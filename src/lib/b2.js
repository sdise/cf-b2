/* 由 src/b2-worker.js 拆分而来：原 L675-L1057 */

import { FORWARD_READ_HEADERS, RANGE_RETRY_ATTEMPTS } from './constants.js';
import { corsHeaders, json, sanitizeUpstreamError, sanitizeUpstreamHeaders } from './http.js';
import { normalizeKey, readInt, safeDecode, uriEncode } from './crypto.js';
import { signerOf } from './auth.js';

export function objectUrl(cfg, bucket, key) {
  const encodedKey = normalizeKey(key).split('/').map((seg) => uriEncode(seg, false)).join('/');
  if (cfg.urlStyle === 'virtual' && !bucket.includes('.')) {
    return 'https://' + bucket + '.' + cfg.endpointHost + '/' + encodedKey;
  }
  return cfg.endpointOrigin + '/' + bucket + '/' + encodedKey;
}

/** 桶根 URL */
export function bucketUrl(cfg, bucket) {
  if (cfg.urlStyle === 'virtual' && !bucket.includes('.')) {
    return 'https://' + bucket + '.' + cfg.endpointHost + '/';
  }
  return cfg.endpointOrigin + '/' + bucket + '/';
}

/** 依据请求解析 { bucket, key, isDir }：以 / 结尾视为目录列举（多桶模式由 resolveMount 完成） */
export function resolveBucketKey(cfg, url) {
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
export function classifyB2(method, url) {
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
export function recordUsage(cfg, cls) {
  if (!cfg || !cfg.usage || !cls) return;
  cfg.usage.counts[cls] = (cfg.usage.counts[cls] || 0) + 1;
}

export async function b2Fetch(cfg, method, url, options = {}) {
  const { headers = {}, body = null, query = {}, unsignedPayload = false } = options;
  const request = await signerOf(cfg).sign(method, url, { headers, body, query, unsignedPayload });
  recordUsage(cfg, classifyB2(method, new URL(request.url || url)));
  return fetch(request);
}

/** 兼容 rclone --b2-download-url 的 file/{bucket}/ 前缀 */
export function applyRclone(cfg, key) {
  if (!cfg.rcloneDownload) return key;
  const idx = key.indexOf('/');
  if (idx === -1) return key;
  return key.slice(idx + 1);
}

/** 下载代理：Range / 条件请求 / 304 / 缓存 / CF 丢失 content-range 的补偿重试 */
export async function readObject(request, env, ctx, cfg, bucket, key, options = {}) {
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
export async function putObject(request, cfg, bucket, key) {
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
export async function copyObject(cfg, bucket, fromKey, toKey) {
  const headers = {
    'x-amz-copy-source': '/' + bucket + '/' + normalizeKey(fromKey).split('/').map((s) => uriEncode(s, false)).join('/'),
  };
  if (cfg.uploadCacheControl) headers['cache-control'] = cfg.uploadCacheControl;

  const response = await b2Fetch(cfg, 'PUT', objectUrl(cfg, bucket, toKey), { headers, body: '' });
  const text = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: extractError(text) };
  return { ok: true, etag: (response.headers.get('etag') || '').replace(/"/g, '') };
}

export async function deleteObject(cfg, bucket, key) {
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
export function purgeObjectCache(ctx, cfg, bucket, key, origin) {
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

export function xmlText(xml, tag) {
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

export function extractError(text) {
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

export async function listObjects(cfg, bucket, options = {}) {
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

export async function multipartCreate(cfg, bucket, key, contentType) {
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

export async function multipartListParts(cfg, bucket, key, uploadId) {
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

export async function multipartComplete(cfg, bucket, key, uploadId) {
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

export async function multipartAbort(cfg, bucket, key, uploadId) {
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

