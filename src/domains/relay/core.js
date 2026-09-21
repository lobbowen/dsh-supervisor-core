'use strict';

// relay 域纯层（DL-G8：不 require node:fs/http/https/net/child_process）。
// 只放判定与构造：来源信任、常数时间比较、令牌门卫决策、Cookie 取值、HTML polyfill 常量、
// 远程访问模式归一（normalizeRemoteMode）、wan 前置闸（validateWanAccess）、访问视图投影
// （projectRemoteView）、frpc.toml 文本生成、frp 设置归一；副作用一律留在 proxy/session/tunnel/frp 等 IO 层。

const crypto = require('node:crypto');
// 来源必须落在回环或 RFC1918 私有网段；复用 shared/ip 的同一份判定，绝不在本域重写第二份。
const { isLoopbackAddress, isPrivateIpv4 } = require('../../shared/ip');
// 远程令牌强度下限同理由三个跨层消费点共用，实现在 shared/credential（DS-G1 禁跨域边）。
const { remoteTokenStrength } = require('../../shared/credential');

/** 来源地址是否可信（回环 并 RFC1918）。
 *
 *  relay 监听 0.0.0.0 且把 Origin/Referer 改写成回环权威（「回环呈现」），故「谁连得上」等于
 *  「谁拿到 DSH 特权面」；本闸把可达来源收窄到回环与私有网段。注意这不等于鉴权：私网内仍是
 *  共享信任域，只是堵住了暴露到公网这一档。
 *  @param req  HTTP 请求（取 req.socket.remoteAddress）
 *  @param sock 可选的原始 socket（Upgrade 路径的 socket）
 */
function isTrustedSource(req, sock) {
  const addr = (req && req.socket && req.socket.remoteAddress)
    || (sock && sock.remoteAddress)
    || '';
  if (!addr) return false;
  // Node 对 IPv4-mapped IPv6 呈现::ffff:a.b.c.d —— 归一到 IPv4 字面量后再判定。
  const norm = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)
    ? addr.replace(/^::ffff:/i, '')
    : addr.toLowerCase();
  return isLoopbackAddress(norm) || isPrivateIpv4(norm);
}

/** 常数时间比较（先 sha256 归一到定长，避免长度侧信道）。 */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 提取 Cookie 头中给定名字的值（只按分号切段，不做通用 Cookie 解析）。 */
function cookieByName(headerValue, name) {
  if (!headerValue) return null;
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=');
    if (at === -1) continue;
    if (segment.slice(0, at).trim() === name) return segment.slice(at + 1).trim();
  }
  return null;
}

/** 转发给上游的请求路径：门卫令牌 ?token= 只服务于 relay 自己的准入，
 *  对 DSH 上游是纯噪声，且门卫令牌会随 path 落进 DSH 访问日志/Referer 链——转发前剥离。
 *  （lan cookie 302 之后本已无 token；此处兜住「带 token 直达非根路径」与 WS 升级形态。
 *   DSH 自身的启动令牌不经此路：/open bootstrap 走回环直连。HTTP 与 tunnel 共用本实现，
 *   放纯层也避免 proxy<->tunnel 互 require 成环。） */
function upstreamPath(rawUrl) {
  try {
    const u = new URL(rawUrl, 'http://127.0.0.1');
    if (u.searchParams.has('token')) u.searchParams.delete('token');
    return u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  } catch { return rawUrl || '/'; }
}

/** 门卫会话 cookie 值：`sha256(salt + '\n' + token)`。
 *  旧实现把 remoteToken **原文**写进 dsh_lan_token cookie 当会话凭据——静态门卫凭据随每个请求
 *  上线、落进浏览器 cookie 仓，一次截获永久有效且无法与令牌本身分开轮换。改为加盐派生后：
 *  cookie 是派生会话凭据（kinds 'lan-gate' 的声明语义「我方签发并校验」），从 cookie 值反推
 *  不出令牌明文；salt 为 relay 进程随机数，进程重启即全部会话失效（须重凭 ?token= 进入）。
 *  @returns {string} hex；salt/token 任一缺失返回 ''（调用方据此拒绝匹配）。 */
function lanGateCookieValue(token, salt) {
  const t = String(token == null ? '' : token);
  const s = String(salt == null ? '' : salt);
  if (!t || !s) return '';
  return crypto.createHash('sha256').update(s + '\n' + t).digest('hex');
}

/** 请求是否携带有效令牌（URL ?token= 或派生会话 Cookie）。纯判定，无 IO。
 *：Cookie 档只认派生值，门卫令牌原文只允许经 ?token= 一次性出示。 */
