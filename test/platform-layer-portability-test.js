#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 平台层「可移植性」穷举门禁
//
// 承接 four-platform-behavior-matrix-test：把**平台层模块**的平台相关行为
// 也在**任意宿主**上穷举 —— 不依赖 mac/win runner。
//
// 覆盖三个模块（按可注入程度分两类）：
//   - platform/os/exec-path.js  —— **完全参数化**（platform + env 均可注入）-> 直接穷举
//   - platform/os/service.js    —— 加载期捕获 platform -> **子进程伪造**后穷举
//   - platform/os/autostart.js  —— 同上
//
// ## 本次同时修掉的两个真实缺陷（失效模式 a：声明与实现不一致）
//
// 1) **exec-path 的 platform 注入没有传播**：
//    `npmBin({platform:'win32'})` 内部调 `resolveExecutable`（不传 platform/env）
//    -> 按**宿主**规则解析。实测在 Linux 上返回 `/home/.../bin/npm`（POSIX 路径！），
//    使文档所称「platform 可注入，便于纯函数测试」**形同虚设** ——
//    也就是「无法在 Linux 上验证 Windows 的 npm.cmd 解析」。
//    修法：`resolveExecutable` 接受并**向下传播** platform/env；
//    `standardDirs`/`inPath` 接受 env。
//
// 2) **autostart.status() 在未知平台谎报 kind='systemd'**：
//    原 Linux 分支是**无守卫 fallthrough**，freebsd 等未知平台落进去，
//    对外声称 systemd，而同一平台的 `capabilityProfile().hostService` 是 `none`
//    —— 同一事实两个相反答案。修法：未知平台显式 `kind:'none'` 且不触碰 systemctl。
//
// ## 锁定不变量
//   X-1  exec-path：候选名 / 标准目录 / npmBin-npxBin 的**平台行为**可穷举
//   X-2  **P1-C 复现**：在 Linux 上以注入 env 让 win32 解析命中 `npm.cmd`
//        （即：Windows 上裸 `npm` 会 ENOENT 的那个缺陷类别，被本门禁钉死）
//   X-3  service：W3 分派（linux 实测 systemd/portable、darwin/win32 portable、未知 none）
//        + 三 Provider **方法集完全一致**（含 setLimits）+ 未知平台**显式抛错**
//   X-3b portable provider 纯逻辑：锚点归属/ownGroup 宽严/isUnitActive 三态/stopUnit 幂等
//   X-4  autostart：daemonCommand 平台差异（win 带 .exe）+ status().kind 与能力档位一致
//   X-5  反向：判据能识别宿主泄漏与静默误声明（门禁非空转）
//   X-8  外部打开底座的分工：调度器形态（win32 无可信调度器）、探测层多源并集与留痕、
//        环境表单（本机实况的收敛处）与分发依据（偏好 > 系统默认 > 唯一候选 > 候选次序）、
//        隔离/非隔离计划与诊断面
//   X-10 openBrowser 的三档结果语义（confirmed / handedOff / ok:false）+ observeSpawn 本体
//        + 退出码证据闸（ownsItsWindow 双向生效：不可信形态既不冒领成功也不凭空判失败）
//        + 两种意图（普通打开 / 隔离登录）共用同一出口与同一词汇
//        —— 唯一异步出口，故尾部汇总排在它之后
//   X-11 外部打开「唯一出口」的源码级不变量，只钉运行判据看不见的那几件：旧出口不得重现、
//        平台事实只在探测层一处、图形会话判据只在 desktop.js 一处、网关缺省装配、
//        面板那一环只经统一入口与唯一的 window.open 分支。
//        端点透传/来源闸/分档呈现不在此重复：它们由 api-contract 的 OW/OU/EF 组与面板 vitest 按行为判红。
//   X-12 环境表单与浏览器偏好的归属不变量（表单字段集、快照落点与权限、上层事实只经装配期注入、
//        偏好写入只过校验且落盘唯一入口、全仓只有一个外部打开动词）
//
// ## 覆盖缺口（E-2 制度化登记）：本门禁绿了仍然不成立的方面
//   1. X-8 的探测夹具与 X-10 的 spawn/observe 全是注入的假件：证明的是「读数->清单->分发->分档」的纯逻辑，
//      不证明真机上注册表/LaunchServices/XDG 的读数形态，也不证明浏览器窗口出现。
//      Windows 真机的默认项解析是否命中、候选次序兜底是否落在用户期望的那个浏览器上，
//      只有带着 diagnostics 的真机落档能回答。
//   2. 观测上界（OPEN_OBSERVE_MS）由假时钟推进，真机冷启动/慢解析下是否够用未证明。
//   3. X-11 是源码正则判据：改名、字符串拼出的调用、间接 require 都能绕过 —— 它保证「本仓只有一条路」，
//      不保证「运行期只走了这条路」。
//   4. 本文件在 Linux 宿主运行：win32/darwin 分支全靠注入 platform，图形会话探测本身归
//      platform-parsers-and-commands 的 Y-4。
//   5. 偏好写入口（app/settings/browser.js 的 setExternalBrowser）的**落盘行为**不在本文件跑：这里唯一可能的
//      注入缝是改 platform.environment 的导出，而那正是本仓测试禁令否掉的形态（假件必须经构造期注入）。
//      故本文件只钉源码面（写入唯一入口、校验先于写、写后必刷缓存），真实读写行为由 api-contract 的
//      EF/PR 两组（经 createServer 注入假表单与假门面）加 X-12 的 checkPreference 纯函数判据覆盖。
// ---------------------------------------------------------------------------

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
    // realPath：保留宿主 PATH。缺省清空 PATH 是「探测类能力必须如实失败」的夹具形态；
    //   但 win32 宿主需要「真实环境」那一侧的证据（X-6 icacls 一致性），此时必须留着 PATH。
    o.realPath ? '' : "process.env.PATH = ''; delete process.env.Path;",
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

