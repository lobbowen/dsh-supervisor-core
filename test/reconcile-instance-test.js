#!/usr/bin/env node
'use strict';

// 实例对账（reconcile）契约测试（PROXY-LIFECYCLE-STANDARD W1 形态）：
// 验证生命周期引擎（pool.js 期望集 + restart.js 执行面）的不变量：
//  R1 期望集恒为「在用1+预热1」：可用账号按 registeredAt 登记顺序取前 2，存活进程数=|期望集|；
//    非期望集（等待区）零进程且端口随之归零（LC 核心-3）；对账幂等不重复 spawn
//  R2 在用归属与 sticky：selectedAccountKeyId 提为在用；预热槽 sticky 留任；
//    退位者走停止仲裁回收，下一拍其端口释放；|期望集| <= 2
//  R3 绝不为不可用账号（ready+满额/冻结）保活实例——旧预热-回收死循环的回归防线
//  R4 状态事件表：冻结即即时回收（进程+端口零宽限，_onStatusTransition 钩子），
//    恢复回池（reconcileNow），满额账号不被拉起
//  R5 usage 纯派生：in-use=activeAccount 指向；warming=实例在跑非在用；idle=其余
//  R6 序列化守卫：ready+满额矛盾落盘前自我归位 frozen（不再产生预热燃料）
//  R11 重启幸存者一律弃用重拉（禁 adopt：幸存进程 stdio 归属已死 daemon -> EPIPE 楔死，/health 探针盲区），同端口全新实例无幽灵不漂移
//  R12 停服台账：stopInstance 后 waitAllStopped 确认子进程已死（含忽略 SIGTERM 的进程，SIGKILL 兜底）——防停服孤儿化
//  R13 上游超时实例级自愈：restartInstance upstream-timeout kill 旧进程并同端口重拉（账号切换自愈闭环）
//  R14 锁收敛（A）：锁只对可用账号有意义——冻结/封号即清锁；serialize 与加载不落死锁；不可用账号拒锁
// 自包含：mock 反代本地 spawn，不触碰真实 commandcode/外部服务。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const mockApp = path.join(TMP, 'verproxy.js');
fs.writeFileSync(mockApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18999'),10);\nhttp.createServer((req,res)=>{ if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok', version:'1.2.3'})); return; } res.writeHead(404); res.end('nf'); }).listen(port,'127.0.0.1',()=>console.log('verproxy on '+port));\nprocess.on('SIGTERM',()=>process.exit(0));\n");

// 进程泄漏防线：登记本测试 spawn 的全部子进程 pid，进程退出前强制 SIGKILL 兜底——
// stopInstance 的 SIGKILL 兜底是 .unref() 定时器（1.5s），若测试进程先退出则不触发 -> 子进程孤儿
// 残留占用 4100x 端口 -> 干扰后续测试文件（跨文件 flaky 根因）。
const allProviders = [];
const spawnedPids = new Set();
function trackProvider(p) { allProviders.push(p); }
function trackSpawn(inst) { if (inst && inst.pid) spawnedPids.add(inst.pid); }
function killSpawnedSync() {
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  spawnedPids.clear();
  for (const p of allProviders) { for (const i of (p.instances || [])) { try { if (i.pid) process.kill(i.pid, 'SIGKILL'); } catch {} } }
}
process.on('exit', () => killSpawnedSync());
process.on('SIGINT', () => { killSpawnedSync(); process.exit(130); });
process.on('SIGTERM', () => { killSpawnedSync(); process.exit(143); });

