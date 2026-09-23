# 守护域模型（GUARD-DOMAIN-MODEL）

> **本文件是「守护业务如何分域」的唯一事实源（SSOT）**，2026-09-16 立。
> 解决的问题：此前把**两类本质不同**的东西塞进同一个"用户意图"抽象，
> 导致模型错位、语义矛盾与一连串衍生缺陷（详见 §1）。

---

## §1 问题（为什么必须分域）

### 事实取证（均代码级验证）

| 维度 | DSH（原生 + 沙箱实例） | 智能路由 router | 远程控制 lan |
|---|---|---|---|
| `desired` 来源 | **用户开关**（dsh-main.json / instances.json 的 guardian） | `config.routerAutostart`（配置项）+ API 可改 | `config.lanDaemon`（**仅部署配置**） |
| 面板开关 | ✅ 有（启动区块 / 实例页） | ⚠️ 仅 API（无 UI 入口） | ❌ **无任何入口** |
| `entry.guardian` | 用户可 patch（`dsh_guardian_changed` 事件） | **硬编码 true** | **硬编码 true** |
| 崩溃语义 | 守护关 → **停就停**（`_crashHalted`） | 恒自愈 | 恒自愈 |
| 用户是否知情 | 显式呈现 | 部分 | **完全静默** |

### 错位造成的真实后果

1. **`lan` 守护计数恒为 0**（可观测性断裂）：
   为基础设施硬套"守护开关"语义 → 代码出现 `entry.guardian !== true` 判断（对恒 true 者无意义）
   → 引入 A/B 平面 id 混乱（`lan` vs `lan-daemon`）→ 计数写入 `get('lan-daemon')`（恒 null）
   而读取用 `get('lan')` → **`guardian_action` 里 lan 的 restartCount 恒 0**。
2. **语义自相矛盾**：`routerAutostart` 名为"启动开关"（用户意图），却配 `guardian: true` 硬编码（剥夺停的能力）。
3. **`lan` 无用户意图却配全套意图机制**（`desired`/`guardian`/`restartCount`/`skip-guardian-off`）。

**根因**：用"用户意图模型"描述"基础设施自愈"——**模型与业务不匹配**。

---

## §2 两个域（正确模型）

### 域 A：**被管对象**（用户意图域）

| 项 | 规定 |
|---|---|
| 成员 | `main`（原生 DSH）、沙箱实例 `<id>` |
| 本质 | **用户意图的投射** —— "我要它运行 / 停止" |
| 模型 | `desired`（持久意图）× `guardian`（崩溃是否自愈）**两个正交轴** |
| 开关 | **必须有用户可见入口**（面板） |
| 崩溃 | `guardian=false` → 停就停（`crashHalted`，等显式启动） |
| 计数 | **有意义**（回答"用户开的守护触发了几次"），但**不经** `guardian_action`——该事件已删除（见下）。真实实现各走独立链路：**dsh** → `src/app/main/process.js` 崩塌收敛发 `restart_triggered` 事件 + `_mSetRestartCount` 写 `restartCount`（`_beginRestart` 内，仅 `countCrash:true` 计数）；**沙箱实例** → `domains/instance/index.js` 自身 `state.restartCount`（`_restartInstance` 递增 + 稳定窗归零）。 |
| 停止条件 | 用户关开关 / 退出管家 |

### 域 B：**基础设施**（能力自愈域）

| 项 | 规定 |
|---|---|
| 成员 | **`router-daemon`**、**`lan-daemon`**（及未来同类基础服务）|
| 本质 | **维持业务底线** —— "只要业务需要，它就必须活着" |
| 模型 | **保活**（keepAlive），**不存在** `desired`/`guardian` 用户意图轴 |
| 开关 | **不对用户暴露**（用户无需知情，也无需干预） |
| "是否需要它" | 由**业务条件**判定（如 router 有启用意图 / lan 有远程实例），**不是**用户开关 |
| 崩溃 | **无条件拉起**（这是它的职责，不是"守护功能"） |
| 计数 | **不适用**（"用户意图被触发"的语义）；且 `guardian_action` 事件已随死代码删除，全域不再有任何生产者 |
| 停止条件 | 业务不再需要它 / 退出管家 |

---

## §3 铁律

