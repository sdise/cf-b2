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
 *   · 下载强制经 Worker：不签发任何 GET 预签名直链，?dl=1 由 Worker 下发附件头
 *   · Cache API 边缘缓存 + Cache-Control 覆写
 *   · 目录列表（HTML/JSON；$path、$host、固定桶三种模式）
 *   · 网页文件管理器：浏览/上传/下载（经 Worker）/删除/重命名/建目录
 *   · 预签名 URL 仅用于「上传直传」与分片上传
 *   · S3 分片上传（create → part presign → complete / abort）
 *   · 访问控制：Basic/Bearer 恒定时间比较、公有读写开关、路径穿越防护、CORS 白名单
 *
 * 兼容性：Cloudflare Workers（ESM），compatibility_date >= 2023-09-04
 * ===================================================================================== */

/* eslint-disable */
/* ============================================================================
 * ⚠️ 自动生成，请勿直接编辑 —— 本文件由 tools/build.mjs 从 src/ 下的模块合并而来。
 *    修改源码后执行：npm run build
 * ============================================================================ */

/* ---------- src/lib/constants.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L34-L56 */

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

/* ---------- src/lib/crypto.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L57-L165 */

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

/**
 * 目录前缀：归一化后**必须保留尾斜杠**。
 * ListObjectsV2 要求 prefix 以 / 结尾，否则 "share" 下的对象会被折叠成单个
 * CommonPrefix "share/"，导致文件列表为空、只剩一个无名"目录"。
 */
function dirPrefix(value) {
  const normalized = normalizeKey(value);
  return normalized ? normalized + '/' : '';
}

/* ============================ 2. AWS Signature V4 ============================ */

/* ---------- src/lib/sigv4.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L166-L277 */



