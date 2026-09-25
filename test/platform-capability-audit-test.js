#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 跨平台能力**完整性**审计
//
// 目的：把「跨平台能力」从**文字声明**变成**可执行断言**。
//
// 动机（真实事故）：审计发现 macOS 的壳自启/自愈**从项目奠基提交
//   起就不存在**，而：
//     - 注释声称「mac 由 LaunchAgent 一并代管」（macPlist 从奠基至今逐字节未变、只含守卫）
//     - status() 硬编码 `gui: on`（把守卫自启当成壳自启）
//     - setGuiAutostart 对非 Linux **静默 `return { ok: true }`**
//     - 早期审计曾给这项打了「三端齐全」（现行矩阵见 PLATFORM-CAPABILITY-MATRIX.md）
//   四层互相背书，**没有一层验证行为**。
//
// 本测试即是「验证行为」这一层。
//
// 不变量：
//   A1 完整性    每个能力字段对三平台 + 未知平台都有明确布尔值（无 undefined / 无遗漏）
//   A2 声明=true  该能力必须有**实现产物**（源码/机制证据）
//   A3 声明=false 该能力必须**显式报告不支持**（绝不静默成功）
//   A4 行为一致  模块的跨平台行为必须与 capabilityProfile 的声明一致
//   A5 自愈真伪  自愈类能力的声明必须匹配实际机制（不得声称存在而实现被条件屏蔽）
//   A6 无回归    历史错误声明不得重新出现
//   A7 壳自愈    声明必须匹配实际机制（同 A5，覆盖三平台看护）
//   A8 自启产权  内核不得越权写/删守卫服务定义（定义归壳）
//   A9 守卫自启  guardAutostart 声明为 true 即要求内核有真正作用于守卫的关闭路径
//
// ## 覆盖缺口（E-2 制度化登记）：本门禁绿了仍然不成立的方面
//   1. A2/A3 的「实现产物」是源码正则：只证明代码里存在该形态，不证明它被执行 ——
//      外部打开的执行面（三档结局、零 spawn 拒绝）在 platform-layer-portability 的 X-10 与
//      api-contract 的 OW 组。
//   2. A1/A3 读的是注入的档位表；真机上把声明改成实测的那些覆写（Linux 图形会话、hasTool 探测）
//      本门禁不判探测正确性，归 platform-parsers-and-commands 与 four-platform-behavior-matrix。
//   3. 本门禁不判文案是否用户可读、也不判面板是否按字段分档（后者在 ui 的 externalOpen.test.ts）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const POS = path.join(ROOT, 'src', 'platform', 'os');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readOs = (f) => fs.readFileSync(path.join(POS, f), 'utf8');
/** 按平台层子目录聚合读取。 */
const readOsDir = (d) => fs.readdirSync(path.join(POS, d)).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(POS, d, f), 'utf8')).join(String.fromCharCode(10));

/** 剥离注释：A6「历史错误声明不得重现」必须只看**代码**。
 *   修复过程会在注释里**引用旧声明的原文**（用于解释病因），
 *    不剥离就会把解释文字误判为实际代码（首版即因此 3 项误报）。 */
// 阶段六 P6-A：剥离统一走 test/_strip.js 的**字符级单一实现**（去掉引号奇偶启发式 ——
//   该启发式对多层/转义引号不可靠）。语义等价或更强：字符串/正则字面量感知，只多删注释。
const { stripComments: stripCommentsLex, blankComments } = require('./_strip');
function stripComments(src) { return stripCommentsLex(src); }

const { capabilityProfile } = require(POS);
const autostart = require(path.join(POS, 'autostart'));
const service = require(path.join(POS, 'service.js'));

const PLATFORMS = ['linux', 'darwin', 'win32'];
const UNKNOWN = 'freebsd';
const CAP_FIELDS = [
  'sandboxLaunch', 'pidAdoption', 'processTreeKill', 'desktopNotify', 'autostart', 'frpExpose',
  'guardAutostart', 'guardSelfHeal', 'shellAutostart', 'shellSelfHeal', 'openBrowser',
];
// sandboxEnforcement 是枚举档位（限额执行机制），不是布尔能力位，单列校验。
const ENFORCEMENT_TIERS = ['cgroup', 'supervise', 'none'];

