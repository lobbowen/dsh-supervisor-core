// 面板侧「把地址交到浏览器」的行为测试。病根是静默的：内核说「只是把地址交了出去」，
// 面板却显示成功（或反过来把地址丢掉，用户只能重复点击）。形态门禁（platform-layer-portability X-11）
// 只能证明源码里有这些字样，证不了分档判据真的按字段而非文案走，故这里按行为钉。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handOffFromPanel,
  requestShellOpen,
  classifyOpenResult,
  MSG_OPEN_URL,
  MSG_OPEN_URL_RESULT,
  SHELL_OPEN_ACK_MS,
} from "./externalOpen";
import { BRIDGE_PROTOCOL_VERSION } from "./kernelUpdateBridge";

// 线格式在测试里重写字面量（不复用模块常量）：壳侧 bridge.rs 与本模块各持一份，跨仓一致性由门禁钉，
//   测试若复用同一常量等于「用实现验证实现」，改错常量时两边一起错。
const TYPE_REQUEST = "dsh:open-url";
const TYPE_RESULT = "dsh:open-url-result";

type Handler = (ev: MessageEvent) => void;

function installWindow(withShellHost: boolean) {
  const handlers = new Set<Handler>();
  const toParent = vi.fn();
  const win: Record<string, unknown> = {
    addEventListener: (_t: string, h: Handler) => { handlers.add(h); },
    removeEventListener: (_t: string, h: Handler) => { handlers.delete(h); },
    postMessage: vi.fn(),
    open: vi.fn(() => ({ closed: false })),
  };
  win.parent = withShellHost ? { postMessage: toParent } : win; // 顶层窗口：parent === window
  vi.stubGlobal("window", win as unknown as Window & typeof globalThis);
  const dispatch = (data: unknown, source: unknown = win.parent) => {
    for (const h of Array.from(handlers)) h({ data, source } as MessageEvent);
  };
  return { toParent, open: win.open as ReturnType<typeof vi.fn>, dispatch, listeners: () => handlers.size };
}

/** 取面板发出的 requestId（每请求随机，必须由实现给出而非测试拼一个）。 */
function requestIdOf(toParent: { mock: { calls: unknown[][] } }): string {
  const call = toParent.mock.calls[0] as [Record<string, unknown>];
  return String(call[0].requestId);
}

describe("classifyOpenResult：三档只看字段，不看文案", () => {
  it("confirmed 才升为「已打开」档", () => {
    const r = classifyOpenResult({ ok: true, confirmed: true, handedOff: false, url: "http://127.0.0.1:1/open?code=c" });
    expect(r.tier).toBe("confirmed");
    expect(r.url).toBe("http://127.0.0.1:1/open?code=c");
  });

  it("反向：文案谎称已打开但 confirmed 缺失 -> 仍是 handed-off（判据取字段即不被文案带跑）", () => {
    const r = classifyOpenResult({ ok: true, confirmed: false, handedOff: true, message: "已在系统浏览器打开", url: "http://a.b/" });
    expect(r.tier).toBe("handed-off");
    expect(r.title).not.toBe("已在系统浏览器打开");
  });

  it("ok:false 一律 failed，且带上给用户的说法与地址", () => {
    const r = classifyOpenResult({ ok: false, reason: "no-launcher", error: "未找到可用的浏览器启动命令", url: "http://a.b/" });
    expect(r.tier).toBe("failed");
    expect(r.title).toContain("未找到");
    expect(r.url).toBe("http://a.b/");
  });

  it("结果整体缺失也是 failed（不得因 undefined 冒充实成功）", () => {
    expect(classifyOpenResult(null).tier).toBe("failed");
    expect(classifyOpenResult(undefined).url).toBe(null);
  });
});