class SigV4 {
  constructor({ accessKeyId, secretAccessKey, region, service = SERVICE, keyCache = null }) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
    this.service = service;
    // 派生签名密钥（4 次 HMAC）对同一凭据/日期是常量；由 cfg 传入的请求级缓存可省去重复计算
    this.keyCache = keyCache;
  }

  async signingKey(dateStamp) {
    const cacheKey = this.accessKeyId + '|' + this.region + '|' + this.service + '|' + dateStamp;
    if (this.keyCache && this.keyCache.has(cacheKey)) return this.keyCache.get(cacheKey);
    let k = await hmac(encoder.encode('AWS4' + this.secretAccessKey), dateStamp);
    k = await hmac(k, this.region);
    k = await hmac(k, this.service);
    const key = await hmac(k, 'aws4_request');
    if (this.keyCache) this.keyCache.set(cacheKey, key);
    return key;
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

    // 无请求体时按 AWS 规范用空串哈希；流式或客户端直传用 UNSIGNED-PAYLOAD
    let payload = payloadHash;
    if (!payload) payload = unsignedPayload ? 'UNSIGNED-PAYLOAD' : await sha256Hex(body === null ? '' : body);

    // 预签名（查询串认证）时：日期由 X-Amz-Date 查询参数携带、载荷哈希只写进 canonical request，
    // 二者都不能作为请求头要求客户端发送，否则 B2 会返回
    // "header 'x-amz-date' is listed in signed headers, but is not present"（400）
    if (expiresIn <= 0) {
      h.set('x-amz-date', amzDate);
      h.set('x-amz-content-sha256', payload);
    }

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

/* ---------- src/lib/http.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L297-L334、原 L564-L621 */

const LEAKY_HEADERS = [
  'x-amz-request-id', 'x-amz-id-2', 'x-amz-version-id', 'x-amz-expiration',
  'x-amz-replication-status', 'x-amz-server-side-encryption',
  'x-amz-server-side-encryption-aws-kms-key-id', 'x-amz-mp-parts-count',
  'x-bz-content-sha1', 'x-bz-info-src_last_modified_millis',
];

function sanitizeUpstreamHeaders(headers) {
  for (const name of LEAKY_HEADERS) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-bz-') || name.startsWith('x-rgw-')) headers.delete(name);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.delete('Set-Cookie');
  return headers;
}

/** 对匿名请求隐藏上游错误细节，避免从 XML 里读出桶名 / 内部标识 */
function sanitizeUpstreamError(response, cfg, extraHeaders) {
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

/* ---------- src/lib/auth.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L622-L674 */



async function checkAuth(request, cfg) {
  if (cfg.publicWrite) return { ok: true, mode: 'public' };
  // Basic 模式要求用户名与密码同时配置：只配其一（例如漏配 ADMIN_USER）会退化成「空用户名 + 密码」，
  // 因此这里按「成对存在」判断，避免弱配置被绕过。
  const basicReady = Boolean(cfg.adminUser && cfg.adminPass);
  if (!cfg.adminToken && !basicReady) {
    return { ok: false, reason: '未配置 ADMIN_TOKEN 或完整的 ADMIN_USER/ADMIN_PASS（两者都需设置），操作已被默认拒绝' };
  }

  const authorization = request.headers.get('authorization') || '';

  if (authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (cfg.adminToken && await safeEqual(token, cfg.adminToken)) return { ok: true, mode: 'token' };
    return { ok: false, reason: 'Bearer token 无效' };
  }

  if (authorization.toLowerCase().startsWith('basic ')) {
    if (!basicReady) return { ok: false, reason: '未配置 Basic 凭据' };
    let decoded = '';
    try {
      decoded = atob(authorization.slice(6).trim());
    } catch {
      return { ok: false, reason: 'Basic 凭据格式错误' };
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return { ok: false, reason: 'Basic 凭据格式错误' };
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
  // 请求级缓存：同一 cfg（含 bucketView 浅拷贝）共享一份派生密钥，避免分片上传时逐片重算
  if (!cfg._sigKeyCache) cfg._sigKeyCache = new Map();
  return new SigV4({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: cfg.service,
    keyCache: cfg._sigKeyCache,
  });
}

/** 拼接对象 URL（默认 path-style，兼容性最好） */

/* ---------- src/lib/b2.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L675-L1057 */





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

/** 依据请求解析 { bucket, key, isDir }：以 / 结尾视为目录列举（多桶模式由 resolveMount 完成） */
function resolveBucketKey(cfg, url) {
  const rawPath = url.pathname.replace(/^\/+/, '');
  const isDir = rawPath === '' || rawPath.endsWith('/');
  const pathKey = safeDecode(rawPath.replace(/\/+$/, ''));
  return { bucket: cfg.bucketFixed, key: normalizeKey(pathKey), isDir };
}

/**
 * B2 事务分类的近似判定（官方没有对外的用量 API，只能自己数）：
 *   A = 上传 / 写入（PutObject、CreateMultipartUpload 等，B2 侧免费）
 *   B = 下载 / 读取（GetObject、HeadObject）
 *   C = 列举（ListObjectsV2、ListParts、ListMultipartUploads）
 *   D = 删除等（DeleteObject；multipart abort 归入写入类 A）
 */
function classifyB2(method, url) {
  const query = url.searchParams;
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') {
    if (query.has('list-type') || query.has('uploads') || query.has('uploadId')) return 'C';
    return 'B';
  }
  if (m === 'DELETE') return query.has('uploadId') ? 'A' : 'D';
  return 'A';
}

/** 单请求内的计数累加（cfg 是每请求独立对象，不会串请求） */
function recordUsage(cfg, cls) {
  if (!cfg || !cfg.usage || !cls) return;
  cfg.usage.counts[cls] = (cfg.usage.counts[cls] || 0) + 1;
}

async function b2Fetch(cfg, method, url, options = {}) {
  const { headers = {}, body = null, query = {}, unsignedPayload = false } = options;
  const request = await signerOf(cfg).sign(method, url, { headers, body, query, unsignedPayload });
  recordUsage(cfg, classifyB2(method, new URL(request.url || url)));
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
async function readObject(request, env, ctx, cfg, bucket, key, options = {}) {
  const { anonymous = false } = options;
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
    // 下载路径自带 Range 重试补偿，未走 b2Fetch，这里按实际发起的请求补记 Class B
    recordUsage(cfg, 'B');
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

  const responseHeaders = new Headers(response.headers);
  if (cfg.stripUpstreamMeta) sanitizeUpstreamHeaders(responseHeaders);

  if (method === 'HEAD') {
    if (!response.ok && anonymous) return sanitizeUpstreamError(response, cfg, corsHeaders(request, cfg));
    return new Response(null, {
      status: response.status, statusText: response.statusText, headers: responseHeaders,
    });
  }

  // 匿名请求不回传上游错误正文（XML 中可能含桶名/文件 ID），只回状态码
  if (!response.ok && anonymous) {
    return sanitizeUpstreamError(response, cfg, {
      'Cache-Control': 'no-store',
      ...(request && cfg ? corsHeaders(request, cfg) : {}),
    });
  }

  const headers = responseHeaders;
  if (cfg.cacheMaxAge > 0) headers.set('Cache-Control', 'public, max-age=' + cfg.cacheMaxAge);

  // 下载一律经 Worker：?dl=1 / ?download=1 时由 Worker 直接加附件头，不再签发预签名直链
  if (url.searchParams.get('dl') === '1' || url.searchParams.get('download') === '1') {
    headers.set(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" + encodeURIComponent(key.split('/').pop() || 'download'),
    );
  }
  if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.delete('Set-Cookie');

  const out = new Response(response.body, { status: response.status, headers });

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

  // 走 UNSIGNED-PAYLOAD：避免对最大 96MB 的请求体做 SHA-256（下载/复制早已如此），显著降低 CPU
  const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, bucket, key), { headers, body, unsignedPayload: true });
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

/**
 * 写/删对象后清理边缘缓存（Cache API 键是「公开对象 URL」，见 readObject）。
 * 覆盖两种挂载形态下的公开路径：/<桶>/<key> 与 /share/<桶>/<去公开前缀的 key>，并含 ?dl=1 变体。
 * 浏览器直传 B2（预签名）不经 Worker，无法在此清理，只能靠缓存 TTL 自然过期。
 */
function purgeObjectCache(ctx, cfg, bucket, key, origin) {
  if (!cfg.useCache || !origin) return;
  const enc = normalizeKey(key).split('/').map((s) => encodeURIComponent(s)).join('/');
  const paths = ['/' + bucket + '/' + enc];
  const prefix = (cfg.publicPrefix || '').replace(/\/+$/, '');
  if (prefix && enc.toLowerCase().startsWith(prefix.toLowerCase() + '/')) {
    paths.push('/share/' + bucket + '/' + enc.slice(prefix.length + 1));
  }
  const targets = [];
  for (const path of paths) targets.push(origin + path, origin + path + '?dl=1');
  for (const target of targets) {
    try {
      const del = caches && caches.default && caches.default.delete;
      if (typeof del !== 'function') continue;
      const pending = del.call(caches.default, target);
      if (pending && typeof pending.then === 'function') {
        const settled = pending.catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(settled);
      }
    } catch {
      /* 缓存不可用时忽略 */
    }
  }
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

/* ============================ 5.5 B2 用量面板 ============================ */
/*
 * 背景：Backblaze 没有公开的「用量 / 事务次数」查询 API（官方只在 Web 控制台提供
 * Caps & Alerts，计数器每天 00:00 GMT 重置）。因此这里：
 *   1) 空间：用 S3 ListObjectsV2 全量遍历累加 Size（每 1000 对象消耗 1 次 Class C）；
 *      只统计 current 版本，non-current / hidden 版本不计（比账单口径略小）。
 *   2) 次数：在唯一的出网点 b2Fetch 上按 B2 事务类别计数，写进 Cache API，
 *      按 UTC 日切；Cache API 没有原子操作，高并发下会丢极少量计数。
 * 频率控制：快照只由 Cron（scheduled）刷新；首次读取若还没有快照会引导性扫一次；
 * usageCacheTtl / USAGE_AUTO_SCAN 仅在使用者显式开启「惰性自动扫描」时起作用。
 * 打开管理页只读已有快照，不主动打 B2。
 */

/* ---------- src/lib/prefix.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L278-L296 */

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
/** 会暴露后端实现/对象内部信息的响应头，统一剥离 */

/* ---------- src/lib/hours.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L1065-L1092 */

/**
 * 解析 scheduled() 里的小时列表：
 *   "23"    → 只在 UTC 23 点执行
 *   "23,11" → 11 点与 23 点都执行
 *   "*"     → 每次触发都执行
 *   "-" 或空 → 从不执行
 */
function parseHourList(value, fallback) {
  const raw = String(value === undefined || value === '' ? fallback : value).trim();
  if (raw === '*') return { mode: 'always' };
  if (raw === '-') return { mode: 'never' };
  const hours = raw.split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  return hours.length ? { mode: 'hours', hours } : { mode: 'never' };
}

function hourMatches(spec, hour) {
  if (!spec || spec.mode === 'never') return false;
  if (spec.mode === 'always') return true;
  return spec.hours.includes(hour);
}

function hourListLabel(spec) {
  if (!spec || spec.mode === 'never') return '从不';
  if (spec.mode === 'always') return '每次触发';
  return spec.hours.slice().sort((a, b) => a - b).map((h) => h + ':00').join('、') + ' UTC';
}

/* ---------- src/lib/config.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L335-L563 */





const bucketVarsCache = new WeakMap();

function loadConfig(env) {
  let parsed = env && typeof env === 'object' ? bucketVarsCache.get(env) : null;
  if (!parsed) {
    parsed = parseBucketVars(env);
    if (env && typeof env === 'object') bucketVarsCache.set(env, parsed);
  }
  const { buckets, problems } = parsed;

  return {
    // 挂载表：BUCKET_1..N，每个桶可属于不同的 B2 账号（各自 KEY_ID / APPLICATION_KEY / ENDPOINT）
    buckets,
    mountProblems: problems,
    // 以下字段随请求按桶切换（applyBucket），这里仅是占位默认值
    accessKeyId: '',
    secretAccessKey: '',
    endpointOrigin: '',
    endpointHost: '',
    region: '',
    service: SERVICE,
    urlStyle: String(env.URL_STYLE || 'path').toLowerCase() === 'virtual' ? 'virtual' : 'path',

    bucketMode: 'fixed',
    bucketFixed: '',

    publicRead: readBool(env.PUBLIC_READ, true),
    publicWrite: readBool(env.PUBLIC_WRITE, false),
    // 匿名可读写的对象前缀；留空表示整个桶匿名可读（旧行为）
    publicPrefix: normalizePrefix(env.PUBLIC_PREFIX === undefined ? 'share' : env.PUBLIC_PREFIX),
    publicList: readBool(env.PUBLIC_LIST, true),
    allowList: readBool(env.ALLOW_LIST_BUCKET, false),
    enableWrite: readBool(env.ENABLE_WRITE, true),
    enableDelete: readBool(env.ENABLE_DELETE, true),
    enableManage: readBool(env.ENABLE_MANAGE, true),
    // 匿名信息收敛：隐藏桶名 / 区域，并剥离 B2 内部响应头
    hideDetails: readBool(env.HIDE_BUCKET_INFO, true),
    // 隐藏目录占位对象（<prefix>/.keep），目录页与管理器列表都不显示
    hideKeep: readBool(env.HIDE_KEEP_FILES, true),
    stripUpstreamMeta: readBool(env.STRIP_UPSTREAM_META, true),
    // 匿名访问目录时的行为：deny(返回403 JSON，默认) | redirect(302到管理器) | welcome(渲染引导页)
    rootAction: ['deny', 'redirect', 'welcome'].includes(String(env.ROOT_ACTION || 'deny').toLowerCase())
      ? String(env.ROOT_ACTION).toLowerCase() : 'deny',

    cacheMaxAge: readInt(env.CACHE_MAX_AGE, 86400),
    useCache: readBool(env.ENABLE_CACHE, true),
    rcloneDownload: readBool(env.RCLONE_DOWNLOAD, false),

    // Workers 请求体上限是十进制 100MB（100,000,000 字节），不是 100 MiB；
    // 默认再留 4MB 余量，避免上传到 99.9% 时被平台掐断（表现为连接中断 / HTTP 000）
    maxUploadBytes: readInt(env.MAX_UPLOAD_BYTES, 96 * 1000 * 1000),
    // Worker 代理分片上传的并发数
    uploadConcurrency: Math.max(1, Math.min(10, readInt(env.UPLOAD_CONCURRENCY, 3))),
    presignExpires: readInt(env.PRESIGN_EXPIRES, 3600),
    // 直传超过该体积 → 走并发分片。实测 B2 单次 PUT 上限为 100 MiB（104857600 字节），
    // 超过会被上游中断（500 InternalError / 连接被切断），故默认 100000000 并强制钳制在 100MiB 以下
    multipartThreshold: Math.min(readInt(env.MULTIPART_THRESHOLD, 100 * 1000 * 1000), 100 * 1024 * 1024 - 1),
    multipartPartSize: readInt(env.MULTIPART_PART_SIZE, 25 * 1024 * 1024),

    /* ---- B2 用量面板 ---- */
    enableUsage: readBool(env.ENABLE_USAGE_PANEL, true),
    // 「总空间」基准：默认按 B2 免费额度 10 GB（十进制）展示进度
    storageQuotaBytes: Math.max(0, readInt(env.STORAGE_QUOTA_BYTES, 10 * 1000 * 1000 * 1000)),
    // 空间扫描结果缓存时长（秒），默认 6 小时（仅 usageAutoScan=true 时用作过期判断）
    usageCacheTtl: Math.max(60, readInt(env.USAGE_CACHE_TTL, 21600)),
    // 单次扫描最多翻多少页（每页 1000 个对象 = 1 次 Class C）
    usageScanMaxPages: Math.max(1, Math.min(200, readInt(env.USAGE_SCAN_MAX_PAGES, 20))),
    // 空间统计模式：
    //   false（默认）= 快照只由 Cron（scheduled）刷新；首次读取若还没有快照会引导性扫一次
    //   true         = 额外允许惰性自动扫描（TTL 过期或落入窗口）
    // 注：已移除"手动重新统计"，任何请求路径都不会强制重扫
    usageAutoScan: readBool(env.USAGE_AUTO_SCAN, false),
    // 惰性窗口（仅 usageAutoScan=true 时生效）：UTC 进入该小时后当天第一次读取强制重扫（-1 关闭）
    usageRefreshHour: (() => {
      const hour = readInt(env.USAGE_REFRESH_AT_UTC_HOUR, -1);
      return hour >= 0 && hour <= 23 ? hour : -1;
    })(),
    // 定时统计的桶列表：直接来自挂载表（BUCKET_1..N）
    usageScheduleBuckets: [],
    // scheduled() 里「刷新空间快照」的 UTC 小时（逗号分隔；* = 每次触发都做；- = 从不）
    usageScanHours: parseHourList(env.USAGE_SCAN_HOURS, '23'),
    // scheduled() 里「重置 Class A/B/C/D 计数」的 UTC 小时。
    // 默认与 USAGE_SCAN_HOURS 相同（23）→ 一条 cron 同时完成"统计 + 归零"；
    // 计数区间 = 昨天 23:00 → 今天 23:00，与 B2 官方 00:00 GMT 有 1 小时偏移
    usageResetHours: parseHourList(env.USAGE_RESET_HOURS, '23'),
    // Durable Object 计数：每累计多少次增量才落盘（1 = 每次请求都落盘，最精确）
    usageDoWriteEvery: Math.max(1, Math.min(100, readInt(env.USAGE_DO_WRITE_EVERY, 1))),
    // 每日额度（B2 免费账户的 Class B/C 各 2500 次/天，按你账户实际套餐调整）
    classBQuota: Math.max(0, readInt(env.CLASS_B_DAILY_QUOTA, 2500)),
    classCQuota: Math.max(0, readInt(env.CLASS_C_DAILY_QUOTA, 2500)),

    adminUser: String(env.ADMIN_USER || ''),
    adminPass: String(env.ADMIN_PASS || ''),
    adminToken: String(env.ADMIN_TOKEN || ''),
    uploadCacheControl: String(env.UPLOAD_CACHE_CONTROL || ''),
    allowedOrigins: String(env.ALLOWED_ORIGINS || '*').trim(),
    debug: readBool(env.DEBUG, false),
  };
}

/* ---- 多桶挂载表 ---- */

/** 桶名不能占用这些路径段（大小写不敏感） */
const RESERVED_MOUNTS = new Set(['share', '__api', '__manage']);

/** 解析 BUCKET_1..N 环境变量（JSON：BUCKET_NAME / KEY_ID / APPLICATION_KEY / ENDPOINT）。
 *  单个变量有问题只跳过该桶并记录，不影响其它桶。 */
function parseBucketVars(env) {
  const buckets = [];
  const problems = [];
  for (const key of Object.keys(env)) {
    if (!/^BUCKET_\d+$/.test(key)) continue;
    const ordinal = parseInt(key.slice(7), 10);
    const fail = (msg) => problems.push(key + '：' + msg);
    let raw;
    try {
      raw = JSON.parse(String(env[key]));
    } catch {
      fail('值不是合法 JSON');
      continue;
    }
    if (!raw || typeof raw !== 'object') { fail('值应为 JSON 对象'); continue; }
    const name = String(raw.BUCKET_NAME || '').trim().toLowerCase();
    const keyId = String(raw.KEY_ID || '').trim();
    const appKey = String(raw.APPLICATION_KEY || '').trim();
    const endpoint = String(raw.ENDPOINT || '').trim().replace(/\/+$/, '');
    const label = String(raw.LABEL || '').trim();
    if (!name) { fail('缺少 BUCKET_NAME'); continue; }
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) { fail('桶名不合法：' + name); continue; }
    if (RESERVED_MOUNTS.has(name)) { fail('桶名是保留字：' + name); continue; }
    if (!keyId || !appKey) { fail('缺少 KEY_ID / APPLICATION_KEY'); continue; }
    if (!endpoint || !/^https:\/\//.test(endpoint)) { fail('缺少或非法 ENDPOINT'); continue; }
    if (buckets.some((b) => b.name === name)) { fail('桶名与其它变量重复：' + name); continue; }
    buckets.push({ name, keyId, appKey, endpoint, ordinal, label: label || name });
  }
  buckets.sort((a, b) => a.ordinal - b.ordinal);
  return { buckets, problems };
}

// endpoint 字符串到 {origin,host,region} 的解析结果可跨请求复用（同一 isolate 内 endpoint 数量极少）
const endpointInfoCache = new Map();

function endpointInfo(rawEndpoint) {
  const cached = endpointInfoCache.get(rawEndpoint);
  if (cached) return cached;
  const endpoint = new URL(rawEndpoint);
  const hostParts = endpoint.hostname.split('.');
  const region = hostParts[0] === 's3' && hostParts.length > 2
    ? hostParts.slice(1, -2).join('.')
    : 'us-west-001';
  const info = { origin: endpoint.origin, host: endpoint.hostname, region };
  endpointInfoCache.set(rawEndpoint, info);
  return info;
}

/** 把全局 cfg 原地切换成指定桶的视图（凭据 / endpoint / 桶名）。
 *  浅拷贝保留 cfg.usage 引用 → 同一请求内跨桶的调用都记进同一份计数。 */
function applyBucket(cfg, name) {
  const m = cfg.buckets.find((b) => b.name === name);
  if (!m) return null;
  const info = endpointInfo(m.endpoint);
  cfg.accessKeyId = m.keyId;
  cfg.secretAccessKey = m.appKey;
  cfg.endpointOrigin = info.origin;
  cfg.endpointHost = info.host;
  cfg.region = info.region;
  cfg.bucketFixed = m.name;
  cfg.primaryBucket = m.name;
  return cfg;
}

/** 独立的每桶视图（不改动请求级 cfg），给「遍历所有桶」的场景用 */
function bucketView(cfg, m) {
  const info = endpointInfo(m.endpoint);
  return {
    ...cfg,
    accessKeyId: m.keyId,
    secretAccessKey: m.appKey,
    endpointOrigin: info.origin,
    endpointHost: info.host,
    region: info.region,
    bucketFixed: m.name,
    usage: { counts: {} },
  };
}

/**
 * 把 URL 路径解析成挂载视图：
 *   /                → kind=root        （虚拟根：桶总览）
 *   /share           → kind=shareRoot   （虚拟公开根）
 *   /share/<b>/…     → kind=bucket      别名挂载：桶 b 的 share/… 前缀
 *   /<b>/…           → kind=bucket      正常挂载：桶 b 的 …
 *   其它             → kind=miss        （未挂载的首段）
 */
function resolveMount(cfg, pathname) {
  let segs;
  try {
    segs = pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return { kind: 'bad' };
  }
  if (segs.some((s) => s === '.' || s === '..' || s.includes('\0'))) return { kind: 'bad' };
  if (!segs.length) return { kind: 'root' };
  const trailingSlash = pathname.endsWith('/');
  const join = (arr) => '/' + arr.join('/') + (trailingSlash || arr.length === 0 ? '/' : '');

  if (segs[0].toLowerCase() === 'share') {
    if (segs.length === 1) return { kind: 'shareRoot' };
    const m = cfg.buckets.find((b) => b.name === segs[1].toLowerCase());
    if (!m) return { kind: 'miss', name: segs[1] };
    return { kind: 'bucket', m, alias: true, inner: join(['share', ...segs.slice(2)]) };
  }
  const m = cfg.buckets.find((b) => b.name === segs[0].toLowerCase());
  if (!m) return { kind: 'miss', name: segs[0] };
  return { kind: 'bucket', m, alias: false, inner: join(segs.slice(1)) };
}

/** 匿名访问 /share/** 以外路径时的智能重定向目标 */
function smartPublicRedirect(mount) {
  if (mount && mount.kind === 'bucket' && !mount.alias && mount.m) {
    const rest = mount.inner.replace(/^\/+/, '');
    if (rest === 'share' || rest.startsWith('share/')) {
      const tail = rest === 'share' ? '' : rest.slice('share/'.length);
      return '/share/' + mount.m.name + (tail ? '/' + tail : '/');
    }
  }
  return '/share/';
}

/* ---------- src/lib/usage.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L1058-L1063、原 L1093-L1654 */





const USAGE_CACHE_ORIGIN = 'https://usage.internal';

/** UTC 日期戳（与 B2 计数器 00:00 GMT 重置对齐） */
function utcDayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}


/**
 * 是否该在「归零前窗口」补一次空间扫描：UTC 进入 windowHour 之后，
 * 且当天还没有做过窗口扫描。每天最多一次。
 */
function shouldWindowScan(now, windowHour, windowDay) {
  if (!(windowHour >= 0 && windowHour <= 23)) return false;
  if (now.getUTCHours() < windowHour) return false;
  return windowDay !== utcDayStamp(now);
}

/**
 * 计数器使用**固定键**（不含日期）：归零完全由 scheduled() 显式执行，
 * 不再靠"键里带日期"来隔离不同天。
 */
function counterCacheKey(bucket) {
  return USAGE_CACHE_ORIGIN + '/counters/' + encodeURIComponent(bucket || '_');
}

function storageCacheKey(bucket) {
  return USAGE_CACHE_ORIGIN + '/storage/' + encodeURIComponent(bucket || '_');
}

async function cacheGetJson(key) {
  try {
    const hit = await caches.default.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function cachePutJson(key, value, maxAge) {
  try {
    await caches.default.put(key, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + maxAge },
    }));
  } catch {
    /* Cache API 不可用（或对象过大）时静默跳过，不影响主流程 */
  }
}

/* ---------- 计数后端一：Durable Object（全局单实例、原子） ---------- */

/** 取计数用的 DO stub；未绑定或不可用时返回 null，调用方退化到 Cache API */
function usageDoStub(env, bucket) {
  if (!env || !env.USAGE_DO) return null;
  try {
    return env.USAGE_DO.get(env.USAGE_DO.idFromName('usage:' + (bucket || '_')));
  } catch (error) {
    console.error('[cf-b2-worker] USAGE_DO 不可用，改用 Cache API 口径:', error && error.message);
    return null;
  }
}

async function doCall(stub, action, payload) {
  const init = payload === undefined
    ? { method: 'GET' }
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  const response = await stub.fetch('https://usage.do/' + action, init);
  if (!response.ok) throw new Error('DO ' + action + ' → HTTP ' + response.status);
  return response.json();
}

/**
 * 用量计数器（Durable Object）。
 * 同一个桶共用一个实例 → 所有数据中心看到同一份数字；DO 对同一实例的请求
 * 串行处理，所以「累加」与「重置」都是原子的。
 *
 * 归零方式：**完全由 scheduled()（Cron）显式调用 reset 动作**，
 * 不做「下次请求发现日期变了就归零」的惰性归零，也不用日期分键。
 * 含义：如果 Cron 没配/没跑，计数会持续累加不清零（要靠 Cron 保证）。
 */
class UsageCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
    this.pending = 0;
  }

  async load() {
    if (!this.data) {
      const stored = await this.state.storage.get('usage');
      this.data = stored || {
        day: utcDayStamp(), A: 0, B: 0, C: 0, D: 0, at: '', resetAt: '',
        storage: null, windowDay: '', lastAttempt: 0,
      };
    }
    return this.data;
  }

  /** 落盘；所有时间戳都以传入的 now 为准（便于测试与推理，只用一处时钟） */
  async save(now) {
    this.data.at = (now || new Date()).toISOString();
    await this.state.storage.put('usage', this.data);
  }

  counters() {
    return { A: this.data.A, B: this.data.B, C: this.data.C, D: this.data.D, at: this.data.at || '' };
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop();
    await this.load();
    const now = new Date();
    if (action === 'add') return this.onAdd(request, now);
    if (action === 'sync') return this.onSync(request, now);
    if (action === 'snapshot') return this.onSnapshot(request, now);
    if (action === 'reset') return this.onReset(request, now);
    return json({ ok: false, error: '未知的 DO 动作: ' + action }, 404);
  }

  /** 由 scheduled() 调用的显式归零 */
  async onReset(request, now) {
    await this.load();
    return this.reset(now);
  }

  /** 把当日计数清 0（只在 Cron 触发时执行） */
  async reset(now) {
    const stamp = now.toISOString();
    this.data.A = 0;
    this.data.B = 0;
    this.data.C = 0;
    this.data.D = 0;
    this.data.day = utcDayStamp(now);
    this.data.resetAt = stamp;
    this.data.windowDay = '';
    await this.save(now);
    return json({
      ok: true, resetAt: stamp, day: this.data.day, counters: this.counters(),
    }, 200);
  }

  /** 累加本批 B2 调用次数；writeEvery > 1 时合并落盘以减少 SQLite 行写入 */
  async onAdd(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    let changed = false;
    for (const cls of ['A', 'B', 'C', 'D']) {
      const n = Number(body[cls]) || 0;
      if (n > 0) {
        this.data[cls] += n;
        changed = true;
      }
    }
    if (changed) {
      this.data.at = now.toISOString();
      this.pending += 1;
      const every = Math.max(1, Number(body.writeEvery) || 1);
      if (this.pending >= every) {
        this.pending = 0;
        await this.save(now);
      }
    }
    return json({ ok: true, day: this.data.day, counters: this.counters() }, 200);
  }

  /**
   * 一次调用同时完成「读计数器」与「是否该重扫空间」的仲裁。
   * 仲裁在 DO 内串行执行 → 多个数据中心同时打开页面也只会有一个真正去扫。
   * 空间快照平时只由 Cron（scheduled）刷新；这里的重扫仅限「还没有快照」的引导场景，
   * 以及显式开启 USAGE_AUTO_SCAN 之后的惰性刷新。
   */
  async onSync(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    const ttlMs = Math.max(0, Number(body.ttl) || 0) * 1000;
    const windowHour = Number.isFinite(body.windowHour) ? body.windowHour : -1;

    const snapshot = this.data.storage;
    const snapshotAt = snapshot && snapshot.at ? Date.parse(snapshot.at) : 0;
    const ageMs = snapshotAt ? now.getTime() - snapshotAt : Infinity;
    const autoScan = body.autoScan === true;

    let shouldScan = false;
    let windowed = false;
    let bootstrap = false;

    if (!snapshotAt) {
      shouldScan = true;              // 首次还没有任何快照 → 引导性扫一次
      bootstrap = true;
    } else if (autoScan && ttlMs > 0 && ageMs >= ttlMs) {
      shouldScan = true;              // 仅在显式开启惰性自动扫描时才按 TTL 重扫
    } else if (autoScan && shouldWindowScan(now, windowHour, this.data.windowDay)) {
      shouldScan = true;
    }

    if (shouldScan) {
      this.data.lastAttempt = now.getTime();
      if (windowHour >= 0 && now.getUTCHours() >= windowHour) {
        this.data.windowDay = utcDayStamp(now);
        windowed = true;
      }
      await this.save(now);
    }

    return json({
      ok: true,
      day: this.data.day,
      resetAt: this.data.resetAt || '',
      counters: this.counters(),
      storage: snapshot || null,
      shouldScan,
      windowed,
      bootstrap,
      ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : -1,
    }, 200);
  }

  /** 保存空间扫描结果 */
  async onSnapshot(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    this.data.storage = {
      ok: true,
      bucket: String(body.bucket || ''),
      usedBytes: Number(body.usedBytes) || 0,
      objects: Number(body.objects) || 0,
      pages: Number(body.pages) || 0,
      complete: body.complete !== false,
      at: now.toISOString(),
    };
    await this.save(now);
    return json({ ok: true, day: this.data.day, counters: this.counters(), storage: this.data.storage }, 200);
  }
}

