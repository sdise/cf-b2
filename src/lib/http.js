/* 由 src/b2-worker.js 拆分而来：原 L297-L334、原 L564-L621 */

export const LEAKY_HEADERS = [
  'x-amz-request-id', 'x-amz-id-2', 'x-amz-version-id', 'x-amz-expiration',
  'x-amz-replication-status', 'x-amz-server-side-encryption',
  'x-amz-server-side-encryption-aws-kms-key-id', 'x-amz-mp-parts-count',
  'x-bz-content-sha1', 'x-bz-info-src_last_modified_millis',
];

export function sanitizeUpstreamHeaders(headers) {
  for (const name of LEAKY_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-bz-') || name.startsWith('x-rgw-')) headers.delete(name);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.delete('Set-Cookie');
  return headers;
}

/** 对匿名请求隐藏上游错误细节，避免从 XML 里读出桶名 / 内部标识 */
export function sanitizeUpstreamError(response, cfg, extraHeaders) {
  const status = response.status;
  let detail = '';
  try {
    detail = String(response.statusText || '');
  } catch {
    detail = '';
  }
  console.error('[cf-b2-worker] upstream', status, detail);
  const body = status === 404 ? 'Not Found'
    : status === 403 ? 'Forbidden'
      : status === 416 ? 'Range Not Satisfiable'
        : 'Upstream Error';
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

// env 在同一 isolate 内是稳定对象：缓存 BUCKET_N 的 JSON 解析结果，避免每个请求都全量 parse 一遍

export function corsHeaders(request, cfg) {
  const origin = request.headers.get('origin');
  const allowList = cfg.allowedOrigins.split(',').map((s) => s.trim()).filter(Boolean);
  let allowOrigin = 'null';
  if (allowList.includes('*')) allowOrigin = '*';
  else if (origin && allowList.includes(origin)) allowOrigin = origin;

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,HEAD,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Range,X-Amz-Content-Sha256,X-Requested-With',
    'Access-Control-Expose-Headers': 'ETag,Content-Length,Content-Range,Last-Modified',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export function json(data, status = 200, request = null, cfg = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (request && cfg) Object.assign(headers, corsHeaders(request, cfg));
  return new Response(JSON.stringify(data), { status, headers });
}

export function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      // 页面脚本/样式全部内联，因此放行 unsafe-inline，但仍禁止加载外部资源与嵌套框架
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...extraHeaders,
    },
  });
}

export function deny(reason, request, cfg, status = 403) {
  return json({ ok: false, error: reason }, status, request, cfg);
}

export function challenge(request, cfg) {
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="B2 Manager", charset="UTF-8"',
      'Content-Type': 'text/plain; charset=utf-8',
      ...corsHeaders(request, cfg),
    },
  });
}

/**
 * 校验管理权限：Bearer(ADMIN_TOKEN) > Basic(ADMIN_USER/ADMIN_PASS)
 * 未配置任何凭据时一律默认拒绝，避免误把私有桶变成公共网盘。
 */
