#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// 发布通道选版门禁（RELEASE-CHANNEL-CONTRACT §3）
//
// ## 锁定的不变量
//   RC-1  我们的包**优先信 latest**；latest 合法时绝不返回 versions 最高
//   RC-2  rollback 优先级**高于一切**（含灰度）
//   RC-7  rollback 防降级下限（A3-b）：版本 ≥ ROLLBACK_FLOOR_VERSION 且发布未超
//         ROLLBACK_MAX_AGE_DAYS（time 缺失时仅下限守）——防「令牌失窃→一条 tag 全员降级」
//   RC-3  第三方包**不得**套用通道语义（rollback/canary 是我们的纪律）；但选版同样
//         latest 优先，latest 缺失/非法才回落 versions 最高（条 7 改判，旧「全量最高」已废）
//   RC-4  灰度是**定向**的：名单外机器看到 canary tag 也不得取它
//   RC-5  任一环节失败必须返回 null（明确失败），绝不猜
//   §3五步  ①②③④⑤ 逐条覆盖
//   收敛  选版算法只有一份实现（dist/index.js::pickReleaseVersion），调用点只负责拉取与分流
//   反向  判据能识别「取全量最高」的旧形态（门禁非空转）
//
// ## 为什么有本门禁
//   fetchNpmLatest 原先对**所有**包都「取全量最高」——对我们的包这会绕过通道控制
//   （BETA 的数字可能压过 RC，契约 §2 已论证）。现收口为 dist/index.js 导出的
//   唯一实现 pickReleaseVersion；本门禁把 §3 五步与「第三方不变」钉死。
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const dist = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
// 选版算法是 dist 导出的**唯一实现**（契约 §3）——本测试直接测它，不另建实现。
const channel = dist;
const { VERSION_RE, semverCompare } = dist;

const OPTS_MINE = { isOurs: true, isValid: (v) => VERSION_RE.test(v) };
const OPTS_THIRD = { isOurs: false, isValid: (v) => VERSION_RE.test(v) };
const meta = (tags, versions) => ({ 'dist-tags': tags, versions: versions || {} });
const obj = (arr) => arr.reduce((m, v) => { m[v] = {}; return m; }, {});

// ── 包归属判定（契约 §1 边界）──
{
  check('归属 我们的内核包 → isOurReleasePackage', channel.isOurReleasePackage('@dsh-sup/dsh-core-linux-x64') === true);
  check('归属 我们的壳发布包 → isOurReleasePackage', channel.isOurReleasePackage('@dsh-sup/shell-release') === true);
  check('归属 第三方 DSH 本体 → 非我们的', channel.isOurReleasePackage('@deepseek-ai/dsh') === false);
  check('归属 第三方代理包 → 非我们的', channel.isOurReleasePackage('commandcode-api-proxy') === false);
}

// ── §3 ①：rollback 最高优先级（受 RC-7 下限约束，见下方 A3-b 块）──
// fixture 以 ROLLBACK_FLOOR_VERSION 动态构造：日后上调下限（发布纪律）不需要同步改这里。
{
  const FLOORV = dist.ROLLBACK_FLOOR_VERSION;
  const m = meta({ rollback: FLOORV, canary: '0.1.6-BETA.1', latest: '0.1.4' }, obj(['0.1.4', FLOORV, '0.1.6-BETA.1']));
  check('① rollback 存在 → 返回它（即使同时有 canary+latest）',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === FLOORV);
  check('RC-2 rollback 压过灰度（名单内也回退）',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === FLOORV);
  check('RC-2 rollback 与 max 无关（可低于 versions 最高，但须 ≥ RC-7 下限）',
    channel.pickReleaseVersion(meta({ rollback: FLOORV, latest: '9.9.9' }, obj([FLOORV, '9.9.9'])), OPTS_MINE) === FLOORV);
}

