# 全仓注释与门禁审计报告

## 0 结论（先行）

- 本仓库**注释纪律整体良好**：门禁（CP 组 + CS 组）在作用域内已把「注释被断言钉死」与「注释含过程字符/叙事」两类风险压到零；CI 全绿即对应 **CS-1、CS-2 零违规**（作用域内 256 个 src 文件及 test/ui/release/bin/shared/app）。

- 本报告是**注释与门禁审计**，不是功能缺陷审计：**无 P0 功能缺陷**。风险集中在**注释时效性**与**门禁盲区**。

- 核心风险（按优先级）：
- **C-3（P1）**：无扩展名启动器 `bin/dsh-supervisor` 不在 CS 作用域，而其注释含 `⚠`（CS-1 禁字符）与日期 `2026-09-12`（CS-2 禁叙事）——**盲区正在掩蔽一个真实的规则违反**。
- **C-1（P1）**：源/测试注释里的「行号锚点引用」（如 `src/domains/router/handlers/forward.js:148` 指认 `instance-lifecycle.js:38`）不受任何门禁时效校验；目标行一旦移动，注释即过期而无告警。
- **C-2（P2）**：`src/platform/os/index.js:10` 的「历史 TODO（已撤销，勿据以派单）」属过程叙事措辞，CS-2 的叙事正则未覆盖「历史 TODO」这一措辞——措辞缺口。
- **C-4（P2）**：指向外部仓 `.shell-work main.rs:256` / `core.rs:150` 的行号锚点，在 dsh-supervisor-core 内不可核验，易过期。
- **C-6（P3→P2）**：版本引用 `0.1.5-BETA.N` 41 处，多为历史/示例；唯一可操作项为发布 runbook 的 `bump.sh --core 0.1.5-BETA.1` 占位值已过期。

- **非发现（已确认有意）**：重复的 facet 契约头部（22 组）是统一模板，非违规；「死代码」普查 46 项绝大多数是文档示例，非真正死代码。

## 1 范围与方法

- **方法**：只读静态扫描（node v24.18.0）+ 逐门读取门禁源码定义 + 逐字核对门禁内联字面量钉。未在本机执行 `npm test`（AC-1 四平台矩阵裁决）。

- **扫描面**：`src`（256 个 `.js`）、`test`、`ui`、`release`、`shared`、`app`、`bin`；另含根级 `*.md` 与 `design-notes/*`（用于 XREF/版本引用统计）。

- **数字口径（诚实声明）**：本次静态扫描累计 661 个文件、约 36,300 「注释行」，但该计数**含 `.md` 行与「行内含 `//` 的代码行」**，**不等于** CS-4 的 `_strip.js` 剥离口径。CS-4 的真实判据（≥200 文件 / ≥3000 注释行，只设下限）以门禁运行时为准；本仓库 CI 绿 → **CS-4 通过**。下文凡引 36,300 均以此口径，不作门禁值。

- **取证口径**：每条发现给出相对路径 `file:line`；所有 `src/...` 路径均真实存在（DR-1）。

## 2 基线

| 项 | 值 |
| --- | --- |
| 版本（`package.json`） | 0.1.5-BETA.10 |
| CI | 绿；127 条测试链；四平台矩阵 |
| 上一轮审计 | `AUDIT-REPORT-2026-09-19.md`（P0×4 / P1×22，已批修复，P0 清零） |
| 注释纪律规范 | `DEVELOPMENT-TRACK.md` §6.1 |
| 单字符级词法 | `test/_strip.js`（全 test/ 唯一实现） |

## 3 注释纪律现状（§6.1）
**规则正文**（复述，便于对照）：
1. 默认不写注释；只写「当前为真的约束/为何」。
2. 禁过程叙事：批号、CI run 大数字、审计报告引用、章节交叉引用、勘误、全绿/复绿/CI全红、日期戳。
3. **字符白名单**：ASCII 可见字符 + 制表/换行 + 汉字 + 假名（U+3040–U+30FF）+ 中文标点（U+3000–U+303F）+ 半/全角（U+FF00–U+FFEF）+ 排版引号/破折号/省略号。
4. 门禁：CP 组（注释被断言钉）+ CS 组（字符白名单 CS-1 / 禁叙事 CS-2 / 反向 CS-3 / 覆盖 CS-4）。

