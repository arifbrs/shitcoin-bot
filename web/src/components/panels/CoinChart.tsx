import { useEffect, useState } from "react";
import type { ChartCandleView, ChartResponse } from "@/types/stats";

/**
 * GRAFIK PER KOIN (2026-10-08) — muncul saat sebuah koin DIKLIK, bukan polling.
 *
 * Kenapa begitu: satu-satunya sumber lilin gratis adalah GeckoTerminal, dan limitnya per-IP serta
 * dipakai bersama lane Robinhood. Permintaan manual + cache 60 detik di server + single-flight =
 * grafik tetap tersedia tanpa menyerobot kuota lane yang sedang berdagang.
 *
 * ChartBars dipisah sebagai komponen murni supaya bisa diuji render-nya tanpa jaringan.
 */
const fmtPrice = (v: number): string => (v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(4)}`);
const fmtUsd = (v: number): string => `$${Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0)}`;

export function ChartBars({ candles, height = 150 }: { candles: ChartCandleView[]; height?: number }) {
  const rows = candles.slice(-60);
  if (rows.length < 2) return <p className="mt-2 text-xs text-muted-foreground">Lilin tidak cukup untuk digambar.</p>;
  const min = Math.min(...rows.map((c) => c.l));
  const max = Math.max(...rows.map((c) => c.h));
  const span = max - min || max || 1;
  const vmax = Math.max(...rows.map((c) => c.v), 1);
  const W = 600, H = height, volH = 28;
  const bw = W / rows.length;
  const y = (p: number): number => H - volH - ((p - min) / span) * (H - volH - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="grafik lilin">
      {rows.map((c, i) => {
        const x = i * bw;
        const up = c.c >= c.o;
        const bodyTop = y(Math.max(c.o, c.c));
        const bodyBot = y(Math.min(c.o, c.c));
        const cls = up ? "text-up" : "text-down";
        return (
          <g key={c.t} className={cls}>
            <line x1={x + bw / 2} x2={x + bw / 2} y1={y(c.h)} y2={y(c.l)} stroke="currentColor" strokeWidth={1} opacity={0.6} />
            <rect x={x + bw * 0.15} width={Math.max(1, bw * 0.7)} y={bodyTop} height={Math.max(1, bodyBot - bodyTop)} fill="currentColor" />
            <rect x={x + bw * 0.15} width={Math.max(1, bw * 0.7)} y={H - (c.v / vmax) * volH} height={Math.max(1, (c.v / vmax) * volH)} fill="currentColor" opacity={0.35} />
          </g>
        );
      })}
    </svg>
  );
}

export function CoinChart({ chain, token, symbol, onClose }: { chain: string; token: string; symbol: string; onClose: () => void }) {
  const [tf, setTf] = useState("5m");
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ChartResponse | null>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/chart?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(token)}&tf=${tf}&bars=60`, { credentials: "same-origin" })
      .then((r) => r.json() as Promise<ChartResponse>)
      .then((d) => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) { setData(null); setLoading(false); } });
    return () => { alive = false; };
  }, [chain, token, tf]);
  const rows = data?.candles ?? [];
  const first = rows[0], last = rows[rows.length - 1];
  const chg = first && last ? ((last.c - first.o) / first.o) * 100 : null;
  return (
    <div className="mt-3 rounded-lg border border-scout/40 bg-background/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-foreground">
            {symbol} <span className="text-muted-foreground">· {chain} · {token.slice(0, 10)}…</span>
          </p>
          <p className="font-mono text-[9px] text-muted-foreground">
            {loading ? "mengambil lilin…"
              : data?.error ? data.error
              : `${rows.length} lilin · ${data?.source === "gmgn-kline" ? "GMGN kline (cadangan)" : "GeckoTerminal"}${data?.cached ? " · cache" : ""}${chg != null ? ` · ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%` : ""}${last ? ` · terakhir ${fmtPrice(last.c)}` : ""}${rows.length ? ` · vol ${fmtUsd(rows.reduce((a, c) => a + c.v, 0))}` : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {["1m", "5m", "15m", "1h"].map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${tf === t ? "border-scout text-scout" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {t}
            </button>
          ))}
          <button onClick={onClose} className="rounded border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground hover:text-foreground">tutup</button>
        </div>
      </div>
      {!loading && rows.length >= 2 && <ChartBars candles={rows} />}
      {!loading && rows.length < 2 && !data?.error && <p className="mt-2 text-xs text-muted-foreground">Tidak ada lilin untuk {tf}.</p>}
    </div>
  );
}
