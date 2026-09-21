# 发布与更新机制总纲（RELEASE & UPDATE MECHANISM）

> **流程以 `RELEASE-STANDARD.md` 为准。**
> 本文件只讲机制**原理**（为何这样设计），**不再重复流程细节**（此前同一事实散落 5–8 处 → 已多次漂移）。


> 本文梳理「内核」与「桌面壳」的**推送（发布）**与**更新**机制（原理说明，流程见 `RELEASE-STANDARD.md`）。
> 判据：**稳定与可靠优先**，工业级标准，有舍有得。

---

## 0. 决策记录（累计）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 桌面形态 | **保留 Tauri 原生壳**（桌面级产品） |
| D2 | 壳更新源 | **壳直连公网自更新**；内核**不做更新源**，只做安全网 |
| D3 | 更新失败 | 显示选择页 **【重试】【继续】**（不静默放行，但【继续】始终可用） |
| **D4** | **Linux 分发形态** | **废弃 AppImage，采用标准 Linux 包；且只 `deb` 一种形态**（支持面 = Ubuntu，见 §3.1） |
| D5 | 通道 | 清单走 npm CDN（unpkg 主 / jsdelivr 备，两条对清单都成立）；**安装包**每平台只有清单里那一个 URL，拿不到时由壳按实测候选换源（unpkg → jsdelivr → GitHub Release 同名资产），见 `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §十 V5 |
| D6 | 内核更新机制 | **绝不被本方案破坏**（四条路径原样保留） |

### D4 的影响与契合度（重要）

**这个决定让分发回归当时的生产现状**——取证是**一次性现场快照**（立规时那台生产机）：

```
$ dpkg -S /usr/bin/dsh-supervisor-gui
dsh-supervisor: /usr/bin/dsh-supervisor-gui      # 当时生产就是 deb 安装
```

> **该快照不可复现，也不作为现在的依据**：2026-09-20 在开发机复跑 `dpkg -S /usr/bin/dsh-supervisor-gui`
> 返回「没有找到与 … 相匹配的路径」（本机未装任何 `dsh*` 包），且那个 `/usr/bin/dsh-supervisor-gui`
> 路径属旧的单文件安装形态。D4 之所以仍然成立，靠的是**产线事实**：壳仓 CI 的 Linux 腿
> 就打着 `deb` 包（见壳仓 `docs/RELEASE-STANDARD.md` 的矩阵），不需要任何本机取证。

且这**同时带来两个净收益**（下表数字是**立规当时的估算**，不是当前测量；量级结论成立，绝对值请以 CI 产物实测为准）：

| 收益 | 证据 |
|---|---|
| **体积缩小约 20 倍** | deb 约 **3.8MB** vs AppImage 约 **77MB** |
| **更新耗时缩短约 20 倍** | 按 unpkg 约 1.71MB/s 的链路估算：deb **约 2 秒** vs AppImage 约 45 秒 |
| **自更新仍然成立** | Tauri 源码 `Some(Installer::Deb) => self.install_deb(bytes)`，实现为 `pkexec dpkg -i` |

**代价**：deb 安装到系统目录（`/usr/bin`，root 所有）→ 更新时需**一次 pkexec 密码确认**。
这是「标准 Linux 包」的固有属性，不是缺陷。

---

## 1. 两个组件、两条独立发布链（核心认知）

本项目有**两个独立演进的组件**，各有**独立的版本号、发布链、更新入口**：

| | 内核（dsh-supervisor） | 桌面壳（dsh-supervisor-gui） |
|---|---|---|
| 语言/形态 | Node.js（bundled core.cjs） | Rust / Tauri 2 |
| 仓库 | `dsh-supervisor-core`（**2026-09-13 起转为公开**） | `dsh-supervisor-launcher`（**公开**） |
| 分发单位 | **npm 平台子包** | **系统安装包** |
| 安装位置 | 用户级（`~/.npm-global` 等运行时前缀） | 系统级（Linux `/usr/bin`） |
| 版本示例 | `0.1.2-BETA.7` | `0.1.0` |
| 更新入口 | 壳引导 `core_plan/core_apply`；面板「检查更新」 | 壳启动 **门 0** |
| 监督 | **systemd `Restart=always`**（受监督） | 无（不受监督） |
| 日志 | `<产品状态根>/supervisor/log/`（Linux `~/.local/state/dsh-supervisor/supervisor/log/`）| `<产品状态根>/shell/shell.log` |

> **关键**：两条链**互不干扰**。壳的更新失败**不得**影响内核，反之亦然（D6）。

---

## 2. 内核发布链（**现有机制，本方案不改动**）

### 2.1 产物与命名

```
@dsh-sup/dsh-core-linux-x64
@dsh-sup/dsh-core-darwin-arm64
@dsh-sup/dsh-core-darwin-x64
@dsh-sup/dsh-core-win-x64
```

每个包内含：`bin/dsh-supervisor`（node 启动脚本）+ `core.cjs`（esbuild bundle）+ `ui-react/`（面板产物）。

### 2.2 构建与推送（平台分工，2026-09-10 定案）

| 平台 | 生产位置 | 入口 | 命令 |
|---|---|---|---|
| **linux-x64 / win-x64 / darwin-arm64 / darwin-x64** | **GitHub CI**（2026-09-13 硬标准：四平台全由 CI 产出） | tag `v<ver>` 触发 `build.yml` | 四平台矩阵验证步 `ci-core.sh`（不带令牌）→ token-scoped 发布步 `ci-core.sh --publish-only`（本地无构建/发布路径）|

**认证**：`NPM_TOKEN`（经临时 userconfig 注入，不落盘）或既有 `~/.npmrc` 登录态；解析单源在 `release/scripts/_npm-auth.sh`。

### 2.3 用户侧落地与更新

```
壳引导门 2：core_plan（查最新） → core_apply（npm i -g --prefix <真实前缀>）
面板：guardSelfUpdateStatus（**只读**）；安装/重启由壳 core_apply 与 `kernel_update_apply` 桥执行（`guardSelfUpdateApply`/`guardSelfUpdateRestart` 已删除，协议 §A 方案）
镜像：registry_origins() 四源回退（npmmirror 优先，官方源兜底）
```

**本方案对此链的接触面 = 零**（P1 仅**只读**复用 `dist.fetchLatestVersion` 去查壳版本）。

---

## 3. 桌面壳发布链（**新建**）

### 3.1 产物矩阵（D4 后）

| 平台 | 产物 | 体积 | 更新产物 | 安装位置 | 提权 |
|---|---|---|---|---|---|
| Linux | `.deb`（**唯一形态**） | 3.8MB | `.deb` + `.sig` | `/usr/bin` | 更新需 pkexec |
| macOS | `.app`（由 `.dmg` 装载） | 3.1MB | `.app.tar.gz` + `.sig` | `~/Applications` | 否 |
| Windows | `.msi` / NSIS `-setup.exe` | 3.7MB | `-setup.exe` + `.sig` | `%LOCALAPPDATA%`（per-user） | 否 |

> **不再构建 AppImage**（D4）。壳仓 `tauri.conf.json` 的 `bundle.targets` 由 `["deb","appimage","dmg","msi"]` 改为 `["deb","dmg","nsis","msi"]`。
> 中间那步「再加上 rpm」**已经收回**：Linux 支持面 = **Ubuntu + `deb` 一种形态**，rpm 不产、不测、不承诺
> （更新清单每平台只有一个槽位，多产一种形态就等于让装那种形态的客户端在自动更新时拿到别的包）。
> 要扩发行版得先改清单结构，见 `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §十 N2b。

