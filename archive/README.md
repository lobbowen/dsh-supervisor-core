# archive — 历史与过程文档归档

本目录存放**已归档**文档，**不再作为当前事实源**。当前事实源见根级 `README.md` 的文档索引（规范 / 契约 / 记录）。

## 归档原则
- 根级只保留"当前仍需作为事实源"的规范、契约、记录；
- 历史、过程、已收敛的设计与论证移至本目录，只保留路径、不删内容；
- 归档文件在引用方（根级文档）的路径引用已同步改写为 `archive/...`。

## 目录
- `design-notes/`（138 份）：逐域设计、迁移作业单与登记表、审计报告、FIX 工作笔记。
- `history/`（7 份）：审计报告、事故复盘、结构复算报告（非放行依据）、执行契约、发布/更新机制论证。

## history/
- `ARCHITECTURE-ACCEPTANCE.md` — 结构复算报告（三轮架构归一化的只读复算记录，非放行依据）
- `EXECUTION-CONTRACT.md` — 域结构改造执行契约（接口冻结书）
- `AUDIT-REPORT-2026-09-19.md` — 全仓静态代码审计
- `AUDIT-REPORT-2026-09-20.md` — 注释与门禁专项审计
- `INCIDENT-2026-09-13-credential-overwrite.md` — 凭据覆盖事故复盘
- `INCIDENT-2026-09-18-exit-manager-relaunch.md` — 退出管家后桌面壳自拉起事故复盘
- `RELEASE-AND-UPDATE-MECHANISM.md` — 发布/更新机制设计论证（流程见根级 `RELEASE-STANDARD.md`）

## design-notes/（138 份）
逐域详细设计（router / reagent / gateway / domain / app / ui）、迁移作业单与登记表、审计报告（`AUDIT-*.md`、`FIX-*.md`）与逐批 FIX 记录。具体清单：`ls design-notes/`。

## 为何归档
这些是历史工作产物，其结论已被并入当前规范/契约（如 `DOMAIN-STRUCTURE-DESIGN.md`、`DEVELOPMENT-TRACK.md`、`RELEASE-STANDARD.md`），或已收敛/完成（终验收、已修复事故）。保留于 `archive/` 以维持可回溯性，同时移出根级，避免根级膨胀与事实源混淆。
