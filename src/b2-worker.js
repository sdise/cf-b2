/* =====================================================================================
 * cf-b2-worker.js · Cloudflare Workers ⇄ Backblaze B2 一体化网关
 * -------------------------------------------------------------------------------------
 * 目标：把 hoochanlon/CF-Proxy-B2（S3 兼容 + SigV4 只读代理）与 ka3hun9/cw4b2
 *      （原生 B2 API + 定时刷新下载令牌 + 动态生成第二个 Worker）两者的优点合并，
 *      并补齐两者短板，得到「单文件、零依赖、可读写、自带文件管理器」的 Worker。
 *
 * 设计取舍：
 *  1. 只用 S3 兼容 API + AWS Signature V4。签名密钥永不过期（不像 B2 原生
 *     authorizationToken 最多 7 天），因此不需要 cw4b2 的「第二个 Worker + cron +
 *     Cloudflare API Token」，也不必把可部署 Worker 的高危令牌塞进环境变量。
 *  2. 自己实现 SigV4（不依赖 aws4fetch），真正的单文件纯 ESM，可直接粘贴到
 *     Cloudflare 控制台部署，无需 npm install / esbuild 打包。
 *  3. 数据面请求全部由 Worker 实时签名，桶可保持 Private；Cloudflare 与 Backblaze
 *     同属 Bandwidth Alliance，回源与出网流量均免费。
 *  4. 大文件不穿过 Worker：浏览器用预签名 URL 直传 B2，或走 S3 分片上传，
 *     规避 Workers 100MB 请求体上限与 CPU/时长开销。
 *
 * 能力清单：
 *   · GET/HEAD 代理下载（Range 续传、条件请求、304、补偿 CF 丢失 content-range）
 *   · Cache API 边缘缓存 + Cache-Control 覆写 + 可选 302 直链跳转
 *   · 目录列表（HTML/JSON；$path、$host、固定桶三种模式）
 *   · 网页文件管理器：浏览/上传/下载/复制直链/删除/重命名/建目录
 *   · 预签名 URL（下载 / 直传 / response-content-disposition）
 *   · S3 分片上传（create → part presign → complete / abort）
 *   · 访问控制：Basic/Bearer 恒定时间比较、公有读写开关、路径穿越防护、CORS 白名单
 *
 * 兼容性：Cloudflare Workers（ESM），compatibility_date >= 2023-09-04
 * ===================================================================================== */

/* ============================ 1. 常量与基础工具 ============================ */

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';
const RANGE_RETRY_ATTEMPTS = 3;
const DEFAULT_ENDPOINT = 'https://s3.us-west-001.backblazeb2.com';

const API_PREFIX = '/__api/';
const MANAGE_PATH = '/__manage';

/** 这些头来自客户端或 Cloudflare 平台，参与签名会导致 SignatureDoesNotMatch */
const UNSIGNABLE_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'expect', 'from', 'keep-alive',
  'max-forwards', 'proxy-authorization', 'referer', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'user-agent', 'accept-encoding', 'accept-charset', 'content-md5',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-request-id', 'cdn-loop',
]);

/** 下载时允许透传给 B2 的客户端头 */
const FORWARD_READ_HEADERS = [
  'range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
  'accept', 'accept-language',
];

const encoder = new TextEncoder();

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