(async () => {
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  // 子进程追踪：包装 _doStart 完成后登记 pid（exit 钩子 SIGKILL 兜底防孤儿残留跨文件污染）
  const _origDoStart = ProxyProvider.prototype._doStart;
  ProxyProvider.prototype._doStart = async function (inst) {
    const r = await _origDoStart.call(this, inst);
    if (r && r.ok && inst && inst.pid) spawnedPids.add(inst.pid);
    return r;
  };
  const { keyFingerprint } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports')).shared;
  ports.configureFile(path.join(TMP, 'ports-router.json'));
  const log = { info(){}, warn(){}, error(){}, debug(){} };
  const app = { id: 'vm', name: 'VM', command: ['node', mockApp, '--port', '{{port}}', '--api-key', '{{key}}'], healthPath: '/health', upstream: 'http://127.0.0.1:0', real: false, quota: { type: 'commandcode-billing', apiBase: 'http://127.0.0.1:9' } };

  // 构造账号+实例映射（与 addAccount 同构：实例 keyId = keyFingerprint(key)）
  // registeredAt 显式传入：期望集顺序判据（登记序）不能建立在 Date.now() 并列之上。
  const addAcc = async (p, key, pct, status, extraQ, regAt) => {
    const inst = await p.ensureInstance(key);
    const quota = Object.assign({ weekly: { status: 'ok', percent: pct }, monthly: { status: 'ok', percent: pct }, monthlyRemaining: 10 }, extraQ || {});
    const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: status || 'ready', quota, registeredAt: regAt || Date.now() };
    p.accounts.push(acc);
    return acc;
  };

  // R1 期望集 = 在用1+预热1（registeredAt 登记序）+ 等待区零进程零端口 + 幂等
  {
    const p = new ProxyProvider({ id: 'p1', name: 'P1', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const A = await addAcc(p, 'sk-a1', 10, 'ready', null, 1000);
    const B = await addAcc(p, 'sk-a2', 20, 'ready', null, 2000);
    const C = await addAcc(p, 'sk-a3', 30, 'ready', null, 3000);
    const r = await p.reconcileInstances();
    check('R1a 期望集 = 登记序前 2（在用 A + 预热 B），C 在等待区',
      r.desired.length === 2 && r.desired[0] === A.keyId && r.desired[1] === B.keyId, JSON.stringify(r.desired));
    const running = (p.instances || []).filter((i) => i.pid);
    check('R1b 存活进程数 = |期望集| = 2（在用+预热各 1）', running.length === 2, 'running=' + running.length);
    const cInst = p.instanceOf(C);
    check('R1c 等待区账号零进程且端口归零（LC 核心-3）', !cInst.pid && !cInst.port && !ports.byOwner('proxy:' + C.keyId), 'pid=' + cInst.pid + ' port=' + cInst.port);
    check('R1d 期望集账号保留绑定端口（防漂移，冷账号可再拉起）',
      !!p.instanceOf(A).port && !!p.instanceOf(B).port, '');
    // 第二次对账幂等
    const r2 = await p.reconcileInstances();
    check('R1e 对账幂等（不重复 spawn）', r2.started.length === 0, JSON.stringify(r2.started));
    // 清理
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  // R2 在用归属 + 预热 sticky：selected 提为在用后预热留任；退位者回收、下一拍端口释放
  {
    const p = new ProxyProvider({ id: 'p2', name: 'P2', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const A = await addAcc(p, 'sk-b1', 10, 'ready', null, 1000);
    const B = await addAcc(p, 'sk-b2', 20, 'ready', null, 2000);
    const C = await addAcc(p, 'sk-b3', 30, 'ready', null, 3000);
    await p.reconcileInstances(); // 在用 A + 预热 B（sticky 记录进 _prewarmKeyId）
    check('R2a 预热槽 sticky 记录 = B', p._prewarmKeyId === B.keyId, String(p._prewarmKeyId));
    p.selectedAccountKeyId = C.keyId; // 用户显式切换：C 提为在用
    const r = await p.reconcileInstances();
    check('R2b selected 提为在用，预热 sticky 留任（期望集 = C,B 而非 C,A）',
      r.desired.length === 2 && r.desired.includes(C.keyId) && r.desired.includes(B.keyId) && !r.desired.includes(A.keyId), JSON.stringify(r.desired));
    const aInst = p.instanceOf(A);
    check('R2c 退位者进程被回收（停止仲裁，无在途即终止）', !aInst.pid, 'pid=' + aInst.pid);
    await p.reconcileInstances(); // 第二拍：零进程非期望记录端口归零
    check('R2d 退位者端口下一拍释放（等待区零存在）', !aInst.port && !ports.byOwner('proxy:' + A.keyId), 'port=' + aInst.port);
    const running = (p.instances || []).filter((i) => i.pid);
    check('R2e 存活进程 ≤ 2（在用1+预热1 资源最低）', running.length === 2, 'running=' + running.length);
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  // R3 满额账号（ready+rate-limited）绝不被拉起/保活：对账后其实例回收、端口归零
  {
    const p = new ProxyProvider({ id: 'p3', name: 'P3', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const ok = await addAcc(p, 'sk-ok', 10, 'ready', null, 1000);
    const bad = await addAcc(p, 'sk-bad', 100, 'ready', { weekly: { status: 'rate-limited', percent: 100 } }, 2000); // ready 但满额
    // 先把 bad 的实例手动拉起（模拟旧 bug 残留：满额账号已被预热）-> 对账应收敛停掉
    const badInst = p.instanceOf(bad);
    const sr = await p.startInstance(badInst);
    check('R3a 前置：bad 实例可被拉起（测试前提）', sr.ok === true, JSON.stringify(sr));
    await new Promise((res) => setTimeout(res, 800));
    const r = await p.reconcileInstances();
    check('R3b 对账后 bad（不可用）实例被回收', !badInst.pid, 'pid=' + badInst.pid);
    check('R3c ok（在用）实例在跑且期望集不含不可用账号',
      !!p.instanceOf(ok).pid && !r.desired.includes(bad.keyId), JSON.stringify(r.desired));
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  // R4 状态事件表：冻结即时回收（进程+端口零宽限）+ 恢复回池，满额账号不被拉起
  {
    const p = new ProxyProvider({ id: 'p4', name: 'P4', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const resident = await addAcc(p, 'sk-r4', 85, 'ready', null, 1000);
    const spare = await addAcc(p, 'sk-s4', 10, 'ready', null, 2000);
    const full = await addAcc(p, 'sk-f4', 100, 'ready', { weekly: { status: 'rate-limited', percent: 100 } }, 3000);
    p.selectedAccountKeyId = resident.keyId;
    await p.reconcileInstances(); // 在用 resident + 预热 spare
    const rInst = p.instanceOf(resident);
    // 冻结常驻（模拟上游 400/429 响应驱动 markQuotaExhausted）——事件表要求**同步**回收，不等对账
    p.markQuotaExhausted(resident, 3600000);
    check('R4a 冻结即同步回收：进程与端口零宽限归零（_onStatusTransition→reclaimAccount）',
      !rInst.pid && !rInst.port && !ports.byOwner('proxy:' + resident.keyId), 'pid=' + rInst.pid + ' port=' + rInst.port);
    await new Promise((res) => setTimeout(res, 1500)); // reconcileNow（恢复/收敛回池）异步收敛
    const runningKeys = (p.instances || []).filter((i) => i.pid).map((i) => i.keyId);
    check('R4b 冻结后 spare 晋升在用在跑（reconcileNow 由 mark* 触发）', runningKeys.includes(spare.keyId), JSON.stringify(runningKeys));
    check('R4c 满额账号（full）不被拉起', !runningKeys.includes(full.keyId), JSON.stringify(runningKeys));
    check('R4d 存活进程 ≤ 期望集大小（资源最低）', runningKeys.length <= 2, runningKeys.length + '');
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  // R5 usage 纯派生
  {
    const p = new ProxyProvider({ id: 'p5', name: 'P5', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    const a = await addAcc(p, 'sk-u', 10);
    check('R5a 无 activeAccount 且实例未跑 → idle', p.usageOf(a) === 'idle', p.usageOf(a));
    p.markInUse(a.keyId);
    check('R5b markInUse → in-use', p.usageOf(a) === 'in-use', p.usageOf(a));
    p.activeAccount = null;
    check('R5c 清 activeAccount → idle（无实例）', p.usageOf(a) === 'idle', p.usageOf(a));
    // 实例在跑但非在用 -> warming
    p.activated = true;
    const sr = await p.startInstance(p.instanceOf(a));
    check('R5d 实例可启动（测试前提）', sr.ok === true, JSON.stringify(sr));
    await new Promise((res) => setTimeout(res, 600));
    check('R5e 实例在跑非在用 → warming', p.usageOf(a) === 'warming', p.usageOf(a) + ' pid=' + (p.instanceOf(a) && p.instanceOf(a).pid));
    p.markInUse(a.keyId);
    check('R5f 在用（activeAccount）→ in-use（实例运行态让位）', p.usageOf(a) === 'in-use', p.usageOf(a));
    // 序列化不写 usage/validity（纯派生，无矛盾落盘）
    const ser = p.serialize().accounts[0];
    check('R5g 序列化只含 status（无 usage/validity 持久化字段）', ser.status === 'ready' && ser.usage === undefined && ser.validity === undefined, JSON.stringify(Object.keys(ser)));
    if (p.instanceOf(a) && p.instanceOf(a).pid) p.stopInstance(p.instanceOf(a));
    await new Promise((res) => setTimeout(res, 400));
  }

  // R6 一致性守卫：ready+满额 serialize 归位 frozen（不再产出预热燃料）
  {
    const { ProviderBase } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
    const p = new ProviderBase({ id: 'p6', name: 'P6', kind: 'direct', logger: log, onPersist: () => {} });
    p._isCreditsLow = () => false;
    const full = { key: 'sk-f6', keyId: 'kF6', maskedKey: 'sk-f6', status: 'ready', quota: { weekly: { status: 'rate-limited', percent: 100 }, monthly: { status: 'ok', percent: 10 } } };
    p.accounts.push(full);
    const ser = p.serialize().accounts[0];
    check('R6a serialize 将 ready+满额 → frozen', ser.status === 'frozen', ser.status);
    check('R6b 归位带 window limit + 恢复点', ser.limit && ser.limit.kind === 'window' && ser.limit.recovery && (ser.limit.recovery.type === 'at' || ser.limit.recovery.type === 'poll'), JSON.stringify(ser.limit));
    const ok = { key: 'sk-o6', keyId: 'kO6', maskedKey: 'sk-o6', status: 'ready', quota: { weekly: { status: 'ok', percent: 10 }, monthly: { status: 'ok', percent: 10 } } };
    p.accounts.push(ok);
    const ser2 = p.serialize().accounts.find((a) => a.keyId === 'kO6');
    check('R6c 正常 ready 账号不受影响', ser2.status === 'ready', ser2.status);
  }

  // R7 孤儿收敛：discard 时请求在途 -> 孤儿实例 reconcile 后回收（不再永久泄漏）
  {
    const p = new ProxyProvider({ id: 'p7', name: 'P7', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const key = 'sk-orph'; const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...orph', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    await p.startInstance(inst);
    acc.inflight = 1;
    p.discardAccount(acc.keyId); // 在途 discard -> stopInstance 延迟 + accounts 移除 -> orphan
    check('R7a discard 在途后孤儿存在（测试前提）', p.accounts.length === 0 && p.instances.length === 1, 'accounts=' + p.accounts.length + ' insts=' + p.instances.length);
    acc.inflight = 0;
    await p.reconcileInstances();
    await new Promise((res) => setTimeout(res, 400));
    check('R7b reconcile 回收孤儿实例（进程不泄漏）', !inst.pid, 'pid=' + inst.pid);
    try { if (inst.pid) { p.stopInstance(inst); } } catch { try { process.kill(inst.pid, 'SIGKILL'); } catch {} }
    await new Promise((res) => setTimeout(res, 400));
  }

  // R8 在途请求结束补刀：stopInstance 在途延迟 -> 请求结束即停（不再一次性 timer 泄漏）
  {
    const p = new ProxyProvider({ id: 'p8', name: 'P8', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const key = 'sk-infl'; const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...infl', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    await p.startInstance(inst);
    acc.inflight = 1;
    p.stopInstance(inst); // 在途 -> 待停标记（不杀）
    check('R8a 在途时 stop 仅标记（进程保留）', inst.pid && acc._stopPendingUntilIdle === true, 'pid=' + inst.pid + ' pending=' + acc._stopPendingUntilIdle);
    acc.inflight = 0;
    p._retryPendingStop(acc); // 模拟 forward-core 在途归零调用
    await new Promise((res) => setTimeout(res, 300));
    check('R8b 在途归零补刀立即停（不泄漏）', !inst.pid, 'pid=' + inst.pid);
    try { if (inst.pid) p.stopInstance(inst); } catch { try { process.kill(inst.pid, 'SIGKILL'); } catch {} }
    await new Promise((res) => setTimeout(res, 300));
  }

  // R9 交替切换不启停追逐（selected 锚定期望集 + sticky 预热）：资源稳定
  {
    const p = new ProxyProvider({ id: 'p9', name: 'P9', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const addA = async (key, pct, at) => { const inst = await p.ensureInstance(key); const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: { weekly: { status: 'ok', percent: pct }, monthly: { status: 'ok', percent: pct }, monthlyRemaining: 10 }, registeredAt: at }; p.accounts.push(acc); return acc; };
    const a1 = await addA('sk-alt1', 10, 1000);
    const a2 = await addA('sk-alt2', 12, 2000);
    let starts = 0, stops = 0;
    const osi = p.startInstance.bind(p); const ost = p.stopInstance.bind(p);
    p.startInstance = function (i) { starts++; return osi(i); };
    p.stopInstance = function (i) { stops++; return ost(i); };
    for (let rr = 0; rr < 10; rr++) {
      const a = (rr % 2 === 0) ? a1 : a2;
      // 真实请求路径：forward 选定账号后经引擎门面 ensureServable 保证可服务（W1 门面）
      await p.ensureServable(a);
      p.markInUse(a.keyId);
      if (rr % 2 === 1) { await p.reconcileInstances(); }
    }
    check('R9a 10 次交替请求启停有界（≤3 次 spawn）', starts <= 3, 'starts=' + starts + ' stops=' + stops);
    for (const i of p.instances) if (i.pid) p.stopInstance(i);
    await new Promise((res) => setTimeout(res, 400));
  }

  // R10 reconcile 单飞：并发调用不交错、不重复 spawn
  {
    const p = new ProxyProvider({ id: 'p10', name: 'P10', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const key = 'sk-single'; const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...single', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    let startedTotal = 0;
    const osi = p.startInstance.bind(p);
    p.startInstance = function (i) { startedTotal++; return osi(i); };
    const rA = p.reconcileInstances();
    const rB = p.reconcileInstances();
    const rC = p.reconcileInstances();
    await Promise.all([rA, rB, rC]);
    check('R10a 并发 reconcile 不重复 spawn（单飞）', startedTotal === 1, 'spawn=' + startedTotal);
    check('R10b 单飞后实例在跑', inst.pid ? true : false, '');
    for (const i of p.instances) if (i.pid) p.stopInstance(i);
    await new Promise((res) => setTimeout(res, 400));
  }

  // R11 重启幸存者一律弃用重拉：幸存进程 stdio 归属已死 daemon，
  // 首个请求写日志即 EPIPE 楔死（实测 677630：CPU 110% 旋转、completion 全挂而 /health 秒回——健康探针
  // 检测不到该类病态，故【健康与否不再作为复用判据】）。断言：绑定端口幸存者被 SIGKILL、同端口全新实例、
  // 无幽灵进程、端口绑定不漂移。R11a 健康幸存者；R11b 不健康（/health 500）幸存者。
  {
    const app2 = Object.assign({}, app, { pkg: 'verproxy' }); // 带 cmdline 可匹配标记（幸存判定前提）
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const waitListener = async (port, expectPid, timeoutMs) => {
      const dl = Date.now() + (timeoutMs || 5000);
      while (Date.now() < dl) {
        const lp = pidlook.findListeningPid(port);
        if (expectPid === undefined ? lp : lp === expectPid) return lp;
        await new Promise((res) => setTimeout(res, 120));
      }
      return pidlook.findListeningPid(port);
    };
    const mkP = (id) => { const pr = new ProxyProvider({ id, name: 'P' + id, kind: 'proxy', proxyAppId: 'vm', app: app2, logger: log, events: null, dist: null, onPersist: () => {} }); pr.activated = true; return pr; };
    const mkAcc = async (pr, key, pct) => { const inst = await pr.ensureInstance(key); const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: { weekly: { status: 'ok', percent: pct }, monthly: { status: 'ok', percent: pct }, monthlyRemaining: 10 }, registeredAt: Date.now() }; pr.accounts.push(acc); return inst; };
    const assertReclaimed = async (label, pr, inst, port, survivorPid) => {
      const r = await pr.startInstance(inst);
      const newPid = inst.pid;
      check('R11-' + label + '-1 弃用重拉（新 pid，非幸存者）', r.ok === true && !!newPid && newPid !== survivorPid, 'new=' + newPid + ' survivor=' + survivorPid + ' r=' + JSON.stringify(r).slice(0, 140));
      const got = await waitListener(port, newPid);
      check('R11-' + label + '-2 绑定端口监听者=新实例（同端口不漂移）', got === newPid, 'got=' + got);
      check('R11-' + label + '-3 端口绑定 byOwner 未漂移', ports.byOwner('proxy:' + inst.keyId) === port, String(ports.byOwner('proxy:' + inst.keyId)));
      check('R11-' + label + '-4 幸存者已清（无幽灵进程）', !pidlook.isAlive(survivorPid), 'survivor alive=' + pidlook.isAlive(survivorPid));
      check('R11-' + label + '-5 新实例健康', await fetch('http://127.0.0.1:' + port + '/health').then((x) => x.ok).catch(() => false), '');
      if (inst.pid) pr.stopInstance(inst);
      await new Promise((res) => setTimeout(res, 500));
    };
    // R11a 健康幸存者（两代）
    {
      const p1 = mkP('p11a-1');
      const inst1 = await mkAcc(p1, 'sk-surv-h', 10);
      const sr = await p1.startInstance(inst1);
      check('R11a-0 前置：第一代实例已拉起（幸存者）', sr.ok === true && !!inst1.pid, JSON.stringify(sr));
      const survivorPid = inst1.pid;
      const boundPort = inst1.port;
      await waitListener(boundPort, survivorPid);
      const p2 = mkP('p11a-2');
      const inst2 = await mkAcc(p2, 'sk-surv-h', 10);
      inst2.port = boundPort; // 模拟重启：绑定端口恢复 + pid 空
      await assertReclaimed('a', p2, inst2, boundPort, survivorPid);
    }
    // R11b 不健康幸存者：预登记绑定端口 -> 放 /health 500 进程占端口（cmdline 命中标记）-> 弃用重拉
    {
      const p = mkP('p11b');
      const key = 'sk-surv-s';
      const inst = await mkAcc(p, key, 10);
      const slot = await ports.claimSlot('proxyInstance', 'proxy:' + inst.keyId, {});
      check('R11b-0 前置：绑定端口已登记', !!slot && !slot.conflict, JSON.stringify(slot));
      const boundPort = slot.port;
      inst.port = boundPort;
      const sickApp = path.join(TMP, 'verproxy-sick.js'); // 文件名含 pkg 标记 -> cmdline 命中幸存判定
      fs.writeFileSync(sickApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18997'),10);\nhttp.createServer((req,res)=>{ res.writeHead(500); res.end('sick'); }).listen(port,'127.0.0.1',()=>console.log('sick on '+port));\nprocess.on('SIGTERM',()=>process.exit(0));\n");
      const { spawn } = require('node:child_process');
      const sickProc = spawn(process.execPath, [sickApp, '--port', String(boundPort)], { stdio: 'ignore' });
      spawnedPids.add(sickProc.pid);
      await waitListener(boundPort, sickProc.pid);
      await assertReclaimed('b', p, inst, boundPort, sickProc.pid);
    }
  }

  // R12 停服台账：忽略 SIGTERM 的子进程也能被确认杀净（waitAllStopped SIGKILL 兜底）——防停服孤儿化
  {
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const p = new ProxyProvider({ id: 'p12', name: 'P12', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const stubApp = path.join(TMP, 'verproxy-stubborn.js'); // 忽略 SIGTERM（只吃 SIGKILL），模拟停服退不干净的进程
    fs.writeFileSync(stubApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18996'),10);\nhttp.createServer((req,res)=>{ if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok'})); return; } res.writeHead(404); res.end('nf'); }).listen(port,'127.0.0.1',()=>console.log('stubborn on '+port));\nprocess.on('SIGTERM', () => {});\nprocess.on('SIGINT', () => {});\n");
    p.app = Object.assign({}, app, { pkg: 'verproxy', command: ['node', stubApp, '--port', '{{port}}', '--api-key', '{{key}}'] });
    const key = 'sk-stub';
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...stub', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    const sr = await p.startInstance(inst);
    check('R12a 前置：stubborn 实例已拉起', sr.ok === true && !!inst.pid, JSON.stringify(sr));
    const pid = inst.pid;
    await new Promise((res) => setTimeout(res, 600));
    check('R12b 前置：进程存活、台账为空', pidlook.isAlive(pid) && p._terminatingPids.size === 0, 'alive=' + pidlook.isAlive(pid));
    p.stopInstance(inst); // SIGTERM -> 被 stub 忽略
    // Windows 无 POSIX 信号语义：process.kill(pid,'SIGTERM') 实际等同强杀（TerminateProcess），
    // stub 的 process.on('SIGTERM') handler 不生效 -> 进程被直接终止。产品 waitAllStopped 杀净的
    // 行为在 Windows 上同样正确，仅"SIGTERM 被忽略"前提不存在——断言按平台区分。
    const winNoSig = process.platform === 'win32';
    check('R12c stopInstance 后进程处理（POSIX：仍在=TERM 被忽略；Windows：已终止=无 SIGTERM 语义）',
      winNoSig ? !pidlook.isAlive(pid) : pidlook.isAlive(pid), 'alive=' + pidlook.isAlive(pid));
    check('R12d pid 已入停服台账', p._terminatingPids.has(pid), '');
    // /proc 仅 Linux 有；Windows/macOS 无 zombie 概念（无回收滞后）-> 进程死即算死，statOf 恒 'GONE'
    const statOf = (pid) => { if (process.platform !== 'linux') return 'GONE'; try { const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8'); const i = st.lastIndexOf(') '); return i >= 0 ? st[i + 2] : '?'; } catch { return 'GONE'; } };
    const okW = await p.waitAllStopped(3000); // unref SIGKILL(1.5s) 或本方法超时兜底
    // zombie 亦视为已死（SIGKILL 已投递、端口/stdio 已释放，仅待父进程回收）
    check('R12e waitAllStopped 后进程已死或已投递 SIGKILL（不留活孤儿）', okW === true && (!pidlook.isAlive(pid) || statOf(pid) === 'Z'), 'alive=' + pidlook.isAlive(pid) + ' stat=' + statOf(pid));
    check('R12f 台账清空', !p._terminatingPids.size, 'size=' + p._terminatingPids.size);
    check('R12g 端口已释放（无孤儿占端口）', !pidlook.findListeningPid(inst.port), 'listener=' + pidlook.findListeningPid(inst.port));
    // force 语义（停服专用）：ready+usable 且被选中/在用的账号，stopInstance 仅 defer（不杀）；force=true 强制杀——
    // 否则停服时在用实例逃脱关停 -> 孤儿（426880/677630/795363 三次实锤）
    const key2 = 'sk-stub2';
    const inst2 = await p.ensureInstance(key2);
    const acc2 = { key: key2, keyId: inst2.keyId, maskedKey: '...stub2', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc2);
    p.selectedAccountKeyId = inst2.keyId; // 在用/选中 -> _canStopInstance false
    const sr2 = await p.startInstance(inst2);
    check('R12h 前置：第二实例已拉起', sr2.ok === true && !!inst2.pid, JSON.stringify(sr2));
    const pid2 = inst2.pid;
    await new Promise((res) => setTimeout(res, 600));
    p.stopInstance(inst2); // 无 force -> 在用 defer（进程保留）
    check('R12i 在用实例普通 stop 仅 defer（进程保留）', pidlook.isAlive(pid2) && acc2._stopPendingUntilIdle === true, 'alive=' + pidlook.isAlive(pid2) + ' pending=' + acc2._stopPendingUntilIdle);
    acc2._stopPendingUntilIdle = false;
    p.stopInstance(inst2, true); // force（停服路径）-> 立即 TERM+SIGKILL 台账
    const dlj = Date.now() + 6000;
    while (Date.now() < dlj && pidlook.isAlive(pid2) && statOf(pid2) !== 'Z') { await new Promise((res) => setTimeout(res, 150)); }
    await p.waitAllStopped(5000); // 清台账（含 zombie：SIGKILL 已投递、端口/stdio 已释放）
    check('R12j force 停服：在用实例被强制终止（不留活孤儿）', !pidlook.isAlive(pid2) || statOf(pid2) === 'Z', 'alive=' + pidlook.isAlive(pid2) + ' stat=' + statOf(pid2));
    await new Promise((res) => setTimeout(res, 300));
  }

  // R13 上游超时实例级自愈：restartInstance('upstream-timeout') kill 旧进程 -> 同端口全新拉起
  {
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const p = new ProxyProvider({ id: 'p13', name: 'P13', kind: 'proxy', proxyAppId: 'vm', app: Object.assign({}, app, { pkg: 'verproxy' }), logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const key = 'sk-rt13';
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...rt13', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    const sr = await p.startInstance(inst);
    check('R13a 前置：实例已拉起', sr.ok === true && !!inst.pid, JSON.stringify(sr));
    const pid1 = inst.pid;
    const port = inst.port;
    await new Promise((res) => setTimeout(res, 500));
    p.restartInstance(inst, 'upstream-timeout'); // forward-core 超时处置同款调用
    const dl = Date.now() + 6000;
    let pid2 = null;
    while (Date.now() < dl) {
      if (inst.pid && inst.pid !== pid1 && pidlook.isAlive(inst.pid) && pidlook.findListeningPid(port) === inst.pid) { pid2 = inst.pid; break; }
      await new Promise((res) => setTimeout(res, 150));
    }
    check('R13b 超时重启：新 pid 且旧进程已死', !!pid2 && !pidlook.isAlive(pid1), 'pid1=' + pid1 + ' pid2=' + pid2 + ' alive1=' + pidlook.isAlive(pid1));
    check('R13c 同端口监听（不漂移）', pidlook.findListeningPid(port) === pid2, 'listener=' + pidlook.findListeningPid(port));
    await new Promise((res) => setTimeout(res, 400));
    check('R13d 重启后实例健康', await fetch('http://127.0.0.1:' + port + '/health').then((x) => x.ok).catch(() => false), '');
    if (inst.pid) p.stopInstance(inst);
    await new Promise((res) => setTimeout(res, 500));
  }

  // R14 锁收敛：锁只对可用账号有意义——账号因任何原因冻结即锁失效；
  // serialize 前置收敛死锁不落盘；加载（_reconcileLock）不复活对不可用账号的死锁。
  {
    const p = new ProxyProvider({ id: 'p14', name: 'P14', kind: 'proxy', proxyAppId: 'vm', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    const key = 'sk-lk';
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...lk', status: 'ready', quota: { weekly: { status: 'ok', percent: 10 }, monthly: { status: 'ok', percent: 10 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    p.selectedAccountKeyId = acc.keyId; // 显式锁定可用账号
    check('R14a 可用账号可锁定', p.selectedAccountKeyId === acc.keyId, String(p.selectedAccountKeyId));
    // 1) 冻结（真实状态机路径）-> 锁随可用性清除
    p.markQuotaExhausted(acc, 3600000);
    check('R14b 冻结即清锁（与限额账号同一状态机，无死锁残留）', p.selectedAccountKeyId === null, String(p.selectedAccountKeyId));
    // 2) serialize 前置收敛：锁定账号不可用（frozen）-> 不落盘
    acc.status = 'ready';
    p.selectedAccountKeyId = acc.keyId;
    acc.status = 'frozen'; // 绕过状态机构造「锁+冻结」矛盾态
    const ser = p.serialize();
    check('R14c serialize 收敛：冻结账号锁不落盘', ser.selectedAccountKeyId === null && p.selectedAccountKeyId === null, 'ser=' + String(ser.selectedAccountKeyId));
    // 3) 加载/运行时收敛：_reconcileLock 丢弃对不可用账号的死锁
    const key2 = 'sk-lk2';
    const inst2 = await p.ensureInstance(key2);
    const acc2 = { key: key2, keyId: inst2.keyId, maskedKey: '...lk2', status: 'frozen', quota: { weekly: { status: 'rate-limited', percent: 100 }, monthly: { status: 'rate-limited', percent: 100 }, monthlyRemaining: 0 }, registeredAt: Date.now() };
    p.accounts.push(acc2);
    p.selectedAccountKeyId = acc2.keyId; // 模拟旧残留死锁（如 8AEkNh 冻结账号）
    p._reconcileLock();
    check('R14d 加载/运行时收敛：不可用账号死锁被清', p.selectedAccountKeyId === null, String(p.selectedAccountKeyId));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });