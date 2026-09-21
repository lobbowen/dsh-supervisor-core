# 凭据管理标准（CREDENTIALS-STANDARD）

> 本文件是**凭据管理的唯一规范**。每一条都对应一个会失败的门禁
> （`test/credential-hygiene-test.js`，已注入验证；断言条数以脚本输出为准，不在此固化）。
> 工具：仓库 `release/scripts/cred.sh`；库：**真实用户 home** 下的 `develop/.credentials/`（经 getent/dscl/USERPROFILE 解析；可用 `DSH_CRED_DIR` 覆盖。旧位置 `.dsh/credentials/` 已于 2026-09-19 废弃——与易失的实例 `~/.dsh` 同前缀，易被误认成 ephemeral 副本）。

---

## 0. 这份标准要解决的真实事故

**症状**：「下午还能推壳仓、构建壳仓，现在壳仓令牌找不到了。」

**根因**（已查证）：壳仓令牌被存放在**实例附件目录**：

```
<REAL_HOME>/.dsh/supervisor/instances/inst-<id>/data/.dsh/attachments/.../gh_token.txt
```

那是 **ephemeral** 的 —— 每个会话/实例一个目录，换会话就没了。另有一份副本以 **0664（全局可读）**
散落在 `$HOME` 根目录。

**为什么「下午能推」**：当时推壳仓走的是 **SSH 部署密钥**（`~/.ssh/id_ed25519_wasi7`，经 repo-local `core.sshCommand`），
**与令牌无关**。令牌只用于 **REST API**（查状态 / 设 secret / 改分支保护）——
两者被混为一谈，才显得「令牌时而有时而没有」。

> **现状纠正（2026-09-20 实测）**：上面那句只解释**当时**的症状，**不是**当前的推送方式。
> SSH 部署密钥通道**已废弃且不可恢复**：`~/.ssh/` 下已无任何私钥（2026-09-19 事故连同旧库一并丢失），
> 两仓 remote 现为 `https://github.com/lobbowen/...`。
> **当前唯一推送通道 = HTTPS + repo-local `credential.helper store --file=<REAL_HOME>/develop/.credentials/git-credentials`**。
> 不要把「找回 SSH 通道」当成待办，也不要用 `ssh.github.com:443`。

---

## 1. 三条铁律

| # | 铁律 | 门禁 |
|---|---|---|
| 1 | 凭据**只允许**存放在规范库 `<REAL_HOME>/develop/.credentials/`。**禁止**放在实例子目录或附件目录 | D-4 / 持久化-1 ~ 持久化-3 / R-6 |
| 2 | 库目录 **0700**、库内文件 **0600**；禁止令牌内嵌进 git remote URL；仓库文件里不得出现令牌值 | D-1 / D-2 / R-1 / R-3 / S-1 / S-2 / S-3 |
| 3 | 令牌**必须有清单条目**（`index.json`），只存引用不存值；缺失要显式标 `missing` | D-3 / D-13 / R-2 |

### 关键陷阱：`$HOME` 被重定向

```
$HOME = <产品状态根>/supervisor/instances/<id>/data      # 不是 <REAL_HOME>！
os.homedir() 同值。
```

> 状态根前缀随迁移变过：旧 `<REAL_HOME>/.dsh/supervisor/…`，新默认
> Linux `<REAL_HOME>/.local/state/dsh-supervisor/supervisor/…`（`DSH_SUPERVISOR_HOME` 可覆盖，
> 单源 `src/platform/service/state-root.js`）。上一节的事故现场按**当时**的路径记录，不改写。

所以沙箱 `~/.dsh` **不等于** `<REAL_HOME>/.dsh`。
**一切凭据路径必须写绝对路径**，禁止用 `~` —— 清单里也写明了（`homeNote`）。

---

## 2. 一处凭据、两种用法（不要再混）

> **实测（2026-09-20）**：库内 `github-pat` 与 `git-credentials` 存的是**同一枚** Fine-grained PAT
> （长度与前缀逐位相同），只是**格式**不同。把它当成「两把不同的钥匙、能力不同」是本节要消灭的误解。

