'use strict';

// 平台化浏览器打开：三端同一 open(url) 接口；仅接受本机回环 URL（调用方已校验），失败返回 false。
// launchIsolated 用**系统默认浏览器**做隔离打开：先向操作系统解析默认浏览器
// （win32 注册表 Clients\StartMenuInternet / darwin LaunchServices / linux xdg-settings+desktop Exec），
// 再按解析结果的引擎族展开隔离参数（chromium 无痕+随机 profile / firefox 私有窗口+专用 profile）。
// 浏览器选择权在用户（默认浏览器），不在产品 —— 不再有「硬编码候选内核」链。
// 无隔离能力的引擎（Safari 等）与非隔离兜底路径一样如实标 isolated:false，
// 由调用方的登录超时/重新发起兜底；不监听其退出（open/xdg-open 的退出 ≠ 浏览器退出）。
// win32 不借道 `cmd /c start` —— URL 会被 cmd.exe 二次解析（& ^ " ( ) 均为活性字符），
//   直启解析出的可执行文件或 explorer.exe（argv 数组不经 shell）。
//   入口统一过 isSafeHttpUrl：仅 http(s) 绝对 URL 可进 argv。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// 异步 spawn 统一封装（固定 windowsHide:true）；浏览器打开完全脱离本进程，
// 用 detachedIgnored（detached + stdio ignore）。
const spawnOS = require('./spawn');
// spawn 前的可用性预检依赖 PATH 解析与执行位判定。
const { resolveExecutable, isExecutableFile } = require('./exec-path');
// 默认浏览器解析要跑一次性只读查询（reg query / xdg-settings / osascript），
// 统一走有界 exec（timeout/SIGKILL/windowsHide），失败返回 null 即降级。
const exec = require('../util/exec');

/** 仅接受 http/https 绝对 URL（A4：进 argv 前的唯一闸门；解析失败即拒）。 */
function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** 平台到打开 URL 的命令（纯函数，可穷举；不 spawn）。
 *  win32 用 explorer.exe 直启（ShellExecute 走默认浏览器），**不再有 cmd /c start 的
 *  二次解析注入面**；空标题陷阱随 cmd 一并消失。
 *  未知平台有意退化为 xdg-open（best-effort 且失败静默）：这里不宣称任何能力，只尽力尝试；
 *  与 autostart 不同 —— 那里要向用户宣称服务管理器 kind，故未知平台必须显式 none。 */
function openCommand(platform, url) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return { cmd: 'open', args: [url] };
  if (pl === 'win32') return { cmd: 'explorer.exe', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

function open(url) {
  if (!isSafeHttpUrl(url)) return false;
  try {
    const c = openCommand(process.platform, url);
    const p = spawnOS.detachedIgnored(c.cmd, c.args);
    p.on('error', () => {});
    p.unref();
    return true;
  } catch { return false; }
}

function _spawnDetached(bin, args, env, onExit) {
  let child;
  try { child = spawnOS.detachedIgnored(bin, args, { env: env || process.env }); }
  catch { return null; }
  child.on('error', () => {});
  if (typeof onExit === 'function') child.on('exit', () => { try { onExit(); } catch {} });
  child.unref();
  return child;
}

/** 引擎族分类（纯函数，按可执行文件名判定）。
 *  chromium：支持 --incognito/--user-data-dir 的派生系（Chrome/Chromium/Edge/Brave/Vivaldi/Opera/Thorium）；
 *  firefox：支持 --profile + -private-window 的 Gecko 系（含 LibreWolf/Waterfox）；
 *  other：Safari 与无法注入隔离参数的包装启动器（snap/flatpak 的 Exec 首 token 不是浏览器本体，
 *        归此类按「不隔离」处理正是如实结果 —— 包装器的沙箱本就拒绝自定义 profile 目录）。 */
function engineOf(bin) {
  const base = String(bin || '').toLowerCase().split(/[\\/]/).pop();
  if (/(chrome|chromium|msedge|edge|brave|vivaldi|opera|thorium)/.test(base)) return 'chromium';
  if (/(firefox|librewolf|waterfox)/.test(base)) return 'firefox';
  return 'other';
}

/** desktop 文件 Exec 行的 shell 式分词（单双引号与反斜杠转义；% 字段码剔除在调用侧）。 */
function tokenizeExec(line) {
  const toks = [];
  let cur = ''; let q = null; let esc = false; let has = false;
  for (const ch of String(line)) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; has = true; continue; }
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { toks.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) toks.push(cur);
  return toks;
}

