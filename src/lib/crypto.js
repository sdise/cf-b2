/* 由 src/b2-worker.js 拆分而来：原 L57-L165 */

export const encoder = new TextEncoder();

export function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

export async function sha256Hex(data) {
  let payload;
  if (typeof data === 'string') payload = encoder.encode(data);
  else if (data instanceof Uint8Array) payload = data;
  else if (data instanceof ArrayBuffer) payload = new Uint8Array(data);
  else payload = new Uint8Array(0);
  return toHex(await crypto.subtle.digest('SHA-256', payload));
}

export async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** 恒定时间比较，降低时序侧信道风险 */
export async function safeEqual(a, b) {
  const ha = await sha256Hex(String(a === undefined || a === null ? '' : a));
  const hb = await sha256Hex(String(b === undefined || b === null ? '' : b));
  if (ha.length !== hb.length) return false;
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

/** RFC3986 百分号编码（AWS 要求空格必须是 %20，!'()* 必须转义） */
export function uriEncode(str, encodeSlash = true) {
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

export function safeDecode(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/** pathname 已是百分号编码，还原为 AWS 规范形态，保证与签名计算完全一致 */
export function canonicalPath(pathname) {
  const encoded = pathname.split('/').map((seg) => uriEncode(safeDecode(seg), false)).join('/');
  return encoded.startsWith('/') ? encoded : '/' + encoded;
}

export function nowAmz(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

export function readBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

export function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 归一化对象 key，同时阻断 ../ 路径穿越 */
export function normalizeKey(key) {
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
export function dirPrefix(value) {
  const normalized = normalizeKey(value);
  return normalized ? normalized + '/' : '';
}

/* ============================ 2. AWS Signature V4 ============================ */

