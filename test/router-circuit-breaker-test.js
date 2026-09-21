#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// P1-1/P1-2/P1-3：反代实例的**请求级熔断**此前完全失效（三处叠加）
//
// ## 三个缺陷为何必须一起看
//
// 它们都作用在「坏实例能否被自动重启」这一条链上，任一失效即整链失效：
//
//   P1-1  `markUsed` 在**请求发出前**无条件清零 `_unhealthyCount`，
//         而重启阈值是「连续 >=2 次失败」-> 计数**数学上到不了 2**。
//   P1-2  断流自愈调用的是 `prov.markNetFail(acc)` —— **该方法全仓不存在**，
//         `typeof === 'function'` 恒 false -> 调用是死代码。
//   P1-3  在途请求期间的重启被记为 `_restartPending` 但**无任何读取点**，
//         且 2 分钟退避**在延迟之前**就已置位 -> 坏实例至少卡死 2 分钟。
//
// 后果：稳定 5xx/400（不触发 180s 超时）的坏实例会被持续选中吃流量，
//   只能靠另一套独立的 _monitorFails（探活）兜底。
//
// ## 锁定不变量
//   R-a  清零只发生在**请求成功后**（markUsed/lastUsedAt 已随闲置宽限废止，源码零残留）
//   R-b  `markNetFail` 不得再出现在调用位置（改用真实存在的 markInstanceNetFail）
//   R-c  `_restartPending` 必须有**读取点**（出现在某方法的实参位置）
//   R-d  退避 `_restartAt` 只在**真正执行**重启时置位（不得在延迟分支前）
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

//  R-a/R-b/R-c/R-d 的判据对象（markRequestOk/stopInstance 链/restartInstance/
//   flushRestartPending）已随判据统一阶段抽入 process-pool.js mixin——按实现文件读。
const pool = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'process-pool.js'), 'utf8');
const fwd = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'handlers', 'forward.js'), 'utf8');
const inflight = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'model', 'inflight.js'), 'utf8');

// -- R-a：清零时机 --
{
  // markUsed/lastUsedAt 已随闲置宽限（IDLE_RECLAIM_GRACE）一并废止（PROXY-LIFECYCLE-STANDARD：
  // 回收只看期望集，不看"刚用过"）——死代码收口判据：两处源零残留。
  check('R-a markUsed/lastUsedAt 已全量退场（池与转发层零残留）',
    !/markUsed|lastUsedAt/.test(pool) && !/markUsed|lastUsedAt/.test(fwd), '零残留');
  check('R-a 存在 markRequestOk（成功后才清零）', /markRequestOk\(inst\)/.test(pool), '有');
  //  断言「调用了 markRequestOk」而不绑定具体实参名 ——
  //   P2 双事实源修复后实参已改为 instOf(...) 的结果（okInst），
  //   写死 `acc.instance` 会让「纯重构」误报（我第一版就踩了这个）。
  check('R-a handlers/forward 在 2xx 成功路径调用 markRequestOk',
    /markRequestOk\(\w+\)/.test(fwd), '已接入');
}

