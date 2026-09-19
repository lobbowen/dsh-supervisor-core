'use strict';

// 通用端口记录迁移（纯 IO）：把 owner 命中任一前缀的记录从 oldFile 迁出到 newFile，并从旧文件清除。
// 平台只按 owner 前缀字符串工作，前缀由域侧提供（DS-G4）；目标合并去重（按 port）、幂等、原子写。

const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** owner 前缀迁移；@returns {number} 实际迁出的记录数。
 *
 *  B14 加固（两条旧缺陷）：
 *   ① 源/目标文件 JSON 损坏或 records 非数组：旧实现源解析**裸抛**（启动路径整体崩）、目标解析
 *      失败被 catch 吞掉后**照常清空源文件** —— 记录两头无存。现：任何一侧不可信即返回 0 且**不碰文件**。
 *   ② 半途失败造成重复登记：旧顺序「写目标 → 清源」，若清源失败被吞/抛，同一条记录在新旧两文件
 *      并存（合并视图=双份登记），且旧实现清源失败静默返回。现顺序：先清源（tmp+rename 原子）
 *      → 写目标；写目标抛错则回写源恢复并**上抛**（调用方 ports-bootstrap 本就捕获记日志）。 */
function migrateByOwnerPrefix(oldFile, newFile, prefixes) {
  const pre = (Array.isArray(prefixes) ? prefixes : [])
    .filter((x) => typeof x === 'string' && x !== '');
  if (!pre.length) return 0;
  const matches = (r) => { const o = String((r && r.owner) || ''); return pre.some((p) => o.startsWith(p)); };
  if (!fs.existsSync(oldFile)) return 0;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch { return 0; } // 源损坏：幂等 no-op，绝不崩
  if (!doc || !Array.isArray(doc.records)) return 0;
  const picks = doc.records.filter(matches);
  if (!picks.length) return 0;
  let target = { records: [] };
  let targetExisted = false;
  if (fs.existsSync(newFile)) {
    targetExisted = true;
    // 只有 JSON 解析失败（SyntaxError）才判「坏目标 → no-op 保护」；
    // 读取本身的 IO 错误（目标路径是目录等）→ 视为空目标继续，让写入阶段暴露半途失败。
    try {
      target = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) return 0; // 坏目标：不覆盖、不迁（留给上层报错）
      target = { records: [] };
    }
    if (!target || typeof target !== 'object' || !Array.isArray(target.records)) return 0;
  }
  const seen = new Set(target.records.map((r) => r && r.port));
  let moved = 0;
  for (const r of picks) { if (!seen.has(r.port)) { target.records.push(r); moved += 1; } }
  const keep = doc.records.filter((r) => !matches(r));
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  try {
    writeAtomic(oldFile, { records: keep }); // ① 先清源：此后任何失败都只会「少一份」，不会双份
    writeAtomic(newFile, target);            // ② 再落目标
  } catch (e) {
    if (!targetExisted && fs.existsSync(newFile)) { try { fs.unlinkSync(newFile); } catch { /* 尽力清理 */ } }
    try { writeAtomic(oldFile, doc); } catch { /* 回写失败：源已被原子清走 picks，无双登记风险 */ }
    throw e; // 调用方需知晓半途失败（旧实现静默）
  }
  return moved;
}

module.exports = { migrateByOwnerPrefix };
