#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 运行期启动契约（壳写、内核读）门禁
//
// ## 解决的问题
//   内核自身也要执行 npm（自更新 / 装 DSH / 插件）。旧实现用 ambient PATH 的裸 npm
//   与 process.env；GUI/服务环境的 PATH 常不含 nvm/fnm 的 npm -> 「壳能装、内核自己装不了」。
//   现统一读壳投放的 <产品状态根>/supervisor/runtime.json（schema 2）。
//
//   同一份事实曾在内核里被解析四处（分发安装 / 原生管理 / 环境探测 / 版本探测），且读取口
//   只取 npmPath 而丢掉 npmArgs —— 「node + 包内 npm-cli.js」被降级成裸跑 node。
//   本门禁把「唯一解析口 + 成对消费」钉住。
//
// ## 锁定不变量
//   R-1  read() 解析 schema2（含嵌套 node{}/npm{}）与兼容 schema1；缺失/损坏返回 null（绝不抛）
//   R-2  npmLauncher() 返回启动形态对 { program, args, version, source }；契约优先，
//        契约缺席/指向不存在的文件才退回平台解析
//   R-3  withPath() 把 nodeBinDir 置于 PATH 首位（分隔符跨平台）
//   R-4  消费点接入：分发安装 / 原生管理 / env-catalog 一律经 npmLauncher 且 program 与 args 同源
//   R-5  反向：无契约时退回 ambient（不空转）
//   R-6  契约 schema 版本与壳 handshake
//   R-7  单一解析口：src 内除 os/exec-path.js 与 contract/runtime.js 外不得直呼 npmBin()
//   R-8  版本号不得编造：契约未回读 npm 版本时 launcher.version 必须为 null（不是 node 的版本）
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rc = require(path.join(ROOT, 'src', 'platform', 'contract', 'runtime.js'));
const execPath = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
// 产品状态根隔离（独立于 DSH）：runtime.json 落在 <DSH_SUPERVISOR_HOME>/supervisor。
process.env.DSH_SUPERVISOR_HOME = TMP;
const SUP = path.join(TMP, 'supervisor');
fs.mkdirSync(SUP, { recursive: true });
const writeContract = (obj) => fs.writeFileSync(path.join(SUP, 'runtime.json'), JSON.stringify(obj, null, 2));
const NODE_DIR = path.join(TMP, 'nodebin');
fs.mkdirSync(NODE_DIR, { recursive: true });
const NODE = path.join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
const NPM = path.join(NODE_DIR, process.platform === 'win32' ? 'npm.cmd' : 'npm');
const NPM_CLI = path.join(NODE_DIR, 'npm-cli.js');
fs.writeFileSync(NODE, '#!/bin/sh\n');
fs.writeFileSync(NPM, '#!/bin/sh\n');
fs.writeFileSync(NPM_CLI, '\n');

const savedHome = process.env.HOME; const savedUp = process.env.USERPROFILE;
process.env.HOME = TMP; process.env.USERPROFILE = TMP;

// -- R-5 反向：无契约 -> null + 退回平台解析（不空转）--
check('R-5 无契约时 read()=null', rc.read() === null);
{
  const l = rc.npmLauncher();
  check('R-5 无契约时 npmLauncher 退回平台解析口',
    l.source === 'path' && l.program === execPath.npmBin() && Array.isArray(l.args) && l.args.length === 0,
    JSON.stringify(l));
}

// -- schema 2（壳实投形状：扁平键 + 嵌套 node{}/npm{} 双写）--
writeContract({
  schema: 2, writtenBy: 'test',
  nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR,
  npmPath: NODE, npmArgs: [NPM_CLI],
  node: { path: NODE, binDir: NODE_DIR, version: 'v22.12.0' },
  npm: { path: NODE, args: [NPM_CLI], version: '10.9.2' },
  minNode: 'v22.12.0',
});
{
  const c2 = rc.read();
  check('R-1 schema2 解析出 node/npm/binDir', !!(c2 && c2.nodePath === NODE && c2.npmPath === NODE && c2.nodeBinDir === NODE_DIR), JSON.stringify(c2 && { n: c2.nodePath, m: c2.npmPath }));
  check('R-1 read() 带出 npmArgs 与 npmVersion', !!(c2 && c2.npmArgs[0] === NPM_CLI && c2.npmVersion === '10.9.2'), JSON.stringify(c2 && { a: c2.npmArgs, v: c2.npmVersion }));
  check('R-1 read() 带出 nodeVersion（面板 node.runtime 念它）', c2 && c2.nodeVersion === 'v22.12.0', JSON.stringify(c2 && c2.nodeVersion));
  const l = rc.npmLauncher();
  check('R-2 契约在场时 source=contract', l.source === 'contract', l.source);
  check('R-2 program 取契约绝对路径', l.program === NODE, l.program);
  // 缺陷本体：只取 program 会把「node 跑 npm-cli.js」降级成裸跑 node。args 非空即证明拆读必然失真。
  check('R-2 args 与 program 成对（缺一半即失真）', l.args.length === 1 && l.args[0] === NPM_CLI, JSON.stringify(l.args));
  check('R-8 version 取壳实跑回读的 npm 版本（不是 node 版本）',
    l.version === '10.9.2' && c2.nodeVersion === 'v22.12.0' && l.version !== c2.nodeVersion, String(l.version));
}
const env = rc.withPath({ PATH: '/ambient/bin' });
check('R-3 withPath 把 nodeBinDir 置于首位', env.PATH.indexOf(NODE_DIR) === 0, env.PATH);
check('R-3 保留 ambient PATH', env.PATH.indexOf('/ambient/bin') > 0, env.PATH);

