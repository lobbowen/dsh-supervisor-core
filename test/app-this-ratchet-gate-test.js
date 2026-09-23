#!/usr/bin/env node
'use strict';

// -------------------------------------------------------------------------
// app 层 this 债务棘轮门禁（P3-B，主控追加）
//
// ## 解决的问题
//   DF-4/5/6 及其门禁 DG-4/5/6 **只扫 src/domains**（domain-structure-gate-test.js 的
//   DOMAINS_DIR）。src/app 不在扫描面内，而 app 现有 267 处 this.X() 跨文件调用 —— 这笔债
//   既不可测量、也不受约束，只能靠人记。本门禁把它变成**可测量且不得增长**（棘轮）。
//
// ## 锁定的不变量
//   AT-1 每个 src/app 子目录的 this.X() 调用点数**不得超过基线**（硬判据，棘轮）
//   AT-2 反向自检用**合成样本**证明计数与棘轮裁决正确，不依赖真实数据总量（防自锁）
//   AT-3 绝对数值只作报告；基线按下方纪律更新（无意增长硬红 / 有意修复可上调并注明）
//
// ## 基线的来源与更新纪律（重要，防门禁退化为橡皮图章）
//   基线来源：P3-B 本轮**实测**（grep 原文计数，按目录）。
//   为什么用「原文计数」作基线：剥注释只会**删除**文本，不会凭空产生 this.X( 调用，
//   故 剥注释计数 <= 原文计数 恒成立 —— 以原文计数为基线可**保证首次即绿**，
//   同时仍能抓住任何真实新增（调用点增加会同时抬高两个计数）。实测落在注释内的
//   this.X( 为 2 处，故松弛量恒为 2；运行时会打印真实松弛量（当前 raw 264 / stripped 262）。
//   更新纪律（棘轮是**防漂移**，不是阻止正确修复）：
//     - **无意增长 = 硬红**：必须定位新增调用点来源。
//     - **有意修复需要新增调用 = 允许上调**，但必须同时：1) 在 BASELINE_BY_DIR 处注明理由与
//       新增调用点归属；2) 在提交信息里同步说明。不得为消红而静默上调。
//     - 真实下降时允许**下调**（例如 P3-A 把某切面工厂化后），同样在提交信息注明。
//    不得把 this.X() 藏进注释或字符串拼接来「绕过」计数 —— 那会让棘轮失真，比上调更坏。
//      （计数含字符串内的 this.X()，正是为了不给这类规避留口子。）
//    本门禁只统计、不重构；把 daemons/main 工厂化是 P3-A 的后续独立周期。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'app');

// 基线（本轮实测，按 src/app 直接子目录；未列出的目录基线为 0）
const BASELINE_BY_DIR = {
  main: 0, control: 54, daemons: 31, facade: 0, settings: 8, native: 3, ctl: 0, self: 1, assembly: 1,
};
const BASELINE_TOTAL = 98; // = 上述各项之和（原文口径上界；剥注释实测 94，松弛量 2）
// 上调记录：daemons 30->31 —— 新增调用点唯一归属
//   src/app/daemons/process.js:68 `return this._ctlOwnerPid() === pid;`
//   （B1-5 判活 fail-open 收口：probeAlive 返回 unknown 时必须有第二条证据——ctl 端口属主
//   正是该 pid——才认活；DaemonLifecycle 类自身实例方法，与其余 30 处同类）。总量 97->98。
// 上调记录：daemons 29->30 —— 新增调用点唯一归属
//   src/app/daemons/process.js:159 `if (this._stopping || this._exitIntended()) return { mode: 'stopping' }`
//   （DaemonLifecycle 类自身实例方法，与其余 29 处同类，E-3 退出意图谓词钩子注入所需）。总量 96->97。
// 收紧记录：P3-A 完成 ctl 切面工厂化后，ctl 的
//   this.X() 由 3 降到 0 —— 故 ctl 基线 3->0、总量 267->264。记录于此以说明本门禁**可升可降**：
//   下调永远允许（真实下降时），上调须按上方纪律注明理由与新增调用点归属。
// 收紧记录：facade/daemons **原地去 this**
//   —— 实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的惰性 deps（WeakMap）；
//   方法名、{ methods } 外壳与逐字方法体一律保留（装配路径与读源码形态的门禁均不变）。
//   facade 13->0（router 7->0、main 5->0、ports 1->0；lan/status 原为 0 未动）；
//   daemons 43->29（identity 6->0、runtime 8->0；process.js 的 29 处是 DaemonLifecycle **类**
//   自身实例的方法，this=实例而非 host，不属本棘轮治理范围）。总量 264->237（剥注释实测 235）。
// 收紧记录：main 非热路径 4 文件原地去 this
//   —— decide 25->0、health-gate 12->0、shadow 5->0、signals 3->0（共 45）。基线 main 141->96、
//   总量 237->192（剥注释实测 190）。**未转换且不计入下调**：controller.js 28、process.js 68
//   （二者带源码形态钉子，见 design-notes/_p6-b2-main-inplace.md）。
// 收紧记录：controller.js 28->0
//   （phase switch 抽取器同批改为形态无关）。基线 main 96->68、总量 192->164（剥注释实测 162）。
// 收紧记录：process.js 68->0 —— main 目录
//   **全部归零**（decide/health-gate/shadow/signals/controller/process 六文件）。基线 main 68->0、
//   总量 164->96（剥注释实测 94）。

