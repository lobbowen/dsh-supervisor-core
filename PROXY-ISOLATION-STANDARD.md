# 反代进程隔离标准（唯一事实源）

本文件是 **router 反代进程池（npx 发行的第三方外部进程）归属与终止语义的唯一事实源**。
其它文档（PLATFORM-CAPABILITY-MATRIX.md、PROVIDER-GATEWAY-ARCHITECTURE.md）只可引用本标准，
不得复述条款。机器牙齿：`test/cross-platform-architecture-gate-test.js`（CP-5..CP-8 + CP-9 同步锁）
与 `test/cross-platform-test.js` P3 契约冒烟（假供应商真 spawn/kill，四平台 CI 裁决）。

## 1. 本标准解决的问题

反代链曾绕过平台层、在业务域内自带 POSIX 假设，同类缺陷在一个仓库里修过三次后才立此标准：

- 域内裸 `process.kill(-pid, 'SIGTERM')`：win32 无进程组语义，杀掉的只是 `.cmd` 壳，占端口的子孙存活（孤儿监听者）；
- `sameProcessGroup` 读 `/proc/<pid>/stat`：macOS 无 `/proc` 恒 false，自家 detached 子孙被误判为外部占用 → 放弃纳管 → 端口漂移；
- 直接 spawn `npx.cmd`：Node 补丁版（CVE-2024-27980）无 shell 直调 `.cmd` 必 EINVAL；
- 硬编码 `~/.npm/_npx`：win32 缓存目录实为 `%LOCALAPPDATA%\npm-cache\_npx`，POSIX 形路径在 win 恒未命中。

根因不是某一行写错，而是**缺一层「受管进程」承载**：归属/终止语义在域内无处安放，
只能就地写平台假设。本标准把语义立为三层，每层一份实现，新增供应商不改下层。

## 2. 三层职责

### L0 平台事实（`src/platform/os/**`）

只有本层允许出现平台分派（`process.platform` 等，受 CP-1..CP-4 约束）。反代链取用的事实清单：

- `npx-forms#npxLauncher(opts)` → `{program, args, source}`：node-direct `npx-cli.js` 成对形态
  （win 探 `<node目录>/node_modules/npm/bin/npx-cli.js`，POSIX 探 `../lib/node_modules/npm/bin/npx-cli.js`），
  探不到回退 PATH 上的 `npx`。**任何调用方不得自己拼 `npx.cmd`**（CP-8）。
- `npx-forms#npxCacheDir(opts)` → 平台正确的 `_npx` 根。**域内不得出现 `_npx` 字面**（CP-8）。
- `os/process#killTree(pid, signal, _, {ownGroup})`：整树终止唯一收口；负 pid 组信号只允许出现在本文件（CP-7）。
- `os/pidlookup`：`isAlive` / `isZombie` / `readCmdline` / `findListeningPid`（三端语义齐）。
  **域内不得出现 `/proc/` 字面**（CP-6）。
- `os/spawn`：`windowsHide` / `detached` 形态固定，调用方不再各自选项漂移。

### L1 受管进程载体（`src/platform/os/carrier.js`）

池式消费者（反代进程池）拉起外部进程的**唯一通道**。全仓归属逻辑只有这一套：
判定复用 `portable#findOurs`（锚点身份引擎），不存在第二份归属实现。
与 `portable.startTransient` 的分工：前者服务守卫式拉起（stdio ignore、无句柄），
载体服务池式拉起（detached 自成进程组 + 管道句柄 + 停止确认），身份判定同为 `findOurs`。

- **identity 契约**：`{port, pidFile, anchors}`。
  `anchors` 约定 = `[包名, '--port <端口>']`——须是同时出现在载体进程与其子孙监听者
  cmdline 上的特征串，且**非秘密**（密钥一律不进 cmdline，见 §4）。
- `start(spec)`：detached 拉起 + 写 `run.pid` + 返回 `{pid, child, identity}`；
  `run.pid` 覆盖「监听前窗口」的停止兜底，写失败不构成启动失败（端口+锚点仍可判归属）。
- `probe(identity)` → 三态：`ours`（锚点命中的我方进程，含 `ownGroup`）/
  `foreign`（端口被锚点不匹配的进程占住）/ `dead`。三态语义与 `portable.isUnitActive`
  同口径（null 不等于 inactive）。归属**绝不**据 pid 相等或进程组臆断。
- `signalTermination(pid)`：SIGTERM 整树 + 1.5s 台账自动升级 SIGKILL（fire-and-forget）。
  只用于本方刚拉起的组长 pid（`ownGroup:true` 前提）；外来 pid 一律走 `stop()` 或显式复核。
- `stop(identity, {timeoutMs})`：确认式有界停止（= `portable.stopUnit`）。
  `true`=已确认消失；`false`=未确认，调用方保持原相位、不得当成功。
  预算内 `Atomics.wait` 阻塞线程，只可在关停/低频路径使用。

### L2 供应商声明（`src/domains/router/proxy-apps.js` + `providers/**` 消费）

供应商 = 一条 manifest（`pkg` / `command` / `healthPath` / `keyEnv` / `quota` …）
加通用消费逻辑（`providers/probe.js` 经 `carrier.start/probe` 纳管，`providers/command.js`
产出 launcher 成对形态）。本层**不得出现任何平台事实与归属判定**。

## 3. 禁项与机器牙齿

| 条款 | 禁项（剥注释后扫描） | 牙齿 |
|---|---|---|
| CP-5 | `src/domains/router/**` 零 `process.kill(`（终止/存活唯一经 carrier 与 os/process） | 静态门禁 + 反向合成 |
| CP-6 | `src/domains/**` 零 `'/proc/'` 字面 | 同上 |
| CP-7 | `process.kill(-…)` 负 pid 组信号只允许 `platform/os/process.js` | 同上 |
| CP-8 | `src/domains/**` 零 `.cmd/.bat` 执行字面、零 `_npx` 路径字面 | 同上 |
| CP-9 | 本标准正文须含 L0/L1/L2 条款与 CP-5..8 编号（文档与牙齿同步，防规范漂移） | `cross-platform-architecture-gate-test.js` 真读本文件 |

每条静态牙齿都带反向合成断言（判据必须能抓到构造的旧形状），防「此刻恰好为零」的空转门禁。

## 4. 安全纪律（引用，不在本标准重述）

账号密钥只经 env（manifest `keyEnv`）注入，绝不进 cmdline——见
`PROVIDER-GATEWAY-ARCHITECTURE.md`（PG-6）。推论：anchors 必须选非秘密特征串。

## 5. 新增反代供应商验收单（应为纯 L2 改动）

1. `proxy-apps.js` 加一条 manifest（`pkg`/`command`/`healthPath`/`modelPath`/`keyEnv`/`quota`）；
2. 若命令形态含 `npx`：`providers/command.js` 的 `{{npx}}` 展开已给出 launcher 成对形态，无需改；
3. **不许改 L0/L1**——若觉得必须改 carrier/portable 才能接入，说明判据不满足
   identity 契约（锚点无法稳定命中），这是标准缺陷：先修订本标准，再改载体，最后接入；
4. 测试只需注册 mock 应用（不内置测试供应商，见 `proxy-apps.js` 头注）。

## 6. 验证分层

- **本机**：只跑静态门禁（CP-1..CP-9、PG、DG 族）与 `node --check`——见 `ACCEPTANCE-STANDARD.md`，本机绿/红不构成交付证据。
- **CI 四平台矩阵**：`test/cross-platform-test.js` P3 块是真进程契约冒烟——假供应商
  （`fakeproxy-demo-pkg/entry.js`，回 `/health` 200）走 carrier 真 spawn/探活/终止：
  P3-a 拉起落 pid+run.pid、P3-b 真 `/health`、P3-c 锚点判 ours（删掉 pidFile 后仍须经端口反查命中）、
  P3-d 锚点不匹配判 foreign（不得误杀外来进程）、P3-e `signalTermination` 后端口释放且回 `dead`、
  P3-f 重拉起后 `stop` 确认式停止且清理 pidFile。
