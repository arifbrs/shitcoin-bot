import { panelMemo } from "@/lib/panelMemo";
import type { StatsResponse } from "@/types/stats";

function fmtMc(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/** Only http(s) accepted — same sanitization the old dashboard applied before ever putting a value into an href. */
function safeTwitterHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://x.com/${url}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function ScoutPanelInner({ data }: { data: StatsResponse }) {
  const candidates = data.strategy2.candidates;
  if (!candidates.length) return <p className="font-mono text-[10px] text-muted-foreground">Belum ada kandidat.</p>;

  return (
    <div className="flex h-full gap-2 overflow-x-auto pb-1">
      {candidates.slice(0, 30).map((c) => {
        const href = safeTwitterHref(c.twitterUrl);
        const chg = c.change24h;
        return (
          <div key={c.mint} className="flex w-32 shrink-0 flex-col gap-0.5 rounded-lg border border-border bg-secondary/30 p-2 font-mono text-[9px]">
            <span className="truncate font-semibold text-foreground">{c.sym}</span>
            <span className="text-muted-foreground">MC {fmtMc(c.mcUsd)}</span>
            <span className="text-muted-foreground">{c.holders.toLocaleString()} hold</span>
            <span className={chg == null ? "text-muted-foreground/50" : chg >= 0 ? "text-up" : "text-down"}>
              {chg == null ? "—" : `${chg >= 0 ? "+" : ""}${chg.toFixed(0)}% 24j`}
            </span>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="truncate text-scout hover:underline">
                sosial
              </a>
            ) : (
              <span className="text-muted-foreground/40">—</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const ScoutPanel = panelMemo(ScoutPanelInner, (d) => [
  d.strategy2.count, d.strategy2.candidates?.length, d.strategy2.candidates?.[0]?.mint,
  // Same async-art hazard as TradeJournal: icons arrive after the row already exists.
  d.strategy2.candidates?.filter((c) => c.img).length,
]);
