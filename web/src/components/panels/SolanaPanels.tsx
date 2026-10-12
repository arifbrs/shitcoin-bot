import type { StatsResponse } from "@/types/stats";
import { toLiveView } from "@/lib/liveView";
import { Tile } from "@/components/panels/Tile";
import { Hero, heroMeta } from "@/components/panels/Hero";
import { EquityCurve } from "@/components/panels/EquityCurve";
import { OpenPositions } from "@/components/panels/OpenPositions";
import { TradeJournal } from "@/components/panels/TradeJournal";
import { ExitQuality } from "@/components/panels/ExitQuality";
import { GateFunnel } from "@/components/panels/GateFunnel";
import { BandWatch } from "@/components/panels/BandWatch";
import { ScoutPanel } from "@/components/panels/ScoutPanel";
import { FeelingAgent } from "@/components/panels/FeelingAgent";
import { PipelineFlow } from "@/components/panels/PipelineFlow";
import { RunLedger } from "@/components/panels/RunLedger";
import { SniperRecap } from "@/components/panels/SniperRecap";

export function SolanaPanels({ data }: { data: StatsResponse }) {
  const live = data.liveBridge?.armed === true;
  const view = live ? toLiveView(data) : data;
  return (
    <div className="dash-grid">
      <div
        className={`flex items-center rounded-xl border px-3.5 ${live ? "border-down/60 bg-down/5" : "border-border bg-card"}`}
        style={{ gridArea: "s1" }}
      >
        <SniperRecap data={view} />
      </div>
      <Tile area="hero" label="Pasar · langsung" source={live ? "shared" : undefined} right={heroMeta(data)} live={data.system.strategy2Alive}>
        <Hero data={data} />
      </Tile>
      <Tile
        area="equity"
        label={live ? "Dompet · uang sungguhan" : "Dompet · satu saldo, dua denominasi"}
        source={live ? "live" : undefined}
        live={live}
      >
        <EquityCurve data={view} />
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
        right={`${view.strategy2Primary?.recentTrades.length ?? 0} ${live ? "trade live" : "recent"}`}
        live={live}
      >
        <TradeJournal data={view} />
      </Tile>
      <Tile area="sig" label="Band Watch · jendela entry" source={live ? "shared" : undefined}>
        <BandWatch data={data} />
      </Tile>
      <Tile
        area="pos"
        label={live ? "Posisi · bag nyata" : "Open Positions"}
        source={live ? "live" : undefined}
        right={`${(view.paper?.openPositions?.length ?? 0)} ${live ? "bag live" : "active"}`}
        live={live}
      >
        <OpenPositions data={view} />
      </Tile>
      <Tile area="funnel" label="Scout — candidates" source={live ? "shared" : undefined} right={`${data.strategy2.count} kandidat`}>
        <ScoutPanel data={data} />
      </Tile>
      <Tile area="gate" label="Admission — kenapa ditolak" source={live ? "shared" : undefined} right={`${data.strategy2Primary?.totals.rejected ?? 0} ditolak`}>
        <GateFunnel data={data} />
      </Tile>
      <Tile area="post" label={live ? "Exit Quality · per aturan keluar" : "Exit Quality"} live={live} source={live ? "live" : undefined}>
        <ExitQuality data={view} />
      </Tile>
      <Tile
        area="runs"
        label={live ? "Run Ledger — tidak berlaku di live" : "Run Ledger · lintas reset float"}
        right={live ? "" : `${data.runs?.profitable ?? 0}/${data.runs?.completed ?? 0} untung`}
        live={live}
      >
        <RunLedger data={view} />
      </Tile>
    </div>
  );
}
