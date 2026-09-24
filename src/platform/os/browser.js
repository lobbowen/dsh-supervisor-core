'use strict';

// 三端同一「交给系统浏览器」出口。隔离打开用系统默认浏览器：先向操作系统解析默认浏览器（win32 注册表 Clients\StartMenuInternet /
//   darwin LaunchServices / linux xdg-settings + desktop Exec），再按解析结果的引擎族展开隔离参数（chromium 无痕 + 随机 profile / firefox 私有窗口 + 专用 profile）。
// 浏览器选择权在用户不在产品；无隔离能力的引擎如实标 isolated:false，降级由调用方的登录超时兜底。

// 外部打开的唯一出口是 openBrowser（非隔离）与 launchIsolated（登录用的隔离窗口），两者共用同一结果词汇
//   {ok, confirmed, handedOff, reason, error, message}：调用方与面板只需认一套字段，不必各自解释 argv 结局。
// 三档语义不得混为一谈（这是本能力的标准，也是历史上「面板显示成功而屏幕什么都没有」的病根）：
//   confirmed  —— 拿到了「浏览器/调度器确实接收了该 URL」的证据（子进程 0 退出且该形态的退出可信）
//   handedOff  —— 只证明命令已交出且没报错，无法证明窗口出现（win32 的 explorer.exe 恒返 0，即此类）
//   ok:false   —— 明确失败，必须带 reason 码与给用户的一句话，且绝不静默返回成功。
// 结果需要等子进程的 error/exit 才能定，而 ENOENT 只在异步 error 事件里出现（见 binAvailable 注释），
//   故 openBrowser 是异步的：同步返回 true 的旧形态等于把「没报错」当「已打开」。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const spawnOS = require('./spawn');
// 图形会话可用性：只读 env/socket 判定（无 spawn），与本文件同层，故可直接依赖。
const desktop = require('./desktop');
// 能力档位表（纯数据）：外部打开支持哪些平台只由它的 openBrowser 位决定。
const CAPABILITY_PROFILES = require('./capability-profile');
const { resolveExecutable, isExecutableFile } = require('./exec-path');
// 默认浏览器解析是一次性只读查询（reg query / xdg-settings / osascript）：走有界 exec，失败即降级。
const exec = require('../util/exec');

/** 进 argv 前的唯一闸门：只校验协议为 http/https 的绝对 URL，不校验主机
 *  （两个出口传的都有：openBrowser 传本机回环实例地址，launchIsolated 传外部 OAuth 授权页）。 */
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

/** 支持外部打开的平台名单：单一来源 = 能力档位表里 openBrowser 为 true 的那些，
 *  本文件不得再写第二份平台判断（档位与行为分叉即「声明能开、实际乱试」）。 */
const SUPPORTED_OPEN_PLATFORMS = Object.keys(CAPABILITY_PROFILES).filter((k) => CAPABILITY_PROFILES[k].openBrowser === true);

/** 结果词汇的唯一构造点：三档语义在此定型，调用方与面板不再各自解释 argv/exit。
 *  @param {{ok:boolean, confirmed?:boolean, handedOff?:boolean, reason?:string|null,
 *           url?:string, evidence?:object}} p */
function outcome(p) {
  const ok = !!p.ok;
  const confirmed = ok && p.confirmed === true;
  const handedOff = ok && !confirmed;
  const reason = ok ? null : (p.reason || 'failed');
  return {
    ok, confirmed, handedOff, reason,
    error: ok ? null : (p.error || FAILURE_TEXT[reason] || ('打开失败（' + reason + '）')),
    message: ok ? (confirmed ? CONFIRMED_TEXT : (p.message || HANDEDOFF_TEXT)) : null,
    url: p.url === undefined ? null : p.url,
    evidence: p.evidence || null,
  };
}

const CONFIRMED_TEXT = '已在系统浏览器打开';
const HANDEDOFF_TEXT = '已把地址交给系统，但无法确认浏览器窗口是否出现';
/** reason 码 -> 给用户的一句话（码是契约、文案是呈现；面板按码挂文案时不得改写码）。 */
const FAILURE_TEXT = {
  'unsafe-url': '地址不是 http(s) 绝对 URL，已拒绝交给浏览器',
  'no-launcher': '未找到可用的浏览器启动命令，请手动打开该地址',
  'spawn-failed': '浏览器启动失败（系统拒绝了该命令）',
  'exit-nonzero': '浏览器启动命令以非 0 退出，窗口未出现',
  'killed-by-signal': '浏览器启动命令被系统终止',
  'no-desktop-session': '当前没有图形会话，无法调起浏览器',
  'unsupported-platform': '当前平台不在产品支持的桌面平台内，请手动打开该地址',
};

