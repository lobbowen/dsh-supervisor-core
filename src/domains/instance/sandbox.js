'use strict';

const platform = require('../../platform/os/index');

// 沙箱布局：沙箱根/数据/依赖目录推导、启动命令、systemd 属性与 env 装配、平台能力判决。
// 纯函数，rootDir 由组装根绑定后显式传入（无状态、无隐式 this）；能力判决只查 platform/os
// 的缓存能力矩阵（负结果 60s TTL），不直接 spawn。

const path = require('node:path');

/** 沙箱实例的独立根目录（其下 依赖目录 install/ + 数据目录 data/ + 临时目录 tmp/）。 */
function root(rootDir, inst) { return path.join(rootDir, inst.id); }
/** 该实例独立数据目录（作为实例运行的 HOME/XDG_CONFIG_HOME，内置独立 .dsh 等）。 */
function dataDir(rootDir, inst) { return path.join(root(rootDir, inst), 'data'); }
/** 该实例独立依赖目录（完整 DSH 安装处，node_modules 与原生隔离）。 */
function installDir(rootDir, inst) { return path.join(root(rootDir, inst), 'install'); }
/** 依赖子树 node_modules 的落点：npm -g --prefix 布局分平台——POSIX=<prefix>/lib/node_modules，
 *  win32=<prefix>/node_modules（无 lib/ 一层）。硬编码 POSIX 形在 Windows 必失配。 */
function nodeModulesDir(rootDir, inst) {
  const install = installDir(rootDir, inst);
  return platform.isWindows ? path.join(install, 'node_modules') : path.join(install, 'lib', 'node_modules');
}
/** 该实例沙箱内的 DSH 入口文件（node 直启 lib/bin.js，不经 win32 的 .cmd 垫片）。 */
function dshEntry(rootDir, inst) {
  return path.join(nodeModulesDir(rootDir, inst), '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
/** 沙箱实例独立临时目录：TMPDIR 是 PrivateTmp 的三平台一致泛化（win/mac 无命名空间可借）。 */
function tmpDir(rootDir, inst) { return path.join(root(rootDir, inst), 'tmp'); }

/** 沙箱实例的启动命令：用「官方 npm install -g --prefix」装进该沙箱 install 目录的 DSH。 */
function sandboxCommand(rootDir, inst) {
  const bin = dshEntry(rootDir, inst);
  return [process.execPath, bin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}

/** 未配 command 时的默认启动命令：<node> <dshBin> web --port <port>。 */
function defaultCommand(dshBin, inst) {
  return [process.execPath, dshBin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}

/** 有效启动命令：沙箱用实例独立安装；用户显式配置优先；否则回退默认宿主命令。 */
function effectiveCommand(rootDir, dshBin, inst) {
  if (inst.domain === 'sandbox' && (!inst.command || !inst.command.length)) return sandboxCommand(rootDir, inst);
  if (inst.command && inst.command.length) return inst.command;
  return defaultCommand(dshBin, inst);
}

/** systemd transient 单元属性（业务约束以「属性」表达，域层不拼 systemd 参数）。
 *  alloc（MemoryMax/MemoryHigh/CPUQuota 值）由 governor 按机器预算与活跃实例数推导——用户填额已废止，
 *  静态数字既会超卖也闲置；平台只翻译语义，不决定数额。
 *  MemoryHigh 是真内核节流软顶（回收先于 OOM），仅在 governor 推导出时下发。 */
function unitProps(inst, alloc) {
  const props = [
    'KillMode=process',
    'MemoryMax=' + alloc.memoryMax,
  ];
  if (alloc.memoryHigh) props.push('MemoryHigh=' + alloc.memoryHigh);
  props.push(
    'CPUQuota=' + alloc.cpuQuota,
    'PrivateTmp=' + ((inst.sandbox && inst.sandbox.privateTmp) ? 'yes' : 'no'),
    'ProtectHome=' + ((inst.sandbox && inst.sandbox.protectHome) ? 'yes' : 'no'),
    'Restart=no',
  );
  return props;
}

/** 沙箱实例的环境与工作目录装配（native 无 env）。PATH 连接符用 path.delimiter（跨平台）。 */
function sandboxEnv(rootDir, inst) {
  const env = {};
  let workingDir = null;
  if (inst.domain === 'sandbox') {
    const data = dataDir(rootDir, inst);
    const install = installDir(rootDir, inst);
    const nodeBinDir = path.dirname(process.execPath);
    const paths = [nodeBinDir, path.join(inst, 'bin'), process.env.PATH || ''].join(path.delimiter);
    env.HOME = data;
    env.XDG_CONFIG_HOME = data;
    env.XDG_DATA_HOME = data;
    env.PATH = paths;
    env.NODE_PATH = nodeModulesDir(rootDir, inst);
    // 临时目录隔离三平台一致：POSIX 用 TMPDIR，win32 只认 TMP/TEMP（PrivateTmp 是 Linux 独有加法）。
    env.TMPDIR = tmpDir(rootDir, inst);
    if (platform.isWindows) { env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR; }
    workingDir = data;
  }
  return { env, workingDir };
}

/** 平台能力判决（**实时**求值）：本平台是否支持沙箱实例（判据 = capabilities.sandboxLaunch，
 *  当前实现即 Linux + systemd-run；执行档位另看 sandboxEnforcement）。
 *  override 非空则显式覆写（仅供测试/嵌入方）；否则实时问 platform/os/index.capabilities()，
 *  后者对工具负结果有 60s TTL，不会每次都 spawn 探测进程。 */
function supported(override) {
  if (override !== undefined && override !== null) return override === true;
  try {
    const caps = platform.capabilities();
    return !!(caps && caps.sandboxLaunch === true);
  } catch { return false; }
}

module.exports = {
  root, dataDir, installDir, nodeModulesDir, dshEntry, tmpDir,
  effectiveCommand, unitProps, sandboxEnv, supported,
};
