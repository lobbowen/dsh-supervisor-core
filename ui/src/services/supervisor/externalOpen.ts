/** 面板侧「把地址交到浏览器」的唯一出口（外部打开结果的呈现口径也在此，页面不得各自分档）。
 *
 *  为什么面板还需要自己的一条路：内核的 openBrowser 已负责真正调起浏览器，但面板上呈现的地址
 *  （一次性码地址、OAuth 授权地址）在**内核报不出确认**时必须仍可点击/可复制。
 *  面板运行在桌面壳的内容 iframe 里，Tauri IPC 只注入主帧、webview 默认丢弃 window.open 与
 *  target=_blank，故请壳代开走 postMessage 桥（与 kernelUpdateBridge 同一通道、同一来源校验口径；
 *  协议版本常量单一来源在 kernelUpdateBridge.ts，壳侧 bridge.rs 的同名常量必须与之一致）。
 */
import { BRIDGE_PROTOCOL_VERSION, hasShellHost } from "./kernelUpdateBridge";
import type { OpenExternalResult } from "./types";

export const MSG_OPEN_URL = "dsh:open-url";
export const MSG_OPEN_URL_RESULT = "dsh:open-url-result";

/** 等壳回执的上界：壳不认这条消息（旧版壳）时不能把用户晾着，到点即降级为「请复制地址」。 */
export const SHELL_OPEN_ACK_MS = 2500;

export type HandOff = { via: "shell" | "window" | "none"; ok: boolean; error?: string | null };

/** 请桌面壳用系统默认浏览器打开该地址。新壳回 ack，旧壳不回即判 ok:false（绝不把「已发出请求」说成「已打开」）。 */
export function requestShellOpen(url: string, timeoutMs = SHELL_OPEN_ACK_MS): Promise<HandOff> {
  return new Promise((resolve) => {
    if (!hasShellHost()) { resolve({ via: "none", ok: false, error: "不在桌面壳内" }); return; }
    const requestId = "openu-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    let done = false;
    const finish = (r: HandOff) => { if (done) return; done = true; window.removeEventListener("message", onMessage); clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => finish({ via: "shell", ok: false, error: "桌面壳未回执（可能为旧版本），请复制或手动打开" }), timeoutMs);
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null;
      // 来源硬判据与内核更新桥同一条：能向本帧派发 message 的上下文不止壳。
      if (!d || typeof d !== "object" || ev.source !== window.parent) return;
      if (d.v !== BRIDGE_PROTOCOL_VERSION || d.type !== MSG_OPEN_URL_RESULT || d.requestId !== requestId) return;
      finish({ via: "shell", ok: d.ok === true, error: typeof d.error === "string" ? d.error : null });
    };
    window.addEventListener("message", onMessage);
    try {
      window.parent.postMessage({ v: BRIDGE_PROTOCOL_VERSION, type: MSG_OPEN_URL, requestId, url }, "*");
    } catch (e) {
      finish({ via: "shell", ok: false, error: String(e) });
    }
  });
}

/** 面板直接跑在浏览器里（非壳内）时的通道：window.open 被弹窗拦截时返回 ok:false。 */
export function openViaWindow(url: string): HandOff {
  try {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    return { via: "window", ok: !!w, error: w ? null : "浏览器拦截了新窗口" };
  } catch (e) {
    return { via: "window", ok: false, error: String(e) };
  }
}

/** 用户在面板里点一条地址时的统一入口：壳内请壳代开，壳外走 window.open。 */
export async function handOffFromPanel(url: string): Promise<HandOff> {
  if (!url) return { via: "none", ok: false, error: "没有可打开的地址" };
  if (hasShellHost()) return requestShellOpen(url);
  return openViaWindow(url);
}

export type OpenTier = "confirmed" | "handed-off" | "failed";

/** 结果分档（纯函数）：内核三档语义在此唯一一次映射为界面档位。
 *  判据取 ok/confirmed，不取 message/error 文本 —— 文案可变，档位是契约。 */
export function classifyOpenResult(r?: OpenExternalResult | null): { tier: OpenTier; url: string | null; title: string } {
  const url = typeof r?.url === "string" && r.url ? r.url : null;
  if (!r || r.ok !== true) {
    return { tier: "failed", url, title: (r && r.error) || "无法调起系统浏览器，请手动打开下方地址" };
  }
  if (r.confirmed === true) return { tier: "confirmed", url, title: r.message || "已在系统浏览器打开" };
  return {
    tier: "handed-off", url,
    title: "地址已交给系统，但无法确认浏览器窗口是否出现" + (url ? "：没看到窗口请复制或手动打开" : ""),
  };
}
