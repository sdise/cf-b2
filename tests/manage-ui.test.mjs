/**
 * 管理器前端「分片大小 / 并发数」调参的端到端校验：
 * 把页面内联脚本放进一个极简假 DOM 里真实执行，再模拟用户改输入框，验证默认值与钳制。
 */
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { handle } = await import(pathToFileURL(path.join(here, '..', 'src', 'b2-worker.js')).href);

let failed = 0;
async function check(label, fn) {
  try {
    const note = await fn();
    console.log('PASS  ' + label + (note ? '  → ' + note : ''));
  } catch (error) {
    failed++;
    console.log('FAIL  ' + label + '\n      ' + (process.env.STACK ? error.stack : error.message));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ---------- 极简假 DOM ---------- */

function fakeElement(id = '') {
  // 有状态的 classList（Set 支撑），用于验证「更多」折叠的展开/收起
  const classSet = new Set();
  const classList = {
    add: (...cs) => { cs.forEach((c) => classSet.add(c)); },
    remove: (...cs) => { cs.forEach((c) => classSet.delete(c)); },
    contains: (c) => classSet.has(c),
    toggle(c) {
      if (classSet.has(c)) { classSet.delete(c); return false; }
      classSet.add(c); return true;
    },
  };
  const el = {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    placeholder: '',
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    firstChild: null,
    files: null,
    onchange: null,
    onclick: null,
    classList,
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { this.children.push(child); this.firstChild = this.children[0]; return child; },
    insertBefore(child) { this.children.unshift(child); this.firstChild = this.children[0]; return child; },
    removeChild() {},
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => fakeElement('q'),
    querySelectorAll: () => [],
    cloneNode() { return fakeElement(id); },
    focus() {},
    select() {},
    click() {},
  };
  return el;
}

function buildSandbox(html) {
  const cfgJson = html.match(/<script id="cfg" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const store = new Map();
  const els = new Map();
  const storage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const document = {
    documentElement: fakeElement('html'),
    body: fakeElement('body'),
    getElementById(id) {
      if (!els.has(id)) els.set(id, fakeElement(id));
      return els.get(id);
    },
    createElement: (tag) => fakeElement(tag),
    execCommand: () => true,
    addEventListener() {},
  };
  document.getElementById('cfg').textContent = cfgJson;

  const okJson = (data) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
  const requests = [];
  const fetchStub = async (input) => {
    const target = String(typeof input === 'string' ? input : (input && input.url) || '');
    requests.push(target);
    if (target.includes('/usage')) {
      return okJson({
        ok: true,
        counterBackendLabel: 'Durable Object',
        scanSchedule: '23:00 UTC',
        resetSchedule: '23:00 UTC',
        buckets: [{
          name: 'demo-bucket', label: 'demo-bucket', ordinal: 1, quotaBytes: 10000000000,
          storage: {
            ok: true, usedBytes: 2147483648, objects: 12, pages: 3,
            complete: true, cached: true, at: '2026-09-30T02:00:00.000Z',
          },
          classB: { used: 128, quota: 2500, remaining: 2372 },
          classC: { used: 12, quota: 2500, remaining: 2488 },
        }],
      });
    }
    return okJson({ ok: true, files: [], folders: [], truncated: false, nextToken: '' });
  };

  const location = { origin: 'https://x', href: 'https://x/__manage', reload() {} };
  const winData = {
    document,
    location,
    localStorage: storage,
    sessionStorage: { ...storage, getItem: () => null },
    scrollY: 0,
    pageYOffset: 0,
    innerHeight: 800,
    name: '',
    origin: 'https://x',
  };
  // 未显式提供的 window 成员一律当作空函数（addEventListener、prompt、confirm…）
  const win = new Proxy(winData, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return () => {};
    },
  });

  const sandbox = {
    document,
    window: win,
    self: win,
    location,
    localStorage: storage,
    sessionStorage: winData.sessionStorage,
    fetch: fetchStub,
    XMLHttpRequest: class { open() {} setRequestHeader() {} send() {} },
    console,
    URL,
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Boolean,
    Object,
    Array,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
  };
  sandbox.globalThis = sandbox;

  const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]);
  return { sandbox, els, scripts, storage, requests };
}

const ctxStub = { waitUntil() {}, passThroughOnException() {} };
const basic = 'Basic ' + Buffer.from('b2:b2').toString('base64');

async function render(pageEnv) {
  const res = await handle(
    new Request('https://x/__manage', { headers: { Authorization: basic } }),
    pageEnv,
    ctxStub,
  );
  return res.text();
}

