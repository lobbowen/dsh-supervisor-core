#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 平台「输出解析 + 命令构造 + 会话判定」可移植性穷举门禁
//
// 承接 platform-layer-portability-test：把**剩余平台层模块**的平台相关逻辑
// 也在任意宿主上穷举。
//
// 为使逻辑可穷举，本次**抽出了纯函数并让生产代码直接调用**（非平行实现）：
//   - pidlookup.js：parseProcNetTcpInodes / parseLsofPid / parseNetstatPid /
//                   parseSsPid / parseWmicCommandLine / parsePowerShellCommandLine
//   - notify.js：notifyCommand / appleScriptString / powerShellString
//   （原先把「解析/构造」与「I/O / spawn」揉在一起 -> 只能在对应平台验证，
//     而平台解析与转义恰是跨平台 bug 的藏身处。）
//
// ## 本次同时修掉的真实缺陷（失效模式 b：同一事实两处实现且已分叉）
//
// **PowerShell 字符串转义被套用了 JSON 规则**：notify.js 的 Windows 分支用
//   JSON.stringify 构造标题/正文（产出 "a\"b"），而 PowerShell 的双引号字符串
//   用**双写**转义（"a""b"），反斜杠是字面字符 -> PowerShell 在反斜杠处**终止字符串**
//   -> 语法错误 -> notify 静默失败（best-effort 的 catch 吞掉）。
//   AppleScript 确实用反斜杠，故两平台**必须分开实现**（不可复用同一 helper）。
//
// ## 锁定不变量
//   Y-1  pidlookup：三种平台格式的解析结果正确（含端口整段匹配、CRLF 容忍）
//   Y-2  **P1-2 回归锚点**：wmic 输出 "No Instance(s) Available." 必须返回 null
//        （=> 调用方继续走 PowerShell CIM 回退；旧实现直接 return null 跳过回退）
//   Y-3  notify：平台->命令映射正确；**转义规则按平台区分**（AppleScript 反斜杠 /
//        PowerShell 双写）；不支持平台返回 null
//   Y-4  desktop：sessionAvailable 是三个探针的**或**，且方式探针尊重 XDG_RUNTIME_DIR；
//        darwin/win32 恒真（会话由启动器限定）
//   Y-5  反向：判据能识别错误转义 / 空 wmic 误判（门禁非空转）
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const pid = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
const notify = require(path.join(ROOT, 'src', 'platform', 'os', 'notify.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
// 异步判据登记表：汇总前统一 await（Y-6 起新增行为断言不再自开独立文件，N-e 链条长度纪律）。
const pendingChecks = [];

// -- Y-1：三平台监听者解析 --
{
  // Windows netstat -ano（真实形态：CRLF；IPv6 行；非 LISTENING 行）
  const netstat = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:2800         0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:28100        0.0.0.0:0              LISTENING       12345',
    '  TCP    127.0.0.1:28101        0.0.0.0:0              ESTABLISHED     777',
    '  TCP    [::1]:28100            [::]:0                 LISTENING       12345',
    '  TCPv6  [::]:28102             [::]:0                 LISTENING       555',
  ].join(CRLF);
  check('Y-1 netstat：命中 LISTENING 行取 pid', pid.parseNetstatPid(netstat, 28100) === 12345, String(pid.parseNetstatPid(netstat, 28100)));
  check('Y-1 netstat：端口**整段**匹配（:28100 不被 :2800 误命中）',
    pid.parseNetstatPid(netstat, 2800) === 9999, String(pid.parseNetstatPid(netstat, 2800)));
  //  严格判据：夹具里**只有**:28100，却询问:2800 -> 必须 null。
  //   贪婪子串匹配（indexOf）会错误返回:28100 那行的 pid —— 这一条专门抓它。
  const onlyLonger = '  TCP    127.0.0.1:28100        0.0.0.0:0              LISTENING       12345'
    + CRLF + '  TCP    127.0.0.1:12800        0.0.0.0:0              LISTENING       22222';
  check('Y-1 netstat：**严格判据** 只有 :12800 / :28000 时询问 :2800 → null（抓贪婪匹配）',
    pid.parseNetstatPid(onlyLonger, 2800) === null, String(pid.parseNetstatPid(onlyLonger, 2800)));
  check('Y-1 netstat：同一夹具询问 :28100 → 12345',
    pid.parseNetstatPid(onlyLonger, 28100) === 12345, String(pid.parseNetstatPid(onlyLonger, 28100)));
  check('Y-1 netstat：同一夹具询问 :12800 → 22222（前缀/后缀干扰都不命中）',
    pid.parseNetstatPid(onlyLonger, 12800) === 22222, String(pid.parseNetstatPid(onlyLonger, 12800)));
  check('Y-1 netstat：非 LISTENING 行忽略（28101 是 ESTABLISHED）',
    pid.parseNetstatPid(netstat, 28101) === null, String(pid.parseNetstatPid(netstat, 28101)));
  check('Y-1 netstat：TCPv6 行也解析', pid.parseNetstatPid(netstat, 28102) === 555, String(pid.parseNetstatPid(netstat, 28102)));
  check('Y-1 netstat：无匹配返回 null', pid.parseNetstatPid(netstat, 28999) === null, 'null');
  check('Y-1 netstat：空/undefined 安全', pid.parseNetstatPid('', 80) === null && pid.parseNetstatPid(undefined, 80) === null, 'ok');

  // macOS lsof
  const lsof = [
    'COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    12345 bowen   20u  IPv4 0x1a2b3c4d5e6f7a8b      0t0  TCP 127.0.0.1:28107 (LISTEN)',
  ].join(LF);
  check('Y-1 lsof：取第 2 列数字为 pid', pid.parseLsofPid(lsof) === 12345, String(pid.parseLsofPid(lsof)));
  check('Y-1 lsof：仅表头（无数字列）返回 null',
    pid.parseLsofPid('COMMAND   PID USER   FD') === null, 'null');

  // Linux ss -tlnHp
  const ssOut = 'LISTEN 0      511          0.0.0.0:28107      0.0.0.0:*    users:(("node",pid=12345,fd=20))';
  check('Y-1 ss：从 users:(...pid=N...) 取 pid', pid.parseSsPid(ssOut) === 12345, String(pid.parseSsPid(ssOut)));
  check('Y-1 ss：无 pid 段返回 null',
    pid.parseSsPid('LISTEN 0 511 0.0.0.0:28107 0.0.0.0:*') === null, 'null');

  // Linux /proc/net/tcp（0A = LISTEN；端口十六进制）
  const procTcp = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:6DCB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0',
    '   1: 00000000:6DCC 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 999999 1 0000000000000000 100 0 0 10 0',
  ].join(LF);
  const inodes = pid.parseProcNetTcpInodes(procTcp, 0x6DCB);
  check('Y-1 /proc/net/tcp：仅 0A(LISTEN) 且端口匹配的 inode 入集',
    inodes.size === 1 && inodes.has('socket:[424242]'), JSON.stringify([...inodes]));
  check('Y-1 /proc/net/tcp：非 LISTEN(01) 行被排除',
    pid.parseProcNetTcpInodes(procTcp, 0x6DCC).size === 0, '0');
}

