/* =====================================================================================
 * cf-b2-worker.js · Cloudflare Workers ⇄ Backblaze B2 一体化网关
 * -------------------------------------------------------------------------------------
 * 目标：把 hoochanlon/CF-Proxy-B2（S3 兼容 + SigV4 只读代理）与 ka3hun9/cw4b2
 *      （原生 B2 API + 定时刷新下载令牌 + 动态生成第二个 Worker）两者的优点合并，
 *      并补齐两者短板，得到「单文件、零依赖、可读写、自带文件管理器」的 Worker。
 *
 * 设计取舍：
 *  1. 只用 S3 兼容 API + AWS Signature V4。签名密钥永不过期（不像 B2 原生
 *     authorizationToken 最多 7 天），因此不需要 cw4b2 的「第二个 Worker + cron +
 *     Cloudflare API Token」，也不必把可部署 Worker 的高危令牌塞进环境变量。
 *  2. 自己实现 SigV4（不依赖 aws4fetch），真正的单文件纯 ESM，可直接粘贴到
 *     Cloudflare 控制台部署，无需 npm install / esbuild 打包。
 *  3. 数据面请求全部由 Worker 实时签名，桶可保持 Private；Cloudflare 与 Backblaze
 *     同属 Bandwidth Alliance，回源与出网流量均免费。
 *  4. 大文件不穿过 Worker：浏览器用预签名 URL 直传 B2，或走 S3 分片上传，
 *     规避 Workers 100MB 请求体上限与 CPU/时长开销。
 *
 * 能力清单：
 *   · GET/HEAD 代理下载（Range 续传、条件请求、304、补偿 CF 丢失 content-range）
 *   · 下载强制经 Worker：不签发任何 GET 预签名直链，?dl=1 由 Worker 下发附件头
 *   · Cache API 边缘缓存 + Cache-Control 覆写
 *   · 目录列表（HTML/JSON；$path、$host、固定桶三种模式）
 *   · 网页文件管理器：浏览/上传/下载（经 Worker）/删除/重命名/建目录
 *   · 预签名 URL 仅用于「上传直传」与分片上传
 *   · S3 分片上传（create → part presign → complete / abort）
 *   · 访问控制：Basic/Bearer 恒定时间比较、公有读写开关、路径穿越防护、CORS 白名单
 *
 * 兼容性：Cloudflare Workers（ESM），compatibility_date >= 2023-09-04
 * ===================================================================================== */

import { SigV4 } from './lib/sigv4.js';
import { bucketUrl, listObjects, objectUrl, resolveBucketKey } from './lib/b2.js';
import { canonicalPath, normalizeKey, safeEqual, uriEncode } from './lib/crypto.js';
import { computeStorage, runScheduled, shouldWindowScan, usageState, utcDayStamp, UsageCounter } from './lib/usage.js';
import { handle } from './router.js';
import { loadConfig } from './lib/config.js';
import { managePage } from './ui/manage.js';

export default {
  /** Cron Triggers 入口：每天定时刷新空间快照（见 wrangler.toml 的 [triggers]） */
  async scheduled(event, env, ctx) {
    try {
      return await runScheduled(event, env);
    } catch (error) {
      console.error('[cf-b2-worker] scheduled', error && error.stack ? error.stack : error);
      return { ok: false, error: String((error && error.message) || error) };
    }
  },

  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error('[cf-b2-worker]', error && error.stack ? error.stack : error);
      return new Response(
        JSON.stringify({ ok: false, error: String((error && error.message) || error) }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
  },
};

/** 便于本地单元测试复用内部实现（Workers 允许额外具名导出） */
export {
  SigV4, loadConfig, resolveBucketKey, objectUrl, bucketUrl, normalizeKey,
  uriEncode, canonicalPath, safeEqual, handle, managePage, listObjects,
  shouldWindowScan, utcDayStamp, computeStorage, usageState, UsageCounter,
};

