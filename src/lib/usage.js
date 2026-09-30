/* 由 src/b2-worker.js 拆分而来：原 L1058-L1063、原 L1093-L1654 */

import { bucketView, loadConfig } from './config.js';
import { hourMatches } from './hours.js';
import { json } from './http.js';
import { listObjects } from './b2.js';

export const USAGE_CACHE_ORIGIN = 'https://usage.internal';

/** UTC 日期戳（与 B2 计数器 00:00 GMT 重置对齐） */
export function utcDayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}


/**
 * 是否该在「归零前窗口」补一次空间扫描：UTC 进入 windowHour 之后，
 * 且当天还没有做过窗口扫描。每天最多一次。
 */
export function shouldWindowScan(now, windowHour, windowDay) {
  if (!(windowHour >= 0 && windowHour <= 23)) return false;
  if (now.getUTCHours() < windowHour) return false;
  return windowDay !== utcDayStamp(now);
}

/**
 * 计数器使用**固定键**（不含日期）：归零完全由 scheduled() 显式执行，
 * 不再靠"键里带日期"来隔离不同天。
 */
export function counterCacheKey(bucket) {
  return USAGE_CACHE_ORIGIN + '/counters/' + encodeURIComponent(bucket || '_');
}

export function storageCacheKey(bucket) {
  return USAGE_CACHE_ORIGIN + '/storage/' + encodeURIComponent(bucket || '_');
}

export async function cacheGetJson(key) {
  try {
    const hit = await caches.default.match(key);
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

export async function cachePutJson(key, value, maxAge) {
  try {
    await caches.default.put(key, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + maxAge },
    }));
  } catch {
    /* Cache API 不可用（或对象过大）时静默跳过，不影响主流程 */
  }
}

/* ---------- 计数后端一：Durable Object（全局单实例、原子） ---------- */

/** 取计数用的 DO stub；未绑定或不可用时返回 null，调用方退化到 Cache API */
export function usageDoStub(env, bucket) {
  if (!env || !env.USAGE_DO) return null;
  try {
    return env.USAGE_DO.get(env.USAGE_DO.idFromName('usage:' + (bucket || '_')));
  } catch (error) {
    console.error('[cf-b2-worker] USAGE_DO 不可用，改用 Cache API 口径:', error && error.message);
    return null;
  }
}

export async function doCall(stub, action, payload) {
  const init = payload === undefined
    ? { method: 'GET' }
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    };
  const response = await stub.fetch('https://usage.do/' + action, init);
  if (!response.ok) throw new Error('DO ' + action + ' → HTTP ' + response.status);
  return response.json();
}

/**
 * 用量计数器（Durable Object）。
 * 同一个桶共用一个实例 → 所有数据中心看到同一份数字；DO 对同一实例的请求
 * 串行处理，所以「累加」与「重置」都是原子的。
 *
 * 归零方式：**完全由 scheduled()（Cron）显式调用 reset 动作**，
 * 不做「下次请求发现日期变了就归零」的惰性归零，也不用日期分键。
 * 含义：如果 Cron 没配/没跑，计数会持续累加不清零（要靠 Cron 保证）。
 */
