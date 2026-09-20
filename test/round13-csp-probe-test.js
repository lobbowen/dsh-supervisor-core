#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 第十三轮续：镜像「测试」按钮必须走同源后端
//
// ## 缺陷（结构性失败被伪装成网络失败）
//
// 设置页的「测试」按钮由**浏览器直连**用户填写的任意镜像源
// （RegistryCard.tsx::testLatency -> fetch(url + "/-/ping")）。
// 而该页面由**内核 HTTP 服务**下发，并附带 CSP：
//     connect-src 'self'        （src/api/static.js，步骤9 由 index.js 拆出）
// -> 浏览器**在发起请求之前**就按 CSP 拦截，fetch 立刻 reject，
//   被 catch 统一吞成 toast「探测失败」。
//
// 后果：该按钮对**任何**地址恒报「探测失败」，且换网络、换镜像都无法解决；
//   UI 无法区分「真的不可达」与「被策略阻断」——把**结构性失败伪装成网络失败**，
//   用户据此以为镜像坏了而改配置或放弃使用镜像。
//   而「测速选最快镜像」正是该卡的卖点。
//
// ## 修法
//
// 新增**同源**端点 POST /dist/registry/probe（服务端探测不受页面 CSP 约束），
// 且复用 DistributionManager::_probeRegistry（与内核选源**同一探测规格**，
// 避免「测试说可达、实际选源不同」的第二次分叉）。
//
// ## 门禁
//   A UI 源码中**不再**出现跨源裸 fetch（唯一允许在 client.ts 内）
//   B 后端存在同源探活端点，且用**同一探测规格**（复用 _probeRegistry）
//   C 前端经 supervisorApi 包装调用（不再直接 fetch）
//   D 端点已登记到 api/contract.js（可发现性；步骤9 由 surface.js 改名）
//   E 反向：判据能识别跨源裸 fetch 形态（门禁非空转）
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  console.log('== A UI 不得有跨源裸 fetch ==');
  const uiFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p); }
      else if (/\.(ts|tsx)$/.test(e.name)) uiFiles.push(p);
    }
  };
  walk(path.join(ROOT, 'ui', 'src'));
  const offenders = [];
  for (const f of uiFiles) {
    const rel = path.relative(ROOT, f);
    if (rel.endsWith(path.join('services', 'supervisor', 'client.ts'))) continue; // 唯一允许的 fetch 点
    const src = fs.readFileSync(f, 'utf8');
    const code = src.split('\n').filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    }).join('\n');
    if (/\bfetch\(/.test(code)) offenders.push(rel);
  }
  check('A 除 client.ts 外无裸 fetch（页面 CSP connect-src self 会拦截跨源）',
    offenders.length === 0, offenders.length ? offenders.join(', ') : '0 处');

  console.log('== B 后端同源探活端点复用同一探测规格 ==');
  {
    const api = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'dist.js'), 'utf8');
    check('B 存在 /dist/registry/probe 端点', api.indexOf("'/dist/registry/probe'") >= 0, '有');
    check('B 校验 origin 必须以 http(s) 开头（防 SSRF 到任意协议）',
      /\^https\?:/.test(api), '有');
    //  （域结构第三轮）：probeOrigin 落在 registry.js，按目录聚合读取。
    const distDir = path.join(ROOT, 'src', 'platform', 'distribution');
    const dist = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')).sort().map((f) => fs.readFileSync(path.join(distDir, f), 'utf8')).join(String.fromCharCode(10));
    const i = dist.indexOf('async function probeOrigin(');
    check('B 存在 probeOrigin 实现', i > 0, i > 0 ? '有' : '缺');
    const body = dist.slice(i, i + 700);
    check('B 复用 probeRegistry（与内核选源同一探测规格）',
      body.indexOf('probeRegistry(') >= 0, '有');
  }

  console.log('== C 前端经 supervisorApi 包装调用 ==');
  {
    const card = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'features', 'supervisor', 'settings', 'RegistryCard.tsx'), 'utf8');
    check('C RegistryCard 调 supervisorApi.registryProbe', card.indexOf('supervisorApi.registryProbe(') >= 0, '有');
    const client = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'services', 'supervisor', 'client.ts'), 'utf8');
    check('C client 暴露 registryProbe 方法', client.indexOf('registryProbe:') >= 0, '有');
  }

  console.log('== D 端点已登记 surface ==');
  {
    const surface = fs.readFileSync(path.join(ROOT, 'src', 'api', 'contract.js'), 'utf8');
    check('D surface 登记 /dist/registry/probe', surface.indexOf("'/dist/registry/probe'") >= 0, '有');
  }

  console.log('== E 反向：判据能识别跨源裸 fetch ==');
  check('E 判据对跨源 fetch 形态有效',
    /\bfetch\(/.test('const r = await fetch(url + "/-/ping");'), 'hit');
  check('E 判据对 await x.y(...) 形态不误报',
    !/\bfetch\(/.test('const r = await supervisorApi.registryProbe(url);'), 'no-false-positive');

  // -- F B8 面板访问密钥闭环--
  // 后端对非回环请求 fail-closed（401），UI 必须：本机存 key（保存成功时落 localStorage、
  // URL ?access_key= bootstrap）、每个请求（http + getText）带 Bearer、401 呈现为
  // 「访问密钥缺失或错误」而非假「离线」。行为细节在 vitest（client.test.ts）；
  // 这里锁**结构闭环**四端齐备，防单端回退。
  console.log('== F B8 访问密钥闭环（client/polling/设置/状态条四端）==');
  {
    const rd = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
    const client = rd('ui/src/services/supervisor/client.ts');
    const polling = rd('ui/src/services/supervisor/polling.ts');
    const card = rd('ui/src/features/supervisor/settings/StartupCard.tsx');
    const app = rd('ui/src/features/supervisor/SupervisorApp.tsx');
    check('F client 导出 setStoredAccessKey 且读头两处齐备（http+getText）',
      /export function setStoredAccessKey/.test(client)
      && (client.match(/readStoredAccessKey\(\)/g) || []).length >= 2, 'ok');
    check('F client 注入 Authorization: Bearer 且 401 错误带 status',
      /["']Authorization["']\]?\s*[:=]\s*["']Bearer ["']\s*\+/.test(client)
      && /err\.status\s*=\s*res\.status/.test(client), 'ok');
    check('F polling 以 status===401 置 authFailed（不再把鉴权失败吞成离线）',
      /=== 401/.test(polling) && /authFailed:/.test(polling), 'ok');
    check('F 保存密钥成功后落本机缓存（StartupCard 按 run 返回值 setStoredAccessKey）',
      /if \(ok\) setStoredAccessKey\(key\)/.test(card), 'ok');
    check('F 状态条呈现 authFailed 专属文案（可操作而非假离线）',
      /authFailed/.test(app) && /访问密钥缺失或错误/.test(app), 'ok');
    // 反向：判据对「不带 key 的旧形态」不误判为已修复（门禁非空转）
    const legacy = 'const init = { method, headers: {}, signal }; throw new Error(msg);';
    check('F 反向：旧无鉴权形态不满足 Bearer 判据',
      !/["']Authorization["']\]?\s*[:=]\s*["']Bearer ["']\s*\+/.test(legacy), 'no-hit');
  }

  // -- G B28/B7-UI 高危动作确认与令牌脱敏--
  // LanPage：window.prompt 令牌录入 -> 脱敏 Dialog；远程控制/公网暴露/FRP 总闸三个
  // 无确认 Switch -> 二次确认；frps authToken 服务端已脱敏（仅 authTokenSet），
  // UI 不得再回填、留空提交必须省略字段（提交 '' 会被后端清除现值）。
  // OverviewPage：停止主干 DSH 需确认。无组件测试设施 -> 锁源码形态。
  console.log('== G B28/B7-UI 确认对话框与 authToken 脱敏 ==');
  {
    const rd = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
    const lan = rd('ui/src/features/supervisor/LanPage.tsx');
    const overview = rd('ui/src/features/supervisor/OverviewPage.tsx');
    const client = rd('ui/src/services/supervisor/client.ts');
    check('G LanPage 不再调用 window.prompt（真实调用形态；注释提及不算）',
      !/window\.prompt\(\s*['"`]/.test(lan), 'ok');
    check('G LanPage 高危开启三处确认（setPendingOn 装载 >=3）+ Dialog 渲染',
      (lan.match(/setPendingOn\(\{/g) || []).length >= 3 && /Dialog open=\{!!pendingOn\}/.test(lan), 'ok');
    check('G LanPage 令牌录入走 password Dialog',
      /Dialog open=\{!!tokenFor\}/.test(lan) && /type="password" autoComplete="new-password" placeholder="输入访问令牌"/.test(lan), 'ok');
    check('G B7-UI 不回填 authToken 且留空省略字段（patch 语义）',
      !/setFrpToken\(frp\.settings\.authToken/.test(lan) && /if \(t\) p\.authToken = t/.test(lan), 'ok');
    check('G B7-UI authToken 占位提示按 authTokenSet 切换',
      /authTokenSet \? "已设置 · 留空不修改，输入即轮换"/.test(lan), 'ok');
    check('G client frpSettings 的 authToken 为可选字段',
      /authToken\?: string/.test(client), 'ok');
    check('G OverviewPage 停止主干 DSH 走确认对话框',
      /setConfirmStopDsh\(true\)/.test(overview) && /Dialog open=\{confirmStopDsh\}/.test(overview), 'ok');
    // 反向：判据对旧形态敏感（门禁非空转）
    check('G 反向：旧 prompt 录入形态会被判据命中',
      /window\.prompt\(\s*['"`]/.test("const t = window.prompt('为该实例设置远程访问令牌：');"), 'hit');
    check('G 反向：旧回填形态会被判据命中',
      /setFrpToken\(frp\.settings\.authToken/.test('setFrpToken(frp.settings.authToken || "");'), 'hit');
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
