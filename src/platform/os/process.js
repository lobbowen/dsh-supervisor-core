'use strict';

// POSIX（Linux/macOS）用进程组信号 kill(-pid)；Windows 无进程组语义，单进程信号 +
// taskkill /T 整树终止（能力等价）。
// 异步 taskkill 改走 platform/util/exec 的统一有界封装
// （裸 execFile 是 K-W2 门禁的历史盲区；windowsHide/SIGKILL/timeout 纪律收口在 exec.js）。

const ex = require('../util/exec');

const isWindows = process.platform === 'win32';

/** 向进程（组）发信号：POSIX 先组信号（-pid），失败退单进程；
 *  Windows 仅单进程（树语义由 killTree 提供）。 */
function signalProcess(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    try { process.kill(pid, sig); } catch {}
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

/** 整树终止（尽力而为，回调式）。
 *
 *  B13两处语义修正：
 *   - Windows：`taskkill /T` 补 `/F` —— 无 /F 只投递 WM_CLOSE，无窗口/不处理该消息的
 *     子进程杀不掉（孤儿照旧占端口）；并加 10s 有界超时（经 exec.runAsync）防 taskkill 挂起。
 *     树语义按父子关系枚举，对外来 pid 同样安全。
 *   - POSIX：负 pid 组信号**仅限本方创建的进程组**（opts.ownGroup=true，detached 子进程
 *     必为组长）。接管实例的 pid 可能恰为无关进程组组长（如用户 shell 会话），
 *     `kill(-pid)` 会误杀整组——外来路径只发单进程信号。
 */
function killTree(pid, sig, cb, opts) {
  if (!Number.isInteger(pid) || pid <= 0) { if (cb) cb(new Error('invalid pid')); return; }
  if (isWindows) {
    ex.runAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 })
      .then((r) => { if (cb) cb(r.ok ? null : new Error(r.error || 'taskkill failed')); });
    return;
  }
  if (opts && opts.ownGroup === true) {
    signalProcess(pid, sig || 'SIGTERM');
  } else {
    try { process.kill(pid, sig || 'SIGTERM'); } catch {}
  }
  if (cb) process.nextTick(cb, null);
}

module.exports = { signalProcess, killTree };
