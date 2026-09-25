'use strict';

// 三端同一「交给系统浏览器」出口。分层固定，每层只干一件事：
//   探测（./browser-inventory.js）—— 这台机器装了哪些浏览器、默认是哪个、每条结论来自哪个系统事实；
//   选路（openPlan / isolatedPlan / pickLauncher，本文件）—— 这次该用哪一个，拿不到就说拿不到；
//   执行（openBrowser / launchIsolated，本文件）—— spawn 一次并如实回报拿到的是什么档证据。
// 浏览器选择权在用户不在产品：本文件绝不点名任何浏览器，也不在探测失败时「挑一个试试」。

// 外部打开的唯一出口是 openBrowser（非隔离）与 launchIsolated（登录用的隔离窗口），两者共用同一结果词汇
//   {ok, confirmed, handedOff, reason, error, message}：调用方与面板只需认一套字段，不必各自解释 argv 结局。
// 三档语义不得混为一谈（这是本能力的标准，也是历史上「面板显示成功而屏幕什么都没有」的病根）：
//   confirmed  —— 拿到了「调度器确实接收了该 URL」的证据：仅限本次启动确定拥有自己窗口的形态 0 退出
//   handedOff  —— 命令已交出且 spawn 没报错，但没有任何形态学证据说明窗口出现过
//   ok:false   —— 明确失败（非 0 退出/信号/error 事件/预检不过/选不出启动对象），必须带 reason 码与给用户的一句话。
// 「退出码何时算证据」只由 ownsItsWindow 一处决定，并且**双向**生效：不可信形态既不能凭 0 冒领 confirmed，
//   也不能凭非 0 判成失败。
// 失败必须带得上屏幕的诊断：evidence 里有 pick/found/probed（探测到的候选、默认项来源、每条来源的读数），
//   面板据此把「为什么没弹出来」摊成一行小字。旧形态只有一句「打开失败」，真机报障时无从定性。
// 结果需要等子进程的 error/exit 才能定，而 ENOENT 只在异步 error 事件里出现（见 binAvailable 注释），
//   故 openBrowser 是异步的：同步返回 true 的旧形态等于把「没报错」当「已打开」。

const path = require('node:path');
const spawnOS = require('./spawn');
// 图形会话可用性：只读 env/socket 判定（无 spawn），与本文件同层，故可直接依赖。
const desktop = require('./desktop');
// 能力档位表（纯数据）：外部打开支持哪些平台只由它的 openBrowser 位决定。
const CAPABILITY_PROFILES = require('./capability-profile');
const { resolveExecutable, isExecutableFile } = require('./exec-path');
// 探测层：本文件不查注册表/LaunchServices/XDG，只消费它的清单（平台事实只写一次）。
const detector = require('./browser-inventory');
const { engineOf } = detector;

/** 进 argv 前的唯一闸门：只校验协议为 http/https 的绝对 URL，不校验主机
 *  （两个出口传的都有：openBrowser 传本机回环实例地址，launchIsolated 传外部 OAuth 授权页）。 */
function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** 平台到「系统调度器」的命令（纯函数，不 spawn）。darwin 的 open / linux 的 xdg-open 是文档化调度器，
 *  退出码即「是否接收本次请求」。
 *  win32 返回 null：**没有可信的调度器形态**。系统 shell 的 URL 交付命令未文档化、退出码不携带信息
 *  （真机现场返回 1），且地址带查询串时会被当成路径去开文件资源管理器窗口；`cmd /c start` 是文档化路径，
 *  但 cmd.exe 把 & ^ " ( ) 当活性字符，与本文件「argv 永不裹 shell」的不变量冲突。
 *  所以 Windows 只能直启探测解析出的浏览器本体，解析不出来就显式报 no-launcher —— 宁可如实失败，
 *  也不冒「已交出」的风险（那是本能力历史上全部的假成功来源）。
 *  未知平台有意退化为 xdg-open：这里不宣称任何能力，只尽力尝试；autostart 相反 —— 它要向用户
 *  宣称服务管理器 kind，故未知平台必须显式 none。 */
function openCommand(platform, url) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return { cmd: 'open', args: [url] };
  if (pl === 'win32') return null;
  return { cmd: 'xdg-open', args: [url] };
}