async function sha256Hex(data) {
  let payload;
  if (typeof data === 'string') payload = encoder.encode(data);
  else if (data instanceof Uint8Array) payload = data;
  else if (data instanceof ArrayBuffer) payload = new Uint8Array(data);
  else payload = new Uint8Array(0);
  return toHex(await crypto.subtle.digest('SHA-256', payload));
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** 恒定时间比较，降低时序侧信道风险 */
async function safeEqual(a, b) {
  const ha = await sha256Hex(String(a === undefined || a === null ? '' : a));
  const hb = await sha256Hex(String(b === undefined || b === null ? '' : b));
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/** RFC3986 百分号编码（AWS 要求空格必须是 %20，!'()* 必须转义） */
function uriEncode(str, encodeSlash = true) {
  let out = '';
  for (const ch of String(str)) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      for (const byte of encoder.encode(ch)) out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/** pathname 已是百分号编码，还原为 AWS 规范形态，保证与签名计算完全一致 */
function canonicalPath(pathname) {
  const encoded = pathname.split('/').map((seg) => uriEncode(safeDecode(seg), false)).join('/');
  return encoded.startsWith('/') ? encoded : '/' + encoded;
}

function nowAmz(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 归一化对象 key，同时阻断 ../ 路径穿越 */
function normalizeKey(key) {
  const out = [];
  for (const seg of String(key === undefined || key === null ? '' : key).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/* ============================ 2. AWS Signature V4 ============================ */

class SigV4 {
  constructor({ accessKeyId, secretAccessKey, region, service = SERVICE }) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
    this.service = service;
  }

  async signingKey(dateStamp) {
    let k = await hmac(encoder.encode('AWS4' + this.secretAccessKey), dateStamp);
    k = await hmac(k, this.region);
    k = await hmac(k, this.service);
    return await hmac(k, 'aws4_request');
  }

  /**
   * 生成签名请求；expiresIn > 0 时返回预签名 URL 字符串
   * @param {string} method
   * @param {string} urlStr
   * @param {object} opts {headers, body, query, unsignedPayload, payloadHash, expiresIn}
   */
  async sign(method, urlStr, opts = {}) {
    const {
      headers = {}, body = null, query = {},
      unsignedPayload = false, payloadHash = null, expiresIn = 0,
    } = opts;

    const url = new URL(urlStr);
    const { amzDate, dateStamp } = nowAmz();
    const scope = dateStamp + '/' + this.region + '/' + this.service + '/aws4_request';

    const h = new Headers(headers);
    h.set('host', url.host);
    h.set('x-amz-date', amzDate);

    // 无请求体时按 AWS 规范用空串哈希；流式或客户端直传用 UNSIGNED-PAYLOAD
    let payload = payloadHash;
    if (!payload) payload = unsignedPayload ? 'UNSIGNED-PAYLOAD' : await sha256Hex(body === null ? '' : body);
    h.set('x-amz-content-sha256', payload);

    const pairs = [];
    for (const [rawKey, rawValue] of h.entries()) {
      const key = rawKey.toLowerCase();
      if (UNSIGNABLE_HEADERS.has(key)) continue;
      pairs.push([key, String(rawValue).trim().replace(/\s+/g, ' ')]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const signedHeaders = pairs.map((p) => p[0]).join(';');
    const canonicalHeaders = pairs.map((p) => p[0] + ':' + p[1] + '\n').join('');

    const params = new Map();
    if (expiresIn > 0) {
      params.set('X-Amz-Algorithm', ALGORITHM);
      params.set('X-Amz-Credential', this.accessKeyId + '/' + scope);
      params.set('X-Amz-Date', amzDate);
      params.set('X-Amz-Expires', String(expiresIn));
      params.set('X-Amz-SignedHeaders', signedHeaders);
    }
    for (const [k, v] of url.searchParams.entries()) params.set(k, v);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }

    const canonicalQuery = [...params.keys()].sort()
      .map((k) => uriEncode(k) + '=' + uriEncode(params.get(k)))
      .join('&');

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalPath(url.pathname),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payload,
    ].join('\n');

    const stringToSign = [
      ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = toHex(await hmac(await this.signingKey(dateStamp), stringToSign));
    const target = url.origin + canonicalPath(url.pathname) + (canonicalQuery ? '?' + canonicalQuery : '');

    if (expiresIn > 0) return target + '&X-Amz-Signature=' + signature;

    h.set('authorization',
      ALGORITHM + ' Credential=' + this.accessKeyId + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature);

    return new Request(target, {
      method: method.toUpperCase(),
      headers: h,
      body: body === null ? undefined : body,
    });
  }
}

/* ============================ 3. 配置加载 ============================ */

/** 前缀归一化：去掉首尾斜杠，中间保留；结果为空串表示"不限制" */
function normalizePrefix(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** key/prefix 是否位于指定前缀内（share 与 share/a.txt 均算命中） */
function withinPrefix(key, prefix) {
  if (!prefix) return true;
  const target = String(key || '');
  return target === prefix || target.startsWith(prefix + '/');
}

/** 拼出带尾斜杠的前缀，用于生成链接 */
function prefixWithSlash(prefix) {
  return prefix ? prefix + '/' : '';
}

/** 公开目录的基础路径（$path 模式下需要带上桶名段） */
function publicBase(cfg, bucket) {
  return cfg.bucketMode === 'path' ? '/' + bucket + '/' : '/';
}

function loadConfig(env) {
  const rawEndpoint = String(env.B2_ENDPOINT || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  const endpoint = new URL(rawEndpoint);
  const hostParts = endpoint.hostname.split('.');

  let region = String(env.B2_REGION || '').trim();
  if (!region) {
    region = hostParts[0] === 's3' && hostParts.length > 2
      ? hostParts.slice(1, -2).join('.')
      : 'us-west-001';
  }

  const bucketName = String(env.BUCKET_NAME || '').trim();
  const bucketMode = bucketName === '$path' ? 'path' : bucketName === '$host' ? 'host' : 'fixed';

  return {
    accessKeyId: String(env.B2_KEY_ID || env.B2_APPLICATION_KEY_ID || ''),
    secretAccessKey: String(env.B2_APPLICATION_KEY || env.B2_SECRET_ACCESS_KEY || ''),
    endpointOrigin: endpoint.origin,
    endpointHost: endpoint.hostname,
    region,
    service: SERVICE,
    urlStyle: String(env.URL_STYLE || 'path').toLowerCase() === 'virtual' ? 'virtual' : 'path',

    bucketMode,
    bucketFixed: bucketName,

    publicRead: readBool(env.PUBLIC_READ, true),
    publicWrite: readBool(env.PUBLIC_WRITE, false),
    // 匿名可读写的对象前缀；留空表示整个桶匿名可读（旧行为）
    publicPrefix: normalizePrefix(env.PUBLIC_PREFIX === undefined ? 'share' : env.PUBLIC_PREFIX),
    publicList: readBool(env.PUBLIC_LIST, true),
    allowList: readBool(env.ALLOW_LIST_BUCKET, false),
    enableWrite: readBool(env.ENABLE_WRITE, true),
    enableDelete: readBool(env.ENABLE_DELETE, true),
    enableManage: readBool(env.ENABLE_MANAGE, true),
    // 匿名访问目录时的行为：deny(返回403 JSON，默认) | redirect(302到管理器) | welcome(渲染引导页)
    rootAction: ['deny', 'redirect', 'welcome'].includes(String(env.ROOT_ACTION || 'deny').toLowerCase())
      ? String(env.ROOT_ACTION).toLowerCase() : 'deny',

    cacheMaxAge: readInt(env.CACHE_MAX_AGE, 86400),
    useCache: readBool(env.ENABLE_CACHE, true),
    allowRedirect: readBool(env.ALLOW_REDIRECT, false),
    rcloneDownload: readBool(env.RCLONE_DOWNLOAD, false),

    maxUploadBytes: readInt(env.MAX_UPLOAD_BYTES, 100 * 1024 * 1024),
    presignExpires: readInt(env.PRESIGN_EXPIRES, 3600),
    multipartThreshold: readInt(env.MULTIPART_THRESHOLD, 100 * 1024 * 1024),
    multipartPartSize: readInt(env.MULTIPART_PART_SIZE, 25 * 1024 * 1024),

    adminUser: String(env.ADMIN_USER || ''),
    adminPass: String(env.ADMIN_PASS || ''),
    adminToken: String(env.ADMIN_TOKEN || ''),
    uploadCacheControl: String(env.UPLOAD_CACHE_CONTROL || ''),
    allowedOrigins: String(env.ALLOWED_ORIGINS || '*').trim(),
    debug: readBool(env.DEBUG, false),
  };
}

/* ============================ 4. 响应与鉴权 ============================ */

function corsHeaders(request, cfg) {
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

function json(data, status = 200, request = null, cfg = null) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (request && cfg) Object.assign(headers, corsHeaders(request, cfg));
  return new Response(JSON.stringify(data), { status, headers });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function deny(reason, request, cfg, status = 403) {
  return json({ ok: false, error: reason }, status, request, cfg);
}

function challenge(request, cfg) {
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
async function checkAuth(request, cfg) {
  if (cfg.publicWrite) return { ok: true, mode: 'public' };
  if (!cfg.adminToken && !cfg.adminUser && !cfg.adminPass) {
    return { ok: false, reason: '未配置 ADMIN_TOKEN 或 ADMIN_USER/ADMIN_PASS，操作已被默认拒绝' };
  }

  const authorization = request.headers.get('authorization') || '';

  if (authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (cfg.adminToken && await safeEqual(token, cfg.adminToken)) return { ok: true, mode: 'token' };
    return { ok: false, reason: 'Bearer token 无效' };
  }

  if (authorization.toLowerCase().startsWith('basic ')) {
    let decoded = '';
    try {
      decoded = atob(authorization.slice(6).trim());
    } catch {
      return { ok: false, reason: 'Basic 凭据格式错误' };
    }
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (await safeEqual(user, cfg.adminUser) && await safeEqual(pass, cfg.adminPass)) {
      return { ok: true, mode: 'basic' };
    }
    return { ok: false, reason: '用户名或密码错误' };
  }

  return { ok: false, reason: '缺少 Authorization 头' };
}

/* ============================ 5. B2(S3) 数据面操作 ============================ */

function signerOf(cfg) {
  return new SigV4({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: cfg.service,
  });
}

/** 拼接对象 URL（默认 path-style，兼容性最好） */
function objectUrl(cfg, bucket, key) {
  const encodedKey = normalizeKey(key).split('/').map((seg) => uriEncode(seg, false)).join('/');
  if (cfg.urlStyle === 'virtual' && !bucket.includes('.')) {
    return 'https://' + bucket + '.' + cfg.endpointHost + '/' + encodedKey;
  }
  return cfg.endpointOrigin + '/' + bucket + '/' + encodedKey;
}

/** 桶根 URL */
function bucketUrl(cfg, bucket) {
  if (cfg.urlStyle === 'virtual' && !bucket.includes('.')) {
    return 'https://' + bucket + '.' + cfg.endpointHost + '/';
  }
  return cfg.endpointOrigin + '/' + bucket + '/';
}

/** 依据请求解析 { bucket, key, isDir }：以 / 结尾视为目录列举 */
function resolveBucketKey(cfg, url) {
  const rawPath = url.pathname.replace(/^\/+/, '');
  const isDir = rawPath === '' || rawPath.endsWith('/');
  const pathKey = safeDecode(rawPath.replace(/\/+$/, ''));

  if (cfg.bucketMode === 'path') {
    const segments = pathKey.split('/').filter(Boolean);
    if (segments.length === 0) return { bucket: '', key: '', isDir: true };
    return { bucket: segments[0], key: normalizeKey(segments.slice(1).join('/')), isDir };
  }
  if (cfg.bucketMode === 'host') {
    return { bucket: url.hostname.split('.')[0], key: normalizeKey(pathKey), isDir };
  }
  return { bucket: cfg.bucketFixed, key: normalizeKey(pathKey), isDir };
}

async function b2Fetch(cfg, method, url, options = {}) {
  const { headers = {}, body = null, query = {} } = options;
  const request = await signerOf(cfg).sign(method, url, { headers, body, query });
  return fetch(request);
}

/** 兼容 rclone --b2-download-url 的 file/{bucket}/ 前缀 */
function applyRclone(cfg, key) {
  if (!cfg.rcloneDownload) return key;
  const idx = key.indexOf('/');
  if (idx === -1) return key;
  return key.slice(idx + 1);
}

/** 下载代理：Range / 条件请求 / 304 / 缓存 / CF 丢失 content-range 的补偿重试 */
async function readObject(request, env, ctx, cfg, bucket, key) {
  const url = new URL(request.url);
  const upstreamUrl = objectUrl(cfg, bucket, key);
  const method = request.method;

  // 1) Cache API 命中（仅整对象 GET）
  const cacheable = cfg.useCache && cfg.cacheMaxAge > 0 && method === 'GET'
    && !request.headers.get('range') && !request.headers.get('authorization');
  if (cacheable) {
    try {
      const cached = await caches.default.match(request.url);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set('X-B2-Cache', 'HIT');
        return hit;
      }
    } catch {
      /* 缓存不可用时忽略 */
    }
  }

  // 2) 可选：302 跳转预签名直链，把大文件流量完全交给 B2（会绕过 CF 缓存）
  if (cfg.allowRedirect && method === 'GET' && url.searchParams.get('redirect') === '1') {
    const signed = await signerOf(cfg).sign('GET', upstreamUrl, {
      headers: {}, unsignedPayload: true, expiresIn: cfg.presignExpires,
    });
    return Response.redirect(signed, 302);
  }

  const forwardHeaders = {};
  for (const name of FORWARD_READ_HEADERS) {
    const value = request.headers.get(name);
    if (value) forwardHeaders[name] = value;
  }

  // 3) Cloudflare 会把 HEAD 子请求改写为 GET 导致签名失效 → 统一以 GET 发起
  const signedRequest = await signerOf(cfg).sign('GET', upstreamUrl, {
    headers: forwardHeaders, unsignedPayload: true,
  });

  const hasRange = Object.prototype.hasOwnProperty.call(forwardHeaders, 'range');
  let attempts = RANGE_RETRY_ATTEMPTS;
  let response;

  while (true) {
    const controller = new AbortController();
    response = await fetch(signedRequest.url, {
      method: signedRequest.method,
      headers: signedRequest.headers,
      signal: controller.signal,
    });
    if (!hasRange) break;
    if (response.headers.has('content-range')) break;
    if (!response.ok) break;
    attempts -= 1;
    if (attempts <= 0) break;
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }

  if (method === 'HEAD') {
    return new Response(null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }

  const headers = new Headers(response.headers);
  if (cfg.cacheMaxAge > 0) headers.set('Cache-Control', 'public, max-age=' + cfg.cacheMaxAge);
  if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.delete('Set-Cookie');

  const out = new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });

  if (cacheable && response.status === 200) {
    try {
      const clone = out.clone();
      clone.headers.set('Cache-Control', 'public, max-age=' + cfg.cacheMaxAge);
      ctx.waitUntil(caches.default.put(request.url, clone));
      out.headers.set('X-B2-Cache', 'MISS');
    } catch {
      /* 超过 Cache API 上限时不缓存 */
    }
  }

  return out;
}

/** 通过 Worker 代理上传（受 Workers 100MB 请求体限制，建议仅用于小文件） */
async function putObject(request, cfg, bucket, key) {
  const declared = readInt(request.headers.get('content-length'), 0);
  if (cfg.maxUploadBytes > 0 && declared > cfg.maxUploadBytes) {
    return json({ ok: false, error: '文件超过 MAX_UPLOAD_BYTES，请改用预签名直传' }, 413, request, cfg);
  }
  const body = await request.arrayBuffer();
  if (cfg.maxUploadBytes > 0 && body.byteLength > cfg.maxUploadBytes) {
    return json({ ok: false, error: '文件超过 MAX_UPLOAD_BYTES，请改用预签名直传' }, 413, request, cfg);
  }

  const headers = { 'content-type': request.headers.get('content-type') || 'application/octet-stream' };
  if (cfg.uploadCacheControl) headers['cache-control'] = cfg.uploadCacheControl;

  const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, bucket, key), { headers, body });
  const text = await response.text();
  return response.ok
    ? json({ ok: true, key, size: body.byteLength }, 200, request, cfg)
    : json({ ok: false, status: response.status, error: extractError(text) }, response.status, request, cfg);
}

/** 服务端复制（x-amz-copy-source），空请求体 */
async function copyObject(cfg, bucket, fromKey, toKey) {
  const headers = {
    'x-amz-copy-source': '/' + bucket + '/' + normalizeKey(fromKey).split('/').map((s) => uriEncode(s, false)).join('/'),
  };
  if (cfg.uploadCacheControl) headers['cache-control'] = cfg.uploadCacheControl;

  const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, bucket, toKey), { headers, body: '' });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: extractError(text) };
  return { ok: true, etag: (response.headers.get('etag') || '').replace(/"/g, '') };
}

async function deleteObject(cfg, bucket, key) {
  const response = await b2Fetch(cfg, 'DELETE', objectUrl(cfg, bucket, key), {});
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, status: response.status, error: extractError(text) };
  }
  return { ok: true };
}

/* ---------- 极简 XML 工具（Workers 无 DOMParser） ---------- */

function xmlText(xml, tag) {
  const match = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  if (!match) return '';
  return match[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function extractError(text) {
  const code = xmlText(text || '', 'Code');
  const message = xmlText(text || '', 'Message');
  if (code || message) return code + ': ' + message;
  try {
    const parsed = JSON.parse(text);
    return parsed.message || JSON.stringify(parsed);
  } catch {
    return String(text || '').slice(0, 300) || 'unknown error';
  }
}

/* ---------- ListObjectsV2 ---------- */

async function listObjects(cfg, bucket, options = {}) {
  const { prefix = '', delimiter = '/', limit = 1000, cursor = '' } = options;
  const query = { 'list-type': '2', prefix, delimiter, 'max-keys': String(limit) };
  if (cursor) query['continuation-token'] = cursor;

  const response = await b2Fetch(cfg, 'GET', bucketUrl(cfg, bucket), { query });
  const xml = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: extractError(xml) };

  const files = [];
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
    const key = xmlText(block, 'Key');
    files.push({
      key,
      name: key.slice(prefix.length),
      size: readInt(xmlText(block, 'Size'), 0),
      lastModified: xmlText(block, 'LastModified'),
      etag: xmlText(block, 'ETag').replace(/"/g, ''),
    });
  }

  const folders = (xml.match(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g) || [])
    .map((block) => xmlText(block, 'Prefix'));

  return {
    ok: true,
    files: files.filter((f) => f.name),
    folders,
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml),
    nextToken: xmlText(xml, 'NextContinuationToken'),
  };
}

/* ---------- S3 分片上传 ---------- */

async function multipartCreate(cfg, bucket, key, contentType) {
  const response = await b2Fetch(cfg, 'POST', objectUrl(cfg, bucket, key), {
    query: { uploads: '' },
    headers: { 'content-type': contentType || 'application/octet-stream' },
    body: '',
  });
  const xml = await response.text();
  const uploadId = xmlText(xml, 'UploadId');
  return response.ok && uploadId
    ? { ok: true, uploadId }
    : { ok: false, status: response.status, error: extractError(xml) };
}

async function multipartListParts(cfg, bucket, key, uploadId) {
  const parts = [];
  let marker = '';
  for (let page = 0; page < 20; page++) {
    const query = { uploadId };
    if (marker) query['part-number-marker'] = marker;
    const response = await b2Fetch(cfg, 'GET', objectUrl(cfg, bucket, key), { query });
    const xml = await response.text();
    if (!response.ok) return { ok: false, status: response.status, error: extractError(xml) };
    for (const block of xml.match(/<Part>[\s\S]*?<\/Part>/g) || []) {
      parts.push({
        partNumber: readInt(xmlText(block, 'PartNumber'), 0),
        etag: xmlText(block, 'ETag').replace(/"/g, ''),
        size: readInt(xmlText(block, 'Size'), 0),
      });
    }
    const next = xmlText(xml, 'NextPartNumberMarker');
    if (/<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml) && next) marker = next;
    else break;
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return { ok: true, parts };
}

async function multipartComplete(cfg, bucket, key, uploadId) {
  const listed = await multipartListParts(cfg, bucket, key, uploadId);
  if (!listed.ok) return listed;
  if (listed.parts.length === 0) return { ok: false, error: '没有任何已上传分片' };

  const xmlBody = '<CompleteMultipartUpload>'
    + listed.parts.map((p) => '<Part><PartNumber>' + p.partNumber + '</PartNumber>'
      + '<ETag>&quot;' + p.etag + '&quot;</ETag></Part>').join('')
    + '</CompleteMultipartUpload>';

  const response = await b2Fetch(cfg, 'POST', objectUrl(cfg, bucket, key), {
    query: { uploadId },
    headers: { 'content-type': 'application/xml' },
    body: xmlBody,
  });
  const xml = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: extractError(xml) };
  return { ok: true, etag: xmlText(xml, 'ETag').replace(/"/g, ''), parts: listed.parts.length };
}

async function multipartAbort(cfg, bucket, key, uploadId) {
  const response = await b2Fetch(cfg, 'DELETE', objectUrl(cfg, bucket, key), { query: { uploadId } });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true };
}

/* ============================ 6. 管理 API ============================ */

async function readJsonBody(request) {
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

/** API 场景下的桶名解析：支持 <bucket>/__api/... 与 ?bucket= 两种写法 */
function resolveApiBucket(cfg, basePath, url) {
  if (cfg.bucketMode === 'fixed') return cfg.bucketFixed;
  if (cfg.bucketMode === 'host') return url.hostname.split('.')[0];
  const fromPath = basePath.split('/').filter(Boolean)[0];
  return fromPath || url.searchParams.get('bucket') || '';
}

async function apiRouter(request, env, ctx, cfg, url) {
  const apiIndex = url.pathname.indexOf(API_PREFIX);
  const basePath = url.pathname.slice(0, apiIndex);
  const route = url.pathname.slice(apiIndex + API_PREFIX.length).replace(/^\/+/, '');
  const parts = route.split('/');
  const action = parts[0] || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, cfg) });
  }

  // health 无需鉴权，且不泄露任何敏感配置
  if (action === 'health') {
    return json({
      ok: true,
      service: 'cf-b2-worker',
      bucketMode: cfg.bucketMode,
      region: cfg.region,
      publicRead: cfg.publicRead,
      publicPrefix: cfg.publicPrefix || '',
      authenticated: (await checkAuth(request, cfg)).ok,
    }, 200, request, cfg);
  }

  const auth = await checkAuth(request, cfg);
  if (!auth.ok) return deny(auth.reason, request, cfg, 401);

  const targetBucket = resolveApiBucket(cfg, basePath, url);
  if (!targetBucket) {
    return deny('无法确定桶名（请写成 /<bucket>' + API_PREFIX + '... 或携带 ?bucket=）', request, cfg, 400);
  }

  switch (action) {
    /* ---- 列举 ---- */
    case 'list': {
      const result = await listObjects(cfg, targetBucket, {
        prefix: normalizeKey(url.searchParams.get('prefix') || ''),
        delimiter: url.searchParams.get('recursive') === '1' ? '' : '/',
        limit: readInt(url.searchParams.get('limit'), 1000),
        cursor: url.searchParams.get('cursor') || '',
      });
      if (!result.ok) return deny(result.error, request, cfg, result.status || 502);
      return json({ ok: true, bucket: targetBucket, ...result }, 200, request, cfg);
    }

    /* ---- 预签名 URL ---- */
    case 'presign': {
      const key = normalizeKey(url.searchParams.get('key') || '');
      if (!key) return deny('缺少 key', request, cfg, 400);
      const isPut = (url.searchParams.get('type') || 'get') === 'put';
      const expires = readInt(url.searchParams.get('expires'), cfg.presignExpires);
      const query = {};
      if (url.searchParams.get('download')) {
        query['response-content-disposition'] =
          "attachment; filename*=UTF-8''" + encodeURIComponent(key.split('/').pop());
      }
      const signedUrl = await signerOf(cfg).sign(isPut ? 'PUT' : 'GET', objectUrl(cfg, targetBucket, key), {
        headers: isPut
          ? { 'content-type': url.searchParams.get('ct') || 'application/octet-stream' }
          : {},
        query,
        unsignedPayload: true,
        expiresIn: expires,
      });
      return json({ ok: true, url: signedUrl, method: isPut ? 'PUT' : 'GET', expires }, 200, request, cfg);
    }

    /* ---- 对象读写删（REST 风格） ---- */
    case 'object': {
      const key = normalizeKey(url.searchParams.get('key') || '');
      if (!key) return deny('缺少 key', request, cfg, 400);

      if (request.method === 'DELETE') {
        if (!cfg.enableDelete) return deny('已禁用删除（ENABLE_DELETE=false）', request, cfg, 403);
        const res = await deleteObject(cfg, targetBucket, key);
        return json(res, res.ok ? 200 : (res.status || 500), request, cfg);
      }
      if (request.method === 'PUT') {
        if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
        return putObject(request, cfg, targetBucket, key);
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return readObject(request, env, ctx, cfg, targetBucket, key);
      }
      return deny('不支持的请求方法', request, cfg, 405);
    }

    /* ---- 复制 / 移动 ---- */
    case 'copy': {
      if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
      const body = await readJsonBody(request);
      const from = normalizeKey(body.from || '');
      const to = normalizeKey(body.to || '');
      if (!from || !to) return deny('需要 from 与 to', request, cfg, 400);
      const res = await copyObject(cfg, targetBucket, from, to);
      if (!res.ok) return deny(res.error, request, cfg, res.status || 500);
      const moved = body.move === true || url.searchParams.get('move') === '1';
      if (moved) await deleteObject(cfg, targetBucket, from);
      return json({ ok: true, from, to, moved }, 200, request, cfg);
    }

    /* ---- 创建目录（0 字节 .keep 占位对象） ---- */
    case 'mkdir': {
      if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
      const body = await readJsonBody(request);
      const prefix = normalizeKey(body.prefix || '');
      if (!prefix) return deny('需要 prefix', request, cfg, 400);
      const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, targetBucket, prefix + '/.keep'), {
        headers: { 'content-type': 'application/octet-stream' },
        body: '',
      });
      if (!response.ok) return deny(extractError(await response.text()), request, cfg, response.status);
      return json({ ok: true, prefix }, 200, request, cfg);
    }

    /* ---- 分片上传 ---- */
    case 'multipart': {
      const sub = parts[1] || '';
      const key = normalizeKey(url.searchParams.get('key') || '');

      if (sub === 'create') {
        if (!key) return deny('缺少 key', request, cfg, 400);
        const body = await readJsonBody(request);
        const res = await multipartCreate(cfg, targetBucket, key, body.contentType);
        return json(res, res.ok ? 200 : (res.status || 500), request, cfg);
      }

      if (sub === 'part') {
        const uploadId = url.searchParams.get('uploadId') || '';
        const partNumber = readInt(url.searchParams.get('partNumber'), 0);
        if (!key || !uploadId || partNumber < 1) {
          return deny('需要 key / uploadId / partNumber', request, cfg, 400);
        }
        const signedUrl = await signerOf(cfg).sign('PUT', objectUrl(cfg, targetBucket, key), {
          query: { partNumber: String(partNumber), uploadId },
          unsignedPayload: true,
          expiresIn: cfg.presignExpires,
        });
        return json({ ok: true, url: signedUrl, partNumber }, 200, request, cfg);
      }

      if (sub === 'complete') {
        const body = await readJsonBody(request);
        const uploadId = String(body.uploadId || '');
        if (!key || !uploadId) return deny('需要 key / uploadId', request, cfg, 400);
        const res = await multipartComplete(cfg, targetBucket, key, uploadId);
        return json(res, res.ok ? 200 : (res.status || 500), request, cfg);
      }

      if (sub === 'abort') {
        const body = await readJsonBody(request);
        const res = await multipartAbort(cfg, targetBucket, key, String(body.uploadId || ''));
        return json(res, res.ok ? 200 : (res.status || 500), request, cfg);
      }

      return deny('未知的 multipart 子命令', request, cfg, 404);
    }

    default:
      return deny('未知的 API 端点: ' + action, request, cfg, 404);
  }
}

