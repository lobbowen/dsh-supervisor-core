#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 发布规范一致性门禁

// ## 解决的问题
//   发布流程此前散落在 5+ 份文档：同一事实（入口/矩阵/glibc 基座/凭据）重复 5–8 处，
//   必然漂移 —— 的清理就修掉 4 处过时声明（旧仓库名、「Linux 本地生产」、
//   「三平台矩阵」、「待决策」）。
//   现确立 RELEASE-STANDARD.md 为**唯一事实源**，并由本门禁把「规范 = 现实」钉死：
//   **改代码不改规范、或改规范不改代码，本门禁即红。**

// ## 锁定不变量
//   P-1  规范里的每个入口文件存在；.sh 可执行
//   P-2  规范里的每个 `npm run X` 的 X 存在于 package.json#scripts
//   P-3  平台矩阵与 package.json#npmPublish.packages 逐项一致，且 CI build 矩阵覆盖同集合
//   P-4  CI job 名与 tag 模式与 workflow 一致
//   P-5  规范列出的门禁文件存在且在 test/manifest.js 登记表中
//   P-6  必需章节标题齐备
//   P-7  反向：判据能识别伪造入口 / 缺失文件（门禁非空转）
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
//  凡按行解析 workflow **必须**经 _workflow.js（行尾归一）—— 参见该文件头的事故记录。
const { readWorkflow, jobSection } = require(path.join(__dirname, '_workflow.js'));
const SPEC = path.join(ROOT, 'RELEASE-STANDARD.md');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const specTxt = fs.readFileSync(SPEC, 'utf8');

// 抽取机器可读块：```json release-pipeline ... ```
function extractBlock(txt) {
  const start = txt.indexOf('```json release-pipeline');
  if (start < 0) return null;
  const body = txt.slice(start + '```json release-pipeline'.length);
  const end = body.indexOf('```');
  if (end < 0) return null;
  return body.slice(0, end);
}
let spec = null;
{
  const raw = extractBlock(specTxt);
  check('规范含机器可读块（json release-pipeline）', !!raw, raw ? String(raw.length) + ' 字节' : '缺失');
  try { spec = JSON.parse(raw); } catch (e) { /* 由下面断言报告 */ }
  check('机器可读块可解析为 JSON', !!spec, spec ? 'ok' : '解析失败');
}

