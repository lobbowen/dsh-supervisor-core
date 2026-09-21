#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 跨平台架构契约门禁
//
// ## 这份门禁解决的问题
//
// 明确要求：「后续开发不会再因为内部业务逻辑开发而影响跨平台构建能力」。
//
// 反例（本仓真实发生过）：业务域里顺手写一个 `process.platform !== 'win32'`
// 或一张 os 映射表 -> 平台知识散落到 4 个业务域（见 platform-matrix-single-source-test
// 的缺陷说明）-> 那些分支**在非本平台上不会被校验**，且与平台层能力声明脱钩。
//
// ## 契约条款
//
//   CP-1  `process.platform` / `process.arch` / `os.platform()` / `os.arch()`
//         **只允许出现在 `src/platform/**`**（平台知识的唯一合法位置）。
//         业务域必须经 `src/platform/contract/matrix.js` 或平台层能力取平台事实。
//   CP-2  业务域不得出现 os/arch 映射对象字面量（与 M-c 呼应，此处再锁一层）
//   CP-3  平台实现必须覆盖全部受支持平台（linux/darwin/win32 三份实现文件都在）
//   CP-4  `package.json#engines.node` 必须存在（跨平台运行时下限的单一声明）
//   CP-5  `src/domains/router/**` 零 `process.kill(`：反代隔离层（PROXY-ISOLATION-STANDARD
//         L1）的终止/存活语义唯一经 `platform/os/carrier` 与 `os/process`。
//         根因锁定：域内裸 kill(-pid) 在 win32 无组语义（只杀 .cmd 壳留占端口子孙，B13 同型）、
//         sameProcessGroup 在 macOS 恒 false（自家监听者误判外部 -> 孤儿）。
//   CP-6  `src/domains/**` 零 `/proc/` 字面（进程事实经 os/pidlookup 门面，三端语义齐）。
//   CP-7  负 pid 组信号 `process.kill(-` 只允许 `src/platform/os/process.js`（POSIX 组信号
//         的唯一收口；ownGroup 前提由该层注释纪律约束）。
//   CP-8  `src/domains/**` 零 `.cmd/.bat` 执行字面与零 `_npx` 缓存路径字面：垫片形态与
//         npm 缓存目录是平台事实（npx-forms#npxLauncher/npxCacheDir、exec-path#npxBin），win32 无
//         shell spawn .cmd 必 EINVAL（CVE-2024-27980），POSIX 形 `_npx` 路径在 win 恒未命中。
//   CP-9  标准正文同步锁：CP-5..CP-8 条款出自 PROXY-ISOLATION-STANDARD.md（本门禁真读正文，
//          standards-uniqueness U-1b 的 reads:true 以此为准），条款编号与 L0/L1/L2 职责缺一即红。
//
// 每条都有**反向断言**（判据必须能识别违规形态，否则门禁空转）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 去掉整行注释——本仓多次被自己的说明文字骗过。
 *  统一走 test/_strip.js（阶段六）：语义等价且**字符串/正则感知**；并只丢「整行都是注释」的行，
 *  故『块开符 + 注释 + 代码』这类开头的代码行不再被整行丢掉（原实现会丢代码）。 */
const { dropCommentLines } = require('./_strip');
function stripComments(src) { return dropCommentLines(src); }
{
  const G = 'src/' + String.fromCharCode(42, 42);
  check('S-4 剥离：// 行注释里的 glob 不吞后续代码',
    stripComments('// ' + G + '\nconst K = 1;').indexOf('K = 1') >= 0, 'ok');
  check('S-4 剥离：块注释开头的代码行不再被整行丢掉',
    stripComments('/* c */ const K = 2;').indexOf('K = 2') >= 0, 'ok');
}

function collectJs(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

const PLATFORM_RE = /\bprocess\.(platform|arch)\b|\bos\.(platform|arch)\s*\(/;

// -- CP-1：平台事实只允许在 src/platform/** --
{
  const files = collectJs(path.join(ROOT, 'src'));
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel.startsWith('src/platform/')) continue;           // 唯一合法区域
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    if (PLATFORM_RE.test(code)) {
      const hits = code.split(String.fromCharCode(10))
        .map((l, i) => ({ l, i }))
        .filter((x) => PLATFORM_RE.test(x.l))
        .map((x) => (x.i + 1) + ':' + x.l.trim().slice(0, 50));
      offenders.push(rel + '  [' + hits.slice(0, 3).join(' | ') + ']');
    }
  }
  check('CP-1 平台事实（process.platform/arch、os.platform/arch）只在 src/platform/** 出现',
    offenders.length === 0,
    offenders.length ? offenders.join(String.fromCharCode(10) + '        ') : '未发现越界');
}

