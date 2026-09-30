import fs from 'node:fs';
let s = fs.readFileSync('tests/router.test.mjs', 'utf8');
const subs = [];

// 1) DO 集成：second.storage → buckets[0]
subs.push([
  "assert(second.storage.cached === true, 'DO 快照应命中: ' + JSON.stringify(second.storage));",
  "assert(second.buckets[0].storage.cached === true, 'DO 快照应命中: ' + JSON.stringify(second.buckets[0].storage));",
]);

// 2) DO 降级：counterBackend → counterBackendLabel
subs.push([
  "assert(body.ok === true && body.counterBackend === 'cache', JSON.stringify(body).slice(0, 160));",
  "assert(body.ok === true && body.counterBackendLabel === 'Cache API', JSON.stringify(body).slice(0, 160));",
]);

// 3) autoScan 字段已移除
subs.push([
  "  assert(sent.length === before, '10 天前的快照也不该触发重扫');\n  assert(body.autoScan === false, 'autoScan=' + body.autoScan);",
  "  assert(sent.length === before, '10 天前的快照也不该触发重扫');",
]);
subs.push([
  "  assert(body.autoScan === true && body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.buckets[0].storage));",
  "  assert(body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.buckets[0].storage));",
]);

// 4) 定时统计多桶：改为遍历挂载表（两个桶）
subs.push([
  "await check('定时统计支持多桶（$path 模式需显式列出）', async () => {\n  await settle();\n  cacheStore.clear();\n  const out = await workerDefault.scheduled(cronEvent(), {\n    ...shareEnv, BUCKET_NAME: '$path', USAGE_SCHEDULE_BUCKETS: 'bucket-a, bucket-b',\n  }, ctrlCtx);",
  "await check('定时统计支持多桶（遍历挂载表）', async () => {\n  await settle();\n  cacheStore.clear();\n  const out = await workerDefault.scheduled(cronEvent(), {\n    ...shareEnv, BUCKET_1: bucketJson('bucket-a'), BUCKET_2: bucketJson('bucket-b'),\n  }, ctrlCtx);",
]);

// 5) DO 后端 23 点：buckets[0] + 去掉 counterResetAt
subs.push([
  "  assert(before.classB.used === 1, 'classB=' + before.classB.used);",
  "  assert(before.buckets[0].classB.used === 1, 'classB=' + before.buckets[0].classB.used);",
]);
subs.push([
  "  assert(after.classB.used === 0, 'reset 后 B 应为 0，实际 ' + after.classB.used);\n  assert(after.classC.used === 0, '新周期应从 0 开始（扫描消耗计入旧周期），实际 ' + after.classC.used);\n  assert(after.counterResetAt, '缺少 resetAt');",
  "  assert(after.buckets[0].classB.used === 0, 'reset 后 B 应为 0，实际 ' + after.buckets[0].classB.used);\n  assert(after.buckets[0].classC.used === 0, '新周期应从 0 开始（扫描消耗计入旧周期），实际 ' + after.buckets[0].classC.used);\n  assert(after.resetSchedule, '缺少 resetSchedule');",
]);

// 6) 删除「$path 模式未配置 USAGE_SCHEDULE_BUCKETS」用例（挂载表模式下已不存在）
subs.push([
  "await check('$path 模式未配置 USAGE_SCHEDULE_BUCKETS 时跳过并给出原因', async () => {\n  const out = await workerDefault.scheduled(cronEvent(), { ...shareEnv, BUCKET_NAME: '$path' }, ctrlCtx);\n  assert(out.ok === false && /USAGE_SCHEDULE_BUCKETS/.test(out.skipped), JSON.stringify(out));\n  return out.skipped;\n});\n\n",
  "",
]);

