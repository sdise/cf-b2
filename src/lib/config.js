/* 由 src/b2-worker.js 拆分而来：原 L335-L563 */

import { SERVICE } from './constants.js';
import { normalizePrefix } from './prefix.js';
import { parseHourList } from './hours.js';
import { readBool, readInt } from './crypto.js';

export const bucketVarsCache = new WeakMap();

export function loadConfig(env) {
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
export const RESERVED_MOUNTS = new Set(['share', '__api', '__manage']);

/** 解析 BUCKET_1..N 环境变量（JSON：BUCKET_NAME / KEY_ID / APPLICATION_KEY / ENDPOINT）。
 *  单个变量有问题只跳过该桶并记录，不影响其它桶。 */
export function parseBucketVars(env) {
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
export const endpointInfoCache = new Map();

export function endpointInfo(rawEndpoint) {
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
export function applyBucket(cfg, name) {
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
export function bucketView(cfg, m) {
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
export function resolveMount(cfg, pathname) {
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
export function smartPublicRedirect(mount) {
  if (mount && mount.kind === 'bucket' && !mount.alias && mount.m) {
    const rest = mount.inner.replace(/^\/+/, '');
    if (rest === 'share' || rest.startsWith('share/')) {
      const tail = rest === 'share' ? '' : rest.slice('share/'.length);
      return '/share/' + mount.m.name + (tail ? '/' + tail : '/');
    }
  }
  return '/share/';
}

