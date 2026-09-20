'use strict';

// 分发域的纯策略（无 IO）：镜像合法性、契约/配置合并、探测规格展开、选源决策。
// 全部为具名纯函数，入参显式，可独立 require 单测。

// SSRF 主机分级复用 shared/ip 的同一份判定，不在本层重写第二份。
const { isPrivateHostLiteral } = require('../../shared/ip');

/** 最小兜底镜像源——仅契约缺失/损坏时使用（完整目录与探测规格归壳，由壳经
 *  `<产品状态根>/supervisor/registry.json` 的 catalog 投放）。内核只保证契约不可用时也能跑
 *  （不变量 C2），故保留 2 条覆盖两种基本情形：能上网（官方）+ 中国网络（npmmirror）。
 *  此处不参与正常选择路径。 */
const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/+$/, '');
}

/** 是否为合法 http(s) **纯 origin**（防 SSRF 到任意协议；B11 收紧自「仅查 scheme」）。
 *
 *  旧实现 `/^https?:\/\//` 有三个漏洞面（origin 会经字符串拼接进请求 URL / 写进 npm_config_registry）：
 *    - `http://u:pass@host` —— 凭证夹带；
 *    - `http://host/path?q=1` 与 `http://host/#x` —— 路径/查询/片段借拼接污染真实请求路径；
 *    - `http://host//a` —— 拼接后双斜杠改语义。
 *  现判据：能被 WHATWG URL 解析 + 协议仅 http/https + 无用户名密码 + 主机存在，
 *  且（normalizeOrigin 剥尾斜杠后）剩余只能是空或单个 `/`。 */
function isValidOrigin(origin) {
  const s = normalizeOrigin(origin); // 与拼接侧同一归一（剥尾斜杠），合法 `https://host/` 不被误拒
  // 原文形态闸：仅 scheme://host[:port]（host 允许 IPv6 方括号），杜绝 `?`/`#`/`@`/路径等一切夹带；
  // URL 解析闸（下方）兜住原文闸放行的畸形体。
  if (!/^https?:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.\-_]+)(:\d+)?$/.test(s)) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.hash) return false; // WHATWG 解析会把 `#x` 从 pathname 剥离，须单独判
  if (!u.hostname) return false;
  return u.pathname === '' || u.pathname === '/' || u.pathname === '//';
}

/** 写入口镜像源闸：镜像源是**唯一能进内核 fetch 与 npm 下载链**的外部地址，
 *  配置它等同于授予「守卫替你发请求」的能力，故写盘侧必须与探测端点（api/domains/dist.js
 *  的 probeTargetError）同规——纯 origin 合法性 + 主机字面量非私网。
 *  旧 setRegistryConfig 只过 isValidOrigin，`http://169.254.169.254` / `http://127.0.0.1:4873`
 *  这类字面量能直接落盘并**反向豁免**探测闸第1)层（已配置源按 hostname 放行），把守卫变成
 *  内网/元数据探针与投毒下载源。
 *  已知残留（如实登记 AUDIT）：域名形态的 DNS-rebinding（写入时公网解析、连接时私网）
 *  与 HTTP 重定向已由 redirect:'manual' 封堵一半；连接时 IP 固定需自定义 resolver，暂不实现。
 *  @returns {string|null} 错误文案；null=放行 */
function registryOriginViolation(origin) {
  const o = normalizeOrigin(origin);
  if (!isValidOrigin(o)) return '镜像源必须是 http(s) 纯 origin（无路径/查询/凭证）: ' + o;
  let u;
  try { u = new URL(o); } catch { return '镜像源无法解析: ' + o; }
  if (isPrivateHostLiteral(u.hostname)) return '镜像源主机不得为回环/私网/链路本地/保留段字面量: ' + o;
  return null;
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

/** 展开单个镜像的探测目标。契约 probe.kind='package-metadata' 时用与壳完全一致的
 *  真实包元数据 URL，无契约则退化为 `/-/ping` 兜底。实测两种方法延迟差 6.7 倍，
 *  故两侧必须用同一规格，否则会出现「面板显示一个源、实际下载用另一个」。
 *  platformTag 为 null/空（宿主不可产标或不在发布矩阵，调用方 probeRegistry
 *  已判定）时同样退化 ping —— 缺守卫会把字面量 `undefined` 拼进 pathTemplate 恒 404。 */
function resolveProbe(origin, spec, platformTag) {
  const base = normalizeOrigin(origin);
  if (spec && spec.kind === 'package-metadata' && spec.pathTemplate && platformTag) {
    return {
      url: base + '/' + spec.pathTemplate.replace('{platform}', platformTag),
      kind: spec.kind,
      timeoutMs: spec.timeoutMs || 4000,
    };
  }
  return { url: base + '/-/ping', kind: 'ping', timeoutMs: (spec && spec.timeoutMs) || 4000 };
}

/** 可达结果里选**延迟最低**者；无可达返回 null（明确失败，不缓存坏选择）。 */
function pickFastestReachable(results) {
  const reachable = results.filter((r) => r.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  return reachable.length ? reachable[0] : null;
}

/** 本机是否在灰度名单内。冻结语义是「读名单包内容 + schema===1 + installId/hostnames 匹配」；
 *  该包尚未发布（预留），故当前只认本地开关 `canary === true`。
 *  注意：不得以「名单包存在」为依据——名单包为全部候选机共用，装了就全员灰度。 */
function isInCanaryList(state) {
  return state.canary === true;
}

module.exports = {
  FALLBACK_REGISTRIES,
  normalizeOrigin,
  isValidOrigin,
  registryOriginViolation,
  effectiveOrigins,
  rebuildRegistryConfig,
  resolveProbe,
  pickFastestReachable,
  isInCanaryList,
};
