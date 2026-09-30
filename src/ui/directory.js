/* 由 src/b2-worker.js 拆分而来：原 L2158-L2402 */

import { API_PREFIX, MANAGE_PATH } from '../lib/constants.js';
import { escapeHtml, humanSize, inlineJson, themeCss, themeToggleScript } from './theme.js';

export function renderDirectory(data, prefix, opts = {}) {
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
export function welcomePage(cfg, bucketLabel, prefix, publicPath) {
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

