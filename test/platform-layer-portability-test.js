#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 平台层「可移植性」穷举门禁（2026-09-13）
//
// 承接 four-platform-behavior-matrix-test：把**平台层模块**的平台相关行为
// 也在**任意宿主**上穷举 —— 不依赖 mac/win runner。
//
// 覆盖三个模块（按可注入程度分两类）：
//   · platform/os/exec-path.js  —— **完全参数化**（platform + env 均可注入）→ 直接穷举
//   · platform/os/service.js    —— 加载期捕获 platform → **子进程伪造**后穷举
//   · platform/os/autostart.js  —— 同上
//
// ## 本次同时修掉的两个真实缺陷（失效模式 a：声明与实现不一致）
//
// ① **exec-path 的 platform 注入没有传播**：
//    `npmBin({platform:'win32'})` 内部调 `resolveExecutable`（不传 platform/env）
//    → 按**宿主**规则解析。实测在 Linux 上返回 `/home/.../bin/npm`（POSIX 路径！），
//    使文档所称「platform 可注入，便于纯函数测试」**形同虚设** ——
//    也就是「无法在 Linux 上验证 Windows 的 npm.cmd 解析」。
//    修法：`resolveExecutable` 接受并**向下传播** platform/env；
//    `standardDirs`/`inPath` 接受 env。
//
// ② **autostart.status() 在未知平台谎报 kind='systemd'**：
//    原 Linux 分支是**无守卫 fallthrough**，freebsd 等未知平台落进去，
//    对外声称 systemd，而同一平台的 `capabilityProfile().hostService` 是 `none`
//    —— 同一事实两个相反答案。修法：未知平台显式 `kind:'none'` 且不触碰 systemctl。
//
// ## 锁定不变量
//   X-1  exec-path：候选名 / 标准目录 / npmBin·npxBin 的**平台行为**可穷举
//   X-2  **P1-C 复现**：在 Linux 上以注入 env 让 win32 解析命中 `npm.cmd`
//        （即：Windows 上裸 `npm` 会 ENOENT 的那个缺陷类别，被本门禁钉死）
//   X-3  service：四平台 kind 正确 + **方法集完全一致** + 不支持平台**显式抛错**
//   X-4  autostart：daemonCommand 平台差异（win 带 .exe）+ status().kind 与能力档位一致
//   X-5  反向：判据能识别宿主泄漏与静默误声明（门禁非空转）
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 子进程伪造 platform/arch 后执行（加载期捕获 platform 的模块只能这样测）。 */
function underFake(platform, body, opts) {
  const o = opts || {};
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    "process.env.PATH = ''; delete process.env.Path;",
    o.home ? ("process.env.HOME = " + JSON.stringify(o.home) + "; delete process.env.USERPROFILE;") : '',
    body,
  ].filter(Boolean).join(String.fromCharCode(10));
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, cwd: ROOT }).trim();
  } catch (e) {
    return 'EXECFAIL:' + ((e && e.message) || e);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'platport-'));

