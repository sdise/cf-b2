/* 路由冒烟测试：用桩化的 fetch / caches 跑通主流程，不访问真实网络
 * 运行：node tests/router.test.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const {
  handle, loadConfig, UsageCounter, shouldWindowScan, default: workerDefault,
} = await import(pathToFileURL(path.join(here, '..', 'src', 'b2-worker.js')).href);

/* ---------- 桩：Cache API 与 fetch ---------- */
const cacheStore = new Map();
globalThis.caches = {
  default: {
    // 真实 Cache API 每次 match 都会给一个可重新读取的响应，这里用 clone 模拟
    async match(key) { const hit = cacheStore.get(key); return hit ? hit.clone() : undefined; },
    async put(key, res) { cacheStore.set(key, res.clone ? res.clone() : res); },
  },
};

const sent = [];
const corsBodies = [];   // 发往 B2 原生 API 的 b2_update_bucket 请求体
const xml = (body, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'application/xml' },
});

globalThis.fetch = async (request, init) => {
  // readObject 传的是 { url, ... } 形式，这里统一成 Request 便于断言
  const target = typeof request === 'string' ? new Request(request, init) : request;
  sent.push(target);
  const url = new URL(target.url);
  request = target;

  // B2 原生 API（桶级 CORS 配置）：authorize → get_bucket → update_bucket
  if (url.hostname === 'api.backblazeb2.com' && url.pathname.includes('b2_authorize_account')) {
    return new Response(JSON.stringify({
      authorizationToken: 'native-token',
      apiUrl: 'https://api003.backblazeb2.com',
      accountId: 'acc-1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.hostname.includes('backblazeb2.com') && url.pathname.includes('b2_list_buckets')) {
    return new Response(JSON.stringify({
      buckets: [
        { bucketId: 'bid-1', bucketName: 'my-bucket',
          corsRules: [{ corsRuleName: 'pre-existing', allowedOrigins: ['https://old.example.com'] }] },
        { bucketId: 'bid-2', bucketName: 'other-bucket', corsRules: [] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (url.hostname.includes('backblazeb2.com') && url.pathname.includes('b2_update_bucket')) {
    const b = await target.json();
    corsBodies.push(b);
    return new Response(JSON.stringify({ bucketId: b.bucketId, corsRules: b.corsRules }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ListObjectsV2：按请求里的 prefix 生成内容，便于验证前缀处理
  if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const p = url.searchParams.get('prefix') || '';
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + '<Name>my-bucket</Name><Prefix>' + p + '</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys>'
      + '<Delimiter>/</Delimiter><IsTruncated>false</IsTruncated>'
      + '<Contents><Key>' + p + 'a.txt</Key><LastModified>2026-09-27T10:00:00.000Z</LastModified>'
      + '<ETag>&quot;abc123&quot;</ETag><Size>1024</Size><StorageClass>STANDARD</StorageClass></Contents>'
      + '<Contents><Key>' + p + '.keep</Key><LastModified>2026-09-28T10:51:27.091Z</LastModified>'
      + '<ETag>&quot;keep&quot;</ETag><Size>0</Size><StorageClass>STANDARD</StorageClass></Contents>'
      +       '<CommonPrefixes><Prefix>' + p + 'sub/</Prefix></CommonPrefixes>'
      + '</ListBucketResult>',
      { status: 200, headers: { 'Content-Type': 'application/xml' } },
    );
  }

  // CreateMultipartUpload
  if (request.method === 'POST' && url.searchParams.has('uploads')) {
    return xml('<?xml version="1.0" encoding="UTF-8"?>'
      + '<InitiateMultipartUploadResult><Bucket>my-bucket</Bucket><Key>big.mp4</Key>'
      + '<UploadId>upload-1</UploadId></InitiateMultipartUploadResult>');
  }

  // ListParts
  if (request.method === 'GET' && url.searchParams.has('uploadId')) {
    return xml('<?xml version="1.0" encoding="UTF-8"?>'
      + '<ListPartsResult><Bucket>my-bucket</Bucket><Key>big.mp4</Key><UploadId>upload-1</UploadId>'
      + '<PartNumberMarker>0</PartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>'
      + '<Part><PartNumber>1</PartNumber><ETag>&quot;part-etag-1&quot;</ETag>'
      + '<Size>5242880</Size></Part></ListPartsResult>');
  }

  // 模拟不存在的对象：错误体里刻意带上桶名，用于验证脱敏
  if (request.method === 'GET' && url.pathname.includes('missing')) {
    return xml('<?xml version="1.0" encoding="UTF-8"?>'
      + '<Error><Code>NoSuchKey</Code>'
      + '<Message>The specified key does not exist in bucket my-bucket</Message>'
      + '<BucketName>my-bucket</BucketName></Error>', 404);
  }

  // CompleteMultipartUpload
  if (request.method === 'POST' && url.searchParams.has('uploadId')) {
    return xml('<?xml version="1.0" encoding="UTF-8"?>'
      + '<CompleteMultipartUploadResult><Location>my-bucket/big.mp4</Location>'
      + '<ETag>&quot;final-etag&quot;</ETag></CompleteMultipartUploadResult>');
  }

  return new Response('BODY', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain', 'Content-Length': '4', 'ETag': '"abc123"',
      // 上游内部信息，匿名响应必须剥离
      'x-bz-file-id': '4_z123_c456', 'x-amz-request-id': 'req-abc-123',
      'x-bz-info-src_last_modified_millis': '1700000000000',
    },
  });
};

/* ---------- 环境 ---------- */
/** 多桶挂载：BUCKET_N = { BUCKET_NAME, KEY_ID, APPLICATION_KEY, ENDPOINT } */
const bucketJson = (name) => JSON.stringify({
  BUCKET_NAME: name,
  KEY_ID: '0056testkeyid0000000000001',
  APPLICATION_KEY: 'Ktestapplicationkey000000000000',
  ENDPOINT: 'https://s3.us-west-001.backblazeb2.com',
});

const env = {
  BUCKET_1: bucketJson('my-bucket'),
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'secret-pass',
  ALLOW_LIST_BUCKET: 'true',
  PUBLIC_READ: 'true',
  PUBLIC_PREFIX: '',        // 留空 = 旧行为（整桶匿名可读）
  CACHE_MAX_AGE: '60',
};

/* ctx.waitUntil 收集成 promise，便于用例等待「计数落盘」等异步副作用 */
const ctxPending = [];
const ctx = {
  waitUntil(p) { if (p && typeof p.then === 'function') ctxPending.push(p); },
  passThroughOnException() {},
};
const settle = () => Promise.all(ctxPending.splice(0));

/* ---------- 测试公用小工具（时间/事件构造） ---------- */

const utcToday = () => new Date().toISOString().slice(0, 10);

/** 以「今天(UTC)」为基准构造时间，避免测试日期与真实时钟错位 */
const doAt = (hour, minute = 0, dayOffset = 0) => {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, minute, 0,
  ));
};

/** 构造 Cron 事件：hour 决定 scheduled() 会分派哪件事（默认 23 = 只扫空间） */
const cronEvent = (cron = '0 23 * * *', hour = 23) => ({ cron, scheduledTime: doAt(hour, 0).getTime() });

/** 与 ctx 同款，但会收集 waitUntil 的 promise，便于断言异步副作用 */
const ctrlCtx = { waitUntil(p) { if (p && p.then) ctxPending.push(p); }, passThroughOnException() {} };
function req(url, init = {}) {
  return new Request('https://dl.example.com' + url, init);
}
const basic = 'Basic ' + btoa('admin:secret-pass');

let failed = 0;
async function check(label, fn) {
  try {
    const message = await fn();
    console.log('PASS  ' + label + (message ? '  → ' + message : ''));
  } catch (error) {
    failed++;
    console.log('FAIL  ' + label + '\n      ' + (process.env.STACK ? error.stack : error.message));
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

await check('缺少密钥时返回 500 且不回源', async () => {
  const res = await handle(req('/my-bucket/x.txt'), { B2_APPLICATION_KEY: 'k' }, ctx);
  const body = await res.json();
  assert(res.status === 500 && body.ok === false, 'status=' + res.status);
  return body.error;
});

await check('health：匿名只返回最小信息（不含区域/桶模式）', async () => {
  const res = await handle(req('/__api/health'), env, ctx);
  const body = await res.json();
  assert(body.ok === true && body.authenticated === false, JSON.stringify(body));
  assert(body.region === undefined, '匿名不应泄露 region');
  assert(body.bucketMode === undefined, '匿名不应泄露 bucketMode');
  assert(body.publicPrefix === undefined, '匿名不应泄露 publicPrefix');
  return JSON.stringify(body);
});

await check('health：管理员可见详细配置', async () => {
  const res = await handle(req('/__api/health', { headers: { Authorization: basic } }), env, ctx);
  const body = await res.json();
  assert(body.authenticated === true && body.region === 'us-west-001', JSON.stringify(body));
  return JSON.stringify(body);
});

await check('未鉴权写操作被拒绝', async () => {
  const res = await handle(req('/my-bucket/x.txt', { method: 'PUT', body: 'hi' }), env, ctx);
  const body = await res.json();
  assert(res.status === 401 && body.ok === false, 'status=' + res.status);
  return body.error;
});

await check('Basic 鉴权写操作放行', async () => {
  const res = await handle(
    req('/__api/object?key=t.txt', { method: 'PUT', body: 'hello', headers: { Authorization: basic } }),
    env, ctx,
  );
  const body = await res.json();
  assert(res.status === 200 && body.ok === true, 'status=' + res.status + ' body=' + JSON.stringify(body));
  const sent0 = sent[sent.length - 1];
  assert(sent0.method === 'PUT', 'method=' + sent0.method);
  assert(sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/t.txt', 'url=' + sent0.url);
  assert(/^AWS4-HMAC-SHA256 Credential=/.test(sent0.headers.get('authorization')), 'authorization 缺失');
  return sent0.url;
});

await check('下载代理：签名 URL / 缓存头 / Range 透传', async () => {
  const res = await handle(req('/my-bucket/docs/readme.txt', { headers: { Range: 'bytes=0-9' } }), env, ctx);
  assert(res.status === 200, 'status=' + res.status);
  assert(res.headers.get('cache-control') === 'public, max-age=60', 'cc=' + res.headers.get('cache-control'));
  assert(res.headers.get('accept-ranges') === 'bytes', 'accept-ranges 缺失');
  const sent0 = sent[sent.length - 1];
  assert(sent0.headers.get('range') === 'bytes=0-9', 'range 未透传');
  assert(sent0.url.endsWith('/my-bucket/docs/readme.txt'), 'url=' + sent0.url);
  return await res.text();
});

await check('HEAD 不返回响应体', async () => {
  const res = await handle(req('/my-bucket/docs/readme.txt', { method: 'HEAD' }), env, ctx);
  assert(res.status === 200, 'status=' + res.status);
  assert(res.body === null, 'body should be null');
  return 'ok';
});

await check('目录列表 HTML', async () => {
  const res = await handle(req('/my-bucket/docs/'), env, ctx);
  const body = await res.text();
  assert(res.headers.get('content-type').includes('text/html'), 'content-type 非 HTML');
  assert(body.includes('a.txt') && body.includes('sub'), '列表未包含预期条目');
  return 'readme.txt / img';
});

await check('目录列表 JSON', async () => {
  const res = await handle(req('/my-bucket/docs/?format=json', { headers: { Authorization: basic } }), env, ctx);
  const body = await res.json();
  assert(body.ok === true, JSON.stringify(body).slice(0, 120));
  // JSON 接口返回原始数据（含 .keep 占位对象），隐藏只发生在渲染层
  const real = body.files.filter((f) => f.name !== '.keep');
  assert(real.length === 1 && real[0].size === 1024, 'files 解析异常');
  assert(body.files.some((f) => f.name === '.keep'), '应保留占位对象原文，便于排查');
  assert(body.folders[0] === 'docs/sub/', 'folders 解析异常');
  return JSON.stringify({ files: body.files.map((f) => f.name), folders: body.folders });
});

await check('Chinese/space key 编码一致（签名 URL 与 canonical path）', async () => {
  await handle(req('/my-bucket/docs/' + encodeURIComponent('报告 2026.pdf')), env, ctx);
  const sent0 = sent[sent.length - 1];
  assert(
    sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/docs/'
      + encodeURIComponent('报告 2026.pdf'),
    'url=' + sent0.url,
  );
  return sent0.url;
});

await check('路径穿越被阻断（URL 解析器归一化 + 挂载表双重防御）', async () => {
  const before = sent.length;
  // WHATWG URL 会把 .. / %2e%2e 段归一化掉 → 剩下 /etc/passwd → 匿名 308、管理员 404
  const b = await handle(req('/../../etc/passwd'), env, ctx);
  assert(b.status === 308 && b.headers.get('location') === 'https://dl.example.com/share/', '匿名: ' + b.status);
  const c = await handle(req('/../../etc/passwd', { headers: { Authorization: basic } }), env, ctx);
  assert(c.status === 404, '管理员: ' + c.status);
  // 双重编码也绕不过：解码后是字面量段名，匹配不到桶 → 404，绝不回源
  const d = await handle(req('/%252e%252e/etc/passwd', { headers: { Authorization: basic } }), env, ctx);
  assert(d.status === 404, '双重编码: ' + d.status);
  assert(sent.length === before, '穿越路径不应产生任何 B2 调用');
  return '匿名 308 → /share/；管理员/双重编码 404；全程 0 次 B2 调用';
});

await check('管理页面需要鉴权', async () => {
  const res = await handle(req('/__manage'), env, ctx);
  assert(res.status === 401, 'status=' + res.status);
  assert((res.headers.get('www-authenticate') || '').includes('Basic'), '缺少 WWW-Authenticate');
  return res.headers.get('www-authenticate');
});

await check('管理页面（鉴权后）可渲染', async () => {
  const res = await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx);
  const body = await res.text();
  assert(res.status === 200, 'status=' + res.status);
  assert(body.includes('Backblaze B2 文件管理器') && body.includes('multipart/create'), '渲染不完整');
  return 'HTML ' + body.length + ' bytes';
});

await check('预签名 URL 输出', async () => {
  const res = await handle(
    req('/__api/presign?key=docs/a.txt&type=put&ct=text/plain', { headers: { Authorization: basic } }),
    env, ctx,
  );
  const body = await res.json();
  assert(body.ok === true, JSON.stringify(body));
  assert(body.url.includes('X-Amz-Signature=') && body.url.includes('X-Amz-Credential='), '缺少签名参数');
  const signed = decodeURIComponent(new URL(body.url).search);
  // 预签名 URL 绝不能把 x-amz-date / x-amz-content-sha256 列为待发送的签名头，
  // 否则浏览器 PUT 时会被 B2 以 400 "header ... is listed in signed headers, but is not present" 拒绝
  assert(/SignedHeaders=(content-type;)?host(&|$)/.test(signed), '预签名 SignedHeaders 异常: ' + signed);
  assert(!/SignedHeaders=[^&]*x-amz-date/.test(signed), '预签名不应要求客户端发送 x-amz-date');
  assert(!/SignedHeaders=[^&]*x-amz-content-sha256/.test(signed), '预签名不应要求客户端发送 x-amz-content-sha256');
  return body.url.slice(0, 96) + '...';
});

await check('分片上传 create/complete 链路', async () => {
  const create = await handle(
    req('/__api/multipart/create?key=big.mp4', {
      method: 'POST', body: JSON.stringify({ contentType: 'video/mp4' }),
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
    }), env, ctx,
  );
  const created = await create.json();
  assert(created.ok === true && created.uploadId === 'upload-1', JSON.stringify(created));

  const complete = await handle(
    req('/__api/multipart/complete?key=big.mp4', {
      method: 'POST', body: JSON.stringify({ uploadId: 'upload-1' }),
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
    }), env, ctx,
  );
  const done = await complete.json();
  assert(done.ok === true && done.parts === 1, JSON.stringify(done));
  return 'uploadId=' + created.uploadId + ' parts=' + done.parts;
});

/* ---------- 匿名只读 share 前缀 / 管理员全权限 ---------- */
const shareEnv = { ...env, ALLOW_LIST_BUCKET: 'false', PUBLIC_PREFIX: 'share', PUBLIC_LIST: 'true' };

await check('匿名访问根路径自动路由到 /share/', async () => {
  const res = await handle(req('/'), shareEnv, ctx);
  assert(res.status === 308, 'status=' + res.status);
  assert(res.headers.get('location') === 'https://dl.example.com/share/', 'location=' + res.headers.get('location'));
  return res.headers.get('location');
});

await check('匿名可读 share 前缀内的对象（别名挂载）', async () => {
  const res = await handle(req('/share/my-bucket/photo.jpg'), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const sent0 = sent[sent.length - 1];
  assert(sent0.url.endsWith('/my-bucket/share/photo.jpg'), 'url=' + sent0.url);
  return sent0.url;
});

await check('匿名访问 share 之外的对象被重定向到 /share/', async () => {
  const res = await handle(req('/my-bucket/private/secret.txt'), shareEnv, ctx);
  assert(res.status === 308, 'status=' + res.status);
  assert(res.headers.get('location') === 'https://dl.example.com/share/', res.headers.get('location'));
  return '308 → /share/';
});

await check('匿名无法读取 share 同名的平行路径（sharex.txt）', async () => {
  const res = await handle(req('/sharex.txt'), shareEnv, ctx);
  assert(res.status === 308, 'status=' + res.status);
  return '308（未越权命中 share 前缀）';
});

await check('匿名可列举 /share/<桶>/ 目录', async () => {
  const res = await handle(req('/share/my-bucket/'), shareEnv, ctx);
  assert(res.status === 200 && res.headers.get('content-type').includes('text/html'), 'status=' + res.status);
  return 'HTML ok';
});

await check('匿名列举其它目录被重定向', async () => {
  const res = await handle(req('/my-bucket/private/'), shareEnv, ctx);
  assert(res.status === 308, 'status=' + res.status);
  return '308';
});

await check('管理员可读取 share 之外的对象', async () => {
  const res = await handle(req('/my-bucket/private/secret.txt', { headers: { Authorization: basic } }), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const sent0 = sent[sent.length - 1];
  return sent0.url;
});

await check('管理员访问根路径列出挂载桶（0 次 B2 调用）', async () => {
  const before = sent.length;
  const res = await handle(req('/', { headers: { Authorization: basic } }), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const body = await res.text();
  assert(body.includes('my-bucket'), '应列出挂载桶');
  assert(sent.length === before, '虚拟根不应产生 B2 调用');
  return '挂载桶总览（0 次 Class C）';
});

await check('匿名写操作仍然被拒', async () => {
  const res = await handle(req('/share/my-bucket/hack.txt', { method: 'PUT', body: 'x' }), shareEnv, ctx);
  assert(res.status === 401, 'status=' + res.status);
  return '401';
});

await check('管理员可在 share 之外写入', async () => {
  const res = await handle(
    req('/my-bucket/private/ok.txt', { method: 'PUT', body: 'x', headers: { Authorization: basic } }), shareEnv, ctx,
  );
  const body = await res.json();
  assert(res.status === 200 && body.ok === true, 'status=' + res.status);
  return '已写入 /private/ok.txt';
});

/* ---------- 桶级 CORS 配置（B2 原生 API） ---------- */

await check('CORS：POST /__api/cors 追加放行规则并保留已有规则', async () => {
  const res = await handle(
    req('/__api/cors', {
      method: 'POST',
      body: JSON.stringify({ origin: 'https://files.example.com' }),
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
    }), shareEnv, ctx,
  );
  const body = await res.json();
  assert(body.ok === true && body.bucket === 'my-bucket', JSON.stringify(body).slice(0, 160));
  const rule = body.corsRules.find((r) => r.corsRuleName === 'cfb2-files-example-com');
  assert(rule && rule.allowedOrigins[0] === 'https://files.example.com', '缺少新规则: ' + JSON.stringify(body.corsRules));
  assert(rule.allowedOperations.includes('s3_put') && rule.allowedOperations.includes('b2_upload_file'), '直传操作未放行');
  assert(rule.allowedOperations.includes('s3_get'), '下载操作未放行');
  assert(body.corsRules.some((r) => r.corsRuleName === 'pre-existing'), '已有规则被破坏');
  const upd = corsBodies[corsBodies.length - 1];
  assert(upd.bucketId === 'bid-1' && upd.corsRules.length === body.corsRules.length, '发往 B2 的请求体异常');
  return 'origin 已写入，桶内共 ' + body.corsRules.length + ' 条规则';
});

await check('CORS：同名规则去重（重复提交不叠加）且容忍尾斜杠', async () => {
  const res = await handle(
    req('/__api/cors', {
      method: 'POST',
      body: JSON.stringify({ origin: 'https://files.example.com/' }),
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
    }), shareEnv, ctx,
  );
  const body = await res.json();
  const same = body.corsRules.filter((r) => r.corsRuleName === 'cfb2-files-example-com');
  assert(same.length === 1, '同名规则出现 ' + same.length + ' 次');
  assert(body.origin === 'https://files.example.com', '尾斜杠应被去除: ' + body.origin);
  return '去重 OK，origin=' + body.origin;
});

await check('CORS：非法 origin 400 / 匿名 401 / GET 返回现有规则', async () => {
  const bad = await handle(
    req('/__api/cors', {
      method: 'POST', body: JSON.stringify({ origin: 'ftp://x' }),
      headers: { Authorization: basic, 'Content-Type': 'application/json' },
    }), shareEnv, ctx,
  );
  assert(bad.status === 400, 'status=' + bad.status);
  const anon = await handle(req('/__api/cors', { method: 'GET' }), shareEnv, ctx);
  assert(anon.status === 401, '匿名 status=' + anon.status);
  const get = await handle(req('/__api/cors', { headers: { Authorization: basic } }), shareEnv, ctx);
  const gb = await get.json();
  assert(gb.ok === true && gb.bucket === 'my-bucket' && Array.isArray(gb.corsRules), JSON.stringify(gb).slice(0, 140));
  assert(gb.corsRules.some((r) => r.corsRuleName === 'pre-existing'), 'GET 应返回桩中的现有规则');
  return '400 / 401 / GET 正常';
});

await check('CORS：B2 侧报错时透传为 502（不掩盖原因）', async () => {
  const broken = {
    ...shareEnv,
    BUCKET_1: JSON.stringify({
      BUCKET_NAME: 'my-bucket', KEY_ID: 'bad', APPLICATION_KEY: 'bad',
      ENDPOINT: 'https://s3.us-west-001.backblazeb2.com',
    }),
  };
  // 桩对密钥为 bad 的 authorize 返回 401
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const t = typeof request === 'string' ? new Request(request, init) : request;
    if (t.url.includes('b2_authorize_account')) {
      return new Response(JSON.stringify({ status: 401, code: 'bad_auth_token', message: 'Unauthorized' }), { status: 401 });
    }
    return realFetch(request, init);
  };
  try {
    const res = await handle(
      req('/__api/cors', {
        method: 'POST', body: JSON.stringify({ origin: 'https://x.example.com' }),
        headers: { Authorization: basic, 'Content-Type': 'application/json' },
      }), broken, ctx,
    );
    const body = await res.json();
    assert(res.status === 502 && /Unauthorized/.test(body.error), 'status=' + res.status + ' body=' + JSON.stringify(body));
    return 'B2 错误透传: ' + body.error;
  } finally {
    globalThis.fetch = realFetch;
  }
});


/* ---------- B2 用量面板 ---------- */

await settle();
cacheStore.clear();

await check('usage 端点需要鉴权（匿名 401）', async () => {
  const res = await handle(req('/__api/usage'), shareEnv, ctx);
  assert(res.status === 401, 'status=' + res.status);
  return '401';
});

await check('usage：空间由列举累加，默认额度 10 GB', async () => {
  cacheStore.clear();
  const res = await handle(req('/__api/usage', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.json();
  assert(body.ok === true, JSON.stringify(body).slice(0, 140));
  assert(Array.isArray(body.buckets) && body.buckets.length === 1, '应返回全部挂载桶');
  const b0 = body.buckets[0];
  assert(b0.name === 'my-bucket' && b0.ordinal === 1, JSON.stringify(b0).slice(0, 120));
  // 桩返回 a.txt(1024B) + .keep(0B)
  assert(b0.storage.usedBytes === 1024, 'usedBytes=' + b0.storage.usedBytes);
  assert(b0.storage.objects === 2, 'objects=' + b0.storage.objects);
  assert(b0.storage.cached === false, '首次应回源扫描');
  assert(b0.storage.pages === 1, 'pages=' + b0.storage.pages);
  assert(b0.classB.quota === 2500 && b0.classC.quota === 2500, '缺省每日额度不对');
  assert(body.counterBackendLabel === 'Cache API', 'backend=' + body.counterBackendLabel);
  return b0.storage.usedBytes + ' B / ' + b0.storage.objects + ' 对象，额度 ' + b0.quotaBytes;
});

await check('usage：第二次读取走缓存，不再回源 B2', async () => {
  const before = sent.length;
  const res = await handle(req('/__api/usage', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.json();
  assert(body.buckets[0].storage.cached === true, JSON.stringify(body.buckets[0].storage));
  assert(sent.length === before, '缓存命中时不应回源，实际多出 ' + (sent.length - before) + ' 次');
  return 'cached=true，回源 0 次';
});

await check('已移除「重新统计」：refresh 参数不再触发重扫', async () => {
  const before = sent.length;
  const res = await handle(req('/__api/usage?refresh=1', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.json();
  assert(body.buckets[0].storage.cached === true, 'refresh=1 不应触发重扫');
  assert(sent.length === before, '不应回源，实际多出 ' + (sent.length - before) + ' 次');
  assert(body.minInterval === undefined, 'minInterval 字段应已移除');
  return 'refresh=1 被忽略（cached=true，回源 0 次），限流字段已移除';
});

await check('事务计数：读取→B、列举→C、写入→A、删除→D', async () => {
  await settle();
  cacheStore.clear();

  await handle(req('/share/my-bucket/count-b.bin'), shareEnv, ctx);                        // GET 对象 → B
  await handle(req('/__api/list', { headers: { Authorization: basic } }), shareEnv, ctx);  // 列举 → C
  await handle(req('/my-bucket/private/count-a.bin', {
    method: 'PUT', body: 'x', headers: { Authorization: basic },
  }), shareEnv, ctx);                                                                      // 写入 → A
  await handle(req('/my-bucket/private/count-d.bin', {
    method: 'DELETE', headers: { Authorization: basic },
  }), shareEnv, ctx);                                                                      // 删除 → D
  await settle();

  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).json();
  const b0 = body.buckets[0];

  assert(b0.classB.used === 1, 'classB=' + b0.classB.used);
  // 1 次 /__api/list + 本次 usage 触发的 1 页扫描
  assert(b0.classC.used === 2, 'classC=' + b0.classC.used);
  assert(b0.classB.remaining === 2499, 'remaining=' + b0.classB.remaining);
  // 写入 A / 删除 D 从落账的计数器键里核对
  const stored = await cacheStore.get('https://usage.internal/counters/my-bucket').clone().json();
  assert(stored.A === 1 && stored.D === 1, 'A/D 计数异常: ' + JSON.stringify(stored));
  return 'A=1 B=1 C=2 D=1，Class B 剩 ' + b0.classB.remaining;
});

await check('计数器使用固定键（不再按 UTC 日期寻址）', async () => {
  await settle();   // 等最后一次计数落盘
  const keys = [...cacheStore.keys()].filter((k) => String(k).includes('/counters/'));
  assert(keys.length === 1, '计数器 key 数量异常: ' + keys.length);
  assert(String(keys[0]).endsWith('/my-bucket'), 'key 不应带日期段: ' + keys[0]);
  const stored = await cacheStore.get(keys[0]).clone().json();
  assert(stored.B === 1 && stored.C === 2, JSON.stringify(stored));
  return String(keys[0]).replace('https://usage.internal', 'usage');
});

await check('Cache 降级后端：固定键累加；23 点 cron 同时归零并统计', async () => {
  await settle();
  cacheStore.clear();
  const key = 'https://usage.internal/counters/my-bucket';

  await handle(req('/share/my-bucket/reset-b.bin'), shareEnv, ctx);       // B=1
  await handle(req('/share/my-bucket/reset-c.bin'), shareEnv, ctx);       // B=2
  await settle();
  assert((await cacheStore.get(key).clone().json()).B === 2, '固定键应累加到 2');

  const run = await workerDefault.scheduled(cronEvent('0 23 * * *', 23), shareEnv, ctrlCtx);
  assert(run.didScan === true && run.didReset === true, JSON.stringify(run));
  const after = await cacheStore.get(key).clone().json();
  // 先扫描、再归零 → 扫描自己消耗的 Class C 也记在旧周期里，随归零一起清掉
  assert(after.A === 0 && after.B === 0 && after.C === 0 && after.D === 0, '归零未生效: ' + JSON.stringify(after));
  assert(after.resetAt, '缺少 resetAt');

  // 0 点那条 cron 在默认配置下不做任何事（默认小时是 23）
  const midnight = await workerDefault.scheduled(cronEvent('0 0 * * *', 0), shareEnv, ctrlCtx);
  assert(midnight.didScan === false && midnight.didReset === false, JSON.stringify(midnight));
  return 'B=2 → 23 点触发：先扫描后归零 → A/B/C/D 全 0（含扫描消耗），resetAt 已写';
});

await check('ENABLE_USAGE_PANEL=false 时端点明确报关闭', async () => {
  const res = await handle(
    req('/__api/usage', { headers: { Authorization: basic } }),
    { ...shareEnv, ENABLE_USAGE_PANEL: 'false' }, ctx,
  );
  const body = await res.json();
  assert(body.ok === false && /ENABLE_USAGE_PANEL/.test(body.error), JSON.stringify(body));
  return body.error;
});

await check('管理器页面带用量卡片', async () => {
  const page = await (await handle(
    req('/__manage', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).text();
  assert(page.includes('id="usage"'), '缺少用量容器');
  assert(page.includes('function loadUsage'), '缺少加载逻辑');
  assert(!page.includes('btnUsageRefresh') && !page.includes('重新统计'), '「重新统计」按钮应已移除');
  assert(page.includes('Class B:') && page.includes('Class C:'), '缺少事务分类展示');
  assert(!page.includes('（读取）') && !page.includes('（列举）'), 'Class 标签不应再带分类后缀');
  assert(!page.includes('（剩 '), '不应再展示剩余次数');
  assert(!page.includes('>Class A<') && !page.includes('Class A</span>'), 'Class A 不应再展示');
  assert(page.includes('loadUsage();'), '页面应只读缓存地加载一次');
  return '卡片就位（无重算按钮）';
});

await check('管理器布局：桌面端用量卡在左栏，移动端不显示', async () => {
  const page = await (await handle(
    req('/__manage', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).text();
  assert(page.includes('<aside class="side"><div id="usage"'), '用量卡片应在左侧 aside 中');
  assert(page.includes('<section class="content">'), '文件列表应在 .content 中');
  assert(page.includes('grid-template-columns:360px minmax(0,1fr)'), '桌面端应为「左栏 + 右内容」两栏网格');
  assert(page.includes('.side{display:none}'), '移动端（≤860px）应隐藏用量卡片');
  return '桌面：360px 左栏 + 右内容；≤860px：隐藏 B2 桶信息';
});

/* ---------- Durable Object 计数：单元 + 集成 + 23:00 窗口 ---------- */

const doReq = (action, body) => new Request('https://usage.do/' + action, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function fakeDoState(initial) {
  const store = new Map();
  if (initial) store.set('usage', structuredClone(initial));
  let writes = 0;
  return {
    store,
    get writes() { return writes; },
    storage: {
      async get(key) { return store.get(key); },
      async put(key, value) { writes++; store.set(key, structuredClone(value)); },
    },
  };
}

/** 把真实 UsageCounter 包成 DO stub（模拟 env.USAGE_DO 的 fetch 接口） */
function fakeDoNamespace(created = []) {
  const stubs = new Map();
  return {
    created,
    idFromName(name) { created.push(name); return name; },
    get(id) {
      if (!stubs.has(id)) {
        const counter = new UsageCounter(fakeDoState(), {});
        stubs.set(id, {
          counter,
          fetch: (url, init) => counter.fetch(new Request(url, init)),
        });
      }
      return stubs.get(id);
    },
    stubs,
  };
}

await check('DO：累加计数，且不会因跨日自动归零（归零只由 scheduled 触发）', async () => {
  const counter = new UsageCounter(fakeDoState(), {});
  const day1 = doAt(10, 0);
  await counter.onAdd(doReq('add', { A: 2, B: 3 }), day1);
  await counter.onAdd(doReq('add', { B: 1 }), day1);
  const res = await (await counter.onSync(doReq('sync', { ttl: 21600 }), doAt(10, 1))).json();
  assert(res.counters.A === 2 && res.counters.B === 4, JSON.stringify(res.counters));

  // 跨 UTC 日：不再自动归零，继续累加（体现"归零只由 Cron 触发"的语义）
  const body = await (await counter.onAdd(doReq('add', { C: 1 }), doAt(0, 1, 1))).json();
  assert(body.counters.B === 4, '跨日不应自动清零，实际 B=' + body.counters.B);
  assert(body.counters.C === 1, JSON.stringify(body.counters));
  return 'A=2 B=4 → 跨日再 +C=1 → B 仍为 4（不自动归零）';
});

await check('DO：只有 reset（scheduled 调用）才会把计数清零', async () => {
  const counter = new UsageCounter(fakeDoState(), {});
  await counter.onAdd(doReq('add', { A: 2, B: 5, C: 1, D: 1 }), doAt(23, 50));
  const before = await (await counter.onSync(doReq('sync', { ttl: 21600 }), doAt(23, 55))).json();
  assert(before.counters.B === 5, JSON.stringify(before.counters));

  const resetOut = await (await counter.fetch(doReq('reset', {}))).json();
  assert(resetOut.counters.A === 0 && resetOut.counters.B === 0, JSON.stringify(resetOut.counters));
  assert(resetOut.resetAt, '缺少 resetAt 时间戳');

  const after = await (await counter.onSync(doReq('sync', { ttl: 21600 }), doAt(0, 1, 1))).json();
  assert(after.counters.B === 0 && after.counters.C === 0, JSON.stringify(after.counters));
  assert(after.resetAt === resetOut.resetAt, 'resetAt 应透出给面板: ' + after.resetAt);
  return 'reset 后 A/B/C/D 全 0，resetAt=' + resetOut.resetAt.slice(0, 16) + 'Z';
});

await check('DO：跨日无请求也不会"自己归零"，计数保持到 Cron 重置为止', async () => {
  const counter = new UsageCounter(fakeDoState(), {});
  await counter.onAdd(doReq('add', { B: 5, C: 2 }), doAt(23, 59, 0));
  // 中间整段时间没有任何请求；隔天 00:30 才来第一笔
  const next = await (await counter.onAdd(doReq('add', { B: 1 }), doAt(0, 30, 1))).json();
  assert(next.counters.B === 6, '未重置前应继续累加，实际 B=' + next.counters.B);
  assert(next.counters.C === 2, 'C 应保持 2，实际 ' + next.counters.C);

  // 00:00 的 Cron 跑过之后才归零
  await counter.fetch(doReq('reset', {}));
  const afterCron = await (await counter.onAdd(doReq('add', { B: 1 }), doAt(0, 31, 1))).json();
  assert(afterCron.counters.B === 1, '重置后应重新从 1 开始，实际 ' + afterCron.counters.B);
  return 'B=5 → 跨日累加到 6 → Cron reset 后归零 → 再来一笔 B=1';
});

await check('DO：首次读取要求扫描，之后不再重复要求', async () => {
  const counter = new UsageCounter(fakeDoState(), {});
  const now = doAt(10, 0);
  const first = await (await counter.onSync(doReq('sync', { ttl: 21600, windowHour: 23 }), now)).json();
  assert(first.shouldScan === true, '首次应要求扫描');
  assert(first.storage === null, '首次没有快照');

  await counter.onSnapshot(doReq('snapshot', { bucket: 'b', usedBytes: 2048, objects: 3, pages: 1 }), now);
  const second = await (await counter.onSync(doReq('sync', { ttl: 21600, windowHour: 23 }), doAt(10, 1))).json();
  assert(second.shouldScan === false, '刚存完快照不应再扫: ' + JSON.stringify(second.storage));
  assert(second.storage.usedBytes === 2048, JSON.stringify(second.storage));
  return '首次 shouldScan=true → 存快照后 false（2 KB / 3 对象）';
});

await check('DO：refresh 参数已失效，不再触发重扫', async () => {
  const counter = new UsageCounter(fakeDoState(), {});
  await counter.onSnapshot(doReq('snapshot', { usedBytes: 100 }), doAt(10, 0));

  const out = await (await counter.onSync(doReq('sync', {
    ttl: 21600, refresh: true, windowHour: 23,
  }), doAt(10, 6))).json();
  assert(out.shouldScan === false, 'refresh 不应再触发重扫: ' + JSON.stringify(out));
  assert(out.throttled === undefined, 'throttled 字段应已移除');
  assert(out.storage.usedBytes === 100, '应返回已有快照: ' + JSON.stringify(out.storage));
  return 'refresh=true 被忽略，shouldScan=false，返回已有快照（100B）';
});

await check('DO：开启惰性窗口后，UTC 23 点内补扫一次、全天只补一次', async () => {
  const counter = new UsageCounter(fakeDoState(), {});
  const auto = { ttl: 21600, windowHour: 23, autoScan: true };
  await counter.onSnapshot(doReq('snapshot', { usedBytes: 500 }), doAt(22, 59));

  const inWindow = await (await counter.onSync(doReq('sync', auto), doAt(23, 5))).json();
  assert(inWindow.shouldScan === true, '窗口内应补扫: ' + JSON.stringify(inWindow));
  assert(inWindow.windowed === true, 'windowed 标记缺失');

  await counter.onSnapshot(doReq('snapshot', { usedBytes: 900 }), doAt(23, 6));
  const again = await (await counter.onSync(doReq('sync', auto), doAt(23, 30))).json();
  assert(again.shouldScan === false, '同一天窗口内不应重复扫: ' + JSON.stringify(again));

  const tomorrow = await (await counter.onSync(doReq('sync', auto), doAt(23, 10, 1))).json();
  assert(tomorrow.shouldScan === true, '新的一天应再次补扫');

  // 默认（autoScan 未开启）时窗口逻辑不生效
  const offCounter = new UsageCounter(fakeDoState(), {});
  await offCounter.onSnapshot(doReq('snapshot', { usedBytes: 500 }), doAt(22, 59));
  const off = await (await offCounter.onSync(doReq('sync', {
    ttl: 21600, windowHour: 23,
  }), doAt(23, 5))).json();
  assert(off.shouldScan === false, 'autoScan=false 时不该补扫: ' + JSON.stringify(off));
  return '22:59 不补 → 23:05 补 → 23:30 不补 → 次日 23:10 再补；autoScan=false 时关闭';
});

await check('DO：writeEvery 合并落盘以减少 SQLite 行写入', async () => {
  const state = fakeDoState();
  const counter = new UsageCounter(state, {});
  const now = doAt(10, 0);
  for (let i = 0; i < 4; i++) await counter.onAdd(doReq('add', { B: 1, writeEvery: 3 }), now);
  assert(state.writes === 1, '每 3 次才落盘，实际写 ' + state.writes + ' 次');
  const body = await (await counter.onSync(doReq('sync', { ttl: 0 }), doAt(10, 1))).json();
  assert(body.counters.B === 4, '内存计数应为 4，实际 ' + body.counters.B);
  return '4 次累计 → 1 次落盘，计数仍为 4';
});

await check('shouldWindowScan 纯函数边界', async () => {
  const at = (iso) => new Date(iso);
  assert(shouldWindowScan(at('2026-09-30T22:59:00Z'), 23, '') === false, '22:59 不该触发');
  assert(shouldWindowScan(at('2026-09-30T23:00:00Z'), 23, '') === true, '23:00 应触发');
  assert(shouldWindowScan(at('2026-09-30T23:00:00Z'), 23, '2026-09-30') === false, '当天已扫过不重复');
  assert(shouldWindowScan(at('2026-10-01T23:00:00Z'), 23, '2026-09-30') === true, '隔天应触发');
  assert(shouldWindowScan(at('2026-09-30T23:00:00Z'), -1, '') === false, '关闭后不触发');
  assert(shouldWindowScan(at('2026-09-30T05:00:00Z'), 0, '') === true, 'windowHour=0 表示整个 UTC 日');
  return '6 个边界全部符合预期';
});

await check('绑定 USAGE_DO 后：Worker 走 DO 后端并在面板标注', async () => {
  await settle();
  cacheStore.clear();
  const ns = fakeDoNamespace();
  const doEnv = { ...shareEnv, USAGE_DO: ns };

  await handle(req('/share/my-bucket/do-count.bin'), doEnv, ctrlCtx);      // → B
  await settle();                                                // 等计数写入 DO

  const res = await handle(req('/__api/usage', { headers: { Authorization: basic } }), doEnv, ctrlCtx);
  const body = await res.json();
  assert(body.counterBackendLabel === 'Durable Object', 'backend=' + body.counterBackend);
  assert(/Durable Object/.test(body.counterBackendLabel), body.counterBackendLabel);
  assert(body.buckets[0].classB.used === 1, 'classB=' + body.buckets[0].classB.used);
  assert(body.buckets[0].storage.usedBytes === 1024, 'DO 后端快照应为 1024，实际 ' + body.buckets[0].storage.usedBytes);
  assert(ns.created.some((n) => n === 'usage:my-bucket'), 'DO 实例名不对: ' + JSON.stringify(ns.created));

  // 再读一次：DO 已存快照 → 不应再扫 B2
  const before = sent.length;
  const second = await (await handle(req('/__api/usage', { headers: { Authorization: basic } }), doEnv, ctrlCtx)).json();
  assert(second.buckets[0].storage.cached === true, 'DO 快照应命中: ' + JSON.stringify(second.buckets[0].storage));
  assert(sent.length === before, 'DO 命中快照时不应回源');
  return 'backend=do，B=1，快照 1024B，二次读取零回源';
});

await check('DO 调用失败时自动降级到 Cache API，不影响面板可用', async () => {
  await settle();
  cacheStore.clear();
  const brokenEnv = {
    ...shareEnv,
    USAGE_DO: {
      idFromName: () => 'x',
      get: () => ({ fetch: async () => { throw new Error('DO 炸了'); } }),
    },
  };
  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }), brokenEnv, ctrlCtx,
  )).json();
  assert(body.ok === true && body.counterBackendLabel === 'Cache API', JSON.stringify(body).slice(0, 160));
  assert(body.buckets[0].storage.ok === true, '降级后仍应给出空间数据');
  return 'backend=cache，空间仍可用';
});

/* ---------- scheduled() 定时统计（Cron） ---------- */

const seedSnapshot = (bucket, obj) => cacheStore.set(
  'https://usage.internal/storage/' + encodeURIComponent(bucket),
  new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=172800' },
  }),
);
await check('scheduled() 被导出，且会扫描并落快照', async () => {
  await settle();
  cacheStore.clear();
  const before = sent.length;

  const out = await workerDefault.scheduled(cronEvent(), shareEnv, ctrlCtx);
  assert(out.ok === true, JSON.stringify(out));
  assert(out.didScan === true, JSON.stringify(out));
  assert(out.results[0].bucket === 'my-bucket' && out.results[0].scan.backend === 'cache', JSON.stringify(out.results));
  assert(sent.length > before, '定时统计应发起列举');

  const snap = await cacheStore.get('https://usage.internal/storage/my-bucket').clone().json();
  assert(snap.usedBytes === 1024 && snap.objects === 2, JSON.stringify(snap));
  return '扫描 1 次 → 快照 1024B / 2 对象（backend=cache）';
});

await check('定时统计后：打开管理页只读快照，不再回源', async () => {
  const before = sent.length;
  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).json();
  assert(body.buckets[0].storage.cached === true, JSON.stringify(body.storage));
  assert(body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.storage));
  assert(sent.length === before, '不应回源 B2，实际多出 ' + (sent.length - before) + ' 次');
  return 'cached=true，回源 0 次';
});

await check('USAGE_AUTO_SCAN=false（默认）：快照再旧也不会自动重扫', async () => {
  await settle();
  cacheStore.clear();
  const stale = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
  seedSnapshot('my-bucket', { usedBytes: 42, objects: 1, pages: 1, complete: true, at: stale });

  const before = sent.length;
  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).json();
  assert(body.buckets[0].storage.cached === true && body.buckets[0].storage.usedBytes === 42, JSON.stringify(body.storage));
  assert(sent.length === before, '10 天前的快照也不该触发重扫');
  return '10 天前的快照仍直接返回（autoScan=false）';
});

await check('已移除手动重算：refresh=1 不再回源，直接返回现有快照', async () => {
  const before = sent.length;
  const body = await (await handle(
    req('/__api/usage?refresh=1', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).json();
  assert(sent.length === before, 'refresh=1 不应回源，实际多出 ' + (sent.length - before) + ' 次');
  assert(body.buckets[0].storage.cached === true && body.buckets[0].storage.usedBytes === 42, JSON.stringify(body.storage));
  return 'refresh=1 被忽略 → 回源 0 次，仍返回快照（42B）';
});

await check('USAGE_AUTO_SCAN=true 时恢复惰性：过期快照触发重扫', async () => {
  await settle();
  cacheStore.clear();
  const stale = new Date(Date.now() - 10 * 86400 * 1000).toISOString();
  seedSnapshot('my-bucket', { usedBytes: 42, objects: 1, pages: 1, complete: true, at: stale });

  const before = sent.length;
  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }),
    { ...shareEnv, USAGE_AUTO_SCAN: 'true' }, ctx,
  )).json();
  assert(sent.length > before, '开启 autoScan 后过期快照应触发重扫');
  assert(body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.storage));
  return 'autoScan=true → 自动重扫（1024B）';
});

await check('无快照时首次打开会引导性扫描一次（bootstrap）', async () => {
  await settle();
  cacheStore.clear();
  const before = sent.length;
  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).json();
  assert(sent.length > before, '首次应引导扫描');
  assert(body.buckets[0].storage.ok === true && body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.storage));
  return '首次引导扫描一次，之后只靠 Cron/手动';
});

await check('定时统计支持多桶（遍历挂载表）', async () => {
  await settle();
  cacheStore.clear();
  const out = await workerDefault.scheduled(cronEvent(), {
    ...shareEnv, BUCKET_1: bucketJson('bucket-a'), BUCKET_2: bucketJson('bucket-b'),
  }, ctrlCtx);
  assert(out.ok === true, JSON.stringify(out));
  assert(out.results.length === 2, JSON.stringify(out.results));
  const urls = sent.slice(-2).map((r) => r.url);
  assert(urls.some((u) => u.includes('/bucket-a/')), JSON.stringify(urls));
  assert(urls.some((u) => u.includes('/bucket-b/')), JSON.stringify(urls));
  return 'bucket-a / bucket-b 各扫一次';
});

await check('scheduled 按 UTC 小时分派：默认 23 点同时统计+归零', async () => {
  await settle();
  cacheStore.clear();
  const run = await workerDefault.scheduled(cronEvent('0 23 * * *', 23), shareEnv, ctrlCtx);
  assert(run.didScan === true && run.didReset === true, JSON.stringify(run));

  const idle = await workerDefault.scheduled(cronEvent('0 7 * * *', 7), shareEnv, ctrlCtx);
  assert(idle.didScan === false && idle.didReset === false, JSON.stringify(idle));

  const both = await workerDefault.scheduled(
    cronEvent('0 7 * * *', 7), { ...shareEnv, USAGE_SCAN_HOURS: '*', USAGE_RESET_HOURS: '*' }, ctrlCtx,
  );
  assert(both.didScan === true && both.didReset === true, JSON.stringify(both));

  const never = await workerDefault.scheduled(
    cronEvent('0 23 * * *', 23), { ...shareEnv, USAGE_SCAN_HOURS: '-', USAGE_RESET_HOURS: '-' }, ctrlCtx,
  );
  assert(never.didScan === false && never.didReset === false, JSON.stringify(never));

  // 想错开：统计 23 点、归零 0 点（更贴近 B2 官方口径）
  const split = await workerDefault.scheduled(
    cronEvent('0 0 * * *', 0), { ...shareEnv, USAGE_SCAN_HOURS: '23', USAGE_RESET_HOURS: '0' }, ctrlCtx,
  );
  assert(split.didScan === false && split.didReset === true, JSON.stringify(split));
  return '默认 23 点两者都做；7 点无动作；* 两者都做；- 都不做；可配成 23 扫/0 归零';
});

await check('DO 后端：23 点 cron 先扫描后归零，新周期从 0 开始', async () => {
  await settle();
  const ns = fakeDoNamespace();
  const doEnv = { ...shareEnv, USAGE_DO: ns };

  await handle(req('/share/my-bucket/do-reset.bin'), doEnv, ctrlCtx);   // 先记一笔 B
  await settle();
  const before = await (await handle(req('/__api/usage', { headers: { Authorization: basic } }), doEnv, ctrlCtx)).json();
  assert(before.buckets[0].classB.used === 1, 'classB=' + before.buckets[0].classB.used);

  const run = await workerDefault.scheduled(cronEvent('0 23 * * *', 23), doEnv, ctrlCtx);
  assert(run.didScan === true && run.didReset === true, JSON.stringify(run));
  assert(run.results[0].scan.backend === 'do' && run.results[0].reset.backend === 'do', JSON.stringify(run.results));

  const after = await (await handle(req('/__api/usage', { headers: { Authorization: basic } }), doEnv, ctrlCtx)).json();
  assert(after.buckets[0].classB.used === 0, 'reset 后 B 应为 0，实际 ' + after.buckets[0].classB.used);
  assert(after.buckets[0].classC.used === 0, '新周期应从 0 开始（扫描消耗计入旧周期），实际 ' + after.buckets[0].classC.used);
  assert(after.resetSchedule, '缺少 resetSchedule');
  assert(/23:00 UTC/.test(after.resetSchedule), 'resetSchedule=' + after.resetSchedule);
  return 'B=1 → 23 点 cron（先扫描后归零）→ B=0 / C=0，重置排期 ' + after.resetSchedule;
});

await check('定时统计走 DO 后端时写入 DO 快照', async () => {
  await settle();
  const ns = fakeDoNamespace();
  const out = await workerDefault.scheduled(cronEvent(), { ...shareEnv, USAGE_DO: ns }, ctrlCtx);
  assert(out.results[0].scan.backend === 'do', JSON.stringify(out.results));

  const body = await (await handle(
    req('/__api/usage', { headers: { Authorization: basic } }), { ...shareEnv, USAGE_DO: ns }, ctrlCtx,
  )).json();
  assert(body.counterBackendLabel === 'Durable Object' && body.buckets[0].storage.cached === true, JSON.stringify(body.storage));
  assert(body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.storage));
  return 'backend=do，面板直接读到 DO 快照';
});

/* ---------- 目录页：返回上一级 / 占位对象 ---------- */

await check('子目录的「返回上一级」指向真正的父级（不再自指）', async () => {
  const res = await handle(req('/share/my-bucket/images/', { headers: { Authorization: basic } }), shareEnv, ctx);
  const page = await res.text();
  const up = page.match(/<a href="([^"]+)">返回上一级<\/a>/);
  assert(up, '页面没有返回上一级链接');
  assert(up[1] === '/share/my-bucket/', '返回上一级指向了 ' + up[1]);
  return up[1];
});

await check('三层目录的「返回上一级」逐级回退', async () => {
  const res = await handle(req('/share/my-bucket/images/icons/', { headers: { Authorization: basic } }), shareEnv, ctx);
  const up = (await res.text()).match(/<a href="([^"]+)">返回上一级<\/a>/);
  assert(up && up[1] === '/share/my-bucket/images/', '返回上一级指向了 ' + (up && up[1]));
  return up[1];
});

await check('匿名：面包屑每一级都可点击（公开目录 / default）', async () => {
  const page = await (await handle(req('/share/my-bucket/default/'), shareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/);
  assert(crumb, '页面缺少面包屑');
  assert(crumb[1].includes('<a href="/share/">公开目录</a>'), '根级应为可点击的「公开目录 → /share/」: ' + crumb[1]);
  assert(crumb[1].includes('<span class="cur">default</span>'), '当前级应为纯文本: ' + crumb[1]);
  assert(!page.includes('<h1>'), '旧的静态标题应已移除');
  return '公开目录 → /share/ ｜ default（当前）';
});

await check('匿名：三层目录面包屑逐级可点（公开目录 / 桶 / images / icons）', async () => {
  const page = await (await handle(req('/share/my-bucket/images/icons/'), shareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb.includes('<a href="/share/">公开目录</a>'), '缺少公开根链接: ' + crumb);
  assert(crumb.includes('<a href="/share/my-bucket/">my-bucket</a>'), '缺少桶段链接: ' + crumb);
  assert(crumb.includes('<a href="/share/my-bucket/images/">images</a>'), '缺少中间级链接: ' + crumb);
  assert(crumb.includes('<span class="cur">icons</span>'), '当前级不对: ' + crumb);
  assert(!crumb.includes('href="/"'), '匿名面包屑不应指向桶根 /');
  return '公开目录 → my-bucket → images → icons（当前）';
});

await check('匿名：公开聚合根（/share/）面包屑只有「公开目录」', async () => {
  const page = await (await handle(req('/share/'), shareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb === '<span class="cur">公开目录</span>', '面包屑不符: ' + crumb);
  assert(page.includes('/share/my-bucket/'), '聚合页应列出桶入口');
  return crumb;
});

await check('管理员：面包屑从桶名指向根，逐级可点', async () => {
  const page = await (await handle(
    req('/share/my-bucket/images/', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb.includes('<a href="/my-bucket/">my-bucket</a>'), '根级应为桶名 → /my-bucket/: ' + crumb);
  assert(crumb.includes('<a href="/share/my-bucket/">share</a>'), '缺少 share 链接: ' + crumb);
  assert(crumb.includes('<span class="cur">images</span>'), '当前级不对: ' + crumb);
  return 'my-bucket → /share/ ｜ images';
});

await check('匿名访问规范路径 /<桶>/share/** 重定向到别名 /share/<桶>/**', async () => {
  const res = await handle(req('/my-bucket/share/docs/'), shareEnv, ctx);
  assert(res.status === 308, 'status=' + res.status);
  assert(res.headers.get('location') === 'https://dl.example.com/share/my-bucket/docs/', res.headers.get('location'));
  return res.headers.get('location');
});

await check('各页面都带空 favicon（否则 /favicon.ico 被当对象下载、白记 1 次 Class B）', async () => {
  const pages = {
    '公开目录页 /share/': await (await handle(req('/share/my-bucket/', { headers: { Authorization: basic } }), shareEnv, ctx)).text(),
    '管理器页 /__manage': await (await handle(req('/__manage', { headers: { Authorization: basic } }), shareEnv, ctx)).text(),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert(html.includes('<link rel="icon" href="data:,">'), name + ' 缺少空 favicon');
  }
  // 欢迎页模板同样要有（源码级校验，避免依赖具体路由条件）
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/b2-worker.js', import.meta.url), 'utf8',
  );
  const hits = src.split('<link rel="icon" href="data:,">').length - 1;
  assert(hits >= 3, '三处页面模板都应带空 favicon，实际 ' + hits + ' 处');
  return '2 个页面实测 + 源码共 ' + hits + ' 处';
});

await check('公开目录页的滚动续接也用绝对 URL（带凭据 URL 打开时 fetch 才不报错）', async () => {
  const page = await (await handle(req('/share/my-bucket/', { headers: { Authorization: basic } }), shareEnv, ctx)).text();
  assert(page.includes('function absUrl(u)'), '公开目录页缺少 absUrl');
  assert(page.includes('fetch(absUrl(location.pathname'), '公开目录页的 more() 未改用绝对 URL');
  assert(!/fetch\(location\.pathname/.test(page), '仍存在未包装的相对 URL fetch');
  return 'more() → absUrl(location.pathname…)';
});

await check('公开聚合根（/share/）无「返回上一级」，管理员有管理器入口', async () => {
  const anon = await (await handle(req('/share/'), shareEnv, ctx)).text();
  assert(!anon.includes('返回上一级'), '聚合根不该出现返回上一级');
  const admin = await (await handle(req('/share/', { headers: { Authorization: basic } }), shareEnv, ctx)).text();
  assert(!admin.includes('返回上一级'), '聚合根没有上一级');
  assert(admin.includes('/__manage'), '管理员应能看到管理器入口');
  return '聚合根无返回上一级；管理员有管理器入口';
});

await check('目录占位对象 .keep 不出现在目录页（含计数与前端渲染逻辑）', async () => {
  const page = await (await handle(req('/share/my-bucket/', { headers: { Authorization: basic } }), shareEnv, ctx)).text();
  assert(!page.includes('>.keep<'), '列表里出现了 .keep 行');
  assert(!/href="[^"]*\.keep"/.test(page.split('<script')[0]), '链接里出现 .keep');
  assert(page.includes('1 个目录 / 1 个文件'), '计数未排除占位对象');
  assert(page.includes('C.hideKeep'), '前端滚动加载未过滤占位对象');
  return '已隐藏，计数=1';
});

await check('HIDE_KEEP_FILES=false 时 .keep 重新可见（应急开关）', async () => {
  const page = await (await handle(
    req('/share/my-bucket/', { headers: { Authorization: basic } }),
    { ...shareEnv, HIDE_KEEP_FILES: 'false' }, ctx,
  )).text();
  assert(page.includes('>.keep<'), '.keep 应可见');
  assert(page.includes('1 个目录 / 2 个文件'), '计数应包含 .keep');
  return '可见，计数=2';
});

await check('管理器列表也不显示 .keep（删除目录走目录行的按钮）', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), shareEnv, ctx)).text();
  assert(page.includes('function buildRows'), '缺少列表构造');
  assert(page.includes('return f.name !== ".keep";'), '管理器未过滤 .keep');
  assert(page.includes('esc(p + ".keep")'), '目录行的删除按钮应删占位对象');
  return '列表隐藏，删除按钮保留';
});

/* ---------- $path 多桶模式 ---------- */
const pathEnv = { ...env, BUCKET_NAME: '$path' };

await check('$path 模式：桶名取自 URL 首段', async () => {
  await handle(req('/my-bucket/my-bucket/docs/readme.txt'), pathEnv, ctx);
  const sent0 = sent[sent.length - 1];
  assert(sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/my-bucket/docs/readme.txt', sent0.url);
  return sent0.url;
});

await check('$path 模式：目录列表与桶前缀 API', async () => {
  const res = await handle(req('/my-bucket/docs/', { headers: { Authorization: basic } }), pathEnv, ctx);
  const body = await res.text();
  assert(res.headers.get('content-type').includes('text/html'), '非 HTML');
  assert(body.includes('a.txt'), '缺少条目');
  assert(body.includes('/my-bucket/__manage'), '管理员视图应给出带桶前缀的管理器入口');

  const api = await handle(
    req('/my-bucket/__api/list', { headers: { Authorization: basic } }), pathEnv, ctx,
  );
  const list = await api.json();
  assert(list.ok === true && list.bucket === 'my-bucket', JSON.stringify(list).slice(0, 120));
  return 'bucket=' + list.bucket;
});

await check('$path 模式：<bucket>/__manage 渲染且 API 前缀正确', async () => {
  const res = await handle(req('/my-bucket/__manage', { headers: { Authorization: basic } }), pathEnv, ctx);
  const body = await res.text();
  assert(res.status === 200, 'status=' + res.status);
  assert(body.includes('"/my-bucket/__api/"'), 'apiBase 不正确');
  return 'apiBase=/my-bucket/__api/';
});

await check('目录 prefix 必须带尾斜杠（否则子对象被折叠成一个无名目录）', async () => {
  const res = await handle(req('/share/my-bucket/?format=json'), shareEnv, ctx);
  const body = await res.json();
  assert(body.prefix === 'share/', 'prefix=' + body.prefix);
  assert(body.files.some((f) => f.name === 'a.txt'), JSON.stringify(body.files));
  assert(body.folders[0] === 'share/sub/', JSON.stringify(body.folders));
  const sent0 = sent[sent.length - 1];
  assert(sent0.url.includes('prefix=share%2F'), '回源 prefix 未带尾斜杠: ' + sent0.url);
  return body.prefix + ' → ' + body.files.length + ' 文件 / ' + body.folders.length + ' 目录';
});

await check('API list 的 prefix 同样补尾斜杠', async () => {
  const res = await handle(
    req('/__api/list?prefix=share', { headers: { Authorization: basic } }), shareEnv, ctx,
  );
  const body = await res.json();
  assert(body.ok === true, JSON.stringify(body).slice(0, 120));
  assert(body.files[0].key === 'share/a.txt', JSON.stringify(body.files));
  return body.files[0].key;
});

await check('根目录列举 prefix 为空串（不误加斜杠）', async () => {
  const res = await handle(req('/my-bucket/?format=json', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.json();
  assert(body.prefix === '', 'prefix=' + body.prefix);
  assert(body.files[0].key === 'a.txt', JSON.stringify(body.files));
  return "prefix=''";
});

/* ---------- 信息泄露与防滥用加固 ---------- */
await check('响应剥离 B2 内部头（x-bz-* / x-amz-request-id）', async () => {
  const res = await handle(req('/share/my-bucket/photo.jpg'), shareEnv, ctx);
  assert(res.headers.get('x-bz-file-id') === null, 'x-bz-file-id 未剥离');
  assert(res.headers.get('x-amz-request-id') === null, 'x-amz-request-id 未剥离');
  assert(res.headers.get('x-bz-info-src_last_modified_millis') === null, 'x-bz-info-* 未剥离');
  assert(res.headers.get('etag') === '"abc123"', 'ETag 应保留以支撑断点续传');
  assert(res.headers.get('x-content-type-options') === 'nosniff', '缺少 nosniff');
  return '内部头已剥离，ETag 保留';
});

await check('匿名目录列表不泄露桶名与管理器入口', async () => {
  const res = await handle(req('/share/my-bucket/'), shareEnv, ctx);
  const body = await res.text();
  assert(body.includes('my-bucket'), '桶名可公开（面包屑/挂载点）');
  assert(!body.includes('__manage'), '匿名视图不应暴露管理器入口');
  assert(body.includes('a.txt'), '仍应正常列出文件');
  return '管理器入口已隐藏；桶名按设计公开';
});

await check('管理员目录列表仍可见桶名与管理入口', async () => {
  const res = await handle(req('/share/my-bucket/', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.text();
  assert(body.includes('my-bucket'), '管理员应能看到桶名');
  assert(body.includes('__manage'), '管理员应能看到管理器入口');
  return 'ok';
});

await check('匿名遇到上游错误不回传 XML 细节', async () => {
  const res = await handle(req('/share/my-bucket/missing.txt'), shareEnv, ctx);
  const body = await res.text();
  assert(res.status === 404, 'status=' + res.status);
  assert(!body.includes('NoSuchKey') && !body.includes('my-bucket'), '错误体泄露了上游细节: ' + body);
  return body.trim();
});

await check('管理员仍能看到上游错误细节用于排错', async () => {
  const res = await handle(
    req('/my-bucket/private/missing.txt', { headers: { Authorization: basic } }), shareEnv, ctx,
  );
  const body = await res.text();
  assert(res.status === 404, 'status=' + res.status);
  assert(body.includes('my-bucket'), '管理员应保留上游错误正文');
  return '保留排错信息';
});

await check('?redirect=1 不再签发预签名直链（功能已移除）', async () => {
  const res = await handle(
    req('/my-bucket/private/photo.jpg?redirect=1', { headers: { Authorization: basic } }),
    { ...shareEnv, ALLOW_REDIRECT: 'true' }, ctx,
  );
  assert(res.status === 200, 'status=' + res.status);
  assert(!(res.headers.get('location') || '').includes('X-Amz-Signature'), '仍然拿到了预签名直链');
  return '302 直链已移除，走 Worker 代理';
});

await check('预签名下载直链已被禁用（仅保留上传用 PUT）', async () => {
  const get = await handle(
    req('/__api/presign?key=share/a.txt&type=get', { headers: { Authorization: basic } }), shareEnv, ctx,
  );
  assert(get.status === 403, 'GET 预签名应被拒，实际 status=' + get.status);
  const put = await handle(
    req('/__api/presign?key=share/a.txt&type=put', { headers: { Authorization: basic } }), shareEnv, ctx,
  );
  assert(put.status === 200, 'PUT 预签名应保留，实际 status=' + put.status);
  return 'get=403 / put=200';
});

await check('?dl=1 由 Worker 下发附件头（不泄露 B2 端点）', async () => {
  const res = await handle(req('/share/my-bucket/' + encodeURIComponent('报告 2026.pdf') + '?dl=1'), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const cd = res.headers.get('content-disposition') || '';
  assert(cd.includes('attachment') && cd.includes('2026.pdf'), 'content-disposition=' + cd);
  return cd;
});

await check('/__api/logout 返回 401 并带 WWW-Authenticate', async () => {
  const res = await handle(req('/__api/logout', { method: 'POST' }), env, ctx);
  const body = await res.json();
  assert(res.status === 401, 'status=' + res.status);
  assert((res.headers.get('www-authenticate') || '').includes('Basic'), '缺少 WWW-Authenticate');
  assert(body.ok === true, JSON.stringify(body));
  return res.headers.get('www-authenticate');
});

await check('管理器带「退出」按钮且会清理本地凭据', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('id="btnLogout"'), '缺少退出按钮');
  assert(page.includes('sessionStorage.removeItem("cfb2-token")'), '退出未清理本地令牌');
  assert(page.includes('"logout"'), '退出未调用 logout 端点');
  return 'ok';
});

await check('管理器不再出现「直链」按钮，下载走 Worker 路径', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(!page.includes('data-act=\\"link\\"'), '直链按钮仍在');
  assert(!page.includes('data-act="link"'), '直链按钮仍在');
  assert(page.includes('basePath'), '缺少 basePath 配置');
  assert(page.includes('?dl=1'), '下载未改为 Worker 路径');
  return '已移除';
});

await check('分片经 Worker 中继（PUT multipart/part）', async () => {
  const res = await handle(
    req('/__api/multipart/part?key=big.mp4&uploadId=upload-1&partNumber=1', {
      method: 'PUT', body: 'PARTDATA',
      headers: { Authorization: basic, 'Content-Type': 'application/octet-stream' },
    }), env, ctx,
  );
  const body = await res.json();
  assert(res.status === 200 && body.ok === true, 'status=' + res.status + ' ' + JSON.stringify(body));
  assert(body.partNumber === 1 && body.size === 8, JSON.stringify(body));
  const sent0 = sent[sent.length - 1];
  assert(sent0.method === 'PUT', 'method=' + sent0.method);
  assert(sent0.url.includes('uploadId=upload-1') && sent0.url.includes('partNumber=1'), sent0.url);
  assert(sent0.headers.get('authorization').startsWith('AWS4-HMAC-SHA256'), '未签名转发');
  return sent0.url;
});

await check('超过 MAX_UPLOAD_BYTES 的分片被拒绝', async () => {
  const res = await handle(
    req('/__api/multipart/part?key=big.mp4&uploadId=upload-1&partNumber=2', {
      method: 'PUT', body: 'X'.repeat(64), headers: { Authorization: basic },
    }), { ...env, MAX_UPLOAD_BYTES: '16' }, ctx,
  );
  const body = await res.json();
  assert(res.status === 413 && body.ok === false, 'status=' + res.status);
  return body.error;
});

await check('GET multipart/part 仍返回预签名 URL（直传路径）', async () => {
  const res = await handle(
    req('/__api/multipart/part?key=big.mp4&uploadId=upload-1&partNumber=1',
      { headers: { Authorization: basic } }), env, ctx,
  );
  const body = await res.json();
  assert(res.status === 200 && body.url.includes('X-Amz-Signature='), JSON.stringify(body).slice(0, 120));
  return 'presign ok';
});

await check('暖色主题：目录行有独立暖色底，深色主题不变', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('--folder:#f6e6c8'), '暖色缺少目录行底色');
  assert(page.includes('--folderTxt:#a75a12'), '暖色缺少目录文字色');
  assert(page.includes('tr.dir td{background:var(--folder)}'), '缺少目录行样式规则');
  const darkBlock = page.slice(page.indexOf('[data-theme="dark"]'));
  assert(darkBlock.includes('--folder:#161a22;'), '深色目录底色应与卡片同色（保持不变）');
  assert(!darkBlock.includes('--folderTxt:#a75a12'), '深色不应沿用暖色的目录文字色');
  assert(page.includes('class=\\"dir\\"') || page.includes('class="dir"'), '目录行未打上 dir 类');
  return 'warm 目录高亮 / dark 不变';
});

await check('目录索引页的目录行同样带 dir 类', async () => {
  const res = await handle(req('/share/my-bucket/'), shareEnv, ctx);
  const body = await res.text();
  assert(body.includes('<tr class="dir">'), '目录行未着色');
  return 'ok';
});

await check('主题：默认暖色且支持深色切换', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('--bg:#f6f0e4'), '缺少暖色默认值');
  assert(page.includes('[data-theme="dark"]{--bg:#0f1115'), '缺少深色主题块');
  assert(page.includes('id="btnTheme"'), '缺少主题切换按钮');
  assert(page.includes('cfb2-theme'), '主题未做本地记忆');
  return 'warm 默认 / dark 可切';
});

await check('上传方式：提供直传与 Worker 代理两个选项', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('id="upMode"'), '缺少模式选择器');
  assert(page.includes('value="direct"') && page.includes('value="worker"'), '缺少两个选项');
  assert(page.includes('multipart/part'), '缺少 Worker 分片通道');
  assert(page.includes('cfb2-upmode'), '模式未做本地记忆');
  return 'direct / worker';
});

await check('匿名目录页也带主题切换', async () => {
  const res = await handle(req('/share/my-bucket/'), shareEnv, ctx);
  const body = await res.text();
  assert(body.includes('id="btnTheme"') && body.includes('--bg:#f6f0e4'), '目录页缺少主题支持');
  return 'ok';
});

await check('直传/Worker 都支持并发分片（含失败重试）', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('function mpUpload'), '缺少直传分片函数');
  assert(page.includes('function directStep'), '缺少直传分片步骤');
  assert(page.includes('function withRetry'), '缺少分片重试');
  assert(page.includes('runPool'), '缺少并发池');
  assert(page.includes('uploadConcurrency'), '缺少并发数配置');
  assert(/f\.size > \(CFG\.multipartThreshold \|\| 100000000\)/.test(page), '直传应以上限阈值决定是否分片');
  assert(/file\.size <= \(CFG\.maxUploadBytes/.test(page), 'Worker 代理应在上限内走单次转发');
  return '直传>100MB 分片；Worker>96MB 分片；均为并发+重试';
});

