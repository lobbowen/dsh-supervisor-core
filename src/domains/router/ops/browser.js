'use strict';

const platform = require('../../../platform/os/index');
const desktop = require('../../../platform/os/desktop');

// 图形环境 + 打开浏览器（IO：进程/文件系统/平台层）。
// 调用方只给策略参数，平台差异封装在 platform.browser。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/** 图形会话环境注入：缺图形变量时（systemd user 常驻拉起等场景）从用户会话探测补齐。
 *  平台事实（X11/Wayland socket 在哪、runtime 目录怎么推）只写在 platform/os/desktop.js 一处，
 *  本函数原样转交 —— 这里再摸一遍 /tmp 与 /run 就会出现「可用性说没有会话、环境却补齐了」这类分叉。 */
function graphicalEnv() {
  return desktop.sessionEnv();
}

/** 调起系统默认浏览器做 OAuth 一键登录；引擎支持时叠加无痕 + 随机 profile + 语言/时区/窗口尺寸随机化
 *  （策略在此，引擎方言在平台层）。Safari 等无隔离引擎由平台层降级为非隔离打开，换账号靠登录超时/重新发起与 UI 上的 authUrl 手动兜底。
 *  结果词汇与 platform.browser.openBrowser 同一套（ok/confirmed/handedOff/reason/error）：
 *  调用方不得再把「拿不到 profile」这一件事自己编文案，也不得把「已移交」说成「已打开」。
 *  @param {function} [onExit] 浏览器进程退出回调（隔离形态下用户关闭 -> 取消登录）。
 *  @returns {{profile:string|null, result:object}} profile=null 表示未起浏览器，result 携带原因。 */
function openInBrowser(url, onExit) {
  try {
    const tmpProfile = path.join(os.tmpdir(), 'dsh-oauth-' + crypto.randomBytes(8).toString('hex'));
    const sysEnv = Object.assign({}, process.env, graphicalEnv());
    const TZ_POOL = ['Asia/Shanghai', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];
    const LANG_POOL = ['zh-CN', 'en-US', 'en-GB', 'ja-JP', 'ko-KR', 'de-DE', 'fr-FR', 'zh-TW'];
    const SIZE_POOL = [[1280, 800], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1680, 1050], [1920, 1080], [1024, 768], [1152, 864], [1280, 720]];
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const size = pick(SIZE_POOL);
    const lang = pick(LANG_POOL);
    const tz = pick(TZ_POOL);
    const antiEnv = Object.assign({}, sysEnv, { TZ: tz, LANG: lang });
    const r = platform.browser.launchIsolated(url, { profileDir: tmpProfile, size, lang, antiEnv, sysEnv, onExit });
    if (!r || !r.ok) return { profile: null, result: r || { ok: false, reason: 'spawn-failed' } };
    if (r.isolated) {
      // unref：清理定时器最长 30 分钟，不得拖住进程退出。
      const t30 = setTimeout(() => { try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {} }, 30 * 60 * 1000);
      if (t30.unref) t30.unref();
    }
    return { profile: tmpProfile, result: r };
  } catch (e) {
    return { profile: null, result: { ok: false, reason: 'spawn-failed', error: '浏览器启动失败：' + ((e && e.message) || e) } };
  }
}

module.exports = { graphicalEnv, openInBrowser };
