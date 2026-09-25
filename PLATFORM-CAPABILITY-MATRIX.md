# 内核跨平台能力矩阵（可执行审计）

> 生成日期：2026-09-11　末次校准：2026-09-25（外部打开能力收口为单一出口 + 三档结果语义，见 §九）
> 范围：内核仓 `src/platform/os/`（跨平台能力面）+ 实例舱档位（`domains/instance` × provider 分档，见 §八）
> 配套测试：**`test/platform-capability-audit-test.js`**（A1–A9 组；条数不在此维护，写了就是会过期的数。三平台 CI 均运行）

---

## 一、为什么需要这份文档

本项目曾发生一次**跨平台能力的系统性误判**，值得作为反面教材：

macOS 的**壳自启 / 壳自愈从项目奠基提交（`8867942`, 2026-09-01）起就不存在**，
但整整四层都「确认」它存在：

```
① 注释        「macOS：LaunchAgent plist + 登录面板（同 plist 附带）」   ← 声称已实现
      ↓ 被当作规范读
② 实现        setGuiAutostart: if (!isLinux) return { ok: true }        ← 静默成功
      ↓ 被当作证据
③ 状态        status() → { gui: on }（把守卫自启当成壳自启）             ← 硬编码谎报
      ↓ 被当作事实
④ 审计文档    AUDIT-CROSS-PLATFORM.md：「三端齐全」                      ← 按平台名数，未验证行为
      ↓
⑤ 测试        只断言「函数返回绝对路径」—— 从未断言「能力存在」
```

**四层互相背书，没有一层验证行为。** 而 `macPlist` 从奠基提交至今**逐字节未变**（16 行，只含守卫）——
只要有任何一处做了行为验证，第一天就会暴露。

### 本文件与配套测试确立的不变量

1. **声明必须有断言支撑** —— 文字（注释 / 审计报告 / 文档）**不构成证据**；
2. **「不支持」是可接受的回答，「假装支持」不是** —— 未实现的能力必须**显式报告**，
   绝不静默返回成功（与 `service.js` 的 `CapabilityError` 同规）；
3. **能力必须区分「守卫」与「壳」** —— 原矩阵把守卫能力写在「整链」行里，
   这正是掩盖 macOS 缺口的原因（见 §三）；
4. **测试不得依赖外部状态** —— 断言「无 systemd 单元」就必须隔离 `$HOME`，
   否则跑过一次真实壳之后该断言必然失败（同一失效模式：断言与行为脱钩）。

---

## 二、能力矩阵（每格由测试强制绑定）

图例：**✅ 已实现**　**❌ 未实现（显式报告）**

| # | 能力 | Linux | macOS | Windows | 实现位置 | 验证 |
|---|---|---|---|---|---|---|
| C1 | 产品数据目录 | ✅ | ✅ | ✅ | `platform/os/index.js` | A1 |
| C2 | 可执行解析（PATH/标准目录/扩展名）| ✅ | ✅ | ✅ | `platform/os/exec-path.js` | A2 · cross-platform P0 |
| C3 | 敏感文件保护 | ✅ `chmod` | ✅ `chmod` | ✅ `icacls`（真实 PATH 实测可用，且可用时绝不谎报 `none`） | `platform/os/file-protect.js` | A2 · cross-platform P1 · run `35488336734` 实测（原挂账结案见 AUDIT-REPORT §H-8-9/§H-7-16）。⚠ 本格证明的是 **CI windows runner**，不是任意 Windows 生产机 |
| C4 | 进程信号 / 进程树终止 | ✅ 进程组 `kill(-pid)` | ✅ 进程组 | ✅ `taskkill /T` | `platform/os/process.js`（负 pid 组信号唯一收口，CP-7）；池式消费者经载体门面 `platform/os/carrier.js`（PROXY-ISOLATION-STANDARD L1，反代域零裸 kill） | A2 · cross-platform P3 |
| C5 | 端口 → PID 反查 | ✅ `/proc` + `ss` 兜底 | ✅ `lsof` | ✅ `netstat -ano` | `platform/os/pidlookup/index.js` | A2 |
| C6 | 进程列表 / 命令行读取 | ✅ `pgrep -af` | ✅ `pgrep` + `ps` | ✅ CIM | `platform/os/pidlookup/index.js` | A2 |
| C7 | 桌面通知 | ✅ `notify-send` | ✅ `osascript` | ✅ PowerShell 气泡 | `platform/os/notify.js` | A2 |
| C8 | 打开浏览器（外部打开）：**四层各一处** —— 探测 `platform/os/browser-inventory.js`（这台机器装了哪些浏览器、默认是哪个、每条结论来自哪条系统事实）→ 选路 `pickLauncher`（只有「系统说得出的默认项」与「穷举唯一解」两条，多候选且系统说不出默认项即显式失败，不按清单顺序猜）→ 执行 `openBrowser`（非隔离）/ `launchIsolated`（登录隔离窗口，隔离参数按解析结果的引擎族展开）→ 消费面（HTTP 与面板原样透传同一结果词汇 `{ok, confirmed, handedOff, reason, error, message, url, evidence}`）。三档语义：`confirmed`=本次启动确定拥有自己的窗口且它以 0 退出（判据只写在 `ownsItsWindow` 一处，双向生效）；`handedOff`=只证明交出去了（裸 URL 直启可被既有实例吸收，故 win32 全部形态都属此类）；`ok:false`=显式失败并带 reason 码 + 探测诊断 | ✅ 扫 XDG/flatpak/snap 的 `.desktop`（主条目 `Exec` 还原真实命令、`env` 包装去壳、裸名按 PATH 解析）+ `mimeapps.list`/`xdg-settings` 定默认；`other` 引擎（snap 包装器）交回 `xdg-open`；无图形会话时 `capabilities()` 实测把 `openBrowser` 覆写为 false 并报 `no-desktop-session` | ✅ `NSWorkspace.urlsForApplicationsToOpenURL`（macOS 12+，不可用时回落单默认值老路）给清单、`URLForApplicationToOpenURL` 给默认；本体不可执行即剔除并留痕；Safari 等 `other` 引擎走 `open` | ✅ 五源并集：`UrlAssociations\https\UserChoice`（用户自己选的）优先，其次 `Classes\https` 协议关联（系统真正把地址交给谁），再 `Clients\StartMenuInternet` **子键目录**（其默认值自 Win7 起被系统忽略，故只当目录用）、`RegisteredApplications`、`App Paths`；`REG_EXPAND_SZ` 自行展开。**没有可信调度器**，只直启解析出的本体；选不出即 `no-launcher` 并带诊断 | `platform/os/browser-inventory.js`（探测：平台事实只写一次、每条来源都留痕、按平台缓存）+ `platform/os/browser.js`（选路与执行：结果词汇唯一构造点 `outcome()`；argv 永不裹 shell） | A1·A2（能力位 + 探测层分平台实现与留痕/缓存）· A3（未知平台显式 `unsupported-platform`）· P-5（声明 + `exitIsEvidence` 取证档位 + 旧冒开形态判据）· X-8（探测夹具、选路、计划）· X-10（三档行为 + 诊断必达 `evidence`）· X-11（分层唯一出口的源码级不变量）· `api-contract` OW/OB 两组（三档透传 + 只读清单面）· `ui` `externalOpen.test.ts`（面板分档判据与 `evidenceDetail` 把探测诊断摊上屏幕） |
| C9 | 宿主服务单元管理（systemd 单元语义：daemonReload / 持久单元 / failed 复位） | ✅ systemd | ❌ **显式**（launchd 无 provider；实例舱由 `portable` 档承担，见 C10，不冒充服务管理器） | ❌ **显式**（同左；Windows 服务无 provider，实例舱走 `portable` 档） | `platform/os/service.js` | A3 |
| C10 | 沙箱实例舱（两维拆分声明：拉起 `sandboxLaunch` / 限额执行 `sandboxEnforcement`；provider 分档见 `service.current()`） | ✅ 拉起 + 限额 `cgroup`（`systemd-run` transient；运行期动态限额 `systemctl --user set-property --runtime`）；无 user-systemd 的容器/WSL1 自动落 `portable` 软档 | ✅ 拉起 + 限额 `supervise`（`portable` provider：端口反查 + cmdline 锚点认领，软档无内核强制） | ✅ 拉起 + 限额 `supervise`（同 macOS；未知平台仍**显式** launch=false、enforcement=none） | `platform/os/{service,portable}.js`（provider 分档与 dispatch） + `platform/os/capability-profile.js` + `domains/instance/{sandbox,governor}.js` + `platform/os/resstats.js`（W2 采样观测；governor 决策/准入三平台同跑；W3 落地运行期限额动态化：systemd `setLimits` 下发，portable `setLimits` 恒 false = 档位声明而非缺陷） | A1·A2·A3 · P-5 · X-3·X-3b·X-3c·X-3d |
| C11 | **守卫**开机自启 | ✅ systemd + linger | ✅ LaunchAgent | ✅ schtasks | `platform/os/autostart/index.js` | A2 |
| C12 | **守卫**崩溃自愈 | ✅ `Restart=always` | ✅ `KeepAlive` | ✅ 保活归**桌面壳**（2026-09-15 起内核不再创建 watchdog 任务）| `platform/os/autostart/index.js` | A5 |
| C13 | **壳**开机自启（原生机制） | ✅ XDG `.desktop` | ✅ LaunchAgent `com.dsh.supervisor.gui` | ✅ schtasks `DSH-Supervisor-GUI` | `platform/os/autostart/index.js` | A4 · A8 · P1–P5 |
| C14 | **壳**崩溃自愈 | ✅ 守卫看护 | ✅ 守卫看护 | ✅ 守卫看护 | `domains/shell/watchdog.js` | A7 · W1–W5 · E2E |

**运行时声明**：`capabilityProfile()` 输出 `guardAutostart` / `guardSelfHeal` / `shellAutostart` /
`shellSelfHeal` / `openBrowser` 等布尔能力位，经 `/env/status` 暴露给壳与面板 —— 消费者据此做能力
感知与降级提示，**不再依赖注释或文档描述**。`openBrowser` 在 Linux 由 `capabilities()` 用图形会话
实测覆写（静态档位只说「能试」，不说「这次成了」）。

---

## 三、原矩阵的错误与更正

原 `AUDIT-CROSS-PLATFORM.md` §五 的矩阵把**守卫能力**写在了**整链能力**的行里：

```diff
- | 开机自启 | systemd --user + linger | LaunchAgent + KeepAlive | schtasks ×2 |
- | 崩溃自愈 | systemd Restart=always   | KeepAlive                | Watchdog     |
```

于是 macOS 那格看起来「齐全」，而**壳完全没有自启/自愈**这一事实被掩盖。
现拆分为「守卫」与「壳」两行（C11–C14），缺口变得可见。

同时更正：`os/autostart.js` 评级由 **C+「三端齐全」下调为 D** ——
不是实现质量差，而是**声明与实现不一致**（`setGuiAutostart` 静默成功 + `status()` 谎报）。

---

## 四、本次修复清单（2026-09-11）

| # | 缺陷 | 修复 | 验证 |
|---|---|---|---|
| F1 | `setGuiAutostart` 对非 Linux **静默 `ok:true`** | 未实现平台显式返回 `{ok:false, unsupported:true}` | A4 |
| F2 | macOS `status()` **谎报 `gui: on`** | 如实返回 `gui:false, guiSupported:false` | A6 |
| F3 | Windows watchdog 的**壳检查嵌套在 `if (-not $up)` 内** | 移出守卫块 —— 使「壳崩、守卫活」时可自愈 | A5 |
| F4 | Linux `.desktop` 的 `Exec` **硬编码 `~/.local/bin`** | 按实际安装解析（deb 装在 `/usr/bin`）| A6 |
| F5 | 能力字段**缺失**（无 `shellAutostart`/`shellSelfHeal`）| `capabilityProfile()` 补 4 个字段 | A1 |
| F6 | 假声明注释 / 悬空路径（如已被重构掉的 `infra/platform/…` 引用）| 更正注释，标注真实能力来源 | A6 |
| F7 | `guard-update-test.js` S8 **依赖开发者 `$HOME`**（该测试文件已于 2026-09-15 `83228d1` 随内核更新单写入者改造删除）| 隔离 HOME（跑过真实壳后不再误报）| 该套测试 |

### F3 详解（用户直接指出的缺陷）

```powershell
# 修复前 —— 壳检查被嵌在守卫块内
if (-not $up) {                       # 仅当「守卫也不可达」时才进入
  ... 拉起 darwin/windows 守卫 ...
  $g = @(Get-Process -Name dsh-supervisor-gui ...)
  if (-not $g) { Start-Process $gui }  # ← 壳自愈在这里
}
```

**「壳崩、守卫活」→ `$up` 为真 → 整块跳过 → 壳永远不会被拉起。**
而那恰是壳自愈唯一需要生效的场景（守卫由服务管理器保活，壳无人管）。
修复后壳检查独立于守卫状态（C14 Windows 列由此变为 ✅）。

---

## 五、壳自愈：已实现（2026-09-11）

守卫看护桌面壳（`domains/shell/watchdog.js`），**三平台一套机制**，无需新增服务定义。

**为什么由守卫做**：产品意图「壳关不掉」意味着壳只会在**崩溃**时消失，而壳**无法自我监督**
（监督者会随它一起死）。守卫是抗重启的那个（`Restart=always` / `KeepAlive` / schtasks Watchdog），
且**已在读取** `identity.json`、**已实现** `restartShell()`。

