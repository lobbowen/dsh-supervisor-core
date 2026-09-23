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
    // 与真实 registry.update 同源的关键语义：**值为 undefined 的键不改写**（域 B 申报不带 guardian，
    //   靠这一点不被写成 undefined；用裸 Object.assign 会抹掉，假件反而比实现更严）。
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
  check('P4 sandboxSpec 申报不含 desired（B2-1）+ unit/guardian 在位',
    spec && !('desired' in spec) && spec.ownership.unit === 'dsh-web@s1' && spec.guardian === true,
    JSON.stringify(spec && spec.ownership));
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

  // -- D-8：沙箱不申报 desired（B2-1 运行意图第二落点废止），目录应然面只剩 guardian/ownership --
  //   旧形态一：sandboxSpec 的 desired 由 inst.state.phase 反推 => 实例一崩进 BACKOFF，意图被观测改写。
  //   旧形态二（ST-2c）：desired 取 inst.state.desired 投影 => 该落点无决策消费者，纯空转字段。
  //   收口后 spec 不含 desired，registry.update 见 undefined 即跳过——观测/启动对齐路径对沙箱
  //   目录的 desired 彻底没有写权。本块钉 spec 形状、行为与判别器分辨力，不是绕过。
  {
    // 夹具接线：观测对象必须与上面 `control` 的 getManagedObjects 注入的是同一个 `reg`。
    //   两条教训（旧注释保留，仍然成立）：
    //     1) 夹具的观测对象必须与被测对象的**注入源同一引用**，另造一个只会观测到空气；
    //     2) 判据取值先落地成变量再解引用 —— 未接线应当**判红**，不该让进程崩，
    //        因为崩溃会没收后面所有用例的覆盖面（比一条红的代价大得多）。
    const d8 = reg;                                               // 与 control 的 getManagedObjects 同一引用
    const ent = (id) => (d8.get(id) || { __absent: true });       // 未登记 -> 判红，不抛
    const sb = (over) => Object.assign({ id: 'd8', name: '沙箱', port: 3901, guardian: false }, over);

    control.upsert(control.sandboxSpec(sb({ state: { phase: 'RUNNING', desired: 'running' } })));
    check('D-8 前提：首登确实落到 control 的注册表（未接线即判红，不再崩溃）',
      !!d8.get('d8'), d8.get('d8') ? 'registered' : 'ABSENT');
    check('D-8 形状：sandboxSpec 不再含 desired 键（意图投影没有来源）',
      !('desired' in control.sandboxSpec(sb({ state: { phase: 'STOPPED', desired: 'stopped' } }))),
      'keys=' + Object.keys(control.sandboxSpec(sb({}))).join(','));
    // 假件 register 直通 spec（真实 registry 的 createEntry 缺省归一由 managed-registry-test 单独钉），
    //   所以这里能钉到更强的形态：沙箱申报路径对目录 desired **一个值都不写**。
    check('D-8 行为：register 直通后目录 desired 为空（spec 不带键，残留意图字段不参与）',
      ent('d8').desired === undefined, String(ent('d8').desired));
    control.upsert(control.sandboxSpec(sb({ name: '改名', state: { phase: 'BACKOFF', desired: 'stopped' } })));
    check('D-8 行为：残留意图翻成 stopped + BACKOFF 观测，裸 upsert 仍不写 desired，name 照常刷新',
      ent('d8').desired === undefined && ent('d8').name === '改名',
      'desired=' + ent('d8').desired + ' name=' + ent('d8').name);

    // 源码形态：三条申报线必须整体消失；判别器用两代旧形态合成样本证明它有分辨力。
    const { stripComments } = require('./_strip');
    const ad = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'control', 'instance-adapter.js'), 'utf8'));
    const bs = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'compose', 'observers.js'), 'utf8'));
    const sp = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'control', 'specs.js'), 'utf8'));
    const lc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', 'lifecycle.js'), 'utf8'));
    const specBodyOf = (src) => (/function sandboxSpec[\s\S]*?\n  \}/.exec(src) || [''])[0];
    const declaresDesired = (body) => /\bdesired\s*:/.test(body);
    const intentForm = (body) => /desired:\s*\(inst\.state[^?]*\?\s*'stopped'\s*:\s*'running'/.test(body);
    const derivedForm = (body) => /desired:\s*running\s*\?\s*'running'\s*:\s*'stopped'/.test(body);
    const OLD_INTENT_BODY = "function sandboxSpec(inst) {\n    return { id: inst.id, desired: (inst.state && inst.state.desired === 'stopped') ? 'stopped' : 'running',\n      guardian: true };\n  }";
    const OLD_DERIVED_BODY = "function sandboxSpec(inst) {\n    const running = inst.state.phase === 'RUNNING'; return { id: inst.id, desired: running ? 'running' : 'stopped' };\n  }";
    const body = specBodyOf(sp);
    check('D-8 接线：sandboxSpec 体可定位（覆盖面非空）且不再声明 desired',
      body.length > 0 && !declaresDesired(body), '体长=' + body.length);
    check('D-8 反向：判据对意图投影/相位推导两代旧形态都命中，对现行体不命中（非空转）',
      declaresDesired(OLD_INTENT_BODY) && declaresDesired(OLD_DERIVED_BODY)
        && intentForm(OLD_INTENT_BODY) && derivedForm(OLD_DERIVED_BODY)
        && !intentForm(body) && !derivedForm(body), 'hit');
    check('D-8 收口：keepDesired 旗标机制在 src 侧已整体废止（specs/心跳/动作路径）',
      !/keepDesired/.test(sp + ad + bs),
      '出现处数=' + ((sp + ad + bs).match(/keepDesired/g) || []).length);
    const bareSites = (bs.match(/_upsertManaged\(host\._managedSandboxSpec\(inst\)\)/g) || []).length;
    check('D-8 接线：动作路径三处申报点仍在（start/stop/create 各一，只是不再带旗标）',
      bareSites === 3 && /upsert\(d\.control\(\)\.sandboxSpec\(inst\)\)/.test(ad),
      'observers=' + bareSites + ' adapter裸同步=' + /upsert\(d\.control\(\)\.sandboxSpec\(inst\)\)/.test(ad));
    const intentWrites = (lc.match(/inst\.state\.desired\s*=(?!=)/g) || []).length;
    check('D-8 意图写口：lifecycle 内 desired 零出现、零写口（第二落点已废止）',
      (lc.match(/\bdesired\b/g) || []).length === 0 && intentWrites === 0,
      'token=' + (lc.match(/\bdesired\b/g) || []).length + ' write=' + intentWrites);
    check('D-8 意图写口：stop 不再按 opts.intent 分档抹/留意图（transient 档随字段废止退场）',
      !/opts\.intent/.test(lc), '命中=' + (/opts\.intent/.test(lc) ? '有' : '无'));
    const OLD_TRANSIENT = "function stop(id, opts) { const transient = !!(opts && opts.intent === 'transient'); if (!transient) inst.state.desired = 'stopped'; }";
    check('D-8 反向：transient 分档旧形态仍被识别为缺陷形态（判据非空转）',
      /opts\.intent === 'transient'/.test(OLD_TRANSIENT) && !/opts\.intent/.test(lc), '识别为缺陷形态');

    // 启动对齐（syncManagedRegistry 逐实例 upsert）：load() 后的 state.phase 只是实然快照；
    //   沙箱 spec 不带 desired，对齐刷新永远碰不到目录里的应然意图。
    const d8boot = fakeRegistry();
    const bootInst = { id: 'boot1', name: '沙箱', port: 3903, guardian: false, state: { phase: 'BACKOFF', desired: 'running' } };
    const ctlBoot = createControlPlane({
      getLifecycleManager: () => ({ get: () => null }),
      getState: () => state,
      getManagedObjects: () => d8boot,
      getInstances: () => ({ all: () => [bootInst], sandboxRoot: (i) => '/root/' + i.id }),
      getConfig: () => ({ targetPort: 3080, routerAutostart: true }),
      getCtl: () => ({ routerPort: () => 43107, lanPort: () => 43108 }),
      getDaemons: () => ({ enabled: () => false }),
      getLogger: () => ({ info() {}, warn() {} }),
    });
    const ent2 = (id) => (d8boot.get(id) || {});   // 同上：未登记取值判红而非崩溃
    ctlBoot.syncManagedRegistry();
    check('D-8 前提：实然快照确实是 BACKOFF（否则本例没有防御对象）',
      bootInst.state.phase === 'BACKOFF', String(bootInst.state.phase));
    ent2('boot1').desired = 'stale';
    ent2('boot1').name = '旧名';
    bootInst.name = '新名';
    ctlBoot.syncManagedRegistry();
    check('D-8 行为：启动对齐照常刷新其余应然（name 随申报更新）',
      ent2('boot1').name === '新名', String(ent2('boot1').name));
    check('D-8 行为：同一次刷新不顺手改写目录 desired（观测路径对意图零写权）',
      ent2('boot1').desired === 'stale', String(ent2('boot1').desired));
    check('D-8 边界：router daemon 的 desired 仍由 config 驱动（routerAutostart=true → running）',
      ent2('router-daemon').desired === 'running', String(ent2('router-daemon').desired));
    check('D-8 边界：lan daemon 的 desired 仍由 config 驱动（未启用 → stopped）',
      ent2('lan-daemon').desired === 'stopped', String(ent2('lan-daemon').desired));
    const bootLine = /upsert\(sandboxSpec\(inst\)\)/.test(sp);
    check('D-8 接线：启动对齐的实例循环是裸 upsert（意图投影无需旗标）', bootLine, bootLine ? '已接' : '形态意外');
    check('D-8 收口：specs.js 内已无 keepDesired（域 B/main 申报仍由 config 与 state 驱动）',
      !/keepDesired/.test(sp), 'keepDesired 处数=' + (sp.match(/keepDesired/g) || []).length);
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
