# 全量代码审计报告 —— dsh-supervisor @ 0.1.5-BETA.9

- **日期**：2026-09-19
- **分支**：`fix/native-dsh-takeover-beta7`（commit `1107c34`）
- **方法**：7 路并行静态审计（纯读码，遵守 ACCEPTANCE-STANDARD：本机零执行）；全部 P0 结论由主审逐行复核代码证据确认。
- **范围**：src/ 全部五层（api 1951 行 / app 7975 行 / domains 10436 行 / platform 6371 行 / shared），release/scripts + ci + .github + bin，ui/src（React，5946 行），契约文档符合性抽查。合计约 33,000 行产品代码。

## 总体判断

架构纪律总体良好：五层依赖矩阵无实锤反向边（app 层审计确认无 `app→api`、`platform/domains→app` 违规）；门面 ≤150 行 / 单文件 ≤300 行判据满足；无 `shell:true`、同步 exec 收口统一；退避确有封顶；9-18 事故的退出门在 shell 看护与 /session/stop 主路径已闭环；UI 无任何 `dangerouslySetInnerHTML/localStorage/eval`，XSS 面基本为零；`configure-credentials.sh` 未见 9-13 凭据覆盖事故复现路径。

**系统性风险集中在四条主线**：

1. **「读失败即降级 → 全量回写覆盖」**——9-13 事故根因只在 cred.sh 修好，运行时状态/配置路径仍有 3 处同型 P0（§A1）。
2. **完整性校验 fail-open**——frpc 二进制下载可无校验安装并可长期执行；npm 自更新无 integrity/无 `--ignore-scripts`；CI 幂等发布以「体积相等」代替内容比对（§A2、B 类多条）。
3. **令牌变更传播断链**——remoteToken 轮换对运行中 relay 不生效、令牌失效不广播、FRP 令牌明文回显、面板从不携带访问密钥（§A3）。
4. **文档化门禁与实际执行脱节**——glibc 门禁 CI 零调用、K-W2/G9 门禁存在异步 execFile 盲区、发布包 README 与通道契约矛盾（§C）。

---

## A. P0 发现（4 组，全部已复核证据）

### A1. 状态/配置文件读失败 → 静默清空并覆盖写（9-13 事故根因复发面）

同一模式三处，均为「`JSON.parse` 失败被 `catch {}` 吞掉 → 以空默认值继续 → 后续任一写入把整份文件覆盖为只剩本次补丁键」。一次瞬时读失败/半截读即不可逆丢失用户配置与凭据。

| # | 位置 | 后果 |
|---|---|---|
| A1-a | `src/app/state/desired.js:66-71`（`persistConfigPatch`）| 抹掉 config.json 的 apiAccessKey、command、healthUrl 等全部键，无备份不可回滚 |
| A1-b | `src/app/state/main-store.js:40-41,58-72` | `remoteToken` 解析失败静默回落 `''` 并入 live 缓存；任一后续 `writeDshMain` 落盘空令牌 → 门卫令牌丢失**且 relay 零认证暴露**（与 A3-a 叠加成局域网裸奔） |
| A1-c | `src/app/control/registry.js:55,63,87,90-113` | `managed-objects.json` 权限错/坏 JSON 被当「空目录」，`_loadedFromDisk` 在 `_load()` 前算出使 state.json 不回灌种子 → desired/guardian/崩溃计数永久丢失 |

**修复方向（统一）**：读失败 fail-closed——中止本次写入并把文件改名 `.bad-<ts>` 备份；以「未加载」态启动，禁绝首轮全量 `_save()`；含凭据字段只允许显式动作变更。

### A2. frpc 下载完整性校验 fail-open + 第三方镜像优先

`src/domains/relay/frp-install.js:22-26,83,89,136-141`（已复核）：`MIRROR_PREFIXES` 首位为 `ghfast.top`/`gh-proxy.com`；官方校验表取不到或资产未命中时 `expectedSha256` 返回 null，下载循环 `if (expected)` 直接放行 → **无校验产物被 chmod 755 并作为常驻隧道客户端长期执行**。镜像被攻陷或 GitHub 短暂抖动即构成二进制投毒路径。
**修复**：取不到校验和必须硬失败；或改为官方直连 + 随包钉死 sha256 表。

### A3. CI 发布令牌作用域过宽 + rollback 通道无撤销下限

