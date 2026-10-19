import { useEffect, useState } from "react";
import { LayoutDashboard, ArrowUpRight } from "lucide-react";
import { useLiveStats } from "@/hooks/useLiveStats";
import { dashboardLanes, snapshotAge } from "@/lib/dashboard";
import type { DashboardSection } from "@/lib/dashboard";
import { TopBar } from "@/components/panels/TopBar";
import { FeedStatus, DashboardLoading } from "@/components/panels/FeedStatus";
import { DashboardOverview } from "@/components/panels/DashboardOverview";
import { SolanaPanels } from "@/components/panels/SolanaPanels";
import { StaleBanner } from "@/components/panels/StaleBanner";
import { ControlDialog } from "@/components/panels/ControlDialog";
import { DiagnosticsDialog } from "@/components/panels/DiagnosticsDialog";
import { OkxWeb3Panel } from "@/components/panels/OkxWeb3Panel";
import { RobinhoodChainPanel } from "@/components/panels/RobinhoodChainPanel";
import { LaneRobinhood } from "@/components/panels/LaneRobinhood";
import { LivePanel } from "@/components/panels/LivePanel";
import { LaneGmgn } from "@/components/panels/LaneGmgn";
import { LaneDex } from "@/components/panels/LaneDex";
import { LaneOkxPaper } from "@/components/panels/LaneOkxPaper";
import { QualityCard } from "@/components/panels/QualityCard";

export default function Dashboard() {
  const { data, status, error, lastReceivedAt, reconnect } = useLiveStats();
  const [section, setSection] = useState<DashboardSection>("overview");
  const [controlOpen, setControlOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const age = snapshotAge(lastReceivedAt, now);
  const healthy = status === "open" && !error && age !== null && age < 90;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (status === "session-expired") window.location.replace("/login");
  }, [status]);

  return (
    <div className="console-shell">
      <a href="#dashboard-content" className="skip-link">Lewati ke dashboard</a>
      <TopBar data={data} status={status} healthy={healthy} onOpenControl={() => setControlOpen(true)} onOpenDiagnostics={() => setDiagOpen(true)} />
      <ControlDialog open={controlOpen} onOpenChange={setControlOpen} data={data} />
      <DiagnosticsDialog open={diagOpen} onOpenChange={setDiagOpen} data={data} />
      <main id="dashboard-content" tabIndex={-1} className={`console-main ${controlOpen || diagOpen ? "invisible" : ""}`}>
        <div className="console-intro"><div><p className="eyebrow">Market operations / monitoring</p><h1>Semua pergerakan.<br className="sm:hidden" /> Satu kendali<span className="text-up">.</span></h1><p>Amati strategi, sinyal, dan kualitas eksekusi dari satu tempat.</p></div><button type="button" onClick={() => setDiagOpen(true)} disabled={!data} className="diagnostics-button">Diagnostik sistem<ArrowUpRight size={16} /></button></div>
        <FeedStatus status={status} error={error} age={age} onReconnect={reconnect} />
        {data && <StaleBanner data={data} />}
        <nav className="console-nav" aria-label="Navigasi lane">
          <button type="button" aria-pressed={section === "overview"} onClick={() => setSection("overview")}><LayoutDashboard size={16} />Ringkasan</button>
          {dashboardLanes.map((lane) => <button key={lane.id} type="button" aria-pressed={section === lane.id} onClick={() => setSection(lane.id)}>{lane.name}</button>)}
          <button type="button" aria-pressed={section === "solana"} onClick={() => setSection("solana")}>Solana<span className="nav-label">S1 / S2</span></button>
        </nav>
        {!data ? <DashboardLoading /> : <div className="console-content">
          {section === "overview" && <><DashboardOverview data={data} age={age} healthy={healthy} onSelect={setSection} /><QualityCard data={data.quality} /></>}
          {section === "robinhood" && <><LaneRobinhood data={data.laneRobinhood} /><LivePanel /><RobinhoodChainPanel /></>}
          {section === "gmgn" && <LaneGmgn />}
          {section === "dex" && <LaneDex data={data.laneDex} />}
          {section === "okxPaper" && <><LaneOkxPaper data={data.laneOkxPaper} /><OkxWeb3Panel /></>}
          {section === "solana" && <><p className="archive-notice">Panel S1 / S2 · data historis dan status eksekusi Solana. Periksa mode di kontrol sebelum membaca hasil.</p><SolanaPanels data={data} /></>}
        </div>}
        <footer className="console-footer"><span>SHITCOIN / OPERATIONS</span><span>Data monitoring · hasil paper bukan hasil eksekusi nyata</span></footer>
      </main>
    </div>
  );
}
