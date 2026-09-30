/* 由 src/b2-worker.js 拆分而来：原 L1740-L2087 */

import { API_PREFIX } from './lib/constants.js';
import { applyBucket, bucketView, endpointInfo } from './lib/config.js';
import { b2Fetch, copyObject, deleteObject, extractError, listObjects, multipartAbort, multipartComplete, multipartCreate, objectUrl, purgeObjectCache, putObject, readObject } from './lib/b2.js';
import { b2GetBucketCors, b2UpdateBucketCors, corsRuleFor, readJsonBody } from './lib/b2-native.js';
import { checkAuth, signerOf, verifyLogin } from './lib/auth.js';
import { issueSession, sessionCookie } from './lib/session.js';
import { corsHeaders, deny, json } from './lib/http.js';
import { dirPrefix, normalizeKey, readInt } from './lib/crypto.js';
import { flushCounters, usageState } from './lib/usage.js';
import { hourListLabel } from './lib/hours.js';

export function resolveApiBucket(cfg, basePath, url) {
  const segs = basePath.split('/').filter(Boolean);
  let name = '';
  if (segs[0] && segs[0].toLowerCase() === 'share' && segs.length >= 2) name = segs[1];
  else if (segs.length) name = segs[0];
  if (!name) name = url.searchParams.get('bucket') || '';
  name = String(name).trim().toLowerCase();
  if (!name && cfg.buckets.length) name = cfg.buckets[0].name;   // 缺省 = 第一个挂载桶
  return cfg.buckets.some((b) => b.name === name) ? name : '';
}

export async function apiRouter(request, env, ctx, cfg, url) {
  const apiIndex = url.pathname.indexOf(API_PREFIX);
  const basePath = url.pathname.slice(0, apiIndex);
  const route = url.pathname.slice(apiIndex + API_PREFIX.length).replace(/^\/+/, '');
  const parts = route.split('/');
  const action = parts[0] || '';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, cfg) });
  }

  // 退出登录：清掉会话 Cookie，并返回 401 诱导浏览器丢弃缓存的 Basic 凭据
  if (action === 'logout') {
    return new Response(
      JSON.stringify({ ok: true, message: '本地凭据已清除；浏览器缓存的 Basic 凭据可能需要关闭标签页或浏览器' }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'WWW-Authenticate': 'Basic realm="B2 Manager", charset="UTF-8"',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookie(cfg, '', url.protocol === 'https:'),
          ...corsHeaders(request, cfg),
        },
      },
    );
  }

  /* 登录：校验凭据后下发会话 Cookie。
     Basic / Bearer 只能挂在请求头上，而「下载」是普通导航（<a href> / window.open），
     JS 加不上头 —— 于是管理员点下载会被当成匿名、被 308 重定向到 /share/。
     用 Cookie 让导航类请求也带得上管理员身份。 */
  if (action === 'login') {
    if (request.method !== 'POST') return deny('登录请用 POST', request, cfg, 405);
    const body = await readJsonBody(request);
    const auth = await verifyLogin(cfg, {
      token: String(body.token || ''),
      user: String(body.user || ''),
      pass: String(body.pass || ''),
    });
    if (!auth.ok) return deny(auth.reason, request, cfg, 401);
    const value = await issueSession(cfg);
    const res = json({ ok: true, mode: auth.mode }, 200, request, cfg);
    if (value) res.headers.set('Set-Cookie', sessionCookie(cfg, value, url.protocol === 'https:'));
    return res;
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

