#!/usr/bin/env node
'use strict';

// 确定性槽位仲裁 claimSlot 回归（2026-09，docs/port-architecture.md）：
//  byOwner 绑定复用 / binding-lost 迁移(显式) / preferred advisory 回退 / 顺序补位 / 单 owner 单端口
// 隔离 range（28130+50）→ 确定性，不依赖宿主真实 relay 段占用。

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

  // reload 契约（阶段三）：读路径以权威文件为准——外部进程新增记录后 reload 可见；
  // 内存未落盘记录 reload 后丢弃（以文件为 truth 的语义）。
  {
    const p2 = new PortRegistry({ file: path.join(TMP, 'ports-reload.json') });
    await p2.claimSlot('relay', 'owner-A', { range: RANGE });
    const pA = p2.byOwner('owner-A');
    // 模拟另一进程（独立实例）向同一文件写入新记录
    const pOther = new PortRegistry({ file: path.join(TMP, 'ports-reload.json') });
    const slotB = await pOther.claimSlot('relay', 'owner-B', { range: RANGE });
    check('R-reload-1 外部新增记录文件已含 owner-B', !!slotB && slotB.port > 0, String(slotB && slotB.port));
    check('R-reload-2 reload 前内存不见 owner-B（陈旧快照）', p2.byOwner('owner-B') === null, String(p2.byOwner('owner-B')));
    p2.reload();
    check('R-reload-3 reload 后 owner-B 可见（以文件为准）', p2.byOwner('owner-B') === slotB.port, String(p2.byOwner('owner-B')));
    check('R-reload-4 reload 后 owner-A 绑定保留', p2.byOwner('owner-A') === pA, String(p2.byOwner('owner-A')));
  }

  // ── B14（AUDIT §B-14）：IPv6-only 监听不再漏判 + 跨进程分配锁 + 登记后复检 ──
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

    // 跨进程锁存在性：模拟并发者持锁（fresh mtime）→ 本次分配不崩、fail-open 结果仍正确
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

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