export class UsageCounter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.data = null;
    this.pending = 0;
  }

  async load() {
    if (!this.data) {
      const stored = await this.state.storage.get('usage');
      this.data = stored || {
        day: utcDayStamp(), A: 0, B: 0, C: 0, D: 0, at: '', resetAt: '',
        storage: null, windowDay: '', lastAttempt: 0,
      };
    }
    return this.data;
  }

  /** 落盘；所有时间戳都以传入的 now 为准（便于测试与推理，只用一处时钟） */
  async save(now) {
    this.data.at = (now || new Date()).toISOString();
    await this.state.storage.put('usage', this.data);
  }

  counters() {
    return { A: this.data.A, B: this.data.B, C: this.data.C, D: this.data.D, at: this.data.at || '' };
  }

  async fetch(request) {
    const action = new URL(request.url).pathname.replace(/\/+$/, '').split('/').pop();
    await this.load();
    const now = new Date();
    if (action === 'add') return this.onAdd(request, now);
    if (action === 'sync') return this.onSync(request, now);
    if (action === 'snapshot') return this.onSnapshot(request, now);
    if (action === 'reset') return this.onReset(request, now);
    return json({ ok: false, error: '未知的 DO 动作: ' + action }, 404);
  }

  /** 由 scheduled() 调用的显式归零 */
  async onReset(request, now) {
    await this.load();
    return this.reset(now);
  }

  /** 把当日计数清 0（只在 Cron 触发时执行） */
  async reset(now) {
    const stamp = now.toISOString();
    this.data.A = 0;
    this.data.B = 0;
    this.data.C = 0;
    this.data.D = 0;
    this.data.day = utcDayStamp(now);
    this.data.resetAt = stamp;
    this.data.windowDay = '';
    await this.save(now);
    return json({
      ok: true, resetAt: stamp, day: this.data.day, counters: this.counters(),
    }, 200);
  }

  /** 累加本批 B2 调用次数；writeEvery > 1 时合并落盘以减少 SQLite 行写入 */
  async onAdd(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    let changed = false;
    for (const cls of ['A', 'B', 'C', 'D']) {
      const n = Number(body[cls]) || 0;
      if (n > 0) {
        this.data[cls] += n;
        changed = true;
      }
    }
    if (changed) {
      this.data.at = now.toISOString();
      this.pending += 1;
      const every = Math.max(1, Number(body.writeEvery) || 1);
      if (this.pending >= every) {
        this.pending = 0;
        await this.save(now);
      }
    }
    return json({ ok: true, day: this.data.day, counters: this.counters() }, 200);
  }

  /**
   * 一次调用同时完成「读计数器」与「是否该重扫空间」的仲裁。
   * 仲裁在 DO 内串行执行 → 多个数据中心同时打开页面也只会有一个真正去扫。
   * 空间快照平时只由 Cron（scheduled）刷新；这里的重扫仅限「还没有快照」的引导场景，
   * 以及显式开启 USAGE_AUTO_SCAN 之后的惰性刷新。
   */
  async onSync(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    const ttlMs = Math.max(0, Number(body.ttl) || 0) * 1000;
    const windowHour = Number.isFinite(body.windowHour) ? body.windowHour : -1;

    const snapshot = this.data.storage;
    const snapshotAt = snapshot && snapshot.at ? Date.parse(snapshot.at) : 0;
    const ageMs = snapshotAt ? now.getTime() - snapshotAt : Infinity;
    const autoScan = body.autoScan === true;

    let shouldScan = false;
    let windowed = false;
    let bootstrap = false;

    if (!snapshotAt) {
      shouldScan = true;              // 首次还没有任何快照 → 引导性扫一次
      bootstrap = true;
    } else if (autoScan && ttlMs > 0 && ageMs >= ttlMs) {
      shouldScan = true;              // 仅在显式开启惰性自动扫描时才按 TTL 重扫
    } else if (autoScan && shouldWindowScan(now, windowHour, this.data.windowDay)) {
      shouldScan = true;
    }

    if (shouldScan) {
      this.data.lastAttempt = now.getTime();
      if (windowHour >= 0 && now.getUTCHours() >= windowHour) {
        this.data.windowDay = utcDayStamp(now);
        windowed = true;
      }
      await this.save(now);
    }

    return json({
      ok: true,
      day: this.data.day,
      resetAt: this.data.resetAt || '',
      counters: this.counters(),
      storage: snapshot || null,
      shouldScan,
      windowed,
      bootstrap,
      ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : -1,
    }, 200);
  }

  /** 保存空间扫描结果 */
  async onSnapshot(request, now) {
    await this.load();
    const body = await request.json().catch(() => ({}));
    this.data.storage = {
      ok: true,
      bucket: String(body.bucket || ''),
      usedBytes: Number(body.usedBytes) || 0,
      objects: Number(body.objects) || 0,
      pages: Number(body.pages) || 0,
      complete: body.complete !== false,
      at: now.toISOString(),
    };
    await this.save(now);
    return json({ ok: true, day: this.data.day, counters: this.counters(), storage: this.data.storage }, 200);
  }
}

/* ---------- 计数后端二：Cache API（未绑定 DO 时的降级，按数据中心分裂） ---------- */

