import { useEffect, useRef, useState } from "react";
import { Maximize2, RefreshCw } from "lucide-react";
import { ChartBars, validCandles } from "@/components/panels/CoinChart";
import { PanelFeedback } from "@/components/panels/TerminalPrimitives";
import { formatPrice, formatUtc, quoteProblem } from "@/lib/terminal";
import type { TokenView } from "@/lib/terminal";
import type { ChartResponse } from "@/types/stats";

const intervals = ["1m", "5m", "15m", "1h", "4h", "12h", "1d"] as const;
interface ChartState { key: string; data: ChartResponse | null; error: string | null; loading: boolean; receivedAt: number | null }

export function TerminalChart({ token, now }: { token: TokenView | null; now: number }) {
  const [interval, setInterval] = useState<string>("5m");
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<ChartState>({ key: "", data: null, error: null, loading: false, receivedAt: null });
  const figure = useRef<HTMLElement>(null);
  const requestKey = token?.assetKey ? `${token.assetKey}:${interval}` : "";
  const chain = token?.chain;
  const contract = token?.contract;
  useEffect(() => {
    if (!requestKey || !chain || !contract) return;
    const controller = new AbortController();
    setState((previous) => ({ key: requestKey, data: previous.key === requestKey ? previous.data : null, error: null, loading: true, receivedAt: previous.key === requestKey ? previous.receivedAt : null }));
    fetch(`/api/chart?chain=${encodeURIComponent(chain)}&token=${encodeURIComponent(contract)}&tf=${interval}&bars=60`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) throw new Error("session-expired");
        if (!response.ok) throw new Error(`Riwayat chart gagal dimuat: HTTP ${response.status}`);
        const data = await response.json() as ChartResponse;
        if (!Array.isArray(data.candles) || !["geckoterminal", "gmgn-kline", null].includes(data.source)) throw new Error("Format riwayat chart tidak valid.");
        const candles = validCandles(data.candles);
        if (data.candles.length && !candles.length) throw new Error("Riwayat chart berisi candle tidak valid.");
        return { ...data, candles };
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState((previous) => {
          const retainHistory = Boolean(data.error && !data.candles.length && previous.key === requestKey && previous.data?.candles.length);
          return { key: requestKey, data: retainHistory ? previous.data : data, error: data.error || null, loading: false, receivedAt: retainHistory ? previous.receivedAt : Date.now() };
        });
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        if (error.message === "session-expired") { window.location.replace("/login"); return; }
        setState((previous) => ({ ...previous, key: requestKey, loading: false, error: error.message }));
      });
    return () => controller.abort();
  }, [requestKey, chain, contract, interval, retry]);
  const current = state.key === requestKey ? state : null;
  const rows = current?.data?.candles ?? [];
  const last = rows.at(-1);
  const min = rows.length ? Math.min(...rows.map((candle) => candle.l)) : 0;
  const max = rows.length ? Math.max(...rows.map((candle) => candle.h)) : 1;
  const span = max - min || max || 1;
  const closePercent = last ? 84 * (1 - (last.c - min) / span) : 50;
  const eligible = token && quoteProblem(token, token.quote, now) === null;
  const source = current?.data?.source === "geckoterminal" ? "GeckoTerminal" : current?.data?.source === "gmgn-kline" ? "GMGN kline" : "—";
  const loading = Boolean(requestKey && (!current || current.loading));
  const fullScreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void figure.current?.requestFullscreen?.().catch(() => {});
  };
  return <section ref={figure} className="terminal-chart" aria-label="Riwayat candle token">
    <div className="terminal-chart-toolbar"><div className="terminal-intervals" aria-label="Interval candle">{intervals.map((value) => <button key={value} type="button" aria-pressed={interval === value} onClick={() => setInterval(value)}>{value}</button>)}</div><span className="terminal-chart-source">{source}<span className="terminal-badge">{current?.data ? current.data.cached ? "CACHE" : "HISTORI" : "—"}</span></span><button type="button" className="terminal-icon" aria-label="Muat ulang riwayat chart" disabled={!requestKey || loading} onClick={() => setRetry((value) => value + 1)}><RefreshCw size={14} /></button><button type="button" className="terminal-icon terminal-chart-expand" aria-label="Perbesar chart" onClick={fullScreen}><Maximize2 size={14} /></button></div>
    <div className="terminal-ohlc"><span>{token?.symbol ?? "—"} / USD · {interval}</span>{(["o", "h", "l", "c"] as const).map((field) => <span key={field}>{field.toUpperCase()} <b>{formatPrice(last?.[field])}</b></span>)}</div>
    {current?.error && <div className="terminal-inline-note" role="alert"><span>{current.error}{rows.length ? " · menampilkan riwayat valid terakhir" : ""}</span><button type="button" onClick={() => setRetry((value) => value + 1)}>Coba lagi</button></div>}
    <figure className="terminal-chart-figure" aria-busy={loading}>
      {rows.length >= 2 ? <><div className="terminal-chart-plot"><ChartBars candles={rows} height={330} terminal label={`Riwayat ${token?.symbol ?? "token"} · ${interval}, candle dan volume, bukan harga unit live`} /></div><div className="terminal-price-axis">{[0.1, 0.35, 0.6, 0.85].map((fraction) => <span key={fraction} style={{ top: `${fraction * 84}%` }}>{formatPrice(min + span * (1 - fraction)).replace("$", "")}</span>)}<div className="terminal-cache-close" style={{ top: `${Math.max(3, Math.min(79, closePercent))}%` }}><span>{formatPrice(last?.c).replace("$", "")}</span><small>CLOSE · {current?.data?.cached ? "CACHE" : "HISTORI"}</small></div><small>Vol.</small></div><div className="terminal-chart-times">{[rows[0], rows[Math.floor(rows.length / 3)], rows[Math.floor(rows.length * 2 / 3)], last].map((candle, index) => <span key={index}>{formatUtc(candle?.t).slice(0, 5)}</span>)}</div></> : <PanelFeedback state={loading ? "loading" : current?.error ? "error" : "empty"} title={loading ? "Memuat riwayat candle…" : !token ? "Pilih token dari scanner" : !requestKey ? "Kontrak token belum tersedia" : "Belum ada riwayat candle"} message={!requestKey && token ? "Chart memerlukan chain dan kontrak dari sumber." : "Data candle terpisah dari feed dashboard dan quote unit."} onRetry={requestKey && !loading ? () => setRetry((value) => value + 1) : undefined} />}
      <figcaption className="sr-only">Chart candle historis. Close cache tidak digunakan untuk order simulasi lokal.</figcaption>
      {loading && rows.length >= 2 && <span className="terminal-chart-updating" role="status">Memperbarui riwayat…</span>}
    </figure>
    <div className="terminal-chart-caption"><span>Close terakhir {last ? formatUtc(last.t) : "—"}</span><span>Dimuat {formatUtc(current?.receivedAt)}</span><span>{eligible ? "Quote unit terpisah" : "Bukan stream harga live"}</span></div>
    {rows.length > 0 && <details className="terminal-chart-data"><summary>Data OHLC dan volume · {rows.length} candle</summary><div><table><caption className="sr-only">Data candle {token?.symbol ?? "token"}</caption><thead><tr><th>UTC</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th></tr></thead><tbody>{rows.slice().reverse().map((candle) => <tr key={candle.t}><td>{formatUtc(candle.t)}</td><td>{formatPrice(candle.o)}</td><td>{formatPrice(candle.h)}</td><td>{formatPrice(candle.l)}</td><td>{formatPrice(candle.c)}</td><td>{candle.v.toLocaleString("en-US")}</td></tr>)}</tbody></table></div></details>}
  </section>;
}
