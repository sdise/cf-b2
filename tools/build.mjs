#!/usr/bin/env node
/**
 * 零依赖打包器：把 src/ 下的多个模块合并成**单一部署物** dist/b2-worker.js。
 *
 * 为什么不直接用 esbuild：
 *   本项目的卖点就是「零依赖、可直接粘贴到 Cloudflare 控制台部署」。引入 esbuild
 *   意味着多一份 npm 依赖与安装步骤；而我们的模块都是自己写的纯 ESM、无外部依赖，
 *   合并规则非常简单，用 30 行原生 Node 即可完成，产物与手写单文件完全等价。
 *
 * 规则：
 *   1. 从入口 src/index.js 出发，按 import 语句递归收集模块，依赖在前、入口在后（拓扑序）；
 *   2. 去掉每个模块的 import 语句（合并后同处一个作用域，无需 import）；
 *   3. 去掉非入口模块的 export 前缀（普通具名导出合并后即为同作用域声明）；
 *   4. 入口的 export default / export { ... } 原样保留 —— 即最终的 Worker 导出。
 *
 * 用法：
 *   node tools/build.mjs            # 构建 dist/b2-worker.js
 *   node tools/build.mjs --check    # 只校验产物与磁盘一致（CI 用，不写文件）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const OUT = path.join(ROOT, 'dist', 'b2-worker.js');
const CHECK = process.argv.includes('--check');

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(p, 'utf8');

/** 提取单行 import 语句中的相对路径 */
function importsOf(code) {
  const deps = [];
  for (const m of code.matchAll(/^import\s[^'"]*?['"]([^'"]+)['"]\s*;?\s*$/gm)) {
    if (m[1].startsWith('.')) deps.push(m[1]);
  }
  return deps;
}

/** 拓扑排序：被依赖的模块排在使用者前面 */
function collect(entry) {
  const order = [];
  const seen = new Set();
  const stack = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    if (stack.has(file)) throw new Error('检测到循环依赖：' + rel(file));
    stack.add(file);
    for (const spec of importsOf(read(file))) visit(path.resolve(path.dirname(file), spec));
    stack.delete(file);
    seen.add(file);
    order.push(file);
  };
  visit(entry);
  return order;
}

/** 去掉 import 语句 */
const stripImports = (code) => code.replace(/^import\s[^'"]*?['"][^'"]+['"]\s*;?\s*$/gm, '');

/** 去掉非入口模块的 export 前缀（只认真正的声明关键字，避免误伤注释/字符串） */
const stripExports = (code) =>
  code.replace(/^export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm, '');

const files = collect(ENTRY);
const entry = files[files.length - 1];
if (entry !== ENTRY) throw new Error('入口未排在最后：' + rel(entry));

/** 入口顶部的项目说明块注释，提到产物最前面 */
const entryCode = read(ENTRY);
const headMatch = entryCode.match(/^\/\*[\s\S]*?\*\//);
const header = headMatch ? headMatch[0] : '';
const entryBody = headMatch ? entryCode.slice(headMatch[0].length) : entryCode;

const chunks = files.slice(0, -1).map((file) => {
  const code = stripExports(stripImports(read(file))).replace(/^\s+|\s+$/g, '');
  return `/* ---------- ${rel(file)} ---------- */\n${code}`;
});

const banner = [
  '/* eslint-disable */',
  '/* ============================================================================',
  ' * ⚠️ 自动生成，请勿直接编辑 —— 本文件由 tools/build.mjs 从 src/ 下的模块合并而来。',
  ' *    修改源码后执行：npm run build',
  ' * ============================================================================ */',
].join('\n');

const output = [
  header,
  banner,
  ...chunks,
  '/* ---------- src/index.js（入口，保留导出） ---------- */',
  stripImports(entryBody).replace(/^\s+|\s+$/g, ''),
  '',
].join('\n\n');

if (CHECK) {
  const current = fs.existsSync(OUT) ? read(OUT) : '';
  if (current !== output) {
    console.error('✘ dist/b2-worker.js 与 src/ 不一致，请执行 npm run build');
    process.exit(1);
  }
  console.log('✔ dist/b2-worker.js 与 src/ 一致（' + rel(OUT) + '）');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output);
  const kb = (Buffer.byteLength(output) / 1024).toFixed(1);
  console.log(`✔ 已生成 ${rel(OUT)}（${files.length} 个模块 → 单文件，${kb} KB）`);
}