/* ============================ 7. 目录列表页 ============================ */

function escapeHtml(str) {
  return String(str).split('&').join('&amp;').split('<').join('&lt;')
    .split('>').join('&gt;').split('"').join('&quot;');
}

function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(unit === 0 ? 0 : 1) + ' ' + units[unit];
}

function renderDirectory(data, prefix, base, bucketLabel) {
  const rows = [];

  if (prefix) {
    const parent = prefix.split('/').slice(0, -1).join('/');
    rows.push('<tr><td colspan="4"><a href="' + base
      + escapeHtml(parent ? parent + '/' : '') + '">返回上一级</a></td></tr>');
  }

  for (const folder of data.folders) {
    const name = folder.slice(prefix.length).replace(/\/$/, '');
    rows.push('<tr><td>[DIR] <a href="' + base + escapeHtml(folder) + '">' + escapeHtml(name) + '/</a></td>'
      + '<td>-</td><td>-</td>'
      + '<td><a href="' + base + escapeHtml(folder) + '?format=json">JSON</a></td></tr>');
  }

  for (const file of data.files) {
    const href = base + escapeHtml(prefix + file.name);
    rows.push('<tr><td>[FILE] <a href="' + href + '">' + escapeHtml(file.name) + '</a></td>'
      + '<td>' + humanSize(file.size) + '</td>'
      + '<td>' + escapeHtml(file.lastModified) + '</td>'
      + '<td><a href="' + href + '">下载</a></td></tr>');
  }

  const nextLink = data.truncated && data.nextToken
    ? '<a href="' + base + escapeHtml(prefix) + '?format=html&cursor='
      + encodeURIComponent(data.nextToken) + '">下一页</a>'
    : '';

  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(prefix || '/') + ' - B2 Index</title>',
    '<style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:32px}',
    '.wrap{max-width:900px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}',
    '.sub{color:#8b93a7;font-size:13px;margin-bottom:20px}',
    'table{width:100%;border-collapse:collapse;background:#161a22;border-radius:10px;overflow:hidden}',
    'td{padding:10px 14px;border-bottom:1px solid #222836;font-size:14px}',
    'tr:last-child td{border-bottom:0}a{color:#7cc4ff;text-decoration:none}',
    'a:hover{text-decoration:underline}.empty{color:#8b93a7;padding:24px;text-align:center}',
    '</style></head><body><div class="wrap">',
    '<h1>' + escapeHtml(bucketLabel) + ' - /' + escapeHtml(prefix) + '</h1>',
    '<div class="sub">' + data.folders.length + ' 个目录 / ' + data.files.length
      + ' 个文件 · <a href="' + base + MANAGE_PATH.slice(1) + '">打开管理器</a></div>',
    '<table>' + (rows.join('') || '<tr><td class="empty">（空）</td></tr>') + '</table>',
    '<div style="margin-top:16px">' + nextLink + '</div>',
    '</div></body></html>',
  ].join('\n');
}

