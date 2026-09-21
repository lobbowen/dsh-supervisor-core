#!/usr/bin/env node
'use strict';

// 资源预算策略（governor）纯函数测试：activeCount 拓扑计数、allocation 平摊/下限/单调性、
// decide 两段制矩阵（突发/先到先得/迟滞边界/连续违规计数）、admission 准入、budgetSnapshot 总览。
// 独立脚本：node test/governor-test.js。纯映射断言（currentAllocation 只读 os 事实断形态），
// 不触碰 systemd/npm/真实进程。用户填额废止后本文件即限额链的唯一行为验证层。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { HEADROOM, MEM_FLOOR_MB, CPU_FLOOR_PERCENT, activeCount, allocation, currentAllocation, decide, admission, budgetSnapshot } =
  require(path.join(ROOT, 'src', 'domains', 'instance', 'governor'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const GiB = (g) => g * 1024 * 1024 * 1024;
const memNum = (a) => parseInt(a.memoryMax, 10);
const cpuNum = (a) => parseInt(a.cpuQuota, 10);

// -- G1 activeCount：只计 sandbox 域 RUNNING/STARTING；自不在账上则 +1 --
console.log('== G1 activeCount 拓扑计数 ==');
{
  const mk = (id, domain, phase) => ({ id, domain, state: { phase } });
  check('G1 空列表 → 1（新起实例自身占一格）', activeCount([], 'a') === 1, String(activeCount([], 'a')));
  check('G1 instances 缺省（undefined）→ 1', activeCount(undefined, 'a') === 1, '');
  const one = [mk('a', 'sandbox', 'RUNNING')];
  check('G1 自身已 RUNNING → 不重复计', activeCount(one, 'a') === 1, String(activeCount(one, 'a')));
  check('G1 他实例 RUNNING、自 STOPPED → +1',
    activeCount([mk('b', 'sandbox', 'RUNNING'), mk('a', 'sandbox', 'STOPPED')], 'a') === 2, '');
  check('G1 STARTING 同计为占用', activeCount([mk('b', 'sandbox', 'STARTING')], 'a') === 2, '');
  check('G1 非活跃相位（BACKOFF/FAILED/STOPPED）不计',
    activeCount([mk('b', 'sandbox', 'BACKOFF'), mk('c', 'sandbox', 'FAILED')], 'a') === 1, '');
  check('G1 native 域不计（限额只发给沙箱单元）',
    activeCount([mk('n', 'native', 'RUNNING'), mk('b', 'sandbox', 'RUNNING')], 'a') === 2, '');
  check('G1 state 缺失的脏记录不计且不抛', activeCount([{ id: 'x', domain: 'sandbox' }], 'a') === 1, '');
}

// -- G2 allocation：等权平摊、触底走下限、单调不增 --
console.log('== G2 allocation 平摊与下限 ==');
{
  check('G2 HEADROOM = 0.7（舱外留给系统/守卫/壳/回收缓冲）', HEADROOM === 0.7, String(HEADROOM));
  check('G2 内存下限 = 512M（低于此 DSH node 进程起不来）', MEM_FLOOR_MB === 512, String(MEM_FLOOR_MB));
  check('G2 CPU 下限 = 100%（硬顶低于单核推不满）', CPU_FLOOR_PERCENT === 100, String(CPU_FLOOR_PERCENT));
  const M = GiB(16), C = 8;
  const a1 = allocation(M, C, 1);
  check('G2 单实例：内存 = 总预算×0.7 取整（16G→11469M）', a1.memoryMax === '11469M', a1.memoryMax);
  check('G2 单实例：CPU = 核数×100×0.7（8核→560%）', a1.cpuQuota === '560%', a1.cpuQuota);
  const a2 = allocation(M, C, 2);
  check('G2 双实例内存等权平摊（5734M）', a2.memoryMax === '5734M', a2.memoryMax);
  check('G2 双实例 CPU 等权平摊（280%）', a2.cpuQuota === '280%', a2.cpuQuota);
  const a4 = allocation(M, C, 4);
  check('G2 四实例内存等权平摊（2867M）', a4.memoryMax === '2867M', a4.memoryMax);
  check('G2 四实例 CPU 等权平摊（140%）', a4.cpuQuota === '140%', a4.cpuQuota);
  const big = allocation(M, C, 64);
  check('G2 触内存下限 → 512M（宁可超卖也不发不可用配额）', big.memoryMax === '512M', big.memoryMax);
  check('G2 触 CPU 下限 → 100%（硬顶低于单核推不满，抢占语义可接受）', big.cpuQuota === '100%', big.cpuQuota);
  check('G2 n=0 兜底为 n=1', allocation(M, C, 0).memoryMax === a1.memoryMax, allocation(M, C, 0).memoryMax);
  let mono = true;
  for (let n = 1; n < 16; n++) if (memNum(allocation(M, C, n + 1)) > memNum(allocation(M, C, n))) mono = false;
  check('G2 单调性：实例数增 → 单实例内存配额不增', mono, '');
  check('G2 内存输出形态 = systemd 属性值 NNNM', /^\d+M$/.test(a1.memoryMax), a1.memoryMax);
  check('G2 CPU 输出形态 = systemd 属性值 NNN%', /^\d+%$/.test(a1.cpuQuota), a1.cpuQuota);
  check('G2 MemoryHigh = 0.9xMemoryMax（回收节流先于 OOM）', a1.memoryHigh === '10322M', String(a1.memoryHigh));
}

// -- G3 currentAllocation：唯一 IO 触点，只断机器事实形态与下限 --
console.log('== G3 currentAllocation 形态 ==');
{
  const solo = currentAllocation([], 'fresh');
  check('G3 内存形态为 systemd 属性值 NNNM', /^\d+M$/.test(solo.memoryMax), solo.memoryMax);
  check('G3 CPU 形态为 systemd 属性值 NNN%', /^\d+%$/.test(solo.cpuQuota), solo.cpuQuota);
  check('G3 真实机器上内存不低于下限', memNum(solo) >= MEM_FLOOR_MB, solo.memoryMax);
  check('G3 真实机器上 CPU 不低于下限', cpuNum(solo) >= CPU_FLOOR_PERCENT, solo.cpuQuota);
  const busy = currentAllocation([{ id: 'b', domain: 'sandbox', state: { phase: 'RUNNING' } }], 'fresh');
  check('G3 已有活跃实例 → 本实例内存份额不增', memNum(busy) <= memNum(solo), busy.memoryMax + ' vs ' + solo.memoryMax);
  check('G3 已有活跃实例 → 本实例 CPU 份额不增', cpuNum(busy) <= cpuNum(solo), busy.cpuQuota + ' vs ' + solo.cpuQuota);
}

// -- G4 decide 两段制：预留+突发（先到先得、上限封 2x 预留、池 = 物理-预算）+ 迟滞 + 违规计数 --
//     基准机形：16 GiB / 8 核 -> 预算 11468.8MB，突发池 4915.2MB，N=2 预留 5734.4MB。
console.log('== G4 decide 两段制与违规矩阵 ==');
{
  const M = GiB(16), C = 8;
  const R = (id, extra) => Object.assign({ id, usageMb: null, cpuPct: null, since: 0, prevAlloc: null, prevTicks: null }, extra || {});
  const byId = (plan, id) => plan.entries.find((e) => e.id === id);
  const d1 = decide({ totalMemBytes: M, cpuCount: C, roster: [R('a')] });
  check('G4 单实例闲置 = 全额预算（11469M）', byId(d1, 'a').alloc.memoryMax === '11469M', byId(d1, 'a').alloc.memoryMax);
  check('G4 首拍无上一值 -> changed=true（必下发）', byId(d1, 'a').changed === true, '');
  check('G4 无观测证据 -> 违规计数为 0', byId(d1, 'a').ticks.mem === 0 && byId(d1, 'a').violation === null, '');
  const d2 = decide({ totalMemBytes: M, cpuCount: C, roster: [R('a'), R('b')] });
  check('G4 双实例闲置 = 等权预留（5734M / 280%）',
    byId(d2, 'a').alloc.memoryMax === '5734M' && byId(d2, 'a').alloc.cpuQuota === '280%', byId(d2, 'a').alloc.memoryMax + ' ' + byId(d2, 'a').alloc.cpuQuota);
  const d3 = decide({ totalMemBytes: M, cpuCount: C, roster: [
    R('a', { usageMb: 6000, since: 1 }), R('b', { usageMb: 100, since: 2 })] });
  check('G4 有需求实例获突发补差（5734+266=6000M）', byId(d3, 'a').memoryMaxMb === 6000, String(byId(d3, 'a').memoryMaxMb));
  check('G4 无需求实例保持预留（5734M）', byId(d3, 'b').memoryMaxMb === 5734, String(byId(d3, 'b').memoryMaxMb));
  check('G4 突发池记账 = 266MB', d3.burstUsedMb === 266, String(d3.burstUsedMb));
  const d4 = decide({ totalMemBytes: M, cpuCount: C, roster: [
    R('a', { usageMb: 30000, since: 1 }), R('b', { usageMb: 30000, since: 2 })] });
  check('G4 先到先得：先起者吃满突发池（5734+4915=10650M）',
    byId(d4, 'a').memoryMaxMb === 10650, String(byId(d4, 'a').memoryMaxMb));
  check('G4 池耗尽后到者回落纯预留（5734M）', byId(d4, 'b').memoryMaxMb === 5734, String(byId(d4, 'b').memoryMaxMb));
  const d5 = decide({ totalMemBytes: M, cpuCount: C, roster: [
    R('a', { usageMb: 6000, since: 1 }), R('b', { usageMb: 6000, since: 2 }), R('c', { usageMb: 100, since: 3 })] });
  check('G4 突发封顶 2x 预留（N=4：2867+2867=5734M，池有富余也不超）',
    byId(d5, 'a').memoryMaxMb === 5734, String(byId(d5, 'a').memoryMaxMb));
  check('G4 池余量部分补给第二需求者（2867+2048=4915M）',
    byId(d5, 'b').memoryMaxMb === 4915, String(byId(d5, 'b').memoryMaxMb));
  check('G4 闲置实例纯预留不受挤压（2867M）', byId(d5, 'c').memoryMaxMb === 2867, String(byId(d5, 'c').memoryMaxMb));
  const h1 = decide({ totalMemBytes: M, cpuCount: C, roster: [R('a', { prevAlloc: { memoryMax: '5734M', cpuQuota: '280%' } })] });
  check('G4 迟滞步长：N 2->1 目标翻倍，单拍最多挪 25%（5734->7168M）',
    byId(h1, 'a').memoryMaxMb === 7168, String(byId(h1, 'a').memoryMaxMb));
  const h2 = decide({ totalMemBytes: M, cpuCount: C, roster: [R('a', { prevAlloc: { memoryMax: '5300M', cpuQuota: '280%' } }), R('b')] });
  check('G4 迟滞死区：偏离 8.2%<10% 不下发（保持上一生效值 5300M，changed=false）',
    byId(h2, 'a').memoryMaxMb === 5300 && byId(h2, 'a').changed === false, String(byId(h2, 'a').memoryMaxMb));
  const P = (extra) => R('a', Object.assign({ prevAlloc: { memoryMax: '11469M', cpuQuota: '560%' } }, extra));
  const v1 = decide({ totalMemBytes: M, cpuCount: C, roster: [P({ usageMb: 30000, prevTicks: { mem: 2, cpu: 0 } })] });
  check('G4 内存连续第 3 拍超限 -> 触发违规（burst 目标 16384，迟滞限步后限额 14336）',
    byId(v1, 'a').violation && byId(v1, 'a').violation.kind === 'memory' && byId(v1, 'a').violation.target === 14336,
    JSON.stringify(byId(v1, 'a').violation));
  check('G4 违规触发即清零计数（防连杀）', byId(v1, 'a').ticks.mem === 0, String(byId(v1, 'a').ticks.mem));
  const v2 = decide({ totalMemBytes: M, cpuCount: C, roster: [P({ usageMb: 30000, prevTicks: { mem: 1, cpu: 0 } })] });
  check('G4 未连续满 3 拍只计数不处置', byId(v2, 'a').violation === null && byId(v2, 'a').ticks.mem === 2, JSON.stringify(byId(v2, 'a').ticks));
  const v3 = decide({ totalMemBytes: M, cpuCount: C, roster: [P({ usageMb: 1000, cpuPct: 600, prevTicks: { mem: 2, cpu: 4 } })] });
  check('G4 占用回落 -> 内存计数清零（无证据/达标不累计）', byId(v3, 'a').ticks.mem === 0, JSON.stringify(byId(v3, 'a').ticks));
  check('G4 CPU 连续第 5 拍超限 -> cpu 违规（份额 560%，实际 600）',
    byId(v3, 'a').violation && byId(v3, 'a').violation.kind === 'cpu' && byId(v3, 'a').violation.target === 560,
    JSON.stringify(byId(v3, 'a').violation));
  const v4 = decide({ totalMemBytes: M, cpuCount: C, roster: [P({ usageMb: 30000, cpuPct: 600, prevTicks: { mem: 2, cpu: 4 } })] });
  check('G4 双违规同拍 -> 内存优先（OOM 风险大于慢化）',
    byId(v4, 'a').violation.kind === 'memory' && byId(v4, 'a').ticks.cpu === 5,
    JSON.stringify(byId(v4, 'a').violation) + ' ticks=' + JSON.stringify(byId(v4, 'a').ticks));
  check('G4 空花名册 -> 零条目不抛', decide({ totalMemBytes: M, cpuCount: C, roster: [] }).entries.length === 0, '');
}

// -- G5 admission 准入：等分后跌破单实例下限即显式拒绝（绝不静默超卖） --
console.log('== G5 admission 准入矩阵 ==');
{
  const M = GiB(16); // 预算 11468.8MB，容量 = floor(11468.8/512) = 22
  check('G5 空机器起第一个 -> 放行', admission([], 'x', M).ok === true, '');
  const mkRun = (id, memMax) => ({ id, domain: 'sandbox', state: { phase: 'RUNNING', allocation: { memoryMax: memMax } } });
  check('G5 预算容量内（21 活跃起第 22 个，摊薄 521M>=512M）-> 放行',
    admission(Array.from({ length: 21 }, (_, k) => mkRun('r' + k, '512M')), 'x', M).ok === true, '');
  const full = Array.from({ length: 22 }, (_, k) => mkRun('r' + k, '512M'));
  const rej = admission(full, 'x', M);
  check('G5 第 23 个（摊薄 498M<512M）-> 显式拒绝', rej.ok === false, JSON.stringify(rej));
  check('G5 拒绝文案 = 预算已满 + 已预留 X/Y + 指引',
    /预算已满：22 实例已预留 11264\/11469MB/.test(rej.error || '') && /停一个或等待释放/.test(rej.error || ''), rej.error);
  check('G5 自身已 RUNNING 不重复计数', admission([mkRun('x', '512M')], 'x', M).ok === true, '');
  check('G5 native 实例不占沙箱预算', admission([mkRun('r0', '512M'), { id: 'n', domain: 'native', state: { phase: 'RUNNING' } }], 'x', M).ok === true, '');
}

// -- G6 budgetSnapshot 预算总览（/env/status 观测面） --
console.log('== G6 budgetSnapshot 总览 ==');
{
  const facts = { totalMemBytes: GiB(16), cpuCount: 8 };
  const insts = [
    { id: 'a', domain: 'sandbox', state: { phase: 'RUNNING', allocation: { memoryMax: '5734M', cpuQuota: '280%' } } },
    { id: 'b', domain: 'sandbox', state: { phase: 'STARTING', allocation: { memoryMax: '5734M', cpuQuota: '280%' } } },
    { id: 'c', domain: 'sandbox', state: { phase: 'STOPPED', allocation: { memoryMax: '5734M', cpuQuota: '280%' } } },
  ];
  const { budgetSnapshot } = require(path.join(ROOT, 'src', 'domains', 'instance', 'governor'));
  const s = budgetSnapshot(insts, facts);
  check('G6 总预算 = 物理x0.7 取整（16384->11469）', s.budgetMb === 11469, String(s.budgetMb));
  check('G6 只计活跃实例占用（STOPPED 的 5734M 不算）', s.activeCount === 2 && s.usedMb === 11468, s.activeCount + ' / ' + s.usedMb);
  check('G6 下一份保底摊薄 = 预算/活跃数（5735M）', s.reservationMb === 5735, String(s.reservationMb));
  check('G6 容量 = floor(预算/下限)（22 个）', s.capacity === 22, String(s.capacity));
  check('G6 CPU 预算与占用（560 / 560）', s.cpuBudgetPct === 560 && s.cpuUsedPct === 560, s.cpuBudgetPct + ' / ' + s.cpuUsedPct);
  check('G6 空花名册不抛且容量可用', budgetSnapshot([], facts).usedMb === 0 && budgetSnapshot(undefined, facts).activeCount === 0, '');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