/** 支持外部打开的平台名单：单一来源 = 能力档位表里 openBrowser 为 true 的那些，
 *  本文件不得再写第二份平台判断（档位与行为分叉即「声明能开、实际乱试」）。 */
const SUPPORTED_OPEN_PLATFORMS = Object.keys(CAPABILITY_PROFILES).filter((k) => CAPABILITY_PROFILES[k].openBrowser === true);

/** 结果词汇的唯一构造点：三档语义在此定型，调用方与面板不再各自解释 argv/exit。
 *  @param {{ok:boolean, confirmed?:boolean, handedOff?:boolean, reason?:string|null,
 *           url?:string, evidence?:object}} p
 *  evidence 原样交出（调用方与面板靠它说明「这一档凭的是什么」），本函数不解释也不改写 argv 结局。 */
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
const HANDEDOFF_TEXT = '已把地址交给系统，但这次启动拿不到窗口是否出现的证据';
/** reason 码 -> 给用户的一句话（码是契约、文案是呈现；面板按码挂文案时不得改写码）。
 *  只有 ownsItsWindow 为真的形态才会走到 exit-nonzero/killed-by-signal，故这里可以断言窗口没出现。 */
const FAILURE_TEXT = {
  'unsafe-url': '地址不是 http(s) 绝对 URL，已拒绝交给浏览器',
  'no-launcher': '未能确定该用哪个浏览器打开（系统里读不到默认浏览器设置），请在系统设置里指定默认浏览器或手动打开该地址',
  'spawn-failed': '浏览器启动失败（系统拒绝了该命令）',
  'exit-nonzero': '系统拒绝了这个地址（启动命令非 0 退出），窗口未出现',
  'killed-by-signal': '浏览器启动命令被系统终止，窗口未出现',
  'no-desktop-session': '当前没有图形会话，无法调起浏览器',
  'unsupported-platform': '当前平台不在产品支持的桌面平台内，请手动打开该地址',
};

/** 退出码可信判据的唯一定义处：**本次启动是否确定拥有自己的窗口**。
 *  只有确定是新实例时，它的退出码才同时具备两种证明力：0 说明命令被接收、非 0 说明没接收。
 *  两种不可信形态各有一个平台事实作根据，且都是平台语义而不是产品缺陷：
 *    裸 URL 直启 chromium/firefox 派生系时，浏览器已在运行则本次进程只把地址转交给既有实例，
 *    退出码属于「转交动作」而不属于那个窗口；
 *    win32 只剩直启这一种形态，故该平台恒不可取证（面板必须始终把地址交给用户）。
 *  故不可信形态两个方向都不许进判决，一律只到 handedOff。 */
function ownsItsWindow(via, platform) {
  if (via !== 'dispatcher') return false;
  // darwin 的 open / linux 的 xdg-open：非 0 即调度器明确拒了这次请求，0 即它确认接收。
  // win32 无可信调度器（openCommand 返回 null），到这里不可能成立。
  return platform !== 'win32';
}

/** 选路（纯函数）：探测清单 -> 这次交给谁。顺序只有两条，都不构成「产品挑内核」：
 *  1) 系统自己说得出的默认项（清单条目上的 defaultId，配 defaultSource 说明它是从哪条系统事实读来的；
 *     来源名只存在于探测层，本层认字段不认名字）；
 *  2) 穷举后只有一个候选（唯一解，不是选择）。
 *  有多个候选而系统说不出默认项时返回 null 并留下 how='no-default'：据此显式 no-launcher，
 *  而不是按清单顺序猜一个 —— 猜错就是「面板说开了、屏幕上是另一个浏览器」，比失败更难查。
 *  @param {string} platform
 *  @param {{browsers?:object[], defaultId?:string|null, defaultSource?:string|null}|null} inv
 *  @returns {{browser:object|null, how:string}} */
function pickLauncher(platform, inv) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const id = inv && inv.defaultId;
  const hit = id ? list.find((b) => b.id === id) : null;
  if (hit) return { browser: hit, how: (inv && inv.defaultSource) || 'default' };
  if (list.length === 1) return { browser: list[0], how: 'only-installed' };
  return { browser: null, how: list.length ? 'no-default' : 'none-found' };
}

