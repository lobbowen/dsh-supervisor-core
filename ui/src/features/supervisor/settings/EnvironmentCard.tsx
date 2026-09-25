/**
 * 环境检测 — 本机环境表单：所有「把地址交给浏览器」动作的分发依据都在这里。
 *
 * 为什么做成表单而不是各处自己探一次：一台机器上装了哪些浏览器、系统说不说得清默认项、
 * 有没有图形会话，每项都可能与另一台机器不同；此前每个动作各摸各的、各解释各的结果，
 * 于是「点了没弹出来」在界面上一句都说不清。表单把事实收在一处并写明每一层判定，
 * 用户能在这里定一次偏好，支持排障能直接读快照路径。
 *
 * 数据只走 supervisorApi（fetch 唯一处）；本组件自加载自失败，不拖累概览其余部分。
 */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, RadioGroup, RadioGroupItem } from "../../../framework/ui";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../../framework/ui/dialog";
import { supervisorApi, type EnvironmentForm, type EnvironmentSection, type EgressSectionData } from "../../../services/supervisor";
import { cn } from "../../../framework/utils";

/** 运行时条目的显示字（内核 EnvCatalog 条目视图）：state 已含版本门槛判定，这里只如实摊开。 */
function entryText(e?: Record<string, unknown> | null): string {
  if (!e) return "未读出";
  const st = String(e.state || "?");
  const detail = e.detail ? "（" + String(e.detail) + "）" : "";
  return (String(e.label || "") || "条目") + " " + st + detail;
}

/** 维度读数状态字：pending / empty / error 三态各说一句 —— 把「这一拍还没探」显示成「本机没有」
 *  正是此前多个就绪口径互相顶替的根病，未探必须带上「怎么补」的出路。 */
function sectionState(sec?: EnvironmentSection): string {
  if (!sec || sec.state === "pending") return "未探测（点「重新探测」补齐）";
  if (sec.state === "error") return "探测失败：" + (sec.error || "未给出原因");
  if (sec.state === "empty") return "已探测，无内容";
  return "已探测" + (sec.at ? " " + new Date(sec.at).toLocaleTimeString() : "");
}

/** 代理读数的人话版：unknown 必须说成「取不到」而不是「没有」—— 内核正是按这个差别决定
 *  隔离窗口保不保留的，界面把它显示成「未启用」就会诱导用户去动一个并不需要动的设置。 */
function proxyText(proxy?: NonNullable<EgressSectionData["proxy"]> | null): string {
  const p: NonNullable<EgressSectionData["proxy"]> = proxy || {};
  if (p.state === "on") return "在用（" + (p.server || p.pac || "地址未读出") + "）";
  if (p.state === "off") return "系统里明确未启用";
  if (p.state === "unknown") return "取不到" + (p.source ? "（" + p.source + "）" : "") + "，按判不出处理";
  return "未探测";
}

/** 通路三态的显示字：null = 判不出，绝不能显示成「不通」。 */
function reachText(ok?: boolean | null): string {
  return ok === true ? "可达" : ok === false ? "不通" : "判不出";
}

/** 探测留痕行的显示字（与内核 form().probed 同源）：egress 行的行名已带 reach: 前缀，其余带维度名。 */
function probeText(p: { section?: string; source: string; detail?: string | number | null }): string {
  return (p.section ? p.section + "：" : "") + p.source + "：" + String(p.detail ?? "");
}

/** 分发依据的人话版：内核给的是层名，用户要看到的是「这次用谁、是不是我选的」。 */
function pickText(pick?: EnvironmentForm["pick"]): string {
  const name = pick && pick.name ? pick.name : "未定出";
  if (!pick || !pick.how) return "现在会用：" + name;
  if (pick.how === "user-preference") return "现在会用：" + name + "（你选的）";
  if (pick.how === "candidate-rank") return "现在会用：" + name + "（系统未报默认项，按候选次序取首个，可在此改）";
  if (pick.how === "only-installed") return "现在会用：" + name + "（本机唯一候选）";
  if (pick.how === "none-found") return "本机未探到可用浏览器，请安装或启用一个后重新探测";
  return "现在会用：" + name + "（系统默认项）";
}

/** 「跟随系统」在 RadioGroup 里的取值：Radix 的 item 不许空串 value，故用哨兵映射到内核的空偏好。 */
const FOLLOW_SYSTEM = "__system__";

export function EnvironmentCard() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<EnvironmentForm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // 未保存的选择：null = 未改动（跟随表单里的当前偏好）。保存成功即清空，重探同样清空。
  const [draft, setDraft] = useState<string | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);

  const load = useCallback(async (force: boolean) => {
    if (force) setProbeBusy(true);
    try {
      const r = await supervisorApi.environment(force);
      setForm(r);
      setDraft(null);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
    setProbeBusy(false);
  }, []);

  useEffect(() => {
    // 打开时才装配：概览页轮询不得反复触发内核的注册表/目录扫描。
    if (!open) return;
    void load(false);
  }, [open, load]);

  const save = async (id: string) => {
    setSaveBusy(true);
    let r: { ok?: boolean; error?: string | null } = { ok: false, error: "偏好写入未返回结果" };
    try { r = await supervisorApi.setExternalBrowser(id); } catch (e) { r = { ok: false, error: String((e as Error).message || e) }; }
    setSaveBusy(false);
    if (!r || r.ok !== true) { setErr((r && r.error) || "偏好写入失败"); return; }
    setErr(null);
    await load(true);
  };

  const browsers = form?.browsers ?? [];
  // 维度台账：异步维度（出网条件/运行时/DSH）由内核按拍补齐，本卡片只渲染读数、不自判。
  const sections = form?.sections;
  const stale = form?.pick?.stale === true;
  const current = form?.preference?.id || FOLLOW_SYSTEM;
  const chosen = draft !== null ? draft : current;

  return (
    <>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Button size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
          <ExternalLink className="size-3" />环境表单
        </Button>
        {form?.pick?.name ? (
          <span className="text-xs text-muted-foreground/70">{form.pick.name}</span>
        ) : null}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px]">
          <DialogHeader><DialogTitle>本机环境表单</DialogTitle></DialogHeader>
          <div className="grid max-h-[60vh] gap-3 overflow-y-auto text-sm">
            <p className={cn("text-xs", stale || !browsers.length ? "font-semibold text-warning" : "text-muted-foreground")}>
              {pickText(form?.pick)}
            </p>
            {stale ? (
              <p className="inline-flex items-start gap-1.5 rounded-md bg-warning-background px-2 py-1.5 text-xs font-semibold text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                你先前选的浏览器已不在本机候选清单（可能已卸载或路径变更），下方选择已回落到系统判定，请重选或清除。
              </p>
            ) : null}
            {err ? <p className="text-xs text-status-error">{err}</p> : null}

            <div className="grid gap-2 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">打开地址用哪个浏览器</span>
              <RadioGroup value={chosen} onValueChange={setDraft} className="grid gap-1.5">
                <label className="inline-flex cursor-pointer items-center gap-2 text-xs">
                  <RadioGroupItem value={FOLLOW_SYSTEM} id="env-pref-system" />
                  <span>跟随系统默认（本机探不到默认项时按候选次序）</span>
                </label>
                {browsers.map((b) => (
                  <label key={b.id} className="inline-flex cursor-pointer items-center gap-2 text-xs">
                    <RadioGroupItem value={b.id} id={"env-pref-" + b.id} />
                    <span>{b.name || b.bin}</span>
                    <span className="text-muted-foreground/70">{b.engine}</span>
                    {b.isDefault ? <span className="text-muted-foreground/70">系统默认</span> : null}
                  </label>
                ))}
              </RadioGroup>
              {browsers.length ? (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={saveBusy || chosen === current}
                          onClick={() => void save(chosen === FOLLOW_SYSTEM ? "" : chosen)}>保存偏好</Button>
                  <Button size="sm" variant="ghost" disabled={saveBusy || current === FOLLOW_SYSTEM} onClick={() => void save("")}>清除</Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">候选为空：重新探测后仍为空时，请先在系统里安装或启用一个浏览器。</p>
              )}
            </div>

            <div className="grid gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">出网条件（隔离登录窗口的分发依据）</span>
              <span className="text-xs text-muted-foreground">{sectionState(sections?.egress)}</span>
              {sections?.egress?.data ? (
                <div className="grid gap-0.5 text-xs">
                  <span className="text-muted-foreground">
                    系统代理：{proxyText(sections?.egress?.data?.proxy)}
                  </span>
                  {Object.entries(sections?.egress?.data?.targets || {}).map(([host, t]) => (
                    <span key={host} className="text-muted-foreground">
                      {host}：{reachText(t?.ok)}{t?.stage ? "（停在 " + t.stage + (t.detail ? " " + t.detail : "") + "）" : ""}
                    </span>
                  ))}
                  {!Object.keys(sections?.egress?.data?.targets || {}).length ? (
                    <span className="text-muted-foreground">还没有目标域被问过：一键登录时会当场判定并记在这里。</span>
                  ) : null}
                </div>
              ) : null}
              {sections?.egress?.data?.proxy?.state === "off" ? (
                <p className="text-xs text-muted-foreground">
                  没有在用系统代理时，直连不通的授权域只能靠现有浏览器窗口的既有出网路径打开（隔离冷档案会是空白页）。
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5 rounded-md border border-border/60 px-3 py-2.5">
              <span className="text-xs font-medium">运行时与 DSH（安装/升级动作的分发依据）</span>
              <span className="text-xs text-muted-foreground">{sectionState(sections?.runtime)}</span>
              {sections?.runtime?.data ? (
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span>{entryText(sections?.runtime?.data?.node)} · {entryText(sections?.runtime?.data?.npm)} · {entryText(sections?.runtime?.data?.git)}</span>
                  <span>
                    镜像源：{sections?.runtime?.data?.registry?.origin || "未读出"}
                    {sections?.runtime?.data?.registry?.mode ? "（" + sections.runtime.data.registry.mode + "）" : ""}
                    {" · 候选 " + (sections?.runtime?.data?.registry?.candidates || []).length + " 个"}
                  </span>
                  <span className="break-all">全局前缀：{sections?.runtime?.data?.prefix || "未实测（npm root -g 未返回）"}</span>
                </div>
              ) : null}
              <span className="text-xs text-muted-foreground">{sectionState(sections?.dsh)}</span>
              {sections?.dsh?.data ? (
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <span>{entryText(sections?.dsh?.data?.dsh)} · {entryText(sections?.dsh?.data?.selfUpdate)}</span>
                  <span>看护：{sections?.dsh?.data?.managed ? "守卫托管" : "未托管"}{sections?.dsh?.data?.phase ? " · " + sections.dsh.data.phase : ""}</span>
                </div>
              ) : null}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">平台</dt>
              <dd className="font-mono">{[form?.identity?.platform, form?.identity?.arch].filter(Boolean).join(" / ") || "—"}</dd>
              <dt className="text-muted-foreground">图形会话</dt>
              <dd>{form?.session?.available ? "可用（" + (form?.session?.reason || "—") + "）" : "不可用（" + (form?.session?.reason || "—") + "）"}</dd>
              <dt className="text-muted-foreground">系统默认项</dt>
              <dd>{form?.default ? form.default.id + "（来源 " + (form.default.source || "未读出") + "）" : "未读出"}</dd>
              <dt className="text-muted-foreground">候选</dt>
              <dd>{browsers.length ? browsers.map((b) => (b.name || b.bin) + "[" + (b.sources || []).join("+") + "]").join("、") : "无"}</dd>
              <dt className="text-muted-foreground">探测留痕</dt>
              <dd className="grid gap-0.5">
                {(form?.probed ?? []).map((p, i) => (
                  <span key={i} className="text-muted-foreground/80">{probeText(p)}</span>
                ))}
              </dd>
              <dt className="text-muted-foreground">快照</dt>
              <dd className="break-all font-mono text-muted-foreground/80">{form?.snapshot?.path || "—"}</dd>
            </dl>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={probeBusy} onClick={() => void load(true)}>
              <RefreshCw className="size-4" />{probeBusy ? "探测中…" : "重新探测"}
            </Button>
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
