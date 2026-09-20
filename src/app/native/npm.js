'use strict';

// 域：原生 DSH（app/native）—— npm 调用（IO：exec / spawn 经 platform 统一封装）。
// npm 的启动形态经 host._npmBin/_npmBinArgs 构造期注入，未注入时统一取运行期契约。

const ex = require('../../platform/util/exec');
const runtimeContract = require('../../platform/contract/runtime');

/**
 * npm 启动形态 `{ program, args }`（成对取值，绝不拆用）。
 *
 * 为什么成对：契约可能是「node + 包内 npm-cli.js」，只取 program 会把它降级成裸跑 node；
 *   反之只取 args 会把参数塞给别的解释器。旧实现这里 program 走 ambient PATH、args 恒空，
 *   于是 GUI 环境（PATH 里没有 nvm/fnm 的 npm）下「装 DSH / 卸载 / 探测 root」全失败，
 *   而同一时刻分发层用的是契约解析结果 —— 两个答案、一个事实。
 * 为什么注入即接管整对：测试注入 fake npm 时通常是「node 跑一段假脚本」，
 *   此时继承契约的前缀参数会让假解释器去跑真 npm-cli.js（真实副作用）。
 */
function npmLaunch(host) {
  const h = host || {};
  if (h._npmBin) {
    return { program: h._npmBin, args: Array.isArray(h._npmBinArgs) ? h._npmBinArgs.slice() : [] };
  }
  const l = runtimeContract.npmLauncher();
  return { program: l.program, args: l.args };
}

/** 优先注入值（测试）。 */
function resolveNpmRoot(host) {
  if (host.npmRoot) return host.npmRoot;
  const l = npmLaunch(host);
  const r = ex.runOut(l.program, l.args.concat(['root', '-g']));
  return r ? r.trim() : null;
}

function checkEnvironment(host) {
  const errors = [];
  const nv = ex.runOut('node', ['--version']);
  if (!nv || !nv.trim()) errors.push('node 未安装或不可执行');
  const l = npmLaunch(host);
  const npmv = ex.runOut(l.program, l.args.concat(['--version']));
  if (!npmv || !npmv.trim()) errors.push('npm 未安装或不可执行');
  return { ok: errors.length === 0, errors, npmRoot: resolveNpmRoot(host) };
}

/** 最新版本（统一分发通道；packageName 是第三方包语义——latest 优先，缺失/非法才回落
 *  versions 最高。契约 第三方段落，条 7 改判，勿再写「全量最高」。 */
async function latestVersion(host) {
  if (!host.dist || !host.config.packageName) throw new Error('分发服务未初始化，无法查询最新版本');
  const channel = host.config.releaseChannel || 'npm';
  return host.dist.fetchLatestVersion(host.config.packageName, channel);
}

/** 选最快可达镜像（网络环境自适应）。 */
async function selectRegistry(host) {
  if (!host.dist) return null;
  try { return await host.dist.selectRegistry(true); } catch { return null; }
}

/** 安装执行（唯一入口 = dist.runNpmInstall）；行日志回写升级日志 +（安装中）安装日志。 */
function runInstall(host, version, registry) {
  if (!host.dist) return Promise.resolve({ ok: false, error: 'dist 分发服务不可用，无法安装', output: [] });
  const pkg = host.config.packageName || '@deepseek-ai/dsh';
  const tpl = host.config.installCommandTemplate;
  return host.dist.runNpmInstall({
    pkg,
    version,
    registry,
    commandTemplate: Array.isArray(tpl) && tpl.length ? tpl : null,
    timeoutMs: host.config.upgradeTimeoutMs || 600000,
    onLine: (l) => {
      host._appendUpgradeLog(l);
      if (host.installing) host._appendInstallLog(l);
    },
  });
}

module.exports = { npmLaunch, resolveNpmRoot, checkEnvironment, latestVersion, selectRegistry, runInstall };
