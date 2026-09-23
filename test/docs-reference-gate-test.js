#!/usr/bin/env node
'use strict';

// 文档源码引用门禁（docs-reference）—— E1/J6
//
// 解决的问题：SSOT 文档与根级说明会引用 src/... 路径，但此前没有任何门禁读文档正文，
//   重构搬移文件后文档里的路径会静默失效。已发生两例：NO-CONSOLE-WINDOW-STANDARD.md
//   长期指向已重构掉的 src/guard/...；KERNEL-DAEMON-CONTRACT.md 指向已拆成目录的
//   src/platform/os/autostart.js。人工审计只能事后发现，故固化为机器判据。
//
// 锁定不变量
//   DR-1 根级 *.md 中出现的每个 src/... 路径字面量必须真实存在（文件或目录；
//        允许省略 .js 后缀，允许带:行号）。故意举例"不存在路径"的写法必须先改述，
//        不得把悬空路径留在正文里。
//   DR-2 反向：判据能识别不存在的路径，且不误报存在的文件/目录/带行号形态/glob 形态。
//   DR-3 （report-only）src/ 目录树的「裸名」（无 src/ 前缀）在 src/ 下必须可寻；只报告、
//        不致命 —— 裸名上下文相对，基准目录不可静态确定（见 DR-3 块的诚实边界）。
//   DR-4 文档写死的 archive/ 条目数必须等于文件系统实测（数字双写必失实，计数只归本判据）。
//   DR-5 指向 archive/ 下单个文档的引用必须仍存在（过程文档收敛为主题卷后不留悬空指针）。
//
// 范围与排除：DR-1..DR-3 只扫根级 *.md（design-notes/ 是过程记录，不是 SSOT，不扫）。
//   下列文档记录的是当时（已废弃）的方案与目录，改写反而伪造历史，整份跳过；
//   与其它门禁一致，CHANGELOG.md 属历史记录。
//   DR-5 例外：它判的是「引用能否打开」，故扫全仓（archive/ 内部互引除外），
//   并把 HANDOFF.md（自述为过程文档）与 CHANGELOG.md 一并按历史记录跳过。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const HISTORICAL = new Set([
  'CHANGELOG.md',
  'ARCHITECTURE-CONTRACT-phase0.md',
  'ARCHITECTURE-PLAN-session-lifecycle.md',
]);

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// src/... 字面量。段字符不含 * ? #: ，故 glob（src/**/*.js）与行号后缀不会被吞进来。
//  边界（P3-B 修，主控发现）：src/ 只有在**是路径根**时才计入 —— 前面不得是 / 或标识符字符。
//   否则 `ui/src/features/supervisor/InstancesPage.tsx`（前端路径的正常写法）会被**截出**
//   `src/features/supervisor/InstancesPage.tsx`，再按 <仓根>/src/... 判不存在 => 误报违规。
//   负向后顾 (?<![\w/]) 即为此；Node >=16 支持。`./src/` 是合法写法，由 refsOf 归一后再匹配。
const SRC_REF = /(?<![\w/])src\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*/g;

/** 归一化原文命中：剥掉:行号 与行尾标点；无意义片段返回 null。 */
function normalizeRef(hit) {
  let t = String(hit || '');
  t = t.replace(/(?::\d+)+$/, '');
  t = t.replace(/[#?].*$/, '');
  t = t.replace(/[.,;:)\]}>'"\`。，；：）】]+$/, '');
  t = t.replace(/\/+$/, '');
  if (t.length <= 4) return null;
  return t;
}

/** 路径是否存在：真实文件、真实目录，或补 .js 后的文件。 */
function resolves(rel) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) return true;
  if (!/\.[A-Za-z0-9]+$/.test(rel) && fs.existsSync(abs + '.js')) return true;
  return false;
}

