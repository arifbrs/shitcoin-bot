import { useGmgnOverview } from "@/hooks/useGmgnOverview";
import { finite, formatCount, formatUsd } from "@/lib/terminal";

const SIGNAL_LABEL: Record<number, string> = { 12: "smart-money buy", 20: "KOL buy" };
const fmtUsd = (v: number | null): string => formatUsd(v, true);
const short = (w: string): string => `${w.slice(0, 6)}…${w.slice(-4)}`;
const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (finite(s) === null) return "—";
  return s < 90 ? `${s.toFixed(0)}s` : s < 5_400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3_600).toFixed(1)}j`;
};

/** Lane GMGN: sinyal 24 jam, kualitas wallet (state permanen), trade terpantau, laporan harian. */
export function LaneGmgn({ overview }: { overview?: ReturnType<typeof useGmgnOverview> } = {}) {
  const ownOverview = useGmgnOverview(!overview);
  const { data, error, loading, retry } = overview ?? ownOverview;
  const signalTotal = data ? finite(data.signals24h.reduce((a, s) => a + s.count, 0)) : null;

  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="GMGN lane">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-gold">OpenAPI resmi · read-only · pace 10s/call</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">GMGN · sinyal &amp; kualitas wallet</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Sinyal 24 jam: {formatCount(signalTotal)} · wallet terskor: {formatCount(data?.walletsScored)} · trade terpantau 24 jam: {formatCount(data?.watchedTrades24h)}
            {data?.lastCycle && ` · siklus terakhir: ${data.lastCycle.calls} call ${(data.lastCycle.ms / 1000).toFixed(1)}s (${ago(data.lastCycle.ts)} lalu)`}
          </p>
        </div>
        {data && <span className="font-mono text-[10px] text-muted-foreground">update {ago(data.updatedAt)} lalu</span>}
      </div>
      {error && <div role="alert" className="mt-2 text-xs text-muted-foreground">{error}{data ? " · menampilkan data valid terakhir" : ""}<button type="button" className="terminal-button" onClick={retry}>Coba lagi</button></div>}
      {!data ? <p className="mt-4 text-xs text-muted-foreground">{loading ? "Memuat lane…" : "Data GMGN belum tersedia —"}</p> : (
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Sinyal terbaru</h4>
            {data.recentSignals.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada sinyal.</p> : (
              <div className="mt-2 max-h-64 space-y-1 overflow-auto">
                {data.recentSignals.map((s, i) => (
                  <div key={`${s.ts}-${i}`} className="flex items-center justify-between gap-2 border-b border-border/50 py-1 font-mono text-[10px] last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-foreground">{s.sym}</span>
                    <span className="shrink-0 text-scout" title={SIGNAL_LABEL[s.signalType] ?? `type ${s.signalType}`}>t{s.signalType}</span>
                    <span className="shrink-0">{fmtUsd(s.mcUsd)}</span>
                    <span className="shrink-0 text-muted-foreground">ath {fmtUsd(s.ath)}</span>
                    <span className="shrink-0 text-muted-foreground">{ago(s.ts)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 font-mono text-[9px] text-muted-foreground">t12 = smart-money buy · t20 = KOL buy</p>
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Kualitas wallet (winrate 7h, dari GMGN)</h4>
            {data.wallets.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada wallet terskor.</p> : (
              <div className="mt-2 max-h-64 space-y-1 overflow-auto">
                {data.wallets.map((w) => (
                  <div key={w.wallet} className="border-b border-border/50 py-1 font-mono text-[10px] last:border-b-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground" title={w.wallet}>{short(w.wallet)}</span>
                      <span className={w.winrate == null ? "text-muted-foreground" : w.winrate >= 0.5 ? "text-up" : w.winrate >= 0.35 ? "text-gold" : "text-down"}>
                        win {w.winrate == null ? "—" : `${(w.winrate * 100).toFixed(0)}%`}
                      </span>
                      <span className={w.realizedProfit == null ? "text-muted-foreground" : w.realizedProfit >= 0 ? "text-up" : "text-down"}>
                        {w.realizedProfit == null ? "—" : `${w.realizedProfit >= 0 ? "+" : "−"}$${Math.abs(Math.round(w.realizedProfit)).toLocaleString("en-US")}`}
                      </span>
                    </div>
                    <p className="truncate text-[9px] text-muted-foreground" title={w.tags.join("|")}>{w.tags.slice(0, 5).join(" · ") || "tanpa tag"}{w.tokens ? ` · ${w.tokens} token` : ""}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Trade wallet terpantau (mint kita)</h4>
            {data.watchedRecent.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada trade yang menyentuh mint kita.</p> : (
              <div className="mt-2 max-h-64 space-y-1 overflow-auto">
                {data.watchedRecent.map((t, i) => (
                  <div key={`${t.ts}-${i}`} className="flex items-center justify-between gap-2 border-b border-border/50 py-1 font-mono text-[10px] last:border-b-0">
                    <span className={`w-9 shrink-0 ${t.side === "buy" ? "text-up" : "text-down"}`}>{t.side === "buy" ? "BELI" : "JUAL"}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{t.symbol}</span>
                    <span className="shrink-0 text-muted-foreground">{t.watchType}</span>
                    <span className="shrink-0">{fmtUsd(t.amountUsd)}</span>
                    <span className="shrink-0 text-muted-foreground">{ago(t.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {data?.reportMd && (
        <details className="mt-3 rounded-lg border border-border bg-background/30 p-3">
          <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Laporan harian GMGN</summary>
          <p className="mt-2 font-mono text-[9px] text-scout">{data.reportFile}</p>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">{data.reportMd}</pre>
        </details>
      )}
    </section>
  );
}
