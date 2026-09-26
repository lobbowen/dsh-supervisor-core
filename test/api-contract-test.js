#!/usr/bin/env node
'use strict';

// 卸载类测试：本脚本含 POST /native/uninstall（控制面板对 DSH 原生卸载）契约断言，
// 已纳入 npm test（CI）自动测试链执行；测试结论只能由 CI 裁决，本地不单独复跑
// （如需排查，可显式执行 node test/api-contract-test.js 或 npm run test:api-contract）。

// API 契约断言测试：对 createServer 的响应对未来回归设防。
// 覆盖审计修复的关键契约：202 异步受理带 ok、key/use 路由 await（Promise 序列化回归）、
// 实例/插件写操作状态码与 ok 字段、open-web 与面板代开端点的外部打开三档结果原样透传（OW/OU 组）。
// 全部用最小 stub Supervisor（Proxy 兜底方法）。外部打开出口经 createServer 第二参在构造期注入假件，
// 因此本文件从不真起浏览器，也不 patch 任何模块导出。

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const API_PORT = 28010;
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

/** 维度名单从内核源码取，不再抄第二份：表单加一维而这里没跟上，正是「新维度悄悄变成摆设」的走法。
 *  X-13 那条钉的是表单自己按分母装配；这里钉的是**边界有没有把每一维原样交出去**，两处分母必须同源。
 *  取不到即抛（不静默降级成一份硬编码名单，那样门禁会在名单变更时自动失效）。 */
const SRC_SECTION_ORDER = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src/platform/os/environment.js'), 'utf8');
  const m = /const SECTION_ORDER = \[([^\]]*)\]/.exec(src);
  if (!m) throw new Error('判据失效：在 platform/os/environment.js 里找不到 SECTION_ORDER 定义');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();

const nativeManager = {
  startInstall: () => ({ ok: true }),
  startUninstall: () => ({ ok: true }),
  upgrade: async () => ({ ok: true }),
  busy: () => false,
  status: () => ({ installed: true, version: '1.0.0', state: 'installed' }),
  versionInfo: () => ({}),
  upgradeStatus: () => ({ state: 'idle' }),
  checkUpdate: async () => ({ ok: true }),
};
// 门面名是 sup.routerApi（api.js 全 router 路由走它）；Proxy get 命中 routerApi 返回此 stub。
// 注：旧 Proxy 曾用 'router' 名——api.js 从未暴露 sup.router，导致 key/use 等路由
// 命中 Proxy 兜底函数 -> 400。20复：对齐真实门面名。
// 真实门面 routerApi() 是方法（supervisor.js:561 this.routerApi() 返回门面对象）——
// Proxy 必须暴露「调用后返回对象」的函数，否则 api.js 里 sup.routerApi().switchToKey() 抛
// 'routerApi is not a function' -> catch -> 400。
const routerApi = () => ({ switchToKey: async () => ({ ok: true, selected: 'k1' }) });
const instances = {
  stopInstance: (id) => ({ ok: true, id: typeof id === 'object' ? id.id : null }),
  // sb1 = 沙箱实例条目：open-web 只对「有真实端口的条目」放行（防开放重定向），main 走 dshMainView。
  list: () => [{ id: 'main', port: 3080, name: '主实例', domain: 'native' }, { id: 'sb1', port: 3099, name: '沙箱实例', domain: 'sandbox' }],
  // DG-11 查询接口（消费方不再直读 .instances.instances）
  find: (id) => [{ id: 'main', port: 3080, name: '主实例', domain: 'native' }, { id: 'sb1', port: 3099, name: '沙箱实例', domain: 'sandbox' }].find((x) => x.id === id),
  all: () => [],
};
const pluginManager = { install: async () => ({ ok: true }) };
const lan = { list: () => ({ items: [], addresses: [] }) };
const tokenService = { get: () => 'dsh-session-token-abc123' };

// 远程访问令牌的边界样本：main 记录带明文（进程内意图字段），API 边界只该在回环交出它。
const MAIN_VIEW = () => ({ id: 'main', name: '主实例', port: 3080, domain: 'native', remoteMode: 'lan', remoteToken: 'lan-gate-token-1' });

// Proxy 兜底：任何未 stub 的方法返回 { ok: true }（route 只取所需字段）
const sup = new Proxy({}, {
  get(t, k) {
    if (k === 'config') return { apiPort: API_PORT, apiHost: '127.0.0.1', command: ['node', 'x'], healthUrl: 'http://127.0.0.1:1/' };
    if (k === 'nativeManager') return nativeManager;
    if (k === 'routerApi') return routerApi;
    if (k === 'instances') return instances;
    if (k === 'dshMainView') return MAIN_VIEW;
    if (k === 'pluginManager') return pluginManager;
    if (k === 'lan') return lan;
    if (k === 'tokenService') return tokenService;
    if (k === 'events') return { readSince: () => [], seq: 0 };
    if (k === 'tasks') return null;
    if (k === 'dist') return { registryInfo: async () => ({ ok: true }) };
    // 外部打开的浏览器偏好：GET 状态与 POST 写入的门面替身（校验与落盘判据不在此处，见 X-12）。
    if (k === 'externalBrowserStatus') return () => BROWSER_PREF;
    if (k === 'setExternalBrowser') return setPref;
    return function () { return { ok: true }; };
  },
});