const passed = [], failed = [];
function check(name, ok, evidence) {
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (evidence ? '  <- ' + evidence : ''));
  (ok ? passed : failed).push(name);
}

// -- 剥注释（字符串保留，故 this.X( 出现在字符串里的计数与原文一致）--
// 阶段六 P6-A：统一走 test/_strip.js 的字符级单一实现（语义等价且正则字面量感知）。
//   字符串内的 this.X( 仍被保留 —— 「计数含字符串」是本棘轮的刻意口径。
const { stripComments } = require('./_strip');

// -- 计数与棘轮裁决（纯函数：合成样本与实盘共用同一条路径）--
/** 统计 this.X() 调用点；this.deps.foo() / obj.thisX() 不计（要求点号后即方法名与左括号）。
 *   用 [ \t]* 而非 \s*：基线是用逐行 grep（本机无 JS 运行时）实测的，\s* 允许跨行匹配
 *  `this.foo\n(` 这类换行写法，会与基线口径不一致（可能 stripped > raw 基线而假红）。
 *  收紧为行内空白后，本函数与实测口径严格等价 —— 这是「基线可信」的前提。 */
function countThis(src) {
  const m = String(src || '').match(/this\.([A-Za-z_$][\w$]*)[ \t]*\(/g);
  return m ? m.length : 0;
}
/** 棘轮裁决：不得超过基线（相等通过；下降通过；上升越界）。 */
function ratchetVerdict(current, baseline) { return current <= baseline ? 'ok' : 'over'; }

// - AT-2：合成样本反向自检（永远硬失败；不依赖真实数据总量）--
console.log('== AT-2 合成样本自检（门禁自身完整性）==');
{
  check('AT-2 反向：计数只认 this.X( 形态（this.deps.foo / obj.thisX 不计）',
    countThis('this.a(); this.b();') === 2 &&
    countThis('this.foo ()') === 1 &&
    countThis('this.deps.foo(); obj.thisX(); foo();') === 0, 'ok');
  check('AT-2 反向：剥注释移除注释内的 this.X(、保留字符串内的',
    countThis(stripComments('// this.commentOnly()\nthis.real();')) === 1 &&
    countThis(stripComments('/* this.blockOnly() */\nthis.real();')) === 1 &&
    countThis(stripComments("const s = 'this.inString()'; this.real();")) === 2, 'ok');
  check('AT-2 反向：棘轮裁决三条分支都可达（防恒真/恒假自锁）',
    ratchetVerdict(5, 5) === 'ok' && ratchetVerdict(6, 5) === 'over' && ratchetVerdict(4, 5) === 'ok', 'ok');
  check('AT-2 反向：裁决对 0 基线也非恒真',
    ratchetVerdict(0, 0) === 'ok' && ratchetVerdict(1, 0) === 'over', 'ok');
  check('AT-2 反向：基线与实现口径一致（不跨行匹配）',
    countThis('this.foo\n  ();') === 0, 'ok');
}

// - AT-1：实盘测量 + 棘轮裁决 --
console.log('\n== AT-1 实盘测量（src/app，按目录）==');
{
  const dirs = fs.readdirSync(APP, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const rows = [];
  let rawTotal = 0, strippedTotal = 0;
  for (const d of dirs) {
    let raw = 0, stripped = 0;
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const txt = fs.readFileSync(p, 'utf8');
        raw += countThis(txt);
        stripped += countThis(stripComments(txt));
      }
    };
    walk(path.join(APP, d));
    rows.push({ dir: d, raw, stripped, base: BASELINE_BY_DIR[d] || 0 });
    rawTotal += raw; strippedTotal += stripped;
  }
  for (const r of rows) {
    console.log('  ' + r.dir.padEnd(15) + ' stripped=' + String(r.stripped).padStart(4) +
      '  raw=' + String(r.raw).padStart(4) + '  baseline=' + String(r.base).padStart(4) +
      (ratchetVerdict(r.stripped, r.base) === 'over' ? '   <-- OVER' : ''));
  }
  console.log('  ' + 'TOTAL'.padEnd(15) + ' stripped=' + String(strippedTotal).padStart(4) +
    '  raw=' + String(rawTotal).padStart(4) + '  baseline=' + String(BASELINE_TOTAL).padStart(4));
  console.log('[AT] 松弛量（raw - stripped，即落在注释内的调用点）= ' + (rawTotal - strippedTotal) +
    '；基线取 raw 口径故有一行上界，实测注释内仅 2 处');

  for (const r of rows) {
    check('AT-1 ' + r.dir + ' this.X() 不超基线（' + r.stripped + ' <= ' + r.base + '）',
      ratchetVerdict(r.stripped, r.base) === 'ok');
  }
  check('AT-1 全局 this.X() 不超基线（' + strippedTotal + ' <= ' + BASELINE_TOTAL + '）',
    ratchetVerdict(strippedTotal, BASELINE_TOTAL) === 'ok');

  const lower = rows.filter((r) => r.stripped < r.base);
  if (lower.length) {
    console.log('[AT] 提示（非判据）：下列目录已低于基线，可在确认后**下调**基线常量（只降不升）：' +
      lower.map((r) => r.dir + ' ' + r.base + '->' + r.stripped).join(', '));
  }
}

