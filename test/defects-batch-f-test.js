#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 批 F 缺陷回归
//
// 四个缺陷各自独立，但**共享同一根因族**：
//   「注释声称的行为」与「代码实际行为」不一致，且不一致处**静默**。
//
//   K6  identity.js 声称有 Host 校验，实现里从未读取 req.headers.host
//   K7  ports.js 用 process.env.HOME || '/tmp'，Windows 无 HOME -> 状态文件分裂
//   K9  正则 [^s] 写成字符类（意图 [^\s]），静默截断/跨行
//   K10 卸载失败仍无条件删 manifest -> 残留不可追
//
// 本测试逐条把「声称」变成「断言」。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
// 端口必须经 safePort 取（门禁 T1/T2：不得硬编码，且须落在安全段 28000+）。
const { safePort } = require('./_ports.js');
const TEST_PORT = safePort('defects-batch-f', 0);
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// -- K6 Origin/Host 双闸 --
console.log('== K6 CSRF 深化校验（Host + Origin）==');
{
  const apiPath = path.join(ROOT, 'src', 'api', 'index.js');
  const src = fs.readFileSync(apiPath, 'utf8');
  // 直接测真实导出的函数（若未导出，则退回源码断言）。
  let originAllowed = null;
  try { originAllowed = require(apiPath).originAllowed; } catch {}
  if (typeof originAllowed === 'function') {
    const mk = (headers) => ({ headers });
    const P = TEST_PORT;              // 测试端口（安全段，经 safePort 取）
    const R = TEST_PORT + 1;          // 另一个端口（用于「异端口」用例）
    const evil = `http://evil.com:${P}`;
    // 闸 1)：Host 必须是回环名（防 DNS-rebinding）
    check('K6-a 恶意 Host（evil.com）被拒',
      originAllowed(mk({ host: 'evil.com' }), P) === false, 'evil.com');
    // Host 闸 fail-closed —— 缺 Host 不再整块跳过（旧行为=两闸同时归零）。
    check('K6-a 缺 Host 被拒（C-1 fail-closed）', originAllowed(mk({}), P) === false, 'no-host');
    check('K6-a 回环 Host（127.0.0.1:port）被接受',
      originAllowed(mk({ host: `127.0.0.1:${P}` }), P) === true);
    check('K6-a IPv6 回环 Host（[::1]:port）被接受',
      originAllowed(mk({ host: `[::1]:${P}` }), P) === true);
    check('K6-a localhost:port 被接受',
      originAllowed(mk({ host: `localhost:${P}` }), P) === true);
    // 闸 2)：Origin（以下桩一律带合法 Host —— C-1 后缺 Host 先被闸 1 拒）
    check('K6-b 恶意 Origin（http://evil.com:同端口）被拒（旧实现只比端口 → 会放行）',
      originAllowed(mk({ host: `127.0.0.1:${P}`, origin: evil }), P) === false, evil);
    check('K6-b 回环 Origin + 同端口被接受',
      originAllowed(mk({ host: `127.0.0.1:${P}`, origin: `http://127.0.0.1:${P}` }), P) === true);
    check('K6-b 回环 Origin + 异端口被拒',
      originAllowed(mk({ host: `127.0.0.1:${P}`, origin: `http://127.0.0.1:${R}` }), P) === false);
    check('K6-b 壳内 webview（tauri://localhost）被接受',
      originAllowed(mk({ host: `127.0.0.1:${P}`, origin: 'tauri://localhost' }), P) === true);
    check('K6-b 无 Origin（curl/CLI）放行（C-2 裁决：浏览器 POST 必带 Origin，缺 Origin=非浏览器客户端）',
      originAllowed(mk({ host: `127.0.0.1:${TEST_PORT}` }), TEST_PORT) === true);
    check('K6-b 畸形 Origin 被拒',
      originAllowed(mk({ host: `127.0.0.1:${TEST_PORT}`, origin: 'not a url' }), TEST_PORT) === false);
  } else {
    // 退回源码断言（函数未导出时）
    check('K6 读取 req.headers.host（identity.js 声称的深化校验已实现）',
      /req\.headers\.host/.test(src), 'req.headers.host');
    check('K6 Origin 校验含 hostname 判定',
      /u\.hostname/.test(src) && /isLoopbackHost/.test(src), 'isLoopbackHost');
  }
  check('K6 接受壳 origin（tauri://）', /tauri:/.test(src), 'tauri:');
}

