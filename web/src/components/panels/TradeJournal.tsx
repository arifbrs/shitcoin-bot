import { panelMemo } from "@/lib/panelMemo";
import type { StatsResponse } from "@/types/stats";
import { CoinIcon } from "./CoinIcon";

function fmtAgo(ts: string): string {
  const sec = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  return `${Math.round(min / 60)}h`;
}

/**
 * Merges BOTH strategies' closed trades into one feed, each row tagged S1/S2 (owner, 2026-07-30:
 * "otomatis ini posisi buat sniper ini buat scout, kan lebih enak liatnya" — no shared gate/scanner
 * needed for this, both strategies already log closes independently; this just combines the two
 * existing feeds client-side instead of showing Strategy 2 only).
 */
function TradeJournalInner({ data }: { data: StatsResponse }) {
  const s2 = (data.strategy2Primary?.recentTrades ?? []).map((t) => ({ ts: t.ts, symbol: t.symbol, reason: t.reason, pnlPct: t.pnlPct, img: t.img ?? null, pnlSol: (t as { pnlSol?: number }).pnlSol, tag: ((t as { tag?: string }).tag ?? "S2") as "S1" | "S2" | "LIVE" }));
  const s1 = (data.recentTrades ?? []).map((t) => ({ ts: t.ts, symbol: t.symbol, reason: t.reason ?? "?", pnlPct: t.pnlPct, img: t.img ?? t.image ?? null, pnlSol: undefined as number | undefined, tag: "S1" as "S1" | "S2" | "LIVE" }));
  const trades = [...s1, ...s2].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)).slice(0, 30);

  if (!trades.length) {
    return <p className="font-mono text-[11px] text-muted-foreground">Belum ada trade closed.</p>;
  }

  // TWO BANKROLLS, ONE LIST — say so explicitly.
  //
  // The panel beside this one reads "TOTAL P&L · STRATEGY 2" and its equity curve tracks Strategy
  // 2's USD float alone, while this feed also carries Strategy 1 rows. Owner spotted the result:
  // the journal was showing +94.5%, +95.4%, +31.8% wins while the headline balance never moved,
  // which reads as a broken dashboard. It was not — those wins belong to a DIFFERENT wallet
  // (Strategy 1, denominated in SOL). Measured at the time: the 30 visible S1 rows summed to
  // +30.1%, while Strategy 1's actual balance was -22% from float, because the newest 30 rows
  // happened to hold the big winners. A percentage in this list is a move on its own strategy's
  // stake; the two are not additive and never feed the same equity line.

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
      {trades.map((t, i) => {
        const up = t.pnlPct >= 0;
        return (
          <div key={`${t.ts}-${i}`} className="grid grid-cols-[auto_auto_1fr_auto_auto_auto_auto] items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[10px] hover:bg-secondary/40">
            <span className={`rounded px-1 text-[8px] font-semibold ${t.tag === "LIVE" ? "bg-down/20 text-down" : t.tag === "S1" ? "bg-scout/15 text-scout" : "bg-gold/15 text-gold"}`}>{t.tag}</span>
            {/* The server has been sending `img` for every row all along — the memo fingerprint
                even tracks it — but nothing ever rendered it. */}
            <CoinIcon img={t.img} symbol={t.symbol} />
            <span className="truncate text-foreground">{t.symbol}</span>
            <span className="text-muted-foreground">{t.reason}</span>
            <span className="text-muted-foreground/70">{fmtAgo(t.ts)}</span>
            {/* REAL MONEY GETS ITS ABSOLUTE NUMBER.
                Percent alone hides that each row risked a different amount: with compounding on,
                a -74.6% on a 0.0276 clip lost MORE (-0.021 SOL) than a +156.3% on a 0.0123 clip
                made (+0.019). Reading the column as a scorecard then inverts the two. Percentages
                are also not additive — summing this column gives -152%, which means nothing.
                Only shown for live rows, so the simulation journal is untouched. */}
            {t.pnlSol !== undefined && (
              <b className={`tabular-nums ${up ? "text-up" : "text-down"}`}>{up ? "+" : ""}{t.pnlSol.toFixed(4)}◎</b>
            )}
            <b className={`tabular-nums ${up ? "text-up" : "text-down"}`}>{up ? "+" : ""}{t.pnlPct.toFixed(1)}%</b>
          </div>
        );
      })}
    </div>
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const TradeJournal = panelMemo(TradeJournalInner, (d) => [
  d.strategy2Primary?.recentTrades?.length, d.strategy2Primary?.recentTrades?.[0]?.ts,
  d.recentTrades?.length, d.recentTrades?.[0]?.ts,
  // Coin art resolves ASYNCHRONOUSLY — `img` lands on a row that is otherwise unchanged, so a
  // fingerprint of lengths and timestamps alone would freeze every icon out of existence.
  // memo:check caught this as 6 real pushes whose visible output changed without a repaint.
  d.strategy2Primary?.recentTrades?.filter((t) => t.img).length,
  d.recentTrades?.filter((t) => t.img ?? t.image).length,
]);
