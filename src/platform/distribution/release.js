'use strict';

// 发布通道选版（RELEASE-CHANNEL-CONTRACT 第3节）——唯一实现（纯，无 IO）。
//
// 契约先划边界：我们的包 '@dsh-sup/dsh-core-<os>-<arch>'（及同 scope 的壳发布包）走本算法
// （rollback -> canary -> latest -> versions 最高兜底（我们的包排除 -BETA.）-> null）；
// 第三方包（DSH 本体、代理/插件包）
// 不采纳其 rollback/canary —— 他人的 dist-tag 策略不受我们控制，套用会把别人的 tag
// 误当我们的发布纪律。但选版同样 **latest 优先**（条 7，AUDIT-2026-09-19 批 4 C）：
// 旧「dist-tags ∪ versions 全量最高」会把他人杂 tag（next/alpha/旧 beta）当候选而装到
// 未验证版；latest 缺失/非法才回落 versions 最高。
// 收敛点：fetchNpmLatest（install.js）只负责拉元数据并
// 调本函数，选版算法只此一份，禁止在任何调用点再写第二套。

const { semverCompare } = require('../../shared/version');

/** 「我们的」发布包 scope。同 scope 的 '@dsh-sup/shell-*' 亦由我们发布。 */
const OUR_RELEASE_SCOPE = '@dsh-sup/';

/** 该包名是否属于我们的发布通道；只有 true 时才允许 rollback/canary 语义。 */
function isOurReleasePackage(pkg) {
  return typeof pkg === 'string' && pkg.startsWith(OUR_RELEASE_SCOPE);
}

/**
 * A3-b（AUDIT-2026-09-19）：rollback 防降级下限。低于此版本的 rollback tag 一律忽略。
 * 背景：持有发布令牌即可 `npm dist-tag add <pkg>@<任意旧版> rollback`，而客户端原本
 * 无条件服从（RC-2「最高优先级」）→ 一条 tag 写入即可把全员定向降级到已知漏洞旧版。
 * 下限 = 本次审计时点的已发布安全基线；每次携带安全修复的发布应同步上调
 * （发布纪律，见 RELEASE-CHANNEL-CONTRACT.md RC-7）。
 */
const ROLLBACK_FLOOR_VERSION = '0.1.5-BETA.10';

/** rollback 时效窗口（天）：目标版本的 npm 发布时刻距今超过该天数即忽略。
 *  依据：合法紧急回退的目标几乎总是「刚发布不久」的已知良好版本；
 *  「翻存档」的旧版本被 tag 成 rollback 本身就是异常信号。 */
const ROLLBACK_MAX_AGE_DAYS = 30;

/** rollback 防降级下限核验（RC-7）。true = 采纳该 rollback；false = 视为不存在，继续选版链。 */
function rollbackAllowed(version, meta, o) {
  const floor = typeof o.rollbackFloor === 'string' && o.rollbackFloor ? o.rollbackFloor : ROLLBACK_FLOOR_VERSION;
  if (semverCompare(version, floor) < 0) return false;
  const maxAgeDays = typeof o.rollbackMaxAgeDays === 'number' ? o.rollbackMaxAgeDays : ROLLBACK_MAX_AGE_DAYS;
  const t = meta && meta.time && typeof meta.time === 'object' ? meta.time[version] : null;
  const publishedAt = typeof t === 'string' ? Date.parse(t) : NaN;
  if (Number.isFinite(publishedAt)) {
    const now = typeof o.now === 'number' ? o.now : Date.now();
    if (now - publishedAt > maxAgeDays * 86400000) return false;
  }
  // time 缺失/不可解析（部分镜像剥掉 time 字段）：时效无从核验，交由版本下限兜底 ——
  // 此处 fail-closed 会挡住合法紧急回退；攻击面（任意旧版）已被下限封死。
  return true;
}

/** 我们的测试版形态（契约 §1：`-BETA.n` → tag beta）。
 *  发布条 4（AUDIT-2026-09-19 第 4 批）：④ 兼容兜底不得把测试版当正式版候选。 */
function isOurBetaRelease(v) { return /-BETA\./.test(String(v)); }

/** 在候选版本集合里取最高合法版本（semverCompare 判定）；空集返回 null。 */
function highestVersion(candidates, isValid) {
  let best = null;
  for (const v of candidates) {
    if (!isValid(v)) continue;
    if (best === null || semverCompare(v, best) > 0) best = v;
  }
  return best;
}

