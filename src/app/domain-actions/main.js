'use strict';

// app/domain-actions/main.js —— 原生 DSH(main) 域写动作（facade 只读，写动作下沉至此）。
// 导出形态 { createMainActions(deps) }：**原地去 this**（P6-B-3），实现只经注入的惰性 deps 取事实，
// 故可只 require 本模块 + 假 deps 直接断言。装配侧（app/assembly/facets.js）仍把返回的方法
// **平铺**装到 host，故 api 的 sup.patchDshMain 消费面与方法语义不变。
// 本补丁只持守卫元数据（guardian）；远程控制意图（remoteMode/remoteToken）的唯一写入口在
// app/domain-actions/lan.js#setRemoteMode/setRemoteToken（main 与沙箱同口），不再经设置面旁路。

/** patchDshMain 工厂。
 *  @param deps { getState, getViews, getLogger } 全为惰性取值。 */
function createMainActions(deps) {
  const g = deps || {};
  return {

    /** main 元数据补丁(白名单: guardian)。 */
    patchDshMain(patch) {
      const p = patch || {};
      const state = g.getState();
      const meta = state.readMainMeta();
      const prev = { ...meta };
      if (p.guardian !== undefined) meta.guardian = !!p.guardian;
      state.writeMainMeta(meta);
      // 开关变更事件：所有 main 开关记录进事件日志，可审计回放
      try {
        const events = g.getEvents();
        if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
          events.append('dsh_guardian_changed', { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
        }
      } catch (e) { const logger = g.getLogger(); logger && logger.warn && logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
      return { ok: true, main: g.getViews().dshMain() };
    },
  };
}

module.exports = { createMainActions };