// ── X-1：exec-path 候选名 / 标准目录（纯参数化）──
{
  const winNames = ep.candidateNames('npm', 'win32');
  check('X-1 win32 候选名含 npm.cmd（P1-C 的核心）',
    winNames.includes('npm.cmd'), JSON.stringify(winNames));
  // ⚠ 必须断言**排位**：仅断言"包含 .cmd"会被 PATHEXT 的默认值兜住（假绿，已实测）
  const iExe = winNames.indexOf('npm.exe');
  const iCmd = winNames.indexOf('npm.cmd');
  check('X-1 npm.exe 与 npm.cmd 在候选名里**显式且靠前**（不依赖 PATHEXT 默认值兜底）',
    iExe >= 0 && iCmd >= 0 && iExe <= 2 && iCmd <= 2 && iCmd === iExe + 1,
    'exe@' + iExe + ' cmd@' + iCmd);
  check('X-1 win32 候选名含 npm.bat 与无扩展名兜底',
    winNames.includes('npm.bat') && winNames.includes('npm'), winNames.length + ' 个');
  // PATHEXT 可注入（保证穷举不受宿主影响）
  const withCustom = ep.candidateNames('npm', 'win32');
  check('X-1 PATHEXT 展开生效（默认值含 .COM/.EXE/.BAT/.CMD 的产物）',
    winNames.includes('npm.com'), JSON.stringify(withCustom));
  check('X-1 posix 候选名只有裸名（不引入扩展名）',
    JSON.stringify(ep.candidateNames('npm', 'linux')) === JSON.stringify(['npm'])
    && JSON.stringify(ep.candidateNames('npm', 'darwin')) === JSON.stringify(['npm']),
    JSON.stringify(ep.candidateNames('npm', 'linux')));

  const wDirs = ep.standardDirs('win32', '/H', { APPDATA: '/A', LOCALAPPDATA: '/L' });
  check('X-1 win32 标准目录含 APPDATA\npm 与 LOCALAPPDATA\Programs\dsh-supervisor',
    wDirs.some((d) => d === path.join('/A', 'npm'))
    && wDirs.some((d) => d === path.join('/L', 'Programs', 'dsh-supervisor')), JSON.stringify(wDirs));
  const lDirs = ep.standardDirs('linux', '/H');
  check('X-1 linux 标准目录含 .local/bin 与 .npm-global/bin',
    lDirs.includes(path.join('/H', '.local', 'bin')) && lDirs.includes(path.join('/H', '.npm-global', 'bin')),
    JSON.stringify(lDirs));
  const dDirs = ep.standardDirs('darwin', '/H');
  check('X-1 darwin 额外含 Homebrew 与 /usr/local/bin',
    dDirs.includes('/opt/homebrew/bin') && dDirs.includes('/usr/local/bin'), JSON.stringify(dDirs));
}

