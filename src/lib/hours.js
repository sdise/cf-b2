/* 由 src/b2-worker.js 拆分而来：原 L1065-L1092 */

/**
 * 解析 scheduled() 里的小时列表：
 *   "23"    → 只在 UTC 23 点执行
 *   "23,11" → 11 点与 23 点都执行
 *   "*"     → 每次触发都执行
 *   "-" 或空 → 从不执行
 */
export function parseHourList(value, fallback) {
  const raw = String(value === undefined || value === '' ? fallback : value).trim();
  if (raw === '*') return { mode: 'always' };
  if (raw === '-') return { mode: 'never' };
  const hours = raw.split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
  return hours.length ? { mode: 'hours', hours } : { mode: 'never' };
}

export function hourMatches(spec, hour) {
  if (!spec || spec.mode === 'never') return false;
  if (spec.mode === 'always') return true;
  return spec.hours.includes(hour);
}

export function hourListLabel(spec) {
  if (!spec || spec.mode === 'never') return '从不';
  if (spec.mode === 'always') return '每次触发';
  return spec.hours.slice().sort((a, b) => a - b).map((h) => h + ':00').join('、') + ' UTC';
}
