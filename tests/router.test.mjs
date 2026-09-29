/* 路由冒烟测试：用桩化的 fetch / caches 跑通主流程，不访问真实网络
 * 运行：node tests/router.test.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle, loadConfig } = await import(pathToFileURL(path.join(here, '..', 'src', 'b2-worker.js')).href);

/* ---------- 桩：Cache API 与 fetch ---------- */
const cacheStore = new Map();
globalThis.caches = {
  default: {
    async match(key) { return cacheStore.get(key); },
    async put(key, res) { cacheStore.set(key, res.clone ? res.clone() : res); },
  },
};

const sent = [];
const xml = (body, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'application/xml' },
});

globalThis.fetch = async (request, init) => {
  // readObject 传的是 { url, ... } 形式，这里统一成 Request 便于断言
  const target = typeof request === 'string' ? new Request(request, init) : request;
  sent.push(target);
  const url = new URL(target.url);
  request = target;

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
const env = {
  B2_KEY_ID: '0056testkeyid0000000000001',
  B2_APPLICATION_KEY: 'Ktestapplicationkey000000000000',
  B2_ENDPOINT: 'https://s3.us-west-001.backblazeb2.com',
  BUCKET_NAME: 'my-bucket',
  ADMIN_USER: 'admin',
  ADMIN_PASS: 'secret-pass',
  ALLOW_LIST_BUCKET: 'true',
  PUBLIC_READ: 'true',
  PUBLIC_PREFIX: '',        // 留空 = 旧行为（整桶匿名可读）
  CACHE_MAX_AGE: '60',
};

const ctx = { waitUntil() {} };
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
  const res = await handle(req('/x.txt'), { B2_APPLICATION_KEY: 'k' }, ctx);
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
  const res = await handle(req('/x.txt', { method: 'PUT', body: 'hi' }), env, ctx);
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
  const res = await handle(req('/docs/readme.txt', { headers: { Range: 'bytes=0-9' } }), env, ctx);
  assert(res.status === 200, 'status=' + res.status);
  assert(res.headers.get('cache-control') === 'public, max-age=60', 'cc=' + res.headers.get('cache-control'));
  assert(res.headers.get('accept-ranges') === 'bytes', 'accept-ranges 缺失');
  const sent0 = sent[sent.length - 1];
  assert(sent0.headers.get('range') === 'bytes=0-9', 'range 未透传');
  assert(sent0.url.endsWith('/my-bucket/docs/readme.txt'), 'url=' + sent0.url);
  return await res.text();
});

await check('HEAD 不返回响应体', async () => {
  const res = await handle(req('/docs/readme.txt', { method: 'HEAD' }), env, ctx);
  assert(res.status === 200, 'status=' + res.status);
  assert(res.body === null, 'body should be null');
  return 'ok';
});

await check('目录列表 HTML', async () => {
  const res = await handle(req('/docs/'), env, ctx);
  const body = await res.text();
  assert(res.headers.get('content-type').includes('text/html'), 'content-type 非 HTML');
  assert(body.includes('a.txt') && body.includes('sub'), '列表未包含预期条目');
  return 'readme.txt / img';
});

await check('目录列表 JSON', async () => {
  const res = await handle(req('/docs/?format=json', { headers: { Authorization: basic } }), env, ctx);
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
  await handle(req('/docs/' + encodeURIComponent('报告 2026.pdf')), env, ctx);
  const sent0 = sent[sent.length - 1];
  assert(
    sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/docs/'
      + encodeURIComponent('报告 2026.pdf'),
    'url=' + sent0.url,
  );
  return sent0.url;
});