```
守卫每 20s：pgrepList → 过滤出真正的壳进程（排除 --*-plan 自检进程）
  ├─ 壳在运行                         → 重置计时
  ├─ 缺失 < 宽限（默认 90s）           → 等待（避让壳自更新/自重启空窗）
  ├─ 处于预期缺席（更新/重启中）        → 用更长宽限（默认 300s），不抢跑
  ├─ 无图形会话（Linux 注销/无 DISPLAY）→ 跳过（拉起必失败 → 会成重启风暴）
  ├─ 窗口内已达上限（默认 5 次/30min）  → 跳过（防风暴）
  ├─ 无法定位壳可执行文件              → 跳过（不盲拉）
  └─ 否则                             → restartShell({exePath}) 拉起
```

**关键设计**：

| 设计 | 理由 |
|---|---|
| 决策为**纯函数** `decide()` | 可穷举单测，不依赖进程/时钟/文件系统 |
| 以**进程实际存在**为准 | 不以文件/心跳推断（壳可能已死但文件还在）|
| 宽限期 + 更新期延长 | 避让壳自更新/自重启的瞬时空窗（否则会抢跑）|
| **必须有图形会话** | Linux 经 linger 在注销后仍运行 —— 此时拉起 GUI 必失败 |
| 记账在**尝试前** | 失败同样计入上限，防失败风暴 |
| 失败**如实上报** | 写 `shell_watchdog_restart_failed` 事件，不假成功 |
| 异常不影响守卫主循环 | 看护是**增强**，不是守卫的依赖 |

**壳侧配套**：`identity.json` 新增 `exe`（`std::env::current_exe()`）与 `lastSeenAt` ——
壳崩溃后进程已不存在，`pgrepList` 拿不到它的 cmdline，**必须有一个已落盘的路径来源**。

### 验证

| 测试 | 覆盖 |
|---|---|
| `test/shell-watchdog-test.js`（W1–W5，36 项）| 决策穷举 + 进程过滤 + 集成（注入 mock）+ 接线 + 壳侧契约 |
| `test/shell-watchdog-e2e-test.js`（E2E，6 项）| **真实 Supervisor + 真实 spawn**：壳缺失 → 真的被拉起 |

## 六、自启所有权矩阵（2026-09-11 定案）

此前**没有**矩阵，导致 macOS 上两个写入方争同一个 plist。现明确：

| 产物 | 唯一所有者 | 依据 |
|---|---|---|
| 守卫服务**定义**（unit / plist / 计划任务）| **桌面壳**（`service.rs`）| 引导顺序：壳是安装器，装内核后立即建立 |
| 守卫自启**开关**（enable/disable）| **内核**（面板）| 用户可见设置项在面板 |
| 壳（GUI）自启产物 | **内核**（`autostart.js`）| 同上；与守卫自启同属「整链自启」语义 |
| 壳崩溃自愈 | **守卫看护** | 壳不能自监督（`domains/shell/watchdog`）|

### 修复的两类缺陷

**① 双写冲突（macOS）**

内核与壳**同时写** `~/Library/LaunchAgents/com.dsh.supervisor.plist`，且内核 disable 时
`unlink` 该文件，而壳下次启动会重建并 bootstrap →
**用户「关闭自启」不生效**（下次开机又回来了）。

现内核**只做 `launchctl enable/disable` + `bootstrap/bootout`，绝不写/删该文件**。
`launchctl enable/disable` 持久化到 launchd 覆盖库 —— 这才是「关闭」能生效的机制。

**② macOS 无壳自启**

旧注释谎称「同 plist 附带」，实测只含守卫。现新增**独立** LaunchAgent：

```
com.dsh.supervisor      ← 守卫（壳所有）
com.dsh.supervisor.gui  ← 桌面壳（内核所有）
```

GUI plist 的关键约束：**只表达「登录启动」**（`RunAtLoad` + `LimitLoadToSessionType=Aqua`），
**不加 `KeepAlive`** —— 崩溃恢复归**守卫看护**负责（它有会话判定、宽限期、有界重试）；
两套机制同时管会互相争抢，且 launchd 的 KeepAlive 在 GUI 应用上可能造成无退避重启循环。

### 现在三平台能力齐备

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| 壳开机自启（原生机制） | ✅ systemd + XDG | ✅ LaunchAgent | ✅ schtasks |
| 壳崩溃自愈 | ✅ 守卫看护 | ✅ 守卫看护 | ✅ 守卫看护 |

> 「原生自启」与「崩溃自愈」是**两个独立字段**：前者管「重启后自己回来」，
> 后者管「运行中崩了被拉起」。二者互补，不互相替代。

---

## 七、审计跑在哪里

