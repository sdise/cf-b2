/* 一次性脚本：为 B2 桶配置 CORS（浏览器直传必需）
 * 凭据只从环境变量读取，不写进文件、不打印。
 * 用法：
 *   $env:B2_KEY_ID='xxx'; $env:B2_APP_KEY='xxx'; node tools/setup-b2-cors.mjs
 * 可选环境变量：B2_BUCKET（默认 axyz-bucket）、B2_ORIGIN（默认 workers.dev 域名）
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const keyId = process.env.B2_KEY_ID || '';
const appKey = process.env.B2_APP_KEY || '';
const bucketName = process.env.B2_BUCKET || 'axyz-bucket';
const origin = process.env.B2_ORIGIN || 'https://b2.mose19960101.workers.dev';
const dryRun = process.env.B2_DRY_RUN === '1';

if (!keyId || !appKey) {
  console.error('缺少 B2_KEY_ID / B2_APP_KEY 环境变量');
  process.exit(1);
}

const mask = (s) => (s ? s.slice(0, 4) + '***' + s.slice(-4) : '(空)');
console.log('keyID       :', mask(keyId));
console.log('application :', mask(appKey));
console.log('bucket      :', bucketName);
console.log('origin      :', origin);

/* 注意：实测本桶只接受小写下划线写法 s3_put / s3_get / s3_head / s3_delete，
 * 官方文档里的 "S3 Put Object" 会被 bad_request 拒绝。 */
const CORS_RULE = {
  corsRuleName: 'allow-worker-b2-upload',
  allowedOrigins: [origin],
  allowedOperations: ['s3_put', 's3_get', 's3_head'],
  allowedHeaders: ['content-type', 'x-amz-content-sha256'],
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
};

/* 桶上原本就存在的下载规则（探测过程中被覆盖，这里一并写回） */
const RESTORE_RULE = {
  corsRuleName: 'restore-download-any-https',
  allowedOrigins: ['https'],
  allowedOperations: ['s3_get', 's3_head'],
  allowedHeaders: ['authorization', 'range'],
  exposeHeaders: ['ETag'],
  maxAgeSeconds: 3600,
};

/* ---------- 1. 登录 ---------- */
const authRes = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
  headers: { Authorization: 'Basic ' + Buffer.from(keyId + ':' + appKey).toString('base64') },
});
const auth = await authRes.json();
if (auth.status) {
  console.error('登录失败:', auth.status, auth.code, auth.message);
  process.exit(1);
}
console.log('\n[1] 登录成功，S3 端点:', auth.s3ApiUrl);

const s3Host = new URL(auth.s3ApiUrl).hostname;
const region = s3Host.split('.').slice(1, -2).join('.') || 'us-east-005';
console.log('    推导 region:', region);

/* ---------- 2. 找桶 ---------- */
const listRes = await fetch(auth.apiUrl + '/b2api/v2/b2_list_buckets', {
  method: 'POST',
  headers: { Authorization: auth.authorizationToken },
  body: JSON.stringify({ accountId: auth.accountId, bucketName }),
});
const list = await listRes.json();
if (list.status) {
  console.error('列举桶失败:', list.code, list.message);
  process.exit(1);
}
const bucket = (list.buckets || []).find((b) => b.bucketName === bucketName);
if (!bucket) {
  console.error('找不到桶:', bucketName, '可用桶:', (list.buckets || []).map((b) => b.bucketName).join(', '));
  process.exit(1);
}
console.log('[2] 找到桶:', bucket.bucketName, '| bucketId:', bucket.bucketId, '| type:', bucket.bucketType);

/* ---------- 3. Native API 设置 CORS ---------- */
const RULES = [RESTORE_RULE, CORS_RULE];
console.log('\n[3] 通过 b2_update_bucket 写入 corsRules:');
console.log(JSON.stringify(RULES, null, 2));

if (!dryRun) {
  const updRes = await fetch(auth.apiUrl + '/b2api/v2/b2_update_bucket', {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken },
    body: JSON.stringify({
      accountId: auth.accountId,
      bucketId: bucket.bucketId,
      bucketType: bucket.bucketType,
      corsRules: RULES,
    }),
  });
  const upd = await updRes.json();
  if (upd.status) {
    console.error('  写入失败:', upd.status, upd.code, upd.message);
  } else {
    console.log('  已写入，当前 corsRules:', JSON.stringify(upd.corsRules || []));
  }
}

/* ---------- 4. S3 PutBucketCors（桶若已含 Native 规则会被拒，属正常） ---------- */
const { SigV4 } = await import(pathToFileURL(path.join(here, '..', 'src', 'b2-worker.js')).href);
const signer = new SigV4({ accessKeyId: keyId, secretAccessKey: appKey, region, service: 's3' });

const corsXml = '<CORSConfiguration><CORSRule>'
  + '<AllowedOrigin>' + origin + '</AllowedOrigin>'
  + '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>'
  + '<AllowedHeader>content-type</AllowedHeader><AllowedHeader>x-amz-content-sha256</AllowedHeader>'
  + '<ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>'
  + '</CORSRule></CORSConfiguration>';

const putUrl = auth.s3ApiUrl + '/' + bucketName + '/?cors';
console.log('\n[4] S3 PutBucketCors ->', putUrl);
if (!dryRun) {
  const req = await signer.sign('PUT', putUrl, {
    headers: { 'content-type': 'application/xml' }, body: corsXml,
  });
  const res = await fetch(req);
  const text = await res.text();
  console.log('    HTTP', res.status, text ? text.slice(0, 200) : '(空响应)');
}

/* ---------- 5. 回读校验 ---------- */
console.log('\n[5] 校验：S3 GetBucketCors');
const getReq = await signer.sign('GET', putUrl, {});
const getRes = await fetch(getReq);
const getText = await getRes.text();
console.log('    HTTP', getRes.status);
console.log('   ', getText ? getText.slice(0, 500) : '(空)');

/* ---------- 6. 模拟浏览器预检 ---------- */
console.log('\n[6] 模拟浏览器 OPTIONS 预检（这就是之前被拦的那一步）');
const probe = await fetch(auth.s3ApiUrl + '/' + bucketName + '/probe.txt', {
  method: 'OPTIONS',
  headers: {
    Origin: origin,
    'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'content-type,x-amz-content-sha256',
  },
});
console.log('    HTTP', probe.status);
for (const h of ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-max-age']) {
  console.log('   ', h + ':', probe.headers.get(h) || '(无)');
}
console.log('\n' + (probe.headers.get('access-control-allow-origin') === origin
  ? '✅ CORS 已放行该来源，管理器切回「直传」即可上传'
  : '❌ 预检仍未放行：检查 allowedOrigins 是否写全（含 https://），或改用「Worker 代理」模式'));
