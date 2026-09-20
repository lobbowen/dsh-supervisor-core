# 架构归一化 · 终验收报告（Architecture Acceptance）

> 本文件是**三轮架构归一化改造的记录**。
> **⚠ 本文件不构成验收结论。** 按 `ACCEPTANCE-STANDARD.md` 的硬标准，
> 验收只能由推送后的 GitHub CI（四平台矩阵）裁决；下表数字为**本机自检**，仅用于判断改动是否自洽。
> 本文件不是规范（规范见 README 索引中的规范类文档）。
>
> **本文的「本轮 / 本次」全部指 2026-09 那三轮归一化施工本身**（§五、§六、§七 是那一轮的过程存档）。
> 与树相关的**现行数字**只在 §二、§三 两处，且各自标了复算日期；其余章节里的规模数字不要当作现状读。

---

## 一、验收状态：**通过（CI 四平台全绿）**

**CI run**：https://github.com/advgyxqamf/dsh-supervisor-core/actions/runs/35158648997 （commit `3cebaed`）

> 该 run 在**旧账号仓** `advgyxqamf` 下，链接至今可访问；迁仓不会迁移 Actions 运行记录，
> 所以在现仓 `lobbowen/dsh-supervisor-core` 里查不到这个 run —— 这是留档，不是待办线索。

| CI job | 结果 |
|---|---|
| `test`（ubuntu-latest，测试链经 Xvfb + launcher 产物；**条数不在此处维护**，见下方口径） | ✅ success |
| `build` ubuntu-22.04 / linux-x64 | ✅ success |
| `build` windows-latest / win-x64 | ✅ success |
| `build` macos-latest / darwin-arm64 | ✅ success |
| `build` macos-14 / darwin-x64 | ✅ success |
| `release` | skipped（按预期：无 tag、版本未变动） |

### 取得该结果的过程（CI 抓到的、本机不可能发现的缺陷）

| # | CI 抓到的问题 | 本机能否发现 |
|---|---|---|
| 1 | `X-2` 文档含操作者家目录绝对路径 | 能（未跑全链） |
| 2 | 我自建门禁 `A-5` 的假阳性（按「本机」字面量判） | 能（未跑全链） |
| 3 | **`windows-latest`：`The command line is too long.`**（cmd.exe 上限 8191，`scripts.test` 8593 字符）——同一提交 ubuntu/macOS **三矩阵全绿** | **不能** |
| 4 | `chainFiles` 解析式 `-{1,2}require` 匹配不到 `-r`（`node --check` 通过但语义错） | 能（未跑全链） |
| 5 | `SR-7` 断言链含 `--require` 字面形式 | 能（未跑全链） |

其中第 3 条是**平台原生**问题：只有 Windows 构建能暴露，现已固化为门禁 **N-e**
（`test-chain-completeness-test.js`），不再依赖 Windows CI 才发现。

### 历史自检存档（**不构成验收证据**；结论只由 CI 裁决）

⚠ **本表刻意不记通过条数**：条数随门禁演进每轮变化，写死必然过期 —— 本文件曾记
「`domain-structure-gate-test` 76 passed」，而该门禁随后已增到 82 条（P3-B 加 DG-11 形态
与 DG-12 合成样本自检），条目本身即假信息。**判定口径以「严格模式是否 exit 0」为准**，
条数由 CI 输出，不在此处复制。

| 门禁 | 判定口径（不写条数） |
|---|---|
| `domain-structure-gate-test`（DG-1..16） | `DG_STRICT=1` → exit 0 |
| `directory-structure-gate-test`（DS-G1..G8、DS-9） | `GATE_STRICT=1` → exit 0 |
| `layering-and-dependency-gate-test`（L-1..L-4、CROSS_LAYER） | 硬失败（无严格开关） |
| `standards-uniqueness-test`（U-1..U-5） | 硬失败 |
| `test-chain-completeness-test`（N-a..N-f） | 硬失败 |
| `comment-pin-gate-test`（CP-1 report-only / CP-4/CP-5 硬） | 自检硬失败；实盘需 `CP_STRICT=1` |
| `app-this-ratchet-gate-test`（AT-1..AT-3） | 硬失败（棘轮） |
| `docs-reference-gate-test`（DR-1/DR-2） | 硬失败 |

历史注记：早期本机回归曾被记为「126 条仅 1 项失败」，其中该 1 项为**本机环境前件不满足**
（本机 `$HOME` 有 `.npmrc`），在 CI 干净 runner 上通过。链现为 129 条；
**条数同样不在此处维护**（见上）。理由见 `ACCEPTANCE-STANDARD.md` §1 第 2 条。

---

## 二、物理结构（2026-09-20 实测；**本表非终态承诺**）

> 「终态」这个词此前被用得太早：下表原写「终态 257 文件 / 最大 300 行 / `>300` 的文件 0」，
> 与当前树**三条都不符**。架构归一化仍在推进，任何写死「终态」的结构表都会过期，
> 故本表只记录**复算日期 + 当前实测**，并且**不承载放行结论**（放行只由 CI 与规范判定）。

