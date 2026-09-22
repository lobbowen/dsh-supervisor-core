'use strict';

// 平台静态能力档位（纯数据）：各平台的期望声明，工具类字段由 index.js#capabilities 用 hasTool
// 实测覆写。分派留在 index.js#capabilityProfile —— cross-platform-architecture-gate CP-3 要求门面
// 显式列出三平台分支，故本表不带平台判断。
// guardAutostart/guardSelfHeal/shellAutostart/shellSelfHeal 为服务链的自启与自愈声明。

/** Linux 档位：期望 systemd（systemd-run/systemctl/notify-send 实测覆写）。 */
const linux = {
  // 两维拆分声明：sandboxLaunch = 能否运行实例舱；sandboxEnforcement = 限额由谁执行（cgroup|supervise|none）。
  sandboxLaunch: true,        // W3：恒可跑舱；有 systemd-run 走 cgroup 硬档，无则落 portable 软档（容器/WSL1）
  sandboxEnforcement: 'cgroup', // 期望 cgroup 硬限额；无 systemd-run 实测降 'supervise'（采样式，无内核强制）
  pidAdoption: true,
  processTreeKill: true,
  desktopNotify: true,   // 期望 notify-send（实测覆写）
  autostart: true,       // 期望 systemctl（实测覆写）
  frpExpose: true,
  hostService: 'systemd',
  guardAutostart: true,  // systemd --user enable + linger
  guardSelfHeal: true,   // unit Restart=always
  shellAutostart: true,  // 原生：XDG autostart .desktop（Exec 按实际安装解析）
  shellSelfHeal: true,   // 守卫看护（domains/shell/watchdog，三平台一套机制）
};

/** darwin 档位：期望 launchd / osascript 实测覆写。 */
const darwin = {
  sandboxLaunch: true, // portable provider（platform/os/portable.js，W3）：spawn 独立进程组 + 端口/cmdline 锚点，无需外部工具
  sandboxEnforcement: 'supervise', // 采样式限额（governor 违规处置），无内核强制——如实声明，launchd plist 一期不做
  pidAdoption: true,    // lsof
  processTreeKill: true,
  desktopNotify: true,  // 期望 osascript（实测覆写）
  autostart: true,      // launchctl/LaunchAgent 恒在
  frpExpose: true,
  hostService: 'launchd',
  guardAutostart: true,  // LaunchAgent RunAtLoad + KeepAlive
  guardSelfHeal: true,   // KeepAlive
  // 壳自启 = 独立 LaunchAgent com.dsh.supervisor.gui（RunAtLoad），内核创建/删除；
  // 守卫 plist 归桌面壳建立，内核只 enable/disable + bootstrap/bootout。
  shellAutostart: true,
  shellSelfHeal: true,   // 守卫看护（三平台一套机制）
};

/** win32 档位：期望 schtasks/powershell/taskkill 实测覆写。 */
const win32 = {
  sandboxLaunch: true, // portable provider（W3）：windowsHide + CREATE_NEW_PROCESS_GROUP，整树终止走 taskkill
  sandboxEnforcement: 'supervise', // 采样式限额；Job Object 硬档一期不做不预留（届时以真机数据另立项）
  pidAdoption: true,    // netstat
  processTreeKill: true, // taskkill /PID /T /F（hasTool 覆写；使用点见 app/main/signals.js 的 _killTree）
  desktopNotify: true,   // 期望 powershell（实测覆写）
  autostart: true,       // 期望 schtasks（实测覆写）
  frpExpose: true,
  hostService: 'windows-service',
  guardAutostart: true,  // schtasks DSH-Supervisor（ONLOGON，由壳建立）
  guardSelfHeal: true,   // schtasks DSH-Supervisor-Watchdog 每 5 分钟（同样归壳，内核只查询存在性）
  shellAutostart: true,  // schtasks DSH-Supervisor-GUI（ONLOGON，内核 setAutostart 创建）
  // 壳的自愈依赖那条 watchdog 任务，故与 guardSelfHeal 同前提：登录自启未启用时无从检查。
  shellSelfHeal: true,
};

/** 未知平台档位：全能力 false，hostService=none（显式失败，不谎报）。 */
const unknown = {
  sandboxLaunch: false, sandboxEnforcement: 'none',
  pidAdoption: false, processTreeKill: false,
  desktopNotify: false, autostart: false, frpExpose: false,
  hostService: 'none',
  guardAutostart: false, guardSelfHeal: false,
  shellAutostart: false, shellSelfHeal: false,
};

module.exports = { linux, darwin, win32, unknown };
