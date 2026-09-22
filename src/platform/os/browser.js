'use strict';

// 三端同一 open(url) 接口。隔离打开用系统默认浏览器：先向操作系统解析默认浏览器（win32 注册表 Clients\StartMenuInternet /
//   darwin LaunchServices / linux xdg-settings + desktop Exec），再按解析结果的引擎族展开隔离参数（chromium 无痕 + 随机 profile / firefox 私有窗口 + 专用 profile）。
// 浏览器选择权在用户不在产品；无隔离能力的引擎如实标 isolated:false，降级由调用方的登录超时兜底。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const spawnOS = require('./spawn');
const { resolveExecutable, isExecutableFile } = require('./exec-path');
// 默认浏览器解析是一次性只读查询（reg query / xdg-settings / osascript）：走有界 exec，失败即降级。
const exec = require('../util/exec');

/** 进 argv 前的唯一闸门：只校验协议为 http/https 的绝对 URL，不校验主机
 *  （调用方两种都传：open 传本机回环实例地址，launchIsolated 传外部 OAuth 授权页）。 */
function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** 平台到打开 URL 的命令（纯函数，不 spawn）。win32 用 explorer.exe 直启（ShellExecute 走默认浏览器），
 *  绝不走 `cmd /c start`：argv 不经 shell，URL 不会被 cmd.exe 二次解析（& ^ " ( ) 均为活性字符）。
 *  未知平台有意退化为 xdg-open：这里不宣称任何能力，只尽力尝试；autostart 相反 —— 它要向用户
 *  宣称服务管理器 kind，故未知平台必须显式 none。 */
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

/** 引擎族分类（纯函数，按可执行文件名判定）：chromium 认 --incognito/--user-data-dir，
 *  firefox 认 --profile + -private-window，other（Safari 与 snap 之类包装启动器）不注入隔离参数。
 *  包装器的 Exec 首 token 不是浏览器本体，归 other 正是如实结果：其沙箱本就拒绝自定义 profile 目录。 */
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

/** Exec 行 -> {bin, baseArgs}：URL 字段码剔除、`env VAR=x bin` 包装去壳；
 *  解析不出可执行首 token 返回 null（调用方降级为非隔离打开）。 */
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
 *  直启可执行文件而非 `open -na`：open 立即退出，其 exit 与浏览器退出无关，
 *  「关闭浏览器即取消登录」只有直启才成立；解析失败（含新版 macOS LSCopy 返回空）由调用方降级。 */
function resolveDefaultMac(runOut) {
  const out = runOut('osascript', ['-l', 'JavaScript', '-e', MAC_JXA]);
  if (!out) return null;
  const parts = out.trim().split('\t');
  if (parts.length < 3 || parts[0] === 'EMPTY' || !parts[2]) return null;
  // 拼的恒是 macOS 路径：用宿主 path.join 在 win 宿主（CI 夹具跨端跑）会产出反斜杠形态。
  return { bin: path.posix.join(parts[1], 'Contents', 'MacOS', parts[2]), baseArgs: [], bundleId: parts[0] };
}

/** linux：xdg-settings 得默认浏览器 desktop 文件名，在其 .desktop 主条目 Exec 行还原真实命令。
 *  搜索目录含 snap 桌面目录（其 Exec 首 token 不是浏览器本体，按不隔离处理）。 */
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

/** 解析系统默认浏览器 -> {bin, baseArgs, bundleId?} | null；全部为只读查询，任一失败返回 null。
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

/** 平台到隔离打开的命令规划（纯函数，不 spawn、不做解析 I/O）。
 *  defaultBrowser 为 resolveDefaultBrowser 的结果；null 或 other 引擎 -> openCommand 非隔离兜底。
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

/** spawn 前的可用性预检：绝对路径判执行位，裸名走 PATH 解析。
 *  必须在 spawn 前判：Node 的 ENOENT 是异步 error 事件，spawn 返回时已成功，
 *  事后挂 error 处理器只能吞掉它，改不了已经上报的 ok/bin。 */
function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\') || /^[A-Za-z]:[\\/]/.test(bin)) return isExecutableFile(bin);
  return resolveExecutable(bin) !== null;
}

/** 以系统默认浏览器做隔离打开（OAuth 一键登录用）：浏览器由操作系统决定，产品只决定「以何种隔离参数打开它」。
 *  @param o 注入点：binAvailable/spawn —— 行为测试不依赖宿主浏览器、不在 CI 机器真起浏览器；
 *  defaultBrowser —— 夹具与产品必须共用同一份计划输入，否则预检判定不同源恒 false。
 *  @returns {{ok:boolean, bin:string|null, isolated:boolean}} bin=null 表示打不开 */
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
    // spawn 前预检：不可用即如实 ok:false，不 spawn 必死的 bin。
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