**现状判断**：作用域内注释基本符合纪律。`src/platform/os/index.js` 的门面注释（第 5–9、16、19 行）与 `bin/dsh-supervisor` 第 8–10 行等是「当前为真的约束/why」型，合规。违规集中在 §5 的 C-2、C-3 两类，且二者均属「门规未覆盖」的措辞/范围盲区，而非门禁漏检到的既有违规。

## 4 门禁一致性与盲区
### 4.1 CP 组（注释被断言钉）
| 判据 | 性质 | 说明 |
| --- | --- | --- |
| CP-1 | report-only（`CP_STRICT=1` 转硬） | 内联正则字面量 P 命中目标 src 文件 F 原文、不命中 F 剥注释文本 → 钉在注释 → 违规。全量含跨文件二义，无法纯静态排除假红，故默认报告。 |
| CP-2 / CP-3 | 永远硬失败 | 合成样本反向自检：注释命中必检、代码/字符串命中必不误报。 |
| CP-4 | 硬（含复活自检） | 5 条登记钉子显式豁免；**未登记命中即硬失败**。另设硬自检：5 条登记钉子必须仍在位，否则豁免表「静默失效」。 |
| CP-5 | 永远硬失败 | 高置信子集（单目标 + 更严阈值）未登记命中 = 0。 |
**5 条登记钉子**（均在位，CI 绿佐证）：
1. `src/platform/service/config.js` —「最小兜底」— `test/package-root-test.js`
2. `src/app/control/entry.js` —「静默丢弃」— `test/phase-vocabulary-test.js`
3. `src/platform/contract/deploy.js` —「不再是 SEA」— `test/round8-fixes-test.js`
4. `src/domains/instance/ops.js` —「探测失败不阻断创建」— `test/instance-safety-test.js`
5. `src/platform/os/autostart/win32.js` —「桌面壳」— `test/kernel-daemon-contract-test.js`（D-8 所有者=桌面壳）

**门禁自身的诚实记录（值得借鉴）**：
- 曾有一版**误报阈值 bug**：`distinctive()` 基线阈（≥4 汉字 / ≥6 ASCII）把两条登记钉子「不再是 SEA」（SEA 仅 3 字符）与「所有者…桌面壳」（壳 仅 3 字）滤掉了，导致 CP-4 的 5 条中 2 条永不生效；已用 `REGISTERED.some(...)` 特判修复，并在文件注释中记录。
- 历史事故（本门禁存在的理由）：`245585c` 741 处注释符号清理把「所有者 = 桌面壳」改写为散文 → D-8 硬正则失配 → CI 红；`f410a3a` 死代码普查按注释「仅 read() 内部使用」判定导出无消费者 → 误删 `contract/runtime.js` 的 file 导出 → `rc.file is not a function` → CI 红。
- 文档化盲区（`comment-pin-gate-test.js` 第 31–34 行）：`new RegExp(A+B)` 动态构造、字符串 `includes()/indexOf()` 断言、变量中转的正则常量、以及 P 只作用于二义多目标之一。

### 4.2 CS 组（字符/叙事/覆盖）
| 判据 | 性质 |
| --- | --- |
| CS-1 字符白名单 | 硬 |
| CS-2 禁过程叙事 | 硬 |
| CS-3 反向 | 硬 |
| CS-4 覆盖（≥200 文件 / ≥3000 注释行，只设下限） | 硬（非空转） |
**作用域**：`CS_DIRS = [src, test, release, ui, ci, bin, shared, app]`；`CS_EXT = js|cjs|mjs|ts|tsx|sh|ps1|py`；跳过 `node_modules/dist/.git/target/ui-react/coverage/build`。JS/TS 唯一依赖 `_strip.js` 的 `blankComments`（行尾注释、块注释、字符串内同形字符、正则字面量按词法区分）；SH/PS1/PY **只覆盖整行 `#`**。

