'use strict';

// 平台化浏览器打开：三端同一 open(url) 接口；仅接受本机回环 URL（调用方已校验），失败返回 false。
// launchIsolated 把「隔离 profile + 无痕 + 反指纹参数打开浏览器」的平台差异收敛到平台层，
// 调用方只提供策略参数，不再出现 process.platform 分支与二进制名。
// win32 不再借道 `cmd /c start` —— URL 会被 cmd.exe 二次解析
//   （& ^ " ( ) 均为活性字符），改直启 chrome.exe 或 explorer.exe（argv 数组不经 shell）。
//   入口统一过 isSafeHttpUrl：仅 http(s) 绝对 URL 可进 argv。

const fs = require('node:fs');
const path = require('node:path');
// 异步 spawn 统一封装（固定 windowsHide:true）；浏览器打开完全脱离本进程，
// 用 detachedIgnored（detached + stdio ignore）。
const spawnOS = require('./spawn');
// spawn 前的可用性预检依赖 PATH 解析与执行位判定。
const { resolveExecutable, isExecutableFile } = require('./exec-path');

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

/** win32 Chrome 探测（仅运行期调用；找不到返回 null -> 计划退化为 explorer 兜底）。
 *  只查标准安装路径，不查 PATH（免得再引一层 where.exe 进程）。 */
function findChromeWin(env, exists) {
  const e = env || process.env;
  const has = exists || ((p) => fs.existsSync(p));
  for (const root of [e['ProgramFiles'], e['ProgramFiles(x86)'], e.LOCALAPPDATA]) {
    if (!root) continue;
    try {
      const p = path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (has(p)) return p;
    } catch {}
  }
  return null;
}

/** 平台到隔离打开的命令规划（纯函数，可穷举；不 spawn）。
 *  返回 {kind:single,bin,args,isolated} 或 {kind:chain,candidates}（linux 按可用性依次尝试）。
 *  win32 直启 chrome.exe（opts.chromeBin 由调用方探测传入）—— argv 不经 cmd，
 *  反指纹参数可以安全带全；无 chrome 时退化 explorer.exe（默认浏览器，放弃隔离故明示 isolated:false）。
 *  @param {{profileDir?:string, antiArgs?:string[], chromeBin?:string|null}} [opts] */
function isolatedPlan(platform, url, opts) {
  const o = opts || {};
  const antiArgs = o.antiArgs || [];
  const profileDir = o.profileDir;
  const pl = platform || process.platform;
  if (pl === 'darwin') {
    return { kind: 'single', bin: 'open', args: ['-na', 'Google Chrome', '--args', ...antiArgs], isolated: true, label: 'Google Chrome', envKind: 'anti' };
  }
  if (pl === 'win32') {
    if (o.chromeBin) {
      return {
        kind: 'single', bin: o.chromeBin,
        args: ['--incognito', '--user-data-dir=' + profileDir, ...antiArgs, url],
        isolated: true, label: 'chrome', envKind: 'anti',
      };
    }
    return { kind: 'single', bin: 'explorer.exe', args: [url], isolated: false, label: 'explorer', envKind: 'sys' };
  }
  // Linux（及未知平台，同 openCommand 的有意退化）：候选按「防风控强度 + 可用性」排序
  return {
    kind: 'chain',
    candidates: [
      { bin: 'microsoft-edge', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'microsoft-edge-stable', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'google-chrome', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'chromium', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'chromium-browser', args: antiArgs, isolated: true, watch: true, envKind: 'anti' },
      { bin: 'firefox', args: ['--private-window', url], isolated: false, watch: true, envKind: 'sys' },
      { bin: 'xdg-open', args: [url], isolated: false, watch: false, envKind: 'sys' },
    ],
  };
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
 * 以隔离 profile + 无痕打开浏览器（OAuth 反指纹登录用）。
 * @param {{profileDir?:string, antiArgs?:string[], antiEnv?:object, sysEnv?:object,
 *          onExit?:Function, binAvailable?:Function, spawn?:Function, chromeBin?:string|null}} [o]
 *        binAvailable 可注入（条 4：行为测试不依赖宿主装了什么浏览器）；
 *        spawn 亦可注入（同条：否则 darwin/win32 宿主上本用例会在 CI 机器里真起浏览器）；
 *        chromeBin 亦可注入（缺省 = findChromeWin() 运行期探测）——夹具必须与产品用同一份计划
 *        输入，否则「产品问的 bin」与「夹具认定的候选」不同源，预检恒 false 表现为不起进程
 * @returns {{ok:boolean, bin:string|null, isolated:boolean}} bin=null 表示全部候选失败
 */
function launchIsolated(url, o) {
  const opts = o || {};
  if (!isSafeHttpUrl(url)) return { ok: false, bin: null, isolated: false };
  const profileDir = opts.profileDir;
  const antiArgs = opts.antiArgs || [];
  const antiEnv = opts.antiEnv || opts.sysEnv || process.env;
  const sysEnv = opts.sysEnv || process.env;
  const onExit = opts.onExit;
  const avail = typeof opts.binAvailable === 'function' ? opts.binAvailable : binAvailable;
  const spawnWith = typeof opts.spawn === 'function' ? opts.spawn : _spawnDetached;
  try {
    const chromeBin = 'chromeBin' in opts ? opts.chromeBin
      : (process.platform === 'win32' ? findChromeWin() : null);
    const plan = isolatedPlan(process.platform, url, { profileDir, antiArgs, chromeBin });
    if (plan.kind === 'single') {
      // single 分支同预检——不可用即如实 ok:false，不 spawn 必死的 bin
      if (!avail(plan.bin)) return { ok: false, bin: null, isolated: false };
      const env = (plan.envKind ? plan.envKind === 'anti' : plan.bin === 'open') ? antiEnv : sysEnv;
      const p = spawnWith(plan.bin, plan.args, env, onExit);
      return { ok: !!p, bin: p ? plan.label : null, isolated: plan.isolated };
    }
    // chain 分支按预检过滤后再逐个尝试；error 事件只静默吞（结果已在 spawn 前定）。
    const cands = plan.candidates.filter((c) => avail(c.bin));
    for (const c of cands) {
      const env = c.envKind === 'anti' ? antiEnv : sysEnv;
      // watch=false 的候选（系统兜底）不接 onExit —— 与原实现同语义，交给 _spawnDetached 判定。
      const p = spawnWith(c.bin, c.args, env, c.watch ? onExit : undefined);
      if (!p) continue;
      return { ok: true, bin: c.bin, isolated: c.isolated };
    }
    return { ok: false, bin: null, isolated: false };
  } catch { return { ok: false, bin: null, isolated: false }; }
}

module.exports = { open, launchIsolated, openCommand, isolatedPlan, isSafeHttpUrl, findChromeWin };
