#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 供应商网关架构门禁（PROVIDER-GATEWAY-ARCHITECTURE）
//
// ## 锁定的设计决策
//   PG-1 两类 pattern 的抽象方法必须显式声明（构造期可校验）
//   PG-2 转发层不得用 `typeof === 'function'` 猜测能力（应为 supports()）
//   PG-3 实例态只用 COLD/WARM/HOT/DEAD 四态
//   PG-4 生命周期引擎：槽位预算（在用1+预热1）+ 请求路径走引擎门面 + 状态事件表
//   PG-5 ctl 只能调用白名单内方法（内部方法不可达）
//   PG-6 凭证只经 env 注入，绝不进 spawn 命令行
//   PG-7 写权：所有落盘经统一写权闸
//   PG-8 反向：判据能识别旧形态（门禁非空转）
//   PG-9 daemon 入口必须有 require.main 守卫（require 不得拉起 daemon）
//   PG-11 router 域 kind 字面量比较收敛于 B 类白名单（能力判据一律 supports()）
//   PG-12 用量账本读写实现唯一（仅 store/usage.js）；只读实例每次新鲜读盘
//
// ## 为什么有本门禁
//   本域从未被真正设计过（13 文件同日随初始提交搬入），累积了大量
//   「隐式契约 + 无白名单 + 双事实源」。本文档类规范都配机器校验（一域一规范），
//   本门禁即该设计的可执行部分。
//
//  PG 判据回潮即如实报 FAIL，不掩盖（收口过程与历史现状在 git log，不在此写时点）。
//   设计阶段推进状态见 PROVIDER-GATEWAY-ARCHITECTURE.md（RouterService 改名尚未执行）。
//   PG-8 与各处反向自检保证每条判据能命中旧形态样本（防空转）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
};
/** 去注释（行注释 + 块注释）——避免"注释提及"被误判为"代码存在"。
 *  实现 = test/_strip.js 的**字符级词法**（唯一实现）。原为两条正则链：阶段五已改对顺序，但正则仍
 *  区分不了「真注释」与「字符串/正则字面量里的同形字符」—— baseSrc 的计数判据会被字符串里的 glob
 *  吞掉区间而**失明**（实测原实现下 base.js 6–36 行不可见）。词法实现消除该类。 */
const { stripComments } = require('./_strip');
// 自检（合成样本，硬判据）：四条必须同时成立。
{
  const LF9 = String.fromCharCode(10);
  const ST = String.fromCharCode(42);
  const GLOB = 'src/' + ST + ST;
  const kept = stripComments('// 见 ' + GLOB + LF9 + 'const KEEP_MARKER_9f3 = 1;').indexOf('KEEP_MARKER_9f3') >= 0;
  // 编号取 PG-10：PG-9 已被「入口 require.main 守卫」判据占用（HEAD 既有），避免标签重复。
  check('PG-10 ① 行注释里的 glob 不吞后续代码', kept, kept ? 'ok' : '被吞（假阴性）');
  const gone = stripComments('/* SECRET_9f3 */ const Y = 1;').indexOf('SECRET_9f3') < 0;
  check('PG-10 ② 反向：真块注释仍被剥离', gone, gone ? 'ok' : '漏剥');
  const strKept = stripComments("const S = '" + GLOB + "';" + LF9 + 'const STR_MARKER_9f3 = 1;').indexOf('STR_MARKER_9f3') >= 0;
  check('PG-10 ③ 字符串字面量里的 glob 不吞代码（本轮根除目标）', strKept, strKept ? 'ok' : '被吞（假阴性）');
  const reKept = stripComments('const RE = /a[b/]c/;' + LF9 + 'const RE_MARKER_9f3 = 1;').indexOf('RE_MARKER_9f3') >= 0;
  check('PG-10 ④ 正则字面量不被误当注释', reKept, reKept ? 'ok' : '被吞');
}

const PROXY = 'src/domains/router/providers/proxy.js';
const DIRECT = 'src/domains/router/providers/direct.js';
const FORWARD = 'src/domains/router/forward-core.js';
// 步骤4：通用 dispatcher 上移 L0；白名单随域迁到两个 daemon（按域注入）。
const CTL = 'src/platform/ctl/server.js';
const ROUTER_DAEMON = 'src/domains/router/daemon.js';
const RELAY_DAEMON = 'src/domains/relay/daemon.js';
const APPS = 'src/domains/router/proxy-apps.js';
const IDX = 'src/domains/router/index.js';

const proxySrc = read(PROXY);
const directSrc = read(DIRECT);
//  providers 已按功能切分（base/model/policies/store/command/pool/restart/probe）——
//   本组判据（PG-6 凭证剔除 / PG-4 资源闸与预算）必须读**整组**，否则文件一搬即静默假绿。
const providerSrc = proxySrc + String.fromCharCode(10) + read('src/domains/router/providers/process-pool.js') + String.fromCharCode(10) + read('src/domains/router/providers/command.js') + String.fromCharCode(10) + read('src/domains/router/providers/pool.js') + String.fromCharCode(10) + read('src/domains/router/providers/probe.js') + String.fromCharCode(10) + read('src/domains/router/providers/restart.js') + String.fromCharCode(10) + read('src/domains/router/providers/base.js') + String.fromCharCode(10) + read('src/domains/router/providers/model.js');
//  转发 IO 已拆到 handlers/forward.js（SSOT：forward-core.js 收敛为门面）——
//   本组判据（PG-2 能力猜测 / PG-4 双预算使用）必须读**整组**，否则文件一搬即静默假绿。
const forwardSrc = read(FORWARD) + String.fromCharCode(10) + read('src/domains/router/handlers/forward.js');
const ctlSrc = read(CTL);
const appsSrc = read(APPS);
const idxSrc = read(IDX);

// ---------------------------------------------------------------------------
// PG-6 凭证只经 env 注入，绝不进 spawn 命令行（当前已成立，先锁住防回退）
// ---------------------------------------------------------------------------
{
  // proxy-apps 的命令模板里可以有 {{key}} 占位；但 provider 启动时必须把它剔除。
  const code = stripComments(providerSrc);
  // 判据：确实存在"剔除 --api-key 与 {{key}}"的逻辑（见 proxy.js:114）。
  //    必须匹配【剔除动作】，不能只匹配字符串出现——否则判据形同虚设。
  const stripsKey = /--api-key/.test(code) && /\{\{key\}\}/.test(code)
    && /(?:filter|replace|indexOf|includes)[^;]{0,120}(?:--api-key|\{\{key\}\})/.test(code);
  check('PG-6 反代启动命令**剔除** --api-key / {{key}} 占位（key 只经 env）',
    stripsKey,
    stripsKey ? 'ok（找到剔除动作）' : '未找到剔除逻辑（key 可能进 cmdline！）');
  // 反向：判据能识别"只在模板里出现占位但启动时未剔除"的旧形态
  const OLD_NO_STRIP = "const cmd = app.command.slice(); cmd[cmd.length-1] = key;";
  check('PG-8 反向：PG-6 判据能识别"未剔除占位"的形态',
    !/(?:filter|replace|indexOf|includes)[^;]{0,120}(?:--api-key|\{\{key\}\})/.test(OLD_NO_STRIP), 'hit');
  check('PG-6 凭证经 env 名注入（app.keyEnv 声明）',
    /keyEnv/.test(appsSrc) && /keyEnv/.test(code),
    /keyEnv/.test(appsSrc) ? 'ok（keyEnv 经 env 传递）' : 'proxy-apps 未声明 keyEnv');
  // 反向：命令模板中不得直接把 key 明文拼进参数（占位符之外）
  const cmdLine = (appsSrc.match(/command:\s*\[[^\]]*\]/) || [''])[0];
  check('PG-6 命令模板只用 {{key}} 占位（无明文 key 拼接）',
    cmdLine.includes('{{key}}') || !/command:/.test(appsSrc),
    cmdLine.slice(0, 80));
}