// -- X-1：exec-path 候选名 / 标准目录（纯参数化）--
{
  const winNames = ep.candidateNames('npm', 'win32');
  check('X-1 win32 候选名含 npm.cmd（P1-C 的核心）',
    winNames.includes('npm.cmd'), JSON.stringify(winNames));
  //  必须断言**排位**：仅断言"包含 .cmd"会被 PATHEXT 的默认值兜住（假绿，已实测）
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

// -- X-2：P1-C 复现 —— 在 Linux 上验证 win32 会命中 npm.cmd --
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

  // win32 但解析不到 -> 必须回退 npm.cmd（而不是裸 npm，否则 Windows 必 ENOENT）
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

// -- X-3：service —— W3 分派 kind + 方法集一致 + 未知平台显式抛错 --
{
  // 分派口径（见 ARCHITECTURE-PLAN-instance-sandbox-governor，实测不写死）：伪造 linux 且清空 PATH 下 systemd-run 必然测不到
  // -> 必须落 portable（容器/WSL1 正是过去被整体判死、现被解锁的形状）；
  // darwin/win32 恒 portable；未知平台恒 none。
  const kinds = { linux: 'portable', darwin: 'portable', win32: 'portable', freebsd: 'none' };
  const sets = {};
  for (const [p, want] of Object.entries(kinds)) {
    const out = underFake(p, [
      "const svc = require('./src/platform/os/service.js');",
      "const c = svc.current();",
      "process.stdout.write(JSON.stringify({ kind: c.kind, units: c.supportsUnits, transient: c.supportsTransient, keys: Object.keys(c).sort() }));",
    ].join(String.fromCharCode(10)));
    let j = null;
    try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-3 ' + p + ' provider.kind = ' + want, !!j && j.kind === want, j ? j.kind : out.slice(0, 60));
    check('X-3 ' + p + ' supportsUnits 与 kind 一致（仅 systemd 有用户单元）',
      !!j && j.units === (j.kind === 'systemd'), j ? String(j.units) : '-');
    check('X-3 ' + p + ' supportsTransient=' + (want === 'none' ? 'false' : 'true') + '（三平台跑舱解锁；仅未知平台不可）',
      !!j && j.transient === (want !== 'none'), j ? String(j.transient) : '-');
    if (j) sets[p] = j.keys;
  }
  // 方法集一致必须对**三个真实 Provider** 静态对账（_testProviders 缝）：伪造 linux 在任意宿主
  // 都拿不到 systemd 键集，旧判据只比派发产物会静默失去覆盖面（假绿）。
  const tp = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js'))._testProviders;
  const norm = (o) => Object.keys(o).sort();
  const ref = JSON.stringify(norm(tp.systemd));
  const bad = Object.keys(tp).filter((k) => JSON.stringify(norm(tp[k])) !== ref);
  check('X-3 systemd/portable/NONE 三方**方法集完全一致**（含 setLimits，防"声明了却没实现"）',
    bad.length === 0 && norm(tp.systemd).length >= 11 && JSON.stringify(sets.linux || []) === ref,
    bad.length ? ('不一致: ' + bad.join(',')) : (norm(tp.systemd).length + ' 个成员一致'));

  // 未知平台：必须**显式抛错**（带档位标签），绝不静默 no-op。
  // （旧判据打的是 darwin/launchd —— W3 起 darwin/win32 落 portable，不再抛是**能力解锁**，
  //   显式抛错义务移交未知平台 NONE。）
  const thrown = underFake('freebsd', [
    "const svc = require('./src/platform/os/service.js');",
    "const c = svc.current();",
    "const r = [];",
    "for (const m of ['stopUnit', 'startTransient']) {",
    "  try { c[m]('x'); r.push(m + ':NO-THROW'); } catch (e) { r.push(m + ':' + (/无服务管理器/.test(e.message) ? 'labeled' : 'unlabeled')); }",
    "}",
    "process.stdout.write(r.join(' '));",
  ].join(String.fromCharCode(10)));
  check('X-3 未知平台 stopUnit/startTransient 显式抛错且带档位标签',
    /stopUnit:labeled/.test(thrown) && /startTransient:labeled/.test(thrown), thrown);
  const inact = underFake('freebsd', [
    "const svc = require('./src/platform/os/service.js');",
    "process.stdout.write(String(svc.current().isUnitActive('dsh-web@x')));",
  ].join(String.fromCharCode(10)));
  check('X-3 未知平台 isUnitActive(具名单元)=false（无单元可言，删除路径得以继续）',
    inact === 'false', inact);
  const inactP = underFake('win32', [
    "const svc = require('./src/platform/os/service.js');",
    "process.stdout.write(String(svc.current().isUnitActive('dsh-web@x')));",
  ].join(String.fromCharCode(10)));
  check('X-3 portable 无任何锚点时 isUnitActive=null（无从查询不得被当成已停止）',
    inactP === 'null', inactP);

  // 真实环境侧：分派结果必须**等于** systemd-run 可执行实测（写死平台的旧实现会在此露馅）。
  const dis = underFake('linux', [
    "const svc = require('./src/platform/os/service.js');",
    "const ep = require('./src/platform/os/exec-path.js');",
    "const ex = require('./src/platform/util/exec.js');",
    "const has = !!ep.resolveExecutable('systemd-run') || ex.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;",
    "process.stdout.write(JSON.stringify({ kind: svc.current().kind, has: has }));",
  ].join(String.fromCharCode(10)), { realPath: true });
  let dj = null;
  try { dj = JSON.parse(dis); } catch { /* EXECFAIL */ }
  check('X-3 linux 分派 = systemd-run 实测（有=systemd / 无=portable，不随宿主写死）',
    !!dj && dj.kind === (dj.has ? 'systemd' : 'portable'), dis.slice(0, 60));
}

// -- X-3b：portable provider 纯逻辑（pidlookup 打桩，任意宿主确定） --
{
  const out = underFake('linux', [
    "const fs=require('fs'), os=require('os'), path=require('path');",
    "const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-port-'));",
    "const pf=path.join(tmp,'run.pid');",
    "const CMD='node /opt/inst/install/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 8111';",
    // stopUnit 会对 run.pid 命中的 pid 发真实信号——必须用一个探测出的**不存在**的 pid，
    // 绝不能在 CI 宿主上误伤恰好占用 4242 之类的无关进程。
    "let FP=null; for (let q=4194200;q>4190000;q--){ try { process.kill(q,0); } catch (e) { FP=q; break; } }",
    "if (FP===null) { process.stdout.write('{\"FPFAIL\":true}'); process.exit(0); }",
    "let alive=true, cmd=CMD, listen=null, calls=0, limit=1e9;",
    // 加载期 require.cache 注入（test-safety 门禁 A 认可的构造期替换范式；patch 模块导出被禁）：
    // portable 在其后首次 require 时绑到假 pidlookup，探测结果完全受控、宿主无关。
    "const plPath=require.resolve('./src/platform/os/pidlookup');",
    "require.cache[plPath]={ id: plPath, filename: plPath, loaded: true, exports: {",
    "  isAlive: function(){ calls++; return alive && calls<=limit; },",
    "  readCmdline: function(){ return cmd; },",
    "  findListeningPid: function(){ return listen; },",
    "} };",
    "const { portable, _test } = require('./src/platform/os/portable.js');",
    "const r={};",
    "fs.writeFileSync(pf,'4242');",
    "r.pidOk=_test.readPidFile(pf)===4242;",
    "fs.writeFileSync(pf,'garbage'); r.pidBad=_test.readPidFile(pf)===null;",
    "r.pidMissing=_test.readPidFile(path.join(tmp,'nope.pid'))===null;",
    "fs.writeFileSync(pf,String(FP));",
    "r.anchorHit=_test.matchesAnchors(4242,['--port 8111'])===true;",
    "r.anchorMiss=_test.matchesAnchors(4242,['nope'])===false;",
    "r.anchorEmpty=_test.matchesAnchors(4242,[])===false;",
    "const ctx={port:8111,pidFile:pf,anchors:['/opt/inst/install/lib/node_modules/@deepseek-ai/dsh/lib/bin.js','--port 8111']};",
    "const f1=_test.findOurs(ctx); r.pfOwn=!!f1&&f1.pid===FP&&f1.ownGroup===true;",
    "cmd='unrelated process'; const f2=_test.findOurs(ctx); r.anchorMismatchNull=f2===null;",
    "cmd=CMD; alive=false; listen=9999; const f3=_test.findOurs(ctx); r.portNotOwn=!!f3&&f3.pid===9999&&f3.ownGroup===false;",
    "listen=FP; r.portEqPidfileSkipped=_test.findOurs(ctx)===null;",
    "alive=true; listen=null;",
    "r.activeTrue=portable.isUnitActive('dsh-web@x',ctx)===true;",
    "r.noAnchorNull=portable.isUnitActive('dsh-web@x',{})===null;",
    "cmd=null; r.aliveCmdUnknown=portable.isUnitActive('dsh-web@x',ctx)===null; cmd=CMD;",
    "r.noAnchorAliveTrue=portable.isUnitActive('dsh-web@x',{port:8111,pidFile:pf,anchors:[]})===true;",
    "alive=false;",
    "r.noAnchorDeadFalse=portable.isUnitActive('dsh-web@x',{port:0,pidFile:pf,anchors:[]})===false;",
    "r.noAnchorPortUnknown=portable.isUnitActive('dsh-web@x',{port:8111,pidFile:null,anchors:[]})===null;",
    "r.stopNothingTrue=portable.stopUnit('dsh-web@x',{port:8111,pidFile:path.join(tmp,'nope.pid'),anchors:[]})===true;",
    "fs.writeFileSync(pf,String(FP)); alive=true; calls=0; limit=1e9;",
    "r.stopUnconfirmedFalse=portable.stopUnit('dsh-web@x',Object.assign({timeoutMs:0},ctx))===false;",
    "calls=0; limit=2;",
    "r.stopConfirmedTrue=portable.stopUnit('dsh-web@x',Object.assign({timeoutMs:200},ctx))===true;",
    "r.pidFileCleaned=!fs.existsSync(pf);",
    "r.cleanNothingOk=portable.cleanTransient('dsh-web@x',{port:8111,pidFile:path.join(tmp,'nope.pid'),anchors:[]}).ok===true;",
    "try { portable.startTransient({ cmd: [] }); r.rejectEmptyCmd=false; } catch (e) { r.rejectEmptyCmd=/空命令/.test(e.message); }",
    "r.setLimitsFalse=portable.setLimits('dsh-web@x',{memoryMax:'1G'})===false;",
    "process.stdout.write(JSON.stringify(r));",
  ].join(String.fromCharCode(10)));
  let j = null;
  try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
  const want = ['pidOk', 'pidBad', 'pidMissing', 'anchorHit', 'anchorMiss', 'anchorEmpty', 'pfOwn',
    'anchorMismatchNull', 'portNotOwn', 'portEqPidfileSkipped', 'activeTrue', 'noAnchorNull',
    'aliveCmdUnknown', 'noAnchorAliveTrue', 'noAnchorDeadFalse', 'noAnchorPortUnknown', 'stopNothingTrue',
    'stopUnconfirmedFalse', 'stopConfirmedTrue', 'pidFileCleaned', 'cleanNothingOk', 'rejectEmptyCmd', 'setLimitsFalse'];
  check('X-3b portable 纯逻辑 23 项全真（readPidFile/锚点归属/ownGroup 宽严/三态/幂等停止/清理）',
    !!j && want.every((k) => j[k] === true), j ? want.filter((k) => j[k] !== true).join(',') : out.slice(0, 80));
}

// -- X-3c：portable 真实拉起/终止链（真实宿主，不伪造；CI 三 runner 各验本平台） --
{
  // 真 spawn 一个监听临时端口的 node 子进程，验「拉起写 run.pid -> 锚点归属 -> 停止确认并清 pidfile」。
  // 这是 W3 验收标准第 1 条的内核侧落点：伪造平台验不了真进程，真实宿主验不了别家平台，
  // 三端各自跑自己那段（ubuntu/mac/windows runner 各覆盖 POSIX 组信号或 taskkill 路径）。
  const { portable } = require(path.join(ROOT, 'src', 'platform', 'os', 'portable.js'));
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-port-real-'));
  const pf = path.join(tmpd, 'run.pid');
  // 端口经 _ports.js 分段取（T1/T2 纪律）：真实 listen，必须落在安全段而非 ephemeral。
  const port = require(path.join(__dirname, '_ports.js')).safePort('platform-layer-portability');
  const entry = path.join(tmpd, 'entry.js');
  fs.writeFileSync(entry, "require('net').createServer().listen(" + port + ",'127.0.0.1');setInterval(function(){},1000);");
  const ctx = { port, pidFile: pf, anchors: [entry] };
  let started = false;
  let startErr = '';
  try {
    started = portable.startTransient({ cmd: [process.execPath, entry], pidFile: pf }) === true
      && fs.existsSync(pf) && parseInt(fs.readFileSync(pf, 'utf8'), 10) > 0;
  } catch (e) { startErr = e && e.message; }
  check('X-3c startTransient 真拉起并落 run.pid', started, startErr || 'ok');
  check('X-3c run.pid+cmdline 锚点命中即活跃（不等端口监听）',
    started && portable.isUnitActive('dsh-web@x', ctx) === true, 'true');
  const stopOk = started && portable.stopUnit('dsh-web@x', Object.assign({ timeoutMs: 5000 }, ctx)) === true;
  check('X-3c stopUnit 确认终止（true 仅在端口与 pidfile 双锚点消失后）', stopOk, String(stopOk));
  check('X-3c 停止后 run.pid 已清、再查=false（肯定证据，非未知）',
    stopOk && !fs.existsSync(pf) && portable.isUnitActive('dsh-web@x', ctx) === false, 'false');
  try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch { /* 尽力清 */ }
}

// -- X-3d：systemd 档 setLimits 的 argv 实录（exec 打桩，绝不碰宿主 systemd） --
//
//   验收标准第 2 条要求「cgroup 限额可被 governor 运行时改动」被真实验证。真发
//   `systemctl --user set-property` 会在 CI/开发机上留下真实单元属性副作用（且 transient
//   单元不存在时命令本身就要失败），故在**执行器边界**打桩：断言 argv 逐字、有界超时、
//   空 alloc 与非法名的 fail-closed。argv 是平台层在这条链上唯一的真产物；
//   systemd 收到属性后是否真限流属其自身语义，不在本仓断言面内。
{
  const out = underFake('linux', [
    "const calls = [];",
    // 加载期 require.cache 注入（构造期替换范式；patch 模块导出被 test-safety 门禁 A 禁止）
    "const exPath = require.resolve('./src/platform/util/exec.js');",
    "require.cache[exPath] = { id: exPath, filename: exPath, loaded: true, exports: {",
    "  run: function (c, a, o) { calls.push([c, a, o]); return ''; },",
    "  runOut: function (c, a, o) { calls.push([c, a, o]); return ''; },",
    "  runDetail: function (c, a, o) { calls.push([c, a, o]); return { ok: true, stdout: '' }; },",
    "} };",
    "const svc = require('./src/platform/os/service.js');",
    "const t = svc._testProviders.systemd;",
    "const ok = t.setLimits('dsh-web@a1', { memoryMax: '2G', memoryHigh: '1800M', cpuQuota: '150%' });",
    "const argv = calls.length === 1 ? String(calls[0][1]) : 'CALLS=' + calls.length;",
    "const to = calls[0] && calls[0][2] ? calls[0][2].timeoutMs : null;",
    "calls.length = 0;",
    "const empty = t.setLimits('dsh-web@a1', {}) === false && calls.length === 0;",
    "const bad = t.setLimits('../evil', { memoryMax: '1G' }) === false && calls.length === 0;",
    "process.stdout.write(JSON.stringify({ ok: ok === true, argv: argv, to: to, empty: empty, bad: bad }));",
  ].join(String.fromCharCode(10)));
  let j = null;
  try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
  check('X-3d setLimits argv 逐字：--user set-property --runtime <unit> 三属性（--runtime 防陈旧下限黏住）',
    !!j && j.ok && j.argv === ['--user', 'set-property', '--runtime', 'dsh-web@a1',
      'MemoryMax=2G', 'MemoryHigh=1800M', 'CPUQuota=150%'].join(','), j ? j.argv : out.slice(0, 80));
  check('X-3d setLimits 走有界超时（dbus 挂起不得冻结监督拍）', !!j && j.to === 10000, j ? String(j.to) : '-');
  check('X-3d 空 alloc 不发命令且返 false（无值可下发时绝不发空调用）', !!j && j.empty === true, j ? String(j.empty) : '-');
  check('X-3d 非法单元名 fail-closed（与 stopUnit 同闸，绝不进 systemctl argv）', !!j && j.bad === true, j ? String(j.bad) : '-');
}

// -- X-4：autostart —— daemonCommand 平台差异 + status().kind 与能力档位一致 --
{
  const cmds = {};
  for (const p of ['linux', 'darwin', 'win32']) {
    const out = underFake(p, [
      "const a = require('./src/platform/os/autostart');",
      "process.stdout.write(a.daemonCommand());",
    ].join(String.fromCharCode(10)), { home: '/H' });
    cmds[p] = out;
  }
  //原断言把**期望路径硬编码**为 path.join('/H', ...)，依赖 underFake 的 home 注入。
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

// -- X-6：file-protect —— POSIX 分支 + Windows 不得静默成功 --
{
  const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect.js'));
  check('X-6 hasIcacls(linux/darwin) 恒 false（POSIX 绝不探测 icacls）',
    fp.hasIcacls('linux') === false && fp.hasIcacls('darwin') === false, 'false');
  // Windows 分支：探测不到 icacls 时必须**如实失败**（不得静默 ok）。
  //    本块的前提在 CI 上被证伪过一次：原先写的「win32 宿主
  //   System32 必有 icacls，故清空 PATH 后仍可用」是**推演**，实测该 job 里 hasIcacls()=false
  //   （execFileSync('icacls') 在 PATH 清空后没被解析到）。教训：环境事实不能靠推演写进判据。
  //   现在两侧各验自己的不变量，并把「icacls 到底可不可用」降级为**回显的事实**而非前提：
  //     POSIX 宿主 —— 清空 PATH -> 探测必不可用 -> 必须如实 ok=false/mode=none（不静默成功）；
  //     win32 宿主 —— 真实 PATH -> 「可用 => 绝不谎报 none」且「不可用 => 绝不假称收紧」（一致性）。
  const winMissing = path.join(TMP, 'nonexistent-xyz');
  const probeBody = [
    "const fp = require('./src/platform/os/file-protect.js');",
    "const ex = require('./src/platform/util/exec.js');",
    'const f = ' + JSON.stringify(winMissing) + ';',
    "const d = ex.runDetail('icacls', ['/?'], { timeoutMs: 5000 });",
    'process.stdout.write(JSON.stringify({ i: fp.hasIcacls(), f: fp.protectFile(f), d: fp.protectDir(f),',
    "  p: { ok: d.ok, code: d.code, timedOut: d.timedOut, err: String(d.error || '').slice(0, 120), stderr: String(d.stderr || '').slice(0, 80) } }));",
  ].join(String.fromCharCode(10));
  const wOut = underFake('win32', probeBody);
  let w = null; try { w = JSON.parse(wOut); } catch { /* EXECFAIL */ }
  if (process.platform !== 'win32') {
    check('X-6 前提：POSIX 宿主伪造 win32 时 icacls 探测不可用（判据前提，非空转）',
      !!w && w.i === false, w ? 'hasIcacls=' + w.i + ' p=' + JSON.stringify(w.p) : wOut.slice(0, 70));
    check('X-6 Windows 且 icacls 不可用 → protectFile 如实 ok=false/mode=none（不静默成功）',
      !!w && w.f.ok === false && w.f.mode === 'none' && !!w.f.reason, w ? JSON.stringify(w.f) : '-');
    check('X-6 Windows 且 icacls 不可用 → protectDir 同上',
      !!w && w.d.ok === false && w.d.mode === 'none' && !!w.d.reason, w ? JSON.stringify(w.d) : '-');
  } else {
    const realOut = underFake('win32', probeBody, { realPath: true });
    let wr = null; try { wr = JSON.parse(realOut); } catch { /* EXECFAIL */ }
    check('X-6 前提：win32 宿主能求值本探针（JSON 解析成功，否则一致性判据空转）',
      !!wr, wr ? 'ok' : realOut.slice(0, 90));
    // 环境事实也立判据（不留「绿着掩盖生产退化」的缝）：真实 PATH 下 icacls 必须可用。
    //   若此例判红，回显里的 探针 字段区分两种根因——err 含 ENOENT = 解析不到（路径/环境问题）；
    //   code 非 0 = icacls 自身对 /? 的退出码不为 0，那就是**产品缺陷**（hasIcacls 探测方式要改）。
    check('X-6 win32 真实 PATH：icacls 可用（生产机拿不到 ACL 收紧即为缺陷，不静默放行）',
      !!wr && wr.i === true, wr ? JSON.stringify({ icacls可用: wr.i, 探针: wr.p }) : '-');
    check('X-6 win32 真实 PATH：icacls 可用 ⇒ protectFile/protectDir 绝不谎报 mode=none',
      !!wr && (wr.i === false || (wr.f.mode !== 'none' && wr.d.mode !== 'none')),
      wr ? JSON.stringify({ icacls可用: wr.i, f: wr.f, d: wr.d, 探针: wr.p }) : '-');
    check('X-6 win32 真实 PATH：icacls 不可用 ⇒ 如实 ok=false/mode=none（不假称已收紧）',
      !!wr && (wr.i === true || (wr.f.ok === false && wr.f.mode === 'none' && wr.d.ok === false && wr.d.mode === 'none')),
      wr ? JSON.stringify({ icacls可用: wr.i, f: wr.f, d: wr.d, 探针: wr.p }) : '-');
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

// -- X-7：netinfo —— 平台支持矩阵 + 未知平台显式空 + pick 纯逻辑 --
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

// -- X-8：外部打开底座的分工（探测 browser-inventory / 环境表单+分发 environment / 执行 browser）--
// 本组钉的是「分层是否还在」：探测层只回答系统里有什么，表单把本机实况收一张表并定出这次交给谁，
// 执行层只按计划 spawn 一次并如实回报拿到什么证据。
// 任何一层越界（选路自己查注册表、执行层替用户挑浏览器、探测层顺手 spawn）都会让真机症状重新变成不可定性。
{
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  const env = require(path.join(ROOT, 'src', 'platform', 'os', 'environment.js'));
  const det = br.detector;
  const u = 'http://127.0.0.1:28111/x';
  check('X-8 解析原语只有一个实现处（browser.js 转出的即探测层的同一函数）',
    typeof det === 'object' && br.engineOf === det.engineOf && br.parseExecLine === undefined
    && br.resolveDefaultWin === undefined && br.resolveDefaultLinux === undefined
    && br.resolveDefaultMac === undefined && br.defaultBrowser === undefined,
    Object.keys(det).slice(0, 6).join(','));
  // 分发依据住在表单，不住在执行层：它一旦被 browser.js 重新导出，「本机实况」就有了第二个口径
  //   （旧形态是选路住在 browser.js，于是环境事实与计划各说各话）。
  check('X-8 反向：选路口只由环境表单交出（browser.js 不再导出 pickLauncher/清单面）',
    br.pickLauncher === undefined && br.listBrowsers === undefined && br.invalidateBrowsers === undefined
    && br.launchIsolated === undefined && typeof env.pickLauncher === 'function'
    && typeof env.form === 'function' && typeof env.bind === 'function',
    Object.keys(br).join(','));


  // —— 调度器形态：Windows 没有可信调度器 ——
  check('X-8 win32 openCommand = null（无可信调度器：explorer.exe 未文档化且返回码不携带信息）',
    br.openCommand('win32', u) === null, JSON.stringify(br.openCommand('win32', u)));
  check('X-8 darwin openCommand = open <url>',
    JSON.stringify(br.openCommand('darwin', u)) === JSON.stringify({ cmd: 'open', args: [u] }), 'ok');
  check('X-8 linux openCommand = xdg-open <url>',
    JSON.stringify(br.openCommand('linux', u)) === JSON.stringify({ cmd: 'xdg-open', args: [u] }), 'ok');
  check('X-8 未知平台**有意**退化 xdg-open（best-effort，不宣称能力）',
    br.openCommand('freebsd', u).cmd === 'xdg-open', br.openCommand('freebsd', u).cmd);
  // 被删掉的兜底不得回流：整仓 src/ 扫字面量，注释里留着也算（注释一旦写下 explorer.exe，
  //   下一个人就会以为它是可恢复的退路）。
  const walkJs = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) walkJs(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
  const allSrc = walkJs(path.join(ROOT, 'src'), []);
  const exHits = allSrc.filter((f) => /explorer\.exe/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('X-8 全仓 src/ 零 explorer.exe（未文档化的冒开路径整体删除，不留「随时可恢复」的字样）',
    exHits.length === 0, exHits.join(',') || ('扫描 ' + allSrc.length + ' 个文件'));
  check('X-8 反向：判据能识别 explorer.exe 兜底回流',
    /explorer\.exe/i.test("if (pl === 'win32') return { cmd: 'explorer.exe', args: [url] };"), 'hit');
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

  // —— 解析原语（探测层的纯函数侧，可在任意宿主穷举）——
  check('X-8 engineOf：chromium 派生系（chrome/chromium/msedge/brave/opera/vivaldi/thorium）',
    ['google-chrome', '/usr/bin/chromium-browser', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
     'brave-browser', 'opera', 'vivaldi-stable', 'thorium'].every((b) => det.engineOf(b) === 'chromium'), 'ok');
  check('X-8 engineOf：firefox/librewolf/waterfox=firefox；safari/snap/xdg-open=other',
    det.engineOf('firefox') === 'firefox' && det.engineOf('/usr/lib/firefox/firefox') === 'firefox'
    && det.engineOf('librewolf') === 'firefox' && det.engineOf('waterfox') === 'firefox'
    && det.engineOf('/Applications/Safari.app/Contents/MacOS/Safari') === 'other'
    && det.engineOf('snap') === 'other' && det.engineOf('xdg-open') === 'other', 'ok');
  check('X-8 regValueOf：REG_SZ 与 REG_EXPAND_SZ 都认（只认前者等于把安装器写下的注册当「没注册」）',
    det.regValueOf('    (默认)    REG_SZ    Google Chrome') === 'Google Chrome'
    && det.regValueOf('    (默认)    REG_EXPAND_SZ    %ProgramFiles%\\Mozilla Firefox\\firefox.exe')
      === '%ProgramFiles%\\Mozilla Firefox\\firefox.exe'
    && det.regValueOf('    (默认)    REG_DWORD    1') === null
    && det.regValueOf(null) === null, 'ok');
  check('X-8 expandEnvVars：已知变量展开、未知变量原样留着（宁可判不可用也不猜路径）',
    det.expandEnvVars('%ProgramFiles%\\x\\firefox.exe', { ProgramFiles: 'C:\\Program Files' }) === 'C:\\Program Files\\x\\firefox.exe'
    && det.expandEnvVars('%Nope%\\x', {}) === '%Nope%\\x', 'ok');
  check('X-8 exeFromCmdLine：引号形态与裸 .exe 形态；非 exe 命令行 → null',
    det.exeFromCmdLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"') === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    && det.exeFromCmdLine('C:\\Windows\\notepad.exe %1') === 'C:\\Windows\\notepad.exe'
    // 未加引号但路径自带空格：注册表里 REG_EXPAND_SZ 展开后就是这个形状，按首个空白切会切出 `C:\Program`。
    && det.exeFromCmdLine('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe -- "%1"') === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    && det.exeFromCmdLine('notepad') === null, 'ok');
  check('X-8 parseExecLine：URL 字段码剔除 + env 去壳 + 引号分词',
    JSON.stringify(det.parseExecLine('/usr/bin/firefox %u')) === JSON.stringify({ bin: '/usr/bin/firefox', baseArgs: [] })
    && JSON.stringify(det.parseExecLine('env DISPLAY=:0 brave-browser --ozone-platform=x11 %U')) === JSON.stringify({ bin: 'brave-browser', baseArgs: ['--ozone-platform=x11'] })
    && JSON.stringify(det.parseExecLine('"google chrome"  --incognito %u')) === JSON.stringify({ bin: 'google chrome', baseArgs: ['--incognito'] })
    && det.parseExecLine('%u') === null, 'ok');
  check('X-8 safeRegKeyPart：ProgID 里的 shell 活性字符/控制序列一律拒（键名会进 reg.exe 的 argv）',
    det.safeRegKeyPart('ChromeHTML') === true
    && det.safeRegKeyPart('a&b') === false && det.safeRegKeyPart('a|b') === false
    && det.safeRegKeyPart('a\nb') === false && det.safeRegKeyPart('') === false, 'ok');
  // reg.exe 把根名展开后打印（问 HKLM 回 HKEY_LOCAL_MACHINE）。产品若按简写键比前缀，真机上每一行都匹配不上，
  //   整个 StartMenuInternet 枚举会静默交出空清单——本轮 Windows 落档缺的就是这一类「探了却什么都没探到」。
  const subOf = (text) => det.regSubkeys(() => text, () => {}, 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet');
  check('X-8 regSubkeys：只认 reg.exe 实际打印的完整根名，简写形态反向也钉住',
    JSON.stringify(subOf('HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\MSEdge\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox\r\n')) === JSON.stringify(['MSEdge', 'Firefox'])
    && subOf('HKLM\\SOFTWARE\\Clients\\StartMenuInternet\\MSEdge\r\n').length === 0
    && det.regKeyFull('HKCU\\Software\\Classes') === 'HKEY_CURRENT_USER\\Software\\Classes', 'ok');

  // —— 探测层：win32 多源并集，且「被系统忽略的默认值」不再被当默认项读 ——
  const UC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  const SMI = 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet';
  /** 假 reg.exe：只按探测层实际发出的 query 形态应答，认不出的形态一律 null（= 读不到）。
   *  values 的项可为字符串（REG_SZ）或 {t:'REG_EXPAND_SZ',d:'…'}。
   *  两处必须照真机形状来，否则夹具与产品各自成立、判据空转：
   *   1) 不带 /v 的查询里，子键行打印的是**展开后的完整根名**（`reg query HKLM\...` 回的是 `HKEY_LOCAL_MACHINE\...`），
   *      而 fixture 里的键仍按简写登记（作者侧好读）；
   *   2) 三个登记表（values/named/subs）要挂在返回的函数上，供逐例追加键值。 */
  function fakeReg(o) {
    const hits = [];
    const values = o.values || {}, named = o.named || {}, subs = o.subs || {}, multi = o.multi || {};
    const HIVE = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT' };
    const q = (v) => (typeof v === 'string' ? ['REG_SZ', v] : [v.t || 'REG_SZ', v.d]);
    const run = (bin, args) => {
      if (bin !== 'reg.exe' || args[0] !== 'query') return null;
      hits.push(args.join(' '));
      const key = args[1];
      if (args[2] === '/v') {
        const v = (named[key] || {})[args[3]];
        if (v === undefined) return null;
        const [t, d] = q(v); return '    ' + args[3] + '    ' + t + '    ' + d + '\r\n';
      }
      if (args[2] === '/ve') {
        const v = values[key];
        if (v === undefined) return null;
        const [t, d] = q(v); return '    (默认)    ' + t + '    ' + d + '\r\n';
      }
      const sep = key.indexOf('\\');
      const root = sep < 0 ? key : key.slice(0, sep);
      const fullKey = (HIVE[root.toUpperCase()] || root) + (sep < 0 ? '' : key.slice(sep));
      const lines = [];
      for (const [n, v] of Object.entries(multi[key] || {})) { const [t, d] = q(v); lines.push('    ' + n + '    ' + t + '    ' + d); }
      for (const s of (subs[key] || [])) lines.push(fullKey + '\\' + s);
      return lines.length ? lines.join('\r\n') + '\r\n' : null;
    };
    run.hits = hits;
    run.values = values;
    run.named = named;
    run.subs = subs;
    return run;
  }
  /** 探测注入缝：默认「列出的路径都可执行」，逐例收紧。env 里带 Windows 的真实变量名（含括号）。 */
  const winProbe = (o, canExec) => det.probe('win32', {
    runOut: o,
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    canExec: canExec || (() => true),
  });
  {
    // 真实装机形态：UserChoice 说 ProgID，ProgID 的 open\command 说本体；目录源另报一个浏览器。
    const ucRun = fakeReg({
      named: { [UC_KEY]: { ProgId: 'FirefoxURL' } },
      values: {
        'HKLM\\Software\\Classes\\FirefoxURL\\shell\\open\\command': '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"',
        'HKLM\\Software\\Classes\\MSEdge\\shell\\open\\command': { t: 'REG_EXPAND_SZ', d: '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe -- "%1"' },
      },
      subs: { [SMI]: ['MSEdge', 'Firefox'] },
      multi: {},
    });
    const r = winProbe(ucRun);
    check('X-8 探测 win32：UserChoice 的 ProgID -> open\\command 定出默认项（用户自己选的优先于目录顺序）',
      r.defaultId === 'c:\\program files\\mozilla firefox\\firefox.exe' && r.defaultSource === 'userchoice',
      JSON.stringify({ d: r.defaultId, s: r.defaultSource }));
    check('X-8 探测 win32：StartMenuInternet 目录里的第二个浏览器同时入册（枚举而非单问一句）',
      r.browsers.length === 2 && r.browsers.some((b) => /msedge/.test(b.id)) && r.browsers.every((b) => b.sources.length >= 1),
      JSON.stringify(r.browsers.map((b) => b.id + '<' + b.sources.join('+') + '>')));
    check('X-8 探测 win32：REG_EXPAND_SZ 的 %ProgramFiles(x86)% 已展开成绝对路径（未展开必判不可执行）',
      r.browsers.some((b) => b.bin === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
      JSON.stringify(r.browsers.map((b) => b.bin)));
    check('X-8 探测 win32：每条来源都留痕（probed 是面板 diagnostics 的原料，缺它真机无从定性）',
      r.probed.length >= 4 && r.probed.every((p) => p.source && p.detail !== undefined),
      JSON.stringify(r.probed.slice(0, 4)));
  }
  {
    // 本轮 Windows 真机缺陷的另一半：旧实现把 StartMenuInternet 的**默认值**当「默认浏览器」读，
    //   而 Win7 起系统忽略该值 —— 读到它就以为定了默认，实际什么都没读到。
    const runOut = fakeReg({
      named: {}, values: { [SMI]: 'MSEdge' },
      subs: {
        [SMI]: ['MSEdge', 'Firefox'],
        [SMI + '\\MSEdge']: [],
        [SMI + '\\Firefox']: [],
      },
      multi: {},
    });
    runOut.values['HKLM\\Software\\Classes\\MSEdge\\shell\\open\\command'] = 'C:\\Edge\\msedge.exe "%1"';
    runOut.values['HKLM\\Software\\Classes\\Firefox\\shell\\open\\command'] = 'C:\\FF\\firefox.exe "%1"';
    const r = winProbe(runOut);
    check('X-8 探测 win32 反向：StartMenuInternet 的默认值**不得**被当默认项（Win7 起系统忽略它）',
      r.defaultId === null && r.defaultSource === null, JSON.stringify({ d: r.defaultId, s: r.defaultSource }));
    // 分发依据必须把「这是第 4 层兜底」写在 how 上而不是伪装成系统默认：面板据此说「系统未报默认项」，
    //   用户才有改的地方。按顺序猜的旧病不在「启了一个浏览器」，在于启了之后仍说成系统默认。
    check('X-8 探测 win32 反向：此时两个候选仍在册，分发依据落到候选次序层（不冒认系统默认、也不静默换人）',
      r.browsers.length === 2 && env.pickLauncher('win32', r, null).browser !== null
      && env.pickLauncher('win32', r, null).how === 'candidate-rank', JSON.stringify(env.pickLauncher('win32', r, null)));
  }
  {
    // 协议关联（Classes\https）是「系统真正把地址交给谁」的那条事实：UserChoice 读不到时靠它定默认。
    const runOut = fakeReg({
      named: {}, subs: {}, multi: {},
      values: {
        'HKCU\\Software\\Classes\\https': 'AppURLMicrosoft Edge',
        'HKCU\\Software\\Classes\\https\\shell\\open\\command': { t: 'REG_EXPAND_SZ', d: '"C:\\Edge\\msedge.exe" -- "%1"' },
      },
    });
    const r = winProbe(runOut);
    check('X-8 探测 win32：UserChoice 缺失时以 https 协议关联定默认（来源如实标 scheme-association）',
      r.defaultId === 'c:\\edge\\msedge.exe' && r.defaultSource === 'scheme-association', JSON.stringify({ d: r.defaultId, s: r.defaultSource, b: r.browsers.map((x) => x.bin) }));
  }
  {
    // App Paths 是 per-user 安装的登记处；指向不可执行文件时必须落进 probed 而不是入册。
    const runOut = fakeReg({
      named: {}, subs: {}, values: {
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe': 'C:\\Users\\me\\AppData\\Local\\Brave\\brave.exe',
      }, multi: {},
    });
    const ok = winProbe(runOut);
    const bad = winProbe(runOut, () => false);
    check('X-8 探测 win32：App Paths 单候选 = 唯一解默认（only-installed，不是产品挑内核）',
      ok.browsers.length === 1 && ok.defaultSource === 'only-installed' && ok.defaultId === 'c:\\users\\me\\appdata\\local\\brave\\brave.exe',
      JSON.stringify({ d: ok.defaultId, s: ok.defaultSource }));
    check('X-8 探测 win32 反向：canExec 不过的文件不入册，但留痕说明为什么（「取不到」不等同「没装」）',
      bad.browsers.length === 0 && bad.probed.some((p) => /不可执行/.test(String(p.detail))),
      JSON.stringify(bad.probed));
  }
  {
    // 探测意外不得变成用户可见的打开失败：inventory 兜住异常并留痕。
    const inv = det.inventory('win32', {
      force: true, now: () => 1000, runOut: () => { throw new Error('reg 被拒'); }, env: {}, canExec: () => true,
    });
    check('X-8 探测意外（注册表被拒）-> inventory 不抛错、清单为空且带 probe-error 留痕',
      Array.isArray(inv.browsers) && inv.browsers.length === 0 && inv.probed.some((p) => p.source === 'probe-error'),
      JSON.stringify(inv.probed));
    const inv2 = det.inventory('win32', { force: true, now: () => 2000, runOut: fakeReg({ named: {}, values: {}, subs: {}, multi: {} }), env: {}, canExec: () => true, ttlMs: 60000 });
    const inv3 = det.inventory('win32', { now: () => 20000, runOut: () => { throw new Error('第二次不该被调用'); }, env: {}, canExec: () => true });
    check('X-8 探测结果按平台缓存（面板轮询不得反复查注册表）且 force/窗口外会重探',
      inv2.cached === false && inv3.cached === true, JSON.stringify({ a: inv2.cached, b: inv3.cached }));
    det.invalidate('win32');
    const inv4 = det.inventory('win32', { now: () => 20000, runOut: fakeReg({ named: {}, values: {}, subs: {}, multi: {} }), env: {}, canExec: () => true });
    check('X-8 invalidate 后下一次重探（装/卸载浏览器后面板要能立刻反映）',
      inv4.cached === false, String(inv4.cached));
  }
  {
    // darwin：LaunchServices 报「可打开 https 的全部应用」+ 默认标记；探测脚本输出行协议在探测层内定义。
    const jxa = (bin, bid, isDef) => [bin, bid, isDef ? '1' : ''].join('\t');
    const out = [jxa('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'com.google.chrome', true),
      jxa('/Applications/Firefox.app/Contents/MacOS/firefox', 'org.mozilla.firefox', false)].join('\n');
    const r = det.probe('darwin', { runOut: () => out, canExec: () => true });
    check('X-8 探测 darwin：LaunchServices 清单两条、默认项取带标记的那条',
      r.browsers.length === 2 && r.defaultSource === 'launchservices'
      && r.defaultId === '/applications/google chrome.app/contents/macos/google chrome', JSON.stringify({ d: r.defaultId, n: r.browsers.length }));
    const r2 = det.probe('darwin', { runOut: () => '', canExec: () => true });
    check('X-8 探测 darwin 反向：查询无输出（旧系统/权限拦截）= 空清单 + 留痕，不谎报已装',
      r2.browsers.length === 0 && r2.probed.some((p) => p.source === 'launchservices'), JSON.stringify(r2.probed));
    const r3 = det.probe('darwin', { runOut: () => out, canExec: (p) => !/Firefox/.test(p) });
    check('X-8 探测 darwin：LaunchServices 报了但本体不可执行 -> 剔除并留痕',
      r3.browsers.length === 1 && r3.probed.some((p) => /不可执行/.test(String(p.detail))), JSON.stringify(r3.browsers.map((b) => b.bin)));
  }
  {
    // linux：清单来自 .desktop 扫描，默认项按 mimeapps 规范顺序；snap 包装器（other 引擎）不直启。
    const files = {
      '/usr/share/applications/firefox.desktop': '[Desktop Entry]\nName=Firefox Web Browser\nExec=/usr/lib/firefox/firefox %u\nCategories=Network;WebBrowser;\n\n[Desktop Action new-window]\nExec=/usr/lib/firefox/firefox --new-window %u\n',
      '/usr/share/applications/chromium.desktop': '[Desktop Entry]\nName=Chromium\nExec=env VAR=1 chromium --ozone-platform=x11 %U\nCategories=Network;WebBrowser;\n',
      '/var/lib/snapd/desktop/applications/chromium_chromium.desktop': '[Desktop Entry]\nName=Chromium (snap)\nExec=snap run chromium %U\nCategories=Network;WebBrowser;\n',
      '/home/u/.config/mimeapps.list': '[Default Applications]\nx-scheme-handler/https=chromium.desktop\n',
    };
    const d = {
      runOut: () => null,
      readFile: (p) => { if (!(p in files)) throw new Error('enoent ' + p); return files[p]; },
      exists: (p) => p in files,
      listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1)),
      canExec: (p) => p === '/usr/lib/firefox/firefox' || p === '/usr/bin/chromium',
      env: { PATH: '/usr/bin', XDG_DATA_HOME: '', XDG_CONFIG_HOME: '/home/u/.config' },
      home: '/home/u',
    };
    const r = det.probe('linux', d);
    check('X-8 探测 linux：.desktop 主条目 Exec 还原真实命令（Desktop Action 段不取）',
      r.browsers.some((b) => b.bin === '/usr/lib/firefox/firefox' && JSON.stringify(b.baseArgs) === '[]'),
      JSON.stringify(r.browsers.map((b) => [b.bin, b.baseArgs])));
    check('X-8 探测 linux：env 包装去壳 + baseArgs 保留 + 裸名按 PATH 解析成绝对路径',
      r.browsers.some((b) => b.bin === '/usr/bin/chromium' && JSON.stringify(b.baseArgs) === JSON.stringify(['--ozone-platform=x11'])),
      JSON.stringify(r.browsers.map((b) => [b.bin, b.baseArgs])));
    check('X-8 探测 linux：默认项按 mimeapps.list（用户级）定出，条目 id 与清单同一契约（归一 bin 小写）',
      r.defaultId === '/usr/bin/chromium' && r.defaultSource === 'mimeapps', JSON.stringify({ d: r.defaultId, s: r.defaultSource }));
    check('X-8 探测 linux：snap 包装器不进直启清单（other 引擎交回调度器，绝不裸 URL 硬试）',
      r.browsers.every((b) => b.engine === 'chromium' || b.engine === 'firefox') && r.browsers.every((b) => det.engineOf(b.bin) !== 'other'),
      JSON.stringify(r.browsers.map((b) => [b.name, b.engine])));
    check('X-8 探测 linux：id 恒为归一 bin（defaultId 靠它在清单里定位；三平台同一契约）',
      r.browsers.every((b) => b.id === b.bin.toLowerCase()) && r.browsers.some((b) => b.id === r.defaultId),
      JSON.stringify(r.browsers.map((b) => b.id)));
    const noCfg = det.probe('linux', Object.assign({}, d, { canExec: () => false }));
    check('X-8 探测 linux 反向：全部候选都不可执行 = 空清单（打开时显式 no-launcher，不冒开）',
      noCfg.browsers.length === 0 && noCfg.defaultId === null, JSON.stringify(noCfg.browsers));
    const one = det.probe('linux', Object.assign({}, d, {
      readFile: (p) => (p === '/home/u/.config/mimeapps.list' ? '' : files[p]),
      exists: (p) => p === '/usr/lib/firefox/firefox' ? true : (p in files),
      listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + '/') && !/chromium/.test(f)).map((f) => f.slice(p.length + 1)),
    }));
    check('X-8 探测 linux：只探到一个浏览器时按唯一解定默认（不是按顺序猜）',
      one.browsers.length === 1 && one.defaultSource === 'only-installed', JSON.stringify({ d: one.defaultId, s: one.defaultSource }));
  }

  // —— 分发依据：环境表单 + 用户偏好 -> 这次交给谁（夹具即探测层产物，不另立字段）——
  const brow = (bin, extra) => Object.assign({
    id: String(bin).toLowerCase(), name: String(bin).split(/[\\/]/).pop().replace(/\.exe$/i, ''),
    engine: det.engineOf(bin), bin, sources: ['fixture'],
  }, extra || {});
  const invOf = (list, defId, defSource) => ({
    platform: 'fixture', browsers: list, defaultId: defId || null, defaultSource: defSource || null,
    probed: [{ source: 'fixture', detail: list.length + ' 项' }],
  });
  {
    const ff = brow('/usr/lib/firefox/firefox');
    const chrome = brow('/usr/bin/google-chrome');
    const p = (inv, pref) => env.pickLauncher('linux', inv, pref);
    check('X-8 分发依据 1 层：用户偏好命中即用，并压过系统默认（选过的人不该被系统改口）',
      JSON.stringify([p(invOf([chrome, ff], ff.id, 'mimeapps'), chrome.id).how,
        p(invOf([chrome, ff], ff.id, 'mimeapps'), chrome.id).browser]) === JSON.stringify(['user-preference', chrome])
      && p(invOf([chrome, ff], ff.id, 'mimeapps'), chrome.id).stale === false, JSON.stringify(p(invOf([chrome, ff], ff.id, 'mimeapps'), chrome.id)));
    check('X-8 分发依据 2 层：无偏好时命中 defaultId，用 defaultSource 记账（谁说的默认要跟着走）',
      p(invOf([chrome, ff], ff.id, 'mimeapps'), null).browser === ff
      && p(invOf([chrome, ff], ff.id, 'mimeapps'), null).how === 'mimeapps'
      && p(invOf([chrome, ff], ff.id, 'mimeapps'), null).wanted === null, JSON.stringify(p(invOf([chrome, ff], ff.id, 'mimeapps'), null)));
    check('X-8 分发依据：偏好所指不在候选清单里 = 不静默换人，回落系统默认并标 stale（面板据此提示重选）',
      p(invOf([chrome, ff], ff.id, 'mimeapps'), 'c:\\gone\\browser.exe').browser === ff
      && p(invOf([chrome, ff], ff.id, 'mimeapps'), 'c:\\gone\\browser.exe').stale === true
      && p(invOf([chrome, ff], ff.id, 'mimeapps'), 'c:\\gone\\browser.exe').wanted === 'c:\\gone\\browser.exe',
      JSON.stringify(p(invOf([chrome, ff], ff.id, 'mimeapps'), 'c:\\gone\\browser.exe')));
    check('X-8 分发依据：defaultId 指向清单里没有的条目 = 不命中（探测层与表单同一份数据才谈得上同源）',
      p(invOf([ff], 'no-such-id', 'userchoice'), null).how === 'only-installed',
      JSON.stringify(p(invOf([ff], 'no-such-id', 'userchoice'), null)));
    // 第 4 层是本轮收口点：真机形状 = 多候选且系统说不出默认。旧实现在此给空对象，
    //   整条链路报 no-launcher，用户看到的是「点一键登录什么都没弹」。
    check('X-8 分发依据 3/4 层：单候选=唯一解、多候选无默认=候选次序、空清单=none-found',
      p(invOf([ff]), null).how === 'only-installed'
      && p(invOf([ff, chrome]), null).how === 'candidate-rank'
      && p(invOf([ff, chrome]), null).browser === chrome
      && p(invOf([]), null).how === 'none-found' && p(invOf([]), null).browser === null
      && p(null, null).how === 'none-found', 'ok');
    // 次序不能随清单产出顺序漂移，也不能按平台分叉：引擎族定级（裸 URL 参数语义是否确定）+ id 字典序。
    const safari = brow('/Applications/Safari.app/Contents/MacOS/Safari');
    check('X-8 候选次序按引擎族分级且与清单顺序无关（other 永不在前，同族按 id 定序）',
      JSON.stringify(env.rankCandidates([safari, ff, chrome]).map((b) => b.id)) === JSON.stringify([chrome.id, ff.id, safari.id])
      && JSON.stringify(env.rankCandidates([chrome, ff, safari]).map((b) => b.id)) === JSON.stringify([chrome.id, ff.id, safari.id])
      && JSON.stringify(env.rankCandidates([brow('/usr/bin/tor-browser'), ff]).map((b) => b.id)) === JSON.stringify([ff.id, '/usr/bin/tor-browser']), 'ok');
  }
  const kl = br.openPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome')]) });
  const kw = br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe')]) });
  const knone = br.openPlan('win32', u, { inventory: invOf([]) });
  const kmany = br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]) });
  const ko = br.openPlan('darwin', u, { inventory: invOf([brow('/Applications/Safari.app/Contents/MacOS/Safari')]) });
  check('X-8 openPlan win32 探到本体 = 直启（Windows 唯一路；无调度器可退）',
    kw.bin === 'C:\\Edge\\msedge.exe' && kw.via === 'browser' && kw.engine === 'chromium' && kw.pick === 'only-installed', JSON.stringify(kw));
  check('X-8 openPlan win32 探不到任何浏览器 = bin:null（旧形态在这里退 explorer.exe 冒开）',
    knone.bin === null && knone.via === 'none' && knone.pick === 'none-found' && knone.exitIsEvidence === false, JSON.stringify(knone));
  // 计划层必须把「用的是第几层分发依据」原样带出（pick），并把偏好失效带出（stale）：
  //   面板与 evidence 只认这两个字段说话，否则兜底启的浏览器会被说成系统默认。
  check('X-8 openPlan win32 多候选而系统说不出默认 = 按候选次序启并记账 candidate-rank（旧形态在此整链不弹窗）',
    kmany.bin === 'C:\\Edge\\msedge.exe' && kmany.via === 'browser' && kmany.pick === 'candidate-rank', JSON.stringify(kmany));
  check('X-8 openPlan 偏好直通：计划认偏好，且失效偏好会随计划交出 stale',
    br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]), preference: 'c:\\ff\\firefox.exe' }).pick === 'user-preference'
    && br.openPlan('win32', u, { inventory: invOf([brow('C:\\FF\\firefox.exe')]), preference: 'c:\\gone\\x.exe' }).stale === true, 'ok');
  check('X-8 openPlan linux/darwin 无解析结果 = 文档化调度器且 exitIsEvidence:true（0 即接收、非 0 即拒绝）',
    br.openPlan('linux', u, { inventory: invOf([]) }).bin === 'xdg-open'
    && br.openPlan('linux', u, { inventory: invOf([]) }).exitIsEvidence === true
    && br.openPlan('darwin', u, { inventory: invOf([]) }).bin === 'open'
    && br.openPlan('darwin', u, { inventory: invOf([]) }).exitIsEvidence === true, 'ok');
  // 两种意图的计划产物同一字段口径（args = 最终 argv）：执行层只有一条 spawn 路，计划不得各叫各的名。
  check('X-8 openPlan 解析到 chromium = 直启该浏览器（baseArgs 在前、url 收尾，且绝不注入隔离参数）',
    kl.bin === '/usr/bin/google-chrome' && kl.via === 'browser' && kl.engine === 'chromium'
    && JSON.stringify(kl.args) === JSON.stringify([u]) && kl.isolated === false && kl.watch === false, JSON.stringify(kl));
  check('X-8 openPlan 把候选条目自带的 baseArgs 排在 url 之前（snap/env 包装的启动参数不得被丢掉）',
    JSON.stringify(br.openPlan('linux', u, { inventory: invOf([brow('brave-browser', { baseArgs: ['--ozone-platform=x11'] })]) }).args)
      === JSON.stringify(['--ozone-platform=x11', u]), 'ok');
  check('X-8 openPlan other 引擎（Safari/snap 包装器）在非 win32 交回调度器（裸 URL 参数语义不确定）',
    ko.via === 'dispatcher' && ko.bin === 'open' && ko.engine === 'other', JSON.stringify(ko));
  check('X-8 openPlan win32 对 other 引擎仍直启（那里没有调度器；引擎不明只等于不可取证，不等于不能试）',
    br.openPlan('win32', u, { inventory: invOf([brow('C:\\Tools\\weirdbrowser.exe')]) }).via === 'browser', 'ok');
  // 裸 URL 直启可被既有实例吸收：本次进程的退出码属于「转交动作」，不属于那个窗口，故两向都不作证据。
  check('X-8 直启浏览器一律 exitIsEvidence:false（win32/linux 同判，不按平台分叉）',
    kl.exitIsEvidence === false && kw.exitIsEvidence === false, JSON.stringify([kl.exitIsEvidence, kw.exitIsEvidence]));
  check('X-8 证据规则只在 ownsItsWindow 一处：隔离窗口=恒真，三端调度器=非 win32，两种浏览器形态=恒 false',
    br.ownsItsWindow('isolated', 'linux') === true
    && br.ownsItsWindow('isolated', 'win32') === true
    && br.ownsItsWindow('dispatcher', 'linux') === true
    && br.ownsItsWindow('dispatcher', 'darwin') === true
    && br.ownsItsWindow('dispatcher', 'win32') === false
    && br.ownsItsWindow('browser', 'win32') === false
    && br.ownsItsWindow('browser', 'linux') === false, 'ok');
  check('X-8 反向：win32 若重新出现「调度器可取证」会被上面那条判据识别（旧 explorer.exe 档即此症）',
    br.ownsItsWindow('dispatcher', 'win32') === false && knone.exitIsEvidence === false, 'hit');
  check('X-8 反向：旧字段名 trustExit 已从计划产物里消失（改名不是装饰 —— 它说的是双向可信）',
    [kl, kw, knone, kmany, ko].every((p) => p.trustExit === undefined), JSON.stringify(knone));
  check('X-8 反向：把 url 拼进 shell 字符串的旧形态不在任何计划的产物里（argv 永不裹 shell）',
    [kl, kw, knone, kmany, ko].every((p) => !/^\s*(cmd|sh)\b/.test(String(p.bin)) && !/&/.test(String(p.bin))), 'clean');

  // —— 隔离计划：与 openPlan 同一份探测输入，同一个默认项（否则系统默认只对一半功能生效）——
  const pc = br.isolatedPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome', { baseArgs: [] })]), profileDir: '/P', size: [1280, 800], lang: 'zh-CN' });
  check('X-8 隔离计划（chromium）= 默认浏览器直启：incognito + user-data-dir + size/lang + url 收尾，无 cmd',
    pc.bin === '/usr/bin/google-chrome' && pc.isolated === true && pc.watch === true && pc.envKind === 'anti'
    && JSON.stringify(pc.args) === JSON.stringify(['--incognito', '--user-data-dir=/P', '--window-size=1280,800', '--lang=zh-CN',
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', u]),
    JSON.stringify(pc.args));
  const pf = br.isolatedPlan('linux', u, { inventory: invOf([brow('/usr/lib/firefox/firefox')]), profileDir: '/P' });
  check('X-8 隔离计划（firefox）= --no-remote --profile <tmp> -private-window（新实例，退出可监听）',
    pf.isolated === true && JSON.stringify(pf.args) === JSON.stringify(['--no-remote', '--profile', '/P', '-private-window', u]),
    JSON.stringify(pf.args));
  const ps = br.isolatedPlan('darwin', u, { inventory: invOf([brow('/Applications/Safari.app/Contents/MacOS/Safari')]), profileDir: '/P' });
  check('X-8 Safari 默认 = open 非隔离兜底（isolated:false/watch:false），不再强拉其他内核',
    ps.bin === 'open' && ps.isolated === false && ps.watch === false && JSON.stringify(ps.args) === JSON.stringify([u]), JSON.stringify(ps));
  const pn = br.isolatedPlan('win32', u, { inventory: invOf([]), profileDir: '/P' });
  check('X-8 win32 解析不到浏览器 = 隔离计划 bin:null（由预检如实报 no-launcher，不再 explorer.exe 兜底）',
    pn.bin === null && pn.isolated === false, JSON.stringify(pn));
  const pg = br.isolatedPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome')]) });
  check('X-8 反向：chromium 但缺 profileDir 不冒充隔离（退回非隔离，防并入既有实例后 onExit 恒误报）',
    pg.isolated === false && pg.bin === '/usr/bin/google-chrome', JSON.stringify(pg));
  const pb = br.isolatedPlan('linux', u, { inventory: invOf([brow('brave-browser', { baseArgs: ['--ozone-platform=x11'] })]), profileDir: '/P' });
  check('X-8 desktop baseArgs 原样带入（隔离参数在其后、url 收尾；无 size/lang 则不发对应参数）',
    JSON.stringify(pb.args) === JSON.stringify(['--ozone-platform=x11', '--incognito', '--user-data-dir=/P',
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', u]), JSON.stringify(pb.args));
  const pbn = br.isolatedPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe')]), profileDir: '/P' });
  check('X-8 win32 隔离计划与 openPlan 同一本体（登录窗口与外部打开不得是两个浏览器）',
    pbn.bin === 'C:\\Edge\\msedge.exe' && pbn.isolated === true && pbn.watch === true, JSON.stringify(pbn));
  // 隔离形态的退出码从此双向可证：独立 profile 必为新实例，其 0 退出即窗口确实起过、非 0 即没起。
  //   旧形态的登录路径只能报到 handedOff，用户关了窗口只剩超时可言。
  check('X-8 隔离计划自带取证档位：via=isolated 且 exitIsEvidence=true，降级路径两向皆 false',
    pc.via === 'isolated' && pc.exitIsEvidence === true && pf.via === 'isolated' && pf.exitIsEvidence === true
    && pbn.via === 'isolated' && pbn.exitIsEvidence === true
    && pg.exitIsEvidence === false && pg.via === 'browser' && pg.envKind === 'sys'
    && ps.exitIsEvidence === true && ps.via === 'dispatcher' && pn.exitIsEvidence === false && pn.label === null, JSON.stringify([pg, ps]));
  check('X-8 隔离计划与 openPlan 同一份分发依据：偏好/次序在登录窗口同样生效',
    br.isolatedPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]), preference: 'c:\\ff\\firefox.exe', profileDir: '/P' }).pick === 'user-preference'
    && br.isolatedPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]) }).bin === 'C:\\Edge\\msedge.exe', 'ok');

  // —— 诊断面：每次打开都带上「系统里探到了什么」，真机报障不必再回去读代码 ——
  {
    const manyInv = invOf([brow('C:\\Edge\\msedge.exe', { name: 'msedge' }), brow('C:\\FF\\firefox.exe', { name: 'firefox' })], 'c:\\ff\\firefox.exe', 'userchoice');
    const dg = br.launchDiagnostics(manyInv, kmany, env.pickLauncher('win32', manyInv, null));
    check('X-8 诊断带全部候选/默认项来源/probed 留痕（no-launcher 档也要能定性）',
      dg.pick === 'userchoice' && dg.found.length === 2 && dg.found.every((f) => f.name && f.engine && f.via)
      && JSON.stringify(dg.default) === JSON.stringify({ id: 'c:\\ff\\firefox.exe', source: 'userchoice' })
      && dg.probed.length === 1, JSON.stringify(dg));
    // 偏好是分发依据的一部分，不是探测清单的一部分：诊断里的偏好面由 pick 的 wanted/stale 得出，
    //   于是「你选的」与「这次用的」对不上时只有一处口径（清单本身不带偏好字段，探测层不该知道被越过）。
    check('X-8 诊断带偏好面（无偏好=null；命中与失效由同一次分发依据定出，不在界面侧另算一遍）',
      dg.preference === null
      && JSON.stringify(br.launchDiagnostics(manyInv, kmany, env.pickLauncher('win32', manyInv, 'c:\\ff\\firefox.exe')).preference)
        === JSON.stringify({ id: 'c:\\ff\\firefox.exe', matched: true })
      && JSON.stringify(br.launchDiagnostics(manyInv, kmany, env.pickLauncher('win32', manyInv, 'c:\\gone\\x.exe')).preference)
        === JSON.stringify({ id: 'c:\\gone\\x.exe', matched: false }), JSON.stringify(dg));
    check('X-8 反向：空清单的诊断仍是空清单（把「没探到」写成「探到 0 个」才是可定性的答案）',
      JSON.stringify(br.launchDiagnostics(invOf([]), knone, env.pickLauncher('win32', invOf([]), null)).found) === '[]', 'ok');
  }
}