/** 拿到一个浏览器条目后的启动形态：两族引擎（chromium/firefox 派生系）的裸 URL 参数语义确定，直启本体，
 *  把「用哪个浏览器」留给用户在系统里设的默认值；argv 仍由我们自己拼（不经 shell）。
 *  other 引擎（Safari、snap 包装器）在本平台有可信调度器时交回调度器 —— 裸 URL 参数语义不确定，
 *  但整条链路不得为此砍掉。win32 没有可信调度器，解析到的本体直启是唯一路（引擎不明也只是不可取证）。 */
function formOfBin(pl, b) {
  const engine = b && b.bin ? engineOf(b.bin) : 'other';
  return { engine, direct: !!b && (engine !== 'other' || pl === 'win32') };
}

/** 非隔离打开计划（纯函数，与 isolatedPlan 同族、同一探测输入）。
 *  退出码可信度一律问 ownsItsWindow，此处不再按平台宣称取证能力。
 *  @param {{inventory?:object, pick?:{browser:object|null, how:string}}} [opts] */
function openPlan(platform, url, opts) {
  const o = opts || {};
  const pl = platform || process.platform;
  const picked = o.pick || pickLauncher(pl, o.inventory);
  const b = picked.browser;
  const form = formOfBin(pl, b);
  if (form.direct) {
    return { bin: b.bin, engine: form.engine, via: 'browser', pick: picked.how,
             baseArgs: (b.baseArgs || []).concat([url]), exitIsEvidence: ownsItsWindow('browser', pl) };
  }
  const c = openCommand(pl, url);
  if (!c) return { bin: null, engine: form.engine, via: 'none', pick: picked.how, baseArgs: [], exitIsEvidence: false };
  return { bin: c.cmd, engine: 'other', via: 'dispatcher', pick: picked.how,
           baseArgs: c.args, exitIsEvidence: ownsItsWindow('dispatcher', pl) };
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

/** 探测清单摊成「一行能看完」的诊断，随每次打开的 evidence 交出：
 *  真机报障时这一行就是定档依据（探到几个、默认项从哪条系统事实读出、每条来源答了什么），
 *  不必再让人回去读代码。字段全为字符串/短数组，面板原样渲染。 */
function launchDiagnostics(inv, plan, how) {
  const found = ((inv && inv.browsers) || []).map((b) => ({
    name: b.name, engine: b.engine || engineOf(b.bin),
    via: (b.sources && b.sources.length ? b.sources : [b.source || 'unknown']).join('+'),
  }));
  return {
    platform: (inv && inv.platform) || null,
    pick: how || (plan && plan.pick) || 'none',
    bin: (plan && plan.bin) || null,
    default: inv && inv.defaultId ? { id: inv.defaultId, source: inv.defaultSource || null } : null,
    found,
    probed: (inv && inv.probed) || [],
  };
}

/** 外部打开的唯一出口：把 http(s) URL 交给探测层解析出的浏览器（或该平台的文档化调度器），
 *  并如实回报证据档位。绝不宣称页面已加载 —— 最多说「命令 0 退出」。
 *  @param {string} url
 *  @param {{inventory?:object, resolveInventory?:Function, resolveDeps?:object,
 *           binAvailable?:Function, spawn?:Function, observeMs?:number, setTimeout?:Function,
 *           platform?:string, desktopAvailable?:Function}} [o]
 *    注入缝供行为测试：CI 机器不真起浏览器、不真查注册表。夹具与产品共用同一份 inventory 输入（同源）。
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
  const resolveInv = typeof opts.resolveInventory === 'function' ? opts.resolveInventory
    : ((platform, deps) => detector.inventory(platform, deps));
  const inv = 'inventory' in opts ? opts.inventory : resolveInv(pl, opts.resolveDeps || {});
  const plan = openPlan(pl, url, { inventory: inv, pick: opts.pick });
  const diagnostics = launchDiagnostics(inv, plan, plan.pick);
  const evidence = {
    bin: plan.bin, engine: plan.engine, via: plan.via, ownsWindow: plan.exitIsEvidence === true,
    exitCode: null, exitSignal: null, error: null, diagnostics,
  };
  // linux 无图形会话时任何启动命令都必败：先给出准确原因，别让用户去读 xdg-open 的非 0 退出码。
  // darwin/win32 由图形会话内的 LaunchAgent / schtasks ONLOGON 载入，无会话即无本进程（判定同源 desktop.js）。
  const desktopAvailable = typeof opts.desktopAvailable === 'function' ? opts.desktopAvailable : desktop.sessionAvailable;
  if (pl === 'linux' && !desktopAvailable()) {
    return outcome({ ok: false, reason: 'no-desktop-session', url, evidence });
  }
  // 选不出启动对象 = 显式失败并带诊断（旧形态是退到系统 shell 冒开，屏幕上什么都没有还说「已交出」）。
  if (!plan.bin) {
    return outcome({ ok: false, reason: 'no-launcher', url, evidence });
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
  // 退出码进判决的唯一闸门，规则只在 openPlan/ownsItsWindow 一处写：不可信形态的退出码在两个方向上
  //   都不是证据 —— 据它判红会把已打开的页面报成失败，据它判绿会凭空宣称窗口出现过。
  //   判红与判绿必须同一条 `&&`，分两处写就会重新分叉。
  const exitDecides = seen.stage === 'exit' && plan.exitIsEvidence === true;
  if (exitDecides && (seen.code !== 0 || seen.signal)) {
    return outcome({
      ok: false, reason: seen.signal ? 'killed-by-signal' : 'exit-nonzero', url, evidence,
      error: FAILURE_TEXT[seen.signal ? 'killed-by-signal' : 'exit-nonzero'] + '（' + (seen.signal || seen.code) + '）',
    });
  }
  // 剩下的都是 ok：可信形态 0 退出算 confirmed；不可信形态（或窗口内仍存活、压根没有退出可言）
  //   只算 handedOff —— 命令确实交出去了，但窗口有无只有用户能判，故面板必须同时给出地址。
  return outcome({ ok: true, confirmed: exitDecides, handedOff: !exitDecides, url, evidence });
}

/** 系统浏览器清单（只读诊断面）：面板据此显示「本机探到了什么」，与打开动作共用同一份探测缓存。
 *  @param {{force?:boolean}} [o] force=true 绕开缓存（用户刚装/刚卸载浏览器后用）。 */
function listBrowsers(o) {
  const ov = o || {};
  const inv = detector.inventory(ov.platform, { force: ov.force === true });
  return {
    ok: true,
    platform: inv.platform,
    cached: inv.cached === true,
    default: inv.defaultId ? { id: inv.defaultId, source: inv.defaultSource || null } : null,
    browsers: (inv.browsers || []).map((b) => ({
      id: b.id, name: b.name, engine: b.engine || engineOf(b.bin), bin: b.bin,
      sources: b.sources && b.sources.length ? b.sources : [b.source],
      isDefault: b.id === inv.defaultId,
    })),
    probed: inv.probed || [],
  };
}

/** 缓存失效：安装/卸载浏览器后面板要能立刻反映（与 listBrowsers 的 force 同一目的，两个入口都留着是因为
 *  一个是「只刷这一次」，一个是「下一次自己重探」，语义不同）。 */
function invalidateBrowsers(platform) { return detector.invalidate(platform); }

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

/** 平台到隔离打开的命令规划（纯函数，不 spawn、不做探测 I/O）。
 *  输入与 openPlan 同一份探测清单：登录窗口与非隔离打开必须是同一个浏览器，否则用户在系统里
 *  设的默认值只对一半的功能生效。
 *  拿不到可直启的本体时：本平台有可信调度器就走非隔离兜底（isolated:false，登录靠超时兜底），
 *  没有调度器（win32）则 bin=null，由 launchIsolated 的预检如实报 no-launcher。
 *  @param {{inventory?:object, pick?:{browser:object|null, how:string}, profileDir?:string,
 *           size?:number[], lang?:string}} [opts] */
function isolatedPlan(platform, url, opts) {
  const o = opts || {};
  const pl = platform || process.platform;
  const picked = o.pick || pickLauncher(pl, o.inventory);
  const b = picked.browser;
  const form = formOfBin(pl, b);
  const baseArgs = (b && b.baseArgs) || [];
  if (form.direct && form.engine === 'chromium' && o.profileDir) {
    const args = ['--incognito', '--user-data-dir=' + o.profileDir];
    if (Array.isArray(o.size) && o.size.length === 2) args.push('--window-size=' + o.size[0] + ',' + o.size[1]);
    if (o.lang) args.push('--lang=' + o.lang);
    args.push('--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble');
    // 独立 user-data-dir => 必为新实例进程，其 exit 即窗口关闭（onExit 语义成立）。
    return { bin: b.bin, args: [...baseArgs, ...args, url], isolated: true, watch: true, envKind: 'anti', label: 'chromium', pick: picked.how };
  }
  if (form.direct && form.engine === 'firefox' && o.profileDir) {
    // --no-remote + 专用 profile：不并入既有实例，新进程随窗口关闭而退出。
    return {
      bin: b.bin,
      args: [...baseArgs, '--no-remote', '--profile', o.profileDir, '-private-window', url],
      isolated: true, watch: true, envKind: 'anti', label: 'firefox', pick: picked.how,
    };
  }
  // 其余形态一律不冒充隔离：没有独立 profile 就并入既有实例，onExit 恒误报「用户关了窗口」。
  if (form.direct) {
    return { bin: b.bin, args: baseArgs.concat([url]), isolated: false, watch: false, envKind: 'sys', label: path.basename(b.bin), pick: picked.how };
  }
  const c = openCommand(pl, url);
  if (!c) return { bin: null, args: [url], isolated: false, watch: false, envKind: 'sys', label: null, pick: picked.how };
  return { bin: c.cmd, args: c.args, isolated: false, watch: false, envKind: 'sys', label: c.cmd, pick: picked.how };
}

/** spawn 前的可用性预检：绝对路径判执行位，裸名走 PATH 解析。
 *  必须在 spawn 前判：Node 的 ENOENT 是异步 error 事件，spawn 返回时已成功，
 *  事后挂 error 处理器只能吞掉它，改不了已经上报的 ok/bin。 */
function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\') || /^[A-Za-z]:[\\/]/.test(bin)) return isExecutableFile(bin);
  return resolveExecutable(bin) !== null;
}

