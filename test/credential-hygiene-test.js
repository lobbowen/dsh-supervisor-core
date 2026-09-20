#!/usr/bin/env node
'use strict';

// 凭据卫生门禁—— 凭据管理标准的可执行部分
//
// ## 真实事故（本门禁要防的）
//   壳仓令牌原存于**实例附件目录**（.../instances/inst-<id>/data/.dsh/attachments/.../gh_token.txt）
//   ——那是 ephemeral 的，换个会话就没了 -> 「下午能推壳、现在找不到壳令牌」。
//   另有一份副本以 0664（全局可读）散落在 $HOME 根。
//
// ## 门禁必须宿主无关
//   CI 机器上没有开发机那份凭据库：直接断言它存在，就是把环境事实当成产品事实
//   （与 platform-layer-portability-test 同一条纪律）。
//   因此本文件分三段：
//   D 组用临时夹具库测规则本身（任意宿主可跑）：doctor/list/path/get 之外，
//     put 与 backup 走行为级判定（空输入 fail-closed、真机根双确认、覆盖前备份、
//     拒绝 ephemeral 目标），断言的是子进程退出码与落盘结果，不是脚本文本。
//   R 组真机审计（库存在才做，缺失显式 SKIP）；S 组仓库本地不变量（任何宿主成立）。
//
// ## 标准（见 CREDENTIALS-STANDARD.md 与库内 index.json 的 rules）
//   1. 凭据只允许存放在规范库（SSH 密钥可留 ~/.ssh）；禁止实例/附件目录（ephemeral）；
//   2. 库目录 0700、库内文件 0600；禁止令牌内嵌 remote URL；仓库文件不得含令牌值；
//   3. 令牌必须有清单条目，只存引用不存值；缺失要显式标 missing。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const CRED_SH = path.join(ROOT, 'release', 'scripts', 'cred.sh');

// 真实用户 home：$HOME 被 DSH 重定向到实例数据目录，~/.dsh 不是它 ——
//   故与 cred.sh 同源解析（getent/dscl/USERPROFILE），**不得硬编码机器路径**。
function realHome() {
  if (process.env.DSH_REAL_HOME) return process.env.DSH_REAL_HOME;
  if (process.platform === 'win32') return process.env.USERPROFILE || os.homedir();
  try {
    const u = os.userInfo().username;
    if (process.platform === 'darwin') {
      const h = execFileSync('dscl', ['.', '-read', '/Users/' + u, 'NFSHomeDirectory'], { encoding: 'utf8' }).trim().split(/s+/).pop();
      if (h && fs.existsSync(h)) return h;
    } else {
      const h = execFileSync('getent', ['passwd', u], { encoding: 'utf8' }).trim().split(':')[5];
      if (h && fs.existsSync(h)) return h;
    }
  } catch { /* 回退到 os.homedir() */ }
  return os.homedir();
}
const REAL_HOME = realHome();
// 规范库根：真实 home 下 develop/.credentials（与 cred.sh CANON_STORE 同口径）。
const REAL_STORE = process.env.DSH_CRED_DIR || path.join(REAL_HOME, 'develop', '.credentials');
const LEGACY_ALIAS = path.join(REAL_HOME, '.dsh', 'github-pat-advgyxqamf');
const HOME_ROOT_STRAYS = ['gh_token.txt', 'gh_token', '.gh_token'].map((n) => path.join(REAL_HOME, n));

const results = [];
// Windows 无 POSIX 权限位（chmod 只切换只读位，mode 常为 666）——
//   D 组里所有**权限语义**断言必须平台自感知，否则只在 Windows 红。
const IS_POSIX = process.platform !== 'win32';
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
const TOKEN_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/;
const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0'); } catch { return null; } };

// 用给定库根跑 cred.sh，返回 {code, out}
function runCred(dir, args) {
  return runCredIn(dir, args, '', null);
}