/** 非隔离打开计划（纯函数，与 isolatedPlan 同族、同一解析输入）。
 *  解析到真实浏览器（chromium/firefox 派生系）就直启：调度器形态在非 win32 之外的取证能力更弱，
 *  且 win32 的 explorer.exe 连「失败」都不报（见 trustExit）。other 引擎（Safari、snap 包装器）
 *  的裸 URL 参数语义不确定，交回系统调度器 —— 不为此砍掉整条链路。 */
function openPlan(platform, url, opts) {
  const o = opts || {};
  const pl = platform || process.platform;
  const db = o.defaultBrowser;
  const engine = db && db.bin ? engineOf(db.bin) : 'other';
  if (engine === 'chromium' || engine === 'firefox') {
    return { bin: db.bin, engine, via: 'browser', baseArgs: (db.baseArgs || []).concat([url]), trustExit: true };
  }
  const c = openCommand(pl, url);
  // win32 调度器 = explorer.exe 的 ShellExecute：立即返回 0，与浏览器是否真打开无关，故不可据其宣称成功。
  return { bin: c.cmd, engine: 'other', via: 'dispatcher', baseArgs: c.args, trustExit: pl !== 'win32' };
}

/** 观测一次 spawn 的真实结局（有界）：error/exit 先到者定局，窗口内两者都没到即「已移交、未证实」。
 *  超时句柄 unref：观测不得拖住进程退出。 */
function observeSpawn(child, windowMs, setTimeoutFn) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    timer = (setTimeoutFn || setTimeout)(() => done({ stage: 'alive' }), windowMs);
    if (timer && timer.unref) timer.unref();
    child.on('error', (e) => done({ stage: 'error', code: (e && e.code) || String(e) }));
    child.on('exit', (code, signal) => done({ stage: 'exit', code, signal }));
  });
}

/** 观测窗口：够长以捕获同步失败（ENOENT/权限）与秒退，够短以不占用面板的 15s 动作预算。 */
const OPEN_OBSERVE_MS = 1500;

/** 外部打开的唯一出口：把 http(s) URL 交给操作系统解析出的默认浏览器，并如实回报证据档位。
 *  绝不宣称页面已加载 —— 最多说「命令 0 退出」。
 *  @param {string} url
 *  @param {{defaultBrowser?:{bin:string,baseArgs?:string[]}|null, resolveDeps?:object,
 *           binAvailable?:Function, spawn?:Function, observeMs?:number, setTimeout?:Function,
 *           platform?:string, desktopAvailable?:Function}} [o]
 *    注入缝供行为测试：CI 机器不真起浏览器。夹具与产品共用同一份 defaultBrowser 输入（同源）。
 *  @returns {Promise<{ok, confirmed, handedOff, reason, error, message, url, evidence}>} */
async function openBrowser(url, o) {
  const opts = o || {};
  const pl = opts.platform || process.platform;
  if (!isSafeHttpUrl(url)) {
    return outcome({ ok: false, reason: 'unsafe-url', url: String(url || ''), evidence: null });
  }
  // 能力档位说「不支持」就在这里显式失败：openCommand 对未知平台仍会尽力试一次 xdg-open，
  // 但那是低层映射，不构成本产品对外宣称的能力（unknown 档位 openBrowser:false）。
  if (!SUPPORTED_OPEN_PLATFORMS.includes(pl)) {
    return outcome({ ok: false, reason: 'unsupported-platform', url, evidence: { platform: pl } });
  }
  const observeMs = opts.observeMs === undefined ? OPEN_OBSERVE_MS : opts.observeMs;
  const spawnWith = typeof opts.spawn === 'function' ? opts.spawn : _spawnDetachedIgnored;
  const avail = typeof opts.binAvailable === 'function' ? opts.binAvailable : binAvailable;
  const observe = typeof opts.observe === 'function' ? opts.observe : observeSpawn;
  let db;
  if ('defaultBrowser' in opts) db = opts.defaultBrowser;
  else if (typeof opts.resolveDefault === 'function') db = opts.resolveDefault(pl, opts.resolveDeps || {});
  else db = resolveDefaultBrowser(pl, opts.resolveDeps || {});
  const plan = openPlan(pl, url, { defaultBrowser: db });
  const evidence = { bin: plan.bin, engine: plan.engine, via: plan.via, exitCode: null, exitSignal: null, error: null };
  // linux 无图形会话时任何启动命令都必败：先给出准确原因，别让用户去读 xdg-open 的非 0 退出码。
  // darwin/win32 由图形会话内的 LaunchAgent / schtasks ONLOGON 载入，无会话即无本进程（判定同源 desktop.js）。
  const desktopAvailable = typeof opts.desktopAvailable === 'function' ? opts.desktopAvailable : desktop.sessionAvailable;
  if (pl === 'linux' && !desktopAvailable()) {
    return outcome({ ok: false, reason: 'no-desktop-session', url, evidence });
  }
  if (!avail(plan.bin)) {
    return outcome({ ok: false, reason: 'no-launcher', url, evidence });
  }
  let child;
  try { child = spawnWith(plan.bin, plan.baseArgs); }
  catch (e) {
    evidence.error = (e && e.code) || String(e);
    return outcome({ ok: false, reason: 'spawn-failed', url, evidence });
  }
  if (!child) return outcome({ ok: false, reason: 'spawn-failed', url, evidence });
  const seen = await observe(child, observeMs, opts.setTimeout);
  evidence.error = seen.stage === 'error' ? String(seen.code) : null;
  evidence.exitCode = seen.code === undefined ? null : seen.code;
  evidence.exitSignal = seen.signal === undefined ? null : seen.signal;
  if (seen.stage === 'error') return outcome({ ok: false, reason: 'spawn-failed', url, evidence });
  if (seen.stage === 'exit' && (seen.code !== 0 || seen.signal)) {
    return outcome({
      ok: false, reason: seen.signal ? 'killed-by-signal' : 'exit-nonzero', url, evidence,
      error: FAILURE_TEXT[seen.signal ? 'killed-by-signal' : 'exit-nonzero'] + '（' + (seen.signal || seen.code) + '）',
    });
  }
  // 0 退出：只有「退出可信」的形态才算证据；win32 的 explorer.exe 恒 0，仍是一句「已移交」。
  return outcome({ ok: true, confirmed: plan.trustExit, handedOff: !plan.trustExit, url, evidence });
}

