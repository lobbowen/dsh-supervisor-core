# Changelog

本项目的全部重要变更记录于此文件。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 镜像契约 schema3 与两文件所有权拆分（P0-C，跨仓与桌面壳同批）

面板上「镜像源一个都不亮、取不到版本」的另一半病根在**两份配置的所有权**：契约
`registry.json` 里既住壳的目录（catalog/probe）又住内核的选择（mode/origins/manualOrigin），
两个写者只能互相让步 —— 内核每次保存都要「读回原文、只覆盖自己那三键」，而壳一旦读到
`mode=manual` 就**干脆不再重写整份契约**。后果是用户在面板固定过一次源之后，镜像目录与探测
规格永久停在那一刻：新镜像上线、目录里某个源死掉，内核都再也拿不到。

- 按「谁写哪份」拆成两份：`registry.json` 壳有、内核**只读**（schema3 只剩
  catalog/probe/measurements）；`registry-choice.json` 内核有、**唯一写者**
  （mode/manualOrigin/origins + 自己的 schema 与 updatedAt）。两份各自落盘，两个让步一起删掉。
- 壳的证据采用条件写在 `policies.shellProbeResults`：新鲜（30 分钟窗口）+ 覆盖本轮**全部**候选
  （按归一基址比对）+ 逐源过同一道形态闸，三条任一不满足即回退内核自测 —— 采用它的唯一理由是
  省一次全量网络往返，条件松一点就会出现「面板显示一个源、下载用另一个」。
- 升级上来的第一次载入做一次性迁移：旧契约里内核当年写下的 manual 意图接进选择文档并**当轮落盘**
  （否则壳升到 schema3 把那些字段删掉后就再无来源）。
- 跨仓同表钉死「一个镜像源到底是什么」：内核 `test/npm-resolution-test.js` 的 C-m 与壳
  `mirror.rs` 的 golden vectors 是同一张表（形态表 + 私网主机表 + 跳转复验）。真实分叉案例：
  127/8 与 0/8 —— Rust 的 `is_loopback` 认整段、内核只写了 127.0.0.1，同一份契约两侧答案不同。
- 面板 `/dist/registry` 只往响应里加事实：`source` 增加 `shell-probe` 一档、回显 `contractSchema`
  （v2 与 v3 在排障时是两回事：选择字段是否还住在契约里）。
- 门禁随所有权改锚：`J-j` 由「内核写 registry.json 要保留壳字段」改为「内核一个字节都不写壳有的
  契约」，并补行为级证据（壳文件逐字节不变 + 选择文档不夹带 catalog/probe）。写入口回归 `C-8` 的夹具
  由「手塞 registryConfig」改为**先落盘再构造**（手塞时异步段的一次契约重载会把手塞值冲成默认，
  判的是夹具不是实现），并把断言从「同步段不动」升级为「整次调用后内存与磁盘都不动」，逐条回显拒因。
- 未在本批处理：壳探测传输仍走 ureq 默认跟随跳转（内核侧已是逐跳复验的有界传输，两侧对齐在下一批）；
  HTTP 层超时与 npm 长动作时长的口径冲突。

## [0.1.6-BETA.9]（2026-09-24）

### 安装/卸载执行口收口（P0-B）：同一次 npm 动作不再有两套执行方式

症状是「装不上也卸不掉，面板一直转圈」。上一批把「哪个镜像源可用」收到单源之后，剩下的
一段在**执行**这一层：安装走 `platform/distribution/install.js`（有看门狗、有进程树终止、
有镜像注入、有统一结果），卸载走 `app/native/ops.js` 里自持的一次 spawn —— 没有超时、
没有镜像注入、结果形状也不同。卸载卡住的原因通常是网络盘或杀软扫描 `node_modules`，
它的时长量级本来就和安装不同，共用一个字面量或者干脆没有上界，面板就只能表现为无限等待；
而失败时清单被无条件删掉，重试反而找不到对象。

- `install.js` 由「安装执行器」改为「npm 动作执行器」：`action: 'install' | 'uninstall'`
  决定 argv、时长与是否注入镜像源，两种动作共用同一条 argv 构造、同一份字符集白名单、
  同一个结果形状 `{ok, error, output, exitCode, timedOut, aborted}`。`--ignore-scripts`
  两种动作都带（卸载时不执行待删包的脚本）。
- 时长预算单源到 `platform/distribution/policies.js` 的 `NPM_TIMEOUT_MS`
  （安装 600s／卸载 900s，与 Rust 侧 npm 上限同量级），调用方可用配置覆盖；超时路径
  经 `os/process.js` 的 `killTree` 终止整棵树，组信号只对自有进程组发（Windows 无负 pid 语义）。
- 卸载编排回到纯编排：`app/native/ops.js` 不再自持子进程，只消费执行器的结构化结果，
  并据 `exitCode` 决定清单去留 —— 非零退出保留 manifest 以便重试（K10），超时与中止在
  错误文案里指名「包可能仍在，可重试」。安装/升级/回滚三条路径共用 `_runNpm` 一个出口。
- 镜像源注入点由四处收为一处：`platform/distribution/registry-ref.js` 的 `registryEnvPair`
  是「哪两个键有效」与「什么基址可用」的唯一所有者，非法基址**不给半个键**（把 `null` 或
  非法值写进 env 会让 npm 报出与真实原因无关的错）。消费者含
  `domains/plugin/cli.js`、`domains/router/providers/pkg-cache.js`、`providers/probe.js`。
- 目标版本与下载源同源：`app/native/upgrade.js` 的 `resolveTarget` 回 `{version, origin}`，
  升级/回滚下载用**给出该版本的那个源**；`app/native/npm.js` 对外回结构化的
  `fetchVersionInfo`（含 `attempts` 逐源拒因），只要版本号的调用方仍走 `fetchLatestVersion`。
- 随迁的门禁只改锚点、不改判据语义，并且补了行为级证据：`test/fake-npm.js` 新增 argv 回显模式，
  让门禁看到执行器**真正构造出来的** argv 与注入的 registry（静态正则只能证明字面量存在，
  证不了装/卸两条分支各自落到哪份 argv）；新增全仓判据「只有 `registry-ref.js` 写
  `npm_config_registry` 键名」。卸载看门狗的判据改在函数体内比序并要求 `timedOut`/`clearTimeout`/
  settled 幂等位同在，反向钉住「应用层不再自持 spawn」。
- 未在本批处理：HTTP 层超时与长动作时长的口径冲突（面板请求侧 65~120s，而单次插件 CLI 等待
  180s 排在请求内），以及镜像契约 schema 与两文件所有权拆分（跨仓，壳侧同批）。

## [0.1.6-BETA.8]（2026-09-24）

### 镜像源定义层单源：面板「取不到最新版本、也下载不了」的内核侧收口（P0-A）

病根不是某个镜像挂了，而是同一句话在内核里被解释了两遍：壳的镜像目录**允许基址带路径**
（华为云 `https://repo.huaweicloud.com/repository/npm`、腾讯云都是这个形态），而内核的合法性闸把
「不得带 path」当成安全判据 —— 于是一批准许过的镜像在探测阶段判可达、在取字节阶段判非法，
面板只会显示「无法获取最新版本」。跳转判据同样是反的：探测侧拒绝一切 302（健康的跳转型镜像被判死），
取数据侧却用默认策略盲从跳转到任意主机。

- `platform/distribution/registry-ref.js`（新增）成为「一个可用的镜像源到底是什么」的唯一所有者：
  形态与安全分两层（`parseRegistryBase` 只堵凭证/查询/片段/空白与非 http(s)，主机维度另设
  `hostViolation` 供写入口叠加私网闸），传输只有一个口 `fetchRegistry`（`redirect:'manual'` + **逐跳复验**
  目标主机 + 状态码/字节/时长三重有界）。探测与消费走同一条路，不可能再给出两个答案。
- 选源结果从「一个字符串」升级为结构化选择：`selectRegistry` 回 `{origin, ordered, source, manual, probes}`，
  `ordered` 是消费阶段的顺延序列，`probes` 保留逐源结论（「不可达」必须能指名是哪个源、为什么）。
  `manual` 的语义由「短路一切探测、只用这一个」改为「置顶这一个，仍测速、仍回退」——旧语义下面板一旦
  固定成死源就再也拿不到任何诊断。
- 取版本按候选镜像**顺延**并回传**给出该版本的那个源**：`fetchNpmLatest` 回 `{ok, version, origin, attempts, error}`，
  安装/升级的下载源与目标版本同源，「显示一个源、下载另一个源」的分叉关掉。只回 null 时
  「镜像源全挂」与「确实没有更新」无法区分，UI 会把前者显示成后者。
- 9 处选源/取版本消费者迁移（app/native、instance 安装与升级、plugin cli/market/updater、router pkg-cache/proxy/apps-registry），
  只要「本次用哪个源」的走 `registryOrigin`，需要顺延序列或失败原因的走 `selectRegistry`/`fetchNpmLatest`；
  安装路径里手工拼 `npm_config_registry` 的死 env 清除，镜像注入只由 `runNpmInstall` 负责。
- 面板响应只做加法：`/dist/registry` 新增 `ordered`/`source`/`registries`（逐源形态与判定），
  `RegistryCard` 在无延迟处以 title 显示拒因（非法基址与不可达是两种处置）。
- 按 DF-2（单文件 ≤300 行）把分发层再切两刀：`registry-config.js`（契约载入与「谁的字段谁写」的落盘）、
  `version-check.js`（目标版本查询），与 `install.js`（npm 执行）各自单一职责。
- 传输口对外**只返回 `{ok, error}`，任何情况下不外抛**：响应头已到手、读体读到一半被对端掐线这一路
  过去会抛给调用方，等于逼每个调用方各长一份 `try/catch` —— 那正是第二套「可达」判据长出来的地方。
  `npm-resolution` 用假 registry 的截断路由把这条钉成可红门禁。
- 随迁的门禁判据只改锚点、不改判据语义：`round13` 的读入口重载判据接受 `config.` 限定形式，
  `npm-resolution` 的「形态闸单源」判据改为要求 URL 解析只住在 `registry-ref.js`。
  「先过包名白名单、再拼 registry URL」的时序判据改在 `fetchNpmLatest` **函数体内**比序：
  整份文件比序会拿被闸保护的 `versionFromOrigin` 当参照物（它在文件中天然靠前），判据恒假。
  未新增测试链条目。

壳侧（契约 schema3、探测逐跳复验、两文件所有权）归 P0-C，跨仓且需发版；本批不依赖它即可解除症状。

## [0.1.6-BETA.7]（2026-09-24）

本版是审计第三组的内核侧收口：门禁空转（判据写法上永远不可能判红）、文档失实，与零调用死链
（PR #42）；加上上一版发布链暴露的 `published-smoke` 首跑判红（PR #41）。内核运行时依赖仍为 0；
新判据一律并入既有门禁文件，未新增测试链条目。

### 修复：`published-smoke` 在包已上架的情况下判红（0.1.6-BETA.6 首跑暴露）

发布后冒烟是 v0.1.6-BETA.6 首次真跑的，四平台全红，但线上四个子包当时都已发布成功 —— 红的是判据本身。
取证：`release` job 结束于 09:47:13Z，npm 侧记录该版本的摄取时间是 09:48:04Z，而六轮重试（45 秒一拍）
从 09:47:27Z 跑到 09:51:21Z 始终读到 `ETARGET`。真正卡住的是**可见性**而非执行顺序：packument 在 npm
本地缓存与 registry 前置缓存里都按 `max-age=300` 复用，于是每一轮重试都读回首那份「尚无此版本」的元数据，
重试预算等于空转（末轮从起 npm 到报错只用了约 0.2 秒，即缓存命中的直接证据）。

- `release/scripts/install-smoke-core.sh`：registry 形态的装命令带 `--prefer-online`（实测该旗标会让请求
  绕过前置缓存，`cf-cache-status` 由 HIT 转 MISS）；本地目录形态不带，避免把无谓的网络往返塞进 build job 的冒烟。
- `.github/workflows/build.yml` 的 `published-smoke`：重试窗口由 6 轮 x 45 秒（270 秒，短于缓存生命周期）
  改为 10 轮 x 75 秒（750 秒）；且**只对「registry 看不到该版本」这一类失败重试**，装上了却挂在
  self-check / healthz 的真缺陷立即定判，不再把同一条缺陷抄满预算。判定口径不变：只有末轮的 rc 决定结果。
- 门禁：`test/install-smoke-gate-test.js` 新增 `G4-registryCacheBust`（正向含绕缓存旗标、反向是常开该旗标的
  坏夹具）、`G3-l/G3-m`（重试窗口秒数须达 600 秒、失败须分类）与 `G3-n/G3-o/G3-p/G3-q` 反向样本；
  并纠正 `G3-i` 的归因注释 —— npm 上传实际发生在 build job 的发布步，`needs: release` 是传递性地等到它。

### 门禁不再空转：四条判据改成「真能判红」，归档引用可核（PR #42）

门禁这一族的毛病不是判错，而是**按写法根本判不到**——判据恒真，绿得没有任何含义。
每条新判据都配反向夹具，即「把它退回旧形态必须判红」。

- `all-platforms-test.js` **T2-f**：旧写法是「`ci-core.sh` 里不得出现某个短语」，而那个短语从未存在于
  任何文件，于是恒真；改为对 `release/scripts` 与 `.github/workflows` 下的文件逐个剥整行注释后扫
  `release-core`，要求零命中（真实调用行必须被抓到、整行历史说明不得算作调用）。
- 同文件 **T2-j** 方向是反的：它要求 `publish-core.sh` 从 `_platforms.sh` 取平台矩阵，而该脚本的现行形态
  是每个 runner 只发本机那一包。改为「不得自带平台矩阵」。
- `test-chain-completeness-test.js` 新增 **N-g**：文档与 workflow 注释不得写死测试链的**条目数**——
  数字只有门禁每次实跑打印才可信。同时清掉三处已失实或会失实的写法（`build.yml` 的文件数、
  `ACCEPTANCE-STANDARD.md` 的硬编码条数、`kernel-daemon-contract-test.js` 的编号区间）。
- `docs-reference-gate-test.js` 新增 **DR-4 / DR-5**：DR-4 要求文档写死的归档目录份数等于文件系统实测；
  DR-5 要求指向归档目录内单个文档的引用**打得开**——过程文档收敛成主题卷并删除源文件之后，
  仓内还留着五条打不开的指针，已按其去向改指到存活的 `_EXEC-FIX-HISTORY.md` 或就地写下结论。
- **`ci/check-glibc.sh` 不再静默放行**：旧实现「提取不到 GLIBC 符号 → 警告 + 退出 0」把**静态链接**
  （合法豁免）与**工具缺席 / 产物读不动**（只是看不见）合并成同一条通过路径——那种 runner 上本门禁
  永远绿。现在版本比较器先自校（比不出 2.31/2.35/2.40 即 `exit 2`）、objdump 与 readelf 都不可用即
  `exit 2`、工具读取失败即 `exit 2`，只有 `readelf -lW` 成功解析 ELF **且**确无 `PT_INTERP` 才算豁免。
  `glibc-gate-test.js` 追加 R8：喂一个非 ELF 文件必须拿 `exit 2`（旧形态给 0）。

### 零调用死链与契约漂移（PR #42，删前逐条做全仓引用取证）

- **relay 的 `persist` hook 整链**：`ops.js` 的 `_saveAll()` 是唯一会调 `this.persist` 的地方，而它自己
  无人调用 → 契约声明、`LanManager.persist`、`supervisor.js` 的注入点一并撤下；`CONTRACT_HOOKS.relay`
  同步改为 `mainOf/tokenOf`，否则契约豁免表与 `contract.js` 再次漂移。
- `managed.findManaged` / `LanManager._findManaged`、`host._writeDshMain` 挂载（唯一调用点就是上面那条
  死 hook）、`ctl/facades.js` 的 `_makeCtlFacade`、`audit/orphan-scan` 的 host 兼容外壳（12 项惰性 deps
  与 `collaborators.js` 同一语义维护两遍）、`providers/model.js` 与 `policies/freeze.js` 各一处恒假的
  `selectedProxyKeyId` 读分支（`store.js` 那处是旧持久化数据的兼容迁移入口，保留）。
- **`publish-core.sh` 的 `--all` 自递归发布块**：它在单个 runner 内把四平台各发一遍，与「所有发布仅 CI
  各 runner」的硬标准直接矛盾，且没有任何调用方传该开关。
- 取证推翻的一条审计结论：`_orphanAudit` 被标为死代码——**实现体不能删**（`control/scheduler.js` 是真实
  消费点，且被 GD-6 钉住覆盖面），本批只删无人调用的兼容外壳。

### 文档与注释失实

`DOMAIN-STRUCTURE-DESIGN.md` 的「6085 行」是凭空数字，删；`README.md` 的归档份数按实测改写并注明由
DR-4 核对；`release/scripts/build-ui.sh` 的注释称 CI 侧不设置 `DSH_UI_SKIP_INSTALL`，而 `ci-core.sh`
恰恰先装好依赖再置该变量——注释与实际相反，按实改写；`main-store.js` 的两条日志前缀不再指向已删除的
挂载名。

## [0.1.6-BETA.6]（2026-09-23）

本版为全仓审计修复批的前三组收口：安装包冒烟执法（PR #37）、B1 运行期 P1 缺陷（PR #38）、
B2 状态与意图单源（PR #39）。内核运行时依赖仍为 0；验证全部折进既有测试链，未新增测试文件。

### 补齐缺失的验证：CI 四平台「安装包冒烟」

1.2.3 以来两仓都声明了安装包冒烟、却从无 CI 任务实现它 —— 内核发布物是全局安装的 npm 子包，
「安装包冒烟」应是 `npm i -g` 产物并证明**装出来的全局命令**可用，而 `test/smoke.js` 一直只跑源码树。
本批把它补进 CI（仅此，不改产品代码）：

- 新增脚本单源 `release/scripts/install-smoke-core.sh`：装 → 命令可解析 → `--version` 自报比对 →
  `self-check: OK` + `guardVersion` 比对 → 隔离状态根起 `daemon` → `/healthz` 2xx → `ports.json` 唯一
  `supervisor-api` 记录且端口一致 → `npm rm -g` 收尾（不覆盖应用内更新落盘）。
- `build.yml`：build job 在 dry-run 后、发布前对 `dist/npm/@dsh-sup/dsh-core-<os>-<arch>` 跑（S6b，四平台 PR/push/tag 都跑）；
  新增 `published-smoke` job 从**公开 registry** 按 `@dsh-sup/dsh-core-<os>-<arch>@<ver>` 跑发布后半（S7b，重试至末轮定判据）。
  它 `needs: [precheck, build, release]`：npm 发布在 `release` job 内，只依赖 `build` 会让冒烟与同一 run 的发布赛跑，
  包还没上架就 404 到耗尽重试（判据红而线上其实正常）。`if` 里的 `always()` 不是修饰词，是手动
  `workflow_dispatch(ver=…)` 补跑历史版本的唯一通道 —— 非 tag 运行里 `release` 为 skipped，缺它本 job 会被连带跳过。
- 门禁：新增 `test/install-smoke-gate-test.js`（G1–G5 含反向样本；G3-i/G3-j 专钉上面那条依赖与 `always()`），
  并在 `all-platforms-test.js` T5 组校验 `published-smoke` 可被 `jobSection` 解析；
  规范 JSON 的 `ciJobs`/`specGates`/`entries` 三处清单同步收录本 job 与其脚本、门禁，使「文档列出=CI 存在」双向成立。
- 首跑（四平台）暴露并收口的三处本批缺陷：守卫配置的 `command` / `healthUrl` 属**业务键**，只写 `apiPort`
  会让 `daemon` 死在 `config.normalize`（三平台同点）；告警文案里 `$MOCK（` 被 shell 可移植性 S-1 抓到
  （macOS bash 3.2 把全角字符首字节并进变量名）；darwin-x64 腿的宿主是 arm64，npm 按宿主拒装（`EBADPLATFORM`），
  改为仅在撞上这一条时按目标平台重装一次。三条各补判据（`G4-configBusinessKeys` / `G4-crossArchInstall`），
  反向夹具就是这次失败的那几行原文。

### B1 运行期 P1 缺陷收口 —— HTTP 路径不再同步 exec，判据/校验五处单源（PR #38）

审计真机现场：一次 5s 超时的同步 exec 能把单线程守卫冻结整拍，面板与心跳一起失联。

- **同步 exec 冻结收口**：envStatus/versions/npm/checkEnvironment 全链路改异步探测（EnvCatalog
  `probeAsync` 双口径；exec 同步版退守启动早期/CLI），api 域 `/env/status` 与 `/guard/version`
  改 Promise 包装，`install()` 锁内首步异步环境检查；`runAsync` 兜住 `execFile` 的同步抛，
  「绝不 reject」契约在 win 平台也成立。新增 G9-e 敏感路径同步 exec 门禁（执法）。
- **CLI 不再永挂**：bin 的 `apiRequest`/`cmdUpgrade` 收敛到单一 `apiRaw`（5s 超时可报错退出）。
- **远程开关不再静默变更**：`setRemoteMode` 必须显式 `off|lan|wan`，`setRemoteToken` 必须显式
  字符串（空串=清除）——漏字段不再被当成「关闭远程控制 / 清空凭据」。
- **STARTING 超时判据单源**：唯一判据 `startDeadlinePassed`（decide 纯段导出、controller 复用）；
  从盘恢复无 deadline 时首拍重 derive 宽限，不误杀在途启动。
- **rolledBack 只描述事实**：仅在回滚实据（`rb.ok` / 装回+核验通过）后置位，brief/CLI 文案不再虚报。
- **判活 fail-open 收口**：`probeAlive` 三态化（EPERM=存活 / ESRCH=已亡 / 未知码保守），daemon
  `_pidAlive` 未知态回落 ctl 端口属主 `ownerPid` 比对作第二证据，`waitProcessExit` 去掉 fail-open；
  AT-1 判活基线 30->31 注明归属。

### B2 状态与意图单源收口 —— 第二落点/第二本账废止，治理每拍恰一次（PR #39）

审计的核心错位：同一事实存在两处落点（意图、端口账、退避计数），两边都能「对一半」，
而治理决策还按实例数乘法放大。

- **B2-1 沙箱运行意图第二落点废止**：`inst.state.desired` 整体退役（意图 = guardian 旗标 ×
  启停动作本身），`.state.desired` 写口全域清零（GD-7 执法），model 仅留 `delete` 一次性残留剔除口。
- **B2-2 guardian 退出目录面**：申报不带、`createEntry` 不物化、目录面三文件去注释零 guardian token
  （GD-1 申报/运行期/源码三层）；权威只在 `dsh-main.json` / `inst.guardian`，消费者直读源。
- **B2-3 fallback 暂存稿不再静默蒸发**：目录未就绪期的崩溃计数在真 entry 首见时回填；
  fields.js 生命周期字段直写并入 `record.fieldOf` 唯一写口（ML-2 基线钉 0，回潮即红）。
- **B2-4 config 写口归一**：lan-panel 自带 fs/writeAtomic 直写退场，持久化唯一入口
  `state.persistConfigPatch`（fail-closed 保留原字节）+ `verifyPersisted` 写后读回核验；
  旧键清理由别名字典驱动（`getConfigAliases`），仅当新旧键都在盘上才删旧键。
- **B2-5 端口第二本账退场**：`ports-lan.json` 废止并入 `ports.json` 单本账（启动期按 owner 前缀
  一次性迁移 `relay:*`，幂等）；注册表写口/冲突判读口按 mtime+size 指纹自动对时（分配锁内再对一次），
  陈旧快照不再抢注「已配置但当前停止」的静默端口、全量覆盖不再丢写（ports-claim 补真跨进程夹具）；
  实例启动对配置端口被他方登记即时显式拒绝 `PORT_TAKEN:<by>`，不等 systemd bind 失败。
- **B2-6 五项小收口**：journal 令牌回填加 `_attachGen` 世代守卫（迟到死令牌不再在 detach 后回灌）；
  OAuth 回调/浏览器监视按 `_ccLoginRound` 轮次比对，旧轮迟到回调一律 410（旧凭据绝不注入新轮）；
  市场构建预算入 per-build `bctx`（叠建不再互踩 deadline，最坏数十分钟的挂请求消失）；
  `act=start` 带 `opts.manual`，`_systemdStart` 成功即作废旧退避链（「重试超限」不再封死手动重试通道）；
  governor 全花名册 `decide` 从逐实例监督拍移入心跳拍末钩子 `onBeatDone` -> `governSweep`
  （每拍恰一次、同拍违规一起处置，N 实例 O(N²) 放大消失；ManagedRegistry 不可用时 startTimer 兜底同语义）。

## [0.1.6-BETA.5]（2026-09-23）

本版是真机「内核启动完，进面板直接 127.0.0.1 拒绝连接」的内核侧三条根因收口
（守卫锁自愈 / 端口单源 / 面板可被壳承载），并补上 1.2.3 以来一直缺失的启动链冒烟门禁。
内核运行时依赖仍为 0。

### 守卫锁不再永久让位：心跳续约成为第三条独立证据，让位一律带原因（KI2）

现场（Windows，`guard.log` 两轮）：壳停守卫走的是按命令行 `Stop-Process -Force` 的异步强杀，
`process.on('exit')` 不执行，锁留在一个刚死的 pid 上；此后 `acquireLock` 只有「pid 存活 + 命令行
是不是本产品守卫入口」两条证据，而这两条在 Windows 上都会被 PID 复用或读不到命令行（`wmic` 缺位 /
探针超时）打成假阳性 —— 于是任何新守卫永久让位、端口再没人监听，现场只剩一句无信息量的
「已有守卫实例在运行」。

- 锁持有者以 `utimesSync` 续约 mtime（2s 心跳、15 拍 = 30s 老化）作为第三条**独立**证据：
  命令行读不到时，只有「锁已停止续约」才接管，否则仍保守让位；接管与让位都落一行原因。
- 撞锁时若持有者活着且确实是本产品的守卫，给 `LOCK_TAKE_RETRY_MS` 的**有界**窗口等它退出 ——
  壳刚下令停止、前任还没咽气，立刻让位会把一次正常重启变成永远起不来。窗口耗尽仍让位，
  单实例保证不变（双守卫并存比晚起几秒严重得多）。
- 让位/失败一律带原因返回（`cmdDaemon` 把原因打进日志），不再裸 `false`；pid 存活判定收
  `pidAlive` 单源（EPERM 算存活），分诊循环内不再重复读命令行。

### ports.json 的 `supervisor-api` 立成同 role 唯一（KI1）

登记表以端口号为键，`EADDRINUSE` 避让成功时新端口是**追加**记录；旧记录只有
`release(prev,'system:supervisor-api')` 真生效才消失，而那个调用被 `catch {}` 包住且忽略返回值。
留两条时「按 role 取号」的两种读法可以给出不同答案，其中一个是没人监听的端口 —— 而壳读的正是这个文件。

- 新增 `registerSole(role, port)`：先删同 role 的其它端口记录再登记，把「同 role 唯一」立成不变式；
  `startApi` / `_rebindApiHost` / `_registerFixedPorts` 三处登记点全部改用它。
- `get(role)` 在同 role 有多条（老版本残留）时取 `createdAt` 最新一条，与壳侧读法同一判据。

### 面板 CSP 的 `frame-ancestors` 由 `'none'` 改壳 origin 白名单

桌面壳以内容 iframe 承载面板（祖先 = 壳主帧的 tauri origin），`'none'` 把它一起拒；
iframe 被 CSP 拒绝不触发 `error` 事件，前端拿不到失败信号，表现就是面板永远空白 ——
这是「拒绝连接」修好之后的下一条断链，只发一侧仍会留下坏面板。点击劫持防线保持原样：
白名单只点名壳的三种 origin 形态，不放 `'self'`、不放通配，第三方页仍全禁。

### 门禁：把「壳据以访问面板的那份登记表」真正测到

1.2.3 以来面板链只有 `/status` 级断言，从没验证过端口顺延、锁残留与承载这三件事。

- **S13**（`test/smoke.js` 新场景，CI-only 运行时）：按壳的读法走完整链 —— 从 `ports.json` 取
  **实际**端口（不钉死配置端口，端口顺延是产品自己的合法行为）→ 该端口 `/healthz` → 面板文档
  与 CSP 白名单 → 守卫锁归因 / 续约 / 让位原因 / 强杀残留回收。锁阈值从 CLI 源码读出，
  避免产品调窗后判据空转；Windows 上 SIGTERM=强杀、锁残留是既定语义，故该断言按平台分档，
  真正的保证落在「残留锁必须被回收」那条。
- `test/core-test.js`：CSP 断言从钉 `'none'` 改为逐个点名壳的三种 origin + 无通配 + 不含裸
  `tauri:` 方案。
- D-2/D-5/D-6 针脚随锁改写并各自保留反向样本；`test/ports-claim-test.js` 新增 KI1 段，
  用纯登记表断言「换端口后同 role 只剩一条 / 落盘同表唯一 / 残留双记录取最新 /
  `registerSole` 能清掉老版本僵尸记录」。
- 纠正 D-5 反向判据自身空转：旧样本用「只认 pid 存活就裸 `return false`」的真实形态，
  而比对只认后来两种写法，于是「必须抓到违规」的断言自己判红；改为按分诊区（读锁之后）
  比对有无原因（`tryCreate` 里的 `return false` 是 EEXIST 布尔，不在比对范围）。
- 链完整性文案同步：`test/smoke.js` 的场景数说明由 S1..S12 更正为 S1..S13。

### 已知未验证

- 「`'none'` 导致面板空白」是 CSP 语义 + 已确认的 iframe 结构推出来的，本机没有真机观测过空白本身。
- 安装产物四平台冒烟（壳侧 H9 的 1.2.4 遗留项）仍未做；本版只到 CI 门禁。

## [0.1.6-BETA.4]（2026-09-22）

本版是「运行意图单源」的方向③判据统一：域 A 的意图从此各只有一个落点、一个写者，
读侧判据不再被投影/镜像反喂。行为变更三条（ST-1 / ST-2c / ST-2 收口），判据补齐五条。
内核运行时依赖仍为 0。

### ST-1 router 运行意图收单源：保活/游离判据只读持久化 config

现场：「该不该活着」读两个源（`config.routerAutostart` 或 视图/目录的 `desired`），镜像与库里不一致时
以镜像为准 —— 写库半途失败或被拒的 `start` 抛异常会留下 `desired=running` 的幻影意图，
被停掉的 router-daemon 每拍重拉、面板关掉仍在跑。

- 读侧：`app/daemons/supervise.js` 的保活判据、`app/audit/orphan-scan.js` 的游离判据只看持久化/结构性意图本身。
- 写侧补齐分叉口：`ManagedLifecycle.start()` 的异常分支与 `ok:false` 同语义复位 `desired`；
  adapters 缺 `setRouterRunning` 写口时显式拒绝，不再退回直调内嵌 router
  （内嵌回退本就在 `setRouterRunning` 内部，能力零损失）。
- 停止路径的两处裸赋值改走早就存在的 `wantStopped()` 出口（与启动路径的 `wantRunning()` 对称）。
- 判据：GD-6 在去注释源码上断言两分支与两条 want 判据不读 `desired`（含正反合成样本）；
  `test/session-lifecycle-test.js` 的 ST-1 段锁写侧三态（缺写口拒绝 / 不留意图 / 有写口只经写口）。

### ST-2c 沙箱运行意图收单写者：落点进实例 state，stop 按来源分档，keepDesired 废止

- 意图落点改为实例自己的 `inst.state.desired`：`lifecycle.start()` 走到真正要拉起/安装才记 `running`，
  被拒的 start（作业在飞、预算已满）不留意图；升级收尾与插件生效的重启同样经此表达。
- `stop(id, {intent})` 分两档：默认 `user` 才落 `stopped`；`transient` 只停这一次，不抹用户意图。
- 目录侧 `sandboxSpec` 改为**只投影**该落点，不再读 `state.phase` —— 心跳同步与启动对齐由「禁止直写」
  转为「允许且只能投影意图」，`keepDesired` 旗标随唯一落点成立而成为死代码，全仓删除。
- 老库一次性种子：字段缺失时按当时实然相位猜一次，此后再不由 `phase` 推导（崩溃退避、自动临时停都不抹意图）。
- 判据：GD-7 扩为意图单写者 ratchet（域内 `BASELINE` 计数 + 旗标回潮判红 + 四类反向样本），
  GD-8 扩为来源/消费者三态分类（`noLanding` / `violating` / `landingGaps`）；
  ML-1 与 D-8 断言按新形态有意翻动（原「动作路径不得带旗标」三条改为「意图只有一个写者」）。
- **已知缺口（GD-8 的 GAP_BASELINE 显式登记）**：沙箱意图有落点、暂无决策消费者 ——
  不靠新增开机自动启动来「补」，等那条决策判据立项。

### IL-2 存在层归壳的判据从 macOS 扩到三平台

`KERNEL-DAEMON-CONTRACT` D6 早写了「内核不建立/不服务化自己的定义」，但执法只有 macOS 一份：
linux 的 unit 与 win32 的守卫任务在自启路径上无人看守。新增 P7 —— 三平台 `setAutostart` 体内，
守卫定义标识与建/删动作不得同行共现（`enable`/`disable`/`bootstrap`/`bootout` 作用在既有定义上属许可，
含四类旧形态反向样本 + 合法形态不误报），并登记为门禁 D-10。

### A9 / L-6 两条新判据：违例显式登记为基线，不改行为

- A9（`platform-capability-audit`）：`guardAutostart` 声明为 `true` 必须有真正作用于守卫的关闭路径，
  只写 GUI 产物不算。实盘 linux/darwin 有、win32 无（守卫任务与看护任务均归壳建），违例按 ML-2 形态登记。
- L-6（`layering-and-dependency`）：api 层不得读注入对象的下划线私有成员 —— require 图看不见这条边。
  基线登记 `shell.js`（`sup._sessionHalting`，会话退出意图在 api 自算）与 `dist.js` 各 2 行，按命中行数计。

### 判据基线与注释订正

- ML-2 生命周期视图直写违例基线：router 侧 12 处下调到 10（走出口后不再是直写），
  并把表内行号按现状重新逐条机器核对；文档里未钉死的「29 处」总数改为交给 GD-7 判据。
- `test/autostart-ownership-test.js` 头注释失实纠正：P4/P5 会真调平台实现，故本套件不在本机直跑。
- 契约文档随批：`GUARD-DOMAIN-MODEL.md` §6.2 增「读侧同规则」并改写收口形态，§5 登记 GD-6/GD-7/GD-8；
  `README.md` 守护域行同步到 GD-1..GD-8。

## [0.1.6-BETA.3]（2026-09-22）

本版只含一处行为修复：守卫锁的让位判据（D-5 扩展）。

### 守卫锁只在「持有者确实是本产品守卫」时让位，陈旧锁接管

现场（Windows 真机 + 壳 1.2.2）：壳直接拉起 `node .../bin/dsh-supervisor`，守卫打印
「已有守卫实例在运行（锁 ...guard.lock），本进程退出」并以 1 退出，而端口始终不可达 ——
让位对象是一个**不存在的**守卫，壳端只能报「启动超时（端口不可达）」。

- 判据此前只有 `process.kill(holder, 0)`：Windows 上 pid 会复用，被杀进程句柄未释放时该调用同样成功，
  EPERM 也一律当存活；而锁里只有一个 pid，没有任何身份可比。
- 锁内容升级为 JSON（`pid` / `started` / `entry`），**读侧兼容旧的纯 pid 格式** —— 否则一次升级会把所有
  在用实例的锁看成无效，反而制造双守卫；`releaseLock` 改按解析后的 pid 比对。
- 让位前用命令行锚点确认持有者确实是守卫入口（`dsh-supervisor`）；存活但命令行不是它 = pid 被复用
  → 按陈旧锁**接管并留痕**（清理原因 + 持有 pid + 实际命令行）。
- 保守边界：进程存活却读不到命令行时仍然让位。双守卫并存（双写状态、竞态 spawn）比这一次不起严重得多。
- 判据：`test/kernel-daemon-contract-test.js` 的 D-5 从「占用即退出」扩为以上四条，含旧形态反向自检。

## [0.1.6-BETA.2]（2026-09-22）

本版不含行为变更：按 DEVELOPMENT-TRACK §6.1 对 `src/` 与 `ui/` 全部源文件逐文件压缩注释，
并以真实实现为准纠正失实注释。内核运行时依赖仍为 0。

### 全仓注释压缩：论文式长块清零，注释行 6369 降至 4394（-31%）

- **规模**：323 个源文件（285 个被改，28 个本已合规）注释行 6369 降至 4394，净删 2008 行；
  含尾随注释的行占比 21.0% 降至 15.8%（非空代码行 25955 不变）。
- **块形**：注释块长度分布改为 1 行 1759 / 2 行 571 / 3 行 307 / 4 行 143，**5 行及以上清零**
  （原 118 个长块全部拆解）。执行口径量化下发为「任意注释块 4 行内、文件头 3 行内」。
- **删除项**：批次号与轮次号、CI run 号、红/绿/崩溃过程史、`AUDIT-日期` 与 `§X-n` 交叉引用、
  「原判据…现改为…」式勘误链、拆文件路线图注释、同一事实在两处的重复表述。
  契约编号（TK-/INV-/DS-/RC-/W1..W4/CP-/PG-）作为仍然生效的判据名保留。
- **字符纪律**：注释内的箭头、制表框线、带圈数字、几何符号与 `§`/`·`/NBSP 一律换成 ASCII 或中文标点。

### 失实注释纠正：约 70 处「注释说的」与「代码做的」不一致按实现改写

- `domains/router/scheduler.js`：30s 生命周期监控原自称「不做 HTTP 探活」，实为带探活；
  `refreshReadyAccounts` 原写「预热」，代码无此动作。
- `platform/os/index.js`：darwin/win32 分支原宣称 launchd / windows-service，实为 portable 载体。
- `platform/service/token/kinds.js`：`list()` 顺序原写成由 `KIND_ORDER` 决定，实为插入序。
- `api/security.js`：原宣称不放开子域通配，`tauri:` 协议实际仍接受 `*.tauri.localhost`。
- `app/daemons/process.js`：`_orphanAudit` 原写消费 `classify` 结果，实为不消费。
- `platform/service/token/exchange.js` 缓存口径自相矛盾、`domains/instance/upgrade.js`
  「手动强制刷新」不存在、`app/settings/versions.js` 解析行写错（实为 `dsh-supervisor v<ver>`）、
  `ui/vite.config.ts` 端口写 3100（`apiPort` 默认 36360）等，逐条按现状改写。
- 同类纠正散布于 api/assembly/control/relay/router/plugin/shell/service 各域，共约 70 处。

### archive 文档随批订正

- `archive/design-notes/` 下 13 篇的「范围」行号与规模随拆分现状刷新，
  并在迁移前现状段顶部标注该段为立项取证、非当前事实（按「所有改动单批次」一并入批）。

