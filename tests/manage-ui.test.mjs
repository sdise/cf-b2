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
    classList: { add() {}, remove() {}, contains: () => false },
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

  const fetchStub = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ ok: true, files: [], folders: [], truncated: false, nextToken: '' }),
    text: async () => '',
  });

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
  return { sandbox, els, scripts, storage };
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
  B2_KEY_ID: 'k', B2_APPLICATION_KEY: 's', BUCKET_NAME: 'b',
  ADMIN_USER: 'b2', ADMIN_PASS: 'b2',
  MAX_UPLOAD_BYTES: '96000000', MULTIPART_PART_SIZE: '26214400', UPLOAD_CONCURRENCY: '3',
};

/* ---------- 用例 ---------- */

await check('内联脚本可在假 DOM 中完整执行（初始化不抛错）', async () => {
  const { sandbox, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  return scripts.length + ' 个脚本块执行通过';
});

await check('默认值来自服务端配置：分片 25 MiB / 并发 3', async () => {
  const { sandbox, els, scripts } = buildSandbox(await render(env));
  for (const code of scripts) vm.runInNewContext(code, sandbox);
  assert(Number(els.get('partSize').value) === 25, 'partSize=' + els.get('partSize').value);
  assert(Number(els.get('conc').value) === 3, 'conc=' + els.get('conc').value);
  assert(/分片 25 MiB × 并发 3/.test(els.get('tuneHint').textContent), els.get('tuneHint').textContent);
  return els.get('tuneHint').textContent;
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
  assert(/分片 95 MiB/.test(els.get('tuneHint').textContent), els.get('tuneHint').textContent);

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
  assert(/并发 10/.test(els.get('tuneHint').textContent), els.get('tuneHint').textContent);

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
  assert(/上限 90 MiB/.test(els.get('tuneHint').textContent), els.get('tuneHint').textContent);
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
