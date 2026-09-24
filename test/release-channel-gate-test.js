#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 发布通道门禁（内核侧）—— SSOT: RELEASE-CHANNEL-CONTRACT.md
//
// ## 断言
//   RC-G3 内核选版「优先读 latest」（结构断言 + 行为断言）
//         - 结构：取版本链的三个决定点（fetchNpmLatest / versionFromOrigin / pickReleaseVersion）
//                 逐个取函数体判定：委托链完整、latest 读点在选版算法体内、体内无「dist-tags 全部值
//                 并 versions 全部键」取最高；只有「不得出现在任何一处」的负判据走整目录聚合
//         - 行为：假 registry 上 latest=0.1.6-RC.1 而 versions 另有数字更高的
//                 0.2.0-BETA.1 —— 契约第 3 节第 3 步要求返回 latest（通道控制）
//   RC-G4 发布脚本 release/scripts/publish-core.sh 的标签策略（RC-6）
//         - 档位别名：BETA -> '--tag beta'，RC -> '--tag latest' + 发布后补打 rc
//         - latest 回补：两档都在发布后按 semverCompare 只升不降地对齐 latest；
//           真发布分支与幂等跳过分支都要走到；回补失败非零退出
//         - rollback / canary 不由发布脚本设置（人工运维，契约）
//   RC-G5 反向：判据能识别「仅取全量最高」的旧形态（门禁非空转）
//   RC-G8 权威查询的真相源边界：有官方源可问时只问官方源；只有镜像时退回镜像但 origin 留痕
//
// ## 覆盖面边界
//   本文件只静态判定发布脚本的**形态**（命令行、调用点、判据来源），不真触网（假 registry 本机起端口）。
//   「registry 上 latest 是否真的对齐」由发布日志与契约第 4 节的通道自检覆盖 ——
//   静态门禁抓不到「脚本对但某次人工把标签改回去」。
//   契约第 6 节的 RC-G1/G2 是壳侧断言：内核 CI 不检出壳仓（no-cross-repo X-2），
//   在本仓读 `../dsh-supervisor-launcher/...` 的交叉断言只会走「文件不存在当通过」那条分支，
//   故由壳仓 release_channel 的 step1..step5 单测执行，本文件不再挂空名。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const splitLines = (s) => s.split(String.fromCharCode(10));

