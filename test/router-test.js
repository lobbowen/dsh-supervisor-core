#!/usr/bin/env node
'use strict';

// 智能路由底座（RouterService）离线测试：
// 供应商 CRUD / 账号状态机 / 切换引擎选可用 / 持久化 round-trip / 一账号一实例 / 冻结释放。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

(async () => {
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const providerFile = path.join(TMP, 'providers.json');
  const svc = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });

  // 1. 直连供应商 + 账号状态（k1 可用，k2 额度满不可用）
  const r1 = svc.addDirectProvider({ name: 'Test Direct', baseUrl: 'https://api.test.com' });
  check('添加直连供应商', r1.ok === true, JSON.stringify(r1));
  const dp = svc.getProvider(r1.id);
  dp.accounts.push({ key: 'sk-test-1', keyId: 'k1', maskedKey: '...est-1', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 20, status: 'ok' }, monthly: { percent: 30, status: 'ok' } }, cooldownUntil: null, registeredAt: Date.now() });
  dp.accounts.push({ key: 'sk-test-2', keyId: 'k2', maskedKey: '...est-2', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 100, status: 'rate-limited' }, monthly: { percent: 100, status: 'rate-limited' } }, cooldownUntil: null, registeredAt: Date.now() });
  svc._save();

  // 2. 账号选择引擎：只选可用账号（供应商独立端点在其自身账号池内选号）
  const picked = svc.switcher.pickFor(dp);
  check('切换引擎只选可用账号', picked && picked.keyId === 'k1', JSON.stringify(picked && picked.keyId));

  // 3. 持久化 round-trip：账号状态保留、进程态不落盘
  const svc2 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const dp2 = svc2.getProvider(r1.id);
  check('持久化后供应商存在', !!dp2);
  check('账号状态保留', dp2.accounts.length === 2 && dp2.accounts[0].status === 'ready');

  // 3b. 额度恢复时间归一化（2026-09 审计修复）：ISO resetsAt 不得被 Number()=NaN → 30d 兜底吞掉
  const { normalizeResetTs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  const nISO = normalizeResetTs('2026-09-21T05:54:32.950Z');
  check('normalizeResetTs ISO → epoch 毫秒', nISO === 1789970072950, String(nISO));
  check('normalizeResetTs epoch 秒 → ×1000', normalizeResetTs('1789970072') === 1789970072000, String(normalizeResetTs('1789970072')));
  check('normalizeResetTs 非法 → null', normalizeResetTs('garbage') === null && normalizeResetTs(null) === null, '');
  // _nextResetAt 用归一值：ISO resetsAt 给出精确恢复点（不再 +30d 兜底）
  const fullAcc = { quota: { monthly: { status: 'rate-limited', percent: 100, resetsAt: '2026-09-21T05:54:32.950Z' } } };
  const nr = dp2._nextResetAt(fullAcc.quota);
  check('_nextResetAt 精确解析 ISO → 不落 30d 兜底', nr.precise === true && nr.t === 1789970072950, JSON.stringify(nr));

  // 3c. 锁定/在用派生统一（2026-09 审计修复）：activeAccount 在用而无手动锁定时列表 selected 仍亮
  dp2.activeAccount = dp2.accounts[0]; // 模拟自动在用（未手动锁）
  dp2.selectedAccountKeyId = null;
  const view2 = svc2.listProviders().find((p) => p.id === r1.id);
  const rowSel = view2.accounts.find((a) => a.keyId === 'k1');
  check('未锁定时 activeAccount 在用 → 行 selected=true（列表亮当前账号）', rowSel && rowSel.selected === true, JSON.stringify(rowSel && rowSel.selected));
  check('未锁定时 view.locked=false + activeKeyId=k1', view2.locked === false && view2.activeKeyId === 'k1', JSON.stringify({ locked: view2.locked, activeKeyId: view2.activeKeyId }));
  // 显式锁定（2026-09 A 语义）：只可锁定可用账号——k1 可用 → 持久化 + locked=true
  dp2.selectedAccountKeyId = 'k1';
  svc2._save();
  const svc3 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const dp3 = svc3.getProvider(r1.id);
  check('显式锁定持久化 round-trip（可用账号）', dp3.selectedAccountKeyId === 'k1', String(dp3.selectedAccountKeyId));
  // 一致性守卫：满额「ready」账号(k2)落盘后为 frozen（不再产生可预热矛盾态）
  const k2After = dp3.accounts.find((a) => a.keyId === 'k2');
  check('一致性守卫：满额 ready 账号落盘归位 frozen', k2After && k2After.status === 'frozen', JSON.stringify(k2After && k2After.status));
  const view3 = svc3.listProviders().find((p) => p.id === r1.id);
  const k1row = view3.accounts.find((a) => a.keyId === 'k1');
  const k2row = view3.accounts.find((a) => a.keyId === 'k2');
  // 锁收敛（2026-09 A）：锁只对可用账号有意义——锁定可用账号(k1) locked+selected；满额冻结账号(k2) 无锁不亮
  check('锁收敛：锁定可用账号(k1) locked=true 且高亮', k1row && k1row.locked === true && k1row.selected === true, JSON.stringify({ locked: k1row && k1row.locked, selected: k1row && k1row.selected }));
  check('锁收敛：满额冻结账号(k2) 无锁不亮', k2row && k2row.locked === false && k2row.selected === false && view3.activeKeyId === 'k1', JSON.stringify({ l: k2row && k2row.locked, s: k2row && k2row.selected, activeKeyId: view3.activeKeyId }));

  // 4. 一账号一实例去重
  const pp = new ProxyProvider({ id: 'p1', name: 'P', kind: 'proxy', proxyAppId: 'test-dry-run', app: { command: ['node', 'x', '--port', '{{port}}', '--api-key', '{{key}}'], healthPath: '/health' }, logger: { info(){}, warn(){}, error(){} }, events: null, dist: null, onPersist: () => {} });
  const i1 = await pp.ensureInstance('key-A');
  const i2 = await pp.ensureInstance('key-A');
  check('一账号一实例：重复 ensure 返回同一实例', i1 === i2);
  check('实例列表只有一条', pp.instances.length === 1, 'len=' + pp.instances.length);

  // 5. 实例四态词表（PROVIDER-GATEWAY-ARCHITECTURE §4.1 / PG-3）
  //   ⚠ 实例级 freeze/unfreeze 已删除：它们是未接线的死代码，且"冻结"是**账号级**语义
  //     （实例级只有 COLD/WARM/HOT/DEAD）。此处改验四态判定本身。
  check('实例态为四态词表之一', ['COLD', 'WARM', 'HOT', 'DEAD'].includes(i1.status), i1.status);
  check('无进程 → isServable=false', i1.isServable() === false, String(i1.isServable()));
  const insts = require(path.join(ROOT, 'src', 'domains', 'router', 'model'));
  check('四态常量已导出且唯一', Object.keys(insts.INSTANCE_STATES).length === 4, Object.keys(insts.INSTANCE_STATES).join(','));

  // 6. B19（AUDIT-2026-09-19）：用量账本 byModel 键上限/截断 + 节流落盘 + flush。
  {
    const { UsageLedger } = require(path.join(ROOT, 'src', 'domains', 'router', 'store', 'usage'));
    const mkEntry = (model) => ({ ts: '', model, key: 'sk-x', promptTokens: 1, completionTokens: 1, totalTokens: 2, status: 200 });
    // 6a 截断：>128 字符的 model 键被截到 128。
    const ledT = new UsageLedger({ file: path.join(TMP, 'usage-t.json'), writeDelayMs: 0 });
    ledT.recordUsage(mkEntry('m'.repeat(200)));
    const keysT = Object.keys(ledT.totals.byModel);
    check('B19 超长 model 键被截断至 128', keysT.length === 1 && keysT[0].length === 128, JSON.stringify(keysT.map((k) => k.length)));
    check('B19 空/非字符串 model 归 unknown', (() => {
      const l = new UsageLedger({ file: path.join(TMP, 'usage-u.json'), writeDelayMs: 0 });
      l.recordUsage(mkEntry('')); l.recordUsage(mkEntry(null));
      const ks = Object.keys(l.totals.byModel); return ks.length === 1 && ks[0] === 'unknown';
    })(), 'ok');
    // 6b 上限：maxModelKeys=3 → 至多 3 个真实键 + 1 个 '(other)'，溢出并入 other。
    const ledC = new UsageLedger({ file: path.join(TMP, 'usage-c.json'), writeDelayMs: 0, maxModelKeys: 3 });
    for (const m of ['a', 'b', 'c', 'd', 'e', 'f']) ledC.recordUsage(mkEntry(m));
    const byC = ledC.totals.byModel;
    check('B19 byModel 键数受上限约束（含 other 桶）', Object.keys(byC).length <= 4 && byC['(other)'] && byC['(other)'].requests === 3, JSON.stringify({ n: Object.keys(byC).length, other: byC['(other)'] && byC['(other)'].requests }));
    check('B19 溢出键不再单独建桶（a/b/c 保留，d/e/f 入 other）', byC.a && byC.b && byC.c && !byC.d && !byC.e && !byC.f, JSON.stringify(Object.keys(byC)));
    // 反向（防空转）：上限足够大时，多个 model 各自建桶（证明是上限在起作用，非写死单桶）。
    const ledR = new UsageLedger({ file: path.join(TMP, 'usage-r.json'), writeDelayMs: 0, maxModelKeys: 100 });
    for (const m of ['a', 'b', 'c', 'd', 'e', 'f']) ledR.recordUsage(mkEntry(m));
    check('B19 反向：宽上限下 6 个 model 各自建桶', Object.keys(ledR.totals.byModel).length === 6 && !ledR.totals.byModel['(other)'], JSON.stringify(Object.keys(ledR.totals.byModel)));
    // 6c 节流落盘：writeDelayMs 很大 → recordUsage 不同步落盘；flush() 才落。
    const fThrottle = path.join(TMP, 'usage-throttle.json');
    try { fs.rmSync(fThrottle, { force: true }); } catch {}
    const ledTh = new UsageLedger({ file: fThrottle, writeDelayMs: 600000 });
    ledTh.recordUsage(mkEntry('z'));
    check('B19 节流：未到点不落盘（文件尚未生成）', !fs.existsSync(fThrottle), 'exists=' + fs.existsSync(fThrottle));
    ledTh.flush();
    const thDoc = fs.existsSync(fThrottle) ? JSON.parse(fs.readFileSync(fThrottle, 'utf8')) : null;
    check('B19 flush 强制落盘（未到点的账不丢）', !!thDoc && thDoc.requests === 1, JSON.stringify(thDoc && thDoc.requests));
    ledTh._timer && clearTimeout(ledTh._timer); // 清理未触发的定时器（unref 已防阻退出）
    // 6d canPersist 单闸仍生效（PG-7 语义保留）
    const fGate = path.join(TMP, 'usage-gate.json');
    try { fs.rmSync(fGate, { force: true }); } catch {}
    const ledG = new UsageLedger({ file: fGate, writeDelayMs: 0, canPersist: () => false });
    ledG.recordUsage(mkEntry('g')); ledG.flush();
    check('B19 落盘仍过 canPersist 单闸（false 时不落盘）', !fs.existsSync(fGate), 'exists=' + fs.existsSync(fGate));
  }

  // 7. B20（AUDIT-2026-09-19）：延后停止的有界期限——到期 force 落 kill，不再无限续命。
  //    纯逻辑（instance.pid=null，不触发真实 kill）。
  {
    const life = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'instance-lifecycle'));
    const mkProv = () => ({ accounts: [], _persist() {}, isAccountUsable() { return true; }, name: 'T' });
    const mkCase = () => {
      const p = mkProv();
      const acc = { keyId: 'k1', key: 'sk', maskedKey: '...k1', status: 'ready', inflight: 1, _stopPendingUntilIdle: false };
      p.accounts.push(acc);
      const inst = { keyId: 'k1', pid: null, status: 'HOT', healthy: true };
      return { p, acc, inst };
    };
    // 期限内：在途 -> 仅标记待停 + 记 _stopPendingSince。
    const a = mkCase();
    life.stopInstance(a.p, a.inst);
    check('B20 期限内：在途 stop 仅延后（置 pending + 记起始时刻）',
      a.acc._stopPendingUntilIdle === true && typeof a.acc._stopPendingSince === 'number' && a.acc._stopPendingSince > 0,
      JSON.stringify({ pend: a.acc._stopPendingUntilIdle, since: a.acc._stopPendingSince }));
    // 反向（防空转）：再次 stop（仍在期限内）仍延后——证明是「到期」才放行，非首拍即放行。
    life.stopInstance(a.p, a.inst);
    check('B20 反向：未到期重复 stop 仍延后', a.acc._stopPendingUntilIdle === true, String(a.acc._stopPendingUntilIdle));
    // 越界：把起始时刻拨到期限之后 -> stop 不再延后，落 kill 分支（pid=null → 置 COLD）并清标记。
    const b = mkCase();
    life.stopInstance(b.p, b.inst); // 先置 since
    b.acc._stopPendingSince = Date.now() - (6 * 60 * 1000); // 超过 5min 期限
    b.acc.inflight = 1; // 仍在途（有界期限应无视在途强停）
    life.stopInstance(b.p, b.inst);
    check('B20 到期：即使仍在途也停止延后，清 pending/since 并置 COLD',
      b.acc._stopPendingUntilIdle === false && b.acc._stopPendingSince === 0 && b.inst.status === 'COLD',
      JSON.stringify({ pend: b.acc._stopPendingUntilIdle, since: b.acc._stopPendingSince, st: b.inst.status }));
    // retryPendingStop：在途归零且无 pid 时归位清 since。
    const c = mkCase();
    c.acc.inflight = 0; // 请求已结束（在途归零）才会补做
    c.acc._stopPendingUntilIdle = true; c.acc._stopPendingSince = Date.now() - 1000;
    c.p.instanceOf = () => ({ keyId: 'k1', pid: null });
    life.retryPendingStop(c.p, c.acc);
    check('B20 retryPendingStop 归位清 _stopPendingSince', c.acc._stopPendingSince === 0 && c.acc._stopPendingUntilIdle === false, JSON.stringify({ s: c.acc._stopPendingSince, p: c.acc._stopPendingUntilIdle }));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
