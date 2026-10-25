import { useEffect, useState } from "react";
import { usePumpwatch, type PumpwatchConnection } from "@/hooks/usePumpwatch";
import type { PumpwatchEvent, PumpwatchToken } from "@/types/pumpwatch";

const ago = (ts: number | null): string => {
  if (ts == null) return "—";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 90 ? `${s.toFixed(0)}s lalu` : s < 5_400 ? `${(s / 60).toFixed(0)}m lalu` : `${(s / 3_600).toFixed(1)}j lalu`;
};
const CONN_LABEL: Record<PumpwatchConnection, { text: string; cls: string }> = {
  connecting: { text: "menyambung", cls: "text-muted-foreground" },
  live: { text: "langsung", cls: "text-emerald-400" },
  stalled: { text: "TERLAMBAT", cls: "text-amber-400" },
  error: { text: "galat", cls: "text-red-400" },
};
const COV_TONE: Record<string, string> = { DATA_COMPLETE: "text-emerald-400", DATA_INCOMPLETE: "text-amber-400", COVERAGE_UNKNOWN: "text-muted-foreground", WINDOW_NOT_MATURED: "text-muted-foreground" };
const clsTone = (state: string): string => state === "CONFIRMED" ? "text-emerald-400" : state === "REJECTED" ? "text-red-400" : state === "PENDING" ? "text-amber-400" : "text-muted-foreground";

function EventRow({ e }: { e: PumpwatchEvent }) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3 font-mono text-[11px] text-foreground">{e.symbol ?? e.mint.slice(0, 8)}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-muted-foreground">{e.detectionClass}</td>
      <td className="py-1.5 pr-3 font-mono text-[11px] text-right">${e.usd.toFixed(0)}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-muted-foreground">{e.canonicalIdQuality === "SIG_IX_TRADER" ? "sig+ix" : "sig"}</td>
      <td className={`py-1.5 pr-3 font-mono text-[10px] ${clsTone(e.conf?.state ?? "PENDING")}`}>{e.conf?.state ?? "—"}</td>
      <td className={`py-1.5 pr-3 font-mono text-[10px] ${COV_TONE[e.conf?.coverage ?? ""] ?? ""}`}>{e.conf?.coverage ?? "—"}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{e.conf?.followers ?? "—"}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-foreground">{e.conf?.rapidSell ?? "—"}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{e.conf?.netFlowSol != null ? `${e.conf.netFlowSol > 0 ? "+" : ""}${e.conf.netFlowSol.toFixed(2)}` : "—"}</td>
      <td className="py-1.5 font-mono text-[10px] text-muted-foreground" title={e.conf?.reason ?? undefined}>{e.conf?.reason?.slice(0, 34) ?? "—"}</td>
    </tr>
  );
}

function TokenRow({ t }: { t: PumpwatchToken }) {
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-3 font-mono text-[11px] text-foreground">{t.symbol ?? t.mint.slice(0, 8)}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-muted-foreground">{t.source}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{t.ageMin.toFixed(0)}m</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{t.tradeCount}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{t.distinctTraders}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{t.buySol.toFixed(1)}/{t.sellSol.toFixed(1)}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right">{t.largeBuys > 0 ? <span className="text-gold">{t.largeBuys}</span> : <span className="text-muted-foreground">0</span>}</td>
      <td className="py-1.5 pr-3 font-mono text-[10px] text-right text-foreground">{t.smallSells}</td>
      <td className="py-1.5 font-mono text-[10px] text-muted-foreground">{t.coverageError ? "RPC-err" : t.backlogPossible ? "backlog" : "ok"}</td>
    </tr>
  );
}

