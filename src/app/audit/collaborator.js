'use strict';

// app/audit/collaborator.js —— Orphan scan 协作方工厂（真 ctor 注入）。
// createOrphanScan(deps) 组合 orphan-scan.orphanAudit，自持抑制状态；deps 全为惰性取值函数（装配期 host 尚未就绪）。
// 返回对象键与 assembly/collaborators.js 的 THIN_SPEC.audit 逐字一致；facets.js 路径与两路径共用同一实现。

const { orphanAudit } = require('./orphan-scan');

function createOrphanScan(deps) {
  const g = deps || {};
  // 可选：外部提供 get/setLastKey|At 时用外部状态（如 host 字段，与 host 方法共享）；
  // 否则用闭包状态（工厂对象自持）。
  const last = { key: null, at: 0 };
  const getLastKey = typeof g.getLastKey === 'function' ? g.getLastKey : () => last.key;
  const setLastKey = typeof g.setLastKey === 'function' ? g.setLastKey : (v) => { last.key = v; };
  const getLastAt = typeof g.getLastAt === 'function' ? g.getLastAt : () => last.at;
  const setLastAt = typeof g.setLastAt === 'function' ? g.setLastAt : (v) => { last.at = v; };
  return {
    orphan() {
      return orphanAudit({
        getConfig: g.getConfig,
        getLogger: g.getLogger,
        getEvents: g.getEvents,
        getInstances: g.getInstances,
        getManagedObjects: g.getManagedObjects,
        getCtl: g.getCtl,
        getDaemons: g.getDaemons,
        getStopping: g.getStopping,
        getLastKey, setLastKey, getLastAt, setLastAt,
      });
    },
  };
}

module.exports = { createOrphanScan };