### 4.3 已知盲区（门禁自声明，本报告逐项评估）
| # | 盲区 | 位置 | 本报告评估 |
| --- | --- | --- | --- |
| B1 | 无扩展名 shebang 脚本 | `bin/dsh-supervisor` | **最高优先级**：该文件实为 Node 脚本，其注释含 `⚠` 与日期，若入域即违 CS-1/CS-2。见 C-3。 |
| B2 | SH/PS1/PY 行尾 `#` 注释 | `release/scripts/*.sh` | 行尾 `#` 不受 CS-1/CS-2 管；需人工自查。 |
| B3 | PowerShell `<# #>` 块注释 | `ci` | 无词法器，硬套 JS 词法会把 URL 的 `//` 当注释；不扫。 |
| B4 | YML/JSON/Markdown | `.github`、`release/*.md` 等 | 有意不扫（注释语义口径不同）；根级 `*.md` 的 `src/...` 路径存在性另由 DR-1（report-only）兜底。 |
| B5 | 跨仓行号锚点（`main.rs:N`） | 文档引用 `.shell-work` | 见 C-4。 |

## 5 发现
### C-1（P1）源/测试注释中的「行号锚点引用」不受时效校验
**问题**：注释里写 `文件名:行号` 指认某一行，这类引用**不在 5 条登记钉子之列**，也不被任何正则断言钉；门禁既不禁止行号，也不校验行号是否仍指向所说内容。目标行一移动，注释即静默过期。
**取证（src，8 处 / 7 文件）**：
| 注释所在 | 指认 | 所指内容（现状） |
| --- | --- | --- |
| `src/domains/router/handlers/forward.js:148` | `instance-lifecycle.js:38` | `if (!inst.pid) {`（第 38 行） |
| `src/domains/router/providers/probe.js:174` | `instance-lifecycle.js:38` | 同上（同一不变量） |
| `src/app/assembly/collaborators.js:196` | `control/scheduler.js:30` | （行锚） |
| `src/app/assembly/collaborators.js:220` | `test/token-boundary-test.js:81`、`facade/lan.js:41` | （两行锚） |
| `src/api/security.js:99` | `core-test:146` | （行锚） |
| `src/api/domains/dist.js:22` | `test/round13-csp-probe-test.js:72` | （行锚） |
| `src/api/domains/relay.js:26` | `与 :21 的 settings/install/toggle 同规` | （行锚） |
**取证（test，4 处）**：
| 注释所在 | 指认 | 备注 |
| --- | --- | --- |
| `test/heartbeat-selfheal-test.js:14` | `supervisor.js:455` | — |
| `test/srcpath-gate-test.js:12` | `control-view.js:216` | — |
| `test/srcpath-gate-test.js:14` | `registry-view.js:185` | — |
| `test/round8-fixes-test.js:316` | `core.rs:150` | 跨仓（C-4） |
**性质**：多为**稳定不变量**（如 `inst.pid` 判据），当前仍指向正确行，属低爆发半径。但门禁无时效保护，且本仓自身在 `ARCHITECTURE-PLAN-session-lifecycle.md` 明确「行号会失效，看现状请读代码」——官方承认行号锚点会腐化。
**建议**：三选一——(a) 去裸行号，改「符号/行为」锚（如「以实例 pid 判据」）；(b) 把确实被测试钉的行升格为 CP 登记钉子（仅限已被断言钉者）；(c) 保留行号但统一加「行号易失效」脚注（现状做法，弱）。首选 (a)。
**对比**：文档侧（`design-notes/*`、契约、审计报告）的行号引用是**有意实践**（本审计自身即如此），不属本发现范围。
### C-2（P2）`src/platform/os/index.js` 的「历史 TODO（已撤销）」过程叙事
**取证** `src/platform/os/index.js:10`（第 10–12 行）：
> // 历史 TODO（已撤销，勿据以派单）：原记「servicehost/sandbox 的完整 Provider 化」。核验：**无 servicehost 模块**；service 早已是 `PROVIDERS[PLATFORM]` 真 Provider 分派；sandbox 属 `domains/instance`（非 os 层）。其余 os 模块按平台分支、三端接口一致，是**有意设计**而非待办。

**判断**：注释「内容」为真（无 servicehost 模块等），但**措辞**是过程叙事（「历史 TODO（已撤销，勿据以派单）」），违反 §6.1 的「禁过程叙事 / 无占位」。CS-2 叙事正则（批号/CI 大数字/审计报告/§/勘误/全绿/日期）未覆盖「历史 TODO」措辞——**措辞缺口**，故未检出。

