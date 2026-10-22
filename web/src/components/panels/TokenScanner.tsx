import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Search } from "lucide-react";
import { dashboardLanes, laneState } from "@/lib/dashboard";
import type { DashboardSection } from "@/lib/dashboard";
import { filterTokens, formatDuration, formatPercent, formatUsd, sourceLabel } from "@/lib/terminal";
import type { PanelState, ScannerFilter, TokenView } from "@/lib/terminal";
import type { StatsResponse } from "@/types/stats";
import { LiveNumber, PanelFeedback, TokenAvatar } from "@/components/panels/TerminalPrimitives";

export type ScannerTab = "tokens" | "lanes" | "feed";
export const terminalLanes = [{ id: "overview", name: "Overview", mark: "OV", mode: "Ringkasan" }, ...dashboardLanes, { id: "solana", name: "Solana", mark: "S2", mode: "Strategy 2" }] as const;

export function TerminalSearch({ query, onQueryChange, onPaste, inputRef, onKeyDown }: {
  query: string;
  onQueryChange: (query: string) => void;
  onPaste: () => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}) {
  return <div className="terminal-search"><Search size={15} aria-hidden="true" /><input ref={inputRef} type="search" aria-label="Cari token, lane, alamat, varian, atau kohort" value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Cari token, lane, atau alamat…" /><button type="button" onClick={onPaste}>Tempel</button><kbd>/</kbd></div>;
}

export function LaneNavigation({ data, section, age, healthy, onSelect }: {
  data: Partial<StatsResponse> | null;
  section: DashboardSection;
  age: number | null;
  healthy: boolean;
  onSelect: (section: DashboardSection, query?: string) => void;
}) {
  return <nav className="terminal-lanes" aria-label="Navigasi lane monitoring"><p>LANE MONITORING</p>{terminalLanes.map((lane) => {
    const state = laneState(data?.laneHealth?.[lane.id], age, healthy);
    const count = lane.id === "robinhood" ? `${data?.laneRobinhood?.variants?.length ?? "—"} varian` : lane.mode;
    return <button key={lane.id} type="button" aria-current={section === lane.id ? "page" : undefined} aria-label={`Buka lane ${lane.name}`} onClick={() => onSelect(lane.id)}><span className="terminal-lane-mark">{lane.mark}</span><span>{lane.name}</span><small>{count}</small>{lane.id !== "overview" && <span className="terminal-lane-age" title={state.label}>{healthy && state.age !== null ? formatDuration(state.age) : "—"}</span>}</button>;
  })}</nav>;
}

function SearchNavigation({ data, query, onSelect }: { data: Partial<StatsResponse> | null; query: string; onSelect: (lane: DashboardSection, query?: string) => void }) {
  const text = query.trim().toLowerCase();
  if (!text) return null;
  const lanes = terminalLanes.filter((lane) => `${lane.id} ${lane.name}`.toLowerCase().includes(text));
  const variants = data?.laneRobinhood?.variants?.filter((variant) => `${variant.id} ${variant.cohort ?? ""}`.toLowerCase().includes(text)) ?? [];
  if (!lanes.length && !variants.length) return null;
  return <div className="terminal-search-navigation" aria-label="Résultats lane, varian, dan kohort"><p>LANE / VARIAN / KOHORT</p>{lanes.map((lane) => <button key={lane.id} type="button" onClick={() => onSelect(lane.id)}><span>{lane.name}</span><small>Lane</small></button>)}{variants.map((variant) => <button key={variant.id} type="button" onClick={() => onSelect("robinhood", query)}><span>{variant.id}</span><small title={variant.cohort ?? undefined}>{variant.cohort ?? "Robinhood"}</small></button>)}</div>;
}

/** Fixed 52px rows keep 500+ tokens cheap and preserve the selected row across SSE updates. */
export function VirtualTokens({ tokens, selectedKey, onSelect }: { tokens: TokenView[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [windowSize, setWindowSize] = useState({ top: 0, height: 520 });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const activeKey = focusedKey && tokens.some((token) => token.key === focusedKey) ? focusedKey : selectedKey;
  const activeIndex = tokens.findIndex((token) => token.key === activeKey);
  const ensureVisible = (index: number) => {
    const element = viewport.current;
    if (!element || index < 0) return;
    const top = index * 52;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + 52 > element.scrollTop + element.clientHeight) element.scrollTop = top + 52 - element.clientHeight;
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWindowSize({ top: element.scrollTop, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => { ensureVisible(activeIndex); }, [activeIndex]);
  const start = Math.max(0, Math.floor(windowSize.top / 52) - 8);
  const end = Math.min(tokens.length, Math.ceil((windowSize.top + windowSize.height) / 52) + 8);
  const id = (key: string) => `scanner-${encodeURIComponent(key)}`;
  return <div ref={viewport} className="terminal-token-list" role="listbox" aria-label="Token dari semua lane" tabIndex={0} aria-activedescendant={activeIndex >= start && activeIndex < end ? id(tokens[activeIndex].key) : undefined}
    onScroll={(event) => { const element = event.currentTarget; setWindowSize({ top: element.scrollTop, height: element.clientHeight }); }}
    onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") { if (activeIndex >= 0) onSelect(tokens[activeIndex].key); return; }
      const index = event.key === "Home" ? 0 : event.key === "End" ? tokens.length - 1 : Math.max(0, Math.min(tokens.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1)));
      if (tokens[index]) { setFocusedKey(tokens[index].key); ensureVisible(index); }
    }}><div className="terminal-virtual-space" style={{ height: tokens.length * 52 }}>{tokens.slice(start, end).map((token, offset) => <div key={token.key} id={id(token.key)} role="option" aria-selected={token.key === selectedKey} aria-setsize={tokens.length} aria-posinset={start + offset + 1} className={`terminal-token-row ${token.key === activeKey ? "is-focused" : ""}`} style={{ top: (start + offset) * 52 }} onClick={() => onSelect(token.key)}><span className="terminal-token-identity"><TokenAvatar token={token} /><span><strong>{token.symbol}</strong><small title={token.sources.map(sourceLabel).join(" / ")}>{sourceLabel(token.provenance)} · {token.chain ?? "—"}</small></span></span><LiveNumber value={token.marketCapUsd} width={8}>{formatUsd(token.marketCapUsd, true)}</LiveNumber><LiveNumber value={token.change24h} width={8} signed>{formatPercent(token.change24h)}</LiveNumber></div>)}</div></div>;
}

