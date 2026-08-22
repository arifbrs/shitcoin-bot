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
/**
 * Coin art, with a letter tile as the fallback rather than a gap.
 *
 * `img` resolves ASYNCHRONOUSLY on the server (its own fetch queue), so it is absent on the
 * first tick after a trade and may never arrive for a token whose metadata is unreachable. A
 * row that collapses when the picture is missing makes the whole list jump as art trickles in;
 * the tile reserves the same box either way.
 */
function CoinIcon({ img, symbol }: { img?: string | null; symbol?: string | null }) {
  if (img) {
    return (
      <img
        src={img} alt="" loading="lazy"
        className="h-[18px] w-[18px] shrink-0 rounded-[5px] object-cover"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
      />
    );
  }
  return (
    <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-muted font-mono text-[9px] text-muted-foreground">
      {(symbol || "?").slice(0, 1)}
    </span>
  );
}

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
            <CoinIcon img={r.img} symbol={r.symbol} />
            <span className="w-[78px] truncate text-foreground" title={r.mint}>
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
 * LIVE OPEN POSITIONS — the bags we actually hold on-chain right now.
 *
 * Live positions live for ten to sixty seconds, so this tile is empty most of the time. The
 * first version answered that with one sentence in the middle of a large void, which reads as a
 * broken panel rather than a true one. Empty now says WHY it is empty and what the next buy
 * will look like, so the space carries information in both states.
 *
 * `sellFailures` is surfaced per bag because the one case that matters here is a bag fighting
 * its venue — the failure mode that stranded 25,649 tokens for an hour while the dashboard
 * cheerfully showed nothing at all.
 */
export function LivePositions({ data }: { data: StatsResponse | null }) {
  const b = data?.liveBridge;
  const lots = b?.lots ?? [];
  const last = b?.summary?.recent?.[0];

  if (lots.length === 0) {
    const clip = typeof b?.clipSol === "number" ? b.clipSol : null;
    const compound = (b?.summary?.trades ?? 0) >= 0 && clip != null;
    return (
      <div className="flex h-full flex-col gap-2 font-mono text-[10px]">
        <p className="text-muted-foreground">
          {b?.armed ? "Tidak ada bag terbuka — menunggu entry berikutnya." : "Tidak armed, tidak ada bag."}
        </p>
        <div className="flex flex-col gap-[3px]">
          <div className="flex justify-between text-muted-foreground">
            <span>clip berikutnya</span>
            <span className="text-foreground">{compound ? `${clip.toFixed(4)}◎` : "—"}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>cap exposure</span>
            <span className="text-foreground">{b?.caps?.maxDeployedSol != null ? `${b.caps.maxDeployedSol}◎` : "—"}</span>
          </div>
          {last && (
            <div className="flex justify-between text-muted-foreground">
              <span>trade terakhir</span>
              <span className={last.netSol >= 0 ? "text-up" : "text-down"}>
                {last.symbol || `${last.mint.slice(0, 6)}…`} {last.netSol >= 0 ? "+" : ""}{last.netSol.toFixed(5)}◎
              </span>
            </div>
          )}
        </div>
        <p className="mt-auto text-[8.5px] leading-tight text-muted-foreground/50">
          Posisi live umumnya hidup 10-60 detik, jadi panel ini memang lebih sering kosong
          daripada terisi. Kosong di sini artinya sehat, bukan diam.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1 overflow-y-auto font-mono text-[10px]">
      {lots.map((l) => {
        const stuck = l.sellFailures > 0;
        return (
          <div key={l.tradeId} className={`flex items-center gap-2 rounded-md px-1.5 py-1 whitespace-nowrap ${stuck ? "bg-down/10" : "hover:bg-secondary/40"}`}>
            <CoinIcon img={l.img} symbol={l.symbol} />
            <span className="w-[76px] truncate text-foreground" title={l.mint}>
              {l.symbol || `${l.mint.slice(0, 6)}…`}
            </span>
            <span className={`flex-1 truncate ${stuck ? "text-down" : "text-muted-foreground"}`}>
              {stuck ? `GAGAL JUAL ${l.sellFailures}x` : l.state}
            </span>
            <span className="w-[34px] text-right text-muted-foreground">{l.heldSec}s</span>
            <span className="w-[58px] text-right text-foreground">{l.spentSol.toFixed(4)}◎</span>
            {l.sells > 0 && <span className="w-[44px] text-right text-up">+{l.proceedsSol.toFixed(4)}</span>}
          </div>
        );
      })}
      <p className="mt-auto pt-1 text-[8.5px] leading-tight text-muted-foreground/50">
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