// -- R-b：markNetFail 死调用 --
// 剥离注释后不得再有 markNetFail 的**调用**（形如 .markNetFail( ）
{
  // 注释剥离统一走 test/_strip.js（阶段六）。原实现只丢「// 开头的整行」——语义等价且字符串/正则感知，
  // 并额外丢掉「整行都是块注释」的行（原先会被当代码）。glob 用拼接构造，避免源码出现危险序列。
  const { dropCommentLines } = require('./_strip');
  const strip = dropCommentLines;
  {
    const G = 'src/' + String.fromCharCode(42, 42);
    check('R-b 剥离：// 行注释里的 glob 不吞后续代码',
      strip('// ' + G + '\nconst K = 1;').indexOf('K = 1') >= 0, 'ok');
    check('R-b 剥离：字符串里的 glob 不吞代码',
      strip("const P = '" + G + "';\nconst K = 2;").indexOf('K = 2') >= 0, 'ok');
  }
  check('R-b handlers/forward 不再调用不存在的 markNetFail',
    !/\.markNetFail\s*\(/.test(strip(fwd)), '已改');
  check('R-b 改用真实存在的 markInstanceNetFail',
    /markInstanceNetFail/.test(strip(fwd)), '已改');
  check('R-b 该方法确实定义在 process-pool.js（mixin）',
    /markInstanceNetFail\s*\(instOrAcc\)/.test(pool), '有定义');

  // -- R-b 升级（P3-B）：从「字符串出现过」升级为「实参正确 + 确实计数」的行为断言 --
  //   旧断言只查 markInstanceNetFail 字符串存在，故 forward.js 传错实参也绿。
  //   真实缺陷：markInstanceProblem 以 instOrAcc.pid 判定实参是否为实例；传累加器 acc
  //   （无 pid）会**静默早退、完全不计数** —— 流式中断不进熔断（forward.js:132 与:229）。
  //    本断言为硬判据，必须与修复 forward.js 两处实参的改动**同批提交**。
  const fwdCode = strip(fwd);
  const callArgs = [];
  for (const line of fwdCode.split(String.fromCharCode(10))) {
    const mm = line.match(/(?:markInstanceNetFail|markInstanceProblem)\s*\(([^)]*)/);
    if (mm) callArgs.push(mm[1].trim());
  }
  check('R-b 定位到熔断调用点（forward.js）', callArgs.length >= 1, '共 ' + callArgs.length + ' 处');
  const BARE_ACC = /^(?:acc|okAcc|activeAcc|rt\.acc)$/;
  const bare = callArgs.filter((a) => BARE_ACC.test(a));
  check('R-b 熔断调用点不得传无 pid 的累加器实参（缺陷形态 markInstanceNetFail(acc)）',
    bare.length === 0, bare.length ? ('缺陷实参: ' + bare.join(', ')) : 'ok');
  const INST_SHAPED = /instOf\s*\(|\.instance\b|\binst\b|\w*[Ii]nst\b/;
  const unshaped = callArgs.filter((a) => !INST_SHAPED.test(a));
  check('R-b 熔断调用点实参须为实例形态（instOf()/inst/ .instance）',
    unshaped.length === 0, unshaped.length ? ('可疑实参: ' + unshaped.join(', ')) : 'ok');
  check('R-b 反向：缺陷样本 (acc) 被检出', BARE_ACC.test('acc') === true, 'hit');
  check('R-b 反向：正确样本 parse.instOf(prov, acc) 不误报',
    BARE_ACC.test('parse.instOf(prov, acc)') === false, 'miss');
  check('R-b 反向：正确样本 inst 不误报', BARE_ACC.test('inst') === false, 'miss');

  // -- 行为面：沙箱内执行真实的 markInstanceProblem 本体，证明「计数」语义与实参形状要求 --
  const mBody = pool.match(/markInstanceProblem\(instOrAcc, reason\) \{[\s\S]*?\n    \}/);
  check('R-b 定位到 markInstanceProblem 实现', !!mBody, mBody ? 'ok' : '未找到');
  let impl = null;
  if (mBody) {
    try {
      const inner = mBody[0].replace(/^markInstanceProblem\(instOrAcc, reason\)\s*\{/, '');
      impl = new Function('instOrAcc', 'reason', inner.slice(0, inner.lastIndexOf(String.fromCharCode(10) + '    }')));
    } catch { impl = null; }
  }
  check('R-b 行为断言前提：本体可在沙箱求值（不 require 产品状态根）', typeof impl === 'function', typeof impl);
  if (typeof impl === 'function') {
    const restarts = [];
    const stub = { restartInstance: (inst, why) => { restarts.push(why); } };
    const inst = { pid: 4242 };
    impl.call(stub, inst, 'net-error');
    check('R-b 行为：实例实参被计数（_unhealthyCount 1 / healthy=false）',
      inst._unhealthyCount === 1 && inst.healthy === false, JSON.stringify({ n: inst._unhealthyCount, healthy: inst.healthy }));
    const acc = { key: 'k', instance: inst };
    impl.call(stub, acc, 'net-error');
    check('R-b 行为：累加器实参（无 pid）静默不计数 —— 即缺陷形态',
      acc._unhealthyCount === undefined, JSON.stringify({ accN: acc._unhealthyCount }));
    const inst2 = { pid: 7 };
    impl.call(stub, inst2, 'net-error');
    impl.call(stub, inst2, 'net-error');
    check('R-b 行为：连续 2 次计入 -> 触发重启一次并清零点',
      restarts.length === 1 && inst2._unhealthyCount === 0, JSON.stringify({ restarts: restarts.length, n: inst2._unhealthyCount }));
  }
}

// -- R-c：_restartPending 必须有读取点 --
{
  // 写入点是赋值；读取点应出现在 `if (... _restartPending)` 或实参位置
  const hasRead = /if\s*\([^)]*_restartPending\s*\)/.test(pool)
    || /flushRestartPending\([^)]*_restartPending/.test(pool)
    || /const\s+\w+\s*=\s*inst\._restartPending/.test(pool);
  check('R-c _restartPending 存在读取点（不再只写不读）', hasRead, '有');
  check('R-c 存在 flushRestartPending 消费方法', /flushRestartPending\(inst\)/.test(pool), '有');
  check('R-c handlers/forward 在 inflight 归零时执行 flushRestartPending',
    /prov\.flushRestartPending\([^)]+\)/.test(fwd), '已接入');
  //  行为修复锁（PG-D3-4）：单一 end() 产生 flushRestartPending effect，
  //   且流式成功/中断两条路径共用 endInflight（旧缺陷：成功路径漏补重启）。
  check('R-c 单一 end() 生成 flushRestartPending effect',
    /kind:\s*'flushRestartPending'/.test(inflight), '有');
  check('R-e 流式成功与中断路径共用 endInflight（修复漏补重启）',
    (fwd.match(/endInflight\(acc,\s*prov\)/g) || []).length >= 2, '共用');
}

// -- R-d：退避置位时机 --
{
  const m = pool.match(/restartInstance\(inst, reason\) \{[\s\S]*?\n    \}/);
  check('R-d 定位到 restartInstance', !!m, m ? 'ok' : '未找到');
  if (m) {
    const body = m[0];
    const iPending = body.indexOf('_restartPending = reason');
    const iBackoff = body.indexOf('_restartAt = Date.now()');
    check('R-d 退避置位在**在途延迟分支之后**（不再提前置位）',
      iPending >= 0 && iBackoff > iPending, 'pending@' + iPending + ' backoff@' + iBackoff);
  }
}

// -- 反向：成功路径仍要清零（防「修成永不清零」）--
check('反向：成功路径保留了清零语义（markRequestOk 内有赋值）',
  /markRequestOk\(inst\) \{[\s\S]{0,120}?_unhealthyCount\s*=\s*0/.test(pool), '保留');
check('反向：markInstanceProblem 仍累加（熔断本身没被删）',
  /_unhealthyCount\s*=\s*\(inst\._unhealthyCount \|\| 0\) \+ 1/.test(pool), '保留');

// -- D-4 / D-6：providers/probe.js 实例治理 --
//   D-4 实例日志裸 createWriteStream({flags:'a'})：全仓唯一无轮转、且默认 0644 的日志落盘点。
//   D-6 monitorLifecycle 的 `listening !== inst.pid` 等值判据在 npx --yes 兜底形态下恒不成立
//       （监听者是子孙进程），误判后抹 pid => stopInstance 的 kill 段恒不可达 => 留孤儿占端口。
{
  const { stripComments } = require('./_strip');
  const probeRaw = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'probe.js'), 'utf8');
  const probe = stripComments(probeRaw);
  const logMod = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'log', 'log.js'), 'utf8');

  const bareStream = /createWriteStream\s*\(/.test(probe);
  check('D-4 实例日志不再走裸 fs.createWriteStream', !bareStream, bareStream ? '仍有裸流' : '已移除');
  check('D-4 改走平台层 Rotator（带显式 maxBytes）',
    /new Rotator\(.*INSTANCE_LOG_MAX_BYTES\s*\)/.test(probe), 'ok');
  check('D-4 Rotator 来自平台层日志模块（不是本地复制品）',
    /require\('[^']*platform\/service\/log\/log'\)/.test(probe), 'ok');
  check('D-4 兜底：Rotator 落盘确实是 0600 且超阈值轮转',
    /mode:\s*0o600/.test(logMod) && /this\.file \+ '\.1'/.test(logMod), 'ok');
  check('D-4 无缓冲写入器不需要 end()（close 里遗留的 logStream.end 已删）',
    !/logStream/.test(probe), 'ok');

  // D-6 的旧判据（等值比较 / 进程组 sameProcessGroup）已随消费面清零整体删除：
  //   该判定在 macOS 恒 false（无 /proc）、Windows 无组语义，留着就是「第二份归属逻辑」的诱因。
  //   全仓归属判定只剩 carrier/portable 一套锚点引擎（PROXY-ISOLATION-STANDARD L1）。
  const pidProbe = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup', 'probe.js'), 'utf8');
  const pidIndex = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup', 'index.js'), 'utf8');
  check('D-6 死代码收口：sameProcessGroup 平台层实现与门面导出均已删除',
    !/sameProcessGroup/.test(pidProbe) && !/sameProcessGroup/.test(pidIndex), '零残留');
  // 判据替换（隔离标准 L1）：占住判定必须走 carrier.probe 锚点身份（三平台同语义），
  //   sameProcessGroup 判定在 macOS 恒 false（无 /proc）、Windows 无组语义 —— 域内不得再消费。
  const judged = /carrier\.probe\(\{ port: inst\.port, pidFile: inst\.pidFile, anchors: inst\.launchAnchors \}\)/.test(probe)
    && /st\.state === 'foreign'/.test(probe);
  check('D-6 监控判据 = carrier.probe 锚点身份（foreign 才清 pid，查不到不改判）', judged, judged ? 'ok' : '仍是进程组/等值判据');
  check('D-6 反向：域内 sameProcessGroup 消费与裸等值判据不得残留',
    !/sameProcessGroup/.test(probe) && !/if\s*\(listening !== inst\.pid\)/.test(probe), '已替换');
}

const asyncChecks = [];
const acheck = (n, c, x) => { asyncChecks.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// -- D-1 / D-3：inflight 配对与「先停实例再清 pid」 --
// 行为面：经依赖注入跑真 proxyFor（不触网：forwardOnceImpl 可注入）。
(async () => {
  const { createForwarder } = require(path.join(ROOT, 'src', 'domains', 'router', 'handlers', 'forward.js'));

  const mkDeps = (overrides) => {
    const inst = { keyId: 'k1', pid: 4242, status: 'HOT', healthy: true };
    const acc = { key: 'sk-1', keyId: 'k1', maskedKey: 'sk-1', instance: inst, status: 'ready' };
    const stops = [], restarts = [], netFails = [];
    const prov = {
      name: 'p', kind: 'proxy', apiPort: 18080, accounts: [acc], instances: [inst],
      supports: (f) => f === 'instanceLifecycle',
      // 请求路径进程动作唯一经引擎门面 ensureServable（LC 核心-1）：夹具只桩门面。
      ensureServable: async () => ({ ok: true }),
      stopInstance(called) { stops.push(called); called.pid = null; },
      // 夹具计数用 push：`restarts` / `netFails` 是 const 数组，
      //   自增抛 TypeError -> 被产品侧 try/catch 吞掉 -> 计数恒 0，
      //   「超时走 restartInstance」这条就没有牙（与本文件上方 stub 的既有范式一致）。
      restartInstance(inst, why) { restarts.push(why || 'called'); }, markInstanceNetFail(inst) { netFails.push(inst); },
      _retryPendingStop() {}, flushRestartPending() {},
    };
    const inflight = require(path.join(ROOT, 'src', 'domains', 'router', 'model', 'inflight.js')).createInflight();
    const usage = { recordError() {}, recordUsage() {} };
    let picked = null;
    const switcher = { pickFor: (p) => (picked ? null : (picked = p.accounts[0])), reactToFailure: () => ({ action: 'giveup' }) };
    const parse = {
      parseRequest: () => ({ model: 'm', streamRequested: false, bodyJson: {}, pathname: '/v1/messages', search: '' }),
      resolveTarget: () => ({ prov, targetBase: 'http://127.0.0.1:9' }),
      joinUpstream: (b) => b,
      instOf: (p, a) => (a && a.instance) || null,
      extractUsage: () => null,
    };
    const deps = Object.assign({
      parse, usage, inflight, switcher,
      logger: null, log: () => {}, maskKey: (k) => k,
      readBody: async () => Buffer.from('{}'),
    }, overrides || {});
    deps.switcher = switcher;
    return { deps, prov, acc, inst, inflight, usage, state: () => ({ stops, restarts: restarts.length, netFails: netFails.length }) };
  };
  const mkRes = () => { const r = { headers: {}, ended: null, writeHead(c, h) { this.code = c; this.headers = h || {}; }, end(b) { this.ended = b; }, once() {}, on() {} }; return r; };
  const mkReq = () => ({ method: 'POST', url: '/v1/messages', headers: {} });

  // 上游实现同步抛错（parse/joinUpstream/连接期非 error 事件异常等形态）
  {
    const { deps, prov, acc, inflight } = mkDeps({
      forwardOnceImpl: async () => { throw new Error('boom'); },
    });
    const f = createForwarder(deps);
    const res = mkRes();
    let threw = null;
    try { await f.proxyFor(prov, mkReq(), res); } catch (e) { threw = e && e.message; }
    const st = inflight.stats();
    acheck('D-1a 上游抛错时在途计数不泄漏（begun==ended）', st.active === 0, JSON.stringify(st));
    acheck('D-1a 账号 inflight 归零', (acc.inflight || 0) === 0, 'acc.inflight=' + acc.inflight);
    acheck('D-1a 抛错原样冒泡给端点层（不静默吞）', threw === 'boom', String(threw));
  }

  // 反向对照 —— 判据必须有鉴别力（且不被注释同形干扰）
  {
    const { stripComments } = require('./_strip');
    const src = stripComments(fwd);
    const m = src.match(/async function proxyFor\([\s\S]*?\n  \}/);
    acheck('D-1b 定位到 proxyFor 函数体', !!m, m ? 'ok' : '未找到');
    const body = m ? m[0] : '';
    const hasFinally = /finally\s*\{[\s\S]{0,80}?endAttempt\(\)/.test(body);
    const hasReset = /attemptEnded\s*=\s*false/.test(body);
    const hasIdem = /if\s*\(attemptEnded\)\s*return;/.test(src);
    acheck('D-1b 收口三要素齐备（finally 兜底 + begin 后置位 + 幂等守卫）',
      hasFinally && hasReset && hasIdem, JSON.stringify({ hasFinally, hasReset, hasIdem }));
    // 循环体各显式结束点全部改走 endAttempt()；proxyFor 内 endInflight(acc,…) 只应剩
    // endAttempt 定义里那一处（多出一处即说明有新分支绕过幂等收口）。
    const direct = (body.match(/endInflight\(acc,/g) || []).length;
    const viaEnd = (body.match(/endAttempt\(\)/g) || []).length;
    acheck('D-1b proxyFor 内 endInflight(acc,…) 仅 1 处（endAttempt 内），结束点均走收口',
      direct === 1 && viaEnd >= 5, JSON.stringify({ direct, viaEnd }));
    acheck('D-1b 反向：readableEnded 不再作为 close 收口的早退判据',
      !/if\s*\(ur\.readableEnded\)\s*return;/.test(src), '已移除');
    // 计数前先摘掉声明行：
    //   `function endInflight(acc, prov) {` 也会命中调用正则（3 -> 4），
    //   不摘就永远数出一个不存在的「第四处结束点」。
    const DECL_RE = /function endInflight\(acc,\s*prov\)\s*\{/;
    const decls = (src.match(new RegExp(DECL_RE, 'g')) || []).length;
    const callOnly = src.replace(DECL_RE, '');
    const ends = (callOnly.match(/endInflight\(acc,\s*prov\)/g) || []).length;
    acheck('D-1b 收口后 writeThrough 三处结束仍共用 endInflight(acc, prov)（只数调用点，声明先摘）',
      ends === 3 && decls === 1, '调用 ' + ends + ' 处 / 声明 ' + decls + ' 处');
  }

  // 非超时 net-error 必须先经 stopInstance（kill 路径可达），不得只抹 pid
  {
    const { deps, prov, state } = mkDeps({
      forwardOnceImpl: async () => ({ phase: 'net-error', error: 'socket hang up' }),
    });
    const f = createForwarder(deps);
    await f.proxyFor(prov, mkReq(), mkRes()).catch(() => {});
    const s = state();
    acheck('D-3 非超时 net-error：stopInstance 被调用一次（kill 段可达）',
      s.stops.length === 1, 'stops=' + JSON.stringify(s.stops.map((x) => x && x.keyId)));
    acheck('D-3 实参是实例（带 pid 快照）而非累加器', s.stops[0] && s.stops[0].keyId === 'k1', JSON.stringify(s.stops[0] && s.stops[0].keyId));
  }

  // D-3 反向：超时路径仍走 restartInstance，不得被 stopInstance 抢跑
  {
    const { deps, prov, state } = mkDeps({
      forwardOnceImpl: async () => ({ phase: 'net-error', error: 'response timeout after 180s' }),
    });
    const f = createForwarder(deps);
    await f.proxyFor(prov, mkReq(), mkRes()).catch(() => {});
    const s = state();
    acheck('D-3 反向：超时不直接 stopInstance，改走 restartInstance',
      s.stops.length === 0 && s.restarts === 1, JSON.stringify({ stops: s.stops.length, restarts: s.restarts }));
  }

  const failedAsync = asyncChecks.filter((r) => !r);
  const failed = results.filter((r) => !r).concat(failedAsync);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length + asyncChecks.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();