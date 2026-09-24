# 发布通道契约（RELEASE-CHANNEL-CONTRACT）

> **本文件是「版本如何被选择」的唯一事实源（SSOT）**，2026-09-16 立。
> 适用：**我们的内核产品** `@dsh-sup/dsh-core-<os>-<arch>`（两仓共同消费）。

---

## §1 适用范围（先划清边界）

| 链路 | 包 | 谁管理版本 | 本契约适用？ |
|---|---|---|---|
| **A. 我们的内核** | `@dsh-sup/dsh-core-<os>-<arch>` | **桌面壳**（`core.rs`） | ✅ **是** |
| B. DSH 本体 | `@deepseek-ai/dsh` | 内核 `native/manager` | ❌ 第三方包，其 tag 策略不受我们控制 |

**注意**：`packageName`（默认 `@deepseek-ai/dsh`）指 **B**；`corePackageName` 指 **A**。二者不可混用。

---

## §2 通道定义（npm dist-tag）

| tag | 语义 | 谁装到 | 我们何时设置 |
|---|---|---|---|
| **`canary`** | 灰度验证版 | **仅灰度名单内的机器** | 灰度发布时 |
| **`beta`** | 最新 BETA 档别名 | 显式选 `@beta` 的用户 | BETA 发布时（脚本自动） |
| **`rc`** | 最新 RC 档别名 | 显式选 `@rc` 的用户 | RC 发布时（脚本自动补打） |
| **`latest`** | **当前自动升级通道** = 我们发布的最新版本（档位可以是 RC，也可以是 BETA） | 全部用户（默认） | **每次发布（含 BETA）由脚本核验后回补，只升不降**（RC-6） |
| **`rollback`** | ★**紧急回退开关** | 全部用户（最高优先级） | **仅紧急回退时人工设置** |

### 为什么 `latest` 必须跟随 BETA（RC-6 的由来）

`npm publish --tag` 只决定「**这次首次发布**挂哪个别名」：BETA 挂 `beta`，于是 `latest`
永远停在切档之前的那个版本。而 §3 的选版链第 ③ 步**只读 `latest`**，第 ④ 步兜底又刻意
排除 `-BETA.` 形态 —— 两条合起来的实际后果不是「测试版不外泄」，而是
**切档之后的所有版本对全体自动升级的机器永久不可达**。实证：registry 上曾出现
`latest=0.1.5-BETA.7 / beta=0.1.5-BETA.11`，而 BETA.8..11 正是携带本轮审计安全修复的那批。

因此本契约的口径是：**档位（BETA/RC）决定别名标签，`latest` 只由「是否更新」决定**。
`beta`/`rc` 退化为「按档位显式安装」的别名，在 BETA 出货期与 `latest` 同值属正常形态。

> **将来若要引入独立的稳定线**（例如 `latest` 只跟 RC、BETA 不外泄给默认通道），那是
> **通道设计变更**：须同步改 §2/§3④/RC-6、发布脚本与 §6 的 RC-G4 门禁，不能只改脚本
> ——否则又是一次「实现与契约分叉」。当前无独立稳定线，BETA 线即出货线。

### 为什么回退用独立 tag 而**不**借用 `latest`（设计论证）

用户最初提议「`latest` 低于全量最高 → 视为回退」。**经验证不可行**（三条硬缺陷）：

1. **语义歧义**：`latest < max` 有两种成因——(a) latest 陈旧未更新；(b) 人工回退。
   二者**机器不可分**。实证：npm 上曾出现 `latest=0.1.1-BETA.1, max=0.1.5-BETA.7`，
   真相是 (a) 陈旧（SEA 时代遗留）；若按该规则会把全体用户"回退"到废弃架构。
2. **发布竞态**：`npm publish` 写 `versions` 与设 `tag` **非原子**，中间必有一拍
   `latest=旧, max=新` → **每次正常发布都会误触发全量回退**。
3. **不可观测**：`latest` 永远存在，无法回答"当前是否有回退在生效"。

**结论**：回退必须是**显式信号**（独立 tag），不能靠"推断"。

### 「检测不到新版本」的排查顺序：先 tag，后凭据（2026-09-21 实测）