// -- Y-2：P1-2 回归锚点 —— wmic 空输出必须回退 --
{
  check('Y-2 wmic 正常输出：取出 CommandLine 并 trim',
    pid.parseWmicCommandLine('CommandLine=node.exe --flag  ' + CRLF + CRLF) === 'node.exe --flag',
    JSON.stringify(pid.parseWmicCommandLine('CommandLine=node.exe --flag  ' + CRLF + CRLF)));
  // 内部换行**保留**（只 trim 两端）——命令行本身可能含换行
  check('Y-2 wmic 多行命令行保留内部换行',
    pid.parseWmicCommandLine('CommandLine=a' + CRLF + 'b') === 'a' + CRLF + 'b',
    JSON.stringify(pid.parseWmicCommandLine('CommandLine=a' + CRLF + 'b')));
  //  核心：进程已退出/权限不足时 wmic 输出这个 -> 必须 null（=> 调用方走 CIM 回退）
  const noInstance = 'No Instance(s) Available.';
  check('Y-2 **P1-2 锚点**：wmic 输出 No Instance(s) Available. → null（触发 CIM 回退）',
    pid.parseWmicCommandLine(noInstance) === null, JSON.stringify(pid.parseWmicCommandLine(noInstance)));
  check('Y-2 wmic 输出 CommandLine=（空值）→ null（同样触发回退）',
    pid.parseWmicCommandLine('CommandLine=') === null, 'null');
  check('Y-2 wmic 无输出 → null', pid.parseWmicCommandLine('') === null && pid.parseWmicCommandLine(null) === null, 'ok');
  check('Y-2 PowerShell CIM 输出 trim；空串 → null',
    pid.parsePowerShellCommandLine('  node.exe x  ') === 'node.exe x'
    && pid.parsePowerShellCommandLine('   ') === null, 'ok');
}

