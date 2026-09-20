'use strict';

// 凭据强度判定（L0 纯函数：零 require、零 IO、零平台分支、零域知识）。
// 为什么在 shared 而不是 relay 域：远程令牌的强度下限同时被 **relay 暴露闸**、**实例域写入口**、
// **app 侧 patchDshMain** 消费，三个消费点跨两个域 + 编排层。放在任一域内都会逼出
// `domains/instance -> domains/relay` 这种跨域边（DS-G1 判红），而判定本身没有任何域知识——
// 与 `shared/ip`（来源可信判定被 relay 与 api 共用）同形，按 DIRECTORY-STRUCTURE-DESIGN §4 的
// 既有裁决上移到 shared，单一事实源在此，绝不重写第二份。

/** 远程访问令牌强度闸（C-3，批 4）：与 apiAccessKey 的「至少 8 位」门（app/settings/access.js）
 *  同规。旧闸只判「非空白」——remoteToken 守护的是经 frp 暴露到公网的 DSH 特权面
 *  （relay 空 token 恒放行 + 回环呈现），1~2 位令牌等同无令牌，可被公网暴力枚举。
 *  纯函数：只回判定，落点（写盘前 / 暴露闸）由调用方负责。
 *  @param {string} token  @returns {{ok:boolean, reason:string}} reason ∈ ''（合格）| 'empty' | 'short' */
function remoteTokenStrength(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < 8) return { ok: false, reason: 'short' };
  return { ok: true, reason: '' };
}

module.exports = { remoteTokenStrength };