export function TokenScanner({ tokens, selectedKey, query, onQueryChange, onPaste, tab, onTabChange, filter, onFilterChange, onSelect, onLaneSelect, section, data, age, healthy, state, onRetry, mobile = false, inputRef }: {
  tokens: TokenView[];
  selectedKey: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  onPaste: () => void;
  tab: ScannerTab;
  onTabChange: (tab: ScannerTab) => void;
  filter: ScannerFilter;
  onFilterChange: (filter: ScannerFilter) => void;
  onSelect: (key: string) => void;
  onLaneSelect: (lane: DashboardSection, query?: string) => void;
  section: DashboardSection;
  data: Partial<StatsResponse> | null;
  age: number | null;
  healthy: boolean;
  state: PanelState;
  onRetry: () => void;
  mobile?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const filtered = filterTokens(tokens, query, filter);
  const filters = [{ id: "all", label: "Semua" }, { id: "positions", label: "Posisi" }, { id: "scout", label: "Scout" }, { id: "market", label: "Pasar" }, { id: "solana", label: "Solana" }] as const;
  return <section className={`terminal-scanner ${mobile ? "terminal-scanner-mobile" : ""}`} aria-label="Scanner token dan lane">
    {mobile && <div className="terminal-scanner-search"><TerminalSearch query={query} onQueryChange={onQueryChange} onPaste={onPaste} inputRef={inputRef} /><p>Pencarian mencakup varian dan kohort Robinhood</p></div>}
    <div className="terminal-tabs" aria-label="Panel scanner">{(["tokens", "lanes", "feed"] as const).map((value) => <button key={value} type="button" aria-pressed={tab === value} onClick={() => onTabChange(value)}>{value === "tokens" ? "Tokens" : value === "lanes" ? "Lanes" : "Feed"}</button>)}<small>{tokens.length}</small></div>
    {tab === "tokens" && <><div className="terminal-filters">{filters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => onFilterChange(item.id)}>{item.label}</button>)}</div><SearchNavigation data={data} query={query} onSelect={onLaneSelect} /><div className="terminal-scanner-columns"><span>Token / sumber</span><span>MCap</span><span>24h</span></div>{filtered.length ? <VirtualTokens tokens={filtered} selectedKey={selectedKey} onSelect={onSelect} /> : <PanelFeedback state={state === "stale" ? "empty" : state} title={state === "loading" ? "Memuat token dari server…" : state === "error" ? "Feed token belum tersedia" : "Tidak ada token sesuai filter"} message={query || filter !== "all" ? "Ubah pencarian atau hapus filter." : "Token muncul saat sumber mengirim data."} onRetry={state === "error" ? onRetry : query || filter !== "all" ? () => { onQueryChange(""); onFilterChange("all"); } : undefined} />}</>}
    {tab === "lanes" && <div className="terminal-scanner-scroll"><LaneNavigation data={data} section={section} age={age} healthy={healthy} onSelect={onLaneSelect} /><SearchNavigation data={data} query={query} onSelect={onLaneSelect} /><p className="terminal-note">Kesehatan setiap lane mengikuti sumber server. Feed terputus berarti kesehatan belum terverifikasi.</p></div>}
    {tab === "feed" && <div className="terminal-scanner-scroll"><div className="terminal-feed-detail"><h2>Feed dashboard</h2><p>{healthy ? "Snapshot SSE terhubung" : state === "loading" ? "Menunggu snapshot pertama" : "Snapshot terakhir · belum terverifikasi"}</p><dl><dt>Usia snapshot</dt><dd>{formatDuration(age)}</dd><dt>Chart</dt><dd>Histori on-request</dd></dl><button type="button" className="terminal-button" onClick={onRetry}>Hubungkan ulang</button></div><LaneNavigation data={data} section={section} age={age} healthy={healthy} onSelect={onLaneSelect} /></div>}
    {tab === "tokens" && <LaneNavigation data={data} section={section} age={age} healthy={healthy} onSelect={onLaneSelect} />}
    <footer className="terminal-scanner-footer"><span>{filtered.length} / {tokens.length} token{state === "stale" ? " · tertinggal" : ""}</span><span>↑ ↓ · ↵ pilih</span></footer>
  </section>;
}