/** 剥离 JS 注释（保留字符串字面量），避免注释里的示例文字参与结构判定。 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  const BT = String.fromCharCode(96);
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === BT) { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } else { out += ' '; } i++; continue; }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += (c === '\n') ? c : ' ';
      i++; continue;
    }
    if (c === '\\') { out += c + (n || ''); i += 2; continue; }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === BT)) state = 'code';
    out += c; i++;
  }
  return out;
}

/** 剥离整行注释（// 或 # 开头）——用于 Rust / shell 的结构判定。 */
function withoutCommentLines(src) {
  return splitLines(src).map((l) => (/^\s*(\/\/|#)/.test(l) ? '' : l)).join(String.fromCharCode(10));
}

// -- 判据（正/反共用；RC-G5 对它们做反向断言，证明门禁非空转）--

/** 「优先读 dist-tags.latest」形态判据（JS / Rust 通用）。 */
function readsLatestTag(src) {
  return /\btags\s*\.\s*latest\b/.test(src)
    || /\btags\s*\[\s*['"]latest['"]\s*\]/.test(src)
    || /get\(\s*['"]dist-tags['"]\s*\)[\s\S]{0,120}get\(\s*['"]latest['"]\s*\)/.test(src);
}

/** 「仅取全量最高」旧形态判据：dist-tags 的全部值 并 versions 的全部键后取最高。 */
function isUnionMax(src) {
  const jsUnion = /new Set\(\s*\[[\s\S]{0,160}\bversions\b/.test(src);
  const rustUnion = /get\(\s*['"]dist-tags['"]\s*\)/.test(src) && /get\(\s*['"]versions['"]\s*\)/.test(src);
  return jsUnion || rustUnion;
}

/** 旧「全量最高」算法的本地复现（仅用于 RC-G5 反向，不触碰生产代码）。 */
function legacyUnionMax(meta) {
  const tags = (meta && meta['dist-tags']) || {};
  const versions = Object.keys((meta && meta.versions) || {});
  const cands = Array.from(new Set([].concat(Object.values(tags), versions)));
  let best = null;
  for (const v of cands) if (!best || semverCompare(v, best) > 0) best = v;
  return best;
}

const DIST_DIR = 'src/platform/distribution';
const SCRIPT_REL = 'release/scripts/publish-core.sh';
/**  distribution 已拆分（release/policies/registry/install + index 门面），按目录聚合的读取面只用于
 *  「某种形态不得出现在任何一处」这类负判据；正向判据（读 latest、委托选版）钉在函数体上，
 *  因为聚合面上它们恒为真。 */
const readDist = () => fs.readdirSync(path.join(ROOT, DIST_DIR)).filter((f) => f.endsWith('.js')).sort()
  .map((f) => fs.readFileSync(path.join(ROOT, DIST_DIR, f), 'utf8')).join(String.fromCharCode(10));

/** 取顶层函数体（从声明到首个顶格 `}`）。结构断言用它把判据钉在决定点本身，
 *  而不是整个文件或整个目录 —— 聚合面上「读 latest」永远为真。定位不到返回 null（判红）。 */
function fnBody(src, decl) {
  const s = src.indexOf(decl);
  if (s < 0) return null;
  const e = src.indexOf('\n}', s);
  return e < 0 ? null : src.slice(s, e);
}

// fixture：契约 ) 与「全量最高」在**同一份元数据**上给出不同答案
const META_A = {
  name: '@dsh-sup/dsh-core-test-x64',
  'dist-tags': { latest: '0.1.6-RC.1', beta: '0.2.0-BETA.1' },
  versions: { '0.1.5-BETA.7': {}, '0.1.6-RC.1': {}, '0.2.0-BETA.1': {} },
};
const META_B = {
  name: '@dsh-sup/dsh-core-test-x64',
  'dist-tags': { latest: '1.0.0' },
  versions: { '1.0.0': {}, '9.9.9': {} },
};

const { DistributionManager, semverCompare } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));

/** 假 registry：只提供被测包元数据与 /-/ping，门禁不依赖真实网络。
 *  opts.prefix 把包挂到带路径前缀的基址下（用于造「同一台机器上既像官方源又像镜像」的两个候选）；
 *  opts.miss 让包路由恒 404（模拟「源在架但这个包没同步」）。 */
function startFakeRegistry(opts) {
  const o = opts || {};
  const state = { meta: META_A };
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(String(req.url || '').split('?')[0]);
    if (o.prefix && url.startsWith(o.prefix)) url = url.slice(o.prefix.length) || '/';
    if (url === '/-/ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (url === '/' + META_A.name && !o.miss) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.meta));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: 'http://127.0.0.1:' + server.address().port + (o.prefix || ''),
        set: (m) => { state.meta = m; },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function main() {
  // --- RC-G3 结构 ---
  console.log('== RC-G3 内核选版优先读 latest（结构）==');
  {
    // 判据必须落在真正做决定的函数体上。整目录聚合时，release.js 里合法的 tags.latest 读取
    // 会让「取版本口读 latest」恒真 —— 即使 fetchNpmLatest 换回全量最高也照样绿（判目录=空转）。
    const vc = stripJsComments(read(path.join(DIST_DIR, 'version-check.js')));
    const rel = stripJsComments(read(path.join(DIST_DIR, 'release.js')));
    const fetchBody = fnBody(vc, 'async function fetchNpmLatest(');
    const queryBody = fnBody(vc, 'async function versionFromOrigin(');
    const pickBody = fnBody(rel, 'function pickReleaseVersion(');
    const located = fetchBody !== null && queryBody !== null && pickBody !== null;
    check('RC-G3-a 三个决定点均可在指定文件内定位（取版本口/单源查询/选版算法）', located,
      'fetch:' + (fetchBody !== null) + ' query:' + (queryBody !== null) + ' pick:' + (pickBody !== null));
    // 取版本口自己不选版：委托链 fetchNpmLatest -> versionFromOrigin -> release.pickReleaseVersion。
    check('RC-G3-b 取版本口逐源委托 versionFromOrigin，后者委托唯一选版实现 pickReleaseVersion',
      located && /versionFromOrigin\(/.test(fetchBody) && /release\.pickReleaseVersion\(/.test(queryBody),
      '委托链' + (located ? ' ok' : ' 未定位'));
    check('RC-G3-c latest 优先的读点确实落在选版算法体内（tags.latest）',
      located && readsLatestTag(pickBody), 'ok');
    check('RC-G3-d 选版算法单点：pickReleaseVersion 在取版本链里只被调用一次且发生在单源查询内',
      located && (vc.match(/pickReleaseVersion/g) || []).length === 1
        && /release\.pickReleaseVersion\(/.test(queryBody)
        && (fetchBody.match(/semverCompare\(|pickReleaseVersion\(/g) || []).length === 0,
      'vc 内引用 ' + (vc.match(/pickReleaseVersion/g) || []).length + ' 处');
    check('RC-G3-e 决定链三处体内都无「dist-tags 并 versions 取最高」（旧形态不得回流）',
      located && !isUnionMax(fetchBody) && !isUnionMax(queryBody) && !isUnionMax(pickBody),
      located ? 'ok' : '未定位');
    const src = stripJsComments(readDist());
    check('RC-G3-f 全目录仍无并集取最高形态（聚合面只用于「不得存在任何一处」这一负判据）',
      !isUnionMax(src), isUnionMax(src) ? '检测到 dist-tags ∪ versions 取最高（旧形态）' : 'ok');
    const rc = read('src/platform/contract/registry.js');
    check('RC-G3-g 镜像契约 selected 不含版本字段（latest 只来自 registry 元数据）',
      !/dist-?tags/.test(rc), 'ok');
  }

  // --- RC-G4 发布脚本 ---
  console.log('== RC-G4 publish-core.sh：档位别名 + latest 回补（RC-6）==');
  {
    const sh = read(SCRIPT_REL);
    const ls = splitLines(sh);
    const rcLine = ls.find((l) => /^\s*\*-RC\.\*\)/.test(l));
    const betaLine = ls.find((l) => /^\s*\*-BETA\.\*\)/.test(l));
    check('RC-G4-a case 分支 -RC.* 存在', !!rcLine, rcLine ? rcLine.trim() : '未找到');
    check('RC-G4-b -BETA.* 发布挂 --tag beta（别名档位；latest 由回补步骤负责）',
      !!betaLine && /--tag\s+beta\b/.test(betaLine), betaLine ? betaLine.trim() : '未找到');
    check('RC-G4-c -RC.* 发布挂 --tag latest（RC-6：latest 跟随本次发布）',
      !!rcLine && /--tag\s+latest\b/.test(rcLine), rcLine ? rcLine.trim() : '未找到');
    check('RC-G4-d RC 分支不再以 rc 为主标签（不得 --tag rc）',
      !!rcLine && !/--tag\s+rc\b/.test(rcLine), 'ok');

    const code = withoutCommentLines(sh);
    const rcAddIdx = code.indexOf('dist-tag add "$PKG_NAME@$VER" rc');
    const pubIdx = code.indexOf('npm publish --access public');
    check('RC-G4-e rc 别名经 npm dist-tag add ... rc 在 publish 之后补打',
      rcAddIdx > 0 && pubIdx > 0 && rcAddIdx > pubIdx && /dist-tag add\s+"\$PKG_NAME@\$VER"\s+rc/.test(sh),
      'rc add@' + rcAddIdx + ' / publish@' + pubIdx);

    // -- RC-G4-i..n：latest 回补步骤（RC-6 的执行体）。钉的是命令行与调用点，不钉注释。--
    const fn = /reconcile_latest_tag\(\)\s*\{([\s\S]*?)\n\}/.exec(code);
    const body = fn ? fn[1] : '';
    check('RC-G4-i latest 回补有独立实现（不靠 publish 的 --tag 副作用）',
      !!fn, fn ? 'reconcile_latest_tag()' : '未见 reconcile_latest_tag 函数');
    check('RC-G4-j 回补执行 npm dist-tag add "$PKG_NAME@$VER" latest',
      /dist-tag add "\$PKG_NAME@\$VER" latest\b/.test(body), fn ? 'ok' : '无函数体');
    check('RC-G4-k 只升不降：由 semverCompare 判定，比较单源 = src/shared/version.js',
      /semverCompare\(e\.PUBLISH_VER,\s*e\.CUR_LATEST\)\s*>\s*0/.test(body)
        && /DSH_VERSION_LIB="\$ROOT\/src\/shared\/version\.js"/.test(body),
      fn ? 'ok' : '无函数体');
    check('RC-G4-l 远端 latest 读法容错（缺包/无标签一律按「无 latest」处理，不猜）',
      /npm view "\$PKG_NAME" dist-tags\.latest/.test(body), fn ? 'ok' : '无函数体');
    check('RC-G4-m 回补失败必须非零退出（RC-5：不得「包发出去了但通道没对齐」）',
      /if ! out=.*dist-tag add "\$PKG_NAME@\$VER" latest/.test(body)
        && /exit 1/.test(body), fn ? 'ok' : '无函数体');
    const callLines = splitLines(code).filter((l) => /^\s*reconcile_latest_tag\s*$/.test(l));
    check('RC-G4-n 真发布分支与幂等跳过分支都执行回补（部分平台重跑不得漏）',
      callLines.length >= 2, callLines.length + ' 处调用（期望 >=2：publish 后 + 幂等 exit 前）');
    // 幂等分支的回补形态：紧跟在 `exit 0` 之前（跳过发布也要先对齐通道再退出）。
    check('RC-G4-o 幂等跳过分支里回补排在 exit 0 之前（跳过发布也要对齐通道）',
      /reconcile_latest_tag\s*\n\s*exit 0\s*\n/.test(code),
      /reconcile_latest_tag\s*\n\s*exit 0/.test(code) ? 'ok' : 'exit 0 前无回补调用');

    const autoChannel = splitLines(code)
      .filter((l) => /dist-tag\s+(add|rm)/.test(l) && /\b(rollback|canary)\b/.test(l));
    check('RC-G4-f 发布脚本不自动设置 rollback / canary（人工运维，§4）',
      autoChannel.length === 0, autoChannel.length ? autoChannel.join(' | ') : '无自动设置点');

    const manualLine = ls.find((l) => /^\s*#/.test(l) && /rollback/.test(l) && /canary/.test(l) && /人工/.test(l));
    check('RC-G4-g 脚本注释声明 rollback / canary 由人工运维设置（§4）',
      !!manualLine, manualLine ? manualLine.trim() : '未找到');

    check('RC-G4-h 防误发保护：默认 dry-run（PUBLISH=0）+ 显式 --publish 且仅 CI',
      /防误发/.test(sh) && /PUBLISH=0\b/.test(sh) && /npm publish --dry-run/.test(sh) && /GITHUB_ACTIONS/.test(sh),
      'ok');
  }

  // --- RC-G5 反向 ---
  console.log('== RC-G5 反向：判据能识别「取全量最高」旧形态（门禁非空转）==');
  {
    const LEGACY = "const candidates = new Set([...Object.values(tags), ...versions].filter((v) => VERSION_RE.test(v)));";
    const CONFORMING = "const tags = (j && j['dist-tags']) || {}; const latest = tags.latest; if (latest) return latest;";
    const RUST_LEGACY = 'let obj = j.get("dist-tags"); let obj2 = j.get("versions");';
    const RUST_CONFORMING = 'let latest = j.get("dist-tags").and_then(|x| x.get("latest")).and_then(|x| x.as_str());';

    check('RC-G5-a 判据把 tags 值 ∪ versions 键 取最高判为旧形态', isUnionMax(LEGACY), 'hit');
    check('RC-G5-b 判据不误报契约形态（只读 tags.latest）', !isUnionMax(CONFORMING), 'ok');
    check('RC-G5-c 判据能识别契约形态的 latest 读取点', readsLatestTag(CONFORMING), 'hit');
    check('RC-G5-d 判据把 Rust 旧形态判为旧形态', isUnionMax(RUST_LEGACY), 'hit');
    check('RC-G5-e 判据不误报 Rust 契约形态',
      !isUnionMax(RUST_CONFORMING) && readsLatestTag(RUST_CONFORMING), 'ok');
    check('RC-G5-f 同一 fixture 上旧算法给出与契约不同的答案（判据有分辨力）',
      legacyUnionMax(META_A) === '0.2.0-BETA.1' && META_A['dist-tags'].latest === '0.1.6-RC.1',
      '旧算法=' + String(legacyUnionMax(META_A)) + '；契约期望=' + META_A['dist-tags'].latest);
  }

  // --- RC-G1 / RC-G2：壳侧选版不在本仓判定 ---
  //   原交叉块读的是 `ROOT/../dsh-supervisor-launcher/...`，而内核 CI 从不检出壳仓（由
  //   test/no-cross-repo-test.js X-2 钉住），所以「文件不存在就当过」那条分支才是唯一走得到的分支：
  //   两条断言在内核链上恒绿，属空转门禁。壳侧的同一事实由壳仓 src-tauri/src/release_channel.rs
  //   的 step1..step5 单测判定，那里每次壳 CI 都真跑。

  // --- RC-G3 行为（假 registry）---
  console.log('== RC-G3 内核选版优先读 latest（行为，假 registry）==');
  {
    const fake = await startFakeRegistry();
    try {
      // authoritative 查询只走官方/注入的候选列表，不经测速选源（镜像延迟会把新版本判成「无更新」）。
      const dist = new DistributionManager({ registries: [fake.origin], registryFile: null, logger: { warn() {} } });

      fake.set(META_A);
      const gotA = await dist.fetchNpmLatest(META_A.name, { authoritative: true });
      check('RC-G3-h 行为：latest=RC 时返回 latest（BETA 数字更高不得压过）',
        gotA.ok === true && gotA.version === META_A['dist-tags'].latest,
        '返回 ' + JSON.stringify({ ok: gotA.ok, version: gotA.version, error: gotA.error }) + '（契约 §3③ 期望 ' + META_A['dist-tags'].latest + '）');
      check('RC-G3-i 行为：origin 回传给出该版本的源（下载必须同源，否则显示与下载分叉）',
        gotA.origin === fake.origin, String(gotA.origin));

      fake.set(META_B);
      const gotB = await dist.fetchNpmLatest(META_B.name, { authoritative: true });
      check('RC-G3-j 行为：latest=1.0.0 / max=9.9.9 → 仍返回 latest（不得猜最高）',
        gotB.ok === true && gotB.version === '1.0.0', '返回 ' + JSON.stringify({ ok: gotB.ok, version: gotB.version }) + '（契约 §3③ 期望 1.0.0）');

      // 取不到时必须回传结构化失败 + 逐源原因，而不是 null（null 会让 UI 把「取不到」显示成「已是最新」）。
      const gotNone = await dist.fetchNpmLatest('@dsh-sup/not-published-at-all', { authoritative: true });
      check('RC-G3-k 行为：包不存在 → ok:false + version:null + 指名源与原因',
        gotNone.ok === false && gotNone.version === null && gotNone.attempts.length === 1
          && gotNone.attempts[0].origin === fake.origin && /HTTP 404/.test(gotNone.attempts[0].error),
        JSON.stringify(gotNone.attempts) + ' error=' + String(gotNone.error));
    } finally {
      await fake.close();
    }
  }
  // --- RC-G8 权威查询的真相源边界（假 registry，两个候选源）---
  //   authoritative 的动机是「镜像同步延迟会把新版本判成已是最新」。所以「有官方源可查时绝不查镜像」
  //   必须可判红；而用户只配了镜像时退回镜像是有意兜底 —— 但必须把实际用的源如实回传。
  console.log('== RC-G8 authoritative：官方源优先，镜像兜底要留痕 ==');
  {
    const official = await startFakeRegistry({ prefix: '/registry.npmjs.org' });
    const mirror = await startFakeRegistry({ prefix: '/mirror' });
    try {
      const both = new DistributionManager({ registries: [mirror.origin, official.origin], registryFile: null, logger: { warn() {} } });
      const r1 = await both.fetchNpmLatest(META_A.name, { authoritative: true });
      check('RC-G8-a 官方源与镜像并存时只问官方源（镜像不得当真相源）',
        r1.ok === true && r1.origin === official.origin && String(JSON.stringify(r1)).indexOf(mirror.origin) < 0,
        JSON.stringify({ origin: r1.origin, attempts: r1.attempts }));

      const missing = await startFakeRegistry({ prefix: '/registry.npmjs.org', miss: true });
      const offButMiss = new DistributionManager({ registries: [mirror.origin, missing.origin], registryFile: null, logger: { warn() {} } });
      const r2 = await offButMiss.fetchNpmLatest(META_A.name, { authoritative: true });
      check('RC-G8-b 官方源没同步该包时如实判失败，不顺延去镜像取一个陈旧版本',
        r2.ok === false && r2.version === null && r2.attempts.length === 1
          && r2.attempts[0].origin === missing.origin && String(JSON.stringify(r2)).indexOf(mirror.origin) < 0,
        JSON.stringify({ ok: r2.ok, attempts: r2.attempts }));
      await missing.close();

      const onlyMirror = new DistributionManager({ registries: [mirror.origin], registryFile: null, logger: { warn() {} } });
      const r3 = await onlyMirror.fetchNpmLatest(META_A.name, { authoritative: true });
      check('RC-G8-c 无官方源可问时退回用户配置的首选源，且 origin 如实回传该镜像（兜底不留暗账）',
        r3.ok === true && r3.origin === mirror.origin, JSON.stringify({ ok: r3.ok, origin: r3.origin }));
    } finally {
      await official.close();
      await mirror.close();
    }
  }
}

main().then(() => {
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  if (failed.length) {
    console.log('说明：本门禁的每一项都对应契约第 6 节的一条不变量；失败 = 实现与契约分叉，');
    console.log('      按契约（SSOT）修实现，不要把断言放宽。');
  }
  process.exit(failed.length ? 1 : 0);
}).catch((e) => {
  console.log('FAIL 门禁运行异常: ' + ((e && e.stack) || e));
  process.exit(1);
});
