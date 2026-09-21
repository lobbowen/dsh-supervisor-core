'use strict';

// 远程控制编排主体（LanManager）：多实例反向代理（relay）+ 公网隧道（frpc），
// 访问形态由每实例单一 remoteMode（off|lan|wan）驱动。
// 单一数据源是实例存储（沙箱 instances.json + main dsh-main.json），lanInstances 只是
// syncProxy 维护的内存派生缓存；依赖 managed / ports / proxy / frp / core（单向，见 index.js 门面注释）。

const managed = require('./managed');
const portsvc = require('./ports');
const { FrpManager } = require('./frp');
const { normalizeRemoteMode, validateWanAccess, normalizeFrpSettings, validateFrpServerSettings, projectRemoteView } = require('./core');
const reconcile = require('./ops/reconcile');
const lanServers = require('./ops/lan-servers');

/** 令牌变化热换到已在运行的 relay（快路径）。返回是否实际下发。 */
function applyRelayToken(host, existing, want) {
  const s = host._lanServers && host._lanServers[existing.id];
  if (!s || typeof s.setToken !== 'function') return false;
  try { s.setToken(want); } catch {}
  existing.token = want;
  if (host.events) host.events.append('lan_token_updated', { id: existing.id, tokenSet: !!want });
  // frp 公网隧道闸依赖 remoteToken：令牌清空后既有隧道必须随之收敛
  // （syncFrpc 内 validateWanAccess 复判，不过闸者跳过并停 frpc）。
  host.syncFrpc();
  return true;
}

/** 端口绑定被盗回调（claim 的 onBindingLost）。 */
function onRelayBindingLost(host, inst, e) {
  if (host.events) { try { host.events.append('lan_binding_lost', e); } catch {} }
  if (host.logger && host.logger.warn) host.logger.warn('[syncProxy] ' + inst.id + ' 绑定被盗：' + e.from + ' → 迁移 ' + e.to);
}

