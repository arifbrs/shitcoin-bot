import { useState } from "react";
import { useLiveStats } from "@/hooks/useLiveStats";
import { toLiveView } from "@/lib/liveView";
import { TopBar } from "@/components/panels/TopBar";
import { Tile } from "@/components/panels/Tile";
import { Hero, heroMeta } from "@/components/panels/Hero";
import { EquityCurve } from "@/components/panels/EquityCurve";
import { OpenPositions } from "@/components/panels/OpenPositions";
import { TradeJournal } from "@/components/panels/TradeJournal";
import { ExitQuality } from "@/components/panels/ExitQuality";
import { GateFunnel } from "@/components/panels/GateFunnel";
import { StaleBanner } from "@/components/panels/StaleBanner";
import { ControlDialog } from "@/components/panels/ControlDialog";
import { BandWatch } from "@/components/panels/BandWatch";
import { ScoutPanel } from "@/components/panels/ScoutPanel";
import { FeelingAgent } from "@/components/panels/FeelingAgent";
import { PipelineFlow } from "@/components/panels/PipelineFlow";
import { DiagnosticsDialog } from "@/components/panels/DiagnosticsDialog";
import { RunLedger } from "@/components/panels/RunLedger";
import { SniperRecap } from "@/components/panels/SniperRecap";

export default function Dashboard() {
  const { data, status } = useLiveStats();
  // One switch for the whole layout: armed = feed every panel live data instead of simulation.
  // The panels themselves are unchanged — see lib/liveView.
  const live = data?.liveBridge?.armed === true;
  const view = data && live ? toLiveView(data) : data;
  const [controlOpen, setControlOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  if (status === "session-expired") {
    window.location.href = "/login";
    return null;
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <TopBar data={data} onOpenControl={() => setControlOpen(true)} onOpenDiagnostics={() => setDiagOpen(true)} />
      <ControlDialog open={controlOpen} onOpenChange={setControlOpen} data={data} />
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
            {/* Paper recap is REPLACED, not hidden. Its cumulative +831.5% on a notional float is
                meaningless next to a real wallet and actively misleading above one — but an empty
                row would read as "nothing is happening" while real money is at work. */}
            <div
              className={`flex items-center rounded-xl border px-3.5 ${live ? "border-down/60 bg-down/5" : "border-border bg-card"}`}
              style={{ gridArea: "s1" }}
            >
              <SniperRecap data={view!} />
            </div>
            <Tile area="hero" label="Pasar · langsung" right={heroMeta(data)} live={data.system.strategy2Alive}>
              <Hero data={data} />
            </Tile>
            {/* LIVE REPLACES PAPER — it never sits next to it.
                Showing both put a red LIVE badge above the paper wallet's $2,432 / +831.5%
                while the real wallet held 0.2486 SOL: the eye takes the biggest number on the
                screen as the answer, so "both" is strictly worse than either. Paper is archived
                out of the layout (still logged, still measured) whenever live is armed. */}
            <Tile
              area="equity"
              label={live ? "Dompet LIVE · uang sungguhan" : "Dompet · satu saldo, dua denominasi"}
              live={live}
            >
              <EquityCurve data={view!} />
            </Tile>
            <Tile area="pipe" label="Pipeline · langsung" live={data.system.strategy2Alive}>
              <PipelineFlow data={data} />
            </Tile>
            <Tile area="agent" label="Feeling Agent" live={data.feeling.enabled}>
              <FeelingAgent data={data} />
            </Tile>
            <Tile
              area="jour"
              label={live ? "Trade Journal LIVE · selesai" : "Trade Journal · closed"}
              right={`${view?.strategy2Primary?.recentTrades.length ?? 0} ${live ? "trade live" : "recent"}`}
              live={live}
            >
              <TradeJournal data={view!} />
            </Tile>
            <Tile area="sig" label="Band Watch · jendela entry">
              <BandWatch data={data} />
            </Tile>
            <Tile
              area="pos"
              label={live ? "Posisi LIVE · bag nyata" : "Open Positions"}
              right={`${(view?.paper?.openPositions?.length ?? 0)} ${live ? "bag live" : "active"}`}
              live={live}
            >
              <OpenPositions data={view!} />
            </Tile>
            <Tile area="funnel" label="Scout — candidates" right={`${data.strategy2.count} kandidat`}>
              <ScoutPanel data={data} />
            </Tile>
            <Tile area="gate" label="Admission — kenapa ditolak" right={`${data.strategy2Primary?.totals.rejected ?? 0} ditolak`}>
              <GateFunnel data={data} />
            </Tile>
            <Tile area="post" label={live ? "Exit Quality LIVE · per aturan keluar" : "Exit Quality"} live={live}>
              <ExitQuality data={view!} />
            </Tile>
            {/* Live has no "runs": there is no float to auto-refill, so the paper ledger's whole
                question ("profit, or a refill?") does not exist. The slot carries the question
                that DOES only exist live — is the plumbing costing money? */}
            <Tile
              area="runs"
              label={live ? "Run Ledger — tidak berlaku di live" : "Run Ledger · lintas reset float"}
right={live ? "" : `${data.runs?.profitable ?? 0}/${data.runs?.completed ?? 0} untung`}
              live={live}
            >
              <RunLedger data={view!} />
            </Tile>
          </div>
          </>
        )}
      </div>
    </div>
  );
}
