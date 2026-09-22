#!/usr/bin/env node
'use strict';

// 安装包冒烟门禁：锁定 release/scripts/install-smoke-core.sh 与 build.yml 两处接线。
//
// 背景（缺失的验证）：四平台「安装包冒烟」长期只是声明、没有 CI 真正去装产物 ——
//   test/smoke.js 从源码树跑，从未证明「npm 打包 + bin shim + 依赖自足」这条安装后才成立的链路。
//   本门禁把该冒烟**在 CI 里的存在与判据形状**锁死，防止它再次悄悄退化成不执行。
//
// 锁定不变量：
//   G1 脚本存在且 bash 形态（shebang + set -euo pipefail）
//   G2 build.yml 引用脚本；build job 内的冒烟步在所有触发下都跑（无 tag-only if、无 continue-on-error）
//   G3 published-smoke job 存在、needs 到 release（不抢发布）、tag 成功或 dispatch、从公开 registry 装（@dsh-sup/dsh-core-…@ver）而非 dist/
//   G4 脚本含真判据：--version 相等 / self-check: OK / healthz 轮询 / supervisor-api 唯一记录 / 卸载 trap / daemon 用装出来的命令
//   G5 真判据所在行不得用 || true 兜空
//   每条判据配反向样本：坏夹具必须让判据返回 false（证明判据有牙、非恒真）。

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

// 工作流经 _workflow.js 读取（行尾归一化），禁止裸 fs.readFileSync 读 .github/workflows（W4）。
const { readWorkflow, stripComments, jobSection } = require(path.join(__dirname, '_workflow.js'));

const SCRIPT_REL = path.join('release', 'scripts', 'install-smoke-core.sh');
const scriptExists = fs.existsSync(path.join(ROOT, SCRIPT_REL));
const script = scriptExists ? fs.readFileSync(path.join(ROOT, SCRIPT_REL), 'utf8') : '';
const scriptCode = script.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// -- 判据函数（纯字符串判定，可对反向样本复用）--
const isBash = (t) => /#!\/usr\/bin\/env bash/.test(t) && /set -euo pipefail/.test(t);
const judges = {
  version: (t) => /\*"\$VER"\*/.test(t) && /fail "--version/.test(t),
  selfcheckOk: (t) => /\*"self-check: OK"\*/.test(t) && /self-check 未打印/.test(t),
  guardVersionEq: (t) => /guardVersion=\$GV ≠ --ver/.test(t) && /GV="\$\(printf/.test(t),
  healthzPoll: (t) => /probe_healthz/.test(t) && /\/healthz 未 2xx/.test(t),
  singleApi: (t) => /\[ "\$CNT" != "1" \]/.test(t) && /supervisor-api 登记应为唯一/.test(t),
  cleanupTrap: (t) => /trap cleanup/.test(t) && /npm rm -g/.test(t),
  daemonInstalled: (t) => /dsh_run daemon/.test(t),
  // 守卫配置的 command / healthUrl 属业务键，平台默认值里没有；漏写就是 daemon 起不来。
  // 夹具取仓内唯一那一份 mock-target.js，路径经 argv 传入（Windows 转换后的路径含反斜杠）。
  configBusinessKeys: (t) => /command:\["node",mock/.test(t) && /healthUrl:"http:\/\/127\.0\.0\.1:"/.test(t)
    && /test\/mock-target\.js/.test(t) && /cygpath/.test(t),
};

// -- G1 脚本本体 --
console.log('== G1 脚本存在且 bash 形态 ==');
check('G1-a install-smoke-core.sh 存在', scriptExists, SCRIPT_REL);
check('G1-b bash 形态（shebang + set -euo pipefail）', isBash(script), 'ok');
check('G1-c 反向：非 bash 形态被判 false', !isBash('#!/bin/sh\necho hi'), 'hit');

// -- G2 build.yml 引用 + build job 步骤在所有触发下跑 --
console.log('== G2 build.yml 接线 ==');
{
  const y = readWorkflow('build.yml');
  check('G2-a build.yml 引用冒烟脚本', /install-smoke-core\.sh/.test(stripComments(y)), 'ok');
  const buildSec = jobSection(y, 'build');
  check('G2-b build job 含冒烟步', /install-smoke-core\.sh/.test(buildSec), 'ok');
  // 按 `      - ` 切步：找到调用脚本的那一步，断言它不带 step 级 if（8 空格属性缩进，
  //   区别于 run 块内 10 空格的 bash `if`）也不带 continue-on-error。
  const smokeStep = buildSec.split('\n      - ').find((blk) => /install-smoke-core\.sh/.test(blk)) || '';
  check('G2-c 冒烟步无 step 级 if（push/PR/tag 都跑）', smokeStep !== '' && !/^ {8}if:/m.test(smokeStep), 'ok');
  check('G2-d 冒烟步不得 continue-on-error', !/continue-on-error:\s*true/.test(smokeStep), 'ok');
  // 反向：被 tag-only if 门控 / continue-on-error 的坏步骤必须判 false。
  const badIf = 'name: smoke\n        if: startsWith(github.ref, \'refs/tags/v\')\n        run: bash install-smoke-core.sh';
  check('G2-e 反向：识别被 if 门控的坏步骤', /^ {8}if:/m.test(badIf), 'hit');
  check('G2-f 反向：识别 continue-on-error 坏步骤', !/continue-on-error:\s*true/.test(smokeStep) && /continue-on-error:\s*true/.test('x\n        continue-on-error: true\n'), 'hit');
}

// -- G3 published-smoke job --
console.log('== G3 published-smoke job ==');
{
  const y = readWorkflow('build.yml');
  const sec = jobSection(y, 'published-smoke');
  check('G3-a published-smoke job 可被 jobSection 取到（job 名可解析）', sec.length > 0, sec.length + ' 字符');
  check('G3-b 依赖 build', /needs:\s*\[[^\]]*\bbuild\b[^\]]*\]/.test(sec), 'ok');
  check('G3-c 仅 tag 或 workflow_dispatch 触发',
    /startsWith\(github\.ref,\s*'refs\/tags\/v'\)/.test(sec) && /workflow_dispatch/.test(sec), 'ok');
  check('G3-d 从 registry 装（@dsh-sup/dsh-core- + 版本），不读 dist/',
    /@dsh-sup\/dsh-core-/.test(sec) && !/dist\//.test(sec), 'ok');
  check('G3-e 冒烟公开包不挂载 NPM_TOKEN', !/NPM_TOKEN/.test(sec), 'ok');
  check('G3-f 重试有延迟且只有末轮决定判据（break 于成功、末轮失败才 exit）',
    /sleep/.test(sec) && /break/.test(sec) && /exit "\$rc"/.test(sec), 'ok');
  // G3-i/G3-j：发布后半必须等**同一 run 的发布动作**完成。npm 发布在 release job 里，
  //   只 needs build 会抢先起跑（线上已发好、冒烟却因 404 耗尽预算判红）；
  //   而少了 always()，非 tag 运行里 release=skipped 会把本 job 连带跳过（假绿，比红更坏）。
  check('G3-i 依赖 release（发布后冒烟不得与发布动作赛跑）',
    /needs:\s*\[[^\]]*\brelease\b[^\]]*\]/.test(sec), (sec.match(/needs:.*/) || ['(无 needs)'])[0]);
  check('G3-j if 要求发布真成功 + always() 保住 dispatch 补跑通道',
    /always\(\)/.test(sec) && /needs\.release\.result\s*==\s*'success'/.test(sec),
    (sec.match(/^ {4}if:.*$/m) || ['(无 if)'])[0]);
  // 反向：从本地 dist/ 装、或缺 registry 前缀、或 tag-only（漏 dispatch）都要判 false。
  check('G3-g 反向：识别「从 dist/ 装」的坏样本',
    !(/@dsh-sup\/dsh-core-/.test('x dist/npm/y') && !/dist\//.test('x dist/npm/y')), 'hit');
  check('G3-h 反向：识别「tag-only、漏 dispatch」的坏 if',
    !(/startsWith\(github\.ref,\s*'refs\/tags\/v'\)/.test("if: startsWith(github.ref, 'refs/tags/v')") && /workflow_dispatch/.test("if: startsWith(github.ref, 'refs/tags/v')")), 'hit');
  {
    const race = "  needs: [precheck, build]\n    if: startsWith(github.ref, 'refs/tags/v') || github.event_name == 'workflow_dispatch'";
    check('G3-k 反向：识别「抢先于发布」的坏 needs 与漏 always() 的坏 if',
      !/needs:\s*\[[^\]]*\brelease\b[^\]]*\]/.test(race) && !/always\(\)/.test(race), 'hit');
  }
}

