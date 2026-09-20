'use strict';

// lan-daemon / router-daemon 管理锁（身份文件）。
// 导出形态 { methods }，方法经 this 协作。
//
// 阶段六 B-1 原地去 this：实现体不再经 this 的隐式方法调用取事实，改经按 host 缓存的
// **惰性 deps**（WeakMap；getter 每次读 host 实时值）。方法仍以 { methods } 导出、名字与体
// 逐字保留：装配路径 installMethods(host, mod.methods) 不变，AT 棘轮的直接方法调用计数归零。
// 唯一的 this 出现在 depsOf(this)（作为 WeakMap 键）。

const fs = require('node:fs');
const path = require('node:path');

// 管理锁必须与守卫单实例锁（bin/dsh-supervisor 的
// acquireLock/releaseLock）同一范式，原先三处都不成立：
//   - writeFileSync 直接覆盖 —— 两个守卫并存时后写者静默抢锁，前者的 managed 判据被骗过；
//   - pid 从不回读 —— 崩溃/机器重启后锁恒在，managed 恒真（对已死持有者持续授权）；
//   - unlinkSync 无条件删 —— 可删掉**别的守卫**刚重建的锁。
// 现：'wx' 原子创建 + 持有者存活检测（ESRCH 清残留 / EPERM 视为存活）+ 释放只删自己的锁。

/** 锁内容 = 持有者 pid；不可解析（旧格式/半写）返回 null。 */
function lockPid(p) {
  if (!p) return null;
  try {
    const n = parseInt(fs.readFileSync(p, 'utf8'), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** 进程是否存活：kill(pid,0) —— EPERM = 存在但无权（视为存活），其余异常视为已死。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/** 原子取锁：已存在且持有者存活则不抢（返回 false）；持有者已死/内容不可解析 -> 清残留重试一次。 */
function acquireLock(p, onErr) {
  if (!p) return false;
  const attempt = () => {
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { try { fs.closeSync(fd); } catch {} }
      return true;
    } catch (e) {
      if (e && e.code === 'EEXIST') return false;
      if (onErr) onErr(e);
      return false;
    }
  };
  if (attempt()) return true;
  const holder = lockPid(p);
  if (holder === process.pid) return true; // 自己持有：幂等成功（每拍 ensure 都会重写）
  if (holder !== null && pidAlive(holder)) return false; // 他主存活：绝不抢锁
  try { fs.unlinkSync(p); } catch {}
  return attempt();
}

/** 释放锁：只删自己持有的（内容 pid == 本进程），避免误删后来者的锁。 */
function releaseLock(p) {
  if (!p) return;
  const holder = lockPid(p);
  if (holder !== null && holder !== process.pid) return; // 已易主：不动
  try { fs.unlinkSync(p); } catch {}
}

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      // 同模块兄弟方法经 host 上的既有安装转发（等价于原经 this 的调用）。
      lanLockPath() { return host._lanLockPath(); },
      routerDaemonLockPath() { return host._routerDaemonLockPath(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  // D-12 测试缝：锁的取/放/读主是纯 fs + kill(0) 语义，直接导出给回归用（不改行为）。
  _lockPrimitives: { acquireLock, releaseLock, lockPid, pidAlive },
  methods: {
    _lanLockPath() { const d = depsOf(this); try { return path.join(path.dirname(d.config().stateFile), 'lan-daemon.lock'); } catch { return null; } },
    _lanManaged() { const d = depsOf(this); try { const p = d.lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } },
    _writeLanLock() { const d = depsOf(this); try { return acquireLock(d.lanLockPath()); } catch { return false; } },
    _clearLanLock() { const d = depsOf(this); try { releaseLock(d.lanLockPath()); } catch {} },

    // router-daemon 管理权锁：只有「本守卫目录写过管理锁」的实例才可接管/停止/拉起独立 router-daemon，
    // 防止任意 Supervisor 实例（尤其测试内嵌实例与线上守卫并存）经全局 ctl 端口探测误接管/误杀生产 daemon。
    _routerDaemonLockPath() {
      const d = depsOf(this);
      try { return path.join(path.dirname(d.config().stateFile), 'router-daemon.lock'); } catch { return null; }
    },

    _daemonManaged() {
      const d = depsOf(this);
      try { const p = d.routerDaemonLockPath(); return !!p && fs.existsSync(p); } catch { return false; }
    },

    _writeRouterDaemonLock() {
      const d = depsOf(this);
      try { return acquireLock(d.routerDaemonLockPath()); } catch { return false; }
    },

    _clearRouterDaemonLock() {
      const d = depsOf(this);
      try { releaseLock(d.routerDaemonLockPath()); } catch {}
    },
  },
};
