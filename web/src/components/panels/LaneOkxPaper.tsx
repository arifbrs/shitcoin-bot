import type { LaneOkxPaperResponse } from "@/types/stats";

/**
 * Lane OKX strict-paper (2026-10-08): uang kertas, tanpa risiko.
 *
 * Prosesnya tidak mengimpor wallet/signer/broadcaster — ia meminta transaksi UNSIGNED dari OKX,
 * mensimulasikan pembelian terhadap state mainnet saat itu, lalu menghitung exit virtual dari quote
 * min-receive. Yang ditampilkan di sini adalah HASIL, bukan janji: jumlah posisi, alasan penolakan,
 * dan status hash-chain ledger (satu byte diubah → verifikasi gagal → angka ditandai tidak layak dipercaya).
 *
 * PUSH, BUKAN POLLING: ikut payload SSE `/api/stream` (buildStats → laneOkxPaper), verifikasi ledger
 * di-cache 60 detik di server.
 */
const ago = (iso: string | null): string => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s.toFixed(0)}s` : s < 5_400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3_600).toFixed(1)}j`;
};
const fmtSol = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(4)} SOL`;

export function LaneOkxPaper({ data }: { data: LaneOkxPaperResponse | null | undefined }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="OKX strict paper lane">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-scout">
            OKX OnchainOS · uang kertas · nol wallet · nol tanda tangan · nol broadcast · push realtime
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">OKX strict-paper · kebijakan v6 · 0,1 SOL virtual</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Toplist + radar/signal/tracker OKX → tx unsigned disimulasikan → exit virtual (TP +5% / SL −8% / 60s) ·
            kebijakan ketat: umur ≤5 mnt, liq ≥$20k, vol ≥$20k, mc ≤$250k, holder ≥100, rasio beli ≥0,6.
          </p>
        </div>
        {data?.ledger && (
          <span className={`font-mono text-[10px] ${data.ledger.ok ? "text-up" : "text-down"}`}>
            {data.ledger.ok
              ? `ledger UTUH · ${data.ledger.records} baris · seq ${data.ledger.lastSeq}`
              : `ledger RUSAK — ${data.ledger.error}`}
          </span>
        )}
      </div>
      {!data ? <p className="mt-4 text-xs text-muted-foreground">Menunggu kiriman stream…</p> : (
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Posisi &amp; kesiapan</h4>
            <p className="mt-2 font-mono text-[11px] text-foreground">
              {data.open.length} terbuka · {data.closedTotal} tertutup · {data.pending} menunggu · {data.scoutCache} di cache
            </p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              primed: scan {data.primed.scanner ? "✓" : "✗"} · rank {data.primed.ranking ? "✓" : "✗"} · signal {data.primed.signal ? "✓" : "✗"} · tracker {data.primed.trackers} wallet
            </p>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              budget kuota: premium {data.budget?.premiumUsed ?? 0}/10.000 · basic {data.budget?.basicUsed ?? 0}/25.000
              {data.budget?.premiumPaused || data.budget?.basicPaused ? " (DIJEDA)" : ""}
            </p>
            <p className="mt-1 font-mono text-[9px] text-muted-foreground">state ditulis {ago(data.updatedAt)} lalu</p>
            {data.open.length > 0 && (
              <div className="mt-2 space-y-1">
                {data.open.map((p) => (
                  <p key={p.id} className="truncate font-mono text-[10px] text-foreground">{p.symbol} <span className="text-muted-foreground">· {p.source} · v{p.policyVersion}</span></p>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Mengapa kandidat ditolak (24 jam)</h4>
            {data.rejectReasons.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada penolakan tercatat.</p> : (
              <div className="mt-2 space-y-1">
                {data.rejectReasons.map(([reason, n]) => (
                  <div key={reason} className="flex items-center justify-between gap-2 font-mono text-[10px]">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{reason}</span>
                    <span className="shrink-0 text-foreground">{n}×</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
              {Object.entries(data.activity24h).filter(([k]) => k !== "CANDIDATE_TERMINAL").slice(0, 8).map(([k, v]) => (
                <span key={k}>{k}={v}</span>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Penutupan terakhir (uang kertas)</h4>
            {data.recentCloses.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada posisi tertutup dalam 24 jam.</p> : (
              <div className="mt-2 max-h-56 space-y-1 overflow-auto">
                {data.recentCloses.map((c, i) => (
                  <div key={`${c.ts}-${i}`} className="flex items-center justify-between gap-2 border-b border-border/50 py-1 font-mono text-[10px] last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-foreground">{c.symbol}</span>
                    <span className="shrink-0 text-muted-foreground">{c.trigger ?? ""}</span>
                    <span className={`shrink-0 ${c.pnlSol >= 0 ? "text-up" : "text-down"}`}>{fmtSol(c.pnlSol)}</span>
                    <span className="shrink-0 text-muted-foreground">{ago(c.ts)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 font-mono text-[9px] text-muted-foreground">angka dari ledger ber-hash-chain — dipoles pun ketahuan</p>
          </div>
        </div>
      )}
    </section>
  );
}
