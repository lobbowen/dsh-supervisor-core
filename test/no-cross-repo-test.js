#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 无跨仓源码依赖门禁
//
// ## 解决的问题（真实故障）
//
//   两仓按**仓库**隔离（历史：曾在不同账号下，现均为 lobbowen）：
//   内核 lobbowen/dsh-supervisor-core（闭源 npm 产物），
//   壳 lobbowen/dsh-supervisor-launcher（公开）。运行时二者只经
//   「壳下载**已发布**内核包 / 内核读壳写的 identity.json、registry.json」交互，
//   **不存在任何源码级跨仓依赖**。
//
//   但内核测试曾用 test/_shell-repo.js 去读**壳仓源码**（版本向量逐字节比对、
//   R10-b 扫描壳源码、W5/A5/P2 读壳 update.rs/macos.rs），CI 又 actions/checkout 壳仓。
//   后果：内核 CI 读的是壳仓默认分支 main 的**浮动版本**，本地读同级工作树 ->
//   **同一内核提交，本地绿、CI 红**；且一个与内核无关的壳仓提交即可翻转内核 CI 结论。
//
// ## 锁定的不变量
//
//   X-1 本仓代码/脚本/workflow 不得引用壳仓源码耦合标识
//   X-2 workflow 不得 checkout 壳仓（repository: <owner>/dsh-supervisor-launcher）
//   X-3 test/_shell-repo.js 不得复活
//   X-4 package.json#scripts.test 自包含（不含壳仓耦合门禁，且含本门禁）
//   X-5 反向：判据能识别伪造违规（门禁非空转），且不误报文档中的仓库名
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const SELF = path.basename(__filename);

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

// 壳仓源码耦合标识（仅扫代码/脚本/workflow；.md 文档不扫 —— 文档合法地描述壳仓）
const COUPLING = [
  ['_shell-repo', '壳仓定位助手（已删除）'],
  ['DSH_SHELL_REPO', '壳仓路径环境变量'],
  ['shellRepoPath', '壳仓路径解析函数'],
  ['shellRepoHelper', '壳仓路径解析助手'],
];

// 壳仓 checkout 判据只认「owner 任意 + 壳仓名」：把 owner 钉死会在迁仓后静默失效
// （新账号下的壳仓 checkout 会被直接放过）。
const SHELL_CHECKOUT_RE = /repository:\s*[\w.-]+\/dsh-supervisor-launcher/;

const CODE_DIRS = ['src', 'test', 'release', 'bin', '.github'];
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.sh', '.yml', '.yaml', '.json']);
const SKIP_DIR = new Set(['node_modules', 'target', 'dist', '.git', 'ui-react']);
const SKIP_FILE = new Set([SELF]);

function walk(dir, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (CODE_EXT.has(path.extname(e.name))) out.push(p);
  }
}

// -- X-1 代码/脚本/workflow 无壳仓耦合标识 --
console.log('== X-1 无跨仓源码耦合标识 ==');
{
  const files = [];
  for (const d of CODE_DIRS) walk(path.join(ROOT, d), files);
  const offenders = [];
  for (const f of files) {
    if (SKIP_FILE.has(path.basename(f))) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const [tok, why] of COUPLING) {
      if (src.includes(tok)) offenders.push(path.relative(ROOT, f) + ' :: ' + tok + '（' + why + '）');
    }
  }
  check('X-1 代码/脚本/workflow 无壳仓源码耦合标识',
    offenders.length === 0, offenders.slice(0, 8).join(' | ') || ('扫描 ' + files.length + ' 个文件，零命中'));
}

// -- X-2 workflow 不得检出壳仓 --
console.log('== X-2 workflow 不检出壳仓 ==');
{
  const wfDir = path.join(ROOT, '.github', 'workflows');
  let files = [];
  try { files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)); } catch { /* 由下面断言报告 */ }
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(wfDir, f), 'utf8');
    // 只看可执行内容：剥离整行注释，避免说明文字自匹配（本仓既有纪律）
    const code = src.split(String.fromCharCode(10)).filter((l) => !/^\s*#/.test(l)).join(String.fromCharCode(10));
    if (SHELL_CHECKOUT_RE.test(code)) bad.push(f + ' checkout 壳仓');
    if (/path:\s*shell-repo/.test(code)) bad.push(f + ' path: shell-repo');
  }
  check('X-2 workflow 不检出壳仓（无 repository/path: shell-repo）',
    bad.length === 0 && files.length > 0, bad.join(' | ') || ('检查 ' + files.length + ' 个 workflow'));
}

// -- X-3 助手文件不得复活 --
console.log('== X-3 壳仓定位助手不得复活 ==');
{
  check('X-3 test/_shell-repo.js 不存在',
    !fs.existsSync(path.join(ROOT, 'test', '_shell-repo.js')), '已删除');
}

// -- X-4 清单自包含 --
console.log('== X-4 清单自包含 ==');
{
  // 清单唯一事实源 = test/manifest.js（scripts.test 已收敛为 `node test/_runner.js`）。
  const chain = String((require(path.join(ROOT, 'package.json')).scripts || {}).test || '');
  const listed = require(path.join(__dirname, 'manifest.js')).chain().join(' ');
  const selfContained = (s) => !s.includes('_shell-repo') && !s.includes('DSH_SHELL_REPO');
  check('X-4 scripts.test 与登记表都不含壳仓耦合门禁',
    selfContained(chain) && selfContained(listed), '自包含');
  check('X-4 登记表含本门禁（防自身被漏掉）',
    listed.includes('no-cross-repo-test.js'), '已登记');
}

// -- X-5 反向：判据非空转 --
console.log('== X-5 反向（判据有效性）==');
{
  // 伪造含耦合标识的样本 -> 必须被识别
  const probe = 'const h = require("./_shell-repo"); h.shellRepoPath();';
  check('X-5 反向：判据能识别含耦合标识的样本',
    COUPLING.some(([tok]) => probe.includes(tok)), 'hit');

  // 文档中的仓库名是合法的，不得因「含 dsh-supervisor-launcher」而误报
  const docLine = '壳源码位于公开仓库 `lobbowen/dsh-supervisor-launcher`（MIT）。';
  check('X-5 反向：文档中的仓库名不误报',
    !COUPLING.some(([tok]) => docLine.includes(tok)), 'ok');

  // 伪造 workflow checkout -> 必须被识别（新旧账号名都要抓到：判据不依赖 owner）
  const wfProbeOld = '      - uses: actions/checkout@v4\n        with:\n          repository: wasi7mglns/dsh-supervisor-launcher\n          path: shell-repo\n';
  const wfProbeNew = '      - uses: actions/checkout@v4\n        with:\n          repository: lobbowen/dsh-supervisor-launcher\n          path: shell-repo\n';
  const stripComments = (s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('X-5 反向：判据能识别壳仓 checkout（旧账号名）',
    SHELL_CHECKOUT_RE.test(stripComments(wfProbeOld)) && /path:\s*shell-repo/.test(wfProbeOld), 'hit');
  check('X-5 反向：判据能识别壳仓 checkout（迁仓后的账号名）',
    SHELL_CHECKOUT_RE.test(stripComments(wfProbeNew)), 'hit');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
