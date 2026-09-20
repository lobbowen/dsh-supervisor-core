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
  //  （域结构第三轮）：distribution 已拆分，按目录聚合读取（安装执行器落在 install.js）。
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  // 钉代码行（不钉注释）：模板首项为逻辑名 npm 时，程序与前缀参数一并取自解析口。
  check('C-d commandTemplate 首项为 npm 时经统一启动形态解析（npmLauncher 的 program+args）',
    /const launcher = runtimeContract\.npmLauncher\(\);/.test(dist)
      && /bin = fromTemplate \? argv\[0\] : launcher\.program;/.test(dist)
      && /launcher\.args/.test(dist),
    '已接入');
  check('C-d 反向：只取 program（丢 args）的旧形状会被同一把尺拒',
    !/bin = fromTemplate \? argv\[0\] : launcher\.program;/.test('bin = argv[0];'), '已拒');
  // 模板自带解释器（首项非 'npm'）时不得把契约的 npm 前缀参数塞给它 —— 那是第二种拆半错误。
  check('C-d 契约前缀参数只在前置给契约程序（模板程序不继承）',
    /fromTemplate \? \[\] : launcher\.args/.test(dist), '有');
}

// -- C-f：B11 —— 安装执行器入参白名单 + --ignore-scripts + 纯 origin 闸 --
{
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  check('C-f 默认 npm argv 带 --ignore-scripts（安装期不执行包内生命周期脚本）',
    /'--no-fund'\];[\s\S]{0,400}?push\('--ignore-scripts'\)/.test(dist), '有');
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
  check('C-f registry 写入 npm_config_registry 前过纯 origin 闸',
    /if \(!policies\.isValidOrigin\(o\.registry\)\)/.test(dist)
      && dist.indexOf('if (!policies.isValidOrigin(o.registry))') < dist.indexOf('envVars.npm_config_registry = o.registry'), '有');
  check('C-f fetchNpmLatest 拼接 URL 前过 origin + pkg 双闸',
    /if \(!policies\.isValidOrigin\(base\)\) return null;[\s\S]{0,120}PKG_NAME_RE\.test\(pkg\)/.test(dist), '有');
  check('C-f isValidOrigin 不再是 scheme-only（URL 解析 + 凭证/路径/片段拒绝）',
    /new URL\(s\)/.test(dist) && /u\.username \|\| u\.password/.test(dist) && /u\.hash/.test(dist), '有');

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
    check('C-f 行为：registry file:// → 拒（不写 npm_config_registry）', !rs[2].ok && /registry origin/.test(rs[2].error), rs[2].error);
    check('C-f 行为：registry 凭证夹带 → 拒', !rs[3].ok && /registry origin/.test(rs[3].error), rs[3].error);
    check('C-f 行为：{prefix} 注入空白/元字符 → 替换后仍被拒', !rs[4].ok && /禁用字符/.test(rs[4].error), rs[4].error);
  });

  // 反向：旧判据/旧输入必须能被新闸识别
  const pol = require(path.join(distDir, 'policies.js'));
  check('C-f 反向：scheme-only 旧判据确实放过凭证/路径/片段夹带',
    /^https?:\/\//.test('https://u:pass@host/x#y') === true
      && pol.isValidOrigin('https://u:pass@host/x#y') === false
      && pol.isValidOrigin('https://a.b/path?q=1') === false
      && pol.isValidOrigin('https://a.b/#x') === false, '已收紧');
  check('C-f 反向：合法纯 origin 不被误杀（官方/镜像/带端口/IPv6/尾斜杠）',
    pol.isValidOrigin('https://registry.npmjs.org') && pol.isValidOrigin('https://registry.npmjs.org/')
      && pol.isValidOrigin('http://127.0.0.1:4873') && pol.isValidOrigin('https://[::1]:4873'), 'ok');
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
      !rs[3].ok && /registry origin/.test(rs[3].error) && !/安装前缀/.test(rs[3].error), rs[3].error);
    check('C-g 行为：posix 含空白前缀不被误杀（拦下的是 registry 闸）',
      !rs[4].ok && /registry origin/.test(rs[4].error) && !/安装前缀/.test(rs[4].error), rs[4].error);
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