/** 匿名访问未被授权目录时的引导页（ROOT_ACTION=welcome） */
function welcomePage(cfg, bucketLabel, prefix, publicPath) {
  const manageUrl = MANAGE_PATH;
  const shareUrl = publicPath || '/';
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>B2 资源网关</title>',
    '<style>',
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}',
    '.card{max-width:560px;padding:32px 36px;background:#161a22;border:1px solid #222836;border-radius:14px}',
    'h1{font-size:19px;margin:0 0 10px}p{color:#8b93a7;line-height:1.7;font-size:14px;margin:6px 0}',
    'code{background:#1d222d;padding:2px 6px;border-radius:5px;color:#7cc4ff}',
    'a{color:#4c8dff}.btn{display:inline-block;margin-top:18px;padding:9px 16px;background:#4c8dff;color:#fff;border-radius:8px;text-decoration:none;font-size:14px}',
    'ul{color:#8b93a7;font-size:13px;line-height:1.9;padding-left:18px}',
    '</style></head><body><div class="card">',
    '<h1>📦 Backblaze B2 资源网关</h1>',
    '<p>服务已就绪。请通过<strong>完整对象路径</strong>访问资源：</p>',
    '<p>根路径 <code>/</code> 的目录浏览未对匿名开放。</p>',
    '<ul>',
    (cfg.publicPrefix
      ? '<li>公开目录：<a href="' + shareUrl + '"><code>' + shareUrl + '</code></a>（匿名可直接下载）</li>'
        + '<li>其他目录需登录后访问：<a href="' + manageUrl + '">打开 ' + manageUrl + '</a></li>'
      : '<li>匿名下载：<code>/&lt;对象key&gt;</code>，例如 <code>/photos/a.jpg</code></li>'
        + '<li>可视化管理：<a href="' + manageUrl + '">打开 ' + manageUrl + '</a></li>'),
    '</ul>',
    '<p style="margin-top:14px">当前桶：<code>' + escapeHtml(bucketLabel) + '</code>'
      + (prefix ? ' · 前缀 <code>' + escapeHtml(prefix) + '</code>' : '')
      + ' · 区域 <code>' + escapeHtml(cfg.region) + '</code></p>',
    '<a class="btn" href="' + manageUrl + '">进入文件管理器</a>',
    '</div></body></html>',
  ].join('\n');
}

