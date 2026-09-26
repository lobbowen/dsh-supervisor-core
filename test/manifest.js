#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 测试分层登记表 —— 门禁清单的唯一事实源（取代 scripts.test 里的 && 巨链）
//
// ## 为什么换形态
//   scripts.test 原为「每个测试文件一段 `node -r ./test/_preload.js <file>`」用 && 串成的
//   单条命令，实测长度已逼近 Windows cmd.exe 的 8191 命令行上限（旧判据 N-e 把它钉成硬约束，
//   现为 C-f）。后果是任何人新增测试都要先挤掉一个旧条目 —— 门禁反过来锁住了开发。
//   登记表把入册成本从「挤字符余量」降为「加一行」。真实条数只由
//   test/test-chain-completeness-test.js 每次实跑打印，本文件不复制数字（C-j）。
//
// ## 分层语义（跨平台交付的底线）
//   L1 平台无关：纯逻辑 / 契约 / 结构门禁。判一次就够，在四个 runner 上重复跑
//      不产生任何额外的跨平台证据（旧产线每个矩阵腿都重跑全链，即此浪费）。
//   L2 依赖真实宿主 OS：真的 spawn 进程、跑 bash / pkill / systemctl、读 /proc、
//      断言文件权限位。这类必须在 os 列出的每个宿主上真跑；宿主不在 os 内时它只能
//      SKIP，而 SKIP 不等于通过 —— 由 runner 汇总、chain-completeness 执法。
//
// 已知边界（诚实登记，勿当作已执法）：C-h 只执法「标 os=all 却把 POSIX 命令喂进判定」这一
//   方向。反方向（L1 里混入真实宿主依赖）靠静态扫无法与「命令文本当解析输入」区分，
//   故按条目人工判定；改动测试形态时若引入真宿主调用，必须同步把该条改标 L2。
//
// 新增测试只需在本表加一行；判据见 test/test-chain-completeness-test.js。
// ---------------------------------------------------------------------------

