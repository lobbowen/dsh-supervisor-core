/** 面板侧「把地址交给系统浏览器」的唯一入口（结果如何呈现的唯一出口在 openExternal.tsx）。
 *
 *  为什么面板还要选路：面板由内核自己托管，故「页面来源是否回环」等价于「看面板的浏览器与内核是否
 *  同一台机器」。同一台机器时打开动作**必须**由内核执行 —— 桌面壳的 webview 丢弃 window.open 与
 *  target=_blank（旧形态表现为按钮毫无反应），且只有内核能给出三档证据。不同机器时（局域网/公网访问者）
 *  内核无法打开访客自己的浏览器，只剩访客浏览器的原生新标签。
 *  两条路的结局一律归一成 OpenExternalResult，界面上不存在第二种说法。
 */
import { supervisorApi } from "./client";
import type { OpenExternalResult } from "./types";

/** 面板是否由本机内核托管；与内核 /env/open-url 的 identity.loopback 判的是同一件事。 */
export function servedByKernelHost(): boolean {
  const h = String(window.location.hostname || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1" || /^127\./.test(h);
}

/** 访客自己的浏览器（非回环来源）：被弹窗拦截时 open 返回 null，那是失败不是成功。
 *  用户手势内拿到窗口句柄即浏览器接收了导航（新标签就在访客眼前），故算 confirmed，
 *  但证据只到「浏览器认了这条路」，不得冒领内核那一侧的进程退出取证。 */
export function openViaWindow(url: string): OpenExternalResult {
  try {
    const w = window.open(url, "_blank", "noopener,noreferrer");
    return w
      ? { ok: true, confirmed: true, handedOff: false, url, message: "已在新标签打开", evidence: { via: "window" } }
      : { ok: false, url, error: "浏览器拦截了新窗口，请允许弹窗或复制下方地址打开" };
  } catch (e) {
    return { ok: false, url, error: String(e) };
  }
}

/** 用户在面板里点一条地址时的统一入口：本机内核托管则请内核开浏览器，否则用访客自己的浏览器。
 *  内核侧失败（非 2xx）由调用方 runOpenExternal 的 catch 取 err.body，三档字段与地址都不丢。 */
export async function handOffFromPanel(url: string): Promise<OpenExternalResult> {
  if (!url) return { ok: false, error: "没有可打开的地址" };
  if (servedByKernelHost()) return supervisorApi.envOpenUrl(url);
  return openViaWindow(url);
}

export type OpenTier = "confirmed" | "handed-off" | "failed";

/** 结果分档（纯函数）：三档语义在此唯一一次映射为界面档位。
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