/* ---------- 计数后端二：Cache API（未绑定 DO 时的降级，按数据中心分裂） ---------- */

/** 把本请求产生的 B2 调用次数合并进计数器（尽力而为，不阻塞响应） */
async function flushCounters(cfg, env, bucket) {
  const counts = cfg && cfg.usage && cfg.usage.counts;
  if (!counts || !Object.keys(counts).length) return;
  cfg.usage.counts = {};   // 先清空，避免同一批增量被重复计入（scheduled 里会按桶循环调用）

  const stub = usageDoStub(env, bucket);
  if (stub) {
    try {
      await doCall(stub, 'add', { ...counts, writeEvery: cfg.usageDoWriteEvery });
      return;
    } catch (error) {
      // 绑定存在但调用失败时不再写 Cache，避免两套后端数字分裂
      console.error('[cf-b2-worker] DO 计数失败，丢弃本次增量:', error && error.message);
      return;
    }
  }

  const key = counterCacheKey(bucket);
  const prev = (await cacheGetJson(key)) || {};
  // 保留 resetAt（由 scheduled 的归零写入），否则合并增量时会把它冲掉
  const next = {
    A: prev.A || 0, B: prev.B || 0, C: prev.C || 0, D: prev.D || 0,
    resetAt: prev.resetAt || '',
  };
  for (const [cls, n] of Object.entries(counts)) next[cls] = (next[cls] || 0) + n;
  next.at = new Date().toISOString();
  await cachePutJson(key, next, 2 * 86400);
}

/** 遍历整个桶累加对象数与字节数（每 1000 个对象 1 次 Class C） */
async function computeStorage(cfg, bucket) {
  let cursor = '';
  let objects = 0;
  let bytes = 0;
  let pages = 0;
  let truncated = false;

  for (let i = 0; i < cfg.usageScanMaxPages; i++) {
    const page = await listObjects(cfg, bucket, { prefix: '', delimiter: '', limit: 1000, cursor });
    if (!page.ok) return { ok: false, status: page.status || 502, error: page.error };
    pages++;
    objects += page.files.length;
    for (const file of page.files) bytes += file.size || 0;
    cursor = page.nextToken || '';
    truncated = Boolean(page.truncated && cursor);
    if (!truncated) break;
  }

  return { ok: true, objects, bytes, pages, complete: !truncated };
}

async function readCountersViaCache(bucket) {
  const data = (await cacheGetJson(counterCacheKey(bucket))) || {};
  return {
    A: data.A || 0, B: data.B || 0, C: data.C || 0, D: data.D || 0,
    at: data.at || '', resetAt: data.resetAt || '',
  };
}

/** 降级后端的归零：把固定键重写成 0（由 scheduled 调用） */
async function resetCountersViaCache(bucket) {
  const now = new Date().toISOString();
  await cachePutJson(counterCacheKey(bucket), {
    A: 0, B: 0, C: 0, D: 0, at: now, resetAt: now,
  }, 2 * 86400);
  return { backend: 'cache', resetAt: now };
}

/**
 * 归零当日计数（与 scheduled() 共用）：DO 优先，未绑定则重写 Cache 键。
 * 只有 Cron 触发时才会调用，请求路径不做任何按日期的自动归零。
 */
async function resetCounters(cfg, env, bucket) {
  const stub = usageDoStub(env, bucket);
  if (stub) {
    try {
      const out = await doCall(stub, 'reset', {});
      return { backend: 'do', resetAt: out.resetAt, day: out.day };
    } catch (error) {
      console.error('[cf-b2-worker] DO 归零失败，改写 Cache 键:', error && error.message);
    }
  }
  return resetCountersViaCache(bucket);
}

/** 空间快照（对外统一形状） */
function snapshotShape(bucket, source, { cached, ageSeconds }) {
  return {
    ok: true,
    bucket,
    usedBytes: source.usedBytes || 0,
    objects: source.objects || 0,
    pages: source.pages || 0,
    complete: source.complete !== false,
    at: source.at || '',
    cached: Boolean(cached),
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : 0,
  };
}

/** 降级后端：Cache API（按数据中心独立，读-改-写非原子） */
async function usageStateViaCache(cfg, bucket) {
  const cached = await cacheGetJson(storageCacheKey(bucket));
  const cachedAt = cached && cached.at ? Date.parse(cached.at) : 0;
  const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
  const inWindow = cfg.usageAutoScan && cfg.usageRefreshHour >= 0
    && new Date().getUTCHours() >= cfg.usageRefreshHour;
  const windowed = cfg.usageAutoScan && Boolean(cached)
    && shouldWindowScan(new Date(), cfg.usageRefreshHour, cached.windowDay);

  let shouldScan = false;
  if (!cachedAt) shouldScan = true;
  else if (cfg.usageAutoScan && ageMs >= cfg.usageCacheTtl * 1000) shouldScan = true;
  else if (windowed) shouldScan = true;

  const counters = await readCountersViaCache(bucket);
  if (!shouldScan) {
    return {
      backend: 'cache',
      counters,
      storage: snapshotShape(bucket, cached, { cached: true, ageSeconds: Math.round(ageMs / 1000) }),
      windowed,
    };
  }

  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) {
    return {
      backend: 'cache',
      counters,
      storage: { ok: false, error: scan.error, status: scan.status },
      windowed,
    };
  }

  const stored = {
    usedBytes: scan.bytes, objects: scan.objects, pages: scan.pages,
    complete: scan.complete, at: new Date().toISOString(),
    windowDay: inWindow ? utcDayStamp() : ((cached && cached.windowDay) || ''),
  };
  // 快照可能一天才更新一次（Cron），缓存条目不能按 TTL 6h 就过期
  await cachePutJson(storageCacheKey(bucket), stored, Math.max(cfg.usageCacheTtl, 2 * 86400));
  return {
    backend: 'cache',
    counters,
    storage: snapshotShape(bucket, stored, { cached: false, ageSeconds: 0 }),
    windowed,
  };
}

/**
 * 用量统一入口：绑定了 USAGE_DO 就走 Durable Object（全局一致 + 原子），
 * 否则退化到 Cache API。空间快照由 Cron 刷新；首次读取若还没有快照会引导性扫一次。
 * 没有「手动重新统计」入口 —— 任何请求路径都不会强制重扫。
 */
async function usageState(cfg, env, bucket) {
  const stub = usageDoStub(env, bucket);
  if (!stub) return usageStateViaCache(cfg, bucket);

  let state;
  try {
    state = await doCall(stub, 'sync', {
      ttl: cfg.usageCacheTtl,
      windowHour: cfg.usageRefreshHour,
      autoScan: cfg.usageAutoScan,
    });
  } catch (error) {
    console.error('[cf-b2-worker] DO 读取失败，本次改用 Cache API 口径:', error && error.message);
    return usageStateViaCache(cfg, bucket);
  }

  if (!state.shouldScan) {
    return {
      backend: 'do',
      counters: state.counters,
      resetAt: state.resetAt || '',
      storage: state.storage
        ? snapshotShape(bucket, state.storage, { cached: true, ageSeconds: state.ageSeconds })
        : { ok: false, error: '暂无快照' },
      windowed: state.windowed,
    };
  }

  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) {
    return {
      backend: 'do',
      counters: state.counters,
      resetAt: state.resetAt || '',
      storage: { ok: false, error: scan.error, status: scan.status },
      windowed: state.windowed,
    };
  }

  const saved = await doCall(stub, 'snapshot', {
    bucket,
    usedBytes: scan.bytes,
    objects: scan.objects,
    pages: scan.pages,
    complete: scan.complete,
  });
  return {
    backend: 'do',
    counters: saved.counters,
    resetAt: state.resetAt || '',
    storage: snapshotShape(bucket, saved.storage, { cached: false, ageSeconds: 0 }),
    windowed: state.windowed,
  };
}

/** 定时统计要覆盖的桶列表：直接来自挂载表（BUCKET_1..N） */
function scheduledBuckets(cfg) {
  return cfg.buckets.map((b) => b.name);
}

/** 扫描一次空间并落成快照（DO 优先；未绑定 DO 时写 Cache API） */
async function refreshSnapshot(cfg, env, bucket) {
  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) throw new Error(scan.error || ('扫描失败: HTTP ' + (scan.status || 0)));

  const record = {
    bucket,
    usedBytes: scan.bytes,
    objects: scan.objects,
    pages: scan.pages,
    complete: scan.complete,
    at: new Date().toISOString(),
  };

  const stub = usageDoStub(env, bucket);
  if (stub) {
    try {
      await doCall(stub, 'snapshot', record);
      return { ...record, backend: 'do' };
    } catch (error) {
      console.error('[cf-b2-worker] 定时统计写 DO 失败，改写 Cache API:', error && error.message);
    }
  }
  await cachePutJson(storageCacheKey(bucket), record, Math.max(cfg.usageCacheTtl, 2 * 86400));
  return { ...record, backend: 'cache' };
}

/**
 * Cron（scheduled）统一入口：空间统计与计数归零共用这一个事件。
 * 按触发时刻的 UTC 小时分派（两者默认都在 23 点 → 一条 cron 即可）：
 *   USAGE_SCAN_HOURS  （默认 "23"）→ 先刷新空间快照
 *   USAGE_RESET_HOURS （默认 "23"）→ 再把 Class A/B/C/D 清零
 * 顺序是「先扫描、再归零」：即先给当前用量留下一份快照，再做归零结算；
 * 本次扫描自己消耗的 Class C 也记在旧周期里，随后被归零一并清掉，
 * 因此新周期（23:00 起算）从 0 开始。
 */
async function runScheduled(event, env) {
  const cfg = loadConfig(env);
  const when = new Date((event && event.scheduledTime) || Date.now());
  const hour = when.getUTCHours();

  const doScan = hourMatches(cfg.usageScanHours, hour);
  const doReset = hourMatches(cfg.usageResetHours, hour);
  const buckets = scheduledBuckets(cfg);

  if (!buckets.length) {
    console.warn('[cf-b2-worker] scheduled 缺少桶名：$path / $host 模式请设置 USAGE_SCHEDULE_BUCKETS');
    return { ok: false, skipped: '未确定桶名（请配置 USAGE_SCHEDULE_BUCKETS）', hour, doScan, doReset };
  }
  if (!cfg.enableUsage) {
    return { ok: false, skipped: '用量面板已关闭（ENABLE_USAGE_PANEL=false）', hour };
  }

  if (cfg.enableUsage) cfg.usage = { counts: {} };   // 让定时任务里的 B2 调用也计入用量

  const results = [];
  for (const m of cfg.buckets) {
    // 每桶独立视图（各自的凭据 / endpoint / 计数器）
    const view = bucketView(cfg, m);
    const bucket = m.name;
    const item = { bucket, scan: null, reset: null };

    if (doScan) {
      try {
        const record = await refreshSnapshot(view, env, bucket);
        item.scan = { ok: true, usedBytes: record.usedBytes, objects: record.objects, backend: record.backend };
        console.log('[cf-b2-worker] 定时统计完成',
          bucket, record.usedBytes + 'B', record.objects + ' objects', 'via', record.backend);
      } catch (error) {
        item.scan = { ok: false, error: String((error && error.message) || error) };
        console.error('[cf-b2-worker] 定时统计失败', bucket, error && error.message);
      }
    }

    // 定时任务自己发起的 B2 请求（如本次扫描的 Class C）先记账，再被下面的归零清掉
    if (Object.keys(view.usage.counts).length) {
      await flushCounters(view, env, bucket).catch((error) => {
        console.error('[cf-b2-worker] 定时任务的用量计数写入失败', error && error.message);
      });
    }

    if (doReset) {
      try {
        const out = await resetCounters(view, env, bucket);
        item.reset = { ok: true, backend: out.backend, resetAt: out.resetAt };
        console.log('[cf-b2-worker] 当日计数已归零', bucket, 'via', out.backend);
      } catch (error) {
        item.reset = { ok: false, error: String((error && error.message) || error) };
        console.error('[cf-b2-worker] 计数归零失败', bucket, error && error.message);
      }
    }

    results.push(item);
  }

  const ok = results.every((r) => (!r.scan || r.scan.ok) && (!r.reset || r.reset.ok));
  return {
    ok,
    cron: (event && event.cron) || '',
    hour,
    didScan: doScan,
    didReset: doReset,
    results,
  };
}

/* ============================ 6. 管理 API ============================ */

/* ---- B2 原生 API（控制面，免费、不计 Class A-D）：桶级 CORS 配置 ---- */

/** b2_authorize_account：用桶自己的应用密钥换取控制面令牌 */

/* ---------- src/lib/b2-native.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L1655-L1739 */

