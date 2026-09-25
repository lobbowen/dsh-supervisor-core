'use strict';

// 环境表单（外部打开链路的最底层）：把「这台机器与本产品相关的实况」一次收齐并常驻呈现 ——
//   装了哪些浏览器、系统说不出哪个是默认、有没有图形会话、用户在本产品里选过谁、
//   每条结论是从哪条系统事实读来的。后续动作只从这张表分发（选路见 pickLauncher，执行见 ./browser.js）。
//
// 为什么要一张表而不是各动作各探各的：直启打开与登录隔离窗此前各自摸系统事实、各自解释结果，
//   于是「面板说交出去了、屏幕上什么都没有」在真机上无从定性。表单收敛的是**事实与分发依据**，
//   不是又一个调用口：动作层只问「这次该用谁」，不再问「系统里有什么」。
// 平台事实仍只写在 ./browser-inventory.js 一处：本文件不查注册表、不跑 LaunchServices 脚本、
//   不扫 XDG 目录，只做表单装配、选路次序与快照落盘。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stateRoot = require('../service/state-root');
const { writeAtomic } = require('../util/fs');
const desktop = require('./desktop');
const detector = require('./browser-inventory');
const { engineOf } = detector;

/** 快照 schema：落盘格式变更时递增，读侧据此判旧快照是否作废（不得按字段猜版本）。 */
const SCHEMA = 1;

/** 快照文件名（落在本产品状态目录，与 config/state 同处）。 */
const FILE_NAME = 'environment.json';

/** 表单缓存窗口：与探测层的清单缓存同量级，面板轮询不得把系统查询变成常态开销。 */
const FORM_TTL_MS = 60000;

/** 装配期注入的取数口。platform 不得 require app/api（分层门禁 L-1），而「用户的偏好」住在内核配置里、
 *  「能力矩阵的实测覆写」住在 ./index.js 里，两者都只能由上层在组装时把 getter 绑进来。
 *  绑一次即全局生效，调用点不必层层传参 —— 漏传一处就是一条静默降级路（偏好被忽略、界面仍显示已选）。 */
let _sources = {};

/** @param {{preference?:Function, capabilities?:Function}} sources 同名覆盖，未给的保持原状。 */
function bind(sources) {
  _sources = Object.assign({}, _sources, sources || {});
  return _sources;
}

/** 用户在本产品里选的浏览器（配置项 id）；未绑定或值为空即 null。 */
function preferenceId() {
  const f = _sources.preference;
  if (typeof f !== 'function') return null;
  const v = f();
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 能力矩阵（含实测覆写的最终档位）；未绑定即 null，表单如实标「未绑定」而不冒充一份档位。 */
function capabilities() {
  const f = _sources.capabilities;
  if (typeof f !== 'function') return null;
  return f() || null;
}

/** 本机身份（只读，零 spawn、零网络）。userInfo 在部分服务语境会抛，故落到环境变量。 */
function identity() {
  let user = null;
  try { user = os.userInfo().username; } catch { user = process.env.USER || process.env.USERNAME || null; }
  return {
    platform: process.platform, arch: process.arch,
    hostname: os.hostname(), user: user || null, home: os.homedir(), node: process.version,
  };
}

/** 本产品状态落点（快照写在这里；被管控对象的数据目录不属于本表单）。 */
function paths() {
  return { root: stateRoot.root(), supervisor: stateRoot.supervisorDir(), shell: stateRoot.shellDir() };
}

/** 候选清单的规整形态：engine 恒有值（探测层漏填时按可执行文件名现推），isDefault 按系统默认项标定。
 *  表单与选路共用这一份，避免出现「面板显示两个、实际按第三个启动」。 */
function normalizeInventory(inv, platform) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const defaultId = inv && inv.defaultId ? inv.defaultId : null;
  return {
    platform: (inv && inv.platform) || platform || process.platform,
    cached: !!(inv && inv.cached),
    at: inv && inv.at !== undefined ? inv.at : null,
    defaultId,
    defaultSource: (inv && inv.defaultSource) || null,
    browsers: list.map((b) => ({
      id: b.id,
      name: b.name,
      bin: b.bin,
      engine: b.engine || engineOf(b.bin),
      baseArgs: b.baseArgs || [],
      sources: b.sources && b.sources.length ? b.sources : [b.source || 'unknown'],
      isDefault: !!defaultId && b.id === defaultId,
    })),
    probed: (inv && inv.probed) || [],
  };
}