// -- A1 完整性 --
console.log('== A1 能力字段完整性（无遗漏 / 无 undefined）==');
{
  for (const pl of PLATFORMS.concat([UNKNOWN])) {
    const r = capabilityProfile(pl, 'x64');
    const missing = CAP_FIELDS.filter((f) => typeof r[f] !== 'boolean');
    check('A1 ' + pl + ' 全部能力字段为布尔值', missing.length === 0, missing.length ? 'missing/非布尔: ' + missing.join(', ') : 'ok');
    check('A1 ' + pl + ' sandboxEnforcement 为合法档位枚举',
      ENFORCEMENT_TIERS.includes(r.sandboxEnforcement), String(r.sandboxEnforcement));
    check('A1 ' + pl + ' platform/arch 透传', r.platform === pl && r.arch === 'x64', '');
  }
}

// -- A4 autostart 跨平台行为（真实调用，非文本扫描）--
console.log('== A4 autostart 跨平台行为一致性 ==');
{
  // 壳自启：声明必须与行为一致
  // 三平台**均已实现**。
  const expectShellAutostart = { linux: true, darwin: true, win32: true };
  for (const pl of PLATFORMS) {
    const claimed = capabilityProfile(pl, 'x64').shellAutostart;
    check('A4 ' + pl + ' shellAutostart 声明与 capabilityProfile 一致', claimed === expectShellAutostart[pl], 'claimed=' + claimed);
    let r;
    try { r = autostart.setGuiAutostart(false, pl); } catch (e) { r = { ok: false, threw: e.message }; }
    if (claimed) {
      check('A4 ' + pl + ' 声明可自启 → setGuiAutostart 不报不支持', r && r.unsupported !== true, JSON.stringify(r));
    } else {
      check('A4 ' + pl + ' 声明不可自启 → **显式**报不支持（不得静默 ok:true）',
        r && r.ok === false && r.unsupported === true, JSON.stringify(r));
    }
  }
  // 未知平台一律显式不支持
  const ru = autostart.setGuiAutostart(false, UNKNOWN);
  check('A4 未知平台显式不支持', ru && ru.ok === false && ru.unsupported === true, JSON.stringify(ru));
}

// -- A3 声明=false 必须显式不支持 --
console.log('== A3 不支持的能力必须显式报告 ==');
{
  // W3 后沙箱拉起三平台全解锁（darwin/win32 落 portable 软档）；显式不支持只剩**未知平台**：
  // current() 必须落 NONE（makeUnsupported），动词抛 CapabilityError，绝不静默 no-op。
  const svcSrc = readOs('service.js');
  check('A3 service.js 未知平台 Provider 为 makeUnsupported 产物（NONE）', /NONE\s*=\s*makeUnsupported/.test(svcSrc), 'ok');
  check('A3 current() 未知平台显式 return NONE（不落到任何真实现）', /return NONE;/.test(svcSrc), 'ok');
  check('A3 不支持路径抛 CapabilityError（非静默）',
    /throw new CapabilityError/.test(svcSrc), 'ok');
  const rU = capabilityProfile(UNKNOWN, 'x64');
  check('A3 未知平台 sandboxLaunch 声明为 false 且档位为 none',
    rU.sandboxLaunch === false && rU.sandboxEnforcement === 'none', JSON.stringify({ launch: rU.sandboxLaunch, enf: rU.sandboxEnforcement }));
  // openBrowser：档位 false 就必须**显式拒绝**，而不是「照样试一次 xdg-open 再返 ok:true」。
  //   openCommand 对未知平台仍退化 xdg-open（低层尽力），但那是映射不是能力；出口必须先问档位表。
  check('A3 未知平台 openBrowser=false 且唯一出口以档位表为准显式报 unsupported-platform',
    rU.openBrowser === false
    && /CAPABILITY_PROFILES\[k\]\.openBrowser/.test(readOs('browser.js'))
    && /SUPPORTED_OPEN_PLATFORMS\.includes\(pl\)/.test(readOs('browser.js'))
    && /'unsupported-platform'/.test(readOs('browser.js')), 'ok');
  // 未知平台的壳自启必须显式不支持（已在 A4 覆盖行为侧）
}