- 验证：285 个源文件用仓内 `test/_strip.js` 比对，空白化注释后代码逐字节一致（7 个 `.tsx` 的
  差异全为删掉的 `{/* */}` JSX 注释子节点，无可执行代码变化）；241 x `node --check` 全过；
  comment-pin 门禁 27 passed / 0 hard fail、CS-1 字符白名单与 CS-2 叙事禁令 477 文件 0 命中；
  PR #26 上 precheck / test（全量运行时套件）/ 四平台 build 全绿。

## [0.1.6-BETA.1]（2026-09-22）

本版主线：远程控制三态化收口、面板内核更新进度桥、反代生命周期 W1 + 进程隔离标准化、
实例沙箱 W1–W4、判据统一专项清理与文档归档收敛；同批并入发布通道根因修复（`latest` 跟随每次发布）。
内核运行时依赖仍为 0。

### 远程控制三态化收口：remoteMode 单状态取代多布尔并行，访问视图单一事实源

- **根因**：远程意图由 `remoteEnabled`/`frpEnabled`/`frpRemotePort` 三个布尔加 main 侧
  `patchDshMain` 拼出，「局域网」与「公网」并行存在而非互斥；二维码与就绪态在前端按这些
  开关自行推导，于是出现「开了远程但码还是局域网地址」。端口侧 `inst.wanPort` 镜像与
  relay 槽位注册表构成 ghost 双族（历史写死值经 lan-state 传播给 daemon，两边各信一份）。
- **模型**：每受管对象（main 与各沙箱）一份 `remoteMode: off|lan|wan`，是远程意图的唯一
  落盘字段。`frp.json` 只剩 frps 连接参数（`enabled` 总闸随三态废止：frpc 生命周期单一
  条件 = 是否存在 wan 意图）。legacy 磁盘态经 `legacyRemoteMode` 一次性推导（`true`+`true`
  →wan、`true` →lan、其余 →off），首次写盘后旧键即消失，读侧不留双轨。
- **端口**：公网口与 relay 口**恒同号**（`remotePort = wanPort`），不存在第二套端口分配，
  也没有 override 字段。绑定权威只在注册表（`byOwner` 复用）——关远程只停 server 不
  `releaseOwner`，重开自动复用同口；`inst.wanPort` 镜像字段删除，lan-state 协议不再带端口。
- **判定收口**（`relay/core.js` 纯函数，零 IO）：`projectRemoteView` 产出
  `{mode, ready, accessUrl, reasons}`，`ready` 当且仅当 `reasons` 空，未就绪逐条给因
  （relay 未监听 / 未设令牌 / 会话注入中 / 未配 frps 地址 / 隧道未建立）；`accessUrl` 的
  host 由 mode 选（wan→`serverAddr`、lan→局域网地址），前端不再自行拼。**唯一写入口**
  `setRemoteMode` 对 wan 前置 `validateWanAccess`（令牌闸）：该函数只有令牌入参、没有
  端口参数，端口无自由度由同号纪律在结构上保证。`frpRemotePort` 手填公网口一并删除。
- **API**：意图面收为 `POST /remote/{set-mode|set-token|frp-server|frp-install}`
  （`{ok:false}` 一律非 2xx，安全闸拒因如实回显）；状态面 `GET /lan-access`（remote 视图）
  `GET /remote/frp`。旧 `/lan/frp/*` 五条路由**不留兼容直接删**。`/native/settings` 白名单
  收窄为仅 `guardian`，`/instances` 不再装饰任何远程字段（此前它另算一套 `lanUrl`，与
  `projectRemoteView` 构成第二处访问判定来源，判定不一致即由此产生）。
- **UI（与后端同批改，无半成品中间态）**：`LanPage` 一行一状态一开关——模式开关只在
  off/lan 间切换，wan 由「局域网 / 公网」分段控件选择，两者写同一 `remoteMode`；二维码
  仅在 `remote.ready` 时出，指向 `remote.accessUrl`（开远程即换远程码）；`reasons` 原文
  进状态药丸 title，不再 UI 自证「未运行」。FRP 卡去掉总闸，`authToken` 保持 patch 语义
  （留空省略字段）。
- **门禁与判据**：`round13-router-relay-gaps` ① 段改钉单一意图入口（`setRemoteMode` 写入
  前过闸 + 行为用例断言无令牌/弱令牌被拒且**未落盘**）、`main.js` 整文件零远程字段；
  `token-contract-gate` 的 `LAN_STATE_ROW_KEYS` 收为 `{id,name,port,remoteMode,remoteToken}`；
  `token-boundary` 的 `listLan` 白名单换为现役非机密字段并加 remote 视图结构判据；
  `domain-structure-gate` DG-14 写目标清单删 `setFrp`、增 `setRemoteMode`/`setRemoteToken`；
  `frp-resilience` R1 加「非 wan 意图不出隧道」与同号反向例；`lan-daemon` 集成测试不再硬编码
  期望端口，改由 `ctl list` 回读实测绑定口（注册表权威的必然结果）。
- **事件**：`dsh_frp_changed`/`lan_frp_changed` 随总闸废止删除；新增
  `dsh_remote_changed`/`inst_remote_changed`（载荷 `mode`）与 `dsh_remote_token_changed`，
  令牌类事件只记 `tokenSet` 布尔（TK-5 零明文纪律）。

### 面板点「更新内核」不再是黑箱：消费壳中继的进度，等待上界改由壳下发（配 B4b）

- **根因**：面板→壳桥只有「一问一答」。`kernelUpdateBridge.ts` 收到 progress 帧直接 `return` 丢弃，
  且等待上界写死 `6 * 60 * 1000`，而壳侧内核安装预算是 17 分钟（壳仓 `bridge.rs`）。
  于是面板必然先报「桌面壳无响应（更新请求超时）」——那不是结论，是面板自己编的结论；
  按钮随之解禁，用户重试 = 两个进程并发写同一个 npm 全局前缀（单写入者契约要消灭的形状）。
- **修法（不新增协议，补齐半途的桥）**：progress 帧现在被消费为 `KernelUpdateProgress`
  （`status` 文字 + `progress` 0..1 或 null，null = 该步无可测分母，UI 于是只显文字不画假百分比）；
  首帧带 `maxWaitMs` 时按 `maxWaitMs - 已等时长` 重设上界，旧壳无此字段才退回 `FALLBACK_MAX_WAIT_MS`
  （刻意**大于**后端预算：宁可晚报，不可早解禁）。超时文案带最后一次进度原文。
  协议版本保持 1（旧面板忽略未知帧，递增反而打断新旧并存的升级期）。
- **UI**：`AboutCard` 内核版本行下增进行中一行（逐源/心跳文字 + 可选百分比），
  请求发出即有反馈，终结（成败皆然）随 `run` 的 `onDone` 清除。
- **门禁**：`test/kernel-update-single-writer-test.js` 扩 **SW-9**（进度被回调、上界取自 `d.maxWaitMs`、
  代码行里不得再出现 `6 * 60 * 1000`、AboutCard 真的渲染 status），
  并配两个反向夹具：旧桥整段（两判据皆红）与「补了回调但超时仍写死」（只红超时判据）。
  契约与壳侧接线见壳仓 `docs/DESIGN-SHELL-ARCHITECTURE.md` §3.2c（K6/K7）。

### 反代账号生命周期引擎 W1：期望集纠偏 + 事件表落地 + 旧锁拆迁（PROXY-LIFECYCLE-STANDARD）

- **根因**：进程起停时机散落在额度阈值（80% 备胎）、闲置宽限（markUsed/lastUsedAt）、
  假配置面（proxyInstanceLimits 无任何注入方）三套旧语义里，坏账号退场后进程与端口仍
  滞留（等待区不是零存在），且 DEAD 态与 pid 字段互相矛盾（probe 子进程 error 只清 pid
  不改 status）。标准见 PROXY-LIFECYCLE-STANDARD.md（已入 README/standards 登记）。
- **锁的旧形状 -> 新不变量**（拆迁逐项，判据同批落地）：
  - `R1 常驻1+（>=80% 才补）备胎` -> **期望集恒为 在用1+预热1**，按 registeredAt 登记序
    （裁决 2）；pool.js 纯决策（ACTIVE_SLOTS/PREWARM_SLOTS 引擎常量），restart.js 消费执行。
  - `R2 selected/额度择优归属` -> **selected 提为在用、预热槽 sticky 留任**（裁决 4），
    退位者走停止仲裁回收、下一拍端口归零。
  - `R4 冻结后等周期对账` -> **状态事件表**：freeze.setStatus 回调 `_onStatusTransition`，
    frozen/banned/discarded 同一轮 `reclaimAccount`（force kill + ports.unregister + port=null），
    恢复回 ready 立即 `reconcileNow`（LC 核心-5）。
  - `markUsed/lastUsedAt/IDLE_RECLAIM_GRACE 闲置宽限` -> **删除**（宽限期不存在，回收零延迟）；
    请求路径改引擎门面 `ensureServable`（forward/admin 均不再裸编排 startInstance/_waitHealthy），
    成功计数归 `markRequestOk`（R-a 熔断不变量迁移到 mixin 判据）。
  - `prewarmAsync/needSpare/_switchBudgetMs/DEFAULT_MAX_HOT·WARM/proxyInstanceLimits/
    createPoolPolicy/residentAccount/stopInstanceIfAny` -> **全部删除**，零消费方；
    PG-4 判据从「maxHot/maxWarm 存在且被引用」反转为「假配置面零残留 + 门面 + 事件表」。
  - `E6 DEAD 矛盾` -> probe 子进程 error 置 `pid=null + status=COLD`（COLD 可再拉起），
    reconcile 对 DEAD 残留态收敛。`E11 孤儿记录` -> discard 钩子剪枝 instances + reconcile
    对残余孤儿补剪。
- **测试拆迁**：reconcile-instance-test R1–R4/R9 按新契约重写（registeredAt 显式化、
  sticky/端口归零/事件表同步回收断言）；circuit-breaker R-a 改锁「markUsed/lastUsedAt 零残留」；
  PG-1 契约表 markUsed -> ensureServable/reclaimAccount。本机静态门禁全绿；
  运行时契约由 CI 矩阵裁决（本机严禁跑测试套件）。

### 壳看护的无头模式清单收为单一事实源（跨仓契约 D-9，配 B3b）

- **根因**：守卫靠 `isShellProcess(cmdline)` 区分「真壳」与「壳自己跑的无头进程」，排除表是一条
  手写正则。壳侧每加一个无头入口（`--platform-matrix` 此前已漏；2026-09-21 看护 Rust 化新增
  `--watchdog`；`--run-guard` 从未登记）都可能让一个瞬时进程被当成「壳在运行」——
  `decide()` 里 `alive > 0` 直接短路，真壳**永不**被拉起；`restartShell` 共用同一谓词，漏项还会
  让它把运维进程当壳 SIGKILL（同一缺陷此前已因内联弱过滤修过一次）。
- **修法**：排除表提为 `domains/shell/core.js` 的 `HEADLESS_FLAGS`（冻结清单 + 由它生成正则），
  与壳侧 `main.rs`「Tauri 初始化之前 exit」的分支一一对应；契约写进 `KERNEL-DAEMON-CONTRACT.md` D-9。
  纯核心纪律不变（清单仍是零出度的无 IO 事实）。
- **验证**：`test/shell-watchdog-test.js` 新增 W2-f/g/h（三个漏项各自被排除）、W2-i（清单可枚举
  且逐项生效）、W2-j 反空转（未登记的同名 flag 仍判为壳 ⇒ 证明 false 来自排除表而非名字没匹配）。

### 反代进程隔离标准化：平台事实上收 + 受管进程载体 + CP-5..9 牙齿（PROXY-ISOLATION-STANDARD）

- **根因**：反代链绕过平台层、域内自带 POSIX 假设——裸 `process.kill(-pid)`（win32 只杀 .cmd 壳，
  占端口子孙存活成孤儿）、`sameProcessGroup` 读 `/proc`（macOS 恒 false，自家进程误判外部占用）、
  直 spawn `npx.cmd`（CVE-2024-27980 必 EINVAL）、硬编码 `~/.npm/_npx`（win 缓存实为
  `%LOCALAPPDATA%\npm-cache\_npx`）。同类缺陷本仓已在别处修过三次，这次立标准断根。
- **L0 平台事实上收**（`platform/os/npx-forms.js`，新；自 exec-path 分文件，使其不越 DG-2 ≤300 线）：
  新增 `npxLauncher`（node-direct `npx-cli.js` 成对形态，探不到回退 PATH）与 `npxCacheDir`
  （三平台正确缓存根）；`pidlookup` 补 `isZombie`
  （win 恒 false / linux /proc / darwin ps），域内自读 `/proc` 的 waitAllStopped 改经门面；
  macOS 恒 false 的 `sameProcessGroup` 随消费面清零**删除**（死代码不留）。
- **L1 受管进程载体**（`platform/os/carrier.js`，新）：池式消费者拉起外部进程唯一通道——
  `start`（detached+管道+run.pid）、`probe`（三态 ours/foreign/dead，归属判定复用
  portable#findOurs 锚点引擎，全仓唯一一份）、`signalTermination`（SIGTERM+1.5s 台账升 SIGKILL）、
  `stop`（确认式有界停止）。`portable.js` 导出 findOurs/matchesAnchors 供载体共用。
- **router 反代链切换消费**：probe.js 拉起改走 carrier（identity={port,pidFile,anchors:[pkg,'--port N']}），
  监控占用误判改 `probe().state==='foreign'`，幸存者回收/挂死强杀/全停等待改 `os/process#killTree`；
  instance-lifecycle 裸 `kill(-pid)` 改 `carrier.signalTermination`；command.js npx 回退形
  `[l.program,...l.args,...]` 成对形态；pkg-cache 收敛缓存扫描为 `invalidatePkgCache` 单一实现
  （apps-registry 第二份删除），密钥仍只经 env（PG-6 不变）。
- **机器牙齿**：CP-5..CP-8（域内零裸 process.kill、零 /proc 字面、负 pid 只在 os/process、
  零 .cmd/_npx 字面，各带反向合成）+ CP-9（门禁真读标准正文，锁三层职责与条款编号防漂移）；
  CI 契约冒烟 P3-a..f 并入 `cross-platform-test.js`（假供应商真 spawn/探活/锚点归属/foreign
  不误杀/终止端口释放/确认停止，四平台矩阵裁决）；D-6 监控判据断言同步改 carrier 形状。
- **标准成文**：`PROXY-ISOLATION-STANDARD.md` 入册（L0/L1/L2 职责 + 禁项表 + 新增供应商纯 L2
  验收单），standards-uniqueness 登记（reads:true 经 CP-9 属实），README 索引与矩阵 C4 行同步。
- 验证：node --check 全绿；静态门禁（cross-platform-architecture 23/23、no-console-window 12/12、
  provider-gateway 35/35、layering 13/13）；运行时行为（P3 真进程冒烟、D-6）由 CI 四平台裁决。

### 账号账本读写收口：usage-totals 单一实现 + 只读实例鲜度纪律（PG-12）

- **缺陷（行为变更，内嵌只读模式）**：`UsageLedger.load()` 一次读盘后永久缓存；守卫/内嵌实例
  无写权、从不记账，其 `status` 总量摘要因此冻结在进程启动时的旧快照，而同屏 `listProviders`
  账号行走 `store.readUsage()` 新鲜读盘——两面板两个鲜度源。`views.status` 里
  「loadTotals 确保用量缓存就绪」的注释与代码不符（返回值被丢弃，且并不填账本缓存）。
- **读源统一**：`load()` 缓存命中改为以 `canPersist()` 为条件——写者内存为准（节流窗口内
  盘落后于内存，重读丢在途账），只读实例每次新鲜读盘；views 两个用量消费面（status 摘要、
  listProviders byKey）收敛到 `deps.getUsage()` 单一入口。
- **第二读写口删除**：`RouterStore.readUsage/writeUsage`（writeUsage 全仓零消费）与
  `usageFile` 字段整体删除，router-usage-totals.json 自此只由 `store/usage.js` 持有；
  store.js 头注释同步为现状。
- **防回潮**：provider-gateway 门禁新增 PG-12（router 域除 store/usage.js 外出现第二 usage
  读写口即红 + 只读不得吃永久缓存 + 2 条反向自检）；SSOT §3.3 由「现状缺陷」改写为落地时点，
  §6.2 补 PG-12 行，§7 Phase 5 与 README PG 范围同步。
- 验证：node --check 全绿；静态门禁（provider-gateway 35/35、domain-structure 88 过/0 硬红、
  probe-gate 36/36、circuit-breaker 58/58、round13-robustness 26/26、docs-reference 14/14）；
  运行时行为（status/listProviders 鲜度）由 CI 裁决。

### 判据统一改动专项清理：文档与注释中的假现状对齐（不含行为变更）

- **注释残留**：base.js「process-pool 子类」措辞改「能力方（mixin ctor 装配钩子）」；
  `usageOf` 基座 docstring 不再自称派生 warming（该派生已归 mixin 覆写）。
  contract.js `exempt` 登记面收敛：基座只剩 detectAccount 一个抽象占位，proxy.js 的
  「DG-5c 继承 SCC」条目随 DG-4 归零作废删除。
- **测试面搬移补漏**：`router-circuit-breaker-test` 的 R-a/R-b/R-c/R-d 源码判据原读
  proxy.js，池方法已迁 mixin 后会静默假红/假绿——改读 process-pool.js（含 4 空格缩进的
  函数体闭合判据与沙箱求值取尾）；`probe-gate-and-ownership-test` 删除搬移后遗留的
  base.js 死读取。
- **SSOT 文档假现状对齐**：PROVIDER-GATEWAY-ARCHITECTURE §2.2/§5.1/§5.2/§5.3 的
  「现状」列改为带 2026-09-21 复算时点的落地状态（预热已按 §4.4 恢复、ctl 白名单已落地、
  direct 显式 unsupported）；§6.2 门禁表补 PG-9/PG-11；§7 从「Phase 0 ← 当前」改为逐
  Phase 标注落地状态，并如实登记 **RouterService 标识符改名未执行**。
  DOMAIN-STRUCTURE-DESIGN §10 合法继承豁免条目重写（原描述引用已删除的 11 个抛错占位
  与硬编码行号）；provider-gateway 门禁头不再笼统宣称「Phase 1-5 全部落地」。README
  规范索引 PG 范围更新。
- 验证：node --check 全绿；静态门禁复跑（domain-structure DG-4=0、provider-gateway
  31/31、circuit-breaker 58/58、probe-gate 36/36、round13 53/53）。

### 实例沙箱 W4 呈现定版：前端类型补齐 + 行展示配额/占用 + 档位如实标注（ARCHITECTURE-PLAN-instance-sandbox-governor）

- **前端类型滞后补齐**（tsc 不会报这类缺口，故必须机器把尺）：`types.ts` 的 `InstanceState` 增
  `usage?: { memMb, cpuPct, at } | null`（后端 viewRow 自 W2 已产出）、新增 `SandboxBudget` 接口并挂到
  `EnvStatus.sandboxBudget`（后端 `/env/status` 自 W2 已产出）。声明缺失的后果不是编译失败而是**静默少显示**。
- **列表行呈现**：底栏改「配额 内存 X · CPU Y（软限）+ 占用 ZMB · CPU W%」；占用只在真有采样时显示
  （停止/未采到不渲染，**绝不以零充数**），tooltip 说明配额来源与执行档位。
- **档位语义落到呈现**：能力门仍只在 `sandboxLaunch=false` 时前置提示（W3 后仅未知平台命中），
  另按 `sandboxEnforcement` 分档标注——`cgroup` 内核硬限 / `supervise` 采样式软限（守卫按超标拍数
  收割重启）/ `none` 无内核级限额；能力尚未回读（`caps===null`）时**一句档位话都不说**，
  防「未确认即断言硬限」。添加表单同步显示当前档位（填额框自 W1 已删，此处只补语义交代）。
- **验收标准第 2 条口径修正**：原写「`systemctl show` 断言」，实改为**执行器边界 argv 实录**
  （新增 X-3d：注入假 exec，逐字校验 `--user set-property --runtime <unit> MemoryMax= MemoryHigh=
  CPUQuota=` + 有界超时 + 空 alloc/非法名 fail-closed）。理由：在 CI runner 上真改宿主 systemd
  属性留副作用，且 transient 单元不存在时命令本身就得起不来——argv 是这条链**在平台层的**唯一真产物
  （systemd 收到属性后是否真限流属其自身语义，不在本仓断言面内，故 §六 条 2 标「内核侧生效待 CI」）。
- 门禁/文档同步：`cross-platform-test` 新增 A1-g/A1-g2（前端类型与页面同源消费 usage/SandboxBudget/
  软限标注，反向判据防「软限伪装成硬限」）；`PLATFORM-CAPABILITY-MATRIX.md` 新增「实例舱档位小节」
  （launch/enforcement × 五档运行环境 + 宽严分离与认领语义 + 已裁决不做项），矩阵头计数 14→15；
  README 索引两行状态随动（能力矩阵描述、计划状态改「已落地待 CI 验收」）；计划 §六 改题为
  「验收标准与达成口径」并逐条标注证据面，**依赖真机行为的条目（1/2/4/5）一律不预勾**；
  §五 两条「一期不做 / 一期不留」改为**定案**（重开条件写成证据，不写成期次）。
- 验证：本机 `node --check` 与静态门禁（comment-pin/domain-structure/test-safety/test-chain/
  docs-reference/cross-platform-architecture/layering/exec-bounded）全绿；UI 类型改动**未本机 typecheck**
  （`ui/node_modules` 不存在，安装依赖属重操作且占资源），由 CI 的 `cd ui && npm run verify`
  （typecheck + lint + test + build）裁决；A1-g/A1-g2/X-3d 的行为面判定同样交 CI。

### 实例沙箱 W3 执行面：portable provider + 实测分档 dispatch + 运行期动态限额（ARCHITECTURE-PLAN-instance-sandbox-governor）

- **三平台实例舱拉平**：新增 `platform/os/portable.js`（179 行）——无服务管理器依赖的执行 provider，
  动词与 systemd 档同形（11 键方法集，X-3 以 `_testProviders` 静态对账强制两档一致）。实例身份采用
  无状态认领：端口反查 + cmdline 锚点（`--port` / 可执行入口）复核，`run.pid` 仅在「已拉起未监听」
  窗口作停止兜底，PID 复用由 cmdline 锚点判死；停止走宽严分离——`isUnitActive` 查询降级宽松
  （无锚点时仅凭端口，查询失败返回三态 `null` 而非谎报不活跃），`stopUnit` 杀进程必须锚点命中，
  未确认不杀返 `false`；端口回退路径命中 `ownGroup=false`，不把他进程组当本实例。
  `setLimits` 恒 `false` 是档位声明而非缺陷（supervise 软档无内核强制）。
- **运行期限额动态化**：systemd 档新增 `setLimits` = `systemctl --user set-property --runtime`
  下发 MemoryMax/MemoryHigh/CPUQuota（`--runtime` 防 drop-in 黏住陈旧下限）；`_governTick` 在配额
  跨死区变更且 `phase==='RUNNING'` 时当拍下发，不再「下次启动生效」。portable 档违规处置与启停
  经同一 provider 形状收敛，`start`/`stop`/违规收割三处 ctx（port/timeoutMs/anchors）同源。
- **dispatch 实测不写死**：`service.current()` 分档为数据驱动——linux 探测 `systemd-run` 可达即
  systemd 硬档、不可达（容器/WSL1）落 portable 软档；darwin/win32 portable；未知平台 NONE 显式抛错。
  能力声明随动：`sandboxLaunch` 三平台翻正 `true`，`sandboxEnforcement` darwin/win32 = `supervise`
  （未知平台仍 false/none，无任何虚报）。域层零 `process.platform` 分支，分档全部收在 provider 侧。
- **残留收口**：`_prepareSystemd` 增 `supportsUnits` 闸（mac/win 不再 mkdir systemd 结构）；
  门面 `launchCtx` 入 contract PUBLIC_API（DG-10），`dshBin` 补登记（消费面自 67072da 起存在）。
- 门禁/测试同步：判定性测试并入既有文件、**未新增链条目**——`platform-layer-portability-test`
  重写 X-3（dispatch 不变式 `kind === (hasSystemdRun ? 'systemd' : 'portable')` + `_testProviders`
  方法集对账），新增 X-3b（require.cache 注入假 pidlookup、空闲 PID 探测防真实信号，23 项语义断言）、
  X-3c（真实宿主拉起→监听→认领→停止闭环，每平台 runner 各跑一次）；`exec-return-contract` A4b/A5
  扩 setLimits 与分档不变式；`instance-state-test` 7A 扩 stop ctx、新增 7E（启动 ctx 同源、
  动态下发、不变不重复下发、supportsUnits 闸）；`capability-profile`、`four-platform-behavior-matrix`
  P-5、`platform-capability-audit` A2/A3、`cross-platform` 判据随 W3 事实翻转。
  行为裁决以 CI 三平台矩阵为准；本机仅静态门禁与 `node --check`。

### 实例沙箱 W2 控制面：governor 完整决策策略 + 资源采样 + 监督拍接线（ARCHITECTURE-PLAN-instance-sandbox-governor）

- **决策策略落地**（`governor.js#decide()` 纯函数，45 行预算推导扩为 206 行完整策略）：
  两级配额——预留份额 = 机器预算(物理×0.7) / 活跃实例数（等权，无优先级档），突发池 = 物理内存减预算
  的余量；占用达预留的 0.9 倍才按 `since`（启动时刻）先到先得领用突发，追加封顶 1 倍预留，
  内存软顶 `MemoryHigh = 0.9×MemoryMax` 随 `unitProps` 落单元属性（CPU 可抢占、不设突发）。
  目标值调整带迟滞：10% 死区内维持上轮值不动，跨死区单步最多增减 25%，防配额震荡。
- **违规处置链**：内存连续 3 拍 / CPU 连续 5 拍超限判违规——先记事件 `inst_resource_violation`
  （带实际值/目标值），再 `stopUnit` 收割，最后走既有状态机 `restart` 进 BACKOFF 自愈；
  超限到重试上限仍归 FAILED（与崩溃链共用，不因放宽预算而静默清零）。采样缺失（探测失败、
  进程未起）一律重置违规计数——**无证据不判违规**；每拍只处置本实例，他实例由其自身拍负责。
- **准入闸**：`lifecycle.start()` 在任务占用检查后复算预算——若「现有活跃数 + 本实例」的等权份额
  已低于 512M 保底，直接拒绝并给出「预算已满：K 实例已预留 X/YMB，停一个或等待释放」；
  升级链（fromUpgrade）按既定裁决旁路（与任务闸同理）。BACKOFF 重试被拒不静默：
  自然走 restart 计数直至重试超限 FAILED，故障原因可见。
- **观测面新增** `platform/os/resstats.js`：进程树 rss / cpu-time 异步采样
  （linux 直读 /proc、darwin `ps` 表、win32 `Get-CimInstance` JSON；解析器为纯函数、文本夹具可测），
  单次采样 2s 有界且必须走 `exec.runOutAsync`（同步 execFileSync 会冻结监督拍整个 tick）；
  cpuPct 为两拍间 delta（单核=100），采样失败保留上轮缓存、绝不当零。
- **接线与展示**：supervise 的 RUNNING 分支同拍完成「观测→决策→下发/处置→展示值」——
  配额变更写回 `state.allocation`（当前口径：展示值 + 下次启动生效；运行期 set-property 动态化属 W3，
  该口径已被下方 W3 段取代），
  实时占用写 `state.usage`（`viewRow` 透出）；`stop()` 清 usage 与运行期缓存。
  新增门面 `InstanceManager.budgetSnapshot()`，`/env/status` 加 `sandboxBudget` 预算总览
  （预算/已预留/可容纳实例数/CPU 份额）。
- 门禁/测试同步：`governor-test` 增 G4 decide 矩阵（突发领用/池耗尽/上限封顶/迟滞步进/死区/
  违规计数与重置/内存优先于 CPU）、G5 准入门限、G6 快照形态；resstats 解析夹具并入
  `platform-parsers-and-commands-test`（Y-6 段）；违规处置链、突发展示、准入拒绝、采样空缺
  永不处置四组行为测试并入 `instance-state-test`（第 7 段，端口段扩至 25）。
  按 test-chain N-e 纪律全部并入既有宿主文件、**未新增链条目**（scripts.test 总长保持 Windows
  cmd 8191 上限之内）。

### 实例沙箱 W1 地基纠偏：能力字段拆分 + 动态限额 + win32 布局（ARCHITECTURE-PLAN-instance-sandbox-governor）

- **能力单字段混装修正**：`multiInstance` 废止，拆为 `sandboxLaunch: boolean`（能否运行实例舱）与
  `sandboxEnforcement: 'cgroup'|'supervise'|'none'`（限额由谁执行）两字段——合并声明会掩盖
  「mac/win 可跑舱、仅缺内核强制」的真实形状（C11–C14 拆行教训）。W1 期间三平台取值不变形：
  linux=launch/cgroup，darwin/win32/未知=false/none，无任何虚报。`sandbox.supported()`、
  `/env/status`、面板能力门、不支持文案全部改问新字段。
- **用户填额链废止**：`/instances/add`/`update` 不再接收 `memoryMax/cpuQuota`（传入即无副作用忽略，
  盘上历史残留由 normalize 剔除）。限额定义权收归新增 `domains/instance/governor.js` 纯函数：
  `机器预算(×HEADROOM 0.7) ÷ 活跃实例数` 等权推导，内存下限 512M、CPU 下限 100%，每次启动重算并
  记入 `state.allocation`（视图行透出）。Linux 行为不回退：值仍经 `sandbox.unitProps` 落成
  MemoryMax/CPUQuota 单元属性。
- **win32 npm `-g --prefix` 布局修正**：依赖落点原硬编码 POSIX 形 `<install>/lib/node_modules`，
  win32 实为 `<install>/node_modules`——新增 `sandbox.nodeModulesDir/dshEntry` 按平台分派，
  启动命令、入口存在性检查、版本探测与测试夹具统一改走该推导（入口仍 node 直启 `lib/bin.js`，不经 `.cmd` 垫片）。
- **隔离维度补齐**：沙箱实例独立 `TMPDIR=<根>/tmp`（win32 另设 `TMP/TEMP`；Linux 保留 PrivateTmp 双保险）；
  实例根目录经 `fileProtect.ensurePrivateDir` 收紧（0700 / icacls），ensureDirs 一次到位。
- 门禁/测试同步：`platform-capability-audit`（A1 枚举档位、A2 sandboxLaunch 实现产物含 governor、A3 显式 false+none）、
  `four-platform-behavior-matrix`（14 键规范清单 + enforcement 档位穷举）、`capability-profile`、`cross-platform`、
  `exec-return-contract` 判据改新字段；新增 `test/governor-test.js`（activeCount 拓扑 / allocation 平摊·下限·单调性 /
  currentAllocation 形态）并入全量链。

### 智能路由一键登录：浏览器选择权归还系统默认浏览器

- **错误设计**：Command Code 一键登录的隔离打开不走系统默认浏览器，而是由产品指定浏览器内核 ——
  darwin 硬编码 `open -na 'Google Chrome'`（默认浏览器是别的就被强拉 Chrome；没装 Chrome 直接打不开）、
  win32 用 `findChromeWin` 在 Program Files 三根目录探测 `chrome.exe`、linux 按
  `microsoft-edge→google-chrome→chromium…` 候选链择一。且 darwin 分支 spawn 的是 `open`，
  它拉起浏览器后立即退出 —— 「关闭浏览器即取消登录」的 onExit 在 macOS 上语义本就是坏的。
- **修法（能力零删减，方向反转）**：`platform/os/browser.js` 新增 `resolveDefaultBrowser`
  （win32 注册表 `Clients\StartMenuInternet`→`shell\open\command`；darwin LaunchServices bundle id→
  app 内真实可执行文件；linux `xdg-settings`+`.desktop` 主条目 `Exec` 行还原，env 包装去壳、
  URL 字段码剔除），再按解析结果的**引擎族**（`engineOf`）展开隔离参数：chromium 系
  `--incognito --user-data-dir=<随机 profile>`、firefox 系 `--no-remote --profile <tmp> -private-window`，
  TZ/LANG/窗口尺寸随机化保留在策略层（`router/ops/browser.js` 改为传意图，不再自带 chromium 方言）。
  Safari/包装器等无隔离能力的引擎如实 `isolated:false` 走 `open/xdg-open/explorer.exe` 非隔离打开，
  由 180s 登录超时与「重新发起即取消」兜底。
- **Safari 缺口的边界（实测 commandcode.ai 后认定可接受）**：auth 端点仅认 `callback/state`，
  无 `select_account` 类参数；但已登录会话也必须显式点 Authorize，不存在静默复用旧账号签发。
  非隔离引擎的真实损失仅「再添加其他账号需先在网页退出或用无痕」。
- **onExit 由修复而非牺牲**：chromium 独立 profile / firefox `--no-remote` 均为新实例进程，
  直启后可监听退出；三端语义一致（原 darwin 分支为假）。
- 门禁同步：`platform-layer-portability-test` X-8/X-9 改为注入 `defaultBrowser` 解析结果
  （夹具与产品同源原则不变），新增「平台层源码不再指定任何浏览器内核」反向判据；
  `PLATFORM-CAPABILITY-MATRIX.md` C8 行按新实现改写。

### 发布通道根因修复：`latest` 跟随每次发布（含 BETA 线）+ 无依据口径清障

- 把两条**没有依据的规则**从口径里清除并写成明文（`RELEASE-STANDARD.md` §7 第 7 条、
  `RELEASE-CHANNEL-CONTRACT.md` §2「检测不到新版本」的排查顺序）：
  其一，「npm 同版本不可重发 → 保住版本号原地重发」—— 仓库里从来没有这条规则，各文档一直写的是
  「提版本重来」；现补为红线：版本号一律相对 registry 上**已存在**的版本向前推，保号会让新代码在
  客户端被判成「已装过」（客户端只看版本号），且 npm 端本就 409，保号得不到任何好处。
  其二，「检测/更新内核的令牌不对」—— 读路径**全程匿名**（壳 `core.rs::latest_pick`、内核
  `install.js::fetchNpmLatest` 只做 GET，无 `Authorization`），链上唯一凭据是 CI 发布步的 `NPM_TOKEN`；
  把「拉不到最新版」归因于换令牌会掩盖真实成因（`latest` tag 陈旧，即本节下一条 RC-6）。
  2026-09-21 逐源实测：四个平台包在五源均为 `latest = beta = 0.1.5-BETA.11`，`dist.tarball` 可取回。
- 发布通道根因修复：**`latest` 不再只由「发布的是 RC」驱动**（`RELEASE-CHANNEL-CONTRACT.md` §2/RC-6、
  `release/scripts/publish-core.sh::reconcile_latest_tag`、门禁 `test/release-channel-gate-test.js` RC-G4-i..o）。
  旧口径下 BETA 档 `npm publish --tag beta` 之后再没人写 `latest`，而客户端选版链第 3 步只读 `latest`、
  第 4 步兜底又排除 `-BETA.` —— 两条相加的后果是「切档之后的全部版本对自动升级的机器不可达」
  （registry 实况：`latest=0.1.5-BETA.7 / beta=0.1.5-BETA.11`，即 BETA.8..11 那批安全修复没人拉得到）。
  现两档发布后都按 `semverCompare` **只升不降**地回补 `latest`，幂等跳过分支同样执行（部分平台重跑是最常见的
  漏补场景），回补失败判为发布失败。四平台 `latest` 已按新口径人工对齐到 `0.1.5-BETA.11`。
- Linux 支持面与壳更新通道的实测口径（与壳仓同批）：**Linux 只认 Ubuntu + `.deb` 一种形态** ——
  矩阵此前 `deb,rpm` 一起产，而更新清单每平台只有一个槽位（放 deb），等于产出一个更新通道覆盖不到的形态；
  现从产线源头停掉，`CROSS-PLATFORM-BUILD-AND-UPDATE.md` §十 V1/N2b 与 `RELEASE-AND-UPDATE-MECHANISM.md`
  的 D4/N2 按「不再产 rpm」收口（是定案，不是待议）。
- `D5` / `V5` / `K13` 三条把「拿得到清单」与「拿得到安装包」分开重述：`endpoints` 的回退只覆盖取清单那一次
  请求，插件下载阶段不会自己换源，所以「unpkg + jsdelivr 两条端点」从来不等于「两条下载源」
  （jsdelivr 按扩展名屏蔽 `.exe`）。壳侧现在按逐源实测的候选源换源取安装包，未审计的第三方中转不进默认表；
  逐源状态与全部排除理由在壳仓 `docs/SHELL-UPDATE-CHANNEL-VERIFICATION.md` §九。

- 文档风险表的「缓解」列去假象（`AUDIT-REPORT-2026-09-19.md` §O）：`RELEASE-AND-UPDATE-MECHANISM.md`
  的 K1 / K13 原把**设想**写成**已具备**（私钥异地多份托管与恢复演练、多 CDN 回退 + 内核本地缓存），
  三者实际都不存在。1.2.0 出厂后的端点复测给出硬证据：jsdelivr 对 `.exe` 一律 403（`1.1.11` 同样复现）
  ⇒ Windows 只有 unpkg 单条 CDN；`CHANGELOG` 与 `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §十 V5 登记该缺口。
  本条只改表述，不动 `endpoints`；该缺口由同批壳侧改动按实测候选源收口（见本节上一条）。

## [0.1.5-BETA.11]（2026-09-21）

本版是 **AUDIT-2026-09-19 第 3/4/5 批全量落地**：B 类安全与生命周期（§G）、C 类健壮性 P2 全量 +
§E.1/E.2/E.4 立项收口（§H）、注释纪律门禁与 `--prefix` 闸对称性 + 插件域 killTree 收口 + `cred.sh`
行为级测试（§I），逐条裁决登记于 `AUDIT-REPORT-2026-09-19.md`。同批含第 3 轮起的文档与产线残留纠正
（3b…3g：把「做不到 / 没在做」写成「已具备」的假现状、结构判定假象、单平台构建旁路、一次性证据当现状）、
注释纪律（CS-1 字符白名单 / CS-2 过程叙事禁用）与两仓主干的分支保护落成。内核运行时依赖仍为 0。

发布通道与回退下限（本版两处显式裁决）：

- 通道：`0.1.5-BETA.11` 按 `publish-core.sh` 的 dist-tag 规范只进 `beta`。`latest` 仍停在
  `0.1.5-BETA.7` —— 这是历史错位而非本版引入，修它要发 `-RC.n`（正式版占 latest），属独立发布决策。
- 下限：`ROLLBACK_FLOOR_VERSION` **保持 `0.1.5-BETA.10`**，不按「每次上调到本版」的读法抬到本版。
  理由：下限是本版之下仍允许回退到的最低安全版，抬到本版的净效果是回退开关对本版永久无效
  （没有任何已发布版本满足 `>= 本版`），而 RC-7 要留的是「刚发布即出严重问题退回上一版」这条真实通道。
  BETA.10 已含第 1/2 批 P0 修复，作为回退目标不再暴露那些漏洞；更早版本仍被下限挡住。
- 工具链：`bump.sh --core` 现在同时提升 `package-lock.json` 的两处 `version`。此前它只改
  `package.json`，而门禁 P-9 B26 要求两者同步 —— 即每次发版都要手工补一刀，漏掉就在 CI 判红。
- 发布链（本版发布过程中由 CI 抓到）：`publish-core.sh` 的幂等判定原以「`npm view --json` 输出非空」
  当作「该版本已发布」，而 `--json` 对**不存在**的版本同样把 E404 错误对象写到 stdout（退出码非零）。
  后果是首次发布被判成重复、并在内容强核对处 fail-closed（四平台同红）。存在性改由**退出码**定性，
  B24 的体积 + sha1 双项核对语义不变；补 P-9 B24 两条判据（正向锚在代码行、反向识别旧形态）。
  裁决登记 `AUDIT-REPORT-2026-09-19.md` §N。

### 第 3g 轮：三个长文件的注释按纪律重写（2026-09-21）

用户定案：行数不是判据，逻辑干净才是；而眼下撑长度的正是「把注释写成了过程记录」。本轮只动注释，
除下方一处显式声明的依赖清理外**代码逐字节不变**（用 `test/_strip.js` 的剥注释结果与改前比对，
三文件均 IDENTICAL-CODE）。

判据与逐文件结论（先判断逻辑该不该拆，再动注释）：

| 文件 | 行 | 注释行 | 逻辑判断 |
|---|---|---|---|
| `src/domains/router/handlers/forward.js` | 324 -> 317 | 31 -> 24 | 单一职责（上游 IO + 重试循环 + 透传收口），重试循环长但线性，不拆 |
| `src/app/control/registry.js` | 308 -> 287 | 83 -> 62 | 目录 CRUD + 持久化，调度已归 `heartbeat.js`，视图/查询/变更各一组，不拆 |
| `src/app/main/process.js` | 302 -> 297 | 44 -> 39 | 一个方法 = 一次生命周期迁移（spawn/adopt/observe/restart/stop），不拆 |

删掉的是三类，留下的都是「为什么」：

- 批次与审计编号：`D-1`、`P2-2 配套`、`P3-E #7`、`P3-F #5`、`B2 归一`、`G-1`、`R3`、`D12`、`K3-d`、
  `DF-2/DF-3`、`M-1..M-4`、`阶段六 B-2`、`阶段 2` —— 门禁（CS-2）本来也不认这些，属纪律外残留。