**读路径全程不带凭据**。四个 `@dsh-sup/dsh-core-*` 包与 `@dsh-sup/shell-*` 都是 public，
客户端（壳 `core.rs::latest_pick`、内核 `install.js::fetchNpmLatest`）只做匿名 HTTPS GET
包级 packument，代码里既没有 `Authorization` 也没有 `_authToken`；整条链上唯一的凭据是
**CI 发布步的 `NPM_TOKEN`**（经临时 userconfig 注入、不落盘，解析单源
`release/scripts/_npm-auth.sh`，见 `archive/history/RELEASE-AND-UPDATE-MECHANISM.md` §2.2「认证」）。
所以「换了 GitHub 令牌 / npm 令牌」与「客户端检测不到新版本」**没有因果关系** —— 把它当成
凭据问题会让真正的成因（通道 tag）多活一轮发布。

因此报障「拉不到最新版」按此顺序判：

1. `npm view @dsh-sup/dsh-core-<平台> dist-tags` —— `latest` 是否等于最后一次发布；
   不等即 §2 RC-6 失守，处置是**回补 tag 或向前推版本**，不是查凭据。
2. 逐镜像同查（镜像同步有延迟，壳是并行探全部源、按通道取最高，见 §3）。
3. 以上都对才去看本机 npm 侧（`~/.npmrc` 里的过期 `_authToken` 会让**安装**步 401，
   而**检测**步仍正常 —— 这两步症状不同，不要混为一谈）。

2026-09-21 实测基线（`latest` 回补修复 PR #23 合入后）：四个平台包在
npmjs / npmmirror / huaweicloud / tencent / cnpmjs 五源一致为 `latest = beta = 0.1.5-BETA.11`，
各源 `dist.tarball` 均可 Range 取回；`npmreg.proxy.ustclug.org` 对包级 packument 返 302
（不跟随重定向 → 该源在并行探测里恒为无效候选，属镜像清单事实，不是凭据问题）。

---

## §3 选版算法（**冻结**，两仓必须一致）

```
输入：registry 元数据 { dist-tags, versions }、本机是否在灰度名单
输出：目标版本（string）

① 若 dist-tags.rollback 存在且为合法版本，且通过防降级下限核验（RC-7）→ 返回它 【回退：最高优先级】
   （不满足 RC-7 的 rollback —— 低于下限版本或发布超出时效窗口 —— 视为不存在，继续走②③④）
② 若本机在灰度名单 且 dist-tags.canary 存在且合法 → 返回它   【灰度】
③ 若 dist-tags.latest 存在且合法 → 返回它                  【通道：跟随我们的每次发布】
④ 否则（latest 缺失/非法）→ 取 versions 中最高合法版本（我们的包**排除 -BETA. 测试版**）【兼容兜底】
⑤ 以上皆无（含只剩测试版）→ 返回 null（**明确失败**，绝不猜）
```

**④ 的通道约束（发布条 4，AUDIT-2026-09-19 第 4 批改判）**：兜底要恢复的事实是「最新**正式版**」，
不是「最新发布的任何东西」。镜像元数据丢掉 `dist-tags` 是常见而合法的缺失形态，若兜底把
`-BETA.` 纳入候选，则「一次不带 latest tag 的响应」即可把稳定版机器静默升到测试版——
绕过 RC-1 想守的那条线。故：**我们的包**在 ④ 里按 `-BETA\.` 形态排除测试版；排除后无候选
即走 ⑤ 明确失败（RC-5 要求如实报错，不得静默降级为"已是最新"）。
`latest` **显式指向** BETA 时（§2 之后这是常态而非例外）③ 照原样采纳 —— 区别正是 RC-1 的理由：
tag 值是发布者的显式声明，遍历取最高是把声明降格成猜测。

> **④ 与 BETA 出货线的已知张力（不改动算法，只写清后果）**：§2 之后通道目标可以是 BETA，
> 而 ④ 排除 BETA —— 于是在「镜像把 `dist-tags` 剥掉」这一退化路径上，客户端会回落到较旧的
> 非 BETA 版本（例如 `0.1.4`），那是**保守回退**而不是通道目标。这条路径只在 latest 缺失时
> 才会走到，因此结论是：**latest 必须被发布脚本回补到位（RC-6），④ 才永远只是防御性兜底**。
> 要把 ④ 改成「只剩 BETA 时明确失败」属算法行为变更，两仓须同步（见下方壳仓跟进项），本次不动。

第三方包不套此排除（他人无我们的 BETA/RC 纪律），仍按「latest → versions 最高 → null」。
⚠ **壳仓跟进项**：本条是算法行为变更，两仓必须同步（各自实现 + 各自的向量断言），
否则「壳选的版」与「内核自选的版」在 latest 缺失时会分叉。

### 关键不变量