// -- Y-3：notify 平台->命令映射 + 转义规则区分 --
{
  const L = notify.notifyCommand('linux', 'T', 'B');
  check('Y-3 linux → notify-send，标题/正文作为 argv（无 shell 转义面）',
    L && L.cmd === 'notify-send' && L.args[2] === 'T' && L.args[3] === 'B', JSON.stringify(L));
  const D = notify.notifyCommand('darwin', 'T', 'B');
  check('Y-3 darwin → osascript -e display notification',
    D && D.cmd === 'osascript' && /^display notification /.test(D.args[1]) && /with title /.test(D.args[1]), D && D.args[1]);
  const W = notify.notifyCommand('win32', 'T', 'B');
  check('Y-3 win32 → powershell -NoProfile -NonInteractive -Command',
    W && W.cmd === 'powershell' && W.args[0] === '-NoProfile' && /ShowBalloonTip/.test(W.args[3]), W && W.cmd);
  check('Y-3 不支持平台 → null（notify 返回 false，不静默谎报已派发）',
    notify.notifyCommand('freebsd', 'T', 'B') === null, 'null');

  //  转义：两平台规则**不同**，必须分开实现（本次修复的正是"套用 JSON 规则"）
  // PowerShell 侧改**单引号字面量**——旧双引号串漏 $，
  //   body（含 err.message 通路）里的 $(...) 会被子表达式插值执行 = 注入面。
  const Q = String.fromCharCode(34);
  const SQ = String.fromCharCode(39);
  const raw = 'a' + Q + 'b';
  check('Y-3 AppleScript 转义用反斜杠（JSON 规则恰好等价）',
    notify.appleScriptString(raw) === Q + 'a' + String.fromCharCode(92) + Q + 'b' + Q,
    notify.appleScriptString(raw));
  check('Y-3 **PowerShell 用单引号字面量**（" 为字面字符，$ 不再插值）',
    notify.powerShellString(raw) === SQ + 'a' + Q + 'b' + SQ,
    notify.powerShellString(raw));
  check('Y-3 PowerShell 单引号转义 = ' + "'" + ' 双写',
    notify.powerShellString("it's") === SQ + 'it' + SQ + SQ + 's' + SQ,
    notify.powerShellString("it's"));
  check('Y-3 两者产出**不同**（证明不可复用同一 helper）',
    notify.appleScriptString(raw) !== notify.powerShellString(raw), '已区分');
  // 端到端：win32 命令里标题为单引号字面量形态
  const wQ = notify.notifyCommand('win32', raw, raw);
  check('Y-3 win32 命令里标题走单引号字面量（不含双引号串包裹）',
    wQ.args[3].indexOf('ShowBalloonTip(4000, ' + SQ + 'a' + Q + 'b' + SQ + ', ' + SQ) >= 0, 'ok');
  // B9 注入行为：$(...) 与反引号必须原样处于单引号内（不成为插值点）
  const inj = 'x$(calc.exe)y`z';
  const wrapped = notify.powerShellString(inj);
  check('B9 $()/反引号 原样留在单引号串内（PowerShell 单引号语义=字面量）',
    wrapped === SQ + inj + SQ, wrapped);
  // 反向（门禁非空转）：旧双引号+只转义"的形态会泄漏 $( 插值
  const legacy = '"' + inj.replace(/"/g, '""') + '"';
  check('B9 反向：旧双引号形态被「$ 处于双引号串」判据命中',
    /^".*\$\(/.test(legacy) && !/^".*\$\(/.test(wrapped), 'hit+safe');
}

/** 子进程伪造 platform + env 后执行（模块级：Y-4 与 Y-5 都要用）。 */
function underFakeEnv(platform, env, body) {
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    Object.entries(env).map(([k, v]) => (v === null
      ? ("delete process.env." + k + ";")
      : ("process.env." + k + " = " + JSON.stringify(v) + ";"))).join(LF),
    body,
  ].join(LF);
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, cwd: ROOT }).trim();
  } catch (e) { return 'EXECFAIL:' + ((e && e.message) || e); }
}

