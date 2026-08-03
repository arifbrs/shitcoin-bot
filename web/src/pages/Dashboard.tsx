import { useState } from "react";
import { useLiveStats } from "@/hooks/useLiveStats";
import { TopBar } from "@/components/panels/TopBar";
import { Tile } from "@/components/panels/Tile";
import { Hero } from "@/components/panels/Hero";
import { EquityCurve } from "@/components/panels/EquityCurve";
import { OpenPositions } from "@/components/panels/OpenPositions";
import { TradeJournal } from "@/components/panels/TradeJournal";
import { ExitQuality } from "@/components/panels/ExitQuality";
import { GateFunnel } from "@/components/panels/GateFunnel";
import { StaleBanner } from "@/components/panels/StaleBanner";
import { ControlDialog } from "@/components/panels/ControlDialog";
import { LiveMarket } from "@/components/panels/LiveMarket";
import { ScoutPanel } from "@/components/panels/ScoutPanel";
import { FeelingAgent } from "@/components/panels/FeelingAgent";
import { PipelineFunnel } from "@/components/panels/PipelineFunnel";
import { DiagnosticsDialog } from "@/components/panels/DiagnosticsDialog";
import { RunLedger } from "@/components/panels/RunLedger";
import { SniperRecap } from "@/components/panels/SniperRecap";

export default function Dashboard() {
  const { data, status } = useLiveStats();
  const [controlOpen, setControlOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  if (status === "session-expired") {
    window.location.href = "/login";
    return null;
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <TopBar data={data} onOpenControl={() => setControlOpen(true)} onOpenDiagnostics={() => setDiagOpen(true)} />
      <ControlDialog open={controlOpen} onOpenChange={setControlOpen} />
      <DiagnosticsDialog open={diagOpen} onOpenChange={setDiagOpen} data={data} />
      {/* invisible (not just dimmed) while a dialog is open — owner found live, 2026-07-30: with
          this many continuously-animating canvases/blurred layers behind it, Chromium has a genuine
          GPU compositing bug where background text/labels paint straight through a fully-opaque
          dialog despite DOM/hit-testing being correct (confirmed via elementsFromPoint at the exact
          bleed pixel — it reported only the dialog's own overlay/content there). Compositor hints
          (contain:paint, translateZ(0), will-change:transform) didn't stop it, so the only reliable
          fix is to stop the background from painting at all while a dialog is up. */}
      <div className={`flex-1 p-4 ${controlOpen || diagOpen ? "invisible" : ""}`}>
        {!data ? (
          <p className="p-8 text-center font-mono text-xs text-muted-foreground">Menyambungkan ke feed live…</p>
        ) : (
          <>
          <StaleBanner data={data} />
          <div className="dash-grid mx-auto max-w-[1700px]">
            <div className="flex items-center rounded-xl border border-border bg-card px-3.5" style={{ gridArea: "s1" }}>
              <SniperRecap data={data} />
            </div>
            <Tile area="hero" label="Total P&L · 1 dompet (S1+S2)" live={data.system.strategy2Alive}>
              <Hero data={data} />
            </Tile>
            <Tile area="equity" label="Dompet · satu saldo, dua denominasi">
              <EquityCurve data={data} />
            </Tile>
            <Tile area="pipe" label="Pipeline · live" live={data.system.strategy2Alive}>
              <PipelineFunnel data={data} />
            </Tile>
            <Tile area="agent" label="Feeling Agent" live={data.feeling.enabled}>
              <FeelingAgent data={data} />
            </Tile>
            <Tile area="jour" label="Trade Journal · closed" right={`${data.strategy2Primary?.recentTrades.length ?? 0} recent`}>
              <TradeJournal data={data} />
            </Tile>
            <Tile area="sig" label="Live Market">
              <LiveMarket data={data} />
            </Tile>
            <Tile area="pos" label="Open Positions" right={`${data.strategy2Primary?.paper.open ?? 0} active`}>
              <OpenPositions data={data} />
            </Tile>
            <Tile area="funnel" label="Scout — candidates" right={`${data.strategy2.count} kandidat`}>
              <ScoutPanel data={data} />
            </Tile>
            <Tile area="gate" label="Admission — kenapa ditolak" right={`${data.strategy2Primary?.totals.rejected ?? 0} ditolak`}>
              <GateFunnel data={data} />
            </Tile>
            <Tile area="post" label="Exit Quality" live={false}>
              <ExitQuality data={data} />
            </Tile>
            <Tile
              area="runs"
              label="Run Ledger · lintas reset float"
              right={`${data.runs?.profitable ?? 0}/${data.runs?.completed ?? 0} untung`}
              live={false}
            >
              <RunLedger data={data} />
            </Tile>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