这三份审计（`test/platform-capability-audit-test.js`、`test/capability-profile-test.js`、
`test/cross-platform-test.js`）都在 `package.json#scripts.test` 链里，**由 CI 的 `test` job 执行**：

```bash
npm test        # 只在 CI 内跑；本机一律不得执行（ACCEPTANCE-STANDARD §0 硬标准）
```

> 本节此前给出 `node test/xxx.js # 任意平台可跑` 的单跑命令 —— 那正是 `ACCEPTANCE-STANDARD.md` §0
> 禁止的动作，且单跑绕过 `_preload.js` 的沙箱 HOME 注入，会往真实状态根写文件。故删去。
> 断言条数也不在此维护：多数断言在循环里展开，静态数不出来，写了就是会过期的数。

审计测试的六组不变量：

| 组 | 含义 |
|---|---|
| **A1 完整性** | 每个能力字段对三平台 + 未知平台都有明确布尔值（无 `undefined`）|
| **A2 声明=true** | 该能力必须有**实现产物**（源码/机制证据）|
| **A3 声明=false** | 该能力必须**显式报告不支持**（绝不静默成功）|
| **A4 行为一致** | 模块的跨平台行为与 `capabilityProfile()` 声明一致（真实调用，非文本扫描）|
| **A5 自愈真伪** | 自愈类能力的声明匹配实际机制（不得声称存在而实现被条件屏蔽）|
| **A6 无回归** | 历史错误声明不得重现（剥离注释后检查代码）|
| **A7 壳自愈** | 声明 ↔ 看护机制一致（三平台一套机制，纯策略不得按宿主分支）|
| **A8 自启产权** | 内核不得越权写/删守卫服务定义（定义归壳）|
| **A9 守卫自启** | `guardAutostart=true` 即要求内核有真正作用于守卫的关闭路径 |

---

## 八、实例舱（沙箱多实例）能力小节

矩阵行 C10 的两维拆分在此展开：`sandboxLaunch`（能不能跑舱）与 `sandboxEnforcement`
（限额由谁执行）**是两个独立字段**，合并声明会掩盖「可跑舱但只软限」的真实形状。

| 运行环境 | 拉起 `sandboxLaunch` | 限额执行 `sandboxEnforcement` | 执行 provider | 隔离定性 |
|---|---|---|---|---|
| Linux（有 user-systemd）| ✅ | `cgroup` | `systemd`（`systemd-run` transient 单元）| **内核级硬限**：MemoryMax/MemoryHigh/CPUQuota 由 cgroup 强制，越限即被内核节流/杀 |
| Linux（容器 / WSL1 等无 user-systemd）| ✅ | `supervise` | `portable` | 软限（同 macOS/Windows 行）；分档由**实测探测**决定，不按平台名写死 |
| macOS | ✅ | `supervise` | `portable` | 软限：采样观测 + 超标拍数判定 + 守卫收割重启（非内核强制）|
| Windows | ✅ | `supervise` | `portable` | 同 macOS 行 |
| 未知平台 | ❌ **显式** | `none` | NONE（调用即抛 `CapabilityError`）| 不静默成功，也不假装支持 |

**「软限」不是「不支持」的委婉说法，是可执行的处置链**：`governor.decide()` 每拍（5s）
按机器预算与活跃实例数推导目标配额（预留 + 突发两级，带迟滞），`resstats` 采样进程树
rss / cpu-time，内存连续 3 拍 / CPU 连续 5 拍超限即记 `inst_resource_violation` → 停止 →
按状态机 BACKOFF 自愈。运行期限额变更在 systemd 档经 `set-property --runtime` 当拍下发，
portable 档 `setLimits` 恒 `false` —— 这是**档位声明**而非缺陷（无内核强制点可下发）。

**分工铁律**（防止档位差异渗回业务层）：拉起 / 停止 / 活跃判定归 provider；「该发多少」
永远归 `governor.decide`；域层 `process.platform` 分支数必须为 **0**。
`portable` 与 `systemd` 两档的动词形状（11 键方法集）由 X-3 静态对账强制同形，
调用点因此无需知道自己跑在哪一档。

**认领与宽严分离**（portable 档的身份问题，无 pidfile 权威时）：实例身份 = 端口反查 +
命令行锚点（`--port` / 可执行入口）复核，`run.pid` 仅覆盖「已拉起未监听」窗口，PID 复用由
锚点判死。查询降级宽松（`isUnitActive` 无锚点时仅凭端口，查不到返三态 `null` 而非谎报不活跃），
杀进程从严（`stopUnit` 必须锚点命中，未确认不杀并返 `false`；纯端口回退命中标 `ownGroup=false`，
不把他进程组当本实例）。