// -- K7 ports.js 不用 HOME 兜底 --
console.log('== K7 端口注册表路径（三平台一致）==');
{
  // （测试指针同步）：ports/index.js 已缩为 20 行门面，
  //   路径解析实现在同层 pool.js/core.js —— 改为读取整个 ports 目录（剥注释），覆盖面不缩小。
  const dir = path.join(ROOT, 'src', 'platform', 'service', 'ports');
  const code = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join(String.fromCharCode(10))
    .split(String.fromCharCode(10))
    .filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
  check('K7 不再使用 process.env.HOME（Windows 无该变量）',
    !/process\.env\.HOME/.test(code), 'HOME');
  check('K7 不再把 /tmp 作为兜底（状态文件会与 state.json 分裂）',
    !code.includes("'/tmp'"), '/tmp');
  //路径改由**产品状态根**（src/platform/service/state-root.js）给出 ——
  //   仍是三平台正确来源，且与 state.json 同域（不分裂）；不再各自 os.homedir()。
  //  Phase 1：ports 上游化到 platform/service/ports/ 后，其**同层**引用变为 '../state-root'
  //   （原 '.../platform/service/state-root' 的跨层写法不存在了）——判据随之放宽为"经 state-root 的 supervisorDir()"。
  check('K7 经产品状态根解析端口文件（state-root.supervisorDir）',
    /state-root/.test(code) && /supervisorDir\(\)/.test(code), 'state-root');
}