- 「原先是 X，现已改成 Y」的历史叙事：`forward.js` 里那处已删除的死调用整段、`registry.js` 的
  「回退现已删除」、`process.js` 的「原实现会让异常逃出本方法」，改写为只陈述当前约束与后果。
- 拆文件路线图：`registry.js` 两段「已拆到 managed-object.js / heartbeat.js（registry <=400）」——
  行数上限不是拆分理由，且导出面与 require 行本身就说明了归属。
- 重复表述：`process.js` 头注与 deps 内两次写「等价于原经 this 的调用」、令牌脱敏两次写「journald 不留
  明文」；`registry.js` 的崩溃字段单一副本与 guardian 归一各在两处（_load/_save、_load/update）重复。
  每处只保留一份。

同批的一处代码清理：`forward-core.js` 组装 `createForwarder` 时传了 `canPersist`，而 `handlers/forward.js`
从不读它（它属于 `UsageLedger` 的写权闸）。头注的 deps 清单一直把它列在本层依赖里，属错误引导 ——
删掉这个透传，清单同步更正。`PG-7`（用量落盘必须过 `canPersist()`）的判据读的是 `store/usage.js` 的
代码形态，不受影响。

### 第 3f 轮：签名链路的现状从「从未配过」纠正为「曾在产线、现被冻结」


壳仓取证（2026-09-21，逐条解码 npm 线上清单）推翻了本仓四处口径 —— 它们全部来自
「`lobbowen` 两仓 secrets 里没有 `TAURI_SIGNING_*`」+「壳仓 `/releases` 为 0 条」这两个真事实，
但推论越界成了「从未签过名」，而签名通道其实一直是 **npm + CDN**（`@dsh-sup/shell-release@latest`
现指 1.1.11，四平台各一份 minisign 签名；抽验 1.0.1…1.1.11 七个版本 key id 全是
`96DE3EF26F389F70` = 内置公钥）。按现状改写：

- `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §一 G3：原「自更新签名私钥至今未配置，所以可自更新只对非签名
  路径成立」→ 签名链路**曾产线工作、现断供**：迁仓后新仓无 secret、本机无副本，故签不出存量客户端
  会接受的新产物（壳冻结在 1.1.11）；内核自更新走 npm + registry 完整性，不经 minisign，不受牵制。
- 同文件 §八 C1（minisign 私钥丢失）：由「风险」改为**已成真**并给出证据链 —— 当年只做本机单点备份。
- 同文件 §九 F2：「密钥本身仍缺失」限定为「**新仓**没有该 secret」，并注明旧仓曾配置、≤1.1.11 签名在线。
- 同文件 §十 V1（Tauri 是否为 deb/rpm 生成 `.sig`）：原「两仓从未配过签名私钥，没有任何一份 `.sig` 可证」
  → **deb 已确证**（清单 `linux-x86_64` 条目的 URL 与签名 trusted comment 都是 `…_1.1.11_amd64.deb`）；
  顺带登记一个真缺口：清单每平台只有一个槽位、Linux 放 deb，**rpm 装的客户端在现清单下拿到的更新包是 deb**，
  待壳侧定案。
- `CREDENTIALS-STANDARD.md` §表：`（壳自更新签名）` 行的状态由「缺失」改为「**现仓**缺失 + 唯一可能
  残存处 = 旧账号仓 secret（现 PAT 取之 403，无 admin）」，避免下一任把它当成「从来没有过这枚密钥」。

### 第 3e 轮：分支保护落成服务端事实（2026-09-21）

用户定案「分支保护必须做」。此前状态是：2026-09-19 迁仓把旧账号的服务端配置留在原地，两仓主干
`GET .../protection` 均 404（内核 AUDIT §K-1 记为「待定案」），而多份文档仍把保护写成现行保证或写成
「待恢复的目标态」—— 两种读法都会跑偏。现已 `PUT` 写入并 `GET` 读回（`PAT` 具 `Administration: Read and write`）：

| 仓 · 主干 | required checks | 其余字段 |
|---|---|---|
| `dsh-supervisor-core @ master` | `precheck`、`test` + 4 条 `build (...)` | `strict` / `enforce_admins` / `required_conversation_resolution` 开，审批数 0，禁 force push 与删除分支 |
| `dsh-supervisor-launcher @ main` | `version` + 4 条 `build (...)` | 同上 |

两点与旧文档口径不同，按现状改写而不是照抄旧表：

- **内核把 4 条 `build` 也设为 required**。原表只设 `precheck` + `test`，理由是 `build` 当时受
  `need_build` 门控（条件 job 设 required → GitHub 等一个永不出现的状态 → PR 永久阻塞）。
  2026-09-14 起 `build` 每次 push / PR 都跑，该理由消失；「四平台全由 CI 产出」是硬标准，
  设为 required 才由服务端兜住。`release`（内核）/ `publish`（壳）在 PR 上 `skipped`，**永不设 required**。
- **审批数设 0**：放行裁决者是 CI，单人仓设 ≥1 会把「CI 绿后合入」变成死锁；保护的实际作用是
  关掉不经 PR 的直推（`DEVELOPMENT-TRACK.md` §7 保留 2026-09-13 的实测：直推路径也评估 required）。

登记维护规则：**改 `build.yml` 平台矩阵必须在同一次变更里同步 required contexts** —— 矩阵 job 显示名
内嵌 `os/arch/bundles` 参数，旧语境永不出现即所有 PR 卡死。据此纠正：`DEVELOPMENT-TRACK.md` §7（含
「恢复保护时要写入的字段」表改为读回值）、`RELEASE-STANDARD.md` §4、`CROSS-PLATFORM-BUILD-AND-UPDATE.md`
V3、`release/runbooks/publish-and-verify.md` §0（改为「服务器端配置不随仓迁移」的一般教训）、
`AUDIT-REPORT-2026-09-19.md` §K-1 加 dated 勘误（历史 404 证据保留）。壳仓对应纠正随壳 PR 走。

### 第 3d 轮：把「已完成」写成待办、把「已删除」写成风险面

三份文档里的现状陈述与当前代码对不上，读的人会按它们重复施工或防一个不存在的敌人：

- `DOMAIN-STRUCTURE-DESIGN.md` 仍以命令式写着三条「设计中发现，须修」缺陷（写权闸三处各查一半、
  用量读写散在 `forward-core.js`、流式成功路径不补做延后重启），并挂着改造前的行号锚点。
  三条**都已落地**：写权收敛为 `src/domains/router/store.js` 的唯一闸 `canPersist()`，
  用量读写进同一 store，延后重启由 `model/inflight.js` 发 `flushRestartPending` effect、
  `handlers/forward.js` 统一派发。改写为事实 + 按当前实现重取锚点，并修正
  `providers/base.js` 的抽象占位段区间。
- `INCIDENT-2026-09-13-credential-overwrite.md` §6 把 `release-core.sh --publish` 列为「尚未过同类审计」的
  破坏性操作 —— 该脚本**已删除**。改为现役真实面：只有 `publish-core.sh --publish` 不可逆
  （npm 同版本不可重发，须 `GITHUB_ACTIONS=true`），`bump.sh --core` 只改 `package.json` 一处；
  两者的放行条件由 `release-auth-test`（R7-b）与 `all-platforms-test`（T2-b / T2-b2）断言，
  写路径本身未过「读失败不得覆盖」加固 —— 这是残余风险的本来大小，不夸大也不缩小。
  同节 `cred.sh` 行原写「`put` 是唯一写路径」：漏了 `backup`，它不改库却把整份明文令牌复制到指定目录。
- `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §一 仍以现在时写着「当前公开发布的 deb 只能装 Ubuntu 24.04+」，
  §八 把 L1 的缓解写成待办。实测：壳 CI 的 Linux 基座自 2026-09-11 起已钉 `ubuntu-22.04` +
  `glibc_max: "2.35"`，打包后由壳仓 `ci/check-glibc.sh` 拦截，deb + rpm 双形态在产线
  （Linux arm64 runner 仍停用，未产线）；G1/G2 已收口，**G3 仍开** —— 自更新签名私钥至今未配置，
  「可自更新」只对非签名路径成立。§二 的发行版实测表标注为改造前的证据并保留（判据来源）。
- `README.md` 索引表：`HANDOFF.md` 一行链的是**不入库**的会话过程物（`.gitignore` 有 `**/HANDOFF.md`，
  故干净检出与 CI 都看不到该文件），而该行还写着「新会话接手先读此文件」——照着做会打开一个不存在的文件。
  删该行：本机交接物按 `.gitignore` 既定约定本就只在本地存在，不该出现在入库索引里当必读项。
  同表 `ARCHITECTURE-ACCEPTANCE.md` 行仍以现在时宣称「终验收记录 / 全部门禁严格模式结果 /
  物理结构终态最大单文件 298 / DF-1..DF-9 逐条达成」，四条全与 3b 修正后的该文件正文矛盾
  （实测最大单文件 324、`>300` 有 3 处、DF-2 不满足、两道结构门禁整体 report-only 且 CI 未设严格开关）。
  改为标注复算口径、且不承载放行结论。
- `release/runbooks/publish-and-verify.md`：`build-ui` 缺失的后果写成「直接跑 `npm test` 会得到 503」，
  在本机禁跑测试的硬标准下这是对不存在的动作下判据。改为「链上缺这一步 → **CI 的** `npm test` 得到 503」。
- 同表的 `RELEASE-CHANNEL-CONTRACT.md` 行抄着「RC-1..6」，而正文在 A3-b 修复后已有 **RC-7**
  （rollback 防降级下限）—— 索引抄编号必然再漂移，故改为指向正文 §3「关键不变量」表并声明不抄条数。
  （`DG-1..DG-16` / `R1..R12` / `TK-1..8` / 能力矩阵 14 项 × 3 平台等其余索引计数已逐条复核为实。）

另核三条无需改动的：`RELEASE-CHANNEL-CONTRACT.md` §5.4 说 `@dsh-sup/canary-allowlist` 尚未发布 ——
registry 实测 404，说法成立；`release/README.md` 与两份标准文档里所有 `docs/*.md` 引用都带「壳仓」限定词，
不是本仓断链；壳仓 `DESIGN-BOUNDARY.md` / `DESIGN-COMPLETE.md` 引用的 `shared/version-vectors.json`
与 `shell-release/version-vectors.json` 两仓实测均存在。

### 第 3c 轮：一条「已排除」测试的假理由，以及它其实没在任何人手里跑过

`test/native-test.js`（原生 DSH 卸载全量清理）长期挂在 `test/test-chain-completeness-test.js` 的排除表里，
理由写的是「**需真实原生卸载环境**（npmBin 注入型行为测试），按需经 `npm run test:native-uninstall`」。
两处都不成立：

- 夹具其实**离线** —— 它用临时 `npmRoot` 搭 npm 全局布局，不碰宿主环境；而且它没有注入 `npmBin`。
  同一提交 `ab071f5` 自己的注释就记着它「10 断言，能通过」，与它写下的排除理由互相打脸。
- 「按需运行」在这条硬标准下**没有落点**：CI 的四平台矩阵里没有这一步（`.github/workflows/build.yml` 全文
  不引用该脚本），本机又被 `ACCEPTANCE-STANDARD.md` §0 禁止执行任何测试 —— 所以它不是「按需可取证的通道」，
  而是**当前不在任何环境运行、不产生验收证据**的测试。真实障碍另有两条并已如实登记：
  `src/app/native/ops.js` 的 `uninstall()` 会真起 `npm uninstall -g --prefix` 子进程，
  夹具又用 `fs.symlinkSync` 造 bin 链接（Windows 建符号链接需特权或开发者模式，夹具未按平台分支）。

排除表改为「为什么不能入链 + 那现在是谁在跑它」两问齐备；`README.md` §验证、`package.json#_uninstallTests`、
`test/native-test.js` 头注同步改写，并写明入链前提（走 `npmBin` 注入口塞假 npm + bin 夹具按平台分支）。
本批只纠正说法，**不**把该脚本并入 `npm test` 链（入链需先做上述夹具改造，属独立批次）。

### 第 3b 轮：结构判定假象 + 单平台构建旁路 + 一次性证据当现状

- **结构门禁的「全部满足」是假的**：`ARCHITECTURE-ACCEPTANCE.md` §二 写「终态 257 文件 / 最大 300 行 /
  `>300` 的文件 0」、§三 写「DF-1..DF-9 全部满足」，只读复算实测 **260 文件、3 处越硬线**
  （`domains/router/handlers/forward.js` 324、`app/control/registry.js` 308、`app/main/process.js` 302），
  另有 DG-10 一处越权（`api/domains/instances.js` 取 `instances.dshBin`）。
  根因是这两道门禁**整体 report-only**（退出码恒 0，只有 `DG_STRICT=1` / `GATE_STRICT=1` 才转硬失败），
  而 CI 从未设过这两个变量 —— 「门禁存在且 CI 全绿」不等于「门禁在强制」。
  §二/§三 改为带复算日期的实测并写明该开关事实；`DOMAIN-STRUCTURE-DESIGN.md` §5.0 删掉
  「故下表全部满足硬门禁」，15 行漂移的实测值与超目标量一并重算。
- **单平台 launcher 构建是一条未被封堵的旁路（根因修复，不止改文档）**：`ACCEPTANCE-STANDARD.md` §4
  早已禁止本机跑 `build:launcher`，但 `build-launcher.sh` 只给 `--all-platforms` 分支加了
  `GITHUB_ACTIONS` 守卫，单平台形态随便跑；`release/README.md` 命令表把它写成「构建本机平台 launcher」、
  `publish-core.sh` 缺产物时提示「请先构建：npm run build:launcher」、`release.sh` 结尾也如此建议。
  现把守卫**上移到参数解析之前**、覆盖全部调用形态（新增门禁 T2-a4 以「守卫在 while 之前」这一结构事实钉住，
  并配反向合成样本），三处提示与命令表同步改为「仅 CI 内」。
  `README.md` 里仍以现在时态把 `npm run build:launcher` 当本机入口的三处（构建条目、平台生产分工条、
  单写入者节的发布条），以及 `RELEASE-STANDARD.md` §0 表格里只承诺「本地不得**全平台**构建」的那一行，
  一并改为「任何调用形态仅 CI 内」，并把门禁列指向 T2-a2 / T2-a4。
- **分支保护假象**：`bump.sh` 成功后打印「master 有分支保护」，`DEVELOPMENT-TRACK.md` §7 一边写
  「两个 required check 通过后合并」、一边留着一份「本次启用的完整设置」表。实测两仓 protection API
  均返回 404 Branch not protected。改为：该表题为「恢复保护时要写入的字段（当前一项都没生效）」，
  流程第 3 步降级为**纪律**并显式说明服务端不拦；「若要放开直推」表补上当前真实状态一行；
  `gh pr create` 不再当作唯一入口（作业环境无 gh/curl，改列 UI 与 REST 两条）。
- **一次性证据被当现行事实**：`RELEASE-AND-UPDATE-MECHANISM.md` 用 `dpkg -S /usr/bin/dsh-supervisor-gui`
  的现场输出论证 deb 形态，2026-09-20 在本机复跑是「没有找到相匹配的路径」（该路径且属旧单文件形态）。
  现标注为立规时的一次性快照，结论改挂在**产线事实**（壳仓 CI Linux 腿就打 `deb,rpm`）上；
  体积/耗时两条一并标明是当时估算。`INCIDENT-2026-09-18-exit-manager-relaunch.md` 状态行仍写「验收待 CI」
  且引用的内核 #20 / 壳 #23 属迁仓前旧账号仓，改为已随 0.1.5-BETA.9 发布（提交 `1107c34`）。
- **必然过期的数字不再抄**：门禁断言条数此前两份互相矛盾（`release/README.md` 41 / `DEVELOPMENT-TRACK.md` 61，
  而条数由运行时 `results.length` 统计、静态数不出），两处一并删除并注明以 CI 输出为准；
  `ARCHITECTURE-ACCEPTANCE.md` 三处测试链条数（127 / 125 / 129）退化为「不在此处维护」；
  两处 `bump.sh --core <版本号>` 示例值低于当前 `0.1.5-BETA.10`（照抄必被「拒绝回退」拦下）改为占位。
- **施工契约的失效锚点**：`EXECUTION-CONTRACT.md` 顶部加时效声明（它是那一轮的施工契约，不是现状说明书），
  §7 标为派工记录并注明其锚点已不可定位（`src/supervisor.js` 现 66 行、`APP_MODULES` 只剩
  `src/app/assembly/facets.js:15` 的一行注释提到它）、shell 门面行数由 35 更正为实测 24、
  D-6 的「DS-G3 仍只禁 defineProperties」交接其实早已落地（DS-G3b 实测 PASS），本机测试条数删除。
- **本批不含发布动作**：registry 仍 `0.1.5-BETA.10`，未打 tag、未 npm 发布。

### 文档纠正：以现在时态写着的假现状（第 3 轮残留清扫）

- **指引本机跑测试（引导性最强的一条）**：`PLATFORM-CAPABILITY-MATRIX.md` §七「如何运行审计」直接给出
  `node test/…js # 任意平台可跑`，`RELEASE-STANDARD.md` §3 把 `ci-core.sh`（内含 `npm test` 与构建）、
  `build:launcher`、`publish:core` 列为本机入口 —— 全部与 `ACCEPTANCE-STANDARD.md` §0/§4 正面对撞。
  现逐条改为「仅 CI 内」，只读项（`verify:versions`、`cred.sh doctor`）保留本机可跑；
  静态数不出的断言条数一并删除，不留会过期的数。
- **状态根前缀漂移**：`README.md`（安装 + 配置节）、`RELEASE-AND-UPDATE-MECHANISM.md` §6 隔离证明、
  `release/README.md`、`_npm-auth.sh` 与 `release.sh` 头注仍写 `~/.dsh/supervisor/…`，
  而该前缀在 `src/platform/service/state-root.js` 里已只剩 `legacySupervisorDir()`（仅供一次性迁移）。
  统一改为 `<产品状态根>/supervisor/…` 并注明单源；事故记录里的现场路径按当时形态保留。
- **README 的安装步骤是假的**：写着 `install` 会「写入 systemd unit、启用自启」并让人
  `systemctl --user start dsh-supervisor`，而 `bin/dsh-supervisor` 明写 install **不再**部署任何服务定义
  （所有者是桌面壳，D6）。改为 `dsh-supervisor daemon` + 三平台服务管理器由壳建立，架构框图同步。
- **已整体移除的机制仍被写成现行安全网**：`CROSS-PLATFORM-BUILD-AND-UPDATE.md` §七/§十一 的
  「`attempts>2` 判坏 -> `pinnedVersions` 拉黑 -> 用缓存重装 previous」与「内核预取 + 有界回退」
  （源码 `journal.js`：只有 pending->confirmed；`pinnedVersions` 在 `src/` 零引用），
  真实紧急回退是 `rollback` dist-tag + RC-2/RC-7；同文 §3.2 的「三平台」「命令行 export 签名私钥」
  「仅 tag 触发」三条同时错。
- **与自身产线矛盾的断言**：两仓 `check-glibc.sh`「内容当前一致」（`diff` 实测不同）；
  「不要用 `macos-14`」（本仓 darwin-x64 腿正在用它 + `DSH_ARCH_OVERRIDE`）；
  「唯一受 `need_build` 影响的是 `release` job」（`build.yml:249` 的发布步骤同受门控）；
  `ACCEPTANCE-STANDARD` 引用 build.yml「139-142 行」实指 precheck 版本探测段（改按位置引用）；
  `release/README` 的「唯一可执行集」漏 `cred.sh` 与 `export-consumers.sh`；
  S8 验证表未写执行位置（本机无 `gh`/`curl`、registry 不可达）。
- **`NO-CONSOLE-WINDOW-STANDARD` 的「当前实现位置」清单四条里两条文件已不存在**
  （`domains/dist/index.js`、`relay/frpmgr.js`、`guard/*`）：改为「立规时现场记录，
  当前缺口以门禁 K-W2 扫描为准」。§1 的 14/13 计数**不改**（13 = 14 减判据自身那处，与 K-W2 同口径）。
- **否决的假举报已登记**（`AUDIT-REPORT-2026-09-19.md` §M-6），含所称「workflow 用 `github-server-role`
  自引用会导致静默失去 CI」—— 全仓无该字面量，举报本身不成立。
- 取证与逐条裁决见 `AUDIT-REPORT-2026-09-19.md` §M。**本批不含发布动作**（registry 仍 0.1.5-BETA.10）。

### 凭据工具链根因修复：库 / 工具 / 门禁三方方言对齐（配套门禁此前恒绿）

- **缺陷（工具侧）**：规范库 `index.json` 用 `ref` 作键、`file` 为相对形态，而 `cred.sh` 按 `name`
  寻址并要求库内绝对路径 —— 结果 `path` / `get` / `verify` 对**每一个**真实条目都报「未知条目」，
  凭据库经自己的 CLI 完全不可用。同时 `doctor` 的权限枚举与 `backup` 的文件复制都只扫 `*.pat`，
  而真实推送凭据是无扩展名的 `git-credentials`：权限放宽查不出，**备份里根本不含推送凭据**。
  `verify` 又依赖本机不存在的 `curl`，把「无探测手段」洗成状态码 000，未知条目还零退出。
- **修复**：清单补齐 `name` / 绝对 `file` / `status` / `verify` / `schemaNote`（令牌值一字未动，
  改前副本 `/tmp/credentials-index.pre-sweep.json` 0600）；`doctor` 第 2 段改判「条目可寻址 +
  清单内文件是否都在库内」，权限面与备份改为枚举库内**全部常规文件**；`verify` 收口为单进程 node
  `fetch`（URL/期望码由清单给，未知条目与非预期码均非零退出，只回显身份/路径/状态码）。
- **门禁空转（本条最危险）**：真机审计 `R-4` 用 `l.indexOf('FAIL') === 0` 匹配，而 `doctor` 的 FAIL 行
  **带缩进** ⇒ 该断言永不失败，上面三处缺陷全在「凭据门禁全绿」下存活。判据改为先 trim 再匹配，
  并新增 D-14（无扩展名文件的权限面）/ D-15（条目必须可寻址）/ D-16（审计不按 `kind` 挑食）/
  D-17（`verify` 不用 curl 且未知条目非零退出），每条配旧形状反向夹具；
  D-10 的备份判据同时改为要求**无扩展名凭据**出现在副本内且内容一致（旧判据只盯 `*.pat`，
  正是那条「报成功却没拷走凭据」的缺陷能藏住的地方）。
  本轮真机实测：`doctor` rc=0 且逐个审计四个文件均 0600，`verify github-pat` 回 `OK (HTTP 200)`。
- **文档纠错（删掉以现在时态描述已不成立状态的内容）**：`CREDENTIALS-STANDARD.md` §2 改为「一处凭据、
  两种用法」（`github-pat` 与 `git-credentials` 实测是同一枚 PAT 的两种形态）并登记 D-14 ~ D-17；
  `HANDOFF.md` 删掉 `cred.sh get kernel`、`GIT_SSH_COMMAND=<部署密钥>` 与旧账号 PR 链接；
  `release/README.md` 删重复的「通道定稿」块并把 SSH-over-443 降为历史注；
  `CROSS-PLATFORM-BUILD-AND-UPDATE.md` 纠正 F2/F5（无私钥构建须 `unset` + `createUpdaterArtifacts:false`；
  触发是 push(main+tags)/PR/dispatch 而非仅 tag）与 §十 V2（本机 `cargo build` 证据既不足证又违反
  「运行期结论只由 CI 裁决」）；`configure-credentials.sh` 不再把「本机无 npm 认证」当缺陷；
  `README.md`/`NO-CONSOLE-WINDOW-STANDARD.md`/`RELEASE-STANDARD.md`/发布 runbook 的仓库地址与现状同步。
  取证与逐条裁决见 `AUDIT-REPORT-2026-09-19.md` §L。

### 门禁纠正：跨仓判据不得钉死已废弃的账号名（迁仓残留）

- **缺陷**：`test/no-cross-repo-test.js` 的 X-2 判据写死 `repository: wasi7mglns/dsh-supervisor-launcher`。
  两仓已迁到 `lobbowen` 账号，于是内核 workflow 若去 checkout 现壳仓（同一失效形态）会被放过，
  门禁静默空转 —— 而它锁的正是「壳仓一次提交即可翻转内核 CI 结论」那个故障。
  判据改为只认仓库名（owner 任意），X-5 反向夹具同时投喂新旧 owner 并断言内核仓自身不误报。
- **文档纠错**：`CREDENTIALS-STANDARD.md` §5 的凭据现状表改以规范库 `index.json` 实测条目为准
  （SSH 部署密钥通道标注为已废弃）；`DEVELOPMENT-TRACK.md` §7 如实登记两仓**当前无分支保护**
  （实测 404），原表格标注为旧账号仓配置、待定案后恢复。详见 `AUDIT-REPORT-2026-09-19.md` §K。

### 工具链可见性（内核侧）：npm 的版本走完「契约 / 状态 / 面板」整条链

- **缺陷（与壳侧「装了 npm 却看不见 npm」同根因的另一半）**：内核把同一份 npm 事实各自解析四处
  —— 分发安装经契约但只取 `npmPath` 丢掉 `npmArgs`（「node + 包内 npm-cli.js」被降级成裸跑 node）、
  原生管理 `npmExe()` 完全绕开契约只走 ambient PATH、环境探测在契约缺席时退回**裸 'npm'**
  （Windows 上即 ENOENT，装了也误报 missing）、`app/settings/env.js` 另起一处手拼
  `path.dirname(stateFile) + 'runtime.json'` 读契约（与真实落点不同源，状态根一挪即静默读空）。
- **单一解析口**：`platform/contract/runtime.js` 的 `npmBin()`（只回程序）换成 `npmLauncher()`，
  成对返回 `{ program, args, version, source }`；`read()` 补出 `npmVersion` / `nodeVersion` / `source` / `installedAt`。
  分发安装、原生管理（`app/native/npm.js::npmLaunch`，保留 `_npmBin`/`_npmBinArgs` 注入且「注入即接管整对」）、
  环境探测三处消费者一律经该口，程序与前缀参数同源一次解析。
- **版本探测带上 args**：`env-catalog` 的 `whichVersion/cachedWhichVersion` 增加参数维（缓存键含 args），
  npm 条目改经解析口；不再退回裸 'npm'，也不再在契约指向的文件跑不通时静默退回 PATH 洗成「就绪」。
- **三段事实对齐**：`/env/status` 的 `npm` 与 `node` 同构为 `{ detected, runtime, path }`
  （runtime = 壳实跑回读的 npm 版本，未回读为 null，不拿 node 版本或占位文案顶上），
  前端 `EnvStatus.npm` 同步声明并新增 `EnvCatalogItem`。
- **面板环境卡改声明式消费**：`OverviewPage::EnvDetect` 不再硬编码只念 Node 版本，
  改为遍历 `/env/status` 的 `catalog.items` 必填项渲染（node / npm / DSH 本体同现，非 ok 态出警示芯片），
  LTS 线提示仍取 `/env/node-lts`。仓库里那份把 npm 标成 `required: true` 的声明式目录首次有了消费方。
- **门禁（判据并入既有文件，未新增链条目）**：`runtime-contract-test` 重写 R-2/R-4/R-5 并新增
  R-7（src 内除解析层与唯一口外不得直呼 `npmBin()`）、R-8（版本不得编造），全部配旧形状反向夹具；
  `npm-resolution-test` C-c 的 sink 集补 `whichVersion('npm')` 这类**版本探测**绕过面（旧版盲区），
  C-d 判据改钉 `npmLauncher` 的 program+args 成对取用；`cross-platform-test` 新增 A5 组（契约在场/缺席
  两轮真实 `envStatus()` + 前端类型与面板渲染判据）。
- **文档与设计笔记纠错**：`design-notes/EXEC3-native-domain.md` 与 `_r5-app-api-P3.md` 仍把
  `npmExe`/`npmExeArgs` 记为现存导出（已合并为 `npmLaunch`）；`round13-node-lts-contract-test` 头注与
  `types.ts` 注释指向不存在的 `guard/supervisor/settings-view.js`（实为 `src/app/settings/node-lts.js`）。

### 注释纪律 + 三处收口（AUDIT-2026-09-19 第 5 批，裁决登记见 AUDIT-REPORT §I）

- **注释纪律门禁（CS 组）**：注释只写「为何」与不可见约束，不写修复过程；字符白名单 = ASCII 可打印
  + 汉字假名 + 中文标点 + 全角 + 排版引号，图标与制表符（`→ ⚠ § ├──` 等）一律禁，映射写 ASCII。
  执法点 `test/comment-pin-gate-test.js` CS-1（字符白名单）/ CS-2（过程叙事标记：批次号、run 号、
  日期、章节号、裁决史），规则正文入 DEVELOPMENT-TRACK 注释纪律节。全仓注释按此重写；
  「剥注释后逐字节比对」探针证明 167 个 js/ts 文件的**可执行代码零改动**。
- **`--prefix` 过闸（§H-8-8 结案）**：`runNpmInstall` 默认分支的安装前缀此前原样进 argv。
  新增第五把尺子 `input.prefixViolation`（拦控制符 / 前导 `-` 的选项注入 / 非绝对形态 / 超长），
  刻意**不复用** argv 字符集——Windows 真实前缀普遍含反斜杠与空白。判据 `npm-resolution` C-g。
- **插件域整树终止收口平台层**：`domains/plugin/cli.js` 超时不再自写 `process.kill(-pid)`
  （Windows 无组语义、只杀得到 `.cmd` 壳，pnpm 孙进程成孤儿），改调 `platform/os/process.killTree`。
  同批改掉 `round8-fixes-test` J-i 里「要求源码含负 pid」的判据——它会把正确实现判红。
- **cred.sh 行为级断言（§H-8-5 结案）**：链内 `credential-hygiene-test` 补 D-7 ~ D-13（空/全空白
  stdin fail-closed、覆盖前备份等价、`backup` 拒 ephemeral 目标、未知子命令与未知条目、清单含值），
  并清空宿主确认类环境变量，防负例因环境变绿。未新增链内测试文件。
- **修出的既有缺陷（darwin 专属）**：两个凭据门禁的 `realHome()` 把 `/\s+/` 写成 `/s+/`，
  macOS 上真实 home 解析成裸账号名而非绝对路径 -> `REAL_STORE` 变相对路径，
  `持久化-3` 判红或 R 组静默 SKIP（门禁在其本应守护的平台上空转）。
- **文档纠错**：DEVELOPMENT-TRACK 与 release/README 曾把 `matrix.supportsProcessGroup()` 当作
  进程组操作入口（照着写就会自组负 pid 信号），改指 `platform/os/process.killTree`；
  ACCEPTANCE-STANDARD §9 补第五把尺子；CREDENTIALS-STANDARD 的门禁标签由虚构的 C-1~C-9 改为
  脚本内真实可 grep 的 D / S / R / 持久化 标签，并删掉与自身「不固化条数」声明矛盾的「18 断言」。
- **CI 取证（第一轮四平台同判红 + 一处隐藏红，裁决见 §I-9）**：本批的注释精简把 J-o 用**字符串**匹配的缺口块
  标记 `## 覆盖缺口（E-2 制度化登记` 删成 `## 覆盖缺口`，四份门禁被判「无缺口块」——门禁逻辑没错，
  被改的是它的判据对象。`npm test` 是 `&&` 链，round8 在第 57 位即截断，其后 71 个文件本轮零执行；
  对未执行段做同口径只读复算，又抓到同类一处隐藏红（P-9 B25 的段锚点钉在 `cred.sh` 的注释上，
  已改锚到代码行 `BK="$f.bak-`）。制度化：被机器 grep 的注释标记是**契约字面量**，
  ACCEPTANCE-STANDARD §7 边界补该条、§10 增第 6 种失效形态「判据的对象可能是注释措辞」、
  §2 第 4 条与 §5 补「链截断后按未执行段做只读复算」的口径。
- **第二轮取证抓到的产品缺陷（windows-only，裁决见 §I-10）**：`cred.sh backup` 的「禁把凭据备份进
  ephemeral 实例子目录」闸用 POSIX glob 匹配，Windows 的反斜杠路径整体漏判（闸太窄，与第 3 批那次
  字符集闸误杀 win32 盘符路径互为反向）。改为归一分隔符后再判，判据与文案不变；
  夹具补一条以反斜杠合成路径为目标的跨平台判据，并把 D-10 的退出码与理由文案拆成两条独立断言。
- **第三轮取证的夹具假失败（linux-only，裁决见 §I-11）**：`p2p-api-test` 的 P9 把自身 20s 轮询上限当成
  产品的时限承诺，而反代账号进入 `ready` 取决于实例真正起起来（同轮产品日志在判红之后即打出
  `registering → ready`，P10 证据为 `st:COLD, h:false`），故这是不成立前提造成的假失败。
  修法不降强度：轮询改写为带回显的具名 helper（耗时 / 轮询次数 / 末态入判据行），上限退化为失控守卫并放宽到 60s，
  「已进入视图」与「已到终态」拆成两条独立断言；终态仍必须是 `ready` 或 `frozen`，产品侧不加超时闸门。
  同构的 20s 上限在 `p2p-router-test` 的 B3/B5 也存在（本轮为绿但押同一前提），一并按同修法处理。
- **CI 排障面（第四轮全绿后复查，裁决见 §I-12）**：`build.yml` 的 test 步注释声称「不截断」，命令却是
  `npm test 2>&1 | tail -60` —— 129 个文件的链只留末 60 行，红点的断言文案几乎必被截掉。
  按「让注释为真」修：去掉截断，与四平台产线腿（`ci-core.sh` 本就全量输出）对齐；launcher 构建那步的
  `tail -20` 保留（进度噪音，非判据文案）。

### 健壮性与制度化收口（AUDIT-2026-09-19 第 4 批：C 类 P2 全量 + §E.1/§E.2/§E.4 立项，裁决登记见 AUDIT-REPORT §H）

- **原子写单源（§E-1）**：状态落盘从「各点自拼 `file + '.tmp'` 再 rename」收敛到
  `platform/util/fs` 的 `writeAtomic`（tmp 名含 pid+毫秒、mode 默认 0600、rename 后二次收口、
  失败 truncate 后抛出）。迁移前 `src/` 下 28 个文件自带该形态、25 个用**固定** tmp 名——升级重叠期
  新旧守卫写同一个临时文件，rename 出的是两次序列化字节的交错混合体；26 个调用点迁移 + 3 处显式豁免。
- **外部输入字符集单源（§E-4）**：新增 `platform/util/input.js`（包名 / argv 项 / systemd 单元名 /
  聚合账本键四把尺子），`install.js`、`os/service.js` 改取同名导出。顺带修真实缺陷：用量账本的
  model 键来自请求体，`__proto__` 走原型 setter 会让该桶从聚合视图与落盘里**静默消失**（错账不报错）。
- **静态门禁登记自己的覆盖缺口（§E-2）**：ACCEPTANCE-STANDARD 新增 §7（缺口登记纪律）+ §8/§9
  （原子写单源、输入字符集单源两条硬规则），四个门禁文件头注登记编号化缺口清单，执法点 J-o。
- **API/安全（C-1…C-9）**：Host 闸缺头即拒；remoteToken 强度闸（<8 拒）前置到写入口 + 门卫凭据
  per-IP 退避（429 + Retry-After，HTTP 与 WS 升级同闸）；转发上游剥离 `token=` 凭据 + 凭证响应
  `no-store`；body 改 Buffer 累积（跨块多字节不损坏、上限按字节）；`/open` Cookie 加 `SameSite=Strict`；
  壳来源判定收敛 `isShellOrigin`（删 `*.tauri.localhost` 通配）；registry 写入口 SSRF 私网字面量拦截；
  监听错误按可重试性分类（`EACCES` → 明确 `api_offline`，绝不静默下线）。
- **令牌域**：跨进程轮转改「原子 rename 抢占备份槽」；未 attach 的隐式源必须过与 attach 同一 kind 闸；
  journal 采集改异步（心跳不再被冻结 5s）；`dsh_lan_token` 改存加盐派生值，令牌原文只容一次性 `?token=`
  出示（重启/换令牌即会话全失效）。
- **平台层**：日志与事件写放大治理（记账 + 节流，轮转即时落 meta）；`reclaimByCmdMark` 空参双闸
  fail-closed；可执行判定补 X_OK（0644 半截安装不再判「已安装」）；浏览器降级链改 spawn 前预检
  （ENOENT 是异步事件，旧递归返回值被丢弃）；镜像探测加宿主支持闸 + platformTag 空值守卫；
  异步 exec 面收编进 `runAsync/runOutAsync`（Windows 不再弹黑框，K-W2 判据扩到六词形）；
  第三方包选版改判 latest 优先（旧「全量最高」会装到他人杂 tag）。
- **生命周期（D-1…D-13）**：在途计数幂等收口（不再恒判「不可停」）；上游失败先停实例再清 pid；
  代理实例日志接平台层轮转（首建 0600，内含启动令牌）；polyfill 缓冲加上限；孤儿判定改同进程组；
  生命周期视图写权 SSOT + 只减不增棘轮；`keepDesired` 阻断「实然覆盖权威 desired」两条路径；
  修重装抹掉 dataPaths 认领（卸载清理曾静默失效）；关停切断在途 npm；main 接管需归属凭据
  （凭据只做否决，不封死恢复）；管理锁改 `wx` 原子取锁 + 持有者存活检测；宽作用域静默 catch 收口 + 棘轮。