// ── RC-7 / AUDIT-2026-09-19 A3-b：rollback 防降级下限（版本下限 + 发布时效）──
{
  const FLOOR = dist.ROLLBACK_FLOOR_VERSION;
  check('A3b-0 下限常量存在且为合法版本', typeof FLOOR === 'string' && VERSION_RE.test(FLOOR), FLOOR);
  check('A3b-0b 时效窗口为正值', typeof dist.ROLLBACK_MAX_AGE_DAYS === 'number' && dist.ROLLBACK_MAX_AGE_DAYS > 0);
  // 攻击形态：令牌失窃后 tag 任意古老版本 → 旧实现无条件服从（全员定向降级），新实现忽略之
  const attack = meta({ rollback: '0.1.0', latest: '0.2.0' }, obj(['0.1.0', '0.2.0']));
  check('A3b-1 低于下限的 rollback → 忽略，回落 latest（不降级）',
    channel.pickReleaseVersion(attack, OPTS_MINE) === '0.2.0');
  check('A3b-2 反向非空转：无条件服从的旧形态会给 0.1.0（判据有分辨力）',
    attack['dist-tags'].rollback === '0.1.0' && channel.pickReleaseVersion(attack, OPTS_MINE) !== '0.1.0');
  check('A3b-3 低于下限 + latest 缺失 → 走 versions 兜底（下限不吞后续链）',
    channel.pickReleaseVersion(meta({ rollback: '0.1.0' }, obj(['0.1.0', '0.1.4'])), OPTS_MINE) === '0.1.4');
  check('A3b-4 注入下限生效：rollback=0.2.0 < floor=0.3.0 → 忽略',
    channel.pickReleaseVersion(meta({ rollback: '0.2.0', latest: '0.2.1' }, obj(['0.2.0', '0.2.1'])),
      { ...OPTS_MINE, rollbackFloor: '0.3.0' }) === '0.2.1');
  check('A3b-5 边界：rollback == 下限 → 采纳',
    channel.pickReleaseVersion(meta({ rollback: '0.3.0', latest: '0.4.0' }, obj(['0.3.0', '0.4.0'])),
      { ...OPTS_MINE, rollbackFloor: '0.3.0' }) === '0.3.0');
  const NOW = Date.UTC(2026, 8, 19);
  const withTime = (daysAgo) => ({
    ...meta({ rollback: '0.2.0', latest: '0.3.0' }, obj(['0.2.0', '0.3.0'])),
    time: { '0.2.0': new Date(NOW - daysAgo * 86400000).toISOString() },
  });
  check('A3b-6 发布超出时效窗口（180 天前）→ 忽略 rollback',
    channel.pickReleaseVersion(withTime(180), { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.3.0');
  check('A3b-7 发布在窗口内（7 天前）→ 采纳 rollback',
    channel.pickReleaseVersion(withTime(7), { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.2.0');
  check('A3b-8 镜像剥掉 time 字段 → 时效核验跳过（下限仍守，不误挡合法回退）',
    channel.pickReleaseVersion(meta({ rollback: '0.2.0', latest: '0.3.0' }, obj(['0.2.0', '0.3.0'])),
      { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.2.0');
  check('A3b-9 time 存在但缺该版本条目 → 同样跳过时效',
    channel.pickReleaseVersion({ ...withTime(7), time: { '9.9.9': withTime(180).time['0.2.0'] } },
      { ...OPTS_MINE, rollbackFloor: '0.1.0', now: NOW }) === '0.2.0');
  check('A3b-10 第三方包不套 rollback/下限语义（RC-3 不受影响）',
    channel.pickReleaseVersion(meta({ rollback: '0.9.0', latest: '1.0.0' }, obj(['0.9.0', '1.0.0'])), OPTS_THIRD) === '1.0.0');
  const contractRc7 = fs.readFileSync(path.join(ROOT, 'RELEASE-CHANNEL-CONTRACT.md'), 'utf8');
  check('A3b-11 契约声明 RC-7 防降级下限（防契约单方漂移）',
    /RC-7/.test(contractRc7) && /防降级下限/.test(contractRc7) && /① [^\n]*RC-7/.test(contractRc7));
}

// ── §3 ②：灰度定向 ──
{
  const m = meta({ canary: '0.1.6-BETA.1', latest: '0.1.4' }, obj(['0.1.4', '0.1.6-BETA.1']));
  check('② 名单内 + canary 合法 → 返回 canary',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: true }) === '0.1.6-BETA.1');
  check('RC-4 名单外 → 忽略 canary，取 latest',
    channel.pickReleaseVersion(m, { ...OPTS_MINE, canary: false }) === '0.1.4');
  check('RC-4 canary tag 全局存在但不影响非名单机器', channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('② canary 非法（脏 tag）→ 跳过，取 latest',
    channel.pickReleaseVersion(meta({ canary: 'not-a-version', latest: '0.1.4' }, {}), { ...OPTS_MINE, canary: true }) === '0.1.4');

  // ── 防回归（2026-09-16）：灰度判定**不得**以"名单包存在"为依据 ──
  //   曾经的错误实现：`_inCanaryList()` 里"装了 @dsh-sup/canary-allowlist 就算命中"。
  //   那是"全员灰度"（该包为所有候选机共用），与"定向"的初衷相反。
  //   契约 §5.3 已冻结正确语义（读**内容** + schema===1 + installId/hostnames 匹配）；
  //   且该包当前**未发布**（§5.3 预留），故判定应恒为"非灰度"，只走本地开关。
  // ⚠ 2026-09-17（域结构第三轮）：distribution 已拆分，按目录聚合读取。
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const distSrc = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  check('防回归 灰度判定不得以"名单包存在"为依据（包存在 ≠ 在名单里）',
    !/canaryPkgPresent/.test(distSrc) && !/existsSync\([^)]*canary-allowlist/.test(distSrc), 'ok');
  check('防回归 当前只认本地开关（canary === true）',
    /isInCanaryList\([^)]*\)\s*\{[\s\S]{0,200}?canary === true/.test(distSrc), 'ok');
}

// ── §3 ③：优先信 latest（RC-1）──
{
  const m = meta({ latest: '0.1.4' }, obj(['0.1.4', '0.1.5-BETA.7', '0.1.6-BETA.1']));
  check('③ latest 存在 → 返回它（RC-1：不取全量最高）', channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('RC-1 反向：全量最高 ≠ latest 时不得取最高', channel.pickReleaseVersion(m, OPTS_MINE) !== '0.1.6-BETA.1');
  check('③ latest 为合法预发布号也可用',
    channel.pickReleaseVersion(meta({ latest: '0.2.0-RC.1' }, obj(['0.2.0-RC.1'])), OPTS_MINE) === '0.2.0-RC.1');
}

// ── §3 ④：latest 缺失/非法 → versions 最高（兼容兜底；我们的包排除 -BETA.，E-4 改判）──
{
  // E-4（AUDIT-2026-09-19 第 4 批）改判说明：本例原期望 '0.1.5-BETA.7'（全量最高），
  //   即「镜像响应里 latest 缺失 → 稳定版机器被静默升到测试版」。现按契约 §3 ④ 排除 BETA。
  const m142 = meta({}, obj(['0.1.3', '0.1.5-BETA.7', '0.1.4']));
  check('④ latest 缺失 → versions 最高，但**不越过 BETA**（E-4 改判）',
    channel.pickReleaseVersion(m142, OPTS_MINE) === '0.1.4',
    channel.pickReleaseVersion(m142, OPTS_MINE));
  check('④ 反向非空转：旧「全量最高」形态会给出 0.1.5-BETA.7（判据有分辨力）',
    Object.keys(m142.versions).includes('0.1.5-BETA.7') &&
    channel.pickReleaseVersion(m142, OPTS_MINE) !== '0.1.5-BETA.7',
    channel.pickReleaseVersion(m142, OPTS_MINE));
  check('④ latest 非法 → versions 最高（无 BETA 时候选不变）',
    channel.pickReleaseVersion(meta({ latest: 'garbage' }, obj(['0.1.3', '0.1.4'])), OPTS_MINE) === '0.1.4');
  check('④ 兜底只认 versions（不含 dist-tags 中的低值）',
    channel.pickReleaseVersion(meta({ bad: '0.9.9' }, obj(['0.1.1', '0.1.2'])), OPTS_MINE) === '0.1.2');
  // ③ 与 ④ 的分工：latest **显式指向** BETA（当前线上实况）时照原样采纳，不受 E-4 影响。
  check('③ latest 显式指向 BETA 仍采纳（tag 值是声明，排除只作用于兜底）',
    channel.pickReleaseVersion(meta({ latest: '0.1.5-BETA.7' }, obj(['0.1.5-BETA.7', '0.1.4'])), OPTS_MINE) === '0.1.5-BETA.7',
    channel.pickReleaseVersion(meta({ latest: '0.1.5-BETA.7' }, obj(['0.1.5-BETA.7', '0.1.4'])), OPTS_MINE));
  // 我们的正式版形态是 -RC.n（同为 semver prerelease），故排除只认 -BETA. 字面，不得按「含连字符」判。
  check('④ 排除只认 -BETA. 形态：-RC.n 是我们的正式版，不得一并排除',
    channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-RC.1'])), OPTS_MINE) === '0.1.5-RC.1',
    channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-RC.1'])), OPTS_MINE));
  // 第三方包不套 BETA 排除（他人无我们的通道纪律）——对照例，钉住「排除只在 isOurs 分支」。
  check('④ 第三方包不套 BETA 排除（对照：latest 缺失仍取 versions 最高）',
    channel.pickReleaseVersion(meta({}, obj(['1.0.0', '1.1.0-beta.2'])), OPTS_THIRD) === '1.1.0-beta.2',
    channel.pickReleaseVersion(meta({}, obj(['1.0.0', '1.1.0-beta.2'])), OPTS_THIRD));
}

// ── §3 ⑤：皆无 → null（绝不猜）──
{
  check('⑤ 空元数据 → null', channel.pickReleaseVersion(meta({}, {}), OPTS_MINE) === null);
  check('⑤ 全为非法版本 → null', channel.pickReleaseVersion(meta({ latest: 'x' }, obj(['1.0', 'v2'])), OPTS_MINE) === null);
  check('⑤ 缺 meta → null', channel.pickReleaseVersion(null, OPTS_MINE) === null);
  check('⑤ latest 非法且 versions 空 → null', channel.pickReleaseVersion(meta({ latest: 'garbage' }, {}), OPTS_MINE) === null);
  // E-4：④ 排除 BETA 后无候选 → 落到 ⑤ 明确失败（RC-5：如实报错，不得静默当成"已是最新"）。
  check('⑤ versions 只有 BETA 且 latest 缺失 → null（宁可失败也不猜测试版）',
    channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-BETA.10'])), OPTS_MINE) === null,
    String(channel.pickReleaseVersion(meta({}, obj(['0.1.5-BETA.9', '0.1.5-BETA.10'])), OPTS_MINE)));
}

// ── 第三方包：RC-3（条 7 改判）不套 rollback/canary，但 latest 优先 ──
{
  const m = meta({ latest: '1.0.0', alpha: '1.2.0-alpha.1' }, obj(['1.0.0', '1.1.0', '1.2.0-alpha.1']));
  check('RC-3 条7 第三方包：latest 优先，他人杂 tag（alpha）不再进候选（旧全量最高会返回 1.2.0-alpha.1）',
    channel.pickReleaseVersion(m, OPTS_THIRD) === '1.0.0', channel.pickReleaseVersion(m, OPTS_THIRD));
  check('RC-3 条7 第三方包：versions 里存在更高版也不取（latest 才是他人声明的稳定版）',
    channel.pickReleaseVersion(meta({ latest: '1.0.0' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD) === '1.0.0',
    channel.pickReleaseVersion(meta({ latest: '1.0.0' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD));
  check('RC-3 第三方包：即使带 rollback tag 也不套通道语义（回退是我们的纪律，不是他人的）',
    channel.pickReleaseVersion(meta({ rollback: '0.9.0', latest: '1.0.0' }, obj(['0.9.0', '1.0.0', '1.1.0'])), OPTS_THIRD) === '1.0.0',
    channel.pickReleaseVersion(meta({ rollback: '0.9.0', latest: '1.0.0' }, obj(['0.9.0', '1.0.0', '1.1.0'])), OPTS_THIRD));
  check('RC-3 第三方包：即使本机在灰度名单也不取他人 canary',
    channel.pickReleaseVersion(meta({ canary: '2.0.0', latest: '1.0.0' }, obj(['1.0.0', '2.0.0'])), { ...OPTS_THIRD, canary: true }) === '1.0.0',
    channel.pickReleaseVersion(meta({ canary: '2.0.0', latest: '1.0.0' }, obj(['1.0.0', '2.0.0'])), { ...OPTS_THIRD, canary: true }));
  check('RC-3 条7 latest 缺失 → 回落 versions 最高（兜底仍在工作）',
    channel.pickReleaseVersion(meta({ alpha: '1.2.0-alpha.1' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD) === '1.1.0',
    channel.pickReleaseVersion(meta({ alpha: '1.2.0-alpha.1' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD));
  check('RC-3 条7 反向：兜底只看 versions，杂 tag（next 9.9.9）不得越界当候选',
    channel.pickReleaseVersion(meta({ next: '9.9.9' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD) === '1.1.0',
    channel.pickReleaseVersion(meta({ next: '9.9.9' }, obj(['1.0.0', '1.1.0'])), OPTS_THIRD));
  check('RC-3 第三方包：仅 dist-tags 有 latest 时也算候选', channel.pickReleaseVersion(meta({ latest: '3.0.0' }, {}), OPTS_THIRD) === '3.0.0', '3.0.0');
  check('RC-3 第三方包：latest 非法且无 versions → null（RC-5 绝不猜）', channel.pickReleaseVersion(meta({ latest: 'x' }, {}), OPTS_THIRD) === null, 'null');
  check('RC-3 改判已登记（防文档回退）：契约 §3 第三方段落写明 latest 优先',
    /latest/.test(fs.readFileSync(path.join(ROOT, 'RELEASE-CHANNEL-CONTRACT.md'), 'utf8')), '有');
}

// ── 收敛为「唯一实现」：dist 不再自带一份选版算法 ──
{
  const distDirU = path.join(ROOT, 'src', 'platform', 'distribution');
  const dsrc = fs.readdirSync(distDirU).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDirU, f), 'utf8')).join(String.fromCharCode(10));
  check('唯一实现：release.js 定义 pickReleaseVersion 并导出（无第二份实现）',
    /^function pickReleaseVersion\(/m.test(dsrc) && /pickReleaseVersion,/.test(dsrc));
  {
    // fetchNpmLatest 体内不得再内联「遍历取最高」——那段逻辑只允许存在于 highestVersion。
    const fn = dsrc.match(/async function fetchNpmLatest\([^)]*\) \{[\s\S]*?\n\}/);
    check('唯一实现：fetchNpmLatest 体内不再内联「遍历取最高」循环',
      !!fn && !/for \(const v of/.test(fn[0]), fn ? 'ok' : '未定位到 fetchNpmLatest');
  }
  check('唯一实现：dist 经注入复用 VERSION_RE（不复制 semver 合法性知识）',
    /isValid: \(v\) => typeof v === 'string' && VERSION_RE\.test\(v\)/.test(dsrc));
  check('唯一实现：highestVersion 只在 dist 内定义一次（max 兜底步）',
    (dsrc.match(/function highestVersion\(/g) || []).length === 1);
}

// ── 反向：门禁非空转（判据能识别旧形态「取全量最高」）──
{
  const legacyPick = (m) => {
    const cands = [...Object.values(m['dist-tags'] || {}), ...Object.keys(m.versions || {})].filter((v) => VERSION_RE.test(v));
    let best = null;
    for (const v of cands) if (!best || semverCompare(v, best) > 0) best = v;
    return best;
  };
  const m = meta({ latest: '0.1.4' }, obj(['0.1.4', '0.1.6-BETA.1']));
  check('反向：旧形态「取全量最高」确实会取错（≠ latest）',
    legacyPick(m) === '0.1.6-BETA.1' && channel.pickReleaseVersion(m, OPTS_MINE) === '0.1.4');
  check('反向：Δ 判据对两实现给出不同答案（非恒等，门禁非空转）',
    legacyPick(m) !== channel.pickReleaseVersion(m, OPTS_MINE));
}

// ── 契约一致性：§3 五步在契约正文中仍被声明（防契约单方漂移）──
{
  const contract = fs.readFileSync(path.join(ROOT, 'RELEASE-CHANNEL-CONTRACT.md'), 'utf8');
  check('P-契约 §3 含 rollback 分支且声明最高优先级',
    /① [^\n]*rollback/.test(contract) && /回退：最高优先级/.test(contract));
  check('P-契约 §3 含 canary 灰度分支', /② [^\n]*canary/.test(contract) && /灰度/.test(contract));
  check('P-契约 §3 含 latest 正式分支与全量最高禁令（RC-1）', /③ [^\n]*latest/.test(contract) && /RC-1/.test(contract));
  check('P-契约 §3 含 versions 最高兜底步', /④ [^\n]*versions/.test(contract));
  check('P-契约 §3 含返回 null 明确失败步（RC-5）', /⑤[^\n]*null/.test(contract) && /RC-5/.test(contract));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
