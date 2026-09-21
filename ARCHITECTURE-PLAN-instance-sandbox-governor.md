# 根因级架构计划：实例沙箱跨平台化与动态资源治理（Governor）

> 性质：**计划（进行中）**。内核仓「严重问题清单」批次第 1 项。
> 进度：W1 地基纠偏已落地（2026-09-21，含 governor 初版预算/能力字段拆分/win32 布局/TMPDIR+权限收紧）；
> W2 控制面已落地（2026-09-21，decide 两级预留+突发/迟滞/违规处置 + resstats 采样 + supervise 拍 govern tick
> + 准入门 + 观测面 usage/budgetSnapshot；下发口径为「展示值 + 下次启动生效」，运行期 set-property 动态化属 W3）；
> W3 跨平台执行、W4 呈现定版待令。验收以 CI 四平台矩阵为准。
> 前置调研（2026-09-21 两轮）结论：沙箱卡点不在数据层（目录/环境/令牌/端口隔离本已跨平台），
> 而在**进程层把「限额语义」的定义权交给了 systemd 属性表**——换平台必失能，静态用户填额必退化。
> 本计划的目标：**不做补丁、不写胶水、不为 mac/win 模仿 systemd**；从架构层收权，一次立正。

---

## 一、根因与重构定调

现状链条：`model.js` 收用户 `memoryMax/cpuQuota` → `sandbox.unitProps()` 拼 systemd 属性 →
`service.js#systemd.startTransient()` 一次性下发；darwin/win32 落 `makeUnsupported()` 抛
`CapabilityError`，`multiInstance:false`。三个结构性缺陷：

1. **决策与执行纠缠**：「该给多少」是产品决策，「怎么写内核」是平台机制，同一次调用完成——
   没有反馈回路，所以限额只能静态、只能用户拍脑袋填。
2. **能力单字段混装**：`multiInstance` 同时表达「能不能跑舱」与「有没有 cgroup」，
   掩盖了「mac/win 可跑舱、仅缺内核强制」这一真实形状（违 C11–C14 拆行教训）。
3. **POSIX 假设固化**：`sandboxCommand` 硬编码 `<install>/lib/node_modules/...`（win32 的
   `npm -g --prefix` 落点无 `lib/`），即便换了启动机制，win32 安装/版本探测/入口链照坏——
   这是与平台无关的本域缺陷，随本计划一并修。

**定调**：沙箱 = **守卫主持的应用层进程舱（compartment）**；cgroup 等内核特性是执行面可选增强，
不是功能存在的前提。限额的「定义权」收归守卫控制面（Governor），三平台一份决策逻辑，
平台差异只允许出现在执行适配器里。

## 二、目标架构（零新增抽象层，全走既有缝）

```
┌ 控制面（平台无关）────────────────────────────────────────┐
│ domains/instance/governor.js  decide() 纯函数 + 常量        │
│   输入：budget（物理内存/核数推导）+ topology（存活集与占用）│
│   输出：每实例 allocation{memHigh,memMax,cpuShare} + 违规表  │
└───────────────┬────────────────────────────────────────────┘
                │ 每拍（复用 probeIntervalMs=5000 的 supervise 拍，不新增计时器）
┌ 执行/观测面（平台差异唯一落点）────────────────────────────┐
│ platform/os/resstats.js      进程树 rss / cpu-time delta    │
│ platform/os/service.js（既有 Provider 分派）                │
│   + portable provider（新实现，三平台可用）                  │
│   + systemd provider 增 setLimits()（= systemctl --user     │
│     set-property 运行时改 MemoryHigh/MemoryMax/cpu.weight）  │
└──────────────────────────────────────────────────────────────┘
```

分工铁律：**「拉起 / 停止 / 活跃判定」归 LaunchProvider；「下发限额」归 provider.setLimits；
「该发多少」永远归 governor.decide。** 域层零 `process.platform` 分支。

### 2.1 Governor（纯函数，可穷举单测）

- **预算**（推导，用户不填）：`memBudget = os.totalmem() × 0.7`；`cpuBudget = cpus().length × 100% × 0.7`。
  常量 `HEADROOM = 0.7` 进 governor.js 并注明推导依据。**不设用户配置、不设优先级档**（裁决记录见 §五）。
- **分配**：等权两段制——`reservation_i = budget / N`（准入与保底），空闲量先到先得做突发加给
  有真实需求的实例；`memMax_i = reservation + burstShare`，`memHigh_i = 0.9 × memMax`（回收侧节流先于 OOM）。
- **迟滞**：单拍调整幅度 ≤ ±25%、偏离目标 >10% 才下发——防振荡、防对 systemd 的写放大。
- **违规处置**（反馈给既有状态机，不新建策略面）：
  - 内存：连续 **3 拍** > memMax → `killTree`（portable 档）；cgroup 档内核已压制，此路径几乎不触发。
  - CPU：连续 **5 拍** > 目标份额 → 同上。
  - 杀后走既有 `restart()` → **BACKOFF**（零新状态）；因违规入 BACKOFF 者重试超限 → FAILED，
    且 FAILED 不因「资源变宽松」自动清除（用户可见、可手动重试）；限额每拍按存活拓扑重新推导。
  - 事件：`inst_resource_violation {id, kind, actual, target}`（先 `events.append`，再动作）。
