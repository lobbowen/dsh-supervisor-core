#!/usr/bin/env node
'use strict';

// glibc 基座门禁回归（跨平台审计 F1 的防线）
//   背景：glibc 前向兼容 —— 在新基座（如 Ubuntu 24.04 / glibc 2.39）构建的产物
//   无法在旧发行版（Ubuntu 22.04 / glibc 2.35、Debian 12 / 2.36）运行。
//   实测：本项目曾有产物要求 GLIBC_2.39，把最主流的两大 LTS 用户全部排除。
//   本测试确保门禁脚本能识别该情况并正确失败/通过。
//
// ## 覆盖缺口（E-2 制度化登记，AUDIT-2026-09-19 第 4 批）：本门禁绿 ≠ 产物合格。
//   背景：本文件此前只测 check-glibc.sh **脚本自身**，而 build.yml 注释声称「构建后由
//   ci-core.sh 的 glibc 基座门禁步骤校验产物」—— 该步骤在当时根本不存在（文档化门禁 ≠
//   实际执行）。第 4 批把调用点补成真实存在（下方 E-2 静态断言），并如实登记剩余缺口：
//   1. R 系列用**宿主二进制当夹具**（/bin/ls 等）：证明的是脚本会判，不是本仓产物合格。
//      当前 launcher 为纯 JS 形态、dist/ 下无 ELF —— **本仓没有任何产物被这道门禁实际校验过**，
//      它防的是「重新引入原生产物时的回归」。
//   2. 只在 Linux 计分：macOS/Windows 上 R2..R7 全部跳过，仅保留跨平台静态断言（见下方平台守卫）。
//   3. 产线侧是**条件执行**：ci-core.sh 只对 `find dist -type f` 中 ELF 魔数命中的文件调用；
//      产物若落在 dist/ 之外或不再是 ELF，本步就是 0 对象「通过」。无对象时如实打印留痕，
//      但**留痕本身不会让产线红**——「该检的东西没检出来」这一形态无人执法。
//   4. 上限 `2.35` 是字面量：与 build 矩阵基座（ubuntu-22.04）的一致性没有机器校验，
//      改 runner 而不改这里不会红。

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const GATE = path.join(ROOT, 'ci', 'check-glibc.sh');
// 行尾归一化读取器（workflow-parse-test W4 要求：读 workflow 必须经它）
const WF = require(path.join(__dirname, '_workflow.js'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };

function run(args) {
  const r = cp.spawnSync('bash', [GATE].concat(args), { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// 找一个真实的动态链接二进制作为夹具（优先用本机已有的工具）
function pickBinary() {
  const cands = ['/usr/bin/dsh-supervisor-gui', '/bin/ls', '/usr/bin/ls', '/usr/bin/env'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// ── E-2（AUDIT-2026-09-19 第 4 批）：产线调用点必须真实存在（跨平台静态断言）──
//   本门禁此前只测 check-glibc.sh **脚本自身**，而 build.yml 注释声称「构建后由 ci-core.sh 的
//   glibc 基座门禁步骤校验产物」—— 该步骤在当时根本不存在（文档化门禁 ≠ 实际执行）。
//   审计 §E-2 的制度化要求：文字承诺的防线要有机器可验的落点。故在此钉调用点存在，
//   并如实登记**覆盖缺口**：当前 launcher 为纯 JS 形态、Linux 产物无 ELF，
//   ci-core.sh 的 [3.5/5] 步是条件执行（无 ELF 时如实打印「无对象可检」而非假装通过）；
//   即本仓**当前没有任何产物被该门禁实际校验过**，防的是「重新引入原生产物时的回归」。
{
  // 行尾归一化统一经 _workflow.js（Windows 检出可能给 CRLF；由 workflow-parse-test W4 强制）
  const stripped = WF.readNormalized(path.join('release', 'scripts', 'ci-core.sh'))
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  check('E-2 产线调用点存在：ci-core.sh 真调 ci/check-glibc.sh（非注释里的虚构步骤）',
    /ci\/check-glibc\.sh/.test(stripped), /ci\/check-glibc\.sh/.test(stripped) ? '有非注释调用' : '无');
  check('E-2 调用带上限 2.35（与矩阵基座一致）',
    /check-glibc\.sh[^\n]*2\.35/.test(stripped), (stripped.match(/check-glibc\.sh.*/) || [''])[0].trim());
  check('E-2 反向非空转：注释里的虚构步骤名不再出现在 build.yml',
    !/「glibc 基座门禁（Linux）」步骤/.test(WF.readWorkflow('build.yml')), '已清除');
}

// 平台守卫：glibc 是 Linux 特有概念；在 macOS/Windows 上「对真实二进制跑脚本」的断言不适用。
//   ⚠ 但跳过**不等于作废**已执行的断言（上方 E-2 跨平台静态断言）：失败计数照常带出去。
//   跨平台审计纪律：测试必须在三端都能安全运行（而非只在 Linux 通过）。
if (process.platform !== 'linux') {
  const skippedFailed = results.filter((r) => !r);
  console.log('SKIP glibc 二进制断言（仅 Linux 适用；当前 ' + process.platform + '）');
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - skippedFailed.length) + ' passed, ' +
    skippedFailed.length + ' failed （Linux 专属断言已跳过，跨平台静态断言照常计分）');
  process.exit(skippedFailed.length ? 1 : 0);
}

console.log('== glibc 门禁 ==');
check('R1 门禁脚本存在且可执行', fs.existsSync(GATE));

const bin = pickBinary();
check('R2 找到测试用二进制', !!bin, bin || 'none');

if (bin) {
  // 该二进制实际要求的最高 glibc
  const dump = cp.execFileSync('bash', ['-c',
    'objdump -T ' + bin + ' 2>/dev/null | grep -oE "GLIBC_[0-9]+[.][0-9]+" | sed "s/^GLIBC_//" | sort -uV | tail -1'
  ], { encoding: 'utf8' }).trim();
  check('R3 能提取到 glibc 符号', /^[0-9]+[.][0-9]+$/.test(dump), dump);

  // 用「恰好等于实际要求」作为上限 -> 必须通过（证明不误报）
  const ok = run([bin, dump]);
  check('R4 上限=实际要求 -> 通过（不误报）', ok.code === 0, 'exit=' + ok.code);

  // 用「比实际要求低一档」作为上限 -> 必须失败（证明能拦住）
  const parts = dump.split('.');
  const lower = parts[0] + '.' + Math.max(0, parseInt(parts[1], 10) - 1);
  const bad = run([bin, lower]);
  check('R5 上限低于实际要求 -> 失败（能拦住）', bad.code === 1, 'exit=' + bad.code);
  check('R6 失败输出含发行版兼容性说明', /发行版|glibc|基座/.test(bad.out), (bad.out.split('\n')[2] || '').slice(0, 60));
}

// 缺失文件 -> 退出码 2（用法/环境错误，区别于门禁失败 1）
const miss = run(['/nonexistent/binary-xyz']);
check('R7 文件不存在 -> 退出码 2', miss.code === 2, 'exit=' + miss.code);

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);