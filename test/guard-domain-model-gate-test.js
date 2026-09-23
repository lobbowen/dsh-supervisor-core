#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 守护域模型门禁（GD-1..GD-8）—— SSOT: GUARD-DOMAIN-MODEL.md
//
// ## 为什么需要它
//   GUARD-DOMAIN-MODEL.md 记录了「模型错位」的真实后果：把基础设施（lan-daemon）硬塞进
//   「用户意图模型」，于是代码里出现了自相矛盾的三件套——
//     - 对恒 true 值的补丁判断（entry.guardian !== true，对基础设施无意义）；
//     - A/B 平面 id 混乱：计数写 get('lan-daemon') 而读 get('lan')；
//     - guardian_action 里 lan 的 restartCount 恒为 0（可观测性断裂）。
//   本门禁把该文档第 2 节的两域模型与第 3 节的 G-1..G-6 铁律变成**可执行断言**，防止错位回潮。
//
// ## 断言
//   GD-1 guardian 不入目录面（G-1 / B2-2 收口）：申报块无 guardian 字段、createEntry 对全部 kind
//        不物化该键、去注释代码上目录面三文件零 guardian token（权威在 dsh-main.json / inst.guardian，消费者直读源）
//   GD-2 _daemonSuperviseOnce 的 **router 与 lan 两个分支**均**不调用** _guardianEvent（G-2）
//   GD-3 两平面 id 必须**显式映射**，保活路径不得跨平面混用 id（G-5）
//         契约共识方案把 router-daemon 也归入域 B 后，「router 的 guardian_action 读写同 id」
//          这一断言前提已不存在（基础设施不发该事件）。G-5 的本义是「同一对象不得有两个 id，
//          或必须显式映射」，故按此断言。
//   GD-4 反向：判据能识别「基础设施带 guardian 字段 / 分支仍发事件」的旧形态（门禁非空转）
//   GD-5 基础设施保活路径不再有对恒 true 值的 guardian !== true 补丁判断（G-6）
//   GD-6 保活/游离判据只读持久化意图，不读生命周期视图或目录 entry 的 desired 镜像
//   GD-7 沙箱运行意图无第二落点（B2-1 字段废止）：.state.desired 赋值全域清零，model 仅存一次性残留剔除口
//   GD-8 每类申报 desired 的来源（意图/配置源 vs 派生源）与其决策消费者必须自洽：无落点判红，消费者 GAP 清零
//
//  域划分（契约 ，**共识方案**）：
//   域 A 用户意图 = main（原生 DSH）+ 沙箱实例；
//   域 B 基础设施 = **router-daemon + lan-daemon**（两者都无用户意图轴、都无条件保活）。
//
// ## 现状
//   实现已按契约归位：域 B 申报自始不带 guardian，control-view 两分支删除
//   _guardianEvent / guardian!==true 补丁 / restartCount 写入；B2-2 进一步让目录面
//   全域不持 guardian（GD-1 覆盖申报/运行期/源码 token 三层）。
//   GD-4 仍以**构造的旧形态**证明判据有分辨力（门禁非空转）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BT = String.fromCharCode(96); // 反引号（模板串分隔符）

// ---------------------------------------------------------------------------
// 源码定位工具（纯静态；跳过字符串/注释，避免误判括号）
// ---------------------------------------------------------------------------

