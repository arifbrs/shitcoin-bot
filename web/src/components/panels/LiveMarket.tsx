import { useState } from "react";
import type { StatsResponse } from "@/types/stats";

// null = the feed did not report it. Rendered as an em dash, never "$0" or "0m" — a fabricated
// zero reads as a real measurement ("worthless coin", "brand new") and is worse than an absence.
function fmtMc(v: number | null): string {
  if (v == null || !isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}
function fmtAge(min: number | null): string {
  if (min == null || !isFinite(min)) return "—";
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}

/**
 * SIGNALS/DNA tabs from the old dashboard are not ported — both read exclusively from sniper
 * fields (recentDecisions / patterns) that are permanently empty now the sniper is archived.
 * NEW/TOP MC are real, live pump.fun data (server.ts's own refreshMarket(), independent of the
 * sniper), so those are the only two tabs this rewrite needs.
 */
export function LiveMarket({ data }: { data: StatsResponse }) {
  const [tab, setTab] = useState<"new" | "top">("new");
  const rows = tab === "new" ? data.market.new : data.market.top;
  const ageS = data.market.ageMs != null ? Math.round(data.market.ageMs / 1000) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-1">
        {(["new", "top"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-2 py-0.5 font-mono text-[9px] tracking-widest ${
              tab === t ? "bg-foreground text-background" : "border border-border text-muted-foreground"
            }`}
          >
            {t === "new" ? "NEW" : "TOP MC"}
          </button>
        ))}
        {ageS != null && <span className="ml-auto font-mono text-[9px] text-muted-foreground/60">· {ageS}s ago</span>}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
        {rows.slice(0, 24).map((c, i) => (
          <div key={c.mint} className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 rounded px-1.5 py-0.5 font-mono text-[10px] hover:bg-secondary/40">
            {tab === "top" && <span className="w-4 text-center text-muted-foreground/60">{i + 1}</span>}
            <span className="truncate text-foreground">{c.symbol}</span>
            <span className={tab === "new" ? "text-up" : "text-muted-foreground"}>{fmtMc(c.mcUsd)}</span>
            <span className="w-9 text-right text-muted-foreground/60">{tab === "new" ? fmtAge(c.ageMin) : c.replies > 0 ? `${c.replies} rep` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
