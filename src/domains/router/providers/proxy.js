'use strict';

// 反代供应商：账号=代理实例（进程），每账号一个实例（硬规则）。process-pool 契约方法
// （启停/重启/熔断/对账入口）在 process-pool.js mixin；本文件留 ctor、账号生命周期钩子与
// 池/探测/命令委托：命令拼装归 command.js，实例池决策归 pool.js，spawn/探活/配额探测归
// probe.js，重启重拉/对账归 restart.js，冻结/解冻状态机归 base.js 与 freeze.js。

const { ProviderBase } = require('./base');
const { withProcessPool } = require('./process-pool');
const { keyFingerprint, maskKey } = require('./model');
const { ProxyInstance } = require('../model');
require('../port-segments'); // 本域端口段/独立池申报（require 即注入）
const { npxBin } = require('../../../platform/os/exec-path');
const { buildCommand } = require('./command');
const probe = require('./probe');
const restart = require('./restart');
const poolPolicy = require('./pool');
const life = require('./instance-lifecycle');

class ProxyProvider extends withProcessPool(ProviderBase) {
  constructor(opts) {
    super(opts);
    this.kind = 'proxy';
    this.proxyAppId = opts.proxyAppId;
    this.app = opts.app || null;
    this.stateDir = opts.stateDir || null; // 数据目录（config.stateFile 派生）：日志落这里
    this.proxyRunning = false;
    this.instances = [];
    this.selectedAccountKeyId = null;
    this._startLock = false; // 实例启动互斥：一次只 spawn 一个 npx
    this._stopping = false; // 关停标记：stop() 前置真，期间不预启动
    this._terminatingPids = new Set(); // 停服台账：已发 SIGTERM 的子进程 pid
    this._pool = poolPolicy.createPoolPolicy({ getConfig: () => this.config });
    // 重启编排器与删账号钩子在 withProcessPool 的 mixin ctor 装配（process-pool.js）。
  }

  /** 能力声明：基座与 process-pool 的并集在 withProcessPool mixin 完成（process-pool.js）。 */

  async ensureInstance(key) {
    let inst = this.instances.find((i) => i.key === key);
    if (inst) return inst;
    inst = new ProxyInstance({ key, keyId: keyFingerprint(key), maskedKey: maskKey(key), app: this.app, logger: this.logger, events: this.events });
    this.instances.push(inst);
    return inst;
  }

  /** 解析启动命令（缓存优先 + fallback npx）：纯拼装委托 command.js，凭证剔除留在本层（纪律）。 */
  async _resolveLaunchCommand(app, port, key) {
    const registry = this.dist ? await this.dist.selectRegistry(false).catch(() => null) : null;
    const cachedBin = this._cachedPkgBin(app.pkg);
    const launch = buildCommand({ app, port, cachedBin, registry, npxBin: npxBin(), execPath: process.execPath });
    if (!launch || !launch.ok) return launch || { ok: false, error: '命令拼装失败' };
    // 凭证纪律：key 只经 env（app.keyEnv），argv 必须剔除 --api-key 及其值与 {{key}} 占位
    const cmd = [];
    for (let i = 0; i < launch.cmd.length; i++) {
      const t = launch.cmd[i];
      if (t === '--api-key') { i++; continue; }
      if (String(t).includes('{{key}}')) continue;
      cmd.push(t);
    }
    return { ok: true, cmd, registry: launch.registry };
  }

  _cachedPkgBin(pkg) { return probe.cachedPkgBin(pkg); }
  _ensurePkgCached(app) { return probe.ensurePkgCached(this, app); }

  /** 实例停止仲裁（委托 instance-lifecycle.js）。 */
  _canStopInstance(acc) { return life.canStopInstance(this, acc); }

  /** 等待全部 SIGTERM 在途子进程真正退出（实现与 zombie 判定在 probe.js）。 */
  async waitAllStopped(timeoutMs) { return probe.waitAllStopped(this, timeoutMs); }

  /** 实例探活（探活实现与计数分层在 probe.js，计数各归其主）。 */
  async healthInstance(inst) { return probe.healthInstance(this, inst); }

  /** 实例生命周期监控（进程/端口/HTTP 卡死检测）。 */
  async monitorLifecycle() { return probe.monitorLifecycle(this); }

  /** 模式级配额检测（策略注册与解析在 probe.js + quota-strategies.js）。 */
  async detectInstanceQuota(inst) { return probe.detectInstanceQuota(this, inst); }

  async addAccount(key, extra) { return life.addAccount(this, key, extra); }
  isAccountUsable(acc, opts) { return life.isAccountUsable(this, acc, opts); }
  /** 停掉账号实例（委托 instance-lifecycle.js）。 */
  _stopInstanceIfAny(acc) { return life.stopInstanceIfAny(this, acc); }

  /** 429/403 配额触发冻结：先停实例，再状态机，再对账补备胎 + 异步补探测。 */
  markQuotaExhausted(acc, cooldownMs) {
    this._stopInstanceIfAny(acc);
    super.markQuotaExhausted(acc, cooldownMs);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  /** credits 余额不足：与窗口同一处置（停实例 + 冻结 + 对账补备胎）。 */
  markCreditsExhausted(acc) {
    this._stopInstanceIfAny(acc);
    super.markCreditsExhausted(acc);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  _probeAfterResponseFreeze(acc) { return probe.probeAfterResponseFreeze(this, acc); }

  // 实例池策略（纯决策在 pool.js，此处读 provider 状态并落 sticky）
  _quotaPercent(acc) { return poolPolicy.quotaPercent(acc); }

  residentAccount() {
    const r = this._pool.residentAccount({
      accounts: this.accounts,
      selectedAccountKeyId: this.selectedAccountKeyId,
      activeKeyId: this.activeAccount && this.activeAccount.keyId,
      residentKeyId: this._residentKeyId,
      isUsable: (a) => this.isAccountUsable(a),
    });
    if (r.resident) this._residentKeyId = r.residentKeyId; // 内存 sticky：空闲后回到同一账号
    return r.resident;
  }

  _limits() { return this._pool.limits(); }
  _switchBudgetMs() { return this._pool.switchBudgetMs(); }
  _stateCounts() { return this._pool.stateCounts(this.instances); }

  _needSpare() {
    return this._pool.needSpare({ resident: this.residentAccount(), limits: this._limits(), counts: this._stateCounts(), instances: this.instances });
  }

  desiredRunningAccounts() {
    const resident = this.residentAccount();
    return this._pool.desiredRunningAccounts({
      accounts: this.accounts, resident, limits: this._limits(), needSpare: this._needSpare(),
      isUsable: (a) => this.isAccountUsable(a),
    });
  }

  prewarmAsync(acc) { return restart.prewarmAsync(this, acc); }
  _runReconcile(allowStop) { return restart.runReconcile(this, allowStop); }
  reconcileNow() { return restart.reconcileNow(this); }
  isDesiredAccount(acc) { return poolPolicy.isDesired(this.desiredRunningAccounts(), acc); }

  /** 封号：停掉实例（不再消耗资源），再更新状态机。 */
  markBanned(acc, error) {
    this._stopInstanceIfAny(acc);
    super.markBanned(acc, error);
  }
}

module.exports = { ProxyProvider };