/** Exec 行 -> {bin, baseArgs}（URL 字段码剔除；`env VAR=x bin` 包装去壳）。
 *  解析不出可执行首 token 时返回 null（调用方降级为非隔离打开）。 */
function parseExecLine(line) {
  let toks = tokenizeExec(line).filter((t) => t !== '%%' && !/^%[a-zA-Z]$/.test(t));
  if (toks[0] === 'env') {
    let i = 1;
    while (i < toks.length && /=/.test(toks[i])) i++;
    toks = toks.slice(i);
  }
  if (!toks.length) return null;
  return { bin: toks[0], baseArgs: toks.slice(1) };
}

/** reg query 的默认值输出 -> REG_SZ 值（纯函数）。 */
function regValueOf(out) {
  const m = String(out || '').match(/REG_SZ\s+(.*)/);
  return m ? m[1].trim() : null;
}

/** 注册表 open\command 命令行 -> 可执行文件路径（纯函数；引号形态与裸 .exe 两种）。 */
function exeFromCmdLine(cmdLine) {
  const s = String(cmdLine || '');
  let m = s.match(/^\s*"([^"]+\.exe)"/i);
  if (m) return m[1];
  m = s.match(/^\s*(\S+\.exe)/i);
  return m ? m[1] : null;
}

/** win32：HKCU/HKLM Clients\StartMenuInternet 默认值 = 默认浏览器 ProgID，
 *  再取其 shell\open\command 的可执行文件。runOut 可注入（纯查询，无副作用）。 */
function resolveDefaultWin(runOut) {
  const roots = ['HKCU\\Software\\Clients\\StartMenuInternet', 'HKLM\\Software\\Clients\\StartMenuInternet'];
  for (const root of roots) {
    const progId = regValueOf(runOut('reg.exe', ['query', root, '/ve']));
    // ProgID 进 reg 的 argv（不经 shell），仍限制可打印字符防控制序列。
    if (!progId || !/^[\x20-\x7e]+$/.test(progId)) continue;
    for (const r2 of roots) {
      const cmd = regValueOf(runOut('reg.exe', ['query', r2 + '\\' + progId + '\\shell\\open\\command', '/ve']));
      const bin = exeFromCmdLine(cmd);
      if (bin) return { bin, baseArgs: [] };
    }
  }
  return null;
}

const MAC_JXA = [
  "ObjC.import('CoreServices');ObjC.import('Foundation');",
  "var b=ObjC.unwrap($.LSCopyDefaultHandlerForURLScheme(null,'https'))||ObjC.unwrap($.LSCopyDefaultHandlerForURLScheme(null,'http'));",
  "if(!b){'EMPTY';}else{",
  "var u=$.NSWorkspace.workspace.URLForApplicationWithBundleIdentifier(b);",
  "if(u.isNil()){'EMPTY';}else{",
  "var e=ObjC.unwrap($.NSBundle.bundleWithURL(u).objectForInfoDictionaryKey('CFBundleExecutable'));",
  "b+'\\t'+ObjC.unwrap(u.path)+'\\t'+e;}}",
].join('');

/** darwin：LaunchServices 取 https 默认 handler 的 bundle id 与应用路径，拼出真实可执行文件。
 *  直启可执行文件而非 `open -na`：open 立即退出，其 exit 事件与浏览器退出无关，
 *  「关闭浏览器即取消登录」只有直启才成立。解析失败（含新版 macOS LSCopy 弃用返回空）
 *  由调用方降级为非隔离 open。 */