/** (S12) Lane riset pump-caller: kesehatan observer + token + event H2 + outcome — semua dari jurnal. */
export function LanePumpfun() {
  const [paused, setPaused] = useState(false);
  const { data, error, receivedAt, connection, retry } = usePumpwatch(paused);
  const [, force] = useState(0);
  useEffect(() => { const t = window.setInterval(() => force((v) => v + 1), 5_000); return () => window.clearInterval(t); }, []);

  const o = data?.observer;
  const conn = CONN_LABEL[connection];
  return (
    <section className="rounded-xl border border-border bg-card p-4" aria-label="Pump.fun research lane">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-gold">Riset H2 · observer kontinu · nol modal</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Pump.fun · caller intelligence</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {o ? <>jurnal {o.journalRows} baris · feed pumpportal <b className={o.feed.state === "open" ? "text-emerald-400" : "text-amber-400"}>{o.feed.state ?? "?"}</b> · pass terakhir {ago(o.lastPassTs)} · trade terakhir {ago(o.lastTradeTs)}</> : "memuat jurnal…"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {receivedAt != null && <span className="font-mono text-[10px] text-muted-foreground">update {ago(receivedAt)}</span>}
          <span className={`font-mono text-[10px] uppercase ${conn.cls}`}>● {conn.text}</span>
          <button type="button" className="terminal-button !px-2 !py-1 text-[10px]" onClick={() => setPaused((p) => !p)}>{paused ? "Lanjutkan" : "Jeda tampilan"}</button>
          <button type="button" className="terminal-button !px-2 !py-1 text-[10px]" onClick={retry}>Muat ulang</button>
        </div>
      </div>

      {error && <p className="mt-2 rounded border border-red-500/40 bg-red-500/10 p-2 font-mono text-[11px] text-red-300">galat /api/pumpwatch: {error}</p>}
      {o && o.staleSec != null && o.staleSec > 90 && (
        <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 font-mono text-[11px] text-amber-300">
          Jurnal pump-caller tak menulis {Math.round(o.staleSec / 60)}m — observer bisa mati; candle berikut mungkin tertunda (bukan tick realtime).
        </p>
      )}
      {o && o.feed.state && o.feed.state !== "open" && (
        <p className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 font-mono text-[11px] text-amber-300">
          Feed PumpPortal tidak sehat ({o.feed.state}{o.feed.detail ? `: ${o.feed.detail}` : ""}) — discovery berjalan via fallback GMGN trending (kohor terpisah, bukan launch real-time).
        </p>
      )}

      {data && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded border border-border bg-background/40 p-2">
              <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Gap akuisisi terbuka</p>
              <p className="mt-1 font-mono text-sm text-foreground">{o!.openGaps} / {o!.coveragePasses} pass</p>
              <p className="font-mono text-[9px] text-muted-foreground">missing=0 ≠ cakupan penuh; backlog={o!.backlogPasses}</p>
            </div>
            <div className="rounded border border-border bg-background/40 p-2">
              <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Latensi</p>
              <p className="mt-1 font-mono text-sm text-foreground">deteksi {o!.detectionLatencyMs != null ? `${(o!.detectionLatencyMs / 1000).toFixed(1)}s` : "—"} · sumber {o!.sourceLatencyMs != null ? `${(o!.sourceLatencyMs / 1000).toFixed(1)}s` : "—"}</p>
              <p className="font-mono text-[9px] text-muted-foreground">window real-time registrasi = 90s</p>
            </div>
            <div className="rounded border border-border bg-background/40 p-2">
              <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Keputusan (terpisah)</p>
              <p className="mt-1 font-mono text-sm text-foreground">admisi {data.decisions.admission.total} (skip {data.decisions.admission.skip}) · H2 {data.decisions.h2.length}</p>
              <p className="font-mono text-[9px] text-muted-foreground">admisi ≠ event H2 — tidak dicampur</p>
            </div>
            <div className="rounded border border-border bg-background/40 p-2">
              <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">Fixture</p>
              <p className="mt-1 font-mono text-sm text-foreground">{data.fixtures} baris</p>
              <p className="font-mono text-[9px] text-muted-foreground">dikecualikan dari sampel riset</p>
            </div>
          </div>

          <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-gold">Watchlist token (diamati)</h3>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-left"><thead><tr className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              <th className="pr-3 pb-1">token</th><th className="pr-3 pb-1">sumber</th><th className="pr-3 pb-1 text-right">umur</th><th className="pr-3 pb-1 text-right">trade</th><th className="pr-3 pb-1 text-right">trader</th><th className="pr-3 pb-1 text-right">buy/sell SOL</th><th className="pr-3 pb-1 text-right">large-buy</th><th className="pr-3 pb-1 text-right">small-sell</th><th className="pb-1">cakupan</th>
            </tr></thead>
              <tbody>{data.tokens.map((t) => <TokenRow key={t.mint} t={t} />)}</tbody>
            </table>
          </div>

          <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-gold">Event H2 — REALTIME (prospektif)</h3>
          <p className="font-mono text-[9px] text-muted-foreground">hanya kelas REALTIME + konfirmasi berbasis bukti cakupan yang dapat mendukung keputusan</p>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full text-left"><thead><tr className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              <th className="pr-3 pb-1">token</th><th className="pr-3 pb-1">kelas</th><th className="pr-3 pb-1 text-right">USD</th><th className="pr-3 pb-1">kanonik</th><th className="pr-3 pb-1">state</th><th className="pr-3 pb-1">cakupan</th><th className="pr-3 pb-1 text-right">pengikut</th><th className="pr-3 pb-1">rapid-sell</th><th className="pr-3 pb-1 text-right">net-flow</th><th className="pb-1">alasan</th>
            </tr></thead>
              <tbody>{data.events.realtime.length ? data.events.realtime.map((e) => <EventRow key={e.h2EventId} e={e} />) : <tr><td colSpan={10} className="py-2 font-mono text-[11px] text-muted-foreground">belum ada event REALTIME — menunggu large-buy ≥$500 pasca-admisi (sampel real-time, bukan fixture)</td></tr>}</tbody>
            </table>
          </div>

          <details className="mt-3"><summary className="cursor-pointer font-mono text-[10px] uppercase tracking-wider text-muted-foreground">event historis / backfill ({data.events.historical.length}) — TIDAK prospektif</summary>
            <div className="mt-1 overflow-x-auto">
              <table className="w-full text-left"><thead><tr className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground"><th className="pr-3 pb-1">token</th><th className="pr-3 pb-1">kelas</th><th className="pr-3 pb-1 text-right">USD</th><th className="pr-3 pb-1">kanonik</th><th className="pr-3 pb-1">state</th><th className="pr-3 pb-1">cakupan</th><th className="pr-3 pb-1 text-right">pengikut</th><th className="pr-3 pb-1">rapid-sell</th><th className="pr-3 pb-1 text-right">net-flow</th><th className="pb-1">alasan</th></tr></thead>
                <tbody>{data.events.historical.map((e) => <EventRow key={e.h2EventId} e={e} />)}</tbody>
              </table>
            </div>
          </details>

          <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-gold">Outcome matang (harga = close candle selesai)</h3>
          <div className="mt-1 grid gap-2 md:grid-cols-2">
            {([["admisi token (shadow — BUKTIAN BUKAN POSISI)", data.outcomes.admission], ["event H2 (per-event)", data.outcomes.h2]] as const).map(([label, rows]) => (
              <div key={label} className="rounded border border-border bg-background/40 p-2">
                <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
                <table className="mt-1 w-full text-left"><tbody>
                  {rows.map((r) => (
                    <tr key={r.horizonMin} className="font-mono text-[10px]">
                      <td className="pr-2 text-muted-foreground">{r.horizonMin}m</td>
                      <td className="pr-2 text-right text-foreground">obs {r.observed}</td>
                      <td className="pr-2 text-right text-muted-foreground">pend {r.pending}</td>
                      <td className="pr-2 text-right text-muted-foreground">miss {r.missing}</td>
                      <td className="text-right" style={{ color: r.meanPct == null ? "var(--muted)" : r.meanPct >= 0 ? "#34d399" : "#f87171" }}>{r.meanPct != null ? `${r.meanPct >= 0 ? "+" : ""}${r.meanPct.toFixed(1)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody></table>
              </div>
            ))}
          </div>

          <h3 className="mt-4 font-mono text-[10px] uppercase tracking-[0.2em] text-gold">Paper per-event H2</h3>
          <div className="mt-1 grid gap-2 md:grid-cols-2">
            {([["COUNTERFACTUAL (dari eventTs — hipotesis, BUKAN actionable)", data.paper.counterfactual], ["ACTIONABLE (setelah keputusan konfirmasi)", data.paper.actionable]] as const).map(([label, rows]) => (
              <div key={label} className="rounded border border-border bg-background/40 p-2">
                <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
                {rows.map((p) => (
                  <p key={p.policy} className="mt-1 font-mono text-[10px] text-foreground">{p.policy.replace(/_/g, " ").toLowerCase()}: n={p.n}{p.meanNetPct != null ? <span style={{ color: p.meanNetPct >= 0 ? "#34d399" : "#f87171" }}> · net {p.meanNetPct >= 0 ? "+" : ""}{p.meanNetPct.toFixed(2)}%</span> : " · belum matang"}</p>
                ))}
              </div>
            ))}
          </div>
          <p className="mt-2 font-mono text-[9px] text-muted-foreground">{data.paper.note} · profitabilitas BELUM tervalidasi.</p>
        </>
      )}
    </section>
  );
}
