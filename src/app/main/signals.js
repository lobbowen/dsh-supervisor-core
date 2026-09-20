'use strict';

// app/main/signals.js —— 进程终止信号（_isManagedProcess/_signalChild/_killTree/_killSequence/_killAdopted）。
// 导出形态 { methods }；装配：app/assembly/facets.js 装到 host 实例；方法内部以 this 协作。
//
// 阶段六 B-2 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的**惰性 deps**。
// 方法名/{ methods }/逐字体保留，装配路径不变；process-tree-kill-test 的两条形态钉子同批改为**按符号名**。
const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');
const { writeAtomic } = require('../../platform/util/fs');
const fs = require('node:fs');
const path = require('node:path');

/** SIGKILL 之后的复核窗口（ms）：信号投递与内核回收需要时间，
 *  在同一拍断言 isAlive 会把「正在死」误判成「杀不掉」（假失败）。
 *  仍在存活才判定「停止落空」并上报（D12）。 */
const ADOPT_KILL_VERIFY_MS = 2000;

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      events() { return host.events; },
      logger() { return host.logger; },
      // 兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      mainOwnerFile() { return host._mainOwnerFile(); },
      readMainOwner() { return host._readMainOwner(); },
      signalChild(child, sig) { return host._signalChild(child, sig); },
      killTree(child, sig) { return host._killTree(child, sig); },
      readKillTimer() { return host._killTimer; },
      writeKillTimer(v) { host._killTimer = v; },
      readAdoptKillGen() { return host._adoptKillGen; },
      writeAdoptKillGen(v) { host._adoptKillGen = v; },
      readAdoptKillTimer() { return host._adoptKillTimer; },
      writeAdoptKillTimer(v) { host._adoptKillTimer = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  /** 主 DSH 的**归属凭据**文件（D-11，AUDIT-2026-09-19 第 4 批）：与 lan/router daemon 的
   *  `*-daemon.identity.json` 同范式、同址（stateFile 所在目录）。此前接管只凭 cmdline 子串
   *  相似（`_isManagedProcess`），于是**两个守卫会认领同一个 DSH**——彼此 stop/kill 对方刚
   *  接管的进程（审计原述「疑似双管家互杀」）。 */
  _mainOwnerFile() {
    const d = depsOf(this);
    try { return path.join(path.dirname(d.config().stateFile), 'dsh-main.owner.json'); } catch { return null; }
  },

  /** 读归属凭据；缺失/损坏一律 null（**绝不**因读失败而接管或否决——判定回落 cmdline）。 */
  _readMainOwner() {
    const d = depsOf(this);
    try {
      const p = d.mainOwnerFile();
      if (!p) return null;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (j && typeof j === 'object' && j.dshPid) ? j : null;
    } catch { return null; }
  },

  /** 落归属凭据：声明「pid=<dshPid> 的主 DSH 由本守卫（guardPid）负责」。
   *  spawn 与 adopt 两条取得所有权的路线都要写。落盘走 E-1 原子写单源（platform/util/fs 的
   *  writeAtomic：tmp 名含 pid+时间戳，多实例并发不互相覆盖，rename 原子替换）+ 0600
   *  ——与 daemon 身份文件同法。 */
  _writeMainOwner(dshPid, port) {
    const d = depsOf(this);
    try {
      const p = d.mainOwnerFile();
      if (!p || !dshPid) return;
      writeAtomic(p, JSON.stringify({
        guardPid: process.pid, dshPid, port: port || null, startedAt: Date.now(),
      }), { mode: 0o600 });
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('writeMainOwner: ' + ((e && e.message) || e));
    }
  },

  /** 校验 pid 进程是否属于本守卫管理：cmdline 含配置的启动 bin，或符合 DSH 特征（兼容外部手动起的标准 DSH）。
   *  精确匹配避免"路径碰巧含 dsh 就误接管"与"安装路径不含 dsh 就漏接管"。
   *
   *  D-11：先看**归属凭据**——但凭据只做**否决**（别的守卫活着且明确拥有这个 pid 时不接管），
   *  不单独放行：放行权威仍是 cmdline 特征。理由——陈旧凭据（pid 已被内核复用）若可单独放行，
   *  会把无关进程接管进来，那是比原缺陷更糟的失败方向。 */
  _isManagedProcess(pid) {
    const d = depsOf(this);
    const own = d.readMainOwner();
    if (own && own.dshPid === pid && own.guardPid && own.guardPid !== process.pid
        && pidlook.isAlive && pidlook.isAlive(own.guardPid)) {
      d.logger() && d.logger().warn && d.logger().warn(
        'refuse adopt pid=' + pid + '：归属凭据指向另一存活守卫 pid=' + own.guardPid + '（不双管家互杀）');
      return false;
    }
    const cmd = pidlook.readCmdline(pid);
    if (!cmd) return false;
    const bin = d.config().command && d.config().command[1];
    if (typeof bin === 'string' && bin && cmd.includes(bin)) return true;
    return pidlook.isDshCmdline(pid);
  },

  /** 向进程组发信号（detached spawn 的子进程是组长）；组信号失败退回单进程（平台层封装：
   *  POSIX 组信号；Windows 无组语义则单进程信号，树语义由 `killTree` 提供）。 */
  _signalChild(child, sig) {
    platform.processControl.signalProcess(child.pid, sig);
  },

  /** 整树终止。
   *
   *  为什么必须单独有这个方法：
   *   平台层提供 `killTree`（Windows = `taskkill /PID <pid> /T /F`，POSIX = 进程组信号），
   *   实际停止路径若只用 `signalProcess`，它在 Windows 上只 `process.kill(pid, sig)`（单进程语义由平台层注释自己写明）。
   *   于是 Windows 上停止 DSH 只杀父进程：其派生的子进程（node / 浏览器 / 子命令）成为**孤儿**，
   *   继续占端口、持文件锁；守卫重启后 adopt 复用即被楔死。
   *
   *   POSIX 上 `killTree` 退化为组信号，与 `_signalChild` 等价（幂等，无害）。
   *   B13：child 一律是本守卫 detached 拉起（组长），显式 ownGroup:true 保留组信号。
   */
  _killTree(child, sig) {
    const d = depsOf(this);
    const pc = platform.processControl;
    if (pc && typeof pc.killTree === 'function') {
      pc.killTree(child.pid, sig || 'SIGKILL', () => {}, { ownGroup: true });
      return;
    }
    // 兜底：平台层未提供时退回单进程信号（不因能力缺失而完全不杀）
    d.signalChild(child, sig || 'SIGKILL');
  },

  _killSequence(child) {
    const d = depsOf(this);
    d.events().append('sigterm_sent', { pid: child.pid });
    // 优雅期先发 SIGTERM：Windows 上仍走单进程信号（给目标自行收尾的机会），
    // 超时后的 SIGKILL 才升级为整树（孤儿才是真问题，见上方 _killTree 说明）。
    d.signalChild(child, 'SIGTERM');
    d.writeKillTimer(setTimeout(() => {
      d.writeKillTimer(null);
      if (child.exitCode === null && child.signalCode === null) {
        d.killTree(child, 'SIGKILL');
        d.events().append('sigkill_sent', { pid: child.pid, tree: platform.PLATFORM === 'win32' });
      }
    }, d.config().stopGraceMs));
  },

  /** 杀无句柄的接管实例（仅知 pid）。
   *
   *  失败不再静默（D12）：SIGKILL 投递后另给一次复核窗口，仍存活才判定「停止落空」，
   *  发 stop_failed + warn —— 原实现只 append sigkill_sent 就算完，kill 失败与成功无法区分。
   *
   *  代际（gen）：本文件只有一个 _adoptKillTimer 槽位，后一次 kill 会覆盖前一次的句柄。
   *  故每次调用自增 _adoptKillGen，定时器只在「本代仍是当前代」时才把槽位置回 null，
   *  防止旧 timer 清掉新一次操作的句柄（清掉后 shutdown 就漏清它）。
   *  注意代际只保护共享槽位：每个 timer 仍按自己的 pid 完成升级与复核，
   *  不因换代而跳过，否则前一个 pid 的 SIGKILL 升级会被吞掉。 */
  _killAdopted(pid) {
    const d = depsOf(this);
    const gen = (d.readAdoptKillGen() || 0) + 1;
    d.writeAdoptKillGen(gen);
    const releaseSlot = () => { if (gen === d.readAdoptKillGen()) d.writeAdoptKillTimer(null); };
    d.events().append('sigterm_sent', { pid, adopted: true });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    d.writeAdoptKillTimer(setTimeout(() => {
      releaseSlot();
      if (pidlook.isAlive(pid)) {
        // 接管实例同样可能有子进程：Windows 上升级为整树（taskkill /T /F），否则会留下孤儿子进程占端口。
        // B13：POSIX 外来 pid **不发组信号**（可能恰为无关进程组组长，kill(-pid) 误杀整组）——
        // 不传 ownGroup，平台层退化为单进程 SIGKILL（树枚举仅 Windows 有安全实现）。
        const pc = platform.processControl;
        if (pc && typeof pc.killTree === 'function') {
          pc.killTree(pid, 'SIGKILL', () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        d.events().append('sigkill_sent', { pid, adopted: true, tree: platform.PLATFORM === 'win32' });
        // 复核：SIGKILL 生效是异步的，须另起一拍才能断言成败。
        const verify = setTimeout(() => {
          releaseSlot();
          if (!pidlook.isAlive(pid)) return;
          d.events().append('stop_failed', { pid, adopted: true, reason: 'SIGKILL 后仍存活' });
          if (d.logger() && d.logger().warn) {
            d.logger().warn('[main] 接管实例停止落空：pid ' + pid + ' 在 SIGKILL 后仍存活');
          }
        }, ADOPT_KILL_VERIFY_MS);
        // unref：复核窗口纯观测，不应拖住进程退出（shutdown 亦会清 _adoptKillTimer）。
        if (verify && typeof verify.unref === 'function') verify.unref();
        d.writeAdoptKillTimer(verify);
      }
    }, d.config().stopGraceMs));
  }
  },
};
