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
| B-11 | 确认缺陷 | `distribution/install.js`：`PKG_NAME_RE`/`BAD_ARGV_CHAR_RE`（空白+shell 元字符）fail-closed、version 严格 semver、registry 收纯 http(s) origin、追加 `--ignore-scripts`、argv[0] 非 `npm` 不再原样进 spawn（逻辑名走 `npmBin()`）。**CI 抓出的本批回归已修**：`BAD_ARGV_CHAR_RE` 曾把 `\\` 一刀切禁用，误杀 win32 盘符绝对路径（`D:\a\...\test\fake-npm.js`）→ windows 升级链 U2/U3 确定性判红（runs 14–17）；现增 `WIN_DRIVE_ABS_RE` 整体形态豁免（夹带 `;`/空白/元字符仍拒），见 §G-6-9 | `npm-resolution-test`（C-f 含豁免正反例） |
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
8. **违例勘误（2026-09-20，用户纠偏）**：本批提交前曾在本机多遍运行全量链与行为探针——违反的是**仓库早已生效的硬标准**（`ACCEPTANCE-STANDARD.md:11`，2026-09-17 起；`HANDOFF.md §1-1` 同款禁令；「本地测试无跨平台证据力」在本报告 A2/§D 亦有同口径表述），并非用户当日新立规则；「口径由 2026-09-20 用户定调」的初版归因失实，本条为勘误后的正确表述。副作用已收口：脱离会话的 `dry-run-proxy` 孤儿进程已回收；`/tmp` 测试产物已清理（含 2026-09-20 复查时补删的 623 个探针 `mktemp` 目录与 `dsh-test/fuzz/sigterm/upg` 系列，共 ~9MB）；本地测试还写穿了 `DSH_SUPERVISOR_HOME` 隔离、在真实 `~/.local/state/dsh-supervisor/` 落下 18 个 `proxy-instance-vm-210xx.log`+`install-id`（该目录创建于违例时段、无既有用户数据，已整目录清除，`~/.dsh` 用户数据未触碰）。成因复核：`state-root.supervisorDir()` 认 `DSH_SUPERVISOR_HOME` 覆盖，而 `npm test` 链经 `_preload.js` 注入沙箱 HOME——违例时绕过链直跑 `node test/*.js`/裸探针才落到真实 HOME（**非产品缺陷**）；衍生观察留第 4 批裁决：测试单独运行缺省不落沙箱，属「测试基建裸奔面」，可考虑 `_preload` 判据或门禁提示。仓库工作区无残留。教训固化：本机检查止于 `node --check`/`bash -n`/纯静态门禁；第 7 条三处发现的修复保留（均为 CI 会同样判红的真缺陷），但**不得**以「本地已全绿」作为任何合入依据——最终裁决只看 PR #5 的 CI 矩阵。
9. **CI 抓出的本批回归（B-11 windows 误杀，第 8 条口径的反向验证）**：PR #5 首推后 windows build job（`ci-core.sh` 内含全量 `npm test`）的 `upgrade-test` U2/U3 **确定性判红**（runs 14–17 四连红，linux/mac/ubuntu-test 全绿）。首轮日志无错误正文 → 按第 8 条口径**未本机重跑**，而是在 U2/U3 失败分支补 `[U2-diag]/[U3-diag]` 诊断输出（`lastError`/`rolledBack`/`logTail`，run 17 抓到）→ 定位为 `runNpmInstall` 报「commandTemplate 替换后含禁用字符: `D:\a\...\test\fake-npm.js`」：B-11 的 `BAD_ARGV_CHAR_RE` 禁用集含 `\\`，把 win32 盘符绝对路径整体误杀——**修复自身引入的跨平台缺陷**，曾违例本机跑过 9 遍全绿也零证明力，与第 8 条「本机绿灯对 win 语义零证明力」互为实证。修复：`WIN_DRIVE_ABS_RE` 仅对**完整匹配** `X:\...` 形态的 argv 项豁免（夹带 `;`/引号/`$`/空白/相对形态/`D:/` 正斜杠均不豁免），正反例并入 `npm-resolution-test` C-f。首版豁免夹具自身又误设期望（`D:\a\x\y` 连续分隔符断为应拒、run 18 红后 `2c832e3` 已翻正；拆逐例时又把 `C:rel\path` 误标为放行——均为**产品对、断言错**：豁免判据是 `X:\...` 盘符绝对**形态**，不做路径规范化也不豁免 drive-relative）→ run 18/20/21 三轮同条判红。关键取证改造（`8b6dafb`）：多子句 `&&` 串一条 check 时 CI 只报条名不报子句（run 20 因此白跑一轮），拆为 11 条逐例断言 + `BAD/WIN/gate` 三值回显后，run 21 一轮即精确定位唯一错例并翻正（`48cd8e9`→`8b6dafb` 链）。过程教训×2：① 错误正文经 `/native/status` `lastError` 本已可查，是诊断断言未打印导致两轮盲等——错误透出的验收价值再次确认（同 §B-22 裁决轴）；② 断言粒度即取证粒度——**门禁类多子句断言必须逐例独立 + 判据值回显**，这是本条三轮红换来的可复用纪律。

## H. 第 4 批裁决与修复登记（C 类 P2 全量 + §E.1/§E.2/§E.4 立项收口）

- **分支 / 提交**：`fix/audit-batch4-c-e` —— A 组 `1647225`、B 组 `f84e2ea`、C 组 `371a737`、D 组 `58fcb58`、CI 红因 `241446d`、E 组 `06162f8`、F 组 `bfe782c`。
- **验证口径**：与 §G 相同——本机只 `node --check` / `bash -n` / 纯静态判据探针（一次性脚本，跑完即删），运行时裁判唯一是 CI 四平台矩阵。
- **测试并入**：断言全部并入既有入链文件，`package.json#scripts.test` 链（129 文件 / 7899 字符）**零新增、零增长**；UI 侧由 CI `[1/5] 前端门禁` 跑 vitest。

### H-0 编号消歧（必读，本批踩过一次歧义）

本报告与代码注释里同时存在三套 `E-*`，**互不相关**：

| 写法 | 含义 | 出现处 |
|---|---|---|
| `§E.1 … §E.4`（代码里常简写 `E-1…E-4`） | 本报告 **E 节跨域立项**（原子写单源 / 文档化门禁 / 意图轴 / 输入字符集） | J-n·J-o·J-p、`util/fs.js`、`util/input.js`、`glibc-gate-test`、ACCEPTANCE-STANDARD §7–§9 |
| `发布条 N` / `UI 条 N` | 第 4 批 E 组 = §C「发布/UI」六条（workflow 供应链 / glibc 落点 / README 措辞 / 兜底④ / 200 假成功 / 轮询与桥） | `build.yml:20`、`ci-core.sh [3.5/5]`、`release.js`、`dist.js`、`ui/**`、J-l·J-m |
| `E2E-N` | `shell-watchdog-e2e-test.js` 的端到端用例序号 | 该文件与 build.yml 的失败示例注释 |

历史违例：commit `06162f8` 的标题写「发布链 E-1…E-4」，与同批 F 组收口的 §E.1/§E.2/§E.4 撞名（本段即为此登记）。**处置**：把发布/UI 轴的字面标签统一改为 `发布条 N` / `UI 条 N`（2026-09-20 已全量改标，涉及 `build.yml`、`release.js`、`RELEASE-CHANNEL-CONTRACT`、`dist.js`、`ui/**`、`round8-fixes-test` J-l/J-m、`workflow-parse-test`、`release-channel-test`、`kernel-update-single-writer-test`、README、CROSS-PLATFORM），立项轴继续写 `§E.N`。

### H-1 API/安全域（C-1…C-9）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| C-1 | 确认缺陷（缺 Host 时整块跳过 → 两闸同时归零） | `api/security.js` `originAllowed`：Host 缺失即 fail-closed 拒绝 | `defects-batch-f-test`（K6-a 含反向：合法 Host 放行） |
| C-2 | 裁决=**保持现状并钉死**（现代浏览器对 POST 一律发 Origin；不放宽为「无 Origin 即放行」） | `api/security.js` 注释登记裁决 + 判据 | `defects-batch-f-test` |
| C-3 | 确认缺陷（令牌无长度下限、门卫凭据可无限爆破、WS 升级旁路） | `relay/core.js` `remoteTokenStrength`（<8 拒，单一事实源）+ `backoffGate` 纯函数（计时账本由调用方持有）；`domains/instance/ops.js` 三点写入口前置校验；`relay/proxy.js` per-IP 账本（60s 窗口 ≥10 次 → 429 + Retry-After）；`relay/tunnel.js` WS 升级同闸（`gateWaitMs`） | `lan-access-boundary-test` + `round13-router-relay-gaps-test`；UI 强度提示 |
| C-4 | 确认缺陷（门卫令牌进上游请求行 + 凭证响应可被缓存） | `relay/core.js` 转发路径剥离 `token=`；`relay/proxy.js` 401/302/429 统一 `no-store` | `relay-dshauth-test`（A 组） |
| C-5 | 确认缺陷（`body += d` 逐块隐式解码，跨块多字节损坏；上限按字符数可撑内存） | `api/transport/body.js` 改 Buffer 累积 + end 一次性 utf8 + **按字节**计上限 | `core-test` |
| C-6 | 确认缺陷 | `api/domains/instances.js` `/open` 303 的 Cookie 补 `SameSite=Strict`（跨端口共享是设计意图，跨站不是） | `kernel-daemon-contract-test` |
| C-7 | 确认缺陷（两份壳来源判定，server 侧更宽含 `*.tauri.localhost` 通配） | 收敛 `api/security.js` `isShellOrigin` 为单一事实源，`transport/server.js` CORS 白名单复用 | `core-test` + `defects-batch-f-test` |
| C-8 | 确认缺陷（`registryOriginViolation` 只过 origin 形态，可指回环/元数据地址） | `platform/distribution/policies.js` 复用 `shared/ip` 的 `isPrivateHostLiteral` 分级；`registry.js:221` 写入口闸。**CI 首抓真回归**：早退分支把 `state.registryConfig.mode` 改了（rc 是别名不是副本）→ `241446d` 改副本、只有全闸通过才回写 | `round8-fixes-test`（C-8 早退零改动，:351 段） |
| C-9（=B-22c） | 确认缺陷（非 EADDRINUSE 错误停在静默分支） | `app/assembly/api-rebind.js:27` 按可重试性分类：`EADDRINUSE/EADDRNOTAVAIL` 进快慢重试环，`EACCES` → `api_offline` 明确下线并留痕 | `round8-fixes-test` + UI `api_offline` 文案 |

### H-2 令牌域（§C 令牌条 2…5；条 1「落盘点不唯一」归 §E.1，见 H-6）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| 条2 | 确认缺陷（跨进程轮转竞态） | `platform/service/token/persist.js` `rotateByBackup`：改「**原子 rename 抢占**进备份槽」；rename 失败降级为复制+截断（窗口更小但**不为零**，注释如实登记） | `round13-discipline-gaps-test`（③ 组） |
| 条3 | 确认缺陷（TK-3 旁路：未 attach 的隐式源绕过 kind 闸） | `token/pool.js` `feedLine`：隐式源必须过与 attach **同一** kind 登记闸，推断不出/未登记一律拒入池 | `token-boundary-test`（夹具改走合规分类——旧夹具实为依赖旁路） |
| 条4 | 确认缺陷（journal 同步 exec 冻结心跳 5s） | `util/exec.js` 新增 `runOutAsync`（沿用有界纪律）；`token/capture.js` `captureOnce` 收窄为 stdout/文件两档（同步零外进程），`captureJournal` 异步发射 | `core-test` + G9 门禁（`exec-bounded-gate-test`） |
| 条5 | 确认缺陷（门卫令牌被当会话 cookie 长期驻留） | `relay/core.js` `lanGateCookieValue`：cookie 存 `sha256(salt\|token)`（salt 每 relay 进程随机），令牌原文只容 `?token=` 一次性出示；HTTP 与 WS 两路同闸 → 重启/换令牌即会话全失效 | `relay-dshauth-test`；DSH-TOKEN-CONTRACT §1 #7 |

### H-3 平台层（§C 平台条 1…7）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| 条1 | 确认缺陷（写放大：每行/每事件 stat + meta 全量重写） | `platform/service/log/log.js` `Rotator`：首写 stat + 字节记账（每 64 行回读真值防多写者漂移，异常即作废账本）；`log/events.js` 估算越阈才真 stat 复核，meta 每 32 seq 落盘且轮转即时落，构造期 seq 取 `max(meta, 文件末行)` | `core-test` |
| 条2 | 确认缺陷（`reclaimByCmdMark` 空 cfg 取消过滤 → 误杀） | `platform/service/ports/probe.js:57` 入口双闸（cmdMark/configPath 任一为空即 0 回收，fail-closed） | `adopt-token-reclaim-test` |
| 条3 | 确认缺陷（候选不判 X_OK，0644 半截安装被当「已安装」） | `platform/os/exec-path.js` `isExecutableFile`（POSIX 判 X_OK、win32 免判），`firstExecutable`/envVar/`pidlookup.ss` 绝对路径候选全部改用 | `platform-layer-portability-test`（X-9） |
| 条4 | 确认缺陷（Node 的 spawn ENOENT 是异步事件，旧递归降级返回值被丢弃 → 首候选固化死 bin） | `platform/os/browser.js` `launchIsolated`：spawn **前**可用性预检 + chain 预过滤 + `opts.binAvailable` 注入点 | `platform-audit-fixes-test`/`core-test` |
| 条5 | 确认缺陷（不可产标宿主同步抛穿透 `Promise.all`；`platformTag` 空值把字面量 `undefined` 拼进 URL 恒 404） | `distribution/registry.js` `probeRegistry` 加 `matrix.isSupported` 闸 + try/catch；`resolveProbe` 补 platformTag 空值守卫（`platformTag` 本体一字不动，P-6 钉） | `round13-contract-reload-test` |
| 条6 | 确认缺陷（异步 exec 面是 K-W2 盲区，Windows 弹黑框） | `util/exec.js` `runAsync/runOutAsync` 固定 `windowsHide`；收编 `process.killTree` 的 taskkill、`pkg-cache` 的 npx 预取、`versions` 的 git fetch；K-W2 判据扩到 spawn/spawnSync/execFile/execFileSync/execSync/裸 exec 六词形 + 双豁免 | `no-console-window-gate-test`（W1 措辞同步纠偏） |
| 条7 | 契约改判（「dist-tags ∪ versions 全量最高」把他人杂 tag 当候选） | `distribution/release.js` 第三方选版改判 **latest 优先**、兜底只看 versions；`fetchNpmLatest` 注释同步；RELEASE-CHANNEL-CONTRACT 新增第三方段落（此前契约未写明） | `release-channel-test`（RC-3 期望随改判翻正 + 反向例） |

### H-4 domains + app 生命周期（D-1…D-13）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| D-1 | 确认缺陷（inflight 计数泄漏 → 恒判「不可停」） | `router/handlers/forward.js`：begin 之后任何跳出统一走 `endAttempt` 幂等收口 | `router-circuit-breaker-test` |
| D-2 | **审计原述不成立**（「壳的 desired 未纳管」——MANAGED_KINDS 本就无壳条目，`_shellExitIntended()` 已单源） | 改为在 ARCHITECTURE-CONTRACT §6 划**适用边界**，并明令**禁止**为壳补登目录条目（那会造出同一意图的第二事实源 = 9-18 根因形态） | 文档 + `session-lifecycle-test` 现状断言 |
| D-3 | 确认缺陷（上游失败只置 `pid=null` → 唯一 kill 路径恒不可达，进程残留占端口） | `router/handlers/forward.js:147`：先 `stopInstance` 再清 pid | `router-circuit-breaker-test` |
| D-4 | 确认缺陷（代理实例日志无轮转且默认 0644，内含启动令牌 URL） | `router/providers/probe.js:86`：落盘改接平台层 `log.js` `Rotator`（2MB 轮转、首建 0600） | `router-circuit-breaker-test` |
| D-5 | 确认缺陷（relay HTML 缓冲无界） | `relay/proxy.js:101`：polyfill 注入加全量缓冲上限，超限按流透传 | `round13-router-relay-gaps-test` |
| D-6 | 确认缺陷（`listening !== inst.pid` 等值判据在 npx --yes 兜底形态恒不成立 → 误判孤儿） | `router/providers/probe.js:185` `monitorLifecycle`：改同进程组判定（/proc pgrp，comm 以最后 `") "` 为锚；win32 与读失败一律 false，交 HTTP 探活兜底，不静默放行外部占用） | `daemon-lifecycle-test` |
| D-7 | 契约裁决（SSOT 落 GUARD-DOMAIN-MODEL §6.3；**不**广域扫 `src/domains`——域自治对象改自己的状态机是契约要求的形态） | ML-2/ML-3「只减不增」棘轮，基线 14 处 / 5 文件（含 `state/fields.js` 合法出口） | `guard-domain-model-gate-test` |
| D-8 | 确认缺陷（实然回写权威 desired，违铁律 1） | `app/control/specs.js:73` `upsert(spec,{keepDesired})` **只作用 update 分支**（register 必须带 desired）；本轮收口心跳同步 + 启动对齐两条观测推导路径（后者：load() 后的 BACKOFF 快照会抹掉用户运行意图）。域 B 的 desired 来自 config 业务条件，**不加**旗标 | `app-ctor-injection-test`（假件 `fakeRegistry.update` 同步改成语义对齐：值为 undefined 的键不改写） |
| D-9 | 确认缺陷（`_recordManifest(target, [])`：`Array.isArray([])` 为真 ⇒ 继承分支不触发，上一代 dataPaths 认领被抹成空 → 卸载清理静默失效） | 改传 `undefined` | `uninstall-timeout-behavior-test` + `native-dsh-binding-test` |
| D-10 | 确认缺陷（守卫被 8s 强杀后 detached npm 继续写 node_modules = 并发写入者，9-13 半成品同族） | `platform/distribution` 记在途句柄 + `killInflightNpm()`；`guard-shutdown` / `session-exit` 两条关停路径在**同步段**先切断并落 aborted + warn + 事件 | `graceful-shutdown-test`（⚠ windows tmpdir 短名含 `~` 风险见 H-7） |
| D-11 | 确认缺陷（只凭 cmdline 相似认领 → 双管家互杀） | `app/main/signals.js` `_mainOwnerFile`/`_writeMainOwner`：与 daemon 身份/锁同址落 `dsh-main.owner.json`（0600、原子写）；**凭据只做否决**（他主且 guardPid 存活才拒），他主已死/pid 不匹配一律不否决（否则一次崩溃永久封死恢复）；契约新增 N6 | `adopt-token-reclaim-test`（D-11 全链） |
| D-12 | 确认缺陷（`writeFileSync` 覆盖=后写者静默抢锁；pid 从不回读=对已死持有者持续授权；无条件 unlink=可删别人的新锁） | `app/daemons/identity.js`：`'wx'` 原子取锁 + 持有者存活检测（ESRCH 清残留 / EPERM 视为存活）+ 释放只删自己的锁 | `daemon-lifecycle-test` |
| D-13 | 确认缺陷（宽作用域静默 catch 无痕降级） | 收口 3 处：`state/store.js` `loadState` 拆「读/恢复」两段（首启 ENOENT 安静、恢复失败留痕）、`daemons/process.js` `_writeIdentity` warn+事件、`audit/orphan-scan` 两段扫描失败可见 | `app-this-ratchet-gate-test`（SC-1…SC-3 棘轮，基线 8 + 反向样例证明对窄/留痕形态不误报） |

### H-5 发布链 + UI（发布条 1…4 / UI 条 5…6）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| 发布条1 | 确认缺陷（workflow 无顶层 permissions、actions 未钉 SHA、无 concurrency） | `.github/workflows/build.yml:20` 顶层 `contents: read` + concurrency（**tag 不取消**）+ 10 处 `uses` 全钉 SHA | `workflow-parse-test` W5（九条静态门禁） |
| 发布条2 | 确认缺陷 = §E.2 案例（注释声称产线校验 glibc，实际 CI 零调用） | `release/scripts/ci-core.sh` 新增 `[3.5/5]` 条件步（ELF 判定 + **无对象时如实留痕**），删除 build.yml 里虚构步骤名 | `glibc-gate-test`（§E.2 跨平台静态断言，正反例） |
| 发布条3 | 确认缺陷（发布子包 README 违 RC-1「按全量最高版本选版」） | README 措辞改为真实通道链；4 处「取全量最高」失实注释按条 7 改判归正 | `release-channel-test` + 文档 |
| 发布条4 | 契约改判（兜底④可把正式版顶替成我们的 BETA） | `distribution/release.js` `isOurBetaRelease` 在 ④ 排除 `-BETA.`；契约 §3 ④/⑤ 同步改判并标注壳仓跟进项 | `release-channel-test`（④ 块重写：含 `-RC.n` 不误伤、第三方不适用） |
| UI 条5 | 确认缺陷（后端有拒因仍回 200 → 前端弹「已保存」） | `api/domains/dist.js:75` 有拒因即 400 + `ok:false`；`ui/services/supervisor/client.ts` `failureFromResult` 单源判 2xx 里的假成功，`run()` 消费 | `round8-fixes-test` J-l + `client.test.ts`（vitest） |
| UI 条6 | 确认缺陷（NaN 游标永久停摆、setInterval 无退避、桥不校验来源） | `ui/services/supervisor/polling.ts`：`safeSeq` 写入前归一化、自排 setTimeout 退避（BASE 2s、`2^(failStreak-1)`、封顶 30s、健康成功清零）、`epoch` 断在途轮次；`kernelUpdateBridge.ts` 补 `ev.source === window.parent`（origin 白名单不可用：壳主帧是 Tauri 自定义协议） | `round8-fixes-test` J-m、`kernel-update-single-writer-test` SW-8、`polling.test.ts`；README/ui FRAMEWORK.md 两处失实描述归正 |

### H-6 跨域立项收口（§E.1 / §E.2 / §E.4 + B-25 残留）

| # | 裁决 | 修复锚点 | 测试/门禁 |
|---|---|---|---|
| §E.1 | 确认缺陷，且**规模远大于原述**（原述「至少 4 处」；实测迁移前 `src/` 下 **28 个文件**自带 tmp+rename，其中 **25 个用固定 `file + '.tmp'` 名**，只有 8 个含 pid） | `platform/util/fs.js` `writeAtomic` 单源：tmp = `fp + '.tmp.' + pid + '.' + Date.now()`、mode 默认 0600、rename 后二次 chmod、失败 truncate 后**抛出**；**26 个文件**迁移。显式豁免 3 处（单源自身、`token/persist.js` 轮转追加、`os/file-protect.js` 私有写），豁免项仍要求 tmp 名含 pid | `round8-fixes-test` **J-n**（8 条：旁路扫描 / 豁免集合相等 / 覆盖面 >=25 / 代表点 / 反向 LEGACY 样例）+ `frp-resilience-test` R5-d…d4 |
| §E.2 | 制度化为规则（不改运行时行为） | ACCEPTANCE-STANDARD **§7** + 四个静态门禁（glibc / token-contract / no-console-window / exec-bounded）头注各登记编号化「覆盖缺口」清单 | `round8-fixes-test` **J-o**（缺口块存在 + 无块/空壳标题反向例） |
| §E.4 | 确认缺陷 + **抓出真实错账**（账本 model 键来自请求体，`obj['__proto__'] = {...}` 走 [[Prototype]] setter → 桶从聚合视图与落盘中静默消失，后续键查找走原型链；不污染全局 Object.prototype，但错账不报错） | `platform/util/input.js` 单源四把尺子（`argvViolation`/`pkgNameViolation`/`unitNameViolation`/`ledgerKey`）；`install.js`/`os/service.js` 改取同名导出（调用点字面形态不变）；`router/store/usage.js` `_modelKey` → `ledgerKey`（违规键折进 `(other)`） | `round8-fixes-test` **J-p**（唯一定义处扫描 + 对象同一性 + mkdtemp 造第二把尺子反向例 + 14 行行为表）、`router-test`（B19 后 6b2 含原型未改写与 `naive['__proto__']` 破坏真实性反向）、`npm-resolution-test` C-f（字面判据拆「调用点问闸 + 单源存在」两条） |
| B-25 残留 | §G-6-1 挂账收口（`cat > "$f"` 先截断后等数据 → 空 stdin 落 0 字节并把 status 置 active） | `release/scripts/cred.sh` put 分支：先 `umask 077` 读到唯一临时文件 → 校验非空（含纯空白）→ 才写穿目标；失败/空输入都在动目标之前退出，原文件与 index 不变。备份仍为**尽力安全网**（warn 不硬闸） | 本机 `bash -n` 通过；行为级由 CI 覆盖（见 H-8 第 5 条） |

### H-7 本批 CI 取证与待裁决项

1. **`241446d` 是本批能合入的前提**：runs `35471888496` / `35472954250` / `35474631569` / `35478336653` 四连红的**全链唯一 FAIL** 都是 `round8-fixes-test.js:351` 的「C-8 manual+元数据地址 → mode 未被改」。它是真回归（别名 vs 副本），不是假红。
2. **链位序教训（登记为纪律）**：`round8-fixes-test` 在 `scripts.test` 第 57/129 位，`&&` 链在此中断 → **第 4 批 B/C/D 三组并入 58–128 位入链文件的断言此前一次都没被 CI 执行过**（D-8、ML-2/ML-3、SC-1…3 等）。一条早退红的代价不是 1 个用例，而是 72 个文件的覆盖面。
3. **D-10 windows tmpdir `~` 风险 —— run `35483224735` 已坐实**（原为挂账，见 H-7-6）：`npm test` 是一条 `&&` 链，run `35480363198` 各 job 都在链首红处中断（windows 停在 #28、其余停在 #31），所以 #46 的 D-10 行为块当时一次都没执行；修掉那两条红后链推进，windows 的 D-10 四条即全红，回显直说拒绝原因：`commandTemplate 替换后含禁用字符 … C:\Users\RUNNER~1\AppData\Local\Temp\p1f-…\npm-inflight-hang.js`。**教训登记**：挂账的风险项要按「下一个 run 见分晓」排进裁决，不要因为「日志里没有它的 FAIL」就当已证伪。
4. **E-1 迁移的连带改判**：`provider-gateway-gate-test` PG-7 与 `npm-resolution-test` C-f 都曾因「判据钉住旧实现字面量」而在搬家后**静默抓空**——已改为「调用点问闸 + 单源存在 + 反向样本命中」三段式，并把「搬家即空转」写进两个门禁的缺口清单。
5. **run `35480363198`（HEAD `06162f8`）四平台 + test job 全红的唯一红因取证**（各 job 只有一条 FAIL，属**平台分裂**而非同一缺陷）：
   - `test/daemon-lifecycle-test.js` D-12 反向例（test job + ubuntu + 两个 macos）：断言「锁不存在 → 取锁失败」。定性为**产品对、断言错**——`identity.js` 用 `fs.openSync(p,'wx')`，父目录存在而锁不存在时**首次创建必成功**（同文件 :151 正例早已断言），该期望与自家正例互斥。修法：反向例改指真正的失败路径「父目录缺失 → ENOENT ≠ EEXIST → 判 false 且不建锁、不补目录」，并按 §G-6-9 逐例拆分 + 判据回显（null 路径、失败不建锁、失败不建目录、释放不存在锁 no-op 四条）。
   - `test/adopt-token-reclaim-test.js` D-11「落盘权限 0600」（windows 独有，实测 `666`）：定性为**夹具缺平台门控**——Windows 的 `chmod` 只切换只读位，POSIX mode 语义不成立，产品侧 `writeAtomic` 的显式 `chmodSync(0o600)` 在 POSIX 上仍正确。修法按既有先例（`round13-discipline-gaps-test` ③、`install-id-test` ID-3b、`frp-resilience-test` R5-b）：POSIX 做真实行为断言，win32 打显式 `SKIP` 行，不静默变绿。
   - **纪律提取**：凡「权限位 / mode」断言必须平台自感知；凡「反向例」必须在写完后确认它与同文件正例不互斥——本机只读代码推不出来，CI 是唯一裁判。
6. **run `35483224735`（HEAD `4e83355`）的第二轮红因取证**（链推进到 #63 后新暴露三处；D-11/D-12 两条已按 5 修好不再复现）：
   - `router-circuit-breaker-test` **D-1b**（四平台 + test job 同点红）：判据 `endInflight(acc, prov)` 全文计数期望 3，实得 4。定性为**判据自命中**——第 4 处是 `function endInflight(acc, prov) {` 这行**声明**（forward.js:36），产品侧三处结束点（finishOK / finishAborted / 非流式体）从未变多。修法：计数前先摘掉声明，并回显「调用 N 处 / 声明 M 处」两个判据值，使「声明与调用同形」这一类干扰今后不可能静默。
   - 同文件 **D-3 反向**（同上四平台）：夹具 `restartInstance() { restarts++; }` / `markInstanceNetFail() { netFails++; }` 对 **const 数组**自增 → 抛 TypeError → 被产品侧 `try {} catch {}` 吞掉 → 计数恒 0。定性为**夹具恒假、判据没有牙**（断言的是 `restarts === 1`，而 state() 取的是 `.length`，两侧都拿不到真值），产品逻辑本身正确（forward.js:139-141 的超时分支确实存在）。修法：改 push（同文件 :112 既有范式），并在注释里留下「为何原先恒 0」。**教训**：桩件的累加器要么写 `arr.push(x)` 要么写 `let n = 0; n++`，混用即恒假；且**产品侧的 try/catch 会吞掉夹具异常**，所以「PASS 数符合预期」不构成证据，必须看回显值。
   - `uninstall-timeout-behavior-test` **D-10**（windows 独有，四条同红）：见本节前第 3 条 —— 夹具把临时脚本路径塞进 `commandTemplate`，被 B11 的 fail-closed 字符闸拒（win runner tmpdir 为 8.3 短名含 `~`）。修法：假 npm 改复用仓库内夹具 `test/fake-npm.js` 的新增 `FAKE_MODE=hang` 模式，pid 文件路径经 `FAKE_PID_FILE` 环境变量传入，argv 只留仓库内路径（POSIX 纯路径、win 盘符绝对路径均由 `WIN_DRIVE_ABS_RE` 豁免，本机以 `argvViolation()` 逐例验证：新路径 PASS / 旧 tmp 路径 REJECT）。**产品不改**：B11 的「宁误杀不漏放」是有意裁决，改判属放宽 fail-closed 闸门，需单独立项。
   - **顺带修掉的 Windows 产品缺陷（同一取证带出）**：`distribution/install.js` 的在途 npm 中止原本是 `process.kill(-pid)` + `child.kill` 两段兜底 —— Windows 无进程组语义，负 pid 必抛、只杀得到 `npm.cmd` 那层壳，真正写 `node_modules`/全局前缀的 node 孙进程照旧存活（正是 D-10 要消灭的对象）。现改调平台层 `os/process.killTree(pid,'SIGKILL',cb,{ownGroup:true})`（B13 已给它 `taskkill /T /F`），并保留 `child.kill` 作同步兜底；新增结构闸：`install.js` 源码（剥注释）必须含 `procOS.killTree(child.pid` 且**不得**再有 `process.kill(-`。
7. **run `35483861183`（HEAD `74ba817`）—— 五个 job 只剩一条红，且是我自己带出的**：`round8-fixes-test` J-i 的对照例
   `FAIL 对照：dist 的 npm 安装早已用 detached + -pid ← 是`（链位 #57）。定性为**改判连带**：H-7-6 把 `install.js`
   的负 pid 收口到平台层 `killTree` 后，这条拿 dist 当「既有正确做法」样本的对照判据失去了第二个从句（它钉的正是被删掉的那行字面量）——
   **产品无缺陷、对照样本失效**。修法：拆成两条独立判据并回显判据值（「dist 自成进程组（detached）」/「dist 的杀树走
   `platform/os/process.killTree` 单源」），「不得再自写负 pid」的反向职责由 D-10 结构闸承担。
   **纪律（登记为改判必查项）**：跨文件**对照例**的价值就是「那个模块没变」；动任何被当作样本的模块，必须同批改完
   以它为锚的对照判据，否则假红会伪装成「新改动有罪」并再吃掉一个四平台 run。
8. **⚠ 预防性修复（静态推演，尚未经 CI 裁决）**：`platform-layer-portability-test` X-6 的「icacls 不可用 → mode=none」
   两例，前提只在**非 win32 宿主**成立（真 Windows 的 `icacls.exe` 在 System32，`CreateProcess` 清空 PATH 也会命中系统目录），
   在 windows job 必红（链位 #102，本批此前从未执行到）。已改宿主自感知：POSIX 宿主补一条前提例（防判据空转）后照旧验 `none`，
   win32 宿主显式 SKIP 并改验「icacls 可用 → 绝不谎报 none」；缺失路径目标不再硬编码 `/tmp`。此项属**盲区预防**，
   不构成证据——下一 run 才是裁决。

### H-8 残留与诚实声明

1. **glibc 门禁当前无对象可检**：本仓 Linux 产物为纯 JS launcher，`ci-core.sh [3.5/5]` 走「无 ELF → 如实打印无对象可检」分支。即 §E.2 的这条**没有任何产物被实际校验过**，防的是「重新引入原生产物时的基座回归」。
2. **§E.1 与原述偏离（实现位置与职责边界）**：原述要求「统一注入 `persist.writeAtomic`（tmp 含 pid **+ 读失败禁写内建**）」。实际单源落在 `platform/util/fs.js`（`persist.js` 反而在豁免清单），且「读失败禁写」**仍由各调用点自守**（`canPersist()` / `loadedOk`），单源不内建——helper 不该反向依赖每个调用点的健康语义。规则已按实际形态写进 ACCEPTANCE-STANDARD §8。
3. **§E.4 只统一字符集层**：URL/SSRF 分级（`shared/ip` + `policies.isValidOrigin`）与 semver/通道语义仍留在各域，未纳入 `input.js`（边界见 ACCEPTANCE-STANDARD §9）。
4. **审计原述错锚点（本批实测证伪/纠正）**：① §C「令牌条 1 = 4 处裸 `.tmp` 写」低估为 25 处（见 H-6）；② §C「domains 条：shell 看护不认目录 desired 轴」→ D-2 判为**不成立**；③ §E-1「至少 4 处独立实现」同样低估；④ 本批另有 4 处「取全量最高」失实注释与 1 处 build.yml 虚构步骤名归正（发布条 2/3）。
5. **cred.sh 的行为级验证在 CI 侧覆盖有限**：`bash -n` + 静态判据是本批证据上限；空 stdin 路径的端到端（真起 `put </dev/null`）未新增用例——`release/scripts` 不在 `npm test` 链内，脚本改动历史上只经 dry-run 类 CI 步骤。此项留作后续批次的测试基建议题（与 §G-6-8「测试单独运行缺省不落沙箱」同源）。
6. **C-3 首版断言是夹具误设**：`a7a31f4` 记录——429 出现在第 11 发而非第 10 发，且循环起点账本已被前序 cookie 放行 clear；修法为前置清零断言 + 11 发循环拆两条（§G-6-9 逐例拆分 + 判据回显）。
7. **registry 版本**：本批**不发布**（npm 仍 0.1.5-BETA.10）。合入与发布分两步，发布另需确认。
8. **B-11 闸门的对称性缺口（本轮取证时发现，未在本批修）**：`runNpmInstall` 只在 **commandTemplate 分支**逐项过禁用字符集；默认分支的 `argv.push('--prefix', o.prefix)` 完全不过闸（install.js:149）。因 spawn 不经 shell，实际不构成注入面，但它与 B-11「任何一环被污染都直达 spawn」的立项理由不对称——prefix 来自配置/环境（win 上含空白的安装前缀是常态）。修法有两种且语义相反（放宽=给绝对路径豁免；收紧=prefix 也过同一判据并明确要求引号语义），属裁决题不是手到活，留第 5 批立项。

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
