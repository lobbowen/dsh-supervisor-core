# 反代账号生命周期标准（唯一事实源）

本文件是「反代账号何时拉起、何时冻结、谁进等待区、何时回池」的唯一事实源。
与 [PROXY-ISOLATION-STANDARD.md](PROXY-ISOLATION-STANDARD.md) 平级且正交：那份标准管**载体进程怎么起停**
（L0 平台事实 / L1 carrier 载体 / L2 供应商 manifest）；本标准管**生命周期决策**——该不该起、该不该停、
谁有资格下令。二者合起来构成反代域的全部进程治理纪律：载体标准收口了 kill/spawn 的**手**，
本标准收口它的**脑**。

- 机器校验：LC-1..LC-6 门禁（落点见 §7），登记于 test/standards-uniqueness-test.js（域名「反代账号生命周期」）。
- 状态：设计已经用户逐条裁决 ratified（见 §5）；代码尚未按本标准收敛，分期计划见 §9。
  收敛完成前，本文件描述目标不变量；与现实不一致处以 §6 证据表为准。

## 1. 问题陈述

反代账号生命周期从未收敛成标准工程逻辑：四代设计叠加（预热有、废、复设； survivor adopt 立、禁），
每个供应商各自在决策，三条拉起路径只有一条受资源闸，冻结不即时、恢复无回池机制。根因是目标模型的
三条不变量在今天**无任何机器牙齿**：

1. 存活进程集合恒等于 {在用} ∪ {预热}；
2. 冻结即零进程（此刻起该账号在进程层面不存在）；
3. 恢复即回可用池，由期望集统一决定是否获得槽位。

## 2. 两层架构（生命周期归引擎，状态判断归供应商配置集）

### L-A 生命周期引擎（通用，进程动作唯一发出方）

- 槽位模型：**在用 ≤ 1，预热 ≤ 1**；其余全部账号处于**等待区**。
- 等待区 = 零进程、零端口占用、纯账本（keyId/maskedKey/status/limit/quota 快照/registeredAt）。
  账号进入等待区即回收进程并释放端口，与"仅删除账号才释放 port"的旧纪律分道（见 §6-E9）。
- 引擎是 router 反代域**唯一**允许发起 spawn/kill 的决策方；所有进程动作经 carrier 载体执行
  （HOW 归 PROXY-ISOLATION-STANDARD L1，WHEN/WHO 归本标准）。
- 期望集公式：`E = {在用} ∪ {预热}`，其中预热 = 可用账号中（排除在用）**按 registeredAt 登记顺序**
  取第一个仍可用者。纯二值资格判断，**不做额度择优**。
- 预热槽 sticky：一旦占用，只有该账号自身失效（被冻结/封禁/删除）才换主；
  更早登记的账号恢复不得抢占（防抖动，裁决④）。
- 引擎对供应商零感知：不含任何 vendor 字面量、词表、URL、节奏数值。

### L-B 供应商状态配置集（纯判断，零进程权限）

每个供应商一份配置集，只回答「这个账号现在什么状态」，不回答「拿它怎么办」：

| 契约项 | 语义 | 约束 |
|---|---|---|
| usableOf(acc) | 是否可用（含剩余额度 < 最小请求单元即不可用，裁决③） | 纯判断，禁 require 任何进程/载体模块 |
| recoveryOf(acc) | 恢复观察：`{type:'at',at}` / `{type:'poll',periodMs}` / `{type:'manual'}` | 恢复时刻/重探节奏是**配置**不是引擎常量 |
| probeOf(acc) | 额度/状态探测：只用账号密钥 + 官方 API | **绝不**为探测拉起本地反代进程 |
| refreshCadence | 刷新节奏（在用/预热/等待区**全量账号**一视同仁） | 数值进 manifest 配置面 |
| 词表与兜底 | 限额文案关键词、周期兜底（5h/7d/30d 等）、风控参数 | 全部外置到配置集，引擎零词表 |