const env = {
  BUCKET_1: JSON.stringify({
    BUCKET_NAME: 'b', KEY_ID: 'k', APPLICATION_KEY: 's',
    ENDPOINT: 'https://s3.us-west-001.backblazeb2.com',
  }),
  ADMIN_USER: 'b2', ADMIN_PASS: 'b2',
  MAX_UPLOAD_BYTES: '96000000', MULTIPART_PART_SIZE: '26214400', UPLOAD_CONCURRENCY: '3',
};

/* ---------- 用例 ---------- */

await check('内联脚本可在假 DOM 中完整执行（初始化不抛错）', async () => {
  const { sandbox, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  return scripts.length + ' 个脚本块执行通过';
});

await check('用量卡片只显示指定字段：桶/空间/对象数/Class B/Class C/计数后端', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  await new Promise((resolve) => setImmediate(resolve));   // 等 loadUsage 的异步链跑完

  const card = String(els.get('usage').innerHTML || '');

  // —— 应当展示的 ——
  assert(card.includes('demo-bucket'), '缺少桶名: ' + card);
  assert(card.includes('已用空间:</span>'), '应为「已用空间:」带冒号: ' + card);
  assert(/21\.5%/.test(card), '缺少占用百分比（应作为主值）: ' + (card.match(/[\d.]+%/) || []).join());
  assert(card.includes('2.1 GB / 10.0 GB'), '第二行应为「已用 / 总额」: ' + card);
  assert(card.indexOf('21.5%') < card.indexOf('2.1 GB'), '百分比应在数值行之前: ' + card);
  assert(card.includes('对象数') && card.includes('12'), '缺少对象数');
  assert(card.includes('Class B:</span>') && card.includes('128'), 'Class B 计数缺失');
  assert(card.includes('Class C:</span>') && card.includes('12'), 'Class C 计数缺失');
  assert(/128<\/span><span class="muted">\/ 2500/.test(card), 'Class B 应为「14/ 2500」形态: ' + card);
  assert(card.includes('计数后端：Durable Object'), '未标注计数后端');

  // —— 不应再展示的（含已移除的「重新统计」按钮与剩余次数）——
  const gone = ['btnUsageRefresh', '重新统计', 'Class A', '计数重置', '本次扫描',
    '当日终值扫描', '仅统计本 Worker', '空间更新于', '缓存',
    '（读取）', '（列举）', '（剩 '];
  for (const g of gone) assert(!card.includes(g), '仍展示了「' + g + '」: ' + card);

  return card.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
});

await check('所有 API 请求都用绝对 URL（修复「带凭据 URL → 面板不可用」）', async () => {
  const { sandbox, requests, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  await new Promise((resolve) => setImmediate(resolve));

  assert(requests.length > 0, '没有捕获到任何请求');
  const relative = requests.filter((u) => !/^https?:\/\//i.test(u));
  assert(relative.length === 0, '仍存在相对 URL 请求: ' + relative.join(', '));
  assert(requests.every((u) => u.startsWith('https://x/')), '请求应指向 location.origin: ' + requests.join(', '));
  assert(requests.some((u) => u.includes('/__api/usage')), '缺少 usage 请求: ' + requests.join(', '));

  const page = await render(env);
  assert(page.includes('function absUrl(u)'), '缺少 absUrl 辅助函数');
  assert(page.includes('fetch(absUrl(API + path)'), 'call() 未改用绝对 URL');
  assert(page.includes('xhr.open("PUT", absUrl(url), true)'), 'putXHR() 未改用绝对 URL');
  assert(page.includes('fetch(absUrl(API + "logout")'), 'logout 未改用绝对 URL');
  assert(page.includes('fetch(absUrl(API + "health")'), 'health 未改用绝对 URL');
  return requests.length + ' 个请求全为绝对 URL，5 处调用点已改';
});

await check('移动端顶部：只常显「新建目录 / 上传方式 / 上传」，其余收进折叠区', async () => {
  const page = await render(env);
  const m = page.match(/<div class="more" id="moreMenu">([\s\S]*?)<\/div>/);
  assert(m, '缺少折叠区容器 <div class="more" id="moreMenu">');

  const inside = m[1];
  for (const id of ['bucketLabel', 'fUser', 'fPass', 'btnLogin', 'btnLogout', 'btnRefresh', 'partSize', 'conc', 'btnTheme']) {
    assert(inside.includes('id="' + id + '"'), id + ' 应位于折叠区内');
  }
  assert(inside.includes('<h1>Backblaze B2 文件管理器</h1>'), '标题应位于折叠区内');

  const outside = page.replace(m[0], '');
  for (const id of ['btnMkdir', 'upMode', 'btnUpload', 'btnMore']) {
    assert(outside.includes('id="' + id + '"'), id + ' 应常显在折叠区之外');
  }
  assert(page.includes('.more{display:contents}'), '桌面端折叠区应为 display:contents（顺序不变）');
  return '折叠区 10 项；常显 新建目录 / 直传 / 上传 / 更多';
});

await check('移动端「更多」可点击展开 / 收起（含按钮文案与 aria）', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);

  const menu = els.get('moreMenu');
  const btn = els.get('btnMore');
  assert(menu && btn, '缺少 moreMenu / btnMore');
  assert(typeof btn.onclick === 'function', 'btnMore 未绑定点击事件');
  assert(!menu.classList.contains('more-open'), '默认应为收起状态');

  btn.onclick();
  assert(menu.classList.contains('more-open'), '点击后应加上 more-open');
  assert(btn.textContent === '更多 ▴', '展开后按钮文案应变化: ' + btn.textContent);

  btn.onclick();
  assert(!menu.classList.contains('more-open'), '再次点击应移除 more-open');
  assert(btn.textContent === '更多 ▾', '收起后文案应还原: ' + btn.textContent);
  return '收起 → 展开（更多 ▴）→ 收起（更多 ▾）';
});