// -- 契约指向不存在的文件：退回平台解析，不拿悬空路径去 spawn --
writeContract({ schema: 2, npmPath: path.join(TMP, 'gone', 'npm'), npmArgs: [], nodePath: NODE, minNode: 'v22.12.0' });
{
  const l = rc.npmLauncher();
  check('R-2 契约路径不存在时退回平台解析（source=path）',
    l.source === 'path' && l.program === execPath.npmBin(), JSON.stringify(l));
}

// -- 旧壳（schema2 但无 npm.version）：版本必须为 null，不得拿 node 版本顶上 --
writeContract({ schema: 2, nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR, npmPath: NPM, minNode: 'v22.12.0' });
{
  const l = rc.npmLauncher();
  check('R-8 壳未回读 npm 版本时 version=null（不编造）', l.version === null, String(l.version));
  check('R-2 扁平旧键仍解析出绝对 npm 与空 args', l.program === NPM && l.args.length === 0, JSON.stringify(l));
  check('R-1 只写扁平旧键时也解析出 nodeVersion', rc.read().nodeVersion === 'v22.12.0', String(rc.read().nodeVersion));
}

// -- 只写嵌套 node{}/npm{} 的壳：两形都必须认，漏一侧面板就把运行时念成 null --
writeContract({
  schema: 2,
  node: { path: NODE, binDir: NODE_DIR, version: 'v22.12.0' },
  npm: { path: NODE, args: [NPM_CLI], version: '10.9.2' },
});
{
  const c = rc.read();
  check('R-1 纯嵌套形状解析出 nodePath/nodeVersion/nodeBinDir',
    !!(c && c.nodePath === NODE && c.nodeVersion === 'v22.12.0' && c.nodeBinDir === NODE_DIR),
    JSON.stringify(c && { p: c.nodePath, v: c.nodeVersion, b: c.nodeBinDir }));
  const ln = rc.npmLauncher();
  check('R-1 纯嵌套形状解析出 npm 启动形态',
    ln.source === 'contract' && ln.args[0] === NPM_CLI && ln.version === '10.9.2', JSON.stringify(ln));
}

// -- schema 1 兼容（只有顶层旧键）--
writeContract({ schema: 1, nodePath: NODE, nodeVersion: 'v22.12.0', minNode: 'v22.12.0' });
{
  const c1 = rc.read();
  check('R-1 schema1 兼容（binDir 由 nodePath 推导前仍可读 minNode）', !!(c1 && c1.minNode === 'v22.12.0' && c1.nodePath === NODE), JSON.stringify(c1));
  const l = rc.npmLauncher();
  check('R-1 schema1 无 npm 键时退回平台解析且版本为 null',
    l.source === 'path' && l.version === null, JSON.stringify(l));
}

// -- 损坏 JSON -> null（不抛）--
fs.writeFileSync(path.join(SUP, 'runtime.json'), '{ bad json', 'utf8');
check('R-1 损坏 JSON -> null（不抛）', rc.read() === null);

// -- R-6 契约版本握手：本侧 schema 常量必须与壳写入的 schema 一致（各自断言，不跨仓读源码）--
check('R-6 契约 schema 版本 = 2（与壳 handshake）', rc.SUPPORTED_SCHEMA === 2, String(rc.SUPPORTED_SCHEMA));
// 半个事实的旧 API 不得复活：只返回 program 的 npmBin() 已删，唯一出口是 npmLauncher()。
check('R-7 旧的单值 npmBin() 不再从契约模块导出', typeof rc.npmBin === 'undefined', typeof rc.npmBin);

