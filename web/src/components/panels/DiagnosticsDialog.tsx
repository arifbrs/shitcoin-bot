import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fetchAnalytics, fetchCohorts } from "@/lib/api";
import type { AnalyticsResponse, CohortsResponse, StatsResponse } from "@/types/stats";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: StatsResponse | null;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 font-mono text-[9px] tracking-widest text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between font-mono text-[10px]">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-foreground">{v}</span>
    </div>
  );
}

export function DiagnosticsDialog({ open, onOpenChange, data, restoreFocusRef }: Props) {
  const [cfgScope, setCfgScope] = useState<"current" | "all">("current");
  const [analytics, setAnalytics] = useState<AnalyticsResponse | null>(null);
  const [cohorts, setCohorts] = useState<CohortsResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchAnalytics(cfgScope === "all" ? "all" : undefined).then(setAnalytics).catch(() => setAnalytics(null));
  }, [open, cfgScope]);

  useEffect(() => {
    if (!open) return;
    fetchCohorts().then(setCohorts).catch(() => setCohorts(null));
  }, [open]);

  if (!data) return null;
  const rpc = data.rpc;
  const lat = data.latencyBreakdown;
  const risk = data.risk;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${restoreFocusRef ? "terminal-system-dialog " : ""}max-h-[85vh] max-w-3xl overflow-y-auto font-mono`} onCloseAutoFocus={(event) => { if (restoreFocusRef?.current?.isConnected) { event.preventDefault(); restoreFocusRef.current.focus(); } }}>
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-widest">◎ DIAGNOSTICS</DialogTitle>
        </DialogHeader>
        <p className="-mt-2 font-mono text-[9px] text-muted-foreground">
          Panel ini historis dari log sniper (arsip) — analitik lengkap `/api/analytics`, bukan data live Strategy 2.
        </p>

        <div className="flex gap-1">
          {(["current", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setCfgScope(s)}
              className={`rounded-full px-2.5 py-1 font-mono text-[9px] tracking-widest ${
                cfgScope === s ? "bg-foreground text-background" : "border border-border text-muted-foreground"
              }`}
            >
              {s === "current" ? "THIS CONFIG" : "ALL HISTORY"}
            </button>
          ))}
        </div>

        {cohorts && cohorts.cohorts.length > 0 && (
          <Section label="COHORT — SETELAN LAMA vs BARU">
            {cohorts.delta ? (
              <div className="mb-3 rounded border border-border/60 bg-muted/20 p-2">
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="font-mono text-[9px] tracking-widest text-muted-foreground">
                    {cohorts.delta.cfgOld} → {cohorts.delta.cfgNew}
                  </span>
                  <span
                    className={`font-mono text-[10px] ${
                      cohorts.delta.verdict.startsWith("sampel")
                        ? "text-muted-foreground"
                        : cohorts.delta.evPctDelta > 0
                          ? "text-up"
                          : "text-down"
                    }`}
                  >
                    {cohorts.delta.verdict}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                  <Row k="EV/trade" v={`${cohorts.delta.evPctDelta > 0 ? "+" : ""}${cohorts.delta.evPctDelta}%`} />
                  <Row k="win" v={`${cohorts.delta.winPctDelta > 0 ? "+" : ""}${cohorts.delta.winPctDelta}pp`} />
                  <Row k="bleed (<-25%)" v={`${cohorts.delta.bleedPctDelta > 0 ? "+" : ""}${cohorts.delta.bleedPctDelta}pp`} />
                  <Row k="hold median" v={`${cohorts.delta.medianHoldSecDelta > 0 ? "+" : ""}${cohorts.delta.medianHoldSecDelta}s`} />
                </div>
              </div>
            ) : (
              <p className="mb-3 font-mono text-[10px] text-muted-foreground">
                belum ada dua cohort dengan sampel cukup (≥20 trade) untuk dibandingkan
              </p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full font-mono text-[10px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="pb-1 text-left font-normal">cfg</th>
                    <th className="pb-1 text-right font-normal">trade</th>
                    <th className="pb-1 text-right font-normal">EV kertas</th>
                    <th className="pb-1 text-right font-normal">EV live</th>
                    <th className="pb-1 text-right font-normal">size ◎</th>
                    <th className="pb-1 text-right font-normal">win</th>
                    <th className="pb-1 text-right font-normal">bleed</th>
                    <th className="pb-1 text-right font-normal">hold</th>
                    <th className="pb-1 text-right font-normal">no-dev</th>
                  </tr>
                </thead>
                <tbody>
                  {cohorts.cohorts.slice(0, 8).map((c) => {
                    const nd = c.reasons["NO_DEVELOPMENT"];
                    return (
                      <tr key={c.cfg} className={c.current ? "text-foreground" : "text-muted-foreground"}>
                        <td className="py-0.5 text-left">
                          {c.cfg}
                          {c.current && <span className="ml-1 text-gold">●</span>}
                        </td>
                        <td className="py-0.5 text-right">{c.trades}</td>
                        <td className={`py-0.5 text-right ${c.evPct > 0 ? "text-up" : "text-down"}`}>{c.evPct}%</td>
                        <td className={`py-0.5 text-right ${(c.evLivePct ?? 0) > 0 ? "text-up" : "text-down"}`}>
                          {c.evLivePct != null ? `${c.evLivePct}%` : "—"}
                        </td>
                        <td className="py-0.5 text-right" title={`overhead ${c.overheadPct ?? "?"}%`}>{c.sizeSol ?? "—"}</td>
                        <td className="py-0.5 text-right">{c.winPct}%</td>
                        <td className="py-0.5 text-right">{c.bleedPct}%</td>
                        <td className="py-0.5 text-right">{c.medianHoldSec}s</td>
                        <td className="py-0.5 text-right">{nd ? `${nd.n} @ ${nd.avgPnlPct}%` : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {cohorts.liveOverhead && (
              <p className="mt-2 text-[9px] leading-snug text-gold">
                EV live = EV kertas − {cohorts.liveOverhead.pct}% (tip {cohorts.liveOverhead.tipSol} ◎ + priority fee, dua sisi,
                pada posisi {cohorts.liveOverhead.sizeSol} ◎). Dihitung per cohort dari ukuran yang benar-benar
                diperdagangkan, karena biaya ini tetap dalam SOL sehingga persentasenya bergantung penuh pada ukuran posisi.
                TIDAK dikurangkan dari P&amp;L kertas, supaya angka historis tetap bisa dibandingkan.
              </p>
            )}
            <p className="mt-2 text-[9px] leading-snug text-muted-foreground">{cohorts.caveat}</p>
          </Section>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Section label="RPC BUDGET">
            {rpc ? (
              <div className="space-y-1">
                <Row k="rps / capacity" v={`${rpc.rps} / ${rpc.capacity}`} />
                <Row k="utilization" v={`${rpc.utilPct}%`} />
                <Row k="in-flight" v={rpc.inFlight} />
                <Row k="rate-limited" v={rpc.rateLimited} />
                {rpc.stale && <p className="text-[9px] text-gold">stale — trader tidak melapor</p>}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">tidak ada data (sniper archived)</p>
            )}
          </Section>

          <Section label="ENTRY LATENCY">
            {lat ? (
              <div className="space-y-1">
                <Row k="pre / gate / open" v={`${lat.recent.pre ?? "—"}s / ${lat.recent.gate ?? "—"}s / ${lat.recent.open ?? "—"}s`} />
                <Row k="total (recent)" v={`${lat.recent.total ?? "—"}s`} />
                <Row k="n" v={lat.n} />
                {/* Without this note the `open` figure invites exactly the wrong conclusion. It is
                    dominated by a wait the bot does not control: measured on 8 fresh launches, a
                    pump.fun buy cannot be simulated until the token is ~12-15s old — every one of
                    the eight passed in that band and none sooner. `pre` and `gate` are ours to
                    optimise (16.6s and 6.4s earlier today); `open` is mostly that floor. */}
                <p className="pt-1 text-[9px] leading-snug text-muted-foreground">
                  ~12s dari <span className="text-foreground/70">open</span> adalah lantai chain, bukan kelambatan bot:
                  pembelian pump.fun baru bisa disimulasikan saat token berumur 12-15 detik (terukur, 8/8).
                  Yang benar-benar milik kita adalah <span className="text-foreground/70">pre</span> + <span className="text-foreground/70">gate</span>.
                </p>
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">tidak ada data</p>
            )}
          </Section>

          <Section label="DATA INTEGRITY">
            {data.dataIntegrity ? (
              <div className="space-y-1">
                <Row k="ok" v={data.dataIntegrity.ok == null ? "—" : data.dataIntegrity.ok ? "yes" : "NO"} />
                <Row k="drift" v={`${data.dataIntegrity.driftSol ?? "—"} SOL`} />
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground">— · hasil audit belum tersedia</p>
            )}
          </Section>

          <Section label="EXIT ENVELOPE">
            <div className="space-y-1">
              <Row k="catastrophic stop" v={`${risk.catastrophicStopPct}%`} />
              <Row k="entry MC band (cfg dashboard)" v={`${risk.entryMcBandSol.floor}–${risk.entryMcBandSol.ceiling} SOL`} />
              {risk.entryMcObserved && (
                <Row
                  k="entry MC nyata (sniper)"
                  v={`${risk.entryMcObserved.min}–${risk.entryMcObserved.max} SOL · med ${risk.entryMcObserved.median}`}
                />
              )}
              <Row k="scale-out tiers" v={risk.scaleOutTiers.length} />
            </div>
          </Section>
        </div>

        {analytics && (
          <>
            <Section label={`ENTRY MC → OUTCOME (n=${analytics.mcBand.of})`}>
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[9px]">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th className="text-left font-normal">BAND</th>
                      <th className="text-right font-normal">N</th>
                      <th className="text-right font-normal">WIN%</th>
                      <th className="text-right font-normal">DEAD%</th>
                      <th className="text-right font-normal">SOL/TRADE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.mcBand.bands.map((b) => (
                      <tr key={b.label} className={b.inBand ? "text-foreground" : "text-muted-foreground/60"}>
                        <td>{b.label}</td>
                        <td className="text-right">{b.n}</td>
                        <td className="text-right text-up">{b.winPct}%</td>
                        <td className="text-right text-down">{b.deadPct}%</td>
                        <td className="text-right">{b.solPerTrade}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section label="EXIT LEDGER">
              {analytics.exitLedger.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full font-mono text-[9px]">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left font-normal">REASON</th>
                        <th className="text-right font-normal">N</th>
                        <th className="text-right font-normal">AVG PNL%</th>
                        <th className="text-right font-normal">SOL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.exitLedger.map((r) => (
                        <tr key={r.reason}>
                          <td className="text-foreground">{r.reason}</td>
                          <td className="text-right">{r.n}</td>
                          <td className={`text-right ${r.avgPnlPct >= 0 ? "text-up" : "text-down"}`}>{r.avgPnlPct}%</td>
                          <td className={`text-right ${r.sol >= 0 ? "text-up" : "text-down"}`}>{r.sol}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground">tidak ada trade tercatat</p>
              )}
            </Section>

            <Section label="OUTCOME DISTRIBUTION (by peak)">
              <div className="grid grid-cols-5 gap-2 text-center">
                {Object.entries(analytics.outcomeDistribution).map(([k, v]) => (
                  <div key={k}>
                    <p className="font-sans text-sm font-semibold text-foreground">{v}</p>
                    <p className="text-[8px] text-muted-foreground">{k}</p>
                  </div>
                ))}
              </div>
            </Section>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
