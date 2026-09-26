#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 第十三轮续：router / relay 域「纪律只在一处执行」类缺陷回归
//
// ## 缺陷（全部为失效模式 g，兼 b/e）
//
// 1) P1 公网（wan）安全闸（必须先设 remoteToken）历史上只在 setFrp 一处执行
//    旧设置面 patchDshMain 同样能开启 frpEnabled 却无闸 -> 可绕过令牌闸开公网暴露。
//    三态化收口后：意图唯一写入口 setRemoteMode（lan 模式同闸口），wan 前置闸
//    = core.validateWanAccess（单一事实源）；patchDshMain 白名单只剩 guardian，绕道物理消失；
//    frpc 执行边界（syncFrpc）再复判一次，冷启动只落盘路径也绕不过。
//
// 2) P1 remoteToken 变更永远到不了已在运行的 relay
//    syncProxy 的「已存在则 return」快路径不重读 remoteToken；applyToken 只处理 dshToken。
//    -> 令牌闸已放行，而 relay 进程内 token 仍是空串 -> tokenGate 恒放行。
//
// 3) P1 删除供应商/账号/批量删 Key 时 stopInstance 不带 force
//    proxy.js::_canStopInstance 对「ready+可用+被 selected 指向」返回 false ->
//    只置 _stopPendingUntilIdle 不 kill；而删除路径随即把账号/实例摘除 ->
//    延迟标记不可达 -> 进程与端口**永久泄漏**。
//
// 4) P2 实例重启被自身的在用保护吃掉
//    restartInstance 已自行处理在途（写 _restartPending），却又调不带 force 的
//    stopInstance -> 被更宽的 _canStopInstance 拦下 -> 未 kill、_restartPending 已被清 null、
//    _restartAt 已置 +2min -> 自愈链静默失效 2 分钟。
//
// ## 门禁性质：以**源码形态 + 真实构造**为主（这些路径需真实子进程/systemd，无法在
//    无头 CI 完整驱动），但每条都锁定**可证伪的特征调用**与**计数**，且附反向断言防空转。
// ---------------------------------------------------------------------------

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

