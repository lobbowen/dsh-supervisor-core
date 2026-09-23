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

  // 行为：注入假 deps 构造 setRemoteMode/setRemoteToken 全链（main 路径），断言闸与落盘次序
  const { createLanActions } = require(path.join(ROOT, 'src', 'app', 'domain-actions', 'lan.js'));
  const written = [];
  const meta = { guardian: false, remoteMode: 'off', remoteToken: '' };
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
  const bad = actions.setRemoteMode('main', 'wan');
  check('① 行为：无令牌开 wan → 被拒（ok:false）', bad && bad.ok === false, JSON.stringify(bad));
  check('① 行为：被拒时**未落盘**（不产生半改状态）', written.length === 0, String(written.length));
  const off = actions.setRemoteMode('main', 'off');
  check('① 行为：off 是安全方向，不被闸拦（且与现值同则不重复落盘）',
    off && off.ok === true && written.length === 0, JSON.stringify(off));
  const lan = actions.setRemoteMode('main', 'lan');
  check('① 行为：lan 模式无令牌前置（局域网侧有来源闸），正常落盘',
    lan && lan.ok === true && written.length === 1 && written[0].remoteMode === 'lan', JSON.stringify(written));
  // B1-2：mode/token 必须显式给出——缺省曾被归成 'off'/清除，漏字段请求=静默关远程控制/清凭据。
  const noMode = actions.setRemoteMode('main');
  check('① 行为：缺 mode → 拒（不再隐式归 off）', noMode && noMode.ok === false, JSON.stringify(noMode));
  const bogusMode = actions.setRemoteMode('main', 'WAN');
  check('① 行为：非法 mode（大小写不符）→ 拒', bogusMode && bogusMode.ok === false, JSON.stringify(bogusMode));
  const noTok = actions.setRemoteToken('main');
  check('① 行为：缺 token → 拒（不当作清除）', noTok && noTok.ok === false, JSON.stringify(noTok));
  const clr = actions.setRemoteToken('main', '');
  check('① 行为：空串仍是显式清除（ok 且落盘 remoteToken=""）',
    clr && clr.ok === true && meta.remoteToken === '', JSON.stringify(clr));
  check('① 行为：显式拒绝路径均不落盘（上面三次非法调用零写入）',
    written.length === 2 && written[1].remoteToken === '', String(written.length));
  // 弱令牌在**写入口**即拒（与 wan 闸同一强度下限；此前设置面仅 '非空白' 一票闸）
  const wBefore = written.length;
  const weak = actions.setRemoteToken('main', 'tok');
  check('C-3 行为：4 位令牌写 main → 写入口即拒（ok:false）', weak && weak.ok === false, JSON.stringify(weak));
  check('C-3 行为：被拒后未再多落一次盘（写次数不变）', written.length === wBefore, 'before=' + wBefore + ' after=' + written.length);
  const good = actions.setRemoteToken('main', 'remote-tok-0123');
  check('① 行为：合规令牌写入通过（写入口 ok:true 且落盘）',
    good && good.ok === true && meta.remoteToken === 'remote-tok-0123', JSON.stringify(good));
  check('① 行为：TK-5 事件脱敏 —— 全部事件载荷零令牌明文',
    eventsSeen.includes('dsh_remote_token_changed') && !JSON.stringify(evData).includes('remote-tok-0123'),
    JSON.stringify(evData));
  const wan2 = actions.setRemoteMode('main', 'wan');
  check('① 行为：令牌已设 → wan 放行并落盘（dsh_remote_changed 携带 mode）',
    wan2 && wan2.ok === true && meta.remoteMode === 'wan' && eventsSeen.includes('dsh_remote_changed'), JSON.stringify(wan2));
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

  const failed = results.concat(asyncResults).filter((r) => !r);
  const total = results.length + asyncResults.length;
  console.log('\n结果: ' + (total - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
