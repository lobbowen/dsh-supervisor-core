
# 执行与缺陷修复历史（_EXEC-FIX-HISTORY.md）

> 本文件是对 archive/design-notes/EXEC*.md（28 份执行记录）与 FIX-1..8.md（8 份缺陷修复）的压缩整合。
> 源文件已在收敛后**删除**；本汇总为其**唯一存活索引**。行号是某次快照，可能随代码演进漂移，请以「文件 + 符号/文本」定位。

## 1. 一句话
本批记录了门禁基础设施、app 层重构（ctor 注入/扁平化/根部下拉）、各域结构改造、以及 FIX-1..8 缺陷修复的执行过程与结果。全部为静态执行/报告（node --check + grep 静态核对），未启动任何 daemon、未 commit/push。

## 2. 门禁基础设施（批 0）—— EXEC-gates.md
- 交付物：
  - test/domain-structure-gate-test.js（新建，841 行，DG-1..DG-14 域结构与域间契约门禁，report-only）
  - test/directory-structure-gate-test.js（升级：DS-G3b R6 assign 形态 + DS-9 严格阈值 + report-only 软判据机制）
  - package.json（scripts.test 追加 domain-structure-gate-test.js）
- DG-1..14 实现（每条配反向自检）：
  - DG-1 域门面 index.js ≤150 行且不含 http.createServer/fs.writeFileSync/setInterval
  - DG-2 单文件 ≤400 行
  - DG-3 域 contract.js pure 声明对声明文件扫 IO require（node:fs/net/child_process/http/https/tls/dns）
  - DG-4 域内跨文件 this.X()（X 未在本文件定义却在同域他文件定义），剔除语言关键字/抽象占位/契约豁免
  - DG-4b 豁免表出处核验；DG-4c 消费口径（≥2 兄弟文件定义指向不明）；DG-4d 抽象占位不计违规
  - DG-5a/b/c require 图 + 跨文件 this SCC（环数 0；mixin 环；继承 SCC 合法豁免）
  - DG-6 非入口域文件零顶层副作用（行首第 0 列锚点）
  - DG-7 域内依赖方向单调（rank）
  - DG-8 R6 三件套（mixin-into-prototype 硬判 + methods-fragment 告警，先剥注释）
  - DG-9 contract.exports vs index.js module.exports 双向 diff
  - DG-10 消费方成员 ⊆ 目标域 PUBLIC_API
  - DG-11 域外 .instances.instances 穿透
  - DG-12 非空转下界；DG-13 门禁源码禁止行号断言；DG-14 app/facade 方法名写动词白名单 + 写目标调用
- RED 基线（report-only）：53 passed / 0 hard / 11 soft。
- 偏差 9 项（多为 report-only vs fail）；遗留 6 项。
- 纪律：未改任何 src/；未启动 daemon；扫描先 strip() 剥注释；反向自检与正向判据共用同一函数。