/** 浏览器候选清单（探测层的原样视图 + 表单补上的判定字段）。
 *  @param {{force?:boolean, platform?:string, inventory?:object, resolveInventory?:Function, resolveDeps?:object}} [o]
 *    注入缝供行为测试：CI 机器不真查注册表，夹具与选路必须同源。 */
function browsers(o) {
  const ov = o || {};
  const pl = ov.platform || process.platform;
  if (ov.inventory) return normalizeInventory(ov.inventory, pl);
  const resolve = typeof ov.resolveInventory === 'function' ? ov.resolveInventory
    : ((platform, deps) => detector.inventory(platform, deps));
  return normalizeInventory(resolve(pl, ov.resolveDeps || {}), pl);
}

/** 候选次序（纯函数）：引擎族是「裸 URL 直启的参数语义是否确定」的唯一分级依据 ——
 *  chromium / firefox 两族已知，other（Safari、打包器包装）连能否带地址直启都不确定。
 *  同族按 id 字典序，保证同一台机器每次给出同一个答案，不随清单产出顺序漂移。 */
const ENGINE_RANK = { chromium: 0, firefox: 1, other: 2 };
function rankCandidates(list) {
  const rankOf = (b) => {
    const r = ENGINE_RANK[b && b.engine];
    return r === undefined ? ENGINE_RANK.other : r;
  };
  return (Array.isArray(list) ? list : []).slice().sort((a, b) => {
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    const ia = String((a && a.id) || '');
    const ib = String((b && b.id) || '');
    return ia < ib ? -1 : (ia > ib ? 1 : 0);
  });
}

/** 分发依据（纯函数）：这次交给哪个浏览器。四层优先级，写在这里一次，动作层不再自己判：
 *  1) 用户在本产品里选过的偏好 —— 只在它仍是当前候选时作数；
 *  2) 系统自己说得出的默认项（认 defaultId 字段，来源名由探测层给，本层不认具体名字）；
 *  3) 穷举后的唯一候选（唯一解，不是选择）；
 *  4) 候选多个而系统说不出默认：按候选次序取首个（how='candidate-rank'）并留痕。
 *  第 4 层是本轮的收口点：真机形状正是「装了多个浏览器但读不到用户选择」，旧实现在此返回空对象、
 *  整条链路报 no-launcher，用户看到的是「点一键登录什么都没弹」。
 *  偏好所指被卸载/不可执行时不静默换人：回落并在 stale 里如实标出，面板据此提示重选。
 *  @param {string} [platform]
 *  @param {object} inv 规整后的候选清单（normalizeInventory / browsers 的返回）
 *  @param {string|null} [preference] 显式传 null 表示「无偏好」；不传则取装配期绑定的偏好
 *  @returns {{browser:object|null, how:string, wanted:string|null, stale:boolean}} */
function pickLauncher(platform, inv, preference) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const byId = new Map();
  for (const b of list) byId.set(b.id, b);
  const wanted = preference === undefined ? preferenceId()
    : (typeof preference === 'string' && preference ? preference : null);
  const stale = wanted !== null && !byId.has(wanted);
  const out = (browser, how) => ({ browser, how, wanted, stale });
  if (wanted !== null && byId.has(wanted)) return out(byId.get(wanted), 'user-preference');
  const sys = inv && inv.defaultId ? byId.get(inv.defaultId) : null;
  if (sys) return out(sys, inv.defaultSource || 'default');
  if (list.length === 1) return out(list[0], 'only-installed');
  if (list.length > 1) return out(rankCandidates(list)[0], 'candidate-rank');
  return out(null, 'none-found');
}

/** 表单快照的落盘位置。 */
function snapshotPath() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

/** 读回上一次落盘的快照（无/坏/版本不符一律 null：快照是给人看的留痕，不是启动依赖）。 */
function readSnapshot() {
  try {
    const doc = JSON.parse(fs.readFileSync(snapshotPath(), 'utf8'));
    return doc && doc.schema === SCHEMA ? doc : null;
  } catch { return null; }
}

let _formCache = null;

/** 环境表单：一次装配出本机全部相关事实。
 *  @param {{force?:boolean, persist?:boolean, now?:Function, ttlMs?:number, platform?:string,
 *           inventory?:object, resolveInventory?:Function, resolveDeps?:object}} [o]
 *    persist=true 才落盘（读路径不写盘；面板刷新与启动装配各写一次即可）。
 *  @returns {object} schema/at/identity/paths/session/capabilities/preference/browsers/default/pick/probed/snapshot */
