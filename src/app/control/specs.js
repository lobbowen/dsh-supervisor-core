'use strict';

// app/control/specs.js —— 受管对象申报工厂（真 ctor 注入）：createSpecs(deps) 自己持有
// 申报/注册实现，只 require 本模块 + 假 deps 即可直测。

const os = require('node:os');
const path = require('node:path');
const { daemonScript } = require('../daemons/scripts');

function createSpecs(deps) {
  const g = deps || {};
  const state = () => (typeof g.getState === 'function' ? g.getState() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const instances = () => (typeof g.getInstances === 'function' ? g.getInstances() : null);
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const ctl = () => (typeof g.getCtl === 'function' ? g.getCtl() : null);
  const daemons = () => (typeof g.getDaemons === 'function' ? g.getDaemons() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);

  /** main(dsh) 申报为管家注册项。 */
  function mainSpec() {
    const m = state().readMainMeta();
    return {
      kind: 'dsh', id: 'main', name: '主实例',
      desired: state().desired() === 'stopped' ? 'stopped' : 'running',
      guardian: m.guardian === true,
      ownership: {
        ports: [{ role: 'dsh-main', port: Number(config().targetPort || 3080) }],
        rootPath: path.join(os.homedir(), '.dsh'),
        processMode: 'spawn',
      },
    };
  }

  /** 单个沙箱实例申报。 */
  function sandboxSpec(inst) {
    if (!inst || !inst.id) return null;
    const phase = inst.state && inst.state.phase;
    const running = phase === 'RUNNING' || phase === 'STARTING' || phase === 'INSTALLING';
    let rootPath = null;
    const im = instances();
    try { if (im && typeof im.sandboxRoot === 'function') rootPath = im.sandboxRoot(inst); } catch {}
    return {
      kind: 'sandbox-instance', id: inst.id, name: String(inst.name || inst.id),
      desired: running ? 'running' : 'stopped',
      guardian: inst.guardian === true,
      ownership: {
        ports: [{ role: 'inst', port: Number(inst.port) }],
        rootPath,
        unit: 'dsh-web@' + inst.id,
        processMode: 'systemd',
      },
    };
  }

  /** 申报或更新（存在->update 应然；否则 register）。keepDesired 供观测推导路径（心跳同步/启动对齐）：
   *  由实然推出的 desired 不得写回目录（契约 M-1）——崩溃进 BACKOFF 的实例会被每拍 upsert 把用户的
   *  running 意图静默抹掉且无人恢复；意图唯一写口是 start()/stop() 与动作路径。旗标只作用 update 分支。 */
  function upsert(spec, opts) {
    const m = reg();
    if (!m || !spec) return;
    const keepDesired = !!(opts && opts.keepDesired);
    try {
      const existing = m.get(spec.id);
      if (existing) m.update(spec.id, { desired: keepDesired ? undefined : spec.desired, guardian: spec.guardian, name: spec.name, ownership: spec.ownership });
      else m.register(spec);
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_upsertManaged(' + (spec && spec.id) + '): ' + (e && e.message));
    }
  }

  function unregister(id) {
    const m = reg();
    if (!m || !id) return;
    try { m.unregister(id); } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_unregisterManaged(' + id + '): ' + (e && e.message));
    }
  }

  /** 启动对齐：main + 全部沙箱 + router/lan daemon 申报入册（幂等）。 */
  function syncManagedRegistry() {
    const m = reg();
    if (!m) return;
    try {
      upsert(mainSpec());
      const _m = instances();
      const sandboxes = (_m && typeof _m.all === 'function' && _m.all()) || [];
      for (const inst of sandboxes) {
        if (inst.id === 'main' || inst.domain === 'native') continue;
        // 启动对齐同样不得回写 desired：load() 后的 state.phase 是实然快照
        // （BACKOFF/FAILED/STOPPED 一律推导成 stopped），守卫重启恰逢实例退避时
        // 会把用户运行意图抹掉。
        upsert(sandboxSpec(inst), { keepDesired: true });
      }
      // 域 B 基础设施（router/lan daemon）不写 guardian（契约 G-1）；desired 由配置业务条件驱动。
      const c = ctl();
      upsert({
        kind: 'router-daemon', id: 'router-daemon', name: '智能路由 daemon',
        desired: config().routerAutostart === true ? 'running' : 'stopped',
        ownership: {
          daemonScript: daemonScript('router'),
          ports: [{ role: 'ctl', port: c.routerPort() }],
          processMode: 'daemon',
        },
      });
      const d = daemons();
      upsert({
        kind: 'lan-daemon', id: 'lan-daemon', name: '远程控制 daemon',
        desired: d.enabled() ? 'running' : 'stopped',
        ownership: {
          daemonScript: daemonScript('lan'),
          ports: [{ role: 'ctl', port: c.lanPort() }],
          processMode: 'daemon',
        },
      });
      const l = logger();
      if (l && l.info) l.info('[registry] 受管对象已申报: ' + m.list().map((o) => o.kind + ':' + o.id).join(','));
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_syncManagedRegistry: ' + (e && e.message));
    }
  }

  return { mainSpec, sandboxSpec, upsert, unregister, syncManagedRegistry };
}

module.exports = { createSpecs };