if (spec) {
  const pkg = require(path.join(ROOT, 'package.json'));
  const npmScripts = pkg.scripts || {};

  // -- P-1 / P-2：入口存在且可执行 --
  const badFiles = [];
  const badScripts = [];
  for (const [name, val] of Object.entries(spec.entries || {})) {
    if (val.startsWith('npm run ')) {
      const s = val.slice('npm run '.length).split(' ')[0];
      if (!npmScripts[s]) badScripts.push(name + ' -> ' + val);
      continue;
    }
    const f = path.join(ROOT, val.split(' ')[0]);
    if (!fs.existsSync(f)) { badFiles.push(name + ' -> ' + val); continue; }
    if (f.endsWith('.sh')) {
      try { fs.accessSync(f, fs.constants.X_OK); } catch { badFiles.push(name + ' -> ' + val + '（不可执行）'); }
    }
  }
  check('P-1 规范里的入口文件都存在且 .sh 可执行',
    badFiles.length === 0, badFiles.length ? badFiles.join(', ') : Object.keys(spec.entries).length + ' 个入口');
  check('P-2 规范里的 npm script 都存在',
    badScripts.length === 0, badScripts.length ? badScripts.join(', ') : 'ok');
  // 阶段命令也必须在 scripts 里（若为 npm run）
  const badStages = [];
  for (const st of spec.stages || []) {
    const m = /^npm run ([^ ]+)/.exec(st.cmd);
    if (m && !npmScripts[m[1]]) badStages.push(st.id + ' -> ' + st.cmd);
    const b = /^bash ([^ ]+)/.exec(st.cmd);
    if (b && !fs.existsSync(path.join(ROOT, b[1]))) badStages.push(st.id + ' -> ' + st.cmd);
  }
  check('P-2b 阶段命令引用的脚本/script 都存在',
    badStages.length === 0, badStages.length ? badStages.join(', ') : (spec.stages.length + ' 个阶段'));

  // -- P-2c：规范正文里出现的每个 `npm run X` 都必须在 package.json 存在 --
  //   原缺陷：表格曾列 `npm run publish:core:all`，而该 script 已被硬标准移除；
  //   正文表格不在机器块内，P-2 抓不到。本检查把「规范正文 = 现实」也钉死。
  {
    const allRuns = Array.from(specTxt.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)).map((m) => m[1]);
    const badRuns = Array.from(new Set(allRuns)).filter((s) => !npmScripts[s]);
    check('P-2c 规范正文里的每个 npm run X 都存在于 package.json#scripts',
      badRuns.length === 0, badRuns.length ? badRuns.join(', ') : (new Set(allRuns).size + ' 个唯一 script'));
  }

  // -- P-3：矩阵一致 --
  const pub = (pkg.npmPublish && pkg.npmPublish.packages) || [];
  check('P-3 规范声明的矩阵来源 = package.json#npmPublish.packages',
    spec.matrixSource === 'package.json#npmPublish.packages', String(spec.matrixSource));
  const wf = fs.readFileSync(path.join(ROOT, spec.ciWorkflow), 'utf8');
  const runners = (spec.ciRunners || []);
  const missingRunner = runners.filter((r) => wf.indexOf('os: ' + r) < 0);
  check('P-3b CI build 矩阵含规范列出的全部 runner',
    missingRunner.length === 0 && runners.length === pub.length,
    missingRunner.length ? ('缺 ' + missingRunner.join(', ')) : (runners.length + ' 个 runner = ' + pub.length + ' 个子包'));
  // 规范文档的矩阵表必须列出每个子包
  const missingPkg = pub.filter((p) => specTxt.indexOf(p) < 0);
  check('P-3c 规范正文列出了全部 npm 子包名',
    missingPkg.length === 0, missingPkg.length ? missingPkg.join(', ') : pub.length + ' 个子包');

  // -- P-4：job 名与 tag 模式 --
  const missingJob = (spec.ciJobs || []).filter((j) => !new RegExp('^  ' + j + ':', 'm').test(wf));
  check('P-4 CI job 名与规范一致',
    missingJob.length === 0, missingJob.length ? missingJob.join(', ') : spec.ciJobs.join(', '));
  check('P-4b tag 触发模式与规范一致',
    wf.indexOf("tags:") >= 0 && wf.indexOf("'") >= 0 && spec.tagPattern === 'v*', String(spec.tagPattern));

  // -- P-5：门禁文件存在且在登记表中（清单唯一事实源 = test/manifest.js）--
  const listed = require(path.join(ROOT, 'test', 'manifest.js')).chain().join(' ');
  const badGates = [];
  for (const g of spec.specGates || []) {
    if (!fs.existsSync(path.join(ROOT, g))) { badGates.push(g + '（不存在）'); continue; }
    if (listed.indexOf(g) < 0) badGates.push(g + '（不在 test/manifest.js 登记表中）');
  }
  check('P-5 规范列出的门禁都存在且在登记表中',
    badGates.length === 0, badGates.length ? badGates.join(', ') : (spec.specGates.length + ' 道门禁'));

  // -- P-6：必需章节 --
  const missingSec = (spec.requiredSections || []).filter((s) => specTxt.indexOf(s) < 0);
  check('P-6 必需章节标题齐备',
    missingSec.length === 0, missingSec.length ? missingSec.join(', ') : (spec.requiredSections.length + ' 节'));
}

// -- P-7：反向（判据必须能识别违规）--
{
  const bogus = { entries: { x: 'release/scripts/__nonexistent__.sh' } };
  const missing = !fs.existsSync(path.join(ROOT, bogus.entries.x));
  check('P-7 反向：判据能识别不存在的入口文件', missing, 'hit');
  const badNpm = 'npm run __nonexistent_script__';
  const s = badNpm.slice('npm run '.length).split(' ')[0];
  check('P-7 反向：判据能识别不存在的 npm script',
    !(require(path.join(ROOT, 'package.json')).scripts || {})[s], 'hit');
  check('P-7 反向：机器块抽取在缺块时返回 null',
    extractBlock('no block here') === null, 'ok');
  check('P-7 反向：规范正文确实含矩阵来源声明（防删块仍绿）',
    specTxt.indexOf('npmPublish.packages') >= 0, 'ok');
}