/** 从 openIdx 处的 '{' 出发，返回配对 '}' 的下标（跳过注释/字符串/模板串）。 */
function matchBrace(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== String.fromCharCode(10)) i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === "'" || c === '"' || c === BT) {
      const q = c; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** 去除 // 行注释与块注释（跳过字符串/模板串，避免 'http://' 之类被误伤）。
 *   引用判据必须只看**代码**：任务硬约束「删除前 grep 证明零真实引用（注释不算）」——
 *  同理门禁也不得因一句「已删除 _guardianEvent」的说明性注释而误报。 */
// 阶段六 P6-A：剥离统一走 test/_strip.js 的**字符级单一实现**（删注释、保行结构）。
const { stripComments: stripCommentsLex } = require('./_strip');
function stripComments(src) { return stripCommentsLex(src); }

/** 取含 kind: '<kind>' 的申报对象字面量（从它所属的 '{' 到配对 '}'）。 */
function entrySpecOf(src, kind) {
  const m = new RegExp("kind\\s*:\\s*['\"]" + kind + "['\"]").exec(src);
  if (!m) return null;
  let open = -1;
  for (let i = m.index; i >= 0; i--) { if (src[i] === '{') { open = i; break; } }
  if (open < 0) return null;
  const close = matchBrace(src, open);
  return close < 0 ? null : src.slice(open, close + 1);
}

/** 取类方法体（name(...) { 到配对 '}' 之间的文本）。 */
function methodBody(src, name) {
  const m = new RegExp(name + "\\s*\\([^)]*\\)\\s*\\{").exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(src, open);
  return close < 0 ? null : src.slice(open + 1, close);
}

/** 取 lan 分支：从守护判入口（.enabled() / lanDaemonEnabled()，形态无关）到函数体末尾（lan 是最后一段）。 */
function lanBranchOf(fnBody) {
  //  阶段六 B-6：supervise.js 去 this 后 lan 闸变为 d.daemons().enabled()。
  //   判据改为**形态无关**（匹配任意接收者的 .enabled() 或 lanDaemonEnabled()）；判据本意不变。
  const i = fnBody.search(/(?:\.enabled\(\)|lanDaemonEnabled\(\))/);
  return i < 0 ? null : fnBody.slice(i);
}

/** 取 router 分支：从 kind === 'router' 判分到 lan 分支起点。 */
function routerBranchOf(fnBody) {
  const i = fnBody.search(/kind\s*===\s*['"]router['"]/);
  const j = fnBody.search(/(?:\.enabled\(\)|lanDaemonEnabled\(\))/);
  if (i < 0) return null;
  return fnBody.slice(i, j > i ? j : fnBody.length);
}

// -- 判据（正/反共用；GD-4 对它们做反向断言，证明门禁非空转）--

/** GD-1 判据：entry 申报块是否带 guardian 字段（域 B 不应有用户意图字段）。 */
const hasGuardianField = (spec) => /\bguardian\s*:/.test(spec);

/** GD-1 判据（B2-2）：去注释代码任意处出现 guardian token = 目录面仍在读/写该字段。
 *   守护开关权威在域记录（dsh-main.json / inst.guardian），目录面留副本只会制造分歧面。 */
const carriesGuardianCode = (code) => /guardian/i.test(code);

/** GD-2 判据：某分支是否调用 _guardianEvent('<id>'。 */
const callsGuardianEvent = (branch, id) => new RegExp("_guardianEvent\\(\\s*['\"]" + id + "['\"]").test(branch);

/** GD-3 判据（旧形态专用）：事件读取 id（_guardianEvent('<id>')）与计数写入 id（get('<id>')）是否配对。
 *   共识方案把基础设施（router/lan）全部归入域 B 后，保活路径不再发该事件，
 *    本判据只用于 GD-4 反向（证明「写读 id 错位」这种旧形态确实能被识别），不再作正面断言。 */
const idPaired = (branch, id) => callsGuardianEvent(branch, id)
  && new RegExp("get\\(\\s*['\"]" + id + "['\"]\\s*\\)").test(branch);

/** GD-5 判据（泛指）：是否存在对 guardian 的 !== true 补丁判断。 */
const hasGuardianNotTruePatch = (src) => /\.guardian\s*!==\s*true/.test(src);

/** GD-5 判据（旧形态，特指）：entry.guardian !== true（lan 分支当年那处补丁）。 */
const hasEntryGuardianPatch = (src) => /entry\s*\.\s*guardian\s*!==\s*true/.test(src);

/** GD-6 判据：是否读了派生的意图镜像（生命周期视图或 A 平面目录 entry 上的 desired）。 */
const readsDerivedIntent = (src) => /\.desired\b/.test(src);

/** 递归收集 src/ 下全部 .js 源码（供 GD-5 全域旧形态扫描）。 */
function walkSrc(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkSrc(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GD-1 guardian 不入目录面（G-1 / B2-2：守护开关权威在域记录，消费者直读源）
// ---------------------------------------------------------------------------
{
  const registrySrc = read('src/app/control/specs.js');
  // 域 B 基础设施 = router-daemon + lan-daemon（契约 共识方案）——两个都要断言。
  const lanSpec = entrySpecOf(registrySrc, 'lan-daemon');
  const routerSpec = entrySpecOf(registrySrc, 'router-daemon');
  check('GD-1 lan-daemon 申报块被准确定位', !!lanSpec,
    lanSpec ? 'specs.js 中已定位 kind: lan-daemon 对象字面量' : '未找到 kind: lan-daemon 申报块');
  check('GD-1 router-daemon 申报块被准确定位', !!routerSpec,
    routerSpec ? 'specs.js 中已定位 kind: router-daemon 对象字面量' : '未找到 kind: router-daemon 申报块');
  // 域 B 基础设施（router-daemon + lan-daemon）**两者都不得有** guardian 字段（契约 共识方案）。
  check('GD-1 域 B 基础设施申报不含 guardian 字段（G-1：无用户意图轴）',
    !!lanSpec && !!routerSpec && !hasGuardianField(lanSpec) && !hasGuardianField(routerSpec),
    [lanSpec && hasGuardianField(lanSpec) ? 'lan-daemon 仍含 guardian:' : null,
     routerSpec && hasGuardianField(routerSpec) ? 'router-daemon 仍含 guardian:' : null]
      .filter(Boolean).join('; ') || 'ok（两者均无 guardian）');

  //  GD-1 运行期断言（B2-2 收口：全域 kind 都不物化）：
  //   createEntry 曾按 DOMAIN_A_KINDS 对 dsh/sandbox-instance 物化 guardian 并随目录落盘，
  //   而该字段在全仓 src 内零读者——落盘副本与域记录之间只有分歧面，没有真相来源。
  //   现断言**任何 kind** 传入 guardian 都不落键（"不存在"而非"置 false"），
  //   老目录残留经 load→createEntry 重建即自然消失，无需迁移脚本。
  const { createEntry } = require(path.join(ROOT, 'src', 'app', 'control', 'registry.js'));
  for (const k of ['dsh', 'sandbox-instance', 'router-daemon', 'lan-daemon']) {
    const e = createEntry({ kind: k, id: 'gd1-' + k, desired: 'running', guardian: true });
    check(`GD-1 运行期：createEntry 对 kind='${k}' 不物化 guardian 键（带 guardian:true 入参也不落）`,
      !('guardian' in e), 'entry 的键: ' + Object.keys(e).join(','));
  }
  //  GD-1 源码层断言：目录面三文件（entry 工厂 / 注册机 / 申报器）去注释后 guardian token 清零。
  //   申报不写 + 运行期不落键只挡住数据面；update() 里一句残留补丁、或未来某处
  //   「entry.guardian」读法，都会被本条直接判红（注释说明不计）。
  const OFFENDER_FILES = ['src/app/control/managed-object.js', 'src/app/control/registry.js', 'src/app/control/specs.js'];
  const offenders = OFFENDER_FILES.filter((f) => carriesGuardianCode(stripComments(read(f))));
  check('GD-1 源码层：目录面三文件去注释后零 guardian token（B2-2）',
    offenders.length === 0,
    offenders.length ? offenders.map((f) => f + ' 仍含 guardian 代码').join('; ') : 'ok（三份仅剩说明性注释）');
}

// ---------------------------------------------------------------------------
// GD-2 基础设施保活路径不调用 _guardianEvent（G-2）
// ---------------------------------------------------------------------------
//  步骤7：原 control-view.js 已拆为多个模块（facade/router、daemons/supervise、…）。
//   本门禁的断言对象是「保活路径」，横跨 facade（router 分支）与 daemons/supervise（_daemonSuperviseOnce），
//   故读**整组**（否则文件拆分即静默失去覆盖面）。
const controlSrc = [
  'src/app/facade/router.js',
  'src/app/daemons/supervise.js',
  'src/app/daemons/runtime.js',
  'src/app/facade/lan.js',
].map((f) => read(f)).join(String.fromCharCode(10));
const fnBody = methodBody(controlSrc, '_daemonSuperviseOnce');
const lanBranch = fnBody ? lanBranchOf(fnBody) : null;
{
  check('GD-2 _daemonSuperviseOnce 函数体与 lan 分支被准确定位',
    !!fnBody && !!lanBranch,
    fnBody ? (lanBranch ? '函数体 ' + fnBody.length + ' 字符，lan 分支已切出' : '函数体内未找到 lan 分支判入口') : '未找到 _daemonSuperviseOnce');
  const routerBr = fnBody ? routerBranchOf(fnBody) : null;
  check("GD-2 基础设施保活路径不调用 _guardianEvent('lan')（G-2）",
    !!lanBranch && !callsGuardianEvent(lanBranch, 'lan'),
    lanBranch && callsGuardianEvent(lanBranch, 'lan') ? 'lan 分支仍发 guardian_action 事件（基础设施不该有守护计数）' : 'ok');
  check("GD-2 基础设施保活路径不调用 _guardianEvent('router')（G-2）",
    !!routerBr && !callsGuardianEvent(routerBr, 'router'),
    routerBr && callsGuardianEvent(routerBr, 'router') ? 'router 分支仍发 guardian_action 事件（域 B 不该有守护计数）' : 'ok');
  //  域模型收口（比「分支不调用」更强，防止函数换处复活）：
  //   整份 control-view.js 已**不再定义** _guardianEvent，且全仓 src/ 无任何 guardian_action 生产者。
  //   判据改为全域扫描（注释不算引用），对错位回潮是硬失败而非静默。
  const controlCode = stripComments(controlSrc);
  check('GD-2b 全域不存在 _guardianEvent 定义/调用（函数已删，非仅分支未调用）',
    !/_guardianEvent\s*\(/.test(controlCode),
    /_guardianEvent\s*\(/.test(controlCode) ? 'control-view.js 仍有 _guardianEvent 定义' : 'ok（函数已删除，注释不计）');
  const producerOffenders = walkSrc(path.join(ROOT, 'src'), [])
    .filter((p) => /append\(\s*['"]guardian_action['"]/.test(stripComments(fs.readFileSync(p, 'utf8'))));
  check('GD-2c guardian_action 事件无任何生产者（G-2：域 B 不发；函数已删故域 A 亦不需要）',
    producerOffenders.length === 0,
    producerOffenders.length ? producerOffenders.map((p) => path.relative(ROOT, p)).join(', ') : 'ok');
}

// ---------------------------------------------------------------------------
// GD-3 两平面 id 显式映射 + 保活路径不跨平面混用 id（G-5）
// ---------------------------------------------------------------------------
{
  const routerBranch = fnBody ? routerBranchOf(fnBody) : null;
  check('GD-3 router 分支被准确定位（用于 GD-2 的域 B 断言）', !!routerBranch,
    routerBranch ? 'router 分支已切出' : '未找到 kind === router 分支');
  // 域 B 的 A/B 平面：A 平面目录 id='lan-daemon'（registry 申报），B 平面 lifecycle id='lan'（adapters）。
  // G-5 要求二者**要么一致、要么显式映射**——此处断言映射点确实存在且可读。
  //  步骤 7：registerAdapter 的注册点随构造期装配一起从 src/supervisor.js
  //   下沉到 app/assembly/compose.js（薄壳只剩组装与启动）——故改读新模块；
  //   仍断言「注册点本身即映射点」（kind='lan-daemon' -> _daemonSuperviseOnce('lan')），
  //   否则文件一搬门禁就静默失去覆盖面。
  // R3 严值 DF-2：受管注册机 adapter 挂接随各域构造拆到 compose/domains.js。
  const composeSrc = read('src/app/assembly/compose/domains.js');
  const mapped = /registerAdapter\(\s*'lan-daemon'\s*,[\s\S]{0,160}?_daemonSuperviseOnce\(\s*'lan'\s*\)/.test(composeSrc);
  check("GD-3 域 B 两平面 id 显式映射（A 平面 'lan-daemon' → B 平面 'lan'，G-5）",
    mapped, mapped ? 'ok（compose.js 注册点即映射点）' : '未找到显式映射');
  // 保活路径不得跨平面取 id：基础设施分支全程不应再 get('lan-daemon')（那是 A 平面 id）。
  check('GD-3 保活路径不跨平面混用 id（A 平面 lan-daemon 已从保活路径移除）',
    !!lanBranch && !/get\(\s*'lan-daemon'\s*\)/.test(lanBranch),
    lanBranch && /get\(\s*'lan-daemon'\s*\)/.test(lanBranch) ? 'lan 分支仍取 A 平面 id' : 'ok');
}

// ---------------------------------------------------------------------------
// GD-4 反向：判据能识别旧形态（门禁非空转）
// ---------------------------------------------------------------------------
{
  // 旧形态1：基础设施 entry 带 guardian（当年 registry-view.js:223 的形态）
  const OLD_ENTRY = "this._upsertManaged({ kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon', desired: 'running', guardian: true, ownership: { processMode: 'daemon' } });";
  const oldSpec = entrySpecOf(OLD_ENTRY, 'lan-daemon');
  check('GD-4 反向：判据能识别「基础设施带 guardian 字段」的旧形态',
    !!oldSpec && hasGuardianField(oldSpec),
    oldSpec ? '命中 guardian:（判据有效）' : '构造片段未被判违规（判据空转！）');

  // 正确形态：无 guardian -> 判据不得误报
  const CLEAN_ENTRY = "this._upsertManaged({ kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon', ownership: { processMode: 'daemon' } });";
  const cleanSpec = entrySpecOf(CLEAN_ENTRY, 'lan-daemon');
  check('GD-4 反向：判据不误报无 guardian 的正确形态',
    !!cleanSpec && !hasGuardianField(cleanSpec), 'ok');

  // 旧形态1b（B2-2 废止的目录面写法）：createEntry 曾按域物化该键、update() 曾带残留补丁。
  const OLD_MATERIALIZE = "if (isDomainA(spec.kind)) e.guardian = spec.guardian === true;";
  const OLD_UPDATE_PATCH = "if (p.guardian !== undefined) { e.guardian = p.guardian === true; return; }";
  check('GD-4 反向：源码层判据能识别目录面物化/修正 guardian 的旧形态',
    carriesGuardianCode(OLD_MATERIALIZE) && carriesGuardianCode(OLD_UPDATE_PATCH), 'hit');
  check('GD-4 反向：源码层判据不误报现行入参形态（kind/id/desired/ownership）',
    !carriesGuardianCode("const e = createEntry({ kind: o.kind, id: o.id, desired: o.desired, ownership: o.ownership });"), 'ok');

  // 旧形态2：lan 分支仍调用 _guardianEvent（当年 control-view.js:451/469 的形态）
  const OLD_LAN_BRANCH = "if (!this.lanDaemonEnabled()) return { ok: this._lanDaemonActive() };\n"
    + "const entry = this.managedObjects.get('lan-daemon');\n"
    + "if (entry && entry.guardian !== true) { this._guardianEvent('lan', 'skip-guardian-off'); return { ok: false }; }\n"
    + "this._guardianEvent('lan', 'pull', { pid: rt.spawned });";
  check('GD-4 反向：判据能识别旧 lan 分支仍发 _guardianEvent',
    callsGuardianEvent(OLD_LAN_BRANCH, 'lan'), 'hit');

  // 旧形态3：lan 的写读 id 错位（写 get('lan-daemon') / 读事件 resource='lan'）
  check('GD-4 反向：id 配对判据能识别 lan 写读错位（写 lan-daemon / 读 lan）',
    !idPaired(OLD_LAN_BRANCH, 'lan'), '命中错位（判据有效）');

  // 旧形态4：恒 true 值上的 guardian !== true 补丁
  check('GD-4 反向：判据能识别恒 true 值上的 guardian !== true 补丁',
    hasGuardianNotTruePatch(OLD_LAN_BRANCH) && hasEntryGuardianPatch(OLD_LAN_BRANCH), 'hit');
}

// ---------------------------------------------------------------------------
// GD-5 删除对恒 true 值的 guardian !== true 补丁判断（G-6）
// ---------------------------------------------------------------------------
{
  // 域 A 对象的 guardian 判断合法（rlc.guardian !== true 是正常用户意图逻辑），
  // 故按上下文区分：主断言只看 infrastructural 的 lan 分支。
  check('GD-5 lan 保活分支不存在 guardian !== true 补丁判断（G-6）',
    !!lanBranch && !hasGuardianNotTruePatch(lanBranch),
    lanBranch && hasGuardianNotTruePatch(lanBranch) ? 'lan 分支仍有对恒 true 值的 !== true 判断' : 'ok');

  // 全域旧形态扫描：entry.guardian !== true 是当年 lan 分支的特征写法（域 A 用 rlc/lc，不叫 entry），
  // 它一旦回归即判违规，防止补丁换个地方复活。
  const allSrc = walkSrc(path.join(ROOT, 'src'), []);
  const offenders = allSrc.filter((p) => hasEntryGuardianPatch(fs.readFileSync(p, 'utf8')));
  check('GD-5 全域不存在 entry.guardian !== true 旧补丁形态',
    offenders.length === 0,
    offenders.length ? offenders.map((p) => path.relative(ROOT, p)).join(', ') : allSrc.length + ' 个源码文件已扫描');
}

// ---------------------------------------------------------------------------
// GD-6 保活/游离判据只读持久化意图，不读派生镜像（ST-1 读侧单源）
//
// 为什么单独一条：域 B 的「该不该活着」只有一个应然来源（config.routerAutostart / daemon 部署选择），
//   而生命周期视图与 A 平面目录的 desired 都是它派生出来的镜像。判据里多读一个镜像，
//   就等于承认「镜像与库里不一致时以镜像为准」——写库半途失败或被显式停止过的对象会被无限重拉，
//   面板上的开关关掉后仍在跑。故本条只执法**读侧**，写侧由 session-lifecycle-test 的 ST-1 段锁。
// ---------------------------------------------------------------------------
{
  const codeOf = (rel) => stripComments(read(rel));
  const codeSrc = [
    'src/app/facade/router.js',
    'src/app/daemons/supervise.js',
    'src/app/daemons/runtime.js',
    'src/app/facade/lan.js',
  ].map(codeOf).join(String.fromCharCode(10));
  const fnCode = methodBody(codeSrc, '_daemonSuperviseOnce');
  const routerCode = fnCode ? routerBranchOf(fnCode) : null;
  const lanCode = fnCode ? lanBranchOf(fnCode) : null;
  check('GD-6 去注释源码上保活函数体与两分支被定位（覆盖面非空）',
    !!fnCode && !!routerCode && !!lanCode,
    fnCode ? (routerCode && lanCode ? 'ok' : '分支定位失败') : '未找到 _daemonSuperviseOnce');
  check('GD-6 router 保活判据不读派生意图镜像（只看持久化 config）',
    !!routerCode && !readsDerivedIntent(routerCode),
    routerCode && readsDerivedIntent(routerCode) ? 'router 分支仍读 .desired' : 'ok');
  check('GD-6 lan 保活判据不读派生意图镜像',
    !!lanCode && !readsDerivedIntent(lanCode),
    lanCode && readsDerivedIntent(lanCode) ? 'lan 分支仍读 .desired' : 'ok');
  const wantLines = codeOf('src/app/audit/orphan-scan.js')
    .split(String.fromCharCode(10)).filter((l) => /want:\s*\(\)\s*=>/.test(l));
  check('GD-6 orphan-scan 的 want 判据被定位（覆盖面非空）', wantLines.length === 2,
    wantLines.length + ' 条 want 判据');
  check('GD-6 orphan-scan 的 want 不读目录 entry 的 desired',
    wantLines.length === 2 && !wantLines.some(readsDerivedIntent),
    wantLines.filter(readsDerivedIntent).join(' ; ') || 'ok');
  // 反向：判据必须认得出被移除的旧形态，否则上面几条是空转的正则。
  const OLD_MIRROR = "const wantRunning = d.config().routerAutostart === true || (rlc && rlc.desired === 'running');";
  const OLD_ENTRY_MIRROR = "want: () => g.getConfig().routerAutostart === true || !!(reg && reg.get('router-daemon').desired === 'running')";
  check('GD-6 反向：判据能识别「|| 视图/目录 desired」的旧形态',
    readsDerivedIntent(OLD_MIRROR) && readsDerivedIntent(OLD_ENTRY_MIRROR), 'hit');
  check('GD-6 反向：判据不误报只读持久化源的现行形态',
    !readsDerivedIntent("const wantRunning = d.config().routerAutostart === true;") && !readsDerivedIntent("want: () => g.getDaemons().enabled()"), 'ok');
}

// ---------------------------------------------------------------------------
// GD-7 沙箱运行意图没有第二落点（ST-2c 收口后的硬禁，B2-1 字段废止）
//
// inst.state.desired 已整体废止：lifecycle 的 start/stop 写口、model 的老库种子、specs 的申报
//   投影全部删除，意图 = guardian 开关 × 启停动作本身。src 内任何 `.state.desired =` 赋值
//   即第二个落点回潮，出现即红；旧观测路径的冻写旗标 keepDesired 同样零容忍。
//   唯一合法触碰是 normalize 的一次性残留剔除（delete 形态），其处数由 model 侧单独钉。
// ---------------------------------------------------------------------------
{
  const NL = String.fromCharCode(10);
  const isIntentWrite = (line) => /\.state\.desired\s*=(?!=)/.test(line);
  const countBy = (src, pred) => src.split(NL).filter(pred).length;
  const flagCount = (src) => (src.match(/keepDesired/g) || []).length;
  const writeHits = [];
  let flagTotal = 0;
  const flagFiles = [];
  const files = walkSrc(path.join(ROOT, 'src'), [])
    .map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
  for (const rel of files) {
    const code = stripComments(read(rel));
    const n = countBy(code, isIntentWrite);
    if (n) writeHits.push(rel + '=' + n);
    const f = flagCount(code);
    if (f) { flagTotal += f; flagFiles.push(rel + '=' + f); }
  }
  const modelCode = stripComments(read('src/domains/instance/model.js'));
  const deleteCount = (modelCode.match(/delete\s+inst\.state\.desired/g) || []).length;
  const modelDesiredRefs = (modelCode.match(/\.state\.desired\b/g) || []).length;
  check('GD-7 判据覆盖面非空（扫描 src 下源码文件数）', files.length > 50, files.length + ' 个文件');
  check('GD-7 意图写口全域清零（.state.desired 赋值出现即红）',
    writeHits.length === 0, writeHits.join(' ') || '零命中');
  check('GD-7 model 只剩一次性残留剔除口（delete 恰 1 处且是该文件唯一 .state.desired 引用）',
    deleteCount === 1 && modelDesiredRefs === 1, 'delete=' + deleteCount + ' 引用=' + modelDesiredRefs);
  check('GD-7 model 记录形状不再种 desired（createRecord/种子形态绝迹）',
    !/desired\s*:/.test(modelCode), 'desired: 命中=' + (modelCode.match(/desired\s*:/g) || []).length);
  check('GD-7 keepDesired 冻写旗标已废止（src 内出现即红）', flagTotal === 0, flagFiles.join(' ') || '零残留');
  // 反向：判据必须认得出第二写者与旧旗标，且不误读「读比较」与「别的 desired 字段」，否则上面几条是空转正则。
  check('GD-7 反向：域外第二写者形态被计数命中',
    countBy("  other.state.desired = 'stopped';", isIntentWrite) === 1, 'hit');
  check('GD-7 反向：读比较不误报为写',
    countBy("  if (inst.state.desired !== 'running') return;", isIntentWrite) === 0, 'ok');
  check('GD-7 反向：ManagedLifecycle 的同名字段不属本判据（不误报）',
    countBy("  this.desired = 'running';", isIntentWrite) === 0, 'ok');
  check('GD-7 反向：model 若把残留剔除写成赋值（seed 回潮形态）会被写口判据命中',
    countBy("  inst.state.desired = 'running';", isIntentWrite) === 1, 'hit');
  check('GD-7 反向：旗标回潮形态被禁判据命中（废止判据非空转）',
    flagCount("d.control().upsert(d.control().sandboxSpec(inst), { keepDesired: true });") === 1, 'hit');
}

// ---------------------------------------------------------------------------
// GD-8 desired 的来源分类与决策消费者必须一致（ST-2 读侧，B2-1 后重定档）
//
// 每类申报的 desired 的来源分两档：意图/配置源（config 或持久化意图字段）与派生源（由 state.phase 反推）。
//   派生源「无人读」= 该 kind 的意图既没落点也没生效路径；「有人读」= M-1 直接违例。
//   B2-1 后沙箱彻底退出申报面：sandboxSpec 不再声明 desired（运行意图无第二落点，自动拉起
//   只认 guardian），三类申报源都必须有决策读者——落点/消费者 GAP 面清零，回潮即红。
//   reader 判定只取自源码，不采信文档措辞。
// ---------------------------------------------------------------------------
{
  const NL = String.fromCharCode(10);
  const specsCode = stripComments(read('src/app/control/specs.js'));
  const specBody = (/function sandboxSpec[\s\S]*?\n  \}/.exec(specsCode) || [''])[0];
  const SOURCES = {
    'dsh': { re: /desired:\s*state\(\)\.desired\(\)/, source: 'intent', reader: true },
    'router-daemon': { re: /desired:\s*config\(\)\.routerAutostart/, source: 'config', reader: true },
    'lan-daemon': { re: /desired:\s*d\.enabled\(\)/, source: 'config', reader: true },
  };
  const unlocated = Object.keys(SOURCES).filter((k) => !SOURCES[k].re.test(specsCode));
  check('GD-8 三类 desired 来源表达式全部定位成功', unlocated.length === 0,
    unlocated.length ? '未定位: ' + unlocated.join(', ') : 'dsh/router/lan 均已定位');
  check('GD-8 specs.js 内 desired 字面量恰为 4 处（3 个来源 + upsert 的分发点）',
    (specsCode.match(/\bdesired\s*:/g) || []).length === 4,
    '实数=' + (specsCode.match(/\bdesired\s*:/g) || []).length);
  check('GD-8 沙箱申报体在（判据非空转前提下）不声明 desired、不含任何相位输入',
    specBody.length > 0 && !/\bdesired\b/.test(specBody) && !/\bphase\b/.test(specBody),
    '体长=' + specBody.length + ' desired命中=' + (/\bdesired\b/.test(specBody) ? '有' : '无')
      + ' phase命中=' + (/\bphase\b/.test(specBody) ? '有' : '无'));

  const hbCode = stripComments(read('src/app/control/heartbeat.js'));
  check('GD-8 目录 desired 的唯一决策读者是 daemon 类的 derivePhase 相位收敛',
    /if\s*\(ad\.derivePhase[\s\S]{0,200}?e\.desired\s*===\s*'running'/.test(hbCode), hbCode.match(/\be\.desired\b/) ? '已定位' : '未找到读取点');
  const adapterLines = stripComments(read('src/app/assembly/compose/domains.js'))
    .split(NL).filter((l) => /registerAdapter\(/.test(l));
  const daemonLines = adapterLines.filter((l) => /daemon/.test(l));
  const domainALines = adapterLines.filter((l) => /'dsh'|'sandbox-instance'/.test(l));
  check('GD-8 四个 kind 的 adapter 注册点被定位（覆盖面非空）',
    adapterLines.length === 4 && daemonLines.length === 2 && domainALines.length === 2,
    '共 ' + adapterLines.length + ' 条，daemon ' + daemonLines.length + ' 条，域 A ' + domainALines.length + ' 条');
  check('GD-8 域 A 的 dsh 与 sandbox-instance 均无 derivePhase（desired 不参与其相位）',
    daemonLines.every((l) => /derivePhase\s*:\s*true/.test(l)) && !domainALines.some((l) => /derivePhase/.test(l)),
    domainALines.map((l) => l.trim().slice(0, 46)).join(' | '));
  const instCode = stripComments(read('src/domains/instance/lifecycle.js'));
  check('GD-8 沙箱生命周期不触碰意图字段、也不读目录 desired（只认 guardian）',
    !/\be\.desired\b|entry\.desired|managedObjects\(\)/.test(instCode)
      && !/\bdesired\b/.test(instCode),
    'desired token=' + (instCode.match(/\bdesired\b/g) || []).length
      + ' 目录读取=' + (/entry\.desired|e\.desired/.test(instCode) ? '有' : '无'));
  const guardianCode = stripComments(read('src/shared/guardian.js'));
  check('GD-8 沙箱自动拉起闸门只看 guardian 旗标，与 desired 无关',
    /inst\.guardian\s*===\s*true/.test(guardianCode) && !/\bdesired\b/.test(guardianCode), 'ok');

  const noLandingOf = (tbl) => Object.keys(tbl).filter((k) => tbl[k].source === 'derived' && !tbl[k].reader);
  const violatingOf = (tbl) => Object.keys(tbl).filter((k) => tbl[k].source === 'derived' && tbl[k].reader);
  const landingGapsOf = (tbl) => Object.keys(tbl).filter((k) => tbl[k].source !== 'derived' && !tbl[k].reader);
  check('GD-8 无落点缺陷面必须为空（每类申报 desired 都须有意图或配置来源）',
    noLandingOf(SOURCES).length === 0, noLandingOf(SOURCES).join(',') || 'ok');
  check('GD-8 「有落点、无决策消费者」面已清零（B2-1 摘掉沙箱申报后不允许任何申报落空）',
    landingGapsOf(SOURCES).length === 0, landingGapsOf(SOURCES).join(',') || '无');
  check('GD-8 不存在「派生 desired 驱动决策」的违例（M-1 硬失败）',
    violatingOf(SOURCES).length === 0, violatingOf(SOURCES).join(',') || 'ok');
  // 反向：三档分类判据都必须有分辨力；reader 判定的对照样本取自真实源码（有心跳命中、无沙箱命中）。
  check('GD-8 反向：派生源一旦有人读即命中违例集合',
    violatingOf({ x: { source: 'derived', reader: true } }).length === 1
      && noLandingOf({ x: { source: 'derived', reader: true } }).length === 0, 'hit');
  check('GD-8 反向：派生源无人读命中无落点缺陷面',
    noLandingOf({ x: { source: 'derived', reader: false } }).length === 1, 'hit');
  check('GD-8 反向：申报源若缺决策读者会被 GAP 面检出（沙箱申报线回潮即命中此档）',
    landingGapsOf({ x: { source: 'intent', reader: false } }).length === 1
      && landingGapsOf({ x: { source: 'intent', reader: true } }).length === 0, 'hit');
  const declaresDesired = (body) => /\bdesired\s*:/.test(body);
  const OLD_SANDBOX_INTENT = "function sandboxSpec(inst) {\n    return { kind: 'sandbox-instance', desired: (inst.state && inst.state.desired === 'stopped') ? 'stopped' : 'running',\n      guardian: inst.guardian === true };\n  }";
  const OLD_SANDBOX_DERIVED = "function sandboxSpec(inst) {\n    const running = inst.state.phase === 'RUNNING'; return { kind: 'sandbox-instance', desired: running ? 'running' : 'stopped',\n      guardian: inst.guardian === true };\n  }";
  check('GD-8 反向：申报体判据对旧意图投影/相位推导两形态都命中，对现行体不命中（非空转）',
    declaresDesired(OLD_SANDBOX_INTENT) && declaresDesired(OLD_SANDBOX_DERIVED) && !declaresDesired(specBody), 'hit');
}

// ---------------------------------------------------------------------------
// ML-2 / ML-3 应然写权 ratchet
//
// 判据对象：守卫核心层（src/app/**，**排除 src/app/control/**）里对 ManagedLifecycle 内部字段
//   的直写与 _setPhase() 直调。control/ 是驱动与观测合成的合法落点（角色表），
//   src/domains/** 是域自治对象改自己的状态机（要求的形态），两者都不在本门禁范围内。
// 执法形态：**只减不增的基线**（新增违规文件 / 在已登记文件里加写 -> 判红；
//   收敛一处后把基线调小，防止"改了但没登记"造成静默回潮）。
// ---------------------------------------------------------------------------
{
  const LIFECYCLE_WRITE_RE = /\.\s*(?:_monitoring|desired|healthy|phase)\s*=(?!=)|_setPhase\s*\(/g;
  // 登记基线：rel -> { n: 处数上限, legal: 是否为 承认的合法出口 }
  const BASELINE = {
    'src/app/domain-actions/router.js': { n: 10, legal: false },
    'src/app/assembly/bootstrap.js': { n: 9, legal: false },
    'src/app/session/shutdown.js': { n: 2, legal: false },
    'src/app/daemons/supervise.js': { n: 1, legal: false },
    'src/app/state/fields.js': { n: 2, legal: true }, // 守卫内 main 域 phase/desired 唯一写口的兜底分支
  };
  /** 对一份（已去注释的）源码计数违规写入。 */
  const countLifecycleWrites = (src) => {
    let n = 0;
    for (const line of src.split(String.fromCharCode(10))) { LIFECYCLE_WRITE_RE.lastIndex = 0; const m = line.match(LIFECYCLE_WRITE_RE); if (m) n += m.length; }
    return n;
  };
  const appDir = path.join(ROOT, 'src', 'app');
  const scanned = walkSrc(appDir, [])
    .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('src/app/control/'));
  const found = {};
  for (const rel of scanned) {
    const n = countLifecycleWrites(stripComments(read(rel)));
    if (n) found[rel] = n;
  }
  const unknown = Object.keys(found).filter((f) => !BASELINE[f]);
  check('ML-2 判据覆盖面非空（扫描 src/app 排除 control/ 的文件数）', scanned.length > 20,
    '扫描 ' + scanned.length + ' 个文件，命中 ' + Object.keys(found).length + ' 个');
  check('ML-2 不新增违规文件（违例文件集合 ⊆ 契约 §6.3 登记集合）',
    unknown.length === 0,
    unknown.length ? '未登记直写者: ' + unknown.map((f) => f + '(' + found[f] + ')').join(', ') : Object.keys(found).sort().join(', '));
  const grew = Object.keys(found).filter((f) => BASELINE[f] && found[f] > BASELINE[f].n);
  check('ML-2 已登记文件处数只减不增（每文件 ≤ 基线）',
    grew.length === 0,
    grew.length ? grew.map((f) => f + ' ' + found[f] + '>' + BASELINE[f].n).join('; ')
      : Object.keys(BASELINE).map((f) => f.split('/').pop() + '=' + (found[f] || 0) + '/' + BASELINE[f].n).join(' '));
  // ML-3 反向：判据对合成的旧违例源码确实计数 > 0（否则上面两条是空转的正则）
  const SYNTH_OLD = "const lc = mgr.get('router');\nlc.desired = 'stopped';\nlc._monitoring = false;\nlc._setPhase('stopped');\nlc.healthy = false;\n";
  const synthN = countLifecycleWrites(SYNTH_OLD);
  check('ML-3 反向：判据对「动作层直写生命周期视图」旧形态计数 > 0（门禁非空转）',
    synthN === 4, '计数=' + synthN + '（期望 4）');
  check('ML-3 反向：判据不误报合法形态（经 manager 发指令 / 只读比较）',
    countLifecycleWrites("const lc = mgr.get('router');\nif (lc.desired === 'running' && lc.phase !== 'running') lc = null;\n") === 0,
    'ok');
}

// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