/* ============================ 8. 文件管理器页面 ============================ */

function managePage(cfg, url) {
  // $path 模式下，管理器可以挂在 /<bucket>/__manage，此时 API 也走同名前缀
  let apiBase = API_PREFIX;
  let defaultBucket = '';
  if (cfg.bucketMode === 'fixed') {
    defaultBucket = cfg.bucketFixed;
  } else if (cfg.bucketMode === 'path') {
    const basePath = url.pathname.slice(0, url.pathname.lastIndexOf(MANAGE_PATH));
    const bucketFromPath = basePath.split('/').filter(Boolean)[0];
    if (bucketFromPath) apiBase = '/' + bucketFromPath + API_PREFIX;
    else defaultBucket = url.searchParams.get('bucket') || '';
  }

  const configJson = JSON.stringify({
    apiBase,
    defaultBucket,
    publicPrefix: cfg.publicPrefix,
    bucketMode: cfg.bucketMode,
    bucketFixed: cfg.bucketFixed,
    hasToken: Boolean(cfg.adminToken),
    hasBasic: Boolean(cfg.adminUser || cfg.adminPass),
    publicWrite: cfg.publicWrite,
    enableWrite: cfg.enableWrite,
    enableDelete: cfg.enableDelete,
    multipartThreshold: cfg.multipartThreshold,
    multipartPartSize: cfg.multipartPartSize,
    maxUploadBytes: cfg.maxUploadBytes,
    apiPrefix: API_PREFIX,
  });

  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>B2 文件管理器</title>',
    '<style>',
    ':root{--bg:#0f1115;--card:#161a22;--line:#222836;--txt:#e6e6e6;--dim:#8b93a7;--acc:#4c8dff}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px}',
    'header{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--line);background:#12151c;position:sticky;top:0;z-index:5;flex-wrap:wrap}',
    'header h1{font-size:15px;margin:0;font-weight:600}',
    '.grow{flex:1}',
    'button,input{font:inherit;color:var(--txt);background:#1d222d;border:1px solid var(--line);border-radius:8px;padding:6px 10px}',
    'button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:#fff}',
    'button.ghost{background:#1d222d;color:var(--txt);border-color:var(--line)}',
    'button.mini{padding:3px 7px;font-size:12px;background:#1d222d;border-color:var(--line);color:var(--txt)}',
    'button:disabled{opacity:.45;cursor:not-allowed}',
    'main{max-width:1180px;margin:0 auto;padding:20px}',
    '#drop{border:1.5px dashed #2c3444;border-radius:12px;padding:20px;text-align:center;color:var(--dim);margin-bottom:16px}',
    '#drop.over{border-color:var(--acc);color:#fff;background:#151a26}',
    'table{width:100%;border-collapse:collapse;background:var(--card);border-radius:12px;overflow:hidden}',
    'th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left}',
    'th{color:var(--dim);font-weight:500;font-size:12px;letter-spacing:.04em}',
    'tr:last-child td{border-bottom:0}tr:hover td{background:#1a1f29}',
    '.muted{color:var(--dim)}',
    '.bar{height:6px;border-radius:4px;background:#232a38;overflow:hidden;margin-top:6px}',
    '.bar>i{display:block;height:100%;background:var(--acc);width:0}',
    '#toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:20}',
    '.t{padding:10px 14px;border-radius:8px;background:#1d222d;border:1px solid var(--line);max-width:440px}',
    '.t.err{border-color:#ff6b6b;color:#ffb3b3}',
    '.hidden{display:none}',
    '.crumb a{color:var(--acc);cursor:pointer}',
    '</style></head><body>',
    '<header>',
    '<h1>Backblaze B2 文件管理器</h1>',
    '<span class="muted" id="bucketLabel"></span>',
    '<span class="grow"></span>',
    '<input id="fUser" placeholder="用户名" size="10">',
    '<input id="fPass" type="password" placeholder="密码 / 令牌" size="16">',
    '<button class="ghost" id="btnLogin">鉴权</button>',
    '<button class="ghost" id="btnRefresh">刷新</button>',
    '<button class="ghost" id="btnMkdir">新建目录</button>',
    '<button id="btnUpload">上传</button>',
    '<input type="file" id="file" multiple class="hidden">',
    '</header>',
    '<main>',
    '<div id="drop">把文件拖到这里上传，或点击右上角「上传」<br><span class="muted" id="capHint"></span></div>',
    '<nav class="crumb" id="crumb" style="margin-bottom:12px"></nav>',
    '<table><thead><tr><th>名称</th><th style="width:110px">大小</th>',
    '<th style="width:180px">修改时间</th><th style="width:260px;text-align:right">操作</th></tr></thead>',
    '<tbody id="tb"></tbody></table>',
    '<div style="margin-top:14px;display:flex;gap:8px;align-items:center">',
    '<button class="ghost" id="btnPrev">上一页</button>',
    '<button class="ghost" id="btnNext">下一页</button>',
    '<span class="muted" id="pageHint"></span></div>',
    '</main>',
    '<div id="toast"></div>',
    '<script id="cfg" type="application/json">' + configJson + '</script>',
    '<script>',
    '(function () {',
    'var CFG = JSON.parse(document.getElementById("cfg").textContent);',
    'var API = CFG.apiBase;',
    'var PREFIX = "";',
    'var TOKENS = [];',
    'var NEXT = "";',
    'var TOKEN = "";',
    'var SELECT = null;',
    'function el(id) { return document.getElementById(id); }',
    'function esc(s) {',
    '  return String(s).split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split(String.fromCharCode(34)).join("&quot;");',
    '}',
    'function size(b) {',
    '  if (!b) return "0 B";',
    '  var u = ["B","KB","MB","GB","TB"], v = b, i = 0;',
    '  while (v >= 1024 && i < u.length - 1) { v = v / 1024; i++; }',
    '  return v.toFixed(i ? 1 : 0) + " " + u[i];',
    '}',
    'function toast(msg, isErr) {',
    '  var d = document.createElement("div");',
    '  d.className = "t" + (isErr ? " err" : "");',
    '  d.textContent = msg;',
    '  el("toast").appendChild(d);',
    '  setTimeout(function () { d.parentNode && d.parentNode.removeChild(d); }, isErr ? 6000 : 2600);',
    '}',
    'function buildHeaders(withBody) {',
    '  var h = { Accept: "application/json" };',
    '  if (withBody) h["Content-Type"] = "application/json";',
    '  if (CFG.publicWrite) return h;',
    '  if (TOKEN) { h.Authorization = "Bearer " + TOKEN; return h; }',
    '  var u = el("fUser").value, p = el("fPass").value;',
    '  if (CFG.hasToken && p) { h.Authorization = "Bearer " + p; return h; }',
    '  if (CFG.hasBasic && (u || p)) { h.Authorization = "Basic " + btoa(u + ":" + p); return h; }',
    '  return h;',
    '}',
    'function call(path, opts) {',
    '  opts = opts || {};',
    '  opts.headers = buildHeaders(!!opts.body);',
    '  opts.credentials = "same-origin";',
    '  return fetch(API + path, opts).then(function (r) {',
    '    return r.json().then(function (j) { return { ok: r.ok && j.ok !== false, status: r.status, data: j }; });',
    '  });',
    '}',
    'function q(p) {',
    '  var parts = [];',
    '  for (var k in p) {',
    '    if (p[k] !== undefined && p[k] !== null && p[k] !== "") parts.push(k + "=" + encodeURIComponent(p[k]));',
    '  }',
    '  if (CFG.defaultBucket) parts.push("bucket=" + encodeURIComponent(CFG.defaultBucket));',
    '  return parts.length ? "?" + parts.join("&") : "";',
    '}',
    'function load(prefix, cursor) {',
    '  PREFIX = prefix || "";',
    '  return call("list" + q({ prefix: PREFIX, cursor: cursor || "" })).then(function (r) {',
    '    if (!r.ok) { toast("列举失败: " + (r.data.error || r.status), true); return; }',
    '    TOKENS = cursor ? TOKENS.concat([cursor]) : [];',
    '    NEXT = r.data.nextToken || "";',
    '    render(r.data);',
    '  });',
    '}',
    'function render(data) {',
    '  var rows = "";',
    '  if (PREFIX) rows += \'<tr><td><a data-act="up">.. 返回上级</a></td><td></td><td></td><td></td></tr>\';',
    '  (data.folders || []).forEach(function (p) {',
    '    var name = p.slice(PREFIX.length);',
    '    if (name.charAt(name.length - 1) === "/") name = name.slice(0, -1);',
    '    rows += "<tr><td>[DIR] <a data-act=\\"dir\\" data-p=\\"" + esc(p) + "\\">" + esc(name) + "</a></td>"',
    '      + "<td class=\\"muted\\">目录</td><td></td>"',
    '      + "<td style=\\"text-align:right\\"><button class=\\"mini\\" data-act=\\"deldir\\" data-k=\\"" + esc(p + ".keep") + "\\">删除</button></td></tr>";',
    '  });',
    '  (data.files || []).forEach(function (f) {',
    '    var k = esc(PREFIX + f.name);',
    '    rows += "<tr><td>" + esc(f.name) + "</td><td>" + size(f.size) + "</td>"',
    '      + "<td class=\\"muted\\">" + esc(f.lastModified) + "</td>"',
    '      + \'<td style="text-align:right">\'',
    '      + \'<button class="mini" data-act="link" data-k="\' + k + \'">直链</button> \'',
    '      + \'<button class="mini" data-act="dl" data-k="\' + k + \'">下载</button> \'',
    '      + \'<button class="mini" data-act="ren" data-k="\' + k + \'">重命名</button> \'',
    '      + \'<button class="mini" data-act="del" data-k="\' + k + \'">删除</button>\'',
    '      + "</td></tr>";',
    '  });',
    '  el("tb").innerHTML = rows || \'<tr><td colspan="4" class="muted">（空目录）</td></tr>\';',
    '  var crumb = [\'<a data-act="dir" data-p="">根目录</a>\'];',
    '  var acc = "";',
    '  PREFIX.split("/").forEach(function (seg) {',
    '    if (!seg) return;',
    '    acc += seg + "/";',
    '    crumb.push(\' <span class="muted">/</span> <a data-act="dir" data-p="\' + esc(acc) + \'">\' + esc(seg) + "</a>");',
    '  });',
    '  el("crumb").innerHTML = crumb.join("");',
    '  el("pageHint").textContent = "本页 " + (data.files || []).length + " 个文件 · 是否有下一页: " + (data.truncated ? "是" : "否");',
    '  el("btnPrev").disabled = TOKENS.length === 0;',
    '  el("btnNext").disabled = !data.truncated;',
    '}',
    'function refresh() { load(PREFIX); }',
    'function uploadFiles(files) {',
    '  for (var i = 0; i < files.length; i++) {',
    '    var f = files[i];',
    '    var key = PREFIX + f.name;',
    '    if (CFG.multipartThreshold > 0 && f.size > CFG.multipartThreshold) mpUpload(f, key);',
    '    else simpleUpload(f, key);',
    '  }',
    '}',
    'function progressRow(file) {',
    '  var tr = document.createElement("tr");',
    '  tr.innerHTML = "<td>" + esc(file.name) + \'<div class="bar"><i></i></div></td>\'',
    '    + "<td>" + size(file.size) + \'</td><td class="muted">上传中</td><td></td>\';',
    '  el("tb").insertBefore(tr, el("tb").firstChild);',
    '  return function (pct) {',
    '    tr.querySelector(".bar > i").style.width = pct + "%";',
    '    if (pct >= 100) tr.children[2].textContent = "处理中";',
    '  };',
    '}',
    'function putXHR(url, blob, ct, setPct) {',
    '  return new Promise(function (resolve, reject) {',
    '    var xhr = new XMLHttpRequest();',
    '    xhr.open("PUT", url, true);',
    '    xhr.setRequestHeader("Content-Type", ct);',
    '    xhr.setRequestHeader("x-amz-content-sha256", "UNSIGNED-PAYLOAD");',
    '    xhr.upload.onprogress = function (e) {',
    '      if (e.lengthComputable && setPct) setPct(Math.round(e.loaded / e.total * 100));',
    '    };',
    '    xhr.onload = function () {',
    '      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);',
    '      else reject(new Error("HTTP " + xhr.status + " " + String(xhr.responseText || "").slice(0, 200)));',
    '    };',
    '    xhr.onerror = function () { reject(new Error("网络错误，请确认桶的 CORS 允许本站 PUT")); };',
    '    xhr.send(blob);',
    '  });',
    '}',
    'function simpleUpload(file, key) {',
    '  var setPct = progressRow(file);',
    '  var ct = file.type || "application/octet-stream";',
    '  call("presign" + q({ key: key, type: "put", ct: ct })).then(function (r) {',
    '    if (!r.ok) { toast("预签名失败: " + (r.data.error || r.status), true); return; }',
    '    return putXHR(r.data.url, file, ct, setPct).then(function () {',
    '      setPct(100); toast("上传完成: " + key); refresh();',
    '    });',
    '  }).catch(function (e) { toast("上传失败: " + e.message, true); });',
    '}',
    'function mpUpload(file, key) {',
    '  var setPct = progressRow(file);',
    '  var partSize = CFG.multipartPartSize || 25 * 1024 * 1024;',
    '  var total = Math.ceil(file.size / partSize);',
    '  var ct = file.type || "application/octet-stream";',
    '  call("multipart/create" + q({ key: key }), { method: "POST", body: JSON.stringify({ contentType: ct }) })',
    '    .then(function (r) {',
    '      if (!r.ok) throw new Error(r.data.error || r.status);',
    '      var uploadId = r.data.uploadId;',
    '      var chain = Promise.resolve();',
    '      var done = 0;',
    '      for (var n = 1; n <= total; n++) {',
    '        chain = chain.then(makeStep(n, key, uploadId, partSize, file, function () {',
    '          done++; setPct(Math.round(done / total * 100));',
    '        }));',
    '      }',
    '      return chain.then(function () {',
    '        return call("multipart/complete" + q({ key: key }), {',
    '          method: "POST", body: JSON.stringify({ uploadId: uploadId }),',
    '        });',
    '      });',
    '    })',
    '    .then(function (r) {',
    '      toast(r.ok ? "分片上传完成: " + key : "合并失败: " + ((r.data && r.data.error) || "未知"), !r.ok);',
    '      refresh();',
    '    })',
    '    .catch(function (e) { toast("分片上传失败: " + e.message, true); });',
    '}',
    'function makeStep(n, key, uploadId, partSize, file, done) {',
    '  return function () {',
    '    return call("multipart/part" + q({ key: key, uploadId: uploadId, partNumber: n })).then(function (pr) {',
    '      if (!pr.ok) throw new Error(pr.data.error || pr.status);',
    '      var start = (n - 1) * partSize;',
    '      var chunk = file.slice(start, Math.min(start + partSize, file.size));',
    '      return putXHR(pr.data.url, chunk, "application/octet-stream", null).then(done);',
    '    });',
    '  };',
    '}',
    'function act(a) {',
    '  var k = a.getAttribute("data-k") || "";',
    '  var p = a.getAttribute("data-p") || "";',
    '  if (a.dataset) {',
    '    if (a.dataset.k) k = a.dataset.k;',
    '    if (a.dataset.p) p = a.dataset.p;',
    '  }',
    '  switch (a.getAttribute("data-act")) {',
    '    case "up":',
    '      var segs = PREFIX.split("/");',
    '      segs.pop(); segs.pop();',
    '      load(segs.length ? segs.join("/") + "/" : "");',
    '      break;',
    '    case "dir": load(p); break;',
    '    case "dl":',
    '      call("presign" + q({ key: k, type: "get", download: "1" })).then(function (r) {',
    '        if (r.ok) window.open(r.data.url, "_blank"); else toast("预签名失败", true);',
    '      });',
    '      break;',
    '    case "link":',
    '      call("presign" + q({ key: k, type: "get" })).then(function (r) {',
    '        if (!r.ok) { toast("预签名失败", true); return; }',
    '        var ta = document.createElement("input");',
    '        ta.value = r.data.url; document.body.appendChild(ta); ta.select();',
    '        try { document.execCommand("copy"); toast("直链已复制（默认 1 小时有效）"); }',
    '        catch (e) { window.prompt("复制这条直链", r.data.url); }',
    '        document.body.removeChild(ta);',
    '      });',
    '      break;',
    '    case "ren":',
    '      var target = window.prompt("重命名为：", k.split("/").pop());',
    '      if (!target) return;',
    '      call("copy", { method: "POST", body: JSON.stringify({ from: k, to: PREFIX + target, move: true }) })',
    '        .then(function (r) { toast(r.ok ? "已重命名" : "失败: " + (r.data.error || r.status), !r.ok); refresh(); });',
    '      break;',
    '    case "del":',
    '    case "deldir":',
    '      if (!CFG.enableDelete) { toast("服务端已禁用删除", true); return; }',
    '      if (!window.confirm("确认删除 " + k + " ？")) return;',
    '      call("object" + q({ key: k }), { method: "DELETE" })',
    '        .then(function (r) { toast(r.ok ? "已删除" : "删除失败: " + (r.data.error || r.status), !r.ok); refresh(); });',
    '      break;',
    '    default: break;',
    '  }',
    '}',
    'el("tb").addEventListener("click", function (e) {',
    '  var t = e.target;',
    '  while (t && t !== this && t.tagName !== "BUTTON" && t.tagName !== "A") t = t.parentNode;',
    '  if (!t || t === this) return;',
    '  act(t);',
    '});',
    'el("crumb").addEventListener("click", function (e) {',
    '  if (e.target.tagName === "A") act(e.target);',
    '});',
    'el("btnRefresh").onclick = refresh;',
    'el("btnPrev").onclick = function () {',
    '  var t = TOKENS.slice(); t.pop(); load(PREFIX, t[t.length - 1] || ""); TOKENS = t;',
    '};',
    'el("btnNext").onclick = function () { load(PREFIX, NEXT); };',
    'el("btnUpload").onclick = function () { el("file").click(); };',
    'el("file").onchange = function () { uploadFiles(this.files); this.value = ""; };',
    'el("btnMkdir").onclick = function () {',
    '  var name = window.prompt("目录名：");',
    '  if (!name) return;',
    '  name = name.split("/").join("");',
    '  call("mkdir", { method: "POST", body: JSON.stringify({ prefix: PREFIX + name }) })',
    '    .then(function (r) { toast(r.ok ? "已创建" : "创建失败: " + (r.data.error || r.status), !r.ok); refresh(); });',
    '};',
    'el("btnLogin").onclick = function () {',
    '  SELECT = null;',
    '  if (CFG.hasToken) TOKEN = el("fPass").value; else TOKEN = "";',
    '  call("health").then(function (r) {',
    '    toast(r.data && r.data.authenticated ? "鉴权成功" : "鉴权失败", !(r.data && r.data.authenticated));',
    '    refresh();',
    '  });',
    '};',
    'var dz = el("drop");',
    '["dragenter", "dragover"].forEach(function (ev) {',
    '  dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); });',
    '});',
    '["dragleave", "drop"].forEach(function (ev) {',
    '  dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); });',
    '});',
    'dz.addEventListener("drop", function (e) {',
    '  if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);',
    '});',
    'el("capHint").textContent = "直传不受 Workers 限制；超过 " + size(CFG.multipartThreshold) + " 自动启用分片上传"',
    '  + (CFG.publicPrefix ? "；匿名只读目录: /" + CFG.publicPrefix + "/" : "") + "（登录后可管理全部文件）";',
    'el("bucketLabel").textContent = CFG.bucketMode === "fixed"',
    '  ? ("桶: " + CFG.bucketFixed)',
    '  : (CFG.bucketMode === "path" ? "桶: 按 URL 首段动态解析" : "桶: 按主机名首段动态解析");',
    'if (CFG.publicWrite) el("btnLogin").className = "ghost hidden";',
    'if (CFG.hasToken) { el("fUser").className = "hidden"; el("fPass").placeholder = "Bearer 令牌"; }',
    'load("");',
    '})();',
    '</script>',
    '</body></html>',
  ].join('\n');
}