await check('MULTIPART_THRESHOLD 被钳制在 B2 单次 PUT 上限（100MiB）之内', async () => {
  const cfg = loadConfig({ ...env, MULTIPART_THRESHOLD: '999999999' });
  assert(cfg.multipartThreshold < 100 * 1024 * 1024, 'threshold=' + cfg.multipartThreshold);
  const def = loadConfig({ ...env });
  assert(def.multipartThreshold === 100000000, 'default=' + def.multipartThreshold);
  return 'clamp < 104857600，默认 100000000';
});

await check('提供「复制」按钮（经 Worker 的分享链接）', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('data-act="copy"'), '缺少复制按钮');
  assert(page.includes('navigator.clipboard'), '缺少剪贴板写入');
  assert(page.includes('function objUrl'), '复制应使用 Worker 路径');
  return 'copy → objUrl(key)';
});

await check('取消拖拽区与页内提示文案', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(!page.includes('id="drop"'), '拖拽区仍在');
  assert(!page.includes('capHint'), '提示文案仍在');
  assert(!page.includes('拖到这里上传'), '拖拽提示仍在');
  return '已移除';
});

await check('列表改为瀑布流（无上下页按钮，滚动加载）', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(!page.includes('btnPrev') && !page.includes('btnNext'), '翻页按钮仍在');
  assert(!page.includes('>上一页<') && !page.includes('>下一页<'), '翻页按钮文案仍在');
  assert(page.includes('function loadMore'), '缺少加载更多');
  assert(page.includes('window.addEventListener("scroll"'), '缺少滚动监听');
  assert(page.includes('insertAdjacentHTML'), '缺少追加渲染');
  assert(page.includes('id="status"'), '缺少加载状态区');
  return '无限滚动 + 追加渲染';
});

