#!/usr/bin/env node
'use strict';

// 阶段 1「所有权归一」契约回归（ARCHITECTURE-CONTRACT-phase0）：
//   INV-X1 守卫内核不得 systemctl stop/restart 自己所属单元（自停死锁的结构防线）
//   INV-S1 stopping/stopped 期间抑制一切自动拉起
//   INV-S2 退出唯一入口 shutdownAll（→ /session/stop）
//   INV-S4 会话态唯一读取口 sessionState()
//   V1     壳不得直接 spawn 守卫进程（存在即校验）
// 自包含：构造最小 Supervisor（TMP stateFile，不 start 定时器），不触碰生产文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  // ── 1) INV-X1：内核静态不变量——不得出现自停/自重启自己所属单元 ──
  console.log('== INV-X1 所有权：内核不得自停/自重启守卫单元 ==');
  const supSrc = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
  // 匹配 systemctl 调用且参数含 dsh-supervisor 的 stop/restart（自停）
  const selfStopRe = /systemctl'[^\n]*\[\s*'--user'\s*,\s*'(?:stop|restart)'\s*,\s*'dsh-supervisor'/;
  check('INV-X1a supervisor.js 无 systemctl stop/restart dsh-supervisor 自停', !selfStopRe.test(supSrc), selfStopRe.test(supSrc) ? '发现自停调用' : 'ok');
  const daemonLifecycleSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'daemons', 'process.js'), 'utf8');
  check('INV-X1b daemon-lifecycle 无守卫单元自停', !/dsh-supervisor/.test(daemonLifecycleSrc), 'ok');

  // ── 2) 会话状态机基础 ──
  console.log('== 会话状态机（契约 §3）==');
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:28181/',
    probeIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28180,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
  };
  const sup = new Supervisor(cfg);
  check('会话态初始 = starting', sup.sessionState() === 'starting', sup.sessionState());
  check('INV-S4 会话态经 sessionState() 读取', typeof sup.sessionState === 'function');
  check('_sessionHalting() 初始为 false', sup._sessionHalting() === false);

  // ── 3) INV-S1：stopping 期间抑制自动拉起 ──
  console.log('== INV-S1 stopping 抑制拉起 ==');
  let spawned = 0;
  sup._startProcess = async () => { spawned++; sup._mSetPhase('STARTING'); };
  // 放行门：desired=running + 显式 start 意图（守护关也能拉起）
  sup._mSetDesired('running');
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  const spawnedWhenRunning = spawned;
  check('running 会话态：显式意图可触发拉起', spawnedWhenRunning >= 1, 'spawned=' + spawnedWhenRunning);

  // 进入 stopping → 同一条件下必须抑制
  spawned = 0;
  sup._setSessionState('stopping');
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  check('INV-S1 stopping 期间抑制拉起（spawned=0）', spawned === 0, 'spawned=' + spawned);

  // ── 4) 退出：shutdownAll 置 stopped 且幂等 ──
  console.log('== 退出（契约 §4.1）==');
  sup._setSessionState('running'); // 复位（上一步 INV-S1 测试停在 stopping）
  const r1 = await sup.shutdownAll();
  check('shutdownAll 返回回执 { ok, sessionState:stopped }', r1 && r1.ok === true && r1.sessionState === 'stopped', JSON.stringify(r1));
  check('会话态 = stopped', sup.sessionState() === 'stopped', sup.sessionState());
  check('_sessionHalting() = true', sup._sessionHalting() === true);
  check('退出后 _shellHalted=true（跨守卫重启抑制看护）', sup._shellHalted === true, String(sup._shellHalted));
  check('statusSummary 暴露 shellHalted', sup.statusSummary().shellHalted === true, JSON.stringify(sup.statusSummary().shellHalted));
  const r2 = await sup.shutdownAll();
  check('shutdownAll 幂等（already 回执）', r2 && r2.ok === true && r2.already === true && r2.sessionState === 'stopped', JSON.stringify(r2));

  // stopped 期间仍抑制
  spawned = 0;
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  check('INV-S1 stopped 期间同样抑制拉起', spawned === 0, 'spawned=' + spawned);

  // ── 4b) 阶段 2 意图单源：desired 是恢复权威（契约 §5/§6）──
  console.log('== 阶段 2 意图单源（恢复语义）==');
  {
    const s2 = new Supervisor(cfg);
    s2._startProcess = async () => { spawned++; s2._mSetPhase('STARTING'); };
    // 场景 A：守卫重启后 desired=running + guardian=false + 无任何内存意图 → 必须拉起
    spawned = 0;
    s2._mSetDesired('running');
    s2._mSetGuardianForTest ? s2._mSetGuardianForTest(false) : null;
    s2._setSessionState('running');
    s2._mSetPhase('STOPPED');
    s2.intents.clear(); // 无显式意图（模拟重启后内存态为空）
    await s2.tick();
    check('P2-A desired=running+guardian=false+无意图 → 拉起（恢复语义）', spawned >= 1, 'spawned=' + spawned);

    // 场景 B：desired=stopped → 绝不拉起
    spawned = 0;
    s2._mSetDesired('stopped');
    s2._setSessionState('running');
    s2._mSetPhase('STOPPED');
    s2.intents.clear();
    await s2.tick();
    check('P2-B desired=stopped → 不拉起', spawned === 0, 'spawned=' + spawned);

    // 场景 C：未守护崩溃 → 停靠；下一拍（desired 仍 running）不得自动拉起
    spawned = 0;
    s2._mSetDesired('running');
    s2._setSessionState('running');
    s2._crashHalted = true; // 模拟未守护崩溃停靠
    s2._mSetPhase('STOPPED');
    s2.intents.clear();
    await s2.tick();
    check('P2-C 未守护崩溃停靠后不自动拉起（guardian 语义保留）', spawned === 0, 'spawned=' + spawned);

    // 场景 D：显式启动清除停靠 → 拉起（setDesired 内部自带 tick；等其结算）
    spawned = 0;
    s2._mSetDesired('stopped');
    s2._crashHalted = true;
    s2._mSetPhase('STOPPED');
    s2.setDesired('running'); // 显式启动：清停靠 + 注册意图 + 触发 tick
    check('P2-D 显式启动清除崩溃停靠标记', s2._crashHalted === false, 'halted=' + s2._crashHalted);
    await new Promise((r) => setTimeout(r, 80)); // 等内部 tick 结算（_ticking 守卫下 await tick 会空跑）
    check('P2-D 显式启动后拉起', spawned >= 1, 'spawned=' + spawned);
  }

  // ── 5) V1 段已移除（2026-09-11 清理）──
  // 该段读 `<内核仓>/.shell-work/src-tauri/src/main.rs` —— 即**从内核仓跨仓读取壳仓源码**，
  // 是双仓隔离未彻底的残留（壳 checkout 本就不该出现在内核仓目录内）。
  // 且其断言在内核 P0 修复后已**语义过时**：壳现在确实会 spawn 守卫作为服务管理器不可用时的兜底，
  // 且该逻辑已从 main.rs 迁至 service.rs（断言仍在查 main.rs）。
  // 壳侧不变量由**壳仓自身**的测试保证（bootstrap_flow.rs 的 B13/B14 等），内核仓不再越界。

  // ── 6) /session API 契约 ──
  console.log('== /session API ==');
  const lifecycleApi = require(path.join(ROOT, 'src', 'api', 'domains', 'lifecycle'));
  check('lifecycle.owns(/session/status)', lifecycleApi.owns('/session/status') === true);
  check('lifecycle.owns(/session/stop)', lifecycleApi.owns('/session/stop') === true);

  // ── 7) 阶段 3：会话态贯通（statusSummary / 全域抑制 / 前端 / 壳握手）──
  console.log('== 阶段 3 会话态贯通 ==');
  {
    const s3 = new Supervisor(cfg);
    check('P3-G shellHalted 跨守卫重启继承（新守卫读回）', s3._shellHalted === true, String(s3._shellHalted));
    const snap = s3.statusSummary();
    check('P3-A statusSummary 暴露 sessionState', snap.sessionState === 'starting', JSON.stringify(snap.sessionState));
    s3._setSessionState('stopping');
    check('P3-B sessionState 随迁移更新', s3.statusSummary().sessionState === 'stopping', s3.statusSummary().sessionState);

    // INV-S1 全域：沙箱 / daemon supervise 在 halting 时短路
    let sandboxTouched = false, daemonTouched = false;
    s3.instances = { supervise: async () => { sandboxTouched = true; }, probeInstance: () => ({ running: true }) };
    s3._syncSandboxRegistryEntry = () => {};
    const sr = await s3._sandboxSuperviseOnce({ id: 'inst-x' });
    check('P3-C stopping 期间沙箱 supervise 短路（INV-S1 全域）', sr && sr.ok === false && sandboxTouched === false, JSON.stringify(sr));
    const dr = await s3._daemonSuperviseOnce('router');
    check('P3-D stopping 期间 daemon supervise 短路（INV-S1 全域）', dr && dr.ok === false && daemonTouched === false, JSON.stringify(dr));
  }

  // 前端接入（静态契约）
  {
    const clientTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
    const typesTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'types.ts'), 'utf8');
    // 会话态经 /status.sessionState 投影（2s 轮询）供 UI 消费；/session/status 保留给壳与外部脚本。
    // 注：P2-C1 已删除冗余的 client.sessionStatus（原双路径），故此处断言类型契约而非该方法。
    check('P3-E 前端类型声明 sessionState（/status 投影）', /sessionState\?:\s*SessionState/.test(typesTs), 'ok');
    check('P3-F 前端 types 声明 sessionState', /sessionState\?:\s*SessionState/.test(typesTs) && /export type SessionState/.test(typesTs), 'ok');
  }

  // P3-G / P3-H 段已移除（2026-09-11 清理）：原为跨仓静态断言（读壳仓源码字符串），
  // 属双仓隔离残留。壳的握手/超时契约由壳仓自身测试保证。

  // ── 8) 阶段 4：遗留债清零 ──
  console.log('== 阶段 4 遗留债 ==');
  {
    const lifecycleSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'lifecycle.js'), 'utf8');
    // 单读路径：/events 不应再有 `if (sup.eventHub) {...} else {...}` 双分支（降级适配器统一）
    const dualBranch = /if \(sup\.eventHub\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,400}?sup\.events\.readSince/.test(lifecycleSrc);
    check('P4-A /events 已消除 hub/fallback 双读分支', !dualBranch, 'ok');
    check('P4-B lifecycle 引用统一读接口 eventHub', lifecycleSrc.includes('hub.readVisible') && lifecycleSrc.includes('const hub = sup.eventHub'), 'ok');

    // 空对象适配器：接口完备 + 与 EventHub 同源（共用共享实现）
    const { EventReader } = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'hub'));
    const fakeEvents = { seq: 7, readAll: () => ([{ seq: 1, type: 'a' }, { seq: 2, type: 'shadow_beat' }]), readSince: (a, l) => [{ seq: 1, type: 'a' }] };
    const rd = new EventReader(fakeEvents);
    const ifaceOk = ['seq', 'read', 'readVisible', 'readFiltered', 'tailLog', 'exportLines', 'metrics', 'sync']
      .every((m) => (m === 'seq' ? typeof rd[m] !== 'undefined' : typeof rd[m] === 'function'));
    check('P4-C EventReader 实现完整读接口', ifaceOk, 'ok');
    check('P4-D EventReader.readVisible 过滤 internal 且同 EventHub 语义', rd.readVisible(0, 50).every((e) => e.type !== 'shadow_beat'), JSON.stringify(rd.readVisible(0, 50)));
    check('P4-E EventReader.seq 透传本地事件流', rd.seq === 7, 'seq=' + rd.seq);
  }
  // P4-F / P4-G 段已移除（2026-09-11 清理）：同样是从内核仓跨仓读取壳仓 env.rs，
  // 属双仓隔离残留。壳的 closeAction 实现细节由壳仓自身测试保证。

  // ── 9) P2：B1 能力元数据执法 + C1/A5 前端接线 ──
  console.log('== P2 B1 能力执法 ==');
  {
    const { LifecycleManager } = require(path.join(ROOT, 'src', 'app', 'control', 'manager'));
    const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters'));
    const mgr = new LifecycleManager({});
    registerAll(mgr, {
      router: { start: async () => ({ ok: true }), stop: async () => ({ ok: true }), status: () => ({}) },
      lan: { reconcile: async () => {}, syncFrpc: () => {}, shutdown: () => {}, status: () => ({}) },
      instances: { instances: [] },
      supervisor: { setDesired: () => ({ ok: true }), requestRestart: () => ({ ok: true }), mainGuardian: () => false, desired: 'stopped', phase: 'STOPPED', statusSummary: () => ({}) },
      pluginManager: {},
    });
    check('B1-a 可启停模块 startable=true（dsh/router/lan）',
      ['dsh', 'router', 'lan'].every((id) => mgr.get(id).startable === true), 'ok');
    check('B1-b 聚合模块 startable=false（instances/plugins）',
      ['instances', 'plugins'].every((id) => mgr.get(id).startable === false), 'ok');
    check('B1-c guardable=false 时 guardian 被锁定为 false', mgr.get('plugins').guardable === false && mgr.get('plugins').guardian === false, 'ok');
    check('B1-d snapshot 暴露 startable/guardable', mgr.get('plugins').snapshot().startable === false && mgr.get('router').snapshot().startable === true, 'ok');
    const r1 = await mgr.start('plugins');
    const r2 = await mgr.stop('instances');
    const r3 = await mgr.restart('plugins');
    check('B1-e 不可启停模块 start/stop/restart 被拒（非假成功）',
      r1.ok === false && r2.ok === false && r3.ok === false && /不可启停/.test(r1.error || ''), JSON.stringify(r1));
    check('B1-f 可启停模块仍放行', (await mgr.start('router')).ok === true, 'ok');
    // 能力声明单一源：adapters 从 MANAGED_KINDS 取（改表即生效）
    const adaptersSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'control', 'adapters.js'), 'utf8');
    // ⚠ 2026-09-16 步骤6：guard/lifecycle/objects.js → app/control/registry.js（编排层重组）
    check('B1-g adapters 从 MANAGED_KINDS 取能力（单一源）', adaptersSrc.includes('capsOf(') && adaptersSrc.includes("require('./registry')"), 'ok');
  }

  console.log('== P2 C1/A5 前端接线 ==');
  {
    const clientTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
    check('C1-a 已删除死方法 sessionStatus', !/sessionStatus:\s*\(\)/.test(clientTs), 'ok');
    check('C1-b 已删除死方法 lifecycleGet', !/lifecycleGet:\s*\(/.test(clientTs), 'ok');
    const aboutTsx = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'settings', 'AboutCard.tsx'), 'utf8');
    check('A5-a 源码形态更新通道已接线（guardVersionCheck）', aboutTsx.includes('guardVersionCheck()') && aboutTsx.includes('git-repo'), 'ok');
    check('A5-b 自更新不可用时回退而非直接报错', aboutTsx.includes('upstream === "git-repo"'), 'ok');
  }

  // ── E-3（AUDIT-2026-09-19）：意图轴单源谓词拆分 + B17 外部关停持久化（源码形态门禁）──
  console.log('== E-3 谓词单源 + B17 ==');
  {
    const collab = fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'collaborators.js'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'bootstrap.js'), 'utf8');
    const shut = fs.readFileSync(path.join(ROOT, 'src', 'app', 'session', 'shutdown.js'), 'utf8');
    const lineOf = (src, re) => (src.match(re) || [''])[0];
    // 1) _exitIntended = 通用退出（stopping ∨ session halting），且【不含】_shellHalted。
    const exitDef = lineOf(collab, /host\._exitIntended = [^\n]*\n/);
    check('E-3 _exitIntended 定义含 stopping 与 halting', /_stopping/.test(exitDef) && /halting\(\)/.test(exitDef), exitDef.trim());
    check('E-3 _exitIntended 不含 _shellHalted（主 DSH 恢复权威是 desired，非壳退出）', !/_shellHalted/.test(exitDef), exitDef.trim());
    // 2) _shellExitIntended 额外含 _shellHalted，仅供壳看护。
    const shellDef = lineOf(collab, /host\._shellExitIntended = [^\n]*\n/);
    check('E-3 _shellExitIntended 含 _shellHalted（桌面壳域退出判据）', /_shellHalted/.test(shellDef) && /_exitIntended\(\)/.test(shellDef), shellDef.trim());
    // 3) 壳看护 halted 门切到 _shellExitIntended（不再是裸 _exitIntended）。
    check('E-3 壳看护 halted 用 _shellExitIntended（9-18 壳侧 shellHalted 生效）', /halted:\s*\(\)\s*=>\s*host\._shellExitIntended\(\)/.test(boot), 'ok');
    check('E-3 壳看护 halted 不再直接绑裸 _exitIntended（会丢 shellHalted 原子）', !/halted:\s*\(\)\s*=>\s*host\._exitIntended\(\)/.test(boot), 'ok');
    // 4) 反向（防空转）：旧「三原子合一」形态（_exitIntended 内含 _shellHalted）必须被判 FAIL。
    const OLD_PRED = 'host._exitIntended = () => !!(host._stopping || host._shellHalted || session.halting());\n';
    const oldLine = lineOf(OLD_PRED, /host\._exitIntended = [^\n]*\n/);
    check('E-3 反向：判据能识别「_exitIntended 混入 _shellHalted」的旧形态',
      /_stopping/.test(oldLine) && /halting\(\)/.test(oldLine) && /_shellHalted/.test(oldLine), oldLine.trim());
    // 5) B17：外部 SIGTERM 关停（无在途会话退出）持久化 shellHalted + 事件；会话 halting 时不重复置位。
    check('B17 shutdown() 外部停落在 _shellHalted=false 且非会话 halting 时持久化退出意图',
      /if \(!host\._shellHalted && !host\._sessionHalting\(\)\) \{/.test(shut) && /host\._shellHalted = true;/.test(shut) && /shell_halt_on_external_stop/.test(shut), 'ok');
    // 反向：无守卫的旧 shutdown（无 !host._sessionHalting() 前置即盲写）应能被判缺——用去守卫样本验证正则确有牙。
    const OLD_SHUT = 'function shutdown(host){ host._stopping = true; host.lifecycle.beginShutdown(); }';
    check('B17 反向：判据要求 !host._shellHalted && !host._sessionHalting() 守卫存在',
      !/if \(!host\._shellHalted && !host\._sessionHalting\(\)\) \{/.test(OLD_SHUT), 'ok');
    // 6) B16 接线：组合根必须把单源谓词注入 PluginManager（行为级 O 组锁域内逻辑，此处锁接线）。
    const dom = fs.readFileSync(path.join(ROOT, 'src', 'app', 'assembly', 'compose', 'domains.js'), 'utf8');
    check('B16 组合根向 PluginManager 注入 exitIntended（E-3 单源）',
      /exitIntended:\s*\(\)\s*=>\s*host\._exitIntended\(\)/.test(dom), 'ok');
    check('B16 反向：旧「不注入」形态（无 exitIntended 行）可被判缺',
      !/exitIntended:\s*\(\)\s*=>\s*host\._exitIntended\(\)/.test("new PluginManager({ dshBin, instances: host.instances, tasks: host.tasks })"), 'ok');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