// -- CP-2：业务域不得持 os/arch 映射表 --
{
  const files = collectJs(path.join(ROOT, 'src'));
  const mapRe = /\{\s*(?:win32|darwin|linux)\s*:\s*['"](?:win|darwin|linux)['"]/;
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (rel === 'src/platform/contract/matrix.js') continue;   // 唯一合法位置
    if (mapRe.test(stripComments(fs.readFileSync(f, 'utf8')))) offenders.push(rel);
  }
  check('CP-2 业务域无 os/arch 映射对象字面量（映射表只在 platform/contract/matrix.js）',
    offenders.length === 0, offenders.length ? offenders.join(', ') : '未发现');
}

// -- CP-3：平台层结构齐备（新增平台必须同步加分支，否则平台层会缺档位）--
//
//    内核是 JS：平台分派在 src/platform/os/index.js（capabilityProfile 的 if/else 档位）
//     + src/platform/contract/matrix.js（矩阵与标签）。壳仓才是 Rust 的 #[cfg(target_os)]。
{
  const osDir = path.join(ROOT, 'src', 'platform', 'os');
  const needFiles = ['index.js', 'service.js', 'autostart/index.js', 'desktop.js', 'pidlookup/index.js', 'exec-path.js'];
  const missing = needFiles.filter((n) => !fs.existsSync(path.join(osDir, n)));
  check('CP-3 平台层文件齐备（index/service/autostart/desktop/pidlookup/exec-path）',
    missing.length === 0, missing.length ? ('缺 ' + missing.join(', ')) : needFiles.length + ' 个');

  const disp = fs.readFileSync(path.join(osDir, 'index.js'), 'utf8');
  // capabilityProfile 必须对三个平台**显式**给出档位（不是"能跑就算支持"）
  const branches = ['linux', 'darwin', 'win32'].filter(
    (p) => new RegExp("pl === '" + p + "'").test(disp));
  check('CP-3 capabilityProfile 对三平台各有显式档位',
    branches.length === 3, branches.join(', ') + '（应 3 个）');
  // 而矩阵必须与这些档位同集合
  const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));
  const matrixPlats = [...new Set(matrix.SUPPORTED.map((x) => x.platform))].sort();
  check('CP-3 矩阵平台集合 = capabilityProfile 档位集合',
    JSON.stringify(matrixPlats) === JSON.stringify(['darwin', 'linux', 'win32']),
    matrixPlats.join(', '));
}

// -- CP-4：Node 运行时下限单一声明 --
{
  const pkg = require(path.join(ROOT, 'package.json'));
  check('CP-4 package.json#engines.node 已声明（跨平台运行时下限单源）',
    !!(pkg.engines && pkg.engines.node), (pkg.engines && pkg.engines.node) || '(缺)');
}

