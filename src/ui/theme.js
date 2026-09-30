/* 由 src/b2-worker.js 拆分而来：原 L2088-L2157 */

export function escapeHtml(str) {
  return String(str).split('&').join('&amp;').split('<').join('&lt;')
    .split('>').join('&gt;').split('"').join('&quot;');
}

/** 内联进 <script> 的 JSON：转义 < > & 与行分隔符，防止 </script> 提前闭合标签造成注入 */
export function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* ---------- 主题：暖色（默认） / 深色 ---------- */

export const THEMES = {
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
export function themeCss() {
  const decl = (name) => Object.entries(THEMES[name])
    .map(([key, value]) => '--' + key + ':' + value + ';').join('');
  return ':root{' + decl('warm') + '}[data-theme="dark"]{' + decl('dark') + '}';
}

/** 主题切换按钮脚本（localStorage 记忆，默认暖色） */
export function themeToggleScript() {
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

export function humanSize(bytes) {
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