| # | 不变量 |
|---|---|
| **RC-1** | **优先信 `latest`**，不得"取全量最高"（那会绕过通道控制：BETA 的数字可能压过 RC）；同一理由约束 ④ 兜底（见上「④ 的通道约束」） |
| **RC-2** | `rollback` 优先级**高于一切**（包括灰度）——紧急回退必须立即全量生效；但须先通过 **RC-7** 防降级下限核验 |
| **RC-3** | 回退解除 = `npm dist-tag rm <pkg> rollback`，**不依赖版本比较** |
| **RC-4** | 灰度是**定向**的（名单判定），`canary` tag 全局存在但不影响非名单机器 |
| **RC-5** | 任一环节失败必须**如实返回错误**，绝不静默降级为"已是最新" |
| **RC-6** | **每次发布（含 BETA）都必须让 `latest` 指向本次版本**，且**只升不降**（工程纪律，由 `publish-core.sh::reconcile_latest_tag` + 门禁 RC-G4 强制）。原写法「**正式**发布必须更新 latest」把义务绑在档位上，等于在 BETA 出货线上留下了同一个陈旧 `latest` 的坑（见 §2「为什么 latest 必须跟随 BETA」）。降级 `latest` 的唯一合法途径是人工回退（`rollback` / 手工 `dist-tag add`），脚本不做 |
| **RC-7** | `rollback` 须通过**防降级下限**（A3-b，2026-09-19 审计）：目标版本 ≥ 客户端内建 `ROLLBACK_FLOOR_VERSION`，且其 npm 发布时刻距今 ≤ `ROLLBACK_MAX_AGE_DAYS`（元数据无 time 字段时时效无从核验、跳过，下限仍守）。不满足 = 视同无 rollback 走正常链 —— 否则「一条 `dist-tag add <pkg>@<任意旧版> rollback` 即可全员定向降级到漏洞版本」。下限随携带安全修复的发布**同步上调**；若确需回退到下限之下，唯一途径是人工分发（显式安装指定版本），不接受 tag 攻击面换便利 |

### 第三方包（§1 链路 B）的选版规则（条 7，AUDIT-2026-09-19 批 4 C 改判）

第三方包（如 `@deepseek-ai/dsh`）**不套** ①②（`rollback`/`canary` 是我们的发布纪律，
他人的同名 tag 不受我们控制，采纳等于把别人的 tag 当成我们的开关）。其余走同一链：

```
③ dist-tags.latest 合法 → 返回它
④ 否则 → versions 中最高合法版本
⑤ 皆无 → null
```

**改判说明**：本文件此前**未**写明第三方规则，实现里写的是「取 `dist-tags ∪ versions`
全量最高」。该形态把他人杂 tag（`next` / `alpha` / 被遗忘的旧 `beta`）一并当候选，
会把未验证版当最新安装 —— 与 §2「为什么回退不靠推断」同源的教训：**tag 值是发布者
的显式声明，遍历取最高是把声明降格成猜测**。故收敛为 latest 优先，兜底只看 `versions`。

---

## §4 运维操作手册

```bash
# ── 正常发布 ──（脚本自动设 tag，无需人工）
#   BETA  → publish --tag beta，随后回补 latest（本次版本更高时）
#   RC    → publish --tag latest，随后补打 rc 别名
#   两档发布后 latest 都等于本次版本；发布脚本在幂等跳过分支同样执行回补核验。

# ── 通道自检（发布后必查，四平台逐一）──
npm view @dsh-sup/dsh-core-linux-x64 dist-tags   # latest 必须 = 本次发布的版本
#   latest 落后于 beta = 通道陈旧（RC-6 违反），按 §2 的后果是安全修复对全员不可达

# ── 灰度发布 ──
npm dist-tag add @dsh-sup/dsh-core-linux-x64@0.1.6-BETA.1 canary
#   灰度名单内的机器会取它；名单外不受影响

# ── 紧急回退（全员）──
npm dist-tag add @dsh-sup/dsh-core-linux-x64@0.1.5-BETA.10 rollback
#   → 全体用户（含灰度）回到该版本（示例为 ≥ 下限的已知良好版本）；建议同时把 latest 也指回去
#   ⚠ RC-7：回退目标必须 ≥ 客户端下限版本且发布未超时效窗口（当前基线见
#     src/platform/distribution/release.js::ROLLBACK_FLOOR_VERSION），否则被客户端忽略
#   ⚠ 把 latest 往回指是**人工**操作：发布脚本的回补只升不降，不会自动跟着做

# ── 解除回退 ──
npm dist-tag rm @dsh-sup/dsh-core-linux-x64 rollback
```

