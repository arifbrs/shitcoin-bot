import type { StatsResponse } from "@/types/stats";

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
    <div className="flex flex-col gap-[3px] overflow-y-auto font-mono text-[10px]">
      {rows.map((r) => {
        const neg = r.netSol < 0;
        return (
          <div key={`${r.tradeId}-${r.ts}`} className="flex items-center gap-2 whitespace-nowrap">
            <span className="rounded bg-down/15 px-1 text-[8px] tracking-wider text-down">LIVE</span>
            <span className="w-[86px] truncate text-foreground" title={r.mint}>
              {r.symbol || `${r.mint.slice(0, 6)}…`}
            </span>
            <span className={`flex-1 truncate text-right ${REASON_TONE[r.reason] ?? "text-muted-foreground"}`}>
              {r.reason}
            </span>
            <span className="w-[38px] text-right text-muted-foreground">{r.heldSec}s</span>
            <span className={`w-[62px] text-right font-semibold ${neg ? "text-down" : "text-up"}`}>
              {r.netSol >= 0 ? "+" : ""}{r.netSol.toFixed(5)}◎
            </span>
            <span className={`w-[48px] text-right ${neg ? "text-down" : "text-up"}`}>
              {r.netPct == null ? "—" : `${r.netPct >= 0 ? "+" : ""}${r.netPct.toFixed(1)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * LIVE OPEN POSITIONS — bags we actually hold on-chain right now.
 *
 * Intentionally minimal: the count and the SOL at risk. Anything richer would have to be
 * derived from the paper model's marks, and the whole point of this view is that it never
 * borrows a paper number.
 */
export function LivePositions({ data }: { data: StatsResponse | null }) {
  const b = data?.liveBridge;
  const open = b?.openLots ?? 0;
  if (open === 0) {
    return (
      <p className="py-6 text-center font-mono text-[10px] text-muted-foreground">
        tidak ada bag live terbuka
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 font-mono text-[11px]">
      <div className="flex justify-between">
        <span className="text-muted-foreground">bag terbuka</span>
        <span className="font-semibold text-foreground">{open}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">SOL berisiko</span>
        <span className="font-semibold text-down">{(b?.deployedSol ?? 0).toFixed(4)}◎</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">cap exposure</span>
        <span className="text-foreground">{b?.caps?.maxDeployedSol != null ? `${b.caps.maxDeployedSol}◎` : "—"}</span>
      </div>
      <p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">
        Keluarnya diputuskan model paper; bridge menjual bag nyata mengikuti keputusan itu.
      </p>
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