- **发布链 + 面板**：workflow 顶层最小权限 + 同 ref 串行 + `uses` 全钉 SHA；glibc 基座门禁从「注释里
  存在」变成产线 `[3.5/5]` 条件步（无 ELF 时如实留痕）；发布子包 README 违 RC-1 措辞归正；选版兜底
  排除我们的 `-BETA.`（正式版不被测试版顶替）；写端点有拒因即 400（前端 `failureFromResult` 单源判
  2xx 里的 `ok:false`，不再弹假成功）；轮询改自排退避链 + 游标归一化（NaN 不再永久停摆）+
  `epoch` 断在途轮次；内核更新桥补面板侧来源校验。
- **凭据脚本（B-25 残留收口）**：`cred.sh put` 空 stdin 一律 fail-closed —— 先读唯一临时文件、
  校验非空才写穿目标，不再落 0 字节并把 status 置 active。
- **CI 裁决补录（八轮红 + 一次崩溃，第九轮四平台全绿；取证见 §H-7-5/6/9/11/12/13/14/15/16/17/18）**：在途 npm 的中止改走平台层整树终止
  （Windows 无进程组语义，旧 `process.kill(-pid)` 只杀得到 `npm.cmd` 壳，孙进程照旧写盘）；
  测试夹具侧修十一处「判据/夹具自身失效」——D-12 反向例期望倒置、D-11 权限位缺 win32 门控、
  D-1b 把函数声明数成调用点、D-3 桩件对 const 数组自增（被产品 try/catch 吞掉后恒判 0）、
  C-3 用绝对落盘计数当判据（漏算前一条合法写；改相对增量 + 逐例回显）、
  C-3 backoffGate 把形参**时刻** `now` 当成**已耗时长**（产品剩余 56000ms 算得对；期望翻正 +
  补 elapsed=0 锚点例，使「时刻当时长」与「时长当时刻」两种错法再不能同时自洽）、
  P-9 B25 的「双锚点取段」首末倒置（`umask 077` 在 put() 里出现两次，B 锚取到前一个 ⇒ 段恒空、
  判据伪装成「产品丢了 || 警告分支」；改从 start 向后找 + 补段长前提例）、
  D-8 观测了另一个注册表实例（`control` 写 `reg`、判据读 `d8` → 直接 TypeError 吃掉整份文件；
  改同一引用 + 取值经兜底访问器，未接线判红而非崩溃）、
  X-6 拿**推演出的宿主环境事实**（「清空 PATH 仍会命中 System32 的 icacls」）当判据前提（windows job 证伪；
  现把该事实本身立成带回显的判据、`underFake` 增 `realPath` 选项，并删掉那句已写进 SKIP 文案的错误引导）、
  X-9 条 4 的夹具与产品**规划不同源**（产品内部自己 `findChromeWin()`，win runner 装了 Chrome ⇒
  注入的 `binAvailable` 对产品真正询问的 bin 恒 false ⇒「一个进程都不起」伪装成产品缺陷；
  现 `launchIsolated` 开 `opts.chromeBin` 注入缝、夹具与产品共用同一份输入，并补「产品所问 == 夹具所认」前提例）、
  X-9 条 4 的**前提例自身只验了一条分支**（chain 分支的产品先对**全部**候选做预检再挑首个可用者，
  故「产品问的第一个 == 夹具规划的可达者」在 linux/macos 必红、windows 的 single 反而绿——run `35488336734`
  回显给出全部 7 个询问；改断言**询问序列与计划序列逐位相同**，single/chain 两形同一条判据成立）。
- **机器绑定清零（`no-dev-path` #110 首次被 CI 执行到即抓红，取证见 §H-7-16）**：① 本批 D 组写进
  `native-dsh-binding-test` 的 `/home/.dsh/sessions` 夹具字面量（3 处）改为宿主中性的 `CLAIM` 常量
  （期望值与写入值同源，不再复制字面量）；② 审计报告里逐字抄录的 windows 日志原文含 runner 账号目录，
  改写为占位形态（事实与判据不变）。改前按**门禁同一口径**（同 `HOME_RE`、同 GENERIC 集合、同剥离器、同
  SKIP 列表）在本机穷举 464 个代码文件与全仓 `.md`，确认零 offender——不吃「修一个再红一个」的 run。
- **ACL 收紧挂账结案（§H-8-9 → 实测）**：windows job 真实 PATH 下 `hasIcacls()=true`、`icacls /?` 探针
  `{ok:true, code:"0"}`，「可用 ⇒ `protectFile/protectDir` 绝不谎报 `mode=none`」成立；上一轮靠推演立的前提
  换成实测事实，同时如实登记 win32 那一支「不可用 ⇒ 如实 none」是恒不触发的蕴含式（其证据在 POSIX 宿主伪造
  win32 + 清空 PATH 那一支）。
- **架构越界收口（DS-G1：为消灭重复而跨域，第 4 批 A 组自己带进来的）**：C-3 把远程令牌强度下限
  `remoteTokenStrength` 落在 `domains/relay/core.js`，再让 `domains/instance/ops.js` 直接 require 兄弟域——
  **单一事实源做对了、域边界踩破了**（五 job 同点红，平台无关一次即定性）。修法走本仓既有裁决而非新造规则：
  纯判定上移新建的 L0 `src/shared/credential.js`（零 require/IO/平台分支/域知识），relay 与 instance 两域 +
  app 写入口三个消费点同源取用，`relay/core` 不再导出第二份（不留兼容转发）；`backoffGate` 因带 relay 域知识
  留在原域。两条跨层边按「登记 + 理由」补进 `layering-and-dependency-gate` 的 `CROSS_LAYER`，裁决记进
  DIRECTORY-STRUCTURE-DESIGN §4.4.1 与 DEVELOPMENT-TRACK 登记表。并把这次红固化成四例判据（本体在 shared、
  shared 出度 0、relay 不再自带本体、instance 不再出现跨域 require）——只靠 DS-G1 兜底的话下次还会再来。
- **架构越界收口（CP-1 首次判红即真违规）**：第 4 批 D 组在 `domains/router/providers/probe.js` 自带的
  `sameProcessGroup` 含 `process.platform === 'win32'` 与 `/proc/<pid>/stat` 读取——平台知识的家只有一处。
  实现下沉 `platform/os/pidlookup`（与 `isAlive`/`readCmdline` 同族）并经门面导出，业务域改调
  `pidlook.sameProcessGroup(...)`；逐字搬运不改判（macOS 无 `/proc` 仍返回 false，与迁移前同形）。
  D-6 判据随搬家重写：平台文件取本体求值（注入 `fs`/`isWindows`）+ 两条反向（业务域不留副本、门面必须导出）。
- **链推进的正向证据**：run `35489972031`（head `931d734`）**四平台全绿** —— #1–#129 整条链在 ubuntu 的
  `test` job（`xvfb-run -a npm test`）与四个 `build` job 各自的 `ci-core.sh`（含 `npm test`）里全部走通，
  第 4 批首次拿到可合入的平台裁决；上一轮 DS-G1 的修法（强度闸上移 `shared/credential`）由这次全绿证实，
  而**不是**由本机的静态复算证实——本机跑不到运行时裁判，复算只能用来预拆雷（见 §H-7-17 的诚实边界）。
  run `35489272772` 把链推到 #123 —— **#111–#122 在四平台首次全绿**（含本批新并入的
  #115 D-9 块与 #116/#121/#129 的门禁判据），上一轮的 X-1/X-2/X-9 三处全部转绿。
  同一 run 的其余正向证据：run `35487214678` 把链推到 #104 —— test job 与 ubuntu + 两个 macos 在
  #78–#103 全绿（26 个此前从未被 CI 执行的门禁文件，含 frp 单源写盘三段判据、glibc E-2 静态断言），
  windows 因 #102 断链而覆盖到 #78–#101；链位 #113 的 API 重绑异步夹具在预清阶段以本机探针复现「同步读异步事实」
  并改写成可观测的重试环（跑满 10 次快重试 → 降级 30s + 留痕 → 退出意图即中止），未消耗额外 run。
- **浏览器隔离打开的测试缝与判据（§H-7-10）**：`launchIsolated` 的 chain 分支并入 `_spawnDetached`
  单一路径并新增 `opts.spawn` 注入点；X-9 条 4 原判据把「linux 下 single/chain 恰好同形」当普适，
  在 darwin/win32 宿主必红（产品 single 报 label、chain 报 bin），且会在 CI 机器真起浏览器；
  现按分支断言实际被 spawn 的 bin 与上报值，并反向验「预检不过 / 非法 URL 时一个进程都不起」。
- 测试全部并入既有文件（零新增入链测试，`package.json#scripts.test` 链长 7899/8000 不破）；
  新增断言均带反向防挂机 fixture；运行时裁决一律走 CI 四平台矩阵。

### 安全与生命周期（AUDIT-2026-09-19 第 3 批：B-1…B-28 + N2/B-21 + E-3，裁决登记见 AUDIT-REPORT §G）

- **令牌/面板域（B-1…B-8）**：remoteToken 热换触发 `onRemoteChange` + reconcile 漂移兜底；
  ctl 通道来源闸（application/json + 回环 Origin，403 fail-closed）；令牌池 `clear()` 截断旧代
  stdout 行缓冲（TK-1）；lan-state 令牌空值显式写入（TK-8 失效广播闭环）；frp.json tmp 带 pid+0600；
  FRP `authToken` 不再明文回显（只报 `authTokenSet`）；UI 携带访问密钥并本机缓存（401 可自助恢复）；
  TK-7 契约改述（remoteToken = instances[] 行投影，门禁同步）。
- **平台层（B-9…B-14）**：PowerShell 通知改单引号串语义（堵 `$(...)` 插值执行）；`hasTool` 改解析判存在
  不 spawn；npm 安装入参白名单（包名/semver/argv 禁用字符，win32 盘符绝对路径整体豁免——
  CI run17 实测反斜杠一刀切禁用会误杀 windows 升级链）+ `--ignore-scripts` + registry 纯 http(s) origin；
  systemd 单元名 `UNIT_NAME_RE` fail-closed；`killTree` Windows 补 `/F`、POSIX 外来 pid 不发组信号；
  端口分配跨进程锁 + 被抢即撤销复检 + migrate 损坏不碰文件/先清源后写目标。
- **生命周期（B-15…B-22 + E-3）**：guardian 开关下沉 gate 至 BACKOFF/FAILED（守「停就停」红线）；
  插件变更路径自检 `exitIntended`（补 INV-S1 旁路）；SIGTERM 外部关停落盘退出意图（9-18 谱系收口）；
  credits 解冻基线显式判空；用量账本键上限+截断+脏标记异步落盘；冻结反代 5min 有界强制停；
  升级 hold 早退路径统一 resume；lan 停止补 `classify()` 归属闸；**N2/B-21**：安装成功后立即
  `_bindNativeDshCommand`（首装免重启守卫）；E-3 意图轴收敛为两级谓词（`_exitIntended` 通用自愈 /
  `_shellExitIntended` 仅壳看护，P2-A/P2-D 实验裁决）。
- **发布链（B-23…B-26）**：version 串进构建前硬闸（点分数字/x-prerelease）；NODE_GEN 改环境变量注入
  （os/cpu 保留）；幂等发布改 unpackedSize+sha1 双项核对（缺失/不一致 exit 1，禁静默跳过）；
  cred.sh 旧值备份判成败；根 lockfile 重建零依赖同步 BETA.10 + esbuild 固版对账（`DSH_ESBUILD_VERSION`）。
- **UI（B-27/B-28）**：CSP 补 `frame-ancestors 'none'`（点击劫持面）；公网暴露等高危操作二次确认、
  令牌采集弃 `window.prompt` 改掩码输入。
- **凭据文档尾账**：规范库位置统一改 `<REAL_HOME>/develop/.credentials/`（cred.sh `CANON_STORE`、
  CREDENTIALS-STANDARD、DEVELOPMENT-TRACK、release/README + 9-19 事故后通道定稿：push=HTTPS+凭据文件、
  API=单一细粒度 PAT、npm=Granular bypass-2FA）。
- 测试全部并入既有文件（零新增测试文件，`package.json#scripts.test` 链长不破 8000）；
  新增断言均带反向防挂机 fixture；运行时裁决一律走 CI 四平台矩阵。

## [0.1.5-BETA.10]（2026-09-19）

本版为 **AUDIT-2026-09-19 P0 清零**安全发布（第 1+2 批）；无用户可见 API/事件契约变更，
内核运行时依赖仍为 0。同时是 A3-a 落地后**首个经 CI token-scoped 发布步 + provenance 真发布**的版本。

### 修复（发布产线，首发实测驱动）

- **子包 manifest 必须携带 `repository`**：provenance 上架时 registry 校验「包元数据 repository.url
  == 签名仓库地址」，缺失即 E422 拒发（BETA.10 首发四平台全拦下，**无任何版本泄漏**，fail-closed 符合预期）。
  根 `package.json` 补 `repository`（单源），`publish-core.sh` 组装子包时从该单源注入。
  同轮另证实 npm 新政：Classic Automation 令牌已被拒发发布（E403），发布令牌须为
  **Granular Access Token 且开启 bypass-2FA**。

### 安全（AUDIT-2026-09-19 第 1 批：P0 A1/A2/A4）

- **A1 持久化「读失败→默认值覆盖」三处收口（fail-closed）**：
  `config.json` 读/解析失败拒绝写回并保全原字节（`desired.js`，事件 `config_persist_aborted`）；
  `dsh-main.json` 损坏态拒绝以默认值覆盖写，仅显式重设 `remoteToken` 解锁（`main-store.js`）——
  消除 9-13 凭据覆盖事故的运行时同型根因；受管目录 `managed-objects.json` 损坏时
  改名 `.bad-<ts>` 保全 + 以未加载态启动（`registry.js`，事件 `managed_registry_corrupt`）。
- **A2 frpc 安装 fail-closed**：取不到官方 sha256（GitHub 直连不可达/校验表缺项）即**拒绝安装**，
  不再降级放行未校验二进制（`frp-install.js`）；离线一次不污染缓存，可重试。
- **A4 win32 浏览器打开去 cmd 注入面**：`open`/`launchIsolated` 不再借道 `cmd /c start`
  （URL 中 `& ^ " ( )` 会被 cmd.exe 二次解析执行），改直启 `chrome.exe`（探测标准安装路径）
  或 `explorer.exe`；入口统一 `isSafeHttpUrl` 仅放行 http(s) 绝对 URL（`platform/os/browser.js`）。
- 测试并入既有文件（不破 N-e 链长约束）：`round13-frpc-integrity-test.js`（C 案例反转为拒绝+缺项+重试）、
  `platform-layer-portability-test.js`（X-8 win32 新形态+A4 判据）、
  `app-ctor-injection-test.js`（A1-a/A1-b 损坏保全断言）、`managed-registry-test.js`（A1-c 损坏目录断言）。

### 安全（AUDIT-2026-09-19 第 2 批：P0 A3 —— 发布令牌作用域 + rollback 通道下限）

- **A3-a CI 发布令牌收敛**：`build.yml` 的 build job 不再在 job env 挂 `NPM_TOKEN`
  （原实现让 ci-core.sh 内 ui `npm ci` postinstall 钩子与全量 `npm test` 的第三方代码
  进程树全部可见）；产线拆两步——验证步**永不带令牌**，发布单独一步（条件等价：tag +
  有 NPM_TOKEN + need_build）经 `ci-core.sh --publish-only` 只跑 [5/5]。
  同时 build job 授 `id-token: write`，`publish-core.sh` 真发布加 `--provenance`
  （OIDC 供应链溯源；逃生阀 `DSH_NPM_PROVENANCE=0`）。
- **A3-b 客户端 rollback 防降级下限（契约新增 RC-7）**：`pickReleaseVersion` 不再无条件
  服从 `rollback` tag —— 目标版本须 ≥ 内建下限 `ROLLBACK_FLOOR_VERSION`（本版按发布纪律
  上调至 `0.1.5-BETA.10`：BETA.9 及更早不携带本批 P0 修复，不得再作为回退目标），且其 npm 发布时刻距今 ≤ `ROLLBACK_MAX_AGE_DAYS`（30 天；元数据无
  `time` 字段时时效核验跳过、下限仍守），不满足即视同无 rollback 走正常选版链。
  封堵「令牌失窃 → 一条 `dist-tag add <pkg>@<任意旧版> rollback` 全员定向降级到漏洞版本」。
  下限随携带安全修复的发布同步上调（发布纪律，见 RELEASE-CHANNEL-CONTRACT.md RC-7）。
- 断言并入既有门禁 `release-channel-test.js`（A3b-0..11：低于下限回落链、边界、
  时效窗口、time 缺失跳过、第三方不受影响、契约漂移、反向非空转）。

## [0.1.5-BETA.9]（2026-09-18）

### 修复

- **退出管家后桌面壳被自动重新拉起（严重）**：会话退出意图持久化（新增 `status.shellHalted`，
  跨守卫重启经 `loadState` 继承，看护观测到壳在线且非退出中时清除）；看护「退出中不自愈」门
  从 bootstrap 定时器闭包**下沉到看护域**（`tick` 依赖 `halted/onShellAlive`）；`POST /shell/restart`
  退出中/已退出返回 409；`restartShell` 在杀旧壳与 spawn 之间增加 `shouldAbort` 复判；
  `shutdownAll` 与完整 `shutdown()` 对齐，清全部周期定时器。详见
  `INCIDENT-2026-09-18-exit-manager-relaunch.md`。

## [0.1.5-BETA.8]（2026-09-18）

本版为**结构收口 + 积压清零**预发布：无用户可见 API/事件契约变更，内核运行时依赖仍为 0。

### 安全

- `/dist/registry/probe` 盲 SSRF **双层闭环**：API 层公网 host 策略 + `platform/distribution/registry.js`
  的 `redirect:'manual'`（禁止 302 绕回内网）；
- 局域网无访问密钥时鉴权 **fail-closed**（401），并修正 frp expose 状态码、清密钥时回关 LAN；
- frp 下载重定向协议校验：非 `http(s)` 跳转不再让守卫同步抛错崩溃；
- 密钥/关闭行为持久化失败**如实上报**（200 → 500），不再「假成功」。

### 修复

- **AUDIT 积压收口**：instance/relay/router 侧（#2/#4/#5/#10/#11/#15-#20/#29/#30）与
  platform/plugin/shell/app 侧（#3/#13/#14/#21-#28）逐项修复；门禁/制度债 #31-#36 收口
  （EX 工具系统性假阴性修正、A-5 扩面到 `release/**`+`.github/**`、等）；
- **存疑项确证为真缺陷后收口**：D9 try/finally、D10 停止路径改用 `DaemonLifecycle.classify()`
  动态归属（防误杀异主 daemon）、D11 假死自愈声明化、D12 kill 失败不再只发成功事件
  （新增 `stop_failed` + 2s 复核窗口 + timer 代际）；
- FIX 同型未覆盖调用点收口（含 FIX-5 根因）；lan-daemon 实例快照补契约 `all()`（DG-11 回归）。

### 结构（app 层「去 this」收口）

- `src/app` 全部**宿主绑定切面**移除隐式 `this`：facade（router/lan/ports/main/status）、
  daemons 切面（identity/runtime/probe/supervise）、main 全部 7 文件、control/scheduler、
  control/instance-adapter、settings/versions、settings/lan-panel，以及 `domain-actions` 三个写动作。
  实现体改经按 host 缓存的 **WeakMap 惰性 deps**，**方法名 / `{methods}` 外壳 / 逐字体一律保留**，
  装配路径与对外面不变；类自身实例（`ManagedLifecycle`/`ManagedRegistry`/`DaemonLifecycle` 等）
 保持 OOP 语义不动；
- ctl/audit 切面工厂化；删除 proxy-instance 过渡 shim 与 `releaseProviderPorts` 导出；
- 门禁棘轮 AT 的 `this.X(` 由 267 降至 84（剩余全部为类自身方法与注释，非宿主债）。

### 契约

- instance `command` **运行时执行边界复校**（`EXECUTION-CONTRACT.md` §8.6 由「待决」改「定案」）：
  api 写时闸与启动期 realpath 复校共用单一纯函数，ENOENT fail-closed，**适用范围仅 sandbox**；
- `command` 契约成文为 SSOT（`EXECUTION-CONTRACT.md` §8）；N11 加码（node 族必须给 DSH 入口且绝对路径）；
- 历史 `inst.state.version` 键在加载期做内存幂等清理。

### 门禁（无用户可见影响）

- test/ 下自带「注释剥离」统一到字符级单一实现 `test/_strip.js`（17/18；新增多语言安全的
  `stripLineAndBlocks`）；
- 修复多起门禁**假阴性**：剥离顺序错误（先块后行）致 4 道门禁对部分区间失明、U-1b 误报、
  DG-14 抽取器依赖缩进形态；新增 docs-reference 门禁与四道结构性门禁；
- 多处源码形态钉子改为**按符号名**（不再依赖 `this.` 前缀），判据本意不变。

### 文档

- 阶段二~六作业单与逐阶段报告（30+ 份）；`_p3-e-audit-backlog.md` 逐行回写现状（阶段四/五已全部处置）；
- 验收口径收敛为「**只由 CI 裁决**，本机禁止运行任何测试」（`ACCEPTANCE-STANDARD.md`）；
- 撤销过期 `TODO(P2)`、作废过期作业单、更正 release 文档漂移。

## [0.1.5-BETA.7]（2026-09-16）

### 修复：原生 DSH「检测 → 绑定 → 接管」——消除两套对立逻辑

真机：系统已原生安装 DSH，守卫却判「未安装」，面板据此去装**第二个** DSH 顶替原生的那个。

根因：原生 DSH 的存在/位置**只来自静态 `config.command[1]`**（出厂默认裸逻辑名 `'dsh'`）——
`fs.existsSync('dsh')` 恒 false → `NativeManager.status().installed` 恒 false；全仓（含壳）
**没有任何一处**把 `dsh` 解析为真实入口（`node dsh` 不做 PATH 解析、Windows 裸名无扩展名）。
同一事实得到两个相反结论 —— 这才是「两套对立的逻辑」。

修法（契约见 `NATIVE-DSH-TAKEOVER-CONTRACT.md` N1–N5）：

- `platform/os/exec-path.js::resolveDsh()`：跨平台解析原生 DSH（`DSH_BIN` → PATH/PATHEXT →
  标准落点 → 包内 `node_modules/@deepseek-ai/dsh/lib/bin.js`），优先包内 JS（用 node 承载，
  规避 shebang / `.cmd` 垫片）；
- `supervisor._bindNativeDshCommand()`：启动时**在任何消费者之前**把出厂默认/裸名绑定为绝对入口；
  用户显式给出的路径**原样尊重**（即使当前不存在也不覆盖）；
- `NativeManager.detected()/binPath()`：以检测结果为准，未装**如实 false**，绝不伪造路径；
- 插件 CLI 经 `target.runtime` 承载（原生绑定后与沙箱的 `lib/bin.js` 都可跑，Windows 亦成立）；
- 壳体感契约同步：`runtime.json` 增 `npmArgs`（npm 仅包内 JS 时 program=node、args=[npm-cli.js]）；
  内核 `env-catalog` 的 npm 探测改为**契约优先**（Windows 裸 `npm` 是 ENOENT）。
- 门禁：`test/native-dsh-binding-test.js`（检测 / 绑定 / 版本 / 如实未装 / 结构不变量）。

## [0.1.5-BETA.6]（2026-09-15）

### 产品状态根独立于 DSH（XDG，2026-09-15）

本产品**管控 DSH**，状态不得寄在被管控对象的 `~/.dsh` 下：

- 新增 `src/platform/state-root.js`（唯一入口）：`DSH_SUPERVISOR_HOME` 覆盖 + XDG/平台默认 + `migrateLegacy()`；
- `config`/`ports`/`runtime-contract`/`router|relay daemon`/`domains/shell`/`proxy`/`autostart`/`bin`
  的 supervisor|shell 状态路径全部切换；**DSH 自身数据（`~/.dsh/profiles`、`DSH_HOME`）保持不动**；
- daemon/install 启动早期 `migrateLegacy()`（按条目合并，不覆盖新文件）；
- `npm test` 注入 `DSH_SUPERVISOR_HOME=$(mktemp -d)`：测试不再写真实 HOME（根除"本地残留"）；
- 门禁 `state-root-test.js`（SR-1..SR-7，含迁移行为与 hygiene）；`defects-batch-f` K7、
  `runtime-contract-test` 同步到新状态根。

### 端口/路径/看护契约收口（2026-09-15）

按 KERNEL-DAEMON-CONTRACT D3/D6/D7：

- **端口声明实际值（D3）**：API 绑定成功（含冲突顺延）后 `ports.register('supervisor-api', 实际端口)`，
  并释放旧端口登记 —— 修「守卫已健康、但壳按旧端口判定未就绪」；
- **看护收归壳（D6/G3）**：`autostart.js` 不再创建 `DSH-Supervisor-Watchdog` / 写 `watchdog.ps1`，
  只保留 GUI 自启；Windows 看护由壳 `ensure_watchdog` 建立；
- **状态/日志路径经 stateDir（D7/G6）**：`domains/router/providers/proxy.js` 改用注入的 `stateDir`，
  不再直拼 `os.homedir()`（修本地跑测写真实 `~/.dsh` 的根因）；
- 门禁：`kernel-daemon-contract-test` 增 D-6/D-7/D-8；`platform-capability-audit` A5 改负向不变量。

### 内核守护进程契约：install 不再部署服务定义（2026-09-15）

按 `KERNEL-DAEMON-CONTRACT.md` D6（内核不建/不启/不停自己的服务定义，唯一所有者=桌面壳）：

- `bin/dsh-supervisor` 的 `install` **不再**写 systemd unit / autostart / 桌面入口
  （避免与壳争夺「谁定义、谁拉起」；Windows 上更会形成 kernel watchdog + 壳计划任务双启动器）；
- 删除随之失效的 `installDesktopEntry` 与 `UNIT_TEMPLATE`/`DESKTOP_*` 常量；
- 门禁：`test/kernel-daemon-contract-test.js`（D-1..D-5，含反向非空转）。

## [0.1.5-BETA.5]（2026-09-15）

### 内核读运行期启动契约 —— npm/PATH 与壳同源（Phase 2）

问题：内核自身也要执行 npm（自更新 / 装 DSH / 插件），旧实现用 ambient PATH 的裸 `npm`
与 `process.env`；GUI / 服务环境常找不到 npm，表现为「壳能装、内核自己装不了」。

- 新增 `src/platform/runtime-contract.js`（壳写内核读，schema 2）：`read()` / `npmBin()` / `withPath()`；
- `domains/dist` 的 `runNpmInstall` 用契约里的**绝对** npm 并注入 PATH（模板 npm 分支同源解析）；
- `platform/env-catalog.js` 的 `runtimeMeta()` 委托同一契约，消除第二份读取实现；
- 门禁：`test/runtime-contract-test.js`（R-1..R-6）、`test/npm-resolution-test.js` C-d 断言更新；
- `test/layering-and-dependency-gate-test.js` 登记 `src/platform/runtime-contract`。

### 契约 schema 握手门禁（Phase 3）

- `SUPPORTED_SCHEMA` 恒为 2，门禁 R-6 锁定；与壳 `runtime_contract.rs` 的 `SCHEMA` 握手，
  两仓各自断言、**互不读源码** —— 任一侧改 schema 必须同时改两侧，否则各自 CI 变红。

### 内核更新收敛为单写入者 = 桌面壳（2026-09-15）

问题 1 的根：内核 npm 包有**两个写入者**（内核自更新 `POST /self-update/apply` 与壳 `core_apply`），
两套版本判定、两种源策略（内核官方 registry vs 壳镜像）。现收敛为**唯一写入者 = 桌面壳**；
守卫只提供只读状态，从不安装/重启自己。面板运行在内核托管的 iframe 内、无 Tauri IPC，
故经 postMessage 请壳主帧代执行。

- 写端点下架：`POST /self-update/apply`、`POST /self-update/restart-guard` → `410` + `KERNEL_UPDATE_SINGLE_WRITER`；
  `GET /self-update/status` 保留为**只读**；
- 删除写实现：`settings-view` 的 `guardSelfUpdateApply` / `guardSelfUpdateRestart`、
  `_selfUpdatePending` 及其状态字段；
- 删除旧 manifest 通道死代码：`src/domains/dist/self-update.js`、config 的
  `selfUpdateManifestUrl`/`selfUpdateDir` 残留键、`fs-utils.extractTarGz`（唯一消费方已删）；
- CLI `dsh-supervisor self-update apply` 不再安装（给指引 + 退出码 2）；`check` 保留；
- 面板改用 `ui/src/services/supervisor/kernelUpdateBridge.ts` 经壳主帧代执行（协议 v1）；
- 门禁：`test/kernel-update-single-writer-test.js`（SW-1..SW-7，含反向判据）；api-surface 标 deprecated。

配套壳仓（另一仓）：`src/bridge.rs` + `kernel_update_apply` + `shell.html` 消息桥（见其 §3.2c）。

## [0.1.5-BETA.4]（2026-09-14）

### 设计修正：内核仓与壳仓彻底解耦（移除跨仓源码依赖）

**问题（实证）**：内核测试经 `test/_shell-repo.js` 读取**壳仓源码**，CI 又 `actions/checkout`
壳仓默认分支 `main`。于是同一内核提交 `4eae7371`：本地（同级壳仓工作树在 `release/shell-1.1.0`）
全绿，CI（壳仓 `main` 仍含 `attempt`/`pendingVersion`）在 `shell-safety-net R10-b` 失败。
一个与内核无关的壳仓提交即可翻转内核 CI 结论 —— 两仓账号/仓库隔离被测试层穿透。

**修正**：内核**不检出、不读取壳仓源码**；跨语言契约只经「已发布产物 / schema / 测试向量」消费。

| 位置 | 处置 |
|---|---|
| `.github/workflows/build.yml` | 删除两处壳仓 `actions/checkout` 与 `DSH_SHELL_REPO` |
| `test/_shell-repo.js` | 删除 |
| `test/version-vectors-test.js` V2 | 去掉两仓逐字节比对，改为本仓向量 schema/结构自洽 |
| `test/shell-safety-net-test.js` R10-b | 删除扫描壳源码；保留内核侧 R10-a/R10-c |
| `test/shell-watchdog-test.js` W5 | 删除读壳 `update.rs`；消费行为由 W1-i/W3-c/W3-f 覆盖 |
| `test/autostart-ownership-test.js` P2-f/P2-g | 删除读壳 `macos.rs`；所有权内核侧断言保留 |
| `test/platform-capability-audit-test.js` A5/A7 | 删除读壳源码；保留内核侧所有权断言 |
| `test/no-cross-repo-test.js`（新增） | X-1..X-5：代码/workflow 不得再出现壳仓耦合，含反向判据 |

壳侧反回归（不得重新引入 `attempt`/`pendingVersion`/`update-journal`）归**壳仓自身测试**。

### 规范立住：封死本地发布 + 清除机器绑定与过时声明

**本地单平台真发布封死**：此前只拒绝了 `--all-platforms`，单平台 `publish-core.sh --publish`
/ `ci-core.sh --publish` 仍可在开发机直发 npm。现两者均要求 `GITHUB_ACTIONS=true`（本地 exit 2）；
`all-platforms-test` T2-b2/T2-d2 锁定。`RELEASE-STANDARD.md` §0 增两条硬标准。

**清除机器绑定（`/home/bowen`）**：
- `release/scripts/cred.sh`：库根改由 `_npm-auth.sh::dsh_real_home()` 解析（getent/dscl/USERPROFILE），
  可用 `DSH_CRED_DIR` 覆盖；旧别名/散落副本路径同源派生；
- `test/credential-hygiene-test.js` / `test/destructive-op-safety-test.js`：同源派生真实 home；
  后者改用 `DSH_REAL_HOME=<tmp>` 模拟真机库（不再复制/改写脚本）；
- `ui/src/features/supervisor/InstancesPage.tsx` placeholder 与 `README.md` 示例路径改通用；
- `CREDENTIALS-STANDARD.md` / `DEVELOPMENT-TRACK.md` / `release/README.md` 改 `<REAL_HOME>`；
- 新增 `test/no-dev-path-test.js`（X-1..X-3，含反向判据）。

**清除过时/分歧声明**：
- 脚本头：`ci-core.sh` / `publish-core.sh`（SEA、`--all-platforms` 可用、linux 本地生产）；
- `release/README.md`：删「本地全平台构建已跑通」与「build 被 need_build 跳过」的过时章节/边界；
- `release/runbooks/publish-and-verify.md`：本地生产与 `launcher-build.yml`（幽灵产线）改指真实 CI；
- `RELEASE-STANDARD.md` §3：`publish:core:all`（不存在）→ `publish:core` / `--publish`；新增 P-2c 门禁
  （规范正文里每个 `npm run X` 必须在 package.json 存在）；
- `LICENSE` / `.gitignore` / `_npm-auth.sh` / `build-ui.sh` SEA 遗留措辞；
- **删除过时根级文档** `AUDIT-HANDOFF.md`、`AUDIT-CROSS-PLATFORM.md`，并同步 README 索引与引用。

### 强制更新收敛：壳回退机构整体移除

产品规则：壳与内核同一套升级逻辑 —— 有新版必须强制更新；**不得回退、不得跳过、
不得按版本拉黑、不得冷却抑制**。唯一保留回退的是 **DSH 自身升级**
（`guard/native/manager.js` / `domains/dist/`，本次未触碰）。

| 位置 | 内容 |
|---|---|
| `domains/shell/index.js` | 删除 `rollback()`、`should-rollback` 分支、`pinnedVersions`、`attempts/maxAttempts`；`evaluate()` 仅剩 idle/pending/confirmed |
| `domains/shell/watchdog.js` | 去掉已删账本字段 `rolledBack` 的读取 |
| `api/shell.js` | 删除 `POST /shell/rollback` 处理分支 |
| `api/surface.js` | 删除 `/shell/rollback` 登记与 `pinnedVersions` 相关说明 |
| `release/README.md` | 跨仓契约表：删除 `update-guard.json` 行，`identity.json` 改注运行时字段 |
| `test/shell-safety-net-test.js` | R3 改断言「永不回退」；R4/R10 增反回归门禁 |

### 验证

`npm test` 全绿（CI `test` job）；`shell-safety-net-test` 57 passed / 0 failed。

## [0.1.5-BETA.3]（2026-09-14）

> 本轮确立**硬标准**并据此修正 CI 门控；修正后立刻暴露出 5 类只在 macOS/Windows
> 暴露的缺陷（长期被跳过的构建矩阵掩盖）。每条均经「构造/注入 → 确认门禁失败 →
> 修复 → 确认通过」验证。

### 硬标准（不可协商）

**所有平台构建与发布必须经 GitHub CI 完成；本地不得产生任何发布产物。**

| 项 | 内容 |
|---|---|
| 删除 | `release-core.sh`（157 行本地发布编排器，CI 从不调用）|
| 本地全平台发布 | `publish-core.sh --all-platforms` 一律 exit 2；`ci-core.sh --all-platforms` 同 |
| 本地全平台构建 | `build-launcher.sh --all-platforms` 改为**仅 CI 内放行**（`GITHUB_ACTIONS` 守卫）|
| npm scripts | 移除 `release:core*` / `publish:core:all`（5 个本地发布入口）|

### 修复：四平台完整构建不再被跳过（原为隐藏风险）

`build` job 原受 `need_build == true` 门控，理由是「本地已产出，幂等」——
**那是本地构建时代的理由**。硬标准禁止本地构建后该理由失效，后果是：
**已发布版本之后的任何改动都从未经过四平台构建验证**，而 required checks 只有 ubuntu 上的
`test` → 在 Windows/macOS 编不过的改动照样能合并。

- `build` 去掉条件（**每次 push / PR 都跑**）；`need_build` **只作用于发布**（一次性闸）；
- 四条 `build (...)` 设为 **required status check** → 完整构建成为**合并门禁**；
- 新增门禁 P-8 / T5-d：build **不得**被条件跳过（含反向判据）。

### 修复：改成每次构建后立刻暴露的跨平台缺陷

| 平台 | 缺陷 | 影响 |
|---|---|---|
| macOS | `cred.sh` 用 GNU 专有 `stat -c %a` | BSD stat 不支持 → 权限判定全失效 |
| macOS | **`$VAR` 紧跟全角字符**（如 `$m（应为 600）`）| **bash 3.2 把字节并进变量名** → unbound variable，脚本中止 |
| Windows | 路径**插进 JS 源码字符串**（如 `require('$INDEX')`）| 反斜杠=无效转义 → require 失败或路径错乱 |
| Windows | 门禁夹具注入 Windows 路径未 POSIX 化 | 路径变成 C:UsersRUNNER~1... 无法定位清单 |
| Windows | X-4 断言硬编码 `path.join('/H',...)` | 把 POSIX 语义当通用（被测值其实正确）|

**「$VAR 紧跟全角字符」一类是存量缺陷，不止一处**：`cred.sh` 6 处、
`build-launcher.sh` 1 处（`$BASE_HASH）`）、`configure-credentials.sh` 2 处 ——
即这两个发布脚本原本在 macOS 上会**直接报错中止**。

### 新增：防止同类再犯的门禁

| 门禁 | 断言数 | 作用 |
|---|---|---|
| `test/shell-portability-test.js` | 7 | **本机即可拦**：$VAR+全角、JS 里插路径（值/名字类不误报）|
| `test/release-spec-consistency-test.js` | 21 | 规范↔现实一致；含 P-8（完整构建不得被跳过）|
| `test/standards-uniqueness-test.js` | 8 | **规范唯一性**：其它文档不得自称「唯一事实源」|

### 文档：唯一事实源与清理

- `RELEASE-STANDARD.md` 增 §0 硬标准；S5–S7 改为 CI 流程；机器块重写；
- README 文档索引重写为**角色表**（三份唯一规范 / 契约 / 论证降级 / 历史 / 复盘），根级文档与索引一一对应；
- 整节替换与硬标准矛盾的「全平台本地构建」章节；修正 README「CI 矩阵不含 ubuntu」等直接矛盾；
- `cred.sh backup <目录>`（拒绝默认值、拒绝实例子目录）+ 4 条**持久化断言**；
- 事故复盘 `INCIDENT-2026-09-13-credential-overwrite.md`。

## [0.1.5-BETA.2]（2026-09-13）

> 本轮为**双仓完整审计与缺陷修复**（第十三轮），每条修复均经
> 「注入缺陷 → 确认门禁失败 → 还原 → 确认通过」验证，覆盖 9 类失效模式
> （注释与实现不符、同一事实两处实现分叉、声明无调用点、闸门锁错行为、
> 阈值不可达、只写不读、纪律只在一部分路径执行、异步未收束、跨仓契约错配）。

### 修复：致命 / 高危（P0–P1）

