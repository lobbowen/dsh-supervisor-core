// 面板侧「把地址交给浏览器」的行为测试。病根是静默的：内核说「只是把地址交了出去」，
// 面板却显示成功（或反过来把地址丢掉，用户只能重复点击）。形态门禁（platform-layer-portability X-11）
// 只能证明源码里有这些字样，证不了分档判据按字段而非文案走、也证不了选路判据成立，故这里按行为钉。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handOffFromPanel,
  openViaWindow,
  servedByKernelHost,
  classifyOpenResult,
} from "./externalOpen";
import { supervisorApi } from "./client";

/** 装一个最小 window：hostname 决定面板由谁托管，open 记录访客浏览器的原生新标签。 */
function installWindow(hostname: string) {
  const win: Record<string, unknown> = { location: { hostname }, open: vi.fn(() => ({ closed: false })) };
  vi.stubGlobal("window", win as unknown as Window & typeof globalThis);
  return { open: win.open as ReturnType<typeof vi.fn> };
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

describe("servedByKernelHost：浏览器与内核是否同一台机器", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["127.0.0.1", "localhost", "[::1]", "127.5.1.1"])("%s 判为回环", (h) => {
    installWindow(h);
    expect(servedByKernelHost()).toBe(true);
  });
  it.each(["192.168.1.20", "dsh.example.com", "]")(
    "反向：%s 不是回环：此时请内核开浏览器是在别人的机器上弹窗", (h) => {
      installWindow(h);
      expect(servedByKernelHost()).toBe(false);
    },
  );
});

describe("handOffFromPanel：本机请内核开、他人浏览器自己开", () => {
  const realOpenUrl = supervisorApi.envOpenUrl;
  afterEach(() => { vi.unstubAllGlobals(); supervisorApi.envOpenUrl = realOpenUrl; });

  it("回环来源走内核端点，且不发 window.open（壳内 webview 丢弃它 = 原来的死单击）", async () => {
    const w = installWindow("127.0.0.1");
    supervisorApi.envOpenUrl = vi.fn(async (url: string) => ({ ok: true, confirmed: true, url }));
    const r = await handOffFromPanel("http://127.0.0.1:1/open?code=c");
    expect(supervisorApi.envOpenUrl).toHaveBeenCalledWith("http://127.0.0.1:1/open?code=c");
    expect(w.open).not.toHaveBeenCalled();
    expect(r.confirmed).toBe(true);
  });

  it("内核的失败档原样抛出（呈现口据 err.body 取回地址与 reason）", async () => {
    installWindow("localhost");
    supervisorApi.envOpenUrl = vi.fn(async () => {
      throw Object.assign(new Error("HTTP 500"), { body: { ok: false, reason: "no-launcher", url: "http://a.b/" } });
    });
    const e = await handOffFromPanel("http://a.b/").then(() => null, (x: unknown) => x);
    expect((e as { body?: { reason?: string } }).body?.reason).toBe("no-launcher");
  });

  it("非回环来源用访客自己的浏览器：不得把动作推给内核", async () => {
    const w = installWindow("192.168.1.20");
    supervisorApi.envOpenUrl = vi.fn(async () => { throw new Error("不该被调用"); });
    const r = await handOffFromPanel("http://a.b/");
    expect(supervisorApi.envOpenUrl).not.toHaveBeenCalled();
    expect(w.open).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
    // 新标签就在访客眼前，故算 confirmed；证据只到「浏览器接收了导航」，不冒领内核的进程取证。
    expect(r.evidence?.via).toBe("window");
  });

  it("没有地址时不发起任何动作", async () => {
    const w = installWindow("192.168.1.20");
    const r = await handOffFromPanel("");
    expect(r.ok).toBe(false);
    expect(w.open).not.toHaveBeenCalled();
  });
});

describe("openViaWindow：弹窗被拦截是失败，不是成功", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("带 noopener（不得把面板 window 引用交给被打开页）", () => {
    const w = installWindow("192.168.1.20");
    openViaWindow("http://a.b/");
    expect(String(w.open.mock.calls[0]?.[2])).toContain("noopener");
  });

  it("open 返回 null -> ok:false 并说明是拦截，地址仍在场", () => {
    const w = installWindow("192.168.1.20");
    w.open.mockReturnValue(null);
    const r = openViaWindow("http://a.b/");
    expect(r.ok).toBe(false);
    expect(r.url).toBe("http://a.b/");
    expect(r.error || "").toContain("拦截");
  });

  it("open 抛错也归一成结果对象（异常不得绕过唯一呈现口）", () => {
    const w = installWindow("192.168.1.20");
    w.open.mockImplementation(() => { throw new Error("blocked by policy"); });
    const r = openViaWindow("http://a.b/");
    expect(r.ok).toBe(false);
    expect(r.error || "").toContain("blocked by policy");
  });
});
