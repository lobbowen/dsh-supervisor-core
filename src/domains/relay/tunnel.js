'use strict';

// WebSocket / 任意 Upgrade：重建原始请求头（含回环呈现 + DSH cookie）后建立双向 TCP 隧道。
// 与 proxy.js 的 HTTP 路径共用同一套门禁判定（core）与会话桥（session）；只挡 HTTP 会留下 WS 绕过
// （未设 token 时公网可经 WS 拿到 DSH 特权通道）。

const net = require('node:net');
const { isTrustedSource, hasValidToken, upstreamPath } = require('./core');

/** 重建原始请求行 + 头：host/origin 改写为回环权威（回环呈现），cookie 统一合并输出；
 *  请求行路径经 upstreamPath 剥离门卫 token 参数（与 HTTP 路径同一实现）。 */
function buildRawRequest(req, authority, cookie) {
  let raw = req.method + ' ' + upstreamPath(req.url) + ' HTTP/1.1\r\n';
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host') continue;
    if (k === 'origin') { raw += 'origin: http://' + authority + '\r\n'; continue; }
    if (k === 'cookie') continue; // 已合并到 cookie 变量统一输出
    raw += k + ': ' + v + '\r\n';
  }
  if (cookie) raw += 'cookie: ' + cookie + '\r\n';
  raw += 'host: ' + authority + '\r\n\r\n';
  return raw;
}

/** 建立双向原始 TCP 隧道（任一端出错即双向销毁）。 */
function openTunnel(raw, head, socket, targetHost, targetPort) {
  const upstream = net.connect(targetPort, targetHost, () => {
    upstream.write(raw);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const kill = () => {
    try { socket.destroy(); } catch {}
    try { upstream.destroy(); } catch {}
  };
  upstream.on('error', kill);
  socket.on('error', kill);
}

function rejectSocket(socket, statusLine) {
  try { socket.write(statusLine); } catch {}
  try { socket.destroy(); } catch {}
}

/**
 * @param {object} deps
 *   - session: createSession() 返回的会话桥
 *   - authority: 回环权威 "host:port"
 *   - targetHost/targetPort: 回环 DSH 目标
 *   - getToken: () => string —— 门卫令牌按需读取（proxy 侧可热换）
 *   - getGateSalt: () => string —— 门卫会话盐
 *   - gateWaitMs: (ip) => number|null —— C-3 凭据失败退避（与 HTTP 路径共享账本；null=放行）
 *   - onGateFailure: (ip) => void —— 升级被拒时记一次失败
 */
function createTunnelHandler({ session, authority, targetHost, targetPort, getToken, getGateSalt, gateWaitMs, onGateFailure }) {
  return function onUpgrade(req, socket, head) {
    // 来源闸：WS 升级同样必须限定回环/私网。
    if (!isTrustedSource(req, socket)) {
      rejectSocket(socket, 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ip = (socket && socket.remoteAddress) || (req.socket && req.socket.remoteAddress) || '?';
    // 升级路径同受退避闸约束（否则 HTTP 侧被锁仍可经 WS 继续爆破）。
    if (typeof gateWaitMs === 'function' && gateWaitMs(ip) !== null) {
      rejectSocket(socket, 'HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // 升级握手无法做 302 种 Cookie：凭 ?token= 或既有派生会话 Cookie 放行，否则原始 401。
    if (!hasValidToken(req, getToken(), typeof getGateSalt === 'function' ? getGateSalt() : undefined)) {
      if (typeof onGateFailure === 'function') { try { onGateFailure(ip); } catch {} }
      rejectSocket(socket, 'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    session.ensureDshCookie().then((dshC) => {
      const cookie = session.mergeDshCookie((req.headers.cookie) || '', dshC);
      openTunnel(buildRawRequest(req, authority, cookie), head, socket, targetHost, targetPort);
    }).catch(() => {
      // 换取失败仍按无 DSH cookie 转发（旧版 DSH 场景）
      const cookie = session.mergeDshCookie((req.headers.cookie) || '', session.currentCookie());
      openTunnel(buildRawRequest(req, authority, cookie), head, socket, targetHost, targetPort);
    });
  };
}

module.exports = { createTunnelHandler };
