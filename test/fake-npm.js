#!/usr/bin/env node
'use strict';

// 升级测试用假安装器：模拟 npm install -g 的成功/失败，不碰真实 npm。
// 用法: node fake-npm.js <version>
// 环境变量:
//   FAKE_PKG_JSON  要改写的 package.json 路径（ok/fail 模式必填；hang 模式不需要）
//   FAKE_MODE      ok(默认)=改写版本并退出0 | fail=退出3 | hang=报出自身 pid 后挂住不退出
//   FAKE_PID_FILE  hang 模式：把自身 pid 写到这里（D-10 用它证明「子进程真的活过」）
//   FAKE_HANG_MS   hang 模式挂起时长，默认 60000
//
//  为什么 hang 用**环境变量**而不是 argv：
//   runNpmInstall 的 commandTemplate 逐项过禁用字符集（B11 fail-closed），而 Windows
//   runner 的 os.tmpdir() 是 **8.3 短名** `C:\Users\RUNNER~1\AppData\Local\Temp\…`，
//   `~` 属禁用字符 -> 合法的临时脚本路径被拒。pid 文件路径经 env 传入，argv 只留仓库内路径。

const fs = require('node:fs');

const version = process.argv[2];
const pkgPath = process.env.FAKE_PKG_JSON;
const mode = process.env.FAKE_MODE || 'ok';

if (mode === 'hang') {
  const pidFile = process.env.FAKE_PID_FILE;
  if (pidFile) { try { fs.writeFileSync(pidFile, String(process.pid)); } catch {} }
  console.log('[fake-npm] hang pid=' + process.pid);
  setTimeout(function () {}, Number(process.env.FAKE_HANG_MS || 60000));
  return;
}

console.log(`[fake-npm] install ${version} mode=${mode}`);

if (!pkgPath || !version) {
  console.error('[fake-npm] missing args');
  process.exit(2);
}

if (mode === 'fail') {
  console.error('[fake-npm] simulated failure');
  process.exit(3);
}

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = version;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
console.log(`[fake-npm] wrote ${pkgPath} -> ${version}`);
process.exit(0);
