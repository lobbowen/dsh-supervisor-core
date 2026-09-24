#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// P1-C：npm 必须经**统一解析入口**，不得硬编码裸 'npm'
//
// ## 缺陷
//
// Windows 上 npm 的实际可执行是 `npm.cmd`；Node 的 `spawn`/`execFileSync` **不做 PATHEXT 解析**
// （`.cmd`/`.bat` 必须由 cmd.exe 承载；自 CVE-2024-27980 起 Node 也不再隐式代跑 `.cmd`）
// -> 传裸 `'npm'` 一律 `ENOENT`。
//
// 旧实现在**三处**各自硬编码：
//   - platform/distribution/index.js   let bin = 'npm'      （唯一安装执行器；步骤3 前为 domains/dist）
//   - guard/native/manager.js      ex.runOut('npm', ...)    （版本/root 探测）
//   - guard/native/manager.js      spawn('npm', ...)        （卸载）
// 后果：Windows 用户的「升级内核 / 安装 / 卸载 DSH」全部失败，错误只是含糊的 ENOENT。
// 两仓对同一事实答案不一致：壳仓早有 `npm_exe() -> npm.cmd`。
//
// ## 锁定不变量
//   C-a  `npmBin()` 存在且：非 Windows 返回 'npm'，Windows 返回带扩展名的可执行
//   C-b  解析结果是**绝对路径或带扩展名**（Windows）—— 不能是裸 'npm'
//   C-c  源码里不得再出现裸 npm 调用（runOut('npm')/spawn('npm')/bin='npm'/whichVersion('npm')）
//   C-d  模板路径（commandTemplate 首项为 'npm'）同样被解析，且程序与前缀参数成对取用
//   C-e  npx 与 npm 同构（Windows 上是 npx.cmd）
//   C-f  安装执行器入参白名单：pkg/version/argv 项/registry origin 在 spawn 前全部过闸
//   C-g  --prefix 与模板分支对称：前缀过路径形态尺（绝对 + 无控制符 + 不以 - 开头），
//        且不得因该尺误杀 Windows 真实前缀（含空白、含反斜杠、8.3 短名）
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
/** 「单点/单源」类判据一律在剥注释后的源码上数：说明文里的键名不是注入点。 */
const { stripComments } = require('./_strip');
/** B11：需要 await 的行为断言登记处，文件尾统一结算后再统计。 */
const _asyncGates = [];

const { npmBin } = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));

// -- C-a：基础行为 --
check('C-a npmBin 是函数', typeof npmBin === 'function', typeof npmBin);
check("C-a 非 Windows 返回 'npm'", npmBin({ platform: 'linux' }) === 'npm', npmBin({ platform: 'linux' }));
check("C-a darwin 返回 'npm'", npmBin({ platform: 'darwin' }) === 'npm', npmBin({ platform: 'darwin' }));

// -- C-b：Windows 解析**逻辑**必须真的去找带扩展名的可执行 --
//
//  断言设计说明：在 Linux 上跑 `npmBin({platform:'win32'})` 仍会走本机 PATH，
//   于是「返回绝对路径」这个条件会因**本机恰好有 npm** 而通过 —— 那是弱断言，
//   无法证明 Windows 分支真的会补扩展名。故此处直接断言**候选名生成**（纯函数），
//   它才是 Windows 解析的本质：必须先试 npm.cmd，而不是裸 npm。
const { candidateNames } = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));
{
  const wc = candidateNames('npm', 'win32').map((s) => s.toLowerCase());
  check('C-b Windows 候选名含 npm.cmd', wc.includes('npm.cmd'), JSON.stringify(candidateNames('npm', 'win32')));
  check('C-b Windows 候选名把 npm.cmd 排在裸 npm 之前',
    wc.indexOf('npm.cmd') < wc.indexOf('npm'), 'cmd@' + wc.indexOf('npm.cmd') + ' vs npm@' + wc.indexOf('npm'));
  check('C-b 非 Windows 候选名只有裸 npm（不误加扩展名）',
    JSON.stringify(candidateNames('npm', 'linux')) === JSON.stringify(['npm']),
    JSON.stringify(candidateNames('npm', 'linux')));
  const w = npmBin({ platform: 'win32' });
  check('C-b Windows 结果非裸 npm', w !== 'npm', w);
}

// -- C-c：源码不得再有裸 npm 调用 --
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
/** 一行的裸 npm/npx 使用判定（纯函数：真实源码与合成旧形状走同一把尺）。
 *  B11：判定必须覆盖「逻辑名字符串出现在执行参数位」的全部写法 —— 旧版只认 spawn/execFile，
 *   于是 env-catalog 的 `whichVersion('npm')`（版本探测）长期绕过本门禁，
 *   而它的缺陷与三处硬编码**完全相同**：Windows 上 npm 是 npm.cmd，裸名一律 ENOENT。 */