| 级别 | 内容 |
|---|---|
| **P0** | `execFileSync` 在 `stdio:'ignore'` 下**成功也返回 null**，而三处调用方把 `!== null` 当作成功 —— `hasTool` 恒假 → `capabilities().multiInstance` 恒假 → **Linux 上沙箱实例功能对所有用户不可用**；`isUnitActive` 恒假 → 就绪判定永不满足（误回滚）+ **删除前「仍活跃则不删数据」的保护永不生效**；`hasIcacls` 恒假 → Windows 文件权限静默失效。修在根因（`exec.run` 语义）+ 全部调用点。 |
| **P1** | **心跳是唯一周期驱动**，任一 adapter 卡死即**永久停摆**（无超时/无兜底/无观测）→ main 收敛、沙箱自愈、daemon 监督全停而面板仍显示旧状态。 |
| **P1** | `sanityCheck` **丢弃返回值** → 校验失败的包会被翻转到 `current`（下游拿到损坏内核）。 |
| **P1** | `api/router.js` 多处 `.then` 链**无 `.catch`** → ctl 拒绝/异常时请求**永久挂起**。 |
| **P1** | 壳投放的镜像契约**只在构造期读一次** → 运行中重写永不生效（跨仓同源承诺失效）。修：60s TTL 重载。 |
| **P1** | **frpc 下载零完整性校验**：经两个第三方镜像前缀 + 最多 5 跳重定向下载，仅验 HTTP 200 与 gzip 可解析即 `chmod 0755` 落盘并 detached 执行。修：从**官方 GitHub 直连**取校验和比对 sha256（不经镜像 → 只控镜像者无法伪造），不匹配即拒绝。 |
| **P1** | `TaskRegistry` **跨进程双写者整份覆盖** → 守卫与 router-daemon 互相丢任务。修：写时合并。 |
| **P1** | 插件补丁层写队列被**一次异常永久毒化**（此后所有补丁静默失效）。 |
| **P1** | frp 令牌闸只在一条路径执行 / relay 门卫令牌无热换 / 删除实例与在飞升级无互斥 / 删除路径不 force 停实例。 |

### 修复：中低（P2–P3）

`registry.json` 的 `selected` 恒为 null（壳侧 `selected_npm` 从不落盘）；
Node 安装零进度反馈（前端 `if (p.busy)` 恒假）；`nodeprobe` 孤儿线程堆积（硬上限后置回
Idle，卡死线程无法回收 → 每次重试 +1 条）；镜像「测试」按钮被页面 CSP `connect-src 'self'`
拦截（**结构性失败被伪装成网络失败**）；`ports.release(port, ownerId)` 对未登记端口
**抛 TypeError**（空值检查在 owner 比较之后）；删除实例的「数据已保留」安全结果对用户
不可见（谎报「数据已清」）；令牌恢复文件权限未收口（0600）；providers.json 损坏即静默
清零（改为隔离备份）；平台事实误报（Windows 下 `--service-plan` 恒报「否」、
`privilege_channel` 硬编码 true）；`ManagedLifecycle.stop` 失败时硬编码回 running
（把已知失败显示成运行中）；引导页谎报「内核已是最新」。

### CI / 门禁工程（本轮重点）

| 问题 | 修法 |
|---|---|
| 内核 `test` job **未构建前端** → 面板 CSP/nosniff 两条断言因 503 失败 | 先 `build-ui.sh` 再 `npm test` |
| 看护 E2E 需**图形会话**，无头 runner 中看护按设计拒绝拉起 GUI 壳 | 装 Xvfb，`xvfb-run -a npm test` |
| **跨仓门禁在 CI 中静默 SKIP**（5 条「壳仓不在同级目录」）→ 假门禁 | 检出公开壳仓 + `DSH_SHELL_REPO`；新增 `test/_shell-repo.js`，**声明了却缺失即硬失败** |
| 3 条跨仓门禁**路径已失效**（`service.rs` → `platform/service.rs`；P2-g 断言的字面量在壳仓不存在）| 修正路径；P2-g 改为**真正比对两侧 `GUARD_LABEL` 取值** |
| `build` 矩阵只产 mac/win（原为私有仓省额度）| 内核仓转公开后**四平台全部由 CI 产出**（加回 `ubuntu-22.04`）|
| `all-platforms-test` 的 T6-d/T6-e 无产物时静默 SKIP | `test` job 先 `build:launcher:all`；新增 `DSH_LAUNCHER_REQUIRED=1`，缺失即**硬失败** |

`push master` 现在跑完整回归；`tag v*` 跑四平台构建 + 发布。

### 发布工程

`release/README.md` 规范化：新增 §0「两仓构建决策」（为什么必须分两个仓、跨仓契约、
跨仓发布时序）与 §1「产线实证与已知边界」；修正全篇「私有仓额度」的过时前提。

### 计数

内核 `npm test`：78 文件 / 1460 断言 → **90 文件 / 1665 断言 / 0 失败**；
新增门禁 12 个文件。版本 `0.1.5-BETA.1` → `0.1.5-BETA.2`。

### 修复/架构：镜像目录契约化（M1–M5，消除「两侧选源不一致」）

#### 背景（本次审计实测）

镜像目录在**三处逐字节重复**：壳 `mirror.rs`、内核 `domains/dist/index.js`、内核 `platform/config.js`
（后两处即当时的 `REGISTRY_PRESETS` 与 `registries`；本次已删除，故不写行号）。
且两侧**探测方法不同**（内核 `/-/ping`、壳真实包元数据），同一镜像测出的延迟可差 **6.7 倍**
（实测 ustclug 2613ms vs 389ms）→ 内核选 `repo.huaweicloud.com`、壳选 `registry.npmmirror.com`，
用户看到「面板显示一个源、实际下载用另一个」。

此外内核环境判定只看 `which node` 成功，而壳要求 `>= v22.12.0` →
**面板显示「环境就绪」而壳拒绝启动内核**。

#### 判据（所有权，非偏好）

用户在装壳那一刻机器上**没有内核** —— 壳必须先完成镜像选择才能装内核。
故「镜像目录与探测方法」的所有权在**壳**，内核**消费产物**。

#### 变更

| # | 内容 |
|---|---|
| M1 | 新增 `src/platform/registry-contract.js`（契约读取器，schema 1/2 兼容，未来版本明确拒绝）|
| M1 | `dist` 的 `REGISTRY_PRESETS` 6 条 → **删除**；`config.js` 的 `registries` 6 条 → **2 条最小兜底** |
| M1 | 候选来源优先级：用户 manual > 契约 `catalog` > 构造参数 > 兜底 |
| M2 | `_probeRegistry` 按契约 `probe` 规格探测（与壳同法 → **同一答案**），无契约退回 `/-/ping` |
| M3 | `selectRegistry` **优先复用契约 `selected`**（TTL 内零网络；实测 1ms 完成）|
| M4 | `env-catalog.js` 的 Node 判定改为**三态**（ok/outdated/missing），门槛从壳投放的 `runtime.json.minNode` 读取 |
| M5 | 新增 `shared/version-vectors.json` + `test/version-vectors-test.js`（33 项，含**跨仓逐字节一致**校验）|

#### 不变量

| # | 内容 |
|---|---|
| C2 | 契约缺失/损坏/schema 更新时**必须可降级运行**（实测：reason=contract-missing，仍可用兜底）|
| C3 | 契约比本内核新 → **明确拒绝**并记录，不猜格式 |
| C5 | 两侧对同一问题的判定**必须给同一答案**（探测规格随契约投放）|

#### 验证

```
内核  49 文件 / 1026 断言 / 0 失败
壳    69 项（9 单元 + 54 B 系列 + 6 V 系列）/ 0 失败
E2E   契约 catalog 生效（3 条而非兜底 2 条）
      契约 probe 生效（平台标签展开为 linux-x64）
      契约 selected 复用（1ms，未测速）
      契约缺失降级（contract-missing，兜底可用）
```
### 修复：自启所有权定案 + macOS 原生壳自启（用户要求「按规范做扎实」）

#### 一、先定所有权矩阵（此前**没有**，是两个缺陷的根因）

| 产物 | 唯一所有者 | 依据 |
|---|---|---|
| 守卫服务**定义**（unit / plist / 计划任务）| **桌面壳**（`service.rs`）| 引导顺序：壳是安装器，装内核后立即建立 |
| 守卫自启**开关**（enable/disable）| **内核**（面板）| 用户可见设置项在面板 |
| 壳（GUI）自启产物 | **内核**（`autostart.js`）| 同上；与守卫自启同属「整链自启」语义 |
| 壳崩溃自愈 | **守卫看护** | 壳不能自监督 |

#### 二、缺陷 ①：macOS 双写冲突 + 「关闭自启」不生效

内核与壳**同时写** `~/Library/LaunchAgents/com.dsh.supervisor.plist`（两个模板必然漂移）；
更严重的是内核 disable 时 `unlink` 该文件，而**壳下次启动会重建并 bootstrap** →
**用户关闭自启后下次开机又回来了**。

修复：内核**只做 `launchctl enable/disable` + `bootstrap/bootout`，绝不写/删该文件**。
`launchctl enable/disable` 持久化到 launchd 覆盖库 —— 这才是「关闭」能生效的机制。
定义缺失时**显式报错**（「请先启动一次桌面壳」），不越权创建。

顺带删除内核中已成死代码的 `macPlist()`（守卫定义归壳，保留副本只会漂移）。

#### 三、缺陷 ②：macOS 无壳自启（用户明确要求补齐）

新增**独立** LaunchAgent：

```
com.dsh.supervisor      ← 守卫（壳所有）
com.dsh.supervisor.gui  ← 桌面壳（内核所有）
```

GUI plist 的关键约束：**只表达「登录启动」**
（`RunAtLoad` + `LimitLoadToSessionType=Aqua`），**不加 `KeepAlive`**：

· 崩溃恢复归**守卫看护**（它有会话判定、宽限期、有界重试）；
· 两套机制同时管会互相争抢；
· launchd 的 KeepAlive 在 GUI 应用上可能造成无退避的重启循环。

边界处理：无法定位壳可执行文件时**不盲写 plist**（否则登录时 launchd 静默失败），
而是明确报错。

#### 四、能力声明：三平台齐备

```
linux    壳原生自启=Y（systemd+XDG）   壳自愈=Y（守卫看护）
darwin   壳原生自启=Y（LaunchAgent）   壳自愈=Y（守卫看护）   ← 本次补齐
win32    壳原生自启=Y（schtasks）      壳自愈=Y（守卫看护）
```

「原生自启」与「崩溃自愈」是**两个独立字段**：前者管「重启后自己回来」，
后者管「运行中崩了被拉起」。二者互补、不互相替代。

#### 五、验证

| 测试 | 覆盖 |
|---|---|
| `test/autostart-ownership-test.js`（24 项）| P1 标签分离 / P2 内核不越权 / P3 GUI plist 约束 / P4 边界 / P5 未知平台显式不支持 |
| `test/platform-capability-audit-test.js` | A4 期望值更新（darwin 已实现）；A5 守卫 plist 断言改跨仓读壳；新增 **A8** 所有权不变量（10 项）|

全量：52 个测试文件全绿。
### 新增：桌面壳自愈 —— 守卫看护（三平台一套机制）

#### 修复的缺口（用户指出的「壳最脆的地方」）

产品意图是「**壳关不掉**」：关窗 = 隐藏到托盘；「退出管家」= 停止全部服务链。
故壳只会在**崩溃**时消失。而修复前：

| 平台 | 壳崩溃自愈 |
|---|---|
| Linux | ❌ **完全没有**（仅 XDG 登录自启，会话内崩溃无人拉起）|
| macOS | ❌ **完全没有**（`setGuiAutostart` 在非 Linux 是空操作）|
| Windows | ⚠️ 有 watchdog 但**壳检查被嵌在 `if (-not $up)` 内** —— 只在「守卫也不可达」时才执行，
|  | 而「壳崩、守卫活」正是唯一需要它的场景 → **整块跳过** |

#### 为什么由守卫做

壳**无法自我监督** —— 它的监督者会随它一起死。守卫是抗重启的那个
（`Restart=always` / `KeepAlive` / schtasks Watchdog），且**已在读取** `identity.json`、
**已实现** `restartShell()`。故由守卫承担，且**三平台一套机制、无需新增服务定义**。

#### 看护策略（`src/domains/shell/watchdog.js`）

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

设计要点：
- **决策是纯函数** `decide()` —— 可穷举单测，不依赖进程/时钟/文件系统；
- 以**进程实际存在**为准，不以文件/心跳推断；
- **必须有图形会话**：Linux 经 `enable-linger` 在注销后仍运行，
  此时拉起 GUI 必然失败并造成重启风暴 —— 新增 `platform/os/desktop.js` 做真判定
  （环境变量 + X11/Wayland socket 实测）；
- 记账在**尝试前**（失败同样计入上限，防失败风暴）；
- 失败**如实上报**（`shell_watchdog_restart_failed` 事件），不假成功；
- 异常**不影响守卫主循环** —— 看护是增强，不是依赖；
- 可按配置禁用（`shellWatchdog: false`）。

#### 壳侧配套

`identity.json` 新增 `exe`（`std::env::current_exe()`）与 `lastSeenAt`。
**为什么必须**：壳崩溃后进程已不存在，`pgrepList` 拿不到它的 cmdline ——
看护需要一个**已落盘**的路径来源，否则只能靠猜安装形态（那正是历史上多次踩坑之处）。

#### 修复 Windows watchdog 的嵌套缺陷

```powershell
# 修复前
if (-not $up) {                       # 仅当「守卫也不可达」
  ... 拉起守卫 ...
  $g = @(Get-Process dsh-supervisor-gui ...)
  if (-not $g) { Start-Process $gui }  # ← 壳自愈被埋在这里
}
# 修复后：壳检查移出该块，独立于守卫状态
```

#### 能力声明更新

`capabilityProfile()` 的 `shellSelfHeal` 由 **false → true**（linux/darwin/win32）；
`shellAutostart`（**原生**机制）在 macOS **仍为 false** —— 二者独立，不可互相替代：

```
linux    壳原生自启=Y  壳自愈=Y
darwin   壳原生自启=n  壳自愈=Y   ← 守卫自启 → 看护发现壳缺失 → 拉起
win32    壳原生自启=Y  壳自愈=Y
```

#### 验证

| 测试 | 覆盖 |
|---|---|
| `test/shell-watchdog-test.js`（36 项）| 决策穷举（W1）+ 进程过滤（W2）+ 集成 mock（W3）+ 接线（W4）+ 壳侧契约（W5）|
| `test/shell-watchdog-e2e-test.js`（6 项）| **真实 Supervisor + 真实 spawn**：壳缺失 → 真的被拉起（写标记文件证明）|
| `test/platform-capability-audit-test.js` | 新增 A7：`shellSelfHeal` 声明 ↔ 实现绑定 |

E2E 实测输出：

```
[shell-watchdog] 已启用（周期 1s）
[shell-watchdog] 桌面壳缺失，开始计时（宽限 2s）
[shell-watchdog] 桌面壳缺失 2s，已拉起 pid=3219711 exe=/tmp/.../dsh-supervisor-gui
```
### 修复：全平台发布的时序竞态 —— 本地发布与 CI 同时 PUT 同一包（409 Conflict）

#### 问题（本次发布实测撞到）

`v0.1.5-BETA.1` 发布时，`win-x64` 报错：

```
npm error 409 Conflict - PUT https://registry.npmjs.org/@dsh-sup%2fdsh-core-win-x64
npm error Cannot publish over previously staged version "0.1.5-BETA.1"
```

**根因是 `release-core.sh` 的时序**：旧实现「**先 tag+push，再本地发布**」。
tag 一推，CI 的 build 矩阵立即启动；而 CI 在「tag 触发 + 有 `NPM_TOKEN`」时会执行
`ci-core.sh --publish` —— 即 **CI 会真发布自己平台的子包**。
于是本地与 CI 同时 PUT 同一个包 → 409。

实测发生顺序（时间戳为证）：

| 平台 | 发布者 | 时间（UTC） |
|---|---|---|
| darwin-arm64 | **CI** | 08:53:58 |
| darwin-x64 | **CI** | 08:55:41 |
| linux-x64 | 本地 | 08:57:34 |
| win-x64 | **CI** | 08:58:51（本地于此之前 PUT 撞车） |

darwin 两个平台因**幂等跳过**（本地发现已存在 → 视为成功）才没报错；
win-x64 恰好同时到达，才暴露了竞态。**这不是偶发，是设计缺陷**。

#### 修复：改为「先发布、后 tag」

```
旧：[3/5] 构建 → [4/5] tag+push → [5/5] 本地发布   ← CI 与本地竞态
新：[3/5] 构建 → [4/5] 本地发布 → [5/5] tag+push   ← 无竞态
```

改后两种模式都正确：
- **全平台模式**：tag 前 4 平台已全部发布 → CI 的 `precheck` 判定「已全发布」→
  **跳过整个 mac/win 矩阵**（既省额度、又彻底无竞态）；
- **单平台模式**：本地只发 linux → CI `precheck` 判定需补 → 矩阵发 mac/win
  （平台不同，天然无竞态）。

代价：若 push 失败会短暂处于「已发布但无 tag」。该状态**可恢复**（版本已在 npm，
tag 可随后单独补推 `git push origin v$VER`）。相比 409 导致的**发布不完整**，此代价更小。

#### 附带确认（同一批次）

`v0.1.5-BETA.1` 的 CI **在真实 Windows runner 上全绿**，含此前失败的 `build (windows-latest)` ——
即 CRLF 修复（见上一条）已获真机验证。四平台最终状态：

```
linux-x64      ✅ beta=0.1.5-BETA.1
darwin-arm64   ✅ beta=0.1.5-BETA.1
darwin-x64     ✅ beta=0.1.5-BETA.1
win-x64        ✅ beta=0.1.5-BETA.1
```

## [0.1.5-BETA.1]（2026-09-11）

### 清理：内核仓彻底剥离壳残留 + 本地工作区清理（用户要求）

用户指出「内核仓有报错、东西不知道在哪、完全是乱的」，要求对内核仓做准确清理，
保证**内核仓干净 + 本地干净**，且**删除不再需要的测试文件、不留残留**。

#### 一、仓库归属（先讲清楚，此前从未说明）

两个仓在**两个不同的 GitHub 账号**下 —— 这是「看不到仓库」的直接原因：

| 仓 | 地址 | 可见性 |
|---|---|---|
| **内核** | `advgyxqamf/dsh-supervisor-core` | 🔒 私有 |
| **桌面壳** | `wasi7mglns/dsh-supervisor-launcher` | 🌐 公开 |

按用户决定：**保持两账号不变，不做迁移**。

#### 二、安全隐患：仓目录内曾有 3 把 SSH 私钥

`<内核仓>/.ssh/` 下存有 `id_ed25519_advgyxqamf` / `id_ed25519_oldcore` / `id_ed25519_wasi7`
三把**未加密私钥**（虽被 `.gitignore` 忽略、未被跟踪，但放在仓目录内属重大风险 ——
本仓曾发生私钥被 `git add -A` 误提交的事故）。

已迁移到标准位置 `~/.ssh/`（复制 → 哈希校验 → 更新两仓 `core.sshCommand` →
`ls-remote` 连通验证 → 删除仓内副本）。

#### 三、双仓隔离的最后残留（本次清掉）

| 项 | 处理 |
|---|---|
| `.shell-work/`（壳仓 checkout 嵌在内核仓目录内） | 移到 `~/develop/dsh-supervisor-launcher`，推送通道验证正常 |
| `bin/dsh-supervisor` 图标回退路径 | 删除对 `<内核仓>/.shell-work/src-tauri` 的隐式依赖，改为**只认 `DSH_SHELL_DIR`** |
| `test/session-lifecycle-test.js` 的 6 条断言 | 删除 —— 它们**从内核仓跨仓读取壳仓源码**（`.shell-work/src-tauri/src/*.rs`），属隔离残留；且 P0 修复后语义已过时（壳现在确实会 spawn 兜底，逻辑已迁至 `service.rs`）。壳侧不变量由壳仓自身测试保证 |
| `.gitignore` | 移除 `src-tauri/*`（本仓不得有该目录）与 `dist/export-shell`（脚本已删）条目 |

#### 四、本地工作区清理（释放 53 MB）

| 项 | 原因 |
|---|---|
| `.ssh/` | 见上（安全） |
| `.dsh/`（21 MB agent 记忆库） | 非项目内容 |
| `dist/` | 构建产物；且**含陈旧 0.1.3 版本目录** —— 正是它导致 T6-e 一致性断言假失败（旧版 4 份 + 新版 4 份） |
| `ui-react/`、`ui/dist/` | UI 构建产物（gitignored，`build-ui.sh` 再生） |
| `.darm-fail.log` / `.dx64-fail.log` / `.mac-fail.log` / `.poll4.log` | 陈旧构建失败日志 |
| `dsh-supervisor-AUDIT-REPORT.md` / `dsh-supervisor-REPAIR-PLAN.md` | 陈旧未跟踪审计报告（9-08，已被后续审计取代） |

保留 `ui/node_modules/`（标准依赖缓存，删除会让每次构建都要重装）。

#### 五、测试文件清理（用户特别要求）

对 56 个测试文件做**归属审计**（哪些在测试链上、哪些被 require、哪些是孤儿）：

**结果：无孤儿，无需删除** —— 但发现并修正了**两类真问题**：

1. **`sigterm-desired-test.js` 从未被执行**（不在 `npm test` 链、也不被任何 script 引用），
   但它验证的是一条**硬契约**：「守卫被 SIGTERM 停止后 DSH 的 desired 状态必须保持」。
   连跑 3 次稳定通过（4 断言）→ 已**挂入测试链**（而非删除）。
2. 另 6 个未在链上的文件确认为**辅助模块**（`mock-target.js` 被 7 个测试引用、
   `dry-run-proxy.js` 被 2 个等）或**独立 script 驱动**（`native-test.js` 等），均保留。

清理后：测试链 **47 段**、**无断链**、**无无归属文件**。

#### 六、文档纠错

- **`release/runbooks/publish-and-verify.md` 整篇重写** —— 原版基于已废弃架构，通篇是
  `build:sea`（全平台弃 SEA 后已不存在）、`export-shell.sh`（已删）、错误的仓库名
  （`lobbowen/dsh-supervisor`）、过期的待办（`lobbowen` 的 Secrets）；
- `README.md`：`DESIGN.md` **断链**（该文件不在本仓）→ 指向实际存在的架构文档；
  `build:sea` → `build:launcher`；`verify:shell` → 正确命令；
  「跨平台打包」段由**描述壳仓内容**改为**指向壳仓**；
- `CROSS-PLATFORM-BUILD-AND-UPDATE.md`：删除「经 `export-shell.sh` 单源同步」的说法（脚本已删）；
- `test/core-test.js`：UI 缺失时的失败信息改为**可操作**（原先只打印 `undefined`，
  让人误以为 CSP 逻辑坏了；实为未先执行 `build-ui.sh`）；
- `release/README.md` 与 `LICENSE` 中正确说明壳许可的部分保留。

#### 验证

- 全量回归 **839 passed / 0 failed**（43 个结果文件；较清理前少 6 条 = 删除的跨仓断言）；
- 内核仓目录内**已无** `.ssh` / `.shell-work` / `dist` / `.dsh` / `*.log` / 陈旧审计文档；
- 两仓 `ls-remote` 连通正常（`~/.ssh` 标准位置）。

### 修复：Windows CI 失败 —— 测试用 `\n` 锚定正则解析 workflow，CRLF 检出下失配（本人引入）

#### 事实澄清（先纠正我的失误）

`v0.1.4-BETA.1` 的 CI **确实失败**（Windows job，5 个断言），而我在汇报时只说了「已发布成功」、
**没有检查 tag 触发的 CI 结果** —— 这是我的疏漏。产品本身没有问题（npm 4/4 已发布、四平台
`core.cjs` 同源），失败的是**测试**。

#### 根因（已实测复现）

Windows runner 的 git 检出会把 `build.yml` 转成 **CRLF**（`core.autocrlf`）。
测试里用 `\n` 锚定正则提取 YAML job 段：

```js
code.split(/\n  ([a-z][a-z0-9_-]*):\n/)
```

CRLF 下 job 名后紧跟的是 `\r` 而非 `\n` → **完全失配** → 取到空串 → 5 个断言失败。
而 Linux/macOS（LF）全绿 —— 典型的「只在 Windows 红」。

本机复现验证（把 workflow 转 CRLF 后跑同一测试）：

```
LF   : 全部 PASS
CRLF : FAIL R6-b / R6-d / R6-e / R6-f / R6-g   ← 与 CI 失败列表**完全一致**
```

#### 归属

该解析逻辑由本仓 `042773f`（内核全平台本地构建）引入，属**本人引入的缺陷**。
（`v0.1.3-BETA.3` 之前的旧写法用 `/\njobs:/` 锚定，CRLF 下恰好仍能匹配，故此前未暴露。）

#### 修复

**新增 `test/_workflow.js`（工作流解析单一入口，行尾归一化）**：
- `normalize()` 把 CRLF / CR 统一为 LF，所有下游正则只需处理 `\n`；
- `readWorkflow()` / `readNormalized()` / `stripComments()` / `jobSection()`；
- 规定：凡按行解析 workflow 的测试**必须**经此模块，禁止裸 `fs.readFileSync`。

`release-auth-test.js` 与 `all-platforms-test.js` 均已接入；
并**顺带修掉一处同类缺陷**：`T6-e`（四平台 `core.cjs` 一致性）原先不过滤版本 ——
`dist/launcher` 会累积历史版本的平台目录，导致「旧版 4 份 + 新版 4 份」一起比对而**假失败**
（实测 8 份 / 2 哈希）。现按当前版本过滤（与壳组装器的版本过滤同源问题）。

#### 门禁（防回归）

新增 `test/workflow-parse-test.js`（置于 `npm test` 链第 2 位）：
- **W1** 归一化对 CRLF / CR / LF 结果一致；
- **W2** `jobSection` 在 CRLF 与 LF 下对真实 `build.yml` 结果**完全相同**；
- **W3** CRLF 下必须取到 build / release / precheck 三段且**非空**，
  并**在 CRLF 下重跑原失败断言**（R6-b/d/e/f/g）证明已修好；
- **W4** 任何测试不得裸读 `.github/workflows`。

#### 验证

- 门禁 **15/15 通过**（含 CRLF 下复现原失败断言）；
- 全量回归 **845 passed / 0 failed**（42 个结果文件）。

## [0.1.4-BETA.1]（2026-09-11）

### 修复：测试固定端口落在 OS 动态端口范围 —— 导致偶发假失败

#### 问题（真实 flake，非猜测）

回归中两次遇到**复跑即过**的失败：

```
FAIL instB → base+2（顺序补位）  ← {"port":46003,...}      ← ports-claim-test
Error: listen EADDRINUSE: address already in use 127.0.0.1:39080   ← router-e2e-test
```

根因：**测试把固定端口放在了 OS ephemeral 范围内**。

- `claimSlot` 用 **bind 探测**判断端口可用，而 ephemeral 内的端口会被**任何进程的临时出站连接**
  短暂占用 → bind 失败 → 跳过该端口 → 断言数值不符；
- 生产代码 `ports.js:22,31` 明确要求「选址必须避开 OS 动态端口范围」，**测试自己却违反了它**；
- `router-e2e-test` 与 `token-boundary-test` 更是撞用同一个 `39080` → 必然 EADDRINUSE。

全量扫描发现 **39 个固定端口**落在危险区，涉及 **23 个测试文件**。

#### 修复

**新增 `test/_ports.js`（端口分配单一事实源）**：
- 按测试文件分段（每文件 10 个号），跨文件绝不撞号；
- `safeBase(name)` / `safePort(name, i)` 取端口，未登记的文件会**直接报错**（强制登记，防静默撞号）；
- `freePort()` 动态空闲端口；
- `isSafe(p)` **检查三平台并集**，并叠加本机 `/proc` 实际配置。

**23 个测试文件全部迁移**到安全段（不再硬编码端口字面量）。

#### ⚠ 安全段选取过程中的一次自我纠错（值得记录）

我最初选了 **61000-61999** —— 只考虑了 Linux（`32768-60999`）。
但 **macOS 与 Windows 的动态端口范围是 49152-65535**（RFC 6335 定义的 Dynamic/Ephemeral Ports，
IANA 永不分配），那个段在 mac/win 上**同样危险**。

权威依据（RFC 6335 §6「Port Number Ranges」原文）：

```
o  the User Ports, also known as the Registered Ports, from 1024-49151 (assigned by IANA)
o  the Dynamic Ports, also known as the Private or Ephemeral Ports, from 49152-65535 (never assigned)
```

| 平台 | 动态端口范围 |
|---|---|
| Linux | `net.ipv4.ip_local_port_range` 默认 32768-60999 |
| macOS | `net.inet.ip.portrange` 默认 49152-65535 |
| Windows | `netsh int ipv4 show dynamicport tcp` 默认 49152-65535 |

三平台并集为 `32768-65535`，故安全上界只能到 **32767**；再排除生产池（20000-25999 / 40000-43199），
最终选定 **28000-29999**（与生产池留 2000 号缓冲，且远离边界）。

这条教训已写入 `_ports.js` 与门禁，防止后人重蹈。

#### 门禁（防止回归）

新增 `test/test-port-discipline-test.js`（**置于 `npm test` 链首位**）：
- **T1** 任何测试的固定端口不得落在危险区；
- **T2** 已登记的文件必须经 `safePort()` 取端口（不得硬编码）；
- **T3** 跨文件端口段不得重叠；
- **T4** 安全段自身必须真的安全。

**T1 的实现要点**：「4-5 位数字」≠「端口」是重要教训 —— 实测 `20000` 既是超时毫秒数
（多个测试用它当超时），又恰好是生产池下界，单凭数值无法区分。故 T1 只匹配**明确的端口语境**
（`port: N` / `listen(N` / `127.0.0.1:N` / `localhost:N`），而非「扫描所有数字再过滤」
（后者产生了大量误报）。

#### 验证
- 迁移后全量：**830 passed / 0 failed**（41 个结果文件）；
- 关键测试连跑 5 轮 + 全量连跑 2 轮，均无 flake；
- 门禁 T1-T4 全通过。
### 新功能：壳内镜像源适配（壳装机时无内核，三处下载须自带镜像能力）

用户指正：「安装完壳之后的所有动作，它是没有镜像源的，它是没有内核的 —— 在初始安装完壳的
那一瞬，里面是没有内核的」。据此审计并改造。

**内核侧改动**（壳侧见壳仓 CHANGELOG）：
- 内核 `registry.json` 的**消费方语义**明确化：壳现在会把测速选出的 npm 偏好**导出**为
  该文件，内核读取即继承同一份选择，不再盲选。壳侧已实现「若内核为 manual 模式则不覆盖」，
  以尊重用户在面板 `RegistryCard` 中的显式选择。

**VALUE**: 本次改动使「壳引导阶段选中的最快镜像」与「内核后续使用的镜像」保持一致，
避免两条链路各选一处（用户此前会遇到壳快内核慢或反之）。
### 修复：桌面壳与内核的完整流程审计 —— 守卫服务注册断裂（架构级）

用户要求「把整个桌面壳调查清楚，从检测环境到自动下载运行环境、桌面壳自更新、
内核拉取更新，这些流程是不是都是通的」。逐环节审计后确认：**原设计在首次安装场景下必然断裂**。

**核心发现**：壳只**启动**服务、从不**建立**服务定义；而内核的 `install` 子命令
（唯一会写 systemd unit / LaunchAgent / schtasks 的入口）**不会被任何环节自动调用**，
且 npm 发行包**不含**模板文件。于是全新机器上：守卫服务不存在 → 壳 start 失败 →
引导卡在「守卫就绪」。

**实测证据**：
- 已发布 npm 包内 `systemd/`、`desktop/` 目录均为 0 个文件，无 postinstall；
- 干净 HOME 下实跑 `dsh-supervisor install`：打印「跳过系统服务部署」后返回，服务目录为空；
- 壳仓全部历史中写服务定义的提交数为 **0**（不是回归，是从未通过）。

**本仓（内核）侧改动**：
- `src/platform/os/autostart.js`：Windows 任务名**职责分离** ——
  `DSH-Supervisor` 改由壳建立并指向**守卫守护进程**（原先指向 GUI 壳，导致壳的
  `schtasks /Run` 只会再开一次壳、守卫永远起不来）；GUI 自启改用 `DSH-Supervisor-GUI`。
  关闭 autostart 时改为 `/DISABLE` 守卫任务而非删除（它是服务定义）。
- `bin/dsh-supervisor`：**包根解析 off-by-one** —— 发行态（esbuild bundle）下 `__dirname`
  是包根而非 `bin/`，旧实现 `path.join(__dirname, "..")` 指向包外，导致模板路径错位、
  `BIN_PATH` 指向不存在的文件。改为逐级向上找 `package.json` 定位包根，两种形态均正确。

**壳仓侧改动**（详见壳仓 CHANGELOG）：新增 `service.rs` 自持三平台服务定义 + spawn 兜底；
macOS Node 安装改用 `.pkg`（原 `.tar.gz` 与 `installer -pkg` 格式不匹配必然失败）；
下载超时 60 秒 → 15 分钟（安装包 30-90 MB）；前端开始消费 Node 最低门槛；
内核 `--version` 探测加超时；Windows `.cmd` 垫片的 `--prefix` 推导修复。
### 双仓隔离：壳资产全部移出内核仓（用户 2026-09-11 指出严重违规）

**问题**：内核仓持有大量本应属于壳仓的资产，违反「壳与内核是两个仓」的既定架构。

**已迁出（迁入壳仓，非删除）**：

| 资产 | 原位置（内核仓） | 新位置（壳仓） |
|---|---|---|
| 壳的 npm 打包工具 | `shell-release/` | `shell-release/` |
| 壳设计/审计文档（9 份） | 根目录 `SHELL-*.md`、`AUDIT-SHELL-*.md` | `docs/` |
| 壳仓导出脚本 | `release/scripts/export-shell.sh` | 已不需要（壳仓独立运营） |
| 壳版本提升 | `bump.sh --shell` | `scripts/bump-shell.sh` |
| 壳版本校验 | `verify-versions.js --shell` | `scripts/verify-shell-versions.js` |
| npm 入口 | `npm run export:shell` | 已移除 |

**壳仓已自持**：打包工具、CI、文档、版本脚本齐备，可独立构建/校验/发布，不再依赖内核仓。
壳的版本校验还从「两处互锁」加强为**三处互锁**（新增 `Cargo.lock`）。

**内核仓保留的壳相关内容（均为内核职责，非违规）**：
- `src/domains/shell/`、`src/api/shell.js`：内核需向控制面板提供桌面版本并观测壳健康
  （用户明确要求「桌面版本 + 内核版本」双版本展示）；
- `test/shell-safety-net-test.js`：验证内核侧壳安全网的硬约束（不触碰内核更新机制）；
- `ui/**/AppShell.tsx`、`shell.css`：前端「应用外壳」布局，与桌面壳无关的同名巧合；
- `release/scripts/build-launcher.sh`：内核自身的 launcher 构建（名字里的 launcher 指内核发布形态）。

**文档同步**：`release/README.md` 改写壳发布章节（明确内核仓不参与）、去掉已删入口、
标注双仓隔离边界。

### 修复：桌面壳 Windows 真机三项问题 + 语义统一（详见壳仓 CHANGELOG）
- 卡在检测环境 = Windows `WindowsApps` 应用别名存根被当作 Node + 探测无超时 + 同步命令占主线程；
- 托盘右键失效 = 事件处理未区分按键，右键也被当成「显示窗口」；
- 隐形边框 = Tauri `shadow` 默认 true，官方文档载明会给无边框窗口加 1px 白边；
- 步骤名统一为：检测环境 → 运行环境 → **桌面版本** → 内核版本 → 守卫就绪 → **进入控制面板**。

### 修复：桌面壳引导顺序错误导致首次启动卡死（Windows 真机实测）

#### 现象
用户在 Windows 真机安装桌面壳后，引导页**第一步就是「壳更新」并卡住不动**，无法进入产品。

#### 根因（两个叠加缺陷）

**① 步骤顺序设计错误**（用户直接质疑的点）

原顺序为：`壳更新 → 检测环境 → 运行环境 → 内核版本 → 守卫就绪 → 进入面板`。
把「桌面壳自更新」当成第一步的理由是「新壳才可能带有新的 Node/内核安装要求」，
**该前提不成立**：
- 环境检测与 Node 探测都是**本地**判定，与壳版本无关；
- 用户刚手动安装完桌面壳，此时壳本就是最新，再强制检查更新毫无意义；
- 壳更新是**网络**操作（最慢、最不可靠），放在首位意味着「最可能失败的操作挡住所有后续步骤」。

**② 网络请求无超时 → 永久挂起**

`tauri-plugin-updater` 的 `Config`（tauri.conf.json）**没有 timeout 字段**，只能在 Builder 上设；
而底层 `reqwest` **默认无总超时**。于是网络不可达/连接挂起时（本项目端点用 unpkg CDN，
在部分网络环境下连接会长时间停滞），`check()` 既不返回也不报错 → 前端 Promise 既不 resolve
也不 reject → `.catch` 不触发 → 页面**永久停在「正在检查桌面更新」**，且当时**没有跳过入口**。

#### 修复

**顺序重构**：`检测环境 → 运行环境 → 桌面更新 → 内核版本 → 守卫就绪 → 进入面板`。
本地、快、确定的检查在前；网络类更新放在环境就绪之后。

**多重超时兜底**（三层，任一层生效即不会卡死）：
- Rust：`check()` 用 `updater_builder().timeout(20s)` **加** `tokio::time::timeout` 外层兜底
  （reqwest 的 request timeout 不保证覆盖 DNS 等阶段）；
- 下载用 20 分钟长超时（大安装包 + 慢网）；
- 前端：`withTimeout()` 再包一层（检查 45s / 下载 5 分钟无进展即判定失败）。

**用户随时可跳过**：新增「跳过桌面更新，直接启动」按钮 —— 任何网络类步骤都必须有即时出口，
否则一旦底层挂起，用户除了杀进程别无选择。

**下载进度可视化**：此前进度回调体是空的（`let _ = (chunk, total);`），4MB+ 安装包在慢网下
长时间零反馈，用户无法区分「正在下载」与「卡死」。现每秒级上报已下载/总字节并按百分比显示。

#### 附带修复

- **Windows 上护栏账本失效**：`tauri-plugin-updater` 在 Windows 安装时执行
  `ShellExecuteW` 启动安装程序后**立即 `std::process::exit(0)`**，其后的代码永不执行。
  原实现把 `mark_pending()` 放在 `download_and_install()` 之后 → Windows 上「更新成功确认 /
  连续失败拉黑」机制**完全失效**。现改为**安装之前**记录。
- **`bump.sh --shell` 在开发工作流下必然失败**：该分支硬编码 `./src-tauri`，假设在壳仓根执行；
  而本项目的实际流程是在内核仓根执行（壳仓由 `export-shell.sh` 同步）。现同时支持
  `./src-tauri` 与 `./.shell-work/src-tauri`，并同步更新 `Cargo.lock` 中的包版本。