await check('公开目录页也走滚动加载（无「下一页」链接）', async () => {
  const res = await handle(req('/share/my-bucket/'), shareEnv, ctx);
  const body = await res.text();
  assert(!body.includes('下一页</a>'), '仍存在下一页链接');
  assert(body.includes('addEventListener("scroll"'), '缺少滚动监听');
  assert(body.includes('insertAdjacentHTML'), '缺少追加渲染');
  assert(body.includes('id="tb"'), '缺少 tbody 容器');
  assert(body.includes('id="status"'), '缺少状态区');
  assert(body.includes('?format=json&cursor='), '缺少游标请求');
  return '无限滚动（服务端首屏 + 前端续接）';
});

await check('复制的链接跟随当前域名且锚定挂载点（绝对地址）', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('location.origin + "/share/" + CFG.bucketFixed'), '公开前缀内应生成 /share/<桶>/ 别名链接');
  assert(page.includes('location.origin + "/" + CFG.bucketFixed + "/"'), '其余应生成 /<桶>/<key> 挂载链接');
  assert(!page.includes('location.origin + CFG.basePath'), '不应再用 basePath 拼对象 URL（全局入口下会丢桶前缀）');
  return '公开文件 → /share/<桶>/…；其余 → /<桶>/…（修复「未挂载的桶」）';
});

