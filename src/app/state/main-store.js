'use strict';

// main 元数据（dsh-main.json）存储工厂（真 ctor 注入）：自己持有 live 缓存与读写实现。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');

function createMainStore(deps) {
  const g = deps || {};
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let live = null; // dsh-main.json live 缓存（LanManager mainOf 持同一对象，须原地修改）
  // 文件存在但读/解析失败 -> 置 corrupt，writeDshMain 拒写。
  //   旧行为：解析失败静默回落默认值（remoteToken:''）并缓存进 live，任一后续写把空令牌落盘
  //   -> 门卫令牌不可逆丢失且 relay 被无声降级为零认证。
  let corrupt = false;

  function dshMainFile() {
    try { return path.join(path.dirname(config().stateFile), 'dsh-main.json'); } catch { return null; }
  }

  /** 按守卫 stateFile 派生，隔离同目录多守卫。 */
  function registryFileName() {
    try {
      const b = path.basename(config().stateFile || 'state.json', '.json');
      return b === 'state' ? 'managed-objects.json' : (b + '.managed-objects.json');
    } catch { return 'managed-objects.json'; }
  }

  function readDshMainFile() {
    try {
      const f = dshMainFile();
      if (f && fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        corrupt = false;
        return {
          guardian: j.guardian === true,
          remoteEnabled: j.remoteEnabled === true,
          remoteToken: String(j.remoteToken || ''),
          frpEnabled: j.frpEnabled === true,
          frpRemotePort: j.frpRemotePort || null,
          wanPort: j.wanPort || null,
        };
      }
    } catch (e) {
      // 文件存在但读/解析失败（半截 JSON/权限抖动）-> 记 corrupt，拒后续覆盖写。
      corrupt = true;
      const l = logger();
      if (l && l.warn) l.warn('dsh-main.json 读/解析失败，写回将被拒绝直至显式重设 remoteToken: ' + ((e && e.message) || e));
    }
    return { guardian: false, remoteEnabled: false, remoteToken: '', frpEnabled: false, frpRemotePort: null, wanPort: null };
  }

  /** 读 main 元数据（无文件则默认：守护关、远程关）。结果缓存到 live。 */
  function readDshMain() {
    if (live) return live;
    live = readDshMainFile();
    return live;
  }

  /** 写 main 元数据(白名单字段，原子写 0600)。更新 live 缓存。
   *  A1-b fail-closed：上次读被判定 corrupt 时拒绝覆盖写 —— 默认值缓存会把明文令牌
   *  静默清零（丢失即降级为零认证）。解锁唯一途径：携带显式非空 remoteToken 的写入
   *  （= 用户重设令牌的动作）。 */
  function writeDshMain(meta) {
    const m = meta || {};
    if (!live) live = readDshMainFile(); // 可能在此置 corrupt
    if (corrupt && !(typeof m.remoteToken === 'string' && m.remoteToken)) {
      const l = logger();
      if (l && l.warn) l.warn('_writeDshMain: 文件损坏态，拒绝以默认值覆盖写回');
      return;
    }
    corrupt = false;
    Object.assign(live, m);
    const f = dshMainFile();
    if (!f) return;
    try {
      const cur = readDshMain();
      const merged = Object.assign({}, cur, m);
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        guardian: merged.guardian === true,
        remoteEnabled: merged.remoteEnabled === true,
        remoteToken: String(merged.remoteToken || ''),
        frpEnabled: merged.frpEnabled === true,
        frpRemotePort: merged.frpRemotePort || null,
        wanPort: merged.wanPort || null,
      }, null, 2);
      writeAtomic(f, body, { mode: 0o600 });
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_writeDshMain: ' + ((e && e.message) || e));
    }
  }

  return { dshMainFile, registryFileName, readDshMain, readDshMainFile, writeDshMain };
}

module.exports = { createMainStore };