// -- A2 声明=true 必须有实现产物 --
console.log('== A2 声明能力必须有实现产物 ==');
{
  // 沙箱拉起（W3 后三平台声明 true）：能力位必须被执行侧真实消费。
  // linux=cgroup 硬档（transient 单元属性 + setLimits 动态下发）；darwin/win32/无 systemd-run 的
  // linux=portable 软档（spawn 拉起 + 锚点归属 + governor 采样处置）——声明 true 必须有实现产物。
  const sbxSrc = read('src/domains/instance/sandbox.js');
  check('A2 沙箱拉起 Linux 硬档（transient 单元含 MemoryMax/CPUQuota 限额属性）',
    /MemoryMax=/.test(sbxSrc) && /CPUQuota=/.test(sbxSrc), 'ok');
  check('A2 sandbox.supported() 消费 sandboxLaunch 能力位（不得另判平台）',
    /caps\.sandboxLaunch === true/.test(sbxSrc), 'ok');
  const svcImpl = readOs('service.js');
  check('A2 W3 运行期限额动态下发有实现产物（systemd.setLimits 经 set-property --runtime）',
    /setLimits\(unit, alloc\)/.test(svcImpl) && /set-property/.test(svcImpl) && /--runtime/.test(svcImpl), 'ok');
  const portImpl = readOs('portable.js');
  check('A2 W3 portable 档有实现产物（detached 拉起 + cmdline 锚点归属 + 有界停止复核）',
    /startTransient\(o\)/.test(portImpl) && /require\('\.\/spawn'\)/.test(portImpl)
    && /matchesAnchors/.test(portImpl) && /STOP_WAIT_CAP_MS/.test(portImpl), 'ok');
  for (const pl of ['darwin', 'win32']) {
    const r = capabilityProfile(pl, 'x64');
    check('A2 ' + pl + ' sandboxLaunch=true 由 portable 兑现（enforcement=supervise）',
      r.sandboxLaunch === true && r.sandboxEnforcement === 'supervise',
      JSON.stringify({ launch: r.sandboxLaunch, enf: r.sandboxEnforcement }));
  }
  const govSrc = read('src/domains/instance/governor.js');
  check('A2 限额由 governor 动态推导（非用户填额）', /function allocation\(/.test(govSrc) && /HEADROOM/.test(govSrc), 'ok');
  const pidSrc = readOsDir('pidlookup');
  check('A2 pidlookup 三平台分支齐全',
    /isLinux/.test(pidSrc) && /isMac/.test(pidSrc) && /isWindows/.test(pidSrc), 'ok');
  const procSrc = readOs('process.js');
  check('A2 process 有 Windows 分支（taskkill 整树）', /taskkill/.test(procSrc), 'ok');
  check('A2 process 有 POSIX 分支（进程组信号）', /kill\(-pid/.test(procSrc), 'ok');
  const notifySrc = readOs('notify.js');
  check('A2 notify 三平台实现',
    /notify-send/.test(notifySrc) && /osascript/.test(notifySrc) && /powershell|NotifyIcon/i.test(notifySrc), 'ok');
  // 外部打开（三平台 openBrowser=true）：声明为 true 就必须有「真起进程 + 真等结局」的产物。
  //   本组只钉**实现产物在场**；三档语义的行为证据在 platform-layer-portability X-10。
  const brSrc = readOs('browser.js');
  check('A2 外部打开有实现产物（argv 直启 + spawn 前可用性预检 + 有界观测子进程结局）',
    /detachedIgnored/.test(brSrc) && /if \(!avail\(plan\.bin\)\)/.test(brSrc) && /observeSpawn/.test(brSrc), 'ok');
  check('A2 三档结果有唯一构造点（ok/confirmed/handedOff/reason 不得由调用方各自解释 argv 结局）',
    /function outcome\(/.test(brSrc) && /ok,\s*confirmed,\s*handedOff,\s*reason/.test(brSrc), 'ok');
  // 声明 openBrowser=true 的机器必须答得出「系统里装了哪些浏览器」：这是外部打开的前提，
  //   也是本轮 Windows 缺陷的根因所在（旧实现从不枚举，只问一句被系统忽略的默认值）。
  //   判据按三平台分派逐一钉实现产物 + 留痕，不按当前宿主分叉，也不看导出名。
  const detSrc = readOs('browser-inventory.js');
  check('A2 探测层按三平台各有实现（Windows 多源注册表 / macOS LaunchServices / Linux .desktop 与 xdg-settings）',
    /function probeWin\(/.test(detSrc) && /function probeMac\(/.test(detSrc) && /function probeLinux\(/.test(detSrc)
    && /function inventory\(/.test(detSrc), 'ok');
  check('A2 探测层三平台事实齐备（Windows：UserChoice+协议关联+目录+App Paths；macOS：LaunchServices；Linux：mimeapps+desktop+PATH）',
    /UrlAssociations/.test(detSrc) && /StartMenuInternet/.test(detSrc) && /RegisteredApplications/.test(detSrc)
    && /App Paths/.test(detSrc) && /URLForApplicationToOpenURL/.test(detSrc)
    && /mimeapps/.test(detSrc) && /\.desktop/.test(detSrc) && /PATH/.test(detSrc), 'ok');
  check('A2 探测每条来源都留痕且按平台缓存（probed 抵达面板；面板轮询不得反复查注册表）',
    /probed/.test(detSrc) && /CACHE/.test(detSrc) && /ttl/.test(detSrc), 'ok');
  check('A2 探测意外不得变成用户可见的打开失败（异常兜成空清单并记 probe-error）',
    /catch/.test(detSrc) && /probe-error/.test(detSrc), 'ok');
  // 清单的唯一消费面是环境表单：动作层只问「这次交给谁」，不自己枚举 —— 谁都能枚举就谁都能给出不同答案。
  const envSrc = readOs('environment.js');
  check('A2 环境表单有只读消费面（面板/排障据此看到本机探到了什么，分发依据与候选清单同帧交出）',
    /function form\(/.test(envSrc) && /environment\.form\(/.test(read('src/api/domains/guard.js'))
      && /\/env\/environment/.test(read('src/api/domains/guard.js')), 'ok');
  check('A2 反向：动作层不得自己枚举候选清单（探测器只能被表单调用，否则「面板显示两个、实际按第三个启动」）',
    /environment\.browsers\(/.test(brSrc) && !/detector\.inventory\(/.test(brSrc), 'ok');
  check('A2 linux 的 openBrowser 声明由图形会话实测覆写（静态档位只说「能试」，不说「这次成了」）',
    /p\.openBrowser\s*=\s*desktop\.sessionAvailable\(\)/.test(readOs('index.js')), 'ok');
  const fpSrc = readOs('file-protect.js');
  check('A2 fileProtect Unix 分支（chmod）', /chmodSync/.test(fpSrc), 'ok');
  check('A2 fileProtect Windows 分支（icacls）', /icacls/.test(fpSrc), 'ok');
  // 守卫自启三平台
  const asSrc = readOsDir('autostart');
  check('A2 守卫自启 Linux（systemctl enable）', /systemctl/.test(asSrc) && /enable/.test(asSrc), 'ok');
  check('A2 守卫自启 macOS（launchctl bootstrap）', /launchctl/.test(asSrc) && /bootstrap/.test(asSrc), 'ok');
  check('A2 守卫自启 Windows（schtasks /Create）', /schtasks/.test(asSrc) && /\/Create/.test(asSrc), 'ok');
  // 壳自启
  check('A2 壳自启 Linux（XDG .desktop）', /autostart/.test(asSrc) && /\.desktop/.test(asSrc), 'ok');
  check('A2 壳自启 Windows（DSH-Supervisor-GUI 任务）', /DSH-Supervisor-GUI/.test(asSrc), 'ok');
  // 壳自愈：声明为 true 的平台必须有**真实的看护机制**
  {
    const wdPath = path.join(ROOT, 'src', 'domains', 'shell', 'watchdog.js');
    const exists = fs.existsSync(wdPath);
    check('A2 壳自愈有实现产物（domains/shell/watchdog.js）', exists, exists ? 'ok' : '缺失');
    if (exists) {
      //  域结构改造：纯决策 decide() 已下沉 core.js —— 读取面必须纳入 core.js，
      //   否则「决策为纯函数」断言会静默失去覆盖面（假绿）。沿用按域聚合读取范式。
      const wd = fs.readFileSync(wdPath, 'utf8') + String.fromCharCode(10) +
        read('src/domains/shell/core.js');
      check('A2 看护决策为纯函数（可穷举单测）', /function decide\(/.test(wd), 'ok');
      check('A2 看护要求图形会话（防无显示重启风暴）', /sessionAvailable/.test(wd), 'ok');
      check('A2 看护有界重试（防风暴）', /maxRestarts/.test(wd), 'ok');
      //  步骤 7：看护的装配/接线随启动序列下沉到 app/assembly/bootstrap.js
      //   （src/supervisor.js 收敛为薄壳）——判据改读新模块，否则文件一搬就静默失去覆盖面。
      const bootSrc = read('src/app/assembly/bootstrap.js');
      check('A2 看护已接线进守卫生命周期', /_startShellWatchdog/.test(bootSrc), 'ok');
    }
  }
}

// -- A5 自愈机制真伪 --
console.log('== A5 自愈机制真实性 ==');
{
  const asSrc = readOsDir('autostart');
  // 守卫 plist 的**内容模板**归桌面壳（所有权矩阵）—— 由壳仓测试负责，
  //   内核**不读壳仓源码**。内核侧只保留所有权不变量：不得再持有该模板。
  check('A5 内核不再持有守卫 plist 模板（macPlist 已删）', !/function macPlist/.test(asSrc), 'ok');
  // （G3/C2）：Windows 看护（watchdog）所有者 = 桌面壳（KERNEL-DAEMON-CONTRACT D6）。
  //   内核侧只保留**负向不变量**：不得再创建 watchdog 任务 / 写 watchdog.ps1。
  //   壳侧「建立看护任务、且壳检查独立于守卫块」由壳仓 K-7 门禁负责（内核不读壳仓源码）。
  check('A5 内核不再创建 Windows watchdog 任务',
    !asSrc.includes("'/TN', 'DSH-Supervisor-Watchdog'"), 'ok');
  check('A5 内核不再写 Windows watchdog 脚本',
    !/writeFileSync\([^)]*watchdog\.ps1/.test(asSrc), 'ok');
  // 声明为 true 的平台必须有对应机制（机制在壳仓，见其 K-7）
  check('A5 win32 shellSelfHeal 声明为 true（机制由壳仓保证）',
    capabilityProfile('win32', 'x64').shellSelfHeal === true, 'ok');
}

// -- A6 无回归：历史错误声明不得重现 --
console.log('== A6 历史错误声明不得重现 ==');
{
  const asCode = stripComments(readOsDir('autostart'));  //  只看代码，不看注释
  check('A6 无「mac 由 LaunchAgent 一并代管」的假声明', !/mac 由 LaunchAgent 一并代管/.test(asCode), 'ok');
  check('A6 无「同 plist 附带」的假声明（GUI 从未在 plist 中）', !/同 plist 附带/.test(asCode), 'ok');
  check('A6 无 setGuiAutostart 的静默成功分支',
    !/if \(!isLinux\) return \{ ok: true/.test(asCode), 'ok');
  // macOS status().gui 不得再谎报
  //  域结构改造：macOS status() 已落 autostart/darwin.js —— 直接读该实现文件。
  const macStatus = stripComments(readOs('autostart/darwin.js')).match(/function status\(\) \{[\s\S]*?return \{[^}]*\};/);
  check('A6 macOS status() 不再把守卫自启当作壳自启（gui: on）',
    !!macStatus && !/gui:\s*on/.test(macStatus[0]), macStatus ? macStatus[0].replace(/\s+/g, ' ').slice(0, 80) : '未找到');
  // Linux .desktop 的 Exec 不得硬编码 ~/.local/bin
  check('A6 Linux .desktop Exec 按实际安装解析（不硬编码 .local/bin）',
    /guiCommand\(\)/.test(asCode) && /oldExec/.test(asCode), 'ok');
}

// -- A7 壳自愈：声明 <-> 实现--
console.log('== A7 壳自愈：声明 ↔ 实现 ==');
{
  const wdRel = 'src/domains/shell/watchdog.js';
  const hasWd = fs.existsSync(path.join(ROOT, wdRel));
  // 纯核心 core.js 承载 DEFAULTS/decide —— 一并读取，否则宽限期/纯决策判据静默失效。
  const wd = hasWd ? read(wdRel) + String.fromCharCode(10) + read('src/domains/shell/core.js') : '';
  for (const pl of PLATFORMS) {
    const claimed = capabilityProfile(pl, 'x64').shellSelfHeal;
    check('A7 ' + pl + ' shellSelfHeal 声明为 true', claimed === true, String(claimed));
    check('A7 ' + pl + ' 声明为 true 且有实现产物', claimed ? hasWd : true, hasWd ? 'ok' : '缺 watchdog.js');
  }
  // 未知平台不得声称具备
  check('A7 未知平台 shellSelfHeal 为 false', capabilityProfile(UNKNOWN, 'x64').shellSelfHeal === false);
  // darwin 原生自启已于 补齐 —— 但必须是**独立 LaunchAgent**，
  // 不得复用守卫的 plist（那是壳的产权）。下面的 A8 组验证该分离。
  check('A7 darwin shellAutostart 为 true（2026-09-11 补齐）',
    capabilityProfile('darwin', 'arm64').shellAutostart === true);
  if (hasWd) {
    check('A7 看护覆盖三平台（不按平台分支）', !/process\.platform/.test(wd), '纯策略，平台差异在 desktop.js');
    check('A7 看护有宽限期（避让壳自更新空窗）', /graceMs/.test(wd) && /updateGraceMs/.test(wd), 'ok');
    check('A7 看护不假成功（失败如实上报）', /restart_failed/.test(wd), 'ok');
  }
  // 「壳写 identity.json 的 exe」是壳仓自身产出契约，由壳仓测试负责
  //   （src-tauri/src/update.rs::t1）。内核不读壳仓源码；内核侧只验证消费行为
  //   （shell-watchdog-test 的 W1-i / W3-c / W3-f）。
}

// -- A8 自启所有权：内核不越权 + GUI 产物与守卫分离 --
console.log('== A8 自启所有权不变量 ==');
{
  const asSrc = readOsDir('autostart');
  // 1) 内核不得写/删守卫的 plist（macOS）—— 那条路径上只允许 enable/disable + bootstrap/bootout
  const guardLabelRe = /GUARD_LABEL\s*=\s*'([^']+)'/;
  const guardLabel = (asSrc.match(guardLabelRe) || [])[1];
  const guiLabel = (asSrc.match(/GUI_LABEL\s*=\s*'([^']+)'/) || [])[1];
  check('A8 守卫与 GUI 使用**不同**的 LaunchAgent 标签',
    !!guardLabel && !!guiLabel && guardLabel !== guiLabel, guardLabel + ' / ' + guiLabel);
  check('A8 GUI 标签是守卫标签的子域（com.dsh.supervisor.gui）',
    guiLabel === guardLabel + '.gui', String(guiLabel));
  // 内核 macOS 分支不得出现写守卫 plist 或删除它的调用
  //  域结构改造：macOS setAutostart 落 autostart/darwin.js —— 切出该实现函数体，
  //   断言「内核只做 launchctl，不写/不删守卫 plist」仍然成立。
  const macBranch = (readOs('autostart/darwin.js').match(/function setAutostart\([\s\S]*?\n\}/) || [''])[0];
  check('A8 定位到 darwin setAutostart', macBranch.includes('守卫服务定义缺失'), macBranch ? 'ok' : '未找到');
  check('A8 内核 macOS 分支不写守卫 plist', !/writeFileSync\(atmp,\s*(plist|macPlist)/.test(macBranch), 'ok');
  check('A8 内核 macOS 分支不删除守卫 plist（否则关闭自启不生效）',
    !/unlinkSync\(file\)/.test(macBranch), 'ok');
  check('A8 内核用 launchctl enable/disable 持久化开关（关闭自启可生效）',
    /launchctl/.test(asSrc) && /on \? 'enable' : 'disable'/.test(asSrc), 'macSetEnabled');
  // 2) GUI plist 内容约束
  const guiPlist = asSrc.match(/function macGuiPlist[\s\S]*?\n}/);
  check('A8 GUI plist 存在（macOS 原生壳自启的产物）', !!guiPlist, 'ok');
  if (guiPlist) {
    check('A8 GUI plist 含 RunAtLoad（登录即启动）', /RunAtLoad/.test(guiPlist[0]), 'ok');
    check('A8 GUI plist **不含** KeepAlive（崩溃由守卫看护负责，避免两套机制争抢）',
      !/KeepAlive/.test(guiPlist[0]), 'ok');
    check('A8 GUI plist 限定 Aqua 会话（与实际图形会话判定同语义）',
      /LimitLoadToSessionType/.test(guiPlist[0]) && /Aqua/.test(guiPlist[0]), 'ok');
  }
  // 3) 内核不再持有守卫 plist 模板
  check('A8 内核已删除 macPlist（守卫定义归壳）', !/function macPlist/.test(asSrc), 'ok');
}

// -- A9 守卫自启：声明 <-> 内核有没有真正作用于守卫的关闭路径 --
console.log('== A9 守卫自启：声明 ↔ 内核可关闭性 ==');
{
  // 判据形态：该平台 setAutostart 体内**某一行同时**出现守卫标识与关闭动作。
  // 只写 GUI 产物（壳自启）不算关闭守卫自启；'DSH-Supervisor-GUI' 因引号闭合不同不会被当成守卫标识。
  const GUARD_ID = /['"]dsh-supervisor\.service['"]|\bGUARD_LABEL\b|\bGUARD_TASK\b|['"]DSH-Supervisor['"]/;
  const OFF_ACT = /:\s*'disable'|'disable-linger'|,\s*false\s*\)|\/DISABLE\b|['"]\/Delete['"]/;
  function guardOffEvidence(src) {
    const body = (/function setAutostart\([\s\S]*?\n\}/.exec(src) || [''])[0];
    return body.split(String.fromCharCode(10)).some((l) => GUARD_ID.test(l) && OFF_ACT.test(l));
  }
  /** 已知违例基线（显式登记，只减不增；同 ML-2 形态）。补上关闭路径后必须同步撤登记。 */
  const NO_OFF_PATH = {
    win32: '守卫任务与看护任务均由壳建立，内核 setAutostart 只写 DSH-Supervisor-GUI —— 面板关不掉守卫自启',
  };
  const violating = [];
  for (const pl of PLATFORMS) {
    const claimed = capabilityProfile(pl, 'x64').guardAutostart === true;
    const ev = guardOffEvidence(blankComments(readOs('autostart/' + pl + '.js')));
    if (claimed && !ev) violating.push(pl);
    check('A9 ' + pl + ' 声明(' + claimed + ')↔内核关闭路径(' + ev + ') 一致或违例已登记',
      !claimed || ev || pl in NO_OFF_PATH, NO_OFF_PATH[pl] || 'ok');
  }
  check('A9 违例平台集合 ⊆ 登记集合（新增平台关不掉守卫自启即判红）',
    violating.every((p) => !!NO_OFF_PATH[p]),
    violating.length ? '违例: ' + violating.join(',') : '无违例（登记表应随之清空）');
  check('A9 登记集合无死条目（已能关闭的平台必须撤登记）',
    violating.length === Object.keys(NO_OFF_PATH).length && violating.every((p) => !!NO_OFF_PATH[p]),
    '违例=' + (violating.join(',') || '无') + ' 登记=' + (Object.keys(NO_OFF_PATH).join(',') || '无'));
  check('A9 未知平台不得声称可关守卫自启',
    capabilityProfile(UNKNOWN, 'x64').guardAutostart === false);
  // 反向自检（合成样本，不依赖真实数据）：同一判据必须认出合规形态并拒绝 GUI-only 形态。
  const LF9 = String.fromCharCode(10);
  const synthGuardOff = ['function setAutostart(on) {',
    "  ex('systemctl', ['--user', on ? 'enable' : 'disable', 'dsh-supervisor.service']);", '}'].join(LF9);
  const synthGuiOnly = ['function setAutostart(on) {',
    "  ex('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']);", '}'].join(LF9);
  check('A9 反向：守卫标识+关闭动作必被认出、只删 GUI 任务必判无路径',
    guardOffEvidence(synthGuardOff) === true && guardOffEvidence(synthGuiOnly) === false, 'hit');
  check('A9 反向：函数体定位失败时判无路径（不得把空body当通过）',
    guardOffEvidence('const x = 1;') === false, 'hit');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);