function form(o) {
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : (() => Date.now());
  const stamp = now();
  const ttl = ov.ttlMs === undefined ? FORM_TTL_MS : ov.ttlMs;
  if (!ov.force && _formCache && stamp - _formCache.at < ttl) {
    return Object.assign({}, _formCache.value, { cached: true });
  }
  const inv = browsers(ov);
  const caps = capabilities();
  const session = desktop.describe();
  const prefId = preferenceId();
  const prefEntry = prefId ? (inv.browsers.find((b) => b.id === prefId) || null) : null;
  const preference = {
    id: prefId,
    configured: !!prefId,
    matched: !!prefEntry,
    browser: prefEntry ? { id: prefEntry.id, name: prefEntry.name, engine: prefEntry.engine } : null,
    reason: !prefId ? 'not-set' : (prefEntry ? 'matched' : 'stale'),
  };
  const pick = pickLauncher(inv.platform, inv, prefId);
  const probed = inv.probed.map((p) => ({ section: 'browsers', source: p.source, detail: p.detail }));
  probed.push({ section: 'session', source: 'desktop', detail: session.reason + (session.available ? '（可用）' : '（不可用）') });
  probed.push({ section: 'capabilities', source: 'profile',
    detail: caps ? 'openBrowser=' + (caps.openBrowser === true) : '未绑定能力矩阵（由 platform/os/index.js 装配期注入）' });
  probed.push({ section: 'preference', source: 'config',
    detail: preference.reason === 'not-set' ? '未设置，按系统默认或候选次序分发'
      : (preference.reason === 'matched' ? '已选 ' + preference.browser.name : '偏好所指已不在候选清单: ' + prefId) });
  probed.push({ section: 'pick', source: 'form',
    detail: pick.how + (pick.browser ? '（' + pick.browser.name + '）' : '（无候选）') + (pick.stale ? '，偏好已失效需重选' : '') });
  const value = {
    schema: SCHEMA,
    at: stamp,
    platform: inv.platform,
    identity: identity(),
    paths: paths(),
    session,
    capabilities: caps,
    preference,
    default: inv.defaultId ? { id: inv.defaultId, source: inv.defaultSource } : null,
    browsers: inv.browsers,
    pick: { how: pick.how, id: pick.browser ? pick.browser.id : null, name: pick.browser ? pick.browser.name : null, wanted: pick.wanted, stale: pick.stale },
    probed,
  };
  const snapshot = { path: snapshotPath(), written: false, error: null };
  if (ov.persist === true) {
    try {
      writeAtomic(snapshot.path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      snapshot.written = true;
    } catch (e) { snapshot.error = String((e && e.message) || e); }
    probed.push({ section: 'snapshot', source: FILE_NAME,
      detail: snapshot.written ? '已落盘 ' + snapshot.path : '落盘失败: ' + snapshot.error });
  }
  value.snapshot = snapshot;
  _formCache = { at: stamp, value };
  return Object.assign({ cached: false }, value);
}

/** 显式失效：改动偏好或装卸浏览器后刷新。表单与探测层一起失效，否则下一拍仍读到旧候选。 */
function invalidate(platform) {
  _formCache = null;
  return detector.invalidate(platform);
}

/** 偏好校验（纯函数）：空值=清除；非空必须是当前候选清单里的 id，其余一律拒写。
 *  判据住在表单而不住在写入口：它的依据就是这张表的候选面。写入口可以有很多个（面板、CLI、
 *  未来的导入），各自定义「什么算合法偏好」就会各自漂移 —— 与本轮「问一处答两处」同一种病。
 *  @param {*} value 用户提交的原始值（非字符串按空处理，不猜）
 *  @param {object} form 当前环境表单
 *  @returns {{ok:boolean, id:string|null, browser:object|null, error?:string, candidates:object[]}} */
function checkPreference(value, form) {
  const candidates = ((form && form.browsers) || []).map((b) => ({
    id: b.id, name: b.name, engine: b.engine, isDefault: b.isDefault === true,
  }));
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return { ok: true, id: null, browser: null, candidates };
  const hit = candidates.find((c) => c.id === id);
  if (!hit) {
    return { ok: false, id: null, browser: null, candidates, error: '该浏览器不在本机候选清单里（可能已卸载或路径失效），请先刷新环境表单' };
  }
  return { ok: true, id: hit.id, browser: hit, candidates };
}

module.exports = {
  SCHEMA, FILE_NAME, FORM_TTL_MS,
  bind, preferenceId, capabilities, identity, paths,
  browsers, normalizeInventory, rankCandidates, pickLauncher, checkPreference,
  form, snapshotPath, readSnapshot, invalidate,
};