// -- G4 真判据存在 --
console.log('== G4 脚本含真判据 ==');
for (const [k, fn] of Object.entries(judges)) {
  check('G4-' + k + ' 判据存在', fn(scriptCode), 'ok');
}
// 反向：每条判据的坏夹具（删掉关键判据）必须返回 false，证明判据非恒真。
console.log('== G4 反向：坏夹具让判据返回 false ==');
{
  const rev = {
    version: 'dsh_run --version  # 只跑不判',
    selfcheckOk: 'dsh_run self-check',
    guardVersionEq: 'GV="x"',
    healthzPoll: 'curl http://127.0.0.1:1/healthz',
    singleApi: 'cat ports.json',
    cleanupTrap: 'npm i -g "$PKG"',
    daemonInstalled: 'node src/supervisor.js',
    configBusinessKeys: "printf '{\"apiPort\":%d}\\n' \"$CONFIG_PORT\" > \"$SMOKE_HOME/supervisor/config.json\"",
  };
  const bad = Object.entries(rev).filter(([k, s]) => judges[k](s));
  check('G4-rev 每条坏夹具都不被误判为通过', bad.length === 0, bad.map((x) => x[0]).join(', ') || '全部判 false');
}

// -- G5 真判据行不得 || true 兜空 --
console.log('== G5 判据行无 || true 逃生 ==');
{
  const keyLines = scriptCode.split('\n').filter((l) =>
    /--version 输出未含|self-check 未打印|guardVersion=\$GV|\/healthz 未 2xx|supervisor-api 登记应为唯一|提前退出/.test(l));
  const escaped = keyLines.filter((l) => /\|\|\s*true/.test(l));
  check('G5-a 判据行存在（非空转）', keyLines.length >= 4, keyLines.length + ' 行');
  check('G5-b 判据行不含 || true 逃生', escaped.length === 0, escaped.join(' | ') || 'ok');
  // 反向：把判据行加 || true 的坏样本必须被检出为「有逃生」。
  const badEscape = 'fail "--version 输出未含版本" || true';
  check('G5-c 反向：识别判据行上的 || true', /\|\|\s*true/.test(badEscape), 'hit');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