### 3.2 发布流程（从 commit 到用户可更新）

```
① 开发完成 → PR 合入壳仓 main（壳 CI 在 push main / PR / `v*` tag / 手动 dispatch 都跑）
② 打 tag：git push origin HEAD --tags
    ⚠ **tag 指向的提交必须在某分支上**：实测（2026-09-11）若提交不在任何分支，
    **GitHub 不会为该 tag 推送触发 workflow**（run 数为 0）。原 `release-core.sh` 只 `git push --tags`
    正是踩了这个坑。
③ 壳仓 CI（**四平台并行**：ubuntu-22.04 / windows-latest / macos-latest / macos-15-intel）
    产安装包 + 更新产物 + `.sig` —— 前提是本机之外的 CI 里配好 minisign 私钥：
    **当前两仓 secrets 实测只有 `NPM_TOKEN`**，故 tag 发布被 workflow 主动拦下，
    非 tag 构建按「无密钥即不产签名、也不判红」执行（见壳仓 `docs/UPDATER-SIGNING-KEY.md`）。
④ 组装 npm 包：
      @dsh-sup/shell-linux-x64@0.2.0/
        ├── artifact/dsh-supervisor_0.2.0_amd64.deb    （更新产物本体）
        ├── artifact/....deb.sig                       （minisign 签名）
        └── shell-manifest.json                        （Tauri 静态清单）
⑤ 发布（CI 内，持 `NPM_TOKEN`）：npm publish --access public --tag <beta|rc|latest>
⑥ 清单即通过 CDN 直达用户：
      https://unpkg.com/@dsh-sup/shell-linux-x64@latest/shell-manifest.json
```

