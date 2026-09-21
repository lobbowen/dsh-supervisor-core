'use strict';

// process-pool 能力面（mixin）：实例进程治理的契约方法归能力方实现，而非基座抛错占位。
// 判据纪律：调用方以 supports(cap) 守卫，不按 kind 字面量分支——「有没有实例」是能力事实，
// 「是不是反代」是身份标签，二者今天重合、明天（binary 分发/新协议族）不一定。
// POOL_CAPS：instanceLifecycle/warmPool/switchBudget/reconcile/prewarm 为转发/调度既有消费点；
// processPool=伞能力（_stopping 纪律、端口恢复等整组守卫）；gracefulStop=waitAllStopped 在途收敛。
// 本文件方法自 proxy.js 搬移（方法体逐字保留）；池机制的 ctor 接线（重启编排/删账号钩子）
// 一并归入 mixin——消费方 ctor 不再跨文件 this 调池方法，this 图保持单向（DG-4 语义）。

const life = require('./instance-lifecycle');
const restart = require('./restart');
const probe = require('./probe');
const pidlook = require('../../../platform/os/pidlookup');
const ports = require('../../../platform/service/ports').shared;

const POOL_CAPS = ['instanceLifecycle', 'warmPool', 'switchBudget', 'reconcile', 'prewarm',
  'processPool', 'gracefulStop'];

