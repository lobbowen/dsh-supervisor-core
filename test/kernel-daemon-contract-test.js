#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 内核守护进程契约门禁（D-1..D-8；KERNEL-DAEMON-CONTRACT.md）——
//
// 锁定内核侧「被壳拉起时必须提供什么」，防止回退成「内核自建服务/双启动器/端口不自报」：
//   D-1  daemon 自足：配置缺失时内嵌默认配置自建（不依赖外置模板）
//   D-2  对外声明实际端口：supervisor-api 写入 ports.json
//   D-3  /healthz 可用（壳的唯一就绪判据）
//   D-4  内核 install **不再**写服务定义/autostart（唯一所有者=壳）— 反向非空转
//   D-5  单实例：guard.lock 由**本产品的守卫**占用才让位；陈旧锁（持有者已退出，或 pid
//        被复用到别的进程）必须被接管，否则守卫永远起不来，用户端只剩「端口不可达」
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 读整个域（递归全部 .js）——域拆分后单文件读取会静默失去覆盖面。 */
const readDomain = (rel) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(ROOT, rel));
  return out.join(String.fromCharCode(10));
};
const cli = read('bin/dsh-supervisor');

// -- D-1：daemon 自足（内嵌默认配置）--
check('D-1 配置缺失时 autoCopy 自建', /resolveConfigPath\(\{ autoCopy: true \}\)/.test(cli), 'ok');
check('D-1 内嵌 DEFAULT_CONFIG（不依赖外置模板）', /const DEFAULT_CONFIG = Object\.assign/.test(cli), 'ok');