**已裁决不做**（避免为 mac/win 模仿 systemd）：Windows Job Object、launchd plist provider、
容器专属栈、用户手填额、`sandboxDynamicLimits` 第三能力字段。

**验证**：`platform-layer-portability-test` X-3（分档不变式 + 方法集对账）· X-3b（注入假
pidlookup 的认领/停止语义矩阵）· X-3c（真实宿主拉起→监听→认领→停止闭环，每平台 runner 各跑一次）；
`instance-state-test` 7A/7E（启停 ctx 同源、动态下发、不变不重发）；
`exec-return-contract` A4b/A5；`four-platform-behavior-matrix` P-5；本文件 A1·A2·A3。

---

## 九、外部打开标准（把地址交给系统浏览器）

**为什么单独立标准**：这不是「一个小按钮点不动」的缺陷，而是**跨平台基础能力长期没有分层**的
结果——面板、反代登录、实例 Web 各自调 `spawn`/`window.open`，各自把「没报错」解释成「已打开」。
用户看到的就是「面板显示成功，屏幕上什么都没有」，而且再也拿不到那个地址。

**分层固定，每层只干一件事**（任何一层都不越层：先知道系统里有什么，才谈得上交给谁，才谈得上证据）：

| 层 | 归属 | 只回答 | 不得做 |
|---|---|---|---|
| L1 探测 | `platform/os/browser-inventory.js` | 这台机器装了哪些浏览器、默认是哪个、每条结论从哪条系统事实读来 | 不 launch、不猜命令、查不到时不替用户挑一个试试 |
| L2 选路 | `browser.js#pickLauncher` / `formOfBin` / `openPlan` / `isolatedPlan` | 这次交给清单里的哪一条、以何种形态 | 不碰系统事实、不点名任何浏览器 |
| L3 执行 | `browser.js#openBrowser` / `launchIsolated` + `observeSpawn` | spawn 一次并如实回报拿到的是哪一档证据 | 不把「没报错」改写成「已打开」 |
| L4 消费面 | `GET /env/browsers`（只读）+ `evidence.diagnostics` | 把 L1 的结论与 L3 的档位原样摊到屏幕上 | 不另立第二套语义、不改写 reason 码 |

### S-0 探测层：先知道系统里有什么浏览器

`platform/os/browser-inventory.js` 是**唯一**问系统「装了哪些浏览器」的地方，三端各自实现、共用同一
输出契约 `{browsers[], defaultId, defaultSource, probed[]}`：

| 平台 | 清单来源（取并集） | 默认项来源（有高低，晚到的低优先级来源不得翻案） |
|---|---|---|
| win32 | `UrlAssociations\https\UserChoice` 指向的 ProgID、`Classes\https` 协议关联、`Clients\StartMenuInternet` **子键目录**、`RegisteredApplications` 能力路径、`App Paths`（HKCU 先于 HKLM） | `UserChoice`（用户自己选的）> `Classes\https` 的 `shell\open\command`（系统真正把地址交给谁）> 穷举唯一解 |
| darwin | `NSWorkspace.urlsForApplicationsToOpenURL`（macOS 12+ 文档化「可打开该 URL 的全部应用，最佳匹配在前」），不可用时只交得出下面那条默认值查询的结果 | `URLForApplicationToOpenURL`（同一份清单里标记默认项）> 穷举唯一解 |
| linux | XDG/flatpak/snap 各 `.desktop` 目录（`Categories` 含 `WebBrowser` 且解析出的可执行文件属两族引擎） | `mimeapps.list` 规范顺序（用户级先于系统级）> `xdg-settings` > 穷举唯一解 |

三条硬要求：

1. **每条来源都留痕**：`probed[{source, detail}]` 记下每个来源答了什么（读到几项、无输出、指向的文件
   不可执行）。真机报障时这一份就是定档依据，不必回去读代码。
2. **只认能落地的条目**：注册表/清单报了但本体不可执行的一律剔除并留痕。`id` 恒为归一后的可执行文件
   路径（win32 反斜杠小写、其余 POSIX 小写），`defaultId` 靠它在清单里定位——所以「默认项」与「清单」
   必须同源，否则选路层永远命中不了。
3. **探测永不是用户可见的失败原因**：单条查询 1.5s 上界、任何异常都降级为一条 `probe-error` 留痕，
   最坏结果是清单为空 → 执行层显式 `no-launcher`；结果按平台缓存 60s（面板轮询不得反复触发注册表/目录
   扫描），`?force=1` 与 `invalidateBrowsers()` 是安装/卸载浏览器后的两个入口。

