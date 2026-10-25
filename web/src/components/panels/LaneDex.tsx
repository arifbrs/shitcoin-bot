import { useState } from "react";
import type { LaneDexResponse } from "@/types/stats";
import { CoinChart } from "@/components/panels/CoinChart";

/**
 * Lane DexScreener (2026-10-08): 13 endpoint REST (siklus 5 menit) + 6 stream WebSocket realtime.
 *
 * PUSH, BUKAN POLLING: data datang sebagai prop dari payload SSE `/api/stream` (buildStats →
 * laneDex). Stream WS-nya diukur terbuka tanpa kunci/akun (HTTP 101, data <10 detik) — biaya tidak
 * dipublikasikan DexScreener, kenyataan uji: tidak berbayar.
 *
 * Angka likuiditas ditempel di setiap baris dengan sengaja: "naik 900%" tanpa likuiditas adalah
 * jebakan, dan di layar ini jebakan itu harus terbaca sebagai jebakan.
 */
const fmtUsd = (v: number | null): string =>
  v == null ? "—" : `$${Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0)}`;
const fmtPct = (v: number | null): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`);
const ago = (iso: string | null): string => {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${s.toFixed(0)}s` : s < 5_400 ? `${(s / 60).toFixed(0)}m` : `${(s / 3_600).toFixed(1)}j`;
};
const thin = (liq: number | null): boolean => liq != null && liq < 15_000;

export function LaneDex({ data }: { data: LaneDexResponse | null | undefined }) {
  const wsAlive = data?.ws?.alive ?? 0;
  // KLIK KOIN → lilin (2026-10-08). On-demand, bukan polling: satu-satunya sumber lilin gratis
  // (GeckoTerminal) berbagi limit per-IP dengan lane Robinhood yang sedang berdagang.
  const [pick, setPick] = useState<{ chain: string; token: string; symbol: string } | null>(null);
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="DexScreener lane">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-scout">
            13 endpoint REST + 6 stream WebSocket realtime · tanpa kunci · push realtime
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">DexScreener · promosi, narasi &amp; pergerakan</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Watchlist {data?.watchlistTotal ?? 0} token · {data?.cycles24h ?? 0} siklus 24 jam · WS {wsAlive}/6 stream hidup
            {data?.wsReconnects ? ` · ${data.wsReconnects} sambung-ulang` : ""} · biaya: tidak dipublikasikan (uji: gratis)
          </p>
        </div>
        {data && (
          <span className="font-mono text-[10px] text-muted-foreground">
            siklus terakhir {data.lastCycle ? `${data.lastCycle.calls} call ${((data.lastCycle.ms ?? 0) / 1000).toFixed(1)}s` : "—"} · update {ago(data.updatedAt)} lalu
          </span>
        )}
      </div>
      {!data ? <p className="mt-4 text-xs text-muted-foreground">Menunggu kiriman stream…</p> : (
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/30 p-3">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Promosi berbayar teratas · kondisi poolnya</h4>
            {data.promotions.length === 0 ? <p className="mt-2 text-xs text-muted-foreground">Belum ada boost terpantau.</p> : (
              <div className="mt-2 max-h-64 space-y-1 overflow-auto">
                {data.promotions.map((p, i) => (
                  <button
                    key={`${p.token}-${i}`}
                    onClick={() => setPick({ chain: p.chain, token: p.token, symbol: p.symbol ?? `${p.token.slice(0, 8)}…` })}
                    className={`flex w-full items-center justify-between gap-2 border-b border-border/50 py-1 text-left font-mono text-[10px] last:border-b-0 hover:bg-background/60 ${pick?.token === p.token ? "bg-background/60" : ""}`}
                  >
                    <span className="w-14 shrink-0 text-scout">{fmtUsd(p.amountUsd)}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{p.symbol ?? `${p.token.slice(0, 8)}…`} <span className="text-muted-foreground">· {p.chain}</span></span>
                    <span className={thin(p.liqUsd) ? "shrink-0 text-down" : "shrink-0 text-muted-foreground"}>liq {fmtUsd(p.liqUsd)}{thin(p.liqUsd) ? " ⚠" : ""}</span>
                    <span className="shrink-0 text-muted-foreground">vol {fmtUsd(p.vol24)}</span>
                    <span className={`w-14 shrink-0 text-right ${(p.chg24 ?? 0) >= 0 ? "text-up" : "text-down"}`}>{fmtPct(p.chg24)}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 font-mono text-[9px] text-muted-foreground">promosi = UPAYA berbayar, bukan kualitas — lihat kolom liq · klik baris untuk lihat lilinnya</p>
          </div>
          <div className="grid gap-3">
            <div className="rounded-lg border border-border bg-background/30 p-3">
              <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Pergerakan 24 jam · liq sebagai pengaman</h4>
              <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                {data.movers.map((m, i) => (
                  <button
                    key={`${m.symbol}-${i}`}
                    onClick={() => setPick({ chain: m.chain, token: m.token, symbol: m.symbol })}
                    disabled={!m.token}
                    className="flex w-full items-center justify-between gap-2 border-b border-border/50 py-1 text-left font-mono text-[10px] last:border-b-0 enabled:hover:bg-background/60 disabled:cursor-default"
                  >
                    <span className="min-w-0 flex-1 truncate text-foreground">{m.symbol} <span className="text-muted-foreground">· {m.chain}</span></span>
                    <span className={thin(m.liqUsd) ? "text-down" : "text-muted-foreground"}>liq {fmtUsd(m.liqUsd)}{thin(m.liqUsd) ? " ⚠jebakan?" : ""}</span>
                    <span className={`w-16 shrink-0 text-right ${(m.chg24 ?? 0) >= 0 ? "text-up" : "text-down"}`}>{fmtPct(m.chg24)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/30 p-3">
              <h4 className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Narasi (meta) &amp; penemuan 24 jam</h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.metas.map((m) => (
                  <span key={m.slug} className="rounded border border-border bg-background/50 px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                    {m.slug} · {m.tokens} token · {fmtUsd(m.vol)}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
                {Object.entries(data.discovered).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <span key={k}>{k}={v}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {pick && <CoinChart chain={pick.chain} token={pick.token} symbol={pick.symbol} onClose={() => setPick(null)} />}
    </section>
  );
}
