/* 由 src/b2-worker.js 拆分而来：原 L3214-L3482 */

import { API_PREFIX, MANAGE_PATH } from './lib/constants.js';
import { USAGE_CACHE_ORIGIN, cacheGetJson, cachePutJson, flushCounters } from './lib/usage.js';
import { apiRouter, resolveApiBucket } from './api.js';
import { applyBucket, bucketView, loadConfig, resolveMount, smartPublicRedirect } from './lib/config.js';
import { applyRclone, b2Fetch, deleteObject, listObjects, objectUrl, purgeObjectCache, putObject, readObject } from './lib/b2.js';
import { challenge, corsHeaders, deny, html, json } from './lib/http.js';
import { checkAuth } from './lib/auth.js';
import { dirPrefix, normalizeKey, readInt, sha256Hex } from './lib/crypto.js';
import { escapeHtml, themeCss, themeToggleScript } from './ui/theme.js';
import { managePage } from './ui/manage.js';
import { renderDirectory } from './ui/directory.js';
import { withinPrefix } from './lib/prefix.js';

export async function handle(request, env, ctx) {
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
export function mountListPage(cfg, { publicRoot, isAdmin }) {
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
  // 匿名入口 = 当前页面路径 + __manage（公开聚合根 /share/ → /share/__manage）
  const entryBase = publicRoot ? '/' + String(cfg.publicPrefix || '').replace(/^\/+|\/+$/g, '') + '/' : '/';
  const adminBar = isAdmin
    ? '<div class="sub"><a class="acc" href="' + MANAGE_PATH + '">文件管理器</a> · 共 ' + cfg.buckets.length + ' 个桶'
      + (publicRoot ? '' : ' · 匿名用户只能访问 <a class="acc" href="/share/">/share/</a>') + '</div>'
    : '<div class="sub"><a class="btn" href="' + escapeHtml(entryBase + MANAGE_PATH.slice(1)) + '">登录</a></div>';

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
    '.btn{display:inline-block;padding:7px 16px;background:var(--acc);color:var(--btn);border-radius:8px;text-decoration:none;font-size:14px}',
    '.btn:hover{text-decoration:none;opacity:.9}',
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
export let bootstrappedMounts = '';   // 本隔离实例已做过的引导（Cache 标记负责跨实例去重）

export async function bootstrapPublicDirs(cfg, env) {
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

export async function dispatch(request, env, ctx, cfg) {
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

  /* ---- 文件管理器页面（/<bucket>/__manage；匿名保留 401 挑战以便浏览器弹出登录框） ---- */
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
          // 匿名视图的「登录」= 当前路径 + __manage（走浏览器原生 Basic 弹窗，不泄露任何数据）
          loginHref: base + MANAGE_PATH.slice(1),
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