/** 抽取一段文本里的 src/... 引用（去重、保序）。 */
function refsOf(text) {
  // `./src/` 归一到 `src/`：否则该合法写法会因负向后顾看到前一个字符 '.' 而失去覆盖。
  const t0 = String(text || '').replace(/\.\/src\//g, 'src/');
  const out = new Set();
  for (const hit of (t0.match(SRC_REF) || [])) {
    const t = normalizeRef(hit);
    if (t) out.add(t);
  }
  return [...out];
}

// -- DR-1：根级文档引用的 src/... 全部可解析 --
{
  const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md') && !HISTORICAL.has(f));
  const offenders = [];
  let withRefs = 0;
  for (const d of docs) {
    const refs = refsOf(fs.readFileSync(path.join(ROOT, d), 'utf8'));
    if (refs.length) withRefs += 1;
    for (const r of refs) if (!resolves(r)) offenders.push(d + ' -> ' + r);
  }
  check('DR-1 根级文档引用的 src/... 路径都存在', offenders.length === 0,
    offenders.length ? offenders.slice(0, 6).join(' | ')
      : (docs.length + ' 份文档 / ' + withRefs + ' 份含 src 引用，零悬空'));
}

// -- DR-2：反向（判据非空转，且不误报）--
{
  check('DR-2 反向：能识别不存在的路径',
    refsOf('见 src/guard/supervisor/main-process.js:46 的说明').some((r) => !resolves(r)), 'hit');
  check('DR-2 反向：存在的文件/目录/带行号形态不误报',
    refsOf('src/platform/os/autostart/ 与 src/platform/util/exec.js:22').every((r) => resolves(r)), 'miss');
  check('DR-2 反向：glob 形态（src/**/*.js）不产生引用',
    refsOf('任何 src/**/*.js 都不超过 300 行').length === 0, 'ok');
  check('DR-2 反向：历史文档被显式排除',
    HISTORICAL.has('CHANGELOG.md') && HISTORICAL.has('ARCHITECTURE-PLAN-session-lifecycle.md'), 'ok');
  // 路径根边界（合成样本，不依赖真实数据）：
  check('DR-2 反向：子段 ui/src/... 不得被当作根路径 src/...（防误报）',
    refsOf('ui/src/features/supervisor/InstancesPage.tsx').length === 0, '0');
  check('DR-2 反向：裸 ui/src/... 与其它非 src 根同样为 0',
    refsOf('release/scripts/foo.sh 与 web/src/app.js').length === 0, '0');
  check('DR-2 反向：./src/... 归一后仍被覆盖且可解析',
    refsOf('见 ./src/platform/util/exec.js:22').length === 1 &&
    refsOf('见 ./src/platform/util/exec.js:22').every((r) => resolves(r)), 'hit');
  check('DR-2 反向：src/app/x.js 正常命中（与上一条成对，防我把 src 全滤掉）',
    refsOf('src/platform/util/exec.js').length === 1, 'hit');
}

// -- DR-3 地基：切代码块 / 取树 token / 裸名解析 --
const FENCE = String.fromCharCode(96).repeat(3);
/** 切出 fenced 代码块（三反引号围栏）的逐行内容。 */
function fencedBlocks(md) {
  const out = [];
  let cur = null;
  for (const line of String(md).split(String.fromCharCode(10))) {
    if (line.trim().startsWith(FENCE)) { if (cur === null) cur = []; else { out.push(cur); cur = null; } continue; }
    if (cur !== null) cur.push(line);
  }
  return out;
}
/** 缩进代码块（>=4 空格）；跳过 fenced 区域以免重复计数。 */
function indentedBlocks(md) {
  const out = [];
  let cur = null;
  let inf = false;
  for (const line of String(md).split(String.fromCharCode(10))) {
    if (line.trim().startsWith(FENCE)) { if (cur) { out.push(cur); cur = null; } inf = !inf; continue; }
    if (inf) continue;
    if (/^\s{4,}\S/.test(line)) { if (cur === null) cur = []; cur.push(line); }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
/** 只保留**具体 src 目录树**块：块内存在一行恰为 'src/'。 */
function srcRootedBlocks(md) {
  const all = fencedBlocks(md).concat(indentedBlocks(md));
  return all.filter((b) => b.some((l) => l.trim() === 'src/'));
}
/** 从树块行取路径 token：树连接符之后的首个名字，且须形如目录（/ 结尾）或带扩展名文件。 */
function treeTokensOf(blockLines) {
  const out = [];
  for (const line of blockLines) {
    const m = /^[\s│]*[├└]──\s+([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\/?)/.exec(line);
    if (!m) continue;
    const t = m[1];
    if (!/\/$/.test(t) && !/\.[A-Za-z0-9]+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}
/** src/ 下全部 basename（文件与目录），供裸名宽松检索。 */
const SRC_BASENAMES = (() => {
  const set = new Set();
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { set.add(e.name); if (e.isDirectory()) walk(path.join(d, e.name)); }
  })(path.join(ROOT, 'src'));
  return set;
})();
/** 裸名/相对名是否在 src/ 下可寻（宽松，见 DR-3 头注）。 */
function treeTokenResolves(token) {
  let t = String(token);
  if (t.startsWith('src/')) t = t.slice(4);
  const isDir = t.endsWith('/');
  if (isDir) t = t.slice(0, -1);
  if (!t) return true;
  if (t.includes('/')) {
    const abs = path.join(ROOT, 'src', t);
    return fs.existsSync(abs) || (!isDir && fs.existsSync(abs + '.js'));
  }
  return SRC_BASENAMES.has(t);
}

// -- DR-3（report-only）：src/ 目录树的「裸名」漂移 --
// 目录树用裸名（无 src/ 前缀），DR-1 的 src/... 字面量覆盖不到 -> 已两轮人工漂移。
// 口径：只扫描**含独立 src/ 根行**的代码块（即具体 src 目录树）；模板树（如 domains/<domain>/）
//   与非 src 树（release 产物、API 端点列表）不参与，否则必然误报。树连接符之后的首个
//   路径 token：裸名按 basename 在 src/ 下检索（宽松，同名多目录不误报）；dir/name 要求该相对路径存在。
// 诚实边界：裸名是**上下文相对**的（同名可能属于多个目录，基准目录不可静态确定，P3-B 已登记）。
//   故本判据只报告、不计入退出码；转硬需先实测 0 误报（当前 tree 实测 0，但依托「只扫 src 根块」的收窄口径）。
{
  const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md') && !HISTORICAL.has(f));
  const misses = [];
  let blocks = 0;
  let tokens = 0;
  for (const d of docs) {
    const rooted = srcRootedBlocks(fs.readFileSync(path.join(ROOT, d), 'utf8'));
    blocks += rooted.length;
    for (const b of rooted) for (const t of treeTokensOf(b)) {
      tokens += 1;
      if (!treeTokenResolves(t)) misses.push(d + ' -> ' + t);
    }
  }
  // report-only：只打印，不改退出码（新增可见性，非放宽既有判据）。
  console.log('DR-3（report-only）src/ 目录树裸名：扫描 ' + docs.length + ' 份 .md / ' +
    blocks + ' 个 src 树块 / ' + tokens + ' 个 token，未命中 ' + misses.length + ' 个');
  for (const m of misses.slice(0, 20)) console.log('  - ' + m);
  // 反向自检（硬失败，合成样本，不依赖真实数据）
  check('DR-3 反向：合成树块中的不存在裸名被检出（basename 层）',
    treeTokensOf(['src/', '├── no-such-module.js', '└── no-such-dir/']).some((t) => !treeTokenResolves(t)), 'hit');
  check('DR-3 反向：合成树块中存在的名不误报',
    treeTokensOf(['src/', '├── supervisor.js', '└── platform/']).every((t) => treeTokenResolves(t)), 'miss');
  check('DR-3 反向：非 src 根的树块（模板树）被排除，不参与判定',
    srcRootedBlocks(['domains/<domain>/', '└── README.md']).length === 0, 'ok');
  check('DR-3 反向：带父目录形态 dir/name 不存在时被检出',
    !treeTokenResolves('no-such-dir/no-such-file.js'), 'hit');
  check('DR-3 反向：带父目录形态 dir/name 存在时不误报',
    treeTokenResolves('src/platform/contract/deploy.js'), 'miss');
}

// -- DR-4：文档写死的 archive/ 条目数必须等于文件系统实测 --
// README 用「archive/<目录>/：N 份」描述归档目录的**当前状态**。这类数字与目录内容双写，
//   增删一份文档就静默失实（实盘曾长期停在远大于实际的数字）。计数归本判据实算。
{
  const LINE = /archive\/([A-Za-z0-9_-]+)\/：\s*(\d+)\s*份/g;
  const actualOf = (dir) => {
    const abs = path.join(ROOT, 'archive', dir);
    if (!fs.existsSync(abs)) return -1;
    return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile()).length;
  };
  const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md') && !HISTORICAL.has(f));
  const stated = [];
  for (const d of docs) {
    for (const m of String(fs.readFileSync(path.join(ROOT, d), 'utf8')).matchAll(LINE)) {
      stated.push({ doc: d, dir: m[1], n: Number(m[2]) });
    }
  }
  const bad = stated.filter((s) => actualOf(s.dir) !== s.n);
  check('DR-4 文档写死的 archive/ 条目数 = 文件系统实测', bad.length === 0,
    bad.length ? bad.map((b) => b.doc + ': archive/' + b.dir + '/ 写 ' + b.n + ' 实 ' + actualOf(b.dir)).join(' | ')
      : (stated.length + ' 处计数逐条核对（' + [...new Set(stated.map((s) => s.dir))].join(', ') + '）'));
  // 覆盖下限 + 反向：抽取器必须真的读到两处、且只把写错的那处判红（防判据空转）
  const sample = 'archive/design-notes/：138 份设计文档\narchive/history/：' + actualOf('history') + ' 份\n';
  const hits = [...sample.matchAll(LINE)].map((m) => ({ dir: m[1], n: Number(m[2]) }));
  check('DR-4 反向：抽取器读到合成行两处，且仅写错的那处成为 offender',
    hits.length === 2 && hits.filter((h) => actualOf(h.dir) !== h.n).map((h) => h.dir).join(',') === 'design-notes',
    JSON.stringify(hits));
  check('DR-4 反向：归档目录不存在时按失实处理（防目录改名后静默通过）',
    actualOf('no-such-archive-dir') === -1, 'miss');
  check('DR-4 非空转：实盘至少读到 README 的两处计数', stated.length >= 2, stated.length + ' 处');
}

// -- DR-5：指向 archive/ 下单个文档的引用必须仍然存在 --
//   design-notes/ 的过程文档曾整体收敛为主题卷并删掉源文件，指针留在代码与文档里就成了
//   「读得到名字、打不开文件」——本判据把这类存在性收进机器判定（卷数不写死，见 N-g 同理）。
//   口径：只判指向**单个文件**的引用；集合/区间写法（AUDIT-*.md、FIX-1..8.md）不判。
//   archive/ 内部互引与 CHANGELOG/HANDOFF 是历史记录，整份跳过（改写反而伪造历史）。
{
  const AREF = /(?:archive\/)?(?:design-notes|history)\/[A-Za-z0-9_.\u4e00-\u9fff-]+\.md/g;
  const HISTORY_DOCS = new Set(['CHANGELOG.md', 'HANDOFF.md']);
  const PRUNE = new Set(['node_modules', '.git', 'dist', 'ui-react', 'target', '.cache', 'archive']);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (PRUNE.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(?:md|js|cjs|mjs|sh|ya?ml|json|html|ts|tsx)$/.test(e.name)) {
        if (d === ROOT && HISTORY_DOCS.has(e.name)) continue;
        files.push(p);
      }
    }
  })(ROOT);
  const isSetNotation = (t) => t.includes('*') || t.includes('..');
  const resolvedOf = (t) => resolves(t.startsWith('archive/') ? t : path.posix.join('archive', t));
  const refs = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    for (const m of fs.readFileSync(f, 'utf8').matchAll(AREF)) {
      if (isSetNotation(m[0])) continue;
      refs.push({ rel, t: m[0], ok: resolvedOf(m[0]) });
    }
  }
  const bad = refs.filter((r) => !r.ok);
  check('DR-5 archive/ 单文件引用都存在（过程文档收敛后不留悬空指针）',
    bad.length === 0,
    bad.length ? bad.map((b) => b.rel + ' -> ' + b.t).join(' | ')
      : files.length + ' 个文件 / ' + refs.length + ' 条引用全部可寻');
  // 反向夹具（卷名用拼接构造，避免本文件被自己的判据抓到）：
  const ALIVE = 'archive/design-notes/_EXEC' + '-FIX-HISTORY.md';
  const GONE = 'archive/design-notes/_no_such_volume_' + '9.md';
  check('DR-5 反向：真实存在的卷不误报（判据不因路径形态恒假）', resolvedOf(ALIVE), ALIVE);
  check('DR-5 反向：指向已删除文档的合成引用被判为不可寻', !resolvedOf(GONE), GONE);
  check('DR-5 反向：集合写法被识别为不判定', isSetNotation('design-notes/AUDIT-' + '*.md'), 'glob');
  check('DR-5 非空转：实盘读到可核实的单文件引用', refs.length >= 5, refs.length + ' 条');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