配置集输出只有两种：状态判定结果 + 事件（如「已失效」「已恢复」）。进程动作由引擎消费事件后统一发出。

## 3. 引擎不变量（机器可校验条款）

- **LC 核心-1（唯一发出方）**：router 反代域内，`startInstance`/`signalTermination`/`stopInstance`
  的调用点只存在于引擎白名单文件；请求路径、探测路径、视图层出现即红。
- **LC 核心-2（槽位预算）**：任意时刻 `存活进程集 ⊆ 期望集`，且 `|期望集| ≤ 2`（在用 1 + 预热 1）。
  瞬时越界（如请求路径按需拉起）不允许存在。
- **LC 核心-3（等待区零存在）**：账号 status 离开可用池（frozen/banned/进入等待区）落定的同一轮内，
  其实例必须 pid=null 且 port 释放；不存在"冻结但挂着进程/端口"的稳态。
- **LC 核心-4（探测零拉起）**：任何探测/刷新调用链不 spawn 本地反代进程。
- **LC 核心-5（恢复即回池）**：配置集给出正向恢复证据后，账号回到可用池并触发引擎重算期望集；
  恢复不靠周期对账的运气。
- **LC 核心-6（引擎无 vendor 感知）**：引擎文件内出现供应商名/URL/词表/节奏字面量即红。

## 4. 事件表（谁触发、引擎做什么、配置集判什么）

| 事件 | 判定来源 | 引擎动作 |
|---|---|---|
| 请求命中限额（429/402 等，发不出请求） | 配置集 usableOf | **立即**冻结入等待区：kill + 释放端口，零宽限、零 _stopPending |
| 额度快照显示剩余 < 最小请求单元 | 配置集（裁决③） | 同上（前端显示 99% 但发不出请求即冻结，不保留假可用） |
| 用户主动切换（目标必须是可用账号，此为不可剥夺的前端语义） | 引擎 | 目标→在用：未就绪则同步等待，预算 switchBudgetMs，超时**诚实报错**，绝不静默换号（裁决①）；原在用→等待区**立即回收**；预热槽不动 |
| 预热顶替在用（在用死亡/被回收） | 引擎 | 预热→在用；腾出的预热位按 registeredAt 顺序立即补选 |
| 预热账号自身失效 | 配置集 | 预热槽释放，按顺序补选（sticky 规则的唯一换主条件，裁决④） |
| 探测确认恢复（正向证据） | 配置集 recoveryOf/probeOf | 回可用池 + 重算期望集（LC 核心-5）；不抢 sticky 预热槽 |
| 新账号登记 | 引擎 | 入账本；不动现有槽位，由期望集重算自然参选 |
| 删除账号 | 引擎 | 账本删除 + 若在槽位则回收 + **剪除实例记录**（消灭 orphan 记录） |

回收永远经 carrier（PROXY-ISOLATION-STANDARD L1）；「立即」指事件驱动的同一轮，不等 5min 对账、
不给 90s/5min 宽限。

## 5. 用户裁决记录（2026-09-21，四点全案 ratified）

1. **主动切换的启动预算**：切到等待区（未运行）账号时同步等待，预算内就绪则完成，超时报错给用户，
   不做静默换号兜底。预算值沿用 switchBudgetMs 注入面（须真配置，见 §6-E8）。
2. **顺序的定义**：预热参选顺序 = 登记顺序（registeredAt），非额度余量、非恢复时刻。
3. **可用性的精度**：剩余 < 最小请求单元即不可用；「发不出请求」的账号必须即时冻结，不保留 99% 假可用。
4. **预热槽换主**：sticky——预热槽占用者只有自身失效才让位，不做早期恢复账号抢占（防抖动）。

## 6. 现状缺陷证据（收敛前的事实基线，2026-09-21 逐行核实）