// put/backup 的行为级探针：stdin 经 execFileSync 的 input 显式喂入（空串=真空输入）。
//   先抹平宿主的确认位再叠加 envExtra —— 否则 CI/开发机若残留 DSH_CRED_ALLOW_OVERWRITE
//   或 DSH_CRED_BACKUP_DIR，「应被拒绝」的负例会因为环境而非因为代码变绿。
//   所有写入都落在 TMP 内（DSH_CRED_DIR 由调用方给夹具库根）。
function runCredIn(dir, args, input, envExtra) {
  const base = {
    DSH_CRED_DIR: dir,
    DSH_CRED_ALLOW_OVERWRITE: '',
    DSH_CRED_FORCE: '',
    DSH_CRED_BACKUP_DIR: '',
  };
  try {
    const out = execFileSync('bash', [CRED_SH].concat(args), {
      encoding: 'utf8', timeout: 60000, input: input == null ? '' : input,
      env: Object.assign({}, process.env, base, envExtra || {}),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: (e && e.status) || 1, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
  }
}

// 造夹具库；opts.kernelMissing=true 时该条目置 missing
function fixture(dir, opts) {
  const o = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  const kf = path.join(dir, 'kernel-test.pat');
  fs.writeFileSync(kf, 'dummy-not-a-real-token');
  fs.chmodSync(kf, 0o600);
  const idx = {
    version: 1,
    storeDir: dir,
    homeNote: 'HOME 被重定向 -> 一律绝对路径',
    rules: ['a', 'b', 'c', 'd'],
    entries: [{
      name: 'kernel', kind: 'github-pat', account: 'x', file: kf,
      verify: { method: 'file' }, status: o.kernelMissing ? 'missing' : 'active',
    }],
    history: [],
  };
  const idxPath = path.join(dir, 'index.json');
  fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
  fs.chmodSync(idxPath, 0o600);
  return { dir: dir, idxPath: idxPath, kf: kf };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'credgate-'));

// -- D 组：规则本身（夹具库，任意宿主可跑）--
{
  const d1 = path.join(TMP, 'ok');
  fixture(d1);
  const r1 = runCred(d1, ['doctor']);
  check('D-1 夹具库齐全时 cred.sh doctor 通过（退出 0）', r1.code === 0, 'exit=' + r1.code);
  // Windows 无 POSIX 权限位：doctor 会显式 SKIP，此处断言该 SKIP（而非要求 0700/0600）
  check('D-1 doctor 权限检查（POSIX 报 0700 / Windows 显式 SKIP）',
    IS_POSIX ? /OK\s+库目录 0700/.test(r1.out) : /SKIP.*POSIX 权限位/.test(r1.out),
    IS_POSIX ? 'POSIX 模式' : 'Windows SKIP');
  check('D-1 doctor 报告文件 0600（POSIX）/ Windows 跳过',
    IS_POSIX ? /kernel-test[.]pat 0600/.test(r1.out) : true,
    IS_POSIX ? 'ok' : 'Windows 无 POSIX 权限位');
  check('D-1 doctor 报告无缺项', /OK\s+无缺项/.test(r1.out), 'ok');

  const d2 = path.join(TMP, 'loose');
  const f2 = fixture(d2);
  fs.chmodSync(f2.kf, 0o644);
  const r2 = runCred(d2, ['doctor']);
  // Windows 无 POSIX 权限位：chmod 0644 不会被判为「过宽」-> doctor 不会失败。
  //   故仅在 POSIX 上断言该失败语义；Windows 断言改为「doctor 完成且不因权限误报」。
  check('D-2 库内文件权限过宽（0644）-> doctor 失败（POSIX）/ Windows 跳过',
    IS_POSIX ? r2.code !== 0 : true,
    IS_POSIX ? 'exit=' + r2.code : 'Windows 无 POSIX 权限位');
  check('D-2 失败原因指向该文件（POSIX）/ Windows 跳过',
    IS_POSIX ? /kernel-test[.]pat 权限 644/.test(r2.out) : true,
    IS_POSIX ? 'ok' : 'Windows 无 POSIX 权限位');

  const d3 = path.join(TMP, 'missing');
  fixture(d3, { kernelMissing: true });
  const r3 = runCred(d3, ['doctor']);
  check('D-3 条目 status=missing -> doctor 失败（缺项可见）', r3.code !== 0, 'exit=' + r3.code);
  check('D-3 输出点名缺哪个条目', /kernel/.test(r3.out) && /缺/.test(r3.out), 'ok');

  const d4 = path.join(TMP, 'outside');
  const f4 = fixture(d4);
  const j4 = JSON.parse(fs.readFileSync(f4.idxPath, 'utf8'));
  j4.entries[0].file = path.join(REAL_HOME, '.dsh', 'supervisor', 'instances', 'inst-1', 'data', '.dsh', 'attachments', 'x', 'gh_token.txt');
  fs.writeFileSync(f4.idxPath, JSON.stringify(j4, null, 2));
  const r4 = runCred(d4, ['doctor']);
  check('D-4 条目指向 ephemeral 附件路径 -> doctor 失败', r4.code !== 0, 'exit=' + r4.code);
  check('D-4 失败信息含该条目名与路径', /kernel/.test(r4.out) && /attachments/.test(r4.out), 'ok');

  const r5 = runCred(d1, ['list']);
  check('D-5 list 输出条目名与状态', /kernel/.test(r5.out) && /active/.test(r5.out), 'ok');
  const r5b = runCred(d1, ['path', 'kernel']);
  // 绝对路径：POSIX 以 / 开头；Windows 形如 C:/... 或 C:\...
  const absPath = /^([A-Za-z]:[\\/]|\/)/.test(r5b.out.trim());
  check('D-5 path 输出库内绝对路径', /kernel-test[.]pat/.test(r5b.out) && absPath, r5b.out.trim());
  const r5c = runCred(d1, ['get', 'kernel']);
  check('D-5 get 返回文件内容（供脚本消费）', r5c.out.trim() === 'dummy-not-a-real-token', 'ok');
  const r5d = runCred(d1, ['get', 'nonexistent']);
  check('D-5 get 未知条目 -> 非零退出', r5d.code !== 0, 'exit=' + r5d.code);

  const d6 = path.join(TMP, 'put');
  fixture(d6, { kernelMissing: true });
  try {
    execFileSync('bash', ['-c', 'printf %s new-secret-value | bash "$0" put kernel', CRED_SH],
      { encoding: 'utf8', env: Object.assign({}, process.env, { DSH_CRED_DIR: d6 }) });
  } catch (e) { /* 由下方断言判定 */ }
  const kf6 = path.join(d6, 'kernel-test.pat');
  // Windows 上 chmod 不产生 POSIX 0600（常为 666）——仅断言文件确实写入
  check('D-6 put 写入文件且权限 0600（POSIX）/ Windows 仅断言写入',
    fs.existsSync(kf6) && (IS_POSIX ? modeOf(kf6) === '600' : true),
    IS_POSIX ? String(modeOf(kf6)) : 'Windows 无 POSIX 权限位');
  check('D-6 put 后该条目 status 变为 active',
    JSON.parse(fs.readFileSync(path.join(d6, 'index.json'), 'utf8')).entries[0].status === 'active', 'ok');
  check('D-6 put 后 doctor 通过（缺项已消）', runCred(d6, ['doctor']).code === 0, 'ok');

  // -- D-7 空输入 fail-closed：旧形态 `cat > "$f"` 先截断再等数据，空 stdin 就写出 0 字节 --
  const d7 = path.join(TMP, 'put-empty');
  const f7 = fixture(d7, { kernelMissing: true });
  fs.writeFileSync(f7.kf, 'OLD-VALUE');
  const r7 = runCredIn(d7, ['put', 'kernel'], '');
  check('D-7 空 stdin 的 put 被拒（非零退出）', r7.code !== 0, 'exit=' + r7.code);
  check('D-7 拒绝原因指向空输入', /stdin 为空/.test(r7.out), r7.out.trim().slice(0, 70));
  check('D-7 目标文件未被截断（原值仍在）', fs.readFileSync(f7.kf, 'utf8') === 'OLD-VALUE', fs.readFileSync(f7.kf, 'utf8'));
  check('D-7 被拒的 put 不改清单状态',
    JSON.parse(fs.readFileSync(f7.idxPath, 'utf8')).entries[0].status === 'missing', '仍 missing');
  check('D-7 不留 .tmp 中间产物（校验发生在动目标之前）',
    fs.readdirSync(d7).filter((x) => x.indexOf('.tmp.') >= 0).length === 0, fs.readdirSync(d7).join(','));
  check('D-7 不留 .bak 残留（备份在校验之后）',
    fs.readdirSync(d7).filter((x) => x.indexOf('.bak-') >= 0).length === 0, fs.readdirSync(d7).join(','));

  // -- D-8 只有空白的输入同样拒（`printf '\n'` 是误敲，不是凭据）--
  const r8 = runCredIn(d7, ['put', 'kernel'], '\n  \t \n');
  check('D-8 全空白 stdin 被拒', r8.code !== 0 && /stdin 为空/.test(r8.out), 'exit=' + r8.code);
  check('D-8 全空白被拒后原值仍在', fs.readFileSync(f7.kf, 'utf8') === 'OLD-VALUE', 'ok');

  // -- D-9 覆盖前备份的等价性：名字、内容、权限 --
  //   （真机库两层确认闸已由 destructive-op-safety-test W-1..W-4 覆盖，此处不重复；
  //    D-6/D-7 已管「写成功」与「空输入被拒」，这里只补备份这一条安全网。）
  const d9 = path.join(TMP, 'put-backup');
  const f9 = fixture(d9);
  fs.writeFileSync(f9.kf, 'OLD-VALUE');
  const r9ok = runCredIn(d9, ['put', 'kernel'], 'NEW-VALUE');
  check('D-9 覆盖写入成功且目标为新值', r9ok.code === 0 && fs.readFileSync(f9.kf, 'utf8') === 'NEW-VALUE',
    'exit=' + r9ok.code + ' 现值=' + fs.readFileSync(f9.kf, 'utf8'));
  const baks9 = fs.readdirSync(d9).filter((x) => x.indexOf('.bak-') >= 0);
  check('D-9 只留一个备份（每次覆盖一份）', baks9.length === 1, baks9.join(',') || '(无备份)');
  check('D-9 备份名 = <文件>.bak-<14 位时间戳>',
    baks9.length === 1 && /^kernel-test[.]pat[.]bak-\d{14}$/.test(baks9[0]), baks9[0] || '');
  check('D-9 备份内容 = 覆盖前的旧值', baks9.length === 1
    && fs.readFileSync(path.join(d9, baks9[0]), 'utf8') === 'OLD-VALUE', baks9[0] || '');
  check('D-9 备份权限 0600（POSIX）/ Windows 跳过', !IS_POSIX || (baks9.length === 1
    && modeOf(path.join(d9, baks9[0])) === '600'),
    baks9[0] ? String(modeOf(path.join(d9, baks9[0]))) : '');

  // -- D-10 backup：目标必须显式且不得是 ephemeral 实例子目录 --
  const r10a = runCredIn(d1, ['backup'], '');
  check('D-10 不给目标目录 -> 拒绝且不用默认值', r10a.code !== 0 && /用法/.test(r10a.out), 'exit=' + r10a.code);
  const inInst = path.join(TMP, 'inst-root', 'supervisor', 'instances', 'inst-1', 'bak');
  const r10b = runCredIn(d1, ['backup', inInst], '');
  check('D-10 目标在实例目录内 -> 拒绝（ephemeral 无意义）',
    r10b.code !== 0 && /实例目录/.test(r10b.out), 'exit=' + r10b.code);
  check('D-10 拒绝时不创建目标目录', !fs.existsSync(inInst), 'ok');
  const okBak = path.join(TMP, 'persist-bak');
  const r10c = runCredIn(d1, ['backup', okBak], '');
  const outs = r10c.code === 0 ? fs.readdirSync(okBak) : [];
  const sub = outs.length ? path.join(okBak, outs[0]) : null;
  check('D-10 合法目标 -> 产出带时间戳的副本目录', outs.length === 1 && /^dsh-credentials-\d{14}$/.test(outs[0]), outs.join(','));
  check('D-10 副本含清单与库内 *.pat',
    !!sub && fs.existsSync(path.join(sub, 'index.json')) && fs.existsSync(path.join(sub, 'kernel-test.pat')),
    sub ? fs.readdirSync(sub).join(',') : '无产出');
  check('D-10 副本目录 0700、副本文件 0600（POSIX）/ Windows 跳过',
    !IS_POSIX || (sub && modeOf(sub) === '700' && modeOf(path.join(sub, 'kernel-test.pat')) === '600'),
    IS_POSIX && sub ? modeOf(sub) + '/' + modeOf(path.join(sub, 'kernel-test.pat')) : 'Windows 无 POSIX 权限位');
  check('D-10 备份提示含明文风险，且不回显任何令牌值',
    /明文令牌/.test(r10c.out) && !/dummy-not-a-real-token/.test(r10c.out), r10c.out.trim().slice(0, 60));

  // -- D-11 入口分发的两条尾账 --
  const r11 = runCredIn(d1, ['frobnicate'], '');
  check('D-11 未知子命令 -> 非零退出且打印用法', r11.code === 1 && /用法/.test(r11.out), 'exit=' + r11.code);
  const r12 = runCredIn(d1, ['put', 'nope'], 'x');
  check('D-12 put 未知条目 -> 拒绝且不落任何文件', r12.code !== 0 && /未知条目/.test(r12.out), 'exit=' + r12.code);
}

// -- S 组：仓库本地不变量（任何宿主都成立）--
{
  const exts = ['.js', '.json', '.md', '.sh', '.yml', '.yaml', '.txt', '.rs', '.ts', '.tsx'];
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!exts.includes(path.extname(e.name))) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (TOKEN_RE.test(txt)) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  check('S-1 仓库工作树内无令牌值', hits.length === 0, hits.length ? hits.join(', ') : '未发现');

  let remotes = '';
  try { remotes = execFileSync('git', ['remote', '-v'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { /* 非 git 环境 */ }
  const embedded = remotes.split(String.fromCharCode(10)).filter((l) => {
    const s = l.indexOf('://');
    if (s < 0) return false;
    const rest = l.slice(s + 3);
    const at = rest.indexOf('@');
    if (at < 0) return false;
    return rest.slice(0, at).indexOf(':') >= 0;
  });
  check('S-2 git remote URL 未内嵌凭据', embedded.length === 0, embedded.length ? embedded[0].slice(0, 60) : 'ok');

  let tracked = '';
  try { tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { /* 非 git 环境 */ }
  const keyFiles = tracked.split(String.fromCharCode(10)).filter((f) => /[.](pat|pem|key)$/.test(f));
  check('S-3 未被跟踪任何凭据/密钥文件（*.pat / *.pem / *.key）',
    keyFiles.length === 0, keyFiles.length ? keyFiles.join(', ') : 'ok');
}

// -- R 组：真机审计（库存在才做；缺失显式 SKIP）--
{
  if (!fs.existsSync(REAL_STORE)) {
    console.log('SKIP R 组：本机无规范凭据库（' + REAL_STORE + '）—— CI/新机属正常；规则本身已由 D 组用夹具库确定性验证。');
  } else {
    check('R-1 真机库目录权限 0700', modeOf(REAL_STORE) === '700', String(modeOf(REAL_STORE)));
    const idx = path.join(REAL_STORE, 'index.json');
    check('R-2 真机清单存在且 0600', fs.existsSync(idx) && modeOf(idx) === '600', String(modeOf(idx)));
    const files = fs.readdirSync(REAL_STORE).filter((f) => !f.endsWith('.sh'));
    const loose = files.filter((f) => modeOf(path.join(REAL_STORE, f)) !== '600');
    check('R-3 真机库内文件权限均 0600', files.length > 0 && loose.length === 0,
      loose.length ? loose.join(', ') : (files.length + ' 个文件均 0600'));
    const rr = runCred(REAL_STORE, ['doctor']);
    const permFail = rr.out.split(String.fromCharCode(10)).filter((l) => l.indexOf('FAIL') === 0 && /权限|库内路径/.test(l));
    check('R-4 真机 doctor 的权限与路径检查通过（缺项单列，不视为卫生问题）',
      permFail.length === 0, permFail.length ? permFail[0].slice(0, 70) : 'ok');
    const missLine = rr.out.split(String.fromCharCode(10)).filter((l) => l.indexOf('缺') >= 0 && l.indexOf('OK') < 0);
    if (missLine.length) console.log('     （提示）真机存在缺项：' + missLine[0].trim());
    let aliasState = 'absent';
    try {
      const st = fs.lstatSync(LEGACY_ALIAS);
      if (st.isSymbolicLink()) {
        aliasState = fs.realpathSync(LEGACY_ALIAS).startsWith(REAL_STORE + '/') ? 'link-into-store' : 'link-outside';
      } else aliasState = 'separate-copy';
    } catch (e) { aliasState = 'absent'; }
    check('R-5 旧别名不存在或指向库内（单一副本）',
      aliasState === 'absent' || aliasState === 'link-into-store', aliasState);
    const strays = HOME_ROOT_STRAYS.filter((p) => fs.existsSync(p));
    check('R-6 $HOME 根目录无散落令牌副本', strays.length === 0, strays.join(', ') || 'ok');
  }
}

// -- 持久化断言：库必须在**实例目录之外** --
//   为什么单独锁：$HOME 被 DSH 重定向到 .../instances/<id>/data，
//   若有人把库「改良」成 ~/.dsh/credentials，它就会落在**实例目录内** ——
//   换会话即失效（正是历史事故的形态：凭据存在实例附件目录 -> 下游会话找不到）。
{
  const sandboxHome = os.homedir();
  // 仅当 $HOME 确实被重定向到实例数据目录时该断言才适用；CI/新机 HOME 未重定向 -> 不适用。
  const redirected = /[\\/]instances[\\/]/.test(sandboxHome);
  check('持久化-1 凭据库不在被重定向的实例 $HOME 之下（否则换会话即失效）',
    !redirected || (!REAL_STORE.startsWith(sandboxHome + path.sep) && REAL_STORE !== sandboxHome),
    'STORE=' + REAL_STORE + '  HOME=' + sandboxHome + (redirected ? '' : '（HOME 未重定向，不适用）'));
  check('持久化-2 凭据库路径不含 instances 段（实例目录是 ephemeral 的）',
    !/[\\/]instances[\\/]/.test(REAL_STORE), REAL_STORE);
  check('持久化-3 凭据库是绝对路径（禁止 ~ 依赖）',
    /^([A-Za-z]:[\\/]|\/)/.test(REAL_STORE) && REAL_STORE.indexOf('~') < 0, REAL_STORE);
  if (fs.existsSync(REAL_STORE)) {
    // 判据以 index.json 的引用集合为准（真机库文件名不保证 .pat 后缀，如 github-pat/npm-token）。
    const idxP = path.join(REAL_STORE, 'index.json');
    const refs = fs.existsSync(idxP)
      ? (JSON.parse(fs.readFileSync(idxP, 'utf8')).entries || []).map((e) => e.file).filter(Boolean)
      : [];
    check('持久化-4 真机令牌文件非空且长度合理（未被清空/占位）',
      refs.length > 0 && refs.every((f) => {
        const fp = path.join(REAL_STORE, f);
        try { return fs.statSync(fp).size >= 40; } catch { return false; }
      }), refs.map((f) => { try { return f + '=' + fs.statSync(path.join(REAL_STORE, f)).size + 'B'; } catch { return f + '=缺失'; } }).join(', '));
  } else {
    console.log('SKIP 持久化-4：本机无规范凭据库（CI/新机属正常）');
  }
}

// -- 反向 --
{
  check('反向：令牌值判据能识别真实形态', TOKEN_RE.test('github_pat_' + 'A'.repeat(30)), 'hit');
  check('反向：判据不误报普通字符串', !TOKEN_RE.test('github_pat_short') && !TOKEN_RE.test('token=abc'), 'ok');
  check('反向：D 组夹具确实被创建（非空转）', fs.readdirSync(TMP).length >= 5, String(fs.readdirSync(TMP).length) + ' 个夹具库');
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
