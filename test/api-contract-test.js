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
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const API_PORT = 28010;
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

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
    return function () { return { ok: true }; };
  },
});

const { createServer } = require(path.join(ROOT, 'src', 'api', 'index'));
// 外部打开的出口在测试里由网关**构造期注入**（createServer 第二参）：真出口会 spawn 浏览器，
//   而三档结果必须由用例指定才谈得上「端点是否原样透传」。不去 patch 模块导出——那是
//   test-safety-gate A 条记的形态（值绑定是否生效取决于消费方写法，patch 静默失效就跑真实副作用）。
const argvUrls = [];
let owCase = null; // (url) => 三档结果，或 'throw' 模拟出口抛错
const browserCalls = [];
// 探测层清单的契约形状（与 platform/os/browser-inventory.js 的 listBrowsers 产物同字段）：
//   端点只负责原样交出，字段口径由平台层定；这里造一份，钉的是「边界没加工、没丢留痕」。
const BROWSER_INVENTORY = {
  ok: true, platform: 'win32', cached: false,
  default: { id: 'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe', source: 'userchoice' },
  browsers: [
    { id: 'c:\\program files (x86)\\microsoft\\edge\\application\\msedge.exe', name: 'msedge', engine: 'chromium',
      bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', sources: ['userchoice', 'startmenu-catalog'], isDefault: true },
    { id: 'c:\\ff\\firefox.exe', name: 'firefox', engine: 'firefox', bin: 'C:\\FF\\firefox.exe', sources: ['app-paths'], isDefault: false },
  ],
  probed: [{ source: 'userchoice', detail: 'msedge' }, { source: 'app-paths', detail: 'firefox' }],
};
const fakeBrowser = {
  // 只读探测面：端点必须原样交出清单（default/候选/留痕），且不得顺手触到打开出口。
  listBrowsers: (o) => { browserCalls.push(o || {}); return BROWSER_INVENTORY; },
  invalidateBrowsers: () => ({ ok: true }),
  openBrowser: async (url) => {
    argvUrls.push(url);
    if (owCase === 'throw') throw new Error('spawn blew up');
    return owCase(url);
  },
};
const server = createServer(sup, { browser: fakeBrowser });

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
      diagnostics: { platform: 'win32', pick: 'userchoice', bin: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
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

    // OB 组：只读探测面 GET /env/browsers。它是「先知道系统里有什么浏览器，再谈打开」这条标准的界面落点
    //   —— 真机报「没弹出网页」时，这一份清单（默认项来源 + 每条系统查询的留痕）就是定档依据。
    const before = argvUrls.length;
    r = await req('GET', '/env/browsers');
    check('OB 清单端点 200 且字段原样交出（default/候选/留痕三层齐备，边界不加工）',
      r.code === 200 && r.body.ok === true && r.body.platform === 'win32'
      && r.body.default && r.body.default.source === 'userchoice'
      && r.body.browsers.length === 2 && r.body.browsers.filter((b) => b.isDefault).length === 1
      && r.body.browsers.every((b) => Array.isArray(b.sources) && b.sources.length && b.engine)
      && r.body.probed.length === 2, r.code + ' ' + JSON.stringify(r.body));
    check('OB 反向：清单是只读面，一次都没触到打开出口（argv 里不得多出一条地址）',
      argvUrls.length === before, 'openBrowser 调用 ' + (argvUrls.length - before) + ' 次');
    const evilBrowsers = await new Promise((resolve) => {
      const rr = http.request({ host: '127.0.0.1', port: API_PORT, path: '/env/browsers', method: 'GET', headers: { 'Origin': 'http://evil.example', 'Host': '127.0.0.1:' + API_PORT } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      rr.on('error', () => resolve(0)); rr.end();
    });
    check('OB 跨站 Origin 拒绝 403（本机装了哪些浏览器不得被任意网页读走）', evilBrowsers === 403, String(evilBrowsers));
    r = await req('GET', '/env/browsers?force=1');
    check('OB force=1 透传给探测层（刚装/卸载浏览器后绕开探测缓存）',
      r.code === 200 && browserCalls.some((c) => c.force === true), JSON.stringify(browserCalls));
  } finally {
    // 反空转：注入的出口若一次都没被叫到，整组三档断言都只是对着空气判绿。
    check('OW/OU 两组真的驱动了注入出口（出口未被调用即整组空转）', argvUrls.length >= 7, 'calls=' + argvUrls.length);
    check('OB 组真的驱动了探测面（清单端点没被叫到即该组空转）', browserCalls.length >= 2, 'calls=' + browserCalls.length);
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
  serverKey.close();

  server.close();
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
