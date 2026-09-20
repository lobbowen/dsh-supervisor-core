# 验收与测试标准（Acceptance & Test Standard）

> **本文件是「验收与测试」领域的唯一事实源。**
> 任何其它文档不得自行声明该领域的规范；与本文冲突者一律以本文为准。
> 机器校验门禁：test/acceptance-standard-gate-test.js。

---

## 0. 硬标准（不可协商）

> **所有测试一律不得在本机执行；验收只能由推送后的 GitHub CI 裁决。**
> **本机不得产生任何发布产物。**

这条标准与 .github/workflows/build.yml 文件头第 6 行同源：

    硬标准（2026-09-13，不可协商）：所有平台构建与发布必须经 GitHub CI 完成；
      本地不得产生发布产物。

以及同文件 139-142 行：

> 原条件为 needs.precheck.outputs.need_build == 'true'，理由是「已全量发布则无需再构建
> （**本地已用同一份代码产出，幂等**）」—— **那是本地构建时代的理由；硬标准既已禁止本地构建**。

---

## 1. 为什么（真实故障）

1. **本机是单一平台**：本机只有 Linux。Windows 的 spawn / macOS 的 launchctl /
   systemd / schtasks 原生行为，本机**结构上无法验证**。
2. **本机环境不可复现**：例如 test/release-auth-test.js 的 R4-c 断言「无 token 时不误报成功」，
   其前件是「运行机 $HOME/.npmrc 无 token」。开发机 ~/.npmrc 通常**有** token →
   本机必失败，而 CI 干净 runner 上**必通过**。**本机 FAIL 不是产品缺陷**。
3. **本机可能富集前置条件**：本机常有 X11/Wayland socket，CI runner 无头 →
   守护看护（按设计）拒绝拉起 GUI 壳 → shell-watchdog-e2e 在本机绿、在 CI 需装 Xvfb 才绿。
4. **断言前置条件会被漏掉**：CI 的 test job 明确先 build-ui.sh（否则面板安全头断言返回 503），
   再 npm run build:launcher:all 且 DSH_LAUNCHER_REQUIRED=1（否则 all-platforms 的
   T6-d/T6-e **静默 SKIP = 该断言在 CI 永不检查**）。本机跑 npm test **不含这些步骤**。

5. **平台原生的命令行上限**（2026-09-17 CI 实证）：`scripts.test` 是单条 `&&` 巨链，
   增长到 8593 字符后，**`windows-latest` 报 `The command line is too long.`**
   （cmd.exe 上限 8191），而同一提交的 `ubuntu-22.04` / `macos-latest` / `macos-14`
   **三个矩阵同时全绿**，且 `test` job 也全绿。
   本机 Linux 跑一万遍**都不可能**发现这条 —— 修法是 `--require` → `-r` 缩短到 7711，
   并把该平台差异固化为门禁 **N-e**（`test-chain-completeness-test.js`），
   使其不再依赖 Windows CI 才发现。

**结论：本机 npm test 的绿/红都不构成任何交付证据。**

---

## 2. 唯一合法的验收流程

1. 推送到远端（分支 / tag / PR）；
2. CI 触发条件（on:）：push 到 branches: [master]、push tags: ['v*']、
   pull_request、workflow_dispatch；
   ⚠ **推送非 master 分支不会触发 CI** —— 必须开 PR 或 workflow_dispatch；
3. 以 CI 的**四平台矩阵**结果为准。

### CI 实际执行的内容（.github/workflows/build.yml）

**test job（ubuntu-latest）**

| 步骤 | 说明 |
|---|---|
| bash release/scripts/build-ui.sh | 面板安全头断言的前置条件 |
| apt-get install -y xvfb | 提供图形会话（runner 无头） |
| npm run build:launcher:all | 真实产物（DSH_LAUNCHER_REQUIRED=1） |
| xvfb-run -a npm test | 内核回归 |

**build job（四平台矩阵，每次 push/PR 都跑，不得条件跳过）**

| os | artifact |
|---|---|
| ubuntu-22.04（glibc 2.35 基座） | linux-x64 |
| windows-latest | win-x64 |
| macos-latest | darwin-arm64 |
| macos-14（DSH_ARCH_OVERRIDE=x64） | darwin-x64 |

---

## 3. 「逻辑门禁」与「原生行为」的边界

仓库内的跨平台测试（cross-platform-architecture-gate、four-platform-behavior-matrix、
platform-layer-portability、platform-parsers-and-commands）证明的是**逻辑**
（映射 / 档位 / 解析 / 命令构造 / 分层）。

