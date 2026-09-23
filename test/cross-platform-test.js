#!/usr/bin/env node
'use strict';

// 跨平台规范回归（能力矩阵见 PLATFORM-CAPABILITY-MATRIX.md）：
//   P0 可执行解析：Windows 扩展名/PATHEXT、标准目录跨平台差异、PATH 连接符
//   P1 文件保护：Unix chmod / Windows icacls（平台条件断言）
//   P2 无硬编码 ':' 连接 PATH
//   P3 反代载体真进程冒烟：carrier 拉起->真监听->锚点归属->真终止（CI 三 runner 各验本平台）
// 自包含，不触碰生产文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xplat-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async function () {
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path'));
  const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect'));

  // -- P0 可执行解析 --
  console.log('== P0 跨平台可执行解析 ==');
  const unixNames = ep.candidateNames('dsh-supervisor', 'linux');
  check('unix 候选名无扩展名', unixNames.length === 1 && unixNames[0] === 'dsh-supervisor', JSON.stringify(unixNames));
  const winNames = ep.candidateNames('dsh-supervisor', 'win32');
  check('win 首选 .exe', winNames[0] === 'dsh-supervisor.exe', JSON.stringify(winNames));
  check('win 含 .cmd 垫片', winNames.includes('dsh-supervisor.cmd'), JSON.stringify(winNames));
  check('win 无扩展名兜底在末位', winNames[winNames.length - 1] === 'dsh-supervisor', JSON.stringify(winNames));

  const dl = ep.standardDirs('linux', '/h');
  check('linux 标准目录含 .local/bin 与 .npm-global/bin', dl.includes(path.join('/h', '.local', 'bin')) && dl.includes(path.join('/h', '.npm-global', 'bin')), JSON.stringify(dl));
  const dm = ep.standardDirs('darwin', '/h');
  check('darwin 追加 Homebrew 路径', dm.includes('/opt/homebrew/bin') && dm.includes('/usr/local/bin'), JSON.stringify(dm));
  const dw = ep.standardDirs('win32', 'C:/U/X');
  //  旧写法 replace(/\\\\/g, '/') 匹配的是**两个**反斜杠，而 Windows 路径是单个反斜杠，
  //   于是 replace 不生效 -> 该断言在 Windows CI 上恒失败（Linux 因 standardDirs 返回正斜杠而侥幸通过）。
  //   改为归一化「任意连续的分隔符」，与平台无关。
  const norm = (d) => d.replace(/[\\/]+/g, '/');
  check('win 含 .local/bin 兼容目录', dw.some((d) => norm(d).endsWith('/.local/bin')), JSON.stringify(dw));

  // 真实解析：当前平台的 node 应可解析到
  const nodeHit = ep.resolveExecutable(process.platform === 'win32' ? 'node' : 'node');
  check('resolveExecutable(node) 命中真实文件', !!nodeHit && fs.statSync(nodeHit).isFile(), String(nodeHit));
  check('resolveExecutable(不存在) 返回 null', ep.resolveExecutable('dsh-nonexistent-xyz-123') === null, '');

  // daemonCommand/guiCommand 必须返回绝对路径（不再硬拼无扩展名的猜测）
  const autostart = require(path.join(ROOT, 'src', 'platform', 'os', 'autostart'));
  const dc = autostart.daemonCommand();
  check('daemonCommand 返回绝对路径', path.isAbsolute(dc), dc);
  if (process.platform === 'win32') check('win daemonCommand 含扩展名', /\.(exe|cmd|bat)$/i.test(dc), dc);
  const gc = autostart.guiCommand();
  check('guiCommand 返回绝对路径', path.isAbsolute(gc), gc);

  // -- P1 文件保护 --
  console.log('== P1 跨平台文件保护 ==');
  const dir = path.join(TMP, 'priv');
  const pr = fp.ensurePrivateDir(dir);
  check('ensurePrivateDir 成功', pr.ok === true, JSON.stringify(pr));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(dir).mode & 0o777;
    check('unix 目录权限 0700', mode === 0o700, mode.toString(8));
    const f = path.join(dir, 'secret.json');
    const fr = fp.writePrivate(f, '{"token":"x"}');
    check('writePrivate 成功', fr.ok === true, JSON.stringify(fr));
    check('unix 文件权限 0600', (fs.statSync(f).mode & 0o777) === 0o600, (fs.statSync(f).mode & 0o777).toString(8));
    check('writePrivate 内容正确', JSON.parse(fs.readFileSync(f, 'utf8')).token === 'x', '');
    check('writePrivate 无残留 tmp', !fs.readdirSync(dir).some((n) => n.includes('.tmp')), JSON.stringify(fs.readdirSync(dir)));
  } else {
    check('win 保护走 icacls 或明确降级', pr.mode === 'icacls-dir' || pr.mode === 'none', JSON.stringify(pr));
  }
  check('protectFile 对不存在文件返回失败而非抛出', (() => { try { const r = fp.protectFile(path.join(TMP, 'nope')); return r.ok === false; } catch { return false; } })(), '');

  // -- P2 无硬编码 PATH 连接符 --
  console.log('== P2 PATH 连接符 ==');
  //  步骤8a：instance 拆为 index/core/ops/upgrade 四文件，
  //   判据须读**整域**（否则文件拆分即静默失去覆盖面）。见 DIRECTORY-STRUCTURE-DESIGN 。
  //  instance 域已拆为 8 文件；按目录聚合读取，新增/改名文件自动纳入覆盖面（不再硬编码文件名）。
  const instSrc = fs.readdirSync(path.join(ROOT, 'src', 'domains', 'instance')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', f), 'utf8'))
    .join(String.fromCharCode(10));
  check("instance 无 join(':') 拼 PATH", !/process\.env\.PATH[^\n]*\.join\(':'\)/.test(instSrc), '');
  check('instance 使用 path.delimiter', instSrc.includes('path.delimiter'), '');

  // -- P1-2 bin 安装跨平台 --
  console.log('== P1-2 bin 安装 ==');
  const binSrc = fs.readFileSync(path.join(ROOT, 'bin', 'dsh-supervisor'), 'utf8');
  check('bin 安装有 Windows 分支（.cmd 垫片）', /IS_WINDOWS/.test(binSrc) && binSrc.includes('.cmd'), '');
  check('bin 无裸 symlinkSync（受平台分支保护）', /if \(IS_WINDOWS\)/.test(binSrc), '');

  // -- 分层不变量：平台命令不得出现在域层/编排层 --
  console.log('== 分层不变量（平台命令收敛）==');
  {
    const forbidden = ['systemctl', 'systemd-run', 'launchctl', 'schtasks', 'taskkill', 'netstat', 'lsof', 'wmic', 'osascript', 'notify-send', 'xdg-open'];
    //  步骤6：guard/ -> app/（编排层重组，DIRECTORY-STRUCTURE-DESIGN）。
    //   平台命令收敛扫描须覆盖编排层新目录名，否则判据静默失去覆盖面。
    const scanDirs = ['domains', 'app', 'api'];
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.js')) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const cmd of forbidden) {
          // 匹配 execFileSync('cmd' / execFile('cmd' / spawn('cmd' —— 仅实际调用（排除注释里的出现）
          const re = new RegExp("(execFileSync|execFile|spawnSync|spawn)\\(\\s*['\"]" + cmd + "['\"]");
          if (re.test(src)) offenders.push(path.relative(ROOT, p) + ' → ' + cmd);
        }
      }
    };
    for (const d of scanDirs) walk(path.join(ROOT, 'src', d));
    check('域层/guard/api 无裸平台命令调用', offenders.length === 0, offenders.join('; ') || 'clean');
    // supervisor.js（编排层）同样不得裸调
    const supSrc = fs.readFileSync(path.join(ROOT, 'src', 'supervisor.js'), 'utf8');
    const supBad = forbidden.filter((cmd) => new RegExp("(execFileSync|execFile|spawn)\\(\\s*['\"]" + cmd + "['\"]").test(supSrc));
    check('supervisor（编排层）无裸平台命令调用', supBad.length === 0, supBad.join(', ') || 'clean');
  }

  // -- 服务管理器 Provider --
  console.log('== 服务管理器 Provider ==');
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service'));
  const cur = svc.current();
  const pl = process.platform;
  // W3 分派：darwin/win32 恒 portable；未知平台恒 none；linux 按 systemd-run **实测**（容器/WSL1 落 portable）。
  const expectedKind = pl === 'darwin' || pl === 'win32' ? 'portable' : pl === 'linux' ? null : 'none';
  check('provider kind 匹配 W3 分派（linux 实测 systemd/portable，不写死）',
    expectedKind === null ? (cur.kind === 'systemd' || cur.kind === 'portable') : cur.kind === expectedKind,
    cur.kind + ' vs ' + expectedKind);
  const iface = ['daemonReload', 'stopUnit', 'resetFailed', 'isUnitActive', 'transientUnitFile', 'cleanTransient', 'startTransient', 'setLimits'];
  check('provider 接口完整（含 W3 setLimits）', iface.every((m) => typeof cur[m] === 'function'), iface.filter((m) => typeof cur[m] !== 'function').join(',') || 'ok');
  check('provider 声明能力', typeof cur.supportsUnits === 'boolean' && typeof cur.supportsTransient === 'boolean', '');
  if (cur.kind === 'none') {
    check('未知平台 startTransient 抛 CapabilityError（显式失败，绝不静默）', (() => { try { cur.startTransient({ unit: 'x', cmd: ['node'] }); return false; } catch (e) { return e.name === 'CapabilityError' || e.code === 'CAPABILITY_UNSUPPORTED'; } })(), '');
  } else {
    // 真宿主上**绝不调用** startTransient（会真拉进程）——档位声明即该侧解锁证据，
    // 真实 spawn/kill 链由 platform-layer-portability X-3c 在各自 runner 上承担。
    check('三平台 startTransient 能力声明为可拉起（supportsTransient=true）', cur.supportsTransient === true, '');
  }

  // -- 状态暴露 --
  console.log('== 保护状态可观测 ==');
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const s = new Supervisor({
    command: ['node', '-e', '0'], healthUrl: 'http://127.0.0.1:28031/', probeIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28030,
    stateFile: path.join(TMP, 'state.json'), logFile: path.join(TMP, 'e.log'),
    supervisorLogFile: path.join(TMP, 's.log'), dshLogFile: path.join(TMP, 'd.log'), upgradeLogFile: path.join(TMP, 'u.log'),
  });
  check('statusSummary 暴露 dataDirProtected', s.statusSummary().dataDirProtected === true, String(s.statusSummary().dataDirProtected));

  // -- A1 断点修复：能力矩阵接线（后端暴露 -> 前端类型 -> UI 呈现）--
  console.log('== A1 能力矩阵接线 ==');
  {
    const env = await s.envStatus();
    check('A1-a envStatus 暴露 capabilities', env.capabilities && typeof env.capabilities === 'object', JSON.stringify(env.capabilities));
    const c = env.capabilities || {};
    check('A1-b capabilities 含平台/能力字段',
      typeof c.platform === 'string' && typeof c.sandboxLaunch === 'boolean' && typeof c.sandboxEnforcement === 'string' && typeof c.pidAdoption === 'boolean' && typeof c.hostService === 'string',
      JSON.stringify(c));
    check('A1-c capabilities 与 capabilityProfile 一致', c.hostService === require(path.join(ROOT, 'src', 'platform', 'os', 'index')).capabilityProfile().hostService, String(c.hostService));
    // 前端类型 + UI 消费（静态契约）
    const typesTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'types.ts'), 'utf8');
    check('A1-d 前端声明 PlatformCapabilities 且 EnvStatus 引用', /interface PlatformCapabilities/.test(typesTs) && /capabilities\?:\s*PlatformCapabilities/.test(typesTs), 'ok');
    const instTsx = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'InstancesPage.tsx'), 'utf8');
    check('A1-e UI 消费 capabilities 并前置提示', instTsx.includes('envStatus()') && instTsx.includes('sandboxLaunch') && instTsx.includes('sandboxUnsupported'), 'ok');
    // A1-g（W4 呈现定版）：后端产出的新观测字段必须在**前端类型**里存在，否则 tsc 不会报错、
    //  UI 只是静默少显示（本仓同类失效：EnvStatus.npm 三段字段声明滞后）。判据两端同时把尺：
    //  后端 viewRow 有 usage / env.js 有 sandboxBudget 时，types.ts 与页面必须同源消费。
    check('A1-g 前端类型声明 usage 与 SandboxBudget 且被消费',
      /usage\?:\s*\{[^}]*memMb[^}]*cpuPct/.test(typesTs)
        && /export interface SandboxBudget/.test(typesTs)
        && /sandboxBudget\?:\s*SandboxBudget/.test(typesTs)
        && instTsx.includes('state?.usage') && instTsx.includes('sandboxEnforcement'),
      'ok');
    check('A1-g2 反向：软限档位不伪装成硬限（页面须分档标注）',
      /softTier/.test(instTsx) && /supervise/.test(instTsx) && /软限/.test(instTsx), '有');
    // 误导性错误指引已修正：不再指向不存在的裸字段路径
    //  步骤8a：instance 拆为 index/core/ops/upgrade 四文件，
  //   判据须读**整域**（否则文件拆分即静默失去覆盖面）。见 DIRECTORY-STRUCTURE-DESIGN 。
  //  instance 域已拆为 8 文件；按目录聚合读取，新增/改名文件自动纳入覆盖面（不再硬编码文件名）。
  const instSrc = fs.readdirSync(path.join(ROOT, 'src', 'domains', 'instance')).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', f), 'utf8'))
    .join(String.fromCharCode(10));
    check('A1-f 沙箱错误指引指向真实端点/字段',
      instSrc.includes('GET /env/status') && instSrc.includes('capabilities.sandboxLaunch'),
      'ok');
  }

  // -- A4 断点修复：changelog 入口 --
  console.log('== A4 changelog 接线 ==');
  {
    const clientTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
    check('A4-a client 有 dshChangelog / guardChangelog', /dshChangelog:\s*\(\)\s*=>\s*getText\("\/changelog"\)/.test(clientTs) && /guardChangelog/.test(clientTs), 'ok');
    check('A4-b client 实现 getText（text/plain 端点）', /async function getText/.test(clientTs), 'ok');
    const aboutTsx = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'settings', 'AboutCard.tsx'), 'utf8');
    check('A4-c AboutCard 提供更新日志入口', aboutTsx.includes('dshChangelog') && aboutTsx.includes('guardChangelog') && aboutTsx.includes('Dialog'), 'ok');
    // 命名统一：后端话术指向「概览 - 版本与升级」
    const guardApi = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'guard.js'), 'utf8');
    check('A4-d 后端话术命名与 UI 位置统一', guardApi.includes('概览 · 版本与升级'), 'ok');
  }

  // -- A5 工具链可见性：npm 的事实走完「契约 -> /env/status -> 面板」整条链 --
  //   壳侧曾「装了 npm 却看不见 npm」；内核侧是同根因的另一半：/env/status 的 node 有三段、
  //   npm 只有 detected；env.js 另起一处手写契约路径；面板只念 Node 版本，而把 npm 标成
  //   required 的声明式目录零消费。三处各自都能自洽，合起来是「面板说就绪、实机跑不通」。
  console.log('== A5 工具链可见性（npm 与 node 同现）==');
  {
    const rc = require(path.join(ROOT, 'src', 'platform', 'contract', 'runtime'));
    const savedRoot = process.env.DSH_SUPERVISOR_HOME;
    process.env.DSH_SUPERVISOR_HOME = path.join(TMP, 'tcroot');
    fs.mkdirSync(path.dirname(rc.file()), { recursive: true });
    const TC_NODE_DIR = path.join(TMP, 'tcnode');
    fs.mkdirSync(TC_NODE_DIR, { recursive: true });
    const TC_NODE = path.join(TC_NODE_DIR, 'node');
    const TC_NPM_CLI = path.join(TC_NODE_DIR, 'npm-cli.js');
    fs.writeFileSync(TC_NODE, '#!/bin/sh\n');
    fs.writeFileSync(TC_NPM_CLI, '\n');
    fs.writeFileSync(rc.file(), JSON.stringify({
      schema: 2, writtenBy: 'test',
      nodePath: TC_NODE, nodeVersion: 'v22.12.0', nodeBinDir: TC_NODE_DIR, minNode: 'v22.12.0',
      npmPath: TC_NODE, npmArgs: [TC_NPM_CLI],
      npm: { path: TC_NODE, args: [TC_NPM_CLI], version: '10.9.2' },
    }), null, 2);

    const env = await s.envStatus();
    check('A5-a npm 与 node 同构三段（detected/runtime/path）',
      ['detected', 'runtime', 'path'].every((k) => k in env.npm) && ['detected', 'runtime', 'path'].every((k) => k in env.node),
      JSON.stringify(env.npm));
    check('A5-b npm.runtime 取契约回读的 npm 版本（不得念成 node 版本）',
      env.npm.runtime === '10.9.2' && env.node.runtime === 'v22.12.0', 'npm=' + env.npm.runtime + ' node=' + env.node.runtime);
    check('A5-c npm.path 与契约解析到的可执行同源', env.npm.path === TC_NODE, String(env.npm.path));
    const items = (env.catalog && env.catalog.items) || {};
    const required = Object.keys(items).filter((k) => items[k] && items[k].required);
    check('A5-d catalog 必填项同时含 node 与 npm（面板按必填项渲染）',
      required.includes('node') && required.includes('npm'), required.join(','));
    check('A5-e npm 条目有 label/state（声明式目录形状稳定）',
      !!(items.npm && items.npm.label && typeof items.npm.state === 'string'), JSON.stringify(items.npm));

    // 反向：契约缺席时 runtime/path 必须是 null（不编造、不拿 node 版本或占位文案顶上）。
    fs.unlinkSync(rc.file());
    const bareEnv = await s.envStatus();
    check('A5-f 无契约时 npm/node 的 runtime 与 path 均为 null',
      bareEnv.npm.runtime === null && bareEnv.npm.path === null && bareEnv.node.runtime === null,
      JSON.stringify(bareEnv.npm));
    check('A5-g 无契约时 envStatus 不抛且仍给 detected',
      typeof bareEnv.npm.detected === 'string' || bareEnv.npm.detected === null, String(bareEnv.npm.detected));
    if (savedRoot === undefined) delete process.env.DSH_SUPERVISOR_HOME;
    else process.env.DSH_SUPERVISOR_HOME = savedRoot;

    // 契约读取口唯一：env.js 必须经 platform/contract/runtime，不得再手拼 runtime.json。
    //   判据只看代码行：本组说明注释必然提到 runtime.json 与旧的拼法，不剥离即自匹配。
    const envJsAll = fs.readFileSync(path.join(ROOT, 'src', 'app', 'settings', 'env.js'), 'utf8');
    const envJs = envJsAll.split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join(String.fromCharCode(10));
    check('A5-h env.js 经契约模块读取',
      /require\([^)]*contract\/runtime[^)]*\)/.test(envJs) && /runtimeContract\.read\(\)/.test(envJs), 'ok');
    check('A5-i env.js 不再手拼契约路径（第二处读取口）',
      !/['"]runtime\.json['"]/.test(envJs) && !/dirname\(this\.config\.stateFile\)/.test(envJs), 'ok');

    // 前端类型与后端产出对齐（round13 同类缺陷：声明与实现分叉，tsc 不会报错）。
    const typesTs = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'types.ts'), 'utf8');
    check('A5-j EnvStatus.npm 声明三段（防前端拿不到新字段）',
      /npm\?:\s*\{[^}]*runtime\??:[^}]*path\??:/.test(typesTs), 'ok');
    check('A5-k 目录条目独立成类 EnvCatalogItem 且被 EnvStatus 引用',
      /export interface EnvCatalogItem/.test(typesTs) && /items\?:\s*Record<string,\s*EnvCatalogItem>/.test(typesTs), 'ok');
    check('A5-l 反向：只声明 detected 的旧形状被同一把尺拒',
      !/npm\?:\s*\{[^}]*runtime\??:[^}]*path\??:/.test('export interface EnvStatus { npm?: { detected?: string }; }'), '已拒');

    // 面板环境卡：按必填项遍历渲染，不得再硬编码只念 Node（判据只看代码行，注释必然提旧形状）。
    const ovTsx = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'OverviewPage.tsx'), 'utf8');
    const ovCode = ovTsx.split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join(String.fromCharCode(10));
    check('A5-m 环境卡消费 /env/status 的 catalog',
      /supervisorApi\.envStatus\(\)/.test(ovCode) && /catalog\?\.items/.test(ovCode), 'ok');
    check('A5-n 环境卡按必填项遍历渲染（不点名具体工具）',
      /\.filter\(\(\[, it\]\) => it\.required\)/.test(ovCode) && /required\.map\(\(\[id, it\]\)/.test(ovCode)
        && /\{it\.label\}/.test(ovCode), 'ok');
    check('A5-o 环境卡不再使用硬编码的 Node 单值行', !/环境检测 · Node v\{/.test(ovCode), 'ok');
    check('A5-p 反向：只念 Node 的旧形状必被抓到',
      /环境检测 · Node v\{/.test('      <span>环境检测 · Node v{node.current}</span>')
        && !/\.filter\(\(\[, it\]\) => it\.required\)/.test('  const n = node.current;'), '已抓到');
    check('A5-q LTS 线提示仍取 /env/node-lts（工具链清单与 LTS 建议不互相顶替）',
      /supervisorApi\.nodeLts\(\)/.test(ovCode) && /ltsLine === false/.test(ovCode), 'ok');
  }

  // -- P3 反代载体契约冒烟（PROXY-ISOLATION-STANDARD 的 CI 实机牙齿）--
  //   反代链跨平台缺陷全部住在「真 spawn->真监听->真终止」段：单元面把 spawn 打桩后
  //   四平台 CI 恒绿（win32 组信号缺失/EINVAL、macOS 归属误判都在用户机器上才红）。
  //   假供应商（纯 node 入口 + --port 监听）走 carrier 全生命周期；新增真实反代供应商
  //   不需要改本段（载体与供应商无关），载体契约一旦变化这里必改。
  {
    console.log('\n== P3 反代载体真进程冒烟 ==');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const carrier = require(path.join(ROOT, 'src', 'platform', 'os', 'carrier'));
    const pidlookup = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const PORT = safePort('cross-platform', 0);
    const PKG_MARKER = 'fakeproxy-demo-pkg';
    const dir = path.join(TMP, PKG_MARKER);
    fs.mkdirSync(dir, { recursive: true });
    // 30s 硬保险：本测试进程中途死掉也不留孤儿（全局作业规则）；SIGTERM 速退。
    const entry = path.join(dir, 'entry.js');
    fs.writeFileSync(entry, "'use strict';\n"
      + "const http = require('node:http');\n"
      + "const argv = process.argv.slice(2);\n"
      + "const port = Number(argv[argv.indexOf('--port') + 1]);\n"
      + "const srv = http.createServer((req, res) => { if (req.url === '/health') { res.writeHead(200); res.end('{\"ok\":true}'); } else { res.writeHead(404); res.end(); } });\n"
      + "srv.listen(port, '127.0.0.1');\n"
      + "setTimeout(() => process.exit(0), 30000).unref();\n"
      + "process.on('SIGTERM', () => process.exit(0));\n");
    const pidFile = path.join(dir, 'run.pid');
    const identity = { port: PORT, pidFile, anchors: [PKG_MARKER, '--port ' + PORT] };
    const spawnFake = () => carrier.start({
      cmd: [process.execPath, entry, PKG_MARKER, '--host', '127.0.0.1', '--port', String(PORT)],
      identity,
    });
    let h = spawnFake();
    check('P3-a start 正 pid + run.pid 落盘一致',
      Number.isInteger(h.pid) && h.pid > 0 && parseInt(String(fs.readFileSync(pidFile, 'utf8')), 10) === h.pid, String(h.pid));
    let health = false;
    const dl = Date.now() + 10000;
    while (Date.now() < dl && !health) {
      try { health = (await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { await sleep(250); }
    }
    check('P3-b 真监听：/health 200（本平台 spawn→端口全链可用）', health, health ? 'ok' : '10s 超时');
    const st1 = carrier.probe(identity);
    check('P3-c 归属 ours（pidFile+锚点）', st1.state === 'ours' && st1.pid === h.pid, JSON.stringify(st1));
    // 删 run.pid 只剩端口反查：npx 形态里载体进程与监听子孙不同 pid，锚点必须仍认领（同语义面）。
    fs.unlinkSync(pidFile);
    check('P3-c 无 run.pid 时端口锚点仍 ours（npx 子孙监听形态）', carrier.probe(identity).state === 'ours', JSON.stringify(carrier.probe(identity)));
    const stF = carrier.probe({ port: PORT, pidFile: null, anchors: ['no-such-vendor-pkg'] });
    check('P3-d 错锚点判 foreign（绝不误认领他人进程——孤儿误杀类反例锁）', stF.state === 'foreign', JSON.stringify(stF));
    carrier.signalTermination(h.pid);
    let gone = false;
    const dl2 = Date.now() + 6000;
    while (Date.now() < dl2 && !gone) { gone = !pidlookup.isAlive(h.pid); if (!gone) await sleep(200); }
    check('P3-e signalTermination 后真退', gone, gone ? 'ok' : '6s 未退');
    let freed = false;
    const dl3 = Date.now() + 4000;
    while (Date.now() < dl3 && !freed) { freed = pidlookup.findListeningPid(PORT) === null; if (!freed) await sleep(200); }
    check('P3-e 端口释放（无占端口孤儿）+ probe 收敛 dead', freed && carrier.probe(identity).state === 'dead', freed ? 'ok' : '仍被监听');
    check('P3-e pidlookup.isZombie 门面可用（域内 /proc 读取的合法替代）', typeof pidlookup.isZombie(h.pid) === 'boolean', 'ok');
    h = spawnFake();
    check('P3-f 同端口重拉 + 确认式 stop true 且清 run.pid',
      carrier.stop(identity, { timeoutMs: 3000 }) === true && !fs.existsSync(pidFile), 'ok');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