// -- X-5：反向（判据必须能识别宿主泄漏与静默误声明）--
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

// -- X-9 条 3/4 —— 可执行位判定 + spawn 前可用性预检 --
{
  // isExecutableFile 本体
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
  // pidlookup ss 候选预检（linuxFindSs 要求宿主=linux，注入平台伪造无效 -> 静态判据）
  const ssSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup', 'probe.js'), 'utf8');
  check('X-9 条3 linuxFindSs 绝对路径候选先判执行位（EACCES 不再白耗一轮 spawn）',
    /if \(ssBin\.includes\('\/'\) && !isExecutableFile\(ssBin\)\) continue;/.test(ssSrc), '有');
  check('X-9 条3 裸名候选保留交 execFile 的 PATH 解析（预检不扩大）',
    /candidates = \['ss',/.test(ssSrc), 'ok');

  // 隔离登录的行为判据不在此处：它与普通打开现在是同一个出口（openBrowser 的 intent），
  //   判据一并收在 X-10（那条链是异步的，同步块里等不到结局）。此处只留纯函数侧的预检判据。
  const brSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'), 'utf8');
  check('X-8 反向：平台层源码不再指定任何浏览器内核（无 Google Chrome 硬编码/无候选链/findChromeWin 已除名）',
    !/Google Chrome/.test(brSrc) && !/microsoft-edge/.test(brSrc) && !/chromium-browser/.test(brSrc)
    && !/findChromeWin/.test(brSrc), 'clean');
  check('X-9 条4 预检分形态：绝对路径判执行位、裸名走 PATH 解析',
    /if \(bin\.includes\('\/'\) \|\| bin\.includes\('\\\\'\) \|\| \/\^\[A-Za-z\]:\[\\\\\/\]\/\.test\(bin\)\) return isExecutableFile\(bin\);/.test(brSrc)
    && /return resolveExecutable\(bin\) !== null;/.test(brSrc), '有');
  check('X-9 条4 error 处理器不再递归接力（降级判定已前移到 spawn 前）',
    /child\.on\('error', \(\) => \{\}\);/.test(brSrc) && !/child\.on\('error', \(\) => \{ tryNext\(\); \}\);/.test(brSrc), '有');
}

function finish() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

// -- X-10：openBrowser 的三档结果语义（confirmed / handedOff / ok:false）--
// 为什么必须异步判定：ENOENT 只在子进程的 error 事件里出现，spawn 返回时一切「看起来正常」——
//   旧形态同步 return true 等于把「命令没报错」当成「页面已打开」，正是面板显示成功而屏幕
//   什么都没有的病根。故本组跑在尾部汇总之前，且用注入的 spawn/observe/binAvailable/desktopAvailable
//   做到宿主无关（CI 机器绝不真起浏览器）。
async function x10() {
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  const u = 'http://127.0.0.1:28111/open?code=c1';
  const spawned = [];
  const okSpawn = (bin, args) => { spawned.push([bin, args]); return { fake: true }; };
  const obs = (spec) => async () => spec;
  const EX_OK = { stage: 'exit', code: 0, signal: null };

  // 结果词汇的不变量：字段集合固定、三档互斥、失败必带 reason 与文案。
  const KEYS10 = ['ok', 'confirmed', 'handedOff', 'reason', 'error', 'message', 'url', 'evidence'];
  function vocabOk(r) {
    if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(KEYS10.slice().sort())) return '字段集不符: ' + Object.keys(r).join(',');
    if (r.ok !== (r.reason === null)) return 'ok/reason 互斥被破坏';
    if (r.ok && r.confirmed === r.handedOff) return 'confirmed/handedOff 必须恰好一个为真';
    if (!r.ok && (typeof r.error !== 'string' || !r.error)) return '失败必须带给用户的一句话';
    if (r.ok && !r.message) return '成功必须带文案';
    if (!r.ok && r.message !== null) return '失败不得带成功文案';
    return null;
  }

  // 每条用例都把探测清单钉成显式输入，并把「实际走了哪条形态」纳入判据。
  //   不钉就会去探宿主的真实浏览器（ubuntu runner 上装着 google-chrome-stable），用例名说「调度器」、
  //   实际跑的是直启浏览器，改证据规则前这种漂移是静默通过的（本轮 CI 才把它照红）。
  //   漂移本身是真缺陷：一条说自己测 xdg-open 的用例，结论却来自 chrome 的退出码。
  const B = (bin) => ({ id: String(bin).toLowerCase(), name: String(bin).split(/[\\/]/).pop(), engine: br.detector.engineOf(bin), bin, sources: ['fixture'] });
  const IN = (list, defId, defSource) => ({ platform: 'fixture', browsers: list, defaultId: defId || null,
    defaultSource: defSource || null, probed: [{ source: 'fixture', detail: list.length + ' 项' }] });
  const NO_INV = IN([]);
  const EDGE_WIN = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const cases = [
    ['linux 调度器 0 退出 -> confirmed', u, { platform: 'linux', inventory: NO_INV, observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === true && r.handedOff === false, ['dispatcher', 'xdg-open']],
    // Windows 真机踩过的两种病：一是 explorer.exe 冒开（返回码不携带信息，现场返回 1 却什么都没打开），
    //   二是据此判红/判绿。现在 Windows 只剩直启探测解析出的本体，其退出码两个方向都不作证据。
    ['win32 探到 msedge 非 0 退出 -> handedOff（真机报错的那条路：不可信形态的非 0 不判失败）', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN)]), observe: obs({ stage: 'exit', code: 1, signal: null }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.handedOff === true && r.reason === null && r.evidence.exitCode === 1
        && r.evidence.engine === 'chromium' && r.evidence.ownsWindow === false,
      ['browser', EDGE_WIN]],
    ['win32 探到 msedge 0 退出 -> 仍只到 handedOff（直启可被既有实例吸收，0 不算窗口出现过）', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN)]), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === false && r.handedOff === true && r.evidence.via === 'browser',
      ['browser', EDGE_WIN]],
    ['解析到 chromium 直启 0 退出 -> handedOff（不再冒领 confirmed）', u,
      { platform: 'linux', inventory: IN([B('/usr/bin/google-chrome')]), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === false && r.evidence.bin === '/usr/bin/google-chrome'
        && r.evidence.ownsWindow === false, ['browser', '/usr/bin/google-chrome']],
    ['窗口内子进程仍存活 -> handedOff（不宣称失败也不宣称成功）', u,
      { platform: 'darwin', inventory: NO_INV, observe: obs({ stage: 'alive' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.handedOff === true && r.evidence.exitCode === null, ['dispatcher', 'open']],
    // exitIsEvidence 只说明「这种形态的退出可当证据」，不说明「没退出也可当证据」：
    //   linux 上同样存活必须落 handedOff，否则该判据退化成「按平台无脑报成功」。
    //   此处的 ownsWindow 断言是这条用例的全部意义：可信形态 + 无退出 = 依旧不算证据。
    ['linux 窗口内仍存活 -> 依旧 handedOff（证据规则不能替无证据背书）', u,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'alive' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === false && r.handedOff === true && r.evidence.ownsWindow === true,
      ['dispatcher', 'xdg-open']],
    ['error 事件（ENOENT）-> ok:false/spawn-failed', u,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'error', code: 'ENOENT' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === false && r.reason === 'spawn-failed' && r.evidence.error === 'ENOENT', ['dispatcher', 'xdg-open']],
    ['可信形态非 0 退出 -> ok:false/exit-nonzero（带退出码；证据规则没砍掉真失败信号）', u,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'exit', code: 3, signal: null }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === false && r.reason === 'exit-nonzero' && /3/.test(r.error) && r.evidence.ownsWindow === true,
      ['dispatcher', 'xdg-open']],
    ['可信形态信号终止 -> ok:false/killed-by-signal', u,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'exit', code: null, signal: 'SIGKILL' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === false && r.reason === 'killed-by-signal' && r.evidence.exitSignal === 'SIGKILL',
      ['dispatcher', 'xdg-open']],
    // 每一次打开都带探测留痕：面板显示 handedOff/失败时，用户与开发者都要能看到「探到了什么、据什么定的默认」。
    //   判据只覆盖标题所列四项：platform/bin 已退役（界面没有读者，X-14 反向样本正钉着它们不得回流），
    //   在这里继续断言等于要执行口把无人读的键养回来 —— 两项断言留一条即自相矛盾。
    ['证据必带探测诊断（pick/found/probed/default 四项在场，否则真机无从定性）', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')], 'c:\\ff\\firefox.exe', 'userchoice'), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => {
        const d = r.evidence && r.evidence.diagnostics;
        return !!d && d.pick === 'userchoice' && d.found.length === 2
          && d.found.every((f) => f.name && f.engine && f.via === 'fixture')
          && !!d.default && d.default.source === 'userchoice' && d.probed.length === 1;
      }, ['browser', 'C:\\FF\\firefox.exe']],
    // 真机形状：装了多个浏览器，而系统说不出默认（UserChoice 读不到）。旧实现在此判 no-launcher，
    //   用户看到的症状是「点一键登录什么都没弹」。现在这一档必须真的开窗，且把依据摊进证据。
    ['win32 多候选且系统说不出默认 = 按候选次序直启，依据留在证据里（不再 no-launcher 死路）', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')]), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.evidence.via === 'browser' && r.evidence.bin === EDGE_WIN
        && r.evidence.diagnostics.pick === 'candidate-rank' && r.evidence.diagnostics.preference === null,
      ['browser', EDGE_WIN]],
    // 浏览器选择权在用户：在产品里选过一次的，普通打开与登录窗口都得听它的，且压过系统默认。
    ['偏好命中压过系统默认：启动用户选的那个，诊断记 user-preference/matched:true', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')], EDGE_WIN.toLowerCase(), 'userchoice'),
        preference: 'c:\\ff\\firefox.exe', observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.evidence.bin === 'C:\\FF\\firefox.exe'
        && r.evidence.diagnostics.pick === 'user-preference'
        && JSON.stringify(r.evidence.diagnostics.preference) === JSON.stringify({ id: 'c:\\ff\\firefox.exe', matched: true }),
      ['browser', 'C:\\FF\\firefox.exe']],
    // 偏好所指被卸载：可以回落（否则一次卸载就把功能打死），但必须在面板上说得出来 ——
    //   「你选的火狐已经不在了」与「按系统默认开的」是两件事，静默换人等于把选择权收回产品。
    //   defaultId 恒为候选条目之一的 id（探测层契约，见 X-8 同源那条），夹具不能自己造一个清单外的默认。
    ['偏好所指已不在候选里 = 回落系统默认并交出 matched:false（不静默换人）', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')], EDGE_WIN.toLowerCase(), 'userchoice'),
        preference: 'c:\\gone\\firefox.exe', observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.evidence.bin === EDGE_WIN && r.evidence.diagnostics.pick === 'userchoice'
        && JSON.stringify(r.evidence.diagnostics.preference) === JSON.stringify({ id: 'c:\\gone\\firefox.exe', matched: false }),
      ['browser', EDGE_WIN]],
  ];
  for (const [name, url, opts, judge, form] of cases) {
    // 每档结局都要落且只落一行日志：白窗/无弹窗在界面上没有任何线索，日志是唯一可取证的现场，
    //   而逐档重复刷（或整条链路一句都没有）都等于没有。
    const rows = [];
    const lg = { info: (m) => rows.push(String(m)), warn: (m) => rows.push(String(m)) };
    const r = await br.openBrowser(url, Object.assign({}, opts, { logger: lg }));
    const got = r.evidence ? [r.evidence.via, r.evidence.bin] : [];
    const formOk = !form || (got[0] === form[0] && (!form[1] || got[1] === form[1]));
    check('X-10 ' + name, judge(r) && vocabOk(r) === null && formOk && rows.length === 1,
      (vocabOk(r) || '') + (formOk ? '' : '形态漂移，实走 ' + got.join('/') + ' ') +
      (rows.length === 1 ? '' : '日志行数=' + rows.length + ' ') + JSON.stringify(r));
  }

  // 日志不是令牌的家：普通打开传的就是带 ?token= 的本机地址，argv 摘要必须截掉查询串与片段，
  //   同时留住 origin+path —— 整条抹掉等于把「开的到底是哪个地址」这个取证点也一起抹了。
  {
    const rows = [];
    const lg = { info: (m) => rows.push(String(m)), warn: (m) => rows.push(String(m)) };
    const r = await br.openBrowser('http://127.0.0.1:28111/?token=AbC123def-456',
      { platform: 'linux', inventory: NO_INV, observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true, logger: lg });
    const line = rows[0] || '';
    check('X-10 带令牌地址仍恰落一行', rows.length === 1 && r.ok === true, JSON.stringify(rows));
    check('X-10 令牌值不入日志', !/AbC123def-456/.test(line), line);
    check('X-10 查询串整体截掉（不止令牌那一个键）', !/\?token=/.test(line), line);
    check('X-10 地址主体仍留在日志里可比对', /127\.0\.0\.1:28111/.test(line), line);
    check('X-10 日志写明档位与分发依据', /\[open\] intent=plain via=dispatcher.*=> confirmed/.test(line), line);
  }

  // 失败路径必须**零 spawn**：预检不过还起进程 = 把必死命令交给系统，且面板无从解释。
  //   no-launcher 档还要额外钉诊断在场：没有它，「为什么没弹出来」在界面上就只剩一句「再点一次」。
  const zero = [
    ['非 http(s) 地址（file:///）', 'file:///c:/windows/system32/calc.exe', { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true }, 'unsafe-url'],
    ['空地址', '', { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true }, 'unsafe-url'],
    ['未知平台 freebsd：档位说不开就显式失败（openCommand 仍会试 xdg-open，那是低层映射）', u,
      { platform: 'freebsd', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK) }, 'unsupported-platform'],
    ['linux 无图形会话', u, { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true, desktopAvailable: () => false }, 'no-desktop-session'],
    ['启动命令不在 PATH', u, { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => false }, 'no-launcher'],
    // Windows 真机的原始症状：读不到默认浏览器时旧形态退 explorer.exe 冒开（ok:true + 屏幕上什么都没有）。
    //   现在必须显式失败，且把探测留痕一起交出。
    ['win32 探测清单为空 = 选不出启动对象', u,
      { platform: 'win32', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK) }, 'no-launcher'],
  ];
  for (const [name, url, opts, reason] of zero) {
    spawned.length = 0;
    const r = await br.openBrowser(url, opts);
    const diagOk = reason !== 'no-launcher'
      || (!!r.evidence && !!r.evidence.diagnostics && Array.isArray(r.evidence.diagnostics.found)
        && r.evidence.diagnostics.probed.length === 1);
    check('X-10 反向（零 spawn）：' + name + ' -> ' + reason,
      r.ok === false && r.reason === reason && spawned.length === 0 && r.url === url && diagOk,
      'spawn ' + spawned.length + ' 次 ' + JSON.stringify(r));
  }
  // 探测层自身的意外（注册表被拒）已经退化成空清单 + probe-error 留痕（X-8 钉过），
  //   这里钉的是消费侧：这样的清单走到 no-launcher 档时，留痕必须还在证据里，否则等于没报根因。
  spawned.length = 0;
  const rProbeErr = await br.openBrowser(u, {
    platform: 'win32', spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK),
    resolveInventory: () => ({ platform: 'win32', browsers: [], defaultId: null, defaultSource: null, probed: [{ source: 'probe-error', detail: 'reg 被拒' }] }),
  });
  check('X-10 探测意外退化为空清单后仍走 no-launcher 档，且 probe-error 留痕抵达证据',
    rProbeErr.ok === false && rProbeErr.reason === 'no-launcher' && rProbeErr.url === u && spawned.length === 0
      && JSON.stringify(rProbeErr.evidence.diagnostics.probed) === JSON.stringify([{ source: 'probe-error', detail: 'reg 被拒' }]),
    JSON.stringify(rProbeErr));
  // spawn 同步抛错 / 返回 null 都不是「成功」
  spawned.length = 0;
  const rThrow = await br.openBrowser(u, { platform: 'linux', inventory: NO_INV, binAvailable: () => true, spawn: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  check('X-10 spawn 同步抛错 -> ok:false/spawn-failed（旧形态会把它冒成成功）',
    rThrow.ok === false && rThrow.reason === 'spawn-failed' && rThrow.evidence.error === 'EACCES', JSON.stringify(rThrow));
  const rNull = await br.openBrowser(u, { platform: 'linux', inventory: NO_INV, binAvailable: () => true, spawn: () => null });
  check('X-10 spawn 返回空句柄 -> ok:false/spawn-failed', rNull.ok === false && rNull.reason === 'spawn-failed', JSON.stringify(rNull));
  // url 恒在场：面板靠它在任何一档下都能给出可复制地址
  const rUrl = await br.openBrowser(u, { platform: 'linux', inventory: NO_INV, observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true });
  check('X-10 结果必须原样带回 url（面板据此在 handedOff 档也能给出地址）', rUrl.url === u, JSON.stringify(rUrl.evidence));

  // —— observeSpawn 本体：真实 EventEmitter + 假时钟，不依赖宿主 ——
  const { EventEmitter } = require('node:events');
  const fireExit = (code, signal) => { const e = new EventEmitter(); const p = br.observeSpawn(e, 5000, () => ({ unref() {} })); e.emit('exit', code, signal); return p; };
  const o1 = await fireExit(0, null);
  check('X-10 observeSpawn：exit 先到即定局（stage/码/信号如实带出）',
    o1.stage === 'exit' && o1.code === 0 && o1.signal === null, JSON.stringify(o1));
  const o2 = await (async () => {
    const e = new EventEmitter();
    const p = br.observeSpawn(e, 5000, () => ({ unref() {} }));
    e.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    e.emit('exit', 0, null); // 后到的第二个事件必须被忽略
    return p;
  })();
  check('X-10 observeSpawn：先到者定局，后到事件不得翻案（error 后 emit exit 仍判 error）',
    o2.stage === 'error' && o2.code === 'ENOENT', JSON.stringify(o2));
  let armed = null;
  let unrefed = 0;
  const e3 = new EventEmitter();
  const p3 = br.observeSpawn(e3, 1234, (fn) => { armed = fn; return { unref() { unrefed++; } }; });
  armed();
  const o3 = await p3;
  check('X-10 observeSpawn：窗口内无事件 -> stage:alive（既不判成功也不判失败，交回 handedOff）',
    o3.stage === 'alive' && o3.code === undefined, JSON.stringify(o3));
  check('X-10 observeSpawn 的计时句柄被 unref（观测不得拖住进程退出）', unrefed === 1, 'unref=' + unrefed);

  // —— 一键登录的隔离窗口：与普通打开同一个出口（intent 定形态），故同一套判据逐条适用 ——
  //   注入 observe 而不是依赖真实的 1500ms 窗口：登录那条链的结局由子进程事件决定，等真事件会让用例
  //   随宿主负载漂移（CI 上曾出现同一份代码两种档位）。
  //   出网判定同样必须钉成夹具：隔离档现在会问 environment.checkEgress，不注入就是 CI 真摸网
  //   （DNS + TLS 到 127.0.0.1:28111），既慢又随宿主网络漂移。降档路径由 X-13 逐条钉。
  const EG_OK = { at: 1, proxy: { state: 'unknown', source: 'fixture' },
    targets: { '127.0.0.1': { ok: true, stage: 'tls', detail: 'fixture', at: 1 } }, probed: [] };
  {
    const chromeInv = IN([B('/usr/bin/google-chrome')]);
    const removed = [];
    let isoSpawnArgs = null, isoEnv = null, isoOnExit = 'unset';
    const onExit = () => {};
    const isoSpawn = (bin, args, env, cb) => { spawned.push([bin, args]); isoSpawnArgs = args; isoEnv = env; isoOnExit = cb; return { fake: true }; };
    const li = await br.openBrowser(u, {
      platform: 'linux', inventory: chromeInv, intent: 'isolated-login', observe: obs(EX_OK), egress: EG_OK,
      spawn: isoSpawn, binAvailable: () => true, allocProfile: () => '/P', rmTree: (p, ms) => removed.push([p, ms]),
      profileMs: 5000, onExit, rand: () => 0,
    });
    check('X-10 隔离登录同词汇同档位：独立 profile 必为新实例，0 退出即 confirmed（登录窗口的退出码双向可证）',
      vocabOk(li) === null && li.ok === true && li.confirmed === true && li.handedOff === false
        && li.evidence.via === 'isolated' && li.evidence.isolated === true && li.evidence.watch === true
        && li.evidence.ownsWindow === true && li.evidence.profile === '/P' && li.url === u,
      JSON.stringify(li));
    // argv 的形状是本层的契约（先隔离方言、再随机化外观、url 收尾）；具体取值取自池子，不在此钉死。
    const ia = isoSpawnArgs || [];
    check('X-10 隔离登录的 argv 走隔离方言：--incognito + user-data-dir 开头，外观参数居中，url 收尾',
      ia[0] === '--incognito' && ia[1] === '--user-data-dir=/P'
        && /^--window-size=\d+,\d+$/.test(ia[2]) && /^--lang=[A-Za-z-]+$/.test(ia[3])
        && ia.slice(4, 7).join(',') === '--no-first-run,--no-default-browser-check,--disable-session-crashed-bubble'
        && ia[ia.length - 1] === u, JSON.stringify(ia));
    check('X-10 环境档用反指纹面（TZ 与 argv 里的 --lang 同源注入，域侧不自己拼一份）',
      (() => {
        const m = /^--lang=([A-Za-z-]+)$/.exec(ia[3] || '');
        return !!m && !!isoEnv && isoEnv.LANG === m[1] && typeof isoEnv.TZ === 'string' && !!isoEnv.TZ;
      })(), JSON.stringify([isoEnv && isoEnv.TZ, ia[3]]));
    check('X-10 只在 watch 形态将关闭回调接到 spawn（并入既有实例时 onExit 恒误报，宁可不接）',
      isoOnExit === onExit, String(isoOnExit));
    check('X-10 隔离登录成功后延迟回收临时 profile（一次登录留一个目录 = 磁盘上的孤儿）',
      JSON.stringify(removed) === JSON.stringify([['/P', 5000]]), JSON.stringify(removed));
    check('X-10 隔离登录也带探测诊断（登录页打不开时，面板同样要能说明本机探到了什么）',
      !!li.evidence.diagnostics && li.evidence.diagnostics.found.length === 1
        && li.evidence.diagnostics.pick === 'only-installed', JSON.stringify(li.evidence.diagnostics));
    // 出网判定必须原样进证据：降档与否的定性靠这一份，只留在内核日志就等于界面上无从解释。
    check('X-10 隔离登录的证据带出网判定结论（basis/host/viable 三项在场）',
      !!li.evidence.egress && li.evidence.egress.basis === 'target-reachable'
        && li.evidence.egress.viable === true && li.evidence.egress.host === '127.0.0.1',
      JSON.stringify(li.evidence.egress));
    // 降级路径：Safari 无隔离方言，走调度器并入既有窗口，此时绝不能声称隔离、也不能挂 onExit。
    spawned.length = 0; isoOnExit = 'unset';
    const ld = await br.openBrowser(u, {
      platform: 'darwin', inventory: NO_INV, intent: 'isolated-login', observe: obs({ stage: 'alive' }), egress: EG_OK,
      spawn: (b, a, e, cb) => { isoOnExit = cb; return { fake: true }; }, binAvailable: () => true, profileMs: 5000, onExit,
    });
    check('X-10 隔离登录降级如实（无可信调度器/无方言时 isolated:false、只到 handedOff、不挂 onExit）',
      vocabOk(ld) === null && ld.ok === true && ld.confirmed === false && ld.handedOff === true
        && ld.evidence.isolated === false && ld.evidence.profile === null && ld.evidence.watch === false
        && ld.evidence.via === 'dispatcher' && isoOnExit === undefined, JSON.stringify(ld));
    // 预检不过 = 零 spawn 且回收已分配目录（旧形态：登录绕开档位/会话判据，且失败即留孤儿目录）。
    spawned.length = 0; removed.length = 0;
    const ln = await br.openBrowser(u, {
      platform: 'linux', inventory: chromeInv, intent: 'isolated-login', spawn: okSpawn, egress: EG_OK,
      binAvailable: () => false, desktopAvailable: () => false, allocProfile: () => '/P', rmTree: (p, ms) => removed.push([p, ms]),
    });
    check('X-10 隔离登录吃同一套预检：无图形会话即 no-desktop-session，零 spawn 且已分配的 profile 被回收',
      vocabOk(ln) === null && ln.ok === false && ln.reason === 'no-desktop-session' && spawned.length === 0
        && ln.url === u && typeof ln.error === 'string' && JSON.stringify(removed) === JSON.stringify([['/P', 0]]),
      JSON.stringify([ln, removed]));
    const lb = await br.openBrowser('file:///etc/passwd', { platform: 'linux', intent: 'isolated-login', binAvailable: () => true, spawn: okSpawn });
    check('X-10 隔离登录失败也带 reason/url/error（旧形态只给 ok:false，面板无从解释）',
      vocabOk(lb) === null && lb.ok === false && lb.reason === 'unsafe-url' && typeof lb.error === 'string', JSON.stringify(lb));
    // 偏好对登录窗口同样作数：用户在面板里选一次，两条路都得跟着，否则「选过」只对一半功能生效。
    spawned.length = 0;
    const lp = await br.openBrowser(u, {
      platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')]), preference: 'c:\\ff\\firefox.exe',
      intent: 'isolated-login', observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true, allocProfile: () => '/P', rmTree: () => {},
      egress: EG_OK,
    });
    check('X-10 隔离登录与直启共用分发依据：偏好命中即 firefox 的 --no-remote --profile 形态',
      lp.ok === true && lp.evidence.bin === 'C:\\FF\\firefox.exe' && lp.evidence.isolated === true
        && lp.evidence.diagnostics.pick === 'user-preference', JSON.stringify(lp.evidence));
  }
}

// -- X-11：唯一出口的源码级不变量 --
{
  const brRel = path.join(ROOT, 'src', 'platform', 'os', 'browser.js');
  const br = require(brRel);
  const src = fs.readFileSync(brRel, 'utf8');
  // 遍历 src/ 找外部打开动词的调用点：`browser.open(` / `browser.launchIsolated(` 一旦重现，
  //   说明又开了第二条路（意图是 openBrowser 的参数，不是第二个动词）。
  const walkSrc = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) walkSrc(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
  const files = walkSrc(path.join(ROOT, 'src'), []);
  const reOld = /browser\s*\.\s*(?:open|openExternal|launchIsolated)\s*\(/;
  const legacy = files.filter((f) => reOld.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('X-11 全仓 src/ 无第二条外部打开出口（browser.open 已收口）',
    legacy.length === 0, legacy.join(',') || ('扫描 ' + files.length + ' 个文件'));
  check('X-11 反向：判据能识别旧出口形态（否则本条恒绿）',
    reOld.test("function f(u) { return platform.browser.open(u); }")
      && reOld.test("const r = platform.browser.launchIsolated(u, { profileDir: p });"), 'hit');
  check('X-11 browser.js 只导出一个打开动词（launchIsolated 已被 intent 吸收，不得重现）',
    br.open === undefined && br.launchIsolated === undefined && br.openExternal === undefined
      && typeof br.openBrowser === 'function', Object.keys(br).join(','));
  const prof = require(path.join(ROOT, 'src', 'platform', 'os', 'capability-profile.js'));
  const declared = Object.keys(prof).filter((k) => prof[k].openBrowser === true).sort();
  check('X-11 档位表只声明三平台可外部打开（未知平台不开）',
    JSON.stringify(declared) === JSON.stringify(['darwin', 'linux', 'win32']), declared.join(','));

  // —— 分层归属：平台事实只写在探测层一处，别的文件一律不得再写第二份 ——
  //   为什么钉这一条：本轮 Windows 缺陷的根因不是某个分支写错，而是「系统里有什么浏览器」这件事
  //   从来没有一个唯一回答处 —— 选路层顺手查一次注册表、router 侧自己摸 X socket，两份副本必然漂移。
  const detRel = path.join(ROOT, 'src', 'platform', 'os', 'browser-inventory.js');
  //  允许的第二处只有一个：registry.js —— 它写的是 `reg query` 的**输出排版与键名回显**这一件事，
  //   且被探测层原样转出口消费；浏览器键的**取用与裁决**仍只在探测层。第三处（任何域自己查注册表）
  //   仍是违规，故反向样本照旧成立。
  const regRel = path.join(ROOT, 'src', 'platform', 'os', 'registry.js');
  const factRe = /StartMenuInternet|UrlAssociations|RegisteredApplications|App Paths|urlsForApplicationsToOpenURL|URLForApplicationToOpenURL|mimeapps|x-scheme-handler|xdg-settings/;
  const factFiles = files.filter((f) => f !== detRel && f !== regRel && factRe.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('X-11 浏览器探测的平台事实只在 browser-inventory.js 一处（全仓 src/ 零第二份）',
    fs.existsSync(detRel) && factFiles.length === 0, factFiles.join(',') || ('扫描 ' + files.length + ' 个文件'));
  check('X-11 反向：判据能识别探测事实散回选路层（旧 browser.js 里查注册表即此形态）',
    factRe.test("const v = ex.runOut('reg.exe', ['query', 'HKCU\\\\Software\\\\Clients\\\\StartMenuInternet']);"), 'hit');
  check('X-11 选路与执行层不做任何探测（不读文件系统、不查注册表；只消费探测层交来的清单）',
    !/require\('node:fs'\)|require\('\.\.\/util\/exec'\)|reg\.exe|osascript/.test(src)
    && /require\('\.\/browser-inventory'\)/.test(src), 'ok');
  const x11Re = /\.X11-unix|wayland-\\d/;
  const x11Files = files.filter((f) => x11Re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  check('X-11 图形会话探测只在 platform/os/desktop.js（router 侧摸 socket 的第二份副本必漂移）',
    JSON.stringify(x11Files) === JSON.stringify(['src/platform/os/desktop.js']), x11Files.join(',') || 'ok');
  check('X-11 反向：判据能识别域里自己摸 X socket 的形态',
    x11Re.test("const x11 = '/tmp/.X11-unix'; fs.readdirSync(x11)"), 'hit');
  check('X-11 执行口的图形会话判据与补齐全部委托 desktop.js（会话判据与补齐必须同源，否则一边说有、一边补不全）',
    /desktop\.sessionEnv\(\)/.test(src) && /desktop\.sessionAvailable/.test(src)
      && !/\.X11-unix|WAYLAND_DISPLAY/.test(src), 'ok');

  // 出口如何交到域手里也要有闸：网关只允许「缺省即平台层唯一出口、注入只服务于测试」这一种装配。
  //   否则调用方传个 deps.browser 就把外部打开换了实现，S-1 的唯一出口判据形同虚设。
  //   环境表单同一条装配路：它是动作面的事实来源，允许注入但不允许没有缺省。
  const gwSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'transport', 'server.js'), 'utf8');
  check('X-11 出口与环境表单由网关缺省装配并随 ctx 交出（无缺省即留第二出口位）',
    /const browser = \(deps && deps\.browser\) \|\| browserExit;/.test(gwSrc)
      && /const environment = \(deps && deps\.environment\) \|\| environmentExit;/.test(gwSrc)
      && /require\('\.\.\/\.\.\/platform\/os\/browser'\)/.test(gwSrc)
      && /require\('\.\.\/\.\.\/platform\/os\/environment'\)/.test(gwSrc)
      && /const ctx = \{[^}]*\bbrowser\b[^}]*\benvironment\b/.test(gwSrc), 'ok');
  const gwNoDefault = "  const browser = deps.browser;\n    const environment = deps.environment;\n    const ctx = { sup, req };";
  check('X-11 反向：判据能识别「deps 不给缺省」与「ctx 不带出口/表单」的装配形态',
    !/const browser = \(deps && deps\.browser\) \|\| browserExit;/.test(gwNoDefault)
      && !/const environment = \(deps && deps\.environment\) \|\| environmentExit;/.test(gwNoDefault)
      && !/const ctx = \{[^}]*\bbrowser\b[^}]*\benvironment\b/.test(gwNoDefault), 'hit');

  // 最后一环在面板：这里只钉运行判据看不见的那两件事 —— 新页面不许自己造窗口（window.open 唯一出口）
  //   与不许绕开统一入口自造成败说法（四个消费页必须走 runOpenExternal）。
  //   分档、选路、证据渲染本身由 ui 侧 vitest（externalOpen.test.ts）按行为判红，不在这里重复钉文案。
  //   为什么平台门禁要读到 ui/：这条能力的判据如果只覆盖内核，面板照样能把 handedOff 显示成成功；
  //   而链条长度已近 Windows cmd 上限（test-chain-completeness N-e），不允许再为它新设一个链条目。
  const readUi = (rel) => fs.readFileSync(path.join(ROOT, 'ui', 'src', rel), 'utf8');
  const uiJsx = [];
  const walkUi = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) walkUi(p); else if (/\.tsx?$/.test(f.name)) uiJsx.push(p); } };
  walkUi(path.join(ROOT, 'ui', 'src'));
  const reWinOpen = /window\.open\s*\(/;
  const openers = uiJsx.filter((f) => reWinOpen.test(fs.readFileSync(f, 'utf8')))
    // 相对路径按平台分隔符产出（win32 给反斜杠），与字面量比对前先归一。
    .map((f) => path.relative(path.join(ROOT, 'ui', 'src'), f).split(path.sep).join('/'));
  check('X-11 面板创建外部窗口只有一个出口（window.open 只允许在 externalOpen.ts）',
    JSON.stringify(openers) === JSON.stringify(['services/supervisor/externalOpen.ts']), openers.join(','));
  check('X-11 反向：判据能识别页面里裸 window.open（壳内 webview 会静默丢弃它，正是要钉的形态）',
    reWinOpen.test('function f(){ return window.open(u, "_blank"); }'), 'hit');
  const pages = ['features/supervisor/InstancesPage.tsx', 'features/supervisor/OverviewPage.tsx', 'features/supervisor/RouterPage.tsx', 'features/supervisor/LanPage.tsx']
    .filter((p) => !/runOpenExternal\(/.test(readUi(p)));
  check('X-11 四处外部打开入口都经统一入口消费结果（各自表述成败即病根）',
    pages.length === 0, pages.join(',') || 'ok');
  // 代开只有一条路：面板问内核。postMessage 桥那套（dsh:open-url）与 target=_blank 都在壳内 webview
  //   里静默失效过，留着就是第二套语义（回执有无、超时算成功与否各说各话）。
  const reBridge = /dsh:open-url/;
  const bridged = uiJsx.filter((f) => reBridge.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('X-11 面板不再经 postMessage 桥代开（dsh:open-url 在 ui/src 零出现）',
    bridged.length === 0, bridged.join(',') || ('扫描 ' + uiJsx.length + ' 个文件'));
  check('X-11 反向：判据能识别桥消息形态', reBridge.test('const T = "dsh:open-url";'), 'hit');
  const reBlank = /target="_blank"/;
  const blanked = uiJsx.filter((f) => reBlank.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('X-11 面板不用 target=_blank 开外部地址（壳内静默丢弃 = 死单击）',
    blanked.length === 0, blanked.join(',') || 'ok');
  check('X-11 反向：判据能识别锚点直开形态', reBlank.test('<a href={url} target="_blank">x</a>'), 'hit');
}

// -- X-12：环境表单与浏览器偏好的归属不变量 --
// 为什么不并进 X-8：X-8 判「一次分发选得对不对」，本条判「这张表由谁装配、谁能改它、改了会不会留下两份真相」。
//   Windows 那台机器的缺陷形态正是「问一处答两处」——面板显示候选、登录用另一个浏览器、失败原因写在第三个地方。
//   故本条钉的是结构：字段集、注入点数量、写入路径、动词数量。四项里任何一项松掉，上一层的行为判据都会变成摆设。
{
  const envRel = path.join(ROOT, 'src', 'platform', 'os', 'environment.js');
  const env = require(envRel);
  const envSrc = fs.readFileSync(envRel, 'utf8');
  const walkAll = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) walkAll(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
  const relOf = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const allFiles = walkAll(path.join(ROOT, 'src'), []);

  // 表单的输入全部来自注入与探测层：夹具化后本条在任意宿主上等价（不摸注册表、不读真机配置）。
  const fixtureInv = () => ({
    platform: 'fixture',
    browsers: [
      { id: 'b-firefox', name: 'Firefox', bin: '/usr/bin/firefox', engine: 'firefox', sources: ['fixture'] },
      { id: 'b-chrome', name: 'Chrome', bin: '/usr/bin/chrome', engine: 'chromium', sources: ['fixture'] },
    ],
    defaultId: null, defaultSource: null, probed: [{ source: 'fixture', detail: '2 项' }],
  });
  const FKEYS = ['at', 'browsers', 'cached', 'capabilities', 'default', 'identity', 'paths', 'pick',
    'platform', 'preference', 'probed', 'schema', 'sections', 'session', 'snapshot'];
  const saved = { home: process.env.DSH_SUPERVISOR_HOME, bound: Object.assign({}, env.bind()) };

  const f1 = env.form({ force: true, inventory: fixtureInv(), now: () => 111 });
  check('X-12 表单字段集固定（平台/身份/落点/会话/档位/偏好/系统默认/候选/分发依据/维度台账/留痕/快照/时戳/schema/缓存位）',
    JSON.stringify(Object.keys(f1).sort()) === JSON.stringify(FKEYS.slice().sort()), Object.keys(f1).join(','));
  check('X-12 反向：少一个面的表单不足以支撑后续分发（漏 pick、漏 identity 或漏维度台账必须判红，否则字段集是摆设）',
    (() => {
      const less = Object.assign({}, f1); delete less.pick;
      const lessSection = Object.assign({}, f1); delete lessSection.sections;
      const more = Object.assign({}, f1, { explorer: true });
      const k = JSON.stringify(FKEYS.slice().sort());
      return JSON.stringify(Object.keys(less).sort()) !== k && JSON.stringify(Object.keys(lessSection).sort()) !== k
        && JSON.stringify(Object.keys(more).sort()) !== k;
    })(), 'ok');
  check('X-12 每条结论带留痕来源，分发结论随行（section/source/detail 成对；pick 是后续动作的唯一依据）',
    ['browsers', 'session', 'capabilities', 'preference', 'pick'].every((s) => f1.probed.some((p) => p.section === s
      && typeof p.source === 'string' && typeof p.detail === 'string'))
      && f1.pick.how === 'candidate-rank' && f1.pick.id === 'b-chrome' && f1.preference.reason === 'not-set',
    JSON.stringify([f1.pick, f1.probed.map((p) => p.section)]));
  check('X-12 候选行经规整后交给面板与选路共用（engine 恒有值、isDefault 按系统默认标定、baseArgs 恒为数组）',
    f1.browsers.length === 2 && f1.browsers.every((b) => !!b.engine && Array.isArray(b.baseArgs)
      && typeof b.isDefault === 'boolean' && b.sources.length === 1)
      && f1.browsers.every((b) => b.isDefault === false), JSON.stringify(f1.browsers));
  // 未注入即如实标「未绑定」：能力档的实测覆写只住在 platform/os 门面，表单自造一份就是第二套真相。
  check('X-12 反向：能力矩阵未注入时不冒充档位（宁可报未绑定，也不给面板一个凭空的是/否）',
    f1.capabilities === null && /未绑定能力矩阵/.test(JSON.stringify(f1.probed)), JSON.stringify(f1.capabilities));

  // 偏好的判据住在表单：写入口可以有很多个，判据只能有一个。
  const cp = (v) => env.checkPreference(v, f1);
  check('X-12 偏好判据：命中候选=可写、空值=清除、非候选=拒写并给一句话（非字符串按空处理，不猜意图）',
    cp('b-firefox').ok === true && cp('b-firefox').browser.id === 'b-firefox'
      && cp('').ok === true && cp('').id === null && cp(null).id === null && cp(42).id === null
      && cp('nope').ok === false && typeof cp('nope').error === 'string' && cp('nope').browser === null
      && cp('nope').candidates.length === 2, JSON.stringify(cp('nope')));
  env.bind({ preference: () => 'b-firefox' });
  const f3 = env.form({ force: true, inventory: fixtureInv() });
  check('X-12 偏好经装配期注入即全局生效（调用点不传参：漏传一处就是一条静默降级路）',
    f3.preference.configured === true && f3.preference.matched === true && f3.preference.browser.id === 'b-firefox'
      && f3.pick.how === 'user-preference' && f3.pick.id === 'b-firefox' && f3.pick.stale === false,
    JSON.stringify(f3.pick));
  env.bind({ preference: () => 'b-gone' });
  const f4 = env.form({ force: true, inventory: fixtureInv() });
  check('X-12 偏好所指消失时表单自证 stale 并给出回落依据（不静默换人，也不静默不换）',
    f4.preference.reason === 'stale' && f4.preference.browser === null && f4.pick.stale === true
      && f4.pick.wanted === 'b-gone' && f4.pick.how === 'candidate-rank', JSON.stringify([f4.preference, f4.pick]));
  env.bind({ preference: saved.bound.preference, capabilities: saved.bound.capabilities });
  // 注入点数量必须钉死：多于两处 = 谁都能改写这张表；零处 = 表单在跑假数据。
  const bindFiles = allFiles.filter((f) => /environment\s*\.\s*bind\(/.test(fs.readFileSync(f, 'utf8'))).map(relOf).sort();
  check('X-12 上层事实的注入点恰好两处（能力档=platform/os 门面，偏好=app 组装期；platform 层禁止反向 require app/api）',
    JSON.stringify(bindFiles) === JSON.stringify(['src/app/assembly/compose/core.js', 'src/platform/os/index.js']),
    bindFiles.join(',') || ('扫描 ' + allFiles.length + ' 个文件'));
  check('X-12 反向：判据能识别在执行层现取偏好的形态（分层禁止，且绕过表单就是第二个口径）',
    /environment\s*\.\s*bind\(/.test("environment.bind({ preference: () => cfg.externalBrowser });"), 'hit');

  // 快照是给人回看的留痕，不是启动依赖：读路径绝不写盘，写路径只落进本产品状态目录。
  const home = path.join(TMP, 'x12-state');
  process.env.DSH_SUPERVISOR_HOME = home;
  const snapPath = env.snapshotPath();
  const fNoPersist = env.form({ force: true, inventory: fixtureInv() });
  check('X-12 读路径零写盘（面板轮询不在状态目录留副作用；快照只随人主动刷新落一次）',
    fNoPersist.snapshot.written === false && !fs.existsSync(snapPath) && fNoPersist.snapshot.path === snapPath,
    'exists=' + fs.existsSync(snapPath));
  const f2 = env.form({ force: true, persist: true, inventory: fixtureInv() });
  const bits = fs.statSync(snapPath).mode & 0o777;
  check('X-12 快照落在状态目录、带 schema、权限只给用户自己（win32 无 POSIX 权限位，退钉写侧传参）',
    snapPath === path.join(env.paths().supervisor, env.FILE_NAME) && f2.snapshot.written === true
      && (process.platform === 'win32' ? /\{ mode: 0o600 \}/.test(envSrc) : bits === 0o600)
      && env.readSnapshot().schema === env.SCHEMA, 'mode=' + bits.toString(8) + ' ' + snapPath);
  check('X-12 反向：无条件写盘的表单实现会被上面两条识别（读路径判据与写路径判据必须一假一真）',
    (() => {
      const unconditional = 'function form(o){ writeAtomic(snapshot.path, doc); }';
      return !/if \(ov\.persist === true\)/.test(unconditional) && /if \(ov\.persist === true\)/.test(envSrc);
    })(), 'hit');

  // 动词数量：意图是 openBrowser 的参数，不是第二个动词。旧补丁位（router/ops/browser.js）也不许留壳。
  const defRe = /(?:async\s+)?function\s+(openBrowser|openExternal|launchIsolated)\s*\(/;
  const defFiles = allFiles.filter((f) => defRe.test(fs.readFileSync(f, 'utf8'))).map(relOf).sort();
  check('X-12 全仓只有一处定义外部打开动词（两种意图共用 openBrowser）',
    JSON.stringify(defFiles) === JSON.stringify(['src/platform/os/browser.js']), defFiles.join(',') || '未找到定义处');
  check('X-12 反向：判据能识别域侧自造登录启动函数（router/ops/browser.js 旧形态即此）',
    defRe.test("async function openExternal(url, intent) {}") && defRe.test("function launchIsolated(url, o) {}"), 'hit');
  check('X-12 域侧的浏览器启动补丁文件已删除（留着补丁位就会被重新写回去）',
    !fs.existsSync(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'browser.js')), '仍在');
  // 选路只由交路表决定：pickLauncher 的定义与调用都不许逃出平台层，否则域又在自选浏览器。
  const pickFiles = allFiles.filter((f) => /pickLauncher\s*\(/.test(fs.readFileSync(f, 'utf8'))).map(relOf).sort();
  check('X-12 分发依据只在平台层一处定义、一处消费（域与 API 都不自己选浏览器）',
    JSON.stringify(pickFiles) === JSON.stringify(['src/platform/os/browser.js', 'src/platform/os/environment.js']),
    pickFiles.join(','));
  const setSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'settings', 'browser.js'), 'utf8');
  check('X-12 偏好落盘唯一入口（写前过表单判据、写后读回核验、本层不碰 fs）',
    (setSrc.match(/state\.persistConfigPatch\(/g) || []).length === 1
      && /const v = platform\.environment\.checkPreference\(id, form\);\s*\n\s*if \(!v\.ok\)/.test(setSrc)
      && /verifyPersisted\(this\.configPath, patch\)/.test(setSrc)
      && !/require\('node:fs'\)|fs\.writeFileSync/.test(setSrc), 'ok');
  check('X-12 改偏好必刷表单缓存（否则下一拍按旧偏好分发：面板显示新值、实际用旧浏览器）',
    /platform\.environment\.invalidate\(\)/.test(setSrc), 'ok');

  // 复位：注入的偏好、假状态根与表单缓存都不许留给后面的用例（残留会让 X-10 的无偏好档变成有偏好档）。
  if (saved.home === undefined) delete process.env.DSH_SUPERVISOR_HOME;
  else process.env.DSH_SUPERVISOR_HOME = saved.home;
  fs.rmSync(home, { recursive: true, force: true });
  env.invalidate();
}

// -- X-13：出网条件维度（分发依据从「哪个浏览器」升级为「哪个浏览器 + 这台机器往外走不走得出去」）--
//   三件事各自可红：冷档案可行性判据的真值表、L0 读数的三态分档、维度台账的注册契约。
//   本组一次都不摸网也不起子进程：通路判定吃注入的 lookup/connect，代理读数吃注入的 runner，
//   可行性结论吃注入的读数 —— 真机网络形状不由 CI 的宿主决定。
async function x13() {
  const env = require(path.join(ROOT, 'src', 'platform', 'os', 'environment.js'));
  const eg = require(path.join(ROOT, 'src', 'platform', 'os', 'egress.js'));
  const reg = require(path.join(ROOT, 'src', 'platform', 'os', 'registry.js'));
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  const red = require(path.join(ROOT, 'src', 'platform', 'util', 'redact.js'));
  const sr = require(path.join(ROOT, 'src', 'platform', 'contract', 'shell-report.js'));
  const T = 'login.example.test';
  const url = 'https://' + T + '/callback?state=x13';
  const rd = (ok, stage, detail) => ({ ok, stage, detail, at: 7 });
  const EG = (proxyState, target) => ({ at: 7,
    proxy: { state: proxyState, source: 'fixture', server: null, pac: null },
    targets: target ? { [T]: target } : {}, probed: [] });
  const note = () => {};
  const NO_INV = { platform: 'fixture', browsers: [], defaultId: null, defaultSource: null, probed: [] };

  // (1) 冷档案可行性真值表：唯一砍隔离档的输入是「直连不通 + 代理明确没有」，其余一律保持原档。
  const rows = [
    ['直连可达 -> 照开（没有理由砍）', EG('off', rd(true, 'tls', 'fixture')), true, 'target-reachable'],
    ['不通 + 代理在用 -> 照开（冷档案继承系统/环境代理）', EG('on', rd(false, 'dns', 'ENOTFOUND')), true, 'cold-profile-inherits-proxy'],
    ['不通 + 代理明确没有 -> 降档（冷档案必然空白）', EG('off', rd(false, 'dns', 'ENOTFOUND')), false, 'cold-profile-blocked'],
    ['不通 + 代理读不出 -> 判不出，保持隔离', EG('unknown', rd(false, 'dns', 'ENOTFOUND')), null, 'proxy-unreadable'],
    ['通路本身判不出 -> 判不出，保持隔离', EG('off', rd(null, 'tcp', 'ETIMEDOUT')), null, 'egress-undetermined'],
    ['这台机器还没判过该主机 -> 判不出，保持隔离', EG('off', null), null, 'egress-undetermined'],
  ];
  for (const [name, data, viable, basis] of rows) {
    const v = env.coldProfileViable(data, T);
    check('X-13 冷档案判据 ' + name, v.viable === viable && v.basis === basis && !!v.detail, JSON.stringify(v));
  }
  const unp = env.coldProfileViable(null, T);
  check('X-13 缺维度即如实 unprobed（拿空数据冒充本机实况是最难查的假账，也不许顺手砍能力）',
    unp.viable === null && unp.basis === 'egress-unprobed', JSON.stringify(unp));
  check('X-13 反向：把 unknown 折成 false 的写法会被真值表判红（一次 DNS 抖动就砍掉一项能力）',
    (() => {
      const guessed = (d) => !(d.targets[T] && d.targets[T].ok === true); // 猜测版：没证出可达就降档
      return rows.slice(3).every(([, d]) => guessed(d) === true && env.coldProfileViable(d, T).viable === null);
    })(), 'hit');

  // (2) checkEgress：动作层唯一的取数入口，结论四项（主机/三态/依据码/代理档）必须一起交出
  const ce = await env.checkEgress(url, { egress: EG('off', rd(true, 'tls', 'fixture')) });
  check('X-13 checkEgress 交出 host/结论/依据码/代理档/时戳（结论要一路走到屏幕上，不能只活在判据里）',
    ce.host === T && ce.viable === true && ce.basis === 'target-reachable' && ce.proxy === 'off' && ce.at === 7,
    JSON.stringify(ce));
  const ceBad = await env.checkEgress('读不出主机的地址', { egress: EG('unknown', null) });
  check('X-13 地址读不出主机名 -> 判不出而不是抛错（出网探测不得成为用户可见的失败原因）',
    ceBad.host === null && ceBad.viable === null && typeof ceBad.basis === 'string', JSON.stringify(ceBad));

  // (3) 维度台账：同步维每拍自装，异步维按拍记账；注册口是 app 层挂进来的唯一缝
  const f0 = env.form({ force: true, inventory: NO_INV, now: () => 5 });
  const dims = Object.keys(f0.sections);
  check('X-13 台账把维度收在一张表里且内置维度齐备（缺一个维度就是回到各说各话）',
    env.SECTION_ORDER.every((id) => dims.includes(id)) && dims.length === env.SECTION_ORDER.length
      && f0.schema === env.SCHEMA, dims.join(','));
  // 分母取自 SECTION_ORDER 减同步维：新增维度自动进这条判据，写死名单等于让新维度可以悄悄成摆设
  const asyncDims = env.SECTION_ORDER.filter((id) => !env.SYNC_DIMS.includes(id));
  check('X-13 未刷新的异步维度标 pending 并进留痕（面板据此说「尚未探测」，而不是显示成「本机没有」）',
    asyncDims.length === env.SECTION_ORDER.length - env.SYNC_DIMS.length
      && asyncDims.every((id) => f0.sections[id].state === 'pending' && f0.sections[id].data === null)
      && asyncDims.every((id) => f0.probed.some((p) => p.section === id && /未刷新/.test(String(p.detail)))),
    JSON.stringify(dims.map((id) => [id, f0.sections[id].state])));
  check('X-13 同步维不靠刷新（选路与面板当场要读浏览器清单与分发依据，等一拍即死路）',
    env.SYNC_DIMS.every((id) => f0.sections[id].state !== 'pending'
      && f0.sections[id].at === 5 && f0.sections[id].source === 'self'), JSON.stringify(f0.sections.browsers));
  let probeCalls = 0;
  env.registerSection('x13-fake', { label: '假维度', probe: () => { probeCalls++; return { hit: true }; } });
  const fr = await env.refresh({ only: ['x13-fake'], force: true, inventory: NO_INV, now: () => 5 });
  check('X-13 注册进来的维度进台账并带 label/source/at（采集归所有者、账本归表单：E1 的分工判据）',
    !!fr.sections['x13-fake'] && fr.sections['x13-fake'].state === 'ok' && fr.sections['x13-fake'].source === 'registered'
      && fr.sections['x13-fake'].label === '假维度' && fr.sections['x13-fake'].data.hit === true && probeCalls === 1,
    JSON.stringify(fr.sections['x13-fake']));
  await env.refresh({ only: ['x13-fake'], inventory: NO_INV, now: () => 5 });
  check('X-13 未到期不重探（面板轮询不得把子进程与网络查询变成常态开销）', probeCalls === 1, 'probe ' + probeCalls + ' 次');
  env.registerSection('x13-boom', { probe: () => { throw new Error('探针炸了'); } });
  const fb = await env.refresh({ only: ['x13-boom'], force: true, inventory: NO_INV, now: () => 5 });
  check('X-13 维度探针抛错只记成 error 一档（表单不得成为用户可见的失败原因，也不许拿旧数据顶）',
    fb.sections['x13-boom'].state === 'error' && /探针炸了/.test(fb.sections['x13-boom'].error)
      && fb.sections['x13-boom'].data === null && fb.schema === env.SCHEMA, JSON.stringify(fb.sections['x13-boom']));
  let rejMsg = null;
  try { env.registerSection('browsers', { probe: () => ({}) }); } catch (e) { rejMsg = String(e.message || e); }
  env.unregisterSection('x13-fake'); env.unregisterSection('x13-boom');
  check('X-13 反向：同步维拒接注册、注销即离开台账（两处写同一维度即两个口径）',
    !!rejMsg && /不接注册/.test(rejMsg) && env.form({ force: true, inventory: NO_INV }).sections['x13-fake'] === undefined,
    String(rejMsg));
  check('X-13 维度注册点唯一（platform 只挂自身采集口，运行时与 DSH 由装配期挂入；第四处即第二套真相）',
    (() => {
      const walk = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name); if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
      const hits = walk(path.join(ROOT, 'src'), []).filter((f) => /environment\s*\.\s*registerSection\(|^\s*registerSection\(/m
        .test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
      return JSON.stringify(hits) === JSON.stringify(['src/app/assembly/compose/core.js', 'src/platform/os/environment.js']);
    })(), '注册点见判据');

  // (4) L0 通路判定的三态分档：明确否定才是 false，没有答案一律 null
  const dnsErr = (code) => eg.reachWith({ lookup: () => Promise.reject(Object.assign(new Error(code), { code })),
    connect: () => Promise.resolve(true) }, T, 443, 50);
  const connErr = (code) => eg.reachWith({ lookup: () => Promise.resolve('127.0.0.1'),
    connect: () => Promise.reject(Object.assign(new Error(code), { code })) }, T, 443, 50);
  const cls = {};
  for (const c of ['ENOTFOUND', 'EAI_AGAIN']) cls['dns:' + c] = await dnsErr(c);
  for (const c of ['ECONNREFUSED', 'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ETIMEDOUT', 'ECONNRESET']) cls['c:' + c] = await connErr(c);
  check('X-13 L0 分档：域名不存在=明确不通（dns 段）、连接被拒=tcp 段、TLS 协议/证书错=tls 段且都算否证',
    cls['dns:ENOTFOUND'].ok === false && cls['dns:ENOTFOUND'].stage === 'dns'
      && cls['c:ECONNREFUSED'].ok === false && cls['c:ECONNREFUSED'].stage === 'tcp'
      && cls['c:EPROTO'].ok === false && cls['c:EPROTO'].stage === 'tls'
      && cls['c:ERR_TLS_CERT_ALTNAME_INVALID'].ok === false && cls['c:ERR_TLS_CERT_ALTNAME_INVALID'].stage === 'tls',
    JSON.stringify(cls));
  check('X-13 L0 分档：解析服务器不响应/超时/半路 reset 一律判不出（砍能力要有否证，不能拿没答案当否证）',
    cls['dns:EAI_AGAIN'].ok === null && cls['dns:EAI_AGAIN'].stage === 'dns'
      && cls['c:ETIMEDOUT'].ok === null && cls['c:ECONNRESET'].ok === null, JSON.stringify(cls));
  const okReach = await eg.reachWith({ lookup: () => Promise.resolve('127.0.0.1'), connect: () => Promise.resolve(true) }, T, 443, 50);
  check('X-13 L0 判定停在 TLS 完成（不发业务请求：能力判定不得变成内容依赖）',
    okReach.ok === true && okReach.stage === 'tls' && !/http|GET|status/.test(String(okReach.detail)), JSON.stringify(okReach));
  let lookCalls = 0;
  const spy = { lookup: () => { lookCalls++; return Promise.resolve('127.0.0.1'); }, connect: () => Promise.resolve(true) };
  const cached = await eg.reach(T, spy);
  const cached2 = await eg.reach(T, spy);
  check('X-13 同一主机在 TTL 内复用判定（一次登录动作不得反复摸网；复用的是原结论而不是重算）',
    cached.ok === true && cached2.ok === true && cached2.cached === true && lookCalls === 1, JSON.stringify(cached2));
  check('X-13 hosts() 交出已判主机、invalidate 按主机作废（代理一改旧判定必须当场失效而不是等 TTL）',
    eg.hosts().includes(T) && eg.invalidate(T) === 1 && eg.reachRead(T) === null, JSON.stringify(eg.hosts()));

  // (5) 代理读数：三平台各自的分档与「读不到 != 没配」
  check('X-13 linux 代理分档：环境变量有=on、一个都没有=unknown（服务语境 import-environment 不全，判成没配就打死有代理的机器）',
    eg.proxyLinux({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, note).state === 'on'
      && eg.proxyLinux({ https_proxy: 'http://127.0.0.1:7890' }, note).state === 'on'
      && eg.proxyLinux({}, note).state === 'unknown' && eg.proxyLinux({ https_proxy: '   ' }, note).state === 'unknown',
    JSON.stringify(eg.proxyLinux({}, note)));
  const WIN_ON = '注册表项 HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings 的查询结果\r\n    ProxyEnable    REG_DWORD    0x1\r\n\r\n';
  const WIN_SV = '    ProxyServer    REG_SZ    127.0.0.1:7890\r\n\r\n';
  const winRun = (bin, args) => Promise.resolve(/ProxyEnable/.test(String(args[args.length - 1])) ? WIN_ON
    : /ProxyServer/.test(String(args[args.length - 1])) ? WIN_SV : '未找到指定的注册表项或值\r\n');
  const pw = await eg.proxyWin(winRun, note);
  check('X-13 win32 代理解析只认值名与类型列（中英文表头都读得出；按英文提示语锚定 = 中国版机器读空，正是白窗口的成因之一）',
    reg.regDwordOf(WIN_ON) === 1 && reg.regValueOf(WIN_SV) === '127.0.0.1:7890'
      && reg.regValueOf('未找到指定的注册表项或值\r\n') === null && reg.regValueOf(WIN_ON) === null
      && pw.state === 'on' && pw.server === '127.0.0.1:7890' && pw.source === 'registry:Internet Settings',
    JSON.stringify(pw));
  const offRun = (bin, args) => {
    const v = String(args[args.length - 1]);
    return Promise.resolve(/ProxyEnable/.test(v) ? '    ProxyEnable    REG_DWORD    0x0\r\n'
      : /ProxyServer/.test(v) ? WIN_SV : '未找到指定的注册表项或值\r\n');
  };
  const one = await eg.proxyWin(offRun, note);
  const pacRun = (bin, args) => {
    const v = String(args[args.length - 1]);
    return Promise.resolve(/AutoConfigURL/.test(v) ? '    AutoConfigURL    REG_SZ    http://pac/intranet.pac\r\n'
      : /ProxyEnable/.test(v) ? '    ProxyEnable    REG_DWORD    0x0\r\n' : '未找到指定的注册表项或值\r\n');
  };
  const two = await eg.proxyWin(pacRun, note);
  check('X-13 win32 只存 ProxyServer 而未启用 = off（开着才算数，PAC 单独配也算在用）',
    one.state === 'off' && one.server === '127.0.0.1:7890'
      && two.state === 'on' && two.pac === 'http://pac/intranet.pac' && two.server === null,
    JSON.stringify([one, two]));
  const macOn = await eg.proxyMac(async () => 'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 8888\n', note);
  const macOff = await eg.proxyMac(async () => 'HTTPEnable : 0\nHTTPProxy : 127.0.0.1\n', note);
  const macNone = await eg.proxyMac(async () => '(The command could not load because of a sandbox.)\n', note);
  check('X-13 darwin 代理分档：开关为 1 才算在用、有开关但全 0 才是没配、读不出开关位置即 unknown',
    macOn.state === 'on' && macOn.server === '127.0.0.1' && macOff.state === 'off' && macNone.state === 'unknown',
    JSON.stringify([macOn, macOff, macNone]));
  eg.invalidate();
  const syncCalls = eg.hosts().length;
  check('X-13 同步读数只取缓存、绝不触发系统查询（HTTP 路径与判据读 proxyRead；起子进程的是刷新那一步）',
    syncCalls === 0 && (eg.proxyRead() === null || eg.proxyRead().platform === process.platform), 'ok');
  check('X-13 代理凭据不进表单也不进快照（脱敏住在入站口的同一把尺上，漏一处就等于把 user:pass 投给人看的界面）',
    red.maskProxyServer('http://usr:pwd@127.0.0.1:7890') === 'http://usr:***@127.0.0.1:7890'
      && red.maskProxyServer('127.0.0.1:7890') === '127.0.0.1:7890' && red.maskProxyServer(null) === null
      && red.maskProxySecrets('a=b http://u:p@h/x u2:p2@h2') === 'a=b http://u:***@h/x u2:***@h2',
    JSON.stringify([red.maskProxyServer('http://usr:pwd@h:1'), red.maskProxyServer('a:b@h:1')]));
  // 尺只有一把：任何第二个文件写出替换串 `:***@` 就是第二套「什么算机密」。反向样本 = 把尺复制进读取器。
  const rulerHits = (() => {
    const walk = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name); if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
    return walk(path.join(ROOT, 'src'), [])
      .filter((f) => fs.readFileSync(f, 'utf8').includes(':***@'))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
  })();
  check('X-13 脱敏实现唯一（入站两条路：内核自己的探针与壳上报；各写一把尺即两个机密口径）',
    rulerHits.length === 1 && rulerHits[0] === 'src/platform/util/redact.js'
      && env.maskProxyServer === undefined,
    JSON.stringify(rulerHits));
  // 壳上报维：台账里必须有它，且读侧落点就是契约拼出来的那个路径 —— 第二处拼路径等于两份「壳报在哪」。
  //   available 与 reason 必须自洽（读得出才算 available），这一档在 CI 上是 never-written、
  //   在装过壳的真机上是 ok，两条都合法，所以判据钉的是自洽而不是某个固定答案。
  const shf = await env.refresh({ only: ['shell'], force: true, inventory: NO_INV, now: () => 5 });
  const shRead = (shf.sections.shell || {}).data || {};
  check('X-13 壳上报维进台账且读侧落点唯一（available 必须等于 reason 是否 ok，读不出不能伪装成读到）',
    shf.sections.shell.state === 'ok' && shf.sections.shell.source === 'shell'
      && typeof shf.sections.shell.label === 'string'
      && shRead.path === sr.file() && shRead.available === (shRead.reason === 'ok')
      && (shRead.schema === null || shRead.schema === sr.SUPPORTED_SCHEMA)
      && Array.isArray(shRead.records) && typeof shRead.droppedRecords === 'number'
      && shf.probed.some((p) => p.section === 'shell' && /壳/.test(String(p.detail))),
    JSON.stringify(shf.sections.shell));

  // (6) 执行口接线：降档要说清依据、判不出要保持原档、全程零摸网
  const CH = { id: 'chrome', name: 'Chrome', bin: '/usr/bin/google-chrome', engine: 'chromium', sources: ['fixture'] };
  const inv = { platform: 'fixture', browsers: [CH], defaultId: null, defaultSource: null, probed: [{ source: 'fixture', detail: '1 项' }] };
  let allocated = 0;
  const spawned = [];
  const isoOpen = (egress) => br.openBrowser(url, {
    platform: 'linux', inventory: inv, intent: 'isolated-login', egress, observeMs: 1,
    observe: async () => ({ stage: 'exit', code: 0, signal: null }),
    spawn: (bin, args) => { spawned.push([bin, args]); return { fake: true }; },
    binAvailable: () => true, desktopAvailable: () => true, rmTree: () => {}, onExit: () => {},
    allocProfile: () => { allocated++; return '/P'; },
  });
  eg.invalidate();
  const blocked = await isoOpen(EG('off', rd(false, 'dns', 'ENOTFOUND')));
  check('X-13 判定为必然空白时降档如实：并入既有窗口 + 不分配 profile + 证据带结论码与理由',
    blocked.ok === true && blocked.evidence.isolated === false && blocked.evidence.via === 'browser'
      && blocked.evidence.profile === null && allocated === 0 && spawned.length === 1
      && blocked.evidence.egress.basis === 'cold-profile-blocked' && blocked.evidence.egress.viable === false
      && /空白页/.test(String(blocked.message)) && /代理/.test(String(blocked.message)),
    JSON.stringify([blocked.evidence, blocked.message]));
  check('X-13 降档全程零摸网零系统查询（判据吃注入的读数：CI 摸网会让同一条判据随宿主网络漂移）',
    eg.hosts().length === 0 && eg.proxyRead() === null, JSON.stringify(eg.hosts()));
  const undet = await isoOpen(EG('unknown', rd(false, 'dns', 'ENOTFOUND')));
  check('X-13 判不出即保持隔离档（用猜到的事实砍能力是被禁的形态：真机「弹了个空白窗」的另一半成因）',
    undet.ok === true && undet.evidence.isolated === true && undet.evidence.via === 'isolated'
      && undet.evidence.egress.viable === null && allocated === 1 && !/空白页/.test(String(undet.message)),
    JSON.stringify(undet.evidence));

  // (7) 结论要走到屏幕：域侧交出依据码，面板声明并消费同一份形状
  const oaSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'oauth.js'), 'utf8');
  check('X-13 一键登录把隔离依据码与理由一起交出（「未隔离」必须分得清引擎不支持与本机没有出网路）',
    /isolatedBasis:/.test(oaSrc) && /isolatedDetail:/.test(oaSrc) && /engine-not-isolatable/.test(oaSrc), 'ok');
  const tsSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'types.ts'), 'utf8');
  const cardSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'settings', 'EnvironmentCard.tsx'), 'utf8');
  const extSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'externalOpen.ts'), 'utf8');
  check('X-13 后端产出的新维度必须同时进前端类型与页面（只改后端则 tsc 不报错、界面静默少显示）',
    /export type EnvironmentSections/.test(tsSrc) && /sections\?:\s*EnvironmentSections/.test(tsSrc)
      && /export type EgressSectionData/.test(tsSrc) && /sections\?\.egress/.test(cardSrc)
      && /出网条件/.test(cardSrc) && /判不出/.test(cardSrc), 'ok');
  check('X-13 面板把出网结论与降档理由摊进证据行（内核解释了原因，界面上只剩「没拿到证据」就是把话丢了）',
    /ev\.egress/.test(extSrc) && /isolatedBasis/.test(extSrc) && /r\?\.message/.test(extSrc), 'ok');
  eg.invalidate();
}

