#!/usr/bin/env node
/**
 * 部署脚本：BUCKET_1..N 等含密钥的变量只存放在 .dev.vars（已被 .gitignore 忽略）。
 *
 * 流程：
 *   1) 从 .dev.vars 读取 BUCKET_N，经 Cloudflare API PATCH 进 Worker 设置
 *      （不用 wrangler --var —— JSON 值经 shell 传参会被剥引号，实测踩坑）；
 *   2) 再用 wrangler 只上传代码。wrangler.toml 保持无 [vars] + keep_vars=true，
 *      其余控制台变量不受影响。
 *
 * 用法：
 *   node deploy.mjs                 # 注入 .dev.vars 里全部 BUCKET_N
 *   node deploy.mjs 1               # 只注入 BUCKET_1（本地试验用的桶可以不带上）
 *   node deploy.mjs 1,3             # 只注入 BUCKET_1 与 BUCKET_3
 *
 * 需要环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID（须有 Workers Scripts:Edit 权限）。
 * 可选：WRANGLER_NAME（默认 b2）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const NAME = process.env.WRANGLER_NAME || 'b2';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${NAME}/settings`;

function die(msg) {
  console.error('✘ ' + msg);
  process.exit(1);
}

if (!TOKEN || !ACCOUNT) {
  die('缺少 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID 环境变量。');
}
if (!existsSync('.dev.vars')) {
  die('未找到 .dev.vars —— 请按 .dev.vars.example 创建，并填入 BUCKET_1..N。');
}

/* 解析 .dev.vars（dotenv 风格：KEY=value，支持成对引号包裹；# 开头为注释） */
const vars = {};
for (const raw of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  vars[m[1]] = v;
}

let bucketVars = Object.entries(vars).filter(([k]) => /^BUCKET_\d+$/.test(k));
if (!bucketVars.length) die('.dev.vars 里没有 BUCKET_N 变量，Worker 将没有任何可挂载的桶。');

/* 可选参数：只部署指定序号的桶，如 `node deploy.mjs 1` 或 `node deploy.mjs 1,3` */
const only = (process.argv[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
if (only.length) {
  bucketVars = bucketVars.filter(([k]) => only.includes(k.slice(7)));
  if (!bucketVars.length) die(`过滤条件 ${only.join(',')} 没有匹配到任何 BUCKET_N。`);
}

/* JSON 预校验 + 同名桶守卫（Worker 端会拒绝重复桶名并记入 mountProblems） */
const names = bucketVars.map(([k, v]) => {
  try {
    const name = JSON.parse(v).BUCKET_NAME;
    if (!name) die(`${k} 的 JSON 缺少 BUCKET_NAME`);
    return name;
  } catch {
    die(`${k} 的值不是合法 JSON（检查引号/逗号）`);
    return '';
  }
});
const dup = names.filter((n, i) => names.indexOf(n) !== i);
if (dup.length) {
  die(`以下桶名在多个 BUCKET_N 里重复（同一桶不能挂载两次）: ${[...new Set(dup)].join(', ')}`);
}

/* ① 读当前设置 → 合并 BUCKET_N → PATCH 回写 */
const get = await fetch(API, { headers: { Authorization: `Bearer ${TOKEN}` } });
const cur = await get.json().catch(() => ({}));
if (!get.ok || !cur.success) die(`读取 Worker 设置失败: HTTP ${get.status} ${JSON.stringify(cur.errors || '')}`);

const bindings = (cur.result.bindings || []).filter((b) => !/^BUCKET_\d+$/.test(b.name));
for (const [k, v] of bucketVars) {
  bindings.push({ type: 'plain_text', name: k, text: v });
  console.log(`+ ${k} → ${names[bucketVars.findIndex(([k2]) => k2 === k)]}`);
}

/* 注意：settings PATCH 端点只收 multipart/form-data（JSON 体会 415），
   settings 部分是 JSON 字符串，boundary 由 fetch 自动生成 */
const form = new FormData();
form.append('settings', JSON.stringify({ bindings, keep_bindings: ['secret_text'] }));
const patch = await fetch(API, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});
const patchRes = await patch.json().catch(() => ({}));
if (!patch.ok || !patchRes.success) {
  die(`写入 BUCKET_N 失败: HTTP ${patch.status} ${JSON.stringify(patchRes.errors || '')}`);
}
console.log(`✔ 变量已写入（共 ${patchRes.result.bindings.length} 个绑定）`);

/* ② 先构建单一部署物（源码已拆分为 src/ 下多个模块，wrangler.toml 的 main 指向 dist/） */
console.log('▶ node tools/build.mjs …');
const b = spawnSync('node', ['tools/build.mjs'], { stdio: 'inherit' });
if (b.status !== 0) die('构建失败，已中止部署。');

/* ③ wrangler 只传代码（keep_vars=true ⇒ 不会动变量） */
console.log(`▶ wrangler deploy --name ${NAME} …`);
const r = spawnSync('npx', ['--yes', 'wrangler@3', 'deploy', '--name', NAME], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r.status || 0);