async function b2Authorize(cfg) {
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
function corsRuleFor(origin) {
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

async function b2GetBucketCors(cfg, bucket) {
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

async function b2UpdateBucketCors(cfg, bucketId, corsRules) {
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

/** API 场景下的桶名解析：支持 /<bucket>/__api/...、/share/<bucket>/__api/... 与 ?bucket= 三种写法 */

/* ---------- src/api.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L1740-L2087 */










function resolveApiBucket(cfg, basePath, url) {
  const segs = basePath.split('/').filter(Boolean);
  let name = '';
  if (segs[0] && segs[0].toLowerCase() === 'share' && segs.length >= 2) name = segs[1];
  else if (segs.length) name = segs[0];
  if (!name) name = url.searchParams.get('bucket') || '';
  name = String(name).trim().toLowerCase();
  if (!name && cfg.buckets.length) name = cfg.buckets[0].name;   // 缺省 = 第一个挂载桶
  return cfg.buckets.some((b) => b.name === name) ? name : '';
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

  // 退出登录：Worker 本身无会话，这里返回 401 诱导浏览器丢弃缓存的 Basic 凭据
  if (action === 'logout') {
    return new Response(
      JSON.stringify({ ok: true, message: '本地凭据已清除；浏览器缓存的 Basic 凭据可能需要关闭标签页或浏览器' }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'WWW-Authenticate': 'Basic realm="B2 Manager", charset="UTF-8"',
          'Cache-Control': 'no-store',
          ...corsHeaders(request, cfg),
        },
      },
    );
  }

  // health 无需鉴权，但匿名只能拿到最小信息（不暴露区域 / 桶模式）
  if (action === 'health') {
    const authenticated = (await checkAuth(request, cfg)).ok;
    const details = authenticated || !cfg.hideDetails;
    return json({
      ok: true,
      service: 'cf-b2-worker',
      authenticated,
      publicRead: cfg.publicRead,
      ...(details ? {
        bucketMode: cfg.bucketMode,
        region: cfg.buckets[0] ? endpointInfo(cfg.buckets[0].endpoint).region : cfg.region,
        buckets: cfg.buckets.map((b) => b.name),
        mountProblems: cfg.mountProblems,
        publicPrefix: cfg.publicPrefix || '',
        hideDetails: cfg.hideDetails,
      } : {}),
    }, 200, request, cfg);
  }

  const auth = await checkAuth(request, cfg);
  if (!auth.ok) return deny(auth.reason, request, cfg, 401);

  const targetBucket = resolveApiBucket(cfg, basePath, url);
  if (!targetBucket) {
    return deny('无法确定桶名（请写成 /<bucket>' + API_PREFIX + '... 或携带 ?bucket=）', request, cfg, 400);
  }
  // 按桶切换凭据 / endpoint；未挂载的桶一律拒绝
  if (!applyBucket(cfg, targetBucket)) {
    return deny('未挂载的桶：' + targetBucket, request, cfg, 404);
  }

  switch (action) {
    /* ---- B2 用量（全部挂载桶，按 BUCKET_N 序号排序） ---- */
    case 'usage': {
      if (!cfg.enableUsage) {
        return json({ ok: false, error: '用量面板已关闭（ENABLE_USAGE_PANEL=false）' }, 200, request, cfg);
      }
      const list = [];
      let backendLabel = '已关闭';
      for (const m of cfg.buckets) {
        // 每桶独立视图：扫描产生的调用按桶落账
        const bc = bucketView(cfg, m);
        const state = await usageState(bc, env, m.name);
        if (!backendLabel || backendLabel === '已关闭') {
          backendLabel = state.backend === 'do' ? 'Durable Object'
            : (state.backend === 'cache' ? 'Cache API' : '已关闭');
        }
        const live = (bc.usage && bc.usage.counts) || {};
        const usedB = (state.counters.B || 0) + (live.B || 0);
        const usedC = (state.counters.C || 0) + (live.C || 0);
        list.push({
          name: m.name,
          ordinal: m.ordinal,
          label: m.label,
          quotaBytes: cfg.storageQuotaBytes,
          storage: state.storage,
          classB: { used: usedB, quota: cfg.classBQuota, remaining: Math.max(0, cfg.classBQuota - usedB) },
          classC: { used: usedC, quota: cfg.classCQuota, remaining: Math.max(0, cfg.classCQuota - usedC) },
        });
        await flushCounters(bc, env, m.name).catch(() => {});
      }
      return json({
        ok: true,
        buckets: list,
        counterBackendLabel: backendLabel,
        scanSchedule: hourListLabel(cfg.usageScanHours),
        resetSchedule: hourListLabel(cfg.usageResetHours),
        updatedAt: new Date().toISOString(),
      }, 200, request, cfg);
    }

    /* ---- 列举 ---- */
    case 'list': {
      const result = await listObjects(cfg, targetBucket, {
        prefix: dirPrefix(url.searchParams.get('prefix') || ''),
        delimiter: url.searchParams.get('recursive') === '1' ? '' : '/',
        limit: readInt(url.searchParams.get('limit'), 1000),
        cursor: url.searchParams.get('cursor') || '',
      });
      if (!result.ok) return deny(result.error, request, cfg, result.status || 502);
      return json({ ok: true, bucket: targetBucket, ...result }, 200, request, cfg);
    }

    /* ---- 预签名 URL（仅用于上传直传；下载直链已禁用，必须经 Worker） ---- */
    case 'presign': {
      const key = normalizeKey(url.searchParams.get('key') || '');
      if (!key) return deny('缺少 key', request, cfg, 400);
      const isPut = (url.searchParams.get('type') || 'get') === 'put';
      if (!isPut) {
        return deny('已禁用预签名下载直链：下载必须经 Worker（访问 /<key> 或 /<key>?dl=1）', request, cfg, 403);
      }
      const expires = readInt(url.searchParams.get('expires'), cfg.presignExpires);
      const query = {};
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
        if (res.ok) purgeObjectCache(ctx, cfg, targetBucket, key, url.origin);
        return json(res, res.ok ? 200 : (res.status || 500), request, cfg);
      }
      if (request.method === 'PUT') {
        if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
        const res = await putObject(request, cfg, targetBucket, key);
        if (res.ok) purgeObjectCache(ctx, cfg, targetBucket, key, url.origin);
        return res;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return readObject(request, env, ctx, cfg, targetBucket, key);
      }
      return deny('不支持的请求方法', request, cfg, 405);
    }

    /* ---- 复制 / 移动（支持跨桶：Worker 中转流式复制） ---- */
    case 'copy': {
      if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
      const body = await readJsonBody(request);
      const from = normalizeKey(body.from || '');
      const to = normalizeKey(body.to || '');
      const toBucket = String(body.toBucket || targetBucket).toLowerCase();
      if (!from || !to) return deny('需要 from 与 to', request, cfg, 400);
      if (toBucket === targetBucket) {
        const res = await copyObject(cfg, targetBucket, from, to);
        if (!res.ok) return deny(res.error, request, cfg, res.status || 500);
        const moved = body.move === true || url.searchParams.get('move') === '1';
        if (moved) await deleteObject(cfg, targetBucket, from);
        purgeObjectCache(ctx, cfg, targetBucket, to, url.origin);
        if (moved) purgeObjectCache(ctx, cfg, targetBucket, from, url.origin);
        return json({ ok: true, from, to, moved, crossBucket: false }, 200, request, cfg);
      }
      // 跨桶（可能跨 B2 账号）：GET 源 → 流式 PUT 目标；调用方决定是否删除源
      const dst = cfg.buckets.find((b) => b.name === toBucket);
      if (!dst) return deny('目标桶未挂载：' + toBucket, request, cfg, 400);
      const dstCfg = bucketView(cfg, dst);
      try {
        const upstream = await b2Fetch(cfg, 'GET', objectUrl(cfg, targetBucket, from));
        if (!upstream.ok) {
          return deny('读取源对象失败: HTTP ' + upstream.status, request, cfg, upstream.status === 404 ? 404 : 502);
        }
        const headers = { 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream' };
        const cc = upstream.headers.get('cache-control');
        if (cc) headers['Cache-Control'] = cc;
        const put = await b2Fetch(dstCfg, 'PUT', objectUrl(dstCfg, toBucket, to), {
          headers,
          body: upstream.body,
          unsignedPayload: true,
        });
        if (!put.ok) {
          return deny('写入目标桶失败: HTTP ' + put.status + '（源对象未删除，可重试）', request, cfg, 502);
        }
        const moved = body.move === true || url.searchParams.get('move') === '1';
        if (moved) await deleteObject(cfg, targetBucket, from);
        purgeObjectCache(ctx, dstCfg, toBucket, to, url.origin);
        if (moved) purgeObjectCache(ctx, cfg, targetBucket, from, url.origin);
        return json({ ok: true, from, to, toBucket, moved, crossBucket: true }, 200, request, cfg);
      } finally {
        // 目标桶计数挂在 dstCfg 上，而请求级 finally 只会 flush 源桶，这里补一次避免漏计
        const pending = flushCounters(dstCfg, env, toBucket).catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
      }
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

    /* ---- 桶级 CORS 配置（B2 原生 API，控制面免费不计次） ----
     * GET  /__api/cors                → 当前 CORS 规则
     * POST /__api/cors {origin}       → 按 corsRuleName 去重后追加/更新一条放行规则
     * 浏览器直传（presigned PUT）与跨域下载都依赖这条规则。 */
    case 'cors': {
      try {
        if (request.method === 'GET') {
          const info = await b2GetBucketCors(cfg, targetBucket);
          return json({ ok: true, bucket: targetBucket, bucketId: info.bucketId, corsRules: info.corsRules }, 200, request, cfg);
        }
        if (request.method !== 'POST') return deny('不支持的方法', request, cfg, 405);
        if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
        const body = await readJsonBody(request);
        const origin = String(body.origin || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
          return deny('origin 需形如 https://域名（可带端口）', request, cfg, 400);
        }
        const info = await b2GetBucketCors(cfg, targetBucket);
        const rule = corsRuleFor(origin);
        // 按规则名去重：同名覆盖，其余原样保留（不破坏已有规则）
        const rules = info.corsRules.filter((r) => r && r.corsRuleName !== rule.corsRuleName);
        rules.push(rule);
        const updated = await b2UpdateBucketCors(cfg, info.bucketId, rules);
        return json({
          ok: true,
          bucket: targetBucket,
          origin,
          corsRuleName: rule.corsRuleName,
          corsRules: updated,
        }, 200, request, cfg);
      } catch (error) {
        return deny(String((error && error.message) || error), request, cfg, 502);
      }
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

        // PUT 带 body = 让 Worker 中继该分片（不需要桶配 CORS，单片必须小于 Workers 请求体上限）
        if (request.method === 'PUT') {
          if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 403);
          const declared = readInt(request.headers.get('content-length'), 0);
          if (declared > cfg.maxUploadBytes) {
            return json({
              ok: false,
              error: '分片 ' + partNumber + ' 超过 MAX_UPLOAD_BYTES(' + cfg.maxUploadBytes + ')，请调小 MULTIPART_PART_SIZE',
            }, 413, request, cfg);
          }
          const body = await request.arrayBuffer();
          if (body.byteLength > cfg.maxUploadBytes) {
            return json({ ok: false, error: '分片超过 MAX_UPLOAD_BYTES' }, 413, request, cfg);
          }
          // 分片同样用 UNSIGNED-PAYLOAD，避免每片都重算 body 哈希
          const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, targetBucket, key), {
            query: { partNumber: String(partNumber), uploadId },
            headers: { 'content-type': 'application/octet-stream' },
            body,
            unsignedPayload: true,
          });
          const text = await response.text();
          if (!response.ok) {
            return json({ ok: false, status: response.status, error: extractError(text) }, response.status, request, cfg);
          }
          return json({
            ok: true, partNumber, size: body.byteLength,
            etag: (response.headers.get('etag') || '').replace(/"/g, ''),
          }, 200, request, cfg);
        }

        // GET = 返回该分片的预签名 URL（浏览器直传路径）
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
        if (res.ok) purgeObjectCache(ctx, cfg, targetBucket, key, url.origin);
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

/* ---------- src/ui/theme.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L2088-L2157 */

function escapeHtml(str) {
  return String(str).split('&').join('&amp;').split('<').join('&lt;')
    .split('>').join('&gt;').split('"').join('&quot;');
}

/** 内联进 <script> 的 JSON：转义 < > & 与行分隔符，防止 </script> 提前闭合标签造成注入 */
function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* ---------- 主题：暖色（默认） / 深色 ---------- */

const THEMES = {
  warm: {
    bg: '#f6f0e4', card: '#fffdf7', line: '#e6dcc6', txt: '#3b3327',
    dim: '#8a7d66', acc: '#c2410c', hover: '#f4ecdb', btn: '#ffffff', chip: '#f0e4cd',
    // 目录行暖色底 + 琥珀色文字，文件行保持卡片浅色（保持不变）
    folder: '#f6e6c8', folderTxt: '#a75a12',
  },
  dark: {
    bg: '#0f1115', card: '#161a22', line: '#222836', txt: '#e6e6e6',
    dim: '#8b93a7', acc: '#4c8dff', hover: '#1a1f29', btn: '#ffffff', chip: '#1d222d',
    // 深色模式维持原样：目录行与文件行同色，不做额外着色
    folder: '#161a22', folderTxt: '#4c8dff',
  },
};

/** 生成 CSS 变量：默认暖色，<html data-theme="dark"> 时切深色 */
function themeCss() {
  const decl = (name) => Object.entries(THEMES[name])
    .map(([key, value]) => '--' + key + ':' + value + ';').join('');
  return ':root{' + decl('warm') + '}[data-theme="dark"]{' + decl('dark') + '}';
}

/** 主题切换按钮脚本（localStorage 记忆，默认暖色） */
function themeToggleScript() {
  return [
    '(function () {',
    'function apply(t) {',
    '  document.documentElement.setAttribute("data-theme", t);',
    '  var b = document.getElementById("btnTheme");',
    '  if (b) b.textContent = (t === "dark") ? "暖色模式" : "深色模式";',
    '  try { localStorage.setItem("cfb2-theme", t); } catch (e) {}',
    '}',
    'var saved = "";',
    'try { saved = localStorage.getItem("cfb2-theme") || ""; } catch (e) {}',
    'apply(saved === "dark" ? "dark" : "warm");',
    'var btn = document.getElementById("btnTheme");',
    'if (btn) btn.onclick = function () {',
    '  apply(document.documentElement.getAttribute("data-theme") === "dark" ? "warm" : "dark");',
    '};',
    '})();',
  ].join('\n');
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

/** 公开目录页：服务端渲染首页 + 滚动到底部自动加载后续页（瀑布流） */

/* ---------- src/ui/manage.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L2403-L3213 */



function managePage(cfg, url) {
  // 管理器挂在挂载点下：/<bucket>/__manage 或别名 /share/<bucket>/__manage
  const basePath = url.pathname.slice(0, -MANAGE_PATH.length) || '/';
  const apiBase = basePath.replace(/\/+$/, '') + API_PREFIX;
  const defaultBucket = cfg.bucketFixed;

  // 对象访问根路径（挂载点前缀），下载一律走这里，不再用预签名直链
  const objectBase = basePath.endsWith('/') ? basePath : basePath + '/';

  const configJson = inlineJson({
    apiBase,
    basePath: objectBase,
    defaultBucket,
    bucket: cfg.bucketFixed,
    buckets: cfg.buckets.map((b) => ({ name: b.name, label: b.label })),
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
    uploadConcurrency: cfg.uploadConcurrency,
    apiPrefix: API_PREFIX,
  });

  // 上传调参输入框的默认值（MiB / 并发数），取服务端配置
  const defaultPartMiB = Math.max(5, Math.min(Math.round((cfg.multipartPartSize || 0) / 1048576) || 25, 95));
  const defaultConc = Math.max(1, Math.min(10, cfg.uploadConcurrency || 3));

  return [
    '<!doctype html>',
    '<html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>B2 文件管理器</title>',
    // 空 favicon：避免浏览器自动请求 /favicon.ico（会被当对象下载，白记 1 次 Class B）
    '<link rel="icon" href="data:,">',
    '<style>',
    themeCss(),
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:14px}',
    'code{background:var(--chip);padding:2px 6px;border-radius:5px}',
    'header{display:flex;align-items:center;gap:10px;padding:12px 20px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:5;flex-wrap:wrap}',
    'header h1{font-size:15px;margin:0;font-weight:600}',
    '.grow{flex:1}',
    'button,input,select{font:inherit;color:var(--txt);background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:6px 10px}',
    'button{cursor:pointer;background:var(--acc);border-color:var(--acc);color:var(--btn)}',
    'button.ghost{background:var(--chip);color:var(--txt);border-color:var(--line)}',
    'button.mini{padding:3px 7px;font-size:12px;background:var(--chip);border-color:var(--line);color:var(--txt)}',
    'button:disabled{opacity:.45;cursor:not-allowed}',
    // 桌面端：左侧用量卡片（360px，容纳多桶两列），右侧文件列表
    'main{max-width:1400px;margin:0 auto;padding:20px;display:grid;grid-template-columns:360px minmax(0,1fr);gap:20px;align-items:start}',
    '.content{min-width:0}',
    // 表格列宽用 class 而不用内联样式，移动端断点才能覆盖
    '.c-size{width:110px}.c-time{width:180px}.c-act{width:300px;text-align:right}.act{text-align:right}',
    // 移动端「更多」折叠区：桌面用 display:contents，子项直接参与 header 的 flex 布局
    // order 的取值刻意让桌面视觉顺序稳定（桶切换器在新建目录之前）
    '.more{display:contents}',
    '.more-toggle{display:none}',
    '.more>*{order:1}',
    '#bucketSel{order:2}',
    '#btnMkdir{order:3}#upMode{order:4}',
    '.more .set,.more #btnTheme{order:5}',
    '#btnUpload{order:6}',
    // 移动端：① 不显示 B2 桶信息 ② 顶部只常显「新建目录 / 上传方式 / 上传」，其余折叠
    // ③ 隐藏「修改时间」并拉宽「操作」，让「复制/下载/重命名/删除」放得下、好点
    '@media (max-width:860px){',
    'main{grid-template-columns:1fr;gap:14px}',
    '.side{display:none}',
    'header{padding:10px 12px;gap:8px}',
    '.more{display:none;order:9;width:100%;flex-wrap:wrap;gap:10px;align-items:center;margin-top:6px;padding-top:10px;border-top:1px solid var(--line)}',
    '.more.more-open{display:flex}',
    '.more>*{order:0}',
    '.more .grow{display:none}',
    '.more h1{font-size:14px}',
    '.more-toggle{display:inline-block;order:4}',
    '#btnMkdir{order:1}#upMode{order:2}#btnUpload{order:3}',
    // 桶切换器在移动端收进折叠区
    '#bucketSel{order:0;max-width:150px}',
    // 文件列表：文件行为「两行」（第一行 名称+大小，第二行 四个操作按钮整行铺开；
    // 390px 下按钮挤在名称右侧会让名称只剩 ~58px，长文件名折成 10 行）。
    // 目录行保持「一行」：名称占满、删除按钮尾部右对齐（目录只有一个按钮，放得下）。
    'table,tbody,tr,td{display:block}',
    'thead{display:none}',
    'table{border:0;background:transparent}',
    'tbody tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px 4px;border-bottom:1px solid var(--line);background:var(--card)}',
    'tbody tr:last-child{border-bottom:0}',
    'tbody td{padding:0;border:0;overflow-wrap:anywhere}',
    'tbody td:empty{display:none}',
    'tbody td:nth-child(2){text-align:right;white-space:nowrap;color:var(--dim);font-size:12px;align-self:center}',
    'tbody td:nth-child(3){display:none}',
    'tbody td.act{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;text-align:left}',
    'tbody td.act .mini{flex:1 1 72px;min-height:42px;padding:8px 6px;font-size:13px}',
    'tbody tr.dir{display:flex;align-items:center;gap:8px;background:var(--folder)}',
    'tbody tr.dir td:first-child{flex:1;min-width:0}',
    'tbody tr.dir td.act{display:block;text-align:right;flex:0 0 auto;grid-column:auto}',
    'tbody tr.dir td.act .mini{flex:0 0 auto;padding:8px 18px}',
    '}',
    '#status{margin-top:14px;font-size:12px;display:flex;align-items:center;gap:8px;justify-content:center}',
    '#status .spin{width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:sp 0.8s linear infinite}',
    '@keyframes sp{to{transform:rotate(360deg)}}',
    'table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}',
    'th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left}',
    'th{color:var(--dim);font-weight:500;font-size:12px;letter-spacing:.04em}',
    'tr:last-child td{border-bottom:0}tr:hover td{background:var(--hover)}',
    'tr.dir td{background:var(--folder)}tr.dir:hover td{background:var(--hover)}',
    'tr.dir td a{color:var(--folderTxt)}tr.dir td button{color:var(--folderTxt)}',
    '.muted{color:var(--dim)}',
    '.bar{height:6px;border-radius:4px;background:var(--chip);overflow:hidden;margin-top:6px}',
    '.bar>i{display:block;height:100%;background:var(--acc);width:0}',
    '#toast{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:20}',
    '.t{padding:10px 14px;border-radius:8px;background:var(--card);border:1px solid var(--line);max-width:440px}',
    '.t.err{border-color:#ff6b6b;color:#ffb3b3}',
    '.hidden{display:none}',
    '.set{display:flex;align-items:center;gap:4px;color:var(--dim);font-size:12px;white-space:nowrap}',
    '.set input{width:62px;padding:4px 6px}',
    '.crumb a{color:var(--acc);cursor:pointer}',
    '.usage{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:13px}',
    '.usage .row{display:flex;flex-direction:column;gap:8px}',
    '.usage .kv{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}',
    '.usage .v{font-weight:600;font-size:15px}',
    '.usage .bar{height:6px;border-radius:4px;background:var(--chip);overflow:hidden;margin-top:8px}',
    '.usage .bar>i{display:block;height:100%;background:var(--acc)}',
    '.usage .over{color:#c2410c}',
    '.usage .foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}',
    // 多桶用量：每桶一块，两列并排
    '.bgrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
    '.bcell{min-width:0;border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--bg)}',
    '.bcell .bname{font-weight:600;margin-bottom:6px;font-size:13px;overflow-wrap:anywhere}',
    '.bcell .row{display:flex;flex-direction:column;gap:4px}',
    '.bcell .kv{gap:4px}',
    '.bcell .v{font-size:13px}',
    '.bcell .muted{font-size:12px;overflow-wrap:anywhere}',
    '</style></head><body>',
    '<header>',
    // 折叠区（桌面 display:contents → 顺序与改造前完全一致）
    '<div class="more" id="moreMenu">',
    '<h1>Backblaze B2 文件管理器</h1>',
    '<span class="muted" id="bucketLabel"></span>',
    '<span class="grow"></span>',
    '<input id="fUser" placeholder="用户名" size="10">',
    '<input id="fPass" type="password" placeholder="密码 / 令牌" size="16">',
    '<button class="ghost" id="btnLogin">鉴权</button>',
    '<button class="ghost" id="btnLogout">退出</button>',
    '<button class="ghost" id="btnRefresh">刷新</button>',
    '<button class="ghost" id="btnCors" title="把一个站点域名加入该桶的 CORS 规则（浏览器直传/跨域下载需要）。默认放行当前站点。">配置CORS</button>',
    '<select id="bucketSel" title="切换到其它桶的管理器"></select>',
    '<label class="set" title="分片大小（MiB）。直传单次 PUT 上限为 5–95，Worker 代理受 MAX_UPLOAD_BYTES 约束；B2 硬上限 100MiB。">分片',
    '<input id="partSize" type="number" min="5" max="95" step="1" value="' + defaultPartMiB + '">MiB</label>',
    '<label class="set" title="分片并发上传数，1–10。越大越快，但更吃带宽/上游限流。">并发',
    '<input id="conc" type="number" min="1" max="10" step="1" value="' + defaultConc + '"></label>',
    '<button class="ghost" id="btnTheme">深色模式</button>',
    '</div>',
    // 移动端常显：更多 / 新建目录 / 上传方式 / 上传
    '<button class="ghost more-toggle" id="btnMore" aria-expanded="false">更多 ▾</button>',
    '<button class="ghost" id="btnMkdir">新建目录</button>',
    '<select id="upMode">',
    '<option value="direct">直传（推荐）</option>',
    '<option value="worker">Worker 代理</option>',
    '</select>',
    '<button id="btnUpload">上传</button>',
    '<input type="file" id="file" multiple class="hidden">',
    '</header>',
    '<main>',
    '<aside class="side"><div id="usage" class="usage"></div></aside>',
    '<section class="content">',
    '<nav class="crumb" id="crumb" style="margin-bottom:12px"></nav>',
    '<table><thead><tr><th>名称</th><th class="c-size">大小</th>',
    '<th class="c-time">修改时间</th><th class="c-act">操作</th></tr></thead>',
    '<tbody id="tb"></tbody></table>',
    '<div id="status" class="muted"></div>',
    '</section>',
    '</main>',
    '<div id="toast"></div>',
    '<script id="cfg" type="application/json">' + configJson + '</script>',
    '<script>' + themeToggleScript() + '</script>',
    '<script>',
    '(function () {',
    'var CFG = JSON.parse(document.getElementById("cfg").textContent);',
    'var API = CFG.apiBase;',
    '/* 请求一律用绝对 URL。若页面是通过 https://user:pass@host/… 打开的（书签里带了凭据），',
    '   相对 URL 会让 fetch 直接抛 “Request cannot be constructed from a URL that includes credentials”，',
    '   用量面板会显示「不可用」、文件列表也一个都列不出来。location.origin 不含凭据，',
    '   同源请求浏览器会自动带上已缓存的 Basic 认证。 */',
    'function absUrl(u) { return /^[a-z][a-z0-9+.-]*:\\/\\//i.test(u) ? u : location.origin + u; }',
    'var PREFIX = "";',
    'var NEXT = "";',
    'var LOADING = false;',
    'var LOADED = 0;',
    'var GEN = 0;',
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
    '  return fetch(absUrl(API + path), opts).then(function (r) {',
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
    'function buildRows(data, withUp) {',
    '  var rows = "";',
    '  if (withUp && PREFIX) rows += \'<tr class="dir"><td><a data-act="up">.. 返回上级</a></td><td></td><td></td><td></td></tr>\';',
    '  (data.folders || []).forEach(function (p) {',
    '    var name = p.slice(PREFIX.length);',
    '    if (name.charAt(name.length - 1) === "/") name = name.slice(0, -1);',
    '    rows += "<tr class=\\"dir\\"><td><a data-act=\\"dir\\" data-p=\\"" + esc(p) + "\\">" + esc(name) + "</a></td>"',
    '      + "<td class=\\"muted\\">目录</td><td></td>"',
    '      + "<td class=\\"act\\"><button class=\\"mini\\" data-act=\\"deldir\\" data-k=\\"" + esc(p + ".keep") + "\\">删除</button></td></tr>";',
    '  });',
    '  (data.files || []).filter(function (f) { return f.name !== ".keep"; }).forEach(function (f) {',
    '    var k = esc(PREFIX + f.name);',
    '    rows += "<tr><td>" + esc(f.name) + "</td><td>" + size(f.size) + "</td>"',
    '      + "<td class=\\"muted\\">" + esc(f.lastModified) + "</td>"',
    '      + \'<td class="act">\'',
    '      + \'<button class="mini" data-act="copy" data-k="\' + k + \'">复制</button> \'',
    '      + \'<button class="mini" data-act="dl" data-k="\' + k + \'">下载</button> \'',
    '      + \'<button class="mini" data-act="ren" data-k="\' + k + \'">重命名</button> \'',
    '      + \'<button class="mini" data-act="del" data-k="\' + k + \'">删除</button>\'',
    '      + "</td></tr>";',
    '  });',
    '  return rows;',
    '}',
    'function statusHtml(done) {',
    '  if (LOADING) return \'<span class="spin"></span> 正在加载…\';',
    '  if (!NEXT) return "已加载 " + LOADED + " 项 · 到底了";',
    '  return "已加载 " + LOADED + " 项 · 继续往下滚动加载更多";',
    '}',
    'function paintStatus() { el("status").innerHTML = statusHtml(); }',
    'function paintCrumb() {',
    '  var crumb = [\'<a data-act="dir" data-p="">根目录</a>\'];',
    '  var acc = "";',
    '  PREFIX.split("/").forEach(function (seg) {',
    '    if (!seg) return;',
    '    acc += seg + "/";',
    '    crumb.push(\' <span class="muted">/</span> <a data-act="dir" data-p="\' + esc(acc) + \'">\' + esc(seg) + "</a>");',
    '  });',
    '  el("crumb").innerHTML = crumb.join("");',
    '}',
    '/* 目录内容：瀑布流式加载（滚动到底部自动续接下一页） */',
    'function load(prefix) {',
    '  PREFIX = prefix || "";',
    '  LOADING = true; LOADED = 0; NEXT = ""; GEN++;',
    '  var gen = GEN;',
    '  paintCrumb();',
    '  el("tb").innerHTML = "";',
    '  paintStatus();',
    '  return call("list" + q({ prefix: PREFIX })).then(function (r) {',
    '    if (gen !== GEN) return;',
    '    LOADING = false;',
    '    if (!r.ok) { toast("列举失败: " + (r.data.error || r.status), true); paintStatus(); return; }',
    '    NEXT = r.data.nextToken || "";',
    '    var rows = buildRows(r.data, true);',
    '    LOADED += (r.data.files || []).length + (r.data.folders || []).length;',
    '    el("tb").innerHTML = rows || \'<tr><td colspan="4" class="muted">（空目录）</td></tr>\';',
    '    paintStatus();',
    '  });',
    '}',
    'function loadMore() {',
    '  if (LOADING || !NEXT) return Promise.resolve();',
    '  LOADING = true;',
    '  var gen = GEN;',
    '  var cursor = NEXT;',
    '  paintStatus();',
    '  return call("list" + q({ prefix: PREFIX, cursor: cursor })).then(function (r) {',
    '    if (gen !== GEN) return;',
    '    LOADING = false;',
    '    if (!r.ok) { toast("加载更多失败: " + (r.data.error || r.status), true); paintStatus(); return; }',
    '    NEXT = r.data.nextToken || "";',
    '    el("tb").insertAdjacentHTML("beforeend", buildRows(r.data, false));',
    '    LOADED += (r.data.files || []).length + (r.data.folders || []).length;',
    '    paintStatus();',
    '  });',
    '}',
    'window.addEventListener("scroll", function () {',
    '  if (LOADING || !NEXT) return;',
    '  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300) loadMore();',
    '});',
    'function refresh() { load(PREFIX); }',
    'var ERR_DIRECT = "直传失败：浏览器只给笼统错误，请到 DevTools → Network 看真实状态码。常见原因：① 桶未配 CORS（需放行本站与 s3_put）；② 单次 PUT 超过 B2 的 100MiB 上限（超过会自动改走分片，若仍报错请调小 MULTIPART_THRESHOLD）；③ 请求多带了未签名的自定义头（B2 会 400）。";',
    'var ERR_WORKER = "经 Worker 上传失败：网络中断，或单请求超过 MAX_UPLOAD_BYTES（默认 96MB，超过会自动分片）。";',
    'function upMode() { return el("upMode") ? el("upMode").value : "direct"; }',
    'function saveMode() { try { localStorage.setItem("cfb2-upmode", upMode()); } catch (e) {} }',
    '/* 直传：超过阈值 → 并发分片（B2 单次 PUT 实测上限 100MiB）；Worker 代理：超过单请求上限 → 并发分片 */',
    'function uploadFiles(files) {',
    '  for (var i = 0; i < files.length; i++) {',
    '    var f = files[i];',
    '    var key = PREFIX + f.name;',
    '    if (upMode() === "worker") workerUpload(f, key);',
    '    else if (f.size > (CFG.multipartThreshold || 100000000)) mpUpload(f, key);',
    '    else simpleUpload(f, key);',
    '  }',
    '}',
    '/* ---------- 上传调参（输入框 > 服务端默认值；改动记忆在 localStorage） ---------- */',
    'function partCapMB() {',
    '  /* 直传：B2 单次 PUT 上限 100MiB，留 5MiB 余量 → 95；Worker 代理：受 MAX_UPLOAD_BYTES 约束 */',
    '  if (upMode() === "worker") {',
    '    var c = Math.floor(((CFG.maxUploadBytes || 96000000) - 1048576) / 1048576);',
    '    return c < 5 ? 5 : c;',
    '  }',
    '  return 95;',
    '}',
    'function defaultPartMB() { return (CFG.multipartPartSize || 26214400) / 1048576; }',
    'function clampField(id, lo, hi, fallback) {',
    '  var n = el(id);',
    '  var fb = fallback || lo;',
    '  if (!n) return fb;',
    '  var v = parseFloat(n.value);',
    '  if (!isFinite(v) || v <= 0) v = fb;',
    '  v = Math.max(lo, Math.min(hi, Math.round(v)));',
    '  n.value = v;',
    '  return v;',
    '}',
    'function partSizeMB() {',
    '  var cap = partCapMB();',
    '  var n = el("partSize");',
    '  var v = n ? parseFloat(n.value) : NaN;',
    '  if (!isFinite(v) || v <= 0) v = defaultPartMB();',
    '  v = Math.max(5, Math.min(v, cap));',
    '  return Math.round(v * 1048576);',
    '}',
    'function concurrency() {',
    '  var n = el("conc");',
    '  var v = n ? parseInt(n.value, 10) : NaN;',
    '  if (!isFinite(v) || v <= 0) v = CFG.uploadConcurrency || 3;',
    '  return Math.max(1, Math.min(10, v));',
    '}',
    'function saveTuning() {',
    '  try {',
    '    localStorage.setItem("cfb2-tune", JSON.stringify({',
    '      part: el("partSize") ? el("partSize").value : "",',
    '      conc: el("conc") ? el("conc").value : "",',
    '    }));',
    '  } catch (e) {}',
    '}',
    'function syncTuning() {',
    '  var cap = partCapMB();',
    '  var p = clampField("partSize", 5, cap, defaultPartMB());',
    '  var c = clampField("conc", 1, 10, CFG.uploadConcurrency || 3);',
    '  saveTuning();',
    '  return { part: p, conc: c };',
    '}',
    'function directPartSize() { return partSizeMB(); }',
    '/* 失败重试：分片偶发 5xx / 网络抖动时自动重试（最多 3 次，退避 0.8s/1.6s） */',
    'function withRetry(fn, times) {',
    '  var n = times || 3;',
    '  function attempt(i) {',
    '    return fn().catch(function (e) {',
    '      if (i >= n) throw e;',
    '      return new Promise(function (res) { setTimeout(res, 800 * i); })',
    '        .then(function () { return attempt(i + 1); });',
    '    });',
    '  }',
    '  return attempt(1);',
    '}',
    'function workerPartSize() { return partSizeMB(); }',
    '/* 受限并发池：同时最多 limit 个任务，全部完成/失败后 settle */',
    'function runPool(tasks, limit) {',
    '  var idx = 0;',
    '  var firstErr = null;',
    '  function next() {',
    '    if (firstErr || idx >= tasks.length) return Promise.resolve();',
    '    var cur = idx++;',
    '    return tasks[cur]().catch(function (e) { if (!firstErr) firstErr = e; }).then(next);',
    '  }',
    '  var workers = [];',
    '  for (var i = 0; i < Math.max(1, Math.min(limit, tasks.length)); i++) workers.push(next());',
    '  return Promise.all(workers).then(function () { if (firstErr) throw firstErr; });',
    '}',
    'function workerUpload(file, key) {',
    '  var setPct = progressRow(file);',
    '  var ct = file.type || "application/octet-stream";',
    '  if (file.size <= (CFG.maxUploadBytes || 96 * 1000 * 1000)) {',
    '    return putXHR(API + "object" + q({ key: key }), file, ct, setPct, { direct: false })',
    '      .then(function () { setPct(100); toast("上传完成（Worker 代理）: " + key); refresh(); })',
    '      .catch(function (e) { toast("上传失败: " + e.message, true); });',
    '  }',
    '  return workerMultipart(file, key, setPct);',
    '}',
    'function workerMultipart(file, key, setPct) {',
    '  var partSize = workerPartSize();',
    '  var total = Math.ceil(file.size / partSize);',
    '  var ct = file.type || "application/octet-stream";',
    '  var uploadId = "";',
    '  call("multipart/create" + q({ key: key }), { method: "POST", body: JSON.stringify({ contentType: ct }) })',
    '    .then(function (r) {',
    '      if (!r.ok) throw new Error(r.data.error || r.status);',
    '      uploadId = r.data.uploadId;',
    '      var tasks = [];',
    '      var done = 0;',
    '      for (var n = 1; n <= total; n++) {',
    '        tasks.push(workerStep(n, key, uploadId, partSize, file, function () {',
    '          done++; setPct(Math.round(done / total * 100));',
    '        }));',
    '      }',
    '      var conc = concurrency();',
    '      return runPool(tasks, conc).then(function () {',
    '        return call("multipart/complete" + q({ key: key }), {',
    '          method: "POST", body: JSON.stringify({ uploadId: uploadId }),',
    '        });',
    '      });',
    '    })',
    '    .then(function (r) {',
    '      toast(r.ok ? "分片上传完成（Worker 代理，并发 " + concurrency() + "）: " + key',
    '        : "合并失败: " + ((r.data && r.data.error) || "未知"), !r.ok);',
    '      refresh();',
    '    })',
    '    .catch(function (e) {',
    '      if (uploadId) {',
    '        call("multipart/abort" + q({ key: key }), {',
    '          method: "POST", body: JSON.stringify({ uploadId: uploadId }),',
    '        }).catch(function () {});',
    '      }',
    '      toast("分片上传失败（已清理未完成的碎片）: " + e.message, true);',
    '    });',
    '}',
    'function workerStep(n, key, uploadId, partSize, file, done) {',
    '  return function () {',
    '    return withRetry(function () {',
    '      var start = (n - 1) * partSize;',
    '      var chunk = file.slice(start, Math.min(start + partSize, file.size));',
    '      var url = API + "multipart/part" + q({ key: key, uploadId: uploadId, partNumber: n });',
    '      return putXHR(url, chunk, "application/octet-stream", null, { direct: false });',
    '    }, 3).then(done);',
    '  };',
    '}',
    '/* 直传分片：逐片取预签名 URL，浏览器直发 B2（并发 + 失败重试） */',
    'function mpUpload(file, key) {',
    '  var setPct = progressRow(file);',
    '  var partSize = directPartSize();',
    '  var total = Math.ceil(file.size / partSize);',
    '  var ct = file.type || "application/octet-stream";',
    '  var uploadId = "";',
    '  call("multipart/create" + q({ key: key }), { method: "POST", body: JSON.stringify({ contentType: ct }) })',
    '    .then(function (r) {',
    '      if (!r.ok) throw new Error(r.data.error || r.status);',
    '      uploadId = r.data.uploadId;',
    '      var tasks = [];',
    '      var done = 0;',
    '      for (var n = 1; n <= total; n++) {',
    '        tasks.push(directStep(n, key, uploadId, partSize, file, function () {',
    '          done++; setPct(Math.round(done / total * 100));',
    '        }));',
    '      }',
    '      var conc = concurrency();',
    '      return runPool(tasks, conc).then(function () {',
    '        return call("multipart/complete" + q({ key: key }), {',
    '          method: "POST", body: JSON.stringify({ uploadId: uploadId }),',
    '        });',
    '      });',
    '    })',
    '    .then(function (r) {',
    '      toast(r.ok ? "上传完成（直传分片 " + total + " 片，并发 " + concurrency() + "）: " + key',
    '        : "合并失败: " + ((r.data && r.data.error) || "未知"), !r.ok);',
    '      refresh();',
    '    })',
    '    .catch(function (e) {',
    '      if (uploadId) {',
    '        call("multipart/abort" + q({ key: key }), {',
    '          method: "POST", body: JSON.stringify({ uploadId: uploadId }),',
    '        }).catch(function () {});',
    '      }',
    '      toast("上传失败（已清理未完成的碎片）: " + e.message, true);',
    '    });',
    '}',
    'function directStep(n, key, uploadId, partSize, file, done) {',
    '  return function () {',
    '    return withRetry(function () {',
    '      return call("multipart/part" + q({ key: key, uploadId: uploadId, partNumber: n })).then(function (pr) {',
    '        if (!pr.ok) throw new Error(pr.data.error || pr.status);',
    '        var start = (n - 1) * partSize;',
    '        var chunk = file.slice(start, Math.min(start + partSize, file.size));',
    '        return putXHR(pr.data.url, chunk, "application/octet-stream", null, { direct: true });',
    '      });',
    '    }, 3).then(done);',
    '  };',
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
    'function putXHR(url, blob, ct, setPct, opts) {',
    '  opts = opts || { direct: true };',
    '  return new Promise(function (resolve, reject) {',
    '    var xhr = new XMLHttpRequest();',
    '    xhr.open("PUT", absUrl(url), true);',
    '    xhr.setRequestHeader("Content-Type", ct);',
    '    if (!opts.direct) {',
    '      var h = buildHeaders(false);',
    '      for (var key in h) { if (Object.prototype.hasOwnProperty.call(h, key)) xhr.setRequestHeader(key, h[key]); }',
    '    }',
    '    xhr.upload.onprogress = function (e) {',
    '      if (e.lengthComputable && setPct) setPct(Math.round(e.loaded / e.total * 100));',
    '    };',
    '    xhr.onload = function () {',
    '      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);',
    '      else reject(new Error("HTTP " + xhr.status + " " + String(xhr.responseText || "").slice(0, 200)));',
    '    };',
    '    xhr.onerror = function () { reject(new Error(opts.direct ? ERR_DIRECT : ERR_WORKER)); };',
    '    xhr.send(blob);',
    '  });',
    '}',
    'function simpleUpload(file, key) {',
    '  var setPct = progressRow(file);',
    '  var ct = file.type || "application/octet-stream";',
    '  call("presign" + q({ key: key, type: "put", ct: ct })).then(function (r) {',
    '    if (!r.ok) { toast("预签名失败: " + (r.data.error || r.status), true); return; }',
    '    return putXHR(r.data.url, file, ct, setPct, { direct: true }).then(function () {',
    '      setPct(100); toast("上传完成（直传）: " + key); refresh();',
    '    });',
    '  }).catch(function (e) { toast("上传失败: " + e.message, true); });',
    '}',
    '/* 绝对地址（跟随当前访问域名，而不是写死某个域名）。',
    '   多桶语义下对象 URL 必须落在挂载点上：公开前缀内的 key 生成 /share/<桶>/<去前缀路径>',
    '   （匿名可访问、可直接分享）；其余生成 /<桶>/<key>（管理员经 Worker 访问）。',
    '   之前用 CFG.basePath 拼接，在全局入口 /__manage 下 basePath 是 "/"，',
    '   会把 /share/110MB.test 这类 URL 的第一段当桶名 → 「未挂载的桶」。 */',
    'function objUrl(key) {',
    '  var enc = key.split("/").map(encodeURIComponent).join("/");',
    '  var pp = (CFG.publicPrefix || "").replace(/\\/+$/, "");',
    '  if (pp && enc.toLowerCase().indexOf(pp.toLowerCase() + "/") === 0) {',
    '    return location.origin + "/share/" + CFG.bucketFixed + "/" + enc.slice(pp.length + 1);',
    '  }',
    '  return location.origin + "/" + CFG.bucketFixed + "/" + enc;',
    '}',
    '/* 复制链接：经 Worker 的可分享地址（与「下载」同一路径，加 ?dl=1 即强制另存） */',
    'function copyText(text) {',
    '  function fallback() { window.prompt("复制这条链接（经 Worker，可直接分享）", text); }',
    '  if (navigator.clipboard && navigator.clipboard.writeText) {',
    '    navigator.clipboard.writeText(text).then(function () { toast("已复制链接: " + text); }, fallback);',
    '    return;',
    '  }',
    '  try {',
    '    var ta = document.createElement("input");',
    '    ta.value = text; document.body.appendChild(ta); ta.select();',
    '    document.execCommand("copy"); document.body.removeChild(ta);',
    '    toast("已复制链接: " + text);',
    '  } catch (e) { fallback(); }',
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
    '      var segs = PREFIX.replace(/\\/+$/, "").split("/");',
    '      segs.pop();',
    '      load(segs.length ? segs.join("/") + "/" : "");',
    '      break;',
    '    case "dir": load(p); break;',
    '    case "dl":',
    '      window.open(objUrl(k) + "?dl=1", "_blank");',
    '      break;',
    '    case "copy":',
    '      copyText(objUrl(k));',
    '      break;',
    '    case "ren":',
    '      var target = window.prompt("重命名为（输入 其它桶名/路径 可跨桶移动）：", k.split("/").pop());',
    '      if (!target) return;',
    '      var toBucket = CFG.bucketFixed, toKey = PREFIX + target;',
    '      var head = target.split("/")[0].toLowerCase();',
    '      if ((CFG.buckets || []).some(function (b) { return b.name === head; }) && head !== CFG.bucketFixed) {',
    '        toBucket = head;',
    '        toKey = target.slice(head.length + 1);',
    '      }',
    '      call("copy", { method: "POST", body: JSON.stringify({ from: k, to: toKey, toBucket: toBucket, move: true }) })',
    '        .then(function (r) { toast(r.ok ? (r.data.crossBucket ? "已移动到 " + toBucket : "已重命名") : "失败: " + (r.data.error || r.status), !r.ok); refresh(); });',
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
    '/* 配置CORS：把一个来源写入当前桶的 CORS 规则（B2 原生 API，免费不计次）。',
    '   浏览器直传（presigned PUT）与跨域下载依赖桶级 CORS；默认放行当前站点域名。 */',
    'el("btnCors").onclick = function () {',
    '  var def = (location.origin && location.origin.indexOf("http") === 0) ? location.origin : "https://";',
    '  var o = window.prompt("加入 B2 桶 CORS 的来源（https://域名，可带端口）：", def);',
    '  if (!o) return;',
    '  o = o.replace(/\\/+$/, "");',
    '  call("cors", { method: "POST", body: JSON.stringify({ origin: o }) })',
    '    .then(function (r) {',
    '      var n = r.data && r.data.corsRules ? r.data.corsRules.length : 0;',
    '      toast(r.ok ? "CORS 已更新：已放行 " + o + "（该桶共 " + n + " 条规则）" : "CORS 配置失败: " + ((r.data && r.data.error) || r.status), !r.ok);',
    '    });',
    '};',
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
    '    var okAuth = r.data && r.data.authenticated;',
    '    if (okAuth) { try { sessionStorage.setItem("cfb2-token", TOKEN || ""); } catch (e) {} }',
    '    toast(okAuth ? "鉴权成功" : "鉴权失败", !okAuth);',
    '    refresh();',
    '  });',
    '};',
    'el("btnLogout").onclick = function () {',
    '  TOKEN = "";',
    '  el("fUser").value = "";',
    '  el("fPass").value = "";',
    '  try { sessionStorage.removeItem("cfb2-token"); } catch (e) {}',
    '  fetch(absUrl(API + "logout"), { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } })',
    '    .catch(function () {})',
    '    .then(function () {',
    '      return fetch(absUrl(API + "health"), {',
    '        credentials: "same-origin",',
    '        headers: { Accept: "application/json", Authorization: "Basic " + btoa("logout:logout") },',
    '      });',
    '    })',
    '    .catch(function () {})',
    '    .then(function () {',
    '      toast("已退出：本地凭据已清除。若浏览器仍自动登录，请关闭标签页/浏览器，或改用 Bearer 令牌模式（退出即时生效）。");',
    '      setTimeout(function () { location.reload(); }, 900);',
    '    });',
    '};',
    '/* 移动端「更多」折叠：默认收起，点击在 moreMenu 上切换 more-open（桌面该按钮被隐藏，不影响） */',
    'if (el("moreMenu") && el("btnMore")) {',
    '  el("btnMore").onclick = function () {',
    '    var m = el("moreMenu");',
    '    var open = !m.classList.contains("more-open");',
    '    if (open) m.classList.add("more-open"); else m.classList.remove("more-open");',
    '    el("btnMore").textContent = open ? "更多 ▴" : "更多 ▾";',
    '    el("btnMore").setAttribute("aria-expanded", open ? "true" : "false");',
    '  };',
    '}',
    'el("upMode").onchange = function () { saveMode(); syncTuning(); };',
    'try {',
    '  var sm = localStorage.getItem("cfb2-upmode");',
    '  if (sm === "worker" || sm === "direct") el("upMode").value = sm;',
    '} catch (e) {}',
    '/* 调参：输入框优先，其次服务端默认值；改动即时生效并记忆在本机 */',
    'try {',
    '  var tn = JSON.parse(localStorage.getItem("cfb2-tune") || "{}");',
    '  if (tn && tn.part) el("partSize").value = tn.part;',
    '  if (tn && tn.conc) el("conc").value = tn.conc;',
    '} catch (e) {}',
    'el("partSize").onchange = function () { var r = syncTuning(); toast("分片大小已设为 " + r.part + " MiB"); };',
    'el("conc").onchange = function () { var r = syncTuning(); toast("并发数已设为 " + r.conc); };',
    'syncTuning();',
    '/* ---------- B2 用量面板（空间自己遍历算，次数只能自己数） ---------- */',
    'function sizeD(b) {',
    '  /* 用量卡片用十进制单位（与 B2 控制台一致：10 GB = 10,000,000,000 字节） */',
    '  if (!b) return "0 B";',
    '  var u = ["B", "KB", "MB", "GB", "TB"], v = b, i = 0;',
    '  while (v >= 1000 && i < u.length - 1) { v = v / 1000; i++; }',
    '  return v.toFixed(i ? 1 : 0) + " " + u[i];',
    '}',
    'function pct(used, quota) {',
    '  if (!quota) return "";',
    '  var p = used / quota * 100;',
    '  return (p < 1 ? p.toFixed(2) : p.toFixed(1)) + "%";',
    '}',
    'function quotaCell(label, used, quota) {',
    '  var over = quota > 0 && used >= quota;',
    '  return "<span class=\\"kv\\"><span class=\\"muted\\">" + label + "</span>"',
    '    + "<span class=\\"v" + (over ? " over" : "") + "\\">" + used + "</span>"',
    '    + "<span class=\\"muted\\">/ " + (quota || "-") + "</span></span>";',
    '}',
    '/* 用量卡片：全部挂载桶两列并排（按 BUCKET_N 序号排序），每桶只展示',
    '   「桶名 / 已用空间 / 对象数 / Class B / Class C」，计数后端放卡片底部 */',
    'function renderUsage(d) {',
    '  var list = (d && d.buckets) || [];',
    '  var html = "";',
    '  if (!list.length) {',
    '    html += "<div class=\\"row\\"><span>没有已挂载的桶</span></div>";',
    '  } else {',
    '    html += \'<div class="bgrid">\';',
    '    list.forEach(function (b) {',
    '      var s = b.storage || {};',
    '      var quota = b.quotaBytes || 0;',
    '      var cell = "<div class=\\"bcell\\"><div class=\\"bname\\">" + esc(b.label || b.name) + "</div>";',
    '      if (s.ok === false) {',
    '        cell += "<div class=\\"muted\\">空间统计失败：" + esc(s.error || "未知错误") + "</div>";',
    '      } else {',
    '        var used = s.usedBytes || 0;',
    '        cell += "<div class=\\"row\\">"',
    '          + "<span class=\\"kv\\"><span class=\\"muted\\">已用空间:</span><span class=\\"v\\">" + pct(used, quota) + "</span></span>"',
    '          + (quota ? "<span class=\\"muted\\">" + sizeD(used) + " / " + sizeD(quota) + "</span>" : "<span class=\\"muted\\">" + sizeD(used) + "</span>")',
    '          + "<span class=\\"kv\\"><span class=\\"muted\\">对象数</span><span class=\\"v\\">" + (s.objects || 0) + "</span>"',
    '          + (s.complete === false ? "<span class=\\"over\\">（扫描到上限，实际更多）</span>" : "") + "</span>"',
    '          + "</div>";',
    '        if (quota) cell += \'<div class="bar"><i style="width:\' + Math.min(100, used / quota * 100) + \'%"></i></div>\';',
    '      }',
    '      cell += "<div class=\\"row\\" style=\\"margin-top:8px\\">"',
    '        + quotaCell("Class B:", (b.classB || {}).used || 0, (b.classB || {}).quota || 0)',
    '        + quotaCell("Class C:", (b.classC || {}).used || 0, (b.classC || {}).quota || 0)',
    '        + "</div></div>";',
    '      html += cell;',
    '    });',
    '    html += "</div>";',
    '  }',
    '  html += \'<div class="foot"><span>计数后端：\' + esc(d.counterBackendLabel || "-") + "</span></div>";',
    '  el("usage").innerHTML = html;',
    '}',
    'function loadUsage() {',
    '  if (!el("usage")) return;',
    '  el("usage").innerHTML = \'<span class="muted">正在读取用量…</span>\';',
    '  call("usage").then(function (r) {',
    '    if (!r.ok || !r.data || r.data.ok === false) {',
    '      el("usage").innerHTML = \'<span class="muted">用量面板不可用：\' + esc((r.data && r.data.error) || r.status) + "</span>";',
    '      return;',
    '    }',
    '    renderUsage(r.data);',
    '  }).catch(function (e) {',
    '    el("usage").innerHTML = \'<span class="muted">用量面板不可用：\' + esc(e.message) + "</span>";',
    '  });',
    '}',
    'loadUsage();',
    'el("bucketLabel").textContent = "桶: " + CFG.bucketFixed;',
    '/* 桶切换器：跳到目标桶的管理器（多桶挂载） */',
    '(CFG.buckets || []).forEach(function (b) {',
    '  var o = document.createElement("option");',
    '  o.value = b.name;',
    '  o.textContent = b.label;',
    '  if (b.name === CFG.bucket) o.selected = true;',
    '  el("bucketSel").appendChild(o);',
    '});',
    'el("bucketSel").onchange = function () {',
    '  location.href = "/" + el("bucketSel").value + "/__manage";',
    '};',
    'if (CFG.publicWrite) { el("btnLogin").className = "ghost hidden"; el("btnLogout").className = "ghost hidden"; }',
    'try {',
    '  var st = sessionStorage.getItem("cfb2-token");',
    '  if (st && CFG.hasToken) { TOKEN = st; el("fPass").value = st; }',
    '} catch (e) {}',
    'if (CFG.hasToken) { el("fUser").className = "hidden"; el("fPass").placeholder = "Bearer 令牌"; }',
    'load("");',
    '})();',
    '</script>',
    '</body></html>',
  ].join('\n');
}

/* ============================ 9. 主入口与路由 ============================ */

/**
 * 请求入口：准备每请求独立的 cfg 与用量计数器，分发后异步把计数落盘。
 * 计数落盘放在 finally 里，因此出错路径产生的 B2 调用同样会被统计。
 */

/* ---------- src/ui/directory.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L2158-L2402 */



function renderDirectory(data, prefix, opts = {}) {
  const base = opts.base || '/';
  const baseLabel = opts.label || '';
  const showManage = opts.showManage !== false;
  const hideKeep = opts.hideKeep !== false;
  const publicPrefix = opts.publicPrefix || '';
  // 管理员删除目录用的 API 基址（挂载点感知：/<桶>/__api/ 或 /share/<桶>/__api/）
  const apiBase = base.replace(/\/+$/, '') + API_PREFIX;
  const bucketName = opts.bucket || '';

  const rows = [];
  // 目录占位对象（<prefix>/.keep）不参与展示与计数
  const files = hideKeep ? data.files.filter((f) => f.name !== '.keep') : data.files;

  /* 路径导航：挂载点段（crumbPre，由调用方按挂载方式给出）+ 相对段（relPrefix），每一级都可点击 */
  const crumbPre = Array.isArray(opts.crumbPre) ? opts.crumbPre : [];
  const relPrefix = opts.relPrefix !== undefined ? opts.relPrefix : prefix;
  const crumbs = crumbPre.map((c) => '<a href="' + escapeHtml(c.href) + '">' + escapeHtml(c.label) + '</a>');
  const segs = relPrefix.replace(/\/+$/, '').split('/').filter(Boolean);
  let acc = '';
  segs.forEach((seg, i) => {
    acc += seg + '/';
    crumbs.push(i === segs.length - 1
      ? '<span class="cur">' + escapeHtml(seg) + '</span>'
      : '<a href="' + base + escapeHtml(acc) + '">' + escapeHtml(seg) + '</a>');
  });
  if (!crumbs.length) crumbs.push('<span class="cur">/</span>');
  const crumbsHtml = '<nav class="crumb">' + crumbs.join('<span class="sep">/</span>') + '</nav>';

  if (relPrefix.replace(/\/+$/, '')) {
    // 注意 relPrefix 形如 "images/"，先去尾斜杠再取父级，否则会算成自己
    const parent = relPrefix.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    rows.push('<tr><td colspan="4"><a href="' + base
      + escapeHtml(parent ? parent + '/' : '') + '">返回上一级</a></td></tr>');
  } else if (opts.upHref) {
    // 已在挂载根：返回到虚拟根（/ 或 /share/）
    rows.push('<tr><td colspan="4"><a href="' + escapeHtml(opts.upHref) + '">返回上一级</a></td></tr>');
  }

  for (const folder of data.folders) {
    // 相对挂载点（已去掉 share/ 这类别名偏移）：href 基于挂载根 base 拼接，且保留尾斜杠（目录链接）；
    // 显示名 name 才需要去尾斜杠。不能再加完整列举前缀，否则别名下会出现 /share/<桶>/share/… 双前缀。
    const rel = relPrefix + folder.slice(prefix.length);
    const name = folder.slice(prefix.length).replace(/\/$/, '');
    // 匿名不给任何操作（连 JSON 也不暴露）；管理员给「删除」（删掉该目录的 .keep 占位）
    const dirAct = showManage
      ? '<td><button data-act="deldir" data-k="' + escapeHtml(folder + '.keep') + '">删除</button></td>'
      : '<td></td>';
    rows.push('<tr class="dir"><td><a href="' + base + escapeHtml(rel) + '">' + escapeHtml(name) + '/</a></td>'
      + '<td>-</td><td>-</td>'
      + dirAct + '</tr>');
  }

  for (const file of files) {
    const href = base + escapeHtml(relPrefix + file.name);
    rows.push('<tr><td>[FILE] <a href="' + href + '">' + escapeHtml(file.name) + '</a></td>'
      + '<td>' + humanSize(file.size) + '</td>'
      + '<td>' + escapeHtml(file.lastModified) + '</td>'
      + '<td><a href="' + href + '">下载</a></td></tr>');
  }

  const initCount = data.folders.length + files.length;
  const cfgJson = inlineJson({
    prefix, base, relPrefix, apiBase, bucket: bucketName,
    showManage: !!showManage,
    next: data.truncated ? (data.nextToken || '') : '', loaded: initCount,
    hideKeep: !!hideKeep,
  });

  const script = [
    '(function () {',
    'var C = ' + cfgJson + ';',
    'var NEXT = C.next, LOADING = false, LOADED = C.loaded;',
    'function esc(s) {',
    '  return String(s).split("&").join("&amp;").split("<").join("&lt;")',
    '    .split(">").join("&gt;").split(String.fromCharCode(34)).join("&quot;");',
    '}',
    'function human(b) {',
    '  if (!b) return "0 B";',
    '  var u = ["B","KB","MB","GB","TB"], v = b, i = 0;',
    '  while (v >= 1024 && i < u.length - 1) { v = v / 1024; i++; }',
    '  return v.toFixed(i ? 1 : 0) + " " + u[i];',
    '}',
    'function rowsHtml(d) {',
    '  var out = "";',
    '  (d.folders || []).forEach(function (p) {',
    '    var name = p.slice(C.prefix.length);',
    '    var rel = C.relPrefix + p.slice(C.prefix.length);',
    '    if (name.charAt(name.length - 1) === "/") name = name.slice(0, -1);',
    '    var act = C.showManage',
    '      ? \'<td><button data-act="deldir" data-k="\' + esc(p + \'.keep\') + \'">删除</button></td>\'',
    '      : \'<td></td>\';',
    '    out += \'<tr class="dir"><td><a href="\' + C.base + esc(rel) + \'">\' + esc(name) + \'/</a></td>\'',
    '      + \'<td>-</td><td>-</td>\'',
    '      + act + \'</tr>\';',
    '  });',
    '  (d.files || []).filter(function (f) { return !(C.hideKeep && f.name === ".keep"); })',
    '    .forEach(function (f) {',
    '    var href = C.base + esc(C.relPrefix + f.name);',
    '    out += \'<tr><td>[FILE] <a href="\' + href + \'">\' + esc(f.name) + \'</a></td>\'',
    '      + "<td>" + human(f.size) + "</td>"',
    '      + \'<td class="muted">\' + esc(f.lastModified) + "</td>"',
    '      + \'<td><a href="\' + href + \'">下载</a></td></tr>\';',
    '  });',
    '  return out;',
    '}',
    'function paint() {',
    '  document.getElementById("status").innerHTML = LOADING',
    '    ? \'<span class="spin"></span> 正在加载…\'',
    '    : (NEXT ? "已加载 " + LOADED + " 项 · 继续往下滚动加载更多" : "已加载 " + LOADED + " 项 · 到底了");',
    '}',
    '/* 请求一律用绝对 URL。若页面是通过 https://user:pass@host/… 打开的（书签里带了凭据），',
    '   相对 URL 会让 fetch 直接抛 “Request cannot be constructed from a URL that includes credentials”，',
    '   列表会一直卡在「正在加载…」。location.origin 不含凭据，同源请求浏览器会自动带上已缓存的 Basic 认证。 */',
    'function absUrl(u) { return /^[a-z][a-z0-9+.-]*:\\/\\//i.test(u) ? u : location.origin + u; }',
    'function more() {',
    '  if (LOADING || !NEXT) return;',
    '  LOADING = true; paint();',
    '  fetch(absUrl(location.pathname + "?format=json&cursor=" + encodeURIComponent(NEXT)), { credentials: "same-origin" })',
    '    .then(function (r) { return r.json(); })',
    '    .then(function (d) {',
    '      LOADING = false;',
    '      if (!d || d.ok === false) { paint(); return; }',
    '      NEXT = d.truncated ? (d.nextToken || "") : "";',
    '      document.getElementById("tb").insertAdjacentHTML("beforeend", rowsHtml(d));',
    '      LOADED += (d.folders || []).length + (d.files || []).filter(function (f) {',
    '        return !(C.hideKeep && f.name === ".keep"); }).length;',
    '      paint();',
    '    })',
    '    .catch(function () { LOADING = false; paint(); });',
    '}',
    'window.addEventListener("scroll", function () {',
    '  if (LOADING || !NEXT) return;',
    '  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300) more();',
    '});',
    '/* 管理员：删除目录（删掉该目录的 .keep 占位）。匿名页面不渲染这个按钮。 */',
    'document.addEventListener("click", function (e) {',
    '  var t = e.target;',
    '  while (t && t !== document && t.tagName !== "BUTTON") t = t.parentNode;',
    '  if (!t || t === document || t.getAttribute("data-act") !== "deldir") return;',
    '  var k = t.getAttribute("data-k") || "";',
    '  if (!k || !window.confirm("确认删除目录 " + k + " ？")) return;',
    '  fetch(absUrl(C.apiBase + "object?key=" + encodeURIComponent(k) + "&bucket=" + encodeURIComponent(C.bucket || "")), {',
    '    method: "DELETE", credentials: "same-origin",',
    '  })',
    '    .then(function (r) { return r.json(); })',
    '    .then(function (j) {',
    '      if (j && j.ok) location.reload();',
    '      else window.alert("删除失败: " + ((j && j.error) || "未知错误"));',
    '    })',
    '    .catch(function () { window.alert("删除失败：网络错误"); });',
    '});',
    'paint();',
    '})();',
  ].join('\n');

  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(relPrefix || '/') + ' - B2 Index</title>',
    // 空 favicon：避免浏览器自动请求 /favicon.ico（会被当对象下载，白记 1 次 Class B）
    '<link rel="icon" href="data:,">',
    '<style>',
    themeCss(),
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:32px}',
    '.wrap{max-width:900px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}',
    '.crumb{font-size:18px;font-weight:600;margin:0 0 6px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}',
    '.crumb a{color:var(--acc)}.crumb a:hover{text-decoration:underline}',
    '.crumb .sep{color:var(--dim);font-weight:400}.crumb .cur{color:var(--txt)}',
    '.sub{color:var(--dim);font-size:13px;margin-bottom:20px}',
    '.top{display:flex;align-items:center;gap:10px;margin-bottom:18px}',
    '.top .grow{flex:1}',
    '#status{margin-top:16px;font-size:12px;color:var(--dim);display:flex;gap:8px;align-items:center;justify-content:center}',
    '.spin{width:12px;height:12px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;display:inline-block;animation:sp .8s linear infinite}',
    '@keyframes sp{to{transform:rotate(360deg)}}',
    'button{font:inherit;color:var(--txt);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer}',
    'table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}',
    'td{padding:10px 14px;border-bottom:1px solid var(--line);font-size:14px}',
    'tr:last-child td{border-bottom:0}tr:hover td{background:var(--hover)}',
    'tr.dir td{background:var(--folder)}tr.dir:hover td{background:var(--hover)}',
    'tr.dir td a{color:var(--folderTxt)}tr.dir td [data-act]{color:var(--folderTxt)}',
    'a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}',
    '.empty{color:var(--dim);padding:24px;text-align:center}.muted{color:var(--dim)}',
    '</style></head><body><div class="wrap">',
    '<div class="top"><button id="btnTheme">深色模式</button><span class="grow"></span></div>',
    crumbsHtml,
    '<div class="sub">' + data.folders.length + ' 个目录 / ' + files.length
      + ' 个文件'
      + (showManage ? ' · <a href="' + base + MANAGE_PATH.slice(1) + '">打开管理器</a>' : '')
      + '</div>',
    '<table><thead><tr><th style="text-align:left">名称</th><th>大小</th><th>修改时间</th><th></th></tr></thead>',
    '<tbody id="tb">' + (rows.join('') || '<tr><td class="empty" colspan="4">（空）</td></tr>') + '</tbody></table>',
    '<div id="status"></div>',
    '</div>',
    '<script>' + themeToggleScript() + '</script>',
    '<script>' + script + '</script>',
    '</body></html>',
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
    // 空 favicon：避免浏览器自动请求 /favicon.ico（会被当对象下载，白记 1 次 Class B）
    '<link rel="icon" href="data:,">',
    '<style>',
    themeCss(),
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--txt);margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}',
    '.card{max-width:560px;padding:32px 36px;background:var(--card);border:1px solid var(--line);border-radius:14px}',
    '.thm{position:fixed;top:14px;right:14px}',
    'button{font:inherit;color:var(--txt);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer}',
    'h1{font-size:19px;margin:0 0 10px}p{color:var(--dim);line-height:1.7;font-size:14px;margin:6px 0}',
    'code{background:var(--chip);padding:2px 6px;border-radius:5px;color:var(--acc)}',
    'a{color:var(--acc)}',
    '.btn{display:inline-block;margin-top:18px;padding:9px 16px;background:var(--acc);color:var(--btn);border-radius:8px;text-decoration:none;font-size:14px}',
    'ul{color:var(--dim);font-size:13px;line-height:1.9;padding-left:18px}',
    '</style></head><body>',
    '<div class="thm"><button id="btnTheme">深色模式</button></div><div class="card">',
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
    (cfg.hideDetails
      ? '<p style="margin-top:14px">区域与桶信息已对用户隐藏。</p>'
      : '<p style="margin-top:14px">当前桶：<code>' + escapeHtml(bucketLabel) + '</code>'
        + (prefix ? ' · 前缀 <code>' + escapeHtml(prefix) + '</code>' : '')
        + ' · 区域 <code>' + escapeHtml(cfg.region) + '</code></p>'),
    '<a class="btn" href="' + manageUrl + '">进入文件管理器</a>',
    '</div><script>' + themeToggleScript() + '</script></body></html>',
  ].join('\n');
}

/* ============================ 8. 文件管理器页面 ============================ */

/* ---------- src/router.js ---------- */
/* 由 src/b2-worker.js 拆分而来：原 L3214-L3482 */













async function handle(request, env, ctx) {
  const cfg = loadConfig(env);
  if (cfg.enableUsage) cfg.usage = { counts: {} };

  try {
    return await dispatch(request, env, ctx, cfg);
  } finally {
    if (cfg.usage && Object.keys(cfg.usage.counts).length) {
      const bucket = cfg.primaryBucket || (cfg.buckets[0] && cfg.buckets[0].name) || '';
      const pending = bucket ? flushCounters(cfg, env, bucket).catch(() => {}) : Promise.resolve();
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
    }
  }
}

/** 虚拟根页面（桶总览 / 公开桶聚合）。纯配置推导，0 次 B2 调用。 */
function mountListPage(cfg, { publicRoot, isAdmin }) {
  const title = publicRoot ? '公开目录' : '根目录';
  const items = cfg.buckets.map((b) => ({
    text: '[DIR] ' + (publicRoot ? b.label : b.name),
    href: publicRoot ? '/share/' + b.name + '/' : '/' + b.name + '/',
    sub: publicRoot ? '桶 ' + b.name + ' 的公开目录' : '桶 ' + b.name,
  }));
  const rows = items.map((it) =>
    '<tr class="dir"><td><a href="' + escapeHtml(it.href) + '">' + escapeHtml(it.text) + '</a></td>'
    + '<td class="muted" colspan="3">' + escapeHtml(it.sub) + '</td></tr>',
  ).join('') || '<tr><td colspan="4" class="muted">（未配置任何桶）</td></tr>';

  const crumbs = publicRoot
    ? '<nav class="crumb"><span class="cur">公开目录</span></nav>'
    : '<nav class="crumb"><span class="cur">根目录</span></nav>';
  const adminBar = isAdmin
    ? '<div class="sub"><a class="acc" href="' + MANAGE_PATH + '">文件管理器</a> · 共 ' + cfg.buckets.length + ' 个桶'
      + (publicRoot ? '' : ' · 匿名用户只能访问 <a class="acc" href="/share/">/share/</a>') + '</div>'
    : '';

  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + title + ' - B2 Index</title>',
    '<link rel="icon" href="data:,">',
    '<style>',
    themeCss(),
    'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:var(--bg);color:var(--txt);margin:0;padding:32px}',
    '.wrap{max-width:900px;margin:0 auto}',
    '.crumb{font-size:18px;font-weight:600;margin:0 0 12px}',
    '.crumb a{color:var(--acc)}.crumb a:hover{text-decoration:underline}',
    '.acc{color:var(--acc)}',
    'table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}',
    'td{padding:12px 14px;border-bottom:1px solid var(--line);font-size:14px}',
    'tr:last-child td{border-bottom:0}',
    'tr.dir td{background:var(--folder)}',
    'tr.dir td a{color:var(--folderTxt)}',
    '.muted{color:var(--dim)}',
    '</style></head><body><div class="wrap">',
    crumbs,
    adminBar,
    '<table><tbody>' + rows + '</tbody></table>',
    '</div><script>' + themeToggleScript() + '</script></body></html>',
  ].join('\n');
}