function resolveDefaultMac(runOut) {
  const out = runOut('osascript', ['-l', 'JavaScript', '-e', MAC_JXA]);
  if (!out) return null;
  const parts = out.trim().split('\t');
  if (parts.length < 3 || parts[0] === 'EMPTY' || !parts[2]) return null;
  return { bin: path.join(parts[1], 'Contents', 'MacOS', parts[2]), baseArgs: [], bundleId: parts[0] };
}

/** linux：xdg-settings 得默认浏览器 desktop 文件名，在其 .desktop 主条目 Exec 行还原真实命令。
 *  搜索目录含 snap 桌面目录（Exec 首 token 为 snap -> engineOf other -> 不隔离，如实降级）。 */
function resolveDefaultLinux(runOut, readFile, exists, env, home) {
  const id = runOut('xdg-settings', ['get', 'default-web-browser']);
  const desktop = id && id.trim();
  if (!desktop || !/^[A-Za-z0-9._-]+\.desktop$/.test(desktop)) return null;
  const dirs = [
    (env.XDG_DATA_HOME || path.join(home, '.local', 'share')),
    '/usr/local/share', '/usr/share', '/var/lib/snapd/desktop',
  ].map((d) => path.join(d, 'applications'));
  for (const dir of dirs) {
    const p = path.join(dir, desktop);
    let text = null;
    try { if (exists(p)) text = readFile(p); } catch { continue; }
    if (text === null) continue;
    // 主条目 [Desktop Entry] 的首个 Exec（Desktop Action 段的 Exec 是特化动作，不取）。
    let inMain = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\[Desktop Entry\]\s*$/.test(line)) { inMain = true; continue; }
      if (/^\[/.test(line)) break;
      if (inMain) {
        const m = line.match(/^Exec=(.+)/);
        if (m) return parseExecLine(m[1]);
      }
    }
  }
  return null;
}

/** 解析系统默认浏览器 -> {bin, baseArgs, bundleId?} | null。
 *  全部为只读查询（reg/xdg-settings/osascript），任一失败返回 null（调用方降级非隔离）。
 *  @param {{runOut?:Function, readFile?:Function, exists?:Function, env?:object, home?:string}} [o]
 *    注入缝供行为测试：CI 机器不真起浏览器也不真查注册表。 */
function resolveDefaultBrowser(platform, o) {
  const ov = o || {};
  const pl = platform || process.platform;
  const runOut = ov.runOut || ((bin, args) => exec.runOut(bin, args, { timeoutMs: 5000 }));
  const readFile = ov.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = ov.exists || ((p) => fs.existsSync(p));
  const env = ov.env || process.env;
  const home = ov.home || os.homedir();
  try {
    if (pl === 'win32') return resolveDefaultWin(runOut);
    if (pl === 'darwin') return resolveDefaultMac(runOut);
    return resolveDefaultLinux(runOut, readFile, exists, env, home);
  } catch { return null; }
}

/** 平台到隔离打开的命令规划（纯函数，可穷举；不 spawn、不做解析 I/O）。
 *  输入 defaultBrowser 为 resolveDefaultBrowser 的结果；null/other 引擎 -> openCommand 非隔离兜底。
 *  @param {{defaultBrowser?:{bin:string,baseArgs?:string[]}|null, profileDir?:string,
 *           size?:number[], lang?:string}} [opts] */
function isolatedPlan(platform, url, opts) {
  const o = opts || {};
  const pl = platform || process.platform;
  const db = o.defaultBrowser;
  const engine = db && db.bin ? engineOf(db.bin) : 'other';
  const baseArgs = (db && db.baseArgs) || [];
  if (engine === 'chromium' && o.profileDir) {
    const args = ['--incognito', '--user-data-dir=' + o.profileDir];
    if (Array.isArray(o.size) && o.size.length === 2) args.push('--window-size=' + o.size[0] + ',' + o.size[1]);
    if (o.lang) args.push('--lang=' + o.lang);
    args.push('--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble');
    // 独立 user-data-dir => 必为新实例进程，其 exit 即窗口关闭（onExit 语义成立）。
    return { bin: db.bin, args: [...baseArgs, ...args, url], isolated: true, watch: true, envKind: 'anti', label: 'chromium' };
  }
  if (engine === 'firefox' && o.profileDir) {
    // --no-remote + 专用 profile：不并入既有实例，新进程随窗口关闭而退出。
    return {
      bin: db.bin,
      args: [...baseArgs, '--no-remote', '--profile', o.profileDir, '-private-window', url],
      isolated: true, watch: true, envKind: 'anti', label: 'firefox',
    };
  }
  const c = openCommand(pl, url);
  return { bin: c.cmd, args: c.args, isolated: false, watch: false, envKind: 'sys', label: c.cmd };
}