function hasValidToken(req, token, salt) {
  if (!token) return true;
  const url = new URL(req.url, 'http://localhost');
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) return true;
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
  if (m) {
    try {
      const want = lanGateCookieValue(token, salt);
      return !!want && safeEqual(decodeURIComponent(m[1]), want);
    } catch {
      return false;
    }
  }
  return false;
}

/** 令牌门卫决策（HTTP 响应路径）。纯函数，应答由调用方落笔。
 *  @param salt relay 进程随机盐（lanGateCookieValue；缺失 = 无法签发/校验会话 cookie，fail-closed）
 *  @returns {ok:true} 放行；
 *           {ok:false, redirect, cookie} 首次凭 URL 令牌进入，302 种 HttpOnly 派生会话 Cookie；
 *           {ok:false, unauthorized:true} 401。
 */
function tokenGateDecision(req, token, salt) {
  if (!token) return { ok: true };
  const url = new URL(req.url, 'http://localhost');
  const cookies = req.headers.cookie || '';
  const m = /(?:^|;\s*)dsh_lan_token=([^;]+)/.exec(cookies);
  if (m) {
    try {
      const want = lanGateCookieValue(token, salt);
      if (want && safeEqual(decodeURIComponent(m[1]), want)) return { ok: true };
    } catch {}
  }
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) {
    return {
      ok: false,
      redirect: url.pathname,
      // 令牌条 5：种的是派生会话值，绝不是门卫令牌原文。
      cookie: 'dsh_lan_token=' + lanGateCookieValue(token, salt) + '; Path=/; HttpOnly; SameSite=Lax',
    };
  }
  return { ok: false, unauthorized: true };
}

// 非回环 HTTP 源上 crypto.randomUUID 不存在（secure-context-only），
// 而 DSH 客户端用它生成每个 RPC 的 id —— 缺失即所有请求抛错、WS 就绪握手失败。
// 反代在 HTML 注入此 polyfill，使局域网源的客户端获得等价能力。
const POLYFILL_SCRIPT = `<script>
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = '';
    for (var i = 0; i < 16; i++) h += (i === 4 || i === 6 || i === 8 || i === 12 ? '-' : '') + ('0' + b[i].toString(16)).slice(-2);
    return h;
  };
}
</script>`;

/** settings 与 instances 生成 frpc.toml 文本（纯，无 IO）。
 *  loginFailExit 必须为 false：frpc 默认 true 时首次连不上 frps 即退出且不重试，隧道永久失效；
 *  置 false 让 frpc 自身持续重连。wanPort 未分配时不得写出无效 [[proxies]]。
 *  端口纪律：公网口与本机 relay 口恒同号（remotePort = wanPort），不存在第二套端口分配。 */
