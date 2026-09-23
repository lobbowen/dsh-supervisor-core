#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 插件市场的**整体构建预算**
//
// ## 缺陷
//
// 社区源候选约 **2468** 个，按 8 并发分批、每批各带超时 —— 最坏情况可达数十分钟；
// 而 `GET /plugins/market` 会**阻塞到构建完成**：
//   - 前端 15s 就放弃了（AbortSignal），**服务端却还在跑**；
//   - 反复点「刷新」会叠加多轮构建。
//
// ## 修法
//
// 给整次构建一个上限（默认 4 分钟，可经 `buildBudgetMs` 注入）：
//   - `buildIndex()` 造**本次构建私有**的预算 ctx（deadline + truncated 集合），`finally` 只清自己的（B2-6c）；
//   - 各源的批次循环在发起**新批次前**检查 `_budgetExhausted(bctx)`，到点即 break；
//   - 用已采集的部分构建索引 —— 与既有的「坏构建保护」天然配合
//     （部分结果 < 旧缓存 50% 时会按 source 维度沿用旧缓存，不会冲掉）。
//   旧实现把 deadline 挂在实例上：叠建（直接 buildIndex，绕过 getIndex 的 _inFlight 去重）时
//   先结束者 finally 清零，后启动者预算上限整体失效 —— M-h 即钉此点。
//
// ## 锁定不变量
//   M-a  `buildBudgetMs` 可注入（默认 4 分钟）
//   M-b  `buildIndex()` 期间预算 ctx 的 deadline **已置位**（各源可观察到），结束后**清零**
//   M-c  `_budgetExhausted(bctx)` 语义正确（无 ctx/未置位/未到点 -> false；到点 -> true）
//   M-d  两个批次循环都检查预算（源码级：loop guard 在 `slice` 之前）
//   M-e  超预算时**返回部分结果**（不抛、不清缓存）
//   M-h  叠建预算互不干扰：A 结束只清 A 的 ctx，B 构建中 deadline 恒有效
//   M-i  `getIndex(force=true)` 复用 `_inFlight`：force 不得叠加并发构建（审计#25 的申报侧）
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 步骤8a（DIRECTORY-STRUCTURE-DESIGN）：pluginmarket.js 改名归位为 market.js
const SRC = path.join(ROOT, 'src', 'domains', 'plugin', 'market.js');
const src = fs.readFileSync(SRC, 'utf8');
const { PluginMarket } = require(SRC);

// -- M-a：可注入的预算 --
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const mk = (o) => new PluginMarket(Object.assign({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } }, o || {}));
  check('M-a 默认预算 4 分钟', mk().buildBudgetMs === 240000, String(mk().buildBudgetMs));
  check('M-a 预算可注入（测试/特殊环境）', mk({ buildBudgetMs: 1234 }).buildBudgetMs === 1234, String(mk({ buildBudgetMs: 1234 }).buildBudgetMs));
  fs.rmSync(dir, { recursive: true, force: true });
}

// -- M-c：_budgetExhausted(bctx) 语义（B2-6c：预算归 ctx，不再是实例字段）--
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
  check('M-c 无 ctx（单源直调）→ 不设预算', m._budgetExhausted() === false, 'false');
  check('M-c 未置位（deadline 0）→ 不视为耗尽', m._budgetExhausted({ deadline: 0 }) === false, 'false');
  check('M-c 未到点 → false', m._budgetExhausted({ deadline: Date.now() + 10000 }) === false, 'false');
  check('M-c 已到点 → true', m._budgetExhausted({ deadline: Date.now() - 1 }) === true, 'true');
  fs.rmSync(dir, { recursive: true, force: true });
}

