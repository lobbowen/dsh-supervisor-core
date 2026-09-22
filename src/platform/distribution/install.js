'use strict';

// npm 安装执行 + 端口健康验证 + 版本检查（IO）。
// 全具名导出、显式收参（state 用于镜像选择/灰度事实），不碰跨文件 this。

const net = require('node:net');
const spawnOS = require('../os/spawn');
const procOS = require('../os/process');
const execPath = require('../os/exec-path');
const runtimeContract = require('../contract/runtime');
const service = require('../os/service').current();
const { VERSION_RE } = require('../../shared/version');
const release = require('./release');
const registry = require('./registry');
const policies = require('./policies');
const input = require('../util/input');

/** 字符集白名单尺子取自 platform/util/input 单源，此处仅同名转发导出
 *  （npm-resolution 门禁直接断言 inst.PKG_NAME_RE，尺子只有一把）：
 *  pkg/version 会流入 argv 与 commandTemplate 的 {pkg}/{version} 替换，不进白名单就是注入面。 */
const PKG_NAME_RE = input.PKG_NAME_RE;
const BAD_ARGV_CHAR_RE = input.ARGV_UNSAFE_RE;
const WIN_DRIVE_ABS_RE = input.WIN_ABS_PATH_RE;

/** npm registry 最新版（用选中镜像；失败回退候选；null 表示不可达）。 */
async function fetchNpmLatest(state, pkg, opts) {
  if (!pkg) return null;
  const o = opts || {};
  let origin = null;
  if (o.authoritative) {
    // 发布权威源解析：版本真相源 = 官方 npm registry。镜像同步有延迟，把「镜像未同步」
    // 误判为「没有新版本」是真相源错误。优先级：配置里显式的官方源 > 注入的非官方列表 > 默认官方。
    const list = registry.registryOrigins(state);
    origin = list.find((x) => /registry\.npmjs\.org/.test(x)) || list[0] || 'https://registry.npmjs.org';
  } else {
    origin = await registry.selectRegistry(state, false);
  }
  if (!origin) return null; // 全部镜像不可达：明确失败（checkUpdate 据此报错而非误报最新）
  // 拉元数据前过 origin 协议/形态闸与包名白名单：manualOrigin/契约 selected 等来路不经
  // setRegistryConfig 校验，URL 拼接攻击面只能在这里堵。
  const base = policies.normalizeOrigin(origin);
  if (!policies.isValidOrigin(base)) return null;
  if (!PKG_NAME_RE.test(pkg)) return null;
  try {
    // 拉包完整元数据（dist-tags + versions）；选版一律交 release.pickReleaseVersion，此处不定策略。
    const res = await fetch(base + '/' + encodeURIComponent(pkg), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const j = await res.json();
    const picked = release.pickReleaseVersion(j, {
      isOurs: release.isOurReleasePackage(pkg),
      canary: policies.isInCanaryList(state), // 仅 isOurs 分支消费
      isValid: (v) => typeof v === 'string' && VERSION_RE.test(v),
    });
    if (picked) return picked;
    // 兜底：元数据里没有任何可用版本（例如仅 pkg/latest 端点有）——属「版本缺失」
    // 而非「通道选择」，与选版算法无关，故留在调用点。
    const lr = await fetch(base + '/' + encodeURIComponent(pkg) + '/latest', { signal: AbortSignal.timeout(8000) });
    if (!lr.ok) return null;
    const lj = await lr.json();
    return (lj && typeof lj.version === 'string' && VERSION_RE.test(lj.version)) ? lj.version : null;
  } catch (e) { return null; }
}

/** GitHub Releases 最新 tag（去除可选 v 前缀）。返回版本号。 */
async function fetchGithubLatest(owner, repo) {
  if (!owner || !repo) return null;
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest',
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'dsh-supervisor' } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const tag = (j && typeof j.tag_name === 'string') ? j.tag_name : (j && typeof j.name === 'string' ? j.name : null);
    if (!tag) return null;
    return String(tag).replace(/^v/, '');
  } catch (e) { return null; }
}

/** 统一版本检查：channel = 'npm' | 'github'。返回最新版本字符串或 null。
 *  @param {object} [opts] { authoritative?: boolean } */
async function fetchLatestVersion(state, pkg, channel, opts) {
  const ch = channel || 'npm';
  const o = opts || {};
  if (ch === 'github') {
    const slash = String(pkg).split('/');
    if (slash.length >= 2) return fetchGithubLatest(slash[0], slash.slice(1).join('/'));
    return null;
  }
  return fetchNpmLatest(state, pkg, { authoritative: o.authoritative === true });
}

/** 在途 npm 安装句柄（D-10）。装/卸/升级全部经 runNpmInstall，故本集合就是「守卫内不可见的
 *  外部写入者」清单。子进程 detached（自成进程组），守卫退出后不会随之消亡——关停必须先中止它们。 */
const INFLIGHT_NPM = new Set();