它们**不能**证明**平台原生行为**（真能跑 systemd/launchctl/schtasks、真能 spawn Windows 可执行、
真能出 MSI）。**后者只能由真实四平台 CI 构建裁决。两者互补，不可互相替代。**

---

## 4. 禁止事项

- ❌ 以本机测试结果作为交付结论、发布依据或「已完成」的证据；
- ❌ 在本机执行 npm run build:launcher / build:launcher:all（产生发布产物）；
- ❌ 把本机 FAIL 直接当成产品缺陷上报（必须先判断是否为环境前件不满足）；
- ❌ 把本机 PASS 当作 CI 会绿。

## 5. 允许事项

- ✅ 语法自检（node --check）——**不是测试**，仅作者自校；
- ✅ 只读检查（git status、grep、wc）与静态审阅；
- ✅ 推送后**读取 CI 结果**（GitHub API / Actions 页面）。

---

## 6. 违规判定

在 CI 绿之前，任何「已验收 / 已完成 / 通过」的表述都必须降级为
「**待 CI 裁决**」。文档中不得把本机结果写成验收结论（由
test/acceptance-standard-gate-test.js 机器校验）。

---

## 7. 静态门禁必须显式登记自己的覆盖缺口（E-2，2026-09-20 立项）

**规则**：凡以「读源码做正则/结构判据」立规的契约门禁（glibc、令牌契约 TK-G、
无控制台窗口 K-W2、有界执行 G9 等），其文件头必须含一个
`## 覆盖缺口（E-2 制度化登记` 块，逐条写明**本门禁绿了仍然不成立**的那些方面；
执法点：`test/round8-fixes-test.js` 的 J-o。

**为什么**（同一失效模式复发了四次）：审计 §E-2 抓到 glibc 门禁「注释声称产线会校验
产物，实际 CI 零调用」、TK-G4「白名单把违规形态定为合法」、K-W2「只匹配 `spawn(`，
异步 execFile 全盲区」、发布包 README 与通道契约矛盾。四处的共同点不是「判据写错」，
而是**门禁的名字比它的判据大**——文件叫 `xxx-gate-test`，读者就把绿当成
「xxx 这件事被验证了」，于是这条「看起来已经有的防线」反而**阻止**了下一次检查
（与 macOS 自启谎称由 LaunchAgent 代管同形）。

**边界（不得越界理解）**：
- 登记缺口**不是**放宽断言，也**不是**把已知盲区写成「已覆盖」；缺口清单本身必须
  是可核对的事实（扫描面路径、判据用到的字面量、有无行为级用例）。
- 缺口块只描述「不证明什么」；要补强某条缺口时，**先删掉对应那一行**再提交判据，
  避免判据已收紧而文档继续声称有洞（反向失实同样是违规）。
- 新增此类门禁时若不带缺口块，J-o 直接 FAIL——要么写，要么说明为何无需（该判据是行为级）。

## 8. 状态落盘的原子写只有一个源（E-1，2026-09-20 立项）

**规则**：任何「写临时文件再 rename 到目标」的落盘，一律
`require('platform/util/fs').writeAtomic(file, data, { mode })`。不得在调用点自拼
tmp 名、不得另立第二个 helper。豁免清单（连同豁免理由）与执法点都在
`test/round8-fixes-test.js` 的 J-n；新增豁免必须先进清单再提交。

**为什么**：审计 §E-1 原述「至少 4 处独立实现」，实测迁移前 `src/` 下 **28 个文件**自带
tmp+rename，其中 **25 个用固定 `file + '.tmp'` 名**。固定名不是风格问题：升级重叠期新旧两个
守卫进程写的是**同一个**临时文件，rename 出来的字节是两次序列化的交错混合体（既不是新版也
不是旧版，解析必失败）；另有实现不带 mode，令牌/URL 明文落 0644。

**边界**：
- `writeAtomic` 只负责**唯一 tmp 名 + 权限收口 + 失败不残留**。「读失败禁写」仍是各调用点的
  职责（usage/store 的 `canPersist()`、registry 的 `loadedOk` 等），单源**不内建**该闸——
  把它塞进 helper 需要 helper 反向依赖每个调用点的健康语义。
- 迁移只允许替换写手段，不得顺手改 mode 之外的行为；带特殊语义的点（令牌轮转追加
  `persist.appendByRotation`、私有写 `file-protect.writePrivate`）留在豁免清单内，
  但仍被要求 tmp 名含 pid（豁免只豁免「用哪个 helper」，不豁免唯一性）。

## 9. 外部输入的字符集白名单只有一个源（E-4，2026-09-20 立项）

