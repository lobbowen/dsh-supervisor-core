#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 第十三轮修复回归：三处「纪律只在一处执行」类缺陷（失效模式 g）
//
// ## 缺陷
//
// 1) P1 补丁层写队列被异常**永久毒化**（plugins.js）
//    两处入队都是 `this._bundleOpQueue = this._bundleOpQueue.then(fn)`，**无 catch**。
//    一次写盘异常（EACCES/EIO/ENOSPC）后队列变 rejected，此后每次 .then() 都跳过回调、
//    继续传播同一个 rejection -> 进程剩余生命周期内所有 enable/disable 写盘**根本不发生**，
//    卸载的 scrub 静默跳过而 uninstall 照常「报成功」，全程无日志。
//    同文件 _withScopeLock 正是正确写法（=.catch 续链）—— 纪律只执行了一条路径。
//
// 2) P1 删除实例与「进行中的升级作业」**无互斥**（instance/index.js::removeInstance）
//    其它三条路径都有 tasks.isBusy 互斥，唯独 removeInstance 没有 ->
//    升级到 npm install 时删除：内存先移除、rmSync 删目录，npm 又把 install/ 重建写入 ->
//    目录永留盘上而无清理路径（孤儿永久占盘）。
//
// 3) P3 令牌恢复文件权限**只在创建时收口**（token.js::_persistTokenFile）
//    appendFileSync 的 mode 仅对 O_CREAT 生效，对既有文件被忽略；
//    而注释声称「恢复文件 0600 私有」-> 若曾以 0644 落盘，每次轮换都把明文令牌
//    追加进世界可读文件（该令牌即可直连面板的会话凭据）。
//
// ## 门禁性质
//   1)2)为**行为级**（真实调用 + 桩内层）；3)为行为级（真实建文件 + 断言 mode）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-'));

