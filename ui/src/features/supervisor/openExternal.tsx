/** 外部打开结果的唯一呈现口：内核三档（confirmed / handedOff / ok:false）在此各有说法，
 *  且**任何一档都把地址交到用户眼前**（可点、可复制）。
 *  页面不得自行拼这类 toast —— 「按钮点了没反应却显示成功」正是各处各自表述成败的结果。 */
import { Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { classifyOpenResult, handOffFromPanel } from "../../services/supervisor/externalOpen";
import type { OpenExternalResult } from "../../services/supervisor";

/** 地址条：点开（壳内请壳代开、壳外 window.open）+ 复制；复制失败时明示要手动选中。 */
function OpenUrlRow({ url }: { url: string }) {
  async function onOpen() {
    const r = await handOffFromPanel(url);
    if (!r.ok) toast.error(r.error || "未能打开，请复制下方地址手动打开");
  }
  function onCopy() {
    const fallback = () => toast.error("复制失败，请手动选中地址");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(() => toast.success("地址已复制"), fallback);
    else fallback();
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{url}</code>
      <button type="button" onClick={() => void onOpen()} title="在系统浏览器中打开该地址" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
        <ExternalLink className="size-3.5" />
      </button>
      <button type="button" onClick={onCopy} title="复制地址" className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

/** 一次外部打开结果的呈现（不抛错：这一步没有可失败的后端动作）。 */
export function notifyOpen(r?: OpenExternalResult | null): void {
  const { tier, url, title } = classifyOpenResult(r);
  const opts = { description: url ? <OpenUrlRow url={url} /> : undefined, duration: tier === "confirmed" ? 3000 : 20000 };
  if (tier === "confirmed") toast.success(title, opts);
  else if (tier === "handed-off") toast.warning(title, opts);
  else toast.error(title, opts);
}

/** 发起 + 呈现的唯一入口。后端把「动作未被接受」映射为非 2xx（GD 条），而失败响应体里的地址
 *  仍必须呈现，故 catch 里优先取 err.body，取不到才退化成一句错误文案。
 *  泛型：调用方的端点带额外字段（如登录发起的 authUrl/isolated）时原样交出，不必二次请求。 */
export async function runOpenExternal<T extends OpenExternalResult>(
  call: () => Promise<T | null | undefined>,
): Promise<T | null> {
  try {
    const r = await call();
    notifyOpen(r);
    return r ?? null;
  } catch (e) {
    const body = (e as { body?: unknown }).body;
    const r: OpenExternalResult = body && typeof body === "object"
      ? (body as OpenExternalResult)
      : { ok: false, error: e instanceof Error ? e.message : String(e) };
    notifyOpen(r);
    return r as T;
  }
}