| 指标 | 改造前 | **2026-09-20 实测** |
|---|---|---|
| `src/` 文件数 | — | **260** |
| 最大单文件 | **1319**（`supervisor.js`） | **324**（`src/domains/router/handlers/forward.js`） |
| `>300` 行的文件 | 大量 | **3**：`router/handlers/forward.js` 324、`app/control/registry.js` 308、`app/main/process.js` 302 |
| 门面 `index.js` `>150` 行 | 大量 | **0**（最大 `router/index.js` 150，贴线） |
| `src/supervisor.js` | 1319 行 | **66 行** |
| 全域 `Object.assign(X.prototype, …)` 挂载 | 6 处 | **0**（仅存 2 处**注释**记录已删除） |
| 内核运行时依赖 | — | **`dependencies: {}`** |
| 域契约 `contract.js` | 0 | **5**（每域一份） |
| 测试链条目 | — | **129** 段（链长 7899 字符；Windows `cmd.exe` 8191 上限由门禁 N-e 守） |

> **为什么这 3 处超限没被 CI 拦下**：`domain-structure-gate-test`（含 DG-2 `≤300`）**整体 report-only**
> —— 判据全部执行并打印，但退出码恒 0，只有 `DG_STRICT=1` 才转硬失败，而 CI 从未设该变量。
> 因此「门禁存在且全绿」不等于「门禁在强制」。把 3 个文件压回 300 以下、或把 `DG_STRICT=1` 纳入 CI，
> 二者必居其一 —— 这是一项**未收口的结构债务**，登记在 `DOMAIN-STRUCTURE-DESIGN.md` §5.0。

### 五层结构（单向依赖）

```
src/shared/          L0 纯（出度 0）
src/platform/        L0 平台（零出边到上层）
src/domains/         L1 业务域（router/relay/instance/plugin/shell）
src/app/             L2 编排（切面 + 协作方）
src/api/             L3 门禁（HTTP 边界）
src/supervisor.js    L4 薄壳（66 行）
```

---

## 三、结构判据（DF-1..DF-9，**DF-2 当前不满足**）

> 下表 ✅/❌ 的口径：2026-09-20 用**只读门禁复算**得到（`node test/domain-structure-gate-test.js`
> 与 `node test/directory-structure-gate-test.js`，两者均不写盘、不 spawn 被测代码）。
> 这两处复算**不是验收**（验收只由 CI 裁决），只是「声明 = 现实」的核对。

| 编号 | 判据 | 2026-09-20 复算 |
|---|---|---|
| **DF-1** | 门面 ≤150 行 | ✅ DG-1 = 0 违规（5 门面，最大 `router/index.js` 150 贴线） |
| **DF-2** | **单文件 ≤300 行**（本轮由 400 取严） | ❌ **3 处越线**（DG-2 与 DS-9 各报同一条：`app/control/registry.js` 308、`app/main/process.js` 302、`domains/router/handlers/forward.js` 324）；两门禁均 report-only，故 CI 不红 |
| **DF-3** | 纯 / IO 分离 | ✅ DG-3（21 处 `contract.pure` 声明） |
| **DF-4** | 零跨文件 `this.X()` | ✅ DG-4 = 0（反向自检见真实调用 142 处，非空转） |
| **DF-5** | 域内 DAG，禁方法集合并 | ✅ DG-5a 无环、DG-5b 无 mixin SCC |
| **DF-6** | 非门面文件可独立 require | ✅ DG-6（89 个） |
| **DF-7** | 依赖单向、rank 不上升 | ✅ DG-7 = 0（130 边 0 向上） |
| **DF-8** | `require()` 必须在模块顶层 | ✅ DG-15（260 文件；内联 1 处，全落在唯一白名单 `src/supervisor.js`） |
| **DF-9** | 函数（回调/闭包）嵌套 ≤6 层 | ✅ DG-16（实测最大 5） |

> 判据编号与本体取自 `DOMAIN-STRUCTURE-DESIGN.md` §2（DF-1..DF-9）与 §9 的 DF↔DG 对照表，
> 本文件不重复定义，只记复算结果。
> **另有一处不属于 DF 的越权**：DG-10 报 `api/domains/instances.js` 取 `instances.dshBin`
> 不在目标域 `PUBLIC_API`（同样 report-only）。
> 本仓结构门禁当前合计 **2 条 FAIL(soft) / 0 条 hard**（`结果: 88 passed, 0 failed(hard), 2 failed(soft/report-only)`）。
> 两处 FAIL(soft) 要收口，只能二选一：**修到判据内**，或把 `DG_STRICT=1` / `GATE_STRICT=1`
> 纳入 CI（后者会让当前树立刻红，属单独定案）。

---

## 四、全量回归

