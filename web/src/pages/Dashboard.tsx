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
import { OkxWeb3Panel } from "@/components/panels/OkxWeb3Panel";
import { RobinhoodChainPanel } from "@/components/panels/RobinhoodChainPanel";
import { LaneRobinhood } from "@/components/panels/LaneRobinhood";
import { LaneGmgn } from "@/components/panels/LaneGmgn";
import { LaneDex } from "@/components/panels/LaneDex";
import { LaneOkxPaper } from "@/components/panels/LaneOkxPaper";

/** Kartu ringkas status lane untuk landing multi-lane (2026-10-07). */
function LaneTag({ name, status, tone, note }: { name: string; status: string; tone: "up" | "dim"; note: string }) {
  return (
    <div className={`rounded-xl border px-3.5 py-3 ${tone === "up" ? "border-up/40 bg-up/5" : "border-border bg-card opacity-70"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{name}</p>
        <span className={`font-mono text-[10px] ${tone === "up" ? "text-up" : "text-muted-foreground"}`}>{status}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

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
          {/* MULTI-LANE (2026-10-07, keputusan owner): landing menampilkan lane yang BENAR-BENAR
              berjalan — Robinhood (10 varian) dan GMGN — sementara lane Solana (S1+S2) dihentikan
              dan panel lamanya dipindah ke balik <details> supaya tidak lagi mendominasi layar. */}
          <div className="mx-auto max-w-[1700px] space-y-4">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
              <LaneTag name={`Robinhood · ${data.laneRobinhood?.variants.length ?? "?"} varian`} status="AKTIF" tone="up" note="Paper $5/trade di Ethereum L2 4663 · review harian 08:00 · nol eksekusi" />
              <LaneTag name="GMGN" status="AKTIF" tone="up" note="Proxy + watch (pace 10s) + sinyal & kualitas wallet · laporan harian" />
              <LaneTag name="DexScreener" status="AKTIF" tone="up" note="13 endpoint + 6 stream WS realtime (diukur gratis) · watchlist & promosi berbayar" />
              <LaneTag name="OKX · strict-paper" status="AKTIF" tone="up" note="Uang kertas 0,1 SOL · tx unsigned + simulasi · ledger hash-chain · nol tanda tangan" />
              <LaneTag name="Solana (S1 + S2)" status="DIMATIKAN" tone="dim" note="Dihentikan 2026-10-07 · data lama tetap tersimpan di logs/" />
            </div>
            <LaneRobinhood data={data.laneRobinhood} />
            <LaneGmgn />
            <LaneDex data={data.laneDex} />
            <LaneOkxPaper data={data.laneOkxPaper} />
            {/* OKX WEB3 PANEL — dipindah keluar dari lipatan "Lane Solana" pada 2026-10-08: lane OKX
                kini HIDUP (radar/observatory/strict-paper jalan terus), jadi menyembunyikannya di
                balik label "dihentikan" akan membuat panel yang benar terlihat seperti arsip. */}
            <OkxWeb3Panel />
            <details className="rounded-xl border border-border bg-card p-3">
              <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Lane Solana — dihentikan 2026-10-07 · tampilkan panel lama (S1 sniper · S2)
              </summary>
              <div className="dash-grid mt-3">
            {/* Paper recap is REPLACED, not hidden. Its cumulative +831.5% on a notional float is
                meaningless next to a real wallet and actively misleading above one — but an empty
                row would read as "nothing is happening" while real money is at work. */}
            <div
              className={`flex items-center rounded-xl border px-3.5 ${live ? "border-down/60 bg-down/5" : "border-border bg-card"}`}
              style={{ gridArea: "s1" }}
            >
              <SniperRecap data={view!} />
            </div>
            <Tile area="hero" label="Pasar · langsung" source={live ? "shared" : undefined} right={heroMeta(data)} live={data.system.strategy2Alive}>
              <Hero data={data} />
            </Tile>
            {/* LIVE REPLACES PAPER — it never sits next to it.
                Showing both put a red LIVE badge above the paper wallet's $2,432 / +831.5%
                while the real wallet held 0.2486 SOL: the eye takes the biggest number on the
                screen as the answer, so "both" is strictly worse than either. Paper is archived
                out of the layout (still logged, still measured) whenever live is armed. */}
            <Tile
              area="equity"
              label={live ? "Dompet · uang sungguhan" : "Dompet · satu saldo, dua denominasi"}
              source={live ? "live" : undefined}
              live={live}
            >
              <EquityCurve data={view!} />
            </Tile>
            <Tile area="pipe" label="Pipeline · langsung" source={live ? "shared" : undefined} live={data.system.strategy2Alive}>
              <PipelineFlow data={data} />
            </Tile>
            <Tile area="agent" label="Feeling Agent" source={live ? "shared" : undefined} live={data.feeling.enabled}>
              <FeelingAgent data={data} />
            </Tile>
            <Tile
              area="jour"
              label={live ? "Trade Journal · selesai" : "Trade Journal · closed"}
              source={live ? "live" : undefined}
              right={`${view?.strategy2Primary?.recentTrades.length ?? 0} ${live ? "trade live" : "recent"}`}
              live={live}
            >
              <TradeJournal data={view!} />
            </Tile>
            <Tile area="sig" label="Band Watch · jendela entry" source={live ? "shared" : undefined}>
              <BandWatch data={data} />
            </Tile>
            <Tile
              area="pos"
              label={live ? "Posisi · bag nyata" : "Open Positions"}
              source={live ? "live" : undefined}
              right={`${(view?.paper?.openPositions?.length ?? 0)} ${live ? "bag live" : "active"}`}
              live={live}
            >
              <OpenPositions data={view!} />
            </Tile>
            <Tile area="funnel" label="Scout — candidates" source={live ? "shared" : undefined} right={`${data.strategy2.count} kandidat`}>
              <ScoutPanel data={data} />
            </Tile>
            <Tile area="gate" label="Admission — kenapa ditolak" source={live ? "shared" : undefined} right={`${data.strategy2Primary?.totals.rejected ?? 0} ditolak`}>
              <GateFunnel data={data} />
            </Tile>
            <Tile area="post" label={live ? "Exit Quality · per aturan keluar" : "Exit Quality"} live={live} source={live ? "live" : undefined}>
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
            </details>
            <RobinhoodChainPanel />
          </div>
          </>
        )}
      </div>
    </div>
  );
}
