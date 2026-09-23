#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 第八轮修复的回归
//
// ## 缺陷
//
// P0-A `deploy.detect()` 只认「二进制 magic 头」，而发布形态**早已弃 SEA**
//   （build-launcher.sh:2 明写）-> 真实用户落 `source-shell` -> 自更新永久不可用。
//
// P0-B `DaemonLifecycle.cmdMark` 传的是 `'router-daemon'`，而真实 cmdline 是
//   `node <pkg>/src/domains/router/daemon.js -c …` —— 子串**不匹配**（实测 -1）
//   -> ctl 属主反查恒 null -> 换代逻辑与「异主不接管」全线死代码。
//
// P1-C `semverCompare` 用 `split('-')` 只取前两段 -> `1.0.0-beta-2` 的 `-2` 被丢弃
//   -> 与 `1.0.0-beta-1` 判等（实测均为 0）。
//
// P1-D `self-update` 的 `prune`/`currentDir` 用**字符串**比较版本 ->
//   `v0.10.0` 被排在 `v0.9.0` 之前 -> prune 从下标 0 删，**删掉刚装的当前版本**。
//
// P1-E `_spawn()` 不接 `'error'`、不看 `child.pid` 就写身份 -> ENOENT 时
//   异常逃逸（守卫自杀）+ 身份写成 undefined（每轮重复 spawn）。
//
// ## 锁定不变量
//   J-a  deploy.detect() 能识别 **launcher 形态**（同目录/上级有 core.cjs）
//   J-b  DaemonLifecycle 的标记**包含从 script 派生的路径**，且能匹配真实 cmdline
//   J-c  semverCompare 保留连字符后的完整 prerelease，且符合 semver 规范
//   J-d  self-update 的版本排序用 semverCompare（非字符串）
//   J-e  _spawn 接 'error'；无 pid 时不写身份并返回 failed
// ---------------------------------------------------------------------------
//  编号消歧：本文件里
//   - `E-1 / E-2 / E-4`（J-n/J-o/J-p）＝ 审计报告 **跨域立项**编号；
//   - `UI 条 5 / UI 条 6`（J-l/J-m）＝ **发布/UI 六条**，与跨域立项编号无关。
//   两套编号无关，别把「E-1 绿了」读成「发布链第 1 条被验过」。
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
//  步骤8a（DIRECTORY-STRUCTURE-DESIGN）：shell/plugin 两域已拆为
//   index/journal/restart 与 index/ops/store/market。本套源码级断言的**对象是「域」**
//   （restartShell 的 'error' 监听、插件 CLI 的 detached 杀树、市场重定向协议），
//   与文件切分无关 —— 故按域聚合读取，避免把判据搬走而静默失去覆盖面。
const readDomain = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).sort()
  .map((f) => read(dir + '/' + f)).join(String.fromCharCode(10));

// -- J-a：deploy launcher 形态识别 --
{
  const dep = require(path.join(ROOT, 'src', 'platform', 'contract', 'deploy.js'));
  check('J-a 导出 isLauncherForm', typeof dep.isLauncherForm === 'function', typeof dep.isLauncherForm);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depj-'));
  // 1) 发布布局：<pkg>/bin/dsh-supervisor + <pkg>/core.cjs
  const pkg = path.join(tmp, 'pkg');
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  const tgt = path.join(pkg, 'bin', 'dsh-supervisor');
  fs.writeFileSync(tgt, '#!/usr/bin/env node\n');
  //  顺序：先断言「无 core.cjs 时不识别」，再放 core.cjs 断言「识别」。
  //   （我第一版把断言写在创建 core.cjs 之前，却期望 true —— 自造的假失败。）
  check('J-a 尚未放 core.cjs → 不识别', dep.isLauncherForm(tgt) === false, 'false');
  fs.writeFileSync(path.join(pkg, 'core.cjs'), '//b');
  check('J-a 放上 core.cjs（发布布局）→ 识别为 launcher', dep.isLauncherForm(tgt) === true, 'true');
  // 2) 源码布局：无 core.cjs
  const src = path.join(tmp, 'repo', 'bin');
  fs.mkdirSync(src, { recursive: true });
  const t2 = path.join(src, 'dsh-supervisor');
  fs.writeFileSync(t2, '#!/usr/bin/env node\n');
  check('J-a 源码布局（无 core.cjs）→ 不误判', dep.isLauncherForm(t2) === false, 'false');
  fs.rmSync(tmp, { recursive: true, force: true });
  // 反向：注释不得再声称产品形态是 SEA
  const srcTxt = read('src/platform/contract/deploy.js');
  check('J-a 头部注释已校正（不再称 SEA 为标准形态）',
    /弃 SEA|不再是 SEA/.test(srcTxt), '已校正');
}