**建议**：改写为纯「当前为真」约束（如「本门面不做 servicehost/sandbox 的 Provider 化：service 已按 `PROVIDERS[PLATFORM]` 分派；sandbox 归 `domains/instance`。」），删「历史 TODO（已撤销）」框。
### C-3（P1，最高优先级）无扩展名启动器 `bin/dsh-supervisor` 出域，且注释含禁字符
**取证**：
- 文件为 Node 脚本：`bin/dsh-supervisor` 第 1 行 `#!/usr/bin/env node`、第 2 行 `use strict` 声明，纯 JS（`fs`/`path`/`os`/`http`、`fs.writeFileSync`、`fs.symlinkSync`）。
- 其注释第 8–10 行含 `⚠`（CS-1 禁字符）与日期 `2026-09-12`（CS-2 禁叙事）及「P2 修复」叙事头。
- 第 10 行还称「而 G9 门禁只扫 `src/`，看不见 `bin/`」——对 G9 门属实，但 CS 门**经 `CS_DIRS` 含 `bin`**，只是因无扩展名而排除。

**判定**：`bin/dsh-supervisor` 在 `CS_DIRS` 内却因 `CS_EXT` 无匹配扩展名而**不在 CS-1/CS-2 作用域**（门禁第 290–291 行自声明此盲区）。这导致其「本应违规」的注释（`⚠`、日期）未被拦下——**盲区掩蔽了真实违规**。

**建议**：(a) 将「shebang 无扩展名」识别为 JS，纳入 CS 作用域；(b) 同步改写该文件注释（去 `⚠`、去日期，改「当前为真」措辞）；(c) 至少显式登记其为「已知豁免」。三选联合，优先 (a)+(b)。

**附带**：第 392–397 行含 D-6「所有者是桌面壳」注释（与 §4.1 登记钉子第 5 条同源），内容合规；问题仅在其出域。
### C-4（P2）跨仓行号锚点（`.shell-work main.rs:256` / `core.rs:150`）
**取证**：`ARCHITECTURE-CONTRACT-phase0.md`、`ARCHITECTURE-PLAN-session-lifecycle.md`、`EXECUTION-CONTRACT.md` 及 `test/round8-fixes-test.js:316` 指认 `.shell-work main.rs:256`、`core.rs:150`。
**判定**：`.shell-work`（Rust 壳仓）为**外部/兄弟仓**，本仓无 `.rs`、无 `.shell-work`；其行号锚点在 dsh-supervisor-core 内**不可核验**、且 Rust 侧独立演化 → 易过期。属设计正当（守卫与壳协同）但形式脆弱。
**建议**：保留引用但标注「跨仓，行号易失效」，优先用「符号/行为」锚替代纯行号。
### C-5（P2）真正「注释掉的代码」（个别）
**判定**：普查「死代码」46 项中，绝大多数是**文档示例**（JSDoc 内 `createProjection`、「async: 须 await」、成员方法示意等），非真死代码。**真正注释掉的代码**少见、需人工复核，候选：
| 位置 | 性质 |
| --- | --- |
| `test/arch-validation-test.js:10` | 被注释掉的架构校验逻辑（测试被注释停用？） |
| `test/test-safety-gate-test.js:72` | 注释块 |
| `test/api-gate-test.js:70` | 注释块 |
| `test/standards-uniqueness-test.js:224` | 注释块（位于门禁自身内，需确认是否应启用） |
**警示（`f410a3a` 教训）**：曾据注释「仅 read() 内部使用」误删导出致 CI 红——**注释不得作为删除决策的唯一依据**，死代码清理须与 CP 门配合。
**建议**：逐条确认这 4 处注释块是「有意停用」还是「遗漏」，改为「启用/删除」或加「停用原因」约束型注释。
### C-6（P3→P2）版本引用漂移（41 处 `0.1.5-BETA.N`）
**判定**：当前版本 `0.1.5-BETA.10`。41 处引用分类：
| 类别 | 位置 | 性质 | 处理 |
| --- | --- | --- | --- |
| 历史变更 | `CHANGELOG.md` | 变更史 | 合法，不改 |
| 设计笔记 | `design-notes/*` | 历史 | 合法，不改 |
| 历史绿跑记录 | `release/README.md:301` | 「v0.1.5-BETA.2 的 tag run 实证」 | 合法 |
| 历史记录 | `release/scripts/ci-core.sh:79-80` | 「上次 tag 构建是 09-11（v0.1.5-BETA.1）」/「v0.1.5-BETA.2 首跑即四平台红」 | 合法 |
| 实证记录 | `.github/workflows/build.yml:202` | 「该组合自 0.1.5-BETA.1 起连续多轮成功」 | 合法 |
| 测试夹具 | `test/release-channel-test.js:141` | 测试数据 | 合法 |
| **runbook 示例** | **`release/runbooks/publish-and-verify.md:35`** | `bash release/scripts/bump.sh --core 0.1.5-BETA.1`（占位值） | **过期占位**：照抄会 bump 错版本 |
**结论**：**无「当前版本为 X」硬断言过期**；唯一可操作项为该 runbook 占位值。
**建议**：将 `release/runbooks/publish-and-verify.md:35` 的 `--core 0.1.5-BETA.1` 改为占位（如 `--core 0.1.5-BETA.<next>`，或说明「取 `package.json.version`」）。
### C-7（非发现）重复的 facet 契约头部
普查「重复行 ≥3」共 22 组（`// export form { methods }…`、`// domain-internal unmatched …` 各 4–22 次；分隔线 `// -----` 等）。均为**facet 契约统一模板**，有意一致，**非违规**。注意：本次重复判定法（任意重复含 `//` 的行）会误报真实代码行（如 `.filter((l)=>…)`），真实「重复」仅上述模板。
### C-8（非发现）「死代码」普查口径膨胀
46 项中绝大多数为文档示例（§C-5）。另有「重复行」判定的误报（§C-7）。**无新增真实死代码发现**，除 C-5 列出的 4 处注释块待复核。