| # | 铁律 |
|---|---|
| **G-1** | 基础设施**不得**有 `desired`/`guardian` 用户意图字段；只有"当前是否应运行"的**业务条件**。**2026-09-23 B2-2 扩展收口**：`guardian` 已**整体退出目录面**——域 A entry 也曾带该键（设置面写入、全仓 src 零读者；守护开关权威一直在 `dsh-main.json` / `inst.guardian`，消费者直读源），目录留副本只会制造分歧面。现 `createEntry` 对任何 kind 都不物化该键，老目录残留经 load 重建自然丢弃，无需迁移脚本。 |
| **G-2** | 基础设施的保活**不得**写 `guardian_action`（该事件专表"用户意图被触发"）。**2026-09-16 收口**：该事件唯一生产者 `_guardianEvent()` 已删除（域 B 两分支删除调用后成为死代码，从未服务域 A），登记（`platform/service/log/hub.js` 内部簿记名单）与 UI 标签（`ui/.../nav.ts` EVENT_LABELS）同步移除。 |
| **G-3** | 域 A 对象**必须**有用户可见开关；无 UI 入口的"用户意图"是伪意图。 |
| **G-4** | 两域**共用**心跳驱动（这是对的：都是周期收敛），但**不得共用**同一个状态模型。 |
| **G-5** | 同一对象在两个域中**不得有两个 id**（A/B 平面命名必须一致或显式映射）。 |
| **G-6** | 删除"为兼容错位模型而存在"的补丁性代码（如对恒 true 值的 `!== true` 判断）。 |

---

## §4 目标形态

```
ManagedRegistry（心跳驱动 —— 共用）
   │
   ├─ 域 A 受管对象（desired 在册；guardian 权威在域记录，不入目录 B2-2）
   │    main / sandbox-instance
   │    · 守护计数（restart_triggered/restartCount）、用户开关、crashHalted 语义
   │
   └─ 域 B 基础设施（keepAlive + 业务条件）
        router-daemon / lan-daemon
        · 保活（失联即拉起），无守护计数、无 guardian_action（事件已删），无用户意图字段
        · 应由 needsRouter() / needsLan() 业务条件决定"是否该活着"
```

**注意**：两域仍共用 `ManagedRegistry.heartbeat` 与 adapter 机制 —— 这是**正确的复用**
（周期收敛是同一件事）；分域针对的是**状态模型与语义**，不是驱动机制。

---

## §5 门禁

| 门禁 | 断言 |
|---|---|
| GD-1 | guardian 不入目录面（G-1 / B2-2 收口形态）：① 四类申报块均不含 `guardian` 字段；② `createEntry` 对**任何 kind** 都不物化该键（"不存在"而非"置 false"）；③ 目录面三文件（`control/managed-object.js`/`registry.js`/`specs.js`）去注释代码上 guardian token 清零（注释不计）|
| GD-2 | 基础设施保活路径**不调用** `_guardianEvent`；且该函数已从 `src/app/daemons/runtime.js` **删除**（GD-2b：代码全域无定义/调用，注释不计），`guardian_action` 全域无生产者（GD-2c） |
| GD-3 | 两平面 id **显式映射**，保活路径不跨平面混用 id（G-5）；域 A 计数不经 `guardian_action` |
| GD-4 | 反向：判据能识别"申报带 guardian 字段""目录面物化/修正 guardian（`e.guardian = …` / `DOMAIN_A_KINDS` spread）"两代旧形态，且不误报现行形态（门禁非空转） |
| GD-5 | 不再存在对恒 true 值的 `guardian !== true` 补丁判断（基础设施无此概念）|
| GD-6 | 保活/游离判据**只读持久化意图**，不读生命周期视图或目录 entry 的 `desired` 镜像（见 §6.2 读侧同规则）|
| ML-1..ML-3 | **目录写入 / 生命周期视图写权**门禁，见 §6.4（同一 `test/guard-domain-model-gate-test.js`）|

---

## §6 应然（desired/phase）的写权归属（2026-09-20 第 4 批 D-7/D-8 立）

> **本小节是「谁能写应然」的 SSOT。** 此前这四条铁律只存在于 `src/app/control/registry.js` 的
> 文件头注释里（无 .md 定本 → 无法被契约索引、无法挂门禁、评审时无人引用），本节把它提升为正文；
> 代码内保留摘要并指向本节，**两份冲突时以本文件为准**。

### §6.1 目录（ManagedRegistry）四条铁律

| # | 铁律 | 唯一合法出口 |
|---|---|---|
| **M-1** | **实然绝不写回目录**：pid / 端口占用 / 健康 / 观测结果只进 `lastObserved`，不得推导成 `desired` | `applyObservation(id, obs)` |
| **M-2** | 注册即存在、注销即不存在（限管家直接负责的对象）；域自治对象**不入簿**（经 ctl 摘要） | `register(spec)` / `unregister(id)` |
| **M-3** | 目录不是第二状态源：`phase` 由调谐循环驱动，**业务不得直改目录 phase** | `setPhase(id, p)`（只由 heartbeat 调） |
| **M-4** | 路径由 `root` 派生，不登记路径清单；端口只登记**所有权引用**（联动统一端口注册表） | `ownership` 字段 |