- **移除「门 0」这一内部概念**：它从未出现在任何需求中，是我自行引入的编号并直接暴露给了用户。
  已全部改为「桌面更新」等直白表述，并在回归测试中禁止其回到用户可见文案里。

#### 回归防护

新增 `src-tauri/tests/bootstrap_flow.rs`（7 断言），锁定：步骤顺序、HTML 步骤条与 JS `stepNames`
一致、引导从环境检测启动、网络步骤必有超时与跳过出口、下载进度已接线、Rust 侧超时与
`mark_pending` 顺序、用户文案不含内部概念。

### 内核「全平台本地构建」：发布不再消耗 GitHub Actions 额度（2026-09-11）

#### 动因（实测数据）

私有仓 Actions 按**倍率**计费：Linux 1x、Windows 2x、**macOS 10x**。本仓 mac/win 矩阵约
**110 分钟/次**，免费额度 2000 分钟/月仅够约 **18 次** —— 已实测耗尽（run #1–#24 正常，
#25 起 job 拿不到 runner、`steps=0`、秒级失败；同时间公开壳仓 4 平台全绿）。
迁移账号只能再买约 18 次，不是根治。

#### 关键事实（本机逐一验证）

| 事实 | 数值 |
|---|---|
| 内核运行时依赖数 | **0** |
| 产物中 `.node` 原生二进制 | **0 个** |
| esbuild 打包参数 | 仅 `--platform=node` + 版本注入，**无平台相关参数** |
| 同一 bundle 在 linux/win32/darwin 覆盖下的 sha256 | **完全一致** |

即：launcher 是**纯 JS 产物**，四平台只差 npm 包名与 `os`/`cpu` 元数据。
故正确做法是**构建一次 → 派生四份元数据包装**，而非「四台机器各构建一次」。

#### 实现

- **新增 `release/scripts/_platforms.sh`**：平台矩阵的**单一事实源**（读取
  `package.json#npmPublish.packages`）。此前平台清单散落在三个脚本 + workflow 硬编码矩阵，
  四处不同步就会产出「少一个平台」的发布。
- **`build-launcher.sh --all-platforms`**：一次 esbuild → 派生 4 个平台目录，并**断言四份
  `core.cjs` 逐字节一致**（不一致即失败）。这从构造上消除了「同版本不同平台代码不同」的风险
  —— 该风险曾真实发生（BETA.2 的 linux/darwin 缺 frpc 修复而 win 有）。
- **`publish-core.sh --all-platforms`**：自递归（每个平台各跑一遍既有单平台路径），
  避免复制「冒烟 + 版本核对 + 组装 + 幂等发布 + 认证」逻辑；任一平台失败即非零退出，
  并提示「可只重跑失败平台」（幂等保证已成功的自动跳过）。
- **`ci-core.sh --all-platforms`**：透传参数（CI 的 mac/win 不使用此选项，避免同平台重复发布）。
- **`release-core.sh --all-platforms`**：新增全平台编排；平台闸放宽为「单平台真发布仍限 Linux，
  全平台模式任何平台皆可」。
- **npm scripts**：`build:launcher:all` / `publish:core:all` / `release:core:all` /
  `release:core:all:publish`。

#### workflow 自动收敛（`precheck`）

全平台本地发布后仍会推送 tag，因而仍触发 workflow。为避免白烧额度，新增 `precheck` job
（ubuntu，约 1 分钟）：用 `npm view` 逐个检查 4 个平台子包在该版本下是否已存在 ——
**已全部存在则跳过整个 build 矩阵**（省下约 110 分钟，含 macOS 10x）；有缺失则照常补齐。
因此无论用哪种模式，tag 推送后都会收敛到「四平台齐备」，且不会重复发布。

#### 验证

- 本机 `--all-platforms` 产出的四份 `core.cjs` **四平台逐字节一致**，且与 CI 在 macOS/Windows
  产出的 BETA.3 包**哈希完全吻合**（`7668aaa13f41c898`）—— 构建可复现。
- 四份子包的 `os`/`cpu` 元数据各不相同且正确（linux/x64、darwin/arm64、darwin/x64、win32/x64）。
- 缺平台时：明确报错、退出码非 0、并提示构建命令；补齐后复跑 4/4 成功。
- 新增 `test/all-platforms-test.js`（34 断言 + `release-auth-test` 的 2 条 workflow 断言）：
  覆盖平台矩阵单一事实源、脚本接线、npm 入口、同源断言、precheck、以及「纯 JS 产物」前提本身
  （含**实测**四平台产物哈希一致）。
- 全量回归：**40 文件 826 passed / 0 failed**。

## [0.1.3-BETA.3]（2026-09-11）

### 发布 0.1.3-BETA.3：修正 BETA.2 的跨平台代码不一致

- **问题**：对比 npm 上 BETA.2 的四个平台子包，`core.cjs` 存在**代码级差异**：
  - `linux-x64` / `darwin-arm64` / `darwin-x64`：`sha256=ad46dda5…`（**缺少 frpc 崩溃修复**）
  - `win-x64`：`sha256=9d68744f…`（含 frpc 崩溃修复）
- **成因**：BETA.2 发布时，修复 `frpc spawn 崩溃` 的提交只在 **Windows job** 先跑完并发布；
  而 mac/win 三平台在更早的相对时间点已完成构建（含更早的 linux 本地发布）。
  npm 不允许覆盖同版本，因此同一版本号下不同平台承载了不同代码。
- **影响**：Linux（本项目主要平台）用户拿到的是**未修复**的版本 —— 当 `frpc` 不可执行时，
  守卫会因未捕获异常而崩溃。
- **处置**：本版以**同一提交**构建全部四个平台，使四份 `core.cjs` 逐字节一致。
  构建顺序：本机 Linux 先产 linux-x64 → 推送 tag 触发 CI 产 mac/win 三平台（同一 tag、同一源码）。
- **附带验证**：本版同时验证新账号 `advgyxqamf` 的 CI 能完整跑通 mac/win 矩阵。

### 仓库迁移至新账号 + 修复一起 SSH 私钥入库事故（2026-09-11）

#### ⚠ 安全事故：私有 SSH 私钥曾被提交并推送
- **事实**：`.ssh/id_ed25519_dshpush`（`wasi7mglns` 账号级私有 SSH 私钥）在 `ae51753` 被 `git add -A`
  扫入仓库，并随 master 与多个 tag 推送到远端。**原 `.gitignore` 只忽略 `*.key`/`*.key.pub`，未覆盖 `.ssh/`**。
- **暴露面**：旧仓为**私有仓**，可读面仅限账号所有者与协作者；全历史扫描**未发现** npm token / PAT 泄露
  （仅有文档中对 `rsign encrypted secret key` 格式的文字说明）。
- **处置**：
  1. `.gitignore` 显式忽略 `.ssh/`、`*.pem`、`id_ed25519*`、`id_rsa*`（**主仓与壳仓同步加固**）。
  2. 用 `git filter-branch` 重写全部历史移除 `.ssh/`，并**同样强制推送到旧仓**，
     使远端历史中的私钥不可达（事后全新克隆验证：`0` 处 `.ssh/`、`0` 处私钥标记）。
  3. 改用**仓库级部署密钥**替代账号级 SSH 密钥 —— 细粒度 PAT **无权管理账号级密钥**（403），
     但可由 API 管理部署密钥，故推送凭据不再需要人工登记。
  4. ⛔ **仍待人工完成**：在 `wasi7mglns` 账号中**删除**那把已泄露的账号级 SSH 公钥。
     删除前该密钥对所有该账号仓库仍有效。

#### 迁移：内核仓 → `advgyxqamf/dsh-supervisor-core`
- **动机**：`wasi7mglns` 私有仓 Actions 额度耗尽（实测 run #1–#24 均分配到 runner，#25 起 `steps=0`、
  无 runner、秒级失败；同时间公开壳仓 4 平台全绿）。根因是计费倍率：**macOS 10×、Windows 2×**，
  本仓 3 job 矩阵约 **110 分钟/次**，免费额度 2000 分钟/月仅够约 **18 次**。
- **过程**（顺序关键）：镜像克隆 → 历史清洗 → **只推 master**（不触发任何 run）→
  **临时禁用 workflow** → 推其余分支与 21 个 tag → 重新启用 workflow。
  禁用这一步**不可省略**：否则每个历史 tag 推送都会触发一次完整矩阵，会瞬间烧光新账号额度。
  实测整个迁移触发 **0** 个 run。
- **验证**：一次性 ubuntu 探针确认新账号可正常分配 runner（`runner_name="GitHub Actions …"`、
  步骤全成功，随后已删除探针）。
- **凭据**：新仓 `NPM_TOKEN` secret 已由 `gh-secrets/set-secrets.js` 写入。

#### 文档
- `release/README.md` 运维条目更新为新仓地址与部署密钥方案；本地 `origin` 与 `core.sshCommand` 已切换。

### 修复：构建冒烟后的目录清理竞态（mac/win 发布失败的最后一环）
- **现象**：CI 中所有测试全绿，却在 `build:launcher` 末尾以 exit 1 结束，报
  `rm: <tmp>: Directory not empty`。
- **根因**：`build-launcher.sh` 用 `kill` 结束冒烟守护进程后**立即** `rm -rf` 其 HOME 目录。
  `kill` 是异步的，daemon 及其子进程仍在写该目录 → `rm -rf` 在遍历期间遇到新建文件而失败；
  脚本是 `set -euo pipefail`，于是整个构建被中止（**测试其实全绿**）。
  属竞态，故时好时坏（同一次 CI 中 darwin-x64 过、darwin-arm64 挂）。
- **修复**：kill 后**轮询等待进程真正退出**（最多 3s）→ `kill -9` 兜底 → `rm -rf ... || true`
  （清理绝不允许影响构建结果）。修复后本机重跑，rm 报错由 1 次降为 0 次。

### 修复：frpc 不可执行时崩溃守卫（两条失败路径都无归宿）
- **缺陷**：`FrpManager.start()` 对 `spawn` 的两条失败路径都没有处理：
  ① **同步抛出**（Windows 上把非可执行格式当程序 spawn → errno -4094 / code UNKNOWN）：
     原代码未捕获 → 调用方乃至整个守卫进程崩溃；
  ② **异步 emit `error`**（二进制存在但不可执行：权限不足 / 架构不符 / 目标是目录）：
     原代码**没有 `child.on('error')` 监听器** → Node 视为未捕获异常 → 守卫崩溃。
- **修复**：`spawn` 包 try/catch 降级为 `{ok:false, ...}`；并新增 `child.on('error')`
  记录日志、清空 child、按既有退避策略排期重启。
- **测试**：`frp-resilience-test.js` 新增 R4（把 `binPath` 设为**目录**以触发不可执行路径），
  断言不抛出且 child 被清理、进程存活。

### 修复：`frp-resilience-test` 在 Windows 上不可运行（测试夹具的平台限制）
- 该测试用 **POSIX shell 脚本**（`#!/bin/sh` + `sleep`）冒充 frpc 可执行文件，
  Windows 无法执行该格式（spawn 同步抛出）。属夹具限制而非产品缺陷。
- Windows 上显式 **SKIP** 并打印原因（不静默变绿）；产品侧「spawn 失败不得崩溃」已由上述修复保证。

### 修复：mac/win 平台发布长期 ENEEDAUTH（关键根因）
- **现象**：macOS/Windows 的 CI 真发布恒在 `npm publish` 报 `ENEEDAUTH`，平台子包长期缺失。
- **根因**：npm 把环境变量按 `npm_config_*`（**不分大小写**）映射为配置项，两者都落到 `userconfig`，
  且**小写 `npm_config_userconfig` 胜出**。CI 中 `npm run publish:core` 由 npm 自身注入
  `npm_config_userconfig=$HOME/.npmrc`，我们 `export NPM_CONFIG_USERCONFIG=<临时 token 文件>` 因此被忽略，
  npm 转去读 runner 的无 token `~/.npmrc` → ENEEDAUTH。
- **为何长期潜伏**：本地 `~/.npmrc` 恰好有 token，即使读错文件也能认证成功 —— 本地完全无法复现。
- **对照实验**（同一台机、HOME 干净以排除掩盖）：
  - 大写=token + 小写=无token → `npm error code ENEEDAUTH`（与 CI 一致）
  - 大写=token + 小写=token   → `lob.bowen`（修复后）
- **修复**：`_npm-auth.sh` 新增 `dsh_npm_auth__apply()`，设置 userconfig 时**大小写同时写**；
  `snapshot`/`cleanup` 同时快照与还原两者（避免留下指向已删临时文件的悬空值）。
  5 条解析分支统一走该函数。回归测试新增 R3-f/g/h 三条断言。

### 修复：Windows 上跨平台路径断言恒失败（测试自身的正则错误）
- `cross-platform-test.js` 用 `replace(/\\\\/g, '/')` 归一化路径 —— 该正则匹配的是**两个**反斜杠，
  而 Windows 路径只有单个反斜杠 → 替换不生效 → 断言在 Windows CI 上恒失败
  （Linux 因 `standardDirs` 返回正斜杠而侥幸通过，属平台掩盖）。
- 改为归一化「任意连续分隔符」`replace(/[\\/]+/g, '/')`，与平台无关。

### 修复：GitHub Release 附加的并发竞态 + 同名资产冲突
- **缺陷**：`Attach to GitHub Release` 原先写在 build **矩阵内部**，3 个 job（win/mac-arm64/mac-x64）
  会**并发**向同一 Release 上传（实测 CI #19：darwin-x64 成功、darwin-arm64 在同一步骤失败）。
  且各平台 `dist/launcher/**` 含**同名文件**（如 `core.cjs`），直接挂载会互相覆盖。
- **修复**：拆出独立的 `release` job（`needs: build`，仅 tag 触发，只跑一次）：
  先 `download-artifact` 汇总，再按平台打成**唯一命名**的
  `dsh-supervisor-launcher-<ver>-<platform>.tar.gz`，最后一次性挂载；并断言产物非空。
- build job 的 `permissions` 相应收敛为 `contents: read`。

## [0.1.3-BETA.2]（2026-09-11）

> **为什么跳过 BETA.1 直接发 BETA.2**：BETA.1 的 linux-x64 子包在「relay 端口偏好」修复**之前**
> 构建并发布；npm **不允许覆盖已发布版本**，且**已 unpublish 的版本号永不可重用**
> （实测 403 You cannot publish over the previously published versions）。
> 若继续用 BETA.1，则 Linux 是旧代码、mac/win 是新代码 —— 同版本不同代码。
> 故以 BETA.2 作为**代码一致**的正式发布；BETA.1 的 Linux 包成为弃用残留（beta dist-tag 已指向 BETA.2）。

### 修复：relay 槽位偏好硬编码池外端口（导致内核 CI 连续 5 次失败）
- **缺陷**：relay/manager.js 为 main 硬编码 preferred: 40000，而 2026-09 端口池重构后 relay 段为
  20000-23999 → 该偏好落在池外，破坏「所有 relay 端口都在池内（避开 OS ephemeral 32768-60999）」的不变量。
- **为什么长期未暴露**：本机 40000 恰被占用 → claimSlot 回退到池内 → 测试侥幸通过；
  CI 净环境 40000 空闲 → 直接绑定 40000 → ports-verify 失败。
  该失败使内核仓 CI **自 #9 起连续 5 次失败**，**mac/win 平台长期无法发布**。
- **修复**：main 的建议槽位改为派生自池定义（ports.rangeOf("relay").base）。
  现有安装不受影响：已持久化的 wanPort 走 hasPersistedBinding 原样复用。
- **回归守卫**：ports-capacity-test.js 新增源码级断言，禁止该硬编码复活。

### 修复：发布编排漏推分支，导致 tag 推送不触发 CI
- **缺陷**：release-core.sh 只执行 git push --tags，从不推分支。
  实测后果：tag 指向的提交不在任何分支上时，**GitHub 不为该 tag 触发 workflow**（匹配 run 数为 0）。
- **修复**：改为 git push origin HEAD --tags；相关文档/提示同步修正。

### 修复：内核仓误把壳仓收为 gitlink（无 .gitmodules）
- **缺陷**：git add -A 把本地壳仓克隆目录 .shell-work/ 收成了 mode 160000 的 gitlink，
  而仓库并无 .gitmodules → CI 检出后 git submodule foreach 报 No url found for submodule path。
- **修复**：从索引移除该条目（工作区文件保留），并将 .shell-work/ 加入 .gitignore。

### 修复：发布脚本的 GNU/BSD 不可移植断言
- release-auth-test.js 用 stat -c %a 读权限 —— 该写法仅 GNU 有效；macOS(BSD) 需 stat -f %Lp。
  结果是该断言在 **macOS CI 上恒为空值并失败**（CI #16 的失败点）。已改为两者回退。

### 新增：发布幂等性
- publish-core.sh 在真发布前先查该版本是否已存在：存在则**跳过并核对 unpackedSize**，
  避免「部分平台已发、部分失败」时重跑被 403 卡死（npm 无「只补发缺失平台」入口）。

## [0.1.3-BETA.1]（2026-09-11）

### 关于卡：双版本呈现 + 内核/桌面壳一起检测（2026-09-11）
- **背景**：本产品由两个独立组件构成、各有独立版本线——桌面壳（Tauri，`dsh-supervisor-gui`）与
  内核（守卫，`dsh-supervisor`）。原先「关于」只显示一个「当前版本」，语义有歧义。
- **改造**：
  - 「关于」拆为两行：**桌面壳版本** 与 **内核版本**；壳版本取 `~/.dsh/shell/identity.json`（经 `/shell/status`），内核版本取 `/guard/version`。
  - **检查更新改为两者一起检测**：内核走 `/self-update/status`（npm 子包；源码形态回退 git 上游检查），桌面壳走新增的 `/shell/check-update`（查 `@dsh-sup/shell-release` 的 npm latest）。
  - 两者任一有更新用警示色汇总提示；各自提供独立更新入口。
  - **版本号不再带 `v` 前缀**（按要求直接显示纯版本号）。
- **新增后端**：
  - `domains/shell.checkUpdate(dist, opts)`：复用内核同一份 `semverCompare`，支持「远端更低不报可更新」（不降级）。
  - `domains/shell.restartShell(opts)`：**应用壳更新 = 重启桌面壳**（壳自更新发生在启动时的门 0）。
    先 SIGTERM 旧壳 → 有界等待 → 必要时 SIGKILL → 确认退出后才拉起新壳（壳有 single-instance 插件，
    旧实例未退时新实例会「唤起旧窗口后自行退出」，等于没重启）。新壳 detached + unref。
  - 新增 API：`POST /shell/check-update`、`POST /shell/restart`（已登记 API 契约面）。
- **测试**：`test/shell-safety-net-test.js` 扩至 34 断言（新增 R8 版本检测 7 项、R9 重启 3 项）。
  其中 R9 通过可配置的 `procPattern` 注入不存在的进程名，**确保单元测试不会误杀开发者本机真实运行的壳**。
- 全量回归：**39 文件 781 passed / 0 failed**；UI typecheck / lint / 15 项单测全绿。

### 本地端到端预演：JS 工具链 ↔ Tauri 契约打通（2026-09-11）
- **预演目标**：在**不安装、不触碰用户系统**的前提下，证明「我们发布链路产出的东西」正是 **Tauri updater 会接受**的东西。
- **方法与设计要点**：为使用**Tauri 自己的依赖**做验证（而非我们自己理解的格式）：
  - 验签用 `minisign-verify` —— 与 `tauri-plugin-updater` 内部**同一个 crate**（其 `verify_signature` 即 base64 解码 → `PublicKey::decode` → `verify`）；
  - 清单用 `tauri_plugin_updater::RemoteRelease` —— 由 **Tauri 自己的 Deserialize 实现**解析。
- **新增 `src-tauri/tests/updater_artifacts.rs`（6 项验收，全部通过）**：
  | # | 验收项 | 结果 |
  |---|---|---|
  | V1 | 清单可被 Tauri 的 `RemoteRelease` 解析（平台键/url/signature 齐备） | ✅ |
  | V2 | 产物签名用 **tauri.conf.json 里的公钥**验证通过（4,546,278 字节） | ✅ |
  | V3 | **篡改产物 → 验签必须失败**（安全底线） | ✅ |
  | V4 | **换一把公钥 → 验签必须失败**（防任意密钥绕过） | ✅ |
  | V5 | 公钥来自配置文件且结构合法（152 字符，可被 minisign-verify 解码） | ✅ |
  | V6 | **真实工具链往返**：用 `assemble-shell-pkg.js` + `make-manifest.js` 生成的清单被 Tauri 接受，且签名验证通过 | ✅ |
- **V6 是闭环关键**：它证明 JS 发布工具链的输出与 Tauri 契约**一致**（此前只能靠人工比对格式）。
- **接入壳仓 CI 作为产物门禁**：新增「产物验收」步骤（`SHELL_REHEARSAL_DIR=dist/npm-shell cargo test --test updater_artifacts`）——**缺签名或格式不符即构建失败，绝不静默发布不可用于自动更新的产物**。
- **`export-shell.sh` 补携带 `tests/`**：此前只导出 `src capabilities bootstrap icons`，验收测试不会被带到壳仓 CI（会直接失败）。已修正并验证导出结果含 `tests/`。
- **顺带修掉一个真实的测试 flake**：`test/instance-upgrade-test.js` 原先用**固定端口 35910/35911**，前一次运行的 socket 处于 TIME_WAIT 时触发 `EADDRINUSE`，会**中断整个测试链**（实测发生）。已改为向内核申请空闲端口（`listen(0)`），彻底消除。
- 全量回归：**39 文件 768 passed / 0 failed**。
### 内核侧壳更新安全网（P1/P3）落地：闭环完整（2026-09-11）
- **定位澄清（避免越界）**：内核**不是**壳的更新源（壳直连 npm CDN 自更新，冷启动即可用）；内核做**安全网**：预取 / 备份 / 观察 / **有界回退** / 审计。理由：壳不受监督（无 systemd 单元，崩溃无人拉起），而内核是 `Restart=always` 常驻服务——壳被更新坏掉时内核**很可能仍在运行**，是唯一能救它的角色。
- **新域 `src/domains/shell/index.js`**（纯函数式，无状态）：
  - `identity()`：读壳在启动最早期写入的 `~/.dsh/shell/identity.json`（含 `attempt` 自增、`phase`、`version`）——**壳完全起不来时也能判断「该版本反复失败」**，这是回退决策的核心输入。
  - `markPending(from,to)` / `readJournal()`：维护更新账本 `update-journal.json`（内核权威）。
  - `evaluate()`：状态机 `idle / pending / confirmed / should-rollback`。
  - `health()`：壳阶段上报；**`phase=ready` 即更新确认信号**。
  - `rollback()`：把坏版本加入 `pinnedVersions`（壳门 0 读取后不再尝试）+ 清空账本（**防循环**）。
- **新 API 域 `src/api/shell.js`** + `surface.js` 契约登记 4 条 + `/shell/` 前缀：`GET /shell/status`、`POST /shell/health`、`POST /shell/update-pending`、`POST /shell/rollback`（写操作走 `originAllowed` 同源校验）。**无** `/shell/update/check`——因为内核不是更新源。
- **⛔ D6 硬约束以测试固化**：`test/shell-safety-net-test.js` 断言安全网**不 require dist、不调用 runNpmInstall、不写内核版本状态、不触碰内核状态目录**——内核既有四条更新路径零改动。
- **物理隔离**：壳用 `~/.dsh/shell/`、内核用 `~/.dsh/supervisor/`（测试断言两者不同）。
- **端到端闭环实测**（隔离 HOME 模拟）：无更新 → idle；安装完成告知 → 账本建立；以目标版本上报 ready → **confirmed**；坏版本（壳起不来，attempt=2）→ **should-rollback**；执行回退 → 坏版本拉黑 + 账本清空 → **回归 idle，不再反复判定**。
- 新增 `test/shell-safety-net-test.js`（21 断言，覆盖账本/确认/回退/防循环/硬约束/域归属）；全量回归 **39 文件 768 passed / 0 failed**。
- **待后续（已明确，未仓促实施）**：① 面板展示壳版本与更新状态（`/shell/status` 已就绪，UI 卡片待加）；② 内核**预取**（提前下载壳产物到 `~/.dsh/shell/cache/`，使门 0 从本机秒级完成）；③ 有界回退的**自动触发**（当前 `evaluate()` 已产出 `should-rollback` 判定，尚需接到心跳与通知）。
### 桌面壳门 0 落地：三平台自更新行为一致（2026-09-11）
- **依赖**：`tauri-plugin-updater` + `tauri-plugin-process`（`app.restart()`）。
- **新模块 `src/update.rs`**（236 行）：
  - `init_identity()`：启动最早写 `~/.dsh/shell/identity.json` + `shell.log`（**壳此前零日志**，任何「打不开」都无法诊断——这是结构性修复）。
  - `install_kind()`：识别运行时安装形态（deb/rpm/appimage/msi/nsis/app）。
  - `self_update_capable()`：形态受支持 **且**（Linux）有 pkexec/sudo 提权通道。
  - **循环护栏**：`attempt` 计数 + `pendingVersion` + `pinned` 黑名单；以非 pending 版本启动即计失败，达 2 次拉黑该版本（防「更新成功但版本比对仍认为需更新」的无限重启）。
  - `should_check()`：不可自更新/已拉黑/达阈值 → 跳过（**绝不阻断启动**）。
- **四个命令**：`shell_identity` / `shell_update_check` / `shell_update_apply` / `shell_restart`（+ `shell_set_phase`）。
  **三平台同一代码路径**：check → download → **minisign 验签（强制）** → 平台安装 → 重启；平台差异（Linux `pkexec dpkg -i` / macOS `.app` 替换 / Windows NSIS `passive`）**全部由插件内部处理，壳侧无平台分支**。
- **引导页门 0**（`bootstrap.html`）：
  - 步骤条新增「壳更新」并置于**最前**（壳更新 → 环境 → Node → 内核 → 守卫 → 面板）——新壳才可能带有新的 Node/内核安装要求。
  - **失败选择页**（用户定案）：显示【重试更新】【继续使用当前版本】；**【继续】始终可用**（有界失败即放行的用户可见形式）。
  - 离线/清单不可达/已拉黑 → **失败放行**，不阻断。
  - `stepPanel()` 上报 `phase=ready` = **健康确认信号**（内核据此确认壳更新成功并清 journal）。
  - 诊断信息扩充：壳版本/安装形态/自更新能力/attempt/pinned/门 0 结果。
- **无头自检 `--shell-update-plan`**：输出壳更新基线并**实际写一次** identity.json + shell.log，供 CI 冒烟与人工诊断。
- **端到端实测（deb 内二进制）**：`install_kind=deb`、`self_update_capable=true`、`should_check=true` → **门 0 会在真实安装形态下启用**（裸 `target/release` 二进制为 `unknown/false`，符合预期）；落盘 identity.json + shell.log 验证通过。
- **构建验证**：`tauri build --bundles deb` 成功，产出 `deb` + `.deb.sig`（正式密钥签名）。
- 全量回归：**38 文件 747 passed / 0 failed**（先前 8 处失败经单独复跑确认为环境残留，非代码回归）。
### 桌面壳自更新签名密钥（minisign）正式生成 + 发布链路打通（2026-09-11）
- **正式密钥已生成并保存**（用户要求用正式密钥，不用测试密钥）：`tauri signer generate` → 私钥 `~/.tauri/dsh-supervisor.key`（0600）、公钥 `~/.tauri/dsh-supervisor.key.pub`（644）。
- **备份已完成并演练**：`~/.tauri/backup/`（0700）含时间戳副本 + `README.txt`；已比对 sha256 一致性并通过**恢复演练**（用备份解出后指纹一致）。指纹：私钥 `92e3ae43ed4dea58`、公钥 `d5ffd60103af390a`。
- **防泄漏加固**：两个仓的 `.gitignore` 均加 `*.key` / `*.key.pub`；已核查「导出包/壳仓工作区/git 追踪项」**均无私钥**。
- **三平台统一配置**（`tauri.conf.json`）：`createUpdaterArtifacts: true` + `plugins.updater.pubkey`(152 字符) + 双 CDN 静态清单端点（unpkg 主 / jsdelivr 备）+ Windows `installMode: passive`。
- **关键设计修正**：Tauri 的 `{{target}}`(linux|windows|darwin) 与 `{{arch}}`(x86_64|aarch64) **与 npm 包命名不同**（linux|win|darwin、x64|arm64）——把变量直接拼进包名会产生不存在的包。故改用**静态清单**，让 URL 构造只发生在一处。
- **两个发布工具（单源，内核 `shell-release/`，经 `export-shell.sh` 导出到壳仓）**：
  - `assemble-shell-pkg.js`：把「安装包 + `.sig`」成对组装为 npm 包；**缺 `.sig` 即失败**（防静默发布不可更新产物）。
  - `make-manifest.js`：汇总各平台条目 → Tauri 静态清单 `shell-manifest.json`（含平台键映射与签名）。
- **已用真实产物端到端验证**：`tauri build --bundles deb` → `deb 3.8MB` + `.deb.sig 420B`（base64 minisign）→ 组装为 `@dsh-sup/shell-linux-x64` → 生成清单，`linux-x86_64` 正确映射到 `shell-linux-x64` 的 unpkg URL。
- **⛔ 实测关键约束**：本密钥为 `rsign encrypted secret key` 格式，**不设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 会签名失败**（`failed to decode secret key: incorrect updater private key password`）——CI 必须显式提供该 secret（空值也要设）。
- **CI 补齐发布链**：新增 `version` job（版本单源）与 `publish` job（聚合各平台产物 → 生成并校验清单 → 发布 `@dsh-sup/shell-*` 与 `@dsh-sup/shell-release` 到 npm），仅 tag 触发。
- **新增运维手册**：`release/runbooks/updater-signing-key.md`（密钥保管、CI 配置、备份验证、轮换代价；**不含私钥内容**）。
- 全量回归：**38 文件 747 passed / 0 failed**。
### 壳仓 CI 改造 + 本地端到端验证（2026-09-11）
- **壳仓 CI 重写**（`src-tauri/launcher-build.yml`，经 `export-shell.sh` 同步到壳仓 `.github/workflows/build.yml`）：
  - **触发改仅 tag + workflow_dispatch**（F5）——原 `push main` 会每次全平台构建，浪费额度。
  - **矩阵改为 4 平台**：`ubuntu-22.04`(linux-x64, `deb,rpm`) / `windows-latest`(win-x64, `nsis,msi`) / `macos-latest`(darwin-arm64, `app,dmg`) / **`macos-15-intel`**(darwin-x64, `app,dmg`)。
  - **Linux 基座固定 `ubuntu-22.04`**（glibc 2.35，F1 修复）+ **`glibc_max: 2.35` 门禁断言**。
  - **废弃 AppImage**；Linux 安装 `rpm`（供 rpmbuild）；`tauri.conf.json` targets 改 `[deb,rpm,dmg,nsis,msi]`。
  - **签名接入**：`TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` 环境变量 + `.sig` 收集；**未配密钥时不产 .sig 并 `::warning::`，不阻断构建**（开发/验证友好）。
  - 产物收集与 Release 挂载同步更新（`.deb/.rpm/.dmg/.app.tar.gz/.exe/.msi/.sig`）。
- **本地端到端验证（V2）**：`npx @tauri-apps/cli@2 build --bundles deb` **成功（2m37s）**：
  - 产出 `dsh-supervisor_0.1.0_amd64.deb` **3.8MB**（与预估完全一致）。
  - `Depends: libayatana-appindicator3-1, libwebkit2gtk-4.1-0, libgtk-3-0`。
  - **自带 `.desktop` + 图标**（`usr/share/applications/dsh-supervisor.desktop`）→ 印证「标准包应自带桌面集成」。
  - **证明 Tauri 容忍 config 中跨平台 targets**（Linux 上含 dmg/nsis/msi 不报错）。
- **🎯 F1 修复机制的直接证明**（严格校验，链接成功且产物 507KB 真实存在）：
  | 链接目标 | 最高 glibc 需求 | pidfd 符号 |
  |---|---|---|
  | 宿主 libc **2.39** | **GLIBC_2.39** ❌ | 2（被解析 → 硬性 verneed） |
  | **sysroot libc 2.35** | **GLIBC_2.34** ✅ | 2（保持未解析 → 无 verneed） |
  即：**链接目标降到 2.35，2.39 需求即消失** —— 与「在 ubuntu-22.04 基座构建」等效，修复方案得到本地直接证实。
