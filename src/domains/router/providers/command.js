'use strict';

// 命令拼装（B9）：纯函数，零 IO / 零 require。缓存优先（npx 包缓存已命中直接用
// node <bin>，零解析/零下载/秒起），缓存未命中走注入的 npx 启动形态（node 直启
// npx-cli.js 优先——Windows 上 .cmd 垫片无 shell spawn 必 EINVAL，成对形态由
// platform/os/npx-forms#npxLauncher 解析，本模块只消费不解析）。
// 注意：凭证不在本模块处理，{{key}} / --api-key 的剔除是调用方（provider）的凭证纪律，
// 本模块绝不持有或注入密钥。

/** 由 app 模板 + 端口构造 spawn argv（纯）。
 *  @param ctx { app, port, cachedBin, registry, launcher, execPath }
 *         launcher = platform 解析出的 npx 成对启动形态 {program,args,source}
 *  @returns { ok:boolean, cmd:string[], registry:string|null } */
function buildCommand(ctx) {
  const { app, port, cachedBin, registry, launcher, execPath } = ctx || {};
  if (!app || !Array.isArray(app.command)) return { ok: false, error: '无效应用命令模板', cmd: [], registry: registry || null };
  if (cachedBin) {
    // 标准参数统一注入（host/port）——api-key 绝不写入 cmdline
    const args = ['--host', '127.0.0.1', '--port', String(port)];
    const STANDARD = new Set(['--host', '--port', '--api-key', 'npx', '--yes']);
    const extra = [];
    const cmdList = app.command;
    for (let i = 0; i < cmdList.length; i++) {
      const t = String(cmdList[i]);
      if (STANDARD.has(t) || t.includes('{{') || (app.pkg && t === app.pkg)) continue;
      if (t === '127.0.0.1' || t === String(port)) continue;
      if (String(t).startsWith('--registry') || t === '--registry') continue;
      if (i > 0 && STANDARD.has(String(cmdList[i - 1]))) continue;
      extra.push(t);
    }
    return { ok: true, cmd: [execPath, cachedBin, ...extra, ...args], registry: registry || null };
  }
  // fallback：npx 形态拉起（首次安装/缓存丢失）——只替换 {{port}}；{{key}}/--api-key 交由调用方剔除
  const mapped = app.command.map((t) => String(t).replace('{{port}}', String(port)));
  const cmd = mapped;
  const args = [...cmd.slice(1)];
  if (cmd[0] === 'npx' && registry) {
    const ri = args.findIndex((a) => a === '--registry');
    if (ri >= 0) args[ri + 1] = registry;
    else { args.unshift(registry); args.unshift('--registry'); }
  }
  if (cmd[0] === 'npx') {
    // 成对形态优先：node-direct 时 program=node、args 前置 npx-cli.js 路径。
    const l = launcher || { program: 'npx', args: [], source: 'path' };
    return { ok: true, cmd: [l.program, ...l.args, ...args], registry: registry || null };
  }
  return { ok: true, cmd: [cmd[0], ...args], registry: registry || null };
}

module.exports = { buildCommand };