/** 把本请求产生的 B2 调用次数合并进计数器（尽力而为，不阻塞响应） */
export async function flushCounters(cfg, env, bucket) {
  const counts = cfg && cfg.usage && cfg.usage.counts;
  if (!counts || !Object.keys(counts).length) return;
  cfg.usage.counts = {};   // 先清空，避免同一批增量被重复计入（scheduled 里会按桶循环调用）

  const stub = usageDoStub(env, bucket);
  if (stub) {
    try {
      await doCall(stub, 'add', { ...counts, writeEvery: cfg.usageDoWriteEvery });
      return;
    } catch (error) {
      // 绑定存在但调用失败时不再写 Cache，避免两套后端数字分裂
      console.error('[cf-b2-worker] DO 计数失败，丢弃本次增量:', error && error.message);
      return;
    }
  }

  const key = counterCacheKey(bucket);
  const prev = (await cacheGetJson(key)) || {};
  // 保留 resetAt（由 scheduled 的归零写入），否则合并增量时会把它冲掉
  const next = {
    A: prev.A || 0, B: prev.B || 0, C: prev.C || 0, D: prev.D || 0,
    resetAt: prev.resetAt || '',
  };
  for (const [cls, n] of Object.entries(counts)) next[cls] = (next[cls] || 0) + n;
  next.at = new Date().toISOString();
  await cachePutJson(key, next, 2 * 86400);
}

/** 遍历整个桶累加对象数与字节数（每 1000 个对象 1 次 Class C） */
export async function computeStorage(cfg, bucket) {
  let cursor = '';
  let objects = 0;
  let bytes = 0;
  let pages = 0;
  let truncated = false;

  for (let i = 0; i < cfg.usageScanMaxPages; i++) {
    const page = await listObjects(cfg, bucket, { prefix: '', delimiter: '', limit: 1000, cursor });
    if (!page.ok) return { ok: false, status: page.status || 502, error: page.error };
    pages++;
    objects += page.files.length;
    for (const file of page.files) bytes += file.size || 0;
    cursor = page.nextToken || '';
    truncated = Boolean(page.truncated && cursor);
    if (!truncated) break;
  }

  return { ok: true, objects, bytes, pages, complete: !truncated };
}

export async function readCountersViaCache(bucket) {
  const data = (await cacheGetJson(counterCacheKey(bucket))) || {};
  return {
    A: data.A || 0, B: data.B || 0, C: data.C || 0, D: data.D || 0,
    at: data.at || '', resetAt: data.resetAt || '',
  };
}

/** 降级后端的归零：把固定键重写成 0（由 scheduled 调用） */
export async function resetCountersViaCache(bucket) {
  const now = new Date().toISOString();
  await cachePutJson(counterCacheKey(bucket), {
    A: 0, B: 0, C: 0, D: 0, at: now, resetAt: now,
  }, 2 * 86400);
  return { backend: 'cache', resetAt: now };
}

/**
 * 归零当日计数（与 scheduled() 共用）：DO 优先，未绑定则重写 Cache 键。
 * 只有 Cron 触发时才会调用，请求路径不做任何按日期的自动归零。
 */
export async function resetCounters(cfg, env, bucket) {
  const stub = usageDoStub(env, bucket);
  if (stub) {
    try {
      const out = await doCall(stub, 'reset', {});
      return { backend: 'do', resetAt: out.resetAt, day: out.day };
    } catch (error) {
      console.error('[cf-b2-worker] DO 归零失败，改写 Cache 键:', error && error.message);
    }
  }
  return resetCountersViaCache(bucket);
}

/** 空间快照（对外统一形状） */
export function snapshotShape(bucket, source, { cached, ageSeconds }) {
  return {
    ok: true,
    bucket,
    usedBytes: source.usedBytes || 0,
    objects: source.objects || 0,
    pages: source.pages || 0,
    complete: source.complete !== false,
    at: source.at || '',
    cached: Boolean(cached),
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : 0,
  };
}

/** 降级后端：Cache API（按数据中心独立，读-改-写非原子） */
export async function usageStateViaCache(cfg, bucket) {
  const cached = await cacheGetJson(storageCacheKey(bucket));
  const cachedAt = cached && cached.at ? Date.parse(cached.at) : 0;
  const ageMs = cachedAt ? Date.now() - cachedAt : Infinity;
  const inWindow = cfg.usageAutoScan && cfg.usageRefreshHour >= 0
    && new Date().getUTCHours() >= cfg.usageRefreshHour;
  const windowed = cfg.usageAutoScan && Boolean(cached)
    && shouldWindowScan(new Date(), cfg.usageRefreshHour, cached.windowDay);

  let shouldScan = false;
  if (!cachedAt) shouldScan = true;
  else if (cfg.usageAutoScan && ageMs >= cfg.usageCacheTtl * 1000) shouldScan = true;
  else if (windowed) shouldScan = true;

  const counters = await readCountersViaCache(bucket);
  if (!shouldScan) {
    return {
      backend: 'cache',
      counters,
      storage: snapshotShape(bucket, cached, { cached: true, ageSeconds: Math.round(ageMs / 1000) }),
      windowed,
    };
  }

  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) {
    return {
      backend: 'cache',
      counters,
      storage: { ok: false, error: scan.error, status: scan.status },
      windowed,
    };
  }

  const stored = {
    usedBytes: scan.bytes, objects: scan.objects, pages: scan.pages,
    complete: scan.complete, at: new Date().toISOString(),
    windowDay: inWindow ? utcDayStamp() : ((cached && cached.windowDay) || ''),
  };
  // 快照可能一天才更新一次（Cron），缓存条目不能按 TTL 6h 就过期
  await cachePutJson(storageCacheKey(bucket), stored, Math.max(cfg.usageCacheTtl, 2 * 86400));
  return {
    backend: 'cache',
    counters,
    storage: snapshotShape(bucket, stored, { cached: false, ageSeconds: 0 }),
    windowed,
  };
}

/**
 * 用量统一入口：绑定了 USAGE_DO 就走 Durable Object（全局一致 + 原子），
 * 否则退化到 Cache API。空间快照由 Cron 刷新；首次读取若还没有快照会引导性扫一次。
 * 没有「手动重新统计」入口 —— 任何请求路径都不会强制重扫。
 */
export async function usageState(cfg, env, bucket) {
  const stub = usageDoStub(env, bucket);
  if (!stub) return usageStateViaCache(cfg, bucket);

  let state;
  try {
    state = await doCall(stub, 'sync', {
      ttl: cfg.usageCacheTtl,
      windowHour: cfg.usageRefreshHour,
      autoScan: cfg.usageAutoScan,
    });
  } catch (error) {
    console.error('[cf-b2-worker] DO 读取失败，本次改用 Cache API 口径:', error && error.message);
    return usageStateViaCache(cfg, bucket);
  }

  if (!state.shouldScan) {
    return {
      backend: 'do',
      counters: state.counters,
      resetAt: state.resetAt || '',
      storage: state.storage
        ? snapshotShape(bucket, state.storage, { cached: true, ageSeconds: state.ageSeconds })
        : { ok: false, error: '暂无快照' },
      windowed: state.windowed,
    };
  }

  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) {
    return {
      backend: 'do',
      counters: state.counters,
      resetAt: state.resetAt || '',
      storage: { ok: false, error: scan.error, status: scan.status },
      windowed: state.windowed,
    };
  }

  const saved = await doCall(stub, 'snapshot', {
    bucket,
    usedBytes: scan.bytes,
    objects: scan.objects,
    pages: scan.pages,
    complete: scan.complete,
  });
  return {
    backend: 'do',
    counters: saved.counters,
    resetAt: state.resetAt || '',
    storage: snapshotShape(bucket, saved.storage, { cached: false, ageSeconds: 0 }),
    windowed: state.windowed,
  };
}

/** 定时统计要覆盖的桶列表：直接来自挂载表（BUCKET_1..N） */
export function scheduledBuckets(cfg) {
  return cfg.buckets.map((b) => b.name);
}

/** 扫描一次空间并落成快照（DO 优先；未绑定 DO 时写 Cache API） */
export async function refreshSnapshot(cfg, env, bucket) {
  const scan = await computeStorage(cfg, bucket);
  if (!scan.ok) throw new Error(scan.error || ('扫描失败: HTTP ' + (scan.status || 0)));

  const record = {
    bucket,
    usedBytes: scan.bytes,
    objects: scan.objects,
    pages: scan.pages,
    complete: scan.complete,
    at: new Date().toISOString(),
  };

  const stub = usageDoStub(env, bucket);
  if (stub) {
    try {
      await doCall(stub, 'snapshot', record);
      return { ...record, backend: 'do' };
    } catch (error) {
      console.error('[cf-b2-worker] 定时统计写 DO 失败，改写 Cache API:', error && error.message);
    }
  }
  await cachePutJson(storageCacheKey(bucket), record, Math.max(cfg.usageCacheTtl, 2 * 86400));
  return { ...record, backend: 'cache' };
}