// ---------------------------------------------------------------------------
// SC-1..SC-3 宽作用域静默 catch 棘轮
//
//   判据：`try { … } catch {}`（catch 完全空）**且** try 体 >=3 行 **且** >=2 条语句 —— 即
//   「面过宽且无痕」：一次抛错会静默吞掉整段动作，而单表达式（`try { JSON.parse(f) } catch {}`）
//   是惯用法、不计。
//   修复方向（不是删 catch）：要么**窄化作用域**（把"读"和"用"分开），要么**留痕**
//   （logger.warn + 必要时事件），让失败在日志/面板可见。见 src/app/state/store.js 的 loadState。
//   基线更新纪律同 AT-*：只减不增；确需新增须在提交信息注明理由。
//   基线来源：D-13 本轮**实测**（判据即本文件的 countWideSilentCatch，剥注释口径）：
//     bootstrap(1) daemons/process.js(1，reclaimOrphans 的 catch 只有注释体=行为静默)
//     native/ops(1) native/probe(2) settings/env(1) settings/versions(2) = 8。
//     本轮已收口：state/store.js loadState（分段+留痕）、daemons/process.js _writeIdentity（warn+事件）、
//     audit/orphan-scan.js 两段（扫描维度失败必须可见）。
// ---------------------------------------------------------------------------
const SC_BASELINE = 8;

