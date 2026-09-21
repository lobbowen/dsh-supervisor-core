'use strict';

// 生命周期引擎纯决策（PROXY-ISOLATION-STANDARD 平级件 PROXY-LIFECYCLE-STANDARD L-A）：
// 期望集 = {在用} + {预热}，是反代域进程动作的唯一决策源。
// 槽位预算是引擎常量（在用 1 + 预热 1），不是配置——旧 proxyInstanceLimits 读取面无任何
// 注入方（假配置），已删；扩槽须修订标准重新裁决，不留暗参数。
// 预热参选 = registeredAt 登记顺序（裁决 2），不做额度择优（旧 needSpare 80%/时间窗判据废止）；
// 预热槽 sticky，占用者只有自身失效（或被提为在用）才让位（裁决 4）。
// IO（启停/对账）由 restart.js/proxy.js 编排；本文件零 require 进程/IO 模块。

/** 在用槽预算（引擎常量）。 */
const ACTIVE_SLOTS = 1;
/** 预热槽预算（引擎常量）。存活进程集恒等于期望集：|期望集| <= ACTIVE_SLOTS + PREWARM_SLOTS。 */
const PREWARM_SLOTS = 1;
/** 请求路径同步等待预算（ms）：目标未就绪最多等这么久，超预算换号（裁决 1 的转发侧形态）。 */
const SWITCH_BUDGET_MS = 2000;

function byRegisteredAt(a, b) {
  return (a.registeredAt || 0) - (b.registeredAt || 0);
}

/** 期望集计算。
 *  @param state { accounts, isUsable, selectedAccountKeyId, activeKeyId, prewarmKeyId }
 *  @returns { active|null, prewarm|null, list }  list=期望运行账号数组（<=2，在用在前）
 *  在用归属：用户锁定优先，其次当前在用指针；皆无则可用池登记序首位（保证恒有一个 HOT 服务位）。
 *  预热归属：sticky 仍在可用池且未被提为在用则留任，否则可用池（排除在用）按登记顺序补位。 */
function computeDesired(state) {
  const s = state || {};
  const usable = (s.accounts || []).filter((a) => s.isUsable(a)).slice().sort(byRegisteredAt);
  if (!usable.length) return { active: null, prewarm: null, list: [] };
  // 槽位预算在此消费：在用槽 + 预热槽 = 存活进程上限；服务位恒存在，槽位全 0 时退化为在用 1。
  const totalSlots = ACTIVE_SLOTS + PREWARM_SLOTS;
  const capped = usable.slice(0, Math.max(1, totalSlots));
  let active = null;
  if (s.selectedAccountKeyId) active = capped.find((a) => a.keyId === s.selectedAccountKeyId) || null;
  if (!active && s.activeKeyId) active = capped.find((a) => a.keyId === s.activeKeyId) || null;
  if (!active) active = capped[0];
  const rest = capped.filter((a) => a.keyId !== active.keyId);
  let prewarm = s.prewarmKeyId ? rest.find((a) => a.keyId === s.prewarmKeyId) || null : null;
  if (!prewarm) prewarm = rest[0] || null;
  const list = [active];
  if (PREWARM_SLOTS > 0 && prewarm) list.push(prewarm);
  return { active, prewarm: PREWARM_SLOTS > 0 ? prewarm : null, list };
}

/** 账号是否属于期望集（入参为 computeDesired.list 或含 keyId 的账号数组）。 */
function isDesired(desired, acc) {
  if (!acc) return false;
  return (desired || []).some((d) => d && d.keyId === acc.keyId);
}

module.exports = { ACTIVE_SLOTS, PREWARM_SLOTS, SWITCH_BUDGET_MS, computeDesired, isDesired };