// -- CP-5..CP-8：反代隔离层进程纪律（PROXY-ISOLATION-STANDARD 的机器牙齿）--
//   共同范式（继承门禁三教训）：判据抽纯函数 scan()，真实扫描与反向合成样本共用同一把尺；
//   反向样本必须真的命中，防「此刻恰好为零」的空转门禁。
const DOMAIN_FILES = collectJs(path.join(ROOT, 'src', 'domains'));
function scan(files, re, exclude) {
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (exclude && exclude.some((p) => rel.startsWith(p) || rel === p)) continue;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const hit = code.split(String.fromCharCode(10)).findIndex((l) => re.test(l));
    if (hit >= 0) offenders.push(rel + ':' + (hit + 1));
  }
  return offenders;
}
const ALL_SRC = collectJs(path.join(ROOT, 'src'));
{
  const ROUTER = DOMAIN_FILES.filter((f) => path.relative(ROOT, f).replace(/\\/g, '/').startsWith('src/domains/router/'));
  const off = scan(ROUTER, /\bprocess\.kill\s*\(/);
  check('CP-5 反代域零 process.kill（终止/存活唯一经 carrier 与 os/process）',
    off.length === 0, off.length ? off.join(', ') : '0 处');
  check('CP-5 反向：合成旧形状 process.kill(-pid, …) 被同一判据抓到',
    /\bprocess\.kill\s*\(/.test("try { process.kill(-pid, 'SIGTERM'); } catch {}"), 'hit');

  const off6 = scan(DOMAIN_FILES, /['"`]\/proc\//);
  check('CP-6 业务域零 /proc 字面（进程事实经 os/pidlookup）',
    off6.length === 0, off6.length ? off6.join(', ') : '0 处');
  check('CP-6 反向：合成 readFileSync(\'/proc/…\') 被抓到',
    /['"`]\/proc\//.test("const st = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');"), 'hit');

  const off7 = scan(ALL_SRC, /\bprocess\.kill\s*\(\s*-/).filter((o) => !o.startsWith('src/platform/os/process.js:'));
  check('CP-7 负 pid 组信号只允许 platform/os/process.js（POSIX 组语义唯一收口）',
    off7.length === 0, off7.length ? off7.join(', ') : '0 处（平台层收口外）');
  check('CP-7 反向：合成 kill(-pid) 旧形状被抓到、正 pid 单杀不误报',
    /\bprocess\.kill\s*\(\s*-/.test("try { process.kill(-pid, 'SIGKILL'); } catch {}")
      && !/\bprocess\.kill\s*\(\s*-/.test("process.kill(pid, 'SIGTERM');"), 'hit');

  const off8 = scan(DOMAIN_FILES, /['"`][^'"`]*\.(cmd|bat)['"`]|['"`]_npx['"`]|, '_npx'/);
  check('CP-8 业务域零 .cmd/.bat 执行字面、零 _npx 缓存路径字面（npx-forms 唯一解析口）',
    off8.length === 0, off8.length ? off8.join(', ') : '0 处');
  check('CP-8 反向：合成 npx.cmd 直调与 ~/.npm/_npx 拼接被抓到',
    /['"`][^'"`]*\.(cmd|bat)['"`]/.test("spawn('npx.cmd', args)")
      && /['"`]_npx['"`]/.test("path.join(home, '.npm', '_npx')"), 'hit');
}

// -- CP-9：标准正文同步锁（reads:true 的事实依据：本门禁真读 PROXY-ISOLATION-STANDARD.md 正文）--
{
  const std = fs.readFileSync(path.join(ROOT, 'PROXY-ISOLATION-STANDARD.md'), 'utf8');
  const missing = [];
  for (const layer of ['L0', 'L1', 'L2']) if (!new RegExp('\\b' + layer + '\\b').test(std)) missing.push('职责层 ' + layer);
  for (const clause of ['CP-5', 'CP-6', 'CP-7', 'CP-8']) if (!std.includes(clause)) missing.push('条款 ' + clause);
  if (!std.includes('唯一事实源')) missing.push('唯一事实源声明');
  check('CP-9 标准正文含 L0/L1/L2 三层职责与 CP-5..8 条款编号（牙齿与规范同源，防漂移）',
    missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : 'ok');
  check('CP-9 反向：合成缺 L2/缺条款编号的正文被同一判据抓到',
    !/\bL2\b/.test('L0 平台事实 CP-5') && !/CP-8/.test('L0 L1 CP-5 CP-6 CP-7'), 'hit');
}

// -- 反向断言：判据必须能识别违规形态（否则门禁空转）--
{
  check('反向：判据能识别业务域里的 process.platform',
    PLATFORM_RE.test("if (process.platform !== 'win32') { x(); }"), 'hit');
  check('反向：判据能识别 os.platform()',
    PLATFORM_RE.test("const p = os.platform();"), 'hit');
  check('反向：判据对平台层安全代码不误报（仍需 CP-1 的位置判定）',
    PLATFORM_RE.test("const p = process.platform;") === true, 'ok（位置由 CP-1 判）');
  check('反向：判据不误报普通代码',
    !PLATFORM_RE.test("const x = { platform: 'linux' }; const y = f.arch;"), 'ok');
  check('反向：stripComments 会剥离说明文字（本仓踩过 13 次）',
    !PLATFORM_RE.test(stripComments("// 不要写 process.platform\nconst a = 1;")), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