| 用法 | 载体与形态 | 能做到 |
|---|---|---|
| `git push` / `git fetch` | `git-credentials`，URL 形态 `https://x-access-token:<值>@github.com`，经两仓 repo-local `credential.helper store --file=` 指过去 | 读写 git；**不**要走 API 语义，helper 只在 http(s) remote 上生效 |
| REST API：查 CI / 建 secret / **改分支保护** | `github-pat` 原值作 `Authorization: Bearer` | 取决于该 PAT 的仓库与权限授予（现为 `lobbowen` 两仓 + `Administration: Read and write`）|

> 历史上还有第三类：**SSH 部署密钥**（`~/.ssh/id_ed25519_*`）——**已废弃，见 §0 现状纠正**，
> 不要再去找或重建。它当时的教训仍然成立：部署密钥再全权限也**做不到**「required status checks」，
> 那必须走 **API 且有 Administration 权限**（本会话就在壳仓上撞到过 `Resource not accessible`）。

---

## 3. 工具：release/scripts/cred.sh

```bash
bash release/scripts/cred.sh list      # 列出全部条目与状态
bash release/scripts/cred.sh doctor    # 卫生检查（权限/条目可寻址/库内路径/散落副本/清单含值），有 FAIL 行返回 1
bash release/scripts/cred.sh verify [名] # 按清单的 verify 打点实测连通性，不打印令牌值
bash release/scripts/cred.sh path 名    # 打印凭据文件路径
bash release/scripts/cred.sh get  名    # 打印令牌值（仅给脚本消费）
echo -n TOKEN | bash release/scripts/cred.sh put 名   # 写入并置 active
```

库根可用 `DSH_CRED_DIR` 覆盖（测试 / 换机）。

> 三点容易踩空的实测事实：
> - **条目一律按 `index.json` 的 `name` 寻址**，不存在 `kernel` / `ref` 之类的别名；
> - `verify` 用 node 的 `fetch` 打点，**不依赖 curl**（本机无 curl），且打点走 `HTTPS_PROXY` 时由
>   调用方给代理环境；未知条目名**非零退出**，不是静默通过；
> - `doctor` 的权限面枚举的是**库内全部常规文件**（含无扩展名的 `git-credentials`、`index.json`），
>   不是只看 `*.pat`。

---

## 4. 新增一枚凭据的标准步骤

1. 在 `index.json` 的 `entries` 增加条目：
   `name`（**全库唯一**，`path`/`get`/`verify` 的寻址键）/ `kind` / `account` / `purpose` / `repoScopes` /
   `requiredPermission` / `file`（**绝对路径且必须在规范库目录内**，不要写 `~` 或相对路径）/
   `verify`（`{url,expect}` 走 API 打点，`{method:"file"}` 只查文件在库内且非空）/ `status`；
2. 写入值：`bash release/scripts/cred.sh put 名`（从 stdin 读；自动 0600、自动置 active）；
3. 验证：`bash release/scripts/cred.sh verify 名` 应显示 OK；
4. 由 CI 门禁验证：`credential-hygiene-test` 必须全过（按 ACCEPTANCE-STANDARD，测试不在本机执行）；
5. 若是**轮换**，在 `history` 记一条（旧令牌尾号 / 失效原因 / 处置）。

### 轮换 / 作废

- 旧值**必须彻底删除**（`shred -u` 或 `rm`），不得留在附件目录、备份、`$HOME` 根；
- 状态由 `put` 自动置 `active`；作废时手动改 `missing` 并写 `history`；
- `doctor` 只要出现 FAIL 行就返回 **1** —— 故意的：让「缺令牌 / 权限过宽 / 条目不可寻址」在自动检查里可见，而不是安静地继续。

---

## 5. 现状（以规范库 `index.json` 与两仓 secret 实测为准）

| 条目（`name`）| 类型 | 账号 | 状态 |
|---|---|---|---|
| `github-pat` | GitHub Fine-grained PAT | `lobbowen` | active；两仓共用（`lobbowen/dsh-supervisor-core`、`lobbowen/dsh-supervisor-launcher`），用途 = push（HTTPS）+ REST（查 CI / 设 secret / 分支保护）|
| `git-credentials` | git credential store（URL 形态）| `x-access-token` | active；与上一行是**同一枚 PAT 的另一种形态**（见 §2）。两仓 repo-local `credential.helper store --file` 指向该文件，是**唯一**推送通道 |
| `npm-token` | npm Granular Access Token（须带 bypass 2FA）| `lob.bowen` | active，`rotateBy` 2026-12-18；作用域 `@dsh-sup`；同一值以 repo secret `NPM_TOKEN` 存在于两仓 |
| （壳自更新签名）| minisign 私钥 `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` | - | **缺失**：2026-09-20 实测两仓 Actions secrets 只有 `NPM_TOKEN`，本机亦无密钥文件。壳的非 tag 构建已改为不因此变红，tag 发布仍由 workflow 主动拦下；恢复/重建流程见壳仓 `docs/UPDATER-SIGNING-KEY.md` |