跨宿主纯度（同一份测试要在四平台 runner 上同判）：linux 侧路径拼接恒用 `path.posix.join`、PATH 恒按
`':'` 拆，不经宿主 `path.join`；可执行性判定只有一个 `canExec` 注入缝（文件在 **且** 有执行位），
不写成 `exists || canExec`。

### S-1 唯一出口 + 三档诚实语义

内核侧外部打开**只有一个出口**：`platform/os/browser.js#openBrowser`（非隔离）与
`#launchIsolated`（登录用的隔离窗口）。两者共用同一结果词汇，调用方与面板不再各自解释 argv 结局。

| 档位 | 判据（不是文案） | 允许说 | 禁止说 |
|---|---|---|---|
| `confirmed` | 本次启动**确定拥有自己的窗口**（`ownsItsWindow`）且它以 0 退出 | 「已在系统浏览器打开」 | —— |
| `handedOff` | 命令已交出、`spawn` 没报错，但退出码不属于「窗口是否出现」这个事实：被既有实例吸收的裸 URL 直启、win32 的全部形态（只剩直启）、观测窗口内仍存活 | 「已把地址交给系统，无法确认窗口」 | 「已打开」 |
| `ok:false` | 明确失败：`error` 事件、`binAvailable` 预检不过、选不出启动对象（探测清单为空，或多候选且系统说不出默认项）、**可信形态**非 0 退出或被信号终止 | 一句给用户的说法 + `reason` 码 + **地址** + 探测诊断 | 静默 `ok:true` |

**退出码何时算证据，是一条双向规则，只写在 `platform/os/browser.js#ownsItsWindow` 一处**：只有本次启动
确定拥有自己的窗口（即确定是新实例）时，它的退出码才同时具备「0 算接收、非 0 算拒绝」两种证明力。
不可信形态的退出码两个方向都不许进判决——win32 正是这条被写反过：系统 shell 的 URL 交付命令未文档化，
其返回码与地址是否打开无关（真机现场返回 1），旧实现「非 0 即失败」于是把已经打开的页面报成「窗口未出现」。
那条冒开路径已整体删除（win32 的 `openCommand` 返回 `null`，只直启探测解析出的本体），故该平台恒不可
取证。同一处还解释了为什么裸 URL 直启 chromium/firefox 派生系也不算拥有窗口：浏览器已在运行时，本次进程
只把地址转交给既有实例。`evidence.ownsWindow` 与 `evidence.diagnostics`（`pick`/`bin`/`default`/`found`/
`probed`）随结果一起交出，面板在 `handedOff`/`ok:false` 两档把启动形态与探测结论摊在地址行下面——
没有这一行，真机报错就只剩一句无法定位的文案。

`reason` 码是契约、文案是呈现：`unsafe-url` / `no-launcher` / `spawn-failed` / `exit-nonzero` /
`killed-by-signal` / `no-desktop-session` / `unsupported-platform`。

结果必须等子进程的 `error`/`exit` 才能定，而 Node 的 ENOENT **只在异步 `error` 事件里出现**——
所以 `openBrowser` 是异步的：同步返回布尔的实现形态本身就不诚实。

出口交到调用方手里的方式也只有一种：HTTP 网关 `createServer(sup, deps)` **缺省**装本出口并随请求上下文
`ctx.browser` 交出，`deps.browser` 仅供契约测试在构造期注入假件。调用方不得自己 patch 模块导出——
patch 是否生效取决于消费方是解构还是按属性取用，静默失效的那一次就会真去 spawn 浏览器。

### S-2 能力位与降级

`capabilityProfile().openBrowser` 是唯一的声明面：三平台 `true`（Linux 由 `capabilities()` 用
图形会话**实测**覆写），未知平台 `false`。名单从档位表推导，`browser.js` 内**不得**再写第二份
平台判断——档位与行为分叉就是「声明能开、实际乱试」。

档位说不开时出口**显式失败**（`unsupported-platform`），而不是尽力试一次 `xdg-open` 再冒成功。
`openCommand` 对未知平台仍退化 `xdg-open`：那是低层映射，不构成本产品对外宣称的能力。

### S-3 消费方一律回 `{ok, reason, url}`

任何调用外部打开的端点/域动作都必须把三档结果原样交出，且 **`url` 恒在场**：