/* ============================ 9. 主入口与路由 ============================ */

async function handle(request, env, ctx) {
  const cfg = loadConfig(env);
  const url = new URL(request.url);

  const missing = [];
  if (!cfg.accessKeyId) missing.push('B2_KEY_ID / B2_APPLICATION_KEY_ID');
  if (!cfg.secretAccessKey) missing.push('B2_APPLICATION_KEY');
  if (cfg.bucketMode === 'fixed' && !cfg.bucketFixed) missing.push('BUCKET_NAME');
  if (missing.length) {
    return json({ ok: false, error: '缺少必需配置: ' + missing.join(', ') }, 500, request, cfg);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, cfg) });
  }

  /* ---- 管理 API（也支持 /<bucket>/__api/... 形式） ---- */
  if (url.pathname.includes(API_PREFIX)) {
    return apiRouter(request, env, ctx, cfg, url);
  }

  /* ---- 文件管理器页面（也支持 /<bucket>/__manage 形式） ---- */
  if (cfg.enableManage && url.pathname.endsWith(MANAGE_PATH)) {
    const auth = await checkAuth(request, cfg);
    if (!auth.ok) return challenge(request, cfg);
    return html(managePage(cfg, url));
  }

  const resolved = resolveBucketKey(cfg, url);
  const bucket = resolved.bucket;
  if (!bucket) return deny('无法确定桶名', request, cfg, 400);

  switch (request.method) {
    case 'GET':
    case 'HEAD': {
      /* 统一的访问口径：
       *   管理员（Basic/Bearer 通过）   → 全部权限
       *   匿名                          → 只能读/列 PUBLIC_PREFIX（默认 share）以内，其余拒绝
       *                                  且访问根路径自动 302 到 /<PUBLIC_PREFIX>/
       */
      const auth = await checkAuth(request, cfg);
      const isAdmin = auth.ok;
      const anonymous = !isAdmin;
      const publicPath = publicBase(cfg, bucket) + prefixWithSlash(cfg.publicPrefix);

      if (resolved.isDir) {
        // 目录 → 列表（HTML 或 JSON）
        const prefix = normalizeKey(
          url.searchParams.get('prefix') || (resolved.key ? resolved.key + '/' : ''),
        );
        // 匿名列举：只允许在公开前缀内（PUBLIC_LIST），或全局开放 ALLOW_LIST_BUCKET
        const anonymousListingOk = anonymous && cfg.publicRead
          && ((cfg.publicPrefix && cfg.publicList && withinPrefix(prefix, cfg.publicPrefix)) || cfg.allowList);

        if (!isAdmin && !cfg.allowList && !anonymousListingOk) {
          // 匿名访问根路径 → 自动路由到公开目录
          if (!prefix && cfg.publicPrefix) {
            return Response.redirect(new URL(publicPath, url.origin).toString(), 302);
          }
          if (cfg.rootAction === 'welcome') return html(welcomePage(cfg, bucket, prefix, publicPath));
          if (cfg.rootAction === 'redirect') {
            return Response.redirect(new URL(MANAGE_PATH, url.origin).toString(), 302);
          }
          return json(
            { ok: false, error: '目录列举未开放（ALLOW_LIST_BUCKET=false），请带鉴权访问' },
            403, request, cfg,
          );
        }
        const result = await listObjects(cfg, bucket, {
          prefix, delimiter: '/',
          limit: readInt(url.searchParams.get('limit'), 1000),
          cursor: url.searchParams.get('cursor') || '',
        });
        if (!result.ok) return deny(result.error, request, cfg, result.status || 502);

        if (url.searchParams.get('format') === 'json') {
          return json({ ok: true, bucket, prefix, ...result }, 200, request, cfg);
        }
        const base = cfg.bucketMode === 'path' ? '/' + bucket + '/' : '/';
        return html(renderDirectory(result, prefix, base, bucket));
      }

      if (!resolved.key) return deny('缺少对象 key', request, cfg, 400);

      if (anonymous) {
        if (!cfg.publicRead) {
          return json({ ok: false, error: '该对象需要登录后访问' }, 403, request, cfg);
        }
        if (!withinPrefix(resolved.key, cfg.publicPrefix)) {
          return json({
            ok: false,
            error: '匿名只能访问公开目录 ' + publicPath + '，请登录后访问其他对象',
          }, 403, request, cfg);
        }
      }

      return readObject(request, env, ctx, cfg, bucket, applyRclone(cfg, resolved.key));
    }

    case 'PUT': {
      if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 405);
      if (!resolved.key) return deny('缺少对象 key', request, cfg, 400);
      const auth = await checkAuth(request, cfg);
      if (!auth.ok) return deny(auth.reason, request, cfg, 401);
      return putObject(request, cfg, bucket, resolved.key);
    }

    case 'DELETE': {
      if (!cfg.enableDelete) return deny('已禁用删除（ENABLE_DELETE=false）', request, cfg, 405);
      if (!resolved.key) return deny('缺少对象 key', request, cfg, 400);
      const auth = await checkAuth(request, cfg);
      if (!auth.ok) return deny(auth.reason, request, cfg, 401);
      const res = await deleteObject(cfg, bucket, resolved.key);
      return json(res, res.ok ? 200 : (res.status || 500), request, cfg);
    }

    case 'POST': {
      return json({
        ok: false,
        error: 'POST 请使用 ' + API_PREFIX + 'object / ' + API_PREFIX + 'copy / ' + API_PREFIX + 'mkdir',
      }, 400, request, cfg);
    }

    default:
      return deny('不支持的请求方法: ' + request.method, request, cfg, 405);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('[cf-b2-worker]', error && error.stack ? error.stack : error);
      return new Response(
        JSON.stringify({ ok: false, error: String((error && error.message) || error) }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
  },
};

/** 便于本地单元测试复用内部实现（Workers 允许额外具名导出） */
export {
  SigV4, loadConfig, resolveBucketKey, objectUrl, bucketUrl, normalizeKey,
  uriEncode, canonicalPath, safeEqual, handle, managePage, listObjects,
};
