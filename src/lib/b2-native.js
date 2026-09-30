/* 由 src/b2-worker.js 拆分而来：原 L1655-L1739 */

export async function b2Authorize(cfg) {
  const basic = 'Basic ' + btoa(cfg.accessKeyId + ':' + cfg.secretAccessKey);
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: basic },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.authorizationToken) {
    throw new Error('b2_authorize_account 失败: HTTP ' + res.status + ' ' + (data.message || data.code || ''));
  }
  return data;   // { authorizationToken, apiUrl, accountId, ... }
}

/** 生成一条放行指定来源的 CORS 规则（浏览器直传/下载都需要它）。
 *  注意 corsRuleName 只允许字母数字与 '-'（点号会被 B2 拒绝），所以域名里的点要换成 '-'。 */
export function corsRuleFor(origin) {
  const tag = String(origin).replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40) || 'default';
  return {
    corsRuleName: 'cfb2-' + tag,
    allowedOrigins: [origin],
    allowedOperations: [
      'b2_upload_file', 'b2_upload_part', 'b2_download_file_by_id', 'b2_download_file_by_name',
      's3_get', 's3_put', 's3_head', 's3_post', 's3_delete',
    ],
    allowedHeaders: ['authorization', 'content-type', 'content-range', 'range',
      'x-amz-content-sha256', 'x-amz-date', 'x-requested-with'],
    exposeHeaders: ['etag', 'content-length', 'content-range', 'last-modified'],
    maxAgeSeconds: 3600,
  };
}

export async function b2GetBucketCors(cfg, bucket) {
  const auth = await b2Authorize(cfg);
  // 注意：不能用 b2_get_bucket?bucketName= —— 受限应用密钥下按名字查会 404 not_found
  //（实测复现）。b2_list_buckets 对受限密钥返回其被允许的桶，且响应自带 corsRules，
  // 一次调用同时拿到 bucketId 与现有规则。
  const res = await fetch(auth.apiUrl + '/b2api/v2/b2_list_buckets', {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: auth.accountId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(data.buckets)) {
    throw new Error('b2_list_buckets 失败: HTTP ' + res.status + ' ' + (data.message || data.code || ''));
  }
  const m = data.buckets.find((b) => String(b.bucketName || '').toLowerCase() === String(bucket).toLowerCase());
  if (!m) {
    throw new Error('B2 账号（对该密钥可见的桶）中找不到 ' + bucket + '：请确认密钥未限制到其它桶');
  }
  return { bucketId: m.bucketId, corsRules: Array.isArray(m.corsRules) ? m.corsRules : [] };
}

export async function b2UpdateBucketCors(cfg, bucketId, corsRules) {
  const auth = await b2Authorize(cfg);
  const res = await fetch(auth.apiUrl + '/b2api/v2/b2_update_bucket', {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: auth.accountId, bucketId, corsRules }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.bucketId) {
    throw new Error('b2_update_bucket 失败: HTTP ' + res.status + ' ' + (data.message || data.code || ''));
  }
  return Array.isArray(data.corsRules) ? data.corsRules : [];
}

export async function readJsonBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(await request.text()).entries());
  }
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/** API 场景下的桶名解析：支持 /<bucket>/__api/...、/share/<bucket>/__api/... 与 ?bucket= 三种写法 */
