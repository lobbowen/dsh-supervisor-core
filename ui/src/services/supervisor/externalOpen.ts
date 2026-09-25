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

/** 面板是否由本机内核托管；与内核 /env/open-url 的 identity.loopback 判的是同一件事。
 *  回环 IPv4 按四段整体匹配：`^127.` 这种前缀判据会把 `127.example.com` 也认成本机，
 *  而内核侧按真实 socket 判回环，误判只会让远程访客的面板把动作推给内核、换回一次 403。 */
export function servedByKernelHost(): boolean {
  const h = String(window.location.hostname || "").toLowerCase();
  return h === "localhost" || h === "[::1]" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
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

/** 启动形态 + 探测留痕摊成一行小字：三档里 handedOff 与 failed 的区别只在证据强弱，用户需要知道自己点了什么
 *  才知道该不该信这句结论 —— 内核把 bin/via/ownsWindow/exit 一并交出，此前它在响应体里躺着没人看。
 *  diagnostics 是探测层留痕的行内摘要（默认项从哪条系统事实读出、本机探到哪些候选）：
 *  「点了没弹出来」这一类报障，只有带着这一行才谈得上定性，否则界面永远只剩一句「再点一次」。 */
export function evidenceDetail(ev?: OpenExternalResult["evidence"]): string | null {
  if (!ev || typeof ev !== "object") return null;
  const exe = typeof ev.bin === "string" ? ev.bin.split(/[\\/]/).pop() : null;
  const bits: string[] = [];
  if (exe) bits.push(exe);
  else if (ev.via === "none") bits.push("未定出启动对象");
  if (ev.via) bits.push(ev.via);
  if (ev.ownsWindow === false) bits.push("退出码不作证据");
  if (ev.exitCode !== undefined && ev.exitCode !== null) bits.push("exit " + String(ev.exitCode));
  else if (ev.exitSignal) bits.push("signal " + ev.exitSignal);
  else if (ev.error) bits.push(String(ev.error));
  const d = ev.diagnostics;
  if (d && typeof d === "object") {
    bits.push("默认项来源 " + ((d.default && d.default.source) || "未读出"));
    // 分发依据要说人话：用户最需要知道的是「这次用的是不是我选的那个」，而不是内核内部的来源名。
    if (d.pick === "user-preference") bits.push("按你在环境检测里选的浏览器");
    else if (d.pick === "candidate-rank") bits.push("系统未报默认项，已按候选次序取首个（可在环境检测里改）");
    else if (d.pick === "only-installed") bits.push("本机唯一候选");
    else if (d.pick === "none-found") bits.push("本机未探到可用浏览器");
    if (d.preference && d.preference.id && d.preference.matched === false) bits.push("你选的浏览器已不在候选清单，请重选");
    const found = Array.isArray(d.found) ? d.found : [];
    bits.push(
      "候选 " + String(found.length) + " 个" +
      (found.length ? "：" + found.map((f) => f.name || f.via || "?").join("、") : ""),
    );
    const probed = Array.isArray(d.probed) ? d.probed : [];
    if (!found.length && probed.length) bits.push("探测读数：" + probed.map((p) => p.source).join("、"));
  }
  if (ev.via === "isolated") bits.push(ev.isolated === false ? "未隔离（并入既有窗口）" : "隔离窗口");
  return bits.length ? bits.join(" | ") : null;
}

/** 结果分档（纯函数）：三档语义在此唯一一次映射为界面档位。
 *  判据取 ok/confirmed，不取 message/error 文本 —— 文案可变，档位是契约。 */
export function classifyOpenResult(r?: OpenExternalResult | null): { tier: OpenTier; url: string | null; title: string; detail: string | null } {
  const url = typeof r?.url === "string" && r.url ? r.url : null;
  const detail = evidenceDetail(r?.evidence);
  if (!r || r.ok !== true) {
    return { tier: "failed", url, detail, title: (r && r.error) || "无法调起系统浏览器，请手动打开下方地址" };
  }
  if (r.confirmed === true) return { tier: "confirmed", url, detail, title: r.message || "已在系统浏览器打开" };
  return {
    tier: "handed-off", url, detail,
    title: "已把地址交给系统，但没拿到窗口出现的证据" + (url ? "：没看到浏览器就点下方地址" : ""),
  };
}
