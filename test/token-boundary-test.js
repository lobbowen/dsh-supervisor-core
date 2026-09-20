#!/usr/bin/env node
'use strict';

// 令牌边界回归（2026-09，docs/token-management.md）：
//  - supervisor.listLan() 输出剔除 token/dshToken（/lan-access 允许 LAN 访问，防会话令牌泄漏）
//  - InstanceManager.load 剔除历史遗留 dshToken 列（会话令牌不落盘）
//  - /status 仅暴露 dshTokenCaptured 布尔
// 自包含：构造测试 Supervisor（tmp 状态）+ 覆写 lan 存根，不触碰真实 daemon/账号。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'token-boundary-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}

function buildSupervisor() {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '/nonexistent/bin/dsh', 'web'],
    healthUrl: 'http://127.0.0.1:28210/',
    apiHost: '127.0.0.1', apiPort: 28211,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'upg.log'),
    logLevel: 'error',
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  return new Supervisor(cfg, cfgPath);
}

async function main() {
  console.log('== 令牌边界：listLan 输出不含会话令牌 ==');
  {
    const sup = buildSupervisor();
    // 本地模式：覆写 lan.list() 返回带 token/dshToken 的伪造项（模拟 relay 缓存内字段）
    sup.lan = {
      list: () => ({ items: [{ id: 'inst-x', name: 'x', dshPort: 3081, wanPort: 28213, token: 'lan-gate-key', dshToken: 'SECRETSESSIONTOKEN', enabled: true, localPort: 1, running: true }], addresses: ['192.168.3.64'] }),
    };
    const r = sup.listLan();
    const it = r.items && r.items[0];
    check('listLan 保留结构字段', !!it && it.id === 'inst-x' && it.wanPort === 28213);
    check('listLan 剔除 remoteToken', !!it && !Object.prototype.hasOwnProperty.call(it, 'token'));
    check('listLan 剔除 dshToken', !!it && !Object.prototype.hasOwnProperty.call(it, 'dshToken'));
    // 白名单（2026-09 扩展）：新增 frpEnabled/frpRemotePort/tokenSet —— 均为**非机密**
    //   （布尔与端口号；tokenSet 只表明「令牌已设」，绝不含明文），用于 UI 呈现公网暴露开关。
    //   机密字段（token/dshToken/remoteToken）仍被剔除（上方两条断言继续守护）。
    const ALLOWED = ['dshPort','enabled','frpEnabled','frpRemotePort','id','localPort','name','running','tokenSet','wanPort'].sort().join(',');
    check('listLan 白名单恰为已知非机密字段', Object.keys(it).sort().join(',') === ALLOWED, Object.keys(it).sort().join(','));
  }

  console.log('== 令牌边界：注入状态 inject 透传（不含令牌）==');
  {
    const sup = buildSupervisor();
    sup.lan = {
      list: () => ({ items: [{ id: 'inst-r', name: 'r', dshPort: 3081, wanPort: 28213, token: 'k', dshToken: 'SECRET', enabled: true, localPort: 1, running: true, inject: { tokenSet: true, cookieReady: true, lastOkAt: 1, lastError: null, lastErrorAt: null } }], addresses: [] }),
    };
    const it = sup.listLan().items[0];
    check('inject 透传 cookieReady', !!it.inject && it.inject.cookieReady === true && it.inject.tokenSet === true);
    check('inject 透传仍无令牌', !!it.inject && !Object.prototype.hasOwnProperty.call(it, 'dshToken') && !Object.prototype.hasOwnProperty.call(it, 'token'));
  }

  console.log('== 令牌边界：L3b 门面路径同样剔除 ==');
  {
    const sup = buildSupervisor();
    // daemon 门面：listLan 经 ctl 后 sanitize——以假 Promise 覆写 _lanCtlCall 验证
    // 2026-09 结构单写后 daemon 门面由 lanDaemonEnabled() 判定（lanApi/API 方法均改判该）；测试 mock 对应
    sup.lanDaemonEnabled = () => true;
    sup._lanCtlCall = () => Promise.resolve({ items: [{ id: 'inst-y', dshPort: 3082, wanPort: 28214, dshToken: 'SECRET2' }], addresses: [] });
    const r = await sup.listLan();
    check('门面路径剔除 dshToken', r.items.length === 1 && !Object.prototype.hasOwnProperty.call(r.items[0], 'dshToken'));
  }

  console.log('== 令牌边界：instances.json 遗留 dshToken 列剔除 ==');
  {
    fs.writeFileSync(path.join(TMP, 'instances.json'), JSON.stringify({ instances: [{ id: 's1', name: 's', port: 28212, domain: 'sandbox', remoteEnabled: false, dshToken: 'STALEVALUE' }] }));
    const sup = buildSupervisor();
    sup.instances.load();
    const inst = sup.instances.instances.find((x) => x.id === 's1');
    check('load 后内存无 dshToken', inst && !Object.prototype.hasOwnProperty.call(inst, 'dshToken'), inst && Object.keys(inst));
  }

  console.log('== 令牌边界：tokenService 捕获后仅经 get/onChange 分发（模拟单节点语义）==');
  {
    const sup = buildSupervisor();
    let pushed = null;
    const unsub = sup.tokenService.onChange((id, tok) => { pushed = { id, tok }; });
    // 批 4 令牌条 3（TK-3）：attach 必须给可登记的分类（显式 kind；unit 留空以隔离 journal 档，
    //   本用例只测 stdout 链路）——旧写法 {unit:null} 下 attach 实为静默失败，
    //   捕获全靠 feedLine 的隐式源旁路（正是 TK-3 要封的洞）。
    check('B4-3 attach(dsh-instance) 登记成功（前置）', sup.tokenService.attach('inst-z', { kind: 'dsh-instance', unit: null }) === true);
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=AbC123');
    check('feedLine 捕获成功', sup.tokenService.get('inst-z') === 'AbC123');
    check('onChange 广播', pushed && pushed.id === 'inst-z' && pushed.tok === 'AbC123', pushed);
    // 轮换收敛=同值不广播：置空后重喂同值，回调不得再触发
    pushed = null;
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=AbC123');
    check('重复相同令牌不重复广播（轮换收敛）', pushed === null, '未再广播');
    // 取消订阅生效：退订后任何新值广播都不得回调
    unsub();
    pushed = null;
    sup.tokenService.feedLine('inst-z', 'dsh web: http://127.0.0.1:3081/?token=ZzZ999');
    check('取消订阅生效（后续广播不再回调）', pushed === null, '未回调');
  }

  console.log('== 令牌边界：clear() 必须同步清空 stdout 残留行（TK-1 死令牌回灌，AUDIT B-3）==');
  {
    const sup = buildSupervisor();
    sup.tokenService.attach('inst-w', { kind: 'dsh-instance', unit: null }); // B4-3：合规分类登记（同上）
    sup.tokenService.feedLine('inst-w', 'dsh web: http://127.0.0.1:3081/?token=OLD999');
    check('清除前 capture 正常（前置状态）', sup.tokenService.get('inst-w') === 'OLD999');
    sup.tokenService.clear('inst-w');
    check('clear 后 get 为空串（TK-8 失效已广播）', sup.tokenService.get('inst-w') === '');
    const revived = sup.tokenService.capture('inst-w');
    check('capture() 不得从残留行复活旧令牌（旧实现第 0 拍即命中 OLD999 记为新 gen）',
      !revived, String(revived));
    check('复活判定防空转：池清空后仍是空', sup.tokenService.get('inst-w') === '');
    sup.tokenService.feedLine('inst-w', 'dsh web: http://127.0.0.1:3081/?token=NEW111');
    check('clear 后重喂新行仍可捕获（链路未被清死，TK-1 恒通）', sup.tokenService.get('inst-w') === 'NEW111');
  }

  console.log('== 令牌边界：批4 条3 feedLine 未 attach 旁路封堵（TK-3）==');
  {
    const sup = buildSupervisor();
    // 既未 attach、inferKind 又推不出（id 不在 byId、无 unit/file）→ feedLine 必须拒绝入池。
    const r = sup.tokenService.feedLine('ghost-id', 'dsh web: http://127.0.0.1:3081/?token=GHOST');
    check('B4-3 无法分类的未 attach 源：feedLine 不入池（get 为空）', r === null && sup.tokenService.get('ghost-id') === '', String(r) + '/' + sup.tokenService.get('ghost-id'));
  }

  console.log('== 令牌边界：批4 条4 journal 捕获异步化（不阻塞心跳）==');
  {
    const fsx = require('node:fs');
    const capPath = path.join(ROOT, 'src', 'platform', 'service', 'token', 'capture.js');
    const capSrc = fsx.readFileSync(capPath, 'utf8').split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join(String.fromCharCode(10));
    check('B4-4 capture.js 不再同步 exec（无 ex.runOut/execFileSync，改 runOutAsync）',
      !/\.runOut\s*\(/.test(capSrc) && !/execFileSync/.test(capSrc) && /runOutAsync/.test(capSrc), '有 runOutAsync');
    check('B4-4 capture.js 暴露异步 journal 档 captureJournal', /function captureJournal/.test(capSrc) && /captureJournal/.test(fsx.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'token', 'pool.js'), 'utf8')), '有');
    const exSrc = fsx.readFileSync(path.join(ROOT, 'src', 'platform', 'util', 'exec.js'), 'utf8');
    check('B4-4 exec 提供 runOutAsync（异步唯一子进程入口仍收口于此文件）',
      /function runOutAsync/.test(exSrc) && /require\('node:child_process'\)/.test(exSrc), '有');
    // 行为：journal 档不得阻塞——给一个必然查无的 unit，capture() 同步立即返回（不挂 5s）。
    const sup = buildSupervisor();
    sup.tokenService.attach('inst-j', { kind: 'dsh-instance', unit: 'nonexistent-unit-zz' });
    const t0 = Date.now();
    const hit = sup.tokenService.capture('inst-j');
    const dt = Date.now() - t0;
    check('B4-4 capture() 同步返回不等 journal（<50ms，不冻结心跳）', dt < 50, dt + 'ms 返回=' + hit);
  }


  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });
