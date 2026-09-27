/* 路由冒烟测试：用桩化的 fetch / caches 跑通主流程，不访问真实网络
 * 运行：node tests/router.test.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle } = await import(pathToFileURL(path.join(here, '..', 'src', 'b2-worker.js')).href);

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

  // ListObjectsV2
  if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
      + '<Name>my-bucket</Name><Prefix>docs/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys>'
      + '<Delimiter>/</Delimiter><IsTruncated>false</IsTruncated>'
      + '<Contents><Key>docs/readme.txt</Key><LastModified>2026-09-27T10:00:00.000Z</LastModified>'
      + '<ETag>&quot;abc123&quot;</ETag><Size>1024</Size><StorageClass>STANDARD</StorageClass></Contents>'
      +       '<CommonPrefixes><Prefix>docs/img/</Prefix></CommonPrefixes>'
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

  // CompleteMultipartUpload
  if (request.method === 'POST' && url.searchParams.has('uploadId')) {
    return xml('<?xml version="1.0" encoding="UTF-8"?>'
      + '<CompleteMultipartUploadResult><Location>my-bucket/big.mp4</Location>'
      + '<ETag>&quot;final-etag&quot;</ETag></CompleteMultipartUploadResult>');
  }

  return new Response('BODY', {
    status: 200,
    headers: { 'Content-Type': 'text/plain', 'Content-Length': '4', 'ETag': '"abc123"' },
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

await check('health 返回匿名未鉴权', async () => {
  const res = await handle(req('/__api/health'), env, ctx);
  const body = await res.json();
  assert(res.status === 200 && body.region === 'us-west-001', 'region=' + body.region);
  assert(body.authenticated === false, 'anonymous should be false');
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
  assert(body.includes('readme.txt') && body.includes('img'), '列表未包含预期条目');
  return 'readme.txt / img';
});

await check('目录列表 JSON', async () => {
  const res = await handle(req('/docs/?format=json', { headers: { Authorization: basic } }), env, ctx);
  const body = await res.json();
  assert(body.ok === true, JSON.stringify(body).slice(0, 120));
  assert(body.files.length === 1 && body.files[0].size === 1024, 'files 解析异常');
  assert(body.folders[0] === 'docs/img/', 'folders 解析异常');
  return JSON.stringify({ files: body.files.length, folders: body.folders });
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
  assert(/SignedHeaders=[^&]*x-amz-content-sha256/.test(signed), 'payload 哈希未进入 SignedHeaders');
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

/* ---------- $path 多桶模式 ---------- */
const pathEnv = { ...env, BUCKET_NAME: '$path' };

await check('$path 模式：桶名取自 URL 首段', async () => {
  await handle(req('/my-bucket/docs/readme.txt'), pathEnv, ctx);
  const sent0 = sent[sent.length - 1];
  assert(sent0.url === 'https://s3.us-west-001.backblazeb2.com/my-bucket/docs/readme.txt', sent0.url);
  return sent0.url;
});

await check('$path 模式：目录列表与桶前缀 API', async () => {
  const res = await handle(req('/my-bucket/docs/'), pathEnv, ctx);
  const body = await res.text();
  assert(res.headers.get('content-type').includes('text/html'), '非 HTML');
  assert(body.includes('readme.txt'), '缺少条目');
  assert(body.includes('/my-bucket/__manage'), '管理器链接未带桶前缀');

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
