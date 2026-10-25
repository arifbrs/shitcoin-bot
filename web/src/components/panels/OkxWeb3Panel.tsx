import { useEffect, useState } from "react";
import { fetchOkxOverview } from "@/lib/api";
import type { OkxOutcomeAggregate, OkxOverviewResponse, OkxSourceEventView } from "@/types/stats";

function Badge({ children, tone = "dim" }: { children: React.ReactNode; tone?: "up" | "down" | "gold" | "dim" | "scout" }) {
  const cls = {
    up: "border-up/35 bg-up/8 text-up",
    down: "border-down/45 bg-down/10 text-down",
    gold: "border-gold/35 bg-gold/8 text-gold",
    scout: "border-scout/35 bg-scout/8 text-scout",
    dim: "border-border bg-background/35 text-muted-foreground",
  }[tone];
  return <span className={`rounded-full border px-2.5 py-1 font-mono text-[9px] tracking-[0.12em] whitespace-nowrap ${cls}`}>{children}</span>;
}

function SubPanel({ title, meta, children, className = "" }: { title: string; meta?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-lg border border-border bg-background/30 p-3 ${className}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="h-1 w-1 rounded-full bg-muted-foreground" />
        <h3 className="font-mono text-[9px] tracking-[0.15em] text-muted-foreground uppercase">{title}</h3>
        {meta && <div className="ml-auto">{meta}</div>}
      </div>
      {children}
    </section>
  );
}

const num = (row: Record<string, unknown> | null, key: string): number => {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

function compact(value: number | null, kind: "usd" | "int" = "int"): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: kind === "usd" ? 1 : 0,
    style: kind === "usd" ? "currency" : "decimal",
    currency: "USD",
  }).format(value);
}