// ---------------------------------------------------------------------------
// PG-1 抽象方法显式声明（Phase 2 目标）
// ---------------------------------------------------------------------------
{
  const baseSrc = read('src/domains/router/providers/base.js');
  const ppSrc = read('src/domains/router/providers/process-pool.js');
  // 设计更新（判据统一阶段3）：process-pool 契约的显式声明**迁出基座、落在能力方 mixin**——
  //   基座携带实现不了的抛错占位会诱导调用方退回 typeof 猜测；契约面与实现面同文件收口。
  // 判据仍是"达到设计要求的数量"：detectAccount 基座抛错 1 个 + process-pool 契约 12 个在 mixin 定义。
  //   markUsed 已随闲置宽限废止；生命周期引擎门面（ensureServable/reclaimAccount）入列（W1）。
  const baseThrows = (stripComments(baseSrc).match(/must be implemented by subclass/g) || []).length;
  const POOL_CONTRACT = ['startInstance', 'stopInstance', 'restartInstance', '_waitHealthy', 'instanceOf',
    'ensureServable', 'reclaimAccount', 'markRequestOk', 'markInstanceNetFail', '_retryPendingStop', 'flushRestartPending', 'reconcileInstances'];
  const ppDefs = POOL_CONTRACT.filter((n) => new RegExp('^\\s*(?:async\\s+)?' + n + '\\s*\\(', 'm').test(stripComments(ppSrc)));
  check('PG-1 契约显式声明：基座 detectAccount + mixin 的 12 个 process-pool 能力方法',
    baseThrows >= 1 && ppDefs.length === POOL_CONTRACT.length,
    'base=' + baseThrows + ' mixin=' + ppDefs.length + '/' + POOL_CONTRACT.length);
  // 能力声明 supports() 必须存在（两类 pattern 的差异靠它表达）
  //  能力声明随 process-pool mixin 走（判据统一阶段 3）——按整组读，文件一搬判据不失覆盖面。
  const proxySrc2 = read('src/domains/router/providers/proxy.js') + String.fromCharCode(10)
    + read('src/domains/router/providers/process-pool.js');
  const directSrc2 = read('src/domains/router/providers/direct.js');
  check('PG-1 两类 provider 均声明 supports()（能力可静态校验）',
    /supports\s*\(/.test(stripComments(proxySrc2)) && /supports\s*\(/.test(stripComments(directSrc2)),
    'proxy=' + /supports\s*\(/.test(proxySrc2) + ' direct=' + /supports\s*\(/.test(directSrc2));
  // 反向：判据能识别"未声明"的旧形态
  check('PG-8 反向：抽象方法判据能识别只声明 1 个的旧形态',
    (stripComments('throw new Error("must be implemented by subclass")').match(/must be implemented by subclass/g) || []).length === 1, 'hit');
}

// ---------------------------------------------------------------------------
// PG-2 转发层不得用 typeof 猜测能力（Phase 2/3 目标）
// ---------------------------------------------------------------------------
{
  const code = stripComments(forwardSrc);
  //  判据只针对 **provider 能力猜测**（typeof prov/activeProv/rt.prov === 'function'）——
  //   Node 内建/平台方法的探测（res.flushHeaders / clientRes.once / this.canPersist）
  //   是合法的兼容写法，不属于"契约靠猜测"。
  const guesses = (code.match(/typeof\s+(?:rt\.prov|activeProv|prov|this\.prov)[\w.]*\s*===\s*'function'/g) || []);
  check('PG-2 转发层无 provider 能力 typeof 猜测（应为 supports()）',
    guesses.length === 0,
    guesses.length ? '仍有 ' + guesses.length + ' 处能力猜测: ' + guesses.slice(0, 3).join(', ') : 'ok（仅剩平台内建探测）');
  // 反向：判据能识别"能力猜测"旧形态
  const OLD_GUESS = "if (typeof activeProv.restartInstance === 'function') activeProv.restartInstance(inst);";
  check('PG-8 反向：PG-2 判据能识别 typeof 能力猜测旧形态',
    (OLD_GUESS.match(/typeof\s+(?:rt\.prov|activeProv|prov|this\.prov)[\w.]*\s*===\s*'function'/g) || []).length === 1, 'hit');
}

// ---------------------------------------------------------------------------
// PG-3 实例态四态（Phase 4 目标）
// ---------------------------------------------------------------------------
{
  //  实例模型已上移 router/model.js（instances/proxy-instance.js 降为 1 行过渡 shim）
  const code = stripComments(proxySrc) + stripComments(read('src/domains/router/model.js'));
  const hasNew = /COLD|WARM|HOT|DEAD/.test(code);
  check('PG-3 [Phase4] 实例态使用 COLD/WARM/HOT/DEAD 四态',
    hasNew,
    hasNew ? 'ok' : '仍用旧 6 态（registered/starting/running/unhealthy/stopped/failed）');
}

// ---------------------------------------------------------------------------
// PG-4 生命周期引擎（W1）：槽位预算常量 + 请求路径走引擎门面 + 状态事件表
//   旧的 maxHot/maxWarm 假配置面与 80%-备胎/双预算切换语义随 PROXY-LIFECYCLE-STANDARD 废止。
// ---------------------------------------------------------------------------
{
  const poolOnly = stripComments(read('src/domains/router/providers/pool.js'));
  const restartOnly = stripComments(read('src/domains/router/providers/restart.js'));
  const freezeOnly = stripComments(read('src/domains/router/providers/policies/freeze.js'));
  const code = stripComments(providerSrc);
  // 资源闸：期望集槽位常量必须存在**且被 computeDesired 引用**（不能只是定义了不用）。
  const hasCaps = /ACTIVE_SLOTS\s*=\s*1/.test(poolOnly) && /PREWARM_SLOTS\s*=\s*1/.test(poolOnly);
  const computeBody = (poolOnly.match(/function computeDesired[\s\S]*?\n\}/) || [''])[0];
  const usedInGate = /ACTIVE_SLOTS/.test(computeBody) && /PREWARM_SLOTS/.test(computeBody);
  // 假配置面（proxyInstanceLimits / DEFAULT_MAX_HOT / DEFAULT_MAX_WARM / needSpare）零残留。
  const fakeGone = !/proxyInstanceLimits|DEFAULT_MAX_HOT|DEFAULT_MAX_WARM|needSpare/.test(code);
  check('PG-4 槽位预算（在用1+预热1）定义于 pool.js 且被 computeDesired 引用，假配置面零残留',
    hasCaps && usedInGate && fakeGone,
    '常量=' + hasCaps + ' computeDesired引用=' + usedInGate + ' 假配置面残留=' + !fakeGone);
  // 请求路径经引擎门面：forward 只调 ensureServable，不得再裸编排 startInstance/prewarmAsync。
  const fwd = stripComments(forwardSrc);
  const usesFacade = /ensureServable\(/.test(fwd);
  const noRawOrchestration = !/\.startInstance\(/.test(fwd) && !/prewarmAsync/.test(fwd);
  check('PG-4 请求路径走引擎门面 ensureServable（裸 startInstance / prewarmAsync 零残留）',
    usesFacade && noRawOrchestration,
    '门面=' + usesFacade + ' 裸编排残留=' + !noRawOrchestration);
  // 反向：判据能识别 W1 前"转发层裸编排启动"的旧形态
  const OLD_RAW = "const sr = await prov.startInstance(inst); await prov._waitHealthy(inst); prov.prewarmAsync(acc);";
  check('PG-8 反向：PG-4 门面判据能识别裸编排旧形态',
    /\.startInstance\(/.test(OLD_RAW) && /prewarmAsync/.test(OLD_RAW), 'hit');
  // 事件表落地：冻结/封禁/删除即时回收 + 恢复回池（freeze 钩子），等待区端口随回收释放（restart）。
  const hasHook = /_onStatusTransition\s*\(/.test(freezeOnly) && /_onStatusTransition\(acc/.test(freezeOnly);
  const hasPrewarmReclaim = /reclaimAccount/.test(code) && /_prewarmKeyId/.test(code);
  const portReleaseInReconcile = /ports\.unregister\(/.test(restartOnly);
  check('PG-4 状态事件表：冻结即时回收（_onStatusTransition）+ 期望集消费与端口释放（reconcile）',
    hasHook && hasPrewarmReclaim && portReleaseInReconcile,
    '钩子=' + hasHook + ' 回收门面=' + hasPrewarmReclaim + ' reconcile端口释放=' + portReleaseInReconcile);
}

// ---------------------------------------------------------------------------
// PG-5 ctl 白名单（Phase 2 目标）—— 安全面
// ---------------------------------------------------------------------------
{
  const code = stripComments(ctlSrc);
  const routerDaemonSrc = stripComments(read(ROUTER_DAEMON));
  const relayDaemonSrc = stripComments(read(RELAY_DAEMON));
  //  判据必须看**实际调用形态**：调用前有白名单闸，且两个 daemon 各自注入本域的表。
  //   不能用"字符串里是否出现 target[method].apply"——注释里也会出现（stripComments 已去，
  //   但为稳妥仍需断言"调用被闸保护"这一正向事实）。
  // 步骤4 后通用 dispatcher 不再持有任何域的表：白名单随域迁到 daemon。
  const hasAllowlist = /isMethodAllowed\s*\(/.test(code);
  const gated = /isMethodAllowed\(allowMethods,\s*method\)/.test(code);
  // 闸是 fail-closed：白名单缺省直接抛错，绝不回退到"放行全部/借用他域表"。
  const failClosed = /!Array\.isArray\(allowMethods\)[\s\S]{0,80}throw new Error/.test(code);
  // 两个 daemon 各自声明并注入**本域**白名单（router / lan 互不串用）。
  const routerInjects = /ROUTER_CTL_METHODS/.test(routerDaemonSrc)
    && /allowMethods:\s*ROUTER_CTL_METHODS/.test(routerDaemonSrc);
  const lanInjects = /LAN_CTL_METHODS/.test(relayDaemonSrc)
    && /allowMethods:\s*LAN_CTL_METHODS/.test(relayDaemonSrc);
  // 通用层不得残留域知识：白名单表已不在 platform（步骤4 前它含 'addProxyKey' 等 router 方法名）。
  const noDomainKnowledge = !/'addProxyKey'|'setFrp'|'listProviders'/.test(code);
  check('PG-5 ctl 白名单按域注入（router/lan 各持自己的表）+ 调用前 isMethodAllowed 闸 + fail-closed',
    hasAllowlist && gated && failClosed && routerInjects && lanInjects && noDomainKnowledge,
    'dispatcher闸=' + (hasAllowlist && gated) + ' failClosed=' + failClosed
      + ' router注入=' + routerInjects + ' lan注入=' + lanInjects + ' 通用层无域知识=' + noDomainKnowledge);
  // 反向：判据能识别"无白名单的反射调用"旧形态
  const OLD_REFLECT2 = "if (!method || !router || typeof router[method] !== 'function') return send(404);\nrouter[method].apply(router, args);";
  check('PG-8 反向：PG-5 判据能识别反射式旧形态',
    !/isMethodAllowed\s*\(/.test(OLD_REFLECT2)
    && !/allowMethods:\s*ROUTER_CTL_METHODS|allowMethods:\s*LAN_CTL_METHODS/.test(OLD_REFLECT2), 'hit');
}

// ---------------------------------------------------------------------------
// PG-7 写权统一闸（Phase 2 目标）
// ---------------------------------------------------------------------------
{
  //  域改造后用量落盘从 forward-core.js 收敛进 store/usage.js（SSOT 缺陷 2）。
  //   继续按 _writeTotals() 的函数体正则抓取，方法一改名/搬文件即静默抓空。
  //   判据改为「用量落盘模块（旧家 + 新家）内含落盘且经统一写权闸」这一**结构不变量**。
  const usageSrc = stripComments([
    'src/domains/router/store/usage.js',
    'src/domains/router/forward-core.js',
  ].map((f) => read(f)).join('\n'));
  // 落盘从各点自拼 `fs.writeFileSync(tmp,…)` 收敛进
  // platform/util/fs 的 writeAtomic —— 只认 writeFileSync 会让本判据静默抓空。
  // 不变量本身不变：**用量落盘必须先过 canPersist()**。落盘手段两式皆可（单源或直接写）。
  const gated = /canPersist\(\)|_canPersist\s*\(\s*\)/.test(usageSrc)
    && /writeAtomic|writeFileSync/.test(usageSrc);
  check('PG-7 用量落盘经统一写权闸 canPersist()',
    gated,
    gated ? 'ok' : '用量落盘未过闸（"守卫只读"仅成立于 providers.json）');
  // 反向：判据能识别"未过闸"的旧形态（样本里没有 canPersist）
  const OLD_WRITE = '_writeTotals() {\n    try {\n      const t = this.totals;\n      if (!t) return;\n      fs.writeFileSync(f, JSON.stringify(t));\n    } catch {}\n  }';
  check('PG-8 反向：写闸判据能识别未过闸形态',
    !/canPersist\(\)/.test(stripComments(OLD_WRITE)), 'hit');
}

// ---------------------------------------------------------------------------
// PG-9 daemon 入口守卫（安全面）——require 不得启动真实 daemon
//
// 背景：daemon.js 此前裸调 `main()`，导致 require（测试/工具/静态分析）会**立即启动
//   真实 daemon**（连真实 npm、拉起真实实例）。本仓实测发生过一次误启生产 daemon。
//   标准写法是 `if (require.main === module) main();` —— 直接运行才启动，require 为纯导入。
// ---------------------------------------------------------------------------
{
  for (const rel of ['src/domains/router/daemon.js', 'src/domains/relay/daemon.js']) {
    const code = stripComments(read(rel));
    const guarded = /require\.main\s*===\s*module/.test(code);
    const bareCall = /^\s*main\(\);\s*$/m.test(code);
    check('PG-9 ' + rel + ' 入口有 require.main 守卫（require 不得启动 daemon）',
      guarded && !bareCall,
      (guarded ? '有守卫' : '无守卫') + ' / ' + (bareCall ? '仍有裸 main()' : '无裸调用'));
  }
  // 反向：判据能识别"裸 main()"旧形态
  check('PG-8 反向：PG-9 判据能识别裸 main() 旧形态',
    /^\s*main\(\);\s*$/m.test('\nmain();\n') && !/require\.main/.test('\nmain();\n'), 'hit');
}

// ---------------------------------------------------------------------------
// PG-8 反向：判据能识别旧形态（门禁非空转）
// ---------------------------------------------------------------------------
{
  const OLD_REFLECT = 'return send(200, { ok: true, value: router[method].apply(router, args) });';
  const OLD_TYPEOF = "if (typeof prov.startInstance === 'function') prov.startInstance(inst);";
  check('PG-8 反向：反射式 ctl 判据有效', /router\[method\]\.apply/.test(stripComments(OLD_REFLECT)), 'hit');
  check('PG-8 反向：typeof 猜测判据有效',
    (stripComments(OLD_TYPEOF).match(/typeof\s+[\w.]+\s*===\s*'function'/g) || []).length === 1, 'hit');
  const OLD_TOTALS = '_writeTotals() {\n    try {\n      const t = this.totals;\n      fs.writeFileSync(file, JSON.stringify(t));\n    } catch {}\n  }';
  const m = /_writeTotals\s*\(\s*\)\s*\{([\s\S]*?)\n  \}/.exec(OLD_TOTALS);
  check('PG-8 反向：写闸判据能识别未过闸形态',
    !!m && !/_persistEnabled|_canPersist|writeGate/.test(m[1]), 'hit');
}

// ---------------------------------------------------------------------------
// PG-11 判据统一（方向 3）防回潮：router 域能力判据不得退回 kind 字面量分支。
//   运行时「能不能做 X」一律 supports(cap)（PG-2 锁 typeof 猜测，本条锁 kind 分支）。
//   B 类保留场景 = 持久化字段 / 视图行渲染 / 同类注册表鉴别 / 无原型裸 JSON 记录，
//   按文件精确配额登记；新增文件或配额增减不匹配都红（配额精确=逼同步，防沉淀）。
// ---------------------------------------------------------------------------
{
  const CLASS_B_BUDGET = {
    'src/domains/router/store.js': 2,             // 序列化/反序列化持久化 kind 字段
    'src/domains/router/views.js': 1,             // 视图行按身份渲染反代字段
    'src/domains/router/ops.js': 3,               // 注册表 CRUD 查找的同类鉴别条件
    'src/domains/router/ports-bootstrap.js': 1,   // 裸 providers.json 记录（无原型，supports 不可用）
  };
  const KIND_CMP = /kind\s*[!=]==\s*['"](proxy|direct)['"]/g;
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(ROOT, 'src/domains/router'));
  const hits = {};
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const n = (stripComments(fs.readFileSync(f, 'utf8')).match(KIND_CMP) || []).length;
    if (n) hits[rel] = n;
  }
  const viol = [];
  for (const [rel, n] of Object.entries(hits)) {
    if (CLASS_B_BUDGET[rel] === undefined) viol.push(rel + '=' + n + ' 未登记');
    else if (n !== CLASS_B_BUDGET[rel]) viol.push(rel + '=' + n + '≠配额' + CLASS_B_BUDGET[rel]);
  }
  const total = Object.values(hits).reduce((a, b) => a + b, 0);
  check('PG-11 kind 字面量比较收敛于 B 类白名单（逐文件精确配额）',
    viol.length === 0, viol.length ? viol.join(', ') : total + ' 处均在配额内');
  // 反向（防空转）：A 类旧形态必须命中；supports 形态与异名 kind（limit.kind 等）不误伤。
  check('PG-11 反向：旧形态 kind 分支命中',
    (stripComments("if (p.kind === 'proxy') { this.startInstance(i); }").match(KIND_CMP) || []).length === 1, 'hit');
  check('PG-11 反向：supports 形态不命中',
    !KIND_CMP.test("if (p.supports('instanceLifecycle')) { p.startInstance(i); }"), 'miss');
  check('PG-11 反向：异名 kind（额度限流种类）不误伤',
    !/kind\s*[!=]==\s*['"](proxy|direct)['"]/.test("if (acc.limit.kind === 'rpm') {}"), 'miss');
}

// ---------------------------------------------------------------------------
// PG-12 用量账本读写实现唯一（防第二读写口回潮）。
//   router-usage-totals.json 的持有者只能有 store/usage.js 一处：旧形态是 store.js 自带
//   readUsage/writeUsage 第二口（与 UsageLedger 同文件双实现），且 views 走盘、getUsage 走
//   内存缓存，两面板鲜度不一致。收口后：写口唯一（PG-7 已过闸），读口唯一（UsageLedger.load），
//   并锁死鲜度纪律——写者以内存为准（节流落后），只读实例必须每次读盘（缓存即冻结旧账）。
//   接线面豁免：usageTotalsFile（deps 键名）只是路径传递，不触碰文件 IO，与本判据的
//   /usageFile/ 不冲突（大小写敏感：usageTotalsFile 与 usageFile 不是同一键）。
// ---------------------------------------------------------------------------
{
  const LEDGER = 'src/domains/router/store/usage.js';
  const SECOND_PORT = /usageFile|readUsage\s*\(|writeUsage\s*\(|_writeTotals\s*\(/;
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) files.push(f);
    }
  })(path.join(ROOT, 'src/domains/router'));
  const viol = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === LEDGER) continue;
    if (SECOND_PORT.test(stripComments(fs.readFileSync(f, 'utf8')))) viol.push(rel);
  }
  check('PG-12 账本读写实现唯一（router 域除 store/usage.js 外无第二 usage 读写口）',
    viol.length === 0, viol.length ? '第二口: ' + viol.join(', ') : '唯一实现 ' + LEDGER);
  // 鲜度纪律：UsageLedger.load 的缓存命中必须以「本实例是写者」为条件（只读必落回读盘）。
  const ledgerCode = stripComments(read(LEDGER));
  check('PG-12 只读实例不得吃永久缓存（load 缓存命中以 canPersist 为条件）',
    /if\s*\(\s*this\.totals\s*&&\s*this\._canPersist\(\)\s*\)\s*return\s+this\.totals/.test(ledgerCode),
    'ok');
  // 反向（防空转）：旧 store.js 第二口样本必须命中；usageTotalsFile 接线不误伤。
  check('PG-12 反向：旧第二读写口命中',
    SECOND_PORT.test(stripComments('this.usageFile = f; readUsage() { return 1; } writeUsage(t) { return 2; }')), 'hit');
  check('PG-12 反向：usageTotalsFile 路径接线不误伤',
    !SECOND_PORT.test(stripComments("opts.usageTotalsFile; this.usageTotalsFile = x")), 'miss');
}

// ---------------------------------------------------------------------------
console.log('\n结果: ' + (results.length - results.filter((x) => !x).length) + ' passed, ' + results.filter((x) => !x).length + ' failed');
process.exit(results.every((x) => x) ? 0 : 1);
