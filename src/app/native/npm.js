'use strict';

// 域：原生 DSH（app/native）—— npm 调用（IO：exec / spawn 经 platform 统一封装）。
// npm 的启动形态经 host._npmBin/_npmBinArgs 构造期注入，未注入时统一取运行期契约。

const ex = require('../../platform/util/exec');
const runtimeContract = require('../../platform/contract/runtime');

/** npm 启动形态 `{ program, args }`：必须成对取值、同源一次解析，绝不拆用。
 *  契约可能是「node + 包内 npm-cli.js」——只取 program 会降级成裸跑 node，只取 args 会把参数塞给别的解释器；
 *  program 走 ambient PATH 在 GUI 环境（PATH 里没有 nvm/fnm 的 npm）下安装/卸载/探测 root 全失败。
 *  注入即接管整对：测试注入 fake npm 时不继承契约前缀参数，否则假解释器会去跑真 npm-cli.js（真实副作用）。 */
function npmLaunch(host) {
  const h = host || {};
  if (h._npmBin) {
    return { program: h._npmBin, args: Array.isArray(h._npmBinArgs) ? h._npmBinArgs.slice() : [] };
  }
  const l = runtimeContract.npmLauncher();
  return { program: l.program, args: l.args };
}

/** 优先注入值（测试）。 */
/** npm 全局根（异步：HTTP/安装路径都在事件循环上，同步 root -g 最长冻结 15s）。 */
async function resolveNpmRoot(host) {
  if (host.npmRoot) return host.npmRoot;
  const l = npmLaunch(host);
  const r = await ex.runOutAsync(l.program, l.args.concat(['root', '-g']));
  return r ? r.trim() : null;
}

/** 环境检查（异步并行探测）：三个子进程各自有界、互不串行叠加。 */
async function checkEnvironment(host) {
  const errors = [];
  const l = npmLaunch(host);
  const [nv, npmv, npmRoot] = await Promise.all([
    ex.runOutAsync('node', ['--version']),
    ex.runOutAsync(l.program, l.args.concat(['--version'])),
    resolveNpmRoot(host),
  ]);
  if (!nv || !nv.trim()) errors.push('node 未安装或不可执行');
  if (!npmv || !npmv.trim()) errors.push('npm 未安装或不可执行');
  return { ok: errors.length === 0, errors, npmRoot };
}

/** 最新版本（统一分发通道）。第三方包语义：latest 通道优先，缺失/非法才回落 versions
 *  最高——由 dist.fetchLatestVersion 保证，调用侧勿自行取 versions 最高。 */
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