// -- X-14：证据字段与快照留痕的出口收口 --
//   E3 判的是「交出去的东西有没有人读」这一类假账，三条各自可红：
//   (1) 每次打开交出的 evidence / diagnostics 逐键要有读者，且内核发出与前端声明的字段集必须相等；
//   (2) 启动段只抄装配已经算出的既成事实（写处一处、读处一处），没刷新那一拍如实 pending；
//   (3) 快照从单向写变成有读回口，且「没落过盘」与「读不出」必须分得开 —— 把后者说成前者会引着人去点刷新。
async function x14() {
  const env = require(path.join(ROOT, 'src', 'platform', 'os', 'environment.js'));
  const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const brSrc = rd('src/platform/os/browser.js');
  const extSrc = rd('ui/src/services/supervisor/externalOpen.ts');
  const tsSrc = rd('ui/src/services/supervisor/types.ts');
  const cardSrc = rd('ui/src/features/supervisor/settings/EnvironmentCard.tsx');
  const clientSrc = rd('ui/src/services/supervisor/client.ts');

  // 顶层键提取：按括号配平切出字面量体，再按深度 0 的分隔符分件 —— 换行与夹注都拦不住它
  const objBody = (src, anchor) => {
    const at = src.indexOf(anchor);
    if (at < 0) return null;
    const i0 = src.indexOf('{', at);
    if (i0 < 0) return null;
    let depth = 0;
    for (let i = i0; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(i0 + 1, i); }
    }
    return null;
  };
  const topKeys = (body) => {
    if (!body) return [];
    const parts = [];
    let depth = 0, cur = '';
    for (const c of body) {
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      if ((c === ',' || c === ';') && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += c;
    }
    parts.push(cur);
    return parts.map((t) => {
      const s = t.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const m = /^([A-Za-z_$][\w$]*)\??\s*:/.exec(s) || /^([A-Za-z_$][\w$]*)$/.exec(s);
      return m ? m[1] : null;
    }).filter(Boolean);
  };
  const readKeys = (src, re) => { const s = new Set(); let m; while ((m = re.exec(src))) s.add(m[1]); return Array.from(s); };
  const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));

  // (1) 字段级假账：发出、声明、读到三处必须同一份，任何一侧单独动都判红
  const evKeys = topKeys(objBody(brSrc, 'const evidence = {'));
  const dgKeys = topKeys(objBody(brSrc.slice(brSrc.indexOf('function launchDiagnostics')), 'return {'));
  const evDecl = topKeys(objBody(tsSrc, 'evidence?: {'));
  const dgDecl = topKeys(objBody(tsSrc, 'export interface BrowserDiagnostics {'));
  const evRead = readKeys(extSrc, /\bev\??\.([A-Za-z_$][\w$]*)/g);
  const dgRead = readKeys(extSrc, /\bd\??\.([A-Za-z_$][\w$]*)/g);
  check('X-14 分母非空：两份字段集从真实源码切出（提取失灵会让下面三条一起空转）',
    evKeys.length === 12 && dgKeys.length === 5, JSON.stringify([evKeys, dgKeys]));
  check('X-14 内核发出的字段集与前端声明逐键相等（只改一侧即假账：声明缺则界面读不出，声明多则是凭空字段）',
    sameSet(evKeys, evDecl) && sameSet(dgKeys, dgDecl), JSON.stringify([evKeys, evDecl, dgKeys, dgDecl]));
  check('X-14 反向：无人可读的键（platform/bin 旧形态）不得回流',
    !dgKeys.includes('platform') && !dgKeys.includes('bin') && !evKeys.some((k) => /^(platform|isolatedBasis)$/.test(k)),
    JSON.stringify(dgKeys));
  check('X-14 每个发出的键都在面板证据判据里有读者（内核交出而界面不读等于没交）',
    evKeys.every((k) => evRead.includes(k)) && dgKeys.every((k) => dgRead.includes(k)),
    JSON.stringify([evKeys.filter((k) => !evRead.includes(k)), dgKeys.filter((k) => !dgRead.includes(k))]));
  check('X-14 反向：凭空多一个没人读的键会被上面那条识别（判据非空转）',
    evKeys.concat(['zzNobodyReadsIt']).filter((k) => !evRead.includes(k)).length === 1, 'hit');

  // (2) 启动既成事实：一处写一处读，探针只抄不判（第二处写即第二个口径）
  const walk = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
  const relOf = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const factFiles = walk(path.join(ROOT, 'src'), []).map(relOf)
    .filter((r) => /_startupFacts/.test(rd(r))).sort();
  check('X-14 启动事实的触及面恰好两处（bootstrap 记既成事实、装配核读进台账；第三处即另起口径）',
    JSON.stringify(factFiles) === JSON.stringify(['src/app/assembly/bootstrap.js', 'src/app/assembly/compose/core.js']),
    factFiles.join(','));
  const suBody = objBody(rd('src/app/assembly/compose/core.js').slice(0), "registerSection('startup'");
  check('X-14 启动维度的探针只读装配状态（不起子进程、不摸网、不读盘：它就是 bootstrap 的另一面镜子）',
    !!suBody && /_startupFacts/.test(suBody) && !/spawn|execFile|readFile|fetch\(|require\(/.test(suBody),
    String(suBody).replace(/\s+/g, ' ').slice(0, 70));
  check('X-14 启动维度走异步台账（在 SECTION_ORDER 而不在 SYNC_DIMS：没刷新那一拍如实 pending，不拿空壳冒充本机实况）',
    env.SECTION_ORDER.includes('startup') && !env.SYNC_DIMS.includes('startup'), JSON.stringify(env.SECTION_ORDER));

  // (3) 快照读回口：只读、零写盘、两种「没有」分得开
  const prevHome = process.env.DSH_SUPERVISOR_HOME;
  process.env.DSH_SUPERVISOR_HOME = path.join(TMP, 'x14-state');
  const INV14 = { platform: 'fixture', browsers: [], defaultId: null, defaultSource: null, probed: [] };
  const l0 = env.lastSnapshot({ now: () => 1000 });
  check('X-14 没落过盘要说成没写过（available=false + never-written，不含糊成读不出）',
    l0.available === false && l0.reason === 'never-written' && l0.data === null
      && l0.at === null && l0.ageMs === null && l0.path === env.snapshotPath(), JSON.stringify(l0));
  const f14 = env.form({ force: true, persist: true, inventory: INV14, now: () => 4242 });
  const l1 = env.lastSnapshot({ now: () => 9242 });
  check('X-14 落盘后读回整份上一拍表单与年龄（留痕读不回来就等于没留；这里吃注入时钟，不随宿主漂移）',
  // 判据按分母走，不比对 l1.data 与 f14 自己：同源自比恒真，等于没判。
  //   落盘那一刻文档还不含本拍的 snapshot 字段（写成功与否不能自证），所以「留痕在不在」只能由读回口说。
    l1.available === true && l1.reason === 'ok' && l1.at === f14.at && l1.ageMs === 5000 && l1.path === env.snapshotPath()
      && !!l1.data && l1.data.schema === env.SCHEMA && l1.data.at === f14.at
      && env.SECTION_ORDER.every((id) => !!(l1.data.sections || {})[id]) && Array.isArray(l1.data.browsers), JSON.stringify({
      available: l1.available, at: l1.at, ageMs: l1.ageMs, schema: l1.data && l1.data.schema }));
  fs.writeFileSync(env.snapshotPath(), '{"schema":' + (env.SCHEMA + 1) + ',"at":1}\n', { mode: 0o600 });
  const l2 = env.lastSnapshot();
  check('X-14 文件在但读不出/版本不符要单列一档（说成「没写过」会引着人去点刷新而不是去查文件）',
    l2.available === false && l2.reason === 'unreadable-or-schema-mismatch' && l2.data === null
      && fs.existsSync(l2.path), JSON.stringify({ reason: l2.reason }));
  if (prevHome === undefined) delete process.env.DSH_SUPERVISOR_HOME; else process.env.DSH_SUPERVISOR_HOME = prevHome;

  // (4) 读回口只有一条路：HTTP 面消费，绝不喂分发；界面与契约两侧都得点名它
  const lastCallers = walk(path.join(ROOT, 'src'), []).map(relOf)
    .filter((r) => /lastSnapshot\s*\(/.test(rd(r))).sort();
  check('X-14 读回口的生产侧消费者只有 HTTP 面（并进当拍字段即拿旧数据冒充刚探出来的结论）',
    JSON.stringify(lastCallers) === JSON.stringify(['src/api/domains/guard.js', 'src/platform/os/environment.js']),
    lastCallers.join(','));
  check('X-14 读回端点已上契约清单且带具名消费者（无消费者的端点就是下一个没人读的字段）',
    /\/env\/environment\/last/.test(rd('src/api/contract.js'))
      && /\/env\/environment\/last/.test(rd('src/api/domains/guard.js')), 'ok');
  check('X-14 上一拍留痕在前端有类型、有请求、有分档文案（后端产出而界面不显示等于没产出）',
    /EnvironmentSnapshotRead/.test(tsSrc) && /environmentLast/.test(clientSrc)
      && /never-written/.test(cardSrc) && /读不出/.test(cardSrc) && /启动既成事实/.test(cardSrc), 'ok');
}

x10().catch((e) => check('X-10 异步判据自身未抛错', false, String((e && e.stack) || e)))
  .then(x13).catch((e) => check('X-13 异步判据自身未抛错', false, String((e && e.stack) || e)))
  .then(x14).catch((e) => check('X-14 异步判据自身未抛错', false, String((e && e.stack) || e)))
  .then(finish);