## 3. 执行批次（EXEC3 / EXEC4 / EXEC）
| 批次 | 域/主题 | 驱动门禁 | 关键产出 | 结果 |
|---|---|---|---|---|
| EXEC3 app-ctor-injection | app | DF-4/DF-5 | 真 ctor 注入 3 切面（state/session/control）；test/app-ctor-injection-test.js 26 passed | 完成，3 门禁绿 |
| EXEC3 app-root-downpull | app | DF-2 | app 根部 4 个 >300 行文件下拉拆解 | 完成 |
| EXEC3 app-this-flattening | app | DF-4 | app 跨文件 this 扁平依赖消除（collaborators.js 薄委托） | 完成 |
| EXEC3 df8-df9-scan | app | DF-8/9 | DF-8 顶层 require + DF-9 函数嵌套深度扫描判据 | 完成 |
| EXEC3 native-domain | app/native | DF-2 | app/native 根部拆解（R3-A） | 完成 |
| EXEC3 platform-distribution | platform | DF-2 | platform/distribution 拉到根部 | 完成 |
| EXEC3 platform-os | platform | DF-2 | platform/os 下探（autostart/pidlookup） | 完成 |
| EXEC3 r3g-root-splits | app/api | R3G | 最根部下探，R3-G 六文件拆分 | 完成 |
| EXEC3 service-root-split | platform | DF-2 | platform/service 根部拆解（ports/log/token） | 完成 |
| EXEC4 dg15-dg16 | gates | DG-15/16 | DF-8/DF-9 接入门禁为 DG-15/16 | 完成 |
| EXEC4 dg7-dg11 | gates | DG-7/11 | DG-7 依赖方向 + DG-11 .instances.instances 穿透收口 | 完成 |
| EXEC4 domain-contracts | gates | DG-3/4b/9/10 | 五域 contract.js + 判据收口 | 完成 |
| EXEC4 ds9-facades | gates | DS-9 | 门面 ≤150 行收口（api + platform/os） | 完成 |
| EXEC4 router-residual-soft-red | router | DG-4/4c/5b | router 剩余软红清零 | 完成 |
| EXEC-app-facade-purity | app | R7/R8 | app facade 纯化 + 写动作下沉 app/domain-actions/ | 完成 |
| EXEC-app-state-scc | app | DF-4 | app 状态层 + this 调用图 SCC①② 消解 | 完成 |
| EXEC-app-unmix | app | DF-4 | AP1 装配收口（批 8/10，原型挂载全域消除） | 完成 |
| EXEC-docs-and-registry-sync | docs | DR | 文档与登记同步（域内结构归一化） | 完成 |
| EXEC-instance | instance | DF-2/4 | instance 域结构改造 | 完成 |
| EXEC-plugin-domain | plugin | DF-2/4 | plugin 域 5 文件→14 文件 | 完成 |
| EXEC-relay-domain | relay | DF-2/4 | relay 域入口错位修正 + 单向依赖 | 完成 |
| EXEC-router-facade-store | router | DF-2/4 | router 域门面与状态层（RT1） | 完成 |
| EXEC-router-forward-usage | router | DF-2/4 | router 域「转发与用量 + 运维」 | 完成 |
| EXEC-router-providers | router | DF-2/4 | router 域 providers 功能切分（D2） | 完成 |
| EXEC-router-switch-instance-daemon | router | DF-2/4 | router 域 交换机/实例模型/daemon/端口段 | 完成 |
| EXEC-shell-domain | shell | DF-2/4 | shell 域结构改造（域内分层归一化） | 完成 |
| EXEC-test-assert-sync | test | R10 | 断言钉在源码内容上的既有门禁同步（test/*.js） | 完成 |

## 4. FIX-1..8（8 项缺陷修复）
每条均为「缺陷修复非重构、最小改动、保持对外契约」；核验统一为 node --check + grep/git diff 静态核对。
| 编号 | 缺陷 | 所施修复 | 状态 |
|---|---|---|---|
| FIX-1 | frp 暴露闸按原始值判定落盘用 !! 绕过；LAN CSRF originAllowed 不验 Origin 主机===Host；setLanPanel 不要求 apiAccessKey | 闸改 !!meta.frpEnabled + validateFrpExposure；normalizeHostname + Origin 主机===Host；开启前显式要求 apiAccessKey | 已完成；残留（超范围）：旧空 token 状态、清密钥不自动关 LAN |
| FIX-2 | api-rebind 只绑定 portsShared 却调用未定义 ports.register 致登记丢失；bootstrap 提前 return 跳过更新检查；controller 忽略 applyPort 返回值 | 改 portsShared.register + warn；删 return；applyPort 返回 true 才赋 targetPort | 已完成；内核契约测试 D-2/D-6 正则同步（请主代理确认） |
| FIX-3 | uninstall 锁 TOCTOU；startInstall 未验 policies.busy；store.loadState 调不存在的 upgradeHold.set/setSince | 锁移到 await 前 + try/finally；补 busy 闸；改用 upgradeHold.enter() | 已完成；残留：bootstrap .finally 无代际(D7)、stall 阈值 #11 未改 |
| FIX-4 | registry._load 单条坏 entry 截断整份加载；heartbeat 直接迭代活数组致条目成片跳过；_stopAllSandboxes 丢弃 stopUnit 返回值落 STOPPED 幽灵相位 | per-entry try/catch；.slice() 遍历 + 归属校验；仅 stopUnit===true 才置 STOPPED | 已完成；残留：lifecycle.js:99 同型缺陷、registry._loaded 死字段保留 |
| FIX-5 | removeInstance 把查询失败当 inactive 致删活目录（高危）；lifecycle.stop 恒 {ok:true}；supervise 无进行中即 FAILED；rollback 未先停新版 | 以 stopUnit 确认为唯一放行条件；读返回值失败发 inst_stop_failed；无作业不即死 + FAILED 自愈；rollback 先 await stop | 已完成；新增事件 inst_stop_failed |
| FIX-6 | exec.run() 失败/超时返回 null 不抛；service.js systemd 忽略返回值恒 true 致假成功/STARTING 空等 | daemonReload/stopUnit 改 run()!==null；startTransient 用 runDetail，!r.ok 抛 Error | 已完成；超范围：resetFailed/cleanTransient 同类、exec {timeout} 键名回落默认 |
| FIX-7 | relay shutdown waitFrpcExit 现读 frp.child 已 null 致 frpc 孤儿；probe close/error 不验所有权；monitorLifecycle 遇 DEAD 即 continue 致 kill 分支死代码 | waitFrpcExit 接收捕获句柄；inst.pid===child.pid 所有权守卫；删 DEAD 跳过，连败 3 次 kill 重拉 | 已完成；超范围：frp.js:145 守卫 |
| FIX-8 | applyProxyUpdate 用无 force 的 stopInstance 致常驻实例假成功；deactivateProvider 同缺陷泄漏；instances/router 恒 200；body.js onDone 抛即 uncaughtException | 两处改 stopInstance(inst,true)；失败 200→400；onDone 包 try/catch | 已完成；对外契约：失败由 200 改 400，成功不变 |

状态结论：8 条范围内修复均为已完成。各残留项（空 token 旧状态、bootstrap.js stall 阈值 D7/#11、resetFailed/cleanTransient、frp.js ownership 守卫、exec timeout 键名等）均在各自文件明确标注为超范围、尚未解决。

## 5. 遗留 / 不确定
- 门禁 RED 软项 11 个（DG 软判据，report-only，见 EXEC-gates.md §3）。
- EXEC3-native-domain：upgrade.js 独立（>300 行会破 DF-2）；协作形态用 host-first 自由函数而非 ctor 注入（测试契约未同步）；未运行 upgrade-test（spawn daemon，违反契约）。
- 各 FIX 的超范围残留（见 §4 表「状态」列）。
- 27 条注释钉未逐字核验；§5 域内目标漂移（6 个文件仍超限）——详见 _MIGRATION-HISTORY.md §6。

## 6. 追溯脚注
- 源：EXEC-gates.md、EXEC3-*.md（9）、EXEC4-*.md（5）、EXEC-*.md（13）、FIX-1..8.md（8）。
- 门禁：test/domain-structure-gate-test.js、test/directory-structure-gate-test.js、test/domain-contract-test.js、test/standards-uniqueness-test.js。