## 6 修复优先级汇总
| 优先级 | ID | 事项 | 类型 |
| --- | --- | --- | --- |
| P1 | C-3 | `bin/dsh-supervisor` 纳入 CS 作用域 + 清其 `⚠`/日期注释 | 门禁盲区 + 规则违反 |
| P1 | C-1 | 源/测试注释行号锚点去裸行号或升格为登记钉子 | 注释时效 |
| P2 | C-2 | 改写 `src/platform/os/index.js` 「历史 TODO」措辞 | 措辞缺口 |
| P2 | C-4 | 跨仓 `main.rs`/`core.rs` 行号加「跨仓易失效」注 | 注释时效 |
| P2 | C-5 | 复核 4 处注释块（`arch-validation-test.js:10` 等） | 死代码 |
| P2 | C-6 | 修 `publish-and-verify.md:35` bump 占位值 | 版本引用 |
| 非发现 | C-7/C-8 | 无 | — |

## 7 结论
- **注释纪律**：作用域内良好；CI 绿 → CS-1/CS-2 零违规。`src/platform/os/index.js`、`bin/dsh-supervisor` 等门面/启动器注释为合规格型「当前为真」。
- **门禁**：CP+CS 是仓库自审计的强项——CP-4 复活硬自检、CP-5 高置信子集硬执行、CS-4 只设下限防自锁；且门禁自身诚实记录过误报阈值 bug 并修复，属「诚实门禁」范式。
- **残余风险（本报告主线）**：
  1. 行号锚点**无时效校验**（C-1、C-4）；
  2. **无扩展名启动器出域且其注释本应违规**（C-3，最高优先）；
  3. 「历史 TODO」措辞**门禁未覆盖**（C-2）；
  4. runbook **版本占位值过期**（C-6）。
- **整体风险等级：中低**。无功能正确性问题。建议按 §6 优先级推进；C-3 为门禁一致性最高优先（它同时是「规则未生效」与「真实违规被掩蔽」双重问题）。
- **复核方法**：所有 `file:line` 均可直接定位；门禁定义见 `test/comment-pin-gate-test.js`（CP/CS）、`test/standards-uniqueness-test.js`（U-1..U-5）、`test/docs-reference-gate-test.js`（DR-1..DR-3）；词法见 `test/_strip.js`。

## 附录 A：登记钉子与门规映射（C-1 豁免核查）
C-1 所列 8 个 src 行号锚点**均不属于 5 条登记钉子**（登记钉子的字面量为：最小兜底 / 静默丢弃 / 不再是 SEA / 探测失败不阻断创建 / 桌面壳），故不受 CP-4 豁免，亦未被任何断言钉。这是「行号锚点无时效校验」的直接依据。
## 附录 B：CS-4 口径说明
CS-4 下限（≥200 文件 / ≥3000 注释行）由门禁运行时以 `_strip.js` 剥离口径计数，本报告静态扫描的 36,300 行含 md/内联 `//`，仅用于量级说明，不作门禁值。CI 绿即 CS-4 通过。