- **门禁落地到壳仓**：`ci/check-glibc.sh`（内核 `ci/` 单源 → `export-shell.sh` 导出到壳仓）；已用本地构建产物验证能正确拦截（2.39 > 2.35）。
- **诚实记录一次自我纠错**：中途一次 sysroot 实验因 `libc.so.6` 路径取错导致链接失败，我的判定脚本误报「证明成功」（空二进制无输出被当成通过）；已修正路径并用「链接成功 + 产物存在性」严格前置校验后重测，得到上述真结论。
### 构建链路验证：Rust 工具链就绪 + F1 缺陷根因定位（2026-09-11）
- **Rust 工具链**：本机原无 toolchain（rustup 1.29.0 存在但无 default）。经 **rsproxy 镜像**安装 **rustc/cargo 1.98.1**（官方源实测仅 18KB/s，rsproxy 9MB/s；cargo 镜像配置已存在，未改动用户配置）。
- **构建验证成功**：`.shell-work/src-tauri` 执行 `cargo build --release` **通过，耗时 3m52s**，产物 8.5MB ELF；系统依赖（libwebkit2gtk-4.1-dev / libgtk-3-dev / libayatana-appindicator3-dev / librsvg2-dev）齐全。
- **⛔ F1 缺陷决定性确证**：下载 Ubuntu 22.04 的 `libc6 2.35` 并解包，用其 `ld.so` **真实加载**本机构建的产物 → `version GLIBC_2.39 not found` → **确认无法在 Ubuntu 22.04 运行**（非推测）。
- **🎯 根因定位（最小复现，两行代码）**：`fn main(){}` 仅需 GLIBC_2.34；加入一次 `Command::new("/bin/true").status()` 即跳到 **GLIBC_2.39**（含 2 个 pidfd 弱符号）。根因链：**Rust 官方预编译 std 的 `process` 模块**含对 `pidfd_spawnp`/`pidfd_getpid`（glibc 2.39 新增）的**弱引用**；在 glibc 2.39 基座链接时被本机 `libc.so.6` 解析成功 → 记录**硬性 verneed**；在 2.35 基座上该符号不存在 → 弱引用未被解析 → **不产生版本需求** → 二进制通用于旧系统。排查中**排除**了 tokio（仅注释中提及）、libc crate 与本项目代码。
- **修复方案确证充分**：CI 基座改 `ubuntu-22.04`（glibc 2.35）——根因是**链接期弱符号解析**，换基座即从根上消除，无需任何 hack。与 Chrome / VS Code 的「在最老受支持基座上构建」一致。
- **新增防线（已落地并验证）**：`ci/check-glibc.sh`（断言产物最高 GLIBC 符号 ≤ 上限，并用真实产物验证能正确拦截）+ `test/glibc-gate-test.js`（7 断言，含平台守卫）；经 `export-shell.sh` **单源导出**到壳仓 `ci/`，避免两处漂移。
- 全量回归：**38 文件 747 passed / 0 failed**。
### 跨平台审计：修正「只按本机 Linux 想」的产品缺陷（用户批评驱动）
- **缺口承认**：此前方案只按本机（Linux Mint 22.3 / Ubuntu 24.04 基座）考虑，把 Linux 当单一形态，且未展开 macOS/Windows 的构建、签名与自更新全链路。作为一个**公开发行的跨平台桌面产品**，这是缺陷。
- **⛔ 实测确认的必修缺陷（F1）**：已安装 deb 声明 `Depends: libwebkit2gtk-4.1-0`，且二进制实测要求 **`GLIBC_2.39`**（因在本机 Ubuntu 24.04 基座构建；glibc 前向兼容）。后果：**当前公开 deb 只能装 Ubuntu 24.04+**，把最主流的 **Ubuntu 22.04 LTS（glibc 2.35）与 Debian 12（2.36）用户全部排除**。
- **修复**：CI 基座改 **`ubuntu-22.04`**——已实测该基座提供 `libwebkit2gtk-4.1-0`（`2.50.4-0ubuntu0.22.04.1`，security/universe），覆盖扩至「Ubuntu 22.04+ / Debian 12+ / Fedora 36+」。
- **新增门禁（已落地）**：`ci/check-glibc.sh`（断言产物最高 GLIBC 符号 ≤ 上限）+ `test/glibc-gate-test.js`（7 断言，含平台守卫，非 Linux 优雅跳过）。已用当前生产二进制验证：**正确报出 2.39 > 2.35 失败**，防该缺陷回归。
- **GitHub runner 精确核实**：`ubuntu-22.04` / `ubuntu-22.04-arm` / `macos-latest`(arm64) / **`macos-15-intel`(x64，实测存在)** / `windows-latest` / `windows-11-arm`。据此**修正**「GitHub 已无 Intel macOS runner、darwin-x64 需交叉编译」的旧判断——**可原生构建**，避开交叉编译的签名风险。另注 `macos-14` 已弃用。
- **额度事实**：壳仓为**公开仓（MIT）→ GitHub Actions 标准 runner 免费**，故跨平台矩阵不受额度约束（可按覆盖优先设计）；只有私有内核仓受额度限制（这也是内核 Linux 本地生产的由来）。
- **三平台自更新链路明确**：Linux → Tauri `install_deb`（`pkexec dpkg -i`，需一次密码）；macOS → 替换 `~/Applications/*.app`（**必须签名+公证**，硬性）；Windows → NSIS per-user `passive` 静默（**建议代码签名**；WebView2 运行时依赖）。
- **新增权威文档**：`CROSS-PLATFORM-BUILD-AND-UPDATE.md`（构建矩阵、各平台更新链路、发布流程、风险登记、待实测项）。
- 新增风险 K15b（glibc 基座）、K16（webkit ABI）、K17（macOS 签名公证）、K18（Windows WebView2）。
### 决策 D4：Linux 废弃 AppImage，采用标准 Linux 安装包
- **决策（用户）**：Linux 废弃 AppImage，按**标准 Linux 包机制**（deb，可选 rpm）分发。
- **与现状契合**：已取证 `dpkg -S /usr/bin/dsh-supervisor-gui` → `dsh-supervisor: /usr/bin/dsh-supervisor-gui`，**当前生产本就是 deb 安装**，D4 让分发与现状一致，无需用户迁移形态。
- **净收益（实测支撑）**：体积 77MB → **3.8MB（20×）**；更新耗时约 45 秒 → **约 2 秒（20×）**。
- **自更新仍成立**：Tauri 源码 `Some(Installer::Deb) => self.install_deb(bytes)`（实现为 `pkexec dpkg -i`），代价是**更新时一次密码确认**（标准系统包固有属性）。
- **同步修正**：内核 `desktop/` 模板指向 `~/.local/bin`，与 deb 的 `/usr/bin` **不一致** → 以 deb 为准修正路径解析并保留用户级回退。
- **新增权威文档**：`RELEASE-AND-UPDATE-MECHANISM.md` —— 发布与更新机制总纲（两条独立发布链、产物矩阵、端到端时序、与内核更新机制的边界、风险登记）。
- 新增待实测 V1（Tauri 是否为 deb/rpm 生成 `.sig`；若无则自行 `tauri signer sign`）、V2（deb 缺依赖时的 `dpkg -i` 报错形态）；新增开放项 N2b（是否加 rpm）、N4（是否发布 apt/yum 仓库）。
### 壳更新通道定案（实测驱动）：npm CDN，而非 GitHub Release
- **实测结论**：GitHub Release 直连**不可用**——`objects.githubusercontent.com` 15s 完全超时；真实产物下载实测仅 **15–28 KB/s**（3.8MB deb 15.6s 只下 231KB）。77MB AppImage 需约 45 分钟，且 **Tauri 传输超时会先触发 → 更新永远失败**（不是「慢」而是「不成」）。
- **对照**：npmmirror（内核在用）1.44 MB/s；**npm CDN（unpkg）大文件实测 1.71 MB/s**，与内核镜像同级。这一发现**恰好印证内核既有机制的正确性**——内核/DSH 早就因同样原因走 npm 镜像。
- **源码级验证**：Tauri `ReleaseManifestPlatform { pub url: Url }` 为**通用 URL、无域名白名单**，且 `verify_signature` 独立于托管位置 → 换 CDN 不影响安全性；同时 `endpoints` 改公网 HTTPS 后**不再需要** `dangerousInsecureTransportProtocol`（去掉一个安全妥协）。
- **定案**：壳产物发布为 npm 包 `@dsh-sup/shell-<os>-<arch>`，清单 `shell-manifest.json` 经 unpkg/jsdelivr 直链提供；**零新增基础设施**（复用已有 npm 发布流程与凭据）。
- **重大修正**：先前判断「Linux 只有 AppImage 可自更新、deb 用户出局」**是错的**——Tauri `install_deb` 通过 `pkexec dpkg -i` **支持 deb 自更新**。而 **deb 仅 3.8MB，比 AppImage 小 20 倍**（更新耗时 45 秒 → 约 2 秒），代价是一次密码确认。新增决策项 N2。
- 新增风险 K13（npm CDN 第三方可用性 → 多 CDN 回退 + 内核本地缓存兜底）、K14（deb 提权被拒 → 选择页重试/继续）。
### 设计修正（用户确认驱动）：壳更新失败选择页 + 内核更新机制不可触碰
- **定案 1（用户确认）**：壳更新失败**不静默放行**，改为显示选择页 **【重试】【继续使用当前版本】**；【继续】必须始终可用（有界失败放行的用户可见形式）；离线与 `installKind=deb` 不进选择页，直接放行 + 提示。
- **定案 2（用户明确要求）**：**不得破坏内核既有更新机制**。已取证内核侧四条更新路径并全部保持原样：① 守卫自更新（**全更新强制语义**：latest > 当前即装，无跳过无降级 + 磁盘版本校验 + 重启后复核）；② 原生 DSH 更新（唯一 `_runInstall` + 自动回滚 + `installedVersion` 校验闭环）；③ 沙箱实例更新（带 `--prefix`，每实例独立）；④ manifest 通道（`selfUpdateManifestUrl` 默认 null，当前未启用）。
- **发现并修正原方案缺陷**：原 P6.2「`core.rs` 按壳声明选择版本」会**用壳的策略推翻内核的全更新强制语义**（可能把已是最新的内核装上旧版）；原 P6.4「整对回退」会让**壳的故障污染内核版本**。已改为：壳只做兼容性检查、不兼容时**唯一允许动作是先升级壳**；回退时**只回退壳自身**；**禁止互相降级**。
- **新增隔离保证**：壳用 `~/.dsh/shell/`、内核用 `~/.dsh/supervisor/`（物理隔离）；壳账本 `update-journal.json` 与内核 `_selfUpdateExpectedVersion` 不同命名空间；`pinnedVersions` **只针对壳版本**；P1 复用 `dist` 仅限**只读**能力（`fetchLatestVersion`），**不调用** `runNpmInstall`、不写内核版本状态。
- **新增风险 K12**：壳侧逻辑越界扰动内核更新 → 以 P6 硬约束 + 隔离保证缓解。
### 设计：桌面壳稳定与热更新执行方案（含一次架构修正）
- **定案**：保留 Tauri 原生壳（桌面级产品形态）。产出 `SHELL-STABILITY-AUDIT.md`（故障模式审计）、`SHELL-NATIVE-STABILITY-DECISION.md`（架构决策）、`SHELL-EXECUTION-PLAN.md`（P0–P7 执行方案）。
- **架构修正（用户质疑驱动）**：原设计把**内核**同时当作「更新权威 + 产物提供方」，却又要求壳**在内核之前**完成自更新——**自相矛盾**：冷启动/内核未安装/内核损坏时内核不在，壳拿不到更新，只能「下次启动生效」，恰在最需要它的时刻失效。
- **修正**：拆开两个角色——**壳直连公网发布通道自更新**（冷启动即可用；壳本就直连 nodejs.org/npm 镜像，具备 HTTPS 能力）；**内核只做安全网**（预取/备份/观察/有界回退/审计），不再提供 `/shell/update/*` 端点。
- **净收益**：① 冷启动自洽（满足「启动即更新壳」）；② **不再需要** `dangerousInsecureTransportProtocol`（端点改公网 HTTPS，天然满足 Tauri 的 TLS 强制）；③ 壳与内核之间不再有「更新协议」需同步演进。
- **引导顺序**（按用户诉求并精化）：只读环境探针 → **门 0 壳自更新** → 门 1 Node → 门 2 内核 → 门 3 守卫/面板。壳更新排在 Node 之前，因为新壳可能带有不同的 Node 要求，且每个写动作都应由最新版本的壳执行。
- **新增关键约束（已核实）**：Tauri updater 为**原地安装，不保留旧版本** → **更新前必须备份当前产物**，否则新版本坏掉时磁盘上无退路（风险 K11）。另：Tauri 多端点回退**仅对非 2XX 生效**，网络超时不会回退 → 「离线即放行」必须由壳自己控制。
### 发布认证标准化（2026-09-10）：单一解析器 + 规范位置
- **真实故障**：npm token 曾散落在某个 DSH 沙箱实例的 home 下（`instances/<id>/data/.npmrc`），只有在那一个沙箱里发布才成功；换沙箱即 `ENEEDAUTH`。根因是认证解析依赖 `$HOME`，而 DSH 沙箱会把 `$HOME` 指向实例数据目录。
- **单源实现**：新增 `release/scripts/_npm-auth.sh`，`publish-core.sh`（读）与 `configure-credentials.sh`（写/自检）共用同一份解析；解析顺序 `DSH_NPMRC` → `NPM_CONFIG_USERCONFIG` → `NPM_TOKEN`(临时 userconfig) → **真实 home/.npmrc** → `$HOME/.npmrc`。
- **规范位置**：真实用户 home 下的 `~/.npmrc`（0600）。用 `getent passwd`/`dscl`/`~user` 展开定位，**不受 `$HOME` 覆盖影响**——任何沙箱、任何 shell 下发布行为一致。
- **自检同源**：`configure-credentials.sh --check` 改用与发布完全相同的解析器判定，消除「自检说没配、发布却成功」的错位。
- **临时 userconfig 语义修正**：`cleanup` 现在精确**恢复**调用前的 `NPM_CONFIG_USERCONFIG`（原实现只删临时文件，会留下指向已删文件的悬空值）。
- **真发布缺认证时快速失败**：`publish-core.sh --publish` 无任何认证时立即退出并给出三条配置指引（dry-run 不校验认证）。
### 发布链路：Linux 改本地生产（GitHub 额度优化，2026-09-10 定案）
- **平台分工调整**：`linux-x64` 子包改由**本地 Linux 机器**生产（`npm run release:core:publish`：完整门禁 → commit+tag+push → 本地直推 npm），不再消耗 GitHub Actions 额度；`win-x64` / `darwin-arm64` / `darwin-x64` 仍由 CI 矩阵生产。
- **CI 矩阵去 ubuntu**：`.github/workflows/build.yml` 仅保留 mac/win 三平台；原常驻 `ubuntu-latest` 的 `ui-verify` 作业移入本地 `release-core.sh`（每次发布必跑，不漏跑）。Linux launcher 构建物不再挂 GitHub Release（npm 即其分发通道）。
- **真发布平台闸**：`release-core.sh --publish` 在非 Linux 平台直接拒绝（exit 2）并提示走 tag 触发 CI——防止与 CI 形成同平台二次发布（npm 同版本不可重发）。
- **发布顺序可回退**：改为「先 tag+push（标签可删；CI 需时间）→ 再本地发 linux 子包」，避免旧的「先发 npm 后 push」一旦 push 失败即「已发布但无 tag」的不可补救状态。
- **认证不再污染开发机**（安全修复）：原 `ci-core.sh` 执行 `npm config set registry` + `npm config set //registry.npmjs.org/:_authToken`——前者把开发机默认 registry 永久改成官方源（用户平时用镜像源），后者把 token **明文写入 `~/.npmrc`**。现认证单源收敛到 `publish-core.sh`：有 `NPM_TOKEN` 则写入**临时 userconfig**（`NPM_CONFIG_USERCONFIG`，退出即删），否则沿用既有登录态；发布脚本不再改动全局 npm 配置。

### 修复：实例管理 / 原生 DSH「检测到新版本却始终升级失败」
- **实例升级根因 R1（主因）**：`startInstance()` 的并发守卫 `tasks.isBusy('instance', id)` 会**挡住升级作业自身**——升级走到「装完 → 重启并验证」时调用 `startInstance(id)` 返回 `{ok:true}` 却**从未拉起 systemd 单元**，于是等端口 40s 判「升级后实例未能启动」→ 回滚 → 回滚同样被挡 → 最终「升级失败」。修复：新增 `fromUpgrade` 直通，升级与回滚两处显式传入（非升级路径的并发互斥语义不变）。
- **实例升级根因 R2**：`waitPortHealthy()` 在「剩余时间 < stabilityMs」时**直接 break 判失败**——端口其实已健康（只是探测来得晚），慢启动实例被误判并触发不必要回滚。修复：改用剩余预算做缩短稳定期复检；实例升级验证窗口 40s → 120s（与原生 `verifyDeadlineMs` 同量级）。
- **误导性错误文案**：删去「可能是新版 DSH 与已装插件不兼容」的归因（真实原因是单元从未启动）。

### 修复：远程控制 · 公网访问（FRP）「配了 frps 却始终不运行」
- **根因 RC1**：UI 的「保存并应用」**从不提交 `enabled`**（后端 `syncFromInstances` 要求 `settings.enabled === true`）→ 恒为默认 false。
- **根因 RC2**：**无实例级「公网暴露」UI 入口**——后端 `/lan/frp/expose` 全仓零消费者 → `[[proxies]]` 数恒为 0。
- **根因 RC3**：**无访问令牌 UI 入口**，而公网暴露有安全闸（无令牌拒绝暴露）。
- **根因 RC4**：后端 `list()` 不下发 `frpEnabled/frpRemotePort`，`listLan` 白名单会剥离字段 → UI 无法回读状态。
- **健壮性**：`frpc` 默认 `loginFailExit=true` → 连不上 frps 即退出且**不重试**（隧道永久失效）；显式写 `loginFailExit = false`（frp 原生自愈）+ 新增非预期退出的**有界退避自动重拉**（2s→60s，最多 5 次，稳定 60s 后重置）。
- **安全**：`frpc.toml` 含 auth.token 明文但实测权限为 `664`（同机他用户可读）→ 构造时经平台层 `fileProtect` 加固为 `0600`（Unix chmod / Windows icacls）。
- UI 新增：公网访问**总闸开关**、每实例**公网暴露**（远端端口 + 开关）、**访问令牌设置**（含 `tokenSet` 状态提示）。

## [0.1.2-BETA.7]（2026-09-09）

### 双仓拆分定稿（2026-09-09）：壳/核彻底分离，发布永不错位
- 单仓 `lobbowen/dsh-supervisor` 拆为双仓并迁至账号 `wasi7mglns`：
  - **内核仓** `wasi7mglns/dsh-supervisor-core`（私有，本仓）：bin/src/ui/systemd/release + 文档，`npm` 子包发布产线
  - **壳仓** `wasi7mglns/dsh-supervisor-launcher`（公开）：src-tauri 引导器形态（MIT），GitHub 安装程序产线
- **核仓产线自足化**（本版本核心）：剥离壳依赖——`ci-core.sh` 移除壳前端组装/壳集成冒烟（归壳仓职责），步骤重排为 verify(--core)→npm test→build:launcher→子包发布；`build.yml` 去掉 Rust/cargo/apt 壳依赖步骤；`verify:versions` 仅校验内核 package.json 单源（壳版本互锁随壳仓剥离）。内核 launcher 为纯 JS（Node ≥18），无 Rust/系统库依赖。
- 壳仓首次 CI（launcher-build）产出 Linux 桌面安装程序 `.deb/.AppImage`——用户下载安装的桌面程序。

## [0.1.2-BETA.6]（2026-09-09）

### 跨平台架构整改：全平台弃 SEA 统一 Node launcher 发行形态
- Node SEA 在 macOS 上注入后段错误（最小 SEA 亦崩，铁证=上游缺陷）→ 全平台改发 Node launcher（esbuild bundle + bin 启动脚本），darwin/win/linux 统一可发布
- 修 4 处 Linux-only 假设：pgrep -af、macOS 无 timeout、SIGTERM 语义、0600 权限断言
- darwin-x64 runner macos-13→macos-14（GitHub 弃用 macos-13）

### 发布自动化工程化（2026-09-09）：散落脚本收拢为专一 `release/` 发布工程
- **单一发布工程根 `release/`**：`release/scripts/`（9 个发布脚本从根 `scripts/` 迁入 + `ci-core.sh` CI 核心 + `release-core.sh` 一键编排）、`release/runbooks/`（publish-and-verify / verify-desktop 手册迁入并**纳入 git 追踪**）、`release/README.md`（唯一端到端 SOP）。根 `scripts/` 已移除。
- **CI 逻辑单源本地可跑**：`.github/workflows/build.yml` 变薄壳，矩阵各步调用 `release/scripts/ci-core.sh`（verify → 壳前端组装 → 壳冒烟 → npm test → build:sea → 子包 dry-run / tag 触发时 `--publish`）；顺修原 workflow `if: runner.os ==  + Linux +` 语法 bug（→ `'Linux'`）。
- **一键发布编排**：`npm run release:core`（dry-run：干净树预检 → verify:versions → build:sea → 子包 dry-run → CHANGELOG 段检查 → 发布清单）；`npm run release:core:publish`（真发 + commit + tag `v<内核>` + push --tags 触发 CI）。
- **版本与发布入口不变**：npm scripts（build:sea / publish:core / verify:versions / verify:shell / export:shell / release:guard）命令名保持原样，仅内部路径改指向 `release/scripts/`。

## [0.1.2-BETA.5]（2026-09-08）

### 内核自更新部署形态闭环（2026-09-08）：安装目标=运行目标，重启链路可观测
- 背景：生产实测「面板点击更新后无动作」——apply 把新内核 npm 装到了 global 段，而本机部署是源码开发形态（systemd ExecStart 指向开发目录 bin 壳），装出的 SEA 二进制与运行位无关，永远不生效；且 restart 被 guardRestartAllowed 未配置闸死，两层叠加 = 用户视角「点了没反应」。
- A1 部署形态判定（platform/deploy.js 单源）：detect() 依运行位文件 magic 头判 sea-binary/source-shell；非标准形态显式拒绝自更新（不再假装成功）；`DSH_DEPLOY_FORM` 环境变量供测试/CI 注入。
- A2 自重启能力按形态自动判定：SEA 形态自动允许（systemctl restart），删除 guardRestartAllowed 人工配置门槛；重启前落盘预期版本，重启后 status 校验达标才报成功（guard_self_update_verified 事件），闭环可观测。
- A3 双版本口径：/guard/version 返回 runningVersion（进程固化）与 diskVersion（运行位实况），不一致即 updatePending=true（status 同步暴露）——根除「version 旧 + commit 新」的自相矛盾呈现。
- B 内核自更新下载源强制官方 registry：镜像 tarball 曾 stale（拉出旧版本二进制），真相源与下载源统一；镜像继续服务沙箱安装等大流量场景。
- C 壳（launcher）内核定位文案对齐 @dsh-sup；bootstrap 引导页内核缺失时一键 `npm i -g @dsh-sup/dsh-core-<platform>-<arch>` 标准产品包（原仅提示语），轮询兜底放宽至 10 分钟。
- 回归：guard-update 23/23（S1-S3 用 SEA 模拟形态对齐、S8 断言改无 systemd 单元指引）；deploy 判定双形态验证。

## [0.1.2-BETA.3]（2026-09-08）

### 月额度冻结/解冻语义定稿（2026-09-08）：信号=权威，快照只展示——修复 99% 灰区冻结/解冻死循环
- 现象：账号月额度用到 99%（余额剩几美分）时，面板不显示限额状态，请求持续失败；事件日志显示账号在 frozen/ready 间秒级死循环（生产实测 1 分钟内同一账号 frozen→recovered 各 4 次，累计 25 轮）。
- 根因：上游 400 insufficient credits 是「月额度不足以服务请求」的权威信号，冻结正确；但冻结后的补探测拉到 billing 快照（percent=99<100、remaining>0）不满足冻结阈值 → applyDetection 误判「已恢复」解冻 → 下一请求再挑中再失败再冻结。快照（滞后、粗粒度、Math.round 抹掉 99.33%）推翻了即时权威信号——两口径打架。
- 语义定稿（用户拍板）：**信号=权威，快照只展示**。credits 冻结的解冻不再回判阈值，只认正向恢复证据：① 月度重置到期（periodEnd）② 余额较冻结时刻回升（充值，冻结时记录 limit.creditsAt 基线）。
- 落地：applyDetection 解冻分支增加 credits 冻结证据门槛（无正向证据 → 维持冻结，quota 快照仍刷新供展示）；_setLimit 同 kind 重建保留 creditsAt 基线；quota-strategies 的 subscriptions（periodEnd）拉取条件放宽为「凡 credits 冻结即取」（灰区冻结也需精确恢复时刻，维持 6h 缓存）。
- 回归：新增 test/monthly-credits-freeze-test.js（冻结/维持/充值解冻/到期解冻/旧数据兼容/正常账号不受影响 8 场景）；upstream-credits 78、commandcode-quota 14、router 18 全绿。

## [0.1.2-BETA.2]（2026-09-08）

### 内核自更新版本检查直查发布权威源——修复镜像同步延迟漏报
- fetchLatestVersion 增加 `authoritative` 选项：自有发布包（内核自更新）的版本真相源 = 官方 registry.npmjs.org；镜像（npmmirror 等）同步存在分钟~小时级延迟，把『镜像未同步』误判为『已是最新』是真相源错误（生产实测：0.1.2-BETA.1 发布后面板检查更新漏报）。
- selectRegistry 按延迟选镜像继续服务安装下载流量——查询元数据与下载流量语义分离。
- authoritative 源解析：配置列表含官方源则用之；测试注入非官方列表（mock）尊重注入；空列表回退默认官方。

## [0.1.2-BETA.1]（2026-09-08）

### 全量代码审计与结构性修复（2026-09-08）：安全信任根/意图模型/执行契约/事件系统四层归位

第三方视角全量审计（约 2.3 万行）发现 1×P0、5×P1、12×P2、20+×P3，全部按结构根因修复（非补丁），详见 dsh-supervisor-AUDIT-REPORT.md 与 REPAIR-PLAN.md。

- **P0 安全（信任根错位）**：API 访问者身份改由 `src/api/identity.js` 依 `req.socket.remoteAddress` 判定——此前 Host/Origin 头可伪造导致「局域网窃取 DSH 会话令牌 + apiAccessKey 门卫被绕过」；Host 头职责归位防 DNS-rebinding，Origin 头归位防跨站驱动。
- **P1-1 adopt 观察窗绕过**：`_tokenReclaimAt` 等瞬态字段未在构造期初始化（undefined ≠ null）→ 接管后首拍即重建 DSH（实测 565ms，设计应观察 20s）。新增 `guard/intent.js` 意图登记簿 + 构造契约根治。
- **P1-2 畸形 URL 3 连崩**：`/lifecycle/%E0%A4%A` 触发未捕获 URIError → 守卫 60s 内 3 次 uncaughtException 自杀重启循环。API 分派器升级为统一异常边界（同步抛错/Promise reject 一律兜底 500），路径解码收敛单点。
- **P1-3 升级后不自动拉起**：守护开关（默认关）误拦升级恢复——升级完成经 `upgrade-resume` 显式意图穿透；upgrade-test 从 6 项 FAIL 回归全绿（此前 npm test 实为 EXIT=1 被管道掩盖）。
- **P1-4 shutdown 期望状态竞态**：`stopAll` 翻转 DSH desired 依赖 exit 竞态——契约化 `stopAll(reason, { exclude })`，守卫退出永不含 dsh；`shutdownAll` 显式持久化 stopped。
- **P1-5 锁 fail-open**：守卫单实例锁非 EEXIST 错误改 fail-closed（双守卫并存风险）。
- **P2 系列**：升级作业 catch 契约（不再永久 running 锁死实例）、stopInstance systemctl 超时、UI 缺失 503（不再 TypeError 崩溃环）、loghub 水位绑定写成功、事件轮转原子化、LogCore 聚合流路径冲突断言、relay 端口回收 configPath 注入（防误杀其它配置的 lan-daemon）。
- **P3 系列**：switcherAutoStart 死迁移复活、bump.sh SemVer 数值比较、CLI events 参数位、CLI 兜底端口对齐、`_findManagedDshPort` 劫持收窄、facade 危险键词表、测试卫生（退出兜底清理残留进程）。
- **死代码清理**：ensureMainInstance/_mainInstance/_syncMainEntry、token 重复扫描段。
- **测试基建**：新增 api-fuzz-test（伪造身份/畸形输入/存活断言）与 sigterm-desired-test（P1-4 契约门）；smoke/upgrade 退出兜底清理防残留污染；全量 npm test 625 PASS / 0 FAIL / EXIT 0。

### 账号锁定语义定稿（2026-09-05 A）：锁只对可用账号有意义——死锁不落盘/不复活/可拒锁
- 背景：遗留 selectedAccountKeyId 指向早已冻结的账号（8AEkNh，月额度耗尽，与其余限额账号同一冻结状态机），
  无任何逻辑让其跟随账号生命周期（仅 banned/discarded 清锁、无解锁入口）→ UI 死锁徽标/持久化死锁残留。
- 语义（用户拍板 A）：账号因任何原因冻结（额度任意窗口/封号/作废/不存在）即锁失效；恢复后由用户按需重新显式锁定。
- 落地：base._reconcileLock()（serialize 前置收敛 + _setStatus 冻结/封号/作废即清锁 + 加载后收敛丢弃死锁）；
  aux.setSelectedProxyKey 拒绝锁定不可用账号；死锁不落盘、重启不复活。
- 回归：router-test 3c / p2p-router F 改 A 语义断言；reconcile 新增 R14（冻结清锁/序列化不落盘/加载收敛）；全量 npm test exit 0。

### 端口管理激活失真修复（2026-09-05）：_portActives 改 TCP 探测——不再依赖 pid 映射
- 表现：前端端口管理所有 proxyInstance 无激活（41038 真实在监听而 active=false）。
- 根因：_portActives 用 findListeningPid（/proc/<pid>/fd 反查 socket→pid）判激活；对本环境守卫管理树
  （router-daemon 反代孙进程）fd 读取受限返回 null → 恒 inactive。真实监听与 pid 映射无必然关系。
- 修复：改为纯 TCP connect 探测（infra/probe.portListening，300ms）——与端口是否监听直接等价、
  与 infra/ports 判占用同语义、零 /proc 权限依赖、三平台一致；保留 3s TTL 缓存。
- 效果：实测 41038 active=true(7ms)/死端口 false；端口管理恢复真实状态。

### 智能路由复检之二：前端「账号切换/在用漂移」= 守卫回退陈旧本地视图（2026-09-05）
- 表现：前端看到 Kbobt7 在用、三账号轮转、锁定账号(8AEkNh)怪异——而 daemon 事件里并无对应流量/切换。
  实测 3100 /router/providers 在【daemon 真值】(2NVZWA 在用) 与【守卫内嵌陈旧副本】(Kbobt7 在用 + MxULq9 ready，
  07:36 快照随守卫常驻) 两态间 ~1/3 概率交替 → 前端每几秒整卡重渲染。
- 根因：Node≥19 http.globalAgent 默认 keepAlive=true（连接池化），守卫经 ctl 调 daemon 复用长连；而 ctl server
  未设 keepAliveTimeout（Node 默认 5s 回收空闲连接）→ 守卫复用已关 socket → 间歇 'socket hang up'（全天内 ~2s 一条
  WARN）→ routerProviders 回退守卫陈旧视图（监督模式下守卫内嵌 router 本不应再对外供数）。
- 修复：router-ctl server 设 keepAliveTimeout=65s（与供应商端点对齐）+ headers/request 超时上探——长连不再被
  服务端空闲回收。router 与 lan 共用本 ctl 模块，两 daemon 一并受益。
- 效果：修复后 40×1.5s 采样单一指纹、WARN 归零。
- 遗留（另立专项）：守卫内嵌 router 陈旧副本在监督模式仍可能被兜底路径外供（建议 last-good 缓存，需守卫重启）；
  lan-daemon 全天慢性重启（05-30min 一次，'lan-daemon 失联重新拉起'）致远程控制周期性掉线，独立子系统问题待查。

### 智能路由复检根治：账号切换根因（2026-09-05：停服孤儿化 / adopt 楔死 / 超时不自愈）
- 表现（实测复现）：健康常驻账号的实例楔死后（CPU 110% 旋转、completion 全挂而 /health 秒回），每次请求撞上 →
  15s 上游 connect 超时 → 换账号冷启动重试 → 前端「在用」跳变、账号不断切换（5 个真实请求中第 4 个从 wvr3t4 跳到 2NVZWA）。
- 根因链（代码确认 + 实证）：
  ① 停服孤儿化：stopInstance 的 SIGKILL 兜底是 unref 1.5s 定时器，router-daemon 随即 process.exit → 定时器随进程消亡
     永不触发 → 子进程孤儿化、stdio 管道死（426880/677630 两次实锤，重拉后 reparent 到 systemd）；
  ② adopt 复用不安全：重启幸存者的 stdout/stderr 读端属于已死 daemon，首个请求写日志即 EPIPE 楔死（677630 实测），
     且 /health 健康探针检测不到「completion 挂死 + CPU 旋转」类病态 → 认领复用无安全判据、adopt 后请求日志永久丢失；
  ③ 上游超时不自愈实例：net-error 路径先清 pid 再 markInstanceNetFail（内部 !pid→return，请求级熔断成死代码），
     且超时从不重启实例 → 楔死实例持续被撞 → 每次请求跳账号。
- 修复（三层根治）：
  - 停服必杀：stopInstance(inst, force) 支持停服强制路径（stopAllInstances 一律 force——在用/在途 defer 仲裁只用于
    运行期收敛，停服若沿用会把在用实例放过关停 → 孤儿，三次实锤）；stopInstance 登记 _terminatingPids 台账；
    RouterService.stopAndWait + provider.waitAllStopped 轮询确认子进程已死（zombie 亦视为已死：SIGKILL 已投递、
    端口/stdio 已释放），未退即 SIGKILL 进程组兜底；router-daemon 优雅退出改为 await stopAndWait 后再 exit。
  - 幸存者禁 adopt：_doStart 认领前置保留（claimSlot 之前、绑定端口、等释放），但同 pkg 幸存进程一律 SIGKILL 弃用重拉
    ——实例 stdio/env 必归当前 daemon；删除失效的后置 adopt 块。
  - 超时自愈：forward-core net-error 区分 timeout（connect 15s/response 180s）→ restartInstance('upstream-timeout')
    实例级 kill+同端口重拉（2min 退避），非超时网络错才清 pid 走按需激活。
- 回归：reconcile-instance-test R11 改为弃用重拉语义 + 新增 R12（停服台账/忽略 TERM 进程 SIGKILL 兜底）R13（超时重启同端口）；
  53 断言全绿；全量 npm test exit 0。

### 智能路由实例管理架构收敛（2026-09-05：reconcile 唯一决策者）
- 背景/根因：反代实例启停此前由 7 条各自写 if 的并行路径驱动（ensure/stopIdle/prewarmByQuota/probe/refresh/请求按需/生命周期），互相无仲裁——实况 41012 端口 5min 周期 prewarm+reclaim 死循环（prewarm 只看 percent>=80 不看可用性，预热已限额账号后回收同 tick 停掉，再预热）。
- 决策（用户拍板）：1) usage 纯派生（从 activeAccount/实例实况算，不落盘）；2) 常驻 1（resident）+ 至多 1 备胎（仅当常驻将耗尽 >=80% 且存在更低占用可用账号）。
- 落地：
  - providers/proxy.js 新增 reconcile 引擎：residentAccount / desiredRunningAccounts / _runReconcile / reconcileInstances（单飞互斥 _reconcileBusy）/ reconcileNow；resident 服务跟随 activeAccount + 内存 sticky 兜底；备胎只选 usable 最低占用者（绝不为不可用账号预热）；stopInstance 空安全 + 无一次性 timer（孤儿直接回收）；_retryPendingStop 请求结束补刀。
  - providers/base.js 状态单事实源：删 validity / 持久化 usage 双字段；usageOf 纯派生；markWarming/markIdle 死代码删除；一致性守卫 serialize 前置 ready+满额归位 frozen+limit（矛盾态不落盘）。
  - forward-core.js 在途计数接线（inflight 原只读不写=死保护）：begin/end 计数 + 归零补刀；取代旧一次性 2.5s timer（命中在途即空放永不重排的泄漏根因）。
  - index.js 清理 _primaryAccountKey/_prewarmByQuota/refresh 尾重复 reconcile；probe/refresh 用 isDesiredAccount 同源判定。
  - providers/proxy.js 重启幸存者认领前置（2026-09 复检根治）：adopt 判定提前到 claimSlot 之前、针对持久化绑定端口执行——原逻辑在 claimSlot 之后只看新分端口，绑定端口被上一代幸存进程（重启后 reparent 到 systemd/init 继续服务的残留）占用时 claimSlot 先 bindingLost 迁移 → adopt 永不触发 → 每次重启残留幽灵进程 + 绑定漂移（实测 41028 孤儿）；现健康幸存者认领复用（pid 接管探活/停止）、不健康 SIGKILL 后同绑定端口全新拉起——不漂移、不留幽灵。
- 回归：新增 reconcile-instance-test（R1-R11，40 断言：常驻/备胎可用性/孤儿收敛/在途补刀/单飞/交替请求资源有界/usage 派生/一致性守卫）；router-test 18、p2p-router 42、ensure 8、upstream-credits 71、commandcode-quota 14 全绿；全量 npm test exit 0。

### 上游 insufficient credits 自动切换（2026-09-04）
- 根因（用户指正）：Command 预付 credits 耗尽时上游回 400 insufficient credits/billing/balance；
  forward-core 旧逻辑把 400 一律当业务拒绝透传 → 一直打到空余额 key，不切换。
- 修复：classifyUpstreamLimited 按 状态+响应体 区分 credits(预付余额)/window(时间窗配额)/none；
  400/402/429/403 出现 credits 信号 → markCreditsExhausted（冻结+10min 周期回探）+ 本请求换下一账号重试；
  isAccountUsable/applyDetection 纳入余额阈值（monthlyRemaining<0.5 即不可选/保持冻结，充值后自动解冻）；
  ProxyProvider 停实例+冻结+预热下一个。非额度 400 仍透传（业务拒绝语义不变）。
- test/upstream-credits-test.js 15 断言并入 npm test；回归 router16/commandcode8/p2p-router40/p2p-api27 全绿。
- 实测：空余额 key(…EkNh) 已冻结不再被挑，有余量 key(…ULq9) 承载流量；单 key 池耗尽将返回
  all accounts exhausted(429) 并留日志，不再以空 key 反复 400。
## [未发布]

### 注入可诊断层（2026-09-04，docs/token-management.md §七）
- relay 内置注入状态（tokenSet/cookieReady/lastOkAt/lastError/lastErrorAt）+ 事件
  lan_cookie_exchanged/failed/invalidated（带实例 id）；LanManager.list 附 inject；
  sup.listLan() 白名单外显（含 inject，令牌永不下发）。
- /lan-access 每实例可读注入状态；前端远程控制页显示「远程就绪/正在注入/令牌缺失」徽标（title 给失败原因）。
- 「远程访问不了」定位路径：面板实例徽标 + lastError + 事件流，不再靠 401 猜。
- 回归：relay-dshauth / token-boundary 12 / lan-daemon 10 / p2p-api 27 全绿。
## [未发布]

### DSH 令牌注入稳定性根治（2026-09-04，docs/token-management.md §六）——「远程访问不了」实证修复
- 长驻实例令牌滚窗丢失：capture 只回看 journald 最近 400 行，启动即打印的 token 行早已滚出 → 令牌恒空 →
  relay 无 cookie 401（实测 inst-…920 启动 18h+ 未重启即此症）；修复为 journalctl -g 取最近一条 URL 行。
- 回填被实例 phase 卡住：InstanceManager 原仅 RUNNING 分支 ensureCaptured；孤立/长驻实例守卫重启后
  永不回填；改为 tick 对 sandbox 无条件 ensure（服务内节流）。
- lan-state churn：_syncLanState 每 30s 因 updatedAt 重写 → lan-daemon 全员重换 cookie；改稳定内容哈希。
- 实测：920 修复后守卫重启 5s 内 40003→200；40000/40001/40003 全 200。
## [未发布]

### DSH 访问令牌管理梳理与收敛（2026-09-04，docs/token-management.md）
- **梳理结论**：令牌已有唯一节点（DshTokenService：attach 登记源 → capture(journald/stdout 最新行)/feedLine
  → get/onChange 分发），非「无主分散」；真正问题是**节点外的边界残留/泄露/落盘**。
- **P1 泄露修复（高危）**：/lan-access 直出各实例 dshToken（真实会话令牌）且面板允许 LAN 访问 → 绕过
  F1「token 永不出本机」；sup.listLan() 两路（本地/L3b 门面）剔除 token/dshToken。
- **P2 持久化收敛**：instances.json 历史遗留 dshToken 列载入即剔（内存断行），线上文件已清。
- **P3 日志脱敏补洞**：守卫 stdout 实时镜像改走脱敏完整行，dsh-supervisor journald 不再残留 token 明文。
- **边界固化**：docs/token-management.md 载明「谁能持 token」裁决表；test/token-boundary-test.js（9 断言）
  并入 npm test。守卫重启 #10 后 dshTokenCaptured true、relay 40001 200、daemon 不受影响。
- 后续可选（未做）：lan-state token 改 ctl push；relay 内部缓存收敛为单一 owner；前端 type 移除 dshToken 字段。
## [未发布]

### L3b lan(relay) daemon 解耦上线（2026-09-04，docs/L3-process-decoupling.md + config.lanDaemon=true）
- **lan-daemon 独立进程**（src/service-daemon/lan-daemon.js）：远程控制（40000 主 relay + 4000x 实例 relay + frpc）
  不再驻守卫——守卫重启不影响远程控制（实测：lan-daemon/router-daemon pid 跨守卫重启不变，relay 在线）。
- 数据流：守卫写 lan-state.json（实例清单+令牌，原子 0600，事件驱动+30s 兜底）→ daemon 2s 轮询 diff →
  reconcile/applyToken 热换；relay 端口注册表独立（ports-lan.json）；43108 ctl（复用 router-ctl dispatcher）。
- 守卫委托：listLan/setLanFrp/frpStatus/lanFrpc/syncFrpc 经 lanApi() 门面；api.js /instances /lan-access /lan/frp
  改 Promise 兼容；守卫 30s 监督拉起失联 daemon；lan-daemon.lock 管理锁（同 router 三重门）。
- **守卫 shutdown 不停 daemon 修复**：lifecycle router/lan 适配器 stop 在 sup._stopping 时豁免（曾致每次守卫
  重启 SIGTERM router-daemon 并持久化 routerAutostart=false）。
- **pidlookup 修复（关键）**：/proc/net/tcp 数据行 inode 实测第 9 列（勿按表头取列——表头 12 名 vs 行 17 列）；
  ss 兜底（异 pidns 环境 /proc fd 扫描不可见宿主进程时经 netlink 归因 pid，补 /usr/sbin PATH 候选）。
  危害：探测恒 null → 守卫 30s 监督每轮重复拉起 daemon（stray 堆积）、DSH adopt 失效。
- **daemon 拉起仅限真实守卫**：_ensureRouterRuntime 对无 configPath 实例（测试 Supervisor）一律 embedded，
  杜绝测试在探测不可见环境把 router-daemon 拉成 stray。
- 清理：本会话早期未门控测试曾向生产 Command 供应商写入 pk-2 测试账号（已 discarded）——经 daemon 路径移除，
  账号恢复 14 零丢失。
- 验证：守卫重启 #6 后 lan/router daemon pid 不变（守卫重启不影响被管模块，L3a/L3b 语义实证）；relay
  40000/40001 代理 200；全量回归：p2p-api 27、smoke 34、lan-daemon 10、adopt 13、guard-update 23 等全绿。
## [未发布]

### L3 监督模式状态一致性修复（2026-09-04，HANDOFF #4 定案 + #3 前端迁移）
- **router 控制经 ctl 转发 daemon（#4）**：router-daemon 新增 127.0.0.1:43107 ctl 控制口（POST /ctl {method,args}，
  同步/异步/异常统一语义）；守卫 routerApi() 门面在 daemon 监督模式下全量转发——此前守卫本地 RouterService 副本
  persist 关、不 live 同步 → 视图陈旧（daemon 刷新后守卫仍是旧快照）、写操作不落盘 daemon 无感知（双脑）。
  实测：守卫视图=daemon 一致；refresh/activate/deactivate 经守卫落到 daemon 并持久化。
- **daemon 模式三重门判定（隔离修复）**：routerDaemonActive() = routerAutostart ∧ 管理锁（stateFile 同域
  router-daemon.lock）∧ 43011 监听为 router-daemon；spawn/接管落锁、停止清锁；异主 daemon（测试内嵌等）一律
  退回内嵌语义。根治 p2p-api-test 误接生产 daemon（曾把测试 provider 写操作打到线上、/router/stop 误杀生产 daemon）。
- **守卫 30s 监督 tick**：router-daemon 期望运行但失联 → 自动重新拉起（事件 router_daemon_supervised；实测
  kill 后 15s 内自动恢复）。
- **#3 前端迁移统一 /lifecycle**：OverviewPage DSH 启停、RouterPage 路由启停改调 /lifecycle/{id}/start|stop
  （client.ts 增 lifecycle*、删旧 start/stop/restart/routerStart/routerStop；types.ts 增 Lifecycle 类型）；
  lifecycle router 启停适配器改走守卫 setRouterRunning（daemon 感知，/lifecycle/router/restart E2E 通过）。