// 7) 匿名三层面包屑：桶名段现在可见（用户已确认桶名可公开）
subs.push([
  "await check('匿名：三层目录面包屑逐级可点，且不暴露桶根', async () => {\n  const page = await (await handle(req('/share/my-bucket/images/icons/'), shareEnv, ctx)).text();\n  const crumb = page.match(/<nav class=\"crumb\">([\\s\\S]*?)<\\/nav>/)[1];\n  assert(crumb.includes('<a href=\"/share/\">公开目录</a>'), '缺少公开根链接');\n  assert(crumb.includes('<a href=\"/share/my-bucket/images/\">images</a>'), '缺少中间级链接: ' + crumb);\n  assert(crumb.includes('<span class=\"cur\">icons</span>'), '当前级不对: ' + crumb);\n  assert(!crumb.includes('href=\"/\"'), '匿名面包屑不应指向桶根 /');\n  assert(!crumb.includes('share</a>'), '匿名面包屑不应暴露公开前缀本身');\n  return '公开目录 → /share/images/ ｜ icons';\n});",
  "await check('匿名：三层目录面包屑逐级可点（公开目录 / 桶 / images / icons）', async () => {\n  const page = await (await handle(req('/share/my-bucket/images/icons/'), shareEnv, ctx)).text();\n  const crumb = page.match(/<nav class=\"crumb\">([\\s\\S]*?)<\\/nav>/)[1];\n  assert(crumb.includes('<a href=\"/share/\">公开目录</a>'), '缺少公开根链接: ' + crumb);\n  assert(crumb.includes('<a href=\"/share/my-bucket/\">my-bucket</a>'), '缺少桶段链接: ' + crumb);\n  assert(crumb.includes('<a href=\"/share/my-bucket/images/\">images</a>'), '缺少中间级链接: ' + crumb);\n  assert(crumb.includes('<span class=\"cur\">icons</span>'), '当前级不对: ' + crumb);\n  assert(!crumb.includes('href=\"/\"'), '匿名面包屑不应指向桶根 /');\n  return '公开目录 → my-bucket → images → icons（当前）';\n});",
]);

// 8) 匿名公开根：改回虚拟根 /share/
subs.push([
  "await check('匿名：公开根（/share/）面包屑只有「公开目录」且指向自身', async () => {\n  const page = await (await handle(req('/share/my-bucket/'), shareEnv, ctx)).text();\n  const crumb = page.match(/<nav class=\"crumb\">([\\s\\S]*?)<\\/nav>/)[1];\n  assert(crumb === '<a href=\"/share/\">公开目录</a>', '面包屑不符: ' + crumb);\n  return crumb;\n});",
  "await check('匿名：公开聚合根（/share/）面包屑只有「公开目录」', async () => {\n  const page = await (await handle(req('/share/'), shareEnv, ctx)).text();\n  const crumb = page.match(/<nav class=\"crumb\">([\\s\\S]*?)<\\/nav>/)[1];\n  assert(crumb === '<span class=\"cur\">公开目录</span>', '面包屑不符: ' + crumb);\n  assert(page.includes('/share/my-bucket/'), '聚合页应列出桶入口');\n  return crumb;\n});",
]);

// 9) 管理员面包屑：根级 href 为挂载点
subs.push([
  "  assert(crumb.includes('<a href=\"/\">my-bucket</a>'), '根级应为桶名 → /: ' + crumb);",
  "  assert(crumb.includes('<a href=\"/my-bucket/\">my-bucket</a>'), '根级应为桶名 → /my-bucket/: ' + crumb);",
]);
subs.push([
  "  assert(crumb.includes('<a href=\"/share/\">share</a>'), '缺少 share 链接: ' + crumb);",
  "  assert(crumb.includes('<a href=\"/share/my-bucket/\">share</a>'), '缺少 share 链接: ' + crumb);",
]);

// 10) $path 匿名面包屑 → 规范路径重定向到别名
subs.push([
  "await check('$path 模式：匿名面包屑根链接带桶名前缀', async () => {\n  const pathShareEnv = { ...env, ALLOW_LIST_BUCKET: 'false', PUBLIC_PREFIX: 'share' };\n  const page = await (await handle(req('/my-bucket/share/docs/'), pathShareEnv, ctx)).text();\n  const crumb = page.match(/<nav class=\"crumb\">([\\s\\S]*?)<\\/nav>/)[1];\n  assert(crumb.includes('<a href=\"/share/my-bucket/\">公开目录</a>'), '根链接应为 /my-bucket/share/: ' + crumb);\n  assert(crumb.includes('<span class=\"cur\">docs</span>'), '缺 docs: ' + crumb);\n  return crumb;\n});",
  "await check('匿名访问规范路径 /<桶>/share/** 重定向到别名 /share/<桶>/**', async () => {\n  const res = await handle(req('/my-bucket/share/docs/'), shareEnv, ctx);\n  assert(res.status === 308, 'status=' + res.status);\n  assert(res.headers.get('location') === 'https://dl.example.com/share/my-bucket/docs/', res.headers.get('location'));\n  return res.headers.get('location');\n});",
]);