await check('移动端：文件行改为「名称+大小」一行、四个操作按钮整行铺开', async () => {
  const page = await render(env);

  // 桌面端：列宽改用 class 控制，取值与改造前一致
  assert(page.includes('<th class="c-size">大小</th>'), '大小列应改用 class');
  assert(page.includes('<th class="c-time">修改时间</th>'), '修改时间列应改用 class');
  assert(page.includes('<th class="c-act">操作</th>'), '操作列应改用 class');
  assert(page.includes('.c-size{width:110px}.c-time{width:180px}.c-act{width:300px;text-align:right}'), '桌面列宽应保持 110/180/300');
  assert(!page.includes('style="width:110px"') && !page.includes('style="width:300px'), '不应再依赖内联列宽');
  assert(!page.includes('style="text-align:right"'), '仍有内联 text-align:right 残留');
  assert(page.includes('<td class="act">'), '文件行操作单元格未改用 class="act"');

  // 移动端：表头隐藏、修改时间隐藏、按钮整行 flex 铺开
  assert(page.includes('thead{display:none}'), '移动端应隐藏表头');
  assert(page.includes('tbody td:nth-child(3){display:none}'), '移动端应隐藏「修改时间」列');
  assert(page.includes('tbody td.act{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;text-align:left}'), '移动端操作按钮应整行 flex 铺开');
  assert(page.includes('tbody td.act .mini{flex:1 1 72px;min-height:42px'), '移动端按钮应均分宽度且高度 ≥42px');
  // 目录行保持单行：名称 flex:1 占满，删除按钮尾部右对齐（不换行、不两行布局）
  assert(page.includes('tbody tr.dir{display:flex;align-items:center;gap:8px;background:var(--folder)}'), '目录行应为单行 flex 布局');
  assert(page.includes('tbody tr.dir td:first-child{flex:1;min-width:0}'), '目录行名称应占满剩余宽度');
  assert(page.includes('tbody tr.dir td.act{display:block;text-align:right;flex:0 0 auto;grid-column:auto}'), '目录行删除按钮应尾部右对齐且不换行');
  assert(page.includes('tbody td:empty{display:none}'), '空单元格不应占位');
  return '文件两行（按钮铺开）；目录单行（名称占满+删除右对齐）';
});

await check('管理器带「配置CORS」按钮并已绑定处理器', async () => {
  const page = await render(env);
  assert(page.includes('id="btnCors"'), '缺少配置CORS按钮');
  assert(page.includes('call("cors"'), '缺少 CORS API 调用');
  const { sandbox, els, scripts } = buildSandbox(page);
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  assert(typeof els.get('btnCors').onclick === 'function', 'btnCors 未绑定处理器');
  return '按钮 + 处理器就位';
});

await check('管理页目录行不再显示 [DIR]（靠 dir 配色 + 「目录」标签区分）', async () => {
  const page = await render(env);
  assert(!page.includes('[DIR]'), '管理页仍出现 [DIR] 前缀');
  assert(/class=\\?"dir\\?"/.test(page), '目录行应保留 dir 类（配色区分）');
  assert(page.includes('>目录<'), '目录行应保留「目录」标签');
  return '已去掉 [DIR]；保留 dir 配色与「目录」标签';
});