| # | 缺陷 | 出处（真实行号） |
|---|---|---|
| E1 | 四态词表与谓词零生产消费：isServable/occupiesSlot 无人调用，各路径平行造判据 | model.js:17-25；pool.js:31-35；providers/switch.js 用 `!!a.instance.pid`；handlers/forward.js:99 直写 `status !== 'HOT'` 字面量 |
| E2 | 三条拉起路径仅一条有闸：prewarmAsync 受资源闸，请求路径与探测路径旁路 | providers/restart.js:56；handlers/forward.js:97-118；scheduler.js:128-133 |
| E3 | 瞬时进程上界 = min(账号数, 端口池 4000)，回收只靠 5min 对账 + 90s 宽限 | providers/restart.js:10,82-93 |
| E4 | 冻结不即时：stopInstance 非 force，在途/在用可hang 5min | providers/instance-lifecycle.js:23,27-38；providers/proxy.js:89-102 |
| E5 | 恢复无回池机制：account_recovered 事件全仓仅生产端一处、零消费端 | providers/policies/freeze.js:29 |
| E6 | 态定义自相矛盾：model.js 定义 DEAD=进程在，探测 error 分支却写 pid=null+DEAD；监控跳过无 pid 者，重启跳过有 pid 者，DEAD 无人回收 | model.js:4-5；providers/probe.js:145,177；providers/restart.js:70 |
| E7 | 预热判据是额度择优（80%、将尽 10min 且 >50%、不健康前兆），与登记顺序裁决相悖，整体废止 | providers/pool.js:59-77,86-91 |
| E8 | 池上限是假配置：proxyInstanceLimits 全仓仅此一处读取，store/ops 从不注入，实际恒 2/1/2000 | providers/pool.js:9-13,16-22；文档 PROVIDER-GATEWAY-ARCHITECTURE.md 的"可配置"宣称失实 |
| E9 | 冻结账号保留端口占用（port 与实例绑死、仅删号释放），违背等待区零存在 | model.js:6-7；providers/probe.js:140 |
| E10 | 探测靠临时拉起本地反代（scheduler 探测路径 startInstance、10min 刷新仅探运行中账号，等待区账号永不刷新） | scheduler.js:129-133,197-198 |
| E11 | 删号后实例记录不剪枝，留 orphan（对账时以 'orphan' 名义停进程）；钩子只停进程清端口 | providers/process-pool.js:33-37；providers/restart.js:91 |
| E12 | HOT+不健康可无限存活（markInstanceProblem 不降级态） | providers/process-pool.js:136-149 |
| E13 | 供应商泄漏进通用面：CC_API_KEY 兜底、官方 API 基址与路径、6h/45d 风控参数、billing kind 分支、npx 标准词表、策略状态写进实例对象 | providers/probe.js:75,225-231；quota-strategies.js:15-21,85-99；providers/direct.js:35-38；providers/command.js:20,37,42；policies/quota.js:8-9,109,150 |
| E14 | OAuth 链路以供应商名占用通用门面（/router/proxy/login/* 绑 commandcode 实现） | ops/oauth.js:18,37,84；contract.js:26,43；config.js:25；index.js:131-132；api/domains/router.js:59-68 |

## 7. 门禁设计（LC-1..LC-6，实现时随代码落地）

登记纪律：清单在 `test/manifest.js`（`scripts.test` 已收敛为一行 runner），LC 检查可作为独立文件登记，
但必须同时标 tier/os/why —— 判据 C-a/C-c/C-g/C-h 会核对登记与实跑形态一致。

| 牙齿 | 校验内容 | 落点 |
|---|---|---|
| LC-1 | 进程动作调用点白名单（源码正则）：spawn/kill/stop 系列仅引擎文件可调 | test/provider-gateway-gate-test.js（PG 族扩展） |
| LC-2 | 槽位预算不变量：存活集 ⊆ 期望集且 ≤ 2（行为断言，CI 运行） | test/reconcile-instance-test.js（R 族重写） |
| LC-3 | 等待区零存在：冻结/入区断言 pid=null 且端口已 unregister | test/reconcile-instance-test.js + providers 行为测试 |
| LC-4 | 探测零拉起：scheduler/providers 探测函数体内出现 startInstance 即红 | test/provider-gateway-gate-test.js |
| LC-5 | 引擎零 vendor 感知：引擎文件内 vendor 字面量/URL/词表黑名单 | test/provider-gateway-gate-test.js（复用 PG-11 式精确预算机制） |
| LC-6 | 标准文档读取门（与 CP-9 同形，使 reads:true 诚实）：门禁实读本文件，校验两分层、六不变量、事件表存在 | test/cross-platform-architecture-gate-test.js（CP 族扩展） |

配套登记：test/standards-uniqueness-test.js 增加「反代账号生命周期」域（本文件 + 读门 + reads:true）；
README 索引行、PLATFORM-CAPABILITY-MATRIX 生命周期行、CHANGELOG 段随代码批次同步。

## 8. 拆迁清单（现状测试锁，实现时逐项处置）

以下断言把现状形状钉死，收敛必然触碰，逐条登记防"改测试迁就实现"失控：

- test/provider-gateway-gate-test.js:78（全文件集拼接读源）、:173-195（PG-4 形状锁）、
  :298-303（PG-11 per-file kind 配额）、:304（KIND_CMP 判据漏 strategy.kind）。
- test/router-circuit-breaker-test.js:37,43（4 空格缩进形状锁）、:74,102,134-151（endInflight 计数==3 等
  调用点锁）、:198-202,214-227,283,293。
- test/probe-gate-and-ownership-test.js:40,98-104（E-d）、:200-204（E-f）。
- test/reconcile-instance-test.js R1-R14：R1/R2 编码 80% 备胎语义，整体重做为槽位/顺序语义。
- test/p2p-router-test.js:194,202、test/router-test.js:84-88 化石断言。

纪律：拆迁须与对应实现同批提交，CHANGELOG 逐项注明"锁的旧形状 -> 新不变量"，不允许先拆锁后补实现。

## 9. 分期实施（供裁决施工顺序）

- W1 引擎收口：期望集公式落地（在用 1 + 按 registeredAt 预热 1）、needSpare/额度择优废止、
  事件表落地（冻结即时回收、角色变化即时回收、恢复回池）、等待区含端口释放、
  E6 DEAD 矛盾修复、E11 实例记录剪枝、E8 假配置面处置（要么真注入要么删配置面只留引擎常量）。
- W2 探测路径改造：删 scheduler 临时拉起（LC 核心-4）、刷新覆盖全量账号（密钥 + 官方 API）、
  恢复判定接回池事件（LC 核心-5）。
- W3 供应商配置集成形：E13/E14 泄漏表条目迁入各供应商配置集/manifest；引擎文件过 LC-5 黑名单。
- W4 门禁与文档收口：LC-1..LC-6 落地、拆迁清单同批处置、标准族文档同步、CI 全链验证。

## 10. 边界与非目标

- 载体进程的起停机制不在本标准内（归 PROXY-ISOLATION-STANDARD L0/L1/L2）；本标准只裁决何时、对谁起停。
- 账号账本读写（usage-totals、PG-12 收口成果）不动；密钥纪律不动（PG-6：密钥只经 env，绝不进 cmdline）。
- 前端语义不变：完整账号列表可见；可用账号可被用户主动切换，此为不可剥夺约束。
- maxHot/maxWarm 的"2+1"历史预算被 {在用 1, 预热 1} 取代；如需扩槽位须修订本标准并重新裁决，不留暗参数。

## 11. 提交栈备注

本文件与未提交的 proxy-isolation 标准包同属待提交集；生命周期代码收敛（W1-W4）在收到开发令前不动，
施工时的暂存一律选择性进行，绝不裹入并行会话未提交改动。