/**
 * 选版算法（契约第3节冻结）——唯一实现。
 *
 *   1) dist-tags.rollback 合法且通过防降级下限核验（RC-7）→ 返回它（回退，最高优先级）
 *   2) 灰度名单内且 dist-tags.canary 合法 -> 返回它（灰度）
 *   3) dist-tags.latest 合法 -> 返回它（正式，跟随我们的发布）
 *   4) 否则 versions 中最高合法版本（兼容兜底；**排除我们的 -BETA. 测试版**，发布条 4）
 *   5) 以上皆无（含排除后为空）-> null（明确失败，绝不猜，契约 RC-5）
 *
 * 第三方包（isOurs !== true）跳过 1)/2)，按 3) latest 优先 → 4) versions 最高 → 5) null
 * （条 7 起；旧语义「dist-tags ∪ versions 全量最高」已废）。
 *
 * @param {object} meta npm registry 元数据：{ 'dist-tags': {...}, versions: {...} }
 * @param {object} opts
 *   - isOurs  {boolean} 是否我们的发布包（用 isOurReleasePackage 判定）
 *   - canary  {boolean} 本机是否在灰度名单；仅 isOurs 时生效
 *   - isValid {(v:string)=>boolean} 版本合法性判据（install.js 传 VERSION_RE.test）
 *   - rollbackFloor {string} 覆盖 RC-7 下限版本（仅供测试注入；生产用常量）
 *   - rollbackMaxAgeDays {number} 覆盖时效窗口（仅供测试注入）
 *   - now {number} 当前时刻 epoch ms（仅供测试确定性注入）
 * @returns {string|null} 目标版本；无法确定时 null（明确失败）
 */
function pickReleaseVersion(meta, opts) {
  const o = opts || {};
  const isValid = typeof o.isValid === 'function' ? o.isValid : (v) => typeof v === 'string' && v.length > 0;
  const tags = (meta && meta['dist-tags']) || {};
  const versionKeys = (meta && meta.versions && typeof meta.versions === 'object') ? Object.keys(meta.versions) : [];
  // 只有「存在且合法」的 tag 才算数：脏 tag（如 'latest': 'beta'）一律忽略，走下一步。
  const validTag = (v) => (typeof v === 'string' && isValid(v) ? v : null);

  if (o.isOurs === true) {
    // 1) 回退最高优先级（RC-2）：独立 tag 是显式信号，不靠版本比较推断；
    //    但须通过防降级下限核验（RC-7 / A3-b），否则视为无 rollback 继续走链。
    const rollback = validTag(tags.rollback);
    if (rollback && rollbackAllowed(rollback, meta, o)) return rollback;
    // 2) 灰度：定向生效（RC-4），非名单机器即使 canary tag 存在也不受影响
    if (o.canary === true) {
      const canary = validTag(tags.canary);
      if (canary) return canary;
    }
    // 3) 正式：优先信 latest（RC-1），绝不「取全量最高」（BETA 的数字可能压过 RC）
    const latest = validTag(tags.latest);
    if (latest) return latest;
    // 4) 兼容兜底：latest 缺失/非法时才回落 versions 最高；兜底**排除我们的测试版**（发布条 4）：
    //    镜像元数据丢掉 dist-tags 是常见而合法的缺失形态，它要恢复的事实是「最新正式版」，
    //    而不是「最新发布的任何东西」—— 让 -BETA. 进候选等于把通道控制交给镜像
    //    （不带 latest tag 的一次响应即可把全员静默升到测试版）。
    // 5) 只剩测试版或皆无 → null（RC-5 明确失败，绝不猜）。
    return highestVersion(versionKeys.filter((v) => !isOurBetaRelease(v)), isValid);
  }

  // 第三方包（条 7）：不套 rollback/canary，但同样 latest 优先 —— 旧「全量最高」把他人杂 tag
  // 当候选（next/alpha/被遗忘的旧 beta 都进池），会把未验证版当最新装。latest 缺失/非法
  // 才回落 versions 最高；两路都无 → null（RC-5）。
  const thirdLatest = validTag(tags.latest);
  if (thirdLatest) return thirdLatest;
  return highestVersion(versionKeys, isValid);
}

module.exports = {
  OUR_RELEASE_SCOPE,
  ROLLBACK_FLOOR_VERSION,
  ROLLBACK_MAX_AGE_DAYS,
  isOurReleasePackage,
  highestVersion,
  pickReleaseVersion,
};
