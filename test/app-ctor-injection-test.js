#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// test/app-ctor-injection-test.js —— app 级 2「真 ctor 注入」直测（DF-6 判据）。
//
// 判据：协作方模块可**只 require + 假 deps**直接断言行为，无需构造 Supervisor。
// 覆盖三个已完成工厂化的切面：state / session / control。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const { createStateStore } = require(path.join(ROOT, 'src', 'app', 'state', 'collaborator'));
const { createSession } = require(path.join(ROOT, 'src', 'app', 'session', 'machine'));
const { createControlPlane } = require(path.join(ROOT, 'src', 'app', 'control', 'collaborator'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctor-inj-'));
const warnLog = [];

/** 假受管目录（含真实 setPhase/update/register/unregister 语义）。 */
function fakeRegistry() {
  const entries = new Map();
  return {
    entries,
    _loadedFromDisk: false,
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    setPhase(id, ph) { const e = entries.get(id); if (e) { e.phase = ph; e.lastTransitionAt = 't'; } },
    // 与真实 registry.update 同源的关键语义：**值为 undefined 的键不改写**（D-8 的 keepDesired
    //   正是靠这一点成立；用裸 Object.assign 会把 desired 抹成 undefined，假件反而比实现更严）。
    update(id, patch) {
      const e = entries.get(id);
      if (!e) return { ok: false, error: '未注册: ' + id };
      for (const k of Object.keys(patch || {})) if (patch[k] !== undefined) e[k] = patch[k];
      return { ok: true, object: e };
    },
    register(spec) { entries.set(spec.id, Object.assign({ phase: 'stopped' }, spec)); },
    unregister(id) { entries.delete(id); },
    persistCrashState() {},
  };
}

// ---------------------------------------------------------------------------
// F8 state：createStateStore(deps) —— 自己持有 phase/desired/字段/IO 实现
// ---------------------------------------------------------------------------
{
  const reg = fakeRegistry();
  const stateFile = path.join(tmp, 'state.json');
  const state = createStateStore({
    getConfig: () => ({ stateFile }),
    getConfigPath: () => path.join(tmp, 'config.json'),
    getLogger: () => ({ warn: (m) => warnLog.push(m) }),
    getEvents: () => null,
    getManagedObjects: () => reg,
    getInstances: () => null,
    getViews: () => ({ status: () => ({ updatedAt: null }) }),
    getIntents: () => null,
    getHold: () => false, setHold() {}, getSince: () => null, setSince() {},
    getCrashHalted: () => false, setCrashHalted() {},
    getManualRestart: () => false, setManualRestart() {},
    stopProcess() {}, tick() {},
  });

  check('S1 state 工厂可独立构造（无 Supervisor）', typeof state.phase === 'function', 'ok');
  check('S2 无目录项 → fallback：phase 默认 STOPPED', state.phase() === 'STOPPED', state.phase());

  state.setPhase('RUNNING');
  check('S3 setPhase 大写 → 目录 canonical running', state.store().phase === 'running', state.store().phase);
  check('S4 phase 读回大写 RUNNING', state.phase() === 'RUNNING', state.phase());

  state.setDesired('stopped');
  check('S5 setDesired 写目录 desired', state.store().desired === 'stopped' && state.desired() === 'stopped', state.desired());

  state.field('restartCount', 3);
  check('S6 field 写读一致', state.field('restartCount') === 3, String(state.field('restartCount')));
  state.procField('adopted', true);
  check('S7 procField 写读一致', state.procField('adopted') === true, String(state.procField('adopted')));
  check('S8 访问器 phase/desired 与协作方同源', state.accessors.phase.get() === 'RUNNING' && state.accessors.desired.get() === 'stopped', 'ok');

  state.writeMainMeta({ guardian: true, remoteToken: 'tok' });
  check('S9 main 元数据写后读同源', state.readMainMeta().guardian === true && state.readMainMeta().remoteToken === 'tok', 'ok');
  check('S10 mainMetaFile 派生自 stateFile', state.mainMetaFile() === path.join(tmp, 'dsh-main.json'), state.mainMetaFile());
  const rf = state.registryFileName();
  check('S11 registryFileName 派生（生产 state.json → managed-objects.json）', rf === 'managed-objects.json', rf);

  state.persistConfigPatch({ apiAccessKey: 'k' });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  check('S12 persistConfigPatch 原子落盘', cfg.apiAccessKey === 'k', JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// config.json 读/解析失败 -> **拒绝写回**（fail-closed），
//   原字节保留；仅 ENOENT（首启）照常写入。旧行为 catch{} 后以 cur={} 覆盖 -> 全键静默蒸发。
// ---------------------------------------------------------------------------
{
  const { createDesired } = require(path.join(ROOT, 'src', 'app', 'state', 'desired.js'));
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-config-'));
  const cf = path.join(t, 'config.json');
  const warns = []; const evs = [];
  const d = createDesired({
    getConfigPath: () => cf,
    getLogger: () => ({ warn: (m) => warns.push(String(m)) }),
    getEvents: () => ({ append: (e) => evs.push(e) }),
    fields: {}, store: {},
  });
  check('A1a 首启（文件缺失）仍照常写入 —— 不伤可用性',
    d.persistConfigPatch({ apiPort: 8080 }) === true
    && JSON.parse(fs.readFileSync(cf, 'utf8')).apiPort === 8080, 'ok');
  fs.writeFileSync(cf, '{"apiAccessKey":"SECRET","swit');
  check('A1a 半截 JSON → 返回 false', d.persistConfigPatch({ apiPort: 9 }) === false, 'false');
  check('A1a **原字节保留**（未被派生内容覆盖）',
    fs.readFileSync(cf, 'utf8') === '{"apiAccessKey":"SECRET","swit', fs.readFileSync(cf, 'utf8').slice(0, 24));
  check('A1a 根为数组同样拒绝', (() => { fs.writeFileSync(cf, '[1,2]'); return d.persistConfigPatch({ apiPort: 9 }) === false && fs.readFileSync(cf, 'utf8') === '[1,2]'; })(), 'ok');
  fs.rmSync(cf); fs.mkdirSync(cf); // EISDIR：非 ENOENT 读失败
  check('A1a 读失败（EISDIR，非 ENOENT）拒绝', d.persistConfigPatch({ apiPort: 9 }) === false, 'false');
  fs.rmSync(cf, { recursive: true });
  check('A1a 故障解除后可正常再写',
    d.persistConfigPatch({ apiPort: 7 }) === true && JSON.parse(fs.readFileSync(cf, 'utf8')).apiPort === 7, 'ok');
  check('A1a 不静默：warn 日志 + config_persist_aborted 事件都在',
    warns.some((w) => /fail-closed/.test(w)) && evs.filter((e) => e === 'config_persist_aborted').length >= 3,
    JSON.stringify(evs));
}

// ---------------------------------------------------------------------------
// dsh-main.json 损坏 -> 读回默认值但标记 corrupt，
//   后续**不带显式 remoteToken 的写回一律拒绝**（默认值覆盖 = 令牌静默清零 -> 零认证降级，
//   运行时同型）；显式重设令牌是唯一解锁路径。
// ---------------------------------------------------------------------------
{
  const { createMainStore } = require(path.join(ROOT, 'src', 'app', 'state', 'main-store.js'));
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-main-'));
  const sf = path.join(t, 'state.json');
  const mf = path.join(t, 'dsh-main.json');
  const warns = [];
  const mkStore = () => createMainStore({ getConfig: () => ({ stateFile: sf }), getLogger: () => ({ warn: (m) => warns.push(String(m)) }) });
  // 首启：无文件照常写
  mkStore().writeDshMain({ guardian: true, remoteToken: 'TK-1' });
  check('A1b 首启写入正常', JSON.parse(fs.readFileSync(mf, 'utf8')).remoteToken === 'TK-1', 'ok');
  // 损坏态
  fs.writeFileSync(mf, '{"guardian":true,"remoteToken":"TK-SECRET"');
  const ms = mkStore();
  ms.writeDshMain({ guardian: true }); // 先写后读：内部首次读即判 corrupt
  check('A1b corrupt 态**拒绝默认值覆盖写**（原字节保留）',
    fs.readFileSync(mf, 'utf8') === '{"guardian":true,"remoteToken":"TK-SECRET"', fs.readFileSync(mf, 'utf8').slice(0, 24));
  const meta = ms.readDshMain();
  check('A1b 读回降级为默认值但**留 warn**（不静默）',
    meta.remoteToken === '' && warns.some((w) => /dsh-main\.json 读\/解析失败/.test(w)), JSON.stringify(warns).slice(0, 120));
  ms.writeDshMain({ remoteToken: 'TK-RESET' });
  check('A1b 唯一解锁：显式重设 remoteToken 可写回',
    JSON.parse(fs.readFileSync(mf, 'utf8')).remoteToken === 'TK-RESET', fs.readFileSync(mf, 'utf8').slice(0, 60));
  ms.writeDshMain({ guardian: true });
  check('A1b 解锁后普通写恢复', JSON.parse(fs.readFileSync(mf, 'utf8')).guardian === true, 'ok');
}

// ---------------------------------------------------------------------------
// F2 session：createSession(deps) —— 自己持有会话态
// ---------------------------------------------------------------------------
{
  const evs = [];
  const session = createSession({
    events: () => ({ append: (e, p) => evs.push([e, p]) }),
    desired: () => 'running',
    crashHalted: () => false,
  });
  check('C1 初始 starting 且 shouldRun=true', session.state() === 'starting' && session.shouldRun() === true, session.state());
  session.setState('running');
  session.setState('stopping');
  check('C2 stopping → halting=true / shouldRun=false', session.halting() === true && session.shouldRun() === false, String(session.halting()));
  check('C3 迁移发 session_state 事件', evs.length === 2 && evs[0][0] === 'session_state', JSON.stringify(evs));

  const halted = createSession({ events: () => null, desired: () => 'running', crashHalted: () => true });
  check('C4 crashHalted → shouldRun=false', halted.shouldRun() === false, String(halted.shouldRun()));
  const stopped = createSession({ events: () => null, desired: () => 'stopped', crashHalted: () => false });
  check('C5 desired=stopped → shouldRun=false', stopped.shouldRun() === false, String(stopped.shouldRun()));
}

// ---------------------------------------------------------------------------
// F6/F7 control：createControlPlane(deps) —— 视图投影 + 受管申报
// ---------------------------------------------------------------------------
{
  const reg = fakeRegistry();
  reg.register({ kind: 'dsh', id: 'main', desired: 'running', phase: 'running' });
  const lcMap = new Map();
  const mkLc = (id) => ({ id, desired: 'stopped', phase: 'stopped', _monitoring: false, _setPhase(p) { this.phase = p; }, wantRunning() { this.desired = 'running'; } });
  const routerLc = mkLc('router'); routerLc.desired = 'running'; lcMap.set('router', routerLc);
  lcMap.set('instances', mkLc('instances'));
  lcMap.set('dsh', mkLc('dsh'));
  const mgr = { get: (id) => lcMap.get(id) };

  const state = {
    dshEntry: () => reg.get('main'),
    phase: () => 'RUNNING',
    desired: () => 'running',
    guardian: () => true,
    readMainMeta: () => ({ guardian: true }),
  };
  const control = createControlPlane({
    getLifecycleManager: () => mgr,
    getState: () => state,
    getManagedObjects: () => reg,
    getInstances: () => ({ instances: [], sandboxRoot: (i) => '/root/' + i.id }),
    getConfig: () => ({ targetPort: 3080, routerAutostart: true }),
    getCtl: () => ({ routerPort: () => 43107, lanPort: () => 43108 }),
    getDaemons: () => ({ enabled: () => false }),
    getLogger: () => ({ info() {}, warn() {} }),
  });

  control.syncInstancesView();
  check('P1 syncInstancesView → instances 视图 running/healthy', lcMap.get('instances').phase === 'running' && lcMap.get('instances').healthy === true, lcMap.get('instances').phase);
  control.syncRouterView({ ok: true });
  check('P2 syncRouterView(ok) → router running/healthy', lcMap.get('router').phase === 'running' && lcMap.get('router').healthy === true, lcMap.get('router').phase);
  control.syncDshView();
  check('P3 syncDshView → dsh running + guardian 同源', lcMap.get('dsh').phase === 'running' && lcMap.get('dsh').guardian === true, lcMap.get('dsh').phase);

  const spec = control.sandboxSpec({ id: 's1', name: '沙箱', port: 3900, state: { phase: 'RUNNING' }, guardian: true });
  check('P4 sandboxSpec 申报 desired=running + unit', spec && spec.desired === 'running' && spec.ownership.unit === 'dsh-web@s1', JSON.stringify(spec && spec.ownership));
  check('P5 sandboxSpec 的 rootPath 来自实例域', spec.ownership.rootPath === '/root/s1', spec.ownership.rootPath);

  control.upsert(spec);
  check('P6 upsert 注册沙箱实例', !!reg.get('s1'), 'ok');
  control.unregister('s1');
  check('P7 unregister 注销', !reg.get('s1'), 'ok');

  reg.unregister('main');
  control.syncManagedRegistry();
  const keys = [...reg.entries.keys()].sort();
  check('P8 syncManagedRegistry 申报 main + router/lan daemon', keys.join(',') === 'lan-daemon,main,router-daemon', keys.join(','));
  check('P9 域 B daemon 申报不含 guardian 字段（G-1）',
    !('guardian' in reg.get('router-daemon')) && !('guardian' in reg.get('lan-daemon')), 'ok');

  // -- D-8：心跳同步路径不得把观测推导的 desired 写回目录 --
  //   缺陷形态：_syncSandboxRegistryEntry 每拍 upsert(sandboxSpec(inst))，而 sandboxSpec 的
  //   desired 由 inst.state.phase 推导 => 实例一崩进 BACKOFF/FAILED，目录里用户意图被静默改成
  //   stopped。
  {
    // 夹具接线：观测对象必须与上面 `control` 的 getManagedObjects 注入的是同一个 `reg`。
    //   另起 `const d8 = fakeRegistry()` 则 control.upsert() 写进 reg、d8 恒空，
    //   `d8.get('d8').desired` 直接 TypeError，本文件 D-8 之后的全部用例被吃掉（&& 链也在此断）。
    //   两条教训：
    //     1) 夹具的观测对象必须与被测对象的**注入源同一引用**，另造一个只会观测到空气；
    //     2) 判据取值先落地成变量再解引用 —— 未接线应当**判红**，不该让进程崩，
    //        因为崩溃会没收后面所有用例的覆盖面（比一条红的代价大得多）。
    const d8 = reg;                                               // 与 control 的 getManagedObjects 同一引用
    const ent = (id) => (d8.get(id) || { __absent: true });       // 未登记 -> 判红，不抛
    const instRunning = { id: 'd8', name: '沙箱', port: 3901, state: { phase: 'RUNNING' }, guardian: false };
    control.upsert(control.sandboxSpec(instRunning));            // 首次登记（动作路径，允许带 desired）
    check('D-8 前提：首登确实落到 control 的注册表（未接线即判红，不再崩溃）',
      !!d8.get('d8'), d8.get('d8') ? 'registered' : 'ABSENT');
    check('D-8 前提：首登按观测登记 desired=running',
      ent('d8').desired === 'running', String(ent('d8').desired));
    ent('d8').desired = 'running';                                // 用户意图：要它在跑
    control.upsert(control.sandboxSpec({ ...instRunning, state: { phase: 'BACKOFF' } }), { keepDesired: true });
    check('D-8 行为：keepDesired 同步不改写 desired（崩溃不被判成「用户想停」）',
      ent('d8').desired === 'running', String(ent('d8').desired));
    control.upsert(control.sandboxSpec({ ...instRunning, state: { phase: 'STOPPED' }, name: '改名' }), { keepDesired: true });
    check('D-8 行为：keepDesired 仍同步其余应然（name/guardian/ownership）',
      ent('d8').name === '改名', String(ent('d8').name));
    control.upsert(control.sandboxSpec({ id: 'd8b', name: '沙箱2', port: 3902, state: { phase: 'STOPPED' }, guardian: false }), { keepDesired: true });
    check('D-8 register 分支不受 keepDesired 影响（否则缺省会谎报 running）',
      ent('d8b').desired === 'stopped', String(ent('d8b').desired));
    control.upsert(control.sandboxSpec({ ...instRunning, state: { phase: 'STOPPED' } }));  // 动作路径（无旗标）
    check('D-8 反向：动作路径仍按观测对齐 desired（停真实例必须落 stopped）',
      ent('d8').desired === 'stopped', String(ent('d8').desired));

    // 源码形态：心跳同步调用点必须带旗标；动作路径不得带（否则用户 stop 后目录永远 running）
    const { stripComments } = require('./_strip');
    const ad = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'control', 'instance-adapter.js'), 'utf8'));
    const bs = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'compose', 'observers.js'), 'utf8'));
    const FLAG_RE = /sandboxSpec\(inst\),\s*\{\s*keepDesired:\s*true\s*\}/;
    check('D-8 接线：心跳同步路径带 keepDesired', FLAG_RE.test(ad), '已接');
    check('D-8 接线：动作路径（onInstanceStart/Stop）仍同步 desired（不带旗标）',
      !/keepDesired/.test(bs) && /_upsertManaged\(host\._managedSandboxSpec\(inst\)\)/.test(bs), '不带');
    // 判据有牙：把旗标从源码里抹掉后必须不再命中（否则这条接线断言是空转的正则）
    check('D-8 判据反向：抹掉旗标即判红（断言非空转）',
      !FLAG_RE.test(ad.replace(', { keepDesired: true }', ')')), '识别为缺陷形态');

    // 启动对齐路径（syncManagedRegistry，boot 时逐实例 upsert）与心跳同形：
    //   `instances.load()` 后的 state.phase 是崩溃/停机快照，BACKOFF 推导成 stopped，
    //   照写会把「守卫重启时实例正好在退避」的用户意图抹掉且无人恢复（9-18 同形）。
    const d8b = fakeRegistry();
    const bootInst = { id: 'd8b', name: '沙箱', port: 3903, state: { phase: 'BACKOFF' }, guardian: false };
    const ctlBoot = createControlPlane({
      getLifecycleManager: () => ({ get: () => null }),
      getState: () => state,
      getManagedObjects: () => d8b,
      getInstances: () => ({ all: () => [bootInst], sandboxRoot: (i) => '/root/' + i.id }),
      getConfig: () => ({ targetPort: 3080, routerAutostart: true }),
      getCtl: () => ({ routerPort: () => 43107, lanPort: () => 43108 }),
      getDaemons: () => ({ enabled: () => false }),
      getLogger: () => ({ info() {}, warn() {} }),
    });
    const ent2 = (id) => (d8b.get(id) || {});   // 同上：未登记取值判红而非崩溃
    ctlBoot.upsert(ctlBoot.sandboxSpec({ ...bootInst, state: { phase: 'RUNNING' } })); // 首登（动作路径）
    check('D-8 前提：启动对齐前目录 desired=running（首登走动作路径）',
      ent2('d8b').desired === 'running', String(ent2('d8b').desired));
    check('D-8 前提：实然快照确实是 BACKOFF（否则本例没有防御对象）',
      bootInst.state.phase === 'BACKOFF', String(bootInst.state.phase));
    ctlBoot.syncManagedRegistry();
    check('D-8 行为：启动对齐不改写既有 desired（退避快照不抹意图）',
      ent2('d8b').desired === 'running', String(ent2('d8b').desired));
    ent2('d8b').name = '旧名';                                       // 目录里是被替换前的显示名
    ctlBoot.syncManagedRegistry();
    check('D-8 行为：keepDesired 只冻结 desired（name 等其余应然仍随观测刷新）',
      ent2('d8b').name === '沙箱', String(ent2('d8b').name));
    check('D-8 行为：同一次刷新里 desired 未被顺手改写',
      ent2('d8b').desired === 'running', String(ent2('d8b').desired));
    // 域 B 的 desired 来源是**配置业务条件**（域 B），启动对齐必须落目录——不得被 keepDesired 冻结
    ctlBoot.syncManagedRegistry();
    check('D-8 边界：router daemon 的 desired 仍由 config 驱动（routerAutostart=true → running）',
      ent2('router-daemon').desired === 'running', String(ent2('router-daemon').desired));
    check('D-8 边界：lan daemon 的 desired 仍由 config 驱动（未启用 → stopped）',
      ent2('lan-daemon').desired === 'stopped', String(ent2('lan-daemon').desired));
    const sp = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'control', 'specs.js'), 'utf8'));
    const bootLine = /upsert\(sandboxSpec\(inst\),\s*\{\s*keepDesired:\s*true\s*\}\)/.test(sp);
    check('D-8 接线：启动对齐的实例循环带 keepDesired', bootLine, bootLine ? '已接' : '仍裸 upsert');
    // 域 B（router/lan）与 main 的 desired 来源是 config / 目录自身，不得被冻结：
    //   全文件只允许实例循环这一处旗标（别处加旗标 -> 计数变 2 -> 判红）。
    const flagSites = (sp.match(/keepDesired:\s*true/g) || []).length;
    check('D-8 接线：specs.js 内 keepDesired 仅实例循环一处（域 B/main 申报仍由 config 驱动）',
      flagSites === 1, 'keepDesired 处数=' + flagSites);
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
