#!/usr/bin/env node
'use strict';

// 统一受管进程生命周期核心（src/infra/proc/daemon-lifecycle.js）回归：
//  - ensureRunning：身份接管 / 首启 spawn / latch barrier
//  - replace 换代：停旧->等死->等端口释放->才启新（同一 ctl 端口，绝不双代并存）
//  - superviseOnce：死透才重拉；残留先 TERM
//  - stop：TERM->等死->等端口释放->清身份
// 自包含：真实 spawn 本机 fixture（fake-ctl-daemon.js），不触碰真实 daemon/守卫。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lc-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'app', 'daemons', 'process'));
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-ctl-daemon.js');
const CTL = 28040; // 测试专用端口段（远离生产）
const ctlHealth = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: CTL, path: '/' }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
  req.on('error', () => resolve(null));
  req.setTimeout(1200, () => { req.destroy(); resolve(null); });
});
const waitCtl = async (ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = await ctlHealth(); if (h && h.code === 200) return true; await sleep(150); } return false; };

(async () => {
  const identity = path.join(TMP, 'fake.identity.json');
  const marker = path.join(TMP, 'fake.marker');
  const mk = (opts) => new DaemonLifecycle(Object.assign({
    name: 'fake', script: FAKE, args: ['--port', String(CTL), '--marker', marker],
    ctlPort: CTL, cmdMark: 'fake-ctl-daemon', identityFile: identity,
    logger: { info() {}, warn() {}, error() {} }, events: null,
  }, opts || {}));

  console.log('== 首启 + 身份 ==');
  let dl = mk();
  let r1 = dl.ensureRunning();
  check('首启 → mode=started + pid 写入身份', r1.mode === 'started' && !!r1.pid && dl.expectedPid() === r1.pid, JSON.stringify(r1));
  check('ctl 就绪', await waitCtl());
  await sleep(300);
  const alive1 = await ctlHealth();
  check('fake daemon 应答自身 pid', alive1 && JSON.parse(alive1.body).pid === dl.expectedPid(), alive1 && alive1.body);
  const pid1 = dl.expectedPid();

  console.log('== 幂等/接管：同身份再 ensure → adopted（不双拉）==');
  const dl2 = mk();
  const r2 = dl2.ensureRunning();
  check('再 ensure → adopted 同 pid', r2.mode === 'adopted' && r2.pid === pid1, JSON.stringify(r2));
  const h2 = await ctlHealth();
  check('ctl 仍同一 pid（单实例）', h2 && JSON.parse(h2.body).pid === pid1, h2 && h2.body);

  console.log('== 换代：kill 期望 pid → 新生命周期实例 replace（停残留→等死→等端口→启新同端口）==');
  try { process.kill(pid1, 'SIGKILL'); } catch {}
  await sleep(1500); // 等进程消失、端口释放
  const dlNew = mk(); // 全新实例（无历史 latch，模拟守卫重启后接管/换代）
  let replaced = null;
  for (let i = 0; i < 40; i++) {
    replaced = dlNew.ensureRunning();
    if (replaced.mode === 'started' || replaced.mode === 'adopted') break;
    if (replaced.mode === 'reclaiming') { await sleep(400); continue; } // 残留 TERM 后等释放再重试
    await sleep(200);
  }
  check('kill 后换代成功（新 pid ≠ 旧 pid，同 ctl 端口）', replaced && (replaced.mode === 'started' || replaced.mode === 'adopted') && replaced.pid !== pid1, JSON.stringify(replaced));
  const pid2 = dlNew.expectedPid();
  check('换代后 ctl 就绪且为新 pid', (await waitCtl()) && JSON.parse((await ctlHealth()).body).pid === pid2, String(pid2));
  dl = dlNew; // 后续沿用新实例

  console.log('== 换代期间 latch：进程刚死但 spawn 窗口内 → ensure → barrier（无双代）==');
  const dlB = mk();
  const rB = dlB.ensureRunning();
  await waitCtl();
  const pidB = dlB.expectedPid();
  try { process.kill(pidB, 'SIGKILL'); } catch {}
  await sleep(500);
  dlB._spawnWindowUntil = Date.now() + 20000; // 模拟刚 spawn（latch 有效）
  const r3 = dlB.ensureRunning();
  check('latch 窗口内 → mode=barrier（不双拉）', r3.mode === 'barrier', JSON.stringify(r3));
  dlB._spawnWindowUntil = 0;
  try { await dlB.stop(); } catch {}

  console.log('== stop：TERM → 等死 → 等端口释放 → 清身份 ==');
  const st = await dl.stop();
  check('stop ok + 身份已清', st.ok === true && dl.expectedPid() === null, JSON.stringify(st));
  await sleep(300);
  const h3 = await ctlHealth();
  check('端口已释放（ctl 无应答）', h3 === null, JSON.stringify(h3));

  console.log('== 孤儿回收（reclaimOrphans）：同 cmdline 的额外实例被 TERM，受管实例不受影响 ==');
  {
    const dlX = mk();
    const rX = dlX.ensureRunning();
    await waitCtl();
    const mainPid = dlX.expectedPid();
    // 再手工起一个同 cmdline 的“孤儿” fake（不同端口，模拟旧代/不可见命名空间残留）
    const { spawn } = require('node:child_process');
    const orphan = spawn(process.execPath, [FAKE, '--port', String(CTL + 100), '--marker', path.join(TMP, 'orphan.marker')], { stdio: 'ignore' });
    await sleep(800);
    const before = (await new Promise((res) => { const { execFileSync } = require('node:child_process'); try { res(execFileSync('pgrep', ['-af', 'fake-ctl-daemon'], { encoding: 'utf8' }).toString().split('\n').length); } catch { res(0); } }));
    const killed = dlX.reclaimOrphans();
    await sleep(600);
    const orphanDead = (() => { try { process.kill(orphan.pid, 0); return false; } catch { return true; } })();
    check('孤儿（同 cmdline、非受管）被 reclaimOrphans TERM', killed >= 1 && orphanDead, JSON.stringify({ killed, orphanPid: orphan.pid }));
    const mainAlive = dlX.expectedPid() === mainPid && (await ctlHealth()) && JSON.parse((await ctlHealth()).body).pid === mainPid;
    check('受管实例不受影响（同一 pid、ctl 正常）', mainAlive, String(mainPid));
    try { await dlX.stop(); } catch {}
  }

  console.log('== 残留回收：伪造身份=已死 pid + 同 cmdMark 进程占 ctl → superviseOnce 先 TERM 再启 ==');
  // 手工起一个占 ctl 的 fake（不写身份）
  const child = require('node:child_process').spawn(process.execPath, [FAKE, '--port', String(CTL), '--marker', path.join(TMP, 'x.marker')], { stdio: 'ignore' });
  await waitCtl();
  const dl3 = mk();
  dl3._writeIdentity(999999); // 期望 pid 已死
  const sv = await dl3.superviseOnce();
  check('期望死 + ctl 被残留占 → reclaiming（先 TERM 残留）', sv.mode === 'reclaiming', JSON.stringify(sv));
  // 等残留死透 + 端口释放 -> 下轮 spawn
  let started = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    started = dl3.ensureRunning();
    if (started.mode === 'started') break;
  }
  check('残留清后 → 启新并 ctl 就绪', started && started.mode === 'started' && (await waitCtl()), JSON.stringify(started));
  try { await dl3.stop(); } catch {}
  if (child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

// -- D-12：管理锁 = 原子取锁 + 持有者存活检测 + 只删自己的锁 --
// 旧实现三处不成立：writeFileSync 直接覆盖（后写者静默抢锁）、pid 从不回读（崩溃残留恒授权）、
// unlinkSync 无条件删（可删掉别的守卫刚重建的锁）。范式出处：bin/dsh-supervisor 的守卫单实例锁。
{
  const idMod = require(path.join(ROOT, 'src', 'app', 'daemons', 'identity.js'));
  const { acquireLock, releaseLock, lockPid, pidAlive } = idMod._lockPrimitives;
  const dir = path.join(TMP, 'd12');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'router-daemon.lock');
  const writeRaw = (txt) => fs.writeFileSync(lock, txt);

  check('D-12 全新取锁成功且内容为 pid',
    acquireLock(lock) === true && lockPid(lock) === process.pid, 'pid=' + lockPid(lock));
  check('D-12 二次取锁：持有者是自己 -> 仍成功（幂等，不误报易主）',
    acquireLock(lock) === true, 'ok');
  releaseLock(lock);
  check('D-12 释放后锁文件消失', !fs.existsSync(lock), 'gone');

  // 他主且存活：绝不能抢
  writeRaw(String(process.ppid || 1));
  const ppid = lockPid(lock);
  check('D-12 前提：父进程 pid 可解析且存活', ppid > 0 && pidAlive(ppid) === true, 'ppid=' + ppid);
  check('D-12 他主存活 -> 取锁失败且不覆盖内容',
    acquireLock(lock) === false && lockPid(lock) === ppid, 'holder=' + lockPid(lock));
  check('D-12 释放他人锁 -> no-op（只删自己的）',
    (releaseLock(lock), fs.existsSync(lock) && lockPid(lock) === ppid), 'kept=' + lockPid(lock));
  check('D-12 他主存活时即使目录/权限正常也不覆盖内容（无静默抢锁）',
    (writeRaw(String(ppid)), acquireLock(lock) === false, fs.readFileSync(lock, 'utf8').trim() === String(ppid)),
    'content=' + fs.readFileSync(lock, 'utf8').trim());
  fs.rmSync(lock, { force: true });

  // 真-死 pid：起一个即刻退出的子进程，用它的 pid 模拟崩溃残留
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', '']);
  const dead = r && r.pid;
  check('D-12 前提：取到已退出的 pid', !!dead && pidAlive(dead) === false, 'deadPid=' + dead);
  writeRaw(String(dead));
  check('D-12 崩溃残留（持有者已死）-> 清锁重试成功并改成本 pid',
    acquireLock(lock) === true && lockPid(lock) === process.pid, 'holder=' + lockPid(lock));

  // 内容不可解析（旧格式/半写）：按残留处理，取锁方胜出
  fs.rmSync(lock, { force: true });
  writeRaw('not-a-pid');
  check('D-12 锁内容不可解析 -> 视为残留并自愈',
    lockPid(lock) === null && acquireLock(lock) === true && lockPid(lock) === process.pid, 'ok');
  releaseLock(lock);

  // 反向（判据有牙）：旧缺陷形态必被识破
  //   期望方向：父目录存在而锁不存在时 `'wx'` 首次创建**必成功**（本块首条正例已断言），
  //   把「锁不存在」当成取锁失败就把期望倒置了。
  //   真正的失败路径是「父目录都不存在」——那里 ENOENT != EEXIST，取锁必须判 false 且不留任何半成品。
  check('D-12 反向：路径为 null -> 安全返回 false（不触碰 fs）',
    acquireLock(null) === false, 'null 路径安全');
  const ghostDir = path.join(TMP, 'd12-no-such-dir');
  const ghost = path.join(ghostDir, 'router-daemon.lock');
  fs.rmSync(ghostDir, { recursive: true, force: true });
  check('D-12 反向：父目录缺失（ENOENT 非 EEXIST）-> 取锁判 false',
    acquireLock(ghost) === false, 'false');
  check('D-12 反向：失败路径不创建锁文件（无半成品 pid 锁）',
    !fs.existsSync(ghost), 'absent');
  check('D-12 反向：失败路径不擅自补出目录（自愈只清锁、不建目录）',
    !fs.existsSync(ghostDir), 'absent-dir');
  check('D-12 反向：对不存在的锁释放 -> no-op 且不创建',
    (releaseLock(ghost), !fs.existsSync(ghost)), 'absent');
  const idSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'daemons', 'identity.js'), 'utf8');
  const lines = idSrc.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('//'));
  const bareWrite = lines.filter((l) => /fs\.writeFileSync\(.*pid/.test(l));
  check('D-12 反向：源码不再有裸 writeFileSync(pid) 覆盖式写锁', bareWrite.length === 0, bareWrite.join('|'));
  const bareUnlink = lines.filter((l) => /if \(p\) \{ try \{ fs\.unlinkSync/.test(l));
  check('D-12 反向：无条件 unlinkSync 删锁的旧体已消失', bareUnlink.length === 0, bareUnlink.join('|'));
  check('D-12 范式一致：取锁走 wx 原子创建（与守卫单实例锁同法）',
    /fs\.openSync\(p, 'wx'\)/.test(idSrc) && /openSync\(LOCK_FILE, 'wx'\)/.test(fs.readFileSync(path.join(ROOT, 'bin', 'dsh-supervisor'), 'utf8')), 'wx');
}