await check('路径穿越被阻断', async () => {
  await handle(req('/../../etc/passwd'), env, ctx);
  const sent0 = sent[sent.length - 1];
  assert(sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/etc/passwd', 'url=' + sent0.url);
  return sent0.url;
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
  assert(res.status === 302, 'status=' + res.status);
  assert(res.headers.get('location') === 'https://dl.example.com/share/', 'location=' + res.headers.get('location'));
  return res.headers.get('location');
});

await check('匿名可读 share 前缀内的对象', async () => {
  const res = await handle(req('/share/photo.jpg'), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const sent0 = sent[sent.length - 1];
  assert(sent0.url.endsWith('/my-bucket/share/photo.jpg'), 'url=' + sent0.url);
  return sent0.url;
});

await check('匿名读取 share 之外的对象被拒', async () => {
  const res = await handle(req('/private/secret.txt'), shareEnv, ctx);
  const body = await res.json();
  assert(res.status === 403 && body.ok === false, 'status=' + res.status);
  return body.error;
});

await check('匿名无法读取 share 同名的平行路径（sharex.txt）', async () => {
  const res = await handle(req('/sharex.txt'), shareEnv, ctx);
  assert(res.status === 403, 'status=' + res.status);
  return '403（未越权命中 share 前缀）';
});

await check('匿名可列举 /share/ 目录', async () => {
  const res = await handle(req('/share/'), shareEnv, ctx);
  assert(res.status === 200 && res.headers.get('content-type').includes('text/html'), 'status=' + res.status);
  return 'HTML ok';
});

await check('匿名列举其它目录被拒', async () => {
  const res = await handle(req('/private/'), shareEnv, ctx);
  assert(res.status === 403, 'status=' + res.status);
  return '403';
});

await check('管理员可读取 share 之外的对象', async () => {
  const res = await handle(req('/private/secret.txt', { headers: { Authorization: basic } }), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const sent0 = sent[sent.length - 1];
  return sent0.url;
});

await check('管理员访问根路径列全桶（不跳转）', async () => {
  const res = await handle(req('/', { headers: { Authorization: basic } }), shareEnv, ctx);
  assert(res.status === 200, 'status=' + res.status);
  const body = await res.text();
  assert(body.includes('a.txt'), '管理员应能列出全桶内容');
  return '全桶列表';
});

await check('匿名写操作仍然被拒', async () => {
  const res = await handle(req('/share/hack.txt', { method: 'PUT', body: 'x' }), shareEnv, ctx);
  assert(res.status === 401, 'status=' + res.status);
  return '401';
});

await check('管理员可在 share 之外写入', async () => {
  const res = await handle(
    req('/private/ok.txt', { method: 'PUT', body: 'x', headers: { Authorization: basic } }), shareEnv, ctx,
  );
  const body = await res.json();
  assert(res.status === 200 && body.ok === true, 'status=' + res.status);
  return '已写入 /private/ok.txt';
});

/* ---------- 目录页：返回上一级 / 占位对象 ---------- */

await check('子目录的「返回上一级」指向真正的父级（不再自指）', async () => {
  const res = await handle(req('/share/images/', { headers: { Authorization: basic } }), shareEnv, ctx);
  const page = await res.text();
  const up = page.match(/<a href="([^"]+)">返回上一级<\/a>/);
  assert(up, '页面没有返回上一级链接');
  assert(up[1] === '/share/', '返回上一级指向了 ' + up[1]);
  return up[1];
});

await check('三层目录的「返回上一级」逐级回退', async () => {
  const res = await handle(req('/share/images/icons/', { headers: { Authorization: basic } }), shareEnv, ctx);
  const up = (await res.text()).match(/<a href="([^"]+)">返回上一级<\/a>/);
  assert(up && up[1] === '/share/images/', '返回上一级指向了 ' + (up && up[1]));
  return up[1];
});

await check('匿名：面包屑每一级都可点击（公开目录 / default）', async () => {
  const page = await (await handle(req('/share/default/'), shareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/);
  assert(crumb, '页面缺少面包屑');
  assert(crumb[1].includes('<a href="/share/">公开目录</a>'), '根级应为可点击的「公开目录 → /share/」: ' + crumb[1]);
  assert(crumb[1].includes('<span class="cur">default</span>'), '当前级应为纯文本: ' + crumb[1]);
  assert(!page.includes('<h1>'), '旧的静态标题应已移除');
  return '公开目录 → /share/ ｜ default（当前）';
});

await check('匿名：三层目录面包屑逐级可点，且不暴露桶根', async () => {
  const page = await (await handle(req('/share/images/icons/'), shareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb.includes('<a href="/share/">公开目录</a>'), '缺少公开根链接');
  assert(crumb.includes('<a href="/share/images/">images</a>'), '缺少中间级链接: ' + crumb);
  assert(crumb.includes('<span class="cur">icons</span>'), '当前级不对: ' + crumb);
  assert(!crumb.includes('href="/"'), '匿名面包屑不应指向桶根 /');
  assert(!crumb.includes('share</a>'), '匿名面包屑不应暴露公开前缀本身');
  return '公开目录 → /share/images/ ｜ icons';
});

await check('匿名：公开根（/share/）面包屑只有「公开目录」且指向自身', async () => {
  const page = await (await handle(req('/share/'), shareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb === '<a href="/share/">公开目录</a>', '面包屑不符: ' + crumb);
  return crumb;
});

await check('管理员：面包屑从桶名指向根，逐级可点', async () => {
  const page = await (await handle(
    req('/share/images/', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb.includes('<a href="/">my-bucket</a>'), '根级应为桶名 → /: ' + crumb);
  assert(crumb.includes('<a href="/share/">share</a>'), '缺少 share 链接: ' + crumb);
  assert(crumb.includes('<span class="cur">images</span>'), '当前级不对: ' + crumb);
  return 'my-bucket → /share/ ｜ images';
});

await check('$path 模式：匿名面包屑根链接带桶名前缀', async () => {
  const pathShareEnv = { ...env, BUCKET_NAME: '$path', ALLOW_LIST_BUCKET: 'false', PUBLIC_PREFIX: 'share' };
  const page = await (await handle(req('/my-bucket/share/docs/'), pathShareEnv, ctx)).text();
  const crumb = page.match(/<nav class="crumb">([\s\S]*?)<\/nav>/)[1];
  assert(crumb.includes('<a href="/my-bucket/share/">公开目录</a>'), '根链接应为 /my-bucket/share/: ' + crumb);
  assert(crumb.includes('<span class="cur">docs</span>'), '缺 docs 当前级: ' + crumb);
  return crumb;
});

await check('公开根目录（/share/）匿名不再显示返回上一级，管理员仍可回根', async () => {
  const anon = await (await handle(req('/share/'), shareEnv, ctx)).text();
  assert(!anon.includes('返回上一级'), '匿名在公开根不该出现返回上一级');

  const admin = await (await handle(
    req('/share/', { headers: { Authorization: basic } }), shareEnv, ctx,
  )).text();
  const up = admin.match(/<a href="([^"]+)">返回上一级<\/a>/);
  assert(up && up[1] === '/', '管理员返回上一级应指向 /，实际 ' + (up && up[1]));
  return '匿名隐藏；管理员 → /';
});

await check('目录占位对象 .keep 不出现在目录页（含计数与前端渲染逻辑）', async () => {
  const page = await (await handle(req('/share/', { headers: { Authorization: basic } }), shareEnv, ctx)).text();
  assert(!page.includes('>.keep<'), '列表里出现了 .keep 行');
  assert(!/href="[^"]*\.keep"/.test(page.split('<script')[0]), '链接里出现 .keep');
  assert(page.includes('1 个目录 / 1 个文件'), '计数未排除占位对象');
  assert(page.includes('C.hideKeep'), '前端滚动加载未过滤占位对象');
  return '已隐藏，计数=1';
});

await check('HIDE_KEEP_FILES=false 时 .keep 重新可见（应急开关）', async () => {
  const page = await (await handle(
    req('/share/', { headers: { Authorization: basic } }),
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
  await handle(req('/my-bucket/docs/readme.txt'), pathEnv, ctx);
  const sent0 = sent[sent.length - 1];
  assert(sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/docs/readme.txt', sent0.url);
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

await check('$path 模式：缺失桶名时明确报错', async () => {
  const res = await handle(req('/__api/list', { headers: { Authorization: basic } }), pathEnv, ctx);
  const body = await res.json();
  assert(res.status === 400 && body.ok === false, 'status=' + res.status);
  return body.error;
});

await check('目录 prefix 必须带尾斜杠（否则子对象被折叠成一个无名目录）', async () => {
  const res = await handle(req('/share/?format=json'), shareEnv, ctx);
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
  const res = await handle(req('/?format=json', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.json();
  assert(body.prefix === '', 'prefix=' + body.prefix);
  assert(body.files[0].key === 'a.txt', JSON.stringify(body.files));
  return "prefix=''";
});

await check('匿名根目录：默认返回 403 JSON', async () => {
  const res = await handle(req('/'), { ...env, ALLOW_LIST_BUCKET: 'false' }, ctx);
  const body = await res.json();
  assert(res.status === 403 && body.ok === false, 'status=' + res.status);
  return body.error;
});

await check('匿名根目录：ROOT_ACTION=redirect 跳转管理器', async () => {
  const res = await handle(req('/'), { ...env, ALLOW_LIST_BUCKET: 'false', ROOT_ACTION: 'redirect' }, ctx);
  assert(res.status === 302, 'status=' + res.status);
  assert(res.headers.get('location') === 'https://dl.example.com/__manage', 'location=' + res.headers.get('location'));
  return res.headers.get('location');
});

await check('匿名根目录：ROOT_ACTION=welcome 渲染引导页', async () => {
  const res = await handle(req('/'), { ...env, ALLOW_LIST_BUCKET: 'false', ROOT_ACTION: 'welcome' }, ctx);
  const body = await res.text();
  assert(res.status === 200, 'status=' + res.status);
  assert(res.headers.get('content-type').includes('text/html'), '非 HTML');
  assert(body.includes('Backblaze B2 资源网关'), '内容不完整');
  assert(!body.includes('my-bucket'), '引导页泄露了桶名');
  assert(!body.includes('us-west-001'), '引导页泄露了区域');
  return 'HTML ' + body.length + ' bytes（已脱敏）';
});

/* ---------- 信息泄露与防滥用加固 ---------- */
await check('响应剥离 B2 内部头（x-bz-* / x-amz-request-id）', async () => {
  const res = await handle(req('/share/photo.jpg'), shareEnv, ctx);
  assert(res.headers.get('x-bz-file-id') === null, 'x-bz-file-id 未剥离');
  assert(res.headers.get('x-amz-request-id') === null, 'x-amz-request-id 未剥离');
  assert(res.headers.get('x-bz-info-src_last_modified_millis') === null, 'x-bz-info-* 未剥离');
  assert(res.headers.get('etag') === '"abc123"', 'ETag 应保留以支撑断点续传');
  assert(res.headers.get('x-content-type-options') === 'nosniff', '缺少 nosniff');
  return '内部头已剥离，ETag 保留';
});

await check('匿名目录列表不泄露桶名与管理器入口', async () => {
  const res = await handle(req('/share/'), shareEnv, ctx);
  const body = await res.text();
  assert(!body.includes('my-bucket'), '泄露了桶名');
  assert(!body.includes('__manage'), '匿名视图不应暴露管理器入口');
  assert(body.includes('a.txt'), '仍应正常列出文件');
  return '已脱敏';
});

await check('管理员目录列表仍可见桶名与管理入口', async () => {
  const res = await handle(req('/share/', { headers: { Authorization: basic } }), shareEnv, ctx);
  const body = await res.text();
  assert(body.includes('my-bucket'), '管理员应能看到桶名');
  assert(body.includes('__manage'), '管理员应能看到管理器入口');
  return 'ok';
});

await check('匿名遇到上游错误不回传 XML 细节', async () => {
  const res = await handle(req('/share/missing.txt'), shareEnv, ctx);
  const body = await res.text();
  assert(res.status === 404, 'status=' + res.status);
  assert(!body.includes('NoSuchKey') && !body.includes('my-bucket'), '错误体泄露了上游细节: ' + body);
  return body.trim();
});

await check('管理员仍能看到上游错误细节用于排错', async () => {
  const res = await handle(
    req('/private/missing.txt', { headers: { Authorization: basic } }), shareEnv, ctx,
  );
  const body = await res.text();
  assert(res.status === 404, 'status=' + res.status);
  assert(body.includes('my-bucket'), '管理员应保留上游错误正文');
  return '保留排错信息';
});

await check('?redirect=1 不再签发预签名直链（功能已移除）', async () => {
  const res = await handle(
    req('/private/photo.jpg?redirect=1', { headers: { Authorization: basic } }),
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
  const res = await handle(req('/share/' + encodeURIComponent('报告 2026.pdf') + '?dl=1'), shareEnv, ctx);
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
  const res = await handle(req('/share/'), shareEnv, ctx);
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
  const res = await handle(req('/share/'), shareEnv, ctx);
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
  const res = await handle(req('/share/'), shareEnv, ctx);
  const body = await res.text();
  assert(!body.includes('下一页</a>'), '仍存在下一页链接');
  assert(body.includes('addEventListener("scroll"'), '缺少滚动监听');
  assert(body.includes('insertAdjacentHTML'), '缺少追加渲染');
  assert(body.includes('id="tb"'), '缺少 tbody 容器');
  assert(body.includes('id="status"'), '缺少状态区');
  assert(body.includes('?format=json&cursor='), '缺少游标请求');
  return '无限滚动（服务端首屏 + 前端续接）';
});

await check('复制的链接跟随当前域名（绝对地址）', async () => {
  const page = await (await handle(req('/__manage', { headers: { Authorization: basic } }), env, ctx)).text();
  assert(page.includes('location.origin + CFG.basePath'), '复制应使用 location.origin');
  assert(!/function objUrl\(key\) \{ return CFG\.basePath/.test(page), '仍在使用相对路径');
  return 'location.origin + basePath + key';
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
  assert(page.includes('id="tuneHint"'), '缺少当前值提示');
  return '分片 25 MiB / 并发 3';
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
