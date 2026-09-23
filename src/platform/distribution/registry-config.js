'use strict';

// 镜像配置的载入与持久化（IO）：壳投放的 registry.json 由本文件读成内核内存态、写回时只覆盖内核拥有的键。
// 与 registry.js（探测与选源）分开的原因是所有权不同：这里的规则是「谁的字段谁写」，
// 那里的规则是「本次用哪个源」；混在一处会让保留壳字段的义务被选源逻辑淹掉。

const fs = require('node:fs');
const path = require('node:path');
const registryContract = require('../contract/registry');
const { writeAtomic } = require('../util/fs');
const policies = require('./policies');

/** 壳投放契约的重载 TTL（ms）：壳会在运行中重写 registry.json，内核必须能看到。 */
const CONTRACT_TTL_MS = 60 * 1000;

/** 载入镜像配置与壳投放的契约。候选列表优先级（高到低）：1) 契约 catalog；2) registryFile
 *  旧字段 origins；3) defaultRegistries（构造参数，缺省即最小兜底）。mode=manual 在选源时
 *  另置顶锁定 manualOrigin。契约不可用时不阻断：记录 reason 供诊断，选择路径自动回退
 *  （不变量 C2）。 */
function loadRegistryConfig(state) {
  // 1) 先读契约（即使下面是 manual，也要拿到 probe 规格用于复测）
  state.contract = registryContract.read(state.registryFile);
  if (!state.contract.ok) {
    state.logger.warn && state.logger.warn(
      'dist: 镜像契约不可用（' + state.contract.reason + '），回退到最小兜底（' +
      state.defaultRegistries.length + ' 条）'
    );
    if (state.events) {
      try {
        state.events.append('dist_contract_unavailable', {
          reason: state.contract.reason, file: state.registryFile,
        });
      } catch { /* 事件失败不阻断 */ }
    }
  }
  // 2) 旧字段（mode/manualOrigin/origins）保留读取，兼容 v1 与「内核自己写过的配置」
  if (!state.registryFile) return;
  try {
    if (!fs.existsSync(state.registryFile)) return;
    const doc = JSON.parse(fs.readFileSync(state.registryFile, 'utf8'));
    if (typeof doc !== 'object' || !doc) return;
    state.registryConfig = policies.rebuildRegistryConfig(doc, state.contract, state.defaultRegistries);
  } catch (e) {
    state.logger.warn && state.logger.warn('dist: registry config load failed: ' + e.message);
  }
}

/** 距上次载入超过 CONTRACT_TTL_MS 则重载壳投放的镜像契约。不用 fs.watch：无句柄泄漏、
 *  跨平台一致，60s 新鲜度对低频的镜像选择足够。 */
function reloadContractIfStale(state) {
  const now = Date.now();
  if (state._contractLoadedAt && (now - state._contractLoadedAt) < CONTRACT_TTL_MS) return;
  loadRegistryConfig(state);
  state._contractLoadedAt = now;
}

/** 落盘 registry 配置。该文件的所有者是桌面壳（壳写入 v2 字段 catalog/probe/selected）：
 *  内核必须保留壳字段，只覆盖自己拥有的 mode/origins/manualOrigin，
 *  否则一次保存就抹掉壳的镜像解析依据。 */
function saveRegistryConfig(state) {
  if (!state.registryFile) return;
  try {
    const dir = path.dirname(state.registryFile);
    if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建目录失败不阻断 */ } }
    writeRegistryDoc(state);
  } catch (e) {
    state.logger.warn && state.logger.warn('dist: registry config save failed: ' + e.message);
  }
}

/** 读回原文档（保留壳字段与未来新增字段），只覆盖内核拥有的三键，原子写回。 */
function writeRegistryDoc(state) {
  const f = state.registryFile;
  let doc = {};
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') doc = parsed;
  } catch { /* 首次写入：无原文件 */ }
  const rc = state.registryConfig || {};
  doc.mode = rc.mode;
  doc.origins = rc.origins;
  doc.manualOrigin = rc.manualOrigin;
  writeAtomic(f, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
}

module.exports = {
  CONTRACT_TTL_MS,
  loadRegistryConfig,
  reloadContractIfStale,
  saveRegistryConfig,
};
