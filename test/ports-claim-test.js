#!/usr/bin/env node
'use strict';

// 确定性槽位仲裁 claimSlot 回归：
//  byOwner 绑定复用 / binding-lost 迁移(显式) / preferred advisory 回退 / 顺序补位 / 单 owner 单端口
// 隔离 range（28130+50）-> 确定性，不依赖宿主真实 relay 段占用。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-claim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const RANGE = { base: 28130, count: 50 };

(async () => {
  const { PortRegistry } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  const ports = new PortRegistry({ file: path.join(TMP, 'ports.json') });
  const claim = (owner, pref, extra) => ports.claimSlot('relay', owner, Object.assign({ range: RANGE }, pref ? { preferred: pref } : {}, extra || {}));

  console.log('== 确定性分配（preferred + 顺序补位）==');
  const m = await claim('relay:main', RANGE.base);
  check('main → base（preferred）', m && m.port === RANGE.base && !m.conflict, JSON.stringify(m));
  const a = await claim('relay:instA');
  check('instA → base+1', a && a.port === RANGE.base + 1, JSON.stringify(a));
  const b = await claim('relay:instB');
  check('instB → base+2（顺序补位）', b && b.port === RANGE.base + 2, JSON.stringify(b));

  console.log('== byOwner 复用（绑定持久，重启不漂移）==');
  const m2 = await claim('relay:main', RANGE.base);
  check('main 再 claim → 复用 base（binding）', m2 && m2.port === RANGE.base && m2.binding === true && !m2.bindingLost, JSON.stringify(m2));
  const b2 = await claim('relay:instB');
  check('instB 再 claim → 复用 base+2', b2 && b2.port === RANGE.base + 2, JSON.stringify(b2));

  console.log('== 删除后补位 + 单 owner 单端口 ==');
  ports.unregister('relay:instA');
  const c1 = await claim('relay:instC');
  check('A 释放后 instC → 补 base+1', c1 && c1.port === RANGE.base + 1, JSON.stringify(c1));
  const recs = ports.list().map((r) => r.port + ':' + r.owner);
  check('无重复端口、每 owner 一条', recs.length === new Set(recs.map((s) => s.split(':')[0])).size && recs.length === new Set(recs).size, JSON.stringify(recs));

  console.log('== inst.wanPort 持久绑定优先 ==');
  const d = await claim('relay:instD', RANGE.base + 7);
  check('instD 按 preferred 绑定 base+7', d && d.port === RANGE.base + 7, JSON.stringify(d));
  const d2 = await claim('relay:instD');
  check('instD 再 claim → 复用 base+7（绑定持久）', d2 && d2.port === RANGE.base + 7 && d2.binding === true, JSON.stringify(d2));

  console.log('== preferred advisory：被其它 owner 占 → 回退最小空闲，不中断 ==');
  ports._records.set(RANGE.base + 20, { port: RANGE.base + 20, role: 'relay', owner: 'relay:OTHER', createdAt: Date.now() });
  const fallback = await claim('relay:instE', RANGE.base + 20);
  check('preferred 被异 owner 占 → 回退最小空闲（服务不中断）', fallback && !fallback.conflict && fallback.port !== RANGE.base + 20 && fallback.port >= RANGE.base, JSON.stringify(fallback));
  const recE = ports.list().find((r) => r.owner === 'relay:instE');
  check('instE 回退后已登记（绑定持久化）', !!recE && recE.port === fallback.port, JSON.stringify(recE));

  console.log('== binding 被盗（持久绑定记忆被异 owner 抢注）→ 迁移 + bindingLost 显式 ==');
  // main 持久绑定 base（bindingPreferred）；THIEF 抢注 base 记录
  ports._records.set(RANGE.base, { port: RANGE.base, role: 'relay', owner: 'relay:THIEF', createdAt: Date.now() });
  let lost = null;
  const mig = await ports.claimSlot('relay', 'relay:main', {
    range: RANGE, preferred: RANGE.base, bindingPreferred: true,
    onBindingLost: (x) => { lost = x; },
  });
  check('绑定被盗 → 迁移 + bindingLost 事件（不静默）', mig && !mig.conflict && mig.bindingLost === true && mig.from === RANGE.base && !!lost && lost.to === mig.port, JSON.stringify(mig) + ' lost=' + JSON.stringify(lost));
  const recMain = ports.list().find((r) => r.owner === 'relay:main');
  check('main 已迁移并登记新端口', !!recMain && recMain.port === mig.port && recMain.port !== RANGE.base, JSON.stringify(recMain));

  // B2-5 契约：注册表是多进程共享事实源（守卫 + lan-daemon 同写 ports.json）。
  //   写口/冲突判读口进入前按指纹（mtime+size）自动对时——「阶段三」手动 reload 前的
  //   陈旧快照语义**已废止**；「以文件为 truth、未落盘内存记录丢弃」保留。
  {
    const p2 = new PortRegistry({ file: path.join(TMP, 'ports-resync.json') });
    await p2.claimSlot('relay', 'owner-A', { range: RANGE });
    const pA = p2.byOwner('owner-A');
    // 模拟另一进程（独立实例）向同一文件写入新记录
    const pOther = new PortRegistry({ file: path.join(TMP, 'ports-resync.json') });
    const slotB = await pOther.claimSlot('relay', 'owner-B', { range: RANGE });
    check('RS-auto-1 外部进程新增记录无需手动 reload 即可见（B2-5 自动对时）',
      !!slotB && p2.byOwner('owner-B') === slotB.port, String(p2.byOwner('owner-B')));
    check('RS-auto-2 对时后既有绑定不丢', p2.byOwner('owner-A') === pA, String(p2.byOwner('owner-A')));
    // 反向（判据非空转）：只改内存不落盘 -> 对时后仍被丢弃（文件 truth 语义未被削弱）
    p2._records.set(RANGE.base + 45, { port: RANGE.base + 45, role: 'relay', owner: 'owner-ghost', createdAt: Date.now() });
    await pOther.claimSlot('relay', 'owner-C', { range: RANGE }); // 外部再写一版文件
    check('RS-auto-3 反向：未落盘的内存注入对时后丢弃（以文件为准）',
      p2.byOwner('owner-ghost') === null, String(p2.byOwner('owner-ghost')));
    check('RS-auto-4 显式 reload() 仍作为强制重载 API 可用',
      (p2.reload(), p2.byOwner('owner-B') === slotB.port), 'ok');
  }

  // -- B14：IPv6-only 监听不再漏判 + 跨进程分配锁 + 登记后复检 --
  {
    const net = require('node:net');
    const probe = require(path.join(ROOT, 'src', 'platform', 'service', 'ports', 'probe'));
    const utilProbe = require(path.join(ROOT, 'src', 'platform', 'util', 'probe'));
    const RANGE2 = { base: 28200, count: 20 };
    const p6 = new PortRegistry({ file: path.join(TMP, 'ports-v6.json') });

    // 占用者：只 bind '::1'（IPv6-only，bindv6only 语义下的典型形态）
    const occ = net.createServer();
    const v6Ok = await new Promise((res) => {
      occ.once('error', () => res(false));
      occ.listen(RANGE2.base + 3, '::1', () => res(true));
    });
    if (v6Ok) {
      check('B14 isTaken 识出 IPv6-only 监听者（旧实现只连 127.0.0.1 → 漏判）',
        (await p6.isTaken(RANGE2.base + 3)) === true, 'taken');
      check('B14 反向：util 层单栈探测对同一端口确实漏判（判据非空转）',
        (await utilProbe.portListening('127.0.0.1', RANGE2.base + 3, 300)) === false, '单栈漏判=预期');
      check('B14 bindable 拒绝 IPv6-only 已占端口（旧实现 bind 127.0.0.1 会成功）',
        (await probe.bindable(RANGE2.base + 3)) === false, 'false');
      const got = await p6.claimSlot('relay', 'relay:v6owner', { range: RANGE2 });
      check('B14 claimSlot 绕开 IPv6-only 占用端口', !!got && got.port !== RANGE2.base + 3 && !got.conflict, JSON.stringify(got));
      occ.close();
    } else {
      console.log('SKIP B14 IPv6 探针：本机 ::1 不可绑定（无 IPv6 栈）');
      try { occ.close(); } catch {}
    }
    // bindable：真实 IPv4 监听者仍被拒
    const occ4 = net.createServer();
    await new Promise((res) => { occ4.once('error', res); occ4.listen(RANGE2.base + 9, '127.0.0.1', res); });
    check('B14 bindable 拒绝 IPv4 已占端口', (await probe.bindable(RANGE2.base + 9)) === false, 'false');
    occ4.close();

    // 跨进程锁存在性：模拟并发者持锁（fresh mtime）-> 本次分配不崩、fail-open 结果仍正确
    const lockF = path.join(TMP, 'ports-xlock.json') + '.alloc.lock';
    const px = new PortRegistry({ file: path.join(TMP, 'ports-xlock.json') });
    fs.writeFileSync(lockF, String(process.pid));
    const t0 = Date.now();
    const slot = await px.claimSlot('relay', 'relay:xlock', { range: RANGE2 });
    check('B14 持锁者在场：claimSlot 超时后 fail-open 仍完成分配（不冻结）',
      !!slot && slot.port > 0 && Date.now() - t0 >= 1000, 'took ' + (Date.now() - t0) + 'ms slot=' + JSON.stringify(slot));
    fs.unlinkSync(lockF);
    // 老化接管：stale 锁（mtime 远超窗口）可被接管，分配照常
    fs.writeFileSync(lockF, '999999');
    fs.utimesSync(lockF, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const slot2 = await px.claimSlot('relay', 'relay:xlock2', { range: RANGE2 });
    check('B14 stale 锁被老化接管（持有者崩溃不死锁）', !!slot2 && slot2.port > 0 && slot2.port !== slot.port, JSON.stringify(slot2));
    // 正常路径：锁在临界区被创建、释放后不残留
    const px2 = new PortRegistry({ file: path.join(TMP, 'ports-xlock3.json') });
    await px2.claimSlot('relay', 'relay:clean', { range: { base: 28230, count: 10 } });
    check('B14 正常分配后不残留 .alloc.lock', !fs.existsSync(path.join(TMP, 'ports-xlock3.json') + '.alloc.lock'), 'clean');
    check('B14 源码：alloc.js 使用 wx 独占创建锁 + 复检撤销',
      /'wx'/.test(fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'ports', 'alloc.js'), 'utf8'))
      && /_confirmRegister/.test(fs.readFileSync(path.join(ROOT, 'src', 'platform', 'service', 'ports', 'alloc.js'), 'utf8')), '有');
  }

  // == KI1：固定 role 全表唯一 —— 避让/重绑后「按 role 取号」不许拿到没人监听的僵尸端口 ==
  {
    const SOLE = 'supervisor-api';
    const pA = safePort('ports-claim', 4);
    const pB = safePort('ports-claim', 5);
    const pOld = safePort('ports-claim', 6);
    const pNew = safePort('ports-claim', 7);
    const pMain = safePort('ports-claim', 8);
    const sp = new PortRegistry({ file: path.join(TMP, 'ports-sole.json') });
    sp.register(SOLE, pA);
    sp.registerSole(SOLE, pB);
    const after = sp.list().filter((r) => r.role === SOLE);
    check('KI1 registerSole 换端口后同 role 只剩一条', after.length === 1 && after[0].port === pB, JSON.stringify(after));
    check('KI1 get(role) 指向新端口', sp.get(SOLE) === pB, String(sp.get(SOLE)));
    sp.reload();
    check('KI1 唯一性落盘（桌面壳读同一文件，看不到僵尸端口）',
      sp.list().filter((r) => r.role === SOLE).length === 1, JSON.stringify(sp.list()));
    sp.register('dsh-main', pMain);
    sp.registerSole(SOLE, pB);
    check('KI1 registerSole 只清同 role，不误删其它固定端口',
      sp.get('dsh-main') === pMain && sp.get(SOLE) === pB, JSON.stringify(sp.list()));

    // 反向样本：老版本（避让只追加记录、release 被 catch 吞掉）留下的双记录仍在表内。
    // 判据必须取**最新登记**，且要能证明「首个命中即返回」的老读法会取错——否则本条空转。
    const sz = new PortRegistry({ file: path.join(TMP, 'ports-zombie.json') });
    sz._records.set(pOld, { port: pOld, role: SOLE, owner: 'system:' + SOLE, createdAt: 1 });
    sz._records.set(pNew, { port: pNew, role: SOLE, owner: 'system:' + SOLE, createdAt: 2 });
    check('KI1 残留双记录时 get(role) 取最新登记', sz.get(SOLE) === pNew, String(sz.get(SOLE)));
    check('KI1 反向：老读法「首个命中」确实会取到僵尸端口 ' + pOld + '（判据非空转）',
      [...sz._records.values()].find((r) => r.role === SOLE).port === pOld, '首命中');
    sz.registerSole(SOLE, pNew);
    check('KI1 registerSole 能把老版本留下的僵尸记录清掉（升级后自愈）',
      sz.list().filter((r) => r.role === SOLE).length === 1 && sz.get(SOLE) === pNew, JSON.stringify(sz.list()));
  }

  // == B2-5 跨进程夹具：两个真 node 进程共写同一 ports.json，B（常驻方）不得抢注/丢写
  //    A 侧「已配置但停止」的端口（静默端口 TCP 探测不可见，注册表是唯一可见性来源）。
  //    双本账（ports-lan.json）与陈旧快照语义下此夹具必红——本段即该缺陷的牙齿。 ==
  {
    const { spawn } = require('node:child_process');
    const XF = path.join(TMP, 'ports-xproc.json');
    const XB = 28310; // 避开 _ports.js 全部已登记段（28000+27*10-1=28269 以内）
    fs.rmSync(XF, { force: true });
    // 子进程：构造注册表（此刻 A 尚未登记任何记录 => 真正陈旧的快照），READY 后等 stdin 一发令即 claim。
    const CHILD = [
      'const { PortRegistry } = require(' + JSON.stringify(path.join(ROOT, 'src', 'platform', 'service', 'ports', 'index.js')) + ');',
      'const reg = new PortRegistry({ file: process.argv[1] });',
      'console.log("READY");',
      'process.stdin.once("data", async () => {',
      '  const r = await reg.claimSlot("relay", "relay:longlive", { range: { base: ' + XB + ', count: 5 } });',
      '  console.log("RESULT:" + JSON.stringify(r));',
      '  process.exit(0);',
      '});',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', CHILD, XF], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const deadline = Date.now() + 15000;
    while (out.indexOf('READY') < 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    check('B2-5 夹具启动：B 侧进程就绪（其注册表快照早于 A 侧登记）', out.indexOf('READY') >= 0, out.slice(0, 80));
    // A 进程：登记「配置端口但实例停止」——只落注册表，无任何监听。
    const regA = new PortRegistry({ file: XF });
    regA.registerUser(XB, 'inst:stopped');
    child.stdin.on('error', () => { /* 子进程已亡：由下面的有界 exit 断言如实报红 */ });
    child.stdin.write('GO\n');
    // 有界等待：子进程卡死（探针/锁异常）也必须让本套件如实报红，绝不吊死 CI 链
    const exitCode = await new Promise((res) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} res('timeout'); }, 20000);
      child.once('exit', (c) => { clearTimeout(t); res(c); });
    });
    const line = (out.split('RESULT:')[1] || '').split('\n')[0];
    let bRes = null;
    try { bRes = JSON.parse(line); } catch { /* 保留 null 让断言如实报红 */ }
    check('B2-5 跨进程：B 侧 claim 绕开 A 侧已登记的静默端口 ' + XB + '（陈旧快照不得抢注）',
      exitCode === 0 && !!bRes && !bRes.conflict && bRes.port > 0 && bRes.port !== XB,
      'exit=' + exitCode + ' bRes=' + line);
    const fileRecs = JSON.parse(fs.readFileSync(XF, 'utf8')).records;
    check('B2-5 跨进程：B 侧落盘不丢写——ports.json 仍含 A 侧 inst:stopped@' + XB + '（全量覆盖=丢更新）',
      fileRecs.some((r) => r.port === XB && r.owner === 'inst:stopped'), JSON.stringify(fileRecs));
    check('B2-5 跨进程：B 侧自己的绑定也在册（对时是合并视野而非失忆）',
      fileRecs.some((r) => r.owner === 'relay:longlive'), JSON.stringify(fileRecs.map((r) => r.owner)));
  }

  // == B2-5 源码层：第二本账 ports-lan.json 已退场（剥注释判据，防注释自证）==
  {
    const { stripComments } = require('./_strip');
    const daemonSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'domains', 'relay', 'daemon.js'), 'utf8'));
    // 判据函数化：三条款缺一即不过（旧实现把 migrate 条款写成 [^)]* —— 跨不过 path.join 的右括号，恒假误红）。
    const lanRetired = (src) => {
      if (/configureFile\([^)]*ports-lan/.test(src)) return false;
      if (!/configureFile\([^)]*'ports\.json'/.test(src)) return false;
      const args = (/migrateByOwnerPrefix\(([\s\S]*?)\);/.exec(src) || ['', ''])[1];
      return args.indexOf("'ports-lan.json'") >= 0
        && args.indexOf("'ports-lan.json'") < args.indexOf("'ports.json'")
        && /'relay:'/.test(args);
    };
    check('B2-5 源码层：lan-daemon 不再把注册表指到 ports-lan.json，且 ports.json 为唯一落点',
      lanRetired(daemonSrc), 'ok');
    const facadeSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src', 'app', 'facade', 'ports.js'), 'utf8'));
    check('B2-5 源码层：守卫聚合面 SIBLING_REGISTRIES 不含 ports-lan.json（router 侧仍为姊妹账）',
      /SIBLING_REGISTRIES\s*=\s*\[[^\]]*\]/.test(facadeSrc)
      && !/SIBLING_REGISTRIES\s*=\s*\[[^\]]*ports-lan\.json[^\]]*\]/.test(facadeSrc)
      && /SIBLING_REGISTRIES\s*=\s*\[[^\]]*ports-router\.json[^\]]*\]/.test(facadeSrc), 'ok');
    // 反向（判据非空转）：旧形态 configureFile(ports-lan) 命中、缺 ports.json 落点命中、
    //   缺迁移条款命中；完整正形态必须过（防判据写成恒假）。
    check('B2-5 源码层反向：三档违例形态各被识别且合成正形态通过（非空转、非恒假）',
      !lanRetired("ports.configureFile(path.join(swDir, 'ports-lan.json'));")
      && !lanRetired("ports.migrateByOwnerPrefix(path.join(swDir, 'ports-lan.json'), path.join(swDir, 'ports.json'), ['relay:']);")
      && !lanRetired("ports.configureFile(path.join(swDir, 'ports.json'));")
      && lanRetired("ports.migrateByOwnerPrefix(path.join(swDir, 'ports-lan.json'), path.join(swDir, 'ports.json'), ['relay:']); ports.configureFile(path.join(swDir, 'ports.json'));"), 'hit');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