describe("requestShellOpen：壳内请壳代开", () => {
  let h: ReturnType<typeof installWindow>;
  beforeEach(() => { vi.useFakeTimers(); h = installWindow(true); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

  it("出站帧带协议版本、类型与地址", async () => {
    void requestShellOpen("http://127.0.0.1:1/open?code=c1");
    const [msg, target] = h.toParent.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg.v).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(msg.type).toBe(TYPE_REQUEST);
    expect(msg.url).toBe("http://127.0.0.1:1/open?code=c1");
    expect(typeof msg.requestId).toBe("string");
    // 出站允许 '*'：壳主帧 origin 由 Tauri 自定义协议决定，面板无从预知（入向另有硬校验）。
    expect(target).toBe("*");
  });

  it("父帧回执才算交出；非父来源的“成功”被忽略", async () => {
    const p = requestShellOpen("http://a.b/");
    const rid = requestIdOf(h.toParent);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: TYPE_RESULT, requestId: rid, ok: true }, { notTheParent: true });
    await flush();
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: TYPE_RESULT, requestId: rid, ok: true });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.via).toBe("shell");
  });

  it("协议版本或 requestId 不符的帧被忽略", async () => {
    const p = requestShellOpen("http://a.b/");
    const rid = requestIdOf(h.toParent);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION + 1, type: TYPE_RESULT, requestId: rid, ok: true });
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: TYPE_RESULT, requestId: "openu-other", ok: true });
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: "dsh:kernel-update-result", requestId: rid, ok: true });
    await vi.advanceTimersByTimeAsync(SHELL_OPEN_ACK_MS);
    expect((await p).ok).toBe(false);
  });

  it("壳不回执（旧版壳）-> ok:false 且要求用户复制/手动打开，绝不默认成功", async () => {
    const p = requestShellOpen("http://a.b/");
    await vi.advanceTimersByTimeAsync(SHELL_OPEN_ACK_MS - 1);
    let done = false;
    void p.then(() => { done = true; });
    await flush();
    expect(done).toBe(false);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error || "").toContain("复制");
  });

  it("回执后摘掉监听器", async () => {
    const p = requestShellOpen("http://a.b/");
    const rid = requestIdOf(h.toParent);
    expect(h.listeners()).toBe(1);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: TYPE_RESULT, requestId: rid, ok: true });
    await p;
    expect(h.listeners()).toBe(0);
  });
});

describe("handOffFromPanel：壳内走桥、壳外走 window.open", () => {
  let h: ReturnType<typeof installWindow>;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("壳内：不发 window.open，只发桥消息", async () => {
    h = installWindow(true);
    const p = handOffFromPanel("http://a.b/");
    expect(h.open).not.toHaveBeenCalled();
    const rid = requestIdOf(h.toParent);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: TYPE_RESULT, requestId: rid, ok: true });
    expect((await p).via).toBe("shell");
  });

  it("壳外：window.open 带 noopener（不得把面板 window 引用交给被打开页）", async () => {
    h = installWindow(false);
    const r = await handOffFromPanel("http://a.b/");
    expect(r.via).toBe("window");
    expect(r.ok).toBe(true);
    expect(h.open.mock.calls[0]?.[2]).toContain("noopener");
  });

  it("弹窗被拦截（open 返回 null）-> ok:false，说明是拦截而非已打开", async () => {
    h = installWindow(false);
    h.open.mockReturnValue(null);
    const r = await handOffFromPanel("http://a.b/");
    expect(r.ok).toBe(false);
    expect(r.error || "").toContain("拦截");
  });

  it("没有地址时不发起任何动作", async () => {
    h = installWindow(false);
    const r = await handOffFromPanel("");
    expect(r.ok).toBe(false);
    expect(r.via).toBe("none");
    expect(h.open).not.toHaveBeenCalled();
  });

  it("常量与线格式一致（改名即两侧脱钩，先在这里判红）", () => {
    expect(MSG_OPEN_URL).toBe(TYPE_REQUEST);
    expect(MSG_OPEN_URL_RESULT).toBe(TYPE_RESULT);
  });
});