class LanManager {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.instances = opts.instances; // InstanceManager（沙箱实例配置单一数据源）
    this.configPath = opts.configPath || ''; // 端口回收 reclaimCfg 精确匹配——防误杀其它配置的 lan-daemon
    this.mainOf = opts.mainOf || null; // 守卫核心服务的原生主干视图
    this.persist = opts.persist || null; // 持久化路由：沙箱写 instances.save()，main 变更写守卫 dsh-main.json
    // frp 托管经 ctor 注入（默认真实实现）：替身价值高，单测可给假 frp。
    this.frp = opts.frp || new FrpManager({ dir: opts.stateDir, logger: this.logger, events: this.events });
    this.lanInstances = []; // [{ id, name, dshPort, wanPort, token, remoteMode }]（派生缓存）
    this._reconcileInFlight = null; // 对账单飞：避免 2s 节拍叠加串行 TCP 探测
    this._lanServers = {};   // id -> http.Server（relay）
    // 令牌只读来源（DshTokenService 注入）：不持久化令牌副本，一律按需 tokenOf。
    this.tokenOf = opts.tokenOf || (() => '');
    this._proxyChain = Promise.resolve(); // 代理同步串行队列（防并发竞态拿同端口）
  }

  localAddresses() { return managed.localAddresses(); }
  /** 持久化：优先注入的路由(persist)，否则回退沙箱实例 save。 */
  _saveAll() {
    if (typeof this.persist === 'function') { try { this.persist(); } catch (e) { this.logger && this.logger.warn && this.logger.warn('lan persist: ' + (e && e.message)); } return; }
    if (this.instances && typeof this.instances.save === 'function') { try { this.instances.save(); } catch {} }
  }
  /** 受管 DSH 合成清单：沙箱实例 + 原生主干 main。 */
  _allManaged() { return managed.allManaged({ instances: this.instances, mainOf: this.mainOf }); }
  /** 合成查找：按 id 取首个匹配（清单无同 id 项，见 managed.js#allManaged）。 */
  _findManaged(id) { return managed.findManaged(this._allManaged(), id); }
  /** frpc 子进程句柄只读访问器（daemon 优雅停机等待其退出；不暴露内部 frp 私有对象）。 */
  frpChild() { return (this.frp && this.frp.child) || null; }

  list() {
    this.reconcile().catch(() => {}); // 对账异步执行：剔除孤儿/陈旧代理（不阻塞 list 响应）
    const addresses = this.localAddresses();
    const insts = this._allManaged();
    const remoteInsts = insts.filter((x) => normalizeRemoteMode(x.remoteMode) !== 'off');
    // 幂等自愈：非 off 实例异步补建代理（不可达由 syncProxy 内 TCP 裁决跳过）。
    for (const inst of remoteInsts) {
      if (!this.lanInstances.some((p) => p.dshPort === inst.port)) {
        this._syncProxyQueued(inst).catch((e) => this.logger.warn && this.logger.warn('syncProxy failed: ' + e.message));
      }
    }
    const frpSt = this.frp ? this.frp.status() : { running: false, settings: {} };
    const items = remoteInsts.map((inst) => {
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      const srv = this._lanServers && this._lanServers[inst.id];
      const st = (srv && typeof srv.status === 'function') ? srv.status() : null;
      const inject = st ? {
        tokenSet: !!st.tokenSet, cookieReady: !!st.cookieReady,
        lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, lastErrorAt: st.lastErrorAt || null,
      } : null;
      const remote = projectRemoteView({
        mode: normalizeRemoteMode(inst.remoteMode),
        relayListening: !!(this._lanServers && this._lanServers[inst.id]),
        tokenSet: !!String(inst.remoteToken || '').trim(),
        cookieReady: !!(st && st.cookieReady),
        frpcRunning: !!frpSt.running,
        serverAddr: (frpSt.settings && frpSt.settings.serverAddr) || '',
        lanAddress: addresses[0] || '',
        wanPort: proxy ? proxy.wanPort : null,
      });
      return {
        id: inst.id, name: inst.name, dshPort: inst.port,
        wanPort: proxy ? proxy.wanPort : null,
        token: inst.remoteToken || '',
        dshToken: this.tokenOf(inst.id) || '', // 令牌一律按需从令牌池读取
        running: !!this._lanServers && !!this._lanServers[inst.id],
        inject, remote,
      };
    });
    return { items, addresses };
  }
  frpStatus() {
    const st = this.frp ? this.frp.status() : { installed: false, running: false };
    const insts = this._allManaged();
    st.instancesExposed = insts
      .filter((x) => normalizeRemoteMode(x.remoteMode) === 'wan')
      .map((x) => {
        const proxy = this.lanInstances.find((p) => p.dshPort === x.port);
        return { id: x.id, name: x.name, port: proxy ? proxy.wanPort : null };
      });
    return st;
  }
  /** frpc 操作门面（settings/install 统一入口；总闸已随三态模型废止）。 */
  async frpAction(action, body) {
    const j = body || {};
    if (action === 'settings') {
      const cur = this.frp ? this.frp.loadSettings() : {};
      const next = normalizeFrpSettings(j, cur);
      // 写前一致性：serverAddr 为空但仍有 wan 意图时拒存（否则隧道静默失效）；
      // 无 wan 实例时允许保存空地址（纯配置编辑）。
      if (!String(next.serverAddr || '').trim() && this._hasWanIntent()) {
        return { ok: false, error: validateFrpServerSettings(next).error };
      }
      if (this.frp) this.frp.saveSettings(next);
      this.syncFrpc();
      return { ok: true, ...this.frpStatus() };
    }
    if (action === 'install') {
      if (!this.frp) return { ok: false, error: 'frpmgr 不可用' };
      return this.frp.install((msg) => { try { this.logger.info('[frpc] ' + msg); } catch {} });
    }
    return { ok: false, error: '未知 frp 操作: ' + action };
  }
  /** 受管清单是否存在 wan 意图（配置闸用：含尚未建立代理的实例，磁盘态即算）。 */
  _hasWanIntent() {
    return this._allManaged().some((x) => normalizeRemoteMode(x.remoteMode) === 'wan');
  }
  /** 实例变化后同步 frpc 配置与进程（尽力而为，不抛异常影响主流程）。
   *  执行边界复校 wan 闸：写入口（setRemoteMode 动作）已过 core.validateWanAccess，但冷启动
   *  是直接按磁盘态组装隧道 —— 历史遗留的「wan 态但远程令牌为空」会绕开写侧闸，在网络
   *  边界重现公网零认证暴露。故建隧道前对每个 wan 项复用同一事实源复校，不过闸即跳过该隧道。 */
  syncFrpc() {
    if (!this.frp) return;
    try {
      const all = this.lanInstances || [];
      const safe = all.filter((inst) => {
        if (normalizeRemoteMode(inst.remoteMode) !== 'wan') return true;
        const v = validateWanAccess({ remoteToken: String(inst.token || '') });
        if (!v.ok) {
          if (this.logger && this.logger.warn) this.logger.warn('[frpc] 实例 ' + inst.id + ' 公网访问未过闸，已跳过建隧道：' + v.error);
          if (this.events) this.events.append('lan_frp_blocked', { id: inst.id, reason: v.error });
          return false;
        }
        return true;
      });
      const r = this.frp.syncFromInstances(safe);
      if (r && r.needInstall) this.logger.info && this.logger.info('frpc not installed; WAN exposure pending install');
    } catch (e) {
      this.logger.warn && this.logger.warn('frpc sync failed: ' + e.message);
    }
  }
  /** 远程代理对账：注册只与「remoteMode!=off」绑定；relay 运行 = 目标存活；孤儿注册移除。
   *  单飞：对账内含逐实例串行 await targetReachable（每个最多 600ms），而被 2 秒级节拍多次触发；
   *  同刻只允许一轮在跑，后续调用复用同一在途 Promise。
   *  刻意不加 async：async 会把返回值包一层新 Promise，单飞身份丢失。 */
  reconcile() {
    if (this._reconcileInFlight) return this._reconcileInFlight;
    this._reconcileInFlight = this._reconcileOnce()
      .catch((e) => { this.logger.warn && this.logger.warn('[reconcile] ' + ((e && e.message) || e)); })
      .finally(() => { this._reconcileInFlight = null; });
    return this._reconcileInFlight;
  }
  /** 对账主体（委托 ops/reconcile.js；具名保留：单飞包装与门禁按此名调用）。 */
  async _reconcileOnce() { return reconcile.reconcileOnce(this); }
  /** 目标实例是否可达（委托 ops/reconcile.js）。 */
  targetReachable(inst) { return reconcile.targetReachable(inst); }
  /** 串行执行 syncProxy（队列）。 */
  _syncProxyQueued(inst) { return reconcile.syncProxyQueued(this, inst); }
  /** 删除某实例关联的局域网代理（实例被删除时调用）。 */
  async removeProxyForInstance(instId) { return reconcile.removeProxyForInstance(this, instId); }

  /** 同步某实例的远程访问代理：remoteMode!=off 且目标在监听时创建 relay，off 拆除。
   *  wan 不引入第二监听/第二端口：隧道口与 relay 口恒同号（core.buildFrpcToml）。
   *  端口绑定唯一权威是 relay 槽位注册表（byOwner 复用）；实例记录不存 wanPort 镜像。 */
  async syncProxy(inst) {
    if (!inst) return;
    const mode = normalizeRemoteMode(inst.remoteMode);
    if (mode !== 'off') {
      const owner = 'relay:' + inst.id;
      // 已登记且端口有效：确保 server 在跑后直接返回（幂等，不重分配）。
      const existing = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (existing && existing.wanPort) {
        const srv = this._lanServers && this._lanServers[inst.id];
        if (!srv) this._startLanServer(existing);
        // 令牌变化必须热换到已在运行的 relay，否则旧快路径直接 return 会让令牌无声残留。
        const want = String(inst.remoteToken || '');
        if (existing.token !== want) applyRelayToken(this, existing, want);
        // 模式变化（lan<->wan）热收敛：隧道随 mode 增删。
        if (existing.remoteMode !== mode) {
          existing.remoteMode = mode;
          this.syncFrpc();
        }
        return;
      }
      // 目标必须真的在监听（TCP 可达），否则代理无意义且会白占端口。
      if (!(await this.targetReachable(inst))) return;
      // 确定性槽位仲裁：绑定记忆在注册表 byOwner（claim 自动复用）；main 无绑定时的建议槽位派生自池定义（禁池外硬编码）。
      const relayPool = portsvc.rangeOf('relay');
      const slot = await portsvc.claim('relay', owner, {
        preferred: !existing && inst.id === 'main' ? relayPool.base : undefined,
        onBindingLost: (e) => onRelayBindingLost(this, inst, e),
        configPath: this.configPath,
      });
      if (!slot || slot.conflict) {
        if (this.logger && this.logger.warn) this.logger.warn('[syncProxy] ' + inst.id + ' relay 槽位冲突（' + (slot && slot.port) + ' 被外部占用且无法回收），不静默跳号，等待下轮');
        return;
      }
      const wanPort = slot.port;
      // 换绑/迁移前：关闭该实例旧端口仍在跑的 server（防同进程新旧两族监听并存）。
      const oldSrv = this._lanServers && this._lanServers[inst.id];
      const oldPort = existing && existing.wanPort;
      if (oldSrv && oldPort && oldPort !== wanPort) {
        try { oldSrv.close(() => {}); } catch {}
        try { if (typeof oldSrv.closeAllConnections === 'function') oldSrv.closeAllConnections(); } catch {}
        delete this._lanServers[inst.id];
        if (this.logger && this.logger.info) this.logger.info('[syncProxy] ' + inst.id + ' 关闭旧端口 ' + oldPort + ' server（换绑 ' + wanPort + '）');
      }
      // 注册表单 owner 单记录：清重复残留（真源唯一）。
      portsvc.purgeDuplicates(owner, wanPort);
      portsvc.ensureMarked(wanPort, owner);
      // 不把 dshToken 放进代理条目；消费方需要时经 tokenOf 按需取。
      const proxyInst = { id: inst.id, name: inst.name, dshPort: inst.port, wanPort, token: inst.remoteToken || '', remoteMode: mode };
      if (existing) { Object.assign(existing, proxyInst); }
      else this.lanInstances.push(proxyInst);
      this._startLanServer(existing || proxyInst);
      if (this.events) this.events.append('lan_instance_added', { id: inst.id, name: inst.name, dshPort: inst.port, wanPort });
      this.syncFrpc();
    } else {
      // 关闭远程：停 relay 并移除派生缓存条目——注册表绑定保留（再开复用同一端口，
      // 端口唯一权威即注册表，实例记录不再有 wanPort 镜像）。
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (proxy) {
        this._stopLanServer(proxy.id);
        this.lanInstances = this.lanInstances.filter((p) => p.id !== proxy.id);
        if (this.events) this.events.append('lan_instance_removed', { id: proxy.id, reason: 'disabled' });
        this.syncFrpc();
      }
    }
  }
  /** 实例启动时联动远程代理（委托 ops/reconcile.js）。 */
  async instanceStart(inst) { return reconcile.instanceStart(this, inst); }
  /** 实例停止时联动远程代理（委托 ops/reconcile.js）。 */
  instanceStop(inst) { return reconcile.instanceStop(this, inst); }
  _startLanServer(inst) { return lanServers.startLanServer(this, inst); }
  _stopLanServer(id) { return lanServers.stopLanServer(this, id); }
  /** 守卫优雅退出时调用（委托 ops/lan-servers.js）。 */
  shutdown() { return lanServers.shutdown(this); }
  /** 令牌变化经 onChange 下发（委托 ops/lan-servers.js）。 */
  applyToken(instId) { return lanServers.applyToken(this, instId); }
}

module.exports = { LanManager };
