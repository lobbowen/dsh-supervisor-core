'use strict';

// npm 包缓存定位与预取（IO 叶子）。
// 所有 require 在模块顶层（DF-8），无内联 require。
// 只做「~/.npm/_npx 下的缓存 bin 定位」与「未命中时 npx --yes 预下载」。

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
// 条 6（批 4 C 平台）：异步子进程必须走统一有界封装（裸 execFile 无 windowsHide，
// Windows 上 npx.cmd 会弹控制台窗口，且绕过 timeout/SIGKILL/maxBuffer 纪律）。
const ex = require('../../../platform/util/exec');
const { npxBin } = require('../../../platform/os/exec-path');

/** 定位已缓存的包 bin（~/.npm/_npx/<hash>/node_modules/<pkg>，取最新）。无则 null。 */
function cachedPkgBin(pkg) {
  if (!pkg) return null;
  try {
    const npxDir = path.join(os.homedir(), '.npm', '_npx');
    if (!fs.existsSync(npxDir)) return null;
    const dirs = fs.readdirSync(npxDir).filter((d) => /^[0-9a-f]{8,}$/i.test(d));
    dirs.sort((a, b) => { try { return fs.statSync(path.join(npxDir, b)).mtimeMs - fs.statSync(path.join(npxDir, a)).mtimeMs; } catch { return 0; } });
    for (const d of dirs) {
      const pkgDir = path.join(npxDir, d, 'node_modules', pkg);
      if (!fs.existsSync(pkgDir)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const bin = j.bin;
        let rel = null;
        if (typeof bin === 'string') rel = bin;
        else if (bin && typeof bin === 'object') { const k = Object.keys(bin)[0]; rel = bin[k]; }
        if (rel) return path.join(pkgDir, rel);
      } catch {}
    }
  } catch {}
  return null;
}

/** 下载预取：缓存未命中 -> npx --yes 预下载（首次安装）。 */
async function ensurePkgCached(provider, app) {
  if (!app || !app.pkg) return { ok: true };
  if (cachedPkgBin(app.pkg)) return { ok: true, cached: true };
  try {
    const regOrigin = provider.dist ? await provider.dist.selectRegistry(false).catch(() => null) : null;
    const env = Object.assign({}, process.env);
    if (regOrigin) { env.npm_config_registry = regOrigin; env.NPM_CONFIG_REGISTRY = regOrigin; }
    // 预下载成败以下方缓存复检为准，runOutAsync 自身绝不 reject。
    await ex.runOutAsync(npxBin(), ['--yes', app.pkg, '--help'], { env, timeoutMs: 120000 });
    return { ok: !!cachedPkgBin(app.pkg) };
  } catch { return { ok: false }; }
}

module.exports = { cachedPkgBin, ensurePkgCached };