- **单测**：新增 test/router-ctl-test.js（9 断言）；p2p-api-test 27/27 全绿（隔离回归验证）。
## [未发布]

### 守卫重启根源审计定案（2026-09-04，见 docs/guard-restart-audit-20260904.md）
- **定案**：无外部神秘重启者——显式重启（journald 有 Stopping 行）= DSH 会话部署 restart（主因）；
  观感「无人操作也重启」= 崩溃自重启（Failed with result exit-code/signal，无 Stopping 行，systemd 自动拉起）。
- **实证**：8 月多次数小时连续崩溃循环（8/22 exit-code 每 5s、8/28 SIGKILL 每 ~10s）即历史频发观感来源；
  9 月仅 2 例：09-04 05:09 nodeLtsStatus 部署中间态未捕获异常 3 击自退、05:41 SIGKILL（agent 测试），均查实为自崩溃。
- **取证法**：守卫重启先按 Stopping 有无分类；signal 死亡查 code=killed, status=9/KILL。
## [未发布]

### 守卫重启后远程访问令牌不可达修复（2026-09 第四轮：adopt 令牌接管）
- **问题**：守卫重启（systemd KillMode=process）后，新守卫 `_adopt()` 接管旧守卫 spawn 的主 DSH——被接管进程非新守卫 spawn，其启动令牌只打印在旧守卫已断开的 stdout 管道里（令牌服务不落盘）→ 主令牌永久不可达 → relay 无法用令牌向回环 DSH 换 `dsh-auth-*` cookie → LAN 远程控制全 401（实况：主进程被接管后 `/status` dshTokenCaptured=false、`/lan-access` main dshToken=EMPTY，而 sandbox 实例走 journald 不受影响）。
- **修复**：RUNNING tick 新增 `_maybeReclaimAdoptToken()`——被接管（`adoptedPid && !child`）且主令牌空置时启动观察窗（`config.tokenReclaimGraceMs`，默认 20s，覆盖 adopt 后 journald/补获可能），窗口内令牌迟到即复位不干预；窗口过仍空置 → 受控重建一次（`_beginRestart('adopt_token_reclaim', {countCrash:false})`：杀 adopt 进程 → 状态机回 RESTARTING → 自 spawn 建新 stdout 管道 → 令牌必然可捕获）。`_tokenReclaimTried` 保证每次接管仅重建一次，防重启循环；令牌就绪/本守卫 spawn 时复位观察。
- **回归测试**：新增 `test/adopt-token-reclaim-test.js`（13 断言：观察窗语义/单次重建防循环/令牌就绪与自 spawn 不干预/窗口内迟到复位/默认窗 20000ms）并入 npm test；smoke makeConfig 显式拉满观察窗（mock 不打令牌，防 adopt 场景误触发重建），冒烟保持确定性。smoke 34/34。

### 智能路由 COMMAND 全量审计修复（2026-09 第三轮，见 docs/ROUTER-AUDIT.md）
- **额度恢复不同步修复（问题①）**：`resetsAt` 统一归一 `normalizeResetTs`（ISO 字符串/epoch 秒/毫秒均支持）——原 `_nextResetAt` 对 ISO 串 `Number()=NaN` → 30 天兜底，把精确恢复点（如月窗口 09-21）覆写成 +30 天，且恢复探测只按该错误 nextResetAt 触发 → 到真实重置点账号不被探测恢复（实况：OpenCode 6 账号全 frozen、nextResetAt=10-03 远晚于 09-21 真实重置）。direct/proxy 检测落库前归一；`_nextResetAt` 返回 `{t, precise}`；`applyDetection` 仍满额分支防回推（纯兜底不得覆写精确值）。
- **前端无法定位当前账号修复（问题②）**：`selected` 派生口径分裂——账号行只认 `selectedAccountKeyId`、头部回退 `activeAccount`，且 `activeAccount` 为内存态不持久 → 路由实际在用的账号列表不亮。修复：统一 `selectedKeyId()`（锁定可用→锁定；锁定冻结/失效→实际在用 activeAccount）；视图新增 `activeKeyId`/`locked` 同源锚点；`switchToAccount` 同时写持久化锁定；`_deserializeProvider` 恢复直连/反代锁定（兼容旧 selectedProxyKeyId）；锁定仅对永久失效（封号/作废/删除）清空，临时冻结保留（恢复后自动续用）；前端账号行「当前在用账号（锁定）」与「当前在用账号」区分。
- **预热池/启停风暴修复（问题③）**：实例启动前增加端口释放等待（≤3s，旧进程 SIGTERM→SIGKILL 1.5s 内未退即放弃并明确报错）——根除同端口并发 spawn 的 EADDRINUSE 秒退循环（实况：41012 端口 ~10s 一次启停数十次）；10min 额度刷新不再临时拉起全部 ready 账号（改为只探测已在运行的 primary/selected/prewarmed/在用实例）——消除周期性批量启停风暴。
- **回归测试**：router-test 12→16（normalizeResetTs/_nextResetAt 精确解析/selected 派生统一/锁定持久化）、p2p-router-test 37→40（F 段：临时冻结不清锁/解冻后锁定优先/封号清锁）；全量 npm test EXIT=0。
- **Command Code 额度获取修复（问题① Command 侧）**：`detectInstanceQuota` commandcode-billing 分支窗口耗尽判定改为纯 `used/cap` 推导（>=100%→rate-limited），不再依赖上游可选的 `exceeded` 标志（实况：三账号 weekly 100% 却存 status=ok 的矛盾记录）；支持 `{data:{windowLimits,credits}}` 信封解包、used/cap 字符串解析、credits 缺席时 monthlyRemaining=null。对照开源参考 opencodex quota.ts 逐字段核验。新增 `test/commandcode-quota-test.js`（8 断言）并入 npm test。

### 决策定案落地（2026-09 第二轮：D1-D6 拍板 → 剩余 Phase 3 落地）
- **决策记录（docs/DECISIONS.md 定案）**：D1 废 release.sh 自更新旁路统一 npm；D2/D5 单一 SEA（daemon+CLI 合一、全静态）确认；D3 **选 A 砍 useSystemdForMain**（守卫统一自 spawn，三端语义等价最短路径）；D4 壳更新形态 = npm 平台子包；D6 阶段门禁确认；版本双轨独立 + CHANGELOG 过期「壳同号跟随内核」句标注废弃。
- **D3-A 落地**：supervisor.js 全部 `useSystemdForMain===true` 分支折叠到 spawn 语义（tick/_startProcess/stopProcess/_enterRunning/_beginRestart/升级 hold）；删除 `_ensureSystemdMain/_systemdMainActive` 与 native 的 `systemdMainActive`；主 DSH 令牌源只走 stdout；升级健康验证不再依赖 `dsh-web@main` 单元；守卫 systemd 单元加 `KillMode=process`——守卫自身重启/升级不再连带杀掉其 spawn 的 DSH（「重启守卫不断 3080」由 process 模式 + spawn 接管语义保证）；主实例观测记录在守卫启动时注册（仅元数据：清单/relay/端口登记）。config 与测试配置删除死键。测试同步：smoke 34/34、guard-update 23/23、npm test 全绿。
- **F2 apiAccessKey（采纳）**：可选配置 `apiAccessKey`——仅设置后强制：非回环请求（0.0.0.0 局域网 / 私网 Host / FRP 通道）须带 `Authorization: Bearer <key>` 或 `?access_key=<key>`（常数时间比较），否则 401；回环豁免。新增 `GET/POST /settings/access-key`（空串=清除，不回显明文）+ supervisor accessKeyStatus/setAccessKey + skiff SettingsPage「出回环访问密钥」设置项；api-contract 增 F2 五断言。
- **D1 收敛**：`scripts/release.sh` 不再生成 `dist/release/manifest.json`（污染复发面消除），仅作源码打包出口；DESIGN §16.2/16.3 release.sh 行、verify-desktop.md 场景 C 同步为「非自更新通道」；守卫自更新统一走 npm 执行器（DistributionManager + 平台子包，路线见 DECISIONS.md）。

### 修复与重构（2026-09 架构级审计：发布形态驱动 — 壳开源 + 按平台 npm 拉内核 + 内核闭源热更新）
详见 docs/ARCHITECTURE-v2.md。全量 `npm test` EXIT=0（234 PASS）验证。
- **SEA 真内核化（决定性修复）**：bin daemon 的动态 require 改静态（`require('../src/supervisor')`）——此前 esbuild 打 bin 入口且 daemon 用 `path.join(ROOT)` 动态 require，内核从未打入 SEA（bundle 仅 585 行 CLI 壳），SEA daemon 运行时依赖旁置 src/ 明文；静态化后 bundle 11937 行含全部内核类。`--version` 复用 `guardVersion()`（原 vunknown）。内嵌 `DEFAULT_CONFIG` 替代 ROOT/config.json 外读（fresh-HOME 自举崩溃修复）。build-sea.sh 冒烟升级：self-check + `--version` 注入断言 + fresh-HOME daemon 自举三重验证。
- **发布链测试污染治理**：guard-update-test require 路径修复（self-update 迁移到 domain/dist 后断链）；smoke/upgrade-test 清理改 SIGCONT+SIGKILL（SIGTERM 杀不掉 detached/SIGSTOP 残留 mock → 占端口致链序偶发断）
- **补丁层数据破坏修复（Blocker）**：setBundleEnabled 禁用只置 disabled 保留用户行/insert 行，启用只删本插件 disabled 行（原 filter 整删同 id 所有行静默丢数据）；JSON 深比较替代长度比较；回归测试 F0 6 断言
- **原生卸载数据安全（HIGH）**：manifest dataPaths 改显式认领制——首装且 ~/.dsh 干净才认领；升级/回滚继承既有认领；默认空数组（不再默认写 ~/.dsh 凭据/会话路径防误删）
- **逻辑健壮性**：instance tick save() 纳入 try/catch（磁盘错不再经 uncaughtException 触发守卫 3 次退出重启）；restartCount 稳定运行 5min 后清零（偶发重启不再跨时间累计到 20 上限永久 FAILED）；waitPortHealthy 超时精确化（稳定期预算检查，不再溢出 timeoutMs+15s）；INSTALLING/FAILED 死锁自愈（安装超时竞态后成功恢复拉起）
- **逻辑单轨化**：TaskRegistry 观测层单一事实源（upgradeStatus/updateJob 用 current() 精确优先，running 期间不误显旧任务）；唯一 npm 安装执行器（native._runInstall 删重复实现，dist.runNpmInstall 支持 commandTemplate）
- **平台等价（Phase 3）**：frp 平台化（三镜像硬编码 linux_amd64 → frpPlatformTag 动态 os/arch 产物 + frpc.exe 支持 + 不支持平台明确拒绝）；平台能力门 capabilities() 真实矩阵 + /env/status 暴露（原硬编码全 true 与 win/mac 现实不符）；dshBin 统一解析（PluginManager 不再硬编码裸 'dsh'，与 InstanceManager 同源取 config.command[1] 绝对路径防 PATH shim 劫持）；pidlookup readCmdline 补 mac(ps)/win(wmic+CIM)（原非 Linux 返 null 致接管校验防线静默失效）
- **授权边界收口（F1）**：/instances 的 authUrl 仅回环 Host 请求附带 DSH 会话 token（token 永不出本机）；LAN/私网 Host 只给免认证 lanUrl + tokenPresent:false；api-contract 新增 F1 双断言防回归；setLanPanel(0.0.0.0) 记 lan_panel_exposed 风险事件
- **CLI/网络加固**：插件 spec/name 前导 '-' 注入防护（_assertSafeCliArgs settle-safe）；profile package.json 原子写（tmp+rename+0600）；pluginmarket getText 加固（2MB 上限/5 跳重定向/2xx 校验）
- **配置单一事实源**：bin 的 DEFAULT_CONFIG 改为从 src/infra/config.js DEFAULTS 派生 + 补 command/healthUrl 模板必填项（原 30 键手写副本与 DEFAULTS 漂移：缺 pluginsProfileName/routerAutostart/selfUpdate* 等）
- **可测化（跨平台核心逻辑）**：frpPlatformTag/capabilityProfile 纯函数化导出；新增独立测试 frp-platform-test（11 断言）/ capability-profile-test（8 断言）/ instance-state-test（9 断言）——三端映射、能力档位、实例状态机不再依赖真实 OS/进程即可验证
- **发布链 manifest 守卫（F5 关闭）**：release.sh 拒绝本地/私网/占位符 URL 生成 manifest（曾产出 url=127.0.0.1:39240 测试污染产物）
- **自更新去外部 tar**：fs-utils 新增纯 Node extractTarGz（GNU 长名/防穿越/stripComponents）；self-update 不再 execFileSync tar（Windows 无 GNU tar 时原不可用）；guard-update 全链路 23/23 验证
- **frpc 孤儿清理平台化**：pgrep（Linux/mac）→ win32 走 wmic/PowerShell CIM 按 Name+CommandLine 找残留 frpc

### 移除（Command Code 免费通道彻底下线）
- **背景**：免费通道（-free 模型免额度档）干扰正常付费账号稳定性（频繁中断付费流量），用户决策彻底移除，清除全部免费通道逻辑。
- **后端**：providers/base.js（freeCooldownMs/freeSelectedAccountKeyId/freeActiveAccount/freeCursor/freeModels 字段、isFreeAccountUsable/freeCooldownRemaining/markFreeLimited 方法、序列化 free 字段）；providers/proxy.js（markFreeLimited 覆写/_prewarmNextFree/实例仲裁免费分支，恢复单通道 _canStopInstance）；switch.js（免费双通道池，恢复纯付费引擎）；forward-core.js（免费模型分流/isFreeModel/proxyForFree 整方法）；router/index.js（hasFreeChannel/免费视图字段/免费模型周期刷新/实例回收免费分支）；router/aux.js（refreshFreeModels/_refreshFreeModelsIfDue/setFreeSelectedAccountKey）；proxy-apps.js（freeChannel/freeApiBase/freeModelFallback）；api.js（/router/providers/free/select|refresh 端点）。
- **前端**：ui/views-router.js（免费标签区/免费块/事件绑定）、app.css（free-* 样式）、core.js（6 条免费事件映射）。
- **测试**：删除 test/free-channel-test.js 并移出 npm test 链。
- **验证**：npm test 全套 exit=0（含 router/proxy/p2p 套件零回归）；重启守卫后 /router/providers 视图无任何免费通道字段（仅余官方模型名 ox-alpha-free 定价行，无关）。
### 新增（版本管理规范 v2：单一事实源 + 全派生链）
- **版本规范定稿（DESIGN §16）**：SemVer 2.0 纯数字、禁预发布后缀（自更新字符串比较前提）；单一事实源=仓库 package.json.version；
  派生链只读单源；v 前缀只出现在发布通道外层（manifest/tag/版本目录），npm 子包例外=裸版本（npm 强制）。
- ~~**壳版本策略（已拍板）**：Cargo.toml + tauri.conf.json **同号跟随内核**；补丁整包发布（内核 0.10.1 → 壳同步 0.10.1，一个 tag 出全平台整包）。~~ **[已废弃]** 同日下条「版本双轨独立（DESIGN §16.4）」裁定替代：壳 0.1.x 起独立、公开仓 Release 极少更；内核 0.10.x npm 热更。以下行/相关代码以双轨为准。
- **修复（SEA 版本不自包含，历史断点）**：`src/infra/version.js` 支持 `__DSH_VERSION__` 编译期注入常量；build-sea.sh 以 `esbuild --define` 注入单源版本。
  实证：此前 SEA 脱离 dist/sea 目录自报 `guardVersion=unknown`；修复后源码形态 / dist/sea / 孤立目录三态均自报 0.10.0。
- **SEA 产物命名带版本**：`dsh-supervisor-<ver>-<platform>-<arch>`（不再无版本）。
- **版本双轨独立（替代早期同号策略，DESIGN §16.4）**：双仓库拆分开后发布通道解耦——内核走 npm（频繁热更新）、壳走公开仓 Release（稀少）；`bump.sh` 改为 `--core`/`--shell` 双模式（互不 bump、拒回退）；`verify-versions.js` 双轨自洽（内核 package.json 单源 / 壳 Cargo=tauri.conf 互锁）；壳版本 **0.1.0 起**；私有仓 CI 剥离壳 Release（只产 SEA + npm 子包），壳构建仅留集成冒烟。
- **`scripts/bump.sh`（版本提升唯一入口）**：校验 SemVer（拒预发布）→ package.json → Cargo.toml → tauri.conf.json → 一致性强制校验 → 人类清单。
- **`scripts/verify-versions.js` + `npm run verify:versions`**：三处同号校验；接入 `verify:shell` 第 0 步与 bump.sh 尾步（防壳脱轨回归）。
- **双仓库方案落地（壳开源 / 内核闭源）**：壳解耦——tauri.conf resources 仅 bootstrap/icons（不再内嵌内核资产）；main.rs 定位已安装内核（PATH/~/.local/bin/~/.npm-global/bin/旧资源兜底）daemon 拉起（SEA 自足不依赖 Node）；引导页新增 core_status 显示内核安装状态。公开壳仓 `dsh-supervisor-launcher`（MIT）：`scripts/export-shell.sh` 导出（壳+产品主页 README+MIT LICENSE+公开仓 CI），导出目录独立 cargo build 验证通过（clone 即构建）。许可定案：内核 **UNLICENSED**（主 package.json + 根 LICENSE + npm 子包继承），壳 **MIT**。
- **`scripts/publish-core.sh` + `npm run publish:core`（内核 npm 子包发布）**：单源注入裸版本（与内核同号）、`os`/`cpu` 字段平台过滤、`bin` 指向 SEA 二进制（win 为 .exe）、发布前强制 self-check 版本=单源（错配拒绝）、默认 dry-run 保护（`--publish` 真发）。Linux x64 dry-run 实测：包 47.5MB、integrity 已生成。scope 解析链：package.json.npmPublish.scope → 环境 DSH_CORE_SCOPE → 兜底 @dsh-core。### 新增（内核构建物化：SEA 单文件 + V8 字节码）
- **`scripts/build-sea.sh`**：内核发布产线——esbuild CJS bundle → `node --experimental-sea-config`（`useCodeCache` 生成 V8 字节码 `prep.blob`）→ postject 注入 `NODE_SEA_BLOB` → SEA 二进制自举冒烟（`self-check`）。路径统一绝对化，修复子壳相对路径错位（此前 `(cd out)` + 相对 BIN 导致 postject 目标不存在）。
- **`bin/dsh-supervisor self-check`**：SEA/源码双形态自检子命令（guardVersion/node/platform 三段）。
- **Linux x64 验证**：注入 done、`self-check: OK`（guardVersion=0.10.0）；`strings` 无 `class RouterService` 明文（字节码生效），仅字符串常量池可见——闭源构建物口径成立（知悉非绝对防逆向）。
- **发布形态**：公开 npm 内核子包（按平台 `@scope/dsh-core-<os>-<arch>`，内核版本号对齐）、私有 GitHub 存源码、壳开源引流。文档：README「内核发布：SEA 构建物化」+ `scripts/publish-and-verify.md` 双轨重写。
### 重构（前端架构分层：数据层 / 状态中心 / 视图层，工业级单向数据流）
- **分层**：HTTP API（后端）→ syncAll 一次并行拉取（数据层）→ Store（唯一事实源）→ renderActive 渲染当前活跃视图（视图层）。
- **消除重复请求**：/status、/instances 由多次独立拉取合并为 syncAll 一次快照（此前 /instances 每周期拉 3 次、/status 拉 2 次）；
  swActiveProv/Key 从 Store.providers 读取，不再第 3 次拉取 /router/providers。
- **视图纯函数化**：renderStatus/renderUpdate/renderInstances/renderLan/renderFrp/renderSwitcher/renderProviders 全部只读 Store；
  旧 refreshX 混合体移除，操作回调统一走 unifiedTick（操作 → 同步 → 渲染管线）。
- **活跃视图渲染**：renderActive 只渲染当前页 + 概览全局元素（hero/版本卡/事件），设置页低频配置数据按需拉取（不进 2s 同步）。
- **视图联动闭环**：停止 DSH → 后端停 relay → syncAll 刷新 lan 快照 → LAN 页开关/代理徽标/访问链接随快照联动更新（含实例未运行禁用开关）。

### 修复（前端状态架构：状态中心 + 视图联动 + 启动链路根治）
- **前端状态中心 Store（单向数据流）**：所有视图状态统一存 Store（status/instances/lan/frp/switcher/providers/events），
  refresh* 拉取写入、render* 只读渲染；unifiedTick 全量覆盖含远程控制（LAN/FRP）——停止 DSH 时后端联动停 relay，
  LAN 页开关/代理状态随同一状态快照联动刷新，消除「A 页变了 B 页不知道」的断链。
- **远程控制联动语义**：开关 = 实例运行中 ∧ remoteEnabled ∧ relay 实际监听；实例未运行时开关禁用并明示「实例未运行」，
  不再只是 remoteEnabled 配置位。
- **停止链路根治**：systemd 托管模式下 pid 观测提前到 desired=stopped 调和之前，stopProcess 增加「端口占用者
  现场探测 + DSH cmdline 校验」兜底——停止不再因 adoptedPid 未就绪而静默无效，也不误杀外来进程。
- **启动链路根治（systemd）**：_cleanStaleUnit 删除 transient 单元文件后补 daemon-reload，systemd-run 重建同名单元
  不再报「Unit already loaded or has a fragment file」（实测启动一次成功，无 systemd_start_failed）。
- **desired 正交轴彻底解耦**：显式 start/stop 始终生效（守护开关只约束崩溃后自动拉起）；/restart 同属显式操作。

### 修复（useSystemdForMain 模式下「启动 DSH」失效——深度根因）
- **根因**：useSystemdForMain=true 时，主实例「进程守护」开关默认关（guardian=false），tick 在调和前被
  「只观测、绝不拉起」短路——DSH 崩溃后守卫不自动拉起，且前端 POST /start 设置的 desired 永不触发 spawn，
  表现为「点击启动无反应，只能手动命令启动」。
- **修复**：显式操作（POST /start）穿透守护开关一次（_explicitAction 标志）：守护开关只约束「崩溃后自动拉起」，
  绝不约束用户主动点启动；启动等待期保持 STARTING 呈现（systemd 单元拉起数秒内不闪回「已停止」）。
- **语义边界**：自动拉起仍遵循守护开关（默认关，前端「▶ 启动进程守护」按钮开启）；/start 每次显式拉一次。

### 新增（前端即时响应：消除状态真空）
- **统一状态驱动**：单一 2s 主循环（unifiedTick）替代三个独立定时器（5s/3s/5s），页面重新可见时立即同步；
  安装/卸载/实例安装/升级等长任务全部纳入同一轮询驱动。
- **安装/卸载异步任务化**：/native/install|uninstall 由「同步等待 npm 完成」改为 202 受理 + 状态流
  （state / installLog / lastInstall / lastUninstall），hero 区实时进度卡（标题 + npm 输出日志尾 +
  禁用重复操作按钮），完成/失败自动刷新全视图——不再需要手动刷新。
- **卸载不再冻结守卫事件循环**：uninstall() 由同步 execFileSync 改为异步 spawn。
- **写操作后全量即时刷新**：安装/卸载/升级终态统一触发 unifiedTick()（hero/按钮态/版本卡一次到位）。
- **DOM 重建去重**：refreshInstances / refreshProviders 数据未变不重建（2s 轮询下防闪烁与事件重复绑定）。

### 修复（底层架构治理，审计后）
- **插件安装必崩修复（P0）**：`plugins.js` 使用 `os.homedir()` 却未 `require('node:os')`，任何插件安装都抛 ReferenceError 且 API 无响应——已补引用，并为插件安装调用链兜底。
- **健康探测语义回归（三层）**：恢复 L2 HTTP 探活（`GET healthUrl`，超时 `probeTimeoutMs`），新增 `failThreshold` 连续失败防抖与 `httpProbeEnabled` 逃生门（非 HTTP 命令可关闭 L2）。"假死识别"（事件循环卡死）真正生效：端口在但 HTTP 连续失败 → `http_unhealthy` 判故障重启；STARTING 启动门与 RESTARTING/BACKOFF 恢复条件均要求端口+HTTP 双通过。
- **事件增量读取跨守卫重启连续**：seq / rotatedSeq 持久化到 `events.log.meta.json`（原子写），轮转后重启不再丢 `.1` 历史、seq 不再重号；无 meta 时向后兼容旧行为。
- **API 重绑竞态修复**：切换面板局域网访问时旧 keep-alive 连接导致 EADDRINUSE 打死 API——改为 `closeAllConnections` + 10 次重试 listen。
- **守卫版本检查不再冻结事件循环**：`git fetch` 由同步 `execFileSync` 改为异步 `execFile` + 10s 超时；`GET /guard/version` 走本地视图（同步安全），`POST /guard/version/check` 才触发远端 fetch。
- **中转转发增加响应头超时（30s）**：防「已连接但静默」的上游挂死请求占满连接池（仅约束到响应头，长流不受影响）。
- **单实例锁**：`daemon` 入口 O_EXCL pidfile + 存活检测 + 崩溃残留自愈，杜绝双守卫并存。
- **沙箱实例安装走全局镜像源**：`_installSandbox` 注入 dist 选中的 registry（与 DSH 自升级同一镜像配置）；`startInstance` 异步化，调用链（API/tick/守卫）全部对齐。
- **API body 统一有界读取**：所有写接口超过上限先应答 413 再断开，不再静默挂死。
- **实例删除清理沙箱目录**：`removeInstance` 对 sandbox 域异步删除 install/data 残留。
- **实例持久化写放大治理**：`instances.json` 内容未变不写盘。
- **中转费用估算落地**：按实际使用供应商的 models.dev 官方单价累计 `costUsd`（无单价不虚报）。
- **前端清理**：删除 qrcode.js 死引用与死元素调用（swCool/swActive 等）；`wire()` 统一判空绑定；反代版本更新由「打开面板自动重启实例」改为显式「更新」按钮 + 用户确认。
- **overlay 治理**：插件覆盖层只记录 `disabled:true` 条目，启用=删除记录，不再无限累积。

### 重构（信息架构 → 桌面管理台形态）
- 采用侧边导航 + 工作区的桌面软件标准布局：概览 / 大模型中转 /
  局域网访问 / 版本与升级 / 事件日志 / 设置 六个功能页。
  未来新功能（插件市场等）以新增导航项方式扩展。
- 每页全宽布局，消除卡片堆叠导致的参差高度；
  操作按钮统一锚定区块底部。
- 顶栏简化为单一系统状态徽标；期望状态详情保留在概览页。

## [0.10.0] - 2025-08-22

### 重构（面板 UI 全面重设计）
- **布局**：12 列栅格分区式排版——核心监控(7列)+中转服务(5列)、
  版本与升级(5列)+局域网访问(7列)、时间线与服务位置通栏。
  同行卡片等高拉伸，消除参差不齐。
- **视觉层级**：运行状态卡新增大字阶段指示（呼吸状态点），
  关键指标网格化；每卡带类型标签（DSH/LLM Relay/Update/LAN）。
- **操作锚定**：所有操作按钮统一贴卡片底部（margin-top:auto），
  跨卡对齐一致。
- **顶栏**：单一系统状态徽标 + 图标化设置按钮；移除期望胶囊。
- **细节**：阶段呼吸动画、卡片头部渐变、二维码投影、
  服务位置表新增局域网入口行。

### 说明
- 纯前端重构，后端零改动；全部元素 id 保持不变。

## [0.9.3] - 2025-08-22

### 调整（面板 UI）
- 大模型中转服务卡片移至「版本与升级」之后，内部重排为
  状态行 / 统计网格 / 操作按钮 / 按模型统计 四层结构，间距规范化。
- 顶栏简化：移除「期望」胶囊，单一「系统状态」徽标展示运行阶段
  （期望状态详情保留在运行状态卡内）。

## [0.9.2] - 2025-08-22

### 修复
- **客户端断开被误判为上游故障**：长流中用户主动停止（DSH 停止生成、
  客户端超时等）会错误地给当前 Key 施加怀疑冷却，反复触发会劣化整个 Key 池。
  现已区分：客户端断开仅清理连接；上游异常断流才施加冷却。
- 补充上游无 error 无 end 直接关闭 socket 的兜底处理。
- 新增转发连接级超时（15s），防护 TCP 黑洞/握手挂死；
  响应头到达后自动解除，长流不限时长。

## [0.9.1] - 2025-08-22

### 清理与修正（全面代码审计）
- 移除死代码：supervisor._deliberateRestart、keypool.addKeys、
  /switcher/add-keys 路由、面板孤儿 addKeys 函数、
  死 CSS（.sw-add/.sep/.lan-url）、未使用的 killWaitMs 配置项
  （DEFAULTS/config 模板/README/DESIGN 同步清理）。
- 统一：CLI `events` 命令改用与自定义配置一致的日志路径解析。
- 中转代理成功路径生命周期重构：区分客户端断开（仅销毁上游连接）与
  上游异常断流（怀疑冷却+事件），并处理上游过早关闭（aborted 事件）。
- usage 提取支持嵌套子对象（括号计数），修复统计恒为零。

## [0.9.0] - 2025-08-22

### 新增
- **中转服务稳定性重构**（长任务断流根治）：
  - 监听器 `requestTimeout=0`、双侧 TCP keepalive 15s、上游连接池复用——
    长流不限时长、抗 NAT 断链、重连更快；
  - 连接级失败：30s 短冷却轮换下一键并清粘滞（修复原版"同坏键反复尝试后放弃"）；
  - 流中断观测：记录 STREAM_ABORTED 并对键施加 60s 怀疑冷却引导后续请求；
  - 客户端断开：响应前中止上游请求，响应中销毁透传管道，不泄漏连接。
- **流式 Token 统计**：自动注入 `stream_options.include_usage`
  （上游不认时自动去字段重试一次），SSE 尾部 usage 括号计数提取
  （支持嵌套 details 子对象）；成功但无 usage 的调用计入请求数。
- **失败计数**：totals.errors 统计最终失败请求数。

### 安全
- 含密钥/令牌/用量数据的文件以 0600 权限落盘；已有文件加载时自动收紧权限。

### 修复
- 中转代理注入回退逻辑的变量残留与顺序问题整体清理。

## [0.8.2] - 2025-08-22

### 修复
- **嵌套 usage 对象解析失败**：上游返回的 usage 内含
  `prompt_tokens_details` 等子对象，正则 `[^{}]*` 截断导致 JSON.parse 失败、
  统计恒为零。改为 lastIndexOf 定位 + 括号计数提取，支持任意嵌套。
  现网实测：经中转的真实调用已正确计入明细与按模型累计。

## [0.8.1] - 2025-08-22

### 修复
- **用量统计恒为零的根因**：usage 提取正则缺少捕获组，`m[0]` 携带 `"usage":` 前缀
  导致 JSON.parse 必然失败。改用捕获组取花括号部分后解析。
  实测经中转的真实调用已正确计入明细与累计。

## [0.8.0] - 2025-08-22

### 新增：OpenCode 中转（原生实现，替代退役的 opencode-switcher）
- `src/keypool.js` 多账号 Key 轮换代理：粘滞活跃键→顺序游标轮换；
  仅 429/403+额度关键词触发冷却（Retry-After / Reset 头 / "Resets in N min" 解析，
  缺省 5 小时）；SSE 与普通响应透传；joinUpstream 的 /v1 去重与 Go 版逐条对齐。
- 冷却状态持久化（重启不丢）；首次启动自动无损迁入旧版
  ~/.config/opencode-switcher 的配置与冷却状态。
- 面板新增「OpenCode 中转」卡片：运行状态、Key 池列表（当前使用/可用/冷却倒计时）、
  启动/停止、追加 Key、单键移除、额度探测（消耗极小额度）、管理页直达。
- 守卫 API 新增 /switcher/*（status/start/stop/config/test/logs/add-keys/remove-key/
  stop-legacy）；旧版进程一键接管（精确终止其代理二进制）。
- 配置项：switcherPort/switcherUpstream/switcherAutoStart/switcherLegacyDir。

### 说明
- 退役旧版后建议 `sudo dpkg -r opencode-switcher` 并关闭其 GUI 自启；
  本模块占用同一端口 8787，DSH 的 plan 模型指向不变，切换无感。

## [0.7.1] - 2025-08-22

### 调整
- 局域网访问卡片视觉重排：二维码加大加投影、区块间距规范化；
  移除二维码下方地址文字（令牌已嵌入二维码，无需暴露地址）；保存按钮升级主色。

## [0.7.0] - 2025-08-22

### 新增
- **局域网访问卡片**：主界面新增独立卡片——二维码扫码直进（自动携带令牌）、
  局域网地址展示、访问令牌面板内设置（保存即持久化并热生效）。
- 反代对 HTML 文档响应附加 `Cache-Control: no-store`，杜绝局域网设备拿到陈旧页面。

### 修复
- **局域网源 RPC 全废的根因**：`crypto.randomUUID` 为 secure-context-only API，
  非回环 HTTP 源上不存在，而 DSH 客户端用它铸造每个 RPC id——缺失导致所有请求抛错、
  WS 就绪握手失败。反代现向 HTML 注入等价 polyfill（</head> 前执行），
  实测 workspace.list/settings.describe 等经代理与直连返回一致。
- 令牌门卫顺序错误导致"URL 令牌放行并种 Cookie"分支不可达。
- HTML 响应附加 `Cache-Control: no-store` 防设备陈旧页面。
- 已知上游限制：设置**写入**作用域由前端按页面地址选择（非回环=浏览器内存态），
  局域网设备的设置修改在重载后不落盘；读取/展示与桌面完全一致。
  该门禁随官方认证层演进，反代层无法在不篡改前端代码的前提下安全解除。

## [0.6.0] - 2025-08-22

### 新增
- **局域网全权限访问**：反代对 `/api` 与 WebSocket 握手做回环呈现
  （Origin/Referer 改写为回环权威），DSH 浏览器信任围栏将代理流量视为本机，
  设置/Agent 预设/模型/插件等特权配置面在局域网完整可用。
- **反代层可选令牌**（`lanToken`）：首次凭 `?token=` 进入自动种 HttpOnly Cookie，
  常数时间比较；令牌只存在于反代层，不进入 DSH。

### 边界声明
- 遵循硬边界：以上全部在守卫反代层实现，**不改动 DeepSeek Harness 的任何源码、
  配置文件，也不安装任何插件**；DSH 本体保持只听回环。

## [0.5.0] - 2025-08-22

### 新增
- **局域网访问 DeepSeek Web**：守卫内置反向代理（默认 0.0.0.0:3088 → 127.0.0.1:3080），
  局域网设备经 IP 直接使用与桌面端同步的 DSH Web；支持 WebSocket 透传；
  DSH 本体保持只听回环零改动；面板设置中心一键开关。
- **顶栏设置中心**：⚙ 设置按钮聚合配置项；「开机自动启动服务」升级为整条服务链
  开关（systemd 单元 + linger + GUI 自启条目），登录后守卫、DSH、面板全部就位。

### 修复
- 面板按钮可用状态与守卫实际可执行动作严格对齐（重启仅在受管运行时可用等）；
  控制区与上方内容间距规范化。

## [0.4.0] - 2025-08-22

### 新增
- **界面版本信息**：顶栏版本徽标 + 版本卡守卫大字版本；「更新日志」弹层直读 CHANGELOG。
- **一键安装 DeepSeek Harness**：未安装时版本卡提供在线安装按钮（全新安装路径，
  装完按期望状态自动拉起）；守卫对"命令不存在"进入 60s 冷静期并不再刷崩溃计数。
- **面板内登录自启开关**：设置卡直接切换（GET/POST /gui-autostart）。

### 修复
- **期望停止时不再"失明"**：发现无主运行实例进入 OBSERVED 观测模式——
  如实展示运行状态与 pid、不强杀不拉起；「启动」同一实例无缝转正纳管，
  「停止」显式终止。修复"DSH 明明在跑，守卫却显示没检测到"。
- GUI 启动时若守卫未运行，自动尝试 systemctl 拉起。

## [0.3.0] - 2025-08-22

### 新增
- **系统托盘常驻**：Tauri 托盘图标 + 菜单（显示面板 / 启动 / 停止 / 重启一次 / 退出）；
  关窗即隐藏到托盘，守卫状态随时可达；菜单动作经裸 TCP 直发本地 API，零新增依赖。
- **桌面通知**：崩溃进入退避、升级完成/失败/回滚失败、hold 超时等关键事件经
  `notify-send` 触达（`notifyEnabled` 可关；环境不支持自动静默停用）。
- **GUI 自启与入口纳管**：`.desktop` 模板入库；`install` 自动部署菜单入口与图标；
  `dsh-supervisor gui-autostart on|off` 控制登录自启面板。

## [0.2.0] - 2025-08-22

### 新增
- **版本管理**：package.json 为单一版本源；`dsh-supervisor --version` 自报版本；
  `/status` 返回 `guardVersion`；`guard_started` 事件携带版本号。
- **日志管理**（三路分文件、分级、统一轮转，保留一代 `.1`）：
  - `supervisor.log` 守卫运行日志（debug/info/warn/error，`logLevel` 可配）
  - `dsh.log` 被监管目标 stdout/stderr（行缓冲还原完整行）
  - `upgrade.log` npm 安装原始输出
  - CLI 新增 `dsh-supervisor logs [name] [N]`
- `src/pidlookup.js`：/proc 按端口反查进程 pid，接管既有实例可被 stop / 升级。
- API 安全边界：Host 本机校验、POST Origin 校验、移除 CORS `*`、CSP/nosniff 头。
- 测试扩至三套件（core / smoke / upgrade），覆盖 §12 全部用例与安全边界。
- LICENSE（MIT）与 `npm test`。

### 修复
- systemd unit 的 `StartLimitIntervalSec/Burst` 移入 [Unit] 段（原写于 [Service] 被
  systemd 忽略，崩溃循环保护实际失效）。
- 控制端点透传结果：拒绝时返回 409 与原因，不再假成功。
- 配置缺省 `stateFile/logFile` 时事件与状态静默丢失 → 补内置默认值；
  `healthUrl` 非法改为 fail-fast。
- CLI 控制命令此前无视 `-c`/`DSH_SUPERVISOR_CONFIG` 自定义配置。
- RESTARTING/BACKOFF 重启前复查端口占用，不再对占端口的不健康进程反复 spawn 计崩溃。
- 守卫 shutdown 清理升级定时器；崩溃窗口跨守卫重启持久化。
- 非法版本号不再被静默当作"已是最新"。

### 变更
- **升级流程改为"先停后装"**：停 DSH → 安装 → 自动拉起 → 健康验证；
  失败自动回滚旧版并恢复运行。消除运行中替换文件的混合版本窗口
  （行为变化：安装失败时 DSH 会以旧版本重启而非保持原进程）。
- SIGTERM/SIGKILL 发往进程组（detached spawn），DSH 子进程一并退出。
- 事件日志按大小轮转（`eventsMaxBytes`）。

## [0.1.0] - 2025-08-21

### 新增
- 首个可用版本：期望状态调和状态机、两层健康探测、崩溃退避、
  127.0.0.1:3100 本地 API 与运维面板、Tauri 桌面壳、systemd user unit 安装器、
  版本监测与一键升级（回滚）、mock 冒烟测试。
