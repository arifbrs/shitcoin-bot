import { useState } from "react";
import { filterVariants } from "@/lib/dashboard";
import { Search } from "lucide-react";
import type { RobinhoodPaperResponse } from "@/types/stats";

/**
 * Lane Robinhood (Ethereum L2, chain 4663): 10 varian paper, risk $5/trade.
 *
 * PUSH, BUKAN POLLING (2026-10-07, permintaan owner): data datang sebagai prop dari payload SSE
 * `/api/stream` (lihat Dashboard → useLiveStats). Server mengirim frame baru setiap ada tulisan di
 * log-dir (mark posisi tiap 30 detik), jadi panel ini update begitu state berubah — bukan timer.
 */
const fmtPnl = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`);
const fmtPrice = (v: number | null): string => (v == null ? "—" : `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 1 ? 6 : 2 })}`);
const ago = (iso: string): string => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s.toFixed(0)}s` : s < 5_400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3_600).toFixed(1)}j`;
};
const markAgo = (sec: number | null): string => (sec == null ? "?" : sec < 90 ? `${sec}s` : `${Math.round(sec / 60)}m`);

export function LaneRobinhood({ data }: { data: RobinhoodPaperResponse | null | undefined }) {
  const [query, setQuery] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(false);
  const variants = filterVariants(data?.variants ?? [], query, onlyOpen);
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Robinhood Chain paper lane">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-scout">Ethereum L2 · chain 4663 · paper · nol wallet · nol eksekusi · push realtime</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Robinhood · {data?.variants.length ?? "—"} varian forward test</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Risk $5/trade · modal awal {data ? `$${data.startEquityUsd.toFixed(0)}` : "$100"}/varian · kriteria lulus: ≥7 hari & ≥10 trade tertutup per varian.
          </p>
        </div>
        {data && (
          <span className="font-mono text-xs text-muted-foreground">
            umur {data.laneDays.toFixed(1)} hari · {data.cycles} siklus · {data.openTotal} posisi terbuka · update {ago(data.updatedAt)} lalu
          </span>
        )}
      </div>
      {!data ? <p className="mt-4 text-xs text-muted-foreground">Menunggu kiriman stream (server mengirim saat state ditulis)…</p> : (
        <>
          <div className="variant-toolbar">
            <label className="variant-search"><Search size={16} /><span className="sr-only">Cari varian, kohort, atau token</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari varian, kohort, atau token…" /></label>
            <label className="variant-toggle"><input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} />Posisi terbuka saja</label>
            <span role="status" className="text-xs text-muted-foreground">{variants.length} / {data.variants.length} varian</span>
          </div>
          {variants.length === 0 && <div className="console-empty"><p>{data.variants.length ? "Tidak ada varian yang cocok." : "Belum ada varian tersedia."}</p>{(query || onlyOpen) && <button type="button" className="text-action" onClick={() => { setQuery(""); setOnlyOpen(false); }}>Reset filter</button>}</div>}
          {/* DIKELOMPOKKAN PER KOHORT (2026-10-10): dengan 43 varian, daftar rata membuat kohort-1
              (mark30s) tak bisa dibedakan dari kohort-5 (stop/likuiditas). Urutan mengikuti urutan
              varian dari server (id), jadi kohort muncul berurutan tanpa pemetaan nama di UI. */}
          {Object.entries(
            variants.reduce<Record<string, typeof data.variants>>((acc, v) => {
              const k = v.cohort ?? "(tanpa kohort)";
              (acc[k] ??= []).push(v);
              return acc;
            }, {}),
          ).map(([cohort, list]) => (
            <div key={cohort} className="mt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-scout">{cohort}</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  {list.length} varian · net life-berjalan {fmtPnl(list.reduce((a, v) => a + v.pnlUsd, 0))}
                </p>
              </div>
              <div className="mt-1.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((v) => (
                  <div key={v.id} className="rounded-lg border border-border bg-background/40 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate font-mono text-xs text-foreground" title={v.id}>{v.id}{v.life > 1 ? ` · life ${v.life}` : ""}</p>
                      <span className={`font-mono text-[11px] ${v.status === "bankrut" ? "text-down" : v.status === "siap direview" ? "text-up" : "text-muted-foreground"}`}>
                        {v.status === "bankrut" ? "BANKRUT" : v.status === "siap direview" ? "SIAP" : "jalan"}
                      </span>
                    </div>
                    <p className={`mt-1 font-mono text-xl ${v.pnlUsd >= 0 ? "text-up" : "text-down"}`}>
                      {fmtPnl(v.pnlUsd)} <span className="text-[11px] text-muted-foreground">eq ${v.equityUsd.toFixed(2)}</span>
                    </p>
                    {v.life > 1 && (
                      <p className={`font-mono text-[11px] ${v.cumulativePnlUsd >= 0 ? "text-up" : "text-down"}`}>kumulatif {fmtPnl(v.cumulativePnlUsd)} (semua life)</p>
                    )}
                    <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{v.trades} trade · W{v.wins}/L{v.losses} · win {v.winRate ?? "—"}% · dd {v.maxDdPct}%</p>
                    {v.exposureUsd > 0 && (
                      <p className={`font-mono text-[11px] ${v.exposureUsd > Math.max(v.equityUsd, 0.01) ? "text-down" : "text-muted-foreground"}`}>
                        exposure ${v.exposureUsd.toFixed(2)}{v.exposureUsd > Math.max(v.equityUsd, 0.01) ? " (MELEBIHI equity!)" : ""}
                      </p>
                    )}
                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={v.positions.map((p) => p.symbol).join(", ")}>
                      {v.openPositions} posisi{v.positions.length ? `: ${v.positions.slice(0, 4).map((p) => p.symbol).join(", ")}` : ""}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-background/30 p-3">
              <h4 className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Trade terakhir</h4>
              {data.recent.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada trade.</p> : (
                <div className="mt-2 max-h-64 space-y-1 overflow-auto">
                  {data.recent.map((t, i) => (
                    <div key={`${t.ts}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-1 font-mono text-xs last:border-b-0">
                      <span className={`w-10 shrink-0 ${t.action === "RH_OPEN" ? "text-scout" : "text-muted-foreground"}`}>{t.action === "RH_OPEN" ? "BUKA" : "TUTUP"}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{t.symbol} <span className="text-muted-foreground">· {t.variant}</span></span>
                      <span className="shrink-0 text-muted-foreground">{t.reason ?? ""}</span>
                      <span className={`shrink-0 ${t.pnlUsd == null ? "text-muted-foreground" : t.pnlUsd >= 0 ? "text-up" : "text-down"}`}>
                        {t.pnlUsd == null ? fmtPrice(t.entryPriceUsd) : `${fmtPnl(t.pnlUsd)} (${t.pnlPct}%)`}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{ago(t.ts)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg border border-border bg-background/30 p-3">
              <h4 className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Posisi terbuka · harga mark terakhir</h4>
              {data.openTotal === 0 ? <p className="mt-2 text-xs text-muted-foreground">Tidak ada posisi terbuka.</p> : (
                <div className="mt-2 max-h-64 space-y-1 overflow-auto">
                  {data.variants.flatMap((v) => v.positions.map((p) => ({ variant: v.id, ...p }))).map((p, i) => (
                    <div key={`${p.variant}-${p.symbol}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 py-1 font-mono text-xs last:border-b-0">
                      <span className="min-w-0 flex-1 truncate text-foreground">{p.symbol}</span>
                      <span className="text-muted-foreground">{p.variant}</span>
                      <span>{fmtPrice(p.lastPrice)}</span>
                      <span className={p.markAgeSec != null && p.markAgeSec > 600 ? "text-gold" : "text-muted-foreground"}>mark {markAgo(p.markAgeSec)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {(data.backtestMd || data.reviewMd) && (
            <details className="mt-3 rounded-lg border border-border bg-background/30 p-3">
              <summary className="cursor-pointer font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Laporan backtest &amp; review harian</summary>
              {data.reviewMd && (<>
                <p className="mt-2 font-mono text-[11px] text-scout">{data.reviewFile}</p>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{data.reviewMd}</pre>
              </>)}
              {data.backtestMd && (<>
                <p className="mt-3 font-mono text-[11px] text-scout">{data.backtestFile}</p>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{data.backtestMd}</pre>
              </>)}
            </details>
          )}
        </>
      )}
    </section>
  );
}