> **本节此前写的是「③ 壳仓 CI（三平台并行）+ 在命令行里 `export TAURI_SIGNING_PRIVATE_KEY=<CI secret>`
> + `npx tauri build`，并把触发条件记成「仅 tags + workflow_dispatch」**：三平台是旧矩阵（现已四平台），
> 触发口径在 2026-09-13 已恢复为「每次 push / PR 都跑完整矩阵」（省额度的正解是公开仓，不是砍触发，
> 见 `CROSS-PLATFORM-BUILD-AND-UPDATE.md` F5），而**在命令行 export 私钥**更与「密钥只进 CI secret、
> 不落任何命令行/文件」的铁律相违。按旧写法执行会得到一个不存在的签名产物加一次假成功。

### 3.3 清单格式（Tauri 静态 JSON 语义）

```json
{
  "version": "0.2.0",
  "notes": "…",
  "pub_date": "2026-09-11T00:00:00Z",
  "platforms": {
    "linux-x86_64":   { "url": "https://unpkg.com/@dsh-sup/shell-linux-x64@0.2.0/artifact/…deb",       "signature": "<minisign sig>" },
    "darwin-aarch64": { "url": "https://unpkg.com/@dsh-sup/shell-darwin-arm64@0.2.0/artifact/….app.tar.gz", "signature": "…" },
    "windows-x86_64": { "url": "https://unpkg.com/@dsh-sup/shell-win-x64@0.2.0/artifact/…-setup.exe",   "signature": "…" }
  }
}
```

> **要点**：`url` 是任意 HTTPS（源码已验证 `pub url: Url`，无域名白名单）；
> **签名校验独立于托管位置** —— 故「npm CDN 承载 + minisign 验签」等价安全于「GitHub 承载 + 验签」。

### 3.4 与 GitHub Release 的关系

- **npm CDN = 更新通道**（程序自动更新走这里，实测 1.71MB/s）
- **GitHub Release = 人工下载通道**（首次安装、离线拷机、客服支持）
- 两者产物**同源同签**，不产生两套真相

---

## 4. 更新机制矩阵（用户侧，分平台）

| 平台 | 更新方式 | 提权 | 失败表现 |
|---|---|---|---|
| **Linux（只 `deb`）** | 应用内：Tauri → `pkexec dpkg -i` | 一次密码 | 选择页【重试】【继续】 |
| **macOS** | 应用内：Tauri → 替换 `~/Applications/xxx.app` | 否 | 选择页 |
| **Windows** | 应用内：Tauri → NSIS `passive` 静默 | 否 | 选择页 |

### 4.1 唯一的更新入口（保证一致性）

**所有平台都走同一条代码路径**：壳启动门 0 → `tauri-plugin-updater` → 下载 → 验签 → 平台安装 → 重启。
平台差异**全部封装在 Tauri 插件内**，壳不写任何平台分支。

### 4.2 Linux 使用标准包机制的必然推论

| 推论 | 说明 |
|---|---|
| 安装到系统目录 | `/usr/bin/dsh-supervisor-gui`（deb 标准），root 所有 |
| 更新需提权 | `pkexec` 图形密码框；用户拒绝 = 正常失败路径 → 选择页 |
| **依赖由 dpkg 校验** | deb 声明 `Depends`；因当前版本已在运行，依赖已满足；若新版本**新增**依赖，`dpkg -i` 可能报未满足 → 归入失败路径 |
| 内核 XDG 自启 .desktop | **已修（2026-09-16）**：模板改为**内嵌**（`autostart.js`），Exec/Icon 按实际安装路径重写，不再依赖外置 `desktop/` 目录 |

---

## 5. 完整时序（端到端）

### 5.1 发布时序（开发者视角）

```
【内核发布】
  CI（四平台）: git push origin HEAD --tags → 干净树+CHANGELOG 预检 → ci-core 全套门禁（不带令牌）
                 → build.yml 四平台矩阵 token-scoped 发布步 ci-core.sh --publish-only（本地不参与）

【壳发布】
  壳仓:        git push origin main && git tag v<ver> && git push origin v<ver>   # 同样必须先推分支
                 → 四平台构建 + 签名 → npm publish @dsh-sup/shell-<os>-<arch>
                 → 用户下次启动自动看到更新（清单经 unpkg 直达）
```

### 5.2 启动时序（用户视角）

