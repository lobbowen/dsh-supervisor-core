'use strict';

// 捕捉层（DSH-TOKEN-CONTRACT 契约3/4，TK-1/TK-3/TK-7）。
// 令牌由 DSH 侧生成，我方只能从 DSH 输出中取出，共三种源与固定优先级：stdout 实时行最优先，其次本地恢复文件，最后 journald。
// 顺序不可颠倒：journal 优先会把陈旧或别的 unit 的旧 token 覆盖掉刚由 stdout 捕获的新 token。
// journal 必须按“最近一条含回环 URL 的行”查询而非固定最近 N 行，否则长驻实例的 token 行滚出窗口后永远捕获不到。
// 本层只做一次拉取，退避重试与周期兜底由 pool 的 scheduleCapture 与 ensureCaptured 负责。
//：journalctl 必须**异步**（ex.runOutAsync）——captureOnce 由守卫生命周期 tick 的
//   ensureCaptured 调用，同步 execFileSync 在 5s 超时下会把整个事件循环冻住，心跳/定时器全部停摆。
//   因此 captureOnce 只做零外部进程的 stdout/文件两档（同步），journal 档拆成 captureJournal（Promise），
//   由 pool.capture 在非阻塞回填路径上发射，命中后照常 _commit+广播（TK-8）。
// TK-7 用户配置类只登记不捕捉：remote-token/api-access-key/frp-auth 权威在配置存储，本层对非 captured 分类直接 no-op。

const ex = require('../../util/exec');
const persist = require('./persist');
const kinds = require('./kinds');

/** 解析 DSH 启动输出行中的回环访问令牌（全仓唯一实现）。
 *  只认 127.0.0.1 回环 URL，令牌限 base64url 安全字符集，找不到返回 null。
 *  正则为迁移前逐字保留；放宽字符集会吞进 URL 后续片段，改动须同步契约与门禁。 */
function parseDshTokenLine(line) {
  const m = /(?:dsh web:)?\s*(?:https?:\/\/127\.0\.0\.1:\d+\/\?token=)([A-Za-z0-9_-]+)/.exec(String(line || ''));
  return m ? m[1] : null;
}

/** journald 查询：按单元取“最近一条含回环 URL 的行”。
 *  resolve { token, source:'journal', line } 或 null；任何失败（含非 systemd 平台无 journalctl）都 resolve(null)，绝不 reject。 */
async function captureJournal(unit, opts) {
  const logger = (opts && opts.logger) || console;
  // runOutAsync 失败/超时返回 null 且输出有上限，无需再包 try/catch。
  const out = await ex.runOutAsync('journalctl', ['--user', '-u', unit + '.service', '--no-pager', '-o', 'cat', '-g', '127\\.0\\.0\\.1:.*token=', '-n', '1'], {
    timeoutMs: 5000,
    logger,
  });
  if (!out) {
    logger.warn && logger.warn('[token] journal capture(' + unit + ') 命令失败或无输出');
    return null;
  }
  const lines = out.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = parseDshTokenLine(lines[i]);
    if (t) return { token: t, source: 'journal', line: lines[i] };
  }
  return null;
}

/** 按来源顺序取“最新一条”URL 行的令牌（同步档：stdout + 本地恢复文件）；
 *  desc 形如 { kind, unit, file, lines }，找不到返回 null。journal 档见 captureJournal。 */
function captureOnce(desc, opts) {
  const src = desc || {};
  // TK-7/TK-3：非捕捉分类（用户配置/派生/自签）只登记不捕捉。
  if (!kinds.isCaptured(src.kind)) return null;

  // stdout 实时行优先，spawn 托管下 feedLine 推送的当前进程 token 最权威。
  if (src.lines && src.lines.length) {
    for (let i = src.lines.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(src.lines[i]);
      if (t) return { token: t, source: 'stdout', line: src.lines[i] };
    }
  }

  // 本地恢复文件：stdout 管道断（守卫重启/收起）后从文件尾取最近 URL 行，使 main 无需为令牌被重建。
  if (src.file) {
    const tail = persist.readTailLines(src.file);
    for (let i = tail.length - 1; i >= 0; i--) {
      const t = parseDshTokenLine(tail[i]);
      if (t) return { token: t, source: 'file', line: tail[i] };
    }
  }
  return null;
}

module.exports = { parseDshTokenLine, captureOnce, captureJournal };
