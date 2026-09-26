#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 门禁清单「完整性」+「分层诚实」门禁
//
// ## 修复的缺陷（失效模式 c：声明了但零调用点 / 门禁存在却不跑）
//
// `test/` 下曾有真实测试因未登记而从未进入 CI（api-contract / native /
// plugin-change-restart 三个即由此发现）。清单已从 scripts.test 的 && 巨链迁到
// test/manifest.js（那条链的尺寸被 Windows cmd 8191 命令行上限钉死，等于禁止新增测试），
// 本门禁改以登记表为唯一事实源执法。
//
// ## 锁定不变量
//   C-a  test/ 下每个 *-test.js 要么在登记表中，要么在下方排除表并写明理由
//   C-b  排除表引用的文件真实存在，且理由同时回答「为什么不能入册」与「谁在跑它」
//   C-c  登记表每条字段合法：tier 取 L1/L2、os 为 all 或 linux,darwin,win32 组合、file 真实存在
//   C-d  登记表顺序即执行顺序，且无重复条目
//   C-e  反向：判据能识别「未登记的测试」（门禁非空转）
//   C-f  scripts.test 必须走 runner（回到硬编码巨链 = 红），且 OS 腿脚本存在
//   C-g  分层不能空心：L1、L2 都非空；L2 必须在 linux/darwin/win32 各有覆盖
//        （旧链靠「全链在四个 runner 各跑一遍」伪装跨平台，实际跑的是平台无关部分）；
//        且每条按宿主收窄的 L2 必须写明收窄机制
//   C-h  依赖真实宿主的判据要写进 why：L2 条目不得标 os=all 却实际只跑 POSIX 命令
//        （静态扫 pkill/pgrep/systemctl/launchctl/taskkill/chmod/od/-proc 等实跑痕迹）
//   C-i  跨平台不得靠注释自律：真调 setGuiAutostart / uninstall 这类碰宿主状态的
//        测试必须在代码里守卫（DSH_SUPERVISOR_HOME 非临时目录即退），只在注释里写
//        「本机别跑」= 红
//   C-j  文档 / workflow 注释 / 登记表头不得把条目数写死（数字只有本门禁打印可信）
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const MANIFEST = require(path.join(__dirname, 'manifest.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 刻意不入册的测试，必须同时回答「为什么」与「谁在跑」。 */
const EXCLUDED = {
  'test/native-test.js': '未入册的真实原因：夹具虽用临时 npmRoot（不碰宿主），但 ops.uninstall 会'
    + '真起 npm 子进程，且用 fs.symlinkSync 造 bin 链接 —— Windows 建符号链接需特权或开发者模式，'
    + '夹具没有按平台分支。当前 CI 不跑它、本机又禁止执行任何测试，因此它**不产生任何验收证据**；'
    + '入册前提：注入假 npm（走 npmBin 注入口）+ bin 夹具按平台分支。',
};

function isTestFile(name) {
  return name.endsWith('-test.js') || MANIFEST.IN_CHAIN_LEGACY.indexOf(name) >= 0;
}

const registered = MANIFEST.ENTRIES.map((e) => e.file);

// -- C-a：每个 *-test.js 要么在册，要么被显式排除 --
{
  const all = fs.readdirSync(path.join(ROOT, 'test')).filter(isTestFile).map((f) => 'test/' + f);
  const orphans = all.filter((f) => registered.indexOf(f) < 0 && !Object.prototype.hasOwnProperty.call(EXCLUDED, f));
  check('C-a 每个 test/*-test.js 都在登记表或排除表中',
    orphans.length === 0, orphans.length ? ('未登记且未排除: ' + orphans.join(', ')) : (all.length + ' 个测试文件全部有归属'));
  check('C-a 在册数 + 排除数 = 测试文件总数',
    registered.filter((f) => all.indexOf(f) >= 0).length + Object.keys(EXCLUDED).length === all.length,
    registered.filter((f) => all.indexOf(f) >= 0).length + ' + ' + Object.keys(EXCLUDED).length + ' = ' + all.length);
}

// -- C-b：排除表不得腐化为死引用 / 空理由 --
{
  const bad = Object.keys(EXCLUDED).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('C-b 排除表引用的文件真实存在', bad.length === 0, bad.length ? bad.join(', ') : Object.keys(EXCLUDED).length + ' 条');
  const thin = Object.entries(EXCLUDED).filter(([, r]) => String(r || '').trim().length < 8);
  check('C-b 每条排除都写了理由（>=8 字）', thin.length === 0, thin.map(([f]) => f).join(', ') || 'ok');
  const noOwner = Object.entries(EXCLUDED).filter(([, r]) => !/(CI|本机|入册|入链|谁在跑|不跑)/.test(String(r)));
  check('C-b 排除理由必须回答「谁在跑它」（防把没人跑伪装成刻意不跑）',
    noOwner.length === 0, noOwner.map(([f]) => f).join(', ') || 'ok');
}

// -- C-c：登记表字段合法性 --
{
  const bad = [];
  for (const e of MANIFEST.ENTRIES) {
    if (!e.file || !/^test\/[\w.\-]+\.js$/.test(e.file)) { bad.push(e.file + '（文件名形态）'); continue; }
    if (!fs.existsSync(path.join(ROOT, e.file))) bad.push(e.file + '（登记表指向不存在的文件）');
    if (['L1', 'L2'].indexOf(e.tier) < 0) bad.push(e.file + '（tier=' + e.tier + '）');
    const set = MANIFEST.osSet(e);
    if (!set.length || set.some((o) => MANIFEST.ALL_OS.indexOf(o) < 0)) bad.push(e.file + '（os=' + e.os + '）');
    if (!e.why || String(e.why).trim().length < 4) bad.push(e.file + '（why 空）');
  }
  check('C-c 登记表每条字段合法（file/tier/os/why）', bad.length === 0, bad.length ? bad.join(', ') : MANIFEST.ENTRIES.length + ' 条');
}

// -- C-d：无重复、顺序即执行顺序 --
{
  const dup = registered.filter((f, i) => registered.indexOf(f) !== i);
  check('C-d 登记表无重复条目', dup.length === 0, dup.length ? [...new Set(dup)].join(', ') : 'ok');
  check('C-d 执行顺序取自登记表（runner 不再自带名单）',
    /MANIFEST\.select/.test(fs.readFileSync(path.join(__dirname, '_runner.js'), 'utf8')), 'ok');
}

// -- C-e：反向（判据必须能识别未登记） --
{
  const fake = ['test/__nonexistent-gate-test.js'];
  check('C-e 反向：能识别未登记的测试',
    fake.filter((f) => registered.indexOf(f) < 0 && !EXCLUDED[f]).length === 1, 'hit');
  check('C-e 反向：在册文件不误报',
    registered.indexOf('test/core-test.js') >= 0 && registered.indexOf('test/smoke.js') >= 0, 'ok');
  check('C-e 反向：isTestFile 不把助手当测试',
    !isTestFile('_runner.js') && !isTestFile('_ports.js') && !isTestFile('mock-target.js') && isTestFile('core-test.js'), 'ok');
  const badTier = [{ file: 'test/x-test.js', tier: 'L9', os: 'plan9', why: 'x' }];
  const detected = badTier.filter((e) => ['L1', 'L2'].indexOf(e.tier) < 0 || e.os === 'plan9').length === 1;
  check('C-e 反向：C-c 能识别坏字段', detected, 'hit');
}

// -- C-f：scripts.test 必须走 runner --
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const test = String(pkg.scripts.test || '');
  check('C-f scripts.test 走 runner（不得回到硬编码 && 巨链）',
    /_runner\.js/.test(test) && test.split('&&').length === 1, test);
  check('C-f scripts.test 长度远低于命令行上限（清单化后不应再增长）',
    test.length < 200, test.length + ' 字符');
  const osLeg = String((pkg.scripts || {})['test:os-behavior'] || '');
  check('C-f 存在按宿主的 OS 行为腿脚本', /_runner\.js/.test(osLeg) && /--tier=L2/.test(osLeg), osLeg || '缺失');
}

// -- C-g：分层不得空心（跨平台覆盖的真实台账） --
{
  const l1 = MANIFEST.select('L1', 'linux');
  const perOs = {};
  for (const p of MANIFEST.ALL_OS) perOs[p] = MANIFEST.select('L2', p);
  check('C-g L1（平台无关）非空', l1.length > 0, l1.length + ' 条');
  for (const p of MANIFEST.ALL_OS) {
    check('C-g L2 在 ' + p + ' 上有真实覆盖', perOs[p].length >= 5,
      perOs[p].length + ' 条 / 缺口 ' + MANIFEST.gaps(p).length + ' 条');
  }
  // 收窄理由必须落到「哪一处宿主机制」——否则 os 列就成了拍脑袋的黑盒，
  //   而读者无从判断该缺口是真平台限制、还是当年没人敢跑（本仓病灶正是后者）。
  const POSIX_MECHANISM = /pkill|pgrep|killall|systemctl|launchctl|bash|sh |\/proc|chmod|SIGTERM|0700|POSIX|glibc|elf|node -e|symlink/i;
  const thinNarrow = MANIFEST.ENTRIES.filter((e) => e.tier === 'L2' && e.os !== 'all')
    .filter((e) => !POSIX_MECHANISM.test(String(e.why)));
  check('C-g 每条按宿主收窄的 L2 都写明收窄机制（缺口可归因，不写「平台无关」这类空话）',
    thinNarrow.length === 0,
    thinNarrow.length ? thinNarrow.map((e) => e.file + '(' + e.why + ')').join(', ')
      : MANIFEST.ENTRIES.filter((e) => e.tier === 'L2' && e.os !== 'all').length + ' 条收窄项均有理由');
}

// -- C-h：L2 的 os 标注须与实跑命令一致 --
{
  const REAL_CALL = /\b(pkill|pgrep|systemctl|launchctl|taskkill|chmod|plutil|od -An)\b|\/proc\//;
  const bad = [];
  for (const e of MANIFEST.ENTRIES) {
    if (e.tier !== 'L2' || e.os !== 'all') continue;
    if (!fs.existsSync(path.join(ROOT, e.file))) continue;
    const lines = fs.readFileSync(path.join(ROOT, e.file), 'utf8').split('\n');
    // 豁免只认**代码里的平台分支**（注释里提一句 win32 不算）——否则一条注释就能把造假洗白。
    const code = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const verdictHits = [];
    lines.forEach((l, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(l) || !REAL_CALL.test(l)) return;
      // try/catch 兜住的只是「尽力清理」（win32 上静默失败，不影响判定），不算宿主依赖；
      //   判定输入（取值/断言/参与比较）才证明该文件真的依赖 POSIX 宿主。
      const win = lines.slice(Math.max(0, i - 4), i + 4).join('\n');
      if (/\btry\s*{/.test(win) && /catch/.test(win)) return;
      if (/check\(|===|!==|indexOf|status|\bassert/.test(l)) verdictHits.push(l.trim().slice(0, 60));
    });
    if (verdictHits.length && !/win32/.test(code)) {
      bad.push(e.file + '（POSIX 命令进判定却标 os=all：' + verdictHits[0] + '）');
    }
  }
  check('C-h L2 标 os=all 却把 POSIX 命令喂进判定 = 分层造假', bad.length === 0, bad.length ? bad.join(', ') : 'ok');
  check('C-h 反向：判定式 POSIX 调用会被判出、try/catch 清理不会、注释里的 win32 不能洗白',
    /check\(/.test("check('x', execSync('systemctl is-active dsh'))") && !/\btry\s*{/.test("check('x', execSync('systemctl is-active dsh'))")
    && /^\s*\/\//.test('// win32 上没问题') && !/^\s*\/\//.test("check('x', 1)"), 'hit');
}

// -- C-i：跨平台安全不得靠注释自律 --
{
  const HOSTILE = /setGuiAutostart\(|\.uninstall\(|launchctl|bootstrap gui\//;
  const GUARD = /requireHostSandbox|_sandbox-guard|DSH_SUPERVISOR_HOME|process\.env\.CI|tmpdir\(|mkdtemp/;
  const bad = [];
  for (const e of MANIFEST.ENTRIES) {
    if (!fs.existsSync(path.join(ROOT, e.file))) continue;
    const src = fs.readFileSync(path.join(ROOT, e.file), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (HOSTILE.test(code) && !GUARD.test(code)) bad.push(e.file);
  }
  check('C-i 碰宿主状态的测试必须在代码里守卫（注释里写「本机别跑」不算）',
    bad.length === 0, bad.length ? bad.join(', ') : 'ok');
  check('C-i 反向：无守卫样本会被判红',
    HOSTILE.test('autostart.setGuiAutostart(false, pl);') && !GUARD.test('autostart.setGuiAutostart(false, pl);'), 'hit');
}

// -- C-j：条目数不得被文档/CI 注释/登记表头写死 --
//   条数随每次登记变化，复制出去的字面数字没人回头改（长期停在过期值）。
//   真实条数由本门禁 C-c/C-g 每次实跑打印，故文档只描述机制、不复制数字。
{
  const RE = /链[^。\n]{0,24}[0-9]{2,4}\s*个\s*(?:测试)?文件/;
  const targets = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md') && f !== 'CHANGELOG.md')
    .concat(fs.readdirSync(path.join(ROOT, '.github', 'workflows')).map((f) => path.posix.join('.github/workflows', f)))
    .concat(['test/manifest.js']);
  const hardcoded = [];
  for (const rel of targets) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n').split('\n')
      .forEach((l, i) => { if (RE.test(l)) hardcoded.push(rel + ':' + (i + 1)); });
  }
  check('C-j 文档/workflow 注释/登记表头不把链条目数写死（数字归本门禁打印）',
    hardcoded.length === 0, hardcoded.join(', ') || targets.length + ' 个文件零命中');
  check('C-j 反向：写死条数的合成样本被抓到',
    RE.test('  4. `npm test` 链是 `&&` 串接的 129 个文件，首个红点即截断'), 'hit');
  check('C-j 反向：只描述机制的句子不误报',
    !RE.test('链由 test/manifest.js 登记，条数由 C-c 打印'), 'miss');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
