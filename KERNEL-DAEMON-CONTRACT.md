# 内核守护进程契约（Kernel Daemon Contract）

> **本文件定义「内核被壳启动时必须提供什么」的契约（与壳仓 KERNEL-LAUNCH-STANDARD.md 互锁）。**
> 壳侧对应规范见壳仓 `docs/KERNEL-LAUNCH-STANDARD.md`（壳如何把内核拉起来）。
> 两文件互锁：内核不满足其中任何一条，壳的启动即失败并如实报 stage。
>
> 适用四平台：linux-x64 / darwin-arm64 / darwin-x64 / win-x64（见 `src/platform/contract/matrix.js` SUPPORTED）。

---

## 1. 内核的启动契约

内核只承诺「**给定一个 Node 与一条命令 `< node > < bin/dsh-supervisor > daemon`，它能起来并对外可用**」。
以下全部是内核的责任，不得推给壳：

| # | 承诺 | 说明 |
|---|---|---|
| D1 | `daemon` 自足启动 | 不依赖 ambient PATH 里除 node 之外的任何东西；配置缺失时**自建默认配置**（`DEFAULT_CONFIG` 内嵌） |
| D2 | 不依赖 shebang | 必须能被 `node <bin> daemon` 直接执行（launcher 的 `require('../core.cjs')` 形态） |
| D3 | **对外声明实际端口** | 绑定后把 `supervisor-api` 的实际端口写入 `ports.json`（`<stateDir>/ports.json`），供壳/其他进程发现 |
| D4 | `GET /healthz` 可用 | 2xx 即就绪；壳以它作为唯一就绪判据 |
| D5 | **不安装/不升级自己** | 内核包写入者是壳（见 `archive/history/RELEASE-AND-UPDATE-MECHANISM.md` §6） |
| D6 | **不建立/不启动/不停止自己的服务定义** | 服务定义与启停的所有者是壳；内核的 `install` 不再部署 systemd/launchd/schtasks |
| D7 | **不依赖 HOME 隔离以外的全局状态** | 状态目录、锁、端口、日志都必须落在 `stateDir`（由 config 决定），不得散落到 `os.homedir()/` 固定路径 |
| D8 | 版本可自报 | `--version` 与 `/guard/version` 与实际运行版本一致（壳用于 P3 对齐校验） |
| D9 | 失败如实退出非零 | 配置损坏/锁被占/端口不可绑 → 退出非零并写明原因（交给服务管理器重启策略） |

---

## 2. 与壳的契约边界

```
壳（唯一所有者）                          内核（唯一业务本体）
─────────────────────────────            ─────────────────────────────
P0 runtime.json  ── node/npm/PATH ──►
P1 安装/升级（唯一写入者）  ──►  npm 包(dsh-core-<plat>)
P2 core.json     ── bin/prefix/version ──►
P3 定位（读 core.json）
P4 服务定义（三平台模板）  ── node+guard+daemon ──►
P5 启动（systemd/launchd/schtasks 或 spawn）──►  daemon 启动
                                          D1..D9
P6 healthz  ── GET /healthz ────────────►  2xx
P7 shell-report.json ── 壳所见 node/npm/镜像源/前缀 ──►  环境表单 `shell` 维
```

**内核不得反向**：不得安装自己（D5）、不得写服务定义（D6）、不得直接/间接启动第二个守卫实例（`guard.lock` 只允许一个 daemon）。

### 2.1 P7：壳的环境观测报告（`supervisor/shell-report.json`，schema 1）

与 P0 `runtime.json` 同目录、同为「壳写内核读」的文件，但性质相反：P0 是**启动契约**（字段错一个字符就装不上
内核，内核拿它去 spawn），P7 是**观测报告**（内核只读它给人看，永不参与 spawn）。走文件而不新开 HTTP
上报端点，是因为壳与内核恒同机、采集者就是写入者；开 HTTP 要新造带体动词再加投递重试，而那条重试正是把
「没送达」伪装成「已上报」。

读侧唯一实现：`src/platform/contract/shell-report.js`（`file()` 是路径的唯一口径，`read()` 永不抛错）。
它作为环境表单的 `shell` 维进台账（`platform/os/environment.js`），与内核自己的 `runtime` 维**并排而不互相
覆盖**：壳那一份是「装内核时真正用的那一套」，内核那一份是「本进程现在解析到的」，两份不一致就是要排障的
东西，谁盖住谁都会让这类缺陷重新隐身。

| 字段 | 含义 | 纪律 |
|---|---|---|
| `schema` | 固定 `1` | 不等即整份作废（读侧判 `unreadable-or-schema-mismatch`，不做字段猜测） |
| `writtenBy` | 写入者标识（壳版本串） | 自由文本，入站即脱敏 |
| `at` | 壳写入时的 epoch 毫秒 | 缺失即整份作废（没有它算不出年龄，会把旧报告显示成新鲜） |
| `node` | `{path,binDir,version,min,ok}` | `ok` 三态：`null` = 壳也判不出 |
| `npm` | `{path,args[],version,ok}` | `args` 与 `path` 成对（`node + 包内 npm-cli.js` 形态只念 path 会把 node 版本念成 npm 版本） |
| `prefix` | `{dir,writable,why}` | `writable:null` = 没试出来，不是不可写 |
| `registry` | `{best,latencyMs,probes[{url,ok,latencyMs}]}` | URL 里的凭据由内核抹除后才入台账与快照（私有源常把 token 写在 URL 里） |
| `records` | `[{probe,source,target,ms,ok,note}]` | 至多 64 行，超出只截断并如实报 `droppedRecords` |