/** 在途 npm 任务数（关停路径据此决定是否留痕/发事件）。 */
function inflightNpmCount() { return INFLIGHT_NPM.size; }

/** 中止全部在途 npm 子进程（连同其进程组），并让对应 Promise 以 ok:false,aborted:true 收口。
 *  @returns {number} 被中止的任务数 */
function killInflightNpm(reason) {
  const hs = [...INFLIGHT_NPM];
  for (const h of hs) { try { h.abort(reason); } catch { /* 已收口：不阻断关停 */ } }
  return hs.length;
}

/** 安装执行器（统一 npm 安装）：镜像注入 / 超时 / 行日志 / 退出码 / 进程树清理。
 *  @param {object} opts { pkg, version（必须显式）, prefix（沙箱）, registry, timeoutMs, detached, onLine }
 *  @returns Promise<{ ok, error, output, aborted? }> */
function runNpmInstall(opts) {
  const o = opts || {};
  const pkg = o.pkg || '@deepseek-ai/dsh';
  if (!o.version) return Promise.resolve({ ok: false, error: 'runNpmInstall: 缺少 version（必须显式携带）', output: [] });
  // 入参白名单（fail-closed）：pkg/version 来自配置/registry 返回值，任何一环被污染
  // 都会经 argv 或模板替换直达 spawn —— 非法字符（空白/shell 元字符）在构造命令前即拒。
  if (!PKG_NAME_RE.test(pkg)) return Promise.resolve({ ok: false, error: 'runNpmInstall: 非法包名（字符集白名单不通过）: ' + String(pkg).slice(0, 80), output: [] });
  if (!VERSION_RE.test(String(o.version))) return Promise.resolve({ ok: false, error: 'runNpmInstall: 非法版本号（须为严格 semver）: ' + String(o.version).slice(0, 80), output: [] });
  // 唯一安装执行器：commandTemplate 支持完整替换命令（测试/特殊环境注入 fake-npm 等）。
  let argv;
  // 经统一解析口拿启动形态（程序 + 前缀参数成对）：win32 下是 npm.cmd；官方分发包只带
  // 包内 JS 时是 `node <npm-cli.js>`。只取程序会把后者降级成裸跑 node（含糊失败）。
  const launcher = runtimeContract.npmLauncher();
  let bin = launcher.program;
  if (Array.isArray(o.commandTemplate) && o.commandTemplate.length) {
    argv = o.commandTemplate.map((s) => String(s).replace(/{pkg}/g, pkg).replace(/{version}/g, o.version).replace(/{prefix}/g, o.prefix || ''));
    // 模板首项通常就是逻辑名 'npm'，同样需要跨平台解析；仅在首项恰为逻辑名时解析。
    const fromTemplate = argv[0] !== 'npm';
    bin = fromTemplate ? argv[0] : launcher.program;
    // 契约前缀参数只属于契约程序；模板自带解释器（如 node /tmp/fake.js）时不得前插。
    argv = (fromTemplate ? [] : launcher.args).concat(argv.slice(1));
    // 模板首项为逻辑名 'npm' 时走统一解析口并在解析失败时 fail-closed（两平台语义一致）；
    // 首项非 'npm' 时按字面量作为程序交给 spawn（走其自身 PATH 语义），无解析口预校验，
    // 唯一防线是下方逐项禁用字符集闸。
    if (!fromTemplate && launcher.source === 'path' && bin === 'npm' && !execPath.resolveExecutable('npm')) {
      return Promise.resolve({ ok: false, error: 'runNpmInstall: 未找到可执行的 npm（commandTemplate[0]="npm" 解析失败）', output: [] });
    }
    for (const a of argv) {
      // WIN_DRIVE_ABS_RE：win32 盘符绝对路径整体豁免（`\\` 为路径分隔符）；其余项零豁免。
      if (BAD_ARGV_CHAR_RE.test(String(a)) && !WIN_DRIVE_ABS_RE.test(String(a))) {
        return Promise.resolve({ ok: false, error: 'runNpmInstall: commandTemplate 替换后含禁用字符（空白/shell 元字符）: ' + String(a).slice(0, 80), output: [] });
      }
    }
  } else {
    argv = [...launcher.args, 'install', '-g', '--no-audit', '--no-fund'];
    // 安装期不执行包内 pre/post 脚本 ——  registry 内容（含镜像被投毒场景）不再能在
    // 本机以守卫权限跑任意生命周期脚本。
    argv.push('--ignore-scripts');
    // prefix 与 pkg/version 同源（配置/沙箱目录）、同样直达 spawn，故同样过闸；
    // 过的是路径形态尺而非 argv 字符集尺，理由见 input.prefixViolation。
    if (o.prefix) {
      const pv = input.prefixViolation(o.prefix);
      if (pv) return Promise.resolve({ ok: false, error: 'runNpmInstall: ' + pv, output: [] });
      argv.push('--prefix', String(o.prefix));
    }
    argv.push(pkg + '@' + o.version);
  }
  // 契约 PATH 注入（nodeBinDir 首位）：内核自身执行的 npm 也必须能找到 node。
  const envVars = runtimeContract.withPath(process.env);
  if (o.registry) {
    // 镜像源只接受纯 http(s) origin（无凭证/路径夹带）：npm_config_registry 指向
    // file:// 等协议同样是攻击面，非法值不写入 env。
    if (!policies.isValidOrigin(o.registry)) {
      return Promise.resolve({ ok: false, error: 'runNpmInstall: 非法 registry origin（须为纯 http(s) origin）: ' + String(o.registry).slice(0, 80), output: [] });
    }
    envVars.npm_config_registry = o.registry; envVars.NPM_CONFIG_REGISTRY = o.registry;
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnOS.piped(bin, argv, { env: envVars, detached: o.detached !== false });
    } catch (e) {
      return resolve({ ok: false, error: e.message, output: [] });
    }
    const out = [];
    // 在途 npm 子进程必须可被守卫主动中止：detached 子进程在守卫退出/被 8s 强杀后仍会
    //   继续跑，新守卫 boot 时旧 npm 仍在写 node_modules 与全局前缀 —— 无人等待、无人记账
    //   的并发写入者，正是半成品安装的来源。关停路径经 killInflightNpm() 收口。
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      INFLIGHT_NPM.delete(handle);
      clearTimeout(timer);
      resolve(r);
    };
    const killTree = () => {
      if (!child || child.exitCode !== null) return;
      // 必须走 platform/os/process 的整树终止（win 用 taskkill /T /F）：Windows 没有进程组
      //   语义，负 pid 组信号只杀得到 npm.cmd 那层壳，真正写 node_modules/全局前缀的 node
      //   孙进程照旧存活 —— 正是本条（D-10）要消灭的「无人记账的外部写入者」。
      //   ownGroup:true —— 子进程以 detached 起，必为自身进程组组长（POSIX 组信号安全）。
      try { procOS.killTree(child.pid, 'SIGKILL', () => {}, { ownGroup: true }); } catch { /* 尽力而为 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    const handle = {
      pid: child.pid,
      abort: (reason) => {
        killTree();
        finish({ ok: false, aborted: true, error: '安装被中止: ' + (reason || 'guard-exit'), output: out });
      },
    };
    const timer = setTimeout(() => {
      killTree();
      finish({ ok: false, error: '安装超时', output: out });
    }, o.timeoutMs || 600000);
    INFLIGHT_NPM.add(handle);
    const onLine = (buf) => {
      for (const l of String(buf).split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        out.push(t.slice(0, 200));
        if (o.onLine) { try { o.onLine(t.slice(0, 200)); } catch { /* 回调失败不阻断 */ } }
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('error', (e) => { finish({ ok: false, error: e.message, output: out }); });
    child.on('exit', (code) => {
      finish({ ok: code === 0, error: code === 0 ? null : 'npm install 退出码 ' + code, output: out });
    });
  });
}

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 健康验证器（统一端口 + systemd 单元 + 稳定期）。
 *
 *  DSH 进程可能先监听端口、随后因插件兼容崩溃，只探测端口会误判成功 ——
 *  必须同时检查 systemd 单元仍 active，并留稳定期防「延迟崩溃」。 */
