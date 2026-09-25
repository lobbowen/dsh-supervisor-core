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
//   X-8  外部打开底座的三层分工：调度器形态（win32 无可信调度器）、探测层多源并集与留痕、
//        选路（默认项来源优先、多候选而系统说不出默认即拒）、隔离/非隔离计划与诊断面
//   X-10 openBrowser 的三档结果语义（confirmed / handedOff / ok:false）+ observeSpawn 本体
//        + 退出码证据闸（ownsItsWindow 双向生效：不可信形态既不冒领成功也不凭空判失败）
//        —— 唯一异步出口，故尾部汇总排在它之后
//   X-11 外部打开「唯一出口」的源码级不变量（旧出口不得重现、名单取自档位表、平台事实只在探测层一处、
//        图形会话判据只在 desktop.js 一处、只读探测端点与其来源闸、消费方原样透传、
//        面板那一环只经 /env/open-url 与唯一的 window.open 分支）
//
// ## 覆盖缺口（E-2 制度化登记）：本门禁绿了仍然不成立的方面
//   1. X-8 的探测夹具与 X-10 的 spawn/observe 全是注入的假件：证明的是「读数->清单->计划->分档」的纯逻辑，
//      不证明真机上注册表/LaunchServices/XDG 的读数形态，也不证明浏览器窗口出现。
//      Windows 真机的默认项解析是否命中，只有带着 diagnostics 的真机落档能回答。
//   2. 观测上界（OPEN_OBSERVE_MS）由假时钟推进，真机冷启动/慢解析下是否够用未证明。
//   3. X-11 是源码正则判据：改名、字符串拼出的调用、间接 require 都能绕过 —— 它保证「本仓只有一条路」，
//      不保证「运行期只走了这条路」。
//   4. 本文件在 Linux 宿主运行：win32/darwin 分支全靠注入 platform，图形会话探测本身归
//      platform-parsers-and-commands 的 Y-4。
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

// -- X-8：外部打开底座的三层分工（探测 browser-inventory / 选路+执行 browser）--
// 本组钉的是「分层是否还在」：探测层只回答系统里有什么，选路只回答这次交给谁，执行只回报拿到什么证据。
// 任何一层越界（选路自己查注册表、执行层替用户挑浏览器、探测层顺手 spawn）都会让真机症状重新变成不可定性。
{
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));
  const det = br.detector;
  const u = 'http://127.0.0.1:28111/x';
  check('X-8 解析原语只有一个实现处（browser.js 转出的即探测层的同一函数）',
    typeof det === 'object' && br.engineOf === det.engineOf && br.parseExecLine === undefined
    && br.resolveDefaultWin === undefined && br.resolveDefaultLinux === undefined
    && br.resolveDefaultMac === undefined && br.defaultBrowser === undefined,
    Object.keys(det).slice(0, 6).join(','));

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

  // —— 探测层：win32 多源并集，且「被系统忽略的默认值」不再被当默认项读 ——
  const UC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  const SMI = 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet';
  /** 假 reg.exe：只按探测层实际发出的 query 形态应答，认不出的形态一律 null（= 读不到）。
   *  values 的项可为字符串（REG_SZ）或 {t:'REG_EXPAND_SZ',d:'…'}。 */
  function fakeReg(o) {
    const hits = [];
    const values = o.values || {}, named = o.named || {}, subs = o.subs || {}, multi = o.multi || {};
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
      const lines = [];
      for (const [n, v] of Object.entries(multi[key] || {})) { const [t, d] = q(v); lines.push('    ' + n + '    ' + t + '    ' + d); }
      for (const s of (subs[key] || [])) lines.push(key + '\\' + s);
      return lines.length ? lines.join('\r\n') + '\r\n' : null;
    };
    run.hits = hits;
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
    check('X-8 探测 win32 反向：此时两个候选仍在册，选路据「说不出默认」显式拒绝而非按顺序猜',
      r.browsers.length === 2 && br.pickLauncher('win32', r).browser === null
      && br.pickLauncher('win32', r).how === 'no-default', JSON.stringify(br.pickLauncher('win32', r)));
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

  // —— 选路：探测清单 -> 这次交给谁（夹具即探测层产物，不另立字段）——
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
    check('X-8 pickLauncher：命中 defaultId 用 defaultSource 记账（谁说的默认要跟着走）',
      JSON.stringify(br.pickLauncher('linux', invOf([chrome, ff], ff.id, 'mimeapps'))) === JSON.stringify({ browser: ff, how: 'mimeapps' }),
      JSON.stringify(br.pickLauncher('linux', invOf([chrome, ff], ff.id, 'mimeapps'))));
    check('X-8 pickLauncher：defaultId 指向清单里没有的条目 = 不命中（探测层与选路同一份数据才谈得上同源）',
      br.pickLauncher('linux', invOf([ff], 'no-such-id', 'userchoice')).how === 'only-installed',
      JSON.stringify(br.pickLauncher('linux', invOf([ff], 'no-such-id', 'userchoice'))));
    check('X-8 pickLauncher：单候选=唯一解、多候选无默认=no-default、空清单=none-found',
      br.pickLauncher('linux', invOf([ff])).how === 'only-installed'
      && br.pickLauncher('linux', invOf([ff, chrome])).how === 'no-default'
      && br.pickLauncher('linux', invOf([])).how === 'none-found'
      && br.pickLauncher('linux', null).how === 'none-found', 'ok');
  }
  const kl = br.openPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome')]) });
  const kw = br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe')]) });
  const knone = br.openPlan('win32', u, { inventory: invOf([]) });
  const kmany = br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]) });
  const ko = br.openPlan('darwin', u, { inventory: invOf([brow('/Applications/Safari.app/Contents/MacOS/Safari')]) });
  check('X-8 openPlan win32 探到本体 = 直启（Windows 唯一路；无调度器可退）',
    kw.bin === 'C:\\Edge\\msedge.exe' && kw.via === 'browser' && kw.engine === 'chromium' && kw.pick === 'only-installed', JSON.stringify(kw));
  check('X-8 openPlan win32 探不到任何浏览器 = bin:null（旧形态在这里退 explorer.exe 冒开）',
    knone.bin === null && knone.via === 'none' && knone.baseArgs.length === 0, JSON.stringify(knone));
  check('X-8 openPlan win32 多候选而系统说不出默认 = bin:null（拒绝按清单顺序猜）',
    kmany.bin === null && kmany.pick === 'no-default', JSON.stringify(kmany));
  check('X-8 openPlan linux/darwin 无解析结果 = 文档化调度器且 exitIsEvidence:true（0 即接收、非 0 即拒绝）',
    br.openPlan('linux', u, { inventory: invOf([]) }).bin === 'xdg-open'
    && br.openPlan('linux', u, { inventory: invOf([]) }).exitIsEvidence === true
    && br.openPlan('darwin', u, { inventory: invOf([]) }).bin === 'open'
    && br.openPlan('darwin', u, { inventory: invOf([]) }).exitIsEvidence === true, 'ok');
  check('X-8 openPlan 解析到 chromium = 直启该浏览器（baseArgs 在前、url 收尾，且绝不注入隔离参数）',
    kl.bin === '/usr/bin/google-chrome' && kl.via === 'browser' && kl.engine === 'chromium'
    && JSON.stringify(kl.baseArgs) === JSON.stringify([u]), JSON.stringify(kl));
  check('X-8 openPlan other 引擎（Safari/snap 包装器）在非 win32 交回调度器（裸 URL 参数语义不确定）',
    ko.via === 'dispatcher' && ko.bin === 'open' && ko.engine === 'other', JSON.stringify(ko));
  check('X-8 openPlan win32 对 other 引擎仍直启（那里没有调度器；引擎不明只等于不可取证，不等于不能试）',
    br.openPlan('win32', u, { inventory: invOf([brow('C:\\Tools\\weirdbrowser.exe')]) }).via === 'browser', 'ok');
  // 裸 URL 直启可被既有实例吸收：本次进程的退出码属于「转交动作」，不属于那个窗口，故两向都不作证据。
  check('X-8 直启浏览器一律 exitIsEvidence:false（win32/linux 同判，不按平台分叉）',
    kl.exitIsEvidence === false && kw.exitIsEvidence === false, JSON.stringify([kl.exitIsEvidence, kw.exitIsEvidence]));
  check('X-8 证据规则只在 ownsItsWindow 一处：三端调度器 = 非 win32，两种浏览器形态 = 恒 false',
    br.ownsItsWindow('dispatcher', 'linux') === true
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

  // —— 诊断面：每次打开都带上「系统里探到了什么」，真机报障不必再回去读代码 ——
  {
    const dg = br.launchDiagnostics(invOf([brow('C:\\Edge\\msedge.exe', { name: 'msedge' }), brow('C:\\FF\\firefox.exe', { name: 'firefox' })], 'c:\\ff\\firefox.exe', 'userchoice'), kmany, 'no-default');
    check('X-8 诊断带全部候选/默认项来源/probed 留痕（no-launcher 档也要能定性）',
      dg.pick === 'no-default' && dg.found.length === 2 && dg.found.every((f) => f.name && f.engine && f.via)
      && JSON.stringify(dg.default) === JSON.stringify({ id: 'c:\\ff\\firefox.exe', source: 'userchoice' })
      && dg.probed.length === 1, JSON.stringify(dg));
    check('X-8 反向：空清单的诊断仍是空清单（把「没探到」写成「探到 0 个」才是可定性的答案）',
      JSON.stringify(br.launchDiagnostics(invOf([]), knone, 'none-found').found) === '[]', 'ok');
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
  const br = require(path.join(ROOT, 'src', 'platform', 'os', 'browser.js'));

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

  // launchIsolated spawn 前预检（inventory + binAvailable + spawn **三注入** -> 宿主无关、
  //   零真实进程、零注册表/LaunchServices/xdg-settings 真实查询）。
  //   夹具与产品同源：注入的就是探测层交出的条目形状（id 恒为归一 bin），而不是另一套字段口径。
  const u9 = 'http://127.0.0.1:28999/x';
  const chromeBrow = { id: '/usr/bin/google-chrome', name: 'google-chrome', engine: 'chromium',
    bin: '/usr/bin/google-chrome', baseArgs: [], sources: ['fixture'] };
  const inv9 = (b) => ({ platform: 'fixture', browsers: b ? [b] : [], defaultId: b ? b.id : null,
    defaultSource: b ? 'fixture' : null, probed: [{ source: 'fixture', detail: b ? '1 项' : '0 项' }] });
  const otherBrow = { id: '/applications/safari.app/contents/macos/safari', name: 'Safari', engine: 'other',
    bin: '/Applications/Safari.app/Contents/MacOS/Safari', baseArgs: [], sources: ['fixture'] };
  const plan9 = br.isolatedPlan(process.platform, u9, { inventory: inv9(chromeBrow), profileDir: '/P' });
  const spawned9 = [];
  const exits9 = [];
  const fakeSpawn = (bin, args, env, onExit) => { spawned9.push(bin); exits9.push(onExit); return { on() {}, unref() {} }; };
  const asked9 = [];
  const r1 = br.launchIsolated(u9, {
    inventory: inv9(chromeBrow), profileDir: '/P', onExit: () => {},
    binAvailable: (b) => { asked9.push(b); return true; }, spawn: fakeSpawn,
  });
  check('X-9 条4 前提：产品预检只问探测清单定出的那一个浏览器（无候选链可问）',
    asked9.length === 1 && asked9[0] === plan9.bin, JSON.stringify(asked9));
  check('X-9 条4 默认浏览器真的被 spawn（宿主无关，三端同形）',
    spawned9.length === 1 && spawned9[0] === plan9.bin, JSON.stringify(spawned9) + ' want=' + plan9.bin);
  check('X-9 条4 返回值如实上报（ok/label/isolated 取自同一计划）',
    r1.ok === true && r1.bin === plan9.label && r1.isolated === plan9.isolated,
    JSON.stringify(r1) + ' want=' + plan9.label + '/' + plan9.isolated);
  check('X-9 隔离形态接 onExit（关浏览器即取消登录），url 在 args 收尾',
    typeof exits9[0] === 'function' && plan9.args[plan9.args.length - 1] === u9, 'ok');
  const r1f = br.launchIsolated(u9, {
    inventory: inv9(otherBrow), profileDir: '/P', onExit: () => {},
    binAvailable: () => true, spawn: fakeSpawn,
  });
  // other 引擎在非 win32 交回调度器、在 win32 直启本体：两档都是 isolated:false 且不接 onExit
  //   （前者退出不等同浏览器退出，后者并入既有实例），这条差异不得影响失败语义。
  check('X-9 非隔离兜底（other 引擎）= isolated:false、**不接 onExit**（其退出不等同浏览器退出）',
    r1f.ok === true && r1f.isolated === false && typeof exits9[1] !== 'function', JSON.stringify(r1f));
  spawned9.length = 0;
  const r2 = br.launchIsolated(u9, { inventory: inv9(chromeBrow), profileDir: '/P', binAvailable: () => false, spawn: fakeSpawn });
  check('X-9 条4 预检不过 → ok:false/bin:null（旧实现先返回 ok:true/死 bin，error 异步才到）',
    r2.ok === false && r2.bin === null, JSON.stringify(r2));
  check('X-9 条4 反向：预检不过时**一个进程都不起**（"不 spawn 必死的 bin" 不再只是注释）',
    spawned9.length === 0, '累计 spawn ' + spawned9.length + ' 次');
  const r3 = br.launchIsolated('file:///c:/x', { inventory: inv9(chromeBrow), binAvailable: () => true, spawn: fakeSpawn });
  check('X-9 条4 反向：非法 URL 依旧直接拒（预检不绕过 A4 闸门）',
    r3.ok === false && spawned9.length === 0, JSON.stringify(r3));
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
    ['证据必带探测诊断（pick/found/probed/default 四项在场，否则真机无从定性）', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')], 'c:\\ff\\firefox.exe', 'userchoice'), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => {
        const d = r.evidence && r.evidence.diagnostics;
        return !!d && d.platform === 'fixture' && d.pick === 'userchoice' && d.found.length === 2
          && d.found.every((f) => f.name && f.engine && f.via === 'fixture')
          && !!d.default && d.default.source === 'userchoice' && d.probed.length === 1
          && d.bin === r.evidence.bin;
      }, ['browser', 'C:\\FF\\firefox.exe']],
  ];
  for (const [name, url, opts, judge, form] of cases) {
    const r = await br.openBrowser(url, opts);
    const got = r.evidence ? [r.evidence.via, r.evidence.bin] : [];
    const formOk = !form || (got[0] === form[0] && (!form[1] || got[1] === form[1]));
    check('X-10 ' + name, judge(r) && vocabOk(r) === null && formOk,
      (vocabOk(r) || '') + (formOk ? '' : '形态漂移，实走 ' + got.join('/') + ' ') + JSON.stringify(r));
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
    // 多个候选而系统说不出默认项：按清单顺序猜一个就是「面板说开了、屏幕上是另一个浏览器」。
    ['win32 多候选且系统说不出默认项 = 拒绝按顺序猜', u,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')]), spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK) }, 'no-launcher'],
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

  // —— launchIsolated 必须共用同一套词汇（登录路径不得另立一套字段口径）——
  const li = br.launchIsolated(u, { inventory: IN([B('/usr/bin/google-chrome')]), profileDir: '/P', binAvailable: () => true, spawn: () => ({ on() {}, unref() {} }) });
  check('X-10 隔离打开同词汇：ok/confirmed/handedOff/reason/url 在场且为 handedOff（同步返回不宣称窗口出现）',
    li.ok === true && li.confirmed === false && li.handedOff === true && li.reason === null && li.url === u, JSON.stringify(li));
  check('X-10 隔离打开也带探测诊断（登录页打不开时，面板同样要能说明本机探到了什么）',
    !!li.evidence && !!li.evidence.diagnostics && li.evidence.diagnostics.found.length === 1, JSON.stringify(li.evidence));
  const liBad = br.launchIsolated('file:///etc/passwd', { binAvailable: () => true, spawn: () => ({ on() {}, unref() {} }) });
  check('X-10 隔离打开失败也带 reason/url/error（旧形态只给 ok:false，面板无从解释）',
    liBad.ok === false && liBad.reason === 'unsafe-url' && typeof liBad.error === 'string', JSON.stringify(liBad));
}

// -- X-11：唯一出口的源码级不变量 --
{
  const brRel = path.join(ROOT, 'src', 'platform', 'os', 'browser.js');
  const br = require(brRel);
  const src = fs.readFileSync(brRel, 'utf8');
  // 遍历 src/ 找 browser.<verb>( 的调用点：`browser.open(` 一旦重现，说明又开了第二条外部打开路。
  const walkSrc = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name); if (f.isDirectory()) walkSrc(p, out); else if (f.name.endsWith('.js')) out.push(p); } return out; };
  const files = walkSrc(path.join(ROOT, 'src'), []);
  const reOld = /browser\s*\.\s*open\s*\(/;
  const legacy = files.filter((f) => reOld.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  check('X-11 全仓 src/ 无第二条外部打开出口（browser.open 已收口）',
    legacy.length === 0, legacy.join(',') || ('扫描 ' + files.length + ' 个文件'));
  check('X-11 反向：判据能识别旧出口形态（否则本条恒绿）',
    reOld.test("function f(u) { return platform.browser.open(u); }"), 'hit');
  check('X-11 browser.js 不再导出 open（导出面即能力面，留着就是无人调用的第二出口）',
    br.open === undefined && typeof br.openBrowser === 'function' && typeof br.launchIsolated === 'function',
    Object.keys(br).join(','));
  check('X-11 支持外部打开的平台名单来自能力档位表（源码里不得再写第二份平台判断）',
    /CAPABILITY_PROFILES\[k\]\.openBrowser/.test(src) && !/SUPPORTED_OPEN_PLATFORMS\s*=\s*\[\s*['"]linux/.test(src), 'ok');
  const prof = require(path.join(ROOT, 'src', 'platform', 'os', 'capability-profile.js'));
  const declared = Object.keys(prof).filter((k) => prof[k].openBrowser === true).sort();
  check('X-11 档位表只声明三平台可外部打开（未知平台不开）',
    JSON.stringify(declared) === JSON.stringify(['darwin', 'linux', 'win32']), declared.join(','));
  // 消费方必须把三档结果原样交给面板，不得自行折算成布尔（旧形态：spawn 未抛错即 send ok:true）
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'instances.js'), 'utf8');
  check('X-11 open-web 原样透传三档结果且失败映射非 2xx（不得恒 200 把失败说成成功）',
    /openInSystemBrowser\(url\)/.test(apiSrc) && /send\(r\.ok \? 200 : 500, r\)/.test(apiSrc), 'ok');
  const oaSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'oauth.js'), 'utf8');
  check('X-11 一键登录把授权地址与 reason 一起交出（打不开时面板仍能给出可复制地址）',
    /reason:\s*evidence\.reason/.test(oaSrc) && /url:\s*authUrl/.test(oaSrc), 'ok');
  check('X-11 一键登录的成功档原样取自平台层（消费方不得自己宣称 handedOff/confirmed）',
    /Object\.assign\(\{\}, evidence,/.test(oaSrc) && !/handedOff:\s*true/.test(oaSrc), 'ok');
  check('X-11 反向：判据能识别消费方自宣称成功档（旧形态 confirmed:false,handedOff:true 硬编码）',
    /handedOff:\s*true/.test('return { ok: true, confirmed: false, handedOff: true };'), 'hit');
  const brOpSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'browser.js'), 'utf8');
  check('X-11 隔离打开的调用方交出 result 而非只取 profile（丢弃结果即丢弃失败原因）',
    /=\s*platform\.browser\.launchIsolated\(/.test(brOpSrc) && /return \{ profile: null, result:/.test(brOpSrc), 'ok');
  // 面板那条路的前提：内核得有一个「只受理本机来源」的代开端点。没有它，壳内面板只能自己 window.open
  //   （webview 丢弃 = 死单击），远程访问者则会把浏览器弹窗推到内核所在机器上。
  const guardSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'guard.js'), 'utf8');
  const om = /if \(req\.method === 'POST' && pathname === '\/env\/open-url'\) \{([\s\S]*?)\n {4}\}/.exec(guardSrc);
  const ob = om ? om[1] : '';
  check('X-11 代开端点存在且整段处理体被切片判定（切片为空即判据失去对象）', ob.length > 200, 'len=' + ob.length);
  check('X-11 代开端点走唯一出口、失败映射非 2xx、抛错路径仍带地址',
    /browser\.openBrowser\(url\)/.test(ob) && /send\(r\.ok \? 200 : 500, r\)/.test(ob) && /, url \}\)/.test(ob), 'ok');
  check('X-11 代开端点只受理回环来源（跨站与远程访客各有一闸，缺一即白送动作面）',
    /identity\.loopback/.test(ob) && /originAllowed\(req, sup\.config\.apiPort\)/.test(ob), 'ok');
  const badOpenUrl = "\n  const u = JSON.parse(body).url; require('node:child_process').exec(u);\n  return send(200, { ok: true });\n    }";
  check('X-11 反向：判据能识别旁路 spawn、恒 200 与无来源闸（否则上面两条恒绿）',
    !/platform\.browser\.openBrowser\(url\)/.test(badOpenUrl) && !/send\(r\.ok \? 200 : 500, r\)/.test(badOpenUrl)
      && !/identity\.loopback/.test(badOpenUrl), 'hit');

  // —— 分层归属：平台事实只写在探测层一处，别的文件一律不得再写第二份 ——
  //   为什么钉这一条：本轮 Windows 缺陷的根因不是某个分支写错，而是「系统里有什么浏览器」这件事
  //   从来没有一个唯一回答处 —— 选路层顺手查一次注册表、router 侧自己摸 X socket，两份副本必然漂移。
  const detRel = path.join(ROOT, 'src', 'platform', 'os', 'browser-inventory.js');
  const factRe = /StartMenuInternet|UrlAssociations|RegisteredApplications|App Paths|urlsForApplicationsToOpenURL|URLForApplicationToOpenURL|mimeapps|x-scheme-handler|xdg-settings/;
  const factFiles = files.filter((f) => f !== detRel && factRe.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
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
  const brOpEnv = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'browser.js'), 'utf8');
  check('X-11 隔离登录的环境补齐委托 desktop.sessionEnv（会话判据与补齐必须同源，否则一边说有、一边补不全）',
    /function graphicalEnv\(\) \{\s*return desktop\.sessionEnv\(\);?\s*\}/.test(brOpEnv)
    && /require\('\.\.\/\.\.\/\.\.\/platform\/os\/desktop'\)/.test(brOpEnv), 'ok');

  // —— 只读探测面：面板/排障要能直接问「本机探到了什么」，且它绝不允许顺手做动作 ——
  const obm = /if \(req\.method === 'GET' && pathname === '\/env\/browsers'\) \{([\s\S]*?)\n {4}\}/.exec(guardSrc);
  const obmBody = obm ? obm[1] : '';
  check('X-11 浏览器清单端点存在且整段处理体被切片判定（切片为空即判据失去对象）',
    obmBody.length > 150, 'len=' + obmBody.length);
  check('X-11 清单端点是只读探测面：走 browser.listBrowsers、过同源闸、且绝不触到打开出口',
    /browser\.listBrowsers\(/.test(obmBody) && /originAllowed\(req, sup\.config\.apiPort\)/.test(obmBody)
    && !/openBrowser\(/.test(obmBody) && !/spawn/.test(obmBody), 'ok');
  check('X-11 只读面与动作面的来源闸不同级：清单过同源即可（远程面板要能显示本机探到了什么），'
    + '而代开端点必须再加回环闸（否则等于白送「在他人机器上开浏览器」）',
    /identity\.loopback/.test(ob) && !/identity\.loopback/.test(obmBody), 'ok');
  check('X-11 反向：判据能识别「清单端点顺手开浏览器」与无来源闸的形态',
    !/browser\.listBrowsers\(/.test("return send(200, { ok: true });")
    && !/originAllowed\(req, sup\.config\.apiPort\)/.test("return send(200, browser.listBrowsers());"), 'hit');
  const ctSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'contract.js'), 'utf8');
  check('X-11 /env/browsers 在契约里只登记一次（登记面即对外能力面，漏登记=不承诺）',
    (ctSrc.match(/\/env\/browsers/g) || []).length === 1, String((ctSrc.match(/\/env\/browsers/g) || []).length));
  check('X-11 清单与打开共用同一探测实现与缓存（两条路对「系统里有什么」不得给出两个答案）',
    /detector\.inventory\(/.test(src) && /listBrowsers/.test(src) && typeof br.listBrowsers === 'function'
    && typeof br.invalidateBrowsers === 'function', 'ok');

  // 出口如何交到域手里也要有闸：网关只允许「缺省即平台层唯一出口、注入只服务于测试」这一种装配。
  //   否则调用方传个 deps.browser 就把外部打开换了实现，S-1 的唯一出口判据形同虚设。
  const gwSrc = fs.readFileSync(path.join(ROOT, 'src', 'api', 'transport', 'server.js'), 'utf8');
  check('X-11 出口由网关缺省装配并随 ctx 交出（无缺省即留第二出口位）',
    /const browser = \(deps && deps\.browser\) \|\| browserExit;/.test(gwSrc)
      && /require\('\.\.\/\.\.\/platform\/os\/browser'\)/.test(gwSrc)
      && /const ctx = \{[^}]*\bbrowser\b/.test(gwSrc), 'ok');
  const gwNoDefault = "  const browser = deps.browser;\n    const ctx = { sup, req };";
  check('X-11 反向：判据能识别「deps 不给缺省」与「ctx 不带出口」的装配形态',
    !/const browser = \(deps && deps\.browser\) \|\| browserExit;/.test(gwNoDefault)
      && !/const ctx = \{[^}]*\bbrowser\b/.test(gwNoDefault), 'hit');

  // 最后一环在面板：外部打开地址的窗口创建必须只有一个出口，且各页面必须经统一入口消费结果。
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
  const entry = readUi('features/supervisor/openExternal.tsx');
  check('X-11 面板结果分档只有一处，且失败也渲染地址行（假成功在结构上无法出现）',
    /classifyOpenResult\(/.test(entry) && /description:\s*url \|\| shown \? <OpenResultBody url=\{url\} detail=\{shown\} \/>/.test(entry)
    && /\{url \? <OpenUrlRow url=\{url\} \/> : null\}/.test(entry), 'ok');
  const pages = ['features/supervisor/InstancesPage.tsx', 'features/supervisor/OverviewPage.tsx', 'features/supervisor/RouterPage.tsx', 'features/supervisor/LanPage.tsx']
    .filter((p) => !/runOpenExternal\(/.test(readUi(p)));
  check('X-11 四处外部打开入口都经统一入口消费结果（各自表述成败即病根）',
    pages.length === 0, pages.join(',') || 'ok');
  // 失败档的地址要能活着走到面板：后端把 ok:false 映射为非 2xx，若 http() 只抛一句文案，
  //   面板就拿不到 url，用户在最需要的这一档反而只剩「重新点一次」。
  const cliSrc = readUi('services/supervisor/client.ts');
  check('X-11 非 2xx 抛错随附响应体（失败档的 url/reason 才有抵达面板的路）',
    /err\.body = data/.test(cliSrc) && /instanceOpenWeb: .*OpenExternalResult/.test(cliSrc), 'ok');
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
  const eoSrc = readUi('services/supervisor/externalOpen.ts');
  check('X-11 面板选路判据只有一条（来源回环与否），本机路径唯一出口是内核端点',
    /servedByKernelHost\(\)/.test(eoSrc) && /supervisorApi\.envOpenUrl\(url\)/.test(eoSrc), 'ok');
  // 证据必须一路走到屏幕：evidence 只躺在响应体里时，真机报错就只剩一句无法定位的文案
  //   （本能力的上一条缺陷正是这样才被读成「产品打不开浏览器」）。
  check('X-11 启动形态证据抵达面板并随非 confirmed 档渲染（evidenceDetail 取自内核 evidence）',
    /export function evidenceDetail\(/.test(eoSrc) && /ownsWindow/.test(eoSrc)
    && /detail = evidenceDetail\(/.test(eoSrc) && /<OpenResultBody url=\{url\} detail=\{shown\} \/>/.test(entry), 'ok');
  check('X-11 反向：只回 title 不分摊证据的旧呈现口会被上面那条识别',
    !/evidenceDetail\(/.test('export function classifyOpenResult(r){ return { tier: "failed", url: null, title: r.error }; }'), 'hit');
  check('X-11 /env/open-url 在客户端只登记一次（第二处即第二个调用方）',
    (cliSrc.match(/\/env\/open-url/g) || []).length === 1, String((cliSrc.match(/\/env\/open-url/g) || []).length));
}

x10().catch((e) => check('X-10 异步判据自身未抛错', false, String((e && e.stack) || e))).then(finish);