读回三档（写侧与界面都必须分清，因为处置相反）：`ok` = 拿到一份可报告的观测；`never-written` = 这台机器的
壳还没报过（内核由命令行或别的进程拉起、或壳版本未含写入者，都是常态而非故障）；
`unreadable-or-schema-mismatch` = 文件在但读不出/版本不符/超字节上限，得去查那个文件。

**壳侧现状**：写入者尚未实现（本批只交付内核接收口）。未在场期间面板如实显示「这台机器的壳还没报过」。
执法：`test/runtime-contract-test.js` 的 SR 组（三档分档、schema handshake、三态不折叠、入站脱敏、
明细截断、读取口永不抛、路径口径唯一）。

---

## 3. 现状与缺口（2026-09-15 审计）

> **2026-09-15 收口**：C1–C4 均已落地（`install` 不再部署服务定义、看护收归壳、
> 端口绑定后登记实际值、状态/日志路径经 `stateDir`），且各有门禁（D-1..D-8）。
> 下表保留为**审计记录**（写的是修复前状态）。

| # | 缺口 | 证据 | 规范要求 |
|---|---|---|---|
| C1 | `install` 仍部署 systemd/launchd/schtasks 定义 | `bin/dsh-supervisor` 的 `cmdInstall` 写 `UNIT_PATH`/`DESKTOP_*` | D6：定义只由壳写 |
| C2 | Windows watchdog 是第二个启动器 | `src/platform/os/autostart/` 建 watchdog 任务并拉起 daemon | D6：保活归壳 |
| C3 | 端口声明晚于绑定 | `supervisor.js` 绑定后才 `ports.register('supervisor-api')` | D3：壳读 `ports.json`；需保证壳在等待时能发现 |
| C4 | 状态路径仍有 `os.homedir()` 直写 | `domains/router/providers/proxy.js` 拼 `~/.dsh/supervisor/logs` | D7：统一经 `stateDir` |

---

## 4. 门禁

| 门禁 | 断言 |
|---|---|
| D-1 | `daemon` 自足：配置缺失时以内嵌 `DEFAULT_CONFIG` 自建（不依赖外置模板） |
| D-2 | 对外声明端口：`supervisor-api` 写入 `ports.json` |
| D-3 | `/healthz` 2xx（壳的唯一就绪判据） |
| D-4 | 反向：`bin/dsh-supervisor` 的 `install` 不再写任何 systemd/launchd/schtasks 定义，并注明服务定义归桌面壳 |
| D-5 | 单实例：第二个 daemon 因 `guard.lock` 退出非零 |
| D-6 | `ports.json` 的 `supervisor-api` 端口 == 实际监听端口：绑定后登记实际值，顺延时以同一 owner 释放旧登记 |
| D-7 | 数据/日志路径经注入的 `stateDir`：proxy 不直拼 `os.homedir()`，router 向 provider 注入自 `config.stateFile` 派生的 `stateDir` |
| D-8 | Windows 看护（watchdog）所有者 = 桌面壳：内核不再创建 watchdog 任务、不再写 `watchdog.ps1`。2026-09-21 反向收口：壳侧看护任务的动作也不再是内嵌 PowerShell，而是稳定入口的无头模式 `<壳> --watchdog`；**桌面壳进程自愈的唯一所有者是守卫**（`domains/shell/watchdog`，三平台一套），因为壳的监督者会随壳一起死（F3） |
| D-9 | 壳的**无头模式清单**双仓同步：`domains/shell/core.js` 的 `HEADLESS_FLAGS` 必须逐一对应壳侧 `main.rs` 里「在 Tauri 初始化之前 exit」的入口（含 `--run-guard`、`--watchdog`）。漏一项 ⇒ 那个瞬时进程被 `isShellProcess` 当成「壳在运行」，看护短路成 `alive` 而永不拉起真壳；`restartShell` 共用同一谓词，漏项也会让它误杀运维进程（内核侧门禁 W2-f/g/h/i + 反空转 W2-j） |
| D-10 | D6 在**自启路径**上的三平台版：`autostart/{linux,darwin,win32}.js` 的 `setAutostart` 体内，守卫定义标识（`dsh-supervisor.service` / `GUARD_LABEL` / `'DSH-Supervisor'`）与建/删动作（写文件 / unlink / `schtasks /Create` 或 `/Delete`）不得同行共现；`enable`/`disable`、`bootstrap`/`bootout` 只作用在既有定义上，属许可。原 P2 判据只切了 macOS 一份，同一铁律在另两端无人执法（执法：`test/autostart-ownership-test.js` 的 P7 段，含四类旧形态反向样本） |