// -- Y-4：desktop 会话判定 --
{
  const BODY = [
    "const d = require('./src/platform/os/desktop.js');",
    "const s = d.describe();",
    "process.stdout.write(JSON.stringify(s));",
  ].join(LF);

  for (const p of ['darwin', 'win32']) {
    const out = underFakeEnv(p, { DISPLAY: null, WAYLAND_DISPLAY: null }, BODY);
    let j = null; try { j = JSON.parse(out); } catch {}
    check('Y-4 ' + p + ' 恒为可用（会话由启动器限定）且 reason=session-scoped-by-launcher',
      !!j && j.available === true && j.reason === 'session-scoped-by-launcher', out.slice(0, 70));
  }
  {
    const out = underFakeEnv('linux', { DISPLAY: ':0', WAYLAND_DISPLAY: null }, BODY);
    let j = null; try { j = JSON.parse(out); } catch {}
    check('Y-4 linux + DISPLAY → 可用且 reason=env(...)',
      !!j && j.available === true && j.reason === 'env(DISPLAY/WAYLAND_DISPLAY)', out.slice(0, 90));
  }
  {
    // 空 XDG_RUNTIME_DIR -> wayland 探针必须为假（尊重该变量）；x11 探针取决于宿主
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
    const out = underFakeEnv('linux', { DISPLAY: null, WAYLAND_DISPLAY: null, XDG_RUNTIME_DIR: empty }, BODY);
    let j = null; try { j = JSON.parse(out); } catch {}
    const hasX = (() => { try { return fs.readdirSync('/tmp/.X11-unix').some((f) => /^X\d+$/.test(f)); } catch { return false; } })();
    check('Y-4 linux：available === (env || x11套接字 || wayland套接字) —— 逻辑等价（任意宿主成立）',
      !!j && j.available === hasX, out.slice(0, 110));
    check('Y-4 linux + 空 XDG_RUNTIME_DIR：reason 不含 wayland-socket（尊重该变量）',
      !!j && (hasX ? j.reason === 'x11-socket' : j.reason === 'none'), j ? j.reason : out.slice(0, 60));
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

// -- Y-5：反向（判据必须能识别违规）--
{
  const Q = String.fromCharCode(34);
  check('Y-5 反向：判据能识别"把 JSON 规则套到 PowerShell"的旧形态',
    (Q + 'a' + String.fromCharCode(92) + Q + 'b' + Q) !== notify.powerShellString('a' + Q + 'b'), 'hit');
  check('Y-5 反向：判据能识别"空 wmic 被当成有值"',
    pid.parseWmicCommandLine('No Instance(s) Available.') !== 'No Instance(s) Available.', 'hit');
  check('Y-5 反向：端口整段匹配判据有效（:2800 与 :28100 不同）',
    pid.parseNetstatPid('  TCP  127.0.0.1:2800  0.0.0.0:0  LISTENING  1', 28100) === null, 'hit');
  check('Y-5 反向：underFakeEnv 确实伪造了 platform',
    underFakeEnv('win32', {}, "process.stdout.write(process.platform)") === 'win32', 'ok');
}

// -- Y-6：resstats 进程树采样解析（W2 观测面；解析纯函数按三平台真实形态文本 fixture 穷举）--
//    数据源分叉只在 sampleAsync 一步；/proc、ps、Get-CimInstance 三种输出离线可验。
{
  const resstats = require(path.join(ROOT, 'src', 'platform', 'os', 'resstats'));
  const { aggregate } = resstats;
  const { parseProcStat, parseProcStatusRss, parseCpuTimeMs, parsePsTable, parseCimJson } = resstats._parse;
  console.log(LF + '== Y-6 resstats 解析与树聚合 ==');
  const line = '8421 (strange (x) proc) S 5 8421 8421 0 -1 4194304 200 0 0 0 250 125 0 0 20 0 3 0 12345';
  const ps = parseProcStat(line);
  check('Y-6 /proc stat：comm 含空格/括号仍取末个 ")" 后字段', ps && ps.pid === 8421 && ps.ppid === 5, JSON.stringify(ps));
  check('Y-6 /proc stat：utime+stime（USER_HZ=100）换算毫秒 (250+125)*10=3750', ps && ps.cpuMs === 3750, ps && String(ps.cpuMs));
  check('Y-6 /proc stat：无括号垃圾行 -> null（不抛）', parseProcStat('no paren here') === null, '');
  check('Y-6 /proc stat：字段不足 -> null', parseProcStat('1 (a) S 0 0') === null, '');
  check('Y-6 /proc status：VmRSS 1234 kB -> 1263616 B', parseProcStatusRss('Name:\tnode' + LF + 'VmRSS:\t  1234 kB' + LF) === 1234 * 1024, '');
  check('Y-6 /proc status：无 VmRSS（内核线程）-> null', parseProcStatusRss('Name:\tkworker' + LF) === null, '');
  check('Y-6 ps cputime mm:ss.cc -> 303210ms', parseCpuTimeMs('05:03.21') === 303210, String(parseCpuTimeMs('05:03.21')));
  check('Y-6 ps cputime h:mm:ss -> 3723000ms', parseCpuTimeMs('1:02:03') === 3723000, String(parseCpuTimeMs('1:02:03')));
  check('Y-6 ps cputime dd-hh:mm:ss -> 183845000ms', parseCpuTimeMs('2-03:04:05') === 183845000, String(parseCpuTimeMs('2-03:04:05')));
  check('Y-6 ps cputime 00:00 -> 0（零是合法值，不得当失败）', parseCpuTimeMs('00:00') === 0, '');
  check('Y-6 ps cputime 垃圾输入 -> null', parseCpuTimeMs('junk') === null, '');
  const psTable = '  PID  PPID    RSS      TIME' + LF + '  100     1  10240    01:00' + LF + '  101   100   5120  00:30.5' + LF + '  102   999   2048    00:01' + LF;
  const procs = parsePsTable(psTable);
  check('Y-6 ps 表：表头/短行跳过，只留数据行', procs.length === 3, String(procs.length));
  const p100 = procs.find((p) => p.pid === 100);
  check('Y-6 ps 表：rss kB->字节 且 cputime->毫秒', p100 && p100.rssBytes === 10240 * 1024 && p100.cpuMs === 60000, JSON.stringify(p100));
  check('Y-6 ps 表：父子链保真（101 的 ppid=100）', procs.find((p) => p.pid === 101).ppid === 100, '');
  const cim = parseCimJson('[{"ProcessId":10,"ParentProcessId":1,"WorkingSetSize":2048,"UserModeTime":1000,"KernelModeTime":2000}]');
  check('Y-6 CIM JSON：100ns->毫秒（3000/1e4=0.3）且 rss 取字节', cim.length === 1 && cim[0].cpuMs === 0.3 && cim[0].rssBytes === 2048, JSON.stringify(cim));
  const cimSingle = parseCimJson('{"ProcessId":7,"ParentProcessId":0,"WorkingSetSize":10,"UserModeTime":0,"KernelModeTime":0}');
  check('Y-6 CIM JSON：单对象（非数组）也归一为表', cimSingle.length === 1 && cimSingle[0].pid === 7, JSON.stringify(cimSingle));
  check('Y-6 CIM JSON：非法 JSON -> 空表不抛', parseCimJson('not json').length === 0, '');
  const tree = [
    { pid: 1, ppid: 0, rssBytes: 100, cpuMs: 10 },
    { pid: 2, ppid: 1, rssBytes: 200, cpuMs: 20 },
    { pid: 3, ppid: 2, rssBytes: 50, cpuMs: 5 },
    { pid: 4, ppid: 9, rssBytes: 999, cpuMs: 99 },
  ];
  const agg = aggregate(1, tree);
  check('Y-6 树聚合：沿父子链求和（350B/35ms），无关进程不计', agg && agg.rssBytes === 350 && agg.cpuMs === 35, JSON.stringify(agg));
  check('Y-6 树聚合：root 不在表内（已退出）-> null（不是零占用谎报）', aggregate(12345, tree) === null, '');
  check('Y-6 树聚合：竞态数据成环不死循环、每 pid 只计一次',
    (() => { const c = aggregate(1, [{ pid: 1, ppid: 2, rssBytes: 10, cpuMs: 1 }, { pid: 2, ppid: 1, rssBytes: 20, cpuMs: 2 }]); return c && c.rssBytes === 30; })(), '');
  // 异步段（sampleAsync 契约）：必须等它落账再收尾，防汇总先跑造成假绿跳过。
  pendingChecks.push((async () => {
    check('Y-6 sampleAsync：pid 非法（0/负/小数/字符串）-> null 不抛',
      (await resstats.sampleAsync(0)) === null && (await resstats.sampleAsync(-2)) === null &&
      (await resstats.sampleAsync(1.5)) === null && (await resstats.sampleAsync('x')) === null, '');
    const platform = require(path.join(ROOT, 'src', 'platform', 'os', 'index'));
    if (platform.isLinux) {
      const self = await resstats.sampleAsync(process.pid);
      check('Y-6 Linux 真机自采：本进程树 rss>0 且 cpuMs>=0', !!self && self.rssBytes > 0 && self.cpuMs >= 0, JSON.stringify(self));
      check('Y-6 不存在的极大 pid -> null', (await resstats.sampleAsync(2147483646)) === null, '');
    } else {
      check('Y-6 非 Linux：子进程数据源由 CI 对应 runner 裁决（本宿主只断契约形态）',
        typeof resstats.sampleAsync === 'function', '');
    }
  })());
}

Promise.all(pendingChecks).then(() => {
  const failed = results.filter((r) => !r);
  console.log(LF + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
});