function buildFrpcToml(settings, instances) {
  const s = settings || {};
  const lines = [];
  lines.push('serverAddr = "' + (s.serverAddr || '').replace(/"/g, '') + '"');
  lines.push('serverPort = ' + (Number(s.serverPort) || 7000));
  if (s.authToken) lines.push('auth.token = "' + String(s.authToken).replace(/"/g, '') + '"');
  lines.push('loginFailExit = false');
  lines.push('');
  let count = 0;
  for (const inst of instances || []) {
    if (normalizeRemoteMode(inst.remoteMode) !== 'wan' || !Number.isInteger(inst.wanPort) || inst.wanPort <= 0) continue;
    const name = (s.user || 'dsh') + '-lan-' + String(inst.id).slice(-8);
    lines.push('[[proxies]]');
    lines.push('name = "' + name.replace(/"/g, '') + '"');
    lines.push('type = "tcp"');
    lines.push('localIP = "127.0.0.1"');
    lines.push('localPort = ' + inst.wanPort);
    lines.push('remotePort = ' + inst.wanPort);
    lines.push('');
    count++;
  }
  return { text: lines.join('\n'), count };
}

/** frp 设置归并（patch 覆盖现值，纯）。frpc 进程生命周期由「是否存在 wan 实例」驱动，
 *  设置面只有连接参数，没有总闸。 */
function normalizeFrpSettings(patch, current) {
  const j = patch || {};
  const cur = current || {};
  return {
    serverAddr: String(j.serverAddr !== undefined ? j.serverAddr : cur.serverAddr).trim(),
    serverPort: Number(j.serverPort) || cur.serverPort,
    authToken: String(j.authToken !== undefined ? j.authToken : cur.authToken),
    user: String(j.user || cur.user || 'dsh'),
  };
}

/** frp 服务器地址前置校验（纯）：serverAddr 为空时 frpc 只会连到空地址、永不建隧道。
 *  wan 模式写入闸与 frp.start() 执行边界共用本判定。 */
function validateFrpServerSettings(settings) {
  const s = settings || {};
  if (!String(s.serverAddr || '').trim()) {
    return { ok: false, error: '启用公网访问前必须填写服务器地址（serverAddr）' };
  }
  return { ok: true };
}

/** 凭据失败退避判定：纯函数，计时与账本由调用方（proxy 层内存 Map）持有。
 *  门卫令牌校验（tokenGateDecision/hasValidToken）此前对失败完全无状态，公网侧可无限速爆破。
 *  @param {{failCount:number, firstAt:number, now:number}} f  now=当前时刻(ms)
 *  @param {{max:number, windowMs:number, lockMs:number}} [cfg]
 *  @returns {{waitMs:number|null}} null=可立即尝试；否则须等待的毫秒数（可为正数=锁未到期） */
function backoffGate(f, cfg) {
  const c = cfg || {};
  const max = c.max || 10;
  const windowMs = c.windowMs || 60000;
  const lockMs = c.lockMs || 60000;
  const failCount = Number(f && f.failCount) || 0;
  const firstAt = Number(f && f.firstAt) || 0;
  const now = Number(f && f.now) || 0;
  if (!failCount || !firstAt || now - firstAt >= windowMs) return { waitMs: null };
  if (failCount < max) return { waitMs: null };
  return { waitMs: Math.max(0, lockMs - (now - firstAt)) };
}

/** 公网访问（wan）前置安全闸（纯）：relay 空 token 恒放行 + 回环呈现，公网可零认证触达特权 API。
 *  进入 wan 模式前强制要求已设访问令牌；端口无自由度（公网口与 relay 口恒同号），
 *  端口合法性/占用不在本闸——由 relay 槽位注册表单一事实源保证。
 *  @param {string} remoteToken
 *  @returns {{ok:true}|{ok:false, error:string}}
 */
function validateWanAccess({ remoteToken }) {
  const strength = remoteTokenStrength(remoteToken);
  if (!strength.ok) {
    const error = strength.reason === 'short'
      ? '远程访问令牌（remoteToken）至少 8 位：公网暴露可被暴力枚举，过短令牌等同无令牌'
      : '开启公网访问前请先为该实例设置远程访问令牌（remoteToken），否则 DSH 特权接口将对公网完全开放';
    return { ok: false, error };
  }
  return { ok: true };
}

/** 远程访问模式读侧归一（纯）：磁盘/快照记录可能缺字段，一律收敛到 'off'，消费方不做真值猜测。 */
function normalizeRemoteMode(v) {
  return v === 'lan' || v === 'wan' ? v : 'off';
}

/** 远程访问视图投影（纯）——URL 与就绪态的唯一事实源，前端零判定直消费。
 *  ready 语义：relay 在监听 且 DSH 会话 cookie 已注入（= 扫码即进入已认证会话）；
 *  wan 模式额外要求 frpc 在跑（公网隧道存活）。未就绪的具体原因按优先级给出，供 UI 悬停呈现。
 *  @param {{mode,relayListening,cookieReady,tokenSet,frpcRunning,serverAddr,lanAddress,wanPort}} v
 *  @returns {{mode:string, ready:boolean, accessUrl:string|null, reasons:string[]}}
 */
function projectRemoteView(v) {
  const x = v || {};
  const mode = normalizeRemoteMode(x.mode);
  if (mode === 'off') return { mode, ready: false, accessUrl: null, reasons: [] };
  const reasons = [];
  if (!x.relayListening) reasons.push('远程服务未就绪（relay 未监听）');
  if (!x.tokenSet) reasons.push('未设访问令牌');
  else if (!x.cookieReady) reasons.push('正在注入 DSH 会话…');
  if (mode === 'wan') {
    if (!String(x.serverAddr || '').trim()) reasons.push('未配置 frps 服务器地址');
    if (!x.frpcRunning) reasons.push('公网隧道未建立（frpc 未运行）');
  }
  const ready = !reasons.length;
  let accessUrl = null;
  if (Number.isInteger(x.wanPort) && x.wanPort > 0) {
    const host = mode === 'wan' ? String(x.serverAddr || '').trim() : String(x.lanAddress || '').trim();
    if (host) accessUrl = 'http://' + host + ':' + x.wanPort + '/';
  }
  return { mode, ready, accessUrl, reasons };
}

module.exports = {
  isTrustedSource,
  cookieByName,
  upstreamPath,
  hasValidToken,
  lanGateCookieValue,
  tokenGateDecision,
  backoffGate,
  POLYFILL_SCRIPT,
  buildFrpcToml,
  normalizeFrpSettings,
  normalizeRemoteMode,
  validateFrpServerSettings,
  validateWanAccess,
  projectRemoteView,
};
