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
//
// ## SR 组：另一条入站通道 —— 壳的环境观测报告（contract/shell-report.js）
//   与启动契约同目录、同性质的文件（壳写内核读），但**永不参与 spawn**：它只回答
//   「壳最后一次看到本机 Node/npm/镜像源/前缀是什么时候、看到了什么」。
//   SR-1..2  没报过与读不出分得开（两种处置相反，说反一次就够把人引去查不存在的文件）
//   SR-3..6  schema handshake 与整份作废的边界（缺时戳/缺观察都算读不出）
//   SR-7..9  逐字段摊平、三态不折叠、入站即脱敏
//   SR-10..11 明细超限只截断并如实报数；超大文件不读进内存
//   SR-12..13 读取口永不抛；全仓只有契约模块拼这个路径
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rc = require(path.join(ROOT, 'src', 'platform', 'contract', 'runtime.js'));
const sr = require(path.join(ROOT, 'src', 'platform', 'contract', 'shell-report.js'));
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

// -- SR 组：桌面壳环境上报的接收口（壳写、内核读的文件契约，与 runtime.json 同目录但性质不同）--
//   只钉三件事：「没报过」与「读不出」分得开、三态读数不折叠、来自另一个进程的自由文本必过脱敏。
//   这里绝不做投递重试，也不许猜一份默认报告 —— 壳没报就是没报，伪装成「已经收到」会让
//   排障时读到一个本机根本没发生过的环境。
{
  const RP = path.join(SUP, 'shell-report.json');
  const NOW = () => 2000000;
  const writeReport = (obj) => fs.writeFileSync(RP, typeof obj === 'string' ? obj : JSON.stringify(obj));

  fs.rmSync(RP, { force: true });
  const none = sr.read({ now: NOW });
  check('SR-1 壳没报过要说成 never-written（它与「读不出」是两种处置：一个去看壳版本、一个去查文件）',
    none.available === false && none.reason === 'never-written' && none.path === sr.file()
      && none.at === null && none.ageMs === null && none.node === null && none.records.length === 0
      && none.droppedRecords === 0, JSON.stringify(none));
  check('SR-1 反向：available 为假时不得同时给出可读字段（半真半假的读数最难查）',
    none.writtenBy === null && none.schema === null && none.registry === null, JSON.stringify(none));

  writeReport('{ not json');
  check('SR-2 报告损坏要说成读不出而不是没写过（说反了会把故障报成这台机器的常态）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  writeReport({ schema: sr.SUPPORTED_SCHEMA + 1, at: 1999000, node: { version: 'v99.0.0' } });
  check('SR-3 schema 不符即整份作废（字段形状变了不能靠猜；与壳侧各自断言同一个数字）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');
  check('SR-6 报告 schema 版本 = 1（与壳写入侧 handshake）', sr.SUPPORTED_SCHEMA === 1, String(sr.SUPPORTED_SCHEMA));

  writeReport({ schema: 1, at: 1999000 });
  check('SR-4 只有时戳、没有任何观察的报告按读不出处理（拿空对象冒充本机实况是最难查的假账）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  writeReport({ schema: 1, node: { version: 'v22.12.0', ok: true } });
  check('SR-5 壳没写时戳即作废（年龄无从算起，标成新鲜会把三年前的报告当刚探的）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  writeReport({
    schema: 1, writtenBy: 'dsh-shell 1.2.8', at: NOW() - 1500,
    node: { path: '/n/node', binDir: '/n', version: 'v22.12.0', min: 'v22.12.0', ok: true },
    npm: { path: '/n/node', args: ['/n/node_modules/npm/bin/npm-cli.js'], version: '10.9.0', ok: true },
    prefix: { dir: '/p/npm', writable: false, why: 'EACCES' },
    registry: { best: 'http://usr:pwd@reg.internal:4873/', latencyMs: 88,
      probes: [{ url: 'https://registry.npmjs.org', ok: null, latencyMs: null }] },
    records: [{ probe: 'node --version', source: 'spawn', target: '/n/node', ms: 30, ok: true, note: 'ok' },
      { probe: 'ping', source: 'net', target: 'login.example.test', ms: 900, ok: null, note: 'ETIMEDOUT' }],
  });
  const rep = sr.read({ now: NOW });
  check('SR-7 一份正常报告逐字段摊平交出（npm 的 args 与 program 成对：只念 path 会把 node 版本念成 npm 版本）',
    rep.available === true && rep.reason === 'ok' && rep.ageMs === 1500 && rep.at === 1998500
      && rep.writtenBy === 'dsh-shell 1.2.8' && rep.node.ok === true && rep.node.min === 'v22.12.0'
      && rep.npm.args.length === 1 && rep.npm.version === '10.9.0'
      && rep.prefix.writable === false && rep.prefix.why === 'EACCES'
      && rep.records.length === 2 && rep.records[0].probe === 'node --version', JSON.stringify(rep));
  check('SR-8 反向：三态读数不得折叠（ok:null 折成 false 会把「壳判不出」显示成「壳判失败」）',
    rep.registry.probes[0].ok === null && rep.registry.probes[0].latencyMs === null
      && rep.records[1].ok === null && typeof rep.records[1].ms === 'number', JSON.stringify(rep.registry));
  check('SR-9 来自壳的自由文本在入站处就脱敏（私有镜像源常把 token 写在 URL 里，快照与界面都是泄漏面）',
    rep.registry.best === 'http://usr:***@reg.internal:4873/' && !/pwd/.test(JSON.stringify(rep)),
    JSON.stringify(rep.registry.best));

  const many = [];
  for (let i = 0; i < sr.MAX_ROWS + 3; i++) many.push({ probe: 'p' + i, ok: true });
  writeReport({ schema: 1, at: NOW() - 1, records: many });
  const cut = sr.read({ now: NOW });
  check('SR-10 明细超限只截断并把丢掉几行交出去（不撑大快照与 HTTP 响应，也不许悄悄少报）',
    cut.records.length === sr.MAX_ROWS && cut.droppedRecords === 3, JSON.stringify({ n: cut.records.length, d: cut.droppedRecords }));

  writeReport('{"schema":1,"at":1}' + 'x'.repeat(sr.MAX_BYTES));
  check('SR-11 超过字节上限即按读不出处理（那是别的进程写的东西，读侧不能假设自己看到的一定是小文件）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  fs.rmSync(RP, { force: true });
  fs.mkdirSync(RP, { recursive: true });
  const asDir = sr.read({ now: NOW });
  check('SR-12 读取口永不抛：落点成了目录也只说读不出（接收口不得成为用户可见的失败原因）',
    asDir.available === false && asDir.reason === 'unreadable-or-schema-mismatch', JSON.stringify(asDir));
  fs.rmSync(RP, { recursive: true, force: true });

  const rpReaders = [];
  for (const f of walk(path.join(ROOT, 'src'), [])) {
    if (f === path.join(ROOT, 'src', 'platform', 'contract', 'shell-report.js')) continue;
    const codeOnly = fs.readFileSync(f, 'utf8').split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('//')).join(String.fromCharCode(10));
    if (/['"]shell-report\.json['"]/.test(codeOnly)) rpReaders.push(path.relative(ROOT, f));
  }
  check('SR-13 除契约模块外无人再手拼 shell-report.json 路径（两处落点即两份「壳报在哪」）',
    rpReaders.length === 0, rpReaders.join(' | ') || '0 处');
}

process.env.HOME = savedHome; process.env.USERPROFILE = savedUp;
delete process.env.DSH_SUPERVISOR_HOME;
fs.rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