> **已废弃，不要再去找**：SSH 部署密钥通道（历史上的 `push-kernel` / `push-shell`，账号
> `advgyxqamf` / `wasi7mglns`）。2026-09-19 同机事故后该通道未重建，推送一律走 HTTPS +
> `git-credentials`，API 走 `github-pat`。npm 发布令牌须 Granular + bypass 2FA：
> Classic Automation 令牌被 npm 2026-09 新政拒发（BETA.10 首发实测 E403 后更换）。

---

## 6. 门禁（test/credential-hygiene-test.js）

> 断言数以脚本实际输出为准（不在此固化数字，避免与实现漂移）。
> 分段与判据标签同脚本内 `check(...)` 一致：

| 段 | 宿主要求 | 内容 |
|---|---|---|
| D-1 ~ D-6 | 任意（临时夹具库）| `doctor` / `list` / `path` / `get` / `put` 的规则本身：权限过宽、条目 `missing`、条目指向 ephemeral 路径均判红；`put` 写入后 0600 且 status 转 active |
| D-7 ~ D-8 | 任意 | `put` 的空/全空白 stdin **fail-closed**：非零退出、原值未被截断、清单未变、不留 `.tmp`/`.bak` 残留 |
| D-9 | 任意 | 覆盖写等价性：恰好一份 `<文件>.bak-<14 位时间戳>`，内容 = 覆盖前旧值，权限 0600，目标为新值 |
| D-10 | 任意 | `backup` 拒绝无目标与**实例目录内**目标（拒绝时不建目录）；合法目标产出带时间戳副本，目录 0700 / 文件 0600，提示明文风险但不回显令牌值 |
| D-11 ~ D-13 | 任意 | 未知子命令、未知条目的 `put` 均非零退出且不落文件；清单里写入令牌值 -> `doctor` 判红并点名 |
| D-14 | 任意 | 权限面覆盖**无扩展名**文件（`git-credentials` 形态）：放宽到 0644 判红、0600 判过 —— 旧实现只扫 `*.pat`，整条权限面对这类文件是空转的 |
| D-15 | 任意 | **条目可寻址**：条目缺 `name`、`name` 重复、`file` 为空均判红（旧实现按 `kind` 枚举，清单用 `ref` 时 `path`/`get`/`verify` 全部「未知条目」而 `doctor` 仍全绿）|
| D-16 | 任意 | 清单审计**不按 `kind` 挑食**：每条 `file` 都必须在库目录内，库外绝对路径判红 |
| D-17 | 任意 | `verify` 不依赖 curl（node `fetch`）；未知条目名**非零退出**、已知条目回显身份/路径而非值 |
| S-1 ~ S-3 | 任意（仓库不变量）| 工作树内无令牌值、git remote URL 未内嵌凭据、未跟踪 `*.pat`/`*.pem`/`*.key` |
| 持久化-1 ~ 持久化-4 | 任意（-4 需真机库）| 库路径不含 `instances` 段、不被重定向的 `$HOME` 吸收、必须是绝对路径；真机令牌文件非空 |
| R-1 ~ R-6 | 仅当规范库存在，否则显式 SKIP | 真机审计：目录/文件权限、清单权限、`doctor` **零 FAIL 行**（判据按行首 `FAIL` 匹配并先 trim，缩进的 FAIL 也曾被漏掉）、旧别名与 `$HOME` 根散落副本 |
| 反向 | 任意 | 判据非空转：能识别令牌值、不误报普通字符串、D 组夹具确实被创建 |

真机库被破坏性覆盖的保护在 `test/destructive-op-safety-test.js`（W-1 ~ W-6，
用 `DSH_REAL_HOME` 把「真机库」模拟到临时目录，不触碰真实凭据）。

**注入验证**（每类各注入一次，全部 FAIL，还原后全绿）：

