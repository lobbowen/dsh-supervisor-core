#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 第十三轮续：壳投放的镜像契约必须能**重载**
//
// ## 缺陷（失效模式 b + f + i）
//
// `registryContract.read()` 与 `DistributionManager._loadRegistryConfig()` 原先
// **只在构造器各调用一次**，无任何 reload / watch。
// 而壳会在**运行中**重写 registry.json（真实触发点：mirror.rs::export_on_boot
// 每次壳启动、commands/mod.rs:514 的 mirror_set、node.rs:146 选中镜像后落盘）。
//
// 后果：内核进程生命周期内永远看不到壳的新 catalog / **探测规格** / selected / mode：
//   - 用**旧探测方法**自己重测 -> 正是 registry-contract.js:23-28 声称已修复的
//     「两侧选源不一致」（用户看到面板显示一个源、实际用另一个）；
//   - 手动设 manual 后内核仍按 auto 走；
//   - 主进程与 router-daemon 若启动时刻不同 -> 两侧契约长期不一致（一台机器两个决策）。
//
// ## 修法
// 在读入口（selectRegistry / registryInfo）加 TTL 重载（60s）。
//
// ## 门禁
//   A 结构：存在 TTL 重载入口，且读入口确实调用它
//   B 行为：TTL 内不重载、TTL 过后重载（并拿到新的 catalog 与 **probe 规格**）
//   C 反向：不因每次调用都重读而回归（TTL 内多次调用只读一次盘）
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

/** 比生产 TTL（60s）略大的守卫值：确保「拨回过去」后必然过期，又不依赖具体实现数值。 */
const CONTRACT_TTL_GUARD = 61 * 1000;

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  //  （域结构第三轮）：distribution 已拆为 release/policies/registry/install + index 门面；
  //   断言对象是「分发能力」而非单文件，故按目录聚合读取（读取面随文件搬移同步，判据语义不变）。
  const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
  const src = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  console.log('== A 结构 ==');
  check('A 存在 TTL 常量', /CONTRACT_TTL_MS\s*=/.test(code), '有');
  check('A 存在重载入口 _reloadContractIfStale', /_reloadContractIfStale\(\)\s*\{/.test(code), '有');
  check('A selectRegistry 读入口调用重载', /async function selectRegistry[\s\S]{0,400}?reloadContractIfStale\s*\(/.test(code), '有');
  // 判据允许 `x.reloadContractIfStale(state)` 限定形式：重载实现已按所有权归 registry-config.js。
  check('A registryInfo 读入口调用重载', /async function registryInfo\([^)]*\)\s*\{\s*\n\s*(?:\w+\.)?reloadContractIfStale\(state\);/.test(code), '有');

  console.log('== B 行为：TTL 内不重载 / TTL 过后重载 ==');
  {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13rc-'));
    const rf = path.join(TMP, 'registry.json');
    const write = (cat, probe) => fs.writeFileSync(rf, JSON.stringify({
      schema: 2, writtenBy: 'shell', mode: 'auto',
      catalog: [cat], probe: { kind: 'package-metadata', pathTemplate: probe, timeoutMs: 6000 },
    }));
    write('https://boot.example', 'pkg-a');
    const { DistributionManager } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
    const dm = new DistributionManager({ registryFile: rf, registries: ['https://boot.example'] });
    check('B 构造时读到启动契约', dm.contract.catalog[0] === 'https://boot.example', JSON.stringify(dm.contract.catalog));

    // 壳在运行中重写
    write('https://new.example', 'pkg-b');
    await dm.registryInfo();
    check('B TTL 内**不**重载（避免每次请求都读盘）',
      dm.contract.catalog[0] === 'https://boot.example', JSON.stringify(dm.contract.catalog));

    // 把载入时刻拨回 TTL 之前
    dm._contractLoadedAt = Date.now() - (CONTRACT_TTL_GUARD);
    await dm.registryInfo();
    check('B TTL 过后**重载**并获得新 catalog（旧实现永远 boot）',
      dm.contract.catalog[0] === 'https://new.example', JSON.stringify(dm.contract.catalog));
    check('B 新**探测规格**也生效（这正是「两侧选源不一致」的根因）',
      dm.contract.probe && dm.contract.probe.pathTemplate === 'pkg-b',
      JSON.stringify(dm.contract.probe && dm.contract.probe.pathTemplate));

    // C 反向：TTL 内多次调用不应反复读盘
    dm._contractLoadedAt = Date.now();
    write('https://third.example', 'pkg-c');
    await dm.registryInfo();
    await dm.selectRegistry(true).catch(() => {});
    check('C 反向：TTL 内后续调用不重复读盘（仍是 new）',
      dm.contract.catalog[0] === 'https://new.example', JSON.stringify(dm.contract.catalog));

    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log('== D 条 5（批 4 C）：platformTag 不可用时探测退化 ping，不阻断选源（不变量 C2）==');
  {
    const policies = require(path.join(ROOT, 'src', 'platform', 'distribution', 'policies.js'));
    const spec = { kind: 'package-metadata', pathTemplate: 'pkg/{platform}', timeoutMs: 6000 };
    const ping = policies.resolveProbe('https://r.example', spec, null);
    check('D resolveProbe(tag=null) 退化 ping（旧实现把字面量 undefined 拼进 URL 恒 404）',
      ping.kind === 'ping' && ping.url === 'https://r.example/-/ping', JSON.stringify(ping));
    check('D resolveProbe(tag 有效) 仍走 package-metadata 展开（修法不扩大）',
      policies.resolveProbe('https://r.example', spec, 'linux-x64').url === 'https://r.example/pkg/linux-x64',
      policies.resolveProbe('https://r.example', spec, 'linux-x64').url);
    check('D 反向：无契约时照旧 ping 兜底',
      policies.resolveProbe('https://r.example', null, null).kind === 'ping', 'ping');
    const regSrc = fs.readFileSync(path.join(distDir, 'registry.js'), 'utf8');
    check('D probeRegistry 入口有 matrix.isSupported 闸（可产标但不在发布矩阵 → 不投 package-metadata）',
      /matrix\.isSupported\(\)/.test(regSrc), '有');
    check('D probeRegistry 取标签包 try/catch（freebsd 等不可产标宿主不得抛穿 Promise.all）',
      /try \{[\s\S]{0,120}?platformTag\(\)[\s\S]{0,80}?catch \{ tag = null;/.test(regSrc), '有');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