**回退期间的可观测性**：`rollback` tag 存在 = 回退进行中（一眼可见，无需查代码）。

---

## §5 灰度名单（★ 规范化：安装标识 + 名单格式）

### 5.1 匹配依据：**安装标识（installId）**

> **铁律**：灰度匹配的依据必须是**我们自己生成并持久化的安装标识**，
> **不得**使用用户可随意更改的环境事实（主机名 / IP / MAC）。

**为什么不用 IP**（虽然直觉上最方便）：
- 家庭宽带 IP 会变（重拨 / DHCP 租约）→ 名单失配，用户以为没生效；
- 运营商 / 公司 NAT 出口 IP 是**多用户共享**的 → 一旦命中，**整栋楼 / 整个公司**都进灰度；
- 我方无法观测谁真正命中，出问题无法归因。

| 候选 | 稳定性 | 唯一性 | 可伪造 | 结论 |
|---|---|---|---|---|
| 主机名 | ✗ 可改、容器随机 | ✗ 会重名 | 极易 | ❌ |
| IP | ✗ 会变 | ✗ NAT 共享 | 易 | ❌ |
| MAC | ⚠ 多网卡/虚拟网卡 | ⚠ | 可 | ⚠ 仅辅助 |
| **installId** | ✓ 首次生成后不变 | ✓ UUID v4 全局唯一 | 难 | ✅ **唯一主依据** |
| 主机名（兜底） | ✗ | ✗ | 易 | ⚠ 仅 CI/容器，需注明理由 |

### 5.2 installId 生成与持久化（**基础组件**）

| 项 | 规范 |
|---|---|
| 组件 | 内核 `src/platform/service/install-id.js`（与 `version.js` 同级的基础组件） |
| 格式 | UUID v4（36 字符，小写） |
| 落盘 | `<supervisorDir>/install-id`（纯文本一行；原子写 + `0600`） |
| 时机 | **首次读取时生成一次**，此后**只读不改**（重装/删状态根才换新） |
| 失败语义 | 读失败/写失败**绝不静默新建**（否则 UUID 漂移 → 灰度失配）→ 如实报错 |
| 外显 | 面板底部状态栏（**版本号右侧**）；"关于"页同显；**可点击复制** |

### 5.3 名单载体与格式（**⚠ 预留机制，当前未启用**）

> **状态（2026-09-16 定案）**：本节定义的**名单包机制处于「代码就绪、未启用」状态**。
> `@dsh-sup/canary-allowlist` **尚未发布**，客户端读不到它 → 当前灰度**只经 §5.4 的本地开关生效**。
>
> **为什么先不启用**：灰度是**小范围**（几台到几十台），本地开关足以覆盖，
> 且能做到"我们完全掌控谁在灰度"。为一个尚未使用过的能力提前引入**第 5 个 npm 包**
> 和每次检查更新的额外请求，收益不成立。待灰度范围扩大（需要外部用户自助）时再启用本节。
>
> 保留本节的意义：**格式与匹配语义已冻结**，将来启用时两仓按此实现即可，不必再设计一轮。
> 读者请勿误以为"名单包在生效"——**当前生效的只有 §5.4**。

载体（**未来启用**）：独立 npm 包 `@dsh-sup/canary-allowlist`（更新名单 = 发小包）。

```json
{
  "schema": 1,
  "updatedAt": "2026-09-16T00:00:00Z",
  "entries": [
    { "installId": "550e8400-e29b-41d4-a716-446655440000", "note": "张工内测机" }
  ],
  "hostnames": ["build-bot-01"]
}
```

| 字段 | 用途 | 匹配 |
|---|---|---|
| `schema` | 格式版本 | **不为 1 → 忽略整份名单**（不猜） |
| `entries[].installId` | **主依据** | 与本机 installId 精确匹配（大小写不敏感） |
| `entries[].note` | 可读备注（谁/为何） | 不参与匹配 |
| `hostnames[]` | **兜底**（CI/容器无常驻 UUID） | 精确匹配；新增条目须在 PR 说明理由 |

**收敛要求**：两仓现有实现中"兼容 7 种 JSON 形状"的猜测逻辑**必须删除**，
改为只认本规范格式（`schema` + `entries[].installId` + `hostnames[]`）。

### 5.4 本地开关（★ **当前唯一生效**的灰度方式）