// -- M-b / M-e：构建期间 deadline 生效，结束后清零；且返回部分结果不抛 --
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const m = new PluginMarket({
    cacheDir: dir,
    stateFile: path.join(dir, 's.json'),
    buildBudgetMs: 50,
    logger: { info() {}, warn() {}, error() {} },
  });
  const seen = [];
  let buildCtx = null;
  // 用**慢**的三源桩：每个源在被调用时记录此刻的预算 ctx（deadline 应非 0 = 构建中）
  const slow = (name, tag) => async function (bctx) {
    if (!buildCtx) buildCtx = bctx;
    seen.push({ name, deadlinePositive: !!bctx && bctx.deadline > 0, sameCtx: bctx === buildCtx });
    await new Promise((r) => setTimeout(r, 40));
    return tag ? [{ name: tag, source: name, stars: 1 }] : [];
  };
  m.indexNpm = slow('npm', 'a-npm');
  m.indexGithub = slow('github', null);
  m.indexCommunity = slow('community', null);
  // 让 saveToDisk 不真的写盘（无妨，tmp 目录）
  let cache = null, threw = null;
  try { cache = await m.buildIndex(); } catch (e) { threw = e; }
  check('M-e 构建不抛（超预算也返回部分）', threw === null, threw ? threw.message : '无异常');
  check('M-e 返回了部分结果（npm 源已采集）',
    !!(cache && (cache.plugins || []).some((p) => p.name === 'a-npm')),
    JSON.stringify((cache && cache.plugins || []).map((p) => p.name)));
  check('M-b 构建期间预算 ctx 已置位且三源共享同一 ctx',
    seen.length === 3 && seen.every((x) => x.deadlinePositive && x.sameCtx),
    JSON.stringify(seen));
  check('M-b 构建结束后本次 ctx 清零（只清自己的）', buildCtx && buildCtx.deadline === 0, String(buildCtx && buildCtx.deadline));
  fs.rmSync(dir, { recursive: true, force: true });

  // -- M-d：两个批次循环都在发起新批次前检查预算 --
  {
    const loops = src.match(/for \(let i = 0; i < (names|links)\.length; i \+= (batch|8)\) \{[\s\S]{0,300}?slice\(i,/g) || [];
    check('M-d 定位到两个批次循环', loops.length === 2, loops.length + ' 个');
    check('M-d 每个循环都有 _budgetExhausted(bctx) 检查且在 slice 之前',
      loops.every((seg) => seg.indexOf('_budgetExhausted(bctx)') >= 0 && seg.indexOf('_budgetExhausted(bctx)') < seg.indexOf('slice(i,')),
      loops.map((s) => s.indexOf('_budgetExhausted(bctx)') + '/' + s.indexOf('slice(i,')).join(' '));
    // 反向：确认 buildIndex 用 try/finally 清零（异常路径也清），且清的是**本次构建的 ctx**
    //   —— 旧形态 `this._deadline = 0` 出现即回潮（实例字段互踩正是 B2-6c 缺陷本体）。
    check('M-d buildIndex 用 try/finally 只清本次 ctx 的 deadline',
      /finally \{ bctx\.deadline = 0; \}/.test(src) && !/this\._deadline/.test(src), '有');
  }

  // -- M-f：**预算截断的源必须与旧缓存并集**（P2-8 配套修复）--
  //
  // 缺陷：既有的「坏构建保护」判据是「本次**整源失败**」（`!freshSources.has(source)`），
  //   而被截断的源**仍在结果里**（只是不完整）-> 该保护不保留它的旧条目
  //   -> 只跑到 200/2400 的 community 会**替换掉**完整的旧 community 列表。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({
      cacheDir: dir,
      stateFile: path.join(dir, 's.json'),
      logger: { info() {}, warn() {}, error() {} },
    });
    // 预置「完整」旧缓存：100 条 community + 5 条 npm
    const oldCommunity = [];
    for (let i = 0; i < 100; i++) oldCommunity.push({ name: 'old-c-' + i, source: 'community', stars: 1 });
    const oldNpm = [];
    for (let i = 0; i < 5; i++) oldNpm.push({ name: 'old-n-' + i, source: 'npm', stars: 1 });
    m._cache = { indexedAt: Date.now(), sources: { npm: 5, github: 0, community: 100 }, total: 105, plugins: oldNpm.concat(oldCommunity) };
    m._ts = Date.now();
    // 桩：community 被预算截断（只返回 3 条并标记）
    m.indexNpm = async () => oldNpm.map((x) => ({ name: x.name, source: 'npm', stars: 1 }));
    m.indexGithub = async () => [];
    m.indexCommunity = async function (bctx) {
      bctx.truncated.add('community');
      return [
        { name: 'new-c-1', source: 'community', stars: 1 },
        { name: 'new-c-2', source: 'community', stars: 1 },
        { name: 'new-c-3', source: 'community', stars: 1 },
      ];
    };
    const cache = await m.buildIndex();
    const names = new Set((cache.plugins || []).map((p) => p.name));
    check('M-f 截断源：新条目保留', names.has('new-c-1') && names.has('new-c-3'), [...names].filter((n) => n.startsWith('new-')).join(','));
    check('M-f 截断源：旧条目被合并回来（不被替换）',
      names.has('old-c-0') && names.has('old-c-99'), '社区总数=' + (cache.plugins || []).filter((p) => p.source === 'community').length);
    check('M-f 截断源合并后总数为 3+100（社区）',
      (cache.plugins || []).filter((p) => p.source === 'community').length === 103,
      String((cache.plugins || []).filter((p) => p.source === 'community').length));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-g（反向）：**未**截断的源不得合并旧条目（否则陈旧条目永不淘汰）--
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
    m._cache = { indexedAt: Date.now(), sources: {}, total: 1, plugins: [{ name: 'stale', source: 'community', stars: 1 }] };
    m._ts = Date.now();
    m.indexNpm = async () => [];
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [{ name: 'fresh-only', source: 'community', stars: 1 }];
    const cache = await m.buildIndex();
    const names = (cache.plugins || []).map((p) => p.name);
    check('M-g 未截断的源不合并旧条目（陈旧条目正常淘汰）',
      names.length === 1 && names[0] === 'fresh-only', names.join(','));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-h（B2-6c 本体）：叠建预算互不干扰 —— 先结束者只清自己的 ctx --
  //   旧实现（deadline 挂实例）下 A 的 finally 会把 B 还在用的 deadline 清零，
  //   B 构建中观察到 deadline<=0 = 预算上限失效，本断言必红。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), buildBudgetMs: 10000, logger: { info() {}, warn() {}, error() {} } });
    const ctxs = [];
    let n = 0;
    m.indexNpm = async function (bctx) {
      if (!ctxs.includes(bctx)) ctxs.push(bctx);
      const which = ctxs.indexOf(bctx); // 0=先启动的 A（快），1=后启动的 B（慢）
      await new Promise((r) => setTimeout(r, which === 0 ? 5 : 60));
      n += 1;
      return [{ name: 'h-' + which, source: 'npm', stars: 1 }];
    };
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [];
    const pA = m.buildIndex();
    const pB = m.buildIndex(); // 直接叠建（绕过 getIndex 去重的真实形状：contract 公开 buildIndex）
    await pA;
    check('M-h A 结束后 B 的预算 deadline 仍有效（旧实现此处已被清零）',
      ctxs.length === 2 && ctxs[0].deadline === 0 && ctxs[1].deadline > 0,
      JSON.stringify(ctxs.map((c) => c.deadline)));
    await pB;
    check('M-h B 结束后自己的 ctx 也清零（finally 只清各的）', ctxs[1].deadline === 0, String(ctxs[1].deadline));
    check('M-h 两次构建各自走完源循环（前置）', n === 2, String(n));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-i（审计#25 申报侧）：getIndex(force=true) 复用 _inFlight，不叠加并发构建 --
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
    let builds = 0;
    m.indexNpm = async () => { builds += 1; await new Promise((r) => setTimeout(r, 20)); return []; };
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [];
    const p1 = m.getIndex(true);
    const p2 = m.getIndex(true);
    check('M-i force 请求取到同一在途构建（promise 同一引用）', p1 === p2, p1 === p2 ? 'same' : 'diff');
    await p1;
    check('M-i 连续 force 只发起一次构建', builds === 1, String(builds));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();