function short(value: string | null | undefined, head = 5, tail = 4): string {
  if (!value) return "—";
  return value.length <= head + tail + 2 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function elapsed(ts: string | number | null | undefined): string {
  if (ts == null) return "—";
  const raw = typeof ts === "number" && ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  const at = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(at)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (sec < 60) return `${sec}d lalu`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m lalu`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}j lalu`;
  return `${Math.floor(sec / 86_400)}h lalu`;
}

function signedPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function ActivityList({ rows, empty }: { rows: OkxSourceEventView[]; empty: string }) {
  if (rows.length === 0) return <p className="py-7 text-center font-mono text-[10px] leading-5 text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-1.5">
      {rows.slice(0, 6).map((row, index) => (
        <div key={`${row.ts}-${row.mint}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border/60 bg-card/60 px-2.5 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[11px] font-semibold text-foreground" title={row.mint}>{row.symbol || short(row.mint)}</span>
              {row.walletType && <span className="truncate font-mono text-[8px] tracking-wide text-scout">{row.walletType}</span>}
            </div>
            <div className="mt-0.5 flex gap-2 font-mono text-[9px] text-muted-foreground">
              {row.wallet && <span title={row.wallet}>{short(row.wallet)}</span>}
              {row.marketCapUsd != null && <span>MC {compact(row.marketCapUsd, "usd")}</span>}
              {row.holders != null && <span>{compact(row.holders)} holder</span>}
            </div>
          </div>
          <div className="text-right font-mono text-[9px] text-muted-foreground">
            <div className="text-foreground">{row.amountUsd == null ? "—" : compact(row.amountUsd, "usd")}</div>
            <div>{row.detectLagMs == null ? elapsed(row.ts) : `${Math.max(0, row.detectLagMs / 1000).toFixed(1)}d lag`}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function OutcomeTable({ rows }: { rows: OkxOutcomeAggregate[] }) {
  if (rows.length === 0) return <p className="py-5 text-center text-[10px] text-muted-foreground">Belum ada outcome yang selesai.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[430px] border-collapse font-mono text-[9px]">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <th className="pb-2 text-left font-normal">SUMBER</th>
            <th className="pb-2 text-right font-normal">HORIZON</th>
            <th className="pb-2 text-right font-normal">PRICED</th>
            <th className="pb-2 text-right font-normal">WIN</th>
            <th className="pb-2 text-right font-normal">MEDIAN</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.kind ?? row.verdict}-${row.horizonSec}`} className="border-b border-border/50 last:border-0">
              <td className={`py-2 ${row.verdict === "TOXIC" ? "text-down" : row.verdict === "CLEAN" ? "text-up" : "text-foreground"}`}>{row.kind ?? row.verdict ?? "?"}</td>
              <td className="py-2 text-right text-muted-foreground">{row.horizonSec}s</td>
              <td className="py-2 text-right text-foreground">{row.priced}<span className="text-muted-foreground">/{row.total}</span></td>
              <td className="py-2 text-right text-foreground">{row.winRatePercent == null ? "—" : `${row.winRatePercent.toFixed(1)}%`}</td>
              <td className={`py-2 text-right ${(row.medianPct ?? 0) > 0 ? "text-up" : (row.medianPct ?? 0) < 0 ? "text-down" : "text-muted-foreground"}`}>{signedPct(row.medianPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function OkxWeb3Panel() {
  const [data, setData] = useState<OkxOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await fetchOkxOverview(controller.signal);
        if (active) { setData(next); setError(null); }
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message === "session-expired") { window.location.href = "/login"; return; }
        setError(message);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { active = false; controller?.abort(); window.clearInterval(timer); };
  }, []);

  if (!data) {
    return (
      <section className="mt-3 rounded-xl border border-border bg-card p-4">
        <p className="text-center font-mono text-[10px] text-muted-foreground">{error ?? "Memuat status OKX Web3 dari data lokal…"}</p>
      </section>
    );
  }

  const status = data.status;
  const study = data.study.status;
  const lastLane = data.lane.status;
  const laneFresh = lastLane && typeof lastLane.ts === "string" ? elapsed(lastLane.ts) : "belum ada";
  const paperFunnel = data.paper.candidateFunnel;
  const paperPositions = data.paper.positions;
  const paperOutcomes: OkxOutcomeAggregate[] = data.paper.exitSummary.map((row) => ({
    kind: `v${row.policyVersion} ${row.lane} · ${row.eligibility}`,
    horizonSec: row.horizonSec,
    total: row.observations,
    priced: row.built,
    unpriced: row.routeFailures,
    winRatePercent: row.winRatePct,
    avgPct: row.meanPnlPct,
    medianPct: row.medianPnlPct,
  }));
  const paperScalpOutcomes: OkxOutcomeAggregate[] = (data.paper.scalpSummary ?? []).map((row) => ({
    kind: `v${row.policyVersion} scalp · ${row.eligibility}`,
    horizonSec: 60,
    total: row.observations,
    priced: row.built,
    unpriced: row.routeFailures,
    winRatePercent: row.winRatePct,
    avgPct: row.meanPnlPct,
    medianPct: row.medianPnlPct,
  }));
  const purchaseGate = data.paper.purchaseReadiness;
  const fastThroughput = [...(data.paper.rankingThroughput ?? [])].reverse()
    .find((row) => row.policyVersion === 6);
  const fastDecision = [...(data.paper.candidateDecisionLatency ?? [])].reverse()
    .find((row) => row.policyVersion === 6 && row.lane === "toplist");
  const pausedSources = data.paper.latestStatus?.pausedSources;
  const pausedPaperSources = Array.isArray(pausedSources)
    ? pausedSources.flatMap((row: unknown) => row && typeof row === "object" && "source" in row && typeof row.source === "string" ? [row.source] : [])
    : [];

  return (
    <section className="mx-auto mt-3 max-w-[1700px] rounded-xl border border-border bg-card p-3.5">
      <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <span className="h-[5px] w-[5px] animate-pulse rounded-full bg-scout shadow-[0_0_7px_var(--hud-scout)]" />
        <h2 className="font-mono text-[10px] font-semibold tracking-[0.17em] text-foreground">OKX WEB3 / DEX</h2>
        <Badge tone={status.enabled ? "up" : "down"}>{status.enabled ? "REST CONNECTED" : "REST OFF"}</Badge>
        <Badge tone={data.processes.paper ? "up" : "dim"}>{data.processes.paper ? "STRICT PAPER LIVE" : "STRICT PAPER STOPPED"}</Badge>
        <Badge tone={data.processes.lane ? "up" : "dim"}>{data.processes.lane ? "SIGNAL LANE LIVE" : "SIGNAL LANE STOPPED"}</Badge>
        <Badge tone={status.executionArmed ? "down" : "gold"}>{status.executionArmed ? "● REAL EXEC ARMED" : "EXEC LOCKED"}</Badge>
        <Badge tone="scout">{status.endpointCounts.live}/{status.endpointTotal} LIVE-TESTED</Badge>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">cache/log lokal · {data.quotaCost} request OKX · update {elapsed(data.generatedAt)}</span>
      </div>

      {error && <div className="mb-3 rounded-md border border-down/40 bg-down/5 px-3 py-2 text-[10px] text-down">Refresh terakhir gagal: {error}</div>}

      <div className="grid gap-3 lg:grid-cols-12">
        <SubPanel title="Capability & safety" meta={<Badge tone={status.executionArmed ? "down" : "up"}>{status.executionArmed ? "UANG NYATA" : "AMAN / TERKUNCI"}</Badge>} className="lg:col-span-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Endpoint</div><div className="mt-1 text-lg font-semibold">{status.endpointTotal}</div><div className="text-[9px] text-up">{status.endpointCounts.live} diuji live</div></div>
            <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Perlu state</div><div className="mt-1 text-lg font-semibold">{status.endpointCounts.unprobed}</div><div className="text-[9px] text-muted-foreground">tidak auto-probe</div></div>
            <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Route aktif</div><div className="mt-1 truncate text-sm font-semibold uppercase">{status.route}</div><div className="text-[9px] text-muted-foreground">slip {status.slippagePercent}%</div></div>
          </div>
          <div className="mt-3 space-y-1.5 rounded-md border border-border/70 bg-card/40 p-2.5 font-mono text-[9px] leading-4">
            <div className="flex justify-between"><span className="text-muted-foreground">WebSocket</span><span className={status.websocketEnabled ? "text-up" : "text-gold"}>{status.websocketEnabled ? "configured" : "off · REST fallback"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Copy trader</span><span className="text-gold">{status.copyShadow ? "SHADOW ONLY" : "off"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Candidate ledger</span><span className={status.candidateQueueEnabled ? "text-up" : "text-muted-foreground"}>{status.candidateQueueEnabled ? "on · exec blocked" : "off"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Runtime lane</span><span className={data.processes.lane ? "text-up" : "text-muted-foreground"}>{data.processes.lane ? `live · status ${laneFresh}` : "stopped"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Strict paper</span><span className={data.processes.paper ? "text-up" : "text-muted-foreground"}>{data.processes.paper ? "live · unsigned" : "stopped"}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Study trenches</span><span className={data.processes.study ? "text-up" : "text-muted-foreground"}>{data.processes.study ? "live" : "stopped"}</span></div>
          </div>
          {!status.executionArmed && (
            <div className="mt-3 rounded-md border border-gold/25 bg-gold/5 p-2.5">
              <div className="mb-1 text-[9px] tracking-wider text-gold">EXECUTION BLOCKERS</div>
              {status.executionBlockers.slice(0, 4).map((blocker) => <div key={blocker} className="truncate text-[9px] leading-4 text-muted-foreground" title={blocker}>· {blocker}</div>)}
            </div>
          )}
        </SubPanel>

        <SubPanel title="Alpha radar · wallet persisten" meta={<Badge tone="scout">{data.radar.copyableWallets}/{data.radar.totalWallets} copyable</Badge>} className="lg:col-span-8">
          {data.radar.topWallets.length === 0 ? (
            <p className="py-10 text-center text-[10px] text-muted-foreground">Belum ada wallet yang lolos minimal 2 sweep + win rate + freshness.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse font-mono text-[9px]">
                <thead className="text-muted-foreground"><tr className="border-b border-border"><th className="pb-2 text-left font-normal">WALLET</th><th className="pb-2 text-left font-normal">TAG</th><th className="pb-2 text-right font-normal">SWEEP</th><th className="pb-2 text-right font-normal">WIN RATE</th><th className="pb-2 text-right font-normal">REALIZED</th><th className="pb-2 text-right font-normal">AVG BUY</th><th className="pb-2 text-right font-normal">AKTIF</th></tr></thead>
                <tbody>
                  {data.radar.topWallets.slice(0, 8).map((wallet) => (
                    <tr key={wallet.walletAddress} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 font-semibold text-foreground" title={wallet.walletAddress}>{short(wallet.walletAddress, 7, 5)}</td>
                      <td className="py-2.5 text-scout">{wallet.walletTypes.join(" · ") || "—"}</td>
                      <td className="py-2.5 text-right text-foreground">{wallet.sweepCount}<span className="text-muted-foreground"> / {wallet.cellHits}</span></td>
                      <td className="py-2.5 text-right text-up">{wallet.winRatePercent == null ? "—" : `${wallet.winRatePercent.toFixed(1)}%`}</td>
                      <td className="py-2.5 text-right text-foreground">{compact(wallet.realizedPnlUsd, "usd")}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{compact(wallet.avgBuyValueUsd, "usd")}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{elapsed(wallet.lastActiveTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SubPanel>

        <SubPanel title="Signal feed" meta={<Badge tone={data.processes.lane ? "up" : "dim"}>{data.lane.signals.total} event · {data.lane.candidates.total} kandidat</Badge>} className="lg:col-span-4">
          <ActivityList rows={data.lane.signals.recent} empty={data.processes.lane ? "Menunggu signal baru setelah seed dedupe…" : "Jalankan okx:lane untuk signal REST/WS realtime."} />
          <div className="mt-2 flex items-center justify-between border-t border-border/60 pt-2 font-mono text-[9px] text-muted-foreground">
            <span>maks lag {Math.round(status.candidateMaxLagMs / 1000)}d</span>
            <span className="text-gold">EXECUTION HARD-BLOCKED</span>
          </div>
        </SubPanel>

        <SubPanel title="Follow / copy trader" meta={<Badge tone="gold">SHADOW · TIDAK MEMBELI</Badge>} className="lg:col-span-4">
          <ActivityList rows={data.lane.copies.recent} empty={status.copyShadow ? "Belum ada buy baru dari wallet yang dilacak." : "Copy shadow belum diaktifkan."} />
        </SubPanel>

        <SubPanel title="Outcome signal & copy" meta={<Badge tone="dim">dari harga saat terdeteksi</Badge>} className="lg:col-span-4">
          <OutcomeTable rows={data.lane.outcomes} />
        </SubPanel>

        <SubPanel title="Strict paper · OKX Quick Buy simulation" meta={<Badge tone={data.paper.ledgerIntegrity === "OK" ? "up" : "down"}>LEDGER {data.paper.ledgerIntegrity}</Badge>} className="lg:col-span-12">
          <div className="grid gap-3 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Accepted</div><div className="mt-1 text-lg font-semibold">{compact(paperFunnel?.accepted ?? 0)}</div></div>
                <div className="rounded-md border border-up/20 bg-up/5 p-2.5"><div className="text-[9px] text-muted-foreground">Opened</div><div className="mt-1 text-lg font-semibold text-up">{compact(paperPositions?.opened ?? 0)}</div></div>
                <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Pending</div><div className="mt-1 text-lg font-semibold">{compact(paperFunnel?.pendingAccepted ?? 0)}</div></div>
                <div className="rounded-md border border-down/20 bg-down/5 p-2.5"><div className="text-[9px] text-muted-foreground">Rejected / failed</div><div className="mt-1 text-lg font-semibold text-down">{compact(paperFunnel?.rejectedOrFailed ?? 0)}</div></div>
              </div>
              <div className="mt-2 rounded-md border border-border/70 bg-card/40 p-2.5 font-mono text-[9px] leading-4 text-muted-foreground">
                <div>signed: <span className="text-up">false</span> · broadcast: <span className="text-up">false</span></div>
                <div>records: {compact(data.paper.ledgerRecords ?? 0)} · fixed exits: {compact(paperPositions?.exitObservations ?? 0)} · scalp fills: {compact(paperPositions?.scalpExitObservations ?? 0)}</div>
                {pausedPaperSources.length > 0 && <div className="text-gold">paused quota: {pausedPaperSources.join(", ")}</div>}
                {data.paper.error && <div className="text-down">{data.paper.error}</div>}
              </div>
              {fastThroughput && (
                <div className="mt-2 rounded-md border border-scout/25 bg-scout/5 p-2.5 font-mono text-[9px] leading-4">
                  <div className="flex items-center justify-between"><span className="text-scout">V6 REST FAST-RECHECK</span><span className="text-muted-foreground">{fastThroughput.configuredPollMs == null ? "—" : `${(fastThroughput.configuredPollMs / 1000).toFixed(0)}s`} poll</span></div>
                  <div className="mt-1 text-muted-foreground">{compact(fastThroughput.evaluatedSnapshots)} snapshot dievaluasi · {compact(fastThroughput.transientFilteredSnapshots)} diulang · {compact(fastThroughput.accepted)} masuk preflight</div>
                  <div className="text-muted-foreground">API median {fastThroughput.medianApiMs == null ? "—" : `${fastThroughput.medianApiMs.toFixed(0)}ms`} · keputusan median {fastDecision?.medianDecisionMs == null ? "—" : `${(fastDecision.medianDecisionMs / 1000).toFixed(2)}s`} · p95 {fastDecision?.p95DecisionMs == null ? "—" : `${(fastDecision.p95DecisionMs / 1000).toFixed(2)}s`}</div>
                  <div className="text-muted-foreground">laju toplist ~{fastThroughput.observedCallsPerHour == null ? "—" : fastThroughput.observedCallsPerHour.toFixed(0)} call/jam · masih di bawah 5 RPS</div>
                </div>
              )}
              {purchaseGate && (
                <div className={`mt-2 rounded-md border p-2.5 font-mono text-[9px] leading-4 ${purchaseGate.passed ? "border-up/30 bg-up/5" : "border-gold/25 bg-gold/5"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={purchaseGate.passed ? "text-up" : "text-gold"}>PAID WEBSOCKET GATE</span>
                    <span className="text-muted-foreground">{purchaseGate.observations}/{purchaseGate.minimumObservations} fill valid</span>
                  </div>
                  <div className="mt-1 text-muted-foreground">{purchaseGate.status.replaceAll("_", " ")}</div>
                  <div className="text-muted-foreground">PnL {purchaseGate.totalPnlSol >= 0 ? "+" : ""}{purchaseGate.totalPnlSol.toFixed(4)} SOL · lower 95% {signedPct(purchaseGate.lower95MeanPnlPct)}</div>
                  <div className="mt-1 text-muted-foreground">Lolos hanya mengizinkan A/B WebSocket berbayar; uang nyata tetap terkunci.</div>
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <div className="mb-1.5 font-mono text-[8px] tracking-[0.14em] text-scout">V6 FAST-RECHECK · POST-DELAY SELL BUILD</div>
                <OutcomeTable rows={paperScalpOutcomes} />
              </div>
              <div className="border-t border-border/60 pt-3">
                <div className="mb-1.5 font-mono text-[8px] tracking-[0.14em] text-muted-foreground">FIXED-HORIZON DIAGNOSTIC · ALL COHORTS</div>
                <OutcomeTable rows={paperOutcomes} />
              </div>
            </div>
          </div>
        </SubPanel>

        <SubPanel title="Trenches study · evidence, bukan trade" meta={<Badge tone={data.processes.study ? "up" : "dim"}>{data.processes.study ? "SCANNING" : "STOPPED"}</Badge>} className="lg:col-span-12">
          <div className="grid gap-3 xl:grid-cols-[280px_minmax(0,1fr)]">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Scanned</div><div className="mt-1 text-lg font-semibold">{compact(num(study, "scanned"))}</div></div>
              <div className="rounded-md border border-border/70 bg-card/50 p-2.5"><div className="text-[9px] text-muted-foreground">Settled</div><div className="mt-1 text-lg font-semibold">{compact(num(study, "settled"))}</div></div>
              <div className="rounded-md border border-up/20 bg-up/5 p-2.5"><div className="text-[9px] text-muted-foreground">Clean</div><div className="mt-1 text-lg font-semibold text-up">{compact(num(study, "CLEAN"))}</div></div>
              <div className="rounded-md border border-down/20 bg-down/5 p-2.5"><div className="text-[9px] text-muted-foreground">Toxic</div><div className="mt-1 text-lg font-semibold text-down">{compact(num(study, "TOXIC"))}</div></div>
              <div className="col-span-2 text-[9px] leading-4 text-muted-foreground">Outcome di kanan membandingkan CLEAN vs TOXIC pada horizon yang ditetapkan sebelum hasil diketahui. Median dipakai agar satu outlier memecoin tidak mendominasi.</div>
            </div>
            <OutcomeTable rows={data.study.outcomes} />
          </div>
        </SubPanel>
      </div>
    </section>
  );
}
