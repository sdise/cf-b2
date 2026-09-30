/* 由 src/b2-worker.js 拆分而来：原 L622-L674 */

import { SigV4 } from './sigv4.js';
import { safeEqual } from './crypto.js';
import { SESSION_COOKIE, readCookie, verifySession } from './session.js';

/**
 * 登录页/登录接口使用的凭据校验：直接收「令牌」或「用户名 + 密码」，
 * 不必先拼一个 Authorization 头。
 */
export async function verifyLogin(cfg, { token = '', user = '', pass = '' } = {}) {
  const basicReady = Boolean(cfg.adminUser && cfg.adminPass);
  if (!cfg.adminToken && !basicReady) {
    return { ok: false, reason: '未配置 ADMIN_TOKEN 或完整的 ADMIN_USER/ADMIN_PASS（两者都需设置）' };
  }
  if (token) {
    if (cfg.adminToken && await safeEqual(token, cfg.adminToken)) return { ok: true, mode: 'token' };
    return { ok: false, reason: '令牌无效' };
  }
  if (!basicReady) return { ok: false, reason: '本部署只配置了 ADMIN_TOKEN，请改用令牌登录' };
  if (await safeEqual(user, cfg.adminUser) && await safeEqual(pass, cfg.adminPass)) {
    return { ok: true, mode: 'basic' };
  }
  return { ok: false, reason: '用户名或密码错误' };
}

export async function checkAuth(request, cfg) {
  if (cfg.publicWrite) return { ok: true, mode: 'public' };
  // Basic 模式要求用户名与密码同时配置：只配其一（例如漏配 ADMIN_USER）会退化成「空用户名 + 密码」，
  // 因此这里按「成对存在」判断，避免弱配置被绕过。
  const basicReady = Boolean(cfg.adminUser && cfg.adminPass);
  if (!cfg.adminToken && !basicReady) {
    return { ok: false, reason: '未配置 ADMIN_TOKEN 或完整的 ADMIN_USER/ADMIN_PASS（两者都需设置），操作已被默认拒绝' };
  }

  // 会话 Cookie 优先：它是签名过的强凭据，且是「下载」这类导航请求唯一的身份来源。
  // 校验失败不直接返回，继续往下尝试 Authorization 头。
  const session = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (session && await verifySession(cfg, session)) return { ok: true, mode: 'session' };

  const authorization = request.headers.get('authorization') || '';

  if (authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (cfg.adminToken && await safeEqual(token, cfg.adminToken)) return { ok: true, mode: 'token' };
    return { ok: false, reason: 'Bearer token 无效' };
  }

  if (authorization.toLowerCase().startsWith('basic ')) {
    if (!basicReady) return { ok: false, reason: '未配置 Basic 凭据' };
    let decoded = '';
    try {
      decoded = atob(authorization.slice(6).trim());
    } catch {
      return { ok: false, reason: 'Basic 凭据格式错误' };
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return { ok: false, reason: 'Basic 凭据格式错误' };
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (await safeEqual(user, cfg.adminUser) && await safeEqual(pass, cfg.adminPass)) {
      return { ok: true, mode: 'basic' };
    }
    return { ok: false, reason: '用户名或密码错误' };
  }

  return { ok: false, reason: '缺少 Authorization 头' };
}

/* ============================ 5. B2(S3) 数据面操作 ============================ */

export function signerOf(cfg) {
  // 请求级缓存：同一 cfg（含 bucketView 浅拷贝）共享一份派生密钥，避免分片上传时逐片重算
  if (!cfg._sigKeyCache) cfg._sigKeyCache = new Map();
  return new SigV4({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: cfg.service,
    keyCache: cfg._sigKeyCache,
  });
}

/** 拼接对象 URL（默认 path-style，兼容性最好） */
