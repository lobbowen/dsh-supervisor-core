'use strict';

// 分发域的纯策略（无 IO）：镜像合法性、契约/配置合并、探测规格展开、选源决策。
// 全部为具名纯函数，入参显式，可独立 require 单测。

// SSRF 主机分级与镜像基址形态都在 registry-ref 单一定义，本文件只做纯策略的组合与文案。
const registryRef = require('./registry-ref');

/** npm 子进程动作的时长预算（毫秒）。两处最坏情形不同，故分开定量、不再各写一个字面量：
 *  安装受 registry 往返支配；卸载只删本地 node_modules，卡住的原因是网络盘/杀软扫描，
 *  量级与 Rust 侧 npm 上限（15min）对齐。调用方可用 config 覆盖（测试与慢盘环境）。 */
const NPM_TIMEOUT_MS = { install: 600000, uninstall: 900000 };

/** 最小兜底镜像源——仅契约缺失/损坏时使用，不参与正常选择路径（不变量 C2 的兜底）。
 *  完整目录与探测规格归壳（经 registry.json 的 catalog 投放）。保留 2 条覆盖两种基本
 *  情形：能上公网（官方）/ 中国网络（npmmirror）。 */
const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

/** 写入口镜像源闸：形态闸（registry-ref）+ 私网主机闸。镜像源是唯一能进内核 fetch 与 npm
 *  下载链的外部地址，落盘即等于把内核指向内网/元数据地址，所以这一层必须比消费闸严；
 *  探测端点（api/domains/dist.js 的 probeTargetError）对**已配置** hostname 反向豁免，分工不同。
 *  @returns {string|null} 拒因；null=放行 */
function registryOriginViolation(origin) {
  const parsed = registryRef.parseRegistryBase(origin);
  if (!parsed.ok) return parsed.violation;
  return registryRef.hostViolation(parsed.host);
}

/** 生效的候选 registry 列表：配置优先，空则回退兜底。 */
function effectiveOrigins(registryConfig, defaultRegistries) {
  const o = (registryConfig && registryConfig.origins) || [];
  const list = o.filter((x) => typeof x === 'string' && x.trim());
  return list.length ? list : [...defaultRegistries];
}

/** 由契约 / 旧文档 / 兜底重建内核持有的 registryConfig（纯）。
 *  优先级：契约 catalog（壳是所有者）> 旧 origins > 兜底。 */
function rebuildRegistryConfig(doc, contract, defaultRegistries) {
  const fromContract = (contract && contract.ok) ? contract.catalog : [];
  const fromDoc = (Array.isArray(doc.origins) && doc.origins.length) ? doc.origins : [];
  const origins = fromContract.length ? fromContract : (fromDoc.length ? fromDoc : [...defaultRegistries]);
  return {
    mode: (doc.mode === 'manual') ? 'manual' : 'auto',
    origins,
    manualOrigin: (typeof doc.manualOrigin === 'string' && doc.manualOrigin)
      ? doc.manualOrigin : (origins[0] || ''),
  };
}

/** 展开单个镜像的探测目标。契约 probe.kind='package-metadata' 且有 platformTag 时用与壳完全一致的真实包元数据 URL，否则退化为 `/-/ping`
 *  （实测两种规格延迟差数倍，两侧必须同规格，否则「面板显示一个源、实际下载用另一个」分叉）。
 *  platformTag 为 null/空（宿主不可产标或不在发布矩阵，调用方 probeRegistry 已判定）时必须退化 —— 缺守卫会把字面量 `undefined` 拼进 pathTemplate 恒 404。
 *  基址非法时返回 url:null + violation，由调用方按「该源不可用」如实记录，而不是拼出一个必败 URL。 */
function resolveProbe(origin, spec, platformTag) {
  const timeoutMs = (spec && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) ? spec.timeoutMs : 4000;
  const parsed = registryRef.parseRegistryBase(origin);
  if (!parsed.ok) return { url: null, kind: 'invalid', timeoutMs, violation: parsed.violation };
  if (spec && spec.kind === 'package-metadata' && spec.pathTemplate && platformTag) {
    return {
      url: registryRef.registryUrl(parsed.base, spec.pathTemplate.replace('{platform}', platformTag)),
      kind: spec.kind,
      timeoutMs,
    };
  }
  return { url: registryRef.registryUrl(parsed.base, '/-/ping'), kind: 'ping', timeoutMs };
}

/** 本机是否在灰度名单内。冻结语义是「读名单包内容 + schema===1 + installId/hostnames 匹配」；
 *  该包尚未发布（预留），故当前只认本地开关 `canary === true`。
 *  注意：不得以「名单包存在」为依据——名单包为全部候选机共用，装了就全员灰度。 */
function isInCanaryList(state) {
  return state.canary === true;
}

module.exports = {
  FALLBACK_REGISTRIES,
  NPM_TIMEOUT_MS,
  registryOriginViolation,
  effectiveOrigins,
  rebuildRegistryConfig,
  resolveProbe,
  isInCanaryList,
};