// -- R-4 / R-7 / R-8 静态判据 --
// 判据写成纯函数：真实文件与合成旧形状走同一把尺（否则判据只能证明「现在恰好对」）。
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
/** 直呼 npmBin() 的行（注释不算）：解析层与唯一解析口之外即违规。 */
function npmBinCalls(src) {
  const hits = [];
  const lines = String(src).split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) continue;
    if (/\bnpmBin\s*\(/.test(s)) hits.push((i + 1) + ': ' + s.slice(0, 60));
  }
  return hits;
}
const ALLOWED_CALLERS = [
  path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'),      // 解析层本体（定义处）
  path.join(ROOT, 'src', 'platform', 'contract', 'runtime.js'),  // 唯一解析口的实现
];
{
  const offenders = [];
  for (const f of walk(path.join(ROOT, 'src'), [])) {
    if (ALLOWED_CALLERS.includes(f)) continue;
    for (const h of npmBinCalls(fs.readFileSync(f, 'utf8'))) offenders.push(path.relative(ROOT, f) + ' ' + h);
  }
  check('R-7 src 内 npmBin() 只出现在解析层与唯一解析口', offenders.length === 0, offenders.join(' | ') || '0 处');
  // 反向：旧形状（原生管理直呼 execPath.npmBin()）必须被同一把尺抓到
  const oldShape = "const execPath = require('../../platform/os/exec-path');\nfunction npmExe(host) { return host._npmBin || execPath.npmBin(); }";
  check('R-7 反向：判据能识别「各自解析」的旧形状', npmBinCalls(oldShape).length === 1, JSON.stringify(npmBinCalls(oldShape)));
  check('R-7 反向：注释里的提及不算调用（否则门禁自我阻塞）',
    npmBinCalls('// 曾直呼 execPath.npmBin() 于四处').length === 0, '0 处');
}

// 消费点接入（按目录聚合读取：文件搬移不得静默失去覆盖面）。
const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
check('R-4 分发安装经 npmLauncher 取启动形态', /runtimeContract\.npmLauncher\(\)/.test(dist), 'ok');
check('R-4 分发安装把契约 args 前插进 argv（不是只取 program）',
  /launcher\.args/.test(dist) && /\[\.\.\.launcher\.args, action, '-g'\]/.test(dist), 'ok');
check('R-4 分发安装仍用契约注入 PATH', /runtimeContract\.withPath\(/.test(dist), 'ok');
const natSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'native', 'npm.js'), 'utf8');
check('R-4 原生管理经 npmLauncher（不再各自解析）',
  /runtimeContract\.npmLauncher\(\)/.test(natSrc) && !/execPath\.npmBin\(/.test(natSrc), 'ok');
check('R-4 原生管理的 program/args 同源于一次解析',
  /const l = npmLaunch\(host\);[\s\S]{0,160}?l\.program[\s\S]{0,120}?l\.args\.concat\(/.test(natSrc), 'ok');
check('R-4 反向：拆开两次 npmLaunch() 取 program/args 会被判据拒',
  !/const l = npmLaunch\(host\);[\s\S]{0,160}?l\.program[\s\S]{0,120}?l\.args\.concat\(/.test(
    'const a = npmLaunch(host).program; const b = npmLaunch(host).args.concat(["--version"]);'), '已拒');
const ec = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'env-catalog.js'), 'utf8');
check('R-4 env-catalog 用契约读 minNode',
  /require\(\s*['"][^'"]*contract\/runtime['"]\s*\)/.test(ec) || /contract\/runtime/.test(ec), 'ok');
check('R-4 env-catalog 的 npm 探测经唯一解析口且带上 args',
  /runtime\.npmLauncher\(\)/.test(ec) && /cachedWhichVersion\([a-z]+\.program, [a-z]+\.args\)/.test(ec), 'ok');
check('R-4 反向：只传 program 的版本探测会把 node 版本念成 npm 版本',
  !/cachedWhichVersion\([a-z]+\.program, [a-z]+\.args\)/.test('cachedWhichVersion(l.program);'), '已拒');

// 契约读取口唯一：内核不得再手写 runtime.json 路径（两处读取 = 两份落点口径）。
{
  const readers = [];
  for (const f of walk(path.join(ROOT, 'src'), [])) {
    if (f === path.join(ROOT, 'src', 'platform', 'contract', 'runtime.js')) continue;
    const src = fs.readFileSync(f, 'utf8');
    const codeOnly = src.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
    if (/['"]runtime\.json['"]/.test(codeOnly)) readers.push(path.relative(ROOT, f));
  }
  check('R-4 除契约模块外无人再手拼 runtime.json 路径', readers.length === 0, readers.join(' | ') || '0 处');
}

process.env.HOME = savedHome; process.env.USERPROFILE = savedUp;
delete process.env.DSH_SUPERVISOR_HOME;
fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