const BARE_SINK_RE = /(runOut|runDetail|run|runOutAsync|execFile|exec|spawn|whichVersion|cachedWhichVersion)\s*\(\s*'(npm|npx)'|(let|const)\s+bin\s*=\s*'(npm|npx)'/;
function bareNpmCalls(src) {
  const hits = [];
  const lines = String(src).split(String.fromCharCode(10));
  lines.forEach((l, i) => {
    const s = l.trim();
    if (s.startsWith('//') || s.startsWith('*')) return; // 注释里的说明不算
    if (BARE_SINK_RE.test(l)) hits.push((i + 1) + '  ' + s.slice(0, 66));
  });
  return hits;
}
const files = walk(path.join(ROOT, 'src'), []);
const bare = [];
for (const f of files) {
  for (const h of bareNpmCalls(fs.readFileSync(f, 'utf8'))) bare.push(f.replace(ROOT + path.sep, '') + ':' + h);
}
check('C-c 源码无裸 npm/npx 调用（含版本探测 sink）', bare.length === 0, bare.length ? bare.join(' | ') : '已全部经 npmLauncher()/npxBin()');
// 反向：判据必须能识别**旧形状**，否则只是此刻恰好为真的空转门禁。
{
  const oldShapes = [
    "const bin = 'npm';",
    "const v = ex.runOut('npm', ['--version']);",
    "return cachedWhichVersion('npm');",           // B11 漏检面：版本探测绕过执行器门禁
    "child = spawn('npx', ['--yes']);",
  ];
  const missed = oldShapes.filter((s) => bareNpmCalls(s).length === 0);
  check('C-c 反向：四种旧裸调用形状全部被抓到', missed.length === 0, missed.join(' | ') || '4/4');
  check('C-c 反向：合法写法不误伤（经解析口取变量）',
    bareNpmCalls("const l = npmLauncher(); ex.runOut(l.program, l.args);").length === 0, 'ok');
}

// -- C-e：npx 与 npm 同构（P1-4）--
const { npxBin } = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));
check('C-e npxBin 是函数', typeof npxBin === 'function', typeof npxBin);
check("C-e 非 Windows 返回 'npx'", npxBin({ platform: 'linux' }) === 'npx', npxBin({ platform: 'linux' }));
{
  const wc2 = candidateNames('npx', 'win32').map((s) => s.toLowerCase());
  check('C-e Windows 候选名含 npx.cmd', wc2.includes('npx.cmd'), JSON.stringify(candidateNames('npx', 'win32')));
  check('C-e npx.cmd 排在裸 npx 之前',
    wc2.indexOf('npx.cmd') < wc2.indexOf('npx'), 'cmd@' + wc2.indexOf('npx.cmd'));
  const w2 = npxBin({ platform: 'win32' });
  check('C-e Windows 结果非裸 npx', w2 !== 'npx', w2);
}

// -- C-d：模板路径也解析 --
{
  //  （安装执行口收口）：distribution 已拆分，按目录聚合读取；启动形态解析一次、
  //   注入口接管**整对**（program+args），故判据问的是「解析口 + 整对接管」两件事。
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  // 钉代码行（不钉注释）：模板首项为逻辑名 npm 时，程序与前缀参数一并取自解析口。
  check('C-d commandTemplate 首项为 npm 时经统一启动形态解析（npmLauncher 的 program+args）',
    /const contractLauncher = runtimeContract\.npmLauncher\(\);/.test(dist)
      && /: contractLauncher;/.test(dist)
      && /bin = fromTemplate \? argv\[0\] : launcher\.program;/.test(dist)
      && /launcher\.args/.test(dist),
    '已接入');
  check('C-d 反向：只取 program（丢 args）的旧形状会被同一把尺拒',
    !/bin = fromTemplate \? argv\[0\] : launcher\.program;/.test('bin = argv[0];'), '已拒');
  // 注入即接管整对：只换程序会让假解释器去跑契约的 npm-cli.js（真实副作用）。
  check('C-d 注入方（app 层 npmLaunch）接管 program+args 整对，不半接',
    /const launcher = \(o\.launcher && o\.launcher\.program\)/.test(dist)
      && /Array\.isArray\(o\.launcher\.args\)/.test(dist), '整对接管');
  // 模板自带解释器（首项非 'npm'）时不得把契约的 npm 前缀参数塞给它 —— 那是第二种拆半错误。
  check('C-d 契约前缀参数只在前置给契约程序（模板程序不继承）',
    /fromTemplate \? \[\] : launcher\.args/.test(dist), '有');
}