const { createServer } = require(path.join(ROOT, 'src', 'api', 'index'));
// 外部打开的出口在测试里由网关**构造期注入**（createServer 第二参）：真出口会 spawn 浏览器，
//   而三档结果必须由用例指定才谈得上「端点是否原样透传」。不去 patch 模块导出——那是
//   test-safety-gate A 条记的形态（值绑定是否生效取决于消费方写法，patch 静默失效就跑真实副作用）。
const argvUrls = [];
let owCase = null; // (url) => 三档结果，或 'throw' 模拟出口抛错
const envCalls = [];
// 环境表单的契约形状（与 platform/os/environment.js#form 的产物同字段）：端点只负责原样交出，
//   字段口径由表单定；这里造一份，钉的是「边界没加工、没丢留痕」，不是重新判一遍表单对不对。
const ENVIRONMENT_FORM = {
  schema: 2, at: 1700000000000, cached: false, platform: 'win32',
  identity: { platform: 'win32', arch: 'x64', hostname: 'h', user: 'u', home: 'C:\\Users\\u', node: 'v24' },
  paths: { root: 'C:\\Users\\u\\AppData\\Local\\dsh-supervisor', supervisor: 'C:\\s', shell: 'C:\\k' },
  session: { platform: 'win32', available: true, reason: 'session-scoped-by-launcher' },
  capabilities: { openBrowser: true },
  preference: { id: 'c:\\ff\\firefox.exe', configured: true, matched: true, browser: { id: 'c:\\ff\\firefox.exe', name: 'firefox', engine: 'firefox' }, reason: 'matched' },
  default: { id: 'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe', source: 'userchoice' },
  browsers: [
    { id: 'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe', name: 'msedge', engine: 'chromium',
      bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', baseArgs: [], sources: ['userchoice', 'startmenu-catalog'], isDefault: true },
    { id: 'c:\\ff\\firefox.exe', name: 'firefox', engine: 'firefox', bin: 'C:\\FF\\firefox.exe', baseArgs: [], sources: ['app-paths'], isDefault: false },
  ],
  pick: { how: 'user-preference', id: 'c:\\ff\\firefox.exe', name: 'firefox', wanted: 'c:\\ff\\firefox.exe', stale: false },
  // schema 2 的维度台账：每个维度一条 {label, at, source, state, data, error}，端点原样交出。
  //   这里刻意放三种档位各一条：已判成（runtime/egress）、尚未刷新（dsh pending）、判定为无（browsers empty），
  //   并把带凭据的代理地址以脱敏后的形态放进夹具 —— 边界要交出的是表单的口径，不是它自己再判一遍。
  sections: {
    runtime: { label: '运行时', at: 1700000000000, source: 'registered', state: 'ok', error: null,
      data: { node: 'v24.18.0', npm: '11.0.0', git: null, registry: { origin: 'https://registry.npmjs.org', mode: 'default' }, prefix: 'C:\\npm' } },
    // 桌面壳所见（内核 platform/contract/shell-report.js 的读回）：夹具放「壳报过且读得通」那一档，
    //   并把 reason/ageMs/writtenBy 一起给全 —— 面板要分得清「壳没报」与「报了但读不出」，
    //   这两档的处置相反（一个去刷新、一个去查文件），边界挑掉任一个字段就说不出来。
    shell: { label: '桌面壳所见（Node/npm/镜像源/全局前缀）', at: 1700000000000, source: 'shell', state: 'ok', error: null,
      data: { available: true, reason: 'ok', path: 'C:\\s\\shell-report.json', at: 1699999900000, ageMs: 100000,
        writtenBy: 'dsh-shell 1.2.8', schema: 1,
        node: { path: 'C:\\n\\node.exe', binDir: 'C:\\n', version: 'v22.12.0', min: 'v22.12.0', ok: true },
        npm: { path: 'C:\\n\\node.exe', args: ['C:\\n\\node_modules\\npm\\bin\\npm-cli.js'], version: '10.9.0', ok: true },
        prefix: { dir: 'C:\\Users\\u\\AppData\\Roaming\\npm', writable: true, why: null },
        registry: { best: 'https://registry.npmmirror.com', latencyMs: 88, probesTotal: 2,
          probes: [{ url: 'https://registry.npmjs.org', ok: null, latencyMs: null },
            { url: 'https://registry.npmmirror.com', ok: true, latencyMs: 88 }] },
        records: [{ probe: 'node --version', source: 'shell:spawn', target: 'C:\\n\\node.exe', ms: 30, ok: true, note: '' }],
        droppedRecords: 0 } },
    dsh: { label: 'DSH', at: null, source: 'registered', state: 'pending', data: null, error: null },
    browsers: { label: 'browsers', at: 1700000000000, source: 'self', state: 'ok', data: { count: 2, defaultSource: 'userchoice' } },
    session: { label: 'session', at: 1700000000000, source: 'self', state: 'ok', data: { reason: 'session-scoped-by-launcher' } },
    egress: { label: '出网条件', at: 1700000000000, source: 'self', state: 'ok', error: null,
      data: { at: 1700000000000, proxy: { state: 'on', server: 'http://usr:***@127.0.0.1:7890', pac: null, source: 'registry:Internet Settings', cached: false },
        targets: { 'login.example.test': { ok: false, stage: 'dns', detail: 'ENOTFOUND', at: 1700000000000 } },
        probed: [{ source: 'registry:Internet Settings', detail: 'proxy=on' }] } },
    capabilities: { label: 'capabilities', at: 1700000000000, source: 'self', state: 'ok', data: { openBrowser: true } },
    preference: { label: 'preference', at: 1700000000000, source: 'self', state: 'ok', data: { id: 'c:\\ff\\firefox.exe' } },
    pick: { label: 'pick', at: 1700000000000, source: 'self', state: 'ok', data: { how: 'user-preference' } },
    // 启动既成事实由装配期注册（bootstrap 记、compose/core.js 读进台账），端点只做原样透传：
    //   夹具给满字段，是为了让「边界挑字段」这种漏法当场可见——面板据此才有「这一拍真跑过什么」可说。
    startup: { label: '启动既成事实', at: 1700000000000, source: 'registered', state: 'ok', error: null,
      data: { bootAt: 1699999000000, envDelayMs: 3000, routerAutostart: true, routerMode: 'off',
        updateCheck: { enabled: true, initialDelayMs: 20000, intervalMs: 3600000 }, shellWatchdog: true,
        lastRefresh: { at: 1700000000000, tookMs: 12, browsers: 2, pick: 'user-preference', snapshotWritten: true,
          dims: { runtime: 'ok', dsh: 'ok', egress: 'ok', startup: 'pending' } } } },
  },
  probed: [{ section: 'browsers', source: 'userchoice', detail: 'msedge' }, { section: 'pick', source: 'form', detail: 'user-preference（firefox）' }],
  snapshot: { path: 'C:\\s\\environment.json', written: false, error: null },
};
const fakeBrowser = {
  openBrowser: async (url) => {
    argvUrls.push(url);
    if (owCase === 'throw') throw new Error('spawn blew up');
    return owCase(url);
  },
};
// 表单的假装配：只记调用参数，返回固定形状（真表单要查注册表/摸网络，CI 上既慢又不可预期）。
//   异步维度（运行时/DSH/出网）只由 refresh 那一拍补齐，故替身必须两条口都有：少一条就验不到真正跑的路。
const envRefreshCalls = [];
// 上一拍读回口的替身：两种「没有」各留一次可切换的读数，边界必须原样分档交出而不是揉成一句「没数据」。
let envLastRead = { available: false, path: 'C:\\s\\environment.json', at: null, ageMs: null, reason: 'never-written', data: null };
const envLastCalls = [];
const fakeEnvironment = {
  form: (o) => { envCalls.push(o || {}); return ENVIRONMENT_FORM; },
  refresh: (o) => { envRefreshCalls.push(o || {}); return Promise.resolve(ENVIRONMENT_FORM); },
  lastSnapshot: (o) => { envLastCalls.push(o || {}); return envLastRead; },
};
// 偏好门面（app/settings/browser.js）的替身：本文件只判边界，校验与落盘判据在 X-12 里钉。
const BROWSER_PREF = { ok: true, configured: true, value: 'c:\\ff\\firefox.exe', stale: false, browser: ENVIRONMENT_FORM.browsers[1], candidates: ENVIRONMENT_FORM.browsers, pick: ENVIRONMENT_FORM.pick, platform: 'win32' };
const envPrefCalls = [];
function setPref(id) {
  envPrefCalls.push(id);
  return id === 'c:\\ff\\firefox.exe' || id === ''
    ? { ok: true, configured: !!id, value: id || null }
    : { ok: false, error: '该浏览器不在本机候选清单里（可能已卸载或路径失效），请先刷新环境表单' };
}
const server = createServer(sup, { browser: fakeBrowser, environment: fakeEnvironment });

// 本机非回环 IPv4（P0-1 结构修复后的真实 LAN 身份来源：socket 层，不再伪造 Host 头）
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const LAN_IP = (() => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) { if (i.family === 'IPv4' && !i.internal) return i.address; }
  }
  return null;
})();

function req(method, p, body, hostHeader, extraHeaders, via) {
  return new Promise((resolve) => {
    const connectHost = via === 'lan' && LAN_IP ? LAN_IP : '127.0.0.1';
    const hh = hostHeader || (connectHost + ':' + API_PORT);
    const r = http.request({
      host: connectHost, port: API_PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:' + API_PORT, 'Host': hh, 'Content-Length': body ? Buffer.byteLength(body) : 0 }, extraHeaders || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, body: { raw: b } }); } });
    });
    r.on('error', (e) => resolve({ code: 0, body: { error: e.message } }));
    if (body) r.write(body);
    r.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(API_PORT, '0.0.0.0', r)); // 绑 0.0.0.0 支持真实 LAN socket 用例

  // 202 异步受理契约（审计 1.5 修复：ok:true 必须存在，前端 if(r.ok===false) 判定）
  let r = await req('POST', '/native/install', JSON.stringify({}));
  check('POST /native/install → 202 且 ok:true', r.code === 202 && r.body.ok === true && r.body.accepted === true, r.code + ' ' + JSON.stringify(r.body));
  r = await req('POST', '/native/upgrade', JSON.stringify({}));
  check('POST /native/upgrade → 202 且 ok:true', r.code === 202 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  r = await req('POST', '/native/uninstall', JSON.stringify({}));
  check('POST /native/uninstall → 202 且 ok:true', r.code === 202 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // key/use await 契约（审计修复：async 方法必须 await，防 Promise 序列化 {} 回归）
  r = await req('POST', '/router/providers/key/use', JSON.stringify({ id: 'p1', fingerprint: 'k1' }));
  check('POST key/use → 200 且 selected 透传', r.code === 200 && r.body.ok === true && r.body.selected === 'k1', r.code + ' ' + JSON.stringify(r.body));

  // 写操作 ok 契约
  r = await req('POST', '/instances/stop', JSON.stringify({ id: 'i1' }));
  check('POST /instances/stop → 200 且 ok:true', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  r = await req('POST', '/plugins/install', JSON.stringify({ spec: '@x/p' }));
  check('POST /plugins/install → 200 且 ok:true', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));

  // OW 组：open-web 把内核外部打开的三档结果**原样**交给面板（confirmed / handedOff / ok:false）。
  //   病根即此端点：旧实现只要 spawn 没抛错就 send 200 ok:true，屏幕上什么都没有却显示成功。
  const CONFIRMED = (url) => ({ ok: true, confirmed: true, handedOff: false, reason: null, error: null, message: '已在系统浏览器打开', url, evidence: { bin: 'xdg-open', via: 'dispatcher', ownsWindow: true, exitCode: 0, exitSignal: null, error: null } });
  try {
    owCase = CONFIRMED;
    r = await req('POST', '/instances/open-web', JSON.stringify({ id: 'sb1' }));
    check('OW 成功档（confirmed）→ 200 且三档字段原样在场',
      r.code === 200 && r.body.ok === true && r.body.confirmed === true && r.body.handedOff === false
      && r.body.message === '已在系统浏览器打开' && r.body.url === argvUrls[0],
      r.code + ' ' + JSON.stringify(r.body));
    check('OW 交给浏览器的地址只带一次性码、不带会话令牌（令牌进 argv 即同机可读）',
      /\/open\?code=[0-9a-f-]{20,}$/.test(argvUrls[0]) && !/token=/.test(argvUrls[0]), argvUrls[0]);
    const firstCode = argvUrls[0];
    r = await req('POST', '/instances/open-web', JSON.stringify({ id: 'sb1' }));
    check('OW 每次调用重新签发一次性码（成功路径不烧码：码要留给浏览器回 /open 换 cookie）', argvUrls[1] !== firstCode && r.code === 200, argvUrls[1]);

    // Windows 真机那一档：探测解析到默认浏览器本体后直启，其退出码在两个方向都不作证据
    //   （explorer.exe 兜底已删除；直启可被既有实例吸收，故非 0 也不判失败）。
    //   diagnostics 是「为什么没弹出」的唯一现场证据，端点不得把它裁掉。
    owCase = (url) => ({ ok: true, confirmed: false, handedOff: true, reason: null, error: null, message: '已把地址交给系统，但没拿到窗口出现的证据', url, evidence: {
      bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', engine: 'chromium', via: 'browser', ownsWindow: false,
      exitCode: 1, exitSignal: null, error: null,
      diagnostics: { pick: 'userchoice',
        default: { id: 'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe', source: 'userchoice' },
        found: [{ name: 'msedge', engine: 'chromium', via: 'userchoice+startmenu-catalog' }],
        probed: [{ source: 'userchoice', detail: 'msedge' }] } } });
    r = await req('POST', '/instances/open-web', JSON.stringify({ id: 'sb1' }));
    check('OW 移交档（win32 直启探测到的默认浏览器，非 0 退出仍不作证据）→ 200 但 confirmed:false，面板据此不说「已打开」',
      r.code === 200 && r.body.ok === true && r.body.confirmed === false && r.body.handedOff === true
      && /msedge\.exe$/.test(r.body.evidence.bin) && r.body.evidence.ownsWindow === false && r.body.evidence.exitCode === 1,
      JSON.stringify(r.body));
    check('OW 把探测留痕（diagnostics 的 pick/found/default）原样交给面板 —— 真机报障据此定档',
      !!r.body.evidence.diagnostics && r.body.evidence.diagnostics.pick === 'userchoice'
      && r.body.evidence.diagnostics.found.length === 1
      && r.body.evidence.diagnostics.default.source === 'userchoice', JSON.stringify(r.body.evidence.diagnostics));

    owCase = (url) => ({ ok: false, confirmed: false, handedOff: false, reason: 'no-launcher', error: '未找到可用的浏览器启动命令，请手动打开该地址', message: null, url, evidence: { bin: 'xdg-open', via: 'dispatcher', exitCode: null, exitSignal: null, error: null } });
    r = await req('POST', '/instances/open-web', JSON.stringify({ id: 'sb1' }));
    const failUrl = argvUrls[argvUrls.length - 1];
    check('OW 失败档 → 非 2xx（不得恒 200）且带 reason/error',
      r.code === 500 && r.body.ok === false && r.body.reason === 'no-launcher' && !!r.body.error, r.code + ' ' + JSON.stringify(r.body));
    check('OW 失败响应把地址交回面板（用户仍可复制手动打开）', r.body.url === failUrl, String(r.body.url));
    const dead = await new Promise((resolve) => {
      const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: failUrl.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), method: 'GET', headers: { Origin: 'http://127.0.0.1:' + API_PORT, Host: '127.0.0.1:' + API_PORT } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ code: res.statusCode, text: b })); });
      rr.on('error', (e) => resolve({ code: 0, text: String(e) }));
      rr.end();
    });
    check('OW 反向：打开失败即作废该一次性码（残留可用码 = 给一次从未发生的浏览留门）',
      dead.code === 400 && /授权码无效或已过期/.test(dead.text), dead.code + ' ' + dead.text);

    owCase = 'throw';
    r = await req('POST', '/instances/open-web', JSON.stringify({ id: 'sb1' }));
    check('OW 出口抛错也回结构化 500（不能让请求挂死或回 200），且地址仍在场',
      r.code === 500 && r.body.ok === false && r.body.reason === 'spawn-failed' && !!r.body.url, r.code + ' ' + JSON.stringify(r.body));

    // OU 组：面板代开端点与 open-web 同一出口、同一状态码语义。它是壳内面板唯一的活路
    //   （webview 丢弃 window.open 与 target=_blank），本组失配即那条按钮又回到无人应答的形态。
    owCase = CONFIRMED;
    r = await req('POST', '/env/open-url', JSON.stringify({ url: 'http://127.0.0.1:3099/' }));
    check('OU 成功档 → 200 且三档字段原样在场（本域不重造结果）',
      r.code === 200 && r.body.ok === true && r.body.confirmed === true && r.body.evidence.bin === 'xdg-open',
      r.code + ' ' + JSON.stringify(r.body));
    check('OU 地址原样交给出口（面板给什么就开什么，端点不加工 URL）',
      argvUrls[argvUrls.length - 1] === 'http://127.0.0.1:3099/', String(argvUrls[argvUrls.length - 1]));
    r = await req('POST', '/env/open-url', JSON.stringify({}));
    check('OU 缺 url → 400（空地址不得走到出口，也不得回 200）', r.code === 400 && r.body.ok === false, r.code + ' ' + JSON.stringify(r.body));
    owCase = (url) => ({ ok: false, confirmed: false, handedOff: false, reason: 'no-launcher', error: '未找到可用的浏览器启动命令，请手动打开该地址', message: null, url, evidence: null });
    r = await req('POST', '/env/open-url', JSON.stringify({ url: 'http://a.b/' }));
    check('OU 失败档 → 500 且 reason/url 一起到场（面板据此给复制入口）',
      r.code === 500 && r.body.ok === false && r.body.reason === 'no-launcher' && r.body.url === 'http://a.b/',
      r.code + ' ' + JSON.stringify(r.body));
    owCase = 'throw';
    r = await req('POST', '/env/open-url', JSON.stringify({ url: 'http://a.b/' }));
    check('OU 出口抛错 → 结构化 500 且地址仍在场',
      r.code === 500 && r.body.reason === 'spawn-failed' && r.body.url === 'http://a.b/', r.code + ' ' + JSON.stringify(r.body));

    // EF 组：只读装配面 GET /env/environment。它是「先把本机情况摊开，再谈打开」这条标准的界面落点
    //   —— 真机报「没弹出网页」时，这一份表单（候选 + 默认项来源 + 分发依据 + 每条查询留痕）就是定档依据。
    const before = argvUrls.length;
    r = await req('GET', '/env/environment');
    check('EF 表单端点 200 且字段原样交出（候选/默认/偏好/分发依据/留痕五层齐备，边界不加工）',
      r.code === 200 && r.body.platform === 'win32' && r.body.schema === 2
      && r.body.default && r.body.default.source === 'userchoice'
      && r.body.browsers.length === 2 && r.body.browsers.filter((b) => b.isDefault).length === 1
      && r.body.browsers.every((b) => Array.isArray(b.sources) && b.sources.length && b.engine)
      && r.body.preference.configured === true && r.body.preference.matched === true
      && r.body.pick.how === 'user-preference' && r.body.probed.length === 2, r.code + ' ' + JSON.stringify(r.body));
    // 维度台账是 schema 2 的全部意义：面板要在一处看完「本机实况 + 每条结论的来路与新鲜度」。
    //   边界要是挑字段回传，异步维度就会静默消失（面板显示成「本机没有」而不是「尚未探测」）。
    const secs = r.body.sections || {};
    check('EF 交出整张维度台账（名单取自内核 SECTION_ORDER，任一维在边界消失即红；未刷新那维 at 为 null）',
      SRC_SECTION_ORDER.length >= 10
        && SRC_SECTION_ORDER.every((id) => secs[id] && typeof secs[id].state === 'string'
          && typeof secs[id].source === 'string' && typeof secs[id].label === 'string')
        && Object.keys(secs).length === SRC_SECTION_ORDER.length
        && secs.dsh.state === 'pending' && secs.dsh.at === null && secs.runtime.state === 'ok',
      JSON.stringify({ order: SRC_SECTION_ORDER, keys: Object.keys(secs).map((id) => [id, secs[id].state, secs[id].at]) }));
    check('EF 壳上报维连 reason/ageMs 一起交出（「壳没报」与「报了读不出」处置相反，缺一个字段面板就说错话）',
      secs.shell.data.available === true && secs.shell.data.reason === 'ok'
        && secs.shell.data.ageMs === 100000 && secs.shell.data.writtenBy === 'dsh-shell 1.2.8'
        && secs.shell.data.node.version === 'v22.12.0' && secs.shell.data.npm.args.length === 1
        && secs.shell.data.registry.probes[0].ok === null && secs.shell.data.records.length === 1,
      JSON.stringify(secs.shell && secs.shell.data));
    check('EF 代理地址的凭据在边界外仍为脱敏形态（表单是唯一的抹除处，端点再拼一遍就会把两份口径都弄错）',
      secs.egress.data.proxy.server === 'http://usr:***@127.0.0.1:7890'
        && !/pwd/.test(JSON.stringify(secs.egress)), JSON.stringify(secs.egress && secs.egress.data));
    check('EF 反向：表单是只读面，一次都没触到打开出口（argv 里不得多出一条地址）',
      argvUrls.length === before, 'openBrowser 调用 ' + (argvUrls.length - before) + ' 次');
    const evilEnv = await new Promise((resolve) => {
      const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: '/env/environment', method: 'GET', headers: { 'Origin': 'http://evil.example', 'Host': '127.0.0.1:' + API_PORT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      rr.on('error', () => resolve(0)); rr.end();
    });
    check('EF 跨站 Origin 拒绝 403（本机装了哪些浏览器、用什么打开不得被任意网页读走）', evilEnv === 403, String(evilEnv));
    r = await req('GET', '/env/environment?force=1');
    check('EF force=1 走异步刷新那一拍并落快照（只重跑同步表单等于异步维度永远刷不出来）',
      r.code === 200 && envRefreshCalls.length === 1
        && envRefreshCalls[0].force === true && envRefreshCalls[0].persist === true, JSON.stringify(envRefreshCalls));
    check('EF 反向：常态读取既不触发刷新也不写盘（面板轮询不得每次重探系统、反复写盘）',
      envRefreshCalls.length === 1 && envCalls.length === 1 && !envCalls[0].force && !envCalls[0].persist,
      JSON.stringify({ refresh: envRefreshCalls, form: envCalls }));
    check('EF 启动维度原样透传到台账（后端记了既成事实而边界挑掉字段，面板就只剩「未探测」可说）',
      secs.startup.data.lastRefresh.snapshotWritten === true && secs.startup.data.routerMode === 'off'
      && secs.startup.data.updateCheck.enabled === true && secs.startup.data.lastRefresh.dims.dsh === 'ok',
      JSON.stringify(secs.startup && secs.startup.data));

    // EL 组：上一拍快照的只读回看口。它存在的唯一理由是「留痕要能被读回来」，故判据只有三件事：
    //   整份原样交出、两种「没有」分得开、跨站同样拒读；且全程不碰装配也不写盘。
    const beforeLast = { form: envCalls.length, refresh: envRefreshCalls.length };
    r = await req('GET', '/env/environment/last');
    check('EL 没落过盘要说成 never-written（它与「读不出」是两种处置：一个去刷新、一个去查文件）',
      r.code === 200 && r.body.available === false && r.body.reason === 'never-written' && r.body.data === null,
      r.code + ' ' + JSON.stringify(r.body));
    envLastRead = { available: true, path: 'C:\\s\\environment.json', at: 1699999999000, ageMs: 1000, reason: 'ok',
      data: { schema: 2, at: 1699999999000, sections: { startup: { state: 'ok' } }, pick: { how: 'candidate-rank' } } };
    r = await req('GET', '/env/environment/last');
    check('EL 有留痕时整份上一拍表单原样交出（挑字段回传等于把排障要的那条事实删掉）',
      r.code === 200 && r.body.available === true && r.body.ageMs === 1000
      && r.body.data.pick.how === 'candidate-rank' && r.body.data.sections.startup.state === 'ok',
      r.code + ' ' + JSON.stringify(r.body.data && r.body.data.pick));
    const evilLast = await new Promise((resolve) => {
      const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: '/env/environment/last', method: 'GET', headers: { 'Origin': 'http://evil.example', 'Host': '127.0.0.1:' + API_PORT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      rr.on('error', () => resolve(0)); rr.end();
    });
    check('EL 跨站 Origin 同样 403（上一拍本机装了哪些浏览器同样是本机事实）', evilLast === 403, String(evilLast));
    check('EL 反向：读回口既不装配表单也不落盘（掺进装配即拿旧数据冒充当拍结论）',
      envCalls.length === beforeLast.form && envRefreshCalls.length === beforeLast.refresh && envLastCalls.length === 2,
      JSON.stringify({ form: envCalls.length, refresh: envRefreshCalls.length, last: envLastCalls.length }));

    // PR 组：浏览器偏好的读写边界。判据（id 必须是本机候选）住在表单，本组只钉边界三件事：
    //   GET 原样交出状态、POST 缺字段=400 不走到门面、门面判失败=500 而不是把失败说成成功。
    r = await req('GET', '/settings/external-browser');
    check('PR GET 交出当前偏好 + 候选清单 + 这一拍的分发依据（面板据此说明「现在实际会用谁」）',
      r.code === 200 && r.body.ok === true && r.body.value === 'c:\\ff\\firefox.exe'
      && r.body.candidates.length === 2 && r.body.pick.how === 'user-preference', r.code + ' ' + JSON.stringify(r.body));
    const prBefore = envPrefCalls.length;
    r = await req('POST', '/settings/external-browser', JSON.stringify({ id: 'c:\\ff\\firefox.exe' }));
    check('PR POST 命中候选 → 200 且写入门面一次（空串以外的值必须经校验）',
      r.code === 200 && r.body.ok === true && r.body.configured === true && envPrefCalls.length === prBefore + 1,
      r.code + ' ' + JSON.stringify(r.body));
    r = await req('POST', '/settings/external-browser', JSON.stringify({ id: '' }));
    check('PR POST 空串=清除偏好 → 200 且 configured:false（清除与拒写是两种语义，不得都回 400）',
      r.code === 200 && r.body.ok === true && r.body.configured === false, r.code + ' ' + JSON.stringify(r.body));
    const rejectBefore = envPrefCalls.length;
    r = await req('POST', '/settings/external-browser', JSON.stringify({ id: 'C:\\nope.exe' }));
    check('PR POST 非候选 id → 500 且带 error（写下去也不会生效，必须当场说清楚）',
      r.code === 500 && r.body.ok === false && !!r.body.error, r.code + ' ' + JSON.stringify(r.body));
    // 拒写的判据只有一份（门面上的 checkPreference）：边界要是自己抄一份，两处判据迟早分叉。
    //   所以这一档必须真的走到门面一次，再由门面把「不在候选里」说回来。
    check('PR 非候选 id 确实走到门面判据一次（边界不自己复述拒写理由）',
      envPrefCalls.length === rejectBefore + 1, 'calls=' + envPrefCalls.length);
    const missingBefore = envPrefCalls.length;
    r = await req('POST', '/settings/external-browser', JSON.stringify({}));
    check('PR 反向：缺 id 字段 → 400 且一次都没写（漏字段不得被当成清除偏好）',
      r.code === 400 && r.body.ok === false && envPrefCalls.length === missingBefore, r.code + ' ' + envPrefCalls.length);
  } finally {
    // 反空转：注入的出口若一次都没被叫到，整组三档断言都只是对着空气判绿。
    check('OW/OU 两组真的驱动了注入出口（出口未被调用即整组空转）', argvUrls.length >= 7, 'calls=' + argvUrls.length);
    check('EF/PR 两组真的驱动了表单与偏好门面（一次都没被叫到即该组空转）',
      envCalls.length + envRefreshCalls.length >= 2 && envPrefCalls.length >= 2,
      'form=' + envCalls.length + ' refresh=' + envRefreshCalls.length + ' pref=' + envPrefCalls.length);
  }

  // 跨站 Origin 仍拒绝（安全契约不回归）
  r = await req('POST', '/instances/stop', JSON.stringify({ id: 'i1' }));
  const evil = await new Promise((resolve) => {
    const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: '/instances/stop', method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'http://evil.example', 'Host': '127.0.0.1:' + API_PORT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    rr.on('error', () => resolve(0));
    rr.write(JSON.stringify({ id: 'i1' })); rr.end();
  });
  check('跨站 Origin 写请求拒绝 403', evil === 403, String(evil));

  // 代开端点同受 CSRF 闸约束：任意网页对 127.0.0.1 的一次单击就能在用户机器上弹浏览器，
  //   那是白送的动作面，不是产品能力。
  const evilOpen = await new Promise((resolve) => {
    const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: '/env/open-url', method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': 'http://evil.example', 'Host': '127.0.0.1:' + API_PORT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    rr.on('error', () => resolve(0));
    rr.write(JSON.stringify({ url: 'http://evil.example/' })); rr.end();
  });
  check('跨站 Origin 的 /env/open-url 拒绝 403', evilOpen === 403, String(evilOpen));

  // F1 授权收口契约：/instances 的 authUrl 仅回环 Host 请求带 DSH token，
  // LAN 分支的语义已在 P3-C（fail-closed，FIX-1 B2 执行侧）变更：
  //   原契约「LAN/私网访问 200 放行但不下发 token」是**漏洞形态** —— 未配置 apiAccessKey 时
  //   整层鉴权被跳过，LAN 上任意设备可零认证驱动写 API；现为「LAN 未配置密钥一律 401」。
  //   故 F1 的 LAN 分支断言 401；「token 永不出本机」这条安全属性**转移**到 F2 的已认证 LAN 路径
  //   （带正确 key 请求 /instances -> 200 且不下发 token）——覆盖面不因修漏洞而丢失。
  // 概念清分：响应拆两级——instances[]=沙箱、native=原生主干 main；F1 对 main（native 字段）断言。
  let instR = await req('GET', '/instances');
  const instLoopback = instR.body.native;
  check('F1 回环 Host /instances 下发含 token authUrl', !!instLoopback && instLoopback.authUrl.indexOf('token=dsh-session-token-abc123') >= 0 && instLoopback.tokenPresent === true, JSON.stringify(instLoopback && instLoopback.authUrl));
  // 远程访问令牌的明文与 DSH 会话令牌同判据（回环才交）：本机面板的「查看/修改令牌」闭环靠它，
  // 而 tokenSet 布尔对所有来源在场——放宽的是本机的呈现形态，不是可达面。
  check('F1 回环 /instances 下发 remoteToken 明文 + tokenSet',
    !!instLoopback && instLoopback.remoteToken === 'lan-gate-token-1' && instLoopback.tokenSet === true,
    JSON.stringify(instLoopback && { r: instLoopback.remoteToken, s: instLoopback.tokenSet }));
  instR = LAN_IP ? await req('GET', '/instances', null, LAN_IP + ':' + API_PORT, null, 'lan') : { code: 0, body: {} };
  check('F1 LAN（真实非回环 socket）未配置密钥 → 401（fail-closed）',
    !LAN_IP || instR.code === 401, LAN_IP ? (instR.code + '') : '（无 LAN 地址，跳过）');

  // F2 出回环访问密钥契约：配置 apiAccessKey 后，LAN/私网 Host 请求必须带
  // Authorization: Bearer <key> 或 ?access_key=<key>（401 否则）；回环 Host 豁免（CLI/面板语义）。
  const KEY = 'test-access-key-123456';
  const KEY_PORT = API_PORT + 1;
  const supKey = new Proxy({}, {
    get(t, k) {
      if (k === 'config') return { apiPort: KEY_PORT, apiHost: '127.0.0.1', command: ['node', 'x'], healthUrl: 'http://127.0.0.1:1/', apiAccessKey: KEY };
      if (k === 'nativeManager') return nativeManager;
      if (k === 'router') return router;
      if (k === 'instances') return instances;
      if (k === 'dshMainView') return MAIN_VIEW;
      if (k === 'pluginManager') return pluginManager;
      if (k === 'lan') return lan;
      if (k === 'tokenService') return tokenService;
      if (k === 'events') return { readSince: () => [], seq: 0 };
      if (k === 'tasks') return null;
      if (k === 'dist') return { registryInfo: async () => ({ ok: true }) };
      return function () { return { ok: true }; };
    },
  });
  const serverKey = createServer(supKey);
  await new Promise((res2) => serverKey.listen(KEY_PORT, '0.0.0.0', res2)); // 绑 0.0.0.0 支持真实 LAN socket 用例
  function reqKey(method, p, hostHeader, extraHeaders, via) {
    return new Promise((resolve) => {
      const connectHost = via === 'lan' && LAN_IP ? LAN_IP : '127.0.0.1';
      const hh = hostHeader || (connectHost + ':' + KEY_PORT);
      const r = http.request({
        host: connectHost, port: KEY_PORT, path: p, method,
        headers: Object.assign({ 'Content-Type': 'application/json', 'Host': hh }, extraHeaders || {}),
      }, (res2) => {
        let b = '';
        res2.on('data', (c) => (b += c));
        res2.on('end', () => { try { resolve({ code: res2.statusCode, body: JSON.parse(b) }); } catch { resolve({ code: res2.statusCode, body: { raw: b } }); } });
      });
      r.on('error', (e) => resolve({ code: 0, body: { error: e.message } }));
      r.end();
    });
  }
  let kr = await reqKey('GET', '/status', null, null, 'lan');
  check('F2 LAN（真实非回环 socket）GET 无 key → 401', kr.code === 401, kr.code + ' ' + JSON.stringify(kr.body));
  kr = await reqKey('GET', '/status', null, { Authorization: 'Bearer ' + KEY }, 'lan');
  check('F2 LAN Bearer 正确 → 放行 200', kr.code === 200, kr.code + '');
  kr = await reqKey('GET', '/status', null, { Authorization: 'Bearer wrong-key' }, 'lan');
  check('F2 LAN Bearer 错误 → 401', kr.code === 401, kr.code + '');
  kr = await reqKey('GET', '/status?access_key=' + KEY, null, null, 'lan');
  check('F2 LAN ?access_key= 正确 → 放行 200', kr.code === 200, kr.code + '');
  kr = await reqKey('GET', '/status'); // 默认 127.0.0.1 连接 = socket 回环身份
  check('F2 回环身份豁免（无 key 放行）', kr.code === 200, kr.code + '');
  // 自 F1 转移而来的安全属性：**已认证**的 LAN 路径上，响应仍不得包含 DSH token。
  //   （原断言依赖「LAN 未认证也能 200」这一漏洞前提；现改在带 key 的合法路径上验证。）
  kr = await reqKey('GET', '/instances', null, { Authorization: 'Bearer ' + KEY }, 'lan');
  const instLanAuthed = kr.body && kr.body.native;
  check('F2 已认证 LAN GET /instances → 200 且不下发 token（安全属性转移自 F1）',
    !LAN_IP || (kr.code === 200 && !!instLanAuthed && instLanAuthed.authUrl.indexOf('token=') < 0 && instLanAuthed.tokenPresent === false),
    LAN_IP ? (kr.code + ' ' + JSON.stringify(instLanAuthed && instLanAuthed.authUrl)) : '（无 LAN 地址，跳过）');
  // 远程访问令牌明文与 DSH 会话令牌共用同一条回环判据：LAN 侧即使已带 access key 认证，
  // 也只见到 tokenSet 布尔——明文出本机是面板「查看/修改凭据」闭环的唯一理由，不是可达面。
  check('F2 已认证 LAN GET /instances → 有 tokenSet 布尔但零 remoteToken 明文',
    !LAN_IP || (kr.code === 200 && !!instLanAuthed && instLanAuthed.tokenSet === true
      && instLanAuthed.remoteToken === undefined
      && JSON.stringify(instLanAuthed).indexOf('lan-gate-token-1') < 0),
    LAN_IP ? JSON.stringify(instLanAuthed) : '（无 LAN 地址，跳过）');
  // 代开端点的回环闸：已认证 LAN 访客的浏览器不在这台机器上，请内核开浏览器既无用又是白送的动作面。
  //   面板据同一判据（页面来源是否回环）改走访客自己的 window.open，故这里必须如实拒绝而非静默成功。
  kr = await reqKey('POST', '/env/open-url', null, { Authorization: 'Bearer ' + KEY }, 'lan');
  check('OU 非回环来源 → 403 且给出可复制地址的说法',
    !LAN_IP || (kr.code === 403 && kr.body.ok === false && /复制/.test(String(kr.body.error))),
    LAN_IP ? (kr.code + ' ' + JSON.stringify(kr.body)) : '（无 LAN 地址，跳过）');
  // 来源闸的不对称只有这一处判据能回答：表单端点不带回环闸是有意设计——远程访客的面板也要能
  //   看到内核探到了什么（否则报障只剩口述）；动作端点必须加回环闸。上面那条 403 钉了动作面，这条钉读面。
  kr = await reqKey('GET', '/env/environment', null, { Authorization: 'Bearer ' + KEY }, 'lan');
  check('EF 已认证非回环来源 GET /env/environment → 200（只读面与动作面的来源闸不同级）',
    !LAN_IP || kr.code === 200,
    LAN_IP ? String(kr.code) : '（无 LAN 地址，跳过）');
  serverKey.close();

  server.close();
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