// -- J-b：DaemonLifecycle 标记派生 --
{
  const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'app', 'daemons', 'process.js'));
  const script = path.join(ROOT, 'src', 'domains', 'router', 'daemon.js');
  const lc = new DaemonLifecycle({
    name: 'router', script, args: ['-c', '/x/cfg.json'], ctlPort: 43107,
    cmdMark: 'router-daemon', identityFile: path.join(os.tmpdir(), 'j-b.json'),
  });
  check('J-b 标记含语义名', lc._cmdMarks.includes('router-daemon'), JSON.stringify(lc._cmdMarks));
  //  更正：标记**本来就统一为 "/"**（构造器用 norm() 归一化），
  //   故此处**正斜杠字面量是正确的**（我先前误改成 path.join，反而弄坏了它 —— 已回退）。
  check('J-b 标记含 script 绝对路径',
    lc._cmdMarks.some((m) => m.endsWith('/src/domains/router/daemon.js')), '有');
  // 行为级：真实 spawn 产生的 cmdline 必须被匹配。
  //   此处用**原生** cmdline（不手工归一化）—— 因为产品必须自己归一化：
  //   实测 Windows 上原生 cmdline 是反斜杠，而标记是正斜杠 -> 曾是**真实产品缺陷**
  //   （daemon-lifecycle._ctlOwnerPid 在 Windows 永远认不出自己的 daemon）。
  //   修法见 src/platform/os/pidlookup.js 的 normCmdline + 三处调用点。
  //   下面这行因此同时是「测试」与「产品不变量」的检验。
  const realCmd = process.execPath + ' ' + script + ' -c /x/cfg.json';
  const norm = (x) => String(x).replace(/\\/g, '/');
  check('J-b 真实 cmdline 能被匹配（旧实现 indexOf=-1）',
    lc._cmdMarks.some((m) => m && norm(realCmd).indexOf(m) >= 0),
    'realCmd=' + realCmd.slice(0, 70));
  // 反向：确认旧写法（只用 this.cmdMark）已不在匹配点
  const dlSrc = read('src/app/daemons/process.js');
  check('J-b _ctlOwnerPid 用 _cmdMarks 匹配', /_cmdMarks\.some/.test(dlSrc), '已改');

  // -- J-b-2: cmdline 与标记的分隔符归一化--
  //
  //   缺陷：标记由构造器 norm() 成 "/"，而 readCmdline 返回原生分隔符；
  //     Windows 的 cmdline 是反斜杠 -> 直接 indexOf 永远 -1 ->
  //     认不出自己的 router/lan daemon（可能误判端口异主或重复拉起）。
  //   修法：pidlookup 导出 normCmdline，三处比较点先归一化。
  //   本节在 Linux 上也能拦住该回归（不依赖 Windows runner）。
  //  域结构改造：pidlookup 已拆为 pidlookup/{index,probe,norm}.js —— 按目录聚合读取。
  const pidSrc = readDomain('src/platform/os/pidlookup');
  check('J-b-2 pidlookup 导出 normCmdline',
    /module\.exports\s*=\s*\{[^}]*normCmdline[^}]*\}/.test(pidSrc), '已导出');
  for (const [f, label] of [
    ['src/app/daemons/process.js', 'daemon-lifecycle._ctlOwnerPid'],
    ['src/app/daemons/probe.js', 'supervise-view._routerDaemonActive'],
    //  步骤7：lan daemon 判定（_lanDaemonActive）与 router 判定同归 app/daemons/probe.js
    ['src/app/daemons/probe.js', 'control-view lan daemon 判定'],
  ]) {
    const src = read(f);
    check('J-b-2 ' + label + ' 比较前归一化 cmd',
      /normCmdline\(pidlook\.readCmdline\(pid\)/.test(src), '已归一化');
    const bare = /const cmd = pidlook\.readCmdline\(pid\) \|\| '';/.test(src);
    check('J-b-2 ' + label + ' 未回退为裸 readCmdline', !bare, bare ? '**发现裸用法**' : 'ok');
  }
  {
    const { normCmdline } = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const B = String.fromCharCode(92);
    const winCmd = 'C:' + B + 'a' + B + 'src' + B + 'domains' + B + 'router' + B + 'daemon.js -c x';
    check('J-b-2 Windows 风格 cmdline 归一化后可被标记命中',
      normCmdline(winCmd).indexOf('/src/domains/router/daemon.js') >= 0,
      normCmdline(winCmd).slice(0, 60));
    check('J-b-2 posix 风格 cmdline 归一化后不变',
      normCmdline('/usr/bin/node /x/src/domains/router/daemon.js') === '/usr/bin/node /x/src/domains/router/daemon.js', 'ok');
    check('J-b-2 空值安全', normCmdline(null) === '' && normCmdline(undefined) === '', 'ok');
  }
}

// -- J-c：semverCompare 规范符合性 --
{
  const { semverCompare } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
  const cases = [
    ['1.0.0-beta-2', '1.0.0-beta-1', '>'],   // 连字符后不再被截断
    ['1.0.0-rc-10', '1.0.0-rc-2', '<'],      // 非纯数字标识符 -> 字典序（规范）
    ['1.0.0-rc.10', '1.0.0-rc.2', '>'],      // 点分数字 -> 数值
    ['1.0.0', '1.0.0-rc.1', '>'],            // release > prerelease
    ['1.2.3', '1.2.10', '<'],
    ['1.0.0-rc.1+b5', '1.0.0-rc.1', '='],    // build metadata 忽略
  ];
  let bad = 0;
  for (const [a, b, want] of cases) {
    const r = semverCompare(a, b);
    const got = r > 0 ? '>' : r < 0 ? '<' : '=';
    if (got !== want) { bad++; console.log('    ❌ ' + a + ' vs ' + b + ' → ' + got + '（期望 ' + want + '）'); }
  }
  check('J-c semverCompare 全部符合规范（含连字符 prerelease）', bad === 0, bad + ' 处不符');
  // 反向：确认旧的 split('-') 写法已消失
  const dsrc = readDomain('src/platform/distribution');
  check('J-c 不再用 split(\'-\') 解构 core/pre',
    !/const \[core, pre\] = clean\.split\('-'\)/.test(dsrc), '已改');
}