// -- C-f：B11 —— 安装执行器入参白名单 + --ignore-scripts + 纯 origin 闸 --
{
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  const execSrc = fs.readFileSync(path.join(distDir, 'install.js'), 'utf8');
  const vcSrc = fs.readFileSync(path.join(distDir, 'version-check.js'), 'utf8');
  check('C-f 默认 npm argv 带 --ignore-scripts，且不分动作（装/卸都带）',
    /if \(action === 'install'\) argv\.push\('--no-audit', '--no-fund'\);[\s\S]{0,400}?argv\.push\('--ignore-scripts'\)/.test(execSrc), '有');
  // 字符集白名单搬家到 platform/util/input 单源，本域只保留同名导出。
  //   旧判据钉「install.js 里有 `const PKG_NAME_RE = /…/` 字面量」——搬家后会静默 FAIL，
  //   而它真正要守的是「pkg 进 argv 前过白名单」。现判据 = 调用点问闸 + 尺子只有一把。
  const INPUT_JS = path.join(ROOT, 'src', 'platform', 'util', 'input.js');
  check('C-f pkg 走字符集白名单 PKG_NAME_RE（调用点仍问闸）',
    /PKG_NAME_RE\.test\(pkg\)/.test(dist), '有');
  check('C-f 白名单取自 E-4 单源且本域不再自带字面量（防第二把尺子）',
    /const PKG_NAME_RE = input\.PKG_NAME_RE;/.test(dist) && !/const PKG_NAME_RE = \//.test(dist)
      && /const PKG_NAME_RE = \//.test(fs.readFileSync(INPUT_JS, 'utf8')), '单源=input.js');
  check('C-f version 走严格 semver（复用 VERSION_RE，不复制第二份）',
    /VERSION_RE\.test\(String\(o\.version\)\)/.test(dist), '有');
  check('C-f commandTemplate 替换后逐项过禁用字符集',
    /BAD_ARGV_CHAR_RE\.test\(String\(a\)\)/.test(dist), '有');
  // 「先过闸、再落敏感动作」这类时序判据必须在**同一份文件**内比序：聚合目录后跨文件顺序
  //   天然成立（拆分把 install.js/registry-ref.js 固定成字母序），删掉闸门也照样判绿。
  const gateAt2 = execSrc.indexOf('ref.registryEnvPair(o.registry)');
  const assignAt2 = execSrc.indexOf('Object.assign(envVars, rp.env)');
  check('C-f registry 写进子进程 env 前过基址闸（注入形态单源 registryEnvPair，同文件比序）',
    gateAt2 >= 0 && assignAt2 > gateAt2 && /if \(!rp\.ok\) return fail\(/.test(execSrc),
    'gate@' + gateAt2 + ' assign@' + assignAt2);
  // 注入点收口为 1：npm 的两个 registry 环境变量字面量只许住在 registry-ref.js。
  //   旧状是四处各写一遍（执行器/插件 CLI/npx 预取/实例契约），有的过闸有的不过闸，
  //   于是「面板显示一个源、子进程用另一个源」。剥注释后按文件计数，判据才不会命中说明文。
  {
    const sites = [];
    for (const f of files) {
      if (/npm_config_registry/.test(stripComments(fs.readFileSync(f, 'utf8')))) sites.push(f.replace(ROOT + path.sep, ''));
    }
    check('C-f 反向：registry 注入形态全仓单点（只有 registry-ref 写键名）',
      sites.length === 1 && /registry-ref\.js$/.test(sites[0]), sites.join(' | ') || '(无)');
  }
  // 语义 = 包名进 URL 前必须过白名单。参照物不能取「registryPackagePath 在文件中的首次出现」：
  //   拼 URL 只发生在被闸保护的 versionFromOrigin 里，它在文件中天然靠前，整文件比序会必红。
  //   改在 fetchNpmLatest 函数体内比序：闸早于对取版本函数的调用，且拼 URL 不许搬进这个函数。
  const fnBody = (src, decl) => {
    const s = src.indexOf(decl);
    const e = s < 0 ? -1 : src.indexOf('\n}', s);
    return e < 0 ? null : src.slice(s, e);
  };
  const fetchBody = fnBody(vcSrc, 'async function fetchNpmLatest(');
  const probeBody = fnBody(vcSrc, 'async function versionFromOrigin(');
  const gateAt = fetchBody === null ? -1 : fetchBody.indexOf('PKG_NAME_RE.test(pkg)');
  const callAt = fetchBody === null ? -1 : fetchBody.indexOf('versionFromOrigin(');
  check('C-f 取版本前先过包名白名单，再拼 registry URL（同函数体比序）',
    gateAt >= 0 && callAt >= 0 && gateAt < callAt && probeBody !== null
      && /registryPackagePath\(pkg\)/.test(probeBody)
      && (fetchBody.match(/registryPackagePath\(/g) || []).length === 0,
    'gate@' + gateAt + ' call@' + callAt);
  // 镜像基址形态只有一把尺子：URL 解析/凭证/查询/片段判定必须只住在 registry-ref.js。
  const REF_JS = path.join(ROOT, 'src', 'platform', 'distribution', 'registry-ref.js');
  const refSrc = fs.readFileSync(REF_JS, 'utf8');
  check('C-f 形态闸单源在 registry-ref（distribution 其余文件不得再解 URL）',
    /function parseRegistryBase\(/.test(refSrc) && /u\.username \|\| u\.password/.test(refSrc)
      && /u\.hash/.test(refSrc)
      && dist.replace(refSrc, '').match(/new URL\(/g) === null, '唯一');

  // 行为面（无副作用：非法入参必须在 spawn **之前**被拒，故不会启动任何进程）。
  // 文件头是同步判定器 —— 异步断言收进 _asyncGates，末尾 await 后再结算。
  const inst = require(path.join(distDir, 'install.js'));
  _asyncGates.push(async () => {
    const rs = await Promise.all([
      inst.runNpmInstall({ version: '1.2.3; touch /tmp/dsh-pwn', commandTemplate: ['node', '/tmp/fake.js', '{version}'] }),
      inst.runNpmInstall({ pkg: 'bad pkg', version: '1.2.3' }),
      inst.runNpmInstall({ pkg: '@a/b', version: '1.2.3', registry: 'file:///tmp/evil' }),
      inst.runNpmInstall({ pkg: '@a/b', version: '1.2.3', registry: 'https://u:pass@host' }),
      inst.runNpmInstall({ version: '1.2.3', commandTemplate: ['node', '/tmp/fake.js', '{prefix}'], prefix: '/tmp/a b' }),
    ]);
    check('C-f 行为：version 夹带 shell 元字符 → 拒（不 spawn）', !rs[0].ok && /非法版本/.test(rs[0].error), rs[0].error);
    check('C-f 行为：pkg 含空格 → 拒', !rs[1].ok && /非法包名/.test(rs[1].error), rs[1].error);
    check('C-f 行为：registry file:// → 拒（不写 npm_config_registry）', !rs[2].ok && /registry 基址/.test(rs[2].error), rs[2].error);
    check('C-f 行为：registry 凭证夹带 → 拒', !rs[3].ok && /registry 基址/.test(rs[3].error), rs[3].error);
    check('C-f 行为：{prefix} 注入空白/元字符 → 替换后仍被拒', !rs[4].ok && /禁用字符/.test(rs[4].error), rs[4].error);
  });

  // 行为面（默认 argv 构造 + 注入落地）：用 launcher 注入口把 npm 换成回显脚本，走**真实默认分支**
  //   又不碰真实 npm。静态正则只证明字面量在文件里，证明不了装/卸两条分支各自构造出哪份 argv、
  //   带 path 的镜像基址是否原样到达子进程。
  _asyncGates.push(async () => {
    const FAKE = path.join(ROOT, 'test', 'fake-npm.js');
    const launcher = { program: process.execPath, args: [FAKE] };
    process.env.FAKE_MODE = 'argv';
    let rs;
    try {
      rs = await Promise.all([
        inst.runNpmInstall({ action: 'install', pkg: '@a/b', version: '1.2.3', registry: 'https://repo.huaweicloud.com/repository/npm/', launcher }),
        inst.runNpmInstall({ action: 'uninstall', pkg: '@a/b', registry: 'https://registry.npmjs.org', launcher }),
      ]);
    } finally { delete process.env.FAKE_MODE; }
    // 回显行超 200 字符会被执行器截断（截断即解析失败，本块判红而不是静默放行）。
    const echo = (r) => {
      const l = (r.output || []).find((x) => String(x).indexOf('FAKE-ARGV ') === 0);
      if (!l) return null;
      try { return JSON.parse(String(l).slice(10)); } catch { return null; }
    };
    const a = echo(rs[0]);
    const b = echo(rs[1]);
    check('C-f 行为：安装 argv = install -g --no-audit --no-fund --ignore-scripts pkg@version',
      !!a && JSON.stringify(a.argv) === JSON.stringify(['install', '-g', '--no-audit', '--no-fund', '--ignore-scripts', '@a/b@1.2.3']),
      a ? JSON.stringify(a.argv) : '(无回显) ' + JSON.stringify(rs[0] && rs[0].output));
    check('C-f 行为：带 path 的镜像基址原样进 npm_config_registry（不剥路径）',
      !!a && a.registry === 'https://repo.huaweicloud.com/repository/npm', a ? String(a.registry) : '(无回显)');
    check('C-f 行为：卸载 argv 只点名包且同样 --ignore-scripts（不执行待删包脚本）',
      !!b && JSON.stringify(b.argv) === JSON.stringify(['uninstall', '-g', '--ignore-scripts', '@a/b']),
      b ? JSON.stringify(b.argv) : '(无回显) ' + JSON.stringify(rs[1] && rs[1].output));
    check('C-f 行为：卸载不注入 registry（不联网的动作不带镜像地址）', !!b && b.registry === null, b ? String(b.registry) : '(无回显)');
    check('C-f 行为：两条动作都以 ok/exitCode=0 收口（结果形状统一）',
      rs[0].ok === true && rs[0].exitCode === 0 && rs[1].ok === true && rs[1].exitCode === 0,
      JSON.stringify(rs.map((r) => ({ ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, aborted: r.aborted }))));
  });

  // 反向：旧判据/旧输入必须能被新闸识别
  const refGate = require(path.join(distDir, 'registry-ref.js'));
  const okBase = (s) => refGate.parseRegistryBase(s).ok;
  check('C-f 反向：scheme-only 旧判据确实放过凭证/查询/片段夹带',
    /^https?:\/\//.test('https://u:pass@host/x#y') === true
      && okBase('https://u:pass@host/x#y') === false
      && okBase('https://a.b/path?q=1') === false
      && okBase('https://a.b/#x') === false, '已收紧');
  // 带 path 的镜像基址（华为云/腾讯云常态）必须放行：把它判死就是「探测可达、下载判非法」的病根。
  check('C-f 反向：合法基址不被误杀（官方/镜像/带端口/IPv6/尾斜杠/**带 path**）',
    okBase('https://registry.npmjs.org') && okBase('https://registry.npmjs.org/')
      && okBase('http://127.0.0.1:4873') && okBase('https://[::1]:4873')
      && okBase('https://repo.huaweicloud.com/repository/npm/')
      && refGate.parseRegistryBase('https://repo.huaweicloud.com/repository/npm/').base === 'https://repo.huaweicloud.com/repository/npm'
      && refGate.registryUrl('https://repo.huaweicloud.com/repository/npm', '@a%2Fb') === 'https://repo.huaweicloud.com/repository/npm/@a%2Fb', 'ok');
  check('C-f 反向：私网主机闸只在写入口（消费闸放行内网 Verdaccio）',
    okBase('http://127.0.0.1:4873') === true
      && require(path.join(distDir, 'policies.js')).registryOriginViolation('http://127.0.0.1:4873') !== null, '分工正确');
  check('C-f 反向：白名单不拦合法包名/semver（含 prerelease 与 scope）',
    inst.PKG_NAME_RE.test('@deepseek-ai/dsh') && inst.PKG_NAME_RE.test('dsh')
      && require(path.join(ROOT, 'src', 'shared', 'version.js')).VERSION_RE.test('0.1.5-BETA.10'), 'ok');

  // B11 windows 例外（CI run17 实测回归）：BAD_ARGV_CHAR_RE 把 `\\` 一刀切禁用，
  // 误杀 win32 盘符绝对路径（D:\a\...\test\fake-npm.js）-> windows 升级链确定性判红。
  // 纯静态判据 + 组合判据仿真（不 spawn）。逐例独立断言 + 判据值回显（run20 教训：
  // 多子句 && 串一条 check，CI 只能报条名不能报子句，等于没取证）。
  const gate = (s) => inst.BAD_ARGV_CHAR_RE.test(String(s)) && !inst.WIN_DRIVE_ABS_RE.test(String(s));
  // want=true 应拒（gate 命中禁用且无豁免）；want=false 应放行。
  const CASES = [
    ['D:\\a\\dsh\\test\\fake-npm.js', false], // 盘符绝对路径：豁免（run14–17 误杀对象）
    ['D:\\', false],                          // 盘符根：形态合法，豁免
    ['D:\\a\\x\\y', false],                   // 连续分隔符：形态判据不做路径规范化，豁免
    ['D:/a/x/y', false],                      // 正斜杠无 `\\`：根本不触发禁用集
    ['C:rel\\path', true],                    // 盘符相对（有 `\\` 非 `X:\` 绝对形态）：不豁免 -> 拒（run21 实测定性：产品对、旧期望错）
    ['/tmp/fake.js', false],                  // posix 路径：不触发
    ['D:\\a\\x;y', true],                     // 盘符 + 命令链字符：拒
    ['D:\\a\\x y', true],                     // 盘符 + 空白：拒
    ['D:\\a\\x$(pwn)', true],                 // 盘符 + 命令替换：拒
    ['D:\\a\\x`id`', true],                   // 盘符 + 反引号：拒
    ['/tmp/a b', true],                       // posix + 空白：拒
  ];
  for (const [s, want] of CASES) {
    const got = gate(s);
    check('C-f 豁免判据 ' + JSON.stringify(s) + ' 应' + (want ? '拒' : '放行'), got === want,
      'BAD=' + inst.BAD_ARGV_CHAR_RE.test(s) + ' WIN=' + inst.WIN_DRIVE_ABS_RE.test(s) + ' gate=' + got);
  }
}

// -- C-g：--prefix 与 commandTemplate 分支的闸门对称性（安装前缀走路径形态尺）--
{
  const INPUT = require(path.join(ROOT, 'src', 'platform', 'util', 'input.js'));
  const INPUT_SRC = path.join(ROOT, 'src', 'platform', 'util', 'input.js');
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const installSrc = fs.readFileSync(path.join(distDir, 'install.js'), 'utf8');

  check('C-g 默认分支的 prefix 在 push --prefix 前过 prefixViolation',
    installSrc.indexOf('input.prefixViolation(o.prefix)') >= 0
      && installSrc.indexOf('input.prefixViolation(o.prefix)') < installSrc.indexOf("push('--prefix'"), '有');
  // 尺子单源：install.js 不得自带第二份前缀判定。
  check('C-g 前缀尺子取自 input 单源（install.js 内不再写第二份形态正则）',
    !/function prefixViolation/.test(installSrc) && /function prefixViolation/.test(fs.readFileSync(INPUT_SRC, 'utf8')), '单源=input.js');

  // 纯函数正反例（跨平台形态，与宿主无关 —— 这正是不用 path.isAbsolute 的理由）。
  const OK_CASES = [
    '/tmp/dsh-prefix', '/home/u/.dsh/instances/inst-1/install',
    'C:\\Users\\RUNNER~1\\.dsh\\install',        // win 8.3 短名：不得被误杀
    'C:\\Program Files\\dsh',                    // win 含空白：合法
    'D:/a/dsh/prefix', '/tmp/中 文 目 录',
    '\\\\fileserver\\share\\dsh',                // UNC
  ];
  for (const p of OK_CASES) {
    const got = INPUT.prefixViolation(p);
    check('C-g 放行绝对路径 ' + JSON.stringify(p), got === null, String(got));
  }
  const BAD_CASES = [
    ['', '空的安装前缀'], ['   ', '空的安装前缀'],
    ['--foreground-scripts', '以 - 开头'],         // 选项注入：会被 npm 当成下一个选项
    ['-c', '以 - 开头'],
    ['rel/dir', '绝对路径'], ['./x', '绝对路径'], ['../escape', '绝对路径'], ['~/.dsh', '绝对路径'],
    ['/tmp/a\nb', '控制符'], ['/tmp/a\u0000b', '控制符'],
  ];
  for (const [p, want] of BAD_CASES) {
    const got = INPUT.prefixViolation(p) || '';
    check('C-g 拒绝 ' + JSON.stringify(p) + '（' + want + '）', got.includes(want), got || '(放行)');
  }
  check('C-g 拒绝超长前缀（4096 上限）',
    INPUT.prefixViolation('/' + 'a'.repeat(5000)).includes('超长'), String(INPUT.prefixViolation('/' + 'a'.repeat(5000)).slice(0, 20)));

  // 行为面：非法前缀在 spawn 之前被拒；合法前缀不得被前缀闸拦。
  //   探针：配一个必然更晚触发的非法 registry —— 错误正文落在 registry 上即证明前缀已放行。
  const inst2 = require(path.join(distDir, 'install.js'));
  _asyncGates.push(async () => {
    const rs = await Promise.all([
      inst2.runNpmInstall({ pkg: '@a/b', version: '1.2.3', prefix: '--unsafe-cache' }),
      inst2.runNpmInstall({ pkg: '@a/b', version: '1.2.3', prefix: 'relative/dir' }),
      inst2.runNpmInstall({ pkg: '@a/b', version: '1.2.3', prefix: '/tmp/a\u0000b' }),
      inst2.runNpmInstall({ pkg: '@a/b', version: '1.2.3', prefix: 'C:\\Program Files\\dsh', registry: 'file:///tmp/evil' }),
      inst2.runNpmInstall({ pkg: '@a/b', version: '1.2.3', prefix: '/tmp/a b', registry: 'file:///tmp/evil' }),
    ]);
    check('C-g 行为：prefix 以 - 开头 → 拒且不 spawn', !rs[0].ok && /以 - 开头/.test(rs[0].error), rs[0].error);
    check('C-g 行为：prefix 相对路径 → 拒', !rs[1].ok && /绝对路径/.test(rs[1].error), rs[1].error);
    check('C-g 行为：prefix 含 NUL → 拒', !rs[2].ok && /控制符/.test(rs[2].error), rs[2].error);
    check('C-g 行为：win 含空白前缀不被误杀（拦下的是 registry 闸）',
      !rs[3].ok && /registry 基址/.test(rs[3].error) && !/安装前缀/.test(rs[3].error), rs[3].error);
    check('C-g 行为：posix 含空白前缀不被误杀（拦下的是 registry 闸）',
      !rs[4].ok && /registry 基址/.test(rs[4].error) && !/安装前缀/.test(rs[4].error), rs[4].error);
  });
}

// -- C-h：镜像传输口（registry-ref.fetchRegistry）与「带 path 的镜像」端到端行为 --
//   面板症状「完全获取不到最新版本、也下载不了」的内核侧病根有两条，都必须可红：
//   1) 内核把「基址不得带 path」当安全判据，而壳目录允许带 path（华为云/腾讯云常态）——
//      于是同一批镜像在探测阶段可达、在取字节阶段判非法；
//   2) 跳转判据两侧相反：探测拒绝一切 302（同主机改写 CDN 的健康镜像被判死），取数据却盲从跳转。
//   修法是把形态与传输各收成一处（parseRegistryBase / fetchRegistry），故判据也只需盯这一处。
//   全部只连 127.0.0.1 的假 registry，不发外部请求、不 spawn 进程。
{
  const http = require('node:http');
  const os = require('node:os');
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const refGate = require(path.join(distDir, 'registry-ref.js'));
  const { DistributionManager } = require(path.join(distDir, 'index.js'));
  const PKG = 'dsh-e2e-pkg';
  const META = { name: PKG, 'dist-tags': { latest: '1.4.2' }, versions: { '1.4.2': {} } };

  const routes = (req, res) => {
    const p = decodeURIComponent(String(req.url || '').split('?')[0]);
    const send = (code, body, type) => {
      res.writeHead(code, { 'content-type': type || 'application/json' });
      res.end(body);
    };
    const redirect = (loc) => { res.writeHead(302, { location: loc }); res.end(); };
    if (p === '/same/-/ping' || p === '/a/-/ping' || p === '/b/-/ping') return send(200, '{}');
    if (p === '/same') return redirect('/final');
    if (p === '/final') return send(200, JSON.stringify({ hit: 'final' }));
    if (p === '/cross-private') return redirect('http://169.254.169.254/meta');
    if (p === '/loop') return redirect('/loop');
    if (p === '/big') {
      res.writeHead(200, { 'content-type': 'application/json' });
      for (let i = 0; i < 8; i++) res.write('{"a":"' + 'x'.repeat(1024) + '"}');
      return res.end();
    }
    if (p === '/not-json') return send(200, 'not json at all', 'text/plain');
    if (p === '/missing') return send(404, '{}');
    // 声明 200 字节、只发 7 字节便掐线：响应头已落 socket，故失败必然发生在「读体」而不是 fetch()。
    if (p === '/truncated') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 200 });
      return res.write('{"a":"', () => { try { res.socket.destroy(); } catch { /* 已断 */ } });
    }
    // 带 path 的镜像基址（/a 与 /b 都是同一主机的不同目录）：/a 探测可达但取包 404，/b 正常给版本。
    if (p === '/a/' + PKG) return send(404, '{}');
    if (p === '/b/' + PKG) return send(200, JSON.stringify(META));
    if (p === '/' + PKG) return send(200, JSON.stringify(META));
    return send(404, '{}');
  };
  const server = http.createServer(routes);

  _asyncGates.push(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    try {
      const jump = await refGate.fetchRegistry(origin + '/same', { expect: 'json' });
      check('C-h 同主机 302 被跟随并取到字节（旧探测形态把它判死）',
        jump.ok === true && jump.json && jump.json.hit === 'final' && jump.hops.length === 2,
        JSON.stringify({ ok: jump.ok, error: jump.error, hops: jump.hops.length }));
      const cross = await refGate.fetchRegistry(origin + '/cross-private', { expect: 'json' });
      check('C-h 跨主机跳到元数据地址被拒（逐跳复验，不是盲从）',
        cross.ok === false && /私网|保留/.test(cross.error || '') && cross.hops.length === 1,
        String(cross.error));
      const loop = await refGate.fetchRegistry(origin + '/loop', { expect: 'json' });
      check('C-h 自跳环在跳数上限处收口（不给 302 链当跳板）',
        loop.ok === false && /跳转次数超过上限/.test(loop.error || ''), String(loop.error));
      const big = await refGate.fetchRegistry(origin + '/big', { expect: 'json', maxBytes: 2048 });
      check('C-h 响应体超上限即断，不猜内容', big.ok === false && /响应体超过上限/.test(big.error || ''), String(big.error));
      const bad = await refGate.fetchRegistry(origin + '/not-json', { expect: 'json' });
      check('C-h 非 JSON 响应如实判失败', bad.ok === false && /合法 JSON/.test(bad.error || ''), String(bad.error));
      const gone = await refGate.fetchRegistry(origin + '/missing', { expect: 'json' });
      check('C-h 非 2xx 带状态码回传（逐源原因要能指名 HTTP 404）',
        gone.ok === false && gone.status === 404 && /HTTP 404/.test(gone.error || ''), String(gone.error));
      // 读体阶段断流也要落成结构化失败：本口是「可达」的唯一判据源，抛出去等于逼每个调用方
      // 各长一份 try/catch —— 那正是探测与消费两侧答案分叉的起点（旧实现市场侧就有这份 catch）。
      let trunc = null;
      let truncThrew = null;
      try {
        trunc = await refGate.fetchRegistry(origin + '/truncated', { expect: 'json' });
      } catch (e) {
        truncThrew = e;
      }
      check('C-h 响应体读到一半断流不外抛，落成结构化失败',
        truncThrew === null && !!trunc && trunc.ok === false && /读取响应体中断/.test(String(trunc.error || '')),
        truncThrew ? '抛出: ' + truncThrew.message : JSON.stringify({ ok: trunc && trunc.ok, error: trunc && trunc.error }));

      // 症状本体：带 path 的镜像必须「探测可达 == 取到字节」，且死源不阻断顺延。
      // base 一律取归一后的形态（registryOrigins 会剥尾斜杠），带尾斜杠的输入另留一条只当数据用。
      const baseA = origin + '/a';
      const baseB = origin + '/b';
      const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'npmres-')), 'registry.json');
      fs.writeFileSync(tmpFile, JSON.stringify({
        schema: 1, mode: 'manual', origins: [baseA, baseB], manualOrigin: baseA,
      }));
      const dm = new DistributionManager({
        registries: [baseA, baseB], registryFile: tmpFile,
        logger: { warn() {}, info() {} },
      });
      const sel = await dm.selectRegistry(false);
      check('C-h manual 语义＝置顶但仍测速（旧语义短路一切探测 → 延迟列全空、无任何诊断）',
        sel.manual === true && sel.origin === baseA && sel.ordered[0] === baseA
          && sel.ordered.indexOf(baseB) > 0 && sel.probes.length === 2,
        JSON.stringify({ origin: sel.origin, ordered: sel.ordered.length, probes: sel.probes.length }));
      const pick = await dm.fetchNpmLatest(PKG);
      check('C-h 手动死源下仍能顺延取到版本，且 origin=真正给出该版本的源（下载同源）',
        pick.ok === true && pick.version === '1.4.2' && pick.origin === baseB
          && pick.attempts.length === 1 && pick.attempts[0].origin === baseA && /HTTP 404/.test(pick.attempts[0].error),
        JSON.stringify({ version: pick.version, origin: pick.origin, attempts: pick.attempts }));
      // 注入 npm 的基址闸：允许带 path（华为云/腾讯云常态），但仍必须在写入 env 前拦下夹带凭证的基址。
      // 首项用必然不存在的程序 —— 证明「已过 registry 闸、走到了执行阶段」而不是靠真 spawn 判绿；
      // 不用 echo/cmd 内建：Windows runner 上 spawn 不认 shell 内建，会把真绿判成红。
      const NOEXEC = 'dsh-p0a-nonexistent-npm';
      const slashed = await dm.runNpmInstall({ pkg: PKG, version: '1.4.2', registry: baseA + '/', commandTemplate: [NOEXEC], timeoutMs: 15000 });
      check('C-h 带 path 的基址注入 npm 前不再被误杀（尾斜杠归一，仍过同一道闸）',
        !!slashed.error && !/registry 基址/.test(slashed.error) && refGate.parseRegistryBase(baseA + '/').base === baseA,
        JSON.stringify({ error: slashed.error, base: refGate.parseRegistryBase(baseA + '/').base }));
      const credentialed = await dm.runNpmInstall({
        pkg: PKG, version: '1.4.2', registry: origin.replace('http://', 'http://u:p@') + '/a', commandTemplate: [NOEXEC], timeoutMs: 15000,
      });
      check('C-h 反向：注入口仍拦得住凭证夹带（放宽 path 没有放宽攻击面）',
        credentialed.ok === false && /registry 基址/.test(String(credentialed.error)), String(credentialed.error));
      const rejected = await dm.setRegistryConfig({ mode: 'manual', manualOrigin: 'https://u:p@host/x' });
      check('C-h 反向：凭证夹带的手动源不落盘（放宽 path 不等于放宽攻击面）',
        !!rejected.error && /凭证|用户名|密码/.test(rejected.error), String(rejected.error));

      // 结构面：探测与消费必须共用同一个传输口，且域内不留第二处裸 fetch。
      const regSrc = fs.readFileSync(path.join(distDir, 'registry.js'), 'utf8');
      const vcSrc = fs.readFileSync(path.join(distDir, 'version-check.js'), 'utf8');
      const probeBody = regSrc.slice(regSrc.indexOf('async function probeRegistry('));
      const metaBody = vcSrc.slice(vcSrc.indexOf('async function versionFromOrigin('));
      check('C-h 探测与取字节共用 ref.fetchRegistry（两侧不可能再给出不同答案）',
        /ref\.fetchRegistry\(/.test(probeBody.slice(0, 1400)) && /ref\.fetchRegistry\(/.test(metaBody.slice(0, 900)), '同一口');
      // 镜像传输只允许一个出口：registry-ref.fetchRegistry。GitHub Releases 不是镜像，
      // 允许在 version-check.js 里直连；豁免必须先定位到真实函数体并要求其中含 api.github.com，
      // 否则「第二套可达判据」可以藏进任意一段代码里。
      const ghStart = vcSrc.indexOf('async function fetchGithubLatest(');
      const ghEnd = vcSrc.indexOf('/** 统一版本检查', ghStart);
      const ghExempt = ghStart >= 0 && ghEnd > ghStart && /api\.github\.com/.test(vcSrc.slice(ghStart, ghEnd));
      const bareFetches = (src) => (src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').match(/[^.\w]fetch\(/g) || []).length;
      const distFiles = fs.readdirSync(distDir).filter((f) => f.endsWith('.js'));
      const offenders = distFiles.filter((f) => {
        if (f === 'registry-ref.js') return false; // 唯一出口本体，下面单独钉次数
        const src = f === 'version-check.js' && ghExempt ? vcSrc.slice(0, ghStart) + vcSrc.slice(ghEnd)
          : fs.readFileSync(path.join(distDir, f), 'utf8');
        return bareFetches(src) > 0;
      });
      const refGateSrc = fs.readFileSync(path.join(distDir, 'registry-ref.js'), 'utf8');
      check('C-h distribution 内除 registry-ref 外无第二处裸 fetch（防长出第二套「可达」判据）',
        ghExempt && distFiles.length >= 7 && offenders.length === 0 && bareFetches(refGateSrc) === 1,
        offenders.join(', ') + ' / registry-ref=' + bareFetches(refGateSrc));
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    } finally {
      // undici 会池化 keep-alive 套接字：只 close() 要等空闲超时，测试进程跟着挂住。
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
}

// -- 反向：解析结果确实可执行（本机验证，非 Windows 分支）--
{
  const local = npmBin();
  check('反向：本机解析结果可用（非空字符串）', typeof local === 'string' && local.length > 0, local);
}

(async () => {
  for (const g of _asyncGates) await g();
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();