/** 部署后引导：给每个挂载桶盲写 <share>/.keep（幂等，Class A 免费，0 次 Class C）。
 *  用 Cache API 标记（键含挂载表指纹）去重；换个 colo 重复盲写也无害。 */
let bootstrappedMounts = '';   // 本隔离实例已做过的引导（Cache 标记负责跨实例去重）

async function bootstrapPublicDirs(cfg, env) {
  if (!cfg.buckets.length) return;
  const names = cfg.buckets.map((b) => b.name).join(',');
  if (bootstrappedMounts === names) return;
  const flagKey = USAGE_CACHE_ORIGIN + '/bootstrap/' + (await sha256Hex(names)).slice(0, 32);
  const seen = await cacheGetJson(flagKey);
  if (seen && seen.done) return;
  await Promise.all(cfg.buckets.map(async (m) => {
    const bc = bucketView(cfg, m);
    try {
      await b2Fetch(bc, 'PUT', objectUrl(bc, m.name, cfg.publicPrefix + '/.keep'), {
        headers: { 'Content-Type': 'application/octet-stream' },
        body: '',
      });
    } catch (error) {
      console.error('[cf-b2-worker] 引导公开目录失败', m.name, error && error.message);
    }
  }));
  await cachePutJson(flagKey, { done: true }, 30 * 86400);
  bootstrappedMounts = names;
}