function withProcessPool(Base) {
  return class ProcessPoolMixin extends Base {
    constructor(o) {
      super(o);
      this._restart = restart.createRestartOrchestrator({
        startInstance: (inst) => this.startInstance(inst),
        waitHealthy: (inst) => this._waitHealthy(inst),
        isAlive: (pid) => { try { return pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { return true; } },
        logger: this.logger,
        isStopping: () => this._stopping,
      });
      // 删账号钩子（打破 base 到池的 this.stopInstance 反向边）：释放实例与端口绑定
      this._hooks = this._hooks || {};
      this._hooks.onDiscardAccount = (acc) => {
        if (acc.instance) { try { this.stopInstance(acc.instance); } catch {} }
        try { ports.unregister('proxy:' + acc.keyId); } catch {}
        if (acc.instance) acc.instance.port = null;
      };
    }

    /** 能力声明 = 基座能力与 process-pool 能力的并集。 */
    supports(cap) {
      return POOL_CAPS.includes(cap) || super.supports(cap);
    }

    /** 使用状态在基座（in-use/idle）上派生 warming：实例在场是池能力，覆写归 mixin。 */
    usageOf(acc) {
      const r = super.usageOf(acc);
      if (r !== 'idle') return r;
      const inst = this.instanceOf(acc);
      return inst && inst.pid ? 'warming' : 'idle';
    }

    accountOf(inst) { return this.accounts.find((a) => a.key === inst.key) || null; }

    /** 账号 -> 实例映射（一账号一实例）：usageOf 派生 warming 的依据。 */
    instanceOf(acc) {
      if (!acc) return null;
      return (this.instances || []).find((i) => i.keyId === acc.keyId) || acc.instance || null;
    }

    /** 启动实例：并发去重（startingPromise）+ 全局串行（_startLock，防 npm 缓存锁风暴）。 */
    async startInstance(inst) {
      if (inst.pid) return { ok: true, already: true };
      if (inst.startingPromise) return inst.startingPromise;
      inst.startingPromise = (async () => {
        try {
          const lockWaitStart = Date.now();
          while (this._startLock && Date.now() - lockWaitStart < 30000) { await new Promise((r) => setTimeout(r, 250)); }
          if (this._startLock) return { ok: false, error: '实例启动互斥锁超时（前一次启动未完成）' };
          this._startLock = true;
          try {
            return await this._doStart(inst);
          } finally {
            this._startLock = false;
          }
        } finally {
          inst.startingPromise = null;
        }
      })();
      return inst.startingPromise;
    }

    /** 启动实例底层治理（spawn/探活在 probe.js）。方法在能力面上保持原型可覆写，
     *  测试以 _doStart 打桩替换 spawn；留在 mixin 侧是为了 this 图单向（mixin 不回调消费方方法）。 */
    async _doStart(inst) { return probe.spawnInstance(this, inst); }

    /** 标记实例被请求使用：只记录 lastUsedAt（清零归 markRequestOk，避免熔断计数到不了阈值）。 */
    markUsed(inst) {
      if (!inst) return;
      inst.lastUsedAt = Date.now();
    }

    /** 请求成功后清零失败计数（时机是熔断可达的全部要害）。不触碰健康监测的 _monitorFails。 */
    markRequestOk(inst) {
      if (!inst) return;
      inst._unhealthyCount = 0;
    }

    /** 实例停止（幂等）：在途/在用 -> 标记待停；force 跳过仲裁（委托 instance-lifecycle.js）。 */
    stopInstance(inst, force) { return life.arbitrateStop(this, inst, force); }
    /** 请求结束补刀（委托 instance-lifecycle.js）。 */
    _retryPendingStop(acc) { return life.retryPendingStop(this, acc); }
    async _waitHealthy(inst, tries) { return life.waitHealthy(this, inst, tries); }

    /** 实例重启：在途延后（_restartPending）+ 单实例退避（_restartAt）+ force 停止 + 重拉委托。
     *  退避只在真正执行重启时置位；stop 失败必须可观测（重新记待重启并清退避，不静默黑洞）。 */
    restartInstance(inst, reason) {
      if (!inst || this._stopping) return;
      if (!inst.pid && !inst.port) return;
      if (Date.now() < (inst._restartAt || 0)) return; // 退避中
      const acc = this.accountOf(inst);
      if (acc && (acc.inflight || 0) > 0) {
        inst._restartPending = reason || 'deferred';
        if (this.logger && this.logger.info) this.logger.info('[proxy-instance] 在途请求中，重启延后 key=' + inst.maskedKey + ' reason=' + inst._restartPending);
        return;
      }
      inst._restartAt = Date.now() + 120000; // 仅在真正执行时置退避
      inst._restartPending = null;
      if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 实例重启 key=' + inst.maskedKey + ' port=' + inst.port + ' reason=' + reason);
      const hadPid = !!inst.pid;
      try { this.stopInstance(inst, true); } catch (e) { this.logger.warn && this.logger.warn('[proxy-instance] 重启 stop 异常: ' + (e && e.message)); }
      if (inst.pid) {
        let stillAlive = true;
        try { stillAlive = (typeof pidlook !== 'undefined' && pidlook.isAlive) ? pidlook.isAlive(inst.pid) : true; } catch {}
        if (stillAlive) {
          inst._restartAt = 0;
          inst._restartPending = reason || 'restart-stop-failed';
          if (this.logger && this.logger.warn) this.logger.warn('[proxy-instance] 重启未能停止进程 pid=' + inst.pid + ' key=' + inst.maskedKey + '，已重新记待重启（不静默）');
          return;
        }
      }
      this._restart.respawn(inst, { acc, hadPid });
    }

    /** 请求级熔断：连续 >=2 次报错 -> 重启实例（与健康监测 _monitorFails 独立）。 */
    markInstanceProblem(instOrAcc, reason) {
      try {
        const inst = instOrAcc && instOrAcc.pid ? instOrAcc : null;
        if (!inst) return;
        inst._unhealthyCount = (inst._unhealthyCount || 0) + 1;
        inst.healthy = false;
        inst._lastProblem = reason || 'unknown';
        const failN = inst._unhealthyCount;
        if (failN >= 2) {
          inst._unhealthyCount = 0;
          this.restartInstance(inst, 'req-' + (reason || 'unknown') + ' x' + failN);
        }
      } catch {}
    }

    /** 兼容旧名（保持对外调用不破）。 */
    markInstanceNetFail(instOrAcc) { this.markInstanceProblem(instOrAcc, 'net-error'); }

    /** 实例空闲后补做「被延后的重启」（_restartPending 的消费点，不再只写不读）。 */
    flushRestartPending(inst) {
      if (!inst || !inst._restartPending) return;
      const acc = this.accountOf(inst);
      if (acc && (acc.inflight || 0) > 0) return;
      const why = inst._restartPending;
      inst._restartPending = null;
      if (this.logger && this.logger.info) {
        this.logger.info('[proxy-instance] 实例已空闲，补做延后的重启 key=' + inst.maskedKey + ' reason=' + why);
      }
      try { this.restartInstance(inst, why); } catch (e) {
        this.logger.warn && this.logger.warn('[proxy-instance] 补做重启异常: ' + (e && e.message));
      }
    }

    reconcileInstances(opts) { return restart.reconcileInstances(this, opts); }
  };
}

module.exports = { withProcessPool, POOL_CAPS };
