#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 无控制台窗口门禁（内核侧）—— SSOT: NO-CONSOLE-WINDOW-STANDARD
//
// ## 背景（真机取证）
//   壳启动内核时弹出终端窗口。内核 platform/util/exec.js 的**同步** execFileSync
//   已设 windowsHide:true（门禁 G9-d），但**异步 spawn 无统一封装**：
//   SSOT 记录 src 下 14 处裸 spawn、其中 13 处缺 windowsHide。
//
// ## 断言（SSOT）
//   K-W1 src/platform/os/spawn.js 的 detached / piped / detachedIgnored
//        三入口的 options 均含 windowsHide: true（不变量 W-1）。
//   K-W2 src/** 下裸子进程调用点 = 0：spawn( / spawnSync( / execFile( / execFileSync( /
//        execSync( / 裸 exec(（判据要覆盖整个 exec 族；只匹配 spawn( 会把异步 execFile
//        留在盲区）。只允许经统一封装（spawn.js 豁免 spawn、util/exec.js 豁免 exec 族）。
//   K-W3 反向：判据必须能识别旧形态（无 windowsHide 的裸 spawn / 裸 execFile）-> 门禁非空转。
//
// 说明：本文件只**读**源码做静态分析，不执行被测代码。
//
// ## 覆盖缺口
//   K-W2 绿只证明「src/ 里没有裸子进程调用点」这一**文本形态**，不证明窗口隐藏这件事：
//   1. 扫描面只有 `src/**.js`：`bin/` 入口、`release/scripts/`、`ui/` 不在射程内
//      （G9 因同类事故已把 bin 纳入，本闸尚未跟进；当前 bin 实测 0 处裸调用，属**未设防**）。
//   2. 判据是**逐行**正则（先 split 再 test），因此两类形态完全看不见：
//      1) 调用名与 `(` 分处两行；2) **解构改名**后调用（`const { spawn: go } = …; go(…)`）
//      ——改名后源码里不存在任何被匹配的字面量。要补强需换 AST，不在本批范围。
//   3. 含 `child_process` 的整行跳过：同行「require + 调用」复合形态漏报（SSOT 已登记）。
//   4. K-W1 只在**封装入口**固定 windowsHide；调用方经 opts 传什么、子进程自己再起的孙进程
//      是否弹窗，均不在本闸范围。
//   5. 本闸不验证 Windows 真机行为（无 GUI 会话）：真机取证仍靠 CROSS-PLATFORM 文档的人工步骤。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const SPAWN_MODULE = 'src/platform/os/spawn.js';
// exec 族（含异步 execFile）的唯一合法调用点收口于 util/exec.js。
const EXEC_MODULE = 'src/platform/util/exec.js';
const ENTRY_FNS = ['detached', 'piped', 'detachedIgnored'];
const HIDE_RE = /windowsHide\s*:\s*true/;
const BT = String.fromCharCode(96); // 反引号

/** 剥离注释（行注释 + 块注释），保留换行以维持行号；字符串字面量原样保留。 */
// 阶段六 P6-A：剥离统一走 test/_strip.js 的**字符级单一实现**（空格占位，保长度/行号）。
const { blankComments } = require('./_strip');
function stripComments(src) { return blankComments(src); }

/** 收集 src/ 下全部 .js 文件（排除 node_modules/.git）。 */
function jsFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) out.push(p);
    }
  })(path.join(ROOT, 'src'));
  return out;
}

/** K-W2 / K-W3 共用判据：逐行找裸子进程调用点（spawn 族 + exec 族）。
 *  - 跳过含 child_process 的行（require / 解构导入本身不是调用点）——已知残留盲区：
 *    同行「require + 调用」复合形态仍被此规则跳过，与 spawn 时代一致，已在 SSOT 登记；
 *  - \bspawn\( 不会命中 respawn(（词内无边界）；spawnSync( 由独立词形命中；
 *  - 裸 exec( 用 (?<![.\w$]) 排除 RegExp 属性形态（re.exec( 不是子进程调用）。 */
const CALL_PATTERNS = [
  /\bspawn\s*\(/,
  /\bspawnSync\s*\(/,
  /\bexecFile\s*\(/,
  /\bexecFileSync\s*\(/,
  /\bexecSync\s*\(/,
  /(?<![.\w$])exec\s*\(/,
];
function bareSpawnCallSites(text) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!CALL_PATTERNS.some((re) => re.test(line))) continue;
    if (/child_process/.test(line)) continue;
    hits.push({ line: i + 1, text: line.trim() });
  }
  return hits;
}

/** K-W2：扫描 src/**，返回全部裸子进程调用点（spawn.js 豁免 spawn、exec.js 豁免 exec 族）。 */
function scanBareSpawns() {
  const offenders = [];
  for (const f of jsFiles()) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === SPAWN_MODULE || rel === EXEC_MODULE) continue; // 统一封装自身允许调用底层 API
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    for (const h of bareSpawnCallSites(code)) offenders.push(rel + ':' + h.line + '  ' + h.text);
  }
  return offenders;
}

/** 提取函数体（从 name 之后第一个 { 起做括号配对）。找不到返回 null。 */
function functionBody(src, name) {
  const re = new RegExp('\\b' + name + '\\b');
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open);
}