// -- K9 版本解析正则 --
console.log('== K9 版本解析正则 ==');
{
  //  步骤7：版本解析正则已从 settings-view.js 拆到 app/settings/versions.js。
  const p = path.join(ROOT, 'src', 'app', 'settings', 'versions.js');
  const srcAll = fs.readFileSync(p, 'utf8');
  //  必须**先剥离注释**再断言：修复说明里会引用错误形态 [^s] 作对照，
  //   若不剥注释，正确的修复反而会被自己的说明文字判为「仍有误用」。
  const src = srcAll.split(String.fromCharCode(10))
    .filter((l) => !/^\s*\/\//.test(l)).join(String.fromCharCode(10));
  check('K9 不再有 [^s] 字符类误用（已剥注释）', !/\[\^s\]/.test(src), '[^s]');
  check('K9 使用 [^\\s]（正确的「非空白」）', /\[\^\\s\]/.test(src), '[^\\s]');
  check('K9 正则被赋值给变量 m 并从 out 提取',
    /const m = \/dsh-supervisor v\(\[\^\\s\]\+\)\/\.exec\(out\)/.test(src), 'ok');
  const re = /dsh-supervisor v([^\s]+)/;
  check('K9 含 s 的版本不被截断', re.exec('dsh-supervisor v1.0.5s')?.[1] === '1.0.5s',
    String(re.exec('dsh-supervisor v1.0.5s')?.[1]));
  check('K9 不跨行吞字', re.exec('dsh-supervisor v1.0.0\nEXTRA')?.[1] === '1.0.0',
    JSON.stringify(re.exec('dsh-supervisor v1.0.0\nEXTRA')?.[1]));
}

// -- K10 卸载失败保留 manifest --
console.log('== K10 卸载失败时保留 manifest ==');
{
  //  R3-A：卸载编排已从 installer.js 下沉到 app/native/ops.js（DF-1/DF-2）。
  //   不变量不变：rm(manifestFile) 必须在 exitCode===0 成功分支内；断言随之改址。
  const p = path.join(ROOT, 'src', 'app', 'native', 'ops.js');
  const src = fs.readFileSync(p, 'utf8');
  // 找出 uninstall 相关块：rm(host.manifestFile) 必须**在成功分支内**
  const idx = src.indexOf('npm uninstall exit');
  check('K10 有「卸载失败」处理分支', idx > 0, idx > 0 ? 'ok' : '未找到');
  if (idx > 0) {
    // 取该分支前后各 900 字符，检查 rm 是否被 exitCode===0 守卫
    const seg = src.slice(Math.max(0, idx - 900), idx + 400);
    check('K10 删除 manifest 受 exitCode===0 守卫（失败时保留以便重试）',
      /if\s*\(exitCode\s*===\s*0\)\s*\{\s*\n\s*rm\(host\.manifestFile\)/.test(seg),
      'exitCode===0 → rm');
    check('K10 失败分支保留 manifest',
      /保留 manifest/.test(seg), '保留 manifest');
  }
}

// --：C-3/C-4/C-5/C-6/C-7/C-8 纯函数级逐例断言 --
// 判据纪律：多子句一律拆逐例 + 判据值回显。
console.log('== 批4 C-3 remoteTokenStrength（shared/credential）/ backoffGate（relay/core）==');
{
  const core = require(path.join(ROOT, 'src', 'domains', 'relay', 'core.js'));
  // 强度闸的实现住在 shared/credential（L0 纯判定）：三个消费点跨 relay/instance 两域 + app 编排层，
  //   放在任一域内都会逼出 domains 间跨域边。
  const cred = require(path.join(ROOT, 'src', 'shared', 'credential.js'));
  const cases = [
    ['empty-string', '', false, 'empty'],
    ['spaces-only', '   ', false, 'empty'],
    ['null', null, false, 'empty'],
    ['undefined', undefined, false, 'empty'],
    ['7 chars', '1234567', false, 'short'],
    ['8 chars', '12345678', true, ''],
    ['8 chars + pad', ' 12345678 ', true, ''],
    ['long', 'a-very-remote-token-value-0123456789', true, ''],
  ];
  for (const [label, input, wantOk, wantReason] of cases) {
    const r = cred.remoteTokenStrength(input);
    check('C-3 strength ' + label + ' → ok=' + wantOk, r.ok === wantOk && r.reason === wantReason,
      JSON.stringify(r));
  }
  // wan 前置闸接线：过短令牌必须被拒（reason 走 short 文案）；空令牌同样拒（公网零认证防线）
  check('C-3 validateWanAccess 拒 4 位令牌',
    core.validateWanAccess({ remoteToken: 'abcd' }).ok === false, 'short-rejected');
  check('C-3 validateWanAccess 拒空令牌',
    core.validateWanAccess({ remoteToken: '' }).ok === false, 'empty-rejected');
  check('C-3 validateWanAccess 放行 8 位令牌',
    core.validateWanAccess({ remoteToken: '12345678' }).ok === true, 'ok');
  const bgCases = [
    ['低于阈值', { failCount: 9, firstAt: 1000, now: 5000 }, null],
    //   入参语义是 `now` 而非已耗时长：真实耗时 = now - firstAt = 5000 - 1000 = 4000，
    //   剩余 = lockMs(60000) - 4000 = 56000（把 `now` 当已耗时长会算出 59000 这种错期望）。
    //   夹具的账必须与产品同定义，判据回显里带着算式两端。
    //   配一条 elapsed=0 的对照例：它把「剩余窗口」与「已耗时长」彻底分开，两者再混用必红其一。
    ['达阈值窗口内（已耗 4000ms）', { failCount: 10, firstAt: 1000, now: 5000 }, 56000],
    ['达阈值窗口起点（已耗 0ms → 整锁时长）', { failCount: 10, firstAt: 1000, now: 1000 }, 60000],
    ['超窗重置', { failCount: 10, firstAt: 1000, now: 61001 }, null],
    ['零失败', { failCount: 0, firstAt: 0, now: 5000 }, null],
  ];
  for (const [label, f, want] of bgCases) {
    const r = core.backoffGate(f);
    check('C-3 backoffGate ' + label + ' → waitMs=' + want,
      r.waitMs === want, JSON.stringify(r) + ' 输入=' + JSON.stringify(f));
  }
  // 写入口接线（源码形态：令牌强度闸的两个写入前置点都过同一纯函数）。
  //   三态化收口后 main 的 remoteToken 唯一写入口在 app/domain-actions/lan.js#setRemoteToken
  //   （main 与沙箱同口），patchDshMain 只剩 guardian，故不再检查 domain-actions/main.js。
  const opsSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'instance', 'ops.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'core.js'), 'utf8');
  check('C-3 实例域写入口引用 remoteTokenStrength', /remoteTokenStrength\(/.test(opsSrc), '有');
  const actSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'domain-actions', 'lan.js'), 'utf8');
  check('C-3 令牌统一写入口（lan.setRemoteToken）引用 remoteTokenStrength', /remoteTokenStrength\(/.test(actSrc), '有');
  // 归属判据：单一实现 + 三个消费点全部经 shared 取用。
  const credSrc = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'credential.js'), 'utf8');
  check('C-3 强度闸实现在 shared/credential 且已导出',
    /^function remoteTokenStrength\(/m.test(credSrc) && /remoteTokenStrength/.test(credSrc.split('module.exports')[1] || ''),
    '实现=' + /^function remoteTokenStrength\(/m.test(credSrc) + ' 导出=' + JSON.stringify(credSrc.split('module.exports')[1] || '').slice(0, 60));
  check('C-3 反向：shared/credential 出度 = 0（L0 纯，不得 require 任何上层）',
    !/require\(/.test(credSrc.replace(/^\/\*[\s\S]*?\*\//gm, '')), '无 require');
  check('C-3 反向：relay/core 不再自带第二份实现',
    !/function remoteTokenStrength\(/.test(coreSrc), coreSrc.indexOf('function remoteTokenStrength(') >= 0 ? '仍有本体' : '仅引用 shared');
  check('C-3 反向：instance 域不再跨域 require relay（DS-G1 边的成因）',
    !/require\(['"]\.\.\/relay/.test(opsSrc), '跨域 require 计数 0');
}

// --：C-3b projectRemoteView（relay/core）逐子句钉 --
// 这是「二维码跟随真实访问态」的单一事实源：off 短路、reasons 优先级、访问令牌只计入 wan、
// accessUrl 与 ready 正交、host 按 mode 选、端口缺席不拼半截 URL——每个分句一条例，判据值回显整段视图。
console.log('== 批4 C-3b projectRemoteView（访问视图唯一事实源）==');
{
  const core = require(path.join(ROOT, 'src', 'domains', 'relay', 'core.js'));
  const pv = (x) => core.projectRemoteView(x);
  const greenLan = { mode: 'lan', relayListening: true, tokenSet: true, cookieReady: true, lanAddress: '192.168.3.64', wanPort: 22001 };
  // off 短路：即使运行时事实全部就绪也不出 URL/不报因（关 = 无访问态可言）
  {
    const v = pv(Object.assign({}, greenLan, { mode: 'off', serverAddr: '203.0.113.9', frpcRunning: true }));
    check('C-3b off → 短路 {ready:false, accessUrl:null, reasons:[]}',
      v.ready === false && v.accessUrl === null && v.reasons.length === 0, JSON.stringify(v));
  }
  {
    const v = pv({ mode: 'bogus', relayListening: true });
    check('C-3b 非法 mode 归一为 off（normalizeRemoteMode 单一入口）', v.mode === 'off', JSON.stringify(v));
    check('C-3b mode 缺省（undefined）同样归 off', pv({}).mode === 'off', JSON.stringify(pv({})));
  }
  // 未就绪逐条给因 + 优先级：relay 未监听 在 会话注入 之前（else-if 不重复报）
  {
    const v = pv({ mode: 'lan' });
    check('C-3b lan 全缺 → 唯一因是 relay 未监听（缺令牌不计入 lan）',
      v.reasons.join('|') === '远程服务未就绪（relay 未监听）', JSON.stringify(v));
  }
  {
    const v = pv({ mode: 'lan', relayListening: true, tokenSet: false, cookieReady: false });
    check('C-3b lan 监听后会话未注入 → 只报注入一条',
      v.reasons.join('|') === '正在注入 DSH 会话…', JSON.stringify(v));
  }
  // 门卫空令牌恒放行（tokenGateDecision），所以缺令牌对 lan 不构成访问不通；
  // 把它计入 lan 未就绪 = 明明能扫码打开却被判成不可用。
  {
    const v = pv(Object.assign({}, greenLan, { tokenSet: false }));
    check('C-3b lan 缺令牌仍就绪且出地址（令牌只属于 wan 的判据）',
      v.ready === true && v.accessUrl === 'http://192.168.3.64:22001/', JSON.stringify(v));
  }
  {
    const v = pv(Object.assign({}, greenLan, { mode: 'wan', tokenSet: false, serverAddr: '203.0.113.9', frpcRunning: true }));
    check('C-3b wan 缺令牌 → 未设访问令牌计入未就绪（公网口无令牌即裸奔）',
      v.ready === false && v.reasons.join('|') === '未设访问令牌', JSON.stringify(v));
  }
  // 未就绪也要给出可复制地址：relay 尚未监听时端口/地址已定，用户需要的是同一入口。
  {
    const v = pv(Object.assign({}, greenLan, { relayListening: false }));
    check('C-3b 未就绪（relay 未监听）仍出 accessUrl（地址与 ready 正交）',
      v.ready === false && v.accessUrl === 'http://192.168.3.64:22001/', JSON.stringify(v));
  }
  // wan 附加两因：未配地址 / 隧道未建（可并存，各报一条）
  {
    const v = pv(Object.assign({}, greenLan, { mode: 'wan', serverAddr: '', frpcRunning: false }));
    check('C-3b wan 未配地址+隧道未建 → 两条都报（不吞并列因）',
      v.reasons.includes('未配置 frps 服务器地址') && v.reasons.includes('公网隧道未建立（frpc 未运行）') && v.ready === false,
      JSON.stringify(v));
    const v2 = pv(Object.assign({}, greenLan, { mode: 'wan', serverAddr: '   ', frpcRunning: true }));
    check('C-3b serverAddr 纯空白视同未配（trim 判定，防拼出 http:// :port/）',
      v2.reasons.includes('未配置 frps 服务器地址') && v2.accessUrl === null, JSON.stringify(v2));
  }
  // host 选择：lan 用局域网地址、wan 用 serverAddr——另一个字段放诱饵值，选错即红
  {
    const v = pv(Object.assign({}, greenLan, { serverAddr: '203.0.113.9' }));
    check('C-3b lan 就绪 → accessUrl 用局域网地址（serverAddr 诱饵未被选中）',
      v.ready === true && v.accessUrl === 'http://192.168.3.64:22001/', JSON.stringify(v));
    const w = pv({ mode: 'wan', relayListening: true, tokenSet: true, cookieReady: true, frpcRunning: true, serverAddr: '203.0.113.9', lanAddress: '192.168.3.64', wanPort: 22001 });
    check('C-3b wan 就绪 → accessUrl 用 frps 公网地址（即验收判据 a：扫码进公网口）',
      w.ready === true && w.accessUrl === 'http://203.0.113.9:22001/', JSON.stringify(w));
  }
  // 端口缺席不拼半截 URL（同号纪律下 relay 口即公网口，缺位 = 还没绑定）
  {
    const v = pv(Object.assign({}, greenLan, { wanPort: null }));
    check('C-3b wanPort 缺席 → accessUrl=null（宁缺不半截）', v.accessUrl === null, JSON.stringify(v));
    const v2 = pv(Object.assign({}, greenLan, { lanAddress: '' }));
    check('C-3b lanAddress 空 → accessUrl=null 但就绪判定不受影响',
      v2.accessUrl === null && v2.ready === true, JSON.stringify(v2));
  }
  // 反向防空转：ready 的判据必须真依赖 reasons 全清（漏一条原因字段必被检出）。
  // base 取 wan 全就绪：五个原因字段各翻一次，任何一因子被吞掉即红。
  {
    const base = { mode: 'wan', relayListening: true, tokenSet: true, cookieReady: true, serverAddr: '203.0.113.9', frpcRunning: true, lanAddress: 'h', wanPort: 1 };
    check('C-3b 反向：wan 全就绪基线本身为 ready', pv(base).ready === true, JSON.stringify(pv(base)));
    const flips = [
      ['relayListening=false', Object.assign({}, base, { relayListening: false })],
      ['tokenSet=false', Object.assign({}, base, { tokenSet: false })],
      ['cookieReady=false', Object.assign({}, base, { cookieReady: false })],
      ['serverAddr=空', Object.assign({}, base, { serverAddr: '' })],
      ['frpcRunning=false', Object.assign({}, base, { frpcRunning: false })],
    ];
    for (const [label, f] of flips) {
      const v = pv(f);
      check('C-3b 反向：' + label + ' 时 ready 必须 false', v.ready === false && v.reasons.length >= 1, JSON.stringify(v));
    }
  }
}

// --：C-3c normalizeInstance（instance/model）磁盘迁移逐例钉 --
// 这是冷启动唯一的历史态收敛点（验收判据 d）：legacy 布尔对 -> 三态 + 手填口/镜像字段剔除。
console.log('== 批4 C-3c normalizeInstance（legacy 布尔对 -> remoteMode 三态）==');
{
  const { normalizeInstance } = require(path.join(ROOT, 'src', 'domains', 'instance', 'model.js'));
  const base = () => ({ id: 'i', name: 'n', port: 29051 });
  const mig = (extra) => Object.assign(base(), extra);
  const cases = [
    ['remoteEnabled+frpEnabled → wan', mig({ remoteEnabled: true, frpEnabled: true }), 'wan'],
    ['仅 remoteEnabled → lan', mig({ remoteEnabled: true, frpEnabled: false }), 'lan'],
    ['remoteEnabled 有 frpEnabled 缺 → lan', mig({ remoteEnabled: true }), 'lan'],
    ['两者皆 false → off', mig({ remoteEnabled: false, frpEnabled: false }), 'off'],
    ['frpEnabled=true 但总远程关 → off（关是安全方向，不被 frp 意图翻起）', mig({ remoteEnabled: false, frpEnabled: true }), 'off'],
    ['无 legacy 字段 → off', mig({}), 'off'],
    ['已是三态 lan 直读（布尔对缺席不覆盖现值）', mig({ remoteMode: 'lan' }), 'lan'],
    ['已是三态 wan 直读', mig({ remoteMode: 'wan' }), 'wan'],
    ['三态在场优先于 legacy 布尔（新值不被旧对推翻）', mig({ remoteMode: 'wan', remoteEnabled: false, frpEnabled: false }), 'wan'],
    ['非法三态值回落 legacy 推导（脏值不吞意图）', mig({ remoteMode: 'bogus', remoteEnabled: true }), 'lan'],
    ['非法三态值且无 legacy → off', mig({ remoteMode: 'bogus' }), 'off'],
  ];
  for (const [label, input, want] of cases) {
    const r = normalizeInstance(input);
    check('C-3c ' + label + ' → ' + want, r.remoteMode === want, JSON.stringify({ got: r.remoteMode, want }));
  }
  // 旧键必须消失（残留会让下一轮读盘看到双轨真相）
  {
    const legacyRow = () => mig({
      remoteEnabled: true, frpEnabled: true, frpRemotePort: 7001, wanPort: 22001, dshToken: 'STALE',
    });
    const raw = legacyRow(); // 不过 normalize 的原样记录（normalizeInstance 是原地改）
    const r = normalizeInstance(legacyRow());
    check('C-3c 迁移后 legacy 键全部剔除（零双轨）',
      !('remoteEnabled' in r) && !('frpEnabled' in r) && !('frpRemotePort' in r)
        && !('wanPort' in r) && !('dshToken' in r),
      JSON.stringify(Object.keys(r)));
    check('C-3c 迁移幂等（二次 normalize 不改结果 = 落盘后无历史态可推）',
      normalizeInstance(r).remoteMode === 'wan', JSON.stringify(normalizeInstance(r)));
    // 反向对照不过 normalize 的同一记录：键确实在——证明上面「剔除」判据不是空转。
    check('C-3c 反向：未过 normalize 的同形状记录 wanPort/legacy 键仍在（判据非空转）',
      'wanPort' in raw && 'remoteEnabled' in raw, JSON.stringify(Object.keys(raw)));
  }
}

console.log('== 批4 C-4 upstreamPath（门卫令牌不进上游）==');
{
  const core = require(path.join(ROOT, 'src', 'domains', 'relay', 'core.js'));
  const cases = [
    ['/x?token=abc', '/x'],
    ['/x?a=1&token=abc', '/x?a=1'],
    ['/?token=', '/'],
    ['/plain', '/plain'],
    ['/keep?a=1&b=2', '/keep?a=1&b=2'],
  ];
  for (const [input, want] of cases) {
    const got = core.upstreamPath(input);
    check('C-4 upstreamPath ' + input + ' → ' + want, got === want, got);
  }
  check('C-4 tunnel 请求行经 upstreamPath',
    /upstreamPath\(req\.url\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'tunnel.js'), 'utf8')), '有');
}

console.log('== 批4 C-5 有界读取（Buffer 累积不切碎多字节）==');
{
  const { collectBody } = require(path.join(ROOT, 'src', 'api', 'transport', 'body.js'));
  const { Readable } = require('node:stream');
  // 汉字（3 字节）恰被切碎在 chunk 边界：旧的 string 拼接会产生 U+FFFD，Buffer 累积不会。
  const mkRes = (settle) => ({ headersSent: false, writeHead(code) { this.headersSent = true; settle({ code }); }, end() { this.ended = true; } });
  const run = (chunks, max) => new Promise((res) => {
    const r = Readable.from(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));
    let done = false;
    const finish = (v) => { if (!done) { done = true; res(v); } };
    collectBody(r, mkRes(finish), max, (b) => finish({ body: b }));
    setTimeout(() => finish({ code: '<<timeout>>' }), 2000);
  });
  (async () => {
    const b = Buffer.from('你好', 'utf8'); // 6 字节，在 2 字节处切断 -> 半字符跨 chunk
    const r2 = await run([b.subarray(0, 2), b.subarray(2)], 100);
    check('C-5 collectBody 跨 chunk 多字节不损坏', r2.body === '你好', JSON.stringify(r2.body));
    const r3 = await run([Buffer.from('x'.repeat(50)), Buffer.from('y'.repeat(50))], 60);
    check('C-5 collectBody 超限回 413', r3.code === 413, String(r3.code));
    const { readUpstreamBody } = require(path.join(ROOT, 'src', 'domains', 'router', 'handlers', 'upstream-body.js'));
    const ub = Buffer.from('你好世界', 'utf8');
    const ur = Readable.from([ub.subarray(0, 5), ub.subarray(5)]);
    const t = await readUpstreamBody(ur, 65536, 2000);
    check('C-5 readUpstreamBody 跨 chunk 多字节不损坏', t === '你好世界', JSON.stringify(t));
    const ur2 = Readable.from([Buffer.from('0123456789')]);
    const t2 = await readUpstreamBody(ur2, 4, 2000);
    check('C-5 readUpstreamBody 尊重 maxBytes（累积不超界）', Buffer.byteLength(t2) <= 12 && t2.startsWith('0123'), JSON.stringify({ len: t2.length, v: t2 }));
  })();
}

console.log('== 批4 C-6 /open Set-Cookie SameSite=Strict ==');
check('C-6 /open 303 cookie 带 SameSite=Strict',
  /SameSite=Strict/.test(fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'instances.js'), 'utf8')), '有');

console.log('== 批4 C-7 isShellOrigin 单一事实源（CORS=CSRF 集合）==');
{
  const { isShellOrigin } = require(path.join(ROOT, 'src', 'api', 'security.js'));
  const cases = [
    ['tauri: + localhost', 'tauri:', 'localhost', true],
    ['tauri: + a.tauri.localhost', 'tauri:', 'a.tauri.localhost', true],
    ['tauri: + evil.tld', 'tauri:', 'evil.com', false],
    ['http: + tauri.localhost', 'http:', 'tauri.localhost', true],
    ['http: + x.tauri.localhost（通配已收紧）', 'http:', 'x.tauri.localhost', false],
    ['https: + tauri.localhost', 'https:', 'tauri.localhost', true],
    ['http: + localhost（浏览器页不放行）', 'http:', 'localhost', false],
    ['https: + evil', 'https:', 'evil.com', false],
  ];
  for (const [label, p, h, want] of cases) {
    const got = isShellOrigin(p, h);
    check('C-7 isShellOrigin ' + label + ' → ' + want, got === want, String(got));
  }
  const srv = fs.readFileSync(path.join(ROOT, 'src', 'api', 'transport', 'server.js'), 'utf8');
  check('C-7 server.js 委托 isShellOrigin', /isShellOrigin\(u\.protocol, u\.hostname\)/.test(srv), '有');
  check('C-7 server.js 不再自带通配字面量', !/endsWith\('\.tauri\.localhost'\)/.test(srv), '已删');
}

console.log('== 批4 C-8 isPrivateHostLiteral（SSRF 主机分级单一事实源）==');
{
  const { isPrivateHostLiteral } = require(path.join(ROOT, 'src', 'shared', 'ip.js'));
  const cases = [
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.1', true], ['192.168.9.9', true],
    ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true], ['224.0.0.1', true],
    ['localhost', true], ['a.local', true], ['a.internal', true], ['a.home.arpa', true],
    ['intranet', true], ['::1', true], ['[::1]', true], ['fd00::1', true], ['fe80::1', true],
    ['registry.npmjs.org', false], ['registry.npmmirror.com', false], ['8.8.8.8', false],
    ['a.example.com', false],
  ];
  for (const [h, want] of cases) {
    const got = isPrivateHostLiteral(h);
    check('C-8 isPrivateHostLiteral ' + h + ' → ' + want, got === want, String(got));
  }
  const policies = require(path.join(ROOT, 'src', 'platform', 'distribution', 'policies.js'));
  // 带 path 的基址是华为云/腾讯云镜像的常态形态，写入口放行；私网字面量仍拒。
  const vcases = [
    ['http://127.0.0.1:4873', true], ['http://169.254.169.254', true],
    ['https://registry.npmjs.org', false], ['https://registry.npmjs.org/path', false],
    ['https://repo.huaweicloud.com/repository/npm', false],
    ['ftp://a.example.com', true], ['http://u:p@a.example.com', true], ['https://x.test', false],
  ];
  for (const [o, wantReject] of vcases) {
    const got = policies.registryOriginViolation(o);
    check('C-8 registryOriginViolation ' + o + ' → ' + (wantReject ? '拒' : '放行'),
      (got !== null) === wantReject, got === null ? 'pass' : got);
  }
  check('C-8 setRegistryConfig 接线 registryOriginViolation',
    /registryOriginViolation\(/.test(fs.readFileSync(path.join(ROOT, 'src', 'platform', 'distribution', 'registry.js'), 'utf8')), '有');
}

console.log('== 批4 TK-3/条 5 令牌域形态钉（逐例 + 回显）==');
{
  const poolSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'token', 'pool.js'), 'utf8');
  check('TK-3 feedLine 隐式源必须先过 kind 登记闸（推断不出或未登记即拒）',
    /if \(!k \|\| !kinds\.isKnownKind\(k\)\) return null;/.test(poolSrc), '有');
  const core = require(path.join(ROOT, 'src', 'domains', 'relay', 'core.js'));
  check('条5 core 导出 lanGateCookieValue', typeof core.lanGateCookieValue === 'function', typeof core.lanGateCookieValue);
  check('条5 salt 缺省时拒绝签发（返回空串）', core.lanGateCookieValue('tok12345678', undefined) === '', JSON.stringify(core.lanGateCookieValue('tok12345678', undefined)));
  check('条5 token 缺省时拒绝签发（返回空串）', core.lanGateCookieValue('', 'salt') === '', JSON.stringify(core.lanGateCookieValue('', 'salt')));
  const v1 = core.lanGateCookieValue('tok12345678', 'salt-A');
  check('条5 派生值为 64hex（不含令牌原文）', /^[0-9a-f]{64}$/.test(v1) && !v1.includes('tok'), v1);
  check('条5 同 (token,salt) 幂等（cookie 可在进程内复用）', core.lanGateCookieValue('tok12345678', 'salt-A') === v1, v1);
  check('条5 换 salt 即换值（进程重启全员失效）', core.lanGateCookieValue('tok12345678', 'salt-B') !== v1, core.lanGateCookieValue('tok12345678', 'salt-B'));
  check('条5 换 token 即换值（门卫令牌轮换旧 cookie 立即失配）', core.lanGateCookieValue('tok87654321', 'salt-A') !== v1, 'diff');
  // tokenGateDecision：原文 cookie 不再等于放行
  const gate = core.tokenGateDecision(
    { url: 'http://x/', headers: { cookie: 'dsh_lan_token=tok12345678' } }, 'tok12345678', 'salt-A');
  check('条5 令牌原文冒充 cookie → unauthorized（旧实现此处 ok:true）',
    gate.ok === false && gate.unauthorized === true, JSON.stringify(gate));
  const gate2 = core.tokenGateDecision(
    { url: 'http://x/', headers: { cookie: 'dsh_lan_token=' + v1 } }, 'tok12345678', 'salt-A');
  check('条5 派生值 cookie → 放行', gate2.ok === true, JSON.stringify(gate2));
  const gate3 = core.tokenGateDecision(
    { url: 'http://x/?token=tok12345678', headers: {} }, 'tok12345678', 'salt-A');
  check('条5 首次 ?token= → 302 且所种 cookie 为派生值（非原文）',
    gate3.ok === false && gate3.redirect === '/' && gate3.cookie.includes('dsh_lan_token=' + v1) && !gate3.cookie.includes('tok12345678'),
    JSON.stringify(gate3));
  const proxySrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'proxy.js'), 'utf8');
  const tunnelSrc = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'tunnel.js'), 'utf8');
  check('条5 HTTP 路径传盐给 tokenGateDecision', /tokenGateDecision\(req, token, gateSalt\)/.test(proxySrc), '有');
  check('条5 WS 升级路径传盐给 hasValidToken', /hasValidToken\(req, getToken\(\), typeof getGateSalt === 'function' \? getGateSalt\(\) : undefined\)/.test(tunnelSrc), '有');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);