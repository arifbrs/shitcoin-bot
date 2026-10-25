import { panelMemo } from "@/lib/panelMemo";
import type { StatsResponse } from "@/types/stats";

/**
 * RUN LEDGER — the answer to "is this a balance reset or actual profit?"
 *
 * `autoReset` refills the paper float back to its starting value every ~300 trades, so the
 * balance visibly jumps UP without a single winning trade behind it. Every other panel shows
 * the CURRENT run only (server.ts slices at the last RESET marker), which meant three losing
 * runs could scroll past unseen and a refill read as a gain. This panel is the one place the
 * whole history is stated, with the refill named as a refill.
 */
function RunLedgerInner({ data }: { data: StatsResponse }) {
  const r = data.runs;
  if (!r && data.liveBridge?.armed) {
    // Live view zeroes `runs` (no float → no refills → no run history). The old body here said
    // "Belum ada data run." — a PAPER message ("not yet") under a tile labelled "tidak berlaku",
    // promising data that by construction can never arrive. Say what IS true instead.
    return (
      <div className="flex h-full flex-col justify-center gap-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
        <p>
          <span className="font-semibold text-down">LIVE</span> — konsep run tidak berlaku: dompet
          sungguhan tidak punya float yang di-refill otomatis, jadi tidak ada sejarah run untuk
          dinilai.
        </p>
        <p>
          Pertanyaan padanannya di live: apakah hasil bersih melawan biaya? Jawabannya ada di{" "}
          <span className="text-foreground">Trade Journal</span> (per trade) dan{" "}
          <span className="text-foreground">Exit Quality</span> (distribusi alasan keluar).
        </p>
      </div>
    );
  }
  if (!r) return <p className="font-mono text-xs text-muted-foreground">Belum ada data run.</p>;

  const rows = r.recent ?? [];
  const lt = r.lifetime;
  const anyProfit = (lt?.profitable ?? r.profitable) > 0;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-2xl tabular-nums text-foreground">
          {lt ? `${lt.profitable}/${lt.runs}` : `${r.profitable}/${r.completed}`}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">run berakhir untung (seumur hidup)</span>
        {lt && (
          <span className={`font-mono text-[11px] tabular-nums ${lt.pnlSol >= 0 ? "text-up" : "text-down"}`}>
            total {lt.pnlSol >= 0 ? "+" : ""}
            {lt.pnlSol.toFixed(4)} ◎ · {lt.trades} trade
          </span>
        )}
      </div>

      {!anyProfit && (lt?.runs ?? r.completed) > 0 && (
        <p className="rounded border border-down/30 bg-down/5 px-2 py-1 font-mono text-[10px] leading-snug text-down">
          Saldo yang naik kembali ke float awal itu <strong>pengisian ulang otomatis</strong> tiap ~300
          trade, bukan keuntungan. {lt?.runs ?? r.completed} run selesai, {lt?.profitable ?? r.profitable} untung.
        </p>
      )}

      {/* flex-1 + min-h-0 so the table gets the leftover height and scrolls inside it. Without
          min-h-0 a flex child refuses to shrink below its content, and the `mt-auto` footer below
          squeezed this container to zero — the header rendered, every data row was clipped. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full font-mono text-[10px] tabular-nums">
          <thead className="sticky top-0 bg-card">
            <tr className="text-muted-foreground">
              <th className="pb-1 text-left font-normal">run</th>
              <th className="pb-1 text-right font-normal">trade</th>
              <th className="pb-1 text-right font-normal">P&amp;L ◎</th>
              <th className="pb-1 text-right font-normal">akhir ◎</th>
              <th className="pb-1 text-right font-normal">sebab</th>
              <th className="pb-1 pr-3 text-right font-normal">cfg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={x.run ?? i} className="text-muted-foreground">
                <td className="py-0.5 text-left text-foreground">
                  {x.run ?? "—"}
                  {x.measurementInvalid && <span className="ml-1 text-gold" title="dikarantina dari statistik">⚑</span>}
                </td>
                <td className="py-0.5 text-right">{x.trades ?? "—"}</td>
                <td className={`py-0.5 text-right ${(x.pnlSol ?? 0) >= 0 ? "text-up" : "text-down"}`}>
                  {x.pnlSol != null ? `${x.pnlSol >= 0 ? "+" : ""}${x.pnlSol.toFixed(4)}` : "—"}
                </td>
                <td className="py-0.5 text-right">{x.finalSol != null ? x.finalSol.toFixed(4) : "—"}</td>
                <td className="py-0.5 text-right">{x.reason ?? "—"}</td>
                <td className={`py-0.5 pr-3 text-right ${x.sameCfg ? "text-gold" : ""}`} title={x.sameCfg ? "setelan yang berjalan sekarang" : "setelan lama"}>
                  {x.cfg ?? "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-1 text-muted-foreground">
                  belum ada run yang selesai
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <p className="shrink-0 font-mono text-[9px] leading-snug text-muted-foreground">
          Daftar memuat semua setelan; vonis edge hanya memakai {r.completed} run bercfg{" "}
          <span className="text-gold">{r.cfg}</span> ·{" "}
          {r.edge === "need-more-runs" ? "belum cukup run untuk vonis edge" : `edge: ${r.edge}`}
        </p>
      )}
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const RunLedger = panelMemo(RunLedgerInner, (d) => [d.runs?.recent?.length, d.runs?.lifetime?.trades]);