await check('上传方式下拉框不带 title 说明', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(!page.includes('id="upMode" title'), '仍存在 title 说明');
  assert(page.includes('<select id="upMode">'), '缺少下拉框');
  return '已移除说明';
});

await check('管理器提供分片大小/并发输入框，默认值取服务端配置', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(/id="partSize"[^>]*value="25"/.test(page), 'partSize 默认值不是 25');
  assert(/id="conc"[^>]*value="3"/.test(page), 'conc 默认值不是 3');
  assert(page.includes('function partSizeMB'), '缺少 partSizeMB');
  assert(page.includes('function concurrency'), '缺少 concurrency');
  assert(page.includes('function syncTuning') && page.includes('cfb2-tune'), '缺少调参持久化');
  assert(!page.includes('tuneHint'), '提示行 tuneHint 应已移除');
  return '分片 25 MiB / 并发 3（无提示行）';
});

await check('输入框默认值跟随 MULTIPART_PART_SIZE / UPLOAD_CONCURRENCY', async () => {
  const page = await (await handle(
    req('/__manage', { headers: { Authorization: basic } }),
    { ...env, MULTIPART_PART_SIZE: '8388608', UPLOAD_CONCURRENCY: '5' }, ctx,
  )).text();
  assert(/id="partSize"[^>]*value="8"/.test(page), '分片默认值未跟随配置');
  assert(/id="conc"[^>]*value="5"/.test(page), '并发默认值未跟随配置');
  return '8 MiB / 5';
});

