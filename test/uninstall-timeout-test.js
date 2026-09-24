#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// P1-F：npm 动作必须有**超时看门狗**，且卸载锁必须**结构性释放**
//
// ## 缺陷
//
// 卸载路径旧实现自持子进程：
//   - `spawn(npmBin(), uninstallArgs, ...)` **无 timeout / 无 killSignal**；
//   - Promise 只监听 `error` / `exit`，npm 挂起即**永不 settle**；
//   - `this.uninstalling` 只在函数末尾复位 —— 于是永为真。
//
// 后果链：npm 挂起（registry 不可达 / 凭证助手等待 / 网络盘卡住）
//   -> Promise 永不 settle -> `uninstalling` 永为真
//   -> `install`/`uninstall`/`startUninstall` **全部被拒**
//   -> 任务永久 running，用户只能重启守卫。
//
// 对照：同仓**安装**路径本就有 timeout + killTree，唯独卸载漏了 —— 收口方式不是给卸载
// 再写一份看门狗，而是让它走同一个执行器。
//
// ## 锁定不变量（拆成两层的归属，与实现同源）
//   F-a  子进程侧：超时预算取自平台策略表、看门狗成对（setTimeout/clearTimeout）、settle 幂等
//   F-b  超时路径会**终止进程树**（不能只杀父进程），且终止口来自 platform/os/process
//   F-c  应用侧锁释放位于 `finally`，且卸载编排**不再自持子进程**
//   F-d  超时事实对用户**可见**（执行器回报 timedOut，编排层转成「可重试」文案）
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const { stripComments } = require('./_strip');

const EXEC = stripComments(read(path.join('src', 'platform', 'distribution', 'install.js')));
const POLICIES = stripComments(read(path.join('src', 'platform', 'distribution', 'policies.js')));
const SRC = stripComments(read(path.join('src', 'app', 'native', 'ops.js')));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 取执行器函数体（从 runNpmInstall 声明到下一个顶层 function），避免断言命中端口健康段
const execStart = EXEC.indexOf('function runNpmInstall(');
const execEnd = EXEC.indexOf('function portListening(');
const execBody = (execStart >= 0 && execEnd > execStart) ? EXEC.slice(execStart, execEnd) : '';
check('前置：定位到 npm 动作执行器', execBody.length > 1500, execBody.length + ' 字符');

// 取卸载函数体（从 uninstall 的锁置位到文件结束），避免断言命中安装/升级段
const start = SRC.indexOf('host.uninstalling = true;');
const end = SRC.indexOf('module.exports');
const region = (start >= 0 && end > start) ? SRC.slice(start, end) : '';
check('前置：定位到卸载编排', region.length > 500, region.length + ' 字符');

// -- F-a：超时看门狗（子进程侧） --
{
  const m = POLICIES.match(/NPM_TIMEOUT_MS\s*=\s*\{[^}]*uninstall:\s*(\d+)/);
  const uninstallBudget = m ? Number(m[1]) : 0;
  check('F-a 卸载时长预算在平台策略表定义（量级 > 60s）', uninstallBudget > 60000, uninstallBudget + 'ms');
  check('F-a 执行器按 action 取该预算（调用方未覆盖时不会退化成无超时）',
    /policies\.NPM_TIMEOUT_MS\[action\]/.test(execBody), '有');
  check('F-a 存在 setTimeout 看门狗', /const timer = setTimeout\(/.test(execBody), '有');
  check('F-a 看门狗在 settle 时被清除（clearTimeout）', /clearTimeout\(timer\)/.test(execBody), '有');
  check('F-a 有 settled 幂等位（防超时与 exit 竞态双 resolve）', /if \(settled\) return/.test(execBody), '有');
  check('F-a 超时事实带进结果（timedOut:true 且指名动作）', /timedOut:\s*true/.test(execBody), '有');
}

// -- F-b：超时要杀进程树 --
check('F-b 超时路径终止进程树（killTree）', /procOS\.killTree\(child\.pid/.test(execBody), '有');
check('F-b 组信号只对自有进程组（ownGroup）', /ownGroup:\s*true/.test(execBody), '有');
check('F-b 引用了平台进程树的统一实现', /require\('\.\.\/os\/process'\)/.test(EXEC), '有');
check('F-b 反向：不靠裸负 pid 组信号（Windows 无该语义）', !/process\.kill\(-/.test(execBody), '无自造组信号');

// -- F-c：锁在 finally 中释放，且编排不碰子进程 --
check('F-c 存在 try/finally 结构', /\} finally \{/.test(region), '有');
{
  const fin = region.slice(region.indexOf('} finally {'), region.indexOf('} finally {') + 220);
  check('F-c finally 中释放卸载锁', /host\.uninstalling = null/.test(fin), (fin.match(/host\.uninstalling[^;]*/) || [''])[0]);
}
check('F-c 卸载动作经统一执行器出口', /host\._runNpm\(\{ action: 'uninstall' \}\)/.test(region), '有');
check('F-c 反向：卸载编排在应用层不再自持子进程（spawn/child_process 已下沉）',
  !/spawn\(/.test(SRC) && !/child_process/.test(SRC), '无');

// -- F-d：超时事实可见 --
check('F-d 结果带 timedOut 字段', /return \{ ok: exitCode === 0, removed, timedOut, error:/.test(region), '有');
check('F-d 被中止（关停）与超时同判为卡住', /res\.timedOut === true \|\| res\.aborted === true/.test(region), '有');
check('F-d 超时文案说明「可重试」', /可重试/.test(region), '有');

// -- 反向：不能因为加了超时就丢掉 K10 的「失败保留 manifest」语义 --
check('反向：失败仍保留 manifest（K10 未回退）', /if \(exitCode === 0\) \{\s*[\s\S]{0,40}rm\(host\.manifestFile\)/.test(region), '保留');

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
