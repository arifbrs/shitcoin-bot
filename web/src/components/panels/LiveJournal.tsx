import type { OpenPosition, StatsResponse } from "@/types/stats";
import { PositionCard } from "./PositionCard";
import { CoinIcon } from "./CoinIcon";

/**
 * LIVE TRADE JOURNAL — replaces the paper journal while real money is armed.
 *
 * Rows come from the `settled` records in the append-only `live-exec` log, deduplicated by
 * tradeId. The dedupe is not cosmetic: on the first live run a sweeper race wrote a second
 * `settled` row for one trade at -100% (it read a zero token balance while the sell was still
 * in flight, before the SOL came back). Reading the log naively showed five trades at -43%
 * where there were four at -15.9%. The log keeps both rows as the honest record of what
 * happened; the reader takes the later one.
 */
const REASON_TONE: Record<string, string> = {
  EARLY_CUT: "text-gold",
  ORPHAN_SWEEP: "text-gold",
  SWEEP_CONFIRMED_EMPTY: "text-muted-foreground",
  RETRY_EXIT: "text-gold",
  NEVER_FILLED: "text-muted-foreground",
};

export function LiveJournal({ data }: { data: StatsResponse | null }) {
  const rows = data?.liveBridge?.summary?.recent ?? [];

  if (rows.length === 0) {
    return (
      <p className="py-6 text-center font-mono text-[10px] text-muted-foreground">
        belum ada trade live yang selesai
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
        {rows.map((r) => {
          const up = r.netSol >= 0;
          return (
            <div key={`${r.tradeId}-${r.ts}`} className="grid grid-cols-[auto_auto_1fr_auto_auto_auto] items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[10px] hover:bg-secondary/40">
              <span className="rounded bg-down/20 px-1 text-[8px] font-semibold text-down">LIVE</span>
              <CoinIcon img={r.img} symbol={r.symbol} />
              <span className="truncate text-foreground" title={r.mint}>{r.symbol || `${r.mint.slice(0, 6)}…`}</span>
              <span className={REASON_TONE[r.reason] ?? "text-muted-foreground"}>{r.reason}</span>
              <span className="text-muted-foreground/70">{r.heldSec}s</span>
              <b className={up ? "text-up" : "text-down"}>{up ? "+" : ""}{(r.netPct ?? 0).toFixed(1)}%</b>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * LIVE OPEN POSITIONS — the SAME card as the paper panel, fed with live bags.
 *
 * The first version invented its own list layout. That was wrong for a reason worth stating:
 * switching from simulation to live should change the NUMBERS, not the application. A different
 * visual language for the same concept makes the eye re-learn the panel at exactly the moment
 * real money is on it, and it made the dashboard look assembled from parts.
 *
 * So this reuses `PositionCard` and joins each live bag to the paper position that decided it
 * (by mint). The card's rings — time against budget, distance to the trailing stop — belong to
 * the paper model, which is correct: the model is what decides this bag's exit. What the LIVE
 * badge adds is that the SOL in the card is real.
 */
export function LivePositions({ data }: { data: StatsResponse | null }) {
  const lots = data?.liveBridge?.lots ?? [];
  const paperOpen = data?.paper?.openPositions ?? [];

  if (lots.length === 0) {
    // Same empty treatment as OpenPositions, deliberately — a familiar panel that happens to be
    // empty reads as calm; a bespoke one reads as broken.
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-[11px] text-muted-foreground">tidak ada bag live — menunggu entry berikutnya</p>
      </div>
    );
  }

  return (
    <div className="grid h-full auto-rows-min gap-2 overflow-y-auto pr-1"
         style={{ gridTemplateColumns: "repeat(auto-fill, minmax(272px, 1fr))" }}>
      {lots.map((l) => {
        // The paper position for the same mint carries the marks and the exit-proximity data.
        // Absent (an orphan the model already closed, or a stuck bag) the card still renders —
        // with empty rings, because inventing a trail or a budget would draw a stop that does
        // not exist.
        const p = paperOpen.find((x) => x.mint === l.mint);
        const position = {
          ...(p ?? {}),
          mint: l.mint,
          symbol: l.symbol ?? p?.symbol ?? l.mint.slice(0, 6),
          img: l.img ?? (p as { img?: string | null } | undefined)?.img ?? null,
          unrealizedPnl: p?.unrealizedPnl ?? 0,
          heldSec: l.heldSec,
          entryPrice: p?.entryPrice ?? 1,
          lastPrice: p?.lastPrice ?? 1,
          marketCap: p?.marketCap ?? null,
          holders: p?.holders ?? null,
          noManualClose: true as const,
        } as unknown as OpenPosition;
        return (
          <div key={l.tradeId} className={l.sellFailures > 0 ? "rounded-xl ring-1 ring-down" : undefined}
               title={l.sellFailures > 0 ? `gagal jual ${l.sellFailures}x — ${l.lastErr ?? ""}` : undefined}>
            <PositionCard position={position} tag="LIVE" />
          </div>
        );
      })}
    </div>
  );
}

/**
 * LIVE RECAP — the one-line headline that takes the paper recap's slot in the grid.
 *
 * It replaces rather than hides: leaving the row empty would open a gap in the layout, and an
 * empty space where a headline used to be reads as "nothing is happening" at exactly the moment
 * real money is at work.
 */
export function LiveRecap({ data }: { data: StatsResponse | null }) {
  const b = data?.liveBridge;
  const s = b?.summary;
  const armed = b?.armed === true;
  const net = s?.netSol ?? 0;
  const trades = s?.trades ?? 0;
  const clip = typeof b?.clipSol === "number" ? b.clipSol : null;
  const cap24 = b?.caps?.maxDailySpendSol ?? 0;
  const left = Math.max(0, cap24 - (b?.spentLast24h ?? 0));
  const buysLeft = clip && clip > 0 ? Math.floor(left / clip) : 0;

  return (
    <div className="flex h-full items-center gap-x-5 gap-y-1 overflow-x-auto px-1 font-mono text-[10px] whitespace-nowrap">
      <span className="flex items-center gap-2 tracking-[0.14em] uppercase">
        <span className={`h-[6px] w-[6px] rounded-full ${armed ? "animate-pulse bg-down shadow-[0_0_7px_rgba(255,92,92,0.8)]" : "bg-muted-foreground/40"}`} />
        <span className={armed ? "font-semibold text-down" : "text-muted-foreground"}>
          {armed ? "LIVE · uang sungguhan" : "LIVE · disarmed"}
        </span>
      </span>
      {trades === 0 ? (
        <span className="text-muted-foreground">belum ada trade live</span>
      ) : (
        <>
          <span className={`font-semibold ${net >= 0 ? "text-up" : "text-down"}`}>
            {net >= 0 ? "+" : ""}{net.toFixed(5)}◎
          </span>
          {s?.netPct != null && (
            <span className={net >= 0 ? "text-up" : "text-down"}>
              ({s.netPct >= 0 ? "+" : ""}{s.netPct.toFixed(1)}%)
            </span>
          )}
          <span className="text-muted-foreground">{trades} trade</span>
          <span className="text-muted-foreground">{s?.wins}W/{s?.losses}L</span>
        </>
      )}
      <span className="text-muted-foreground">
        clip {clip != null ? `${clip}◎` : "—"}
      </span>
      <span className={buysLeft <= 2 ? "text-gold" : "text-muted-foreground"}>
        sisa {cap24 > 0 ? `${left.toFixed(3)}◎ · ${buysLeft} beli` : "—"}
      </span>
      {b?.halted && <span className="font-semibold text-down">⛔ HALTED — {b.haltReason ?? "kill switch"}</span>}
      {!armed && <span className="text-muted-foreground">tombol tidak di LIVE — tidak ada SOL keluar</span>}
    </div>
  );
}
