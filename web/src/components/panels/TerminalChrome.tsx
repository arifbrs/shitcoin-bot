import type { KeyboardEventHandler, RefObject } from "react";
import { Activity, ChevronDown, PanelRightOpen, Search, UserRound, Workflow } from "lucide-react";
import { TerminalSearch } from "@/components/panels/TokenScanner";
import { LiveNumber } from "@/components/panels/TerminalPrimitives";
import { dashboardLanes, laneState } from "@/lib/dashboard";
import type { DashboardSection } from "@/lib/dashboard";
import { formatDuration, formatPercent, formatUsd, formatUtc } from "@/lib/terminal";
import type { StatsResponse } from "@/types/stats";
import type { ConnectionStatus } from "@/hooks/useLiveStats";

export function TerminalHeader({ data, cashUsd, section, query, onQueryChange, onPaste, onSearchKeyDown, searchRef, onScanner, onLanes, onTicket, onTopUp, onDiagnostics, onAccount }: {
  data: StatsResponse | null;
  cashUsd: number;
  section: DashboardSection;
  query: string;
  onQueryChange: (query: string) => void;
  onPaste: () => void;
  onSearchKeyDown: KeyboardEventHandler<HTMLInputElement>;
  searchRef: RefObject<HTMLInputElement | null>;
  onScanner: () => void;
  onLanes: () => void;
  onTicket: () => void;
  onTopUp: () => void;
  onDiagnostics: () => void;
  onAccount: () => void;
}) {
  const laneName = section === "solana" ? "Solana" : dashboardLanes.find((lane) => lane.id === section)?.name ?? "Overview";
  return <header className="terminal-header"><a href="/app" className="terminal-brand" aria-label="Shitcoin terminal"><Workflow size={20} strokeWidth={1.5} /><strong>shitcoin<span>/</span></strong></a><span className="terminal-badge">PAPER</span><button type="button" className="terminal-header-lane" onClick={onLanes}>{laneName}<ChevronDown size={12} /></button><div className="terminal-header-search"><TerminalSearch query={query} onQueryChange={onQueryChange} onPaste={onPaste} onKeyDown={onSearchKeyDown} inputRef={searchRef} /></div><div className="terminal-header-cash"><p>Kas virtual · lokal <LiveNumber value={cashUsd} width={11}>{formatUsd(cashUsd)}</LiveNumber></p><button type="button" onClick={onTopUp}>Tambah kas virtual</button></div><button type="button" className="terminal-icon terminal-header-scanner" aria-label="Buka pencarian dan scanner" onClick={onScanner}><Search size={18} /></button><button type="button" className="terminal-icon terminal-header-diagnostics" aria-label="Buka diagnostik sistem" disabled={!data} onClick={onDiagnostics}><Activity size={17} /></button><button type="button" className="terminal-button terminal-header-ticket" aria-label="Buka paper ticket" onClick={onTicket}>Paper ticket<PanelRightOpen size={14} /></button><button type="button" className="terminal-icon terminal-account-trigger" aria-label="Menu akun dan diagnostik" onClick={onAccount}><UserRound size={18} /></button></header>;
}

export function TerminalStatus({ data, equityUsd, pnlPct, localStale, status, age, healthy, now }: {
  data: StatsResponse | null;
  equityUsd: number | null;
  pnlPct: number | null;
  localStale: boolean;
  status: ConnectionStatus;
  age: number | null;
  healthy: boolean;
  now: number;
}) {
  const solUsd = data?.system?.solUsd ?? data?.combined?.solUsd;
  return <footer className="terminal-status" aria-label="Status monitoring"><span className="terminal-status-local" title="Ekuitas virtual lokal, terpisah dari server dan wallet live">LOKAL <LiveNumber value={equityUsd} width={10}>{formatUsd(equityUsd)}</LiveNumber><span className="terminal-status-pnl">{formatPercent(pnlPct)}</span>{localStale && <span>· mark terakhir</span>}</span><span className="terminal-status-sol">SOL · server {formatUsd(solUsd)}</span><span>SSE · {formatDuration(age)}</span><span className="terminal-status-lanes">{dashboardLanes.map((lane) => { const health = laneState(data?.laneHealth?.[lane.id], age, healthy); return <span key={lane.id} title={`${lane.name}: ${health.label}`}>{lane.mark} {healthy ? formatDuration(health.age) : "—"}</span>; })}</span><span className="terminal-status-source">{healthy ? "DATA SERVER" : status === "reconnecting" ? "RECONNECT" : data ? "SNAPSHOT TERAKHIR" : "MENUNGGU SERVER"}</span><time className="terminal-status-clock">{formatUtc(now)}</time></footer>;
}
