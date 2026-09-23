#!/usr/bin/env node
'use strict';

// 沙箱实例状态机与监督拍行为测试（state-machine.js 纯转移 + B15 守护语义 + W2 控制面接线）：
// 覆盖 restartCount 稳定窗归零（20复）与 20 次上限 FAILED 语义；第 7 节验 govern tick
// （观测->决策->下发/处置）与准入（预算摊薄跌破下限显式拒绝、fromUpgrade 旁路）。
//  域改造后状态转移已是**纯函数**（deps 显式入参）-> 只 require 叶子模块 + 假依赖；
//   监督拍行为经 ctor opts 注入假 resstats/machineFacts（显式注入不 patch 模块导出），
//   真实监听只为让 monitor 命中 RUNNING，绝不触碰真实 systemd/npm/进程账本（DF-6）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const sm = require(path.join(ROOT, 'src', 'domains', 'instance', 'state-machine'));
const sandbox = require(path.join(ROOT, 'src', 'domains', 'instance', 'sandbox'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
let saves = 0;
const deps = {
  events: { append() {} },
  logger: { info() {}, warn() {}, error() {} },
  save() { saves++; },
  tokens: null,
};
function makeInst() {
  return { id: 't1', name: '测试', domain: 'sandbox', state: { phase: 'STOPPED', restartCount: 0, backoffLevel: 0, lastProbeOk: null } };
}
const now = Date.now();

// 1. restart 累计 + 退避
const i1 = makeInst();
sm.restart(deps, i1, '启动失败');
check('restart: 进入 BACKOFF', i1.state.phase === 'BACKOFF' && i1.state.restartCount === 1, JSON.stringify(i1.state));
check('restart: backoffUntil 已设（>=5s）', typeof i1.state.backoffUntil === 'number' && i1.state.backoffUntil >= now + 5000, String(i1.state.backoffUntil));

// 2. 稳定运行后 restartCount 归零（5min 窗）
const i2 = makeInst();
i2.state.restartCount = 3; i2.state.backoffLevel = 2; i2.state.lastFailAt = now - 6 * 60 * 1000; // 6 分钟前失败
sm.setRunning(deps, i2, { pid: 123 }, now);
check('稳定窗(>5min)后 restartCount 归零', i2.state.restartCount === 0 && i2.state.backoffLevel === 0, JSON.stringify(i2.state));
check('稳定窗后 phase=RUNNING', i2.state.phase === 'RUNNING', i2.state.phase);

// 3. 短期内多次重启不清零（<5min 窗）
const i3 = makeInst();
i3.state.restartCount = 3; i3.state.backoffLevel = 1; i3.state.lastFailAt = now - 60 * 1000;
sm.setRunning(deps, i3, { pid: 456 }, now);
check('未过稳定窗(<5min) restartCount 保留', i3.state.restartCount === 3 && i3.state.backoffLevel === 1, JSON.stringify(i3.state));

// 4. 重试上限（attempts > 20，即第 21 次判定）-> FAILED
const i4 = makeInst();
for (let k = 0; k < 21; k++) sm.restart(deps, i4, '崩溃' + k);
check('超过 20 次后 FAILED', i4.state.phase === 'FAILED' && /重试超限/.test(i4.state.lastError || ''), i4.state.phase + ' ' + i4.state.lastError);
const i4b = makeInst();
for (let k = 0; k < 20; k++) sm.restart(deps, i4b, '崩溃' + k);
check('恰 20 次仍 BACKOFF（未超限）', i4b.state.phase === 'BACKOFF' && i4b.state.restartCount === 20, i4b.state.phase + ' count=' + i4b.state.restartCount);

// 5. fail / setStopped
const i5 = makeInst();
sm.fail(deps, i5, '安装失败');
check('failInstance → FAILED + reason', i5.state.phase === 'FAILED' && i5.state.lastError === '安装失败', JSON.stringify(i5.state));
const i6 = makeInst();
sm.setStopped(deps, i6);
check('setStopped → STOPPED', i6.state.phase === 'STOPPED', i6.state.phase);
check('副作用经 deps.save 显式发出（非隐式 this）', saves > 0, 'saves=' + saves);

// -- 6. B15：守护开关必须约束 BACKOFF/FAILED 的自愈拉起 --
//    supervise 是域级行为：用可注入假 service + 临时目录构造 InstanceManager，
//    端口取 0（pidlookup 必不命中）-> 探测恒「未运行」，绝不触碰真实 systemd/进程。
(async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
  const mk = (phase, extra) => Object.assign({
    id: 'b15', name: 'B15', domain: 'sandbox', port: 0, guardian: false,
    state: Object.assign({ phase, restartCount: 2, backoffLevel: 1, lastProbeOk: false }, extra || {}),
  }, {});
  const svcCalls = [];
  const fakeService = {
    daemonReload() { svcCalls.push('daemonReload'); return true; },
    stopUnit() { svcCalls.push('stopUnit'); return true; }, resetFailed() { return true; },
    isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {},
    startTransient() { svcCalls.push('startTransient'); return true; },
  };
  const mkMgr = (tmp, svcOverride) => {
    const mgr = new InstanceManager({
      dir: tmp, logger: { info() {}, warn() {}, error() {} }, service: Object.assign({}, fakeService, svcOverride || {}),
      tasks: { isBusy: () => false, current: () => null, list: () => [] },
    });
    mgr._setSandboxSupportedForTest(true);
    mgr._ctx.install = async () => ({ ok: false, error: 'stub' }); // 离线：绝不触发真实 npm 安装
    return mgr;
  };
  /** 拉起路径的正向 fixture：落一个假 DSH 入口（install/ 下真实存在），
   *  让 start() 的存在性检查与 EXECUTION-CONTRACT 执行边界复校都通过。 */
  const seedEntry = (mgr, inst) => {
    mgr.save(); // store.save 自建目录；instances 已置入后方可 ensureDirs
    mgr._store.ensureDirs(inst);
    // 入口路径经 sandbox.dshEntry 推导（node_modules 落点分平台），不硬编码 POSIX 形。
    const bin = sandbox.dshEntry(mgr.instancesRoot, inst);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// fake entry for boundary recheck\n');
  };

  // 6a. BACKOFF + 守护关 + 退避已到期 -> 落 STOPPED，零拉起
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-off-')));
    const inst = mk('BACKOFF', { backoffUntil: Date.now() - 1 });
    mgr.instances = [inst];
    mgr.supervise('b15');
    await new Promise((r) => setImmediate(r));
    check('B15 BACKOFF+守护关 → STOPPED（不再无限重试）', inst.state.phase === 'STOPPED', inst.state.phase);
    check('B15 BACKOFF+守护关 → 未触碰 service', svcCalls.length === 0, svcCalls.join(','));
  }
  // 6b. FAILED + 守护关 + installOk=true -> 不自动拉起（停就停红线）
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-f-')));
    const inst = mk('FAILED', { installOk: true, lastError: '安装任务登记失败' });
    mgr.instances = [inst];
    mgr.supervise('b15');
    check('B15 FAILED+守护关 → 维持 FAILED 且零拉起', inst.state.phase === 'FAILED' && svcCalls.length === 0, inst.state.phase + ' ' + svcCalls.join(','));
  }
  // 6c. 反向（判据有牙）：BACKOFF + 守护开 + 到期 -> 走自愈拉起
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-on-')));
    const inst = mk('BACKOFF', { backoffUntil: Date.now() - 1 });
    inst.guardian = true;
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    mgr.supervise('b15');
    await new Promise((r) => setTimeout(r, 50));
    check('B15 反向：守护开+到期 → 自愈拉起（startTransient 被调）', svcCalls.includes('startTransient') && inst.state.phase === 'STARTING', inst.state.phase + ' ' + svcCalls.join(','));
  }
  // 6d. 反向：FAILED + 守护开 + installOk=true -> installOk 兜底仍拉起
  {
    svcCalls.length = 0;
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-fo-')));
    const inst = mk('FAILED', { installOk: true, lastError: '启动失败:x' });
    inst.guardian = true;
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    mgr.supervise('b15');
    check('B15 反向：守护开 FAILED+installOk → 兜底拉起', svcCalls.includes('startTransient') && inst.state.phase === 'STARTING', inst.state.phase + ' ' + svcCalls.join(','));
  }

  // ---- 6e/6f. B2-1 运行意图没有第二落点：start/stop 只动相位，旧库残留字段一次性清理 ----
  //   自动拉起只认 guardian 开关（B15 段已验），用户启停就是动作本身；曾经的第二落点
  //   inst.state.desired 已废止——这里钉「形状里不再出现该键」与迁移清理。
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-intent-')));
    const inst = mk('STOPPED');
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    const r0 = await mgr.startInstance('b15', { fromUpgrade: true });
    check('IN-1 start 走到拉起 → 相位 STARTING 且不写任何意图字段',
      r0.ok === true && inst.state.phase === 'STARTING' && !('desired' in inst.state),
      'ok=' + r0.ok + ' phase=' + inst.state.phase + ' desired=' + inst.state.desired);
    const r1 = mgr.stopInstance('b15');
    check('IN-2 停 → 相位 STOPPED，state 形状自始至终无 desired 键',
      r1.ok === true && inst.state.phase === 'STOPPED' && !('desired' in inst.state),
      'phase=' + inst.state.phase + ' keys=' + Object.keys(inst.state).join(','));
    const model = require(path.join(ROOT, 'src', 'domains', 'instance', 'model'));
    const migrated = model.normalizeInstance({ id: 'x', name: 'x', port: 1, state: { phase: 'RUNNING', desired: 'running', restartCount: 0 } });
    check('IN-3 老库残留 desired 被 normalize 一次性剔除（其余字段不误伤）',
      !('desired' in migrated.state) && migrated.state.phase === 'RUNNING' && migrated.state.restartCount === 0,
      JSON.stringify(migrated.state));
    check('IN-4 反向：createRecord 不再种 desired（新记录无第二落点）',
      !('desired' in model.createRecord({ port: 3901 }, 'c1').state),
      JSON.stringify(model.createRecord({ port: 3901 }, 'c1').state));
  }
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-intent-unconfirmed-')), { stopUnit() { return false; } });
    const inst = mk('RUNNING');
    mgr.instances = [inst];
    const r = mgr.stopInstance('b15');
    check('IN-5 反向：停止未确认 → ok:false 且相位不动（不谎报已停）',
      r.ok === false && inst.state.phase === 'RUNNING' && !('desired' in inst.state),
      'ok=' + r.ok + ' phase=' + inst.state.phase);
  }

  // ---- 6g. B2-6d：手动拉起开新失败链 —— fail() 承诺的「由用户手动重试」成为真实通道 ----
  //   旧缺陷：attempts>20 后 restart() 瞬回 FAILED，清零只靠稳定 RUNNING>5min，
  //   超限实例的手动重试通道实质封死（§4 的 21 次循环即达该状态）。
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b26d-')));
    const inst = mk('FAILED', { restartCount: 21, backoffLevel: 5, lastError: '重试超限(崩溃)', lastFailAt: Date.now() - 1000, backoffUntil: Date.now() - 1 });
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    const r = await mgr.startInstance('b15', { manual: true });
    check('D-1 手动启动成功 → 旧链计数作废（restartCount/backoffLevel/backoffUntil 清零）',
      r.ok === true && inst.state.phase === 'STARTING' && inst.state.restartCount === 0 && inst.state.backoffLevel === 0 && inst.state.backoffUntil === null,
      'ok=' + r.ok + ' ' + JSON.stringify(inst.state));
    // 收口点：手动拉起后进程再失败，监督拍的 restart 从第 1 次重试重新走起。
    sm.restart(deps, inst, '实例进程退出');
    check('D-2 手动启动后的失败重新进 BACKOFF 计第 1 次（旧实现此处必直落「重试超限」FAILED）',
      inst.state.phase === 'BACKOFF' && inst.state.restartCount === 1, inst.state.phase + ' count=' + inst.state.restartCount);
  }
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b26d-auto-')));
    const inst = mk('FAILED', { restartCount: 21, backoffLevel: 5, installOk: true });
    inst.guardian = true;
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    mgr.supervise('b15');
    await new Promise((r) => setImmediate(r));
    check('D-3 自动来源拉起（监督拍 installOk 兜底）不开新链：restartCount=21 原样保留',
      inst.state.restartCount === 21, 'phase=' + inst.state.phase + ' count=' + inst.state.restartCount);
    sm.restart(deps, inst, '实例进程退出');
    check('D-3b 自动链超限判定不变：超限后再失败仍 FAILED（超限->手动重启才有出路）',
      inst.state.phase === 'FAILED' && /重试超限/.test(inst.state.lastError || ''), inst.state.phase);
  }
  {
    const apiSrc = require('node:fs').readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'instances.js'), 'utf8');
    check('D-4 API 接线：act=start 是唯一显式 manual 来源（自动路径不经此标记）',
      /startInstance\(j\.id, \{ manual: true \}\)/.test(apiSrc) && !/startInstance\(j\.id\)/.test(apiSrc), '有');
  }

  // ---- 7. W2 控制面监督拍（govern tick + 准入）：观测(假 resstats)->决策(真 governor+假机器事实)
  //      ->下发(展示值)->处置(违规停单元+退避)。注入走 ctor opts（显式注入，不 patch 模块导出）。
  //      端口用真实监听让 monitor 命中 RUNNING，但采样被假 resstats 接管，绝不读真实进程账本。 ----
  {
    const net = require('node:net');
    const { safePort } = require(path.join(__dirname, '_ports'));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const GiB = (g) => g * 1024 * 1024 * 1024;
    const mkGovMgr = (extra) => {
      const journal = [];
      const transient = [];
      const mgr = new InstanceManager(Object.assign({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gov-')),
        logger: { info() {}, warn() {}, error() {} },
        events: { append(name, data) { journal.push({ kind: 'event', name, data }); } },
        tasks: { isBusy: () => false, current: () => null, list: () => [] },
        service: {
          daemonReload() { journal.push({ kind: 'daemonReload' }); return true; },
          // W3：stopUnit 的 ctx（端口/run.pid/cmdline 锚 + timeoutMs 边界）纳入记录，供调用点判据核对
          stopUnit(unit, o) { journal.push({ kind: 'stopUnit', unit, ctx: o }); return true; },
          resetFailed() { return true; },
          isUnitActive() { return false; },
          transientUnitFile() { return null; },
          cleanTransient() {},
          startTransient(o) { journal.push({ kind: 'startTransient', unit: o.unit }); transient.push(o); return true; },
          setLimits(unit, alloc) { journal.push({ kind: 'setLimits', unit, alloc }); return true; },
        },
      }, extra || {}));
      mgr._setSandboxSupportedForTest(true);
      mgr._ctx.install = async () => ({ ok: false, error: 'stub：绝不真实安装' });
      return { mgr, journal, transient };
    };
    const listen = (port) => new Promise((resolve, reject) => {
      const srv = net.createServer((s) => s.destroy());
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
    const govInst = (id, port, state) => ({
      id, name: id.toUpperCase(), domain: 'sandbox', port, guardian: true,
      state: state || { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: Date.now() - 5000, allocation: null },
    });

    // 7A. 违规处置链：连续 3 个证据拍超限 -> 事件 + stopUnit + BACKOFF（复用退避链）
    {
      const port = safePort('instance-state', 0);
      const srv = await listen(port);
      const rss = Math.round(30000 * 1024 * 1024); // 30000MB：burst 顶满（16384M）仍超限
      const { mgr, journal } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: rss, cpuMs: 5000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const inst = govInst('g1', port);
      mgr.instances = [inst];
      for (let k = 0; k < 3; k++) { mgr.supervise('g1'); await sleep(10); }
      check('7A 迟滞爬升中不处置（内存计数未触顶即不停单元）',
        inst.state.phase === 'RUNNING' && !journal.some((j) => j.kind === 'stopUnit'), inst.state.phase);
      mgr.supervise('g1'); await sleep(10);
      const ev = journal.find((j) => j.kind === 'event' && j.name === 'inst_resource_violation');
      const stop = journal.findIndex((j) => j.kind === 'stopUnit');
      check('7A 连续第 3 个证据拍触发违规处置', !!ev && stop >= 0, JSON.stringify(ev && ev.data));
      check('7A 事件载荷 {id,kind,actual,target}', ev && ev.data.id === 'g1' && ev.data.kind === 'memory'
        && ev.data.actual === 30000 && ev.data.target === 16384, JSON.stringify(ev && ev.data));
      check('7A 事件先于动作（既定纪律）', !!ev && stop > journal.indexOf(ev), 'stopIdx=' + stop);
      // W3：违规处置经 Provider 动词 + 身份锚（portable 档据此归属，绝不盲杀；有界防冻结）
      const stopEntry = stop >= 0 ? journal[stop] : null;
      check('7A 违规 stopUnit 带身份锚与有界超时（W3 调用点）',
        !!stopEntry && stopEntry.ctx && stopEntry.ctx.port === port && stopEntry.ctx.timeoutMs === 20000
        && Array.isArray(stopEntry.ctx.anchors) && stopEntry.ctx.anchors.includes('--port ' + port),
        stopEntry && JSON.stringify(stopEntry.ctx && stopEntry.ctx.anchors));
      check('7A 处置后走既有退避链：BACKOFF + restartCount=1',
        inst.state.phase === 'BACKOFF' && inst.state.restartCount === 1, inst.state.phase + ' n=' + inst.state.restartCount);
      check('7A 违规原因可见（lastFailure 带资源违规）', /资源违规:内存/.test(inst.state.lastFailure || ''), inst.state.lastFailure);
      check('7A 观测行回填（usage.memMb + burst 迟滞三步爬到 16384M）',
        inst.state.usage && inst.state.usage.memMb === 30000 && inst.state.allocation.memoryMax === '16384M',
        JSON.stringify(inst.state.usage) + ' ' + JSON.stringify(inst.state.allocation));
      mgr.stopInstance('g1');
      check('7A 显式停止清观测（usage=null 不残留陈旧展示值）', inst.state.usage === null && inst.state.phase === 'STOPPED', String(inst.state.usage));
      srv.close();
    }
    // 7B. 突发下发展示值：双实例有需求 -> 各补真实差额（先到先得按启动序）
    {
      const pA = safePort('instance-state', 1);
      const pB = safePort('instance-state', 2);
      const srvA = await listen(pA);
      const srvB = await listen(pB);
      const rss = 7000 * 1024 * 1024; // 预留 5734.4M 之上且差额越过 10% 死区（22%），池充裕
      const { mgr } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: rss, cpuMs: 8000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const a = govInst('gb1', pA, { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: 1000, allocation: null });
      const b = govInst('gb2', pB, { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: 2000, allocation: null });
      mgr.instances = [a, b];
      mgr.supervise('gb1'); mgr.supervise('gb2'); await sleep(30);
      check('7B 首拍（采样回填前）等权预留 5734M', a.state.allocation.memoryMax === '5734M', a.state.allocation.memoryMax);
      mgr.supervise('gb1'); mgr.supervise('gb2'); await sleep(30);
      check('7B 有需求实例补到真实用量（7000M，两拍内到位）',
        a.state.allocation.memoryMax === '7000M' && b.state.allocation.memoryMax === '7000M',
        a.state.allocation.memoryMax + ' / ' + b.state.allocation.memoryMax);
      check('7B 展示值含 MemoryHigh（0.9x = 6300M）', a.state.allocation.memoryHigh === '6300M', a.state.allocation.memoryHigh);
      // cpuPct 需相邻两拍时间差 >0（Windows 粗时钟兜底，多跑一拍）。
      mgr.supervise('gb1'); mgr.supervise('gb2'); await sleep(30);
      mgr.supervise('gb1'); mgr.supervise('gb2'); await sleep(30);
      check('7B 观测行 usage 回填（rss 即时 + cpu delta 终有值）',
        !!a.state.usage && a.state.usage.memMb === 7000 && typeof a.state.usage.cpuPct === 'number',
        JSON.stringify(a.state.usage));
      srvA.close(); srvB.close();
    }
    // 7C. 准入：预算摊薄跌破下限显式拒绝；fromUpgrade 旁路 + 启动属性带 MemoryHigh
    {
      const { mgr, transient } = mkGovMgr({
        machineFacts: () => ({ totalMemBytes: GiB(1), cpuCount: 8 }), // 预算 716.8MB：两实例必跌破 512M 下限
      });
      const running = govInst('gc1', 0, { phase: 'RUNNING', restartCount: 0, allocation: { memoryMax: '512M', cpuQuota: '280%' } });
      const fresh = { id: 'gc2', name: 'GC2', domain: 'sandbox', port: 0, guardian: false, state: { phase: 'STOPPED', restartCount: 0 } };
      mgr.instances = [running, fresh];
      mgr.save();
      mgr._store.ensureDirs(fresh);
      const bin = sandbox.dshEntry(mgr.instancesRoot, fresh);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '// fake entry for boundary recheck\n');
      const r1 = await mgr.startInstance('gc2');
      check('7C 预算已满 -> 显式拒绝（绝不静默超卖）', r1.ok === false && /预算已满/.test(r1.error || ''), JSON.stringify(r1));
      check('7C 拒绝文案含指引与预留明细', /停一个或等待释放/.test(r1.error || '') && /512\/717MB/.test(r1.error || ''), r1.error);
      check('7C 被拒实例未被拉起且相位不动', !transient.some((t) => t.unit === 'dsh-web@gc2') && fresh.state.phase === 'STOPPED', fresh.state.phase);
      const r2 = await mgr.startInstance('gc2', { fromUpgrade: true });
      check('7C fromUpgrade 旁路准入（升级重启验证必须真正拉起）', r2.ok === true && fresh.state.phase === 'STARTING', JSON.stringify(r2) + ' ' + fresh.state.phase);
      const t = transient.find((x) => x.unit === 'dsh-web@gc2');
      check('7C 启动属性下发 MemoryMax/MemoryHigh（0.9x 节流先于 OOM）',
        !!t && t.props.includes('MemoryMax=512M') && t.props.includes('MemoryHigh=461M'), t && JSON.stringify(t.props));
    }
    // 7D. 采样无证据不判违规：sampleAsync 恒 null -> 永不处置
    {
      const port = safePort('instance-state', 3);
      const srv = await listen(port);
      const { mgr, journal } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve(null) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const inst = govInst('gd1', port);
      mgr.instances = [inst];
      for (let k = 0; k < 6; k++) { mgr.supervise('gd1'); await sleep(5); }
      check('7D 采样恒失败 -> 无证据不处置（六拍仍 RUNNING、零违规事件）',
        inst.state.phase === 'RUNNING' && !journal.some((j) => j.name === 'inst_resource_violation'), inst.state.phase);
      srv.close();
    }
    // 7E. W3 执行面调用点：单元档门控（非 systemd 平台零结构残留）+ 启停身份锚贯通 + setLimits 动态下发
    {
      const sdir = path.join(os.tmpdir(), 'dsh-w3-never-' + process.pid + '-' + Date.now());
      const port = safePort('instance-state', 4);
      const { mgr, journal, transient } = mkGovMgr({ systemdDir: sdir });
      const inst = govInst('ge1', port, { phase: 'STOPPED', restartCount: 0, allocation: null });
      mgr.instances = [inst];
      mgr.save();
      mgr._store.ensureDirs(inst);
      const bin = sandbox.dshEntry(mgr.instancesRoot, inst);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '// fake entry for boundary recheck\n');
      const r = await mgr.startInstance('ge1', { fromUpgrade: true });
      check('7E 无 supportsUnits 的 provider：_prepareSystemd 门控直过（不 mkdir、不 daemonReload）',
        r.ok === true && !journal.some((j) => j.kind === 'daemonReload') && !fs.existsSync(sdir), sdir);
      const t0 = transient.find((x) => x.unit === 'dsh-web@ge1');
      check('7E startTransient 带身份锚（port/run.pid/anchors 同源 launchCtx 推导）',
        !!t0 && t0.port === port && t0.pidFile === sandbox.runPidFile(mgr.instancesRoot, inst)
        && t0.anchors.includes('--port ' + port) && t0.anchors.includes(bin),
        t0 && JSON.stringify(t0.anchors));
      mgr.stopInstance('ge1');
      const su = journal.filter((j) => j.kind === 'stopUnit').pop();
      check('7E stopUnit 带**同一**身份锚与 20s 边界（启停同值防归属漂移）',
        !!su && su.ctx && su.ctx.port === port && su.ctx.pidFile === t0.pidFile
        && JSON.stringify(su.ctx.anchors) === JSON.stringify(t0.anchors) && su.ctx.timeoutMs === 20000,
        su && JSON.stringify(su.ctx));

      // setLimits：alloc 变化的 RUNNING 拍必须下发（值只来自 governor alloc）；不变拍不重发。
      const port2 = safePort('instance-state', 5);
      const srv2 = await listen(port2);
      const g2 = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: 6000 * 1024 * 1024, cpuMs: 1000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const inst2 = govInst('ge2', port2);
      g2.mgr.instances = [inst2];
      g2.mgr.supervise('ge2'); await sleep(10);
      const sl = g2.journal.find((j) => j.kind === 'setLimits');
      check('7E RUNNING 拍 alloc 变化即下发 setLimits（运行期动态化，不等重启）',
        !!sl && sl.unit === 'dsh-web@ge2' && !!sl.alloc && sl.alloc.memoryMax === inst2.state.allocation.memoryMax,
        sl && JSON.stringify(sl.alloc));
      const n1 = g2.journal.filter((j) => j.kind === 'setLimits').length;
      g2.mgr.supervise('ge2'); await sleep(10);
      check('7E 未变化拍不重发 setLimits（迟滞收敛防写放大）',
        g2.journal.filter((j) => j.kind === 'setLimits').length === n1, 'n=' + n1);
      srv2.close();
    }
  }
})().catch((e) => { check('B15 supervise 块无异常', false, e && e.message); }).then(() => {
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
});
