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

/** 会暴露后端实现/对象内部信息的响应头，统一剥离 */
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
    // 空间扫描结果缓存时长（秒），默认 6 小时
    usageCacheTtl: Math.max(60, readInt(env.USAGE_CACHE_TTL, 21600)),
    // 手动「重新统计」的最小间隔（秒），默认 5 分钟
    usageMinInterval: Math.max(0, readInt(env.USAGE_MIN_INTERVAL, 300)),
    // 单次扫描最多翻多少页（每页 1000 个对象 = 1 次 Class C）
    usageScanMaxPages: Math.max(1, Math.min(200, readInt(env.USAGE_SCAN_MAX_PAGES, 20))),
    // 空间统计模式：
    //   false（默认）= 只在 Cron 触发（scheduled）或手动「重新统计」时扫描
    //   true         = 额外允许惰性自动扫描（TTL 过期或落入窗口）
    usageAutoScan: readBool(env.USAGE_AUTO_SCAN, false),
    // 惰性窗口（仅 usageAutoScan=true 时生效）：UTC 进入该小时后当天第一次读取强制重扫（-1 关闭）
    usageRefreshHour: (() => {
      const hour = readInt(env.USAGE_REFRESH_AT_UTC_HOUR, -1);
      return hour >= 0 && hour <= 23 ? hour : -1;
    })(),
    // 定时统计的桶列表（逗号分隔）。固定桶模式留空即用 BUCKET_NAME；
    // $path / $host 模式无法枚举桶，必须显式列出才会在 scheduled 里统计
    usageScheduleBuckets: String(env.USAGE_SCHEDULE_BUCKETS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
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
  const { headers = {}, body = null, query = {} } = options;
  const request = await signerOf(cfg).sign(method, url, { headers, body, query });
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

/* ============================ 5.5 B2 用量面板 ============================ */
/*
 * 背景：Backblaze 没有公开的「用量 / 事务次数」查询 API（官方只在 Web 控制台提供
 * Caps & Alerts，计数器每天 00:00 GMT 重置）。因此这里：
 *   1) 空间：用 S3 ListObjectsV2 全量遍历累加 Size（每 1000 对象消耗 1 次 Class C）；
 *      只统计 current 版本，non-current / hidden 版本不计（比账单口径略小）。
 *   2) 次数：在唯一的出网点 b2Fetch 上按 B2 事务类别计数，写进 Cache API，
 *      按 UTC 日切；Cache API 没有原子操作，高并发下会丢极少量计数。
 * 频率控制：扫描结果缓存 usageCacheTtl（默认 6h）；手动刷新受 usageMinInterval
 * （默认 5min）限流；打开管理页只读缓存、不主动打 B2。
 */

const USAGE_CACHE_ORIGIN = 'https://usage.internal';

/** UTC 日期戳（与 B2 计数器 00:00 GMT 重置对齐） */
function utcDayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

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
export class UsageCounter {
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
   */
  async onSync(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    const ttlMs = Math.max(0, Number(body.ttl) || 0) * 1000;
    const minIntervalMs = Math.max(0, Number(body.minInterval) || 0) * 1000;
    const windowHour = Number.isFinite(body.windowHour) ? body.windowHour : -1;

    const snapshot = this.data.storage;
    const snapshotAt = snapshot && snapshot.at ? Date.parse(snapshot.at) : 0;
    const ageMs = snapshotAt ? now.getTime() - snapshotAt : Infinity;
    const autoScan = body.autoScan === true;

    let shouldScan = false;
    let throttled = false;
    let windowed = false;
    let bootstrap = false;

    if (!snapshotAt) {
      shouldScan = true;              // 首次还没有任何快照 → 引导性扫一次
      bootstrap = true;
    } else if (body.refresh === true) {
      if (ageMs < minIntervalMs) throttled = true;
      else shouldScan = true;
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
      throttled,
      windowed,
      bootstrap,
      minInterval: Math.round(minIntervalMs / 1000),
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
function snapshotShape(bucket, source, { cached, throttled, ageSeconds }) {
  return {
    ok: true,
    bucket,
    usedBytes: source.usedBytes || 0,
    objects: source.objects || 0,
    pages: source.pages || 0,
    complete: source.complete !== false,
    at: source.at || '',
    cached: Boolean(cached),
    throttled: Boolean(throttled),
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : 0,
  };
}

/** 降级后端：Cache API（按数据中心独立，读-改-写非原子） */
async function usageStateViaCache(cfg, bucket, refresh) {
  const cached = await cacheGetJson(storageCacheKey(bucket));
  const cachedAt = cached && cached.at ? Date.parse(cached.at) : 0;
  const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
  const inWindow = cfg.usageAutoScan && cfg.usageRefreshHour >= 0
    && new Date().getUTCHours() >= cfg.usageRefreshHour;
  const windowed = cfg.usageAutoScan && Boolean(cached)
    && shouldWindowScan(new Date(), cfg.usageRefreshHour, cached.windowDay);

  let shouldScan = false;
  let throttled = false;
  if (!cachedAt) shouldScan = true;
  else if (refresh && ageMs < cfg.usageMinInterval * 1000) throttled = true;
  else if (refresh) shouldScan = true;
  else if (cfg.usageAutoScan && ageMs >= cfg.usageCacheTtl * 1000) shouldScan = true;
  else if (windowed) shouldScan = true;

  const counters = await readCountersViaCache(bucket);
  if (!shouldScan) {
    return {
      backend: 'cache',
      counters,
      storage: snapshotShape(bucket, cached, { cached: true, throttled, ageSeconds: Math.round(ageMs / 1000) }),
      throttled, windowed, minInterval: cfg.usageMinInterval,
    };
  }

  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) {
    return {
      backend: 'cache',
      counters,
      storage: { ok: false, error: scan.error, status: scan.status },
      throttled, windowed, minInterval: cfg.usageMinInterval,
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
    storage: snapshotShape(bucket, stored, { cached: false, throttled, ageSeconds: 0 }),
    throttled, windowed, minInterval: cfg.usageMinInterval,
  };
}

/**
 * 用量统一入口：绑定了 USAGE_DO 就走 Durable Object（全局一致 + 原子），
 * 否则退化到 Cache API。refresh=true 表示用户点了「重新统计」。
 */
async function usageState(cfg, env, bucket, refresh) {
  const stub = usageDoStub(env, bucket);
  if (!stub) return usageStateViaCache(cfg, bucket, refresh);

  let state;
  try {
    state = await doCall(stub, 'sync', {
      ttl: cfg.usageCacheTtl,
      minInterval: cfg.usageMinInterval,
      refresh,
      windowHour: cfg.usageRefreshHour,
      autoScan: cfg.usageAutoScan,
    });
  } catch (error) {
    console.error('[cf-b2-worker] DO 读取失败，本次改用 Cache API 口径:', error && error.message);
    return usageStateViaCache(cfg, bucket, refresh);
  }

  if (!state.shouldScan) {
    return {
      backend: 'do',
      counters: state.counters,
      resetAt: state.resetAt || '',
      storage: state.storage
        ? snapshotShape(bucket, state.storage, {
          cached: true, throttled: state.throttled, ageSeconds: state.ageSeconds,
        })
        : { ok: false, error: '暂无快照' },
      throttled: state.throttled,
      windowed: state.windowed,
      minInterval: state.minInterval,
    };
  }

  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) {
    return {
      backend: 'do',
      counters: state.counters,
      resetAt: state.resetAt || '',
      storage: { ok: false, error: scan.error, status: scan.status },
      throttled: state.throttled,
      windowed: state.windowed,
      minInterval: state.minInterval,
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
    storage: snapshotShape(bucket, saved.storage, {
      cached: false, throttled: state.throttled, ageSeconds: 0,
    }),
    throttled: state.throttled,
    windowed: state.windowed,
    minInterval: state.minInterval,
  };
}

/** 定时统计要覆盖的桶列表：显式配置优先，固定桶模式回落到 BUCKET_NAME */
function scheduledBuckets(cfg) {
  if (cfg.usageScheduleBuckets.length) return cfg.usageScheduleBuckets;
  if (cfg.bucketMode === 'fixed' && cfg.bucketFixed) return [cfg.bucketFixed];
  return [];
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
  for (const bucket of buckets) {
    const item = { bucket, scan: null, reset: null };

    if (doScan) {
      try {
        const record = await refreshSnapshot(cfg, env, bucket);
        item.scan = { ok: true, usedBytes: record.usedBytes, objects: record.objects, backend: record.backend };
        console.log('[cf-b2-worker] 定时统计完成',
          bucket, record.usedBytes + 'B', record.objects + ' objects', 'via', record.backend);
      } catch (error) {
        item.scan = { ok: false, error: String((error && error.message) || error) };
        console.error('[cf-b2-worker] 定时统计失败', bucket, error && error.message);
      }
    }

    // 定时任务自己发起的 B2 请求（如本次扫描的 Class C）先记账，再被下面的归零清掉
    if (Object.keys(cfg.usage.counts).length) {
      await flushCounters(cfg, env, bucket).catch((error) => {
        console.error('[cf-b2-worker] 定时任务的用量计数写入失败', error && error.message);
      });
    }

    if (doReset) {
      try {
        const out = await resetCounters(cfg, env, bucket);
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
        region: cfg.region,
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

  switch (action) {
    /* ---- B2 用量（空间 + 事务计数） ---- */
    case 'usage': {
      const refresh = url.searchParams.get('refresh') === '1';
      const state = cfg.enableUsage
        ? await usageState(cfg, env, targetBucket, refresh)
        : {
          backend: 'off',
          counters: { A: 0, B: 0, C: 0, D: 0, at: '' },
          storage: { ok: false, error: '用量面板已关闭（ENABLE_USAGE_PANEL=false）' },
          throttled: false,
          windowed: false,
          minInterval: cfg.usageMinInterval,
        };

      // 本请求刚发生的 B2 调用（例如本次扫描本身）也一并计入展示
      const live = (cfg.usage && cfg.usage.counts) || {};
      const used = {
        A: (state.counters.A || 0) + (live.A || 0),
        B: (state.counters.B || 0) + (live.B || 0),
        C: (state.counters.C || 0) + (live.C || 0),
        D: (state.counters.D || 0) + (live.D || 0),
      };
      const remaining = (total, quota) => Math.max(0, quota - total);

      return json({
        ok: true,
        bucket: targetBucket,
        quotaBytes: cfg.storageQuotaBytes,
        storage: state.storage,
        counterBackend: state.backend,
        counterBackendLabel: state.backend === 'do'
          ? 'Durable Object（全局一致、原子）'
          : (state.backend === 'cache' ? 'Cache API（按数据中心独立，近似）' : '已关闭'),
        windowed: state.windowed,
        windowHour: cfg.usageRefreshHour,
        minInterval: state.minInterval,
        autoScan: cfg.usageAutoScan,
        scheduledBuckets: scheduledBuckets(cfg),
        classA: used.A,
        classB: { used: used.B, quota: cfg.classBQuota, remaining: remaining(used.B, cfg.classBQuota) },
        classC: { used: used.C, quota: cfg.classCQuota, remaining: remaining(used.C, cfg.classCQuota) },
        classD: used.D,
        scanSchedule: hourListLabel(cfg.usageScanHours),
        resetSchedule: hourListLabel(cfg.usageResetHours),
        counterResetAt: state.resetAt || state.counters.resetAt || '',
        counterUpdatedAt: state.counters.at || '',
        scope: '仅统计本 Worker 发往 B2 的请求；控制台、rclone 等其他客户端不计入',
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
          const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, targetBucket, key), {
            query: { partNumber: String(partNumber), uploadId },
            headers: { 'content-type': 'application/octet-stream' },
            body,
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
function renderDirectory(data, prefix, opts = {}) {
  const base = opts.base || '/';
  const baseLabel = opts.label || '';
  const showManage = opts.showManage !== false;
  const hideKeep = opts.hideKeep !== false;
  const publicPrefix = opts.publicPrefix || '';

  const rows = [];
  // 目录占位对象（<prefix>/.keep）不参与展示与计数
  const files = hideKeep ? data.files.filter((f) => f.name !== '.keep') : data.files;

  /* 路径导航：每一级都可点击（匿名从公开根开始，不显示公开前缀本身；管理员从桶根开始） */
  const segs = prefix.replace(/\/+$/, '').split('/').filter(Boolean);
  const fromPublicRoot = !showManage && publicPrefix && segs[0] === publicPrefix;
  const visibleSegs = fromPublicRoot ? segs.slice(1) : segs;
  const rootHref = fromPublicRoot ? base + escapeHtml(publicPrefix) + '/' : base;
  const crumbs = ['<a href="' + rootHref + '">' + escapeHtml(baseLabel) + '</a>'];
  let acc = fromPublicRoot ? publicPrefix + '/' : '';
  visibleSegs.forEach((seg, i) => {
    acc += seg + '/';
    crumbs.push(i === visibleSegs.length - 1
      ? '<span class="cur">' + escapeHtml(seg) + '</span>'
      : '<a href="' + base + escapeHtml(acc) + '">' + escapeHtml(seg) + '</a>');
  });
  const crumbsHtml = '<nav class="crumb">' + crumbs.join('<span class="sep">/</span>') + '</nav>';

  if (prefix) {
    // 注意 prefix 形如 "share/images/"，先去尾斜杠再取父级，否则会算成自己
    const parent = prefix.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
    // 匿名在公开根（如 /share/）已无处可回，管理员仍可回到根
    if (parent !== '' || showManage) {
      rows.push('<tr><td colspan="4"><a href="' + base
        + escapeHtml(parent ? parent + '/' : '') + '">返回上一级</a></td></tr>');
    }
  }

  for (const folder of data.folders) {
    const name = folder.slice(prefix.length).replace(/\/$/, '');
    rows.push('<tr class="dir"><td>[DIR] <a href="' + base + escapeHtml(folder) + '">' + escapeHtml(name) + '/</a></td>'
      + '<td>-</td><td>-</td>'
      + '<td><a href="' + base + escapeHtml(folder) + '?format=json">JSON</a></td></tr>');
  }

  for (const file of files) {
    const href = base + escapeHtml(prefix + file.name);
    rows.push('<tr><td>[FILE] <a href="' + href + '">' + escapeHtml(file.name) + '</a></td>'
      + '<td>' + humanSize(file.size) + '</td>'
      + '<td>' + escapeHtml(file.lastModified) + '</td>'
      + '<td><a href="' + href + '">下载</a></td></tr>');
  }

  const initCount = data.folders.length + files.length;
  const cfgJson = JSON.stringify({
    prefix, base, next: data.truncated ? (data.nextToken || '') : '', loaded: initCount,
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
    '    if (name.charAt(name.length - 1) === "/") name = name.slice(0, -1);',
    '    out += \'<tr class="dir"><td>[DIR] <a href="\' + C.base + esc(p) + \'">\' + esc(name) + \'/</a></td>\'',
    '      + \'<td>-</td><td>-</td>\'',
    '      + \'<td><a href="\' + C.base + esc(p) + \'?format=json">JSON</a></td></tr>\';',
    '  });',
    '  (d.files || []).filter(function (f) { return !(C.hideKeep && f.name === ".keep"); })',
    '    .forEach(function (f) {',
    '    var href = C.base + esc(C.prefix + f.name);',
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
    'function more() {',
    '  if (LOADING || !NEXT) return;',
    '  LOADING = true; paint();',
    '  fetch(location.pathname + "?format=json&cursor=" + encodeURIComponent(NEXT), { credentials: "same-origin" })',
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
    'paint();',
    '})();',
  ].join('\n');

  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + escapeHtml(prefix || '/') + ' - B2 Index</title>',
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

  // 对象访问根路径（$path 模式会带桶名段），下载一律走这里，不再用预签名直链
  const basePath = apiBase.slice(0, apiBase.lastIndexOf(API_PREFIX)) + '/';

  const configJson = JSON.stringify({
    apiBase,
    basePath,
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
    'main{max-width:1180px;margin:0 auto;padding:20px}',
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
    '.usage{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin-bottom:14px;font-size:13px}',
    '.usage .row{display:flex;flex-wrap:wrap;gap:18px;align-items:baseline}',
    '.usage .kv{display:flex;gap:6px;align-items:baseline}',
    '.usage .v{font-weight:600;font-size:15px}',
    '.usage .bar{height:6px;border-radius:4px;background:var(--chip);overflow:hidden;margin-top:8px;max-width:420px}',
    '.usage .bar>i{display:block;height:100%;background:var(--acc)}',
    '.usage .over{color:#c2410c}',
    '.usage .foot{margin-top:8px;color:var(--dim);font-size:12px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}',
    '</style></head><body>',
    '<header>',
    '<h1>Backblaze B2 文件管理器</h1>',
    '<span class="muted" id="bucketLabel"></span>',
    '<span class="grow"></span>',
    '<input id="fUser" placeholder="用户名" size="10">',
    '<input id="fPass" type="password" placeholder="密码 / 令牌" size="16">',
    '<button class="ghost" id="btnLogin">鉴权</button>',
    '<button class="ghost" id="btnLogout">退出</button>',
    '<button class="ghost" id="btnRefresh">刷新</button>',
    '<button class="ghost" id="btnMkdir">新建目录</button>',
    '<select id="upMode">',
    '<option value="direct">直传（推荐）</option>',
    '<option value="worker">Worker 代理</option>',
    '</select>',
    '<label class="set" title="分片大小（MiB）。直传单次 PUT 上限为 5–95，Worker 代理受 MAX_UPLOAD_BYTES 约束；B2 硬上限 100MiB。">分片',
    '<input id="partSize" type="number" min="5" max="95" step="1" value="' + defaultPartMiB + '">MiB</label>',
    '<label class="set" title="分片并发上传数，1–10。越大越快，但更吃带宽/上游限流。">并发',
    '<input id="conc" type="number" min="1" max="10" step="1" value="' + defaultConc + '"></label>',
    '<button class="ghost" id="btnTheme">深色模式</button>',
    '<button id="btnUpload">上传</button>',
    '<input type="file" id="file" multiple class="hidden">',
    '</header>',
    '<main>',
    '<div id="usage" class="usage"></div>',
    '<nav class="crumb" id="crumb" style="margin-bottom:12px"></nav>',
    '<div class="muted" id="tuneHint" style="margin-bottom:10px;font-size:12px"></div>',
    '<table><thead><tr><th>名称</th><th style="width:110px">大小</th>',
    '<th style="width:180px">修改时间</th><th style="width:300px;text-align:right">操作</th></tr></thead>',
    '<tbody id="tb"></tbody></table>',
    '<div id="status" class="muted"></div>',
    '</main>',
    '<div id="toast"></div>',
    '<script id="cfg" type="application/json">' + configJson + '</script>',
    '<script>' + themeToggleScript() + '</script>',
    '<script>',
    '(function () {',
    'var CFG = JSON.parse(document.getElementById("cfg").textContent);',
    'var API = CFG.apiBase;',
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
    'function buildRows(data, withUp) {',
    '  var rows = "";',
    '  if (withUp && PREFIX) rows += \'<tr class="dir"><td><a data-act="up">.. 返回上级</a></td><td></td><td></td><td></td></tr>\';',
    '  (data.folders || []).forEach(function (p) {',
    '    var name = p.slice(PREFIX.length);',
    '    if (name.charAt(name.length - 1) === "/") name = name.slice(0, -1);',
    '    rows += "<tr class=\\"dir\\"><td>[DIR] <a data-act=\\"dir\\" data-p=\\"" + esc(p) + "\\">" + esc(name) + "</a></td>"',
    '      + "<td class=\\"muted\\">目录</td><td></td>"',
    '      + "<td style=\\"text-align:right\\"><button class=\\"mini\\" data-act=\\"deldir\\" data-k=\\"" + esc(p + ".keep") + "\\">删除</button></td></tr>";',
    '  });',
    '  (data.files || []).filter(function (f) { return f.name !== ".keep"; }).forEach(function (f) {',
    '    var k = esc(PREFIX + f.name);',
    '    rows += "<tr><td>" + esc(f.name) + "</td><td>" + size(f.size) + "</td>"',
    '      + "<td class=\\"muted\\">" + esc(f.lastModified) + "</td>"',
    '      + \'<td style="text-align:right">\'',
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
    '  if (el("tuneHint")) {',
    '    el("tuneHint").textContent = "分片 " + p + " MiB × 并发 " + c',
    '      + "（当前通道上限 " + cap + " MiB）";',
    '  }',
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
    '    xhr.open("PUT", url, true);',
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
    '/* 绝对地址（跟随当前访问域名，而不是写死某个域名） */',
    'function objUrl(key) { return location.origin + CFG.basePath + key.split("/").map(encodeURIComponent).join("/"); }',
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
    '  fetch(API + "logout", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } })',
    '    .catch(function () {})',
    '    .then(function () {',
    '      return fetch(API + "health", {',
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
    '    + "<span class=\\"muted\\">/ " + (quota || "-") + (quota ? "（剩 " + Math.max(0, quota - used) + "）" : "") + "</span></span>";',
    '}',
    'function renderUsage(d) {',
    '  var s = (d && d.storage) || {};',
    '  var quota = d.quotaBytes || 0;',
    '  var html = "";',
    '  if (s.ok === false) {',
    '    html += "<div class=\\"row\\"><span>空间统计失败：" + esc(s.error || "未知错误") + "</span></div>";',
    '  } else {',
    '    var used = s.usedBytes || 0;',
    '    html += "<div class=\\"row\\">"',
    '      + "<span><span class=\\"muted\\">桶</span> <span class=\\"v\\">" + esc(d.bucket || "") + "</span></span>"',
    '      + "<span><span class=\\"muted\\">已用空间</span> <span class=\\"v\\">" + sizeD(used) + "</span>"',
    '      + (quota ? " <span class=\\"muted\\">/ " + sizeD(quota) + "（" + pct(used, quota) + "）</span>" : "") + "</span>"',
    '      + "<span><span class=\\"muted\\">对象数</span> <span class=\\"v\\">" + (s.objects || 0) + "</span>"',
    '      + (s.complete === false ? " <span class=\\"over\\">（扫描到上限，实际更多）</span>" : "") + "</span>"',
    '      + "</div>";',
    '    if (quota) html += \'<div class="bar"><i style="width:\' + Math.min(100, used / quota * 100) + \'%"></i></div>\';',
    '  }',
    '  html += "<div class=\\"row\\" style=\\"margin-top:10px\\">"',
    '    + quotaCell("Class B（读取）", (d.classB || {}).used || 0, (d.classB || {}).quota || 0)',
    '    + quotaCell("Class C（列举）", (d.classC || {}).used || 0, (d.classC || {}).quota || 0)',
    '    + "<span class=\\"kv\\"><span class=\\"muted\\">Class A</span><span class=\\"v\\">" + (d.classA || 0) + "</span></span>"',
    '    + "</div>";',
    '  var foot = [];',
    '  if (s.at) foot.push("空间更新于 " + esc(s.at.replace("T", " ").slice(0, 16)) + " UTC" + (s.cached ? "（缓存）" : ""));',
    '  if (s.throttled) foot.push("刷新过于频繁，已用缓存（最小间隔 " + (d.minInterval || 0) + " 秒）");',
    '  if (s.ok !== false && s.pages) foot.push("本次扫描 " + s.pages + " 次 Class C");',
    '  foot.push("计数重置：" + esc(d.resetSchedule || "-") + "（由 Cron scheduled 触发）"',
    '    + (d.counterResetAt ? "，上次 " + esc(String(d.counterResetAt).replace("T", " ").slice(0, 16)) + " UTC" : ""));',
    '  if (d.counterBackendLabel) foot.push("计数后端：" + esc(d.counterBackendLabel));',
    '  if (d.autoScan === false) foot.push("空间快照由 Cron 定时刷新（不会自动重扫）");',
    '  if (d.windowed) foot.push("本次是 UTC " + d.windowHour + ":00 窗口内的当日终值扫描");',
    '  if (d.scope) foot.push(esc(d.scope));',
    '  html += \'<div class="foot">\' + foot.map(function (t) { return "<span>" + t + "</span>"; }).join("")',
    '    + \'<button class="mini" id="btnUsageRefresh">重新统计</button></div>\';',
    '  el("usage").innerHTML = html;',
    '}',
    'function loadUsage(refresh) {',
    '  if (!el("usage")) return;',
    '  el("usage").innerHTML = \'<span class="muted">正在读取用量…</span>\';',
    '  call("usage" + q(refresh ? { refresh: "1" } : {})).then(function (r) {',
    '    if (!r.ok || !r.data || r.data.ok === false) {',
    '      el("usage").innerHTML = \'<span class="muted">用量面板不可用：\' + esc((r.data && r.data.error) || r.status) + "</span>";',
    '      return;',
    '    }',
    '    renderUsage(r.data);',
    '  }).catch(function (e) {',
    '    el("usage").innerHTML = \'<span class="muted">用量面板不可用：\' + esc(e.message) + "</span>";',
    '  });',
    '}',
    'el("usage").addEventListener("click", function (e) {',
    '  if (e.target && e.target.id === "btnUsageRefresh") loadUsage(true);',
    '});',
    'loadUsage(false);',
    'el("bucketLabel").textContent = CFG.bucketMode === "fixed"',
    '  ? ("桶: " + CFG.bucketFixed)',
    '  : (CFG.bucketMode === "path" ? "桶: 按 URL 首段动态解析" : "桶: 按主机名首段动态解析");',
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
async function handle(request, env, ctx) {
  const cfg = loadConfig(env);
  if (cfg.enableUsage) cfg.usage = { counts: {} };

  try {
    return await dispatch(request, env, ctx, cfg);
  } finally {
    if (cfg.usage && Object.keys(cfg.usage.counts).length) {
      const url = new URL(request.url);
      const resolved = resolveBucketKey(cfg, url);
      const bucket = resolved.bucket || cfg.bucketFixed || '';
      const pending = flushCounters(cfg, env, bucket).catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(pending);
    }
  }
}

async function dispatch(request, env, ctx, cfg) {
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
        const prefix = dirPrefix(
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
        // 匿名视图不显示桶名，也不给出管理器入口
        const label = (auth.ok || !cfg.hideDetails) ? bucket : '公开目录';
        return html(renderDirectory(result, prefix, {
          base,
          label,
          showManage: auth.ok,
          hideKeep: cfg.hideKeep,
          publicPrefix: cfg.publicPrefix,
        }));
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

      return readObject(request, env, ctx, cfg, bucket, applyRclone(cfg, resolved.key), { anonymous });
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
  shouldWindowScan, utcDayStamp, computeStorage, usageState,
};
