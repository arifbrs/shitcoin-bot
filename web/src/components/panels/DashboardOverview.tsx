import { ArrowDownLeft, ArrowUpRight, ChevronRight, Layers3 } from "lucide-react";
import type { StatsResponse } from "@/types/stats";
import { dashboardLanes, formatAge, laneState } from "@/lib/dashboard";
import type { DashboardSection } from "@/lib/dashboard";

interface Props {
  data: Partial<Pick<StatsResponse, "laneHealth" | "laneRobinhood" | "laneDex">>;
  age: number | null;
  healthy: boolean;
  onSelect: (section: DashboardSection) => void;
}

function LaneCards({ data, age, healthy, onSelect }: Props) {
  return <div className="lane-cards">{dashboardLanes.map((lane) => {
    const state = laneState(data.laneHealth?.[lane.id], age, healthy);
    return <button key={lane.id} type="button" className="lane-card" onClick={() => onSelect(lane.id)} aria-label={`Buka lane ${lane.name}`}>
      <span className="flex items-center justify-between gap-3"><span className="lane-monogram">{lane.mark}</span><span className={`lane-state state-${state.tone}`}><span className="status-dot" />{state.label}</span></span>
      <span className="lane-name">{lane.name}<ArrowUpRight size={18} /></span>
      <span className="lane-description">{lane.description}</span>
      <span className="lane-card-footer"><span>{lane.mode}</span><span>{formatAge(state.age)}</span></span>
    </button>;
  })}</div>;
}

function RecentActivity({ data, onSelect }: Pick<Props, "data" | "onSelect">) {
  const trades = data.laneRobinhood?.recent.slice(0, 6);
  return <section className="activity-panel">
    <div className="section-heading"><div><p className="eyebrow">Robinhood · paper</p><h2>Aktivitas terakhir</h2></div><button type="button" className="text-action" onClick={() => onSelect("robinhood")}>Lihat lane<ChevronRight size={15} /></button></div>
    {!trades?.length ? <div className="console-empty"><Layers3 size={25} /><p>{trades ? "Belum ada aktivitas paper." : "Data aktivitas belum tersedia."}</p><span>Trade baru akan muncul saat snapshot diperbarui.</span></div> : <ul className="activity-list">{trades.map((trade, index) => {
      const opened = trade.action === "RH_OPEN";
      const timestamp = Date.parse(trade.ts);
      return <li key={`${trade.ts}-${trade.variant}-${index}`}>
        <span className={`activity-icon ${opened ? "text-up" : "text-muted-foreground"}`}>{opened ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}</span>
        <div className="activity-token"><strong>{trade.symbol}</strong><span title={trade.variant}>{trade.variant}</span></div>
        <span className="activity-side">{opened ? "Buka posisi" : "Tutup posisi"}</span>
        <div className="activity-result"><strong className={trade.pnlUsd == null ? "text-muted-foreground" : trade.pnlUsd >= 0 ? "text-up" : "text-down"}>{trade.pnlUsd == null ? "—" : `${trade.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(trade.pnlUsd).toFixed(2)}`}</strong><time dateTime={Number.isFinite(timestamp) ? trade.ts : undefined}>{Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "—"}</time></div>
      </li>;
    })}</ul>}
  </section>;
}

export function DashboardOverview(props: Props) {
  const { data, healthy, onSelect } = props;
  const known = dashboardLanes.filter((lane) => data.laneHealth?.[lane.id]?.ageSec != null);
  const active = known.filter((lane) => data.laneHealth?.[lane.id]?.fresh).length;
  const metrics = [
    { label: "Lane aktif", value: healthy && known.length ? `${active} / ${dashboardLanes.length}` : "—", note: healthy ? `${known.length} lane dengan data kesehatan` : "Menunggu verifikasi feed" },
    { label: "Varian strategi", value: data.laneRobinhood?.variants.length, note: "Robinhood · forward test" },
    { label: "Posisi paper", value: data.laneRobinhood?.openTotal, note: "Robinhood · posisi terbuka" },
    { label: "Token dipantau", value: data.laneDex?.watchlistTotal, note: "DexScreener · watchlist" },
  ];
  return <>
    <dl className="overview-metrics">{metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{metric.value ?? "—"}</dd><p>{metric.note}</p></div>)}</dl>
    <div className="section-heading"><div><p className="eyebrow">Workspace</p><h2>Empat lane. Satu pandangan.</h2></div><span className="section-caption">Pilih lane untuk membuka detail</span></div>
    <LaneCards {...props} />
    <div className="overview-bottom">
      <RecentActivity data={data} onSelect={onSelect} />
      <aside className="monitoring-note"><span className="eyebrow">Tentang data</span><h2>Pantau sinyal.<br />Pahami konteksnya.</h2><p>Status lane mengikuti aktivitas berkas di server. Feed tersambung menunjukkan koneksi dashboard, bukan jaminan proses trading berjalan.</p><div><span className="status-dot text-up" /><span>Robinhood & OKX memiliki ledger paper terpisah.</span></div><div><span className="status-dot text-gold" /><span>Panel GMGN dan OKX Web3 memperbarui data secara berkala saat dibuka.</span></div><button type="button" className="text-action" onClick={() => onSelect("solana")}>Buka panel Solana<ChevronRight size={15} /></button></aside>
    </div>
  </>;
}