async function dispatch(request, env, ctx, cfg) {
  const url = new URL(request.url);

  if (!cfg.buckets.length) {
    return json({
      ok: false,
      error: '未配置任何桶：请添加 BUCKET_1 环境变量（JSON，含 BUCKET_NAME / KEY_ID / APPLICATION_KEY / ENDPOINT）'
        + (cfg.mountProblems.length ? '；配置问题：' + cfg.mountProblems.join('；') : ''),
    }, 500, request, cfg);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, cfg) });
  }

  /* 部署后引导（异步，不阻塞响应）：给每个桶补建 share/ 占位目录 */
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(bootstrapPublicDirs(cfg, env).catch(() => {}));
  }

  /* ---- 管理 API（/<bucket>/__api/... 与 /share/<bucket>/__api/...） ---- */
  if (url.pathname.includes(API_PREFIX)) {
    return apiRouter(request, env, ctx, cfg, url);
  }

  /* ---- 文件管理器页面（/<bucket>/__manage；匿名保留 401 挑战以便浏览器弹出登录） ---- */
  if (cfg.enableManage && url.pathname.endsWith(MANAGE_PATH)) {
    const auth = await checkAuth(request, cfg);
    if (!auth.ok) return challenge(request, cfg);
    const base = url.pathname.slice(0, -MANAGE_PATH.length);
    const name = resolveApiBucket(cfg, base, url);
    if (!name || !applyBucket(cfg, name)) {
      return Response.redirect(new URL('/' + cfg.buckets[0].name + MANAGE_PATH, url.origin).toString(), 302);
    }
    return html(managePage(cfg, url));
  }

  const mount = resolveMount(cfg, url.pathname);
  const auth = await checkAuth(request, cfg);
  const isAdmin = auth.ok;
  const anonymous = !isAdmin;

  /* 非法路径（穿越段）最先拒绝 */
  if (mount.kind === 'bad') {
    return deny('非法路径', request, cfg, 400);
  }

  /* 匿名：默认只有别名 /share/<桶>/** 的 GET；PUBLIC_PREFIX 留空时退回旧开放模式（整桶可读）。
     规范路径 /<桶>/share/** 对匿名一律 308 到别名，保证公开内容只有单一 URL。 */
  if (anonymous) {
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    let allowed = false;
    if (isRead && mount.kind === 'shareRoot') {
      allowed = true;   // 公开聚合根本身就是匿名入口
    } else if (isRead && mount.kind === 'bucket') {
      const key = normalizeKey(mount.inner);
      allowed = mount.alias
        ? withinPrefix(key, cfg.publicPrefix)
        : !cfg.publicPrefix && withinPrefix(key, cfg.publicPrefix);
    }
    if (!allowed) {
      if (!isRead) {
        return json({ ok: false, error: '匿名只有 /share/ 的浏览与下载权限（GET）' }, 401, request, cfg);
      }
      const target = mount.kind === 'bucket' && !mount.alias ? smartPublicRedirect(mount) : '/share/';
      return Response.redirect(new URL(target, url.origin).toString(), 308);
    }
  }

  /* ---- 虚拟根 / 未挂载 / 非法路径 ---- */
  if (mount.kind === 'root' || mount.kind === 'shareRoot') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return deny((mount.kind === 'root' ? '根目录' : '/share/') + ' 是虚拟目录，不支持该操作', request, cfg, 403);
    }
    return html(mountListPage(cfg, { publicRoot: mount.kind === 'shareRoot', isAdmin }));
  }
  if (mount.kind === 'miss') {
    if (anonymous) return Response.redirect(new URL('/share/', url.origin).toString(), 308);
    return json({ ok: false, error: '未挂载的桶：' + (mount.name || '') }, 404, request, cfg);
  }

  /* ---- 挂载的桶 ---- */
  applyBucket(cfg, mount.m.name);
  const bucket = mount.m.name;
  const resolved = {
    bucket,
    key: normalizeKey(mount.inner.replace(/^\/+/, '').replace(/\/+$/, '')),
    isDir: mount.inner === '/' || mount.inner.endsWith('/'),
  };

  switch (request.method) {
    case 'GET':
    case 'HEAD': {
      if (resolved.isDir) {
        // 目录 → 列表（HTML 或 JSON）
        const prefix = dirPrefix(
          url.searchParams.get('prefix') || (resolved.key ? resolved.key + '/' : ''),
        );
        // 匿名只可能来自别名挂载（inner 必在公开前缀内），这里再做一次防御性校验
        const anonymousListingOk = anonymous && cfg.publicRead
          && ((cfg.publicPrefix && cfg.publicList && withinPrefix(prefix, cfg.publicPrefix)) || cfg.allowList);
        if (anonymous && !cfg.allowList && !anonymousListingOk) {
          return Response.redirect(new URL(smartPublicRedirect(mount), url.origin).toString(), 308);
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
        const base = mount.alias ? '/share/' + bucket + '/' : '/' + bucket + '/';
        // 匿名视图不显示桶名，也不给出管理器入口
        const label = (auth.ok || !cfg.hideDetails) ? bucket : '公开目录';
        const crumbPre = mount.alias
          ? (auth.ok
            ? [{ label: bucket, href: '/' + bucket + '/' }, { label: 'share', href: '/share/' + bucket + '/' }]
            : [{ label: '公开目录', href: '/share/' }, { label: bucket, href: '/share/' + bucket + '/' }])
          : [{ label: bucket, href: '/' + bucket + '/' }];
        const relPrefix = mount.alias ? prefix.slice(cfg.publicPrefix.length + 1) : prefix;
        return html(renderDirectory(result, prefix, {
          base,
          bucket,
          label,
          showManage: auth.ok,
          hideKeep: cfg.hideKeep,
          crumbPre,
          relPrefix,
          upHref: mount.alias ? '/share/' : '/',
        }));
      }

      if (!resolved.key) return deny('缺少对象 key', request, cfg, 400);

      if (anonymous) {
        if (!cfg.publicRead) {
          return json({ ok: false, error: '该对象需要登录后访问' }, 403, request, cfg);
        }
        if (!withinPrefix(resolved.key, cfg.publicPrefix)) {
          return Response.redirect(new URL(smartPublicRedirect(mount), url.origin).toString(), 308);
        }
      }

      return readObject(request, env, ctx, cfg, bucket, applyRclone(cfg, resolved.key), { anonymous });
    }

    case 'PUT': {
      if (!resolved.key) return deny('缺少对象 key', request, cfg, 400);
      const auth = await checkAuth(request, cfg);
      if (!auth.ok) return deny(auth.reason, request, cfg, 401);
      if (!cfg.enableWrite) return deny('已禁用写入（ENABLE_WRITE=false）', request, cfg, 405);
      const res = await putObject(request, cfg, bucket, resolved.key);
      if (res.ok) purgeObjectCache(ctx, cfg, bucket, resolved.key, url.origin);
      return res;
    }

    case 'DELETE': {
      if (!resolved.key) return deny('缺少对象 key', request, cfg, 400);
      const auth = await checkAuth(request, cfg);
      if (!auth.ok) return deny(auth.reason, request, cfg, 401);
      if (!cfg.enableDelete) return deny('已禁用删除（ENABLE_DELETE=false）', request, cfg, 405);
      const res = await deleteObject(cfg, bucket, resolved.key);
      if (res.ok) purgeObjectCache(ctx, cfg, bucket, resolved.key, url.origin);
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

/* ---------- src/index.js（入口，保留导出） ---------- */

export default {
  /** Cron Triggers 入口：每天定时刷新空间快照（见 wrangler.toml 的 [triggers]） */
  async scheduled(event, env, ctx) {
    try {
      return await runScheduled(event, env);
    } catch (error) {
      console.error('[cf-b2-worker] scheduled', error && error.stack ? error.stack : error);
      return { ok: false, error: String((error && error.message) || error) };
    }
  },

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
  shouldWindowScan, utcDayStamp, computeStorage, usageState, UsageCounter,
};