// -- J-e：daemon _spawn 的缺陷防护 --
{
  const dl = read('src/app/daemons/process.js');
  const m = dl.match(/_spawn\(\) \{[\s\S]*?\n  \}/);
  const body = m ? m[0] : '';
  check('J-e 定位到 _spawn', !!m, m ? 'ok' : '未找到');
  check("J-e 监听 'error'（不再逃逸为 uncaughtException）", /child\.on\('error'/.test(body), '有');
  check('J-e 无 pid 时不写身份并返回 failed', /if \(!child\.pid\)/.test(body) && /mode: 'failed'/.test(body), '有');
  //  必须用**最后**一次 _writeIdentity 出现位置：注释里会提前提到它（我第一版踩了这个）。
  check('J-e 身份写入在 pid 校验之后',
    body.lastIndexOf('_writeIdentity') > body.indexOf('if (!child.pid)'),
    'write@' + body.lastIndexOf('_writeIdentity') + ' check@' + body.indexOf('if (!child.pid)'));
  // 壳拉起的同类缺陷（P0-1 of shell）
  const sh = readDomain('src/domains/shell');
  check("J-e shell.restartShell 也监听 'error'", /child\.on\('error'/.test(sh), '有');
  check('J-e shell.restartShell 校验 child.pid', /if \(!child\.pid\)/.test(sh), '有');
}

// -- J-f：detect() 的消费方必须接受 launcher 形态（P0-A 配套）--
//   若只看 form==='sea-binary'，则真实 launcher 用户读不到磁盘版本、
//   updatePending 恒 false、面板永不提示「已装好待重启」。
{
  //  步骤7：settings-view.js 拆为 6 模块，_readBinarySelfVersion 归 app/settings/versions.js。
  const sv = read('src/app/settings/versions.js');
  check('J-f _readBinarySelfVersion 用 updatable 而非 form 硬判',
    /if \(!dep\.updatable \|\| !dep\.runningTarget\) return null;/.test(sv), '已改');
  check('J-f status 的磁盘版本读取用 updatable 判定',
    /if \(dep\.updatable\) diskVersion = (?:await )?[\w.$]*readBinarySelfVersion\(\);/.test(sv), '已改');
  // 反向：剥离注释后不得再有 `form === 'sea-binary'` 的**代码**判定
  const codeOnly = sv.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join(String.fromCharCode(10));
  check("J-f 无残留的 form === 'sea-binary' 硬判（会漏掉 launcher）",
    !/dep\.form === 'sea-binary'/.test(codeOnly), '已清理');
}

// -- J-g：插件域的两个 P1 --
{
  // 域改造后 HTTP 原语（getJson/getText）落在 market-net.js（SSOT）。
  const pm = read('src/domains/plugin/market-net.js');
  const pg = readDomain('src/domains/plugin');
  // 重定向目标必须校验协议（file:// 会让 http.get 同步抛 -> uncaughtException）
  const guards = (pm.match(/重定向到不支持的协议/g) || []).length;
  check('J-g getJson/getText 均校验重定向协议', guards >= 2, guards + ' 处');
  check('J-g 保留跳数上限（防重定向环）', /redirectsLeft <= 0/.test(pm), '有');
  // registry 为 null 时不得写进 env（Node 会把 null 转成 'null'）
  check('J-g 仅在 reg 非空时注入 npm_config_registry',
    /if \(reg\) \{ envBase\.npm_config_registry = reg;/.test(pg), '已改');
  check('J-g 无可用镜像时如实记日志', /无可用的 registry 镜像/.test(pg), '有');
  // 反向：确认旧的「无条件注入」写法已消失（那正是缺陷本体）
  check('J-g 旧的 Object.assign(..., { npm_config_registry: reg }) 已消失',
    !/npm_config_registry: reg, NPM_CONFIG_REGISTRY: reg \}\);/.test(pg), '已改');

  // 停用插件的 entryId 匹配不得用子串（会误伤 dsh-tool-extra）
  const m = pg.match(/async _patchEntryIdsForPlugin\(target, name\) \{[\s\S]*?\n  \}/);
  const fbody = m ? m[0] : '';
  check('J-g 定位到 _patchEntryIdsForPlugin', !!m, m ? 'ok' : '未找到');
  check('J-g 不再用 moduleName.includes(name) 子串匹配',
    !/\.includes\(name\)/.test(fbody), '已改');
  check('J-g 改为包名边界匹配（相等 / 子路径 / 带版本）',
    /mn === name/.test(fbody) && /mn\.startsWith\(name \+ '\/'\)/.test(fbody) && /mn\.startsWith\(name \+ '@'\)/.test(fbody),
    '有');
  // 行为级：复现边界判定
  {
    const name = '@scope/dsh-tool';
    const hit = (mn) => mn === name || mn.startsWith(name + '/') || mn.startsWith(name + '@');
    check('J-g 行为：dsh-tool-extra **不**被匹配（误伤修复）', hit('@scope/dsh-tool-extra') === false, 'false');
    check('J-g 行为：dsh-tool 自身被匹配', hit('@scope/dsh-tool') === true, 'true');
    check('J-g 行为：子路径被匹配', hit('@scope/dsh-tool/lib/x.js') === true, 'true');
  }
}

// -- J-h：daemon stop 必须如实回报（P2-2）--
//   超时是唯一的失败信号，此前被丢弃：仍 return ok:true 且抹掉身份 ->
//   对 SIGTERM 无响应的 daemon 成为「无人知道 pid」的孤儿。
{
  const dl = read('src/app/daemons/process.js');
  const m = dl.match(/async stop\(\) \{[\s\S]*?\n  \}/);
  const body = m ? m[0] : '';
  check('J-h 定位到 stop', !!m, m ? 'ok' : '未找到');
  //  必须断言「`ok:false` 的返回**位于** `!dead` 分支内」——
  //   只做两处字符串存在性检查时，把 `if (!dead)` 改成 `if (false)` 仍会通过（我第一版如此）。
  //  必须匹配**独立的 guard 行**（行首 `if (!dead) {`）——
  //   我第一版用 `indexOf('if (!dead)')`，命中的却是上面那行 `if (!dead) this.logger.warn(...)`，
  //   于是把 guard 改成 `if (false)` 仍然通过（假门禁）。
  const iGuardDead = body.search(/^\s*if \(!dead\) \{$/m);
  const iFailRet = body.indexOf('ok: false, stopped');
  const iClearFn = body.lastIndexOf('_clearIdentity()');
  check('J-h 存在独立的 `if (!dead) {` guard 行', iGuardDead >= 0, 'guard@' + iGuardDead);
  check('J-h 进程未死时返回 ok:false（且在 guard 之后）',
    iGuardDead >= 0 && iFailRet > iGuardDead, 'guard@' + iGuardDead + ' ret@' + iFailRet);
  check('J-h 失败分支位于 clearIdentity 之前（结构正确）',
    iFailRet > 0 && iClearFn > iFailRet, 'ret@' + iFailRet + ' clear@' + iClearFn);
  //  剥离注释行后定位 —— 说明文字里会提到 `_clearIdentity`（我第一版数错了位置）。
  const codeLines = body.split(String.fromCharCode(10))
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); })
    .join(String.fromCharCode(10));
  const iClear = codeLines.lastIndexOf('_clearIdentity()');
  const iGuard = codeLines.indexOf('if (!dead)');
  check('J-h 进程未死时**不**清身份（保留可寻址性）',
    iClear > iGuard && iGuard >= 0, 'clear@' + iClear + ' guard@' + iGuard);
  check('J-h 失败时记事件供面板可见', /daemon_stop_timeout/.test(body), '有');
  // 配套：调用方必须消费返回值（否则记录又丢了）
  //  步骤7：shutdownAll 已从 supervisor.js 下沉 app/session/shutdown.js
  //   （薄壳后 supervisor.js 不再持有业务方法体）。判据对象随之更新。
  const sup = read('src/app/session/shutdown.js');
  check('J-h shutdownAll 消费 stop() 返回值',
    /r\.ok === false/.test(sup) && /shutdown_daemon_stop_incomplete/.test(sup), '已改');
}

