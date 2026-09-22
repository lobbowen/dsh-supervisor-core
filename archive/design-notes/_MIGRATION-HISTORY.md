
# 迁移历史总览（_MIGRATION-HISTORY.md）

> 本文件是对 archive/design-notes/_*.md（EXEC*/FIX*/WO_REG*/_p*/_audit*/_workorder* 等作业单/登记表/裁决/存疑报告）的压缩整合。
> 源文件（EXEC*/FIX*/WO_REG*/_p*/_audit*/_workorder* 等作业单/登记表/裁决/存疑报告）已在收敛后**删除**；本汇总是其**唯一存活索引**。行号可能随代码演进漂移，请以「文件 + 符号/文本」定位。

## 1. 一句话与目标
- 目标：把 6 个域（app/instance/plugin/relay/router/shell）按 5 层（app/daemons、app/facade、app/settings、api/domain、domain/*）拆出，让门禁（DF-1..7、DG-1..19、TK、G9、R3G）可自动验证。
- 产出：5 个独立域；5 层契约；7 条主门禁；主工厂 main.js 4546→147 行。

## 2. 阶段总览
| 阶段 | 主题 | 关键产出 | 状态 |
|---|---|---|---|
| P1 | 结构拆分 | 6 个域 + 5 层；DF-1/2/4 | 已完成 |
| P2 | 结构拆 + 死代码清理 | 6 个域按白名单拆；删除死代码；DG-1..11 | 已完成 |
| P3 | 缺陷 + 门禁 + 测试钉 | FIX-1..8；N1..N11；DG-12..16、TK-1、G9、R3G；测试钉 12/27 | 已完成 |
| P4 | 清空 AUDIT 积压 | 36 项全部处置（34 修 / #29、#32 部分）；DG-13..16 | 已完成 |
| P5 | 收尾 + 门禁 + 测试 + 文档 | N1/N3/N4/N5；DG-17/18/19；测试钉 27/27；27 条注释钉 | 已完成（§5 目标收敛为独立任务） |
| P6 | main.js 主工厂化 | main.js 4546→147 行；19 个工厂文件；7 条测试钉 | 已完成 |

## 3. 逐阶段摘要

### P2 — 结构拆 + 死代码清理
- 6 个域按白名单拆成扁平结构；router 子目录（model/store/policies/ops/providers）15 文件，instance 子目录 3 文件。
- 死代码清理：删除未用导出/函数；apps-registry.js 合并为单入口。
- 门禁新增：DG-1 白名单、DG-4/7 扁平文件、DG-11 命名规范；测试钉 8/12。
- 关键发现：router 域 require 图无环，真实病症是 this 调用图（3 个 SCC）；DF-5 的正确含义是「禁止把两个文件方法合并到同一 this」（Object.assign 形态）。

### P3 — 缺陷 + 门禁 + 测试钉
- FIX-1..8（8 项缺陷）；N1..N11（第三波缺陷）；P3-A/B/C/D 各域工作流。
- 门禁新增：DG-12/13/14/15/16；TK-1 测试名；G9 exec 边界；R3G registry 归属。
- 测试钉 12/27；CI 风险 3 硬项（FRP 暴露闸、N4 lifecycle stop 20s 预算、DG-4 白名单）。
- 关键裁决：R4/R6 门禁判据（Object.assign into prototype）必须剥注释且抓变量右值；R7 门面只读，写动作下沉到 app/domain-actions/。

### P4 — 清空 AUDIT 积压
- 对账 11 份 AUDIT + 3 份 _audit-r5-stale，36 项积压全部处置（34 修 / #29 部分 / #32 部分）。
- 结论：AUDIT 的高危项（数据丢失/假成功/安全闸绕过/状态恢复错配）已被 FIX-1..8 与 P2 基本清空，无 P0。
- 关键纪律 R2 强化：删除符号前必须原始 grep 核验（含 test/、bin/、根级 .md）；export-consumers.sh 有系统性假阴性；按消费者处理（向安全侧失败）；比对 EXECUTION-CONTRACT.md 必须导出表。

### P5 — 收尾 + 门禁 + 测试 + 文档
- 第三波缺陷 N1/N3/N4/N5（N4 已修，其他留独立任务）。新增门禁 DG-17/18/19（测试钉）、R3G registry 归属。
- 测试钉 27/27；CI 风险 3 项。
- 遗留：§5 域内目标 vs 现值漂移；N4 的 20s 停止预算（lifecycle stop 忽略 s）。

### P6 — main.js 主工厂化
- main.js 4546 → 147 行；19 个工厂文件（domainActions/daemons/mainSettings/native/settings）。
- 关键裁决 R8 app/domain-actions/ 建为 app 子目录；R9 各域 ops.js 不共享；R10 测试钉只钉行为；R11 注册表归属验证。

## 4. 裁决 R1–R12（canonical）
- R1 §0 更正：router 域 require 图 0 环；真实病症是 this 调用图（3 SCC）；DF-5 = 禁止把两个文件方法合并到同一 this。
- R2 目录白名单：放宽 DS-G6；新 ALLOWED = providers instances policies model store handlers core jobs。
- R3 阈值取严值：门面 index.js ≤150 行、单文件 ≤400 行。
- R4 DS-G3 补判据：禁止 Object.assign 形态（原正则）。
- R6 修正 R4：判据替换为三条组合（mixin-into-prototype + methods-fragment + 反向自检），必须先剥注释。
- R5 daemon.js basename 不得改（5 处 cmdline 匹配依赖）。
- R7 facade 只读，写动作下沉到 app/domain-actions/。
- R8 app/domain-actions/ 建为 app 子目录。
- R9 各域 ops.js 不共享（禁跨域 require 其他域 ops.js）。
- R10 测试钉只钉行为（不钉行号/正则）。
- R11 注册表归属验证（R3G）。

## 5. 门禁与测试钉
- 门禁：DF-1..7；DG-1..19；TK-1；G9；R3G。
- 测试钉：27 条注释钉 + 2 条断言钉。分布：router 4、instance 3、shell 2、app 3、platform 1、test/api-surface-test.js 8、test/domain-structure-gate-test.js 6、test/domain-contract-test.js 12、test/standards-uniqueness-test.js 4。
- 断言钉：test/api-surface-test.js:20（domain 层入口）、test/standards-uniqueness-test.js:203（R7）。

## 6. 遗留 / 不确定 / 未收敛项（高价值）

### 6.1 §5 域内目标 vs 现值漂移
- 现状：8 个文件中 2 个已收敛（instance/index.js 95、relay/daemon.js 194）、6 个仍超限（plugin 4 个、router freeze、shell core）。
- 定性：真漂移（SSOT 域内目标未随收敛同步）。6 个仍超限文件全部满足硬门禁 DF-2 ≤300（最大 234），不是 CI 红项。
- 最小修法：SSOT 目标值更新为现值并注明取数日期（低风险），收敛另立任务。敏感点：plugin/market.js 仅超 1 行；instance/index.js 已贴线（95=95）。

### 6.2 存疑 7 项（已处置）
- D9/D10/D11/D12：4 项存疑于 P4-F 确证为真缺陷并修复（N1 exec 超时别名、guard 状态码映射 400/500、stop 忽略 stopSignal、native 入口可达性）。
- N4 的 20s 停止预算：lifecycle.stop 忽略 s 已修（P5-E2，N5）。

### 6.3 当前待办（以 phase6 + HANDOFF 为准）
- N1/N3（exec 超时别名、guard 状态码）；§5 目标漂移收敛；27 条注释钉未逐字核验。

## 7. 追溯脚注
- 源：_RULING.md、_p2-r1-registry.md、_ci-risk-fix1-8.md、_workorder-phase2..6.md、_p3-e-audit-backlog.md、_next-wave-N1-N5.md、_p3-f-fix-residual.md、_p4-e*.md、_p4-f-uncertain-fixes.md、_r5-app-api-P*.md。
- 门禁：test/domain-structure-gate-test.js、test/domain-contract-test.js、test/standards-uniqueness-test.js、test/docs-reference-gate-test.js。

