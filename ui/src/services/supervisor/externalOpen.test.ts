// 面板侧「把地址交给浏览器」的行为测试。病根是静默的：内核说「只是把地址交了出去」，
// 面板却显示成功（或反过来把地址丢掉，用户只能重复点击）。形态门禁（platform-layer-portability X-11）
// 只能证明源码里有这些字样，证不了分档判据按字段而非文案走、也证不了选路判据成立，故这里按行为钉。
// 与 client.test.ts 同一手法：注入 fetch 替身，测到真实请求的路径与请求体，不碰 supervisorApi 本身。
import { afterEach, describe, expect, it, vi } from "vitest";
import { handOffFromPanel, openViaWindow, servedByKernelHost, classifyOpenResult, evidenceDetail } from "./externalOpen";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } } as ResponseInit);
}

/** 内核 /env/open-url 的替身：记下面板发出的路径与请求体（选路判据的行为证据），按给定档位回。 */
function stubKernel(status: number, body: unknown) {
  const sent: Array<{ path: string; payload: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    sent.push({ path: String(url), payload: JSON.parse(String(init?.body)) });
    return Promise.resolve(jsonResponse(status, body));
  }));
  return sent;
}

/** 装一个最小 window：hostname 决定面板由谁托管；open 记录访客浏览器的原生新标签。
 *  blocked=弹窗被拦截（浏览器回 null），throws=导航被策略拒绝。 */
function installWindow(hostname: string, behavior: "accept" | "blocked" | "throws" = "accept") {
  const calls: string[][] = [];
  const win: Record<string, unknown> = {
    location: { hostname },
    open: (...args: unknown[]) => {
      calls.push(args.map(String));
      if (behavior === "throws") throw new Error("blocked by policy");
      return behavior === "blocked" ? null : { closed: false };
    },
  };
  vi.stubGlobal("window", win as unknown as Window & typeof globalThis);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

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

describe("evidenceDetail：把启动形态摊给用户（真机报错只有文案时无人能定位）", () => {
  it("不可信形态标注「退出码不作证据」，并可执行文件名而非全路径", () => {
    expect(evidenceDetail({ bin: "C:\\Windows\\explorer.exe", via: "dispatcher", ownsWindow: false, exitCode: 1 }))
      .toBe("explorer.exe | dispatcher | 退出码不作证据 | exit 1");
  });
  it("可信形态只报退出码；只剩 error 码时报 error 码", () => {
    expect(evidenceDetail({ bin: "xdg-open", via: "dispatcher", ownsWindow: true, exitCode: 3 })).toBe("xdg-open | dispatcher | exit 3");
    expect(evidenceDetail({ bin: "xdg-open", via: "dispatcher", ownsWindow: true, error: "ENOENT" })).toBe("xdg-open | dispatcher | ENOENT");
  });
  it("反向：ownsWindow 缺失（旧内核结果）不得凭空标注证据规则", () => {
    expect(evidenceDetail({ bin: "open", via: "dispatcher", exitCode: 0 })).toBe("open | dispatcher | exit 0");
    expect(evidenceDetail(null)).toBe(null);
    expect(evidenceDetail({})).toBe(null);
  });
  it("handed-off 档带着证据细节也不升成成功说法", () => {
    const r = classifyOpenResult({
      ok: true, confirmed: false, handedOff: true, url: "http://a.b/",
      evidence: { bin: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", via: "browser", ownsWindow: false, exitCode: 1 },
    });
    expect(r.tier).toBe("handed-off");
    expect(r.detail).toBe("msedge.exe | browser | 退出码不作证据 | exit 1");
  });
});

describe("servedByKernelHost：浏览器与内核是否同一台机器", () => {
  for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "[::1]", "::1", "127.5.1.1"]) {
    it(h + " 判为回环", () => {
      installWindow(h);
      expect(servedByKernelHost()).toBe(true);
    });
  }
  // 127.example.com 是「以 127. 开头」这种前缀判据的漏网之鱼：它不是 IP，内核在那台机器上，
  //   误判会让远程访客的面板把动作推给内核，而内核按真实 socket 判非回环 —— 用户只看到一次 403。
  for (const h of ["192.168.1.20", "dsh.example.com", "127.example.com", "127.0.0.1.evil.com", "[::2]", ""]) {
    it("反向：" + h + " 不是回环，此时请内核开浏览器是在别人的机器上弹窗", () => {
      installWindow(h);
      expect(servedByKernelHost()).toBe(false);
    });
  }
});

describe("handOffFromPanel：本机请内核开、他人浏览器自己开", () => {
  it("回环来源走内核端点，且原样交出三档结果（不另造成败说法）", async () => {
    const w = installWindow("127.0.0.1");
    const sent = stubKernel(200, { ok: true, confirmed: true, handedOff: false, url: "http://127.0.0.1:1/open?code=c", evidence: { bin: "xdg-open" } });
    const r = await handOffFromPanel("http://127.0.0.1:1/open?code=c");
    expect(sent).toEqual([{ path: "/env/open-url", payload: { url: "http://127.0.0.1:1/open?code=c" } }]);
    expect(w.calls.length).toBe(0);
    expect(r.confirmed).toBe(true);
    expect(r.evidence?.bin).toBe("xdg-open");
  });

  it("内核的失败档随 err.body 原样抛出（呈现口据此取回地址与 reason）", async () => {
    installWindow("localhost");
    stubKernel(500, { ok: false, reason: "no-launcher", url: "http://a.b/" });
    const e = await handOffFromPanel("http://a.b/").then(() => null, (x: unknown) => x as { body?: { reason?: string; url?: string } });
    expect(e?.body?.reason).toBe("no-launcher");
    expect(e?.body?.url).toBe("http://a.b/");
  });

  it("非回环来源用访客自己的浏览器：不得把动作推给内核", async () => {
    const w = installWindow("192.168.1.20");
    const sent = stubKernel(200, { ok: true, confirmed: true });
    const r = await handOffFromPanel("http://a.b/");
    expect(sent.length).toBe(0);
    expect(w.calls.length).toBe(1);
    expect(r.ok).toBe(true);
    // 新标签就在访客眼前，故算 confirmed；证据只到「浏览器接收了导航」，不冒领内核的进程取证。
    expect(r.confirmed).toBe(true);
    expect(r.evidence?.via).toBe("window");
  });

  it("没有地址时不发起任何动作", async () => {
    const w = installWindow("192.168.1.20");
    const sent = stubKernel(200, { ok: true, confirmed: true });
    const r = await handOffFromPanel("");
    expect(r.ok).toBe(false);
    expect(w.calls.length).toBe(0);
    expect(sent.length).toBe(0);
  });
});

describe("openViaWindow：弹窗被拦截是失败，不是成功", () => {
  it("带 noopener（不得把面板 window 引用交给被打开页）", () => {
    const w = installWindow("192.168.1.20");
    openViaWindow("http://a.b/");
    expect(w.calls[0]?.[2]).toContain("noopener");
  });

  it("返回 null -> ok:false 并说明是拦截，地址仍在场", () => {
    const w = installWindow("192.168.1.20", "blocked");
    const r = openViaWindow("http://a.b/");
    expect(w.calls.length).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.url).toBe("http://a.b/");
    expect(r.error || "").toContain("拦截");
  });

  it("抛错也归一成结果对象（异常不得绕过唯一呈现口）", () => {
    const w = installWindow("192.168.1.20", "throws");
    const r = openViaWindow("http://a.b/");
    expect(w.calls.length).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.error || "").toContain("blocked by policy");
  });
});