// -- J-i：插件 CLI 超时必须杀**整棵树**（P1-7）--
//   原实现只 child.kill() 直接子进程 -> pnpm 的孙进程成孤儿，占 profile/store 锁。
{
  const pg = readDomain('src/domains/plugin');
  // 反向判据要剥注释：本域留下的解释性注释本身就含 `process.kill(-pid` 字样。
  const pgCode = require('./_strip').stripComments(pg);
  // （SSOT NO-CONSOLE-WINDOW-STANDARD W1）：插件 CLI 的 spawn 已收口到
  //   platform/os/spawn.js 的 piped({detached:true}) —— windowsHide 由封装固定，不再出现在调用点。
  //   本断言的**意图不变**（插件 CLI 必须自成进程组），故改为断言「经统一封装 + 显式 detached:true」。
  check('J-i 插件 CLI spawn 用 detached（自成进程组）',
    /spawn\.piped\(argv0, \[\.\.\.argvPrefix, \.\.\.cliArgs, \.\.\.args\], \{ env, detached: true \}\)/.test(pg),
    '已改');
  check('J-i 超时经平台层整树终止（procOS.killTree + ownGroup）',
    /require\('\.\.\/\.\.\/platform\/os\/process'\)/.test(pgCode) && /procOS\.killTree\(child\.pid, sig, \(\) => \{\}, \{ ownGroup: true \}\)/.test(pgCode), '已收口单源');
  // 反向（本条原判据曾钉住 `process.kill(-child.pid, sig)`，等于把禁令要除的形态锁进测试）：
  //   域内自写负 pid 在 Windows 上只杀得到 .cmd 那层壳，故一律不得再出现。判据走剥注释代码。
  check('J-i 反向：插件域不再自写 process.kill(-pid) 组信号',
    !/process\.kill\(-/.test(pgCode), '已移除');
  check('J-i 保留 SIGTERM → SIGKILL 升级',
    /killTree\('SIGTERM'\)/.test(pg) && /killTree\('SIGKILL'\)/.test(pg), '有');
  // 反向：确认旧的「只 kill 直接子进程」写法已消失
  check('J-i 超时分支不再只用 child.kill（单进程）',
    !/try \{ child\.kill\('SIGTERM'\); \} catch \{\}/.test(pg), '已改');
  // 对照：dist 的 npm 安装同样自成进程组 —— 「整树终止」是本仓既有做法，不是本处新造的规矩。
  //   第二判据对照的是「杀树走平台层 killTree 单源」，而不是 dist 里某一行代码：
  //   Windows 无进程组语义，域内自写 `process.kill(-child.pid, 'SIGKILL')`
  //   只杀得到 npm.cmd 那层壳，故各域一律不得再自写负 pid。
  //   该禁令的结构闸在 uninstall-timeout-behavior-test 的 D-10。
  const dist = readDomain('src/platform/distribution');
  const distDetached = /detached: o\.detached !== false/.test(dist);
  const distViaPlatformKillTree = /procOS\.killTree\(child\.pid/.test(dist);
  check('对照：dist 的 npm 安装自成进程组（detached）', distDetached, distDetached ? '是' : '否');
  check('对照：dist 的杀树走 platform/os/process.killTree 单源',
    distViaPlatformKillTree, distViaPlatformKillTree ? '是' : '否');
}

// -- J-j：内核写 registry.json 时必须保留壳的 v2 字段（P2 双写）--
//   该文件所有权在壳（registry-contract.js 声明），跨仓 .shell-work 也会读回（行号跨仓不可核验）；
//   内核若整份覆盖，会抹掉 catalog/probe/selected，削弱壳的镜像解析。
{
  const dmSrc = readDomain('src/platform/distribution');
  // 落盘实现已归 registry-config.js（配置所有权），判据对象是聚合源里的该函数体。
  const m = dmSrc.match(/function saveRegistryConfig\([\s\S]*?\n\}/);
  check('J-j 定位到 saveRegistryConfig', !!m, m ? 'ok' : '未找到');
  check('J-j 写前读回原文档（保留未知字段）', /readFileSync\(f, 'utf8'\)/.test(dmSrc), '有');
  check('J-j 只覆盖内核拥有的三键',
    /doc\.mode = /.test(dmSrc) && /doc\.origins = /.test(dmSrc) && /doc\.manualOrigin = /.test(dmSrc), '有');
  check('J-j 不再整份序列化 registryConfig',
    !/JSON\.stringify\(this\.registryConfig, null, 2\)/.test(dmSrc), '已改');
  // 行为级：壳字段必须存活，内核字段必须更新
  const { DistributionManager } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
  const tmpR = fs.mkdtempSync(path.join(os.tmpdir(), 'regj-'));
  const rf = path.join(tmpR, 'registry.json');
  fs.writeFileSync(rf, JSON.stringify({
    schema: 2, writtenBy: 'shell', catalog: ['https://a.example/', 'https://b.example/'],
    probe: { kind: 'package-metadata', pathTemplate: 'x', timeoutMs: 6000 },
    selected: { origin: 'https://a.example/', latencyMs: 12, checkedAt: 1 },
    mode: 'auto', origins: ['https://a.example/'], manualOrigin: 'https://a.example/',
  }, null, 2));
  const dm = Object.create(DistributionManager.prototype);
  dm.registryFile = rf;
  dm.logger = { warn() {}, info() {}, debug() {} };
  dm.registryConfig = { mode: 'manual', origins: ['https://c.example/'], manualOrigin: 'https://c.example/' };
  dm._saveRegistryConfig();
  const after = JSON.parse(fs.readFileSync(rf, 'utf8'));
  check('J-j 行为：壳的 v2 字段全部保留',
    after.schema === 2 && after.writtenBy === 'shell' && (after.catalog || []).length === 2 && !!after.probe && !!after.selected,
    JSON.stringify({ schema: after.schema, writtenBy: after.writtenBy, catalog: (after.catalog || []).length, probe: !!after.probe, selected: !!after.selected }));
  check('J-j 行为：内核三键已更新',
    after.mode === 'manual' && after.origins[0] === 'https://c.example/' && after.manualOrigin === 'https://c.example/',
    JSON.stringify({ mode: after.mode, origins: after.origins }));
  fs.rmSync(tmpR, { recursive: true, force: true });
}

// -- J-k：镜像源写入口 SSRF 闸 —— 私网/元数据字面量不得落盘 --
//   旧 setRegistryConfig 只过 isValidOrigin：http://127.0.0.1:4873 之类合法落盘，
//   并反向豁免探测闸1)层（已配置源按 hostname 放行）。现在写盘前过 registryOriginViolation。
{
  const { DistributionManager } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
  const tmpK = fs.mkdtempSync(path.join(os.tmpdir(), 'regk-'));
  const mkDm = () => {
    const dm = Object.create(DistributionManager.prototype);
    dm.registryFile = path.join(tmpK, 'no-such', 'registry.json'); // 不存在：load/save 走无操作分支
    dm.logger = { warn() {}, info() {}, debug() {} };
    dm.registryConfig = { mode: 'auto', origins: ['https://registry.npmjs.org'], manualOrigin: 'https://registry.npmjs.org' };
    return dm;
  };
  // manual 切换 + 私网手动源：**同步校验段零改动**（内存配置与磁盘都不动）。
  //   异步段会经 registryInfo 回读实况（可能按既有选源逻辑复测），所以本例只断言同步段。
  //   原缺陷：rc 曾是 state.registryConfig 的别名，mode 在校验前就被写进内存 -> 拒后
  //   UI 显示 manual 而磁盘仍是 auto，且下次自动重测按 manual 走旧手动源。
  {
    const dm = mkDm();
    dm.setRegistryConfig({ mode: 'manual', manualOrigin: 'http://169.254.169.254' });
    check('C-8 manual+元数据地址 → registryConfig.mode 未被改（同步拒）',
      dm.registryConfig.mode === 'auto', JSON.stringify({ mode: dm.registryConfig.mode }));
    check('C-8 manual+回环 dev 镜像 → manualOrigin 未被落盘（同步拒）',
      dm.registryConfig.manualOrigin === 'https://registry.npmjs.org', JSON.stringify({ mo: dm.registryConfig.manualOrigin }));
  }
  // 候选列表：私网项被逐条剔除（同步段），公网项保留
  {
    const dm = mkDm();
    dm.setRegistryConfig({ origins: ['https://pub.example', 'http://127.0.0.1:4873', 'http://10.0.0.7:4873'] });
    check('C-8 候选中回环/私网字面量被剔除',
      JSON.stringify(dm.registryConfig.origins) === JSON.stringify(['https://pub.example']),
      JSON.stringify(dm.registryConfig.origins));
  }
  fs.rmSync(tmpK, { recursive: true, force: true });
}

// -- J-l：写端点的「200 假成功」必须归真，且前端有统一判据 --
//   setRegistryConfig 的拒因放在返回值的 error 字段（不带 ok 键）。旧 dist.js 一律
//   `send(200, { ok: true, ...r })` -> 被 SSRF 闸拒绝的镜像源仍回 200，而 UI 的 http()
//   只在 !res.ok（状态码）时抛错 -> 照样弹「已保存」。
//   UI 条 5 两半：后端有拒因即 400 + ok:false；前端 run() 按返回值判失败（判据单源在 client 层）。
{
  const codeOnly = (s) => s.split('\n')
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*'); }).join('\n');
  // 判据：处理段把 setRegistryConfig 的结果无条件 200，且全段没有 4xx 分支
  const unconditionalOk = (seg) => /send\(200, \{ ok: true, \.\.\.r \}\)/.test(seg) && !/400/.test(seg);
  const dist = codeOnly(read('src/api/domains/dist.js'));
  const seg = (dist.match(/pathname === '\/dist\/registry\/set'[\s\S]*?\n {4}\}/) || [''])[0];
  check('UI 条 5 定位到 /dist/registry/set 处理段', seg.length > 20, seg ? seg.slice(0, 46).replace(/\s+/g, ' ') : '未找到');
  check('UI 条 5 set 段按拒因回 400（r.error 参与状态码）',
    /400/.test(seg) && /r\.error/.test(seg), (seg.match(/[^\n]*\? 400 : 200[^\n]*/) || ['无 400/200 分支'])[0].trim());
  check('UI 条 5 set 段不再无条件 send(200)', !unconditionalOk(seg), '当前形态未命中判据');
  check('UI 条 5 反向非空转：旧「无条件 200」写法能被识别',
    unconditionalOk("if (pathname === '/dist/registry/set') {\n      Promise.resolve(sup.dist.setRegistryConfig(j)).then((r) => send(200, { ok: true, ...r }));\n    }"),
    '判据命中旧写法');
  const uiHook = read('ui/src/features/supervisor/useSupervisorAction.ts');
  check('UI 条 5 run() 按返回值判失败（消费统一判据）',
    /failureFromResult\(await fn\(\)\)/.test(uiHook), (uiHook.match(/const rejected = failureFromResult[^\n]*/) || ['未调用'])[0].trim());
  const uiClient = read('ui/src/services/supervisor/client.ts');
  check('UI 条 5 判据单源在 client 层并已导出',
    /export function failureFromResult/.test(uiClient) && /r\.ok !== false/.test(uiClient), 'ok');
}

// -- J-m：面板轮询中心的游标与心跳节奏 --
//   1) 事件游标唯一写点是 Math.max(snap.eventsSeq, r.seq)：后端 r.seq 非数值时 NaN 会
//      永久污染（Math.max(NaN, x) 恒 NaN -> 下一轮拼出 after=NaN 再也拉不到事件）。
//   2) 心跳必须是「跑完一轮再按连续失败次数自排」的退避链，不能是固定 setInterval：
//      守卫离线时固定 2s 节奏 = 每 2s 白打 8 个请求，慢网下还会轮次堆叠。
//    判据一律走 codeOnly：注释里复述旧缺陷（NaN / setInterval）不该算命中。
{
  const codeOnly = (s) => s.split('\n')
    .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');
  const polling = codeOnly(read('ui/src/services/supervisor/polling.ts'));
  const echo = (re, miss) => (polling.match(re) || [miss])[0].trim();
  check('UI 条 6 游标写入前过数值归一化 safeSeq', /safeSeq\(r\.seq/.test(polling), echo(/eventsSeq: Math\.max.*/, '无游标写入点'));
  check('UI 条 6 反向非空转：未归一化的旧游标写法能被识别',
    !/safeSeq\(r\.seq/.test(codeOnly('        eventsSeq: Math.max(snap.eventsSeq, r.seq),')), '旧写法不含 safeSeq');
  check('UI 条 6 心跳改为自排 setTimeout（不再 setInterval）',
    !/setInterval/.test(polling) && /setTimeout\(\(\) => \{ void heartbeat\(\); \}/.test(polling),
    echo(/[^\n]*heartbeat\(\); \}[^\n]*/, '未自排'));
  check('UI 条 6 退避间隔随连续失败翻倍并封顶',
    /Math\.min\(MAX_TICK_MS, BASE_TICK_MS \* 2 \*\* \(failStreak - 1\)\)/.test(polling),
    echo(/return Math\.min\([^\n]*/, '无翻倍曲线'));
  check('UI 条 6 基准间隔仍为 2s（退避只改失败侧，不改健康节奏）',
    /const BASE_TICK_MS = 2000;/.test(polling), echo(/const BASE_TICK_MS.*/, '无基准常量'));
  check('UI 条 6 健康成功即清零连败计数', /failStreak = online \? 0 : failStreak \+ 1;/.test(polling),
    echo(/failStreak = online.*/, '无复位'));
  check('UI 条 6 stop()/复位都递增 epoch，在途轮次不得再排下一轮',
    (polling.match(/epoch \+= 1;/g) || []).length === 2, 'epoch += 1 出现 ' + (polling.match(/epoch \+= 1;/g) || []).length + ' 次');
}

// -- J-n：状态落盘的原子写必须**单源**，且不得用可预测的固定 .tmp 名 --
//   缺陷机理：全仓 31 处「tmp + rename」各自实现，其中 26 处拼的是**固定** `file + '.tmp'`。
//   升级重叠期新旧两个守卫进程同时写同一份状态 -> 两者写的是同一个临时文件 -> rename 出去的
//   是两次序列化字节的**交错混合体**（既不是新版也不是旧版）；另有实现未带 mode，令牌/URL 落 0644。
//   收敛：platform/util/fs 的 writeAtomic（tmp 名含 pid+毫秒、默认 0600、rename 后收口、失败抛错）。
//   豁免（保留自有实现，但 tmp 名同样含 pid）：token/persist.js（返回 {ok} 契约，TK-G3 口径）、
//   os/file-protect.js（Windows icacls 与 rename 交错，无法套统一 helper）。
{
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const codeOf = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => {
    const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
  const relOf = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const srcFiles = walk(path.join(ROOT, 'src'));
  // 判据：代码行里出现**裸** `'.tmp'` 字面量，且该行没有任何唯一化因子（pid / 毫秒 / UUID / 模板插值）
  const fixedTmpLines = (src) => src.split('\n').filter((l) => /['"`]\.tmp['"`]/.test(l)
    && !/process\.pid|Date\.now|randomUUID|\$\{/.test(l));
  const offenders = srcFiles.filter((f) => fixedTmpLines(codeOf(f)).length > 0).map(relOf);
  check('E-1 src/ 下无「固定 .tmp 名」旁路（唯一 tmp 名 = 单源不变量）',
    offenders.length === 0, offenders.join(',') || '无');
  const LEGACY = "  const tmp = file + '.tmp';\n  fs.writeFileSync(tmp, data);\n  fs.renameSync(tmp, file);";
  check('E-1 反向非空转：旧的固定 .tmp 写法必须被同一判据命中',
    fixedTmpLines(LEGACY).length === 1, '命中 ' + fixedTmpLines(LEGACY).length + ' 行');
  const helper = codeOf(path.join(ROOT, 'src', 'platform', 'util', 'fs.js'));
  check('E-1 单源实现：tmp 名含 pid+毫秒，rename 前不暴露半个目标文件',
    /\.tmp\.'\s*\+\s*process\.pid\s*\+\s*'\.'\s*\+\s*Date\.now\(\)/.test(helper) && /renameSync\(tmp, fp\)/.test(helper), 'ok');
  check('E-1 单源实现：mode 默认 0600 并在 rename 后二次收口（部分平台 rename 重写权限位）',
    /:\s*0o600/.test(helper) && (helper.match(/chmodSync\(\w+, mode\)/g) || []).length === 2, 'chmod 次数=2');
  const selfWriters = srcFiles.filter((f) => /renameSync\(\s*\w*[Tt]mp\w*\b/.test(codeOf(f))).map(relOf);
  const EXEMPT = ['src/platform/util/fs.js', 'src/platform/service/token/persist.js', 'src/platform/os/file-protect.js'];
  check('E-1 自带 tmp+rename 的文件只能落在显式豁免清单内（新增旁路必须先进清单并被审）',
    selfWriters.slice().sort().join(',') === EXEMPT.slice().sort().join(','), selfWriters.join(','));
  const uniqOk = (f) => /process\.pid/.test(codeOf(f));
  check('E-1 豁免项也必须 tmp 名含 pid（豁免只豁免「用哪个 helper」，不豁免唯一性）',
    EXEMPT.every(uniqOk), EXEMPT.filter((f) => !uniqOk(path.join(ROOT, f))).join(',') || '全部含 pid');
  const users = srcFiles.filter((f) => /writeAtomic\(/.test(codeOf(f)) && !/function writeAtomic/.test(codeOf(f)));
  check('E-1 覆盖面不缩水：经单源落盘的模块数 >= 25（迁移被逐点回退会在这里红）',
    users.length >= 25, '当前 ' + users.length + ' 个模块');
  check('E-1 代表调用点确在单源路径上（令牌/凭据/用量三类明文）',
    users.some((f) => relOf(f) === 'src/domains/relay/frp.js')
    && users.some((f) => relOf(f) === 'src/app/main/signals.js')
    && users.some((f) => relOf(f) === 'src/domains/router/store/usage.js'),
    ['relay/frp.js', 'app/main/signals.js', 'router/store/usage.js'].filter((k) => !users.some((f) => relOf(f).endsWith(k))).join(',') || 'ok');
}

// -- J-o：静态门禁必须显式登记自己的覆盖缺口（制度化防复发）--
//   E-2 立项的病灶不是判据写错，而是**门禁的名字比判据大**：文件叫 xxx-gate-test，
//   读者把绿当成「xxx 已被验证」，于是这道「看起来存在的防线」阻止了下一次检查
//   （glibc 声称产线校验、CI 零调用；TK-G4 白名单放行；K-W2 只匹配 spawn(；发布包 README 违 RC-1）。
//   规则落在 ACCEPTANCE-STANDARD.md 第 7 节，本节是其执法点：缺口块必须存在、在头部、且是可核对的逐条清单。
{
  const MARKER = '覆盖缺口（E-2 制度化登记';
  const GAP_GATES = [
    'test/glibc-gate-test.js',
    'test/token-contract-gate-test.js',
    'test/no-console-window-gate-test.js',
    'test/exec-bounded-gate-test.js',
  ];
  // 判据：头部注释区里出现标记，且其后连续注释块内至少 3 条编号项（防空壳标题）。
  const gapBlock = (src) => {
    const at = src.indexOf(MARKER);
    if (at < 0) return null;
    const head = src.slice(0, src.indexOf('\nconst ', at) < 0 ? src.length : src.indexOf('\nconst ', at));
    const lines = head.split('\n').filter((l) => /^\s*(\/\/|\*)\s/.test(l));
    return { items: lines.filter((l) => /^\s*(\/\/|\*)\s+\d+\./.test(l)).length, at };
  };
  for (const rel of GAP_GATES) {
    const b = gapBlock(read(rel));
    check('E-2 ' + rel + ' 头部有可核对的覆盖缺口清单（>=3 条编号项）',
      !!b && b.items >= 3, b ? b.items + ' 条' : '无缺口块');
  }
  check('E-2 执法清单非空转：无缺口块的门禁必须被判出',
    gapBlock('// 门禁\n// 断言 A1\nconst fs = 1;\n') === null, 'hit');
  check('E-2 执法清单非空转：有标记但只有空壳标题（0 条编号项）同样被判出',
    (() => { const b = gapBlock('// ## ' + MARKER + '）\n// 随便写点说明\nconst fs = 1;\n'); return !!b && b.items < 3; })(),
    'hit');
  const std = read('ACCEPTANCE-STANDARD.md');
  check('E-2 规则本体在 ACCEPTANCE-STANDARD §7 且指向本执法点',
    /## 7\.[^\n]*覆盖缺口/.test(std) && /round8-fixes-test\.js[^\n]*J-o|J-o/.test(std), 'ok');
}

// -- J-p：外部输入的字符集白名单必须单源，且真的拦住注入 --
//   审计：version / unit 名 / URL / model 名 / commandTemplate「各自散防」——
//   病灶不是某一份写错，而是**新增入口时无处可抄**，于是每个新调用点都要重新赌一次校验。
//   现：platform/util/input.js 是字符集/形态判定的唯一存放处；语义级闸（SSRF、semver 比较）
//   仍留在各域，但不得再复制字符集。判据 = 对象同一性 + 「同一字符集只有一个定义处」+ 行为表。
{
  const input = require(path.join(ROOT, 'src', 'platform', 'util', 'input.js'));
  const inst = require(path.join(ROOT, 'src', 'platform', 'distribution', 'install.js'));
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js'));
  const walkAll = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkAll(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const relOf2 = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  const ownerOf = (re, files) => (files || walkAll(path.join(ROOT, 'src')))
    .filter((f) => fs.readFileSync(f, 'utf8').includes(re.source)).map(relOf2);
  const RULERS = [input.PKG_NAME_RE, input.ARGV_UNSAFE_RE, input.UNIT_NAME_RE, input.WIN_ABS_PATH_RE];
  check('E-4 每条字符集白名单在 src/ 中只有一个定义处（就是 input.js）',
    RULERS.every((re) => { const o = ownerOf(re); return o.length === 1 && o[0] === 'src/platform/util/input.js'; }),
    RULERS.map((re) => ownerOf(re).join('+') || '无').join(' | '));
  check('E-4 消费方拿到的就是同一个 RegExp 对象（无复制粘贴的第二把尺子）',
    inst.PKG_NAME_RE === input.PKG_NAME_RE && inst.BAD_ARGV_CHAR_RE === input.ARGV_UNSAFE_RE
    && inst.WIN_DRIVE_ABS_RE === input.WIN_ABS_PATH_RE && svc.UNIT_NAME_RE === input.UNIT_NAME_RE, 'ok');
  // 反向：造一个「把 UNIT_NAME_RE 抄进别的文件」的样本，同一判据必须数出 2 个定义处。
  const CLONE_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'e4-clone-'));
  try {
    const CLONE = path.join(CLONE_DIR, 'second-ruler.js');
    fs.writeFileSync(CLONE, 'const CLONE_RE = /' + input.UNIT_NAME_RE.source + '/;\n');
    const both = ownerOf(input.UNIT_NAME_RE, [CLONE].concat(walkAll(path.join(ROOT, 'src'))));
    check('E-4 反向：抄一份字符集立刻被「唯一定义处」判据数出来（2 处）',
      both.length === 2 && both.some((p) => p.endsWith('second-ruler.js')), both.join(','));
  } finally {
    try { fs.rmSync(CLONE_DIR, { recursive: true, force: true }); } catch { /* 临时目录清理尽力 */ }
  }
  // 行为表：逐例独立 + 判据值回显。
  const CASES = [
    ['argv posix 路径放行', input.argvViolation('/tmp/fake-npm.js'), null],
    ['argv win 盘符路径放行（CI run17 误杀对象）', input.argvViolation('D:\\a\\x\\fake-npm.js'), null],
    ['argv 盘符+命令链 拒', !!input.argvViolation('D:\\a\\x;y'), true],
    ['argv 空白 拒', !!input.argvViolation('/tmp/a b'), true],
    ['argv 命令替换 拒', !!input.argvViolation('$(id)'), true],
    ['pkg 合法 scope 放行', input.pkgNameViolation('@deepseek-ai/dsh'), null],
    ['pkg 空格 拒', !!input.pkgNameViolation('bad pkg'), true],
    ['unit 实例名放行', input.unitNameViolation('dsh-web@inst-1757-842'), null],
    ['unit 路径穿越 拒', !!input.unitNameViolation('../../etc/x'), true],
    ['unit 非 service 后缀 拒', !!input.unitNameViolation('x.timer'), true],
    ['ledger __proto__ 键折进 other', input.ledgerKey('__proto__', { unsafe: '(other)' }), '(other)'],
    ['ledger 控制符键折进 other', input.ledgerKey('a\u0000b', { unsafe: '(other)' }), '(other)'],
    ['ledger 正常键原样（仅超长截断）', input.ledgerKey('deepseek-chat'), 'deepseek-chat'],
    ['ledger 空/非字符串归 empty', input.ledgerKey(null, { empty: 'unknown' }), 'unknown'],
  ];
  for (const [n, got, want] of CASES) {
    check('E-4 行为 ' + n, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got));
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);