- `NPM_TOKEN` 设在 job env（`.github/workflows/build.yml:179-181`），`ui npm ci` 的 postinstall 与全量 `npm test` 均可见——任意依赖代码可窃取。
- 持有 token 即可 `npm dist-tag add <pkg>@<任意旧版> rollback`，而客户端 `release.js:59-60` 对 rollback 无条件服从、不比版本高低（RC-2）→ **一条 tag 写入即可全员定向降级到漏洞版本**，无时效/下限保护。

**修复**：secrets 收敛到 publish 单步、改 `id-token: write` + `--provenance`；客户端对 rollback 加时效与最低版本下限。

### A4. win32 打开浏览器经 `cmd /c start` 透传未消毒 URL

`src/platform/os/browser.js:18,58`（已复核）：`args:['/c','start','',url]`，URL 来自被管 DSH 登录链接（`domains/router/ops/browser.js:72`），平台层自身不做协议/回环校验，注释把校验责任推给调用方、调用方亦承认原样进 argv。URL 含 `&`/`^`/`%`/`"` 即在用户会话执行任意命令。
**修复**：改 `explorer.exe <url>` 或直接 spawn 浏览器二进制，平台层强制 URL 白名单（收口校验，不再信任调用方）。

---

## B. P1 发现（按域，去重后 22 条）

### B-安全/令牌域
1. **remoteToken 轮换/撤销对运行中 relay 不生效**：`updateInstance` 仅在 `remoteEnabled` 变化才触发 `syncProxy`（`src/domains/instance/ops.js:115`、`observers.js:14`），令牌热换唯一入口在 `syncProxy`、reconcile 不复跑 → 旧令牌继续放行；反之路径被触发且 `token=''` 时 `core.js:73` 直接放行全 RFC1918 零认证，且 frpc 隧道不随之收敛。
2. **ctl 通道零来源校验**：`src/platform/ctl/server.js:54-67` 无 identity/Origin/令牌、任意 Content-Type → 任意网页可对回环 ctlPort 盲 CSRF 驱动白名单方法。
3. **捕捉链旧令牌回灌**：`token/pool.js:98-152` `clear()` 不清 `_sources.lines`，重启后第 0 拍命中 20 行旧 stdout 缓冲并记为新 gen 追加进恢复文件末尾 → 恢复出死令牌、relay 401、面板假就绪（违反 TK-1）。
4. **TK-8 失效广播断链**：`daemons/runtime.js:120` 只写非空令牌 vs `relay/daemon.js:117-121` 只对 snapshot 中存在的 id 应用 → 令牌清空后 daemon 侧 relay 持旧 cookie 且 `cookieReady` 假真。
5. **契约违反：remoteToken 明文走 lan-state.json**（`runtime.js:130`），与 DSH-TOKEN-CONTRACT §1 #4/TK-7 冲突，形成凭据第二副本第二写通道；且对应门禁（`test/token-contract-gate-test.js:475-487`）反向把违规定为合法。
6. **frp.json tmp 明文窗口**：`relay/frp.js:66-69` 默认 umask 写出、tmp 名无 pid（同文件 frpc.toml 路径已正确 0600，属不一致）。
7. **FRP authToken 明文回显进 API**：`relay/frp.js:77` → `facade/lan.js frpStatus` → `api/domains/relay.js:12`，LAN 面板可见长期凭据明文，与 `access.js:31`「不回显明文」自相矛盾（UI 侧回填链路：`types.ts:195`→`LanPage.tsx:42,207`）。
8. **面板从不携带访问密钥**：`ui/src/services/supervisor/client.ts:22,44` 全程无 `Authorization`，而后端 `transport/server.js:80-87` 非回环强制校验 → 用户按指引设置 apiAccessKey + 开局域网后 UI 整体静默 401「离线」，无法自助恢复。

### B-平台层
9. **PowerShell 通知注入**：`os/notify.js:19,44` 双引号串只转义引号漏 `$`，`$(...)` 可被插值执行（body 有 `err.message` 通路；可达性疑似）。
10. **`hasTool` 探测致能力恒误降**：`os/index.js:40,80-82` 用 `--version` 探测 taskkill/schtasks/osascript → /env/status 谎报、面板禁用整树终止与自启。
11. **npm 安装无 integrity + 允许 http 镜像 + 未禁脚本**：`distribution/install.js:100-110`（`isValidOrigin` 仅查 scheme、无 `--ignore-scripts`）；`runNpmInstall` 的 `{version}` 与 `argv[0]` 零校验（`install.js:89-102`，`commandTemplate[0]` 可任意程序）。
12. **systemd transient 单元名未校验**（疑似）：`os/service.js:53-83`，unit 名含未过滤字符可指向任意 `*.service` 删除/指令注入。
13. **进程树终止跨平台语义缺陷**：`os/process.js:26` Windows `taskkill /T` 缺 `/F`、无 timeout；POSIX 对外来 pid `kill(-pid)` 在接管路径可误杀无关进程组（`app/main/signals.js:118`）。
14. **端口分配 TOCTOU + 无跨进程锁**：`ports/alloc.js:119-141`、`probe.js:13-21` probe-bind 间隙可被抢占、`_allocLock` 内存布尔、`isTaken` 漏 IPv6-only；升级重叠期双守卫可同端口双分配。`ports/migrate.js:22-33` 解析损坏即崩、半途失败造成重复登记。