**操作**（一条命令，或改一个配置键）：
```bash
# 方式一：环境变量（适合临时/CI）
DSH_CANARY=1

# 方式二：守卫配置（适合常驻测试机；写进 <状态根>/supervisor/config.json）
{ "canary": true }
```
→ 本机直接进灰度，**零额外请求**；优先级最高（短路，不查任何包）。

**关闭**：移除该键 / 取消环境变量即可。

### 5.5 判定顺序

```
① config.canary === true 或 DSH_CANARY=1 → 灰度（短路，不查任何包）   ← **当前唯一生效路径**
──────────── 以下为预留（名单包未发布，第 ② 步恒为"非灰度"）────────────
② 未 opt-in 名单包（canaryAllowlist !== true） → 非灰度（零额外请求）
③ 显式 opt-in → 读 @dsh-sup/canary-allowlist：
      schema===1 且 (installId 命中 entries 或 主机名命中 hostnames) → 灰度
      否则 → 非灰度
```

**说明**：③ 的 opt-in 门槛是为了让**普通用户一次额外请求都没有**（名单包只对候选机查询）。
在当前（未启用名单包）状态下，第 ① 步之外一律判定为**非灰度** —— 这是**安全的默认方向**。

### 5.6 运维操作规范（"加灰度用户"）

**当前（本地开关）**：
| 步骤 | 操作 |
|---|---|
| 1 | 目标机器上设 `DSH_CANARY=1`（或 config.json 加 `"canary": true`） |
| 2 | `npm dist-tag add @dsh-sup/dsh-core-<平台>@<灰度版本> canary` |
| 3 | 该机器下次检查更新即取 canary 版本；**其它机器不受影响** |
| 4 | 灰度结束：移除 `DSH_CANARY`，并把 `canary` 标签指向正式版或删除 |

**未来（名单包启用后）**：
`用户从面板底部复制 installId` → `加进 entries 并发布名单包` → `打 canary 标签` → `名单机自动更新`。

> 面板底部**外显 installId** 的能力**现在就已就位**（无论用哪种方式），
> 它同时也是"证明某台机器是哪台"的可靠凭据 —— 报障、归因、加白名单都要用它。

---

## §6 门禁

| 门禁 | 断言 | 执行位点 |
|---|---|---|
| RC-G1 | 壳选版含 `rollback` 分支且优先级最高 | **壳仓** `src-tauri/src/release_channel.rs` 的 `tests::step1_*`（内核 CI 不检出壳仓，交叉断言只能恒绿，故不作废代码留在本仓） |
| RC-G2 | 壳选版**优先读 `latest`**（不得仅取 versions 最高） | **壳仓** 同上 `tests::step3_latest_is_trusted_even_when_versions_is_higher`（`step4_*` 判的是 latest 缺失时的回落） |
| RC-G3 | 内核 `fetchNpmLatest` 同上（结构判据钉在取版本链的三个决定点函数体，不钉整目录） | `test/release-channel-gate-test.js` |
| RC-G4 | 发布脚本：`-RC.*` 发布挂 `--tag latest`、`-BETA.*` 发布挂 `--tag beta`，**两档都在发布后回补 `latest`（只升不降，RC-6）**；回补失败必须非零退出 | `test/release-channel-gate-test.js` |
| RC-G5 | 反向：判据能识别"取全量最高"的旧形态（门禁非空转） | `test/release-channel-gate-test.js` |
| RC-G6 | `install-id.js` 存在：生成 UUID v4、持久化 0600、幂等、读失败不静默新建 | `test/install-id-test.js` 的 `ID-1..ID-8`（ID-5/ID-6 判「读坏不覆盖 / 写失败不返回临时值」） |
| RC-G7 | 灰度匹配**只用 installId/hostnames**（不得用 IP/MAC），且名单只认 `schema:1` 格式 | **壳仓** `src-tauri/src/release_channel.rs` 的 `tests::allowlist_matches_install_id` / `allowlist_hostname_is_fallback_hit` / `allowlist_requires_schema_1` —— 匹配函数只吃 installId 与 hostnames 两个入参，IP/MAC 没有入口。**内核不做名单匹配**：`test/release-channel-test.js:124,126` 钉住内核只认本地开关、且不得以「名单包存在」为依据 |
| RC-G8 | 权威查询的真相源边界：有官方源可问时**只问官方源**（取不到也不去镜像顺延拿陈旧版本）；只有镜像时退回镜像但 `origin` 必须如实回传 | `test/release-channel-gate-test.js` |