| 消费方 | 交出形态 |
|---|---|
| `POST /instances/open-web` | 三档结果原样透传；`ok:false` 映射 **500**（恒 200 会让面板显示成功）；失败即作废一次性授权码 |
| `POST /env/open-url` | 面板请内核代开：三档结果原样透传；`ok:false` 映射 **500**；非回环来源 403 |
| 智能路由一键登录 `proxyLoginStart` | `{ok, opened, confirmed, handedOff, reason, url=authUrl, isolated}`；打不开时文案直接接「请手动打开下方地址完成授权」 |
| 隔离窗口调用方（`router/ops/browser.js`） | 返回 `{profile, result}`，不再只回一个 profile（丢弃 result 即丢弃失败原因） |
| `GET /env/browsers`（只读探测面） | L1 的结论原样交出：`{platform, cached, default:{id,source}, browsers[{id,name,engine,bin,sources,isDefault}], probed[]}`；跨站 403、探测异常 500，**不启动任何浏览器**（读探测面与执行动作分属两个端点，判据也不同：后者要回环身份） |

### S-4 面板：一条选路判据 + 任何一档都把地址交到眼前

`ui/src/services/supervisor/externalOpen.ts`（选路与分档判据）+ `ui/src/features/supervisor/openExternal.tsx`
（唯一呈现口 `runOpenExternal`）。三档各有一句说法，且**每一档都渲染可点击、可复制的地址行**——
假成功在结构上无法出现。判据取 `ok`/`confirmed` 字段，绝不取文案（文案可变，档位是契约）。

面板自己那条路只有**一条判据**：`servedByKernelHost()`（页面来源是否回环）。面板由内核自己托管，
所以「回环」等价于「看面板的浏览器与内核同一台机器」：

| 来源 | 由谁开浏览器 | 结果 |
|---|---|---|
| 回环（含桌面壳内） | 内核 `POST /env/open-url` | 三档证据齐全；壳的 webview 丢弃 `window.open` 与 `target=_blank`，历史上正是这条死单击 |
| 非回环（局域网/公网访问者） | 访客浏览器的新标签（`openViaWindow`，唯一实现处） | 拿到窗口句柄即 `confirmed`（新标签在访客眼前），被拦截即 `ok:false` |

两条路的结局一律归一成 `OpenExternalResult`，界面上不存在第二种说法。**曾存在过的第三条路已删**：
面板经 postMessage 桥请壳主帧代开（`dsh:open-url` / `dsh:open-url-result`）。它与内核那条是同一件事的
两套语义（回执有无、超时算不算成功各说各话），而壳与内核恒在同一台机器上，故代开方归内核。

### 反模式（本标准的五条禁止项，都有历史实例）

1. 同步 `return true` / 「spawn 没抛错就算成功」。
2. 端点恒 200，把失败折算成布尔或干脆丢掉结果。
3. 各处自己 `window.open` / `shell.openExternal` / 自己拼 `cmd /c start` / **绕过探测层自己拼一条命令
   冒开**（第二出口 = 第二套语义；历史上 Windows 那条「向系统 shell 冒开」的退路就是这一类，已整体删除，
   注释里也不留它的名字，免得下一个人以为它是可恢复的退路）。
   面板侧的例外只有一个、且有意保留：非回环来源时访客的浏览器根本不在内核那台机器上，
   此时 `openViaWindow` 是唯一正确的执行方（全仓只允许这一处，X-11 钉死）。
4. 失败时不交出地址，让用户只能重复点击。
5. 平台事实写在两处：探测之外的层再出现一次注册表键 / `LaunchServices` / `.desktop` 解析，
   或按平台宣称取证能力（`openBrowser` 的档位表与行为分叉即「声明能开、实际乱试」）。

### 验证

`platform-layer-portability-test` X-8（探测夹具：三平台来源并集、留痕、缓存与失效、选路、计划、取证档位，
含「Win7 起被忽略的那个默认值不得再当默认读」的反向样本）· X-10（三档行为 + 诊断必达 `evidence` +
`observeSpawn` 本体，全部注入假 spawn/observe，CI 不真起浏览器）· X-11（四层唯一出口的源码级不变量：
平台事实只写一次、执行层不碰探测原语、图形会话判定单点、消费面注册单点，含面板最后一环）；
`four-platform-behavior-matrix` P-5（声明 + `exitIsEvidence` + 旧冒开形态回流判据）；
`platform-capability-audit` A1·A2·A3（A2 钉探测层的分平台实现、留痕、缓存与只读消费面）；
`api-contract` OW/OU/OB 三组（HTTP 契约：三档透传、500、地址在场、失败作废一次性码、跨站与已认证 LAN 访客的
403，以及只读清单面零启动副作用）；
`token-contract-gate` TK-G6（令牌不得进 argv，动词集与真实出口对齐）；
`ui` `externalOpen.test.ts`（分档判据 + 回环选路 + `evidenceDetail` 把探测诊断摊上屏幕 + 弹窗被拦截判失败）。

