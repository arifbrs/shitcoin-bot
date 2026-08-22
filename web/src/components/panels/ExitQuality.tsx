import { panelMemo } from "@/lib/panelMemo";
import type { StatsResponse } from "@/types/stats";

const TONE: Record<string, "up" | "down" | "dim"> = {
  TRAIL_STOP: "down",
  MAX_HOLD: "dim",
  MANUAL_FLATTEN: "dim",
};

/**
 * Strategy 2's API shape has no accumulated exitReasons tally (unlike the sniper's `paper.
 * exitReasons`) — only a capped recentTrades list. Computed client-side from what's visible,
 * labeled "recent" rather than implying it's the full-history distribution — an honest limit,
 * not silently overstated.
 */
function ExitQualityInner({ data }: { data: StatsResponse }) {
  // Reads whichever feed is populated. In live view lib/liveView puts the live trades here, so
  // this panel tallies real exit reasons through the same code path — no live-specific copy.
  const trades = data.strategy2Primary?.recentTrades?.length
    ? data.strategy2Primary.recentTrades
    : (data.recentTrades ?? []).map((t) => ({ ...t, reason: t.reason ?? "?" }));
  const tally = new Map<string, number>();
  for (const t of trades) {
    const reason = t.reason.replace(/_NO_LIQUIDITY_FORCED$/, "");
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  if (!rows.length) return <p className="font-mono text-[10px] text-muted-foreground">Belum ada data exit.</p>;

  return (
    <div className="flex h-full items-center gap-2 overflow-x-auto">
      {/* Label says what the numbers ARE. Owner misread the old "RECENT (30) … MAX_HOLD 2" as an
          entry cap, and the collision is genuinely unlucky: maxHoldHours is also 2, so a COUNT of
          two closes rendered identically to the setting "max hold = 2". Counts now carry an
          explicit ×, and the header names them as exits. */}
      <span className="shrink-0 font-mono text-[9px] leading-tight tracking-widest text-muted-foreground/60">
        ALASAN TUTUP<br />
        <span className="tracking-normal text-muted-foreground/40">{trades.length} terakhir</span>
      </span>
      {rows.map(([reason, n]) => {
        const tone = TONE[reason] ?? "dim";
        const cls = tone === "up" ? "text-up border-up/30" : tone === "down" ? "text-down border-down/30" : "text-muted-foreground border-border";
        return (
          <span key={reason} className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] ${cls}`}>
            {reason} <b>×{n}</b>
            <span className="ml-1 text-muted-foreground/50">{Math.round((n / trades.length) * 100)}%</span>
          </span>
        );
      })}
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const ExitQuality = panelMemo(ExitQualityInner, (d) => [d.postExit?.tracked, d.postExit?.premature, d.postExit?.worst?.length, d.strategy2Primary?.paper.closed]);