```
壳进程启动
 ├─[探针] 只读：平台/网络/安装形态（~200ms，失败不阻断）
 ├─[门 0] 壳自更新（直连 npm CDN）
 │      无更新/离线/不可自更新 → 放行
 │      有更新 → 备份当前产物 → 下载 → minisign 验签 → 安装（Linux 走 pkexec）→ 重启
 │      失败 → 选择页【重试】【继续】
 ├─[门 1] Node 运行时（低于最低标准才安装）
 ├─[门 2] 内核（core_plan → core_apply；npm 镜像四源回退）
 ├─[门 3] 守卫就绪（systemd 拉起 + TCP/HTTP 双确认）→ 面板
 └─[确认] finish_boot → 上报健康（= 更新确认信号）
          内核据此清 journal / 打 .ok（自动回退已移除：仅 pending→confirmed）
```

### 5.3 健康确认与回退（安全网闭环）

```
内核（受 systemd 监督）:
  · 观察：读 <产品状态根>/shell/identity.json（version / phase）
  · 确认：收到 phase=ready 且 version==journal.to → confirmed=true，清 journal
  · **无预取、无自动回退**：预取缓存、attempts 自增、pinnedVersions 拉黑与「重装 previous」
    等机制均已整体移除（`domains/shell/index.js` 现只有 pending→confirmed；紧急回退改由发布通道
    契约的 `rollback` dist-tag 显式触发，见 `RELEASE-CHANNEL-CONTRACT.md` §3/§4）
```

---

## 6. 与内核更新机制的边界（单一写入者，2026-09-15 修订）

**硬规则**：内核 npm 包的安装/升级**只有一个写入者 = 桌面壳**。守卫（内核）**不再安装自己**，
只提供只读状态。此前的「D6 双通道」判定（下表 ①④）作废 —— 它正是「更新逻辑分裂」的根因：
同一个全局 npm 包被内核与壳两个进程写，两套版本判定、两种源策略（内核强制官方 registry，壳走镜像）。

| 内核更新路径 | 旧语义 | 现方案 |
|---|---|---|
| ① 守卫自更新（npm 通道） | 内核 `POST /self-update/apply` → `runNpmInstall` | **撤销**：端点下架（410 + `KERNEL_UPDATE_SINGLE_WRITER`）；安装归壳 `core_apply` |
| ② 原生 DSH 更新 | 唯一 `_runInstall` → `dist.runNpmInstall` + 自动回滚 | **不改**（这是 DSH 本体，不是内核） |
| ③ 沙箱实例更新 | 带 `--prefix`，每实例独立 | **不改**（具名实例，不是内核包） |
| ④ manifest 通道 | `selfUpdateManifestUrl` 默认 null（未启用） | **删除**：死代码（端点从未接线，仅自测引用） |

**只读面（保留）**：内核 `GET /self-update/status` —— 版本/可更新性是事实查询，不是写入。
**写入面（唯一）**：壳 `core_apply`（启动门 2）与壳命令 `kernel_update_apply`（面板请求）。
**重启面（唯一）**：壳经服务管理器重启守卫（守卫从不重启自己）。

**面板请求通道**：面板由内核托管、运行在壳的内容 iframe 内，**不能用 Tauri IPC**（IPC 仅主帧）。
故面板经 `postMessage` 把「更新内核」转交壳主帧，由壳调用 `kernel_update_apply`（协议与校验见壳仓
`docs/DESIGN-SHELL-ARCHITECTURE.md` §3.2c）。核心里**没有任何**安装/重启自己的代码路径。

**壳侧约束**：
1. **禁止**为兼容旧壳而把内核降级或 pinned；
2. **禁止**壳回退时连带回退内核；
3. 内核更新**必须**经壳（单一写入者）——壳是唯一有权 `npm i -g <corePackageName>` 的一方；
4. P1 复用 `dist` 仅限**只读**（`fetchLatestVersion`）；壳安装内核走 `core.rs::install_version`，
   **不调用**内核 `dist.runNpmInstall`。

**隔离证明**：壳状态 `<产品状态根>/shell/` vs 内核状态 `<产品状态根>/supervisor/`（同根不同目录，
物理隔离；状态根单源 `src/platform/service/state-root.js`，旧位置 `~/.dsh/{shell,supervisor}` 只用于一次性迁移）；
壳账本 `update-journal.json` vs 内核事件流（不同命名空间）。（历史注：`pinnedVersions` 拉黑机制已整体移除——壳现在只有 pending→confirmed；紧急回退改由 `rollback` dist-tag 显式触发。）
内核 npm 包是**共享产物**，故以「单一写入者」而非物理隔离来保证一致性。

---

## 7. 版本与兼容