/** 条目字段：file / tier(L1|L2) / os("all" | 逗号分隔的 linux,darwin,win32) / why */
const ENTRIES = [
  { file: "test/test-safety-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/test-port-discipline-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/workflow-parse-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/core-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/relay-dshauth-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/task-registry-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/managed-registry-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/heartbeat-selfheal-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/smoke.js", tier: "L2", os: "all", why: "起真 daemon 子进程 + 端口轮询" },
  { file: "test/upgrade-test.js", tier: "L2", os: "all", why: "真起 daemon 走升级回滚" },
  { file: "test/capability-profile-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/governor-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/frp-platform-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/instance-state-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/ports-claim-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/ports-migrate-test.js", tier: "L2", os: "linux,darwin", why: "chmod 语义按 POSIX 断言" },
  { file: "test/ports-verify.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/precheck-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/router-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/router-e2e-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/p2p-router-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/p2p-api-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/ensure-instance-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/reconcile-instance-test.js", tier: "L2", os: "all", why: "10 次子进程 spawn + SIGKILL" },
  { file: "test/commandcode-quota-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/upstream-credits-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/freeze-recovery-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/main-port-rederive-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/adopt-token-reclaim-test.js", tier: "L2", os: "linux,darwin", why: "pkill/pgrep 属主判定" },
  { file: "test/router-ctl-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/lifecycle-mirror-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/daemon-lifecycle-test.js", tier: "L2", os: "linux,darwin", why: "pgrep 残留自检" },
  { file: "test/lan-daemon-test.js", tier: "L2", os: "all", why: "detached 真守护 + 退出码" },
  { file: "test/token-boundary-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/loghub-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/api-fuzz-test.js", tier: "L2", os: "linux,darwin", why: "pkill 清理 spawn 出的 daemon" },
  { file: "test/monthly-credits-freeze-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/ports-capacity-test.js", tier: "L2", os: "linux", why: "读 /proc 判 ephemeral 重叠" },
  { file: "test/session-lifecycle-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/sigterm-desired-test.js", tier: "L2", os: "linux,darwin", why: "pkill + SIGTERM 真进程" },
  { file: "test/managed-lifecycle-failure-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-lifecycle-stop-phase-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/shadow-decision-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/phase-vocabulary-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/npm-resolution-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/uninstall-timeout-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/uninstall-timeout-behavior-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/lan-access-boundary-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/process-tree-kill-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/arch-validation-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/escape-validation-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/relay-source-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/router-circuit-breaker-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/ui-gate-wiring-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/probe-gate-and-ownership-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/reconcile-single-flight-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/graceful-shutdown-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/platform-audit-fixes-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round8-fixes-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/native-op-mutex-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/instance-safety-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/instance-systemd-aside-behavior-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-discipline-gaps-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-router-relay-gaps-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-dropped-result-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-contract-reload-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-robustness-batch-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-node-lts-contract-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-csp-probe-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/round13-ports-release-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/watchdog-phase-freshness-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/market-budget-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/lifecycle-restart-failure-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/daemon-path-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/app-ctor-injection-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/exec-bounded-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/exec-return-contract-test.js", tier: "L2", os: "linux", why: "真跑 node/systemctl 子进程" },
  { file: "test/defects-batch-f-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/srcpath-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/version-vectors-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/release-channel-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/platform-capability-audit-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/cross-platform-test.js", tier: "L2", os: "all", why: "carrier 真子进程 E2E" },
  { file: "test/api-surface-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/instance-upgrade-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/frp-resilience-test.js", tier: "L2", os: "linux,darwin", why: "sh 假 frpc 脚本重启退避" },
  { file: "test/round13-frpc-integrity-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/release-auth-test.js", tier: "L2", os: "linux,darwin", why: "bash 跑发布脚本断言退出码" },
  { file: "test/glibc-gate-test.js", tier: "L2", os: "linux", why: "bash 跑 ci/check-glibc.sh" },
  { file: "test/autostart-ownership-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/shell-watchdog-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/shell-watchdog-e2e-test.js", tier: "L2", os: "all", why: "真 start() 拉起假壳进程" },
  { file: "test/shell-safety-net-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/all-platforms-test.js", tier: "L2", os: "linux,darwin", why: "bash 跑 _platforms.sh" },
  { file: "test/platform-matrix-single-source-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/shell-portability-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/standards-uniqueness-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/release-spec-consistency-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/destructive-op-safety-test.js", tier: "L2", os: "linux,darwin", why: "chmod/字节哈希在真 FS 上" },
  { file: "test/credential-hygiene-test.js", tier: "L2", os: "linux,darwin", why: "cred.sh 子进程 + 0700 位" },
  { file: "test/layering-and-dependency-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/platform-parsers-and-commands-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/platform-layer-portability-test.js", tier: "L2", os: "all", why: "真 listen/spawn 的服务与自启层" },
  { file: "test/four-platform-behavior-matrix-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/cross-platform-architecture-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/test-chain-completeness-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/api-contract-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/plugin-change-restart-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/package-root-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/no-cross-repo-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/no-dev-path-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/runtime-contract-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/kernel-update-single-writer-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/kernel-daemon-contract-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/state-root-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/native-dsh-binding-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/no-console-window-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/token-contract-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/dev-runtime-safety-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/release-channel-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/install-id-test.js", tier: "L2", os: "linux,darwin", why: "node -e 子进程 + POSIX 权限位" },
  { file: "test/guard-domain-model-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/provider-gateway-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/directory-structure-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/domain-structure-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/switch-policies-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/acceptance-standard-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/docs-reference-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/comment-pin-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/app-this-ratchet-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
  { file: "test/install-smoke-gate-test.js", tier: "L1", os: "all", why: "平台无关判据（不依赖真实宿主行为）" },
];

const ALL_OS = ['linux', 'darwin', 'win32'];

/** 历史遗留：不带 -test 后缀但按测试登记的两个门禁（不改名，避免大范围改动）。 */
const IN_CHAIN_LEGACY = ['smoke.js', 'ports-verify.js'];

function osSet(entry) {
  return entry.os === 'all' ? ALL_OS.slice() : entry.os.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 链条目（登记表全量，保持登记顺序；按宿主筛由 select 负责）。 */
function chain() {
  return ENTRIES.map((e) => e.file);
}

/** 按 tier / 宿主筛选要跑的条目。tier='all' 取全量且不按宿主过滤：平台不适用的条目
 *   由测试自己打 SKIP（诚实可见），静默不跑会把「没验过」伪装成「通过」。 */
function select(tier, platform) {
  const pl = platform || process.platform;
  if (tier === 'all') return ENTRIES.slice();
  return ENTRIES.filter((e) => e.tier === tier && osSet(e).indexOf(pl) >= 0);
}

/** 本宿主应跑但表里标了别的 OS 的 L2 条目 = 该平台缺口（供 SKIP 台账与门禁读）。 */
function gaps(platform) {
  const pl = platform || process.platform;
  if (ALL_OS.indexOf(pl) < 0) return [];
  return ENTRIES.filter((e) => e.tier === 'L2' && osSet(e).indexOf(pl) < 0).map((e) => e.file);
}

module.exports = { ENTRIES, IN_CHAIN_LEGACY, chain, select, gaps, osSet, ALL_OS };