- **准入控制**：`start()` 沙箱实例时，`(已运行数+1) × 新 reservation > memBudget` → 返回显式错误
  「预算已满：N 实例已预留 X/Y，停一个或等待释放」。**绝不静默放行超卖。**

### 2.2 portable LaunchProvider（三平台共用的下限实现）

无状态设计：实例身份 = **端口反查 + cmdline 校验**（`monitor.probeInstance`/`pidlookup` 既有链），
不以 pidfile 认进程（PID 复用、守卫重启后的状态恢复问题直接消失）。

- `startTransient()`：`spawn(detached)`——POSIX `setsid` 独立进程组；win32 `windowsHide:true`
  + `CREATE_NEW_PROCESS_GROUP`（遵守 NO-CONSOLE-WINDOW-STANDARD，经统一 exec/spawn 封装）。
  同时写 `<沙箱根>/run.pid` **仅用于「STARTING 未监听窗口」的停止兜底**。
- `stopUnit()`：端口反查有 pid → `killTree`（POSIX 组信号 ownGroup / win `taskkill /T /F`，均既有）；
  无监听 → 验 run.pid 的 cmdline 归属后补杀 → 清 run.pid。三态契约与 `isUnitActive` 对齐
  （查询失败=未知 null ≠ 不活跃——FIX-5 不变量原样携带）。
- `isUnitActive()`：端口 + cmdline 双锚；两问皆「未能执行」→ null。
- `cleanTransient()`：删 run.pid；`daemonReload()`：恒 true（无操作=成功，与现 unsupported 一致）。
- `setLimits()`：返回 false（= 本 provider 无内核强制，处置归 §2.1 违规路径）。

### 2.3 平台分派（capabilities 实测，不写死平台名）

- `linux + hasTool('systemd-run')` → systemd provider（硬 cgroup，`set-property` 动态下发）；
  **无 user-systemd 的 Linux（容器/WSL1）自动落 portable** —— 今天这类环境整个功能判死，一并解锁。
- `darwin` / `win32` → portable。Job Object / launchd plist 一期不做（§五）。
- 能力矩阵 **C10 拆两字段**（A2/A3 审计测试逐格绑定）：
  - `sandboxLaunch: boolean` —— 能否运行实例舱；
  - `sandboxEnforcement: 'cgroup' | 'supervise' | 'none'` —— 限额由谁执行。
  原 `multiInstance` 废止；`/env/status`、壳/面板按新字段呈现。

### 2.4 隔离维度补齐（功能完整性的验收清单）

| 维度 | 机制 | 动作 |
|---|---|---|
| 依赖 | 每实例 install/ 独立 DSH | **修 win32 布局**：`sandboxCommand`/版本探测按平台分派（win32 无 `lib/`，入口仍是 `<install>/node_modules/@deepseek-ai/dsh/lib/bin.js`，用 node 直启，不碰 `.cmd` 垫片）；`exec-path.knownDshEntries`/api 形态闸同步 |
| 数据 | HOME/XDG → data/ | 既有 ✅ |
| 临时 | per-instance `TMPDIR=<根>/tmp`（三平台一致；Linux 另保留 PrivateTmp=yes，默认已开，双保险不冲突） | **新增** |
| 互访 | 实例根 `chmod 700` / `icacls` 收紧（file-protect 既有） | **新增**，ensureDirs 时一次性 |
| 进程树 | 独立进程组/Job 语义下整树终止 | portable 补齐 |
| 凭证/端口/探测/自愈/退避 | token、端口、pidlookup、supervise 状态机 | 既有，本就平台无关 ✅ |

安全定位沿用既有事实：**工程隔离舱，非安全边界**（ProtectHome 默认即关）。此定性写进
PLATFORM-CAPABILITY-MATRIX 配套小节，三平台一致，不新造说法。

## 三、执行分期（每段独立可验证；测试一律 CI 四平台矩阵裁决）

### W1 地基纠偏（纯 Linux 行为不变 + 存量缺陷）
1. 能力字段拆分：`capability-profile.js` 四档 + `capabilities()` 实测 + 审计测试 A2/A3 同步；
   `sandbox.supported()` 改问 `sandboxLaunch`；生命周期/面板/`/env/status` 文案改新字段。
2. win32 npm 布局修正（§2.4 第一行）。
3. 用户填额链删除：`model.js` 不再读 `payload.memoryMax/cpuQuota`、`ops.patch` 停改、
   `unitProps` 的静态值改由 governor 分配供值（W1 期间 governor 未上线，Linux 暂以
   「等权 reservation × HEADROOM 推导」的初版 budget 顶替，即限额从此不再来自用户）。
4. `sandboxEnv` 加 TMPDIR；`ensureDirs` 加目录权限收紧。
- 门禁：`platform-capability-audit`、`cross-platform-architecture-gate`（CP-3 门面显式分支）、
  governor 纯函数穷举、api-surface/契约同步、comment-pin。

