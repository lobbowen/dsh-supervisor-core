'use strict';

const stateRoot = require('../service/state-root');

// 运行期启动契约读取器（壳写、内核读），与壳 src-tauri/src/runtime_contract.rs 成对。
// 契约文件：<产品状态根>/supervisor/runtime.json（schema 2）。
// 内核自身也要执行 npm（自更新/装 DSH/插件），而 GUI 或服务环境 PATH 常缺 nvm/fnm 的 npm；
// 壳在供给层解析一次并投放，内核消费产物，避免壳能装而内核装不了的分叉。
// 不变量 C2：契约不可用时返回 null 或退回调用方的 ambient 解析，绝不因此启动失败。

const fs = require('node:fs');
const path = require('node:path');
const execPath = require('../os/exec-path');

const SUPPORTED_SCHEMA = 2;

function file() {
  return path.join(stateRoot.supervisorDir(), 'runtime.json');
}

/** 读取契约；缺失/损坏返回 null。兼容 schema 1（仅 nodePath/nodeVersion/minNode）。 */
function read() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const node = (j.node && typeof j.node === 'object') ? j.node : {};
  const npm = (j.npm && typeof j.npm === 'object') ? j.npm : {};
  return {
    schema: Number(j.schema) || 1,
    nodePath: j.nodePath || node.path || null,
    nodeVersion: j.nodeVersion || node.version || null,
    nodeBinDir: j.nodeBinDir || node.binDir || null,
    npmPath: j.npmPath || npm.path || null,
    // 外壳可只提供包内 JS（npmPath=node，npmArgs=[npm-cli.js]），消费者必须带上 args。
    npmArgs: Array.isArray(j.npmArgs) ? j.npmArgs : (Array.isArray(npm.args) ? npm.args : []),
    // npm 版本由壳**真实执行** npm --version 得到；旧壳没有这个键时为 null（未知就是未知）。
    npmVersion: (typeof npm.version === 'string' && npm.version) || null,
    minNode: j.minNode || null,
    writtenBy: j.writtenBy || null,
    // 安装留痕（面板 /env/status 的 source/installedAt 直接念这两把）：属壳的供给事实，
    // 内核只转述不推导。
    source: j.source || null,
    installedAt: j.installedAt || null,
    raw: j,
  };
}

/**
 * npm 的**启动形态**（唯一解析口）：`{ program, args, version, source }`。
 *
 * 为什么程序与参数必须成对返回：官方分发包只带包内 JS 时，契约里 `program` 就是 node 本体、
 *   `args=[npm-cli.js]`。只取 program 会把「用 node 跑 npm-cli.js」降级成「裸跑 node」，
 *   每次调用都留下一条含糊的失败 —— 半个事实比没有事实更难查。
 * 为什么这里是唯一口：内核曾有四处各自解析（分发安装 / 环境探测 / 原生卸载 / 版本探测），
 *   于是「壳能装、内核装不了」和「面板说就绪、实机跑不通」都能成立。
 * 契约缺席或指向不存在的文件时退回 `os/exec-path.npmBin()`（Windows 走 PATHEXT，绝不说裸 npm）。
 *
 * @param {{platform?:string,env?:object}} [opts] 透传给 exec-path，便于纯函数级跨平台测试
 * @returns {{program:string,args:string[],version:string|null,source:'contract'|'path'}}
 */
function npmLauncher(opts) {
  const c = read();
  if (c && c.npmPath) {
    let exists = false;
    try { exists = fs.existsSync(c.npmPath); } catch {}
    if (exists) return { program: c.npmPath, args: c.npmArgs.map(String), version: c.npmVersion, source: 'contract' };
  }
  return { program: execPath.npmBin(opts), args: [], version: null, source: 'path' };
}

/** 在给定 env 上注入契约 PATH（nodeBinDir 置于首位）；无契约时原样返回副本。 */
function withPath(env) {
  const e = Object.assign({}, env || {});
  const c = read();
  if (c && c.nodeBinDir) {
    const cur = e.PATH || e.Path || '';
    e.PATH = c.nodeBinDir + path.delimiter + cur;
  }
  return e;
}

// file() 必须导出：测试需要把契约写到 read() 实际读取的那个路径（SSOT 在此，测试不得重推导）。
// 曾按「仅 read() 内部使用」删除，CI  以 rc.file is not a function 检出（test 消费漏检）。
module.exports = { SUPPORTED_SCHEMA, file, read, npmLauncher, withPath };