/** 一条声明的文本段（到匹配的右括号或顶层分号为止）。 */
function declSegment(src, idx) {
  let depth = 0;
  for (let i = idx; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth <= 0) return src.slice(idx, i + 1);
    } else if (c === ';' && depth === 0) {
      return src.slice(idx, i + 1);
    }
  }
  return src.slice(idx);
}

/** 同文件内「携带 windowsHide: true」的常量/工厂名 —— 允许入口经共享 opts 间接设置。 */
function hiddenCarriers(src) {
  const names = [];
  const re = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const seg = declSegment(src, m.index);
    if (seg && HIDE_RE.test(seg)) names.push(m[1]);
  }
  return names;
}

// -- K-W1：spawn.js 三入口均隐藏控制台 --
console.log('== K-W1 spawn.js 三入口 windowsHide ==');
{
  const abs = path.join(ROOT, SPAWN_MODULE);
  if (!fs.existsSync(abs)) {
    check('K-W1 ' + SPAWN_MODULE + ' 存在且三入口含 windowsHide: true', false,
      SPAWN_MODULE + ' 不存在（SSOT §3 统一封装尚未落地）');
  } else {
    const src = stripComments(fs.readFileSync(abs, 'utf8'));
    const carriers = hiddenCarriers(src);
    for (const fn of ENTRY_FNS) {
      const body = functionBody(src, fn);
      let ok = false;
      let how = '';
      if (body) {
        if (HIDE_RE.test(body)) { ok = true; how = 'literal'; }
        else {
          for (const c of carriers) {
            if (c === fn) continue;
            if (new RegExp('\\b' + c + '\\b').test(body)) { ok = true; how = 'via ' + c; break; }
          }
        }
      }
      check('K-W1 ' + fn + '() 的 options 含 windowsHide: true', ok,
        body ? (ok ? how : '函数体内未见 windowsHide: true') : '未找到 ' + fn + ' 函数体');
    }
  }
}

// -- K-W2：src 下裸子进程调用点 = 0（spawn + exec 族，条 6 扩展）--
console.log('== K-W2 src 下裸 spawn(/exec*() 调用点 ==');
{
  const offenders = scanBareSpawns();
  check('K-W2 src/** 裸 spawn(/spawnSync(/execFile(/execFileSync(/execSync(/exec( 调用点 = 0',
    offenders.length === 0,
    offenders.length ? (offenders.length + ' 处: ' + offenders.slice(0, 5).join(' | ')) : 'ok');
  // 收编证据：三处异步 execFile 调用点必须走统一封装，否则判据留盲区。
  const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  check('条 6 killTree 的 taskkill 走 exec.runAsync（不再裸 execFile）',
    /ex\.runAsync\('taskkill'/.test(read('src/platform/os/process.js')), '有');
  check('条 6 npx 预取走 exec.runOutAsync（不再裸 execFile）',
    /ex\.runOutAsync\(npxBin\(\)/.test(read('src/domains/router/providers/pkg-cache.js')), '有');
  check('条 6 git fetch 走 exec.runOutAsync（不再裸 execFile）',
    /ex\.runOutAsync\('git'/.test(read('src/app/settings/versions.js')), '有');
}

// -- K-W3：反向 —— 判据必须能识别旧形态 --
console.log('== K-W3 反向（门禁非空转）==');
{
  const legacy = [
    "const { spawn } = require('node:child_process');",
    "function launch() {",
    "  const child = spawn(process.execPath, ['x'], { detached: true, stdio: 'ignore' });",
    "  return child;",
    "}",
  ].join('\n');
  const hits = bareSpawnCallSites(legacy);
  check('K-W3 判据把无 windowsHide 的裸 spawn 判为违规', hits.length === 1,
    hits.length ? ('命中 1 处（line ' + hits[0].line + '）') : '❌ 未命中（门禁空转）');
  check('K-W3 判据不把 child_process 导入行当调用点',
    !hits.some((h) => /child_process/.test(h.text)), 'ok');
  // 正向：经统一封装的调用点（spawnMod.detached 形态）不应被误报
  const wrapped = "const child = spawnMod.detached(cmd, args, { env });";
  check('K-W3 判据不误报经封装的调用', bareSpawnCallSites(wrapped).length === 0, 'ok');
  // exec 族形态逐一命中（旧判据只匹配 spawn( -> 全盲区）。
  const execLegacy = [
    "const child = execFile('git', ['fetch'], { timeout: 10000 }, (err) => {});",
    "const o = execFileSync('git', ['status']);",
    "const p = execSync('git log');",
    "const q = spawnSync('git', ['diff']);",
    "exec('ls');",
  ].join('\n');
  check('K-W3 条 6 判据逐词形命中 execFile/execFileSync/execSync/spawnSync/裸 exec',
    bareSpawnCallSites(execLegacy).length === 5, bareSpawnCallSites(execLegacy).map((h) => h.line).join(','));
  // 反向中的反向：RegExp 属性形态 re.exec( 与封装入口 ex.runOut( 不得误报。
  const notCalls = [
    "const m = /x/.exec(s);",
    "const out = ex.runOut('systemctl', ['status']);",
    "const b = spawnOS.detachedIgnored(bin, args);",
  ].join('\n');
  check('K-W3 条 6 不误报 re.exec( / ex.runOut( / spawnOS.detachedIgnored(',
    bareSpawnCallSites(notCalls).length === 0, 'ok');
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