/** 从 openIdx 处的 '{' 找配对 '}'（跳过字符串/模板串；本判据面向源码，注释已在外部剥离）。 */
function matchBraceFor(src, openIdx) {
  let depth = 0, i = openIdx;
  const LF = String.fromCharCode(10), BT = String.fromCharCode(96);
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== LF) i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === BT) {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** 数一份（已剥注释的）源码里的「宽作用域静默 catch」处数。 */
function countWideSilentCatch(src) {
  let n = 0;
  const re = /\btry\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    const close = matchBraceFor(src, open);
    if (close < 0) break;
    if (!/^\s*catch\s*(\([^)]*\))?\s*\{\s*\}/.test(src.slice(close + 1, close + 40))) { re.lastIndex = close; continue; }
    const body = src.slice(open + 1, close);
    const lines = body.split(String.fromCharCode(10)).length;
    const stmts = (body.match(/[;}]/g) || []).length;
    if (lines >= 3 && stmts >= 2) n++;
    re.lastIndex = close;
  }
  return n;
}

/** 递归收集目录下全部 .js。 */
function walkJs(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walkJs(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

{
  const files = walkJs(APP, []);
  const hits = [];
  for (const p of files) {
    const n = countWideSilentCatch(stripComments(fs.readFileSync(p, 'utf8')));
    if (n) hits.push(path.relative(ROOT, p).split(path.sep).join('/') + '(' + n + ')');
  }
  const total = hits.reduce((s, h) => s + Number(/\((\d+)\)$/.exec(h)[1]), 0);
  check('SC-0 扫描面非空（src/app 源码文件数）', files.length > 40, files.length + ' 个文件');
  check('SC-1 宽作用域静默 catch 不超基线（' + total + ' <= ' + SC_BASELINE + '）',
    ratchetVerdict(total, SC_BASELINE) === 'ok', hits.join(', ') || '无');
  if (total < SC_BASELINE) console.log('[SC] 提示（非判据）：当前 ' + total + ' 低于基线 ' + SC_BASELINE + '，可下调常量');
  // SC-2 反向：判据对「宽 + 静默」确实计数，对窄/有痕形态不误报（否则 SC-1 是空转）
  const WIDE = "function f() {\n  try {\n    a();\n    b();\n    c();\n  } catch {}\n}\n";
  const NARROW_EXPR = "function f() {\n  try { a(); } catch {}\n}\n";
  const NARROW_ONE = "function f() {\n  try {\n    return JSON.parse(s);\n  } catch {}\n  return null;\n}\n";
  const LOUD = "function f() {\n  try {\n    a();\n    b();\n    c();\n  } catch (e) { log(e); }\n}\n";
  check('SC-2 反向：宽作用域(≥3行/≥2句)+静默 判 1 处', countWideSilentCatch(WIDE) === 1,
    '计数=' + countWideSilentCatch(WIDE));
  check('SC-2 反向：单表达式静默（惯用法）不误报', countWideSilentCatch(NARROW_EXPR) === 0,
    '计数=' + countWideSilentCatch(NARROW_EXPR));
  check('SC-2 反向：跨行但仅 1 句不误报', countWideSilentCatch(NARROW_ONE) === 0,
    '计数=' + countWideSilentCatch(NARROW_ONE));
  check('SC-2 反向：留痕（catch 有体）不误报', countWideSilentCatch(LOUD) === 0,
    '计数=' + countWideSilentCatch(LOUD));
  // SC-3 真实修复的形态证据：loadState 已按「分段 + 留痕」收口（回归即判红）
  const storeSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'state', 'store.js'), 'utf8'));
  check('SC-3 loadState 读段区分 ENOENT、恢复段留痕（D-13 收口形态）',
    /e\.code !== 'ENOENT'/.test(storeSrc) && /state restore partial/.test(storeSrc),
    '已收口');
}

console.log('\n结果: ' + passed.length + ' passed, ' + failed.length + ' failed');
if (failed.length) {
  console.log('\n失败（棘轮越界或自检失败）:');
  for (const s of failed) console.log('  - ' + s);
  console.log('\n若为棘轮越界：先判断是「无意增长」还是「有意修复新增调用」——');
  console.log('  · 无意增长：必须定位来源并消除；');
  console.log('  · 有意修复：允许上调基线常量，但须在 BASELINE_BY_DIR 注明理由与归属，并在提交信息同步。');
}
process.exit(failed.length ? 1 : 0);
