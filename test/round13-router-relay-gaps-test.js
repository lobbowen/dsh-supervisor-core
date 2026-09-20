#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 第十三轮续：router / relay 域「纪律只在一处执行」类缺陷回归（2026-09-13）
//
// ## 缺陷（全部为失效模式 g，兼 b/e）
//
// ① P1 公网暴露安全闸（必须先设 remoteToken）只在 setFrp 一处执行
//    manager.js::setFrp 有令牌闸 + 端口合法性 + 端口占用校验；
//    而 registry-view.js::patchDshMain **同样能开启 frpEnabled** 却无闸 ——
//    /native/settings 把 body 原样透传（api/domains/native.js）→ 可绕过令牌闸开公网暴露。
//    frpc 以回环身份连 relay，来源闸放行；relay token 为空时 tokenGate 恒放行 → 公网零认证。
//
// ② P1 remoteToken 变更永远到不了已在运行的 relay
//    syncProxy 的「已存在则 return」快路径不重读 remoteToken；applyToken 只处理 dshToken。
//    → 令牌闸已放行，而 relay 进程内 token 仍是空串 → tokenGate 恒放行。
//
// ③ P1 删除供应商/账号/批量删 Key 时 stopInstance 不带 force
//    proxy.js::_canStopInstance 对「ready+可用+被 selected 指向」返回 false →
//    只置 _stopPendingUntilIdle 不 kill；而删除路径随即把账号/实例摘除 →
//    延迟标记不可达 → 进程与端口**永久泄漏**。
//
// ④ P2 实例重启被自身的在用保护吃掉
//    restartInstance 已自行处理在途（写 _restartPending），却又调不带 force 的
//    stopInstance → 被更宽的 _canStopInstance 拦下 → 未 kill、_restartPending 已被清 null、
//    _restartAt 已置 +2min → 自愈链静默失效 2 分钟。
//
// ## 门禁性质：以**源码形态 + 真实构造**为主（这些路径需真实子进程/systemd，无法在
//    无头 CI 完整驱动），但每条都锁定**可证伪的特征调用**与**计数**，且附反向断言防空转。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 剥离整行注释（本仓多次被自己的说明文字骗过）。 */
const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