// -- P-8：完整构建不得被条件跳过--
//
//   原实现 build 受 `need_build == true` 门控 —— 版本已全平台发布时整块跳过，
//   于是「已发布版本之后的改动」**从未经过四平台构建验证**（PR 也照样能合）。
//   硬标准要求：**四平台完整构建在每次 push / PR 都跑**。发布才需要一次性闸。
{
  //  必须经 _workflow.js 读取（CRLF 归一）—— 本门禁首版用 fs.readFileSync + 逐行等值比较，
  //   在 Windows 检出（CRLF）下 "  build:" 恒不命中 -> **只在 Windows CI 红**（本仓既有该事故记录）。
  const wf = readWorkflow(spec.ciWorkflow.split("/").pop());
  const seg = jobSection(wf, "build");
  check("P-8 build job 存在（jobSection 取到体）", seg.length > 0, seg.length + " 字符");
  check("P-8 四平台完整构建**不得**被 need_build 之类条件跳过",
    !/^    if:/m.test(seg), (seg.match(/^    if:.*$/m) || ["(无 if)"])[0]);
  check("P-8 矩阵仍为四平台", (seg.match(/- os: /g) || []).length === 4,
    ((seg.match(/- os: /g) || []).length) + " 个 os");
  // 发布必须仍受一次性闸保护（否则会重复发布 -> npm 409）
  check("P-8 发布步骤仍受 need_build 一次性闸保护",
    /needs.precheck.outputs.need_build/.test(seg), "ok");
  // 反向：判据能识别被门控的 build（构造一段带 if 的 build job）
  const probe = "  build:" + String.fromCharCode(10) + "    needs: precheck" + String.fromCharCode(10) + "    if: needs.precheck.outputs.need_build == 'true'";
  check("P-8 反向：判据能识别被条件门控的 build", /^    if:/m.test(probe), "hit");
  // 反向：CRLF 夹具 —— 经 jobSection 归一后仍能取到（防再次退化为裸 fs.readFileSync）
  // 夹具须含**前导换行**：jobSection 的正则要求 `\n  <name>:\n`（顶层 job 前必有其它行）
  const crlf = "name: x" + String.fromCharCode(13, 10) + "  build:" + String.fromCharCode(13, 10) + "    needs: precheck" + String.fromCharCode(13, 10) + "    runs-on: x";
  check("P-8 反向：CRLF 夹具经 jobSection 仍取到 build 段",
    jobSection(crlf, "build").includes("needs: precheck"), "hit");
}

// -- P-9：发布链门禁（B23/B24/B25/B26，纯静态源码形态）--
//   全部判据自带反向夹具（防空转）；运行时行为由 CI 四平台矩阵裁决。
{
  const bl = fs.readFileSync(path.join(ROOT, 'release', 'scripts', 'build-launcher.sh'), 'utf8').replace(/\r\n/g, '\n');
  const pc = fs.readFileSync(path.join(ROOT, 'release', 'scripts', 'publish-core.sh'), 'utf8').replace(/\r\n/g, '\n');
  const cr = fs.readFileSync(path.join(ROOT, 'release', 'scripts', 'cred.sh'), 'utf8').replace(/\r\n/g, '\n');
  const pkgLock = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
  const pkgJson = require(path.join(ROOT, 'package.json'));

  // esbuild 固版 + 构建后对账（npx 浮动拉包 = 同 commit 不同日不同产物）
  check('P-9 B23 build-launcher esbuild 固版（esbuild@$ESBUILD_VER）', bl.includes('"esbuild@$ESBUILD_VER" bin/dsh-supervisor'), 'ok');
  check('P-9 B23 构建后版本对账（不一致即失败）', /ACTUAL_ESBUILD.*!=.*ESBUILD_VER/.test(bl), 'ok');
  check('P-9 B23 反向：无版本 npx esbuild 浮动形态判缺', !bl.includes('npx --yes esbuild bin/'), 'ok');
  // --define 插值前 version 形态硬校验
  const caseIdx = bl.indexOf('case "$VER" in');
  const defIdx = bl.indexOf('--define:__DSH_VERSION__');
  check('P-9 B23 version 形态闸先于 --define 插值', caseIdx >= 0 && defIdx > caseIdx, caseIdx + ' < ' + defIdx);
  // 子包元数据生成不得拼 JS 源码（供应链注入面）
  check('P-9 B23 NODE_GEN 拼接已移除', !pc.includes('NODE_GEN='), 'ok');
  check('P-9 B23 包元数据经 env 生成（GEN_REPO/GEN_PKG_NAME）', pc.includes('GEN_PKG_NAME="$PKG_NAME"') && /node -e '[^']*process\.env/.test(pc), 'ok');
  check('P-9 B23 os/cpu 平台过滤字段仍在生成器中', /os:\[e\.GEN_PLAT\],cpu:\[e\.GEN_ARCH\]/.test(pc), 'ok');
  check('P-9 B23 反向：旧插值形态（repository:{type:\'git\',url:\'$MAIN_REPO\'}）可被识别', /repository:\{type:'git',url:'\$MAIN_REPO'\}/.test("const o={repository:{type:'git',url:'$MAIN_REPO'},bin:{'dsh-supervisor':'x'}}"), 'ok');
  // 幂等发布 = 体积 + sha1 双项强核对，缺要素/不一致即拒（不得只警告）
  check('P-9 B24 幂等核对取远端 shasum', pc.includes('j.dist.shasum'), 'ok');
  check('P-9 B24 本地真 pack 计 sha1 对账', pc.includes('sha1sum "$LOCAL_TGZ"'), 'ok');
  check('P-9 B24 缺要素/不一致均 fail-closed', /-z "\$REMOTE_SHA"[\s\S]{0,200}exit 1/.test(pc) && /\$REMOTE_SHA" != "\$LOCAL_SHA1"[\s\S]{0,300}exit 1/.test(pc), 'ok');
  check('P-9 B24 反向：旧「体积不一致仅警告」形态判缺', !pc.includes('请人工确认后再决定是否升版本重发'), 'ok');
  // 存在性只认退出码：`--json` 下不存在的版本也会把 E404 对象写到 stdout，「输出非空」会判成已存在。
  check('P-9 B24 存在性由 npm view 退出码定性', /if REMOTE_SPEC="\$\(npm view /.test(pc), 'ok');
  check('P-9 B24 反向：旧「输出非空即已存在」形态判缺', !/grep -q \./.test(pc), 'ok');
  // 备份降级为尽力安全网（warn 继续），确认项仍硬闸
  //   段锚点取**代码行** `BK="$f.bak-` 而非相邻注释：注释会被精简/改措辞，锚点一丢判据就静默抓空。
  //   终点必须**向后**找：`umask 077` 在 put() 里出现两次（TMP_IN 读取段的 `( umask 077; mkdir… )`
  //   与导出段的独立 `umask 077`），裸 indexOf 会让 slice 首末倒置、段恒空 => 判据恒红。
  //   并补一条「段非空」前提例——锚点顺序一旦回退要判红带证据，而不是让下游判据静默抓空。
  const b25At = cr.indexOf('BK="$f.bak-');
  const b25EndRaw = b25At < 0 ? -1 : cr.indexOf('umask 077', b25At);
  const putSeg = b25At < 0 ? '' : cr.slice(b25At, b25EndRaw < 0 ? cr.length : b25EndRaw);
  check('P-9 B25 前提：段锚点成立且非空（防 slice 首末倒置把判据掏空）',
    putSeg.length > 80, 'start=' + b25At + ' end=' + b25EndRaw + ' 段长=' + putSeg.length);
  check('P-9 B25 备份失败不阻断 put（|| 警告分支）',
    /\( cp -p "\$f" "\$BK" && chmod 600 "\$BK" \)[\s\S]{0,40}\|\| echo/.test(putSeg),
    /\( cp -p "\$f" "\$BK" && chmod 600 "\$BK" \)[\s\S]{0,40}\|\| echo/.test(putSeg) ? '有 || 警告分支' : '段内未找到（段长=' + putSeg.length + '）');
  check('P-9 B25 反向：旧硬闸形态（cp&&chmod 独立成句）可识别', /^\s*cp -p "\$f" .* && chmod .* "\$f"\.bak/m.test('  cp -p "$f" "$f.bak-x" && chmod 600 "$f".bak-* 2>/dev/null'), 'ok');
  // 尾账：CANON_STORE 规范库根 = develop/.credentials
  check('P-9 CANON_STORE 指向 REAL_HOME/develop/.credentials',
    cr.includes('CANON_STORE=') && cr.includes('"$REAL_HOME/develop/.credentials"') && !cr.includes('"$REAL_HOME/.dsh/credentials"'), 'ok');
  // （X-1 门禁禁操作者用户名字面量 —— 用通用 /home/<user> 形态判，不写死是谁）
  check('P-9 CANON_STORE 不含操作者绝对路径（X-2）', !/\/home\/[a-z0-9._-]+\//.test(cr), 'ok');
  // 内核零依赖不变量 + lockfile 版本同步 + 无第三方 registry 残留
  check('P-9 B26 package.json 无 dependencies（内核零依赖）', !pkgJson.dependencies, JSON.stringify(Object.keys(pkgJson.dependencies || {})));
  check('P-9 B26 lock 版本与 package.json 同步', pkgLock.includes('"version": "' + pkgJson.version + '"'), pkgJson.version);
  check('P-9 B26 lock 无 npmmirror/acorn 残留', !/npmmirror/.test(pkgLock) && !/acorn/.test(pkgLock), 'ok');
  // 反向：把真实 lock 的版本换成旧值，同步判据必须识破（防空转）
  const driftLock = pkgLock.split(pkgJson.version).join('0.1.5-BETA.7');
  check('P-9 B26 反向：漂移夹具（版本回退 BETA.7）被同步判据识破',
    !driftLock.includes('"version": "' + pkgJson.version + '"') && /npmmirror/.test('https://registry.npmmirror.com/acorn/-/acorn-8.18.0.tgz'), 'ok');
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
