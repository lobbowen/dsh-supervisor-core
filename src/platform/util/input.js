'use strict';

// 外部输入的统一字符集闸。
//
// 为什么单源：version / unit 名 / 包名 / argv 项 / 账本键此前分散在三处各写一份白名单
//   （shared/version 的严格 semver、os/service 的 UNIT_NAME_RE、distribution/install 的
//   PKG_NAME_RE + BAD_ARGV_CHAR_RE）。审计 的病灶不是「哪一份写错」，而是
//   **新增入口时无处可抄** —— 每多一个「把外部字符串拼进 argv / 文件路径 / 对象键」的
//   调用点，就多一次「作者以为不用校验」的机会。本文件是那把尺子的唯一存放处。
//
// 边界：这里只做**字符集 / 形态**判定。语义级校验留在各自的域，且不得反向依赖本文件：
//   - URL 可达性 / SSRF / 私网字面量 -> distribution/policies.js（isValidOrigin）与 api C-8 闸；
//   - 版本大小与通道语义 -> app/native/policies.js + shared/version.js。

/** npm 包名（含 scope）：`dsh` / `@deepseek-ai/dsh`。字符集从严，宁误杀不漏放。 */
const PKG_NAME_RE = /^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;

/** argv 项的禁用字符集：空白 + 全部 shell 元字符/引号/控制符。命中即拒。
 *   反斜杠的例外见 WIN_ABS_PATH_RE（win32 盘符绝对路径是合法 argv，CI run17 实测教训）。 */
const ARGV_UNSAFE_RE = /[\s;|&<>`'"$(){}\\*?~#]/;

/** 盘符绝对路径整体形态：仅当该项**完整匹配**时豁免禁用字符集里的 `\\`。
 *  其余禁用字符（`;`、引号、`$`、空白等）仍被拦；含空白的路径必须走 commandTemplate 拆项。 */
const WIN_ABS_PATH_RE = /^[A-Za-z]:\\[^;|&<>`'"$*?~#\s]*$/;

/** systemd 单元名（含实例形 `dsh-web@inst-1`）：字母数字 + `:` `-` `_` `.` `@`，1..128。 */
const UNIT_NAME_RE = /^[A-Za-z0-9:@._-]{1,128}$/;

/** 不得当作对象键使用的名字：这三者会让 `obj[key] = v` 落到原型链上（污染或失效）。 */
const UNSAFE_LEDGER_KEYS = ['__proto__', 'prototype', 'constructor'];

/** 控制符与空白：账本键/展示键里的这些字符没有语义价值，只会污染文件与面板。 */
const LEDGER_UNSAFE_RE = /[\s\u0000-\u001f\u007f]/;

/** 单个 argv 项是否可安全传入（不经 shell）。@returns {string|null} 违规说明；null = 通过。 */
function argvViolation(arg) {
  const s = String(arg == null ? '' : arg);
  if (!s) return '空的 argv 项';
  if (ARGV_UNSAFE_RE.test(s) && !WIN_ABS_PATH_RE.test(s)) return 'argv 项含禁用字符（空白/shell 元字符）: ' + s.slice(0, 80);
  return null;
}

/** 包名是否走白名单。@returns {string|null} */
function pkgNameViolation(pkg) {
  const s = String(pkg == null ? '' : pkg);
  return PKG_NAME_RE.test(s) ? null : '非法包名（字符集白名单不通过）: ' + s.slice(0, 80);
}

/** systemd 单元名（字符集 + 后缀）。@returns {string|null} */
function unitNameViolation(unit) {
  const s = String(unit == null ? '' : unit);
  if (!UNIT_NAME_RE.test(s)) return '非法单元名（字符集/长度白名单不通过）: ' + s.slice(0, 80);
  const dot = s.indexOf('.');
  if (dot >= 0 && !/\.service$/.test(s)) return '单元名后缀不受支持（仅允许 .service 或无后缀）: ' + s.slice(0, 80);
  return null;
}

/** 归一「来自外部、会被当作对象键」的名字（账本 byModel / 分组 map 等）。
 *  与直接判错不同：账本要**继续累计**，所以违规值折进兜底桶而不是丢弃（B19 的上限语义不变）。
 *  @param {string} raw
 *  @param {{max?:number, empty?:string, unsafe?:string}} [opts]
 *  @returns {string} */
function ledgerKey(raw, opts) {
  const o = opts || {};
  const max = typeof o.max === 'number' ? o.max : 128;
  const empty = o.empty == null ? 'unknown' : o.empty;
  const unsafe = o.unsafe == null ? '(other)' : o.unsafe;
  if (typeof raw !== 'string' || !raw) return empty;
  const s = raw.length > max ? raw.slice(0, max) : raw;
  if (UNSAFE_LEDGER_KEYS.indexOf(s) >= 0 || LEDGER_UNSAFE_RE.test(s)) return unsafe;
  return s;
}

module.exports = {
  PKG_NAME_RE, ARGV_UNSAFE_RE, WIN_ABS_PATH_RE, UNIT_NAME_RE,
  UNSAFE_LEDGER_KEYS, LEDGER_UNSAFE_KEYS_RE: LEDGER_UNSAFE_RE,
  argvViolation, pkgNameViolation, unitNameViolation, ledgerKey,
};