**本文件不记录本机回归的条数与逐条结果**。按 `ACCEPTANCE-STANDARD.md` §0，测试一律不得在本机执行，
回归结论只由 CI 的 `test` job（`xvfb-run -a npm test`）裁决；把某一轮的本机输出抄进规范相邻文档，
只会留下一份必然过期的数字（本节此前写「125 条测试链 / 第 87 条 FAIL」，链与条序均已变动）。

保留一条仍然有效的**定性结论**（它解释了一个反复出现的现象）：
`test/release-auth-test.js` 的 R4-c 断言前件是「运行机 `$HOME` 无 `.npmrc` token」。
开发机通常**有** → 本机必失败，而 CI 干净 runner 上必通过。
**该 FAIL 属环境前件不满足，不是代码回归**（`ACCEPTANCE-STANDARD.md` §1 第 2 条即以此为例）。

---

## 五、本轮（第三/四轮「下拉到最根部」）修复的**真实缺陷**

1. **内核被误加运行时依赖 `acorn`** —— 违反「内核零运行时依赖」（T6-a）。
   已删除，DF-8/DF-9 判据改为**零依赖正则 + 括号计数**实现。
2. **门禁自锁**：`DG-2 反向：真实超限 ≥1（非空转）` 要求**真实存在违规**，
   与「架构应零违规」矛盾 —— 全域清零后该自检恒假。已改为**合成样本**判据。
3. **门禁判据与实现不符**：`DG-10` 判据名为「消费方 ⊆ PUBLIC_API」，实现却读 `c.exports`；
   而 `exports` 被 DG-9 要求逐字等于 `index.js` 导出键 —— 数学上无法同时满足。已对齐为读 `PUBLIC_API`。
4. **`relay` 域 `frp.js → frp-install.js` 判为 rank 归类问题**（两者是原 `frpmgr.js` 的二分半），
   门禁 `RANK` 表 `frp-install.js: 1 → 2`（判据本体/阈值/反向自检零改动）。
5. **测试指针静默失覆盖**：文件搬移后 30+ 处「断言钉在源码形态上」的测试改为
   读取**目录聚合**（`defects-batch-f` K7、`process-tree-kill` G-d、`cross-platform-architecture-gate`、
   `platform-layer-portability` 等），**断言语义/阈值逐字不变**。

---

## 六、最根部拆解（本轮核心）

| 原文件 | 行数 | 拆为 |
|---|---|---|
| `app/native/installer.js` | **807** | 门面 125 + `ops/upgrade/npm/manifest/probe/policies` |
| `platform/distribution/index.js` | **691** | 门面 85 + `release/policies/registry/install` |
| `platform/service/ports/index.js` | **592** | 门面 20 + `pool/alloc/core/store/probe/migrate` |
| `platform/service/log/hub.js` | **493** | 245 + `sources/core/tail/watermark` |
| `platform/os/autostart.js` | 393 | `autostart/{index,win32,darwin,linux}` |
| `platform/os/pidlookup.js` | 306 | `pidlookup/{index,probe,norm}` |
| `app/assembly/compose.js` | 376 | 门面 28 + `compose/{core,domains,observers}` |
| `app/control/registry.js` | 355 | 280 + `heartbeat` |
| `app/daemons/process.js` | 354 | 297 + `process-wait/process-marks` |

### app 级 2：真 ctor 注入

`src/app/` 的跨文件 `this.X()` 由 **235 → 0**；`state` / `session` / `control` 三切面已**工厂化**
（`createStateStore(deps)` / `createSession(deps)` / `createControlPlane(deps)`），
可**只 `require` 工厂 + 假 deps 直测**（`test/app-ctor-injection-test.js`，26/0），不构造 `Supervisor`。
`host` 保留兼容薄壳，公共面（`api` 42 成员 + 测试 ~50 成员）逐字保真。

---

## 七、本次改造未做（如实声明）

1. **`ctl` / `daemons` / `main` / `views` / `audit` / `ui` 六切面仍为薄委托** ——
   已按同一手法工厂化 `state`/`session`/`control` 三个，其余可循 `assembly/collaborators.js` 的 `THIN_SPEC` 位后续收编。
2. **`DEF7` 的两处「无前导点」`instances.instances`**（`app/control/adapters.js`、`domains/relay/managed.js`）
   未被 DG-11 正则计入，未改（避免越界）。
3. **`R4-c` 环境项未修** —— 属沙箱前件，非代码问题。
4. **无版本推送、无 commit**（按要求）。

---

## 八、相关文档

- `DOMAIN-STRUCTURE-DESIGN.md` —— 域内结构 SSOT（DF-1..9 / R1..R12）
- `DIRECTORY-STRUCTURE-DESIGN.md` —— 目录结构 SSOT
- `EXECUTION-CONTRACT.md` —— 冻结接口契约与边界授权
- `DEVELOPMENT-TRACK.md` §5.3 —— 运行时安全红线
- `design-notes/EXEC3-*.md` / `design-notes/EXEC4-*.md` —— 各子代理的逐项执行记录