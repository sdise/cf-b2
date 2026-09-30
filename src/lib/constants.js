/* 由 src/b2-worker.js 拆分而来：原 L34-L56 */

export const SERVICE = 's3';
export const ALGORITHM = 'AWS4-HMAC-SHA256';
export const RANGE_RETRY_ATTEMPTS = 3;
export const DEFAULT_ENDPOINT = 'https://s3.us-west-001.backblazeb2.com';

export const API_PREFIX = '/__api/';
export const MANAGE_PATH = '/__manage';
/** 由「当前路径 + __manage」拼出登录/管理器入口：匿名入口是 /share/，故默认是 /share/__manage */

/** 这些头来自客户端或 Cloudflare 平台，参与签名会导致 SignatureDoesNotMatch */
export const UNSIGNABLE_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'expect', 'from', 'keep-alive',
  'max-forwards', 'proxy-authorization', 'referer', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'user-agent', 'accept-encoding', 'accept-charset', 'content-md5',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-request-id', 'cdn-loop',
]);

/** 下载时允许透传给 B2 的客户端头 */
export const FORWARD_READ_HEADERS = [
  'range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since',
  'accept', 'accept-language',
];