// 11) 聚合根返回上一级
subs.push([
  "await check('公开根目录（/share/）匿名不再显示返回上一级，管理员仍可回根', async () => {\n  const anon = await (await handle(req('/share/my-bucket/'), shareEnv, ctx)).text();\n  assert(!anon.includes('返回上一级'), '匿名在公开根不该出现返回上一级');\n\n  const admin = await (await handle(\n    req('/share/my-bucket/', { headers: { Authorization: basic } }), shareEnv, ctx,\n  )).text();\n  const up = admin.match(/<a href=\"([^\"]+)\">返回上一级<\\/a>/);\n  assert(up && up[1] === '/', '管理员返回上一级应指向 /，实际 ' + (up && up[1]));\n  return '匿名隐藏；管理员 → /';\n});",
  "await check('公开聚合根（/share/）无「返回上一级」，管理员有管理器入口', async () => {\n  const anon = await (await handle(req('/share/'), shareEnv, ctx)).text();\n  assert(!anon.includes('返回上一级'), '聚合根不该出现返回上一级');\n  const admin = await (await handle(req('/share/', { headers: { Authorization: basic } }), shareEnv, ctx)).text();\n  assert(!admin.includes('返回上一级'), '聚合根没有上一级');\n  assert(admin.includes('/__manage'), '管理员应能看到管理器入口');\n  return '聚合根无返回上一级；管理员有管理器入口';\n});",
]);

// 12) 删除「$path 模式：缺失桶名时明确报错」（缺省回落第一个桶）
subs.push([
  "await check('$path 模式：缺失桶名时明确报错', async () => {\n  const res = await handle(req('/__api/list', { headers: { Authorization: basic } }), pathEnv, ctx);\n  const body = await res.json();\n  assert(res.status === 400 && body.ok === false, 'status=' + res.status);\n  return body.error;\n});\n\n",
  "",
]);

// 13) 根目录列举：桶根改路径
subs.push([
  "  const res = await handle(req('/?format=json', { headers: { Authorization: basic } }), shareEnv, ctx);\n  const body = await res.json();\n  assert(body.prefix === '', 'prefix=' + body.prefix);",
  "  const res = await handle(req('/my-bucket/?format=json', { headers: { Authorization: basic } }), shareEnv, ctx);\n  const body = await res.json();\n  assert(body.prefix === '', 'prefix=' + body.prefix);",
]);

// 3b) autoScan 断言已随字段移除（此前批量替换后的形态）
subs.push([
  "  assert(body.autoScan === true && body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.buckets[0].storage));",
  "  assert(body.buckets[0].storage.usedBytes === 1024, JSON.stringify(body.buckets[0].storage));",
]);

// 14) 删除 ROOT_ACTION 三个用例（根页已是虚拟桶总览，匿名 308 到 /share/）
const rootActionStart = s.indexOf("await check('匿名根目录：默认返回 403 JSON'");
const rootActionEnd = s.indexOf("/* ---------- 信息泄露与防滥用加固 ---------- */");
assert2(rootActionStart !== -1 && rootActionEnd > rootActionStart);
s = s.slice(0, rootActionStart) + s.slice(rootActionEnd);

// 15) 泄露用例：桶名可公开（用户决策），但管理器入口仍不可暴露
subs.push([
  "  assert(!body.includes('my-bucket'), '泄露了桶名');\n  assert(!body.includes('__manage'), '匿名视图不应暴露管理器入口');\n  assert(body.includes('a.txt'), '仍应正常列出文件');\n  return '已脱敏';",
  "  assert(body.includes('my-bucket'), '桶名可公开（面包屑/挂载点）');\n  assert(!body.includes('__manage'), '匿名视图不应暴露管理器入口');\n  assert(body.includes('a.txt'), '仍应正常列出文件');\n  return '管理器入口已隐藏；桶名按设计公开';",
]);

function assert2(cond) { if (!cond) { console.error('PATCH FAILED: marker not found'); process.exit(1); } }
let applied = 0;
for (const [a, b] of subs) {
  if (!s.includes(a)) { console.error('SKIP NOT FOUND: ' + a.slice(0, 70)); continue; }
  s = s.split(a).join(b);
  applied++;
}
fs.writeFileSync('tests/router.test.mjs', s);
console.log('applied ' + applied + ' patches');
