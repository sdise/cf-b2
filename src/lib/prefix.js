/* 由 src/b2-worker.js 拆分而来：原 L278-L296 */

export function normalizePrefix(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** key/prefix 是否位于指定前缀内（share 与 share/a.txt 均算命中） */
export function withinPrefix(key, prefix) {
  if (!prefix) return true;
  const target = String(key || '');
  return target === prefix || target.startsWith(prefix + '/');
}

/** 拼出带尾斜杠的前缀，用于生成链接 */
export function prefixWithSlash(prefix) {
  return prefix ? prefix + '/' : '';
}

/** 公开目录的基础路径（$path 模式下需要带上桶名段） */
/** 会暴露后端实现/对象内部信息的响应头，统一剥离 */