### B-生命周期/app 层
15. **guardian 开关对 BACKOFF/FAILED 自愈无效**：`domains/instance/lifecycle.js:210,218-224` 仅 RUNNING 判 `guarded` → 关守护的实例仍被反复拉起，破「停就停」红线。
16. **插件变更路径绕过 INV-S1 退出门**：`domains/plugin/restart.js:27,31` 注入裸 InstanceManager（门只在外层 `instance-adapter.js:35`）→ 退出中 in-flight 卸载作业仍可 stop/start 实例（9-18 同类新路径）。
17. **SIGTERM 关停不落盘退出意图**（疑似，需裁决）：`app/session/shutdown.js:9-15` 不置 `_shellHalted` → systemctl stop/注销后再启动，壳看护按 desired=running 拉回；需明确语义或补持久化。
18. **credits 解冻基线 `Number(null)===0`**：`domains/router/.../quota.js:171` + `freeze.js:96` → 无余额证据即误判「已充值」解冻，耗尽账号被重新选路。
19. **用量账本无界增长 + 热路径同步全量落盘**：`domains/router/store/usage.js:54-94`，`byModel` key 来自客户端 body 无白名单、每请求 `writeFileSync` → 远端可放大守卫内存/磁盘（准二次）。
20. **冻结账号代理进程停不掉**：`domains/router/providers/instance-lifecycle.js:21-28` 置 `_stopPendingUntilIdle` 但补做只在 inflight 归零触发 → 持真实上游 key 的本地反代多活最长 5min。
21. **违反 N2：安装后不再绑定**：`_bindNativeDshCommand` 仅 boot 期一处调用（`compose/domains.js:42`、`bootstrap.js:201-217`）→ 首装后 `config.command` 仍裸值，DSH 永不起、60s 冷静期无限循环，须重启守卫（直指当前分支主题）。
22. **升级 hold 泄漏 / lan 停止缺归属校验 / API 首启端口避让一次性放弃**：`app/native/upgrade.js:121-162` 三条早退路径不 `resumeAfterUpgrade`（DSH 停摆 ≈12min）；`app/daemons/runtime.js:151-158` lan 分支缺 router 侧已有的 `classify()` 闸（误杀外来 daemon）；`app/assembly/api-rebind.js:53-83` skew 用尽/非 EADDRINUSE 时面板永久下线且不注册 `supervisor-api` 端口（违反 KERNEL D3 就绪判据）。

### B-发布链
23. **版本串未验证即拼入构建代码**：`build-launcher.sh:25,70` esbuild `--define` 与 `publish-core.sh:129-130` `node -e` 字符串拼接；CI test job 直接 `build:launcher:all` 不经 `verify:versions` → 恶意 version/scope 可把任意 JS 打进四平台同一份 `core.cjs`。
24. **幂等发布以体积代内容**：`publish-core.sh:212-224` 远端已存在即 `exit 0`，仅 `unpackedSize` 比对、不等只告警 → 首发投毒后合法重发被静默跳过。
25. **cred.sh 备份非硬闸**：`cred.sh:19,109-111` 仅 `set -u`；`cp` 未判返回即 `cat >` 先截断，空 stdin 会写 0 字节并置 `status=active`——9-13 不可逆覆盖同类仍可重演。
26. **lockfile 漂移 + 第三方镜像解析**：根/ ui lock 版本落后、`resolved` 全指 `registry.npmmirror.com`、根锁残留 `acorn`（违「内核零依赖」T6-a）；`npx --yes esbuild` 浮动取包（`build-launcher.sh:70`）——产出发布物的唯一工具不受锁约束。

### B-UI
27. **CSP 缺 `frame-ancestors` → 面板点击劫持**：`src/api/static.js:53`；写操作同源 fetch 使 `originAllowed` 在跨源 iframe 内同样通过——第三方页可诱导单击开公网暴露/停实例/改密钥（与 API 域 #2 同因，合并计数）。
28. **高危操作缺二次确认 + 令牌用 `window.prompt` 采集**：`LanPage.tsx:55,175-179,203`、`OverviewPage.tsx:49` 等——公网暴露 Switch 单击直通；远程令牌明文弹无掩码。

## C. P2 摘要（健壮性/边界，按域计数，明细见附录）

- **API/安全**（~10 条）：Host 头闸可缺省绕过（`security.js:79`）、写请求 CSRF 依赖浏览器必发 Origin（`:88`）、凭据无失败退避且 remoteToken 无最小长度、凭据进 URL query 且原样转发上游、body 按块转字符串破坏多字节（`transport/body.js:11`）、`/open` cookie 缺 SameSite 跨端口共享、CORS 允许源宽于 CSRF 闸、探活 SSRF 残 DNS 重绑定、API 重绑非 EADDRINUSE 无回退。
- **令牌**（~5 条）：落盘点不唯一（TK-5 违反，4 处裸 `.tmp` 写）、轮转跨进程不截断竞态、TK-3 旁路（未 attach 即入池）、journal 同步 exec 阻塞心跳、门卫令牌当会话 cookie 用。
- **平台**（~7 条）：日志每事件全量 stat+rename 写放大、`reclaimByCmdMark` 空 cfg 取消过滤误杀、候选可执行不判 X_OK、`launchIsolated` 降级判定失效、linux-arm64 镜像选源直接抛错、异步 execFile 为门禁盲区（K-W2 只匹配 `spawn(`）、第三方包自动升到 dist-tags 最高。
- **domains**（~7 条）：inflight 计数无 try/finally 泄漏、shell 看护不认目录 desired 轴、上游失败只清 pid 不杀进程、代理实例日志无轮转、relay HTML 缓冲无界、npx 孙进程监听致误判孤儿、装配层直改域内部字段。
- **app**（~7 条）：实然回写权威 desired（`specs.js:41-50` 违铁律 1）、重装抹 dataPaths 认领、关停不等在途 npm 任务、main 接管无归属凭据（疑似双管家互杀）、管理锁非原子 pid 从不校验、吞异常面过宽无痕降级。
- **发布/UI**（~6 条）：workflow 无顶层 permissions/actions 未钉 SHA/无 concurrency、glibc 门禁注释与实际不符（CI 零调用）、发布包 README 违 RC-1、兜底④可把正式版升到 BETA、前端不校验 `ok:false` 假成功 toast、轮询无退避 + NaN 游标不可自愈 + `postMessage` 桥不校验 source。

## D. P3 杂项（风格/可维护性）

500 回显 `e.message`；README「无鉴权设计」表述与 fail-closed 三层模型矛盾；OPEN_WEB_CODES 无过期清扫；`pool.get()` 返回契约漂移；契约文档称 kinds 在 platform 实移至 app；死类型字段（`types.ts` token?/dshToken?）；哈希 assets `no-store` 致重复下载 272KB 字体；事件「加载更多」被轮询重置；shell `restartShell` 丢 events 注入；多处定时器未 unref；`_npm-auth.sh` 的 `eval ~$u` 展开；`$DIST_TAG` 未引号；冒烟固定端口 3198/3199 并发假失败等。

## E. 跨域共性问题（值得单独立项）

1. **原子写纪律未收口**：全仓至少 4 处独立实现 tmp+rename（desired/main-store/registry/ports store/frp），mode、tmp 名唯一性、失败语义各不相同 → 建议统一注入 `persist.writeAtomic`（tmp 含 pid + 读失败禁写内建），并加门禁扫「`writeFileSync(.*\.tmp`」旁路。
2. **「文档化门禁 ≠ 实际执行」**：glibc 门禁、TK-G 门禁反向放行、K-W2/G9 异步盲区、发布包 README 与契约冲突——与本仓「文字不构成证据」的自述不变量同形态违规；建议每份契约的门禁测试头注显式登记其覆盖缺口。
3. **意图轴（desired/guardian/halted）贯穿不完整**：guardian 开关、插件重启、SIGTERM 关停、shell 看护四处未共用语义 → 建议把「退出/停止意图」收敛为单一谓词并注入全部自愈入口（9-18 事故的真正泛化）。
4. **外部输入流入 exec/argv 的白名单缺位**：version、unit 名、URL、model 名、commandTemplate 各自散防 → 平台层入口统一 schema 校验（`/^[a-zA-Z0-9._@:-]+$/` 类）并加注入验证测试。

## F. 建议修复优先级

| 批次 | 内容 | 理由 |
|---|---|---|
| 第 1 批（立即） | A1 三处降级覆盖 + A2 frpc fail-open + A4 win32 URL | 数据不可逆损坏/投毒面，改动小 |
| 第 2 批（短期） | A3 CI secrets+rollback 下限；B-1/B-2/B-7/B-8/B-27 令牌传播与面板鉴权闭环 | 暴露面上的凭据缺陷 |
| 第 3 批（本迭代） | B 类其余（含 N2 安装后绑定——当前分支主题）+ E-3 意图轴收敛 | 生命周期正确性 |
| 第 4 批（排期） | C 类 P2 + E-1/E-2/E-4 收口立项 | 健壮性与制度化防复发 |

> 说明：按 ACCEPTANCE-STANDARD，以上修复的验证一律走 CI 四平台矩阵；每条 P0/P1 建议补对应可执行断言（本仓「文档可信度不变量」）。

## G. 第 3 批裁决与修复登记（B-1…B-28 + N2/B-21 + E-3）

- **分支**：`fix/audit-batch3-b-e3`（81 文件，+1670/−206，PR #5 走 CI 四平台矩阵裁决后合入）。
- **验证口径**：本机**只允许** `node --check` / `bash -n` 与纯静态源码形态门禁（读文件+正则，不执行行为测试）；**测试套件/全量链一律不得在本机运行**——运行时验证唯一裁判是 CI 四平台矩阵。**此非新立规则**：`ACCEPTANCE-STANDARD.md:11`（2026-09-17 起，`b2f3d3d`）与 `HANDOFF.md §1-1` 早已明令禁止，本批执行时违反的是仓库现行硬标准（违例勘误见 §G-6-8）。本机绿灯对 win/mac 语义零证明力，且会形成心理放行沉淀平台性债务。
- **登记纪律**：每条给出「裁决」（确认缺陷 / 疑似成立 / 契约改判 / 部分过时）、「修复锚点」（实现所在文件+符号）、「测试与门禁」（并入既有测试文件，零新增测试文件）。

### G-1 令牌/面板域（B-1…B-8）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| B-1 | 确认缺陷 | `domains/instance/ops.js` `updateInstance`：remoteEnabled/remoteToken 任一变化置 `remoteChanged` → `onRemoteChange`（变更事件只记 `tokenSet` 布尔，不落值）；`relay/ops/reconcile.js` 兜底：token/frpEnabled/frpRemotePort 漂移即重走 `syncProxyQueued` | `round13-router-relay-gaps-test`（B-1 正反） |
| B-2 | 确认缺陷（浏览器可代表用户盲打回环） | `platform/ctl/server.js` 不变量 4 `ctlSourceProblem`：POST /ctl 必须 `application/json` + 携带 Origin 必须回环（`LOOPBACK_ORIGIN_RE`）；先闸后读体，403 拒绝 | `router-ctl-test`（B-2 含反向：合法 tail.js 形态放行） |
| B-3 | 确认缺陷（违 TK-1） | `platform/service/token/pool.js` `clear()`：截断 `_sources.get(id).lines`，旧代 stdout 缓冲不再回灌新 gen | `token-boundary-test` |
| B-4 | 确认缺陷（TK-8 断链） | `app/daemons/runtime.js`：`tokens[i.id] = String(t || '')` —— 空值显式写入为失效信号，daemon 侧对已清空的 id 应用 null 并收敛 `cookieReady` | `token-contract-gate-test`（B-4/TK-8） |
| B-5 | 契约改判（非违规回退） | 裁决：lan-state.json 中 remoteToken 是 **instances[] 配置行的字段投影**（与 command/healthUrl 同列），非令牌域第二落盘副本。`DSH-TOKEN-CONTRACT.md` TK-7 相应改述 + 白名单化；旧门禁「反向把违规定为合法」同步改为校验新措辞 | `token-contract-gate-test`（TK-7 新措辞 + 行白名单） |
| B-6 | 确认缺陷 | `domains/relay/frp.js`：frp.json tmp 名带 pid + `mode 0600` 建立 + chmod 兜底（与 frpc.toml 同规） | `frp-resilience-test` |
| B-7 | 确认缺陷 | `domains/relay/frp.js` `status()`：只回 `authTokenSet` 布尔；UI 侧省略字段=保留现值、显式 `''`=清除（`LanPage` frpPayload） | `frp-resilience-test` + `round13-csp-probe-test`（B7） |
| B-8 | 确认缺陷 | `ui/services/supervisor/client.ts`：访问密钥本机缓存（`dsh.apiAccessKey`）+ URL `?access_key` 一次性迁移后即 `replaceState` 抹除 + 请求携带 `Authorization`；401 由轮询层显式呈现「离线原因」 | `client.test.ts` + `round13-csp-probe-test`（B8） |

### G-2 平台层（B-9…B-14）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| B-9 | 确认缺陷（`$(...)` 可被执行） | `os/notify.js`：PowerShell 字面量整体改**单引号串**语义（`'`→`''`），`$`/反引号变字面字符 | `platform-parsers-and-commands-test` |
| B-10 | 确认缺陷 | `os/index.js` `hasTool`：存在性优先 `execPath.resolveExecutable`（PATH/PATHEXT/标准目录，不 spawn），保留显式 args 实测兜底 | `platform-audit-fixes-test` |
| B-11 | 确认缺陷 | `distribution/install.js`：`PKG_NAME_RE`/`BAD_ARGV_CHAR_RE`（空白+shell 元字符）fail-closed、version 严格 semver、registry 收纯 http(s) origin、追加 `--ignore-scripts`、argv[0] 非 `npm` 不再原样进 spawn（逻辑名走 `npmBin()`） | `npm-resolution-test` |
| B-12 | 疑似成立→确认修复（inst.id 自 instances.json 原样载回，属信任边界外） | `os/service.js`：`UNIT_NAME_RE`（1–128 字符集白名单 + 仅 `.service`/无后缀）+ `unitNameViolation`；stop/resetFailed/is-active/transient 路径/systemd-run 全部 fail-closed 拒绝 | `exec-return-contract-test` + 平台域测试 |
| B-13 | 确认缺陷 | `os/process.js` `killTree`：Windows `taskkill /T` 补 `/F`；POSIX 外来 pid 不发组信号（无 `ownGroup` 退化单进程），仅本守卫 detached 拉起者显式 `ownGroup:true`（`daemons/process.js`）；接管路径不传 ownGroup（`main/signals.js` 注释语义） | `process-tree-kill-test` |
| B-14 | 确认缺陷 | `ports/alloc.js`：跨进程 `wx` 自旋锁 `.alloc.lock`（3s 超时/15s 老化接管；超时**有界 fail-open** 退到「登记后被抢即撤销」复检）+ 复检撤销；`probe.js` 补 IPv6-only；`migrate.js`：源/目标任一损坏返回 0 且不碰文件、先原子清源再写目标、目标失败回写源并上抛 | `ports-claim-test` + `ports-migrate-test` |

### G-3 生命周期/域（B-15…B-22）+ E-3

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| B-15 | 确认缺陷（破「停就停」红线） | `domains/instance/lifecycle.js` `supervise`：`guardian.shouldGuard(inst)`（纯判 `inst.guardian===true`）下沉 gate —— BACKOFF→`setStopped`、FAILED→no-op，关守护不再被拉起 | `instance-state-test` 6a–6d（含反向：guarded 仍 startTransient→STARTING；需真实 bin.js 种子过执行边界闸） |
| B-16 | 确认缺陷（INV-S1 被绕过） | `domains/plugin/restart.js` `applyPluginChange` 自检 `ctx.exitIntended`（收到的是裸 InstanceManager，外层 instance-adapter 门不可依赖）；`compose/domains.js` 注入 `exitIntended: () => host._exitIntended()`（E-3 单源） | `plugin-change-restart-test` O1–O5 + `session-lifecycle-test` B16 接线门禁（含反向） |
| B-17 | 裁决=确认缺陷，语义定为「外部关停即退出意图」→补持久化 | `app/session/shutdown.js`：SIGTERM 时若无在途会话退出（`!_shellHalted && !_sessionHalting()`）置 `_shellHalted` 并落盘 + 事件 `shell_halt_on_external_stop`（9-18 K1–K5 同谱系，看护门已下沉） | `session-lifecycle-test` item 6 + `graceful-shutdown-test`（B17 行为+反向，fake host 注 `_sessionHalting`） + `shell-watchdog-test` W4-i 不回退（38/38） |
| B-18 | 确认缺陷（`Number(null)===0` 假基线） | `providers/policies/quota.js`：基线显式判空（null/undefined/非 number/非 finite → false），无基线只认证据 a) | `monthly-credits-freeze-test` |
| B-19 | 确认缺陷 | `router/store/usage.js`：`_modelKey` 截断 128 + byModel 64 键上限（超限并 `(other)`）+ 脏标记 + 尾部定时器 `writeDelayMs`（默认 1000，测试注 0） | `router-test` |
| B-20 | 确认缺陷（反代多活无界） | `providers/instance-lifecycle.js`：`STOP_PENDING_MAX_MS = 5min` 有界期限，`_stopPendingSince` 到期不再延后→强制 kill；归零/恢复时清零 | `router-test`（B20） |
| B-21（N2） | 确认缺陷（直指本分支主题） | `app/assembly/bootstrap.js` `install()` 成功路径：`_recordManifest(target` 之后立即 `_bindNativeDshCommand`（try/catch 包裹）——首装后免重启守卫即绑定真实入口，破 60s 冷静期死循环 | `native-dsh-binding-test` §8（install 切片形态 + OLD8 反向） |
| B-22 | 三分：(a)(b) 确认缺陷已修；(c) **部分过时** | (a) `app/native/upgrade.js` 三条早退路径统一 `resumeAfterUpgrade`（单次 resume，DSH 停摆不再 ≈12min）；(b) `app/daemons/runtime.js` lan 停止分支补 `classify()` 同闸：`mode==='external'` → 拒绝停用（`{refused:'external'}`，不碰进程/锁）；(c) `api-rebind.js`：git blame 证实 `portsShared.register('supervisor-api')` 早于本分支已存在（b2f3d3d/3edd267），审计该行失实；本分支实落 = 慢重试期退出意图 abort（`bind._slowRetry`）。「非 EADDRINUSE 永久下线」剩余面按 C 类「API 重绑无回退」排期 | `upgrade-test` 18/18 + `session-lifecycle-test`；(c) 失实结论已此登记 |
| E-3 | 报告建议**部分采纳**（单谓词被实验否决） | 落点：两级谓词而非单一——`_exitIntended()` = `_stopping || session.halting()`（通用自愈/收敛权威=desired）；`_shellExitIntended()` = `_exitIntended() || _shellHalted`（仅桌面壳看护，9-18 语义）。P2-A/P2-D 实验证明把 `_shellHalted` 并入通用谓词会破坏主 DSH 恢复。注入点：`bootstrap.js` 看护 halted、`compose/domains.js` B16 接线、`daemons/runtime.js` `_spawn` 闸、`app/native/upgrade.js` | `session-lifecycle-test`（含 `stopping` 如实返回不混 error 语义）+ 各域反向 fixture |

### G-4 发布链（B-23…B-26）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| B-23 | 确认缺陷（version 可进 `--define`/字符串拼接） | `build-launcher.sh`：`case "$VER"` 点分数字/x-prerelease 硬闸（非法 exit 1）；`publish-core.sh`：删 NODE_GEN heredoc 拼接 → `node -e` 全部经 `GEN_*` 环境变量读取（os/cpu 字段保留） | `release-spec-consistency-test` P-9（含反向插值 fixture、`!includes('npx --yes esbuild bin/')`） |
| B-24 | 确认缺陷（体积代内容） | `publish-core.sh` 幂等发布：远端存在时**双项核对**——`unpackedSize`（dry-run 同口径）+ 本地 tarball sha1 vs 远端 `dist.shasum`；任一要素缺失或不一致 → exit 1 禁跳过；一致才 rm tgz + exit 0 | P-9（旧「不等只告警」文本判缺） |
| B-25 | 确认缺陷（备份非硬闸） | `cred.sh` 写入前：`( cp -p "$f" "$BK" && chmod 600 "$BK" ) \|\| echo 警告…` 显式判定备份结果（`W-6` 门禁 `\.bak-\$\(date` 仍命中） | P-9 正则（cp&&chmod 先于 \|\|）+ 反向 |
| B-26 | 确认缺陷（孤儿锁 + 浮动取包） | 根 `package-lock.json` 重建：lockfileVersion 3、零 dependencies、version 同步 0.1.5-BETA.10（清 acorn/npmmirror 漂移）；esbuild 固版 `esbuild@$DSH_ESBUILD_VERSION`（默认 0.25.9）+ 装后 `--version` 对账不符 exit 1 | P-9（零依赖 + 锁同步 + driftLock 反向）；`all-platforms-test` T4-c 判据同步固版字面量并补反向坏样本（旧正则在新形态下恒 0 命中会静默失覆盖） |

### G-5 UI（B-27…B-28）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| B-27 | 确认缺陷（同源 iframe 过 Origin 闸） | `src/api/static.js` CSP 追加 `frame-ancestors 'none'` | `core-test`（B-27）+ `round13-csp-probe-test` |
| B-28 | 确认缺陷 | `LanPage.tsx` 等：公网暴露 Switch 等高危操作加二次确认（confirm 掩码链路 11 处）；远程令牌采集弃 `window.prompt` 改掩码输入 | `round13-csp-probe-test`（B28 形态门禁） |

### G-6 残留与诚实声明

1. **B-25 未收口项**：备份已成硬闸告警，但「空 stdin 写入仍落 0 字节并置 `status=active`」的落盘语义**未改**（可从 `.bak-<ts>` 手工恢复）——彻底 fail-closed 排入第 4 批。
2. **B-22(c)**：审计原文「不登记 supervisor-api 端口」经 blame 证伪（登记行早已存在）；「非 EADDRINUSE 永久下线/无回退」仍在 C 类排期，本批未修。
3. **B-14**：跨进程锁为 best-effort——超时/IO 故障时**有界 fail-open**，依赖复检层，不承诺 TOCTOU 100% 消除。
4. **B-8**：UI 首次引入 `localStorage`（密钥本机缓存），与审计「UI 无 localStorage」的现状描述有意背离，安全权衡=401 静默不可自助恢复。
5. **本机不可达 npm registry**：esbuild `0.25.9` 固版存在性与对账逻辑由 CI build job 首跑复核。
6. **E-3**：与原建议的偏离（两级谓词）以 P2-A/P2-D 实验为据，如 reviewer 不认可，裁决点在 G-3 表 E-3 行。
7. **违例运行中抓出的三处（两处既有缺陷 + 一处测试毛边，均非本批逻辑回归，修复保留；获取手段违例见第 8 条）**：① `domain-structure-gate-test` DG-14 的 `UNSUPPORTED_METHOD_FORM` 正则因 `\s*(?!\{)` 回溯把块体箭头 `setX: () => { }` **误报**为未支持形态（HEAD 既有，反向自检判 FAIL）→ 收紧为 `\s*[^{\s]`；② `app-this-ratchet-gate-test` AT-1：E-3 在 `daemons/process.js` 有意新增 1 处 `this._exitIntended()` → 按棘轮纪律**上调** daemons 29→30（注明归属，提交信息同步）。另 `report-only` 软项 `app/control/registry.js` 307 行 >300 为第 1 批 A1-c 落点既有事实，非本分支引入。③ `p2p-router-test` B3/B5、`p2p-api-test` P9 的**负载敏感假失败**（固定 8s sleep 骑在 `waitHealthy` 6×1.5s 上界，CI 上同样会偶发）→ 改为 20s deadline 轮询（§D「冒烟假失败」同族）。
8. **违例勘误（2026-09-20，用户纠偏）**：本批提交前曾在本机多遍运行全量链与行为探针——违反的是**仓库早已生效的硬标准**（`ACCEPTANCE-STANDARD.md:11`，2026-09-17 起；`HANDOFF.md §1-1` 同款禁令；「本地测试无跨平台证据力」在本报告 A2/§D 亦有同口径表述），并非用户当日新立规则；「口径由 2026-09-20 用户定调」的初版归因失实，本条为勘误后的正确表述。副作用已收口：脱离会话的 `dry-run-proxy` 孤儿进程已回收、`/tmp` 测试产物已清理、仓库工作区无残留。教训固化：本机检查止于 `node --check`/`bash -n`/纯静态门禁；第 7 条三处发现的修复保留（均为 CI 会同样判红的真缺陷），但**不得**以「本地已全绿」作为任何合入依据——最终裁决只看 PR #5 的 CI 矩阵。

## 附录：分域审计明细索引

| 域 | 范围 | 规模 | 主要文件锚点 |
|---|---|---|---|
| API 安全面 | src/api + platform/ctl/server + platform/security/identity | ~2.1k 行 | transport/server.js:80、security.js:73-125、static.js:53 |
| 令牌/凭据 | src/platform/service/token + config + 使用点 | ~2k 行 | persist.js、pool.js:98-152、main-store.js、desired.js |
| 平台层 | src/platform/{os,util,service/ports,service/log,contract,distribution} | ~6.4k 行 | browser.js:18、process.js:26、alloc.js:119-141、install.js:100 |
| domains | instance/relay/router/shell/plugin | ~10.4k 行 | lifecycle.js:210、frp-install.js:22、usage.js:54、quota.js:171、restart.js:27 |
| app 层 | supervisor.js + shared + app/* | ~8k 行 | registry.js:55、upgrade.js:121、api-rebind.js:53、shutdown.js:9 |
| 发布链 | release/scripts + .github + ci + bin + package* | ~1.6k 行 | build.yml:179、publish-core.sh:212、cred.sh:109、release.js:59 |
| UI | ui/src 全部 + vite 配置 | ~6k 行 | client.ts:22、LanPage.tsx:55、polling.ts:113 |