await check('objUrl：公开前缀内生成 /share/<桶>/… 可分享链接，其余 /<桶>/…（复制/下载不再报「未挂载的桶」）', async () => {
  const page = await render(env);
  const m = page.match(/function objUrl\(key\) \{[\s\S]*?\n\}/);
  assert(m, '页面缺少 objUrl 函数定义');
  const sandboxCtx = {
    CFG: { publicPrefix: 'share', bucketFixed: 'my-bucket' },
    location: { origin: 'https://x' },
  };
  const objUrl = vm.runInNewContext(m[0] + '; objUrl', sandboxCtx);
  // 公开前缀 share/ 内 → 别名 URL（匿名可访问、可分享）
  assert(
    objUrl('share/110MB.test') === 'https://x/share/my-bucket/110MB.test',
    '公开文件链接错误: ' + objUrl('share/110MB.test'),
  );
  assert(
    objUrl('share/images/a b.jpg') === 'https://x/share/my-bucket/images/a%20b.jpg',
    '公开子目录文件链接错误: ' + objUrl('share/images/a b.jpg'),
  );
  // 公开前缀外 → 挂载点 URL（管理员经 Worker 访问）
  assert(
    objUrl('docs/x.bin') === 'https://x/my-bucket/docs/x.bin',
    '非公开文件链接错误: ' + objUrl('docs/x.bin'),
  );
  assert(objUrl('a.bin') === 'https://x/my-bucket/a.bin', '根级文件链接错误');
  return 'share/* → /share/my-bucket/*；其余 → /my-bucket/*';
});

await check('默认值来自服务端配置：分片 25 MiB / 并发 3', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  assert(Number(els.get('partSize').value) === 25, 'partSize=' + els.get('partSize').value);
  assert(Number(els.get('conc').value) === 3, 'conc=' + els.get('conc').value);
  assert(els.get('tuneHint') === undefined, 'tuneHint 元素应已移除');
  return '25 MiB / 3（无提示行）';
});

await check('自定义配置生效：分片 8 MiB / 并发 5', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render({ ...env, MULTIPART_PART_SIZE: '8388608', UPLOAD_CONCURRENCY: '5' }));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  assert(Number(els.get('partSize').value) === 8, 'partSize=' + els.get('partSize').value);
  assert(Number(els.get('conc').value) === 5, 'conc=' + els.get('conc').value);
  return '8 MiB / 5';
});

await check('直传通道：分片大小被钳制在 5–95 MiB，空值回落服务端默认', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);

  els.get('partSize').value = '999';
  els.get('partSize').onchange();
  assert(els.get('partSize').value === 95, '上限未钳制: ' + els.get('partSize').value);

  els.get('partSize').value = '1';
  els.get('partSize').onchange();
  assert(els.get('partSize').value === 5, '下限未钳制: ' + els.get('partSize').value);

  els.get('partSize').value = '';
  els.get('partSize').onchange();
  assert(els.get('partSize').value === 25, '空值应回落到服务端默认 25: ' + els.get('partSize').value);

  els.get('partSize').value = 'abc';
  els.get('partSize').onchange();
  assert(els.get('partSize').value === 25, '非法值应回落到服务端默认 25: ' + els.get('partSize').value);
  return '>95→95，<5→5，空/非法→25（服务端默认）';
});

await check('并发数被钳制在 1–10，并写入 localStorage', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);

  els.get('conc').value = '99';
  els.get('conc').onchange();
  assert(Number(els.get('conc').value) === 10, '并发上限未钳制: ' + els.get('conc').value);

  els.get('conc').value = '0.5';
  els.get('conc').onchange();
  assert(Number(els.get('conc').value) === 1, '并发下限未钳制: ' + els.get('conc').value);

  els.get('conc').value = '0';
  els.get('conc').onchange();
  assert(Number(els.get('conc').value) === 3, '空/0 应回落到服务端默认 3: ' + els.get('conc').value);

  const saved = JSON.parse(sandbox.localStorage.getItem('cfb2-tune'));
  assert(Number(saved.conc) === 3, '未持久化并发: ' + JSON.stringify(saved));
  return '>10→10，0.5→1，0→3（默认），已存 ' + JSON.stringify(saved);
});

await check('切到 Worker 代理通道后上限收紧到 90 MiB', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);

  els.get('partSize').value = '95';
  els.get('partSize').onchange();
  assert(els.get('partSize').value === 95, '直传下 95 应被接受');

  els.get('upMode').value = 'worker';
  els.get('upMode').onchange();
  assert(els.get('partSize').value === 90, '切换后未按 MAX_UPLOAD_BYTES 收紧: ' + els.get('partSize').value);
  return '95 → 90 MiB';
});

await check('本机记住的调参在下次打开时回填', async () => {
  const html = await render(env);
  const { sandbox, els, scripts } = buildSandbox(html);
  sandbox.localStorage.setItem('cfb2-tune', JSON.stringify({ part: '64', conc: '6' }));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  assert(els.get('partSize').value === 64, 'partSize=' + els.get('partSize').value);
  assert(els.get('conc').value === 6, 'conc=' + els.get('conc').value);
  return '64 MiB / 6';
});

console.log(failed === 0 ? '\n全部通过 ✅' : '\n失败 ' + failed + ' 项 ❌');
process.exit(failed === 0 ? 0 : 1);