/**
 * Cron（scheduled）统一入口：空间统计与计数归零共用这一个事件。
 * 按触发时刻的 UTC 小时分派（两者默认都在 23 点 → 一条 cron 即可）：
 *   USAGE_SCAN_HOURS  （默认 "23"）→ 先刷新空间快照
 *   USAGE_RESET_HOURS （默认 "23"）→ 再把 Class A/B/C/D 清零
 * 顺序是「先扫描、再归零」：即先给当前用量留下一份快照，再做归零结算；
 * 本次扫描自己消耗的 Class C 也记在旧周期里，随后被归零一并清掉，
 * 因此新周期（23:00 起算）从 0 开始。
 */
export async function runScheduled(event, env) {
  const cfg = loadConfig(env);
  const when = new Date((event && event.scheduledTime) || Date.now());
  const hour = when.getUTCHours();

  const doScan = hourMatches(cfg.usageScanHours, hour);
  const doReset = hourMatches(cfg.usageResetHours, hour);
  const buckets = scheduledBuckets(cfg);

  if (!buckets.length) {
    console.warn('[cf-b2-worker] scheduled 缺少桶名：$path / $host 模式请设置 USAGE_SCHEDULE_BUCKETS');
    return { ok: false, skipped: '未确定桶名（请配置 USAGE_SCHEDULE_BUCKETS）', hour, doScan, doReset };
  }
  if (!cfg.enableUsage) {
    return { ok: false, skipped: '用量面板已关闭（ENABLE_USAGE_PANEL=false）', hour };
  }

  if (cfg.enableUsage) cfg.usage = { counts: {} };   // 让定时任务里的 B2 调用也计入用量

  const results = [];
  for (const m of cfg.buckets) {
    // 每桶独立视图（各自的凭据 / endpoint / 计数器）
    const view = bucketView(cfg, m);
    const bucket = m.name;
    const item = { bucket, scan: null, reset: null };

    if (doScan) {
      try {
        const record = await refreshSnapshot(view, env, bucket);
        item.scan = { ok: true, usedBytes: record.usedBytes, objects: record.objects, backend: record.backend };
        console.log('[cf-b2-worker] 定时统计完成',
          bucket, record.usedBytes + 'B', record.objects + ' objects', 'via', record.backend);
      } catch (error) {
        item.scan = { ok: false, error: String((error && error.message) || error) };
        console.error('[cf-b2-worker] 定时统计失败', bucket, error && error.message);
      }
    }

    // 定时任务自己发起的 B2 请求（如本次扫描的 Class C）先记账，再被下面的归零清掉
    if (Object.keys(view.usage.counts).length) {
      await flushCounters(view, env, bucket).catch((error) => {
        console.error('[cf-b2-worker] 定时任务的用量计数写入失败', error && error.message);
      });
    }

    if (doReset) {
      try {
        const out = await resetCounters(view, env, bucket);
        item.reset = { ok: true, backend: out.backend, resetAt: out.resetAt };
        console.log('[cf-b2-worker] 当日计数已归零', bucket, 'via', out.backend);
      } catch (error) {
        item.reset = { ok: false, error: String((error && error.message) || error) };
        console.error('[cf-b2-worker] 计数归零失败', bucket, error && error.message);
      }
    }

    results.push(item);
  }

  const ok = results.every((r) => (!r.scan || r.scan.ok) && (!r.reset || r.reset.ok));
  return {
    ok,
    cron: (event && event.cron) || '',
    hour,
    didScan: doScan,
    didReset: doReset,
    results,
  };
}

/* ============================ 6. 管理 API ============================ */

/* ---- B2 原生 API（控制面，免费、不计 Class A-D）：桶级 CORS 配置 ---- */

/** b2_authorize_account：用桶自己的应用密钥换取控制面令牌 */
