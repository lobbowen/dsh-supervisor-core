#!/usr/bin/env node
'use strict';

// migrateRouterSegment 契约（迁移S2，docs/MIGRATION-PROXY-PORTS.md）：
//   router 自治端口段（owner 前缀 proxy:/providerApi:）从共享 oldFile 迁出到 newFile 并清旧段；
//   幂等（无 router 段时 0 条）；目标合并去重；守卫段（system:/inst: 等）保留在旧文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// 端口统一取自 test/_ports.js（避开 OS ephemeral 与生产池，防跨文件撞号）
const { safePort } = require(path.join(__dirname, '_ports'));

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-mig-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { PortRegistry } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  // DS-G4 §4.2（反转法）：owner 前缀是**域知识**，platform 只做通用前缀迁移 → 由本域申报。
  const { OWNER_PREFIXES } = require(path.join(ROOT, 'src', 'domains', 'router', 'port-segments'));
  const ports = new PortRegistry({ file: path.join(TMP, 'unused.json') });

  const oldF = path.join(TMP, 'mig-old.json');
  const newF = path.join(TMP, 'mig-new.json');

  // 首次迁移：2 条 router 段迁出，旧文件清 router 段
  fs.writeFileSync(oldF, JSON.stringify({ records: [
    { port: 28140, role: 'proxyInstance', owner: 'proxy:k1' },
    { port: 28142, role: 'providerApi', owner: 'providerApi:p1' },
    { port: 3080, role: 'dsh-main', owner: 'system:dsh-main' },
    { port: 3081, role: 'user', owner: 'inst:main' },
  ] }, null, 2));
  const moved = ports.migrateByOwnerPrefix(oldF, newF, OWNER_PREFIXES);
  const oldDoc = JSON.parse(fs.readFileSync(oldF, 'utf8'));
  const newDoc = JSON.parse(fs.readFileSync(newF, 'utf8'));
  const isRouterRec = (r) => String((r && r.owner) || '').startsWith('proxy:') || String((r && r.owner) || '').startsWith('providerApi:');
  check('MIG-1 迁移 2 条 router 段', moved === 2, String(moved));
  check('MIG-2 旧文件保留守卫段、清除 router 段', oldDoc.records.length === 2 && !oldDoc.records.some(isRouterRec), JSON.stringify(oldDoc.records));
  check('MIG-3 新文件含 2 条 router 段', newDoc.records.length === 2 && newDoc.records.every(isRouterRec), JSON.stringify(newDoc.records));

  // 幂等：旧文件已无 router 段 → 二次迁移 0 条
  const moved2 = ports.migrateByOwnerPrefix(oldF, newF, OWNER_PREFIXES);
  check('MIG-4 幂等（无 router 段时迁移 0 条）', moved2 === 0, String(moved2));

  // 目标已有记录时合并去重
  fs.writeFileSync(oldF, JSON.stringify({ records: [
    { port: 28141, role: 'proxyInstance', owner: 'proxy:k2' },
    { port: 3080, role: 'dsh-main', owner: 'system:dsh-main' },
  ] }, null, 2));
  fs.writeFileSync(newF, JSON.stringify({ records: [{ port: 28140, role: 'proxyInstance', owner: 'proxy:k1' }] }, null, 2));
  const moved3 = ports.migrateByOwnerPrefix(oldF, newF, OWNER_PREFIXES);
  const newDoc3 = JSON.parse(fs.readFileSync(newF, 'utf8'));
  check('MIG-5 目标合并去重（新增 28141，保留既有 28140）', moved3 === 1 && newDoc3.records.length === 2, 'moved=' + moved3 + ' recs=' + newDoc3.records.length);

  // ── MIG-6+：B14（AUDIT §B-14）—— 解析损坏不崩 + 半途失败不双登记 ──
  {
    // ① 源文件损坏：返回 0、不抛、**不碰源文件**、不产出目标
    const cOld = path.join(TMP, 'mig-corrupt-old.json');
    const cNew = path.join(TMP, 'mig-corrupt-new.json');
    const junk = '{ records: [ 这不是JSON';
    fs.writeFileSync(cOld, junk);
    let threw = null; let r0 = null;
    try { r0 = ports.migrateByOwnerPrefix(cOld, cNew, OWNER_PREFIXES); } catch (e) { threw = e; }
    check('MIG-6 源损坏：不抛（旧实现裸抛崩启动路径）', threw === null, threw ? threw.message : 'r=' + r0);
    check('MIG-6 源损坏：返回 0 且源文件原样保留、无目标产出',
      r0 === 0 && fs.readFileSync(cOld, 'utf8') === junk && !fs.existsSync(cNew), 'ok');
    // ② 源 records 非数组：同样安全 no-op
    const aOld = path.join(TMP, 'mig-array-doc.json');
    fs.writeFileSync(aOld, JSON.stringify([1, 2, 3]));
    let r1 = null; let threw1 = null;
    try { r1 = ports.migrateByOwnerPrefix(aOld, cNew, OWNER_PREFIXES); } catch (e) { threw1 = e; }
    check('MIG-7 records 非数组：no-op 不抛、不产出目标', threw1 === null && r1 === 0 && !fs.existsSync(cNew), 'r=' + r1);
    // ③ 目标损坏：不得被覆盖，且**绝不顺手清空源**（旧实现吞异常后照常清源 → 两头无存）
    const tOld = path.join(TMP, 'mig-tbad-old.json');
    const tNew = path.join(TMP, 'mig-tbad-new.json');
    fs.writeFileSync(tOld, JSON.stringify({ records: [{ port: 28143, role: 'proxyInstance', owner: 'proxy:k9' }] }));
    fs.writeFileSync(tNew, 'corrupt{{{');
    let r2 = null; let threw2 = null;
    try { r2 = ports.migrateByOwnerPrefix(tOld, tNew, OWNER_PREFIXES); } catch (e) { threw2 = e; }
    const tOldAfter = JSON.parse(fs.readFileSync(tOld, 'utf8'));
    check('MIG-8 目标损坏：不抛、返回 0、源记录仍在、坏目标未被清写',
      threw2 === null && r2 === 0 && tOldAfter.records.length === 1 && fs.readFileSync(tNew, 'utf8') === 'corrupt{{{',
      'r=' + r2);
    // ④ 半途失败：目标文件已存在（走 targetExisted 分支）且其父目录被设成只读（0500）。
    //    单源 writeAtomic 的第一步 writeFileSync(<dir>/target.json.tmp.<pid>.<ts>) → EACCES（rename 前就爆，
    //    与「清源后写目标失败」同构：源已清 → 必须回写源 + 上抛）。
    //    （注：直接拿目录当 newFile 命中坏目标/穿透分支；「目录下的新文件」会被
    //      writeAtomic 的 mkdirSync(dirname) 做成功 —— 都构造不出半途失败。）
    const hOld = path.join(TMP, 'mig-halffail-old.json');
    const hDir = path.join(TMP, 'mig-halffail-ro.dir');
    fs.mkdirSync(hDir);
    const hNewFile = path.join(hDir, 'target.json');
    fs.writeFileSync(hNewFile, JSON.stringify({ records: [] })); // 合法空目标 → targetExisted=true
    fs.writeFileSync(hOld, JSON.stringify({ records: [
      { port: 28144, role: 'proxyInstance', owner: 'proxy:hf' },
      { port: 3090, role: 'dsh-main', owner: 'system:dsh-main' },
    ] }));
    let threw3 = 'skipped(win32: chmod 非强制)';
    if (process.platform !== 'win32') {
      fs.chmodSync(hDir, 0o500); // 只读目录：tmp 文件无法创建
      try { ports.migrateByOwnerPrefix(hOld, hNewFile, OWNER_PREFIXES); threw3 = null; }
      catch (e) { threw3 = e; }
      fs.chmodSync(hDir, 0o755);
    }
    const hDoc = JSON.parse(fs.readFileSync(hOld, 'utf8'));
    check('MIG-9 半途失败：抛错上抛（旧实现清源失败静默）', threw3 === 'skipped(win32: chmod 非强制)' || (!!threw3 && threw3.code === 'EACCES'), threw3 === null ? '未抛' : (threw3.code || threw3.message));
    check('MIG-9 半途失败：源记录经回写保持完整（0 丢失 / 0 双登记）',
      hDoc.records.length === 2 && hDoc.records.some((x) => x.owner === 'proxy:hf'), JSON.stringify(hDoc.records.map((x) => x.port)));
    try { fs.rmSync(hDir, { recursive: true, force: true }); } catch { /* 清理尽力 */ }
    // 反向：旧实现形态确实会崩（证明 MIG-6 判据非空转）
    let legacyThrew = null;
    try { const d = JSON.parse(fs.readFileSync(cOld, 'utf8')); (d.records || []).filter(() => true); } catch (e) { legacyThrew = e; }
    check('MIG-6 反向：裸 JSON.parse（旧形态）对同一损坏文件确实抛', !!legacyThrew, legacyThrew ? '抛' : '未抛');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