### §6.2 `desired` 的唯一写口（M-1 的落地，D-8 收口）

`desired` 是**用户意图**，只有两类路径有权改：

| 路径 | 能否写 `desired` | 依据 |
|---|---|---|
| 用户动作（面板/API 启停、守护开关） | ✅ 必须写 | 意图的唯一来源 |
| 首次登记（`register` 分支，main/域 B） | ✅ 必须带 | `createEntry` 对缺省值是 `(desired==='stopped')?'stopped':'running'` —— **不显式带就会把一个停着的主实例登记成「用户想它跑」** |
| 沙箱申报（`sandboxSpec`，含心跳观测与启动对齐） | ❌ 不申报（B2-1） | 沙箱运行意图**没有第二落点**：spec 不含 desired 键，`registry.update` 见 undefined 即跳过——观测/对齐路径对沙箱目录 desired 零写权（目录该字段恒为 createEntry 缺省，无消费者） |
| 域 B daemon 申报（router/lan） | ✅ 必须写 | 域 B 的"是否该活着"由**业务条件**（`config.routerAutostart` / `lan.enabled()`）决定，config 就是它的应然源（§2 域 B），不属于 M-1 的"实然" |

**缺陷形态与后果**（两处观测推导路径同形）：实例崩溃进 `BACKOFF` → 每拍/每次守卫重启把目录
`desired` 静默改成 `stopped` → 用户重启守卫后，调谐循环按 `desired=stopped` **不再拉起**，
表现为"我明明开着它，重启守卫就再也不起来了"。这与 **2026-09-18 事故同形**（应然被实然覆盖）。

**收口形态（2026-09-23 B2-1，取代 ST-2c 的 `inst.state.desired` 落点）**：ST-2c 曾给沙箱意图
设过落点（lifecycle 按来源分档写、specs 投影），但 GD-8 取证确认该字段**没有任何决策消费者**
（自动拉起只认 `guardian`，心跳 derivePhase 只作用于 daemon 类），按 ST-2 判据「不得为消费者
而保留死字段」整体废止：`lifecycle.start()/stop()` 不再写意图（被拒的 start 本就无痕，升级
收尾/插件生效的恢复由调用方后续 start 表达）；`model.normalizeInstance()` 对老库残留的
`state.desired` 一次性剔除（与 legacy 布尔对同惯例）；`createRecord` 不再种该字段；
`sandboxSpec` 不再申报。`keepDesired` 与 `{intent:'transient'}` 分档随之退场，src 内再出现
`.state.desired` 赋值即由 GD-7 判红。落点：`src/domains/instance/lifecycle.js`、`model.js`、
`src/app/control/specs.js`。

**已闭合缺口（原 GD-8 的 `GAP_BASELINE`）**：「有落点、无决策消费者」面随申报删除而清零——
守卫重启后 STOPPED 沙箱是否自动拉起的产品语义仍未定案，但定案时要补的是 guardian 侧的判据，
不是第二个 desired 落点。

**读侧同规则（2026-09-22 ST-1）**：唯一写口成立后，镜像仍只是**派生态**，因此
"该不该活着"的判据**只准读持久化意图本身**（`config.routerAutostart` / `daemons.enabled()`），
不得再 `|| 视图或目录的 desired`。读镜像等于承认"镜像与库里不一致时以镜像为准"，
后果是写库半途失败的 daemon 被无限重拉、面板关掉后仍在跑。落点：
`src/app/daemons/supervise.js`（保活判据）、`src/app/audit/orphan-scan.js`（游离判据）；
执法：GD-6（读侧）+ `test/session-lifecycle-test.js` 的 ST-1 段（写侧：缺 `setRouterRunning` 写口即显式拒绝，
且 `ManagedLifecycle.start()` 异常分支与 `ok:false` 分支同语义复位 `desired`）。

### §6.3 生命周期视图（ManagedLifecycle）的写权分工（D-7）

`ManagedLifecycle`（`src/app/control/entry.js`）是**管理视图**，不是第二状态源。写权按"**驱动** vs **观测合成**"分：