/** detachedIgnored 的无 env 变体：外部打开不注入反取证环境，用宿主环境即可（隔离窗口才需要 antiEnv）。 */
function _spawnDetachedIgnored(bin, args) {
  try {
    const p = spawnOS.detachedIgnored(bin, args);
    p.on('error', () => {});
    p.unref();
    return p;
  } catch { return null; }
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
 *  与 openBrowser 同一结果词汇；同步返回故只能到 handedOff 档（隔离窗口的存活由 onExit 监视承担）。
 *  @param o 注入点：binAvailable/spawn —— 行为测试不依赖宿主浏览器、不在 CI 机器真起浏览器；
 *  defaultBrowser —— 夹具与产品必须共用同一份计划输入，否则预检判定不同源恒 false。
 *  @returns {{ok:boolean, bin:string|null, isolated:boolean, confirmed:boolean, handedOff:boolean,
 *             reason:string|null, error:string|null, url:string|null}} bin=null 表示打不开 */
function launchIsolated(url, o) {
  const opts = o || {};
  if (!isSafeHttpUrl(url)) return Object.assign(outcome({ ok: false, reason: 'unsafe-url', url: String(url || '') }), { bin: null, isolated: false });
  const antiEnv = opts.antiEnv || opts.sysEnv || process.env;
  const sysEnv = opts.sysEnv || process.env;
  const onExit = opts.onExit;
  const avail = typeof opts.binAvailable === 'function' ? opts.binAvailable : binAvailable;
  const spawnWith = typeof opts.spawn === 'function' ? opts.spawn : _spawnDetached;
  const fail = (reason, extra) => Object.assign(outcome(Object.assign({ ok: false, reason, url }, extra)), { bin: null, isolated: false });
  try {
    let db;
    if ('defaultBrowser' in opts) db = opts.defaultBrowser;
    else if (typeof opts.resolveDefault === 'function') db = opts.resolveDefault(process.platform, opts.resolveDeps || {});
    else db = resolveDefaultBrowser(process.platform, opts.resolveDeps || {});
    const plan = isolatedPlan(process.platform, url, {
      defaultBrowser: db, profileDir: opts.profileDir, size: opts.size, lang: opts.lang,
    });
    // spawn 前预检：不可用即如实 ok:false，不 spawn 必死的 bin。
    if (!avail(plan.bin)) return fail('no-launcher', { evidence: { bin: plan.bin, engine: plan.label, via: plan.isolated ? 'browser' : 'dispatcher' } });
    const env = plan.envKind === 'anti' ? antiEnv : sysEnv;
    const p = spawnWith(plan.bin, plan.args, env, plan.watch ? onExit : undefined);
    if (!p) return fail('spawn-failed');
    return Object.assign(outcome({ ok: true, confirmed: false, handedOff: true, url }), { bin: plan.label, isolated: plan.isolated });
  } catch (e) { return fail('spawn-failed', { error: FAILURE_TEXT['spawn-failed'] + '（' + ((e && e.code) || e) + '）' }); }
}

module.exports = {
  openBrowser, launchIsolated, openCommand, openPlan, isolatedPlan, observeSpawn, isSafeHttpUrl,
  resolveDefaultBrowser, resolveDefaultWin, resolveDefaultMac, resolveDefaultLinux,
  engineOf, parseExecLine, tokenizeExec, regValueOf, exeFromCmdLine, binAvailable,
};