**规则**：包名、argv 项、systemd 单元名、聚合账本键的**字符集/形态**判定，一律取自
`require('platform/util/input')`（`argvViolation` / `pkgNameViolation` /
`unitNameViolation` / `ledgerKey`）。不得在别处复制同形正则——执法点 J-p 按「同一条尺子在
`src/` 只有一个定义处 + 消费方拿到同一个 RegExp 对象」判，抄一份立刻红。

**边界**：语义级校验**不进** input.js，留在各自领域（SSRF 的 `isPrivateHostLiteral`、
semver 比较与通道选择、`isValidOrigin` 的 URL 结构闸）。本条只统一「这串字符能不能进
argv / 单元名 / 对象键」这一层，避免把安全语义稀释成通用正则库。

## 10. 判据自身有五条失效形态，写判据时必须先排掉（第 4 批 CI 取证，2026-09-20）

**规则**（取证链见 AUDIT-REPORT §H-7-8/9/11/12/13/14/15；本条不新增机器执法，靠评审）：

1. **双锚点取段**：`text.slice(indexOf(A), indexOf(B))` 里的 B 必须在 A **之后**。
   同一字面量在文件中出现多次时，裸 `indexOf(B)` 会取到前一个，段恒空，而症状伪装成
   「产品丢了某段代码」——本仓实测一次（`umask 077` 在 `cred.sh` 出现两次，段长 0）。
   凡取段判据都要配一条**段长前提例**（回显 `start/end/段长`），让锚点顺序回退判红带证据。
2. **计数类判据写相对增量**：绝对计数等于把「此前所有用例的次数」隐式钉进期望；
   同理，时间类判据必须显式区分**时刻**（`now`）与**时长**（`now - firstAt`），
   并按经过时间递减的量必配一条 `elapsed = 0` 的锚点例。
3. **异步事实要先推进事件循环再断言**：夹具用 `setImmediate` / `setTimeout` 送达的回调，
   与同步断言不在同一拍；`process.exit()` 还会直接掐掉待执行的 immediate。断言前必须显式
   drain，且改写全局定时器的桩要**随取随装、取完即卸**（窗口外装卸会漏记被测排程，
   也会把夹具自己的心跳误记成被测行为）。
4. **宿主环境事实不能靠推演写进前提**：X-6 曾以「真 Windows 的 `icacls.exe` 在 System32，
   `CreateProcess` 清空 PATH 也会命中系统目录」为**前提**立判据，run `35487214678` 的 windows
   job 直接证伪（该夹具形态下探测结果为不可用）。凡判据依赖环境事实（装了 Chrome、有 `icacls`、
   tmpdir 短名、家目录位置），必须把该事实**本身**立成一条带回显的判据，而不是拿它当另一条的
   前提——两条互证才有定性依据，否则环境一变就是「产品有罪」。
5. **夹具重算计划要连输入一起重算**：产品的计划常来自运行期探测（`launchIsolated` 内部
   `findChromeWin()`），夹具只重算纯函数那一半就会**不同源**——本仓实测：夹具认定
   `explorer.exe`、产品问的是 `chrome.exe`，症状是「一个进程都不起 + ok:false」，
   读起来完全像产品缺陷。规则：夹具与产品共用同一份输入（同源探测结果或显式注入缝），
   并补一条「产品实际询问/消费的对象 == 夹具认定的对象」前提例。
   **推论（run `35488336734` 实测）**：前提例断言的形态也要覆盖被测实现的**全部分支**——本仓把同源写成
   「产品问的**第一个** == 夹具认定的」，而 chain 分支的产品是先对**全部**候选做预检再挑可用者，
   于是在 linux/macos 宿主自证为红（single 分支反而绿）。正确写法是断言**序列逐位相同**，
   与可达位置在哪一格无关；只验一条分支的判据等于没有判据。

**为什么这五条同属一类**：它们都不会让产品变坏，只会让**门禁在绿与红之间撒谎**——
恒空的段、恒 0 的计数、恒空的异步事件、不成立的环境前提、不同源的夹具计划，判红时报的都是
「产品没做」，读者却要去改产品。
而代价不对称：**崩溃 > 判红 > 空转**（判红吃掉一条断言，崩溃吃掉整份文件加链上其后所有文件，
空转则把缺口永久隐藏），所以异步块要把汇总与 `process.exit` 挂到完成回调上，
并让块自身抛错降级为一条 FAIL。

**边界**：本条不豁免 §0/§5 的限制——上述五点都可以在本机用**只读静态审阅**或
`/tmp` 一次性纯函数/注入替身探针预先排掉（跑完即删），但**结论仍由 CI 四平台裁决**。