// -- D-2：对外声明实际端口 --
//  步骤 7：HTTP 启动与端口登记已从 src/supervisor.js 下沉到
//   app/assembly/api-rebind.js（startApi 绑定后登记实际端口、_rebindApiHost 重绑后同登记）。
//   supervisor.js 现为 <=200 行薄壳，仅在 start() 经 _apiStart -> apiRebind.startApi 装配。
//   判据跨文件：读「薄壳 + 实现」整组；不变量不变（supervisor-api 必须写入 ports.json），
//   否则文件一搬门禁就静默失去覆盖面。
const apiSources = [
  read('src/supervisor.js'),
  read('src/app/assembly/api-rebind.js'),
].join('\n');
check('D-2 supervisor-api 写入 ports.json', /ports(?:Shared)?\.register(?:Sole)?\('supervisor-api'/.test(apiSources), 'ok');

// -- D-3：healthz --
const apiSrc = ['src/api/index.js', 'src/api/domains/lifecycle.js'].map((f) => { try { return read(f); } catch { return ''; } }).join('\n');
check('D-3 /healthz 路由存在', /\/healthz/.test(apiSrc), 'ok');

// -- D-4：install 不写服务定义/autostart（唯一所有者=壳）--
const installStart = cli.indexOf('function cmdInstall');
const installEnd = cli.indexOf('function cmdGuiAutostart');
const installBody = installStart >= 0 && installEnd > installStart ? cli.slice(installStart, installEnd) : '';
check('D-4 定位到 cmdInstall', installBody.length > 0, installBody.length ? 'ok' : '未找到');
check('D-4 install 不写 UNIT_PATH', !installBody.includes('UNIT_PATH'), 'ok');
check('D-4 install 不 enable systemd', !/systemctl[\s\S]{0,40}'enable'/.test(installBody), 'ok');
check('D-4 install 明确「由桌面壳负责」', /服务定义\/开机自启\/桌面入口由桌面壳负责/.test(installBody), 'ok');
// 反向：旧形态（写 unit + enable）必须能被识别为违规
const looksLikeDeploy = (body) => body.includes('writeFileSync(UNIT_PATH') || /systemctl[\s\S]{0,40}'enable'/.test(body);
const legacy = "fs.writeFileSync(UNIT_PATH, unit); execInherit('systemctl', ['--user', 'enable', 'dsh-supervisor.service']);";
check('D-4 反向：旧写服务定义形态被识别', looksLikeDeploy(legacy), 'ok');
check('D-4 反向：当前 install 不被误判', !looksLikeDeploy(installBody), 'ok');

// -- D-5：单实例 --
check('D-5 acquireLock 未取得锁即退出非零', /function acquireLock/.test(cli) && /未取得守卫锁/.test(cli) && /process\.exit\(1\)/.test(cli), 'ok');
// 让位的判据必须是「那确实是守卫在跑」，不是「这个 pid 还活着」：Windows 上 pid 会被复用，
// 且进程句柄未释放时 process.kill(pid, 0) 也成功 —— 只看存活就等于把锁永久交给一个不存在的守卫。
check('D-5 让位前按命令行锚点判定持有者是本产品守卫', /isOwnGuardEntry\(cmdline\)/.test(cli) && /readCmdline\(held\.pid\)/.test(cli), 'ok');
// 每一条让位都必须带**原因**：真机上「已有守卫实例在运行，本进程退出」出现过两次，而现场
// 无从区分「确有守卫」与「wmic 读不到命令行 + 残留锁」——后者是永不自愈的死局。
const lockBody = cli.slice(cli.indexOf('function acquireLock'), cli.indexOf('function releaseLock'));
const bareYield = (src) => /if \(alive && !cmdline\) return false/.test(src) || /isOwnGuardEntry\(cmdline\)\) return false/.test(src);
check('D-5 让位必须返回原因（无裸 return false 让位）', !bareYield(lockBody) && /return '持有 pid /.test(lockBody), 'ok');
check('D-5 反向：裸让位旧形态被识别为违规', bareYield("if (alive && !cmdline) return false;\nif (alive && isOwnGuardEntry(cmdline)) return false;"), 'ok');
// 命令行读不到时不再无条件让位：锁续约（mtime）是第三个独立证据，被强制杀掉留下的锁必须可回收。
check('D-5 锁续约与陈旧回收（心跳超阈值即接管）',
  /const LOCK_HEARTBEAT_MS/.test(cli) && /fs\.utimesSync\(LOCK_FILE/.test(cli)
    && /silent >= LOCK_STALE_MS/.test(lockBody) && /startLockHeartbeat\(\)/.test(lockBody), 'ok');
check('D-5 读不到命令行且锁仍在续约时仍保守让位', /保守让位/.test(lockBody), 'ok');
// 活着的前任守卫很可能就是「壳刚下令停止、还没咽气」的那一个（Windows 的停止请求按命令行强杀，
// 从发起到退出要几秒）。撞锁即退 = 前任一死锁就永久留着、端口没人监听。必须**有界**等它退出；
// 窗口耗尽仍按单实例让位（并发双守卫比晚起几秒严重得多）。
check('D-5 撞锁后有界等待前任退出（不立刻放弃）',
  /const LOCK_TAKE_RETRY_MS/.test(cli) && /while \(pidAlive\(held\.pid\)\)/.test(lockBody)
    && /napSync\(LOCK_TAKE_NAP_MS\)/.test(lockBody) && /Date\.now\(\) >= deadline/.test(lockBody), 'ok');
// 存活判定收单源：让位分支与等待循环必须问同一个问题，两处各写一遍就会对同一 pid 给出不同答案。
check('D-5 pid 存活判定单源（EPERM 算存活）',
  /function pidAlive\(pid\)/.test(cli) && /return e\.code === 'EPERM'/.test(cli)
    && !/process\.kill\(held\.pid/.test(lockBody), 'ok');
const yieldAtOnce = "if (cmdline && isOwnGuardEntry(cmdline)) { return '持有 pid ' + held.pid + ' 存活'; }";
check('D-5 反向：撞锁即让位的旧形态确实未等待（证明上一条非空转）',
  !/while \(pidAlive/.test(yieldAtOnce) && /return '持有 pid /.test(yieldAtOnce), 'ok');
check('D-5 陈旧锁被接管并留痕', /清理陈旧守卫锁/.test(cli) && /fs\.unlinkSync\(LOCK_FILE\)/.test(cli), 'ok');
// 锁内容升级为 JSON（pid/started/entry），但读侧必须兼容旧格式：否则一次升级就把所有在用
// 实例的锁看成无效，反而制造双守卫。
check('D-5 锁内容为 JSON 且读侧兼容纯 pid 旧格式', /JSON\.stringify\(LOCK_OWNER\)/.test(cli) && /parseInt\(raw, 10\)/.test(cli), 'ok');
check('D-5 只释放自己的锁（按解析后的 pid 比）', /held && held\.pid === process\.pid/.test(cli), 'ok');
// 反向：旧形态（只看 pid 存活就 return false）必须被上面的判据抓到，证明非空转。
const legacyOnly = "if (Number.isInteger(holder) && holder > 0) { try { process.kill(holder, 0); return false; } catch (err) { if (err.code === 'EPERM') return false; } }";
check('D-5 反向：只认 pid 存活的旧形态被识别为违规',
  !/isOwnGuardEntry\(cmdline\)/.test(legacyOnly) && bareYield(legacyOnly), 'ok');

// -- D-6：绑定后登记**实际端口**（P6 就绪判据的单一来源）--
// 判据跨文件：实现随步骤 7 下沉到 app/assembly/api-rebind.js（见上 D-2），故在整组上断言。
// 实际端口登记必须是 registerSole：登记表以端口号为键，顺延时旧端口的记录是**另一条**记录，
// 只 release 它不足以立住「同 role 唯一」——该调用被 catch{} 包住且忽略返回值，
// 留下两条 supervisor-api 时「按 role 取号」（内核 ports.get / 壳读 ports.json）能拿到没人监听的端口。
check('D-6 listen 回调登记实际端口（同 role 唯一）', /ports(?:Shared)?\.registerSole\('supervisor-api', (?:port|host\.config\.apiPort)\)/.test(apiSources), 'ok');
const poolSrc = read('src/platform/service/ports/pool.js');
check('D-6 registerSole 先清除同 role 的其它端口记录', /registerSole\(role, port\)/.test(poolSrc) && /r\.role === role && existing !== p/.test(poolSrc), 'ok');
check('D-6 装配期登记也走唯一化', /ports\.registerSole\('supervisor-api', host\.config\.apiPort\)/.test(read('src/app/assembly/bootstrap.js')), 'ok');
// 反向：两条登记形态必须被识别为未落实
check('D-6 反向：只 register 实际端口 + release 旧端口的形态被识别为违规',
  !/registerSole\('supervisor-api'/.test("portsShared.register('supervisor-api', port); portsShared.release(prev, 'system:supervisor-api');"), 'ok');

// -- D-7：数据/日志路径经注入的 stateDir，不得各自 os.homedir()（G6）--
const proxySrc = read('src/domains/router/providers/proxy.js');
check('D-7 proxy 用注入的 stateDir 落日志', /this\.stateDir/.test(proxySrc), 'ok');
check('D-7 proxy 不再直拼 os.homedir() 的 supervisor/logs', !/homedir\(\), '\.dsh', 'supervisor', 'logs'/.test(proxySrc), 'ok');
//  域改造后 stateDir 注入随 router 拆分搬移（SSOT：派生/注入在 store/ops）——
//   按整域聚合读取，避免文件一搬门禁就静默失去覆盖面。
// 不变量不变：provider 的 stateDir 由 config.stateFile 派生后注入。形态随域拆分从
//   stateDir: this.config && this.config.stateFile 改为 (d.config && d.config.stateFile)，
//   故判据容忍两种形态，并剥行注释（防注释里的同名字样造成假绿）。
const ridx = readDomain('src/domains/router').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
check('D-7 router 向 provider 注入 stateDir', /stateDir[^\n]{0,120}config\.stateFile/.test(ridx), 'ok');

// -- D-8：Windows 看护（watchdog）所有者 = 壳（G3/C2）--
//  域结构改造：autostart 已拆为 autostart/{index,win32,darwin,linux}.js ——
//   按目录聚合读取，D-8 的覆盖面不因文件切分而静默失效。
const auto = readDomain('src/platform/os/autostart');
const kernelCreatesWatchdog = (src) =>
  src.includes("'/TN', 'DSH-Supervisor-Watchdog'") || /writeFileSync\([^)]*watchdog\.ps1/.test(src);
check('D-8 内核不再创建 watchdog 任务', !auto.includes("'/TN', 'DSH-Supervisor-Watchdog'"), 'ok');
check('D-8 内核不再写 watchdog.ps1', !/writeFileSync\([^)]*watchdog\.ps1/.test(auto), 'ok');
// 判据只要求「所有者」与「桌面壳」在注释中相邻出现，不钉死排版形态（'= **桌面壳**' 与
// '所有者都是桌面壳' 等价）——注释符号清理不得让本判据静默失去覆盖面。
check('D-8 注释明确所有者=桌面壳', /所有者[^\n]{0,12}桌面壳/.test(auto), 'ok');
check('D-8 反向：未声明所有者的样本被判违规',
  !/所有者[^\n]{0,12}桌面壳/.test("schtasks /Create /TN DSH-Supervisor-GUI /SC ONLOGON"), 'ok');
// 反向：旧形态（内核建 watchdog）必须能被识别
const legacyWatchdog = "ex.runDetail('schtasks', ['/Create', '/TN', 'DSH-Supervisor-Watchdog', '/SC', 'MINUTE']);";
check('D-8 反向：旧形态被识别', kernelCreatesWatchdog(legacyWatchdog), 'ok');
check('D-8 反向：当前实现不被误判', !kernelCreatesWatchdog(auto), 'ok');

// -- D-9：API 重绑的监听错误分支绝不静默下线 --
//    时序是本块的第一风险：夹具的 error 与真实 http.Server 一样只在**下一拍** emit（setImmediate），
//   所以每条断言前必须把 immediate 队列跑干；同步读 ev/scheduled 会双双恒空（四例恒红、判据空转）。
//   本块因此是异步的：文件末尾的汇总与退出挂在它的完成回调上（finish），不能留在同步尾部。
//   快重试环由夹具**手动拨表**（setTimeout 只记录不执行），才能把「10 次后降级 30s 并留痕」跑满。
{
  const realST = global.setTimeout;
  const realSI = global.setImmediate;
  const scheduled = [];                              // { fn, ms }
  const drain = () => new Promise((r) => realSI(r)); // 跑干 immediate 队列（error 已送达）
  const takeDue = () => scheduled.splice(0, scheduled.length);
  const msOf = (list) => JSON.stringify(list.map((x) => x.ms));

  const run = async () => {
    const { _rebindApiHost } = require(path.join(ROOT, 'src', 'app', 'assembly', 'api-rebind.js'));
    // 本块要求「产品确实又排了一次重试」是**可观测**的，故用夹具桩接住真实排程（不装就会让测试
    // 自己挂上 30s 定时器拖死链尾）。桩必须**随取随装、取完即卸**：`scheduled` 里只允许出现被测
    // 代码的排程，任何夹在窗口里的别的定时器都会把它变成假红（本机探针踩过：夹具自己的 300ms 心跳
    // 被记成「产品排了重试」）。取完即卸，窗口只剩「一次 bind()」那么长。
    const withStub = async (fn) => {
      const prev = global.setTimeout;
      global.setTimeout = (cb, ms) => { scheduled.push({ cb, ms }); return { unref() {} }; };
      try { return await fn(); } finally { global.setTimeout = prev; }
    };
    const mkHost = (err) => {
      const ev = [];
      const h = {
        api: { close() {}, closeAllConnections() {} },
        config: { apiPort: 29990, apiHost: '127.0.0.1' }, // 假 server 从不 bind；29990 经 T1 端口纪律（非 ephemeral/生产池）
        logger: { warn(m) { ev.push('warn:' + m); }, info() {}, error(m) { ev.push('log:' + m); } },
        events: { append(n, p) { ev.push(n); } },
        _exitIntended: () => false,
      };
      const create = () => {
        const s = { on(e, f) { if (e === 'error') s._f = f; }, listen() {} };
        // 夹具自己用「当时的真实 setImmediate」（realSI）排投递：本块会改写 global.setTimeout，
        // 若将来改用 setTimeout 排投递，写成 realSI 也不会被自己的桩吃掉（同 一类的桩件自伤）。
        if (err) realSI(() => { if (!s._fired) { s._fired = true; s._f(err); } }); // 单次触发：真实 server 不会二次 emit
        return s;
      };
      _rebindApiHost(h, create);
      return { h, ev };
    };
    // 一次「建 host + 等 error 送达」必须在同一个桩窗口内：error 是下一拍才 emit 的，
    // 窗口先关就等于让产品拿回真实 setTimeout（排程再也记不到，且会真挂上 30s 定时器）。
    const arm = (err) => withStub(async () => { const x = mkHost(err); await drain(); return x; });
    const fire = (list) => withStub(async () => { for (const t of list) { t.cb(); await drain(); } });

    // 1) EACCES（配置性错误，重试不可消解）：一次性 api_offline，且不空转重试
    const a = await arm({ code: 'EACCES', message: 'permission denied' });
    check('C-9 EACCES → 落一条 api_offline 事件（失败可见，不静默下线）',
      a.ev.filter((e) => e === 'api_offline').length === 1, JSON.stringify(a.ev));
    const dueA = takeDue();
    check('C-9 EACCES → 不进重试环（零排程）', dueA.length === 0, '排程=' + msOf(dueA));
    check('C-9 EACCES → host.api 保持 null（不假装在线）', a.h.api === null, String(a.h.api));

    // 2) EADDRINUSE（瞬时）：300ms 快重试；跑满 10 次后**必须**降级 30s 慢重试并留 api_error
    const b = await arm({ code: 'EADDRINUSE', message: 'in use' });
    let fireB = takeDue();
    check('C-9 EADDRINUSE 首错 → 排 300ms 快重试',
      fireB.length === 1 && fireB[0].ms === 300, '排程=' + msOf(fireB));
    check('C-9 EADDRINUSE 重试期间 host.api 保持 null（不假装在线）', b.h.api === null, String(b.h.api));
    for (let i = 0; i < 10; i++) { // 端口一直被占：手动拨表把快重试环跑满
      await fire(fireB);
      fireB = takeDue();
    }
    check('C-9 EADDRINUSE 第 11 次失败 → 降级 30s 慢重试（持续自愈）',
      fireB.length === 1 && fireB[0].ms === 30000, '排程=' + msOf(fireB));
    check('C-9 降级时留 api_error 痕迹（B-22c 红线：绝不永久静默）',
      b.ev.indexOf('api_error') >= 0, JSON.stringify(b.ev));
    check('C-9 反向：瞬时错误分支不误报 api_offline（重试中不算下线）',
      b.ev.indexOf('api_offline') === -1, JSON.stringify(b.ev));
    // 慢环仍受 E-3 退出意图闸约束：关停后不得重开监听器（否则守卫已退仍留一个 API 端口）
    b.h._exitIntended = () => true;
    await fire(fireB);
    const dueB3 = takeDue();
    check('C-9 慢环遇退出意图 → 就地中止（不再排程）', dueB3.length === 0, '排程=' + msOf(dueB3));
    check('C-9 慢环遇退出意图 → 留 warn 痕迹（中止这件事本身可见）',
      b.ev.indexOf('warn:api rebind 中止：检测到退出意图') >= 0, JSON.stringify(b.ev));

    // 3) 未知错误：保守按「可自愈」处理 -> 立刻入 30s 环并留痕（不停在静默分支）
    const c = await arm({ code: 'EHOSTUNREACH', message: 'no route' });
    check('C-9 未知错误 → 留 api_error 痕迹', c.ev.indexOf('api_error') >= 0, JSON.stringify(c.ev));
    const dueC = takeDue();
    check('C-9 未知错误 → 入 30s 自愈环', dueC.length === 1 && dueC[0].ms === 30000, '排程=' + msOf(dueC));

    // 4) EADDRNOTAVAIL：与 EADDRINUSE 同环（网卡地址未就绪是瞬时的，不是配置性拒绝）
    const d = await arm({ code: 'EADDRNOTAVAIL', message: 'addr not available' });
    const dueD = takeDue();
    check('C-9 EADDRNOTAVAIL → 与 EADDRINUSE 同环（排 300ms 快重试）',
      dueD.length === 1 && dueD[0].ms === 300, '排程=' + msOf(dueD));
    check('C-9 EADDRNOTAVAIL 不落 api_offline（网卡未就绪不是配置性拒绝）',
      d.ev.indexOf('api_offline') === -1, JSON.stringify(d.ev));
  };

  const finish = () => {
    global.setTimeout = realST;
    const failed = results.filter((r) => !r);
    console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
    process.exit(failed.length ? 1 : 0);
  };
  // 块自身抛错也只吃一条 FAIL，不让它把链尾 #114–#129 一起带走（崩溃代价高于判红）
  run().then(finish, (e) => {
    check('C-9 D-9 块自身未抛错（require/驱动失败即判红）', false, String((e && e.stack) || e));
    finish();
  });
}