// ── ① 公网暴露令牌闸必须两条路径同规 ──
console.log('== ① frp 令牌闸两条路径同规 ==');
{
  // ⚠ 2026-09-16 步骤7：patchDshMain/dshMainView 已从 registry-view.js 拆到 app/facade/main.js。
  // ⚠ 2026-09-17 R7：写动作 patchDshMain 再下沉 app/domain-actions/main.js（facade 只读）；
  //   安全闸收敛到 domains/relay/core.validateFrpExposure（app 侧与 relay 侧同一份纯函数）。
  const act = strip(read('src/app/domain-actions/main.js'));
  const mgr = strip(read('src/domains/relay/ops.js'));
  const mgrCore = strip(read('src/domains/relay/core.js'));
  const gateMsg = '开启公网暴露前请先为该实例设置远程访问令牌';
  check('① setFrp 令牌闸经 core.validateFrpExposure（单一事实源，基线）',
    mgrCore.indexOf(gateMsg) >= 0 && /\.validateFrpExposure\(|validateFrpExposure\(/.test(mgr), '有');
  check('① 安全闸有唯一事实源 core.validateFrpExposure（含端口合法性/占用）',
    /function validateFrpExposure\s*\(/.test(mgrCore) && /无效的公网端口/.test(mgrCore) && /已被实例「/.test(mgrCore), '有');
  check('① patchDshMain 调用同一份安全闸（消除重复实现，旧实现无 → 可绕过）',
    /validateFrpExposure\s*\(/.test(act), '有');
  // 反向：闸必须在落盘 **之前**（否则已落盘半改状态）。
  // ⚠ P6-B-3：判据改为**形态无关** —— 实现已由 { methods }+this 改为真 ctor 工厂
  //   （createMainActions(deps)，不再读 this），故不再要求 `this.state.` 前缀，只锁「该写入发生」。
  //   同时把闸的定位由**导入行**改为**调用行**（`validateFrpExposure(`）：原写法 `indexOf('validateFrpExposure')`
  //   命中的是文件头的 require（恒在落盘之前），判据近乎恒真；改为调用行后才是真正的顺序判定。
  const WRITE_MAIN_META = 'writeMainMeta(meta)';
  const iGate = act.indexOf('validateFrpExposure(');
  const iWrite = act.indexOf(WRITE_MAIN_META);
  check('① 闸在落盘之前（不产生半改状态）', iGate > 0 && iWrite > 0 && iGate < iWrite,
    'gate@' + iGate + ' write@' + iWrite);
  // 反向自检（合成样本，不依赖真实数据）：带前缀/裸两形态都命中，缺失时不命中。
  check('① 反向：形态无关判据识别带前缀形态', 'this.state.writeMainMeta(meta);'.indexOf(WRITE_MAIN_META) >= 0, 'hit');
  check('① 反向：形态无关判据识别裸形态', 'state.writeMainMeta(meta);'.indexOf(WRITE_MAIN_META) >= 0, 'hit');
  check('① 反向：缺失该写入时不命中', 'const x = 1;'.indexOf(WRITE_MAIN_META) < 0, 'miss');

  // 行为：真实构造一个 patchDshMain 上下文，断言「无令牌开 frp」被拒
  //  P6-B-3：导出形态改为真 ctor 工厂 createMainActions(deps)（原地去 this）；本处按 deps
  //   注入构造，判据本意（安全闸行为）不变。R7 后模块位于 app/domain-actions/main.js。
  const { createMainActions } = require(path.join(ROOT, 'src', 'app', 'domain-actions', 'main.js'));
  const { installCollaborators } = require(path.join(ROOT, 'src', 'app', 'assembly', 'collaborators'));
  const inst = {};
  installCollaborators(inst);
  const written = [];
  // 级 2：state 已真 ctor 注入——注入点改为协作方方法（不再是 host._readDshMain 薄壳）。
  inst.state.readMainMeta = () => ({ guardian: false, remoteEnabled: false, remoteToken: '', frpEnabled: false, frpRemotePort: null, wanPort: null });
  inst.state.writeMainMeta = (m) => written.push(m);
  inst.dshMainView = () => ({ ok: true });
  // R7：冲突清单改为注入的只读投影（不再直读 instances.instances）
  inst.exposurePeers = () => [];
  inst.config = { stateFile: '/tmp/x.json' };
  inst.logger = { warn() {} };
  inst.events = { append() {} };
  // daemon 用**字面 stub**（非 installCollaborators 的转发器）：与本用例无关，
  //   且不会随 daemons 切面的装配形态（P6-B-1 进行中）漂移。
  const daemons = { enabled: () => false, syncLanState: () => {} };
  const actions = createMainActions({
    getState: () => inst.state, getViews: () => inst.views, getDaemons: () => daemons,
    getEvents: () => inst.events, getLogger: () => inst.logger,
  });
  const bad = actions.patchDshMain({ frpEnabled: true, frpRemotePort: 7001 });
  check('① 行为：无令牌开 frp → 被拒（ok:false）', bad && bad.ok === false, JSON.stringify(bad));
  check('① 行为：被拒时**未落盘**（不产生半改状态）', written.length === 0, String(written.length));
  const badPort = actions.patchDshMain({ remoteToken: 'remote-tok-0123', frpEnabled: true, frpRemotePort: 99999 });
  check('① 行为：令牌已设但端口非法 → 被拒', badPort && badPort.ok === false, JSON.stringify(badPort));
  const good = actions.patchDshMain({ remoteToken: 'remote-tok-0123', frpEnabled: true, frpRemotePort: 7001 });
  check('① 行为：令牌+合法端口 → 通过', good && good.ok === true, JSON.stringify(good));
  check('① 行为：通过时**确实落盘一次**', written.length === 1, String(written.length));
  // 关闭 frp 不应被闸拦（关是安全方向）
  const wBeforeOff = written.length;
  const off = actions.patchDshMain({ frpEnabled: false });
  check('① 行为：关闭 frp 不被闸拦', off && off.ok === true, JSON.stringify(off));
  check('① 行为：关闭 frp 属于合法写（正常落盘一次）',
    written.length === wBeforeOff + 1, 'before=' + wBeforeOff + ' after=' + written.length);
  // C-3（批 4）：弱令牌在**写入口**即拒（与暴露闸同规；此前仅 '非空白' 一票闸）
  //   ⚠ 勘误（第 4 批 run 35484641560：五个 job 同点红、与平台无关）：原断言写死
  //   `written.length === 1`，漏算了**上一条 off 是一次合法落盘**（走到这里已写 2 次）。
  //   回显 `{"weak":{"ok":false,...至少 8 位},"written":2}` 证明产品判得对，是夹具的账算错。
  //   改为相对断言（被拒前后写次数不变）：既保住「拒且未落盘」的牙，也不再钉死前面用例的条数。
  const wBefore = written.length;
  const weak = actions.patchDshMain({ remoteToken: 'tok', frpEnabled: true, frpRemotePort: 7001 });
  check('C-3 行为：4 位令牌 patch main → 写入口即拒（ok:false）', weak && weak.ok === false, JSON.stringify(weak));
  check('C-3 行为：被拒后未再多落一次盘（写次数不变）',
    written.length === wBefore, 'before=' + wBefore + ' after=' + written.length);
}

// ── ② relay 门卫令牌必须可热换 ──
console.log('== ② relay 门卫令牌热换 ==');
{
  // ⚠ 服务本体 index.js → proxy.js（SSOT §5.2）；编排 manager.js → ops.js。
  const rl = strip(read('src/domains/relay/proxy.js'));
  const mgr = strip(read('src/domains/relay/ops.js'));
  check('② createRelay 的 token 是 let（旧为 const，永不变化）',
    /let token = o\.token/.test(rl), 'let');
  check('② 存在 setToken 热换入口', /server\.setToken = /.test(rl), '有');
  check('② 存在 hasToken 只读探针（不回传明文）', /server\.hasToken = /.test(rl), '有');
  // syncProxy 快路径必须下发令牌
  check('② syncProxy 快路径下发令牌（旧实现直接 return）',
    /existing\.token !== want/.test(mgr) && /setToken\(want\)/.test(mgr), '有');

  // ── AUDIT B-1 补链：令牌变更的「触发—复判—收敛」三段缺一不可 ──
  const iops = strip(read('src/domains/instance/ops.js'));
  check('② updateInstance 只改 remoteToken 也必须触发 onRemoteChange（旧仅 remoteEnabled 变化才触发）',
    /inst\.remoteToken !== next/.test(iops) && /remoteChanged && hooks\.onRemoteChange/.test(iops), '有');
  check('② 令牌变更事件仅记 tokenSet 布尔（事件日志零明文）',
    /'inst_remote_token_changed'[^;]*tokenSet/.test(iops) && !/inst_remote_token_changed[^;]*remoteToken:/.test(iops), '有');
  const recSrc = strip(read('src/domains/relay/ops/reconcile.js'));
  check('② reconcile 复判令牌/frp 意图漂移（钩子丢失时唯一兜底收敛点）',
    /proxy\.token !== wantToken/.test(recSrc) && /drifted && proxy\.wanPort/.test(recSrc), '有');
  check('② applyRelayToken 下发令牌后必须 syncFrpc（公网暴露闸依赖 remoteToken，隧道随之收敛）',
    /existing\.token = want;[\s\S]{0,260}host\.syncFrpc\(\)/.test(mgr), '有');

  // 行为：真实 createOps 断言「只改令牌」一条链走通
  const { createOps } = require(path.join(ROOT, 'src', 'domains', 'instance', 'ops.js'));
  const seen = [];
  const it2 = { id: 'i1', name: 'n', port: 29051, guardian: true, remoteEnabled: true, remoteToken: 'tok-a-01234567' };
  const ops2 = createOps({
    store: { instances: [it2], save() {} },
    logger: { warn() {} },
    events: { append(t) { seen.push(t); } },
    hooks: { onRemoteChange(i) { seen.push('sync:' + i.remoteToken); } },
  });
  // C-3（批 4）：弱令牌写入口即拒，且**不改任何字段**（半改状态防线）
  {
    const before = it2.guardian;
    const r = ops2.updateInstance('i1', { guardian: false, remoteToken: 'B' });
    check('C-3 行为：updateInstance 拒 1 位令牌（ok:false）且同补丁其它字段未被改',
      r.ok === false && it2.remoteToken === 'tok-a-01234567' && it2.guardian === before, JSON.stringify(r));
  }
  ops2.updateInstance('i1', { remoteToken: 'tok-b-01234567' });
  check('② 行为：只换令牌（开关不变）即触发 onRemoteChange 且钩子读得到新值', seen.includes('sync:tok-b-01234567'), seen.join(','));
  check('② 行为：变更留痕 inst_remote_token_changed 事件', seen.includes('inst_remote_token_changed'), seen.join(','));
  seen.length = 0;
  ops2.updateInstance('i1', { remoteToken: 'tok-b-01234567' });
  check('② 行为：同值幂等写不再触发钩子/事件（防空转刷屏）',
    !seen.some((x) => x === 'inst_remote_token_changed' || String(x).startsWith('sync:')), seen.join(','));
  ops2.updateInstance('i1', { remoteToken: '' });
  check('② 行为：清空令牌同样触发（暴露闸与隧道必须收到清空信号）', seen.includes('sync:'), seen.join(','));

  // 行为：真实 createRelay，断言 setToken 后门卫生效
  const { createRelay } = require(path.join(ROOT, 'src', 'domains', 'relay', 'index.js'));
  const srv = createRelay('127.0.0.1', 9, { token: '', logger: null });
  check('② 行为：初始空令牌 → hasToken() false（tokenGate 会恒放行）', srv.hasToken() === false, 'false');
  srv.setToken('newtok');
  check('② 行为：setToken 后 hasToken() true（门卫开始生效）', srv.hasToken() === true, 'true');
  srv.setToken('');
  check('② 行为：清空令牌后 hasToken() false', srv.hasToken() === false, 'false');
}

// ── ③ 删除路径必须 force 停实例 ──
console.log('== ③ 删除路径 force 停实例 ==');
{
  // ⚠ 域改造后删除路径编排从 index.js/router-ops.js 收敛到 ops.js（SSOT §5.1）。
  //   按「删除路径所在文件整组」读取（排除 proxy.js 内部的非删除 stopInstance），
  //   文件一搬判据仍覆盖；计数仍是**删除路径**的 force 调用，未放宽。
  const del = strip([
    'index.js', 'router-ops.js', 'ops.js', 'ops/admin.js', 'ops/apps-registry.js',
  ].map((f) => { try { return read(path.join('src', 'domains', 'router', f)); } catch { return ''; } }).join('\n'));
  check('③ removeProvider 对 proxy 实例传 force=true',
    /removed\.stopInstance\(i, true\)/.test(del), '有');
  // 反向：不得再有删除路径用不带 force 的 stopInstance
  check('③ 反向：删除路径不再存在裸 stopInstance(i)',
    !/removed\.instances \|\| \[\]\) removed\.stopInstance\(i\)/.test(del), '已改');
  check('③ setProviderKeys 删除账号传 force=true',
    /p\.stopInstance\(a\.instance, true\)/.test(del), '有');
  check('③ removeProxyKey 删除账号传 force=true',
    /p\.stopInstance\(p\.accounts\[idx\]\.instance, true\)/.test(del), '有');
  // 计数：删除路径的 force 调用应 >= 3（三处删除）
  const forceDeletes = (del.match(/stopInstance\([^)]*, true\)/g) || []).length;
  check('③ 删除路径 force 调用 >= 3 处', forceDeletes >= 3, String(forceDeletes));
}

// ── ④ 重启必须真正停掉进程 ──
console.log('== ④ 重启真正停进程 ==');
{
  const px = strip(read('src/domains/router/providers/proxy.js'));
  check('④ restartInstance 用 force 停实例（旧为不带 force）',
    /this\.stopInstance\(inst, true\)/.test(px), '有');
  // 失败可观测：未能停掉时重新武装待重启并清退避（不静默黑洞 2 分钟）
  check('④ 未能停掉时重新记待重启（不静默）',
    /restart-stop-failed/.test(px), '有');
  check('④ 未能停掉时清退避（避免 2 分钟黑洞）',
    /inst\._restartAt = 0;/.test(px), '有');
}

// ── D-5（AUDIT-2026-09-19 第4批 D）：relay HTML 注入的全量缓冲必须有上限 ──
//   原实现 `chunks.push(c)` 无上限，且 buildForwardHeaders 强制 accept-encoding: identity
//   ⇒ 单个被代理文档按真实字节无界进内存。上限语义：**超限放弃注入并按流透传**，
//   绝不截断（半份 HTML 会把浏览器打穿），也不静默降级（必须 warn）。
console.log('== D-5 relay HTML 注入缓冲上限 ==');
const asyncResults = [];
const acheck = (n, c, x) => {
  asyncResults.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
{
  const rp = read('src/domains/relay/proxy.js');
  const code = strip(rp);
  check('D-5 注入分支不再无上限 push（存在字节累计 + 阈值比较）',
    /total \+= c\.length/.test(code) && /total <= HTML_INJECT_MAX_BYTES/.test(code), 'ok');
  check('D-5 上限常量有显式数值（不是 Infinity/漏省）',
    /const HTML_INJECT_MAX_BYTES = \d+ \* 1024 \* 1024;/.test(code), 'ok');
  check('D-5 超限降级必须留痕（warn）且不得截断输出',
    /超上限|放弃 polyfill/.test(code) && !/chunks\.slice\(0,\s*\d/.test(code), 'ok');
  check('D-5 handleUpstream 作为测试缝导出（回归不依赖真服务）',
    /module\.exports = \{[^}]*handleUpstream[^}]*\}/.test(code), 'ok');
}

const { PassThrough } = require('node:stream');
const relayProxy = require(path.join(ROOT, 'src', 'domains', 'relay', 'proxy.js'));
const runUpstream = (headers, chunks, chunkMs) => new Promise((resolve) => {
  const ur = new PassThrough();
  ur.headers = headers || {};
  ur.statusCode = 200;
  const sent = [], warns = [];
  let endAt = 0;
  const res = {
    headers: null,
    writeHead(c, h) { this.code = c; this.headers = h || {}; },
    write(b) { sent.push(Buffer.from(b)); return true; },
    end(b) { if (b != null) sent.push(Buffer.from(b)); endAt = sent.length; finish(); },
    once() {}, on() {},
  };
  const logger = { warn: (m) => warns.push(String(m)) };
  // 第 4 参是 onStatus（传 null）；响应头走 ur.headers（PassThrough 自定义属性）
  relayProxy.handleUpstream(ur, res, '/index.html', null, logger);
  const finish = () => resolve({ body: Buffer.concat(sent).toString('utf8'), res, warns, endAt });
  (async () => {
    for (const c of chunks) { ur.write(Buffer.from(c)); await new Promise((r) => setTimeout(r, chunkMs || 0)); }
    ur.end();
  })();
});

(async () => {
  {
    const head = '<html><head><title>t</title></head><body>hi</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' }, [head]);
    const polyfills = (r.body.match(/<script/g) || []).length;
    acheck('D-5 小文档：polyfill 仍注入（上限改造没把注入改没）',
      r.body.includes('</head>') && r.body.indexOf('<script') < r.body.indexOf('</head>') && r.body.endsWith('hi</body></html>'),
      'scriptTag=' + polyfills);
    acheck('D-5 小文档：不触发降级告警', r.warns.length === 0, 'warns=' + r.warns.length);
  }
  {
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const marker = 'x'.repeat(1024);
    const big = '<html><head>' + marker.repeat(Math.ceil(CAP / 1024) + 4) + '</head><body>tail</body></html>';
    // 分两块 + 块间延时：越限发生在第二块，其后才是自然 end（贴近真实慢上游）
    const r = await runUpstream({ 'content-type': 'text/html' },
      [big.slice(0, 4096), big.slice(4096)], 2);
    acheck('D-5 超限：按声明长度透传不截断不重复（总字节 == 上游总字节）',
      Buffer.byteLength(r.body) === Buffer.byteLength(big),
      'got=' + Buffer.byteLength(r.body) + ' want=' + Buffer.byteLength(big));
    acheck('D-5 超限：放弃注入（head 后不再插 script）',
      r.body.indexOf('<script') < 0, 'scriptIdx=' + r.body.indexOf('<script'));
    acheck('D-5 超限：降级有 warn 留痕', r.warns.length >= 1, JSON.stringify(r.warns.map((w) => w.slice(0, 60))));
    acheck('D-5 超限：透传后响应自然结束（不挂在未 end 的 chunked 上）',
      r.body.startsWith('<html><head>') && r.body.endsWith('</body></html>'), 'len=' + r.body.length);
  }
  {
    // 单块即越限 + end 抢先到达：后挂的 pipeWithHold 监听器永不触发 ⇒ 必须自收口
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const huge = '<html><head>' + 'y'.repeat(CAP + 10) + '</head><body>z</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' }, [huge], 0);
    acheck('D-5 越限单块：res 仍被结束（readableEnded 自收口分支可达）',
      Buffer.byteLength(r.body) === Buffer.byteLength(huge) && r.endAt > 0,
      'got=' + Buffer.byteLength(r.body) + '/' + Buffer.byteLength(huge) + ' endAt=' + r.endAt);
  }
  {
    // 多块 + 中途越限 + 后续仍有大量块：三段字节都要按序到达（当前块自转写 + 余下由 pipeWithHold 接管）
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const one = 'z'.repeat(1000);
    const doc = '<html><head>' + one.repeat(Math.ceil(CAP / 1000) + 8) + '</head><body>end</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' },
      [doc.slice(0, 1000), doc.slice(1000, 250000), doc.slice(250000)], 1);
    acheck('D-5 中途越限：三段字节按序完整（无丢块、无重复头）',
      Buffer.byteLength(r.body) === Buffer.byteLength(doc)
        && r.body.startsWith('<html><head>') && r.body.endsWith('</head><body>end</body></html>')
        && (r.body.match(/<html>/g) || []).length === 1,
      'got=' + Buffer.byteLength(r.body) + '/' + Buffer.byteLength(doc));
  }
  {
    // 反向对照：阈值必须有限且量级合理（缺陷形态是无上限 push）
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    acheck('D-5 阈值量级合理（>=1MB，远大于壳文档但有限）',
      Number.isFinite(CAP) && CAP >= 1024 * 1024 && CAP <= 16 * 1024 * 1024, 'CAP=' + CAP);
  }

  const failed = results.concat(asyncResults).filter((r) => !r);
  const total = results.length + asyncResults.length;
  console.log('\n结果: ' + (total - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