### W2 控制面
1. `governor.js#decide()` 完整策略（两段制 + 迟滞 + 违规表 + 准入查询）；`resstats.js` 采样。
2. supervise 拍接线：探测同拍完成「观测→决策→下发/处置→状态行展示值更新」。
3. 准入挂 `lifecycle.start()`；`viewRow` 暴露 `{allocation, usage}` 观测行；`/env/status` 加预算总览。
- 测试：decide 矩阵（预算/权重退化、迟滞边界、连续违规计数）、准入行为测试。

### W3 跨平台执行
1. portable provider（§2.2）+ 分派逻辑（§2.3）；`lifecycle/shutdown/ops` 对 unit 语义的调用点
   逐一过三态表（含 `distribution/install.js:258` 的 unitActive 用途复核）。
2. systemd 档 `setLimits()` 动态化（`set-property`，带 `--runtime` 语义确认）。
- 测试：三端 CI 真实 spawn/kill/收养/删除保护行为测试（本机不跑）。

### W4 呈现与文档定版
1. UI：添加实例表单删内存/CPU 两输入框；列表行展示「配额(动态) + 当前占用」；能力门改读新字段
   （`InstancesPage.tsx:59/64/95/198` 链）。
2. `PLATFORM-CAPABILITY-MATRIX.md` 增补「实例舱」小节（launch/enforcement 两列 × 三平台 + 工程隔离定性）；
   README 文档索引同步。

## 四、影响面（文件清单）

`src/platform/os/{service,capability-profile,index}.js`、`platform/os` 下新增 `resstats.js`（W2 建，采样进程树 rss / cpu-time delta）、
`src/domains/instance/{sandbox,model,ops,lifecycle,upgrade,governor(新)}.js`、
`src/domains/instance/ops/dsh-install.js`、`src/platform/distribution/install.js`（复核）、
`src/app/session/shutdown.js`、`src/api/domains/instances.js`、`src/app/control/*`（adapter 观测行，如涉及）、
`ui/src/features/supervisor/InstancesPage.tsx` + `ui/src/services/supervisor/{client,types}.ts`、
`test/{platform-capability-audit,capability-profile,cross-platform,cross-platform-architecture-gate,
api-surface,instance 生命周期相关}`、`PLATFORM-CAPABILITY-MATRIX.md`、`README.md`、`CHANGELOG.md`。

约束：域内 DF 判据（门面 ≤150 / 单文件 ≤300 行）；`governor.js` 纯函数无 IO；
平台差异不出 `platform/`。

## 五、裁决与不做什么（过度设计审计记录）

| 项 | 裁决 | 理由 |
|---|---|---|
| 优先级三档 / headroom 用户配置 | **裁掉** | 无任何差异化意图面在先；引档位动 4 条链（model/API/UI/契约），收益≈0。等权 + 突发覆盖真实场景；常量可代码内演进 |
| 第三能力字段 `sandboxDynamicLimits` | **裁掉** | 与 `sandboxEnforcement` 不可区分（两档执行面决策都动态）；拆字段的意义是让不同降级形状可见，造区分不了的字段的即胶水 |
| pidfile 作身份 | **裁掉** | 端口+cmdline 双锚已是本项目既定身份链且更严格（防 PID 复用），pidfile 仅留「未监听窗口」停止兜底 |
| macOS launchd plist provider | **不做** | rlimit 启动定死、无法运行时改；每实例 plist 重演双写/篡改事故史；supervise 档给足功能完整性，缺的只有内核强制——如实声明 |
| Windows Job Object helper | **一期不做，不预留分支** | 无软档不足证据前不背 native 供应链（签名/杀软/发布耦合）；届时以 W2 真机数据立项 |
| docker/podman/NSSM/安全沙箱（AppContainer/Seatbelt/nsenter） | **不做** | DSH 是 localhost 长驻服务，容器栈收益已被 §2.4 维度清单覆盖且成本不可比；安全边界从来不是本域承诺（ProtectHome 默认关即证） |
| 单实例配额用户覆写 | **一期不留** | 入口一旦开就是契约负担；预留一个「setLimits 接受外部覆写」的内部参数即可，不暴露 API |

## 六、验收标准（合入前全部满足）

1. 三平台 CI 绿：portable 档真实 spawn→端口在线→STOPPING→killTree→删除三态保护全链行为测试；
2. Linux 行为不回退：cgroup 限额可由 governor 运行时改动（`systemctl show` 断言）；
3. 能力呈现零谎报：`sandboxLaunch/sandboxEnforcement` 对三平台 + 未知平台均有 A2/A3 绑定；
   任何「不支持」路径给出可诊断文案（含新字段指引），绝无静默 ok；
4. 用户配置面：新实例无需填任何资源数字；旧 payload 字段传入被无副作用忽略；
5. win32：`npm -g --prefix` 布局下安装→探测→启动→升级链在 CI windows runner 实测通过；
6. 文档：矩阵 C10 行更新 + 本计划状态改「已完成」，README 索引同步。