async function waitPortHealthy(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const port = Number(o.port);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, reason: 'waitPortHealthy: 非法端口 ' + o.port };
  const unit = o.unit || null;
  const stabilityMs = o.stabilityMs !== undefined ? o.stabilityMs : 15000;
  // 平台层判定（无单元视为通过）。portable 档拿不到单元概念，以 {port} 反查监听进程为活跃锚——
  // 与下方 portListening 同锚，故对 portable 该检查退化为端口持续在线（正确语义）；systemd 档忽略 ctx 附加字段。
  const unitActive = () => service.isUnitActive(unit, { port });
  const deadline = Date.now() + (o.timeoutMs || 60000);
  while (Date.now() < deadline) {
    if ((await portListening(host, port)) && unitActive()) {
      // 稳定期：用**剩余预算**做缩短的稳定期复检（慢启动实例不得被误判失败，也不超 deadline）。
      const remain = deadline - Date.now();
      const wait = Math.max(0, Math.min(stabilityMs, remain));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // 稳定期复查必须同时复检端口：只查单元会漏掉进程在稳定期内崩溃（端口已空）。
      if ((await portListening(host, port)) && unitActive()) return { ok: true };
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, remain)));
  }
  return { ok: false, reason: '端口 ' + port + ' 未就绪' + (unit ? ' 或单元 ' + unit + ' 未保持 active' : '') };
}

module.exports = {
  PKG_NAME_RE,
  BAD_ARGV_CHAR_RE,
  WIN_DRIVE_ABS_RE,
  fetchNpmLatest,
  fetchGithubLatest,
  fetchLatestVersion,
  runNpmInstall,
  waitPortHealthy,
  // 在途 npm 的记账/中止出口（关停路径经 platform/distribution 门面 re-export）
  killInflightNpm,
  inflightNpmCount,
};