// -- 1) wan 前置闸唯一事实源 + 唯一写入口 + 设置面无绕道 --
console.log('== ① 远程控制 wan 安全闸收口 ==');
{
  //  判据统一：意图写入（main 与沙箱同口）唯一在 app/domain-actions/lan.js#setRemoteMode；
  //  前置闸唯一事实源 domains/relay/core.validateWanAccess（令牌强度；端口无自由度，
  //  公网口与 relay 口恒同号，合法性由槽位注册表保证）。app/domain-actions/main.js 白名单
  //  只剩 guardian —— 旧「/native/settings 绕闸开 frp」的旁路面已物理删除。
  const lanAct = strip(read('src/app/domain-actions/lan.js'));
  const mainAct = strip(read('src/app/domain-actions/main.js'));
  const mgr = strip(read('src/domains/relay/ops.js'));
  const mgrCore = strip(read('src/domains/relay/core.js'));
  check('① wan 闸唯一事实源 core.validateWanAccess（令牌强度语义）',
    /function validateWanAccess\s*\(/.test(mgrCore) && /至少 8 位/.test(mgrCore), '有');
  check('① setRemoteMode 写入前过闸（单一意图入口，旧为 setFrp/patchDshMain 双入口）',
    /setRemoteMode\(id, mode\)[\s\S]{0,600}validateWanAccess\(/.test(lanAct), '有');
  check('① frpc 执行边界复判同一份纯函数（冷启动只落盘不绕闸）',
    /validateWanAccess\(/.test(mgr), '有');
  check('① 反向：patchDshMain 不再消费任何远程/frp 字段（绕道消失，白名单=guardian）',
    !/remoteMode|remoteEnabled|remoteToken|frp/i.test(mainAct), 'clean');
  // 反向自检（合成样本）：绕道字段一旦出现即命中，判据不是恒真。
  check('① 反向：污染样本会被识别', /remoteMode|remoteEnabled|remoteToken|frp/i.test('meta.remoteToken = p.remoteToken'), 'hit');

  // 行为：注入假 deps 构造 setRemoteMode/setRemoteToken 全链（main 路径），断言闸与落盘次序。
  // 每例一份新鲜夹具：写次数账本一旦跨例共享，判据就变成「执行顺序正确」而非「这条动作做对」。
  const { createLanActions } = require(path.join(ROOT, 'src', 'app', 'domain-actions', 'lan.js'));
  function mk(meta0) {
    const meta = Object.assign({ guardian: false, remoteMode: 'off', remoteToken: '' }, meta0 || {});
    const written = [];
    const eventsSeen = [];
    const evData = [];
    const actions = createLanActions({
      getDaemons: () => ({ enabled: () => false, syncLanState: () => {} }),
      getCtl: () => null,
      getLifecycleManager: () => null,
      getLan: () => ({ syncProxy: () => Promise.resolve() }),
      getState: () => ({
        readMainMeta: () => ({ ...meta }),
        writeMainMeta: (m) => { Object.assign(meta, m); written.push(m); },
      }),
      getViews: () => ({ dshMain: () => ({ id: 'main' }) }),
      getInstances: () => null,
      getEvents: () => ({ append: (t, d) => { eventsSeen.push(t); evData.push(d); } }),
      getLogger: () => ({ warn() {} }),
    });
    return { meta, written, eventsSeen, evData, actions };
  }
  // 开启远程控制即分配令牌：「先去别处设凭据」留在流程里会产出开关已开、无二维码、
  // 用户也不知凭据为何的半截状态，所以分配必须与模式同一次落盘完成。
  {
    const f = mk();
    const r = f.actions.setRemoteMode('main', 'wan');
    check('① 行为：无令牌开 wan → 自动分配合规令牌、与模式一次落盘（零二次写入）',
      r.ok === true && r.tokenAutoAllocated === true && f.written.length === 1
      && f.written[0].remoteMode === 'wan' && typeof f.written[0].remoteToken === 'string',
      JSON.stringify({ r, w: f.written }));
    check('① 行为：分配的令牌达 wan 闸强度下限且 URL-safe（relay 以 ?token= 一次性出示）',
      /^[A-Za-z0-9_-]{8,}$/.test(f.meta.remoteToken) && f.meta.remoteToken === f.written[0].remoteToken,
      'len=' + f.meta.remoteToken.length);
    check('① 行为：TK-5 事件脱敏 —— 自动分配只记布尔，事件载荷零令牌明文',
      f.eventsSeen.includes('dsh_remote_token_changed')
      && f.evData.some((d) => d && d.tokenSet === true && d.autoAllocated === true)
      && !JSON.stringify(f.evData).includes(f.meta.remoteToken), JSON.stringify(f.evData));
  }
  {
    const f = mk();
    const r = f.actions.setRemoteMode('main', 'lan');
    check('① 行为：无令牌开 lan 同样分配（lan 无前置闸，但凭据一次到位才谈得上后面升级 wan）',
      r.ok === true && r.tokenAutoAllocated === true && f.meta.remoteMode === 'lan'
      && /^[A-Za-z0-9_-]{8,}$/.test(f.meta.remoteToken), JSON.stringify(f.written));
  }
  // 已有令牌（含过弱的历史值）一律不覆盖；被拒必须零写入。
  {
    const f = mk({ remoteToken: 'tok' });
    const r = f.actions.setRemoteMode('main', 'wan');
    check('① 行为：已有弱令牌开 wan → 仍被拒（不静默改写用户自设凭据）',
      r.ok === false && f.written.length === 0 && f.meta.remoteToken === 'tok', JSON.stringify({ r, m: f.meta }));
  }
  {
    const f = mk({ remoteToken: 'remote-tok-0123' });
    const r = f.actions.setRemoteMode('main', 'wan');
    check('① 行为：合规令牌已设 → wan 放行、不重复分配也不回写令牌字段',
      r.ok === true && r.tokenAutoAllocated === false && f.meta.remoteMode === 'wan'
      && f.meta.remoteToken === 'remote-tok-0123' && f.written[0].remoteToken === undefined
      && f.eventsSeen.includes('dsh_remote_changed'), JSON.stringify({ r, w: f.written }));
  }
  {
    // 夹具从 off 起步且无令牌：这一条要同时咬住「off 不过闸也不凭空补凭据」与「与现值同则不落盘」，
    //  起点若给成 lan|wan，落盘就是应有动作，断言零写入只会钉住执行顺序而非这条判断。
    const f = mk({ remoteMode: 'off', remoteToken: '' });
    const off = f.actions.setRemoteMode('main', 'off');
    check('① 行为：off 是安全方向，不过闸也不分配（与现值同则不重复落盘）',
      off.ok === true && off.tokenAutoAllocated === false && f.written.length === 0
      && !String(f.meta.remoteToken).trim(), JSON.stringify({ r: off, w: f.written }));
    const f2 = mk({ remoteMode: 'wan', remoteToken: 'remote-tok-0123' });
    const off2 = f2.actions.setRemoteMode('main', 'off');
    check('① 行为：off 改模式时只写模式字段',
      off2.ok === true && f2.written.length === 1 && f2.written[0].remoteToken === undefined, JSON.stringify(f2.written));
  }
  // B1-2：mode/token 必须显式给出——缺省曾被归成 'off'/清除，漏字段请求=静默关远程控制/清凭据。
  {
    const f = mk();
    const noMode = f.actions.setRemoteMode('main');
    check('① 行为：缺 mode → 拒（不再隐式归 off）且零写入',
      noMode && noMode.ok === false && f.written.length === 0, JSON.stringify(noMode));
    const f2 = mk();
    const bogusMode = f2.actions.setRemoteMode('main', 'WAN');
    check('① 行为：非法 mode（大小写不符）→ 拒（严格三态，不做归一）',
      bogusMode && bogusMode.ok === false && f2.written.length === 0, JSON.stringify(bogusMode));
    const f3 = mk();
    const noTok = f3.actions.setRemoteToken('main');
    check('① 行为：缺 token → 拒（不当作清除）', noTok && noTok.ok === false && f3.written.length === 0, JSON.stringify(noTok));
    const f4 = mk({ remoteToken: 'remote-tok-0123' });
    const clr = f4.actions.setRemoteToken('main', '');
    check('① 行为：空串仍是显式清除（ok 且落盘 remoteToken=""）',
      clr && clr.ok === true && f4.meta.remoteToken === '' && f4.written.length === 1, JSON.stringify(f4.written));
    const f5 = mk();
    const wBefore = f5.written.length;
    const weak = f5.actions.setRemoteToken('main', 'tok');
    check('C-3 行为：4 位令牌写 main → 写入口即拒（ok:false、零落盘）',
      weak && weak.ok === false && f5.written.length === wBefore, JSON.stringify(weak));
    const f6 = mk();
    const good = f6.actions.setRemoteToken('main', 'remote-tok-0123');
    check('① 行为：合规令牌写入通过（写入口 ok:true 且落盘）',
      good && good.ok === true && f6.meta.remoteToken === 'remote-tok-0123', JSON.stringify(good));
    check('① 行为：TK-5 事件脱敏 —— 显式设置同样零令牌明文',
      f6.eventsSeen.includes('dsh_remote_token_changed')
      && !JSON.stringify(f6.evData).includes('remote-tok-0123'), JSON.stringify(f6.evData));
  }
}

// -- 2) relay 门卫令牌必须可热换 --
console.log('== ② relay 门卫令牌热换 ==');
{
  //  服务本体 index.js -> proxy.js（SSOT）；编排 manager.js -> ops.js。
  const rl = strip(read('src/domains/relay/proxy.js'));
  const mgr = strip(read('src/domains/relay/ops.js'));
  check('② createRelay 的 token 是 let（旧为 const，永不变化）',
    /let token = o\.token/.test(rl), 'let');
  check('② 存在 setToken 热换入口', /server\.setToken = /.test(rl), '有');
  check('② 存在 hasToken 只读探针（不回传明文）', /server\.hasToken = /.test(rl), '有');
  // syncProxy 快路径必须下发令牌
  check('② syncProxy 快路径下发令牌（旧实现直接 return）',
    /existing\.token !== want/.test(mgr) && /setToken\(want\)/.test(mgr), '有');

  // -- AUDIT B-1 补链：令牌变更的「触发—复判—收敛」三段缺一不可 --
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
  const it2 = { id: 'i1', name: 'n', port: 29051, guardian: true, remoteMode: 'lan', remoteToken: 'tok-a-01234567' };
  const ops2 = createOps({
    store: { instances: [it2], save() {} },
    logger: { warn() {} },
    events: { append(t) { seen.push(t); } },
    hooks: { onRemoteChange(i) { seen.push('sync:' + i.remoteToken); } },
  });
  // 弱令牌写入口即拒，且**不改任何字段**（半改状态防线）
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

// -- 3) 删除路径必须 force 停实例 --
console.log('== ③ 删除路径 force 停实例 ==');
{
  //  域改造后删除路径编排从 index.js/router-ops.js 收敛到 ops.js（SSOT）。
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

// -- 4) 重启必须真正停掉进程 --
console.log('== ④ 重启真正停进程 ==');
{
  //  restartInstance 等 process-pool 契约方法已抽入 mixin（判据统一阶段 3）——按整组读。
  const px = strip(read('src/domains/router/providers/proxy.js') + String.fromCharCode(10)
    + read('src/domains/router/providers/process-pool.js'));
  check('④ restartInstance 用 force 停实例（旧为不带 force）',
    /this\.stopInstance\(inst, true\)/.test(px), '有');
  // 失败可观测：未能停掉时重新武装待重启并清退避（不静默黑洞 2 分钟）
  check('④ 未能停掉时重新记待重启（不静默）',
    /restart-stop-failed/.test(px), '有');
  check('④ 未能停掉时清退避（避免 2 分钟黑洞）',
    /inst\._restartAt = 0;/.test(px), '有');
}

// -- D-5：relay HTML 注入的全量缓冲必须有上限 --
//   原实现 `chunks.push(c)` 无上限，且 buildForwardHeaders 强制 accept-encoding: identity
//   => 单个被代理文档按真实字节无界进内存。上限语义：**超限放弃注入并按流透传**，
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
    // 单块即越限 + end 抢先到达：后挂的 pipeWithHold 监听器永不触发 => 必须自收口
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

  // -- 6) B2-6b：OAuth 回调轮次解耦 --
  //   旧实现回调处理直接经 st._ccLoginResolve/Reject 决议：重新发起登录时，
  //   旧轮 server 上已在途的请求能通过旧 state 自查、把旧轮凭据注进新一轮 promise
  //   （凭据串轮），旧轮「浏览器已关闭」监视迟到时还会误杀新一轮登录。
  //   收口：server/浏览器监视闭包各带 roundId，决议前比对当前轮，旧轮迟到回调一律 410。
  console.log('== 6) B2-6b OAuth 回调轮次解耦（旧轮迟到回调 410 且不触决议器）==');
  await (async () => {
    const http = require('node:http');
    const { freePort } = require(path.join(__dirname, '_ports'));
    const { createOAuthOps } = require(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'oauth.js'));
    const oauthSrc = strip(read('src/domains/router/ops/oauth.js'));
    // 轮次比对与 410 由下面的真实 HTTP 夹具按行为判红，这里不再按源码字样重复钉。
    // 域与平台的接线只有一行 glue（router-ops 的 openInBrowser）：它声明意图而不是机制，域侧一旦
    //   重新拼起 argv/profile，登录就又开了第二条执行路——该形态运行期看不出来，故钉文本。
    const roSrc = strip(read('src/domains/router/router-ops.js'));
    check('⑥ router-ops 经唯一出口声明 isolated-login 意图，域侧零 argv/零 profile 拼接',
      /platform\.browser\.openBrowser\(url, \{ intent: 'isolated-login'/.test(roSrc)
        && !/user-data-dir|--incognito|--profile/.test(roSrc + oauthSrc), roSrc.slice(0, 160));
    const watchers = [];
    // 夹具形状 = 平台层唯一出口 openBrowser(url, {intent:'isolated-login', onExit}) 的返回：
    //   三档词汇在顶层、隔离产物（profile/isolated）在 evidence 里。域侧只认这一套字段，
    //   所以夹具造错形状等于绕过契约（旧形态 {profile, result} 那种自造包装已不存在）。
    const ops = createOAuthOps({
      ports: { allocate: async () => freePort(), unregister: () => {}, allocateMark: () => {} },
      openInBrowser: async (url, onClose) => {
        watchers.push(onClose);
        return {
          ok: true, confirmed: true, handedOff: false, reason: null, error: null, message: '已在隔离窗口打开', url,
          evidence: { via: 'isolated', isolated: true, watch: true, profile: '/tmp/oauth-b26b-profile', bin: '/usr/bin/chrome' },
        };
      },
    });
    check('⑥ 登录成功后 tmpProfile 取自 evidence 并随 wait 结束回收（丢弃结果即丢弃目录与失败原因）',
      /ev\.profile/.test(oauthSrc) && /removeTreeDeferred\(tmpProfile/.test(oauthSrc), '有');
    const cred = (state, key) => ({ apiKey: key, userId: 'u-' + key, userName: 'n', keyName: 'k', state });
    const post = (port, body) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/callback', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      rq.on('error', reject);
      rq.end(JSON.stringify(body));
    });

    const s1 = await ops.commandcodeLoginStart();
    check('⑥ 第一轮登录轮启动成功（前置）', s1.ok === true && !!s1.state, JSON.stringify(s1).slice(0, 100));
    // 三档由平台层原样交回：本层若自己宣称 confirmed/handedOff，「面板说已打开、屏幕什么都没有」就回来了。
    check('⑥ 成功档原样透传平台层三档（confirmed/message 取自夹具，isolated 取自 evidence，本层不自造）',
      s1.confirmed === true && s1.handedOff === false && s1.message === '已在隔离窗口打开'
        && s1.isolated === true && s1.isolatedBasis === 'isolated', JSON.stringify(s1).slice(0, 160));
    // 在途请求：连接与请求体已送达、未 end —— 复现「用户在浏览器里点了回调但守卫恰好重发登录」。
    const inflight = http.request({ host: '127.0.0.1', port: s1.port, path: '/callback', method: 'POST', headers: { 'Content-Type': 'application/json' } });
    inflight.on('error', () => {});
    inflight.write(JSON.stringify(cred(s1.state, 'K1')));
    await new Promise((r) => setTimeout(r, 30));
    const s2 = await ops.commandcodeLoginStart();
    check('⑥ 第二轮登录轮启动成功（前置）', s2.ok === true && s2.state !== s1.state, JSON.stringify({ p1: s1.port, p2: s2.port }));
    inflight.end();
    const r1 = await new Promise((resolve, reject) => {
      inflight.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      inflight.on('error', reject);
    });
    check('⑥ 旧轮在途迟到回调回 410（旧实现此处 200 且决议新轮 promise）', r1.status === 410, JSON.stringify(r1));
    const w2p = ops.commandcodeLoginWait(4000);
    const ok2 = await post(s2.port, cred(s2.state, 'K2'));
    const w2 = await w2p;
    check('⑥ 新轮仍以自身凭据正常决议（旧实现此处解析出 K1 串轮）',
      ok2.status === 200 && w2.ok === true && w2.apiKey === 'K2', JSON.stringify(w2).slice(0, 100));
    // 决议器同轮守卫：旧轮「浏览器已关闭」监视迟到触发，必须被丢弃。
    const s3 = await ops.commandcodeLoginStart();
    check('⑥ 第三轮登录轮启动成功（前置）', s3.ok === true, JSON.stringify(s3).slice(0, 100));
    if (watchers[1]) watchers[1](); // 第二轮的浏览器监视在第三轮在期迟到触发
    const w3p = ops.commandcodeLoginWait(4000);
    await post(s3.port, cred(s3.state, 'K3'));
    const w3 = await w3p;
    check('⑥ 旧轮浏览器监视迟到不误杀新轮（旧实现此处报「浏览器已关闭，登录已取消」）',
      w3.ok === true && w3.apiKey === 'K3', JSON.stringify(w3).slice(0, 100));

    // 失败档：打不开浏览器时授权地址与分发依据必须一起活着走到面板（否则界面只剩「再点一次」），
    //   且登录态当场拆干净——不能留下一个无人决议、也等不到回调的悬挂轮。
    const opsF = createOAuthOps({
      ports: { allocate: async () => freePort(), unregister: () => {}, allocateMark: () => {} },
      openInBrowser: async () => ({
        ok: false, confirmed: false, handedOff: false, reason: 'no-launcher', error: '未探到可启动的浏览器',
        message: null, url: 'x', evidence: { diagnostics: { pick: 'none-found' } },
      }),
    });
    const f1 = await opsF.commandcodeLoginStart();
    check('⑥ 失败档把 authUrl/reason/evidence 一起交出，error 只补文案不改地址字段',
      f1.ok === false && f1.reason === 'no-launcher' && f1.url === f1.authUrl
        && !!f1.evidence && /手动打开/.test(f1.error), JSON.stringify(f1).slice(0, 180));
    const wf = await opsF.commandcodeLoginWait(200);
    check('⑥ 失败档当场拆轮：wait 报「未在登录中」而非悬挂等待',
      wf.ok === false && /未在登录中/.test(wf.error), JSON.stringify(wf));
  })().catch((e) => check('6) B2-6b 异步块无异常完成（含网络夹具）', false, e && e.message));

  const failed = results.concat(asyncResults).filter((r) => !r);
  const total = results.length + asyncResults.length;
  console.log('\n结果: ' + (total - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