| 角色 | 落点 | 可写字段 |
|---|---|---|
| 驱动（启停动作） | `control/manager.js` 经 `start()/stop()/restart()` | `phase`/`desired`/`_monitoring`/`healthy`/`error`（对象自身迁移）|
| 观测合成 | `control/projection.js`（`syncDshView` / `syncRouterView` / `syncInstancesView`）| 同上——但**只镜像观测**，不发起启停 |
| 注册期能力 | `control/adapters.js`、`control/manager.js` | `_monitoring`（纳入/移出监督）|
| main 域兜底出口 | `state/fields.js` 的 `setPhase`/`setDesired` | 目录不可用/条目非在册时才直写 entry（2 处，**合法**：这是守卫内 phase/desired 的唯一写口本体）|

**规则**：`domain-actions/*`、`assembly/*`、`session/*`、`daemons/*` 等业务/装配层**不得**直写
生命周期对象的 `phase`/`desired`/`_monitoring`/`healthy`——要改就经 `lifecycleManager` 发指令，
或由 projection 在下拍到视图同步里落。

**已知违例基线（显式登记，只减不增；ML-2 机器 ratchet）**：

| 文件 | 处数 | 症状 | 收敛方向 |
|---|---|---|---|
| `src/app/domain-actions/router.js` | 10（:32/:38/:46/:52）| router 的启停由独立 daemon 进程持有、不走 `manager.start/stop`，故动作层手工把视图对齐（ST-3 起 `desired` 已改走 `wantRunning()/wantStopped()` 出口，余下是 `_monitoring`/`_setPhase`/`healthy`）| 给 lifecycle 对象一个显式 `mirrorFromAction()` 出口，或让 router 动作经 `lifecycleManager.stop('router')` |
| `src/app/assembly/bootstrap.js` | 9（:92/:106/:109/:114/:119）| boot 期 daemon 拉起结果直接落视图 | 同上：boot 只做"申报"，视图由 projection 统一合成 |
| `src/app/session/shutdown.js` | 2（:68 `_monitoring`、:160 `inst.state.phase='STOPPED'`）| :68 是"守卫退出不再监督 daemon"；**:160 是跨域直写 instance 域内状态机**（instance 有自己的 phase 词表与迁移，见 `src/domains/instance/state-machine.js`）| :68 挪进 manager 的"停止监督"出口；:160 改经 instance 域动作 |
| `src/app/daemons/supervise.js` | 1（:87）| 保活路径置 `starting` | 属观测合成的错位落点，宜并入 projection |
| （非违例）`src/app/state/fields.js` | 2（:37/:65）| **§6.3 承认的合法出口**：`setPhase`/`setDesired` 在"目录不可用/条目非在册"时的兜底直写 | 登记进基线只为锁死处数（新增第三处直写即判红），不排期收敛 |

**注意**：`src/domains/**` 里另有大量 `state.phase =` / `state.desired =` 写入（instance、router、
shell 各自域内），那是
**域自治对象改自己的状态机**，正是 §2 要求的形态，**不计入本基线**（ratchet 只扫 `src/app/**`，
且排除 `src/app/control/**`）——把广域扫描当门禁会把合法点基线化，反而给"随便写 phase"背书。
沙箱域内的 `desired` 写入处数不在这里钉，由 GD-7 全域清零钉死（`.state.desired` 赋值出现即红，
model 的一次性残留剔除口是唯一合法触碰，另有独立断言钉其恰 1 处）。

### §6.4 门禁（ML-*）

| 门禁 | 断言 | 落点 |
|---|---|---|
| ML-1 | 沙箱 `desired` **不申报**（B2-1）：`sandboxSpec` 体不含 desired 键（两代旧形态——意图投影与 phase 三元推导——由反向样本证明判据可识别）；`keepDesired` 旗标在 src 内出现即判红；心跳/启动对齐/动作路径的申报点保持**裸 upsert**，且不顺手改写目录 desired | `test/app-ctor-injection-test.js` D-8 块（spec 形状 + 行为 + 源码形态 + 反向）+ `test/guard-domain-model-gate-test.js` GD-7（写口全域清零）/ GD-8（申报源与消费者自洽，GAP 清零）|
| ML-2 | `src/app/**`（排除 `src/app/control/**`）内对生命周期对象的 `phase/desired/_monitoring/healthy` 直写与 `_setPhase(` 调用：违规**文件集合 ⊆ 登记集合**（含 §6.3 承认为合法出口的 `state/fields.js`），且**每文件处数 ≤ 基线**（新增文件或同文件加写 → 判红；收敛后基线随之调小）| `test/guard-domain-model-gate-test.js` ML-2 块 |
| ML-3 | 反向：判据对合成的旧违例源码确实计数 > 0（门禁非空转）| 同上 |