/** 条 4：spawn 前的可用性预检。绝对路径 -> 直接判执行位；裸名 -> PATH 解析。
 *  为什么必须在 spawn 前判：Node 的 ENOENT 是**异步** error 事件，旧实现
 *  `child.on('error', () => tryNext())` 的递归返回值被丢弃 —— tryNext() 已先返回
 *  ok:true/该 bin，降级链形同虚设（错误 bin 被如实上报，且没有任何候选真正接力）。 */
function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\') || /^[A-Za-z]:[\\/]/.test(bin)) return isExecutableFile(bin);
  return resolveExecutable(bin) !== null;
}

/**
 * 以系统默认浏览器做隔离打开（OAuth 一键登录用）。
 * 浏览器是谁由操作系统决定；产品只决定「以何种隔离参数打开它」。
 * @param {{profileDir?:string, size?:number[], lang?:string, antiEnv?:object, sysEnv?:object,
 *          onExit?:Function, binAvailable?:Function, spawn?:Function,
 *          resolveDefault?:Function, defaultBrowser?:object|null, resolveDeps?:object}} [o]
 *        binAvailable 可注入（条 4：行为测试不依赖宿主装了什么浏览器）；
 *        spawn 亦可注入（同条：否则 darwin/win32 宿主上本用例会在 CI 机器里真起浏览器）；
 *        resolveDefault/defaultBrowser 可注入 —— 夹具与产品共用同一份计划输入
 *        （缺省为运行期 resolveDefaultBrowser），否则「产品问到的浏览器」与「夹具认定的
 *        候选」不同源，预检恒 false 表现为不起进程。
 * @returns {{ok:boolean, bin:string|null, isolated:boolean}} bin=null 表示打不开
 */
function launchIsolated(url, o) {
  const opts = o || {};
  if (!isSafeHttpUrl(url)) return { ok: false, bin: null, isolated: false };
  const antiEnv = opts.antiEnv || opts.sysEnv || process.env;
  const sysEnv = opts.sysEnv || process.env;
  const onExit = opts.onExit;
  const avail = typeof opts.binAvailable === 'function' ? opts.binAvailable : binAvailable;
  const spawnWith = typeof opts.spawn === 'function' ? opts.spawn : _spawnDetached;
  try {
    let db;
    if ('defaultBrowser' in opts) db = opts.defaultBrowser;
    else if (typeof opts.resolveDefault === 'function') db = opts.resolveDefault(process.platform, opts.resolveDeps || {});
    else db = resolveDefaultBrowser(process.platform, opts.resolveDeps || {});
    const plan = isolatedPlan(process.platform, url, {
      defaultBrowser: db, profileDir: opts.profileDir, size: opts.size, lang: opts.lang,
    });
    // 同样按条 4 预检——不可用即如实 ok:false，不 spawn 必死的 bin。
    if (!avail(plan.bin)) return { ok: false, bin: null, isolated: false };
    const env = plan.envKind === 'anti' ? antiEnv : sysEnv;
    const p = spawnWith(plan.bin, plan.args, env, plan.watch ? onExit : undefined);
    return { ok: !!p, bin: p ? plan.label : null, isolated: plan.isolated };
  } catch { return { ok: false, bin: null, isolated: false }; }
}

module.exports = {
  open, launchIsolated, openCommand, isolatedPlan, isSafeHttpUrl,
  resolveDefaultBrowser, resolveDefaultWin, resolveDefaultMac, resolveDefaultLinux,
  engineOf, parseExecLine, tokenizeExec, regValueOf, exeFromCmdLine, binAvailable,
};
