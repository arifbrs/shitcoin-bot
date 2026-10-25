import { Activity, LogOut, Settings2, Workflow } from "lucide-react";
import type { StatsResponse } from "@/types/stats";
import type { ConnectionStatus } from "@/hooks/useLiveStats";

interface Props {
  data: StatsResponse | null;
  status: ConnectionStatus;
  healthy: boolean;
  onOpenControl: () => void;
  onOpenDiagnostics: () => void;
}

export function TopBar({ data, status, healthy, onOpenControl, onOpenDiagnostics }: Props) {
  const mode = data?.control.execMode;
  const armed = data?.liveBridge?.armed === true;
  const label = healthy ? "Feed tersambung" : status === "reconnecting" ? "Menyambungkan ulang" : status === "open" ? "Snapshot tertinggal" : "Menunggu feed";
  return (
    <header className="console-header">
      <a href="/app" className="console-brand" aria-label="Shitcoin console">
        <span className="brand-symbol"><Workflow size={21} strokeWidth={1.7} /></span>
        <span><strong>SHITCOIN<span className="text-up">.</span></strong><small>Multi-lane console</small></span>
      </a>
      <div className="console-actions">
        <span className={`connection-pill ${healthy ? "text-up" : "text-gold"}`} role="status">
          <span className={`status-dot ${healthy ? "is-live" : ""}`} />{label}
        </span>
        <span className={`execution-pill ${armed || mode === "live" ? "text-down border-down/40" : "text-muted-foreground"}`}>
          {mode ? `Solana · ${armed ? "LIVE · ARMED" : mode.toUpperCase()}${data?.control.paused ? " · PAUSED" : ""}` : "Mode belum tersedia"}
        </span>
        <button type="button" className="console-icon-button" onClick={onOpenDiagnostics} disabled={!data} aria-label="Buka diagnostik" title="Diagnostik"><Activity size={18} /></button>
        <button type="button" className="console-icon-button" onClick={onOpenControl} aria-label="Buka kontrol" title="Kontrol"><Settings2 size={18} /></button>
        <a href="/logout" className="console-icon-button" aria-label="Keluar" title="Keluar"><LogOut size={17} /></a>
      </div>
    </header>
  );
}