| 注入 | 命中 |
|---|---|
| 条目指向 ephemeral 附件路径 | **D-4 FAIL** |
| 库内 `*.pat` 放宽到 0644 | **D-2 FAIL** |
| 库内**无扩展名**凭据放宽到 0644 | **D-14 FAIL** |
| 删掉条目的 `name` | **D-15 FAIL** |
| 条目 `file` 指向库外 | **D-16 FAIL** |
| `$HOME` 根放散落副本 | **R-6 FAIL** |
| 清单内写入令牌值 | **D-13 FAIL** |

---

## 7. 与发布工程的关系

- 仓库内保存**规范 + 工具 + 门禁**，**不含任何值**（值只在本机库或 CI Secrets）；
- 不再单独维护凭据 runbook；面向人的步骤已并入本文件 §3/§4；
- 本文件是**标准**（含门禁与步骤）；两者互补，改一处须同步另一处；
- CI 侧凭据走仓库 Secrets（`NPM_TOKEN` / `GITHUB_TOKEN`），不依赖本机库。

---

## 8. 事故记录与由此产生的第 4 条铁律（2026-09-13）

> 完整复盘（时间线 / 根因四层 / 为何既有防线没拦住 / 残余风险 / 流程变更）：
> **`archive/history/INCIDENT-2026-09-13-credential-overwrite.md`**


### 事故：`put` 覆盖了真令牌

| 项 | 内容 |
|---|---|
| 发现 | 内核 PAT 文件从 93B 变成 16B（内容 `new-secret-value`）|
| 直接原因 | 做本门禁的**注入验证**时，先注入「移除 `DSH_CRED_DIR`」以破坏夹具模式；脚本随后的 `put` 步骤**回落到真机库根**执行 |
| 放大因素 | 迁移时把旧路径改成了**符号链接** → 覆盖立即生效、**无第二份副本可恢复** |
| 不可恢复 | 备份包（2026-09-10）早于令牌创建时间（2026-09-11 10:55），已核实包内只有另一枚已失效令牌 |
| 影响面 | **REST API**（查 CI / 合并 PR / 改分支保护）。**当时推送与发布不受影响**：Release 走 CI 的 `GITHUB_TOKEN`、npm 走 `NPM_TOKEN`、git push 走当时的 SSH 部署密钥（该通道现已废弃，见 §0 现状纠正）|

### 第 4 条铁律：破坏性操作默认拒绝真机

| 规则 | 实现 | 门禁 |
|---|---|---|
| 破坏性子命令（`put`）在真机库上**默认拒绝** | 需 `DSH_CRED_ALLOW_OVERWRITE=1`；目标已存在时再需 `DSH_CRED_FORCE=1` | W-1 / W-2 |
| 覆盖前**必须**留旧值备份 | `<file>.bak-<时间戳>`（0600）| W-3 |
| 测试夹具与真机**结构隔离**；隔离失效要**失败**而非降级 | 门禁用 `DSH_CRED_DIR`；真机保护用 `DSH_REAL_HOME=<tmp>` 把「真机库」指向临时目录来验证 | W-1..W-4 |
| 仓库内不得存在未隔离的 `put` 调用 | 静态扫描（跳过注释）| W-5 |

### 可推广的规律（写进 DEVELOPMENT-TRACK 的假绿清单）

1. **破坏性操作必须默认拒绝**（白名单式确认），不能靠调用方自觉；
2. **隔离失效必须失败**，不能静默降级到真机；
3. **覆盖要可逆**（先备份），因为「不可逆」会把一次失误变成永久损失；
4. **注入验证要选非破坏性注入点** —— 本次若改注入「让 `put` 的确认逻辑失效」而不是「让夹具隔离失效」，就不会碰到真机；
5. **单一副本 + 符号链接 = 零冗余** —— 迁移/轮换期必须保留旧值直到新值验证通过。

### 因此「显式 SKIP」也可能是缺口

本门禁首版在「真机无 PAT 文件」时会 **SKIP** W-1..W-4 —— 那意味着**保护是否生效根本没被验证**。
现已改为 **`DSH_REAL_HOME` 模拟法**：把「真机库」解析根指向临时目录（`cred.sh` 经
`_npm-auth.sh::dsh_real_home()` 读取该变量），在**任意宿主**上确定性验证保护逻辑，
且**完全不动真机凭据**；不再复制/改写脚本源码。
