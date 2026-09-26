'use strict';

// 宿主状态守卫：某些测试会**真的**改动运行机器的登录态（例：setGuiAutostart(false) 在
//   Linux 上 unlink ~/.config/autostart 条目、在 macOS 上跑 launchctl bootout）。
//   这类测试此前只在注释里写「本机别跑」—— 靠自律不算执法，故此处改为代码守卫：
//   非 CI 且未显式设 DSH_TEST_SANDBOX=1 时直接判红退出，而不是悄悄污染开发者机器。

const SANDBOX_ONLY = 'SANDBOX-ONLY';

/** @param file 触发守卫的测试文件名（仅用于报错定位） @param what 会改动的宿主状态 */
function requireHostSandbox(file, what) {
  if (process.env.CI === 'true' || process.env.DSH_TEST_SANDBOX === '1') return true;
  console.log('FAIL ' + file + ' 需要隔离宿主环境：' + what);
  console.log('  该测试会改动本机的登录态。' + SANDBOX_ONLY + '：CI runner 上自动放行，'
    + '本机排查请显式设 DSH_TEST_SANDBOX=1（自担风险）。');
  process.exit(1);
}

module.exports = { requireHostSandbox, SANDBOX_ONLY };
