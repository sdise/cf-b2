/* 会话 Cookie：让「导航类请求」也能带管理员身份 */

/**
 * 为什么需要它？
 *   Basic / Bearer 都只能挂在 **请求头** 上，而 `<a href>`、`window.open()` 这类
 *   普通导航由浏览器发起，JS 无法附加 Authorization 头。于是管理页里点「下载」时，
 *   Worker 会把管理员当成匿名用户，把非公开前缀的对象 308 重定向到 /share/。
 *
 * 做法：
 *   登录接口校验凭据后下发一枚 **HMAC 签名** 的 Cookie（HttpOnly），
 *   之后的导航请求浏览器自动携带，鉴权、下载、Range 全部照常走原生链路。
 *
 * 安全性：
 *   - 值形如 `<过期时间戳>.<HMAC>`，密钥由管理员凭据派生 ⇒ 无法伪造；
 *     且一旦 ADMIN_TOKEN / ADMIN_USER / ADMIN_PASS 变更，旧会话全部自动失效。
 *   - HttpOnly（JS 读不到）、SameSite=Lax（跨站 POST/PUT/DELETE 不带 ⇒ 天然防 CSRF）、
 *     HTTPS 下加 Secure。
 */

import { encoder, hmac, safeEqual, toHex } from './crypto.js';

export const SESSION_COOKIE = 'cfb2_session';

/** 会话有效期：7 天 */
export const SESSION_TTL = 7 * 24 * 60 * 60;

/** 派生会话密钥：任一管理员凭据变化都会让已签发的会话失效 */
function sessionSecret(cfg) {
  return [cfg.adminToken, cfg.adminUser, cfg.adminPass].filter(Boolean).join('\u0000');
}

/** 是否具备签发会话的条件（即配置了管理员凭据） */
export function sessionAvailable(cfg) {
  return Boolean(sessionSecret(cfg));
}

async function sign(cfg, exp) {
  const key = encoder.encode(sessionSecret(cfg));
  return toHex(await hmac(key, 'cfb2-session\n' + exp));
}

/** 签发会话值（未配置凭据时返回空串，调用方据此跳过 Set-Cookie） */
export async function issueSession(cfg, ttl = SESSION_TTL) {
  if (!sessionAvailable(cfg)) return '';
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, ttl);
  return exp + '.' + await sign(cfg, exp);
}

/** 校验会话值：过期 / 格式错 / 签名不符 一律拒绝 */
export async function verifySession(cfg, value) {
  if (!sessionAvailable(cfg) || !value) return false;
  const dot = String(value).indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(String(value).slice(0, dot));
  if (!Number.isInteger(exp) || exp * 1000 < Date.now()) return false;
  return safeEqual(String(value).slice(dot + 1), await sign(cfg, exp));
}

/** 从 Cookie 头里取指定名字的值 */
export function readCookie(header, name) {
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  }
  return '';
}

/** 生成 Set-Cookie 头；value 为空串表示「清除」 */
export function sessionCookie(cfg, value, secure = true, maxAge = SESSION_TTL) {
  const bits = [
    SESSION_COOKIE + '=' + encodeURIComponent(value || ''),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + (value ? maxAge : 0),
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