await check('分片大小按通道钳制：直传 ≤95MiB，Worker 按 MAX_UPLOAD_BYTES', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('return 95;'), '直传上限应为 95MiB（B2 单次 PUT 100MiB 留余量）');
  assert(/- 1048576\) \/ 1048576/.test(page), 'Worker 上限应按 MAX_UPLOAD_BYTES 推算');
  assert(page.includes('clampField("partSize", 5, cap, defaultPartMB())'), '分片输入框应钳制在 5..cap，空值回落服务端默认');
  assert(page.includes('clampField("conc", 1, 10, CFG.uploadConcurrency || 3)'), '并发应钳制在 1..10 并回落默认值');
  assert(page.includes('function workerPartSize() { return partSizeMB(); }'), 'Worker 分片大小应走同一入口');
  return '直传 5–95 MiB，并发 1–10';
});

await check('管理器内嵌前端 JS 可解析', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  const scripts = [...page.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)];
  assert(scripts.length >= 1, '未找到前端脚本');
  const { Script } = await import('node:vm');
  for (const [, code] of scripts) new Script(code);   // 仅做语法编译校验
  return scripts.length + ' 个脚本块';
});

console.log(failed === 0 ? '\n全部通过 ✅' : '\n失败 ' + failed + ' 项 ❌');
process.exit(failed === 0 ? 0 : 1);