(async () => {
  // -- 1) 补丁层写队列：异常后不得毒化 --
  console.log('== ① 补丁层写队列异常不毒化 ==');
  {
    // 步骤8a（DIRECTORY-STRUCTURE-DESIGN）：原 plugins.js 拆为
    //   index/ops/jobs/store（pluginmarket.js -> market.js），此处改指向域门面。
    const M = require(path.join(ROOT, 'src', 'domains', 'plugin'));
    const PM = M.PluginManager || M;
    const logs = [];
    const pm = new PM({ logger: { error: (m) => logs.push(String(m)), warn() {}, info() {} }, dist: null, tasks: null });

    let inner = 0;
    const origInner = pm._setBundleEnabledInner;
    void origInner;
    pm._setBundleEnabledInner = () => {
      inner++;
      if (inner === 1) throw new Error('boom-write-fail');
      return { ok: true, n: inner };
    };

    //  逐调用 try/catch：旧实现在此**抛 rejection**（队列已中毒）。若不接住，
    //   进程会直接崩掉、只留一个非零退出码而**没有可读的 FAIL 行** ——
    //   门禁要「清楚地失败」，不能只是崩。接住后由下面的断言如实报 FAIL。
    const call = async (fn) => { try { return await fn(); } catch (e) { return { __rejected: true, error: (e && e.message) || String(e) }; } };
    const r1 = await call(() => pm.setBundleEnabled('p1', false, 'native'));
    const r2 = await call(() => pm.setBundleEnabled('p2', false, 'native'));
    const r3 = await call(() => pm.setBundleEnabled('p3', false, 'native'));

    check('① 首次异常如实上报（不吞错）', r1 && r1.ok === false && /boom-write-fail/.test(r1.error || ''), JSON.stringify(r1));
    check('① 异常后第二次调用**仍执行内层**（旧实现被毒化 → 返回旧错误）',
      r2 && r2.ok === true && r2.n === 2, JSON.stringify(r2));
    check('① 第三次同样执行', r3 && r3.ok === true && r3.n === 3, JSON.stringify(r3));
    check('① 内层总调用次数 = 3（旧实现为 1）', inner === 3, String(inner));
    check('① 失败有日志（不静默）', logs.some((l) => /boom-write-fail/.test(l)), String(logs.length));

    // 卸载路径（_scrubPluginLayers）共用同一队列：异常同样不得毒化
    let scrubInner = 0;
    pm._scrubPluginLayersInner = () => { scrubInner++; if (scrubInner === 1) throw new Error('scrub-boom'); return { ok: true }; };
    const s1 = await call(() => pm._scrubPluginLayers('native', 'x', null));
    const s2 = await call(() => pm._scrubPluginLayers('native', 'x', null));
    check('① scrub 首次异常如实上报', s1 && s1.ok === false, JSON.stringify(s1));
    check('① scrub 异常后队列未毒化（第二次仍执行）', s2 && s2.ok === true && scrubInner === 2, String(scrubInner));

    // 反向：两条路径必须共用**同一**串行队列（否则丢更新防线失效）。
    //  域改造后补丁层写队列随 layers.js 搬移（SSOT：补丁层写 + 串行队列 + scrub）；
    //   原判据读私有字段 pm._bundleOpQueue（形态一变即失效/静默失真）-> 改为**行为判据**：
    //   让 setBundleEnabled 的内层先挂起，再发起 scrub；若共用同一队列，scrub 内层必须
    //   等 set 内层结束后才启动 —— 不依赖任何私有字段。
    {
      let releaseSet;
      const gate = new Promise((res) => { releaseSet = res; });
      const seq = [];
      pm._setBundleEnabledInner = async () => { seq.push('set:start'); await gate; seq.push('set:end'); return { ok: true }; };
      pm._scrubPluginLayersInner = async () => { seq.push('scrub:start'); return { ok: true }; };
      const pSet = pm.setBundleEnabled('p4', false, 'native');
      const pScrub = pm._scrubPluginLayers('native', 'x', null);
      await new Promise((res) => setTimeout(res, 20));
      check('① 反向：后一写不得越过前一写（共用串行队列）',
        seq.length === 1 && seq[0] === 'set:start', JSON.stringify(seq));
      releaseSet();
      await Promise.all([pSet, pScrub]);
      check('① 反向：两条路径共用同一队列（顺序 set→scrub）',
        seq.join(',') === 'set:start,set:end,scrub:start', JSON.stringify(seq));
    }
  }

  // -- 2) 删除实例与在飞作业互斥 --
  console.log('== ② removeInstance 与在飞作业互斥 ==');
  {
    const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
    //  域改造后 tasks/service 均在**构造期**注入（createOps/createLifecycle 捕获 ctx）——
    //   后置赋值 mgr.tasks 不再生效，且 removeInstance 经注入的 service 停单元；
    //   必须注入假 provider，绝不触碰开发机 systemd（迁移硬前置，见 SSOT）。
    let busy = true;
    const fakeService = {
      daemonReload() { return true; }, stopUnit() { return true; }, resetFailed() { return true; },
      isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {}, startTransient() { return true; },
    };
    const mgr = new InstanceManager({
      dir: path.join(TMP, 'sup'), logger: { info() {}, warn() {}, error() {} },
      tasks: { isBusy: () => busy }, service: fakeService,
    });
    mgr.instances = [{ id: 'i1', name: 'x', domain: 'sandbox', port: 0, state: { phase: 'STOPPED' } }];

    const r1 = mgr.removeInstance('i1');
    check('② 有在飞作业 → 拒绝删除（不静默）', r1 && r1.ok === false && /进行中/.test(r1.error || ''), JSON.stringify(r1));
    check('② 拒绝时**未**改动实例列表（不留半删状态）',
      mgr.instances.length === 1 && mgr.instances[0].id === 'i1', String(mgr.instances.length));

    // 作业结束后可正常删除
    busy = false;
    const r2 = mgr.removeInstance('i1');
    check('② 无在飞作业 → 允许删除', r2 && r2.ok === true, JSON.stringify(r2));
    check('② 删除后列表为空', mgr.instances.length === 0, String(mgr.instances.length));

    // 反向：不存在的实例仍报「实例不存在」（守卫不得掩盖该语义）
    const r3 = mgr.removeInstance('nope');
    check('② 反向：不存在的实例报「实例不存在」', r3 && r3.ok === false && /不存在/.test(r3.error || ''), JSON.stringify(r3));
  }

  // -- 2)-b：stopUnit 抛「平台不支持」时，删除**不得崩溃** --
  //
  //    （P1）：这条是本轮**由 macOS runner 逼出来**的缺陷 ——
  //     当时 platform/os/service.js 的 makeUnsupported（macOS launchd / Windows 服务 / 未知平台）
  //     其 stopUnit() **直接 throw CapabilityError**，而 removeInstance 原先假定它「不抛」->
  //     在 mac/win 上**每次删除都抛未捕获异常**（删除整体失败）。
  //   W3 起 mac/win 落 portable（不抛），但「会抛的 stopUnit」仍是未知平台 NONE 与嵌入方的
  //   真实形状，该回归拦截保留。这里显式注入一个「会抛的 stopUnit」，
  //   于是**在 Linux 上也能拦住**该回归，不必等到 mac/win runner。
  console.log('== ②-b stopUnit 抛能力异常时删除不崩 ==');
  {
    const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
    // 经**构造期注入**伪造平台服务（本仓约定：显式注入，而非 patch 模块导出 ——
    // 后者在值绑定时会静默失效并跑真实副作用，故 test-safety-gate 的 A 条明确禁止）。
    const m2 = new InstanceManager({
      dir: path.join(TMP, 'sup2'),
      logger: { info() {}, warn() {}, error() {} },
      tasks: { isBusy: () => false },
      service: {
        stopUnit() { throw new Error('CapabilityError: 测试注入（模拟无服务管理器的平台形状）'); },
        isUnitActive() { return false; },
      },
    });
    m2.instances = [{ id: 'i9', name: 'x', domain: 'sandbox', port: 0, state: { phase: 'STOPPED' } }];
    let threw = null; let out = null;
    try { out = m2.removeInstance('i9'); } catch (e) { threw = e; }
    check('②-b stopUnit 抛能力异常时删除不得崩溃（未知平台/嵌入方真实情形）',
      threw === null && out && out.ok === true,
      threw ? ('崩溃: ' + threw.message) : JSON.stringify(out));
  }

  // -- 3) 令牌恢复文件权限收口 --
  console.log('== ③ 令牌恢复文件 mode 收口 ==');
  {
    //令牌持久化已随令牌组件目录化迁至 src/platform/service/token/persist.js
    //   （原 DshTokenService._persistTokenFile 的内部实现 -> appendByRotation）。
    //   本断言的**意图不变**：写后显式 chmod 收口（mode 只对新建生效）+ 超限轮转而非清空。
    const T = require(path.join(ROOT, 'src', 'platform', 'service', 'token', 'persist.js'));
    check('③ 定位到令牌持久化实现 appendByRotation', typeof T.appendByRotation === 'function');
    const appendByRotation = T.appendByRotation;
    const fp = path.join(TMP, 'token.log');
    //**POSIX 权限位在 Windows 上不存在**。
    //   Node 的 fs.chmodSync 在 Windows 只能切换**只读位**，statSync().mode 恒为 0666/0444 ——
    //   故「收口到 0600」这类断言在 Windows 上既不可能成立、也无意义
    //   （Windows 用 ACL 而非 mode 表达「世界可读」）。
    //   这是**测试夹具的平台限制**，不是产品缺陷（产品侧 chmodSync(fp,0o600) 在 POSIX 上
    //   仍正确且必要）。故 POSIX 做完整权限断言，Windows 只验功能并**显式说明**（不静默变绿）。
    const POSIX = process.platform !== 'win32';
    if (!POSIX) console.log('SKIP ③ 权限位断言（Windows 无 POSIX mode；chmodSync 仅切换只读位）');

    // 场景 A：既有文件为 0644 -> 写入后必须收口到 0600
    fs.writeFileSync(fp, 'old-line\n');
    if (POSIX) fs.chmodSync(fp, 0o644);
    if (POSIX) check('③ 前提：预置文件为 0644', (fs.statSync(fp).mode & 0o777) === 0o644, (fs.statSync(fp).mode & 0o777).toString(8));
    appendByRotation(fp, 'http://127.0.0.1:3080/?token=ABC');
    if (POSIX) check('③ 写入既有 0644 文件后 mode 收口为 0600（旧实现仍 644，世界可读）',
      (fs.statSync(fp).mode & 0o777) === 0o600, (fs.statSync(fp).mode & 0o777).toString(8));
    check('③ 令牌行确实追加（功能未受影响）',
      /token=ABC/.test(fs.readFileSync(fp, 'utf8')), 'ok');

    // 场景 B：新建文件也必须 0600
    const fp2 = path.join(TMP, 'token-new.log');
    appendByRotation(fp2, 'http://127.0.0.1:3080/?token=NEW');
    if (POSIX) check('③ 新建文件为 0600', (fs.statSync(fp2).mode & 0o777) === 0o600, (fs.statSync(fp2).mode & 0o777).toString(8));
    check('③ 新建文件也写入成功（跨平台功能）', /token=NEW/.test(fs.readFileSync(fp2, 'utf8')), 'ok');

    // 场景 C：较宽权限（0666）也必须收口
    const fp3 = path.join(TMP, 'token-wide.log');
    fs.writeFileSync(fp3, 'x\n');
    if (POSIX) fs.chmodSync(fp3, 0o666);
    appendByRotation(fp3, 'http://127.0.0.1:3080/?token=W');
    if (POSIX) check('③ 0666 也收口为 0600', (fs.statSync(fp3).mode & 0o777) === 0o600, (fs.statSync(fp3).mode & 0o777).toString(8));
    // 3)-b：**chmod 确实被调用**（平台无关的结构断言）——
    //   弥补 Windows 上无法做权限断言的缺口：只要「写后显式收口」这一纪律还在，
    //   POSIX 平台就会真正收口；Linux/macOS 的行为断言同时保证它没退化。
    //  本文件没有 read() 助手（其余门禁文件才有）——直接用 fs 读，避免 ReferenceError。
    const tokenSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'token', 'persist.js'), 'utf8');
    check('③-b 持久化后显式 chmodSync 收口（mode 选项只对新建生效）',
      /appendFileSync\([\s\S]{0,500}?chmodSync\(fp,\s*0o600\)/.test(tokenSrc), '有');
    // 3)-c（TK-6 配套）：超限必须**轮转**，不得清空式删除——那是唯一持久链路。
    //  判据必须**去注释**：persist.js 的注释里正记录着"旧实现 rmSync(fp) 清空"这一历史缺陷，
    //   若连注释一起匹配会把"记录教训"误判成"仍在犯"（本仓已有多次此类假阳性）。
    const tokenCode = tokenSrc.split(String.fromCharCode(10))
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join(String.fromCharCode(10));
    check('③-c 超限走轮转（rotate*）而非删除',
      /rotateByBackup/.test(tokenCode) && !/\brmSync\s*\(/.test(tokenCode), '有');
    // 3)-d：轮转必须「原子改名抢占」而非「读->写->截断」——
    //   旧实现在 read 与 truncate 之间的跨进程追加行既进不了备份也会被截断抹掉。
    //   用「先持有旧 fd、轮转后再写」确定性地复现该窗口：rename 语义下迟到行落进备份本体（不丢）。
    const fpD = path.join(TMP, 'token-rotate.log');
    fs.writeFileSync(fpD, 'OLD-LINE http://127.0.0.1:3080/?token=OLD\n');
    const fdOld = fs.openSync(fpD, 'a'); // 模拟并发写者已打开的 fd
    const rD = appendByRotation(fpD, 'http://127.0.0.1:3080/?token=NEW', { maxBytes: 1 });
    check('③-d 前提：超限追加报告已轮转', rD.ok === true && rD.rotated === true, JSON.stringify(rD));
    fs.writeSync(fdOld, 'RACE-LINE http://127.0.0.1:3080/?token=RACE\n'); // 「窗口内」迟到追加
    fs.closeSync(fdOld);
    const bakAll = ['.bak-0', '.bak-1'].map((s) => { try { return fs.readFileSync(fpD + s, 'utf8'); } catch { return ''; } }).join('');
    const fpNow = fs.readFileSync(fpD, 'utf8');
    check('③-d 备份槽携带轮转前旧内容', /token=OLD/.test(bakAll), JSON.stringify(bakAll.slice(0, 120)));
    check('③-d 轮转窗口期的并发追加不丢失（旧实现此断言必红：截断抹掉）',
      /token=RACE/.test(bakAll + fpNow), 'bak+fp=' + String(bakAll + fpNow).replace(/\n/g, '|'));
    check('③-d 轮转后本次新行落入目标新文件', /token=NEW/.test(fpNow), JSON.stringify(fpNow));
    check('③-d 形态：rotate 以 renameSync 抢占（截断仅作降级路径）',
      /renameSync\(fp, slot\)/.test(tokenCode), '有');
  }

  // -- ④ B2-5 实例启动预校验：配置端口被他进程（lan-daemon relay）登记 -> 显式 PORT_TAKEN:<by> --
  //   静默端口（登记了但没有监听者）TCP 探测不可见，旧行为放任到 systemd 起舱后才以
  //   bind 失败暴露，面板无从定位。注册表是跨进程共享事实源，判据只在册不在听。
  console.log('== ④ B2-5 启动预校验 PORT_TAKEN ==');
  {
    const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
    const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports')).shared;
    ports.configureFile(path.join(TMP, 'r13-ports.json')); // 本测试进程的注册表指到独立文件，绝不触真实状态根
    const GiB = (n) => n * 1024 * 1024 * 1024;
    const P4 = 28320; // 安全段内、_ports 已登记段之外（防撞号）
    let started = 0;
    const fakeService = {
      daemonReload() { return true; }, stopUnit() { return true; }, resetFailed() { return true; },
      isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {},
      startTransient() { started++; return true; },
    };
    const mgr = new InstanceManager({
      dir: path.join(TMP, 'sup4'), logger: { info() {}, warn() {}, error() {} },
      tasks: { isBusy: () => false }, service: fakeService,
      machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
    });
    mgr._setSandboxSupportedForTest(true);
    const inst4 = () => ({ id: 'b25', name: 'x', domain: 'native', port: P4, state: { phase: 'STOPPED' } });
    mgr.instances = [inst4()];

    ports.allocateMark(P4, 'relay', 'relay:thief'); // lan-daemon 侧已把该端口登记给 relay（无监听）
    const r4a = await mgr.startInstance('b25');
    check('④ 端口被他方登记 → 立即 PORT_TAKEN:<by> 显式拒绝（不等 systemd bind 失败、不下发启动）',
      r4a && r4a.ok === false && r4a.error === 'PORT_TAKEN:relay:thief' && started === 0,
      JSON.stringify(r4a) + ' started=' + started);

    // 反向（判据不误伤）：自有登记（syncPorts 的 inst:<id> 形态）照常放行
    ports.release(P4);
    ports.registerUser(P4, 'inst:b25');
    const r4b = await mgr.startInstance('b25');
    check('④ 反向：自有 inst:<id> 登记不误判，正常走到下发', r4b && r4b.ok === true && started === 1,
      JSON.stringify(r4b) + ' started=' + started);

    // 行为留痕：拒绝时 lastError 落库（BACKOFF/面板可见），不再是静默无痕
    ports.release(P4);
    ports.allocateMark(P4, 'relay', 'relay:thief');
    await mgr.startInstance('b25');
    check('④ 拒绝原因写入实例 state.lastError（失败可追）',
      /PORT_TAKEN/.test(mgr.instances[0].state.lastError || ''), String(mgr.instances[0].state.lastError));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.error('ERR', e);
  process.exit(1);
});