| 维度 | 规则 |
|---|---|
| 内核版本 | `package.json` 单源；`X.Y.Z(-BETA.n/-RC.n)` |
| 壳版本 | 壳仓**三处互锁**：`Cargo.toml` = `tauri.conf.json` = `Cargo.lock`（`scripts/verify-shell-versions.js`，壳仓自持）|
| 两者关系 | **独立版本线**；通过元数据声明兼容区间协商（`kernelMin` / `shellMin`） |
| 不兼容时 | **唯一允许动作：先升级壳**（禁止降级内核） |
| npm dist-tag | 档位别名：`-BETA.*`→`beta`；`-RC.*`/无后缀→`latest`（rc 为发布后补打的附加别名）。**通道标签 `latest` 由发布脚本在每次发布后（含 BETA）只升不降地回补对齐**，故客户端默认通道始终跟随我们最后一次发布；`rollback`/`canary` 人工运维（见 `RELEASE-CHANNEL-CONTRACT.md` §2/§4）|

---

## 8. 风险登记册（发布与更新相关）

| # | 风险 | 缓解 |
|---|---|---|
| K1 | minisign 私钥丢失 → 已发布用户**永久**无法更新 | 表上原写的「异地多份 + 双人托管 + 首次发布前演练恢复」**一项都没落地**；用户 2026-09-11 定案为**只做本机备份**（壳仓 `docs/UPDATER-SIGNING-KEY.md` §四）。该风险已真实发生过一次：旧钥四处不可得 → 换钥、`≤1.1.11` 存量客户端强制手动重装 |
| K11 | Tauri 原地安装不保留旧版本 | **更新前强制备份** + 内核缓存 |
| K13 | npm CDN（unpkg/jsdelivr）为第三方 | 原写的「多 CDN 回退 + 内核本地缓存兜底」**都不成立**：jsdelivr 按扩展名屏蔽 `.exe`，且 `endpoints` 的回退只覆盖取清单那一次请求 —— 安装包在插件里不会换源；内核本地缓存从未实现。现在真实在跑的是两件事：**壳按实测候选源换源取安装包**（含 GitHub Release 同名资产，验签仍在插件内按字节做，见 `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §十 V5）与「失败进选择页」让用户重试。风险性质不变（第三方 CDN 仍是主力源），不再有「已经 mitigated」的假象 |
| K14 | deb 自更新需 pkexec，用户可拒绝 | 视为正常失败路径 → 选择页【重试】【继续】 |
| K15 | deb 新版本新增依赖 → `dpkg -i` 报未满足 | 归入失败路径并**如实显示原因**；文档说明可用 `apt install ./x.deb` 手动补依赖 |
| K16 | 壳仓 CI 推 main 即四平台完整构建（耗时；2026-09-13 按明确要求改为 push main 也跑完整矩阵）| 公开仓 Actions 免额度；**发布**仍仅 tag 触发（`publish` job）|

---

## 9. 待实测/待确认

| # | 事项 | 说明 |
|---|---|---|
| V1 | Tauri 是否为 **deb** 自动生成 `.sig` | **已确证**：线上清单 `@dsh-sup/shell-release@1.2.0` 的 `linux-x86_64` 条目 URL 与其签名的 trusted comment 都是 `dsh-supervisor_1.2.0_amd64.deb`（详 `CROSS-PLATFORM-BUILD-AND-UPDATE.md` §十 V1）。rpm 已从支持面收回，无需再问 |
| V2 | deb 自更新在缺依赖时的真实行为 | 需真机验证 `dpkg -i` 的报错形态，以定错误文案 |
| ~~N2~~ | ~~Linux 是否加 rpm~~ | **定案：不加**。Linux 支持面 = Ubuntu + `deb` 一种形态（§3.1）；此前矩阵产 `deb,rpm` 时 rpm 也没有清单槽位，属旁路产物而非可选形态 |
| **N4** | 是否发布 **apt/yum 仓库**（VS Code 模式） | 可选增强：系统包管理器自动更新 + 依赖解析。代价：需仓库托管 + GPG 密钥管理 |

---

## 10. 一句话总览

```
内核：公开仓 → npm 平台子包（**四平台全由 CI 产出**）→ 用户经壳引导或面板更新（镜像四源）
壳  ：公开仓 → CI 构建 deb/dmg/msi + 签名 → npm 包 @dsh-sup/shell-* → unpkg 清单
        → 壳启动门 0 自更新（Linux 走 pkexec 标准包）→ 健康确认（无常驻回退；紧急回退走 rollback dist-tag）
边界：壳管壳、内核管内核；兼容靠声明协商；绝不互相降级
```