/** 以系统默认浏览器做隔离打开（OAuth 一键登录用）：浏览器由操作系统的默认设置决定，
 *  产品只决定「以何种隔离参数打开它」。
 *  与 openBrowser 同一结果词汇；同步返回故只能到 handedOff 档（隔离窗口的存活由 onExit 监视承担）。
 *  @param o 注入点：binAvailable/spawn —— 行为测试不依赖宿主浏览器、不在 CI 机器真起浏览器；
 *  inventory —— 夹具与产品必须共用同一份探测输入，否则预检判定不同源恒 false。
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
    const resolveInv = typeof opts.resolveInventory === 'function' ? opts.resolveInventory
      : ((platform, deps) => detector.inventory(platform, deps));
    const inv = 'inventory' in opts ? opts.inventory : resolveInv(process.platform, opts.resolveDeps || {});
    const plan = isolatedPlan(process.platform, url, {
      inventory: inv, pick: opts.pick, profileDir: opts.profileDir, size: opts.size, lang: opts.lang,
    });
    const evidence = { bin: plan.bin, engine: plan.label, via: plan.isolated ? 'browser' : 'dispatcher', diagnostics: launchDiagnostics(inv, plan, plan.pick) };
    // spawn 前预检：不可用即如实 ok:false，不 spawn 必死的 bin（bin 为 null = 选不出启动对象）。
    if (!avail(plan.bin)) return fail('no-launcher', { evidence });
    const env = plan.envKind === 'anti' ? antiEnv : sysEnv;
    const p = spawnWith(plan.bin, plan.args, env, plan.watch ? onExit : undefined);
    if (!p) return fail('spawn-failed', { evidence });
    return Object.assign(outcome({ ok: true, confirmed: false, handedOff: true, url, evidence }), { bin: plan.label, isolated: plan.isolated });
  } catch (e) { return fail('spawn-failed', { error: FAILURE_TEXT['spawn-failed'] + '（' + ((e && e.code) || e) + '）' }); }
}

module.exports = {
  openBrowser, launchIsolated, openCommand, openPlan, isolatedPlan, pickLauncher, ownsItsWindow,
  observeSpawn, isSafeHttpUrl, binAvailable, listBrowsers, invalidateBrowsers, launchDiagnostics,
  // 探测层的解析原语经此转出（唯一实现处在 ./browser-inventory.js）：门禁与消费方按同一出口取用，
  //   不在别处再写第二份平台解析。
  engineOf, detector,
};