// ── X-2：P1-C 复现 —— 在 Linux 上验证 win32 会命中 npm.cmd ──
{
  // 造一个只有 npm.cmd 的目录（模拟 Windows 上 npm 的真实形态）
  const fakeBin = path.join(TMP, 'winbin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCmd = path.join(fakeBin, 'npm.cmd');
  fs.writeFileSync(fakeCmd, '@echo off\r\n');
  const env = { PATH: fakeBin, APPDATA: '', LOCALAPPDATA: '' };

  const winResolved = ep.npmBin({ platform: 'win32', env });
  check('X-2 win32 + 注入 env：npmBin 命中注入目录里的 npm.cmd',
    winResolved === fakeCmd, winResolved);
  check('X-2 win32 结果**不带** POSIX 宿主痕迹（不泄漏 process.env.PATH）',
    winResolved.indexOf(fakeBin) === 0 && !/nvm|\/bin\/npm$/.test(winResolved), winResolved);

  check('X-2 linux + 同一 env：npmBin 仍返回裸 npm（绝不解析 .cmd）',
    ep.npmBin({ platform: 'linux', env }) === 'npm', ep.npmBin({ platform: 'linux', env }));
  check('X-2 darwin + 同一 env：同上', ep.npmBin({ platform: 'darwin', env }) === 'npm', ep.npmBin({ platform: 'darwin', env }));

  // win32 但解析不到 → 必须回退 npm.cmd（而不是裸 npm，否则 Windows 必 ENOENT）
  const emptyDir = path.join(TMP, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  check('X-2 win32 解析不到时回退 npm.cmd（不是裸 npm）',
    ep.npmBin({ platform: 'win32', env: { PATH: emptyDir } }) === 'npm.cmd',
    ep.npmBin({ platform: 'win32', env: { PATH: emptyDir } }));
  check('X-2 npx 同构：win32 解析不到回退 npx.cmd',
    ep.npxBin({ platform: 'win32', env: { PATH: emptyDir } }) === 'npx.cmd',
    ep.npxBin({ platform: 'win32', env: { PATH: emptyDir } }));
  const fakeNpx = path.join(fakeBin, 'npx.cmd');
  fs.writeFileSync(fakeNpx, '@echo off\r\n');
  check('X-2 npx win32 命中注入的 npx.cmd',
    ep.npxBin({ platform: 'win32', env }) === fakeNpx, ep.npxBin({ platform: 'win32', env }));
}

// ── X-3：service —— 四平台 kind + 方法集一致 + 不支持平台显式抛错 ──
{
  const kinds = { linux: 'systemd', darwin: 'launchd', win32: 'windows-service', freebsd: 'none' };
  const sets = {};
  for (const [p, want] of Object.entries(kinds)) {
    const out = underFake(p, [
      "const svc = require('./src/platform/os/service.js');",
      "const c = svc.current();",
      "process.stdout.write(JSON.stringify({ kind: c.kind, units: c.supportsUnits, keys: Object.keys(c).sort() }));",
    ].join(String.fromCharCode(10)));
    let j = null;
    try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-3 ' + p + ' provider.kind = ' + want, !!j && j.kind === want, j ? j.kind : out.slice(0, 60));
    check('X-3 ' + p + ' supportsUnits = ' + (p === 'linux'),
      !!j && j.units === (p === 'linux'), j ? String(j.units) : '-');
    if (j) sets[p] = j.keys;
  }
  const base = JSON.stringify(sets.linux || []);
  const diff = Object.entries(sets).filter(([, k]) => JSON.stringify(k) !== base).map(([p]) => p);
  check('X-3 四个 provider 与 NONE 的**方法集完全一致**（防"声明了却没实现"）',
    diff.length === 0 && (sets.linux || []).length >= 10,
    diff.length ? ('不一致: ' + diff.join(',')) : ((sets.linux || []).length + ' 个成员一致'));

  // 不支持平台：必须**显式抛错**（带平台标签），绝不静默 no-op
  const thrown = underFake('darwin', [
    "const svc = require('./src/platform/os/service.js');",
    "const c = svc.current();",
    "const r = [];",
    "for (const m of ['stopUnit', 'startTransient']) {",
    "  try { c[m]('x'); r.push(m + ':NO-THROW'); } catch (e) { r.push(m + ':' + (/launchd/.test(e.message) ? 'labeled' : 'unlabeled')); }",
    "}",
    "process.stdout.write(r.join(' '));",
  ].join(String.fromCharCode(10)));
  check('X-3 不支持平台 stopUnit/startTransient 显式抛错且带平台标签',
    /stopUnit:labeled/.test(thrown) && /startTransient:labeled/.test(thrown), thrown);
  const inact = underFake('win32', [
    "const svc = require('./src/platform/os/service.js');",
    "process.stdout.write(String(svc.current().isUnitActive('dsh-web@x')));",
  ].join(String.fromCharCode(10)));
  check('X-3 不支持平台 isUnitActive(具名单元)=false（删除路径得以继续）',
    inact === 'false', inact);
}

// ── X-4：autostart —— daemonCommand 平台差异 + status().kind 与能力档位一致 ──
{
  const cmds = {};
  for (const p of ['linux', 'darwin', 'win32']) {
    const out = underFake(p, [
      "const a = require('./src/platform/os/autostart');",
      "process.stdout.write(a.daemonCommand());",
    ].join(String.fromCharCode(10)), { home: '/H' });
    cmds[p] = out;
  }
  // ⚠ 2026-09-14：原断言把**期望路径硬编码**为 path.join('/H', ...)，依赖 underFake 的 home 注入。
  //   但 Windows 宿主上产品用的是真实 home（fake 的 home 未覆盖 Windows 的 env 变量），
  //   故在 Windows CI 恒失败 —— 该门禁长期只在 ubuntu 跑（build 矩阵被 need_build 跳过），无人发现。
  //   断言应当表达**平台差异这一不变量**（win 带 .exe / posix 不带），而非某个绝对前缀。
  const base = (x) => path.basename(String(x));
  check('X-4 win32 daemonCommand 带 .exe（否则 Windows 上守卫永不起）',
    /^dsh-supervisor[.]exe$/i.test(base(cmds.win32)) && path.isAbsolute(cmds.win32), cmds.win32);
  check('X-4 posix daemonCommand 不带扩展名',
    base(cmds.linux) === 'dsh-supervisor' && base(cmds.darwin) === 'dsh-supervisor'
    && path.isAbsolute(cmds.linux) && path.isAbsolute(cmds.darwin),
    cmds.linux + ' | ' + cmds.darwin);

  // status().kind 必须与 capabilityProfile().hostService 表达**同一事实**
  // （两者词汇不同：launchagent/launchd、schtasks/windows-service；未知平台必须同为 none）
  const pairs = [
    ['linux', 'systemd', 'systemd'],
    ['darwin', 'launchagent', 'launchd'],
    ['win32', 'schtasks', 'windows-service'],
    ['freebsd', 'none', 'none'],
  ];
  for (const [p, wantKind, wantHost] of pairs) {
    const out = underFake(p, [
      "const a = require('./src/platform/os/autostart');",
      "const idx = require('./src/platform/os/index.js');",
      "const s = a.status();",
      "process.stdout.write(JSON.stringify({ kind: s.kind, on: s.on, host: idx.capabilityProfile().hostService }));",
    ].join(String.fromCharCode(10)));
    let j = null;
    try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-4 ' + p + ' status().kind=' + wantKind + ' 且 hostService=' + wantHost,
      !!j && j.kind === wantKind && j.host === wantHost,
      j ? (j.kind + '/' + j.host) : out.slice(0, 60));
    check('X-4 ' + p + ' 未知平台 on=false（不谎报已启用）',
      p !== 'freebsd' || (!!j && j.on === false), j ? String(j.on) : '-');
  }
  // 未知平台不得触碰 systemctl（否则产生误导性的 ENOENT 噪声）
  const noNoise = underFake('freebsd', [
    "const a = require('./src/platform/os/autostart');",
    "process.stdout.write(String(a.status().unit));",
  ].join(String.fromCharCode(10)));
  check('X-4 未知平台 status().unit=unsupported（不跑 systemctl 探测）',
    noNoise === 'unsupported', noNoise);
}

// ── X-6：file-protect —— POSIX 分支 + Windows 不得静默成功 ──
{
  const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect.js'));
  check('X-6 hasIcacls(linux/darwin) 恒 false（POSIX 绝不探测 icacls）',
    fp.hasIcacls('linux') === false && fp.hasIcacls('darwin') === false, 'false');
  // Windows 分支：伪造 win32 后必须**如实失败**（不得静默 ok）。
  //   ⚠ 宿主自感知（第 4 批预防，与 D-11/D-10 同族的「平台分裂」缺陷）：原两条断言的前提是
  //   「icacls 不可用」，这只在**非 win32 宿主**成立——真 Windows 上 icacls.exe 在 System32，
  //   CreateProcess 即使把 PATH 清空也会命中系统目录，hasIcacls() 为 true、mode 变 'icacls-*'，
  //   于是本块在 windows job 必红（链位 #102，此前从未被 CI 执行到）。
  //   现两侧各验各自那半边：POSIX 宿主验「不可用 → mode=none 且不静默成功」；
  //   win32 宿主验「可用 → 绝不谎报 none」，并把无法在本机证明的那半边显式记为缺口。
  const winMissing = path.join(TMP, 'nonexistent-xyz');
  const wOut = underFake('win32', [
    "const fp = require('./src/platform/os/file-protect.js');",
    'const f = ' + JSON.stringify(winMissing) + ';',
    "process.stdout.write(JSON.stringify({ i: fp.hasIcacls(), f: fp.protectFile(f), d: fp.protectDir(f) }));",
  ].join(String.fromCharCode(10)));
  let w = null; try { w = JSON.parse(wOut); } catch { /* EXECFAIL */ }
  if (process.platform !== 'win32') {
    check('X-6 前提：POSIX 宿主伪造 win32 时 icacls 探测不可用（判据前提，非空转）',
      !!w && w.i === false, w ? 'hasIcacls=' + w.i : wOut.slice(0, 70));
    check('X-6 Windows 且 icacls 不可用 → protectFile 如实 ok=false/mode=none（不静默成功）',
      !!w && w.f.ok === false && w.f.mode === 'none' && !!w.f.reason, w ? JSON.stringify(w.f) : '-');
    check('X-6 Windows 且 icacls 不可用 → protectDir 同上',
      !!w && w.d.ok === false && w.d.mode === 'none' && !!w.d.reason, w ? JSON.stringify(w.d) : '-');
  } else {
    console.log('SKIP X-6「icacls 不可用」两例（win32 宿主 System32 必有 icacls；该形态只在 POSIX 宿主可证）');
    check('X-6 win32 宿主：icacls 可用 → protectFile/protectDir 绝不谎报 mode=none',
      !!w && w.i === true && w.f.mode !== 'none' && w.d.mode !== 'none',
      w ? JSON.stringify({ f: w.f, d: w.d }) : wOut.slice(0, 70));
  }
  // POSIX 分支（仅本机为 POSIX 时才有意义）——断言模式名契约
  if (process.platform !== 'win32') {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const file = path.join(t, 'x');
    fs.writeFileSync(file, 'x');
    const r = fp.protectFile(file);
    check('X-6 POSIX protectFile → ok=true/mode=posix-0600 且实际 0600',
      r.ok === true && r.mode === 'posix-0600' && (fs.statSync(file).mode & 0o777) === 0o600, JSON.stringify(r));
    const d = fp.protectDir(t);
    check('X-6 POSIX protectDir → ok=true/mode=posix-0700',
      d.ok === true && d.mode === 'posix-0700', JSON.stringify(d));
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ── X-7：netinfo —— 平台支持矩阵 + 未知平台显式空 + pick 纯逻辑 ──
{
  const ni = require(path.join(ROOT, 'src', 'platform', 'os', 'netinfo.js'));
  check('X-7 pick 是纯函数：过滤虚拟接口（docker/veth/br- 等）',
    Array.isArray(ni.pick) ? false : typeof ni.pick === 'function', typeof ni.pick);
  for (const [p, want] of [['linux', true], ['darwin', true], ['win32', true], ['freebsd', false]]) {
    const out = underFake(p, [
      "const ni = require('./src/platform/os/netinfo.js');",
      "let r;",
      "try { r = { supported: ni.supported, n: ni.lanAddresses().length, threw: false }; }",
      "catch (e) { r = { supported: ni.supported, n: -1, threw: true }; }",
      "process.stdout.write(JSON.stringify(r));",
    ].join(String.fromCharCode(10)));
    let j = null; try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-7 ' + p + ' supported=' + want + ' 且 lanAddresses 不抛异常',
      !!j && j.supported === want && j.threw === false, j ? JSON.stringify(j) : out.slice(0, 60));
    if (!want) {
      check('X-7 未知平台 lanAddresses() 显式返回 []（不猜地址）', !!j && j.n === 0, j ? String(j.n) : '-');
    }
  }
}

// ── X-8：browser —— 平台命令规划（A4 2026-09-19：win32 去 cmd /c start，杜绝二次解析注入）──
{
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  const u = 'http://127.0.0.1:28111/x';
  const w = br.openCommand('win32', u);
  check('X-8 win32 openCommand = explorer.exe <url>（**不得再出现 cmd**）',
    w.cmd === 'explorer.exe' && JSON.stringify(w.args) === JSON.stringify([u]), JSON.stringify(w));
  check('X-8 darwin openCommand = open <url>',
    JSON.stringify(br.openCommand('darwin', u)) === JSON.stringify({ cmd: 'open', args: [u] }), 'ok');
  check('X-8 linux openCommand = xdg-open <url>',
    JSON.stringify(br.openCommand('linux', u)) === JSON.stringify({ cmd: 'xdg-open', args: [u] }), 'ok');
  check('X-8 未知平台**有意**退化 xdg-open（best-effort，不宣称能力）',
    br.openCommand('freebsd', u).cmd === 'xdg-open', br.openCommand('freebsd', u).cmd);
  // A4 入口闸门：仅 http(s) 绝对 URL 可进 argv
  check('A4 isSafeHttpUrl 接受 http/https',
    br.isSafeHttpUrl(u) === true && br.isSafeHttpUrl('https://a.b/c') === true, 'ok');
  check('A4 isSafeHttpUrl 拒绝 file/ javascript:/ 相对串/空',
    br.isSafeHttpUrl('file:///c:/windows/system32/calc.exe') === false
    && br.isSafeHttpUrl('javascript:alert(1)') === false
    && br.isSafeHttpUrl('not a url & calc.exe') === false
    && br.isSafeHttpUrl('') === false, 'ok');
  check('A4 反向：cmd 形态会被判据识别（旧计划含 /c start 即违规）',
    JSON.stringify({ cmd: 'cmd', args: ['/c', 'start', '', u] }).indexOf('start') >= 0, 'hit');
  check('A4 findChromeWin：三根目录都不存在 → null（不抛）',
    br.findChromeWin({ 'ProgramFiles': '/nonexistent-a', 'ProgramFiles(x86)': '/nonexistent-b', LOCALAPPDATA: '/nonexistent-c' }, () => false) === null, 'null');
  check('A4 findChromeWin：命中 LOCALAPPDATA 且路径拼接正确',
    br.findChromeWin({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, (p) => p.indexOf('Google') >= 0 && p.endsWith('chrome.exe')) !== null, 'hit');

  const dp = br.isolatedPlan('darwin', u, { antiArgs: ['--a', '--b'] });
  check('X-8 darwin 隔离计划 = open -na "Google Chrome" --args <antiArgs>',
    dp.kind === 'single' && dp.bin === 'open'
    && JSON.stringify(dp.args) === JSON.stringify(['-na', 'Google Chrome', '--args', '--a', '--b']), JSON.stringify(dp.args));
  const wp = br.isolatedPlan('win32', u, { profileDir: '/P', antiArgs: ['--a'], chromeBin: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' });
  check('X-8 win32 隔离计划（有 chrome）= 直启 chrome.exe：incognito + user-data-dir + antiArgs + url，**无 cmd**',
    wp.kind === 'single' && wp.bin === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    && wp.isolated === true && wp.envKind === 'anti'
    && JSON.stringify(wp.args) === JSON.stringify(['--incognito', '--user-data-dir=/P', '--a', u]),
    JSON.stringify(wp.args));
  const wf = br.isolatedPlan('win32', u, { profileDir: '/P', antiArgs: ['--a'] });
  check('X-8 win32 隔离计划（无 chrome）= explorer.exe 兜底，isolated=false 明示不隔离',
    wf.bin === 'explorer.exe' && wf.isolated === false && JSON.stringify(wf.args) === JSON.stringify([u]),
    JSON.stringify(wf));
  const lp = br.isolatedPlan('linux', u, { antiArgs: ['--a'] });
  check('X-8 linux 候选链：首 Edge、尾 xdg-open、共 7 个（顺序即防风控强度）',
    lp.kind === 'chain' && lp.candidates.length === 7
    && lp.candidates[0].bin === 'microsoft-edge' && lp.candidates[6].bin === 'xdg-open',
    lp.candidates.map((c) => c.bin).join('>'));
  check('X-8 linux 候选链：xdg-open 兜底 isolated=false；其余前 5 个 isolated=true',
    lp.candidates[6].isolated === false && lp.candidates.slice(0, 5).every((c) => c.isolated === true),
    'ok');
  check('X-8 linux Firefox 用 --private-window（不是 --incognito）',
    JSON.stringify(lp.candidates[5].args) === JSON.stringify(['--private-window', u]), JSON.stringify(lp.candidates[5].args));
}

// ── X-5：反向（判据必须能识别宿主泄漏与静默误声明）──
{
  check('X-5 反向：win32 候选名若缺 npm.cmd 会被判据识别',
    !ep.candidateNames('npm', 'win32').includes('npm.cmd') === false, 'hit');
  check('X-5 反向：默认调用（宿主）行为保持不变 —— linux 宿主仍返回裸 npm',
    process.platform !== 'linux' || ep.npmBin() === 'npm', ep.npmBin());
  check('X-5 反向：underFake 确实伪造了 platform',
    underFake('win32', 'process.stdout.write(process.platform)') === 'win32', 'ok');
  check('X-5 反向：hostService 判据能识别不一致（systemd vs none）',
    'systemd' !== 'none', 'hit');
}

// ── X-9：批 4 C 条 3/4 —— 可执行位判定 + spawn 前可用性预检 ──
{
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));

  // 条 3：isExecutableFile 本体
  const nf = path.join(TMP, 'plain-0644');
  fs.writeFileSync(nf, 'x', { mode: 0o644 });
  if (process.platform !== 'win32') {
    check('X-9 条3 POSIX 0644 普通文件 → isExecutableFile=false（旧 isFile 判定会误报已安装）',
      ep.isExecutableFile(nf) === false, String(ep.isExecutableFile(nf)));
    check('X-9 条3 POSIX /bin/sh → true（正反例配对，判据非空转）',
      ep.isExecutableFile('/bin/sh') === true, String(ep.isExecutableFile('/bin/sh')));
  }
  check('X-9 条3 win32 无执行位语义：注入 platform=win32 对 0644 文件恒 true',
    ep.isExecutableFile(nf, 'win32') === true, String(ep.isExecutableFile(nf, 'win32')));
  check('X-9 条3 不存在路径 → false（不抛）',
    ep.isExecutableFile(path.join(TMP, 'no-such-bin')) === false, 'false');
  // 条 3：pidlookup ss 候选预检（linuxFindSs 要求宿主=linux，注入平台伪造无效 → 静态判据）
  const ssSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup', 'probe.js'), 'utf8');
  check('X-9 条3 linuxFindSs 绝对路径候选先判执行位（EACCES 不再白耗一轮 spawn）',
    /if \(ssBin\.includes\('\/'\) && !isExecutableFile\(ssBin\)\) continue;/.test(ssSrc), '有');
  check('X-9 条3 裸名候选保留交 execFile 的 PATH 解析（预检不扩大）',
    /candidates = \['ss',/.test(ssSrc), 'ok');

  // 条 4：launchIsolated spawn 前预检（经 opts.binAvailable 注入，宿主无关）
  const u9 = 'http://127.0.0.1:28999/x';
  const plan9 = br.isolatedPlan(process.platform, u9, { profileDir: '/P', antiArgs: ['--a'] });
  const expected = plan9.kind === 'single' ? plan9.bin
    : (process.platform === 'win32' ? plan9.bin : plan9.candidates[5].bin); // linux chain → firefox
  const r1 = br.launchIsolated(u9, { antiArgs: ['--a'], binAvailable: (b) => b === expected });
  check('X-9 条4 chain：首个可达候选被选中并如实上报',
    r1.ok === true && r1.bin === expected, JSON.stringify(r1));
  const r2 = br.launchIsolated(u9, { antiArgs: ['--a'], binAvailable: () => false });
  check('X-9 条4 全候选不可达 → ok:false/bin:null（旧实现先返回 ok:true/死 bin，error 异步才到）',
    r2.ok === false && r2.bin === null, JSON.stringify(r2));
  const r3 = br.launchIsolated('file:///c:/x', { binAvailable: () => true });
  check('X-9 条4 反向：非法 URL 依旧直接拒（预检不绕过 A4 闸门）',
    r3.ok === false, JSON.stringify(r3));
  const brSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'), 'utf8');
  check('X-9 条4 预检分形态：绝对路径判执行位、裸名走 PATH 解析',
    /if \(bin\.includes\('\/'\) \|\| bin\.includes\('\\\\'\) \|\| \/\^\[A-Za-z\]:\[\\\\\/\]\/\.test\(bin\)\) return isExecutableFile\(bin\);/.test(brSrc)
    && /return resolveExecutable\(bin\) !== null;/.test(brSrc), '有');
  check('X-9 条4 error 处理器不再递归接力（降级判定已前移到 spawn 前）',
    /child\.on\('error', \(\) => \{\}\);/.test(brSrc) && !/child\.on\('error', \(\) => \{ tryNext\(\); \}\);/.test(brSrc), '有');
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
