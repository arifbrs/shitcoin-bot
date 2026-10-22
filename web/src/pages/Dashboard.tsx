import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEventHandler } from "react";
import { Activity, ChevronDown, LogOut, Settings2 } from "lucide-react";
import { useLiveStats } from "@/hooks/useLiveStats";
import { useLocalPaper } from "@/hooks/useLocalPaper";
import { useGmgnOverview } from "@/hooks/useGmgnOverview";
import { dashboardLanes, snapshotAge } from "@/lib/dashboard";
import type { DashboardSection } from "@/lib/dashboard";
import { addPaperCash, localPositionToken, paperPortfolio, parsePaperAmount } from "@/lib/localPaper";
import { filterTokens, formatUsd, quoteProblem, serverPositions, serverSignals, serverTrades, terminalTokens } from "@/lib/terminal";
import type { PanelState, PaperSide, ScannerFilter, TokenView } from "@/lib/terminal";
import { FeedStatus } from "@/components/panels/FeedStatus";
import { DashboardOverview } from "@/components/panels/DashboardOverview";
import { StaleBanner } from "@/components/panels/StaleBanner";
import { ControlDialog } from "@/components/panels/ControlDialog";
import { DiagnosticsDialog } from "@/components/panels/DiagnosticsDialog";
import { TokenScanner } from "@/components/panels/TokenScanner";
import type { ScannerTab } from "@/components/panels/TokenScanner";
import { TerminalHeader, TerminalStatus } from "@/components/panels/TerminalChrome";
import { TerminalDrawer, PanelFeedback } from "@/components/panels/TerminalPrimitives";
import { TerminalWorkspace } from "@/components/panels/TerminalWorkspace";
import { ServerLedger } from "@/components/panels/ServerLedger";
import type { ServerTab } from "@/components/panels/ServerLedger";
import { LocalPaperTicket, LocalPositions, OperationalContext, PaperSubmit, TokenContext } from "@/components/panels/LocalPaperTicket";
import type { LocalTicketProps } from "@/components/panels/LocalPaperTicket";
import { RobinhoodChainPanel } from "@/components/panels/RobinhoodChainPanel";
import { LaneRobinhood } from "@/components/panels/LaneRobinhood";
import { LivePanel } from "@/components/panels/LivePanel";
import { PaperPanel } from "@/components/panels/PaperPanel";
import { LaneGmgn } from "@/components/panels/LaneGmgn";
import { LaneDex } from "@/components/panels/LaneDex";
import { SolanaPanels } from "@/components/panels/SolanaPanels";
import { QualityCard } from "@/components/panels/QualityCard";

type Overlay = "scanner" | "ticket" | "lane" | "account" | "topup" | "reset" | null;

export default function Dashboard() {
  const { data, status, error, lastReceivedAt, reconnect } = useLiveStats();
  const [section, setSection] = useState<DashboardSection>("overview");
  const [laneQuery, setLaneQuery] = useState("");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [controlOpen, setControlOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ScannerFilter>("all");
  const [scannerTab, setScannerTab] = useState<ScannerTab>("tokens");
  const [serverTab, setServerTab] = useState<ServerTab>("positions");
  const [selection, setSelection] = useState<{ key: string | null; token: TokenView | null }>({ key: null, token: null });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [side, setSide] = useState<PaperSide>("buy");
  const [amount, setAmount] = useState("100");
  const [topUpAmount, setTopUpAmount] = useState("1000");
  const [notice, setNotice] = useState<string | null>(null);
  const [width, setWidth] = useState(() => typeof window === "undefined" ? 1600 : window.innerWidth);
  const [now, setNow] = useState(Date.now);
  const headerSearch = useRef<HTMLInputElement>(null);
  const scannerSearch = useRef<HTMLInputElement>(null);
  const inlineAmount = useRef<HTMLInputElement>(null);
  const drawerAmount = useRef<HTMLInputElement>(null);
  const topUpInput = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const age = snapshotAge(lastReceivedAt, now);
  const healthy = status === "open" && !error && age !== null && age < 90;
  const state: PanelState = !data ? error ? "error" : "loading" : healthy ? "ready" : "stale";
  const tokens = useMemo(() => terminalTokens(data), [data]);
  const positions = useMemo(() => serverPositions(data), [data]);
  const trades = useMemo(() => serverTrades(data), [data]);
  const local = useLocalPaper(tokens);
  const portfolio = useMemo(() => paperPortfolio(local.ledger, now), [local.ledger, now]);
  const gmgn = useGmgnOverview(serverTab === "signals" || (overlay === "lane" && section === "gmgn"));
  const signals = useMemo(() => serverSignals(data, gmgn.data), [data, gmgn.data]);
  const availableToken = tokens.find((token) => token.key === selection.key) ?? (selection.key === null ? tokens[0] : null);
  const localPosition = local.ledger.positions.find((position) => position.tokenKey === selection.key);
  const token = availableToken ?? (localPosition ? localPositionToken(localPosition) : selection.token);
  const quote = token?.quote ? availableToken && healthy ? token.quote : { ...token.quote, eligible: false, reason: !availableToken ? "Token tidak tersedia di sumber saat ini. Menunggu quote server baru." : "Feed dashboard belum terverifikasi. Menunggu snapshot dan quote unit baru." } : null;
  const laneName = section === "solana" ? "Solana / Strategy 2" : dashboardLanes.find((lane) => lane.id === section)?.name ?? "Overview";
  const filtered = useMemo(() => filterTokens(tokens, query, filter), [tokens, query, filter]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (status === "session-expired") window.location.replace("/login");
  }, [status]);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if ((width >= 1024 && overlay === "scanner") || (width >= 1440 && overlay === "ticket")) setOverlay(null);
  }, [width, overlay]);
  useEffect(() => {
    const current = tokens.find((item) => item.key === selection.key) ?? (selection.key === null ? tokens[0] : null);
    if (current) setSelection((previous) => previous.token === current ? previous : { key: current.key, token: current });
  }, [tokens, selection.key]);

  const rememberFocus = () => { restoreFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : main.current; };
  const openOverlay = (next: Overlay) => { if (!overlay) rememberFocus(); setOverlay(next); };
  const openScanner = (tab: ScannerTab = "tokens") => {
    setScannerTab(tab);
    if (width < 1024) openOverlay("scanner");
    else if (tab === "tokens") headerSearch.current?.focus();
  };
  const selectToken = (key: string) => {
    const selected = tokens.find((item) => item.key === key);
    const saved = local.ledger.positions.find((position) => position.tokenKey === key);
    if (!selected && !saved) return;
    setSelection({ key, token: selected ?? localPositionToken(saved!) });
    setFocusedKey(key);
    if (overlay === "scanner" || overlay === "lane") setOverlay(null);
    main.current?.scrollTo({ top: 0 });
    local.clearMessage();
  };
  const selectLane = (lane: DashboardSection, search = "") => {
    setSection(lane);
    setLaneQuery(search);
    openOverlay("lane");
  };
  const openTicket = (value: PaperSide = side) => {
    setSide(value);
    local.clearMessage();
    if (width >= 1440) inlineAmount.current?.focus();
    else openOverlay("ticket");
  };
  const openSystemDialog = (kind: "control" | "diagnostics") => {
    if (!overlay) rememberFocus();
    setOverlay(null);
    if (kind === "control") setControlOpen(true); else setDiagOpen(true);
  };
  const changeQuery = (value: string) => {
    setQuery(value);
    setFocusedKey(null);
    setScannerTab("tokens");
    if (width < 1024 && overlay !== "scanner") openOverlay("scanner");
  };
  const paste = async () => {
    try { changeQuery(await navigator.clipboard.readText()); setNotice(null); }
    catch { setNotice("Clipboard belum dapat dibaca. Tempel alamat ke kolom pencarian secara manual."); }
  };
  const moveFocus = (direction: number) => {
    const index = filtered.findIndex((item) => item.key === (focusedKey ?? selection.key));
    const next = filtered[Math.max(0, Math.min(filtered.length - 1, index + direction))];
    if (next) setFocusedKey(next.key);
  };
  const searchKeys: KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.key === "ArrowDown" ? 1 : -1); }
    if (event.key === "Enter") {
      event.preventDefault();
      const selected = filtered.find((item) => item.key === focusedKey) ?? filtered[0];
      if (selected) selectToken(selected.key);
      else {
        const text = query.trim().toLowerCase();
        const lane = dashboardLanes.find((item) => `${item.id} ${item.name}`.toLowerCase().includes(text));
        if (text && lane) selectLane(lane.id);
        else if (text && data?.laneRobinhood?.variants.some((variant) => `${variant.id} ${variant.cohort ?? ""}`.toLowerCase().includes(text))) selectLane("robinhood", query);
      }
    }
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || overlay || controlOpen || diagOpen) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") || target.isContentEditable)) return;
      if (event.key === "/") { event.preventDefault(); openScanner(); }
      else if (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "s") { event.preventDefault(); openTicket(event.key.toLowerCase() === "b" ? "buy" : "sell"); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveFocus(event.key === "ArrowDown" ? 1 : -1); }
      else if (event.key === "Enter" && !(target instanceof HTMLElement && target.closest("button, a, summary")) && focusedKey) { event.preventDefault(); selectToken(focusedKey); }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });

  const submit = () => { if (token) local.submit(token, side, amount, quote, Date.now()); };
  const ticket: LocalTicketProps = { id: "local-paper-inline", token, quote, ledger: local.ledger, side, amount, now, message: local.message, storageError: local.storageError, onSideChange: (value) => { setSide(value); local.clearMessage(); }, onAmountChange: (value) => { setAmount(value); local.clearMessage(); }, onSubmit: submit, amountRef: inlineAmount };
  const drawerTicket = { ...ticket, id: "local-paper-drawer", amountRef: drawerAmount };
  const scanner = { tokens, selectedKey: token?.key ?? null, query, onQueryChange: changeQuery, onPaste: () => void paste(), tab: scannerTab, onTabChange: setScannerTab, filter, onFilterChange: setFilter, onSelect: selectToken, onLaneSelect: selectLane, section, data, age, healthy, state, onRetry: reconnect, focusedKey, onFocusChange: setFocusedKey, onSearchKeyDown: searchKeys };
  const localPositions = <LocalPositions ledger={local.ledger} now={now} onSelect={selectToken} onReset={() => openOverlay("reset")} />;
  const operational = <OperationalContext data={data} age={age} onOpen={() => openSystemDialog("control")} />;
  const modalOpen = Boolean(overlay || controlOpen || diagOpen);

  return <div className="terminal-shell">
    <div className="terminal-surface" inert={modalOpen}>
      <a href="#dashboard-content" className="skip-link">Lewati ke workspace token</a>
      <TerminalHeader data={data} cashUsd={local.ledger.cashUsd} section={section} query={query} onQueryChange={changeQuery} onPaste={() => void paste()} onSearchKeyDown={searchKeys} searchRef={headerSearch} onScanner={() => openScanner()} onLanes={() => openScanner("lanes")} onTicket={() => openTicket()} onTopUp={() => openOverlay("topup")} onDiagnostics={() => openSystemDialog("diagnostics")} onAccount={() => openOverlay("account")} />
      <div className="terminal-body">
        <aside className="terminal-scanner-rail"><TokenScanner {...scanner} /></aside>
        <div className="terminal-center">
          <main id="dashboard-content" ref={main} tabIndex={-1} className="terminal-main" aria-label="Workspace token">
            <nav className="terminal-mobile-nav" aria-label="Lane dan scanner"><button type="button" onClick={() => openScanner()}>Tokens <span>{tokens.length}</span></button><button type="button" onClick={() => openScanner("lanes")}>{laneName}<ChevronDown size={13} /></button></nav>
            <FeedStatus status={status} error={error} age={age} onReconnect={reconnect} />
            {data && <div className="terminal-stale-banner"><StaleBanner data={data} /></div>}
            {notice && <div className="terminal-inline-note" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>Tutup</button></div>}
            {!availableToken && token && <p className="terminal-inline-note" role="status">Token tidak ada di snapshot saat ini · data terakhir, bukan quote baru.</p>}
            <TerminalWorkspace token={token} quote={quote} now={now} onScanner={() => openScanner()} onContext={() => openTicket()} />
          </main>
          <ServerLedger tab={serverTab} onTabChange={setServerTab} positions={positions} trades={trades} signals={signals} state={serverTab === "signals" && gmgn.loading && !signals.length ? "loading" : state} age={age} onSelectToken={selectToken} onSelectLane={selectLane} onRetry={() => { reconnect(); if (serverTab === "signals") gmgn.retry(); }} signalError={gmgn.error} />
          <section className="terminal-mobile-actions" aria-label="Buka ticket simulasi lokal"><div><span>Kas lokal {formatUsd(local.ledger.cashUsd)}</span><span>{token && quoteProblem(token, quote, now) === null ? "Quote unit terpisah" : "Quote unit belum ada"}</span></div><div><button type="button" className="terminal-open-buy" onClick={() => openTicket("buy")}>Buka Buy {token?.symbol ?? "token"}</button><button type="button" className="terminal-open-sell" onClick={() => openTicket("sell")}>Buka Sell {token?.symbol ?? "token"}</button></div></section>
        </div>
        <aside className="terminal-context-rail" aria-label="Simulasi lokal dan konteks token"><div className="terminal-ticket-block"><LocalPaperTicket {...ticket} /><PaperSubmit {...ticket} /></div><TokenContext token={token} />{localPositions}{operational}</aside>
      </div>
      <TerminalStatus data={data} equityUsd={portfolio.equityUsd} pnlPct={portfolio.pnlPct} localStale={portfolio.stale} status={status} age={age} healthy={healthy} now={now} />
    </div>
    <TerminalDrawer open={overlay === "scanner"} onOpenChange={(open) => setOverlay(open ? "scanner" : null)} title="Scanner & lanes" kind="scanner" initialFocusRef={scannerSearch} restoreFocusRef={restoreFocus}><TokenScanner {...scanner} mobile inputRef={scannerSearch} /></TerminalDrawer>
    <TerminalDrawer open={overlay === "ticket"} onOpenChange={(open) => setOverlay(open ? "ticket" : null)} title={`Paper ticket / ${token?.symbol ?? "—"}`} description="SIMULASI LOKAL · tidak dikirim ke server" kind="ticket" initialFocusRef={drawerAmount} restoreFocusRef={restoreFocus} footer={<PaperSubmit {...drawerTicket} />}><LocalPaperTicket {...drawerTicket} />{localPositions}<TokenContext token={token} />{operational}</TerminalDrawer>
    <TerminalDrawer open={overlay === "lane"} onOpenChange={(open) => setOverlay(open ? "lane" : null)} title={laneName} description="Monitoring server · setiap sumber dan ledger tetap terpisah" kind="lane" restoreFocusRef={restoreFocus}><div className="terminal-lane-content">
      <FeedStatus status={status} error={error} age={age} onReconnect={reconnect} />
      {!data ? <PanelFeedback state={state} title="Menunggu snapshot server" onRetry={reconnect} /> : <>
        {section === "overview" && <><DashboardOverview data={data} age={age} healthy={healthy} onSelect={selectLane} /><QualityCard data={data.quality} /></>}
        {section === "robinhood" && <><LaneRobinhood key={laneQuery} data={data.laneRobinhood} initialQuery={laneQuery} /><LivePanel /><PaperPanel /><RobinhoodChainPanel /></>}
        {section === "gmgn" && <LaneGmgn overview={gmgn} />}
        {section === "dex" && <LaneDex data={data.laneDex} />}
        {section === "solana" && <><p className="terminal-note">Lane kompatibilitas · Strategy 2 dari server. Ledger lokal tetap terpisah.</p><SolanaPanels data={data} /></>}
      </>}
    </div></TerminalDrawer>
    <TerminalDrawer open={overlay === "account"} onOpenChange={(open) => setOverlay(open ? "account" : null)} title="Akun & workspace" restoreFocusRef={restoreFocus}><div className="terminal-account-menu"><p>Kas virtual · lokal <b>{formatUsd(local.ledger.cashUsd)}</b></p><p>Exec mode server <b>{data?.control?.execMode ?? "—"}</b></p>{data?.liveBridge?.wallet && <p className="terminal-account-wallet">Wallet server <span>{data.liveBridge.wallet}</span></p>}<button type="button" className="terminal-button" onClick={() => openOverlay("topup")}>Tambah kas virtual</button><button type="button" className="terminal-button" onClick={() => openOverlay("reset")}>Reset ledger lokal</button><button type="button" className="terminal-button" onClick={() => openSystemDialog("diagnostics")} disabled={!data}><Activity size={16} />Diagnostik sistem</button><button type="button" className="terminal-button" onClick={() => openSystemDialog("control")}><Settings2 size={16} />Kontrol operasional server</button><a href="/logout" className="terminal-button"><LogOut size={16} />Keluar</a></div></TerminalDrawer>
    <TerminalDrawer open={overlay === "topup"} onOpenChange={(open) => setOverlay(open ? "topup" : null)} title="Tambah kas virtual" description="Hanya saldo simulasi lokal di browser ini" initialFocusRef={topUpInput} restoreFocusRef={restoreFocus}><form className="terminal-cash-form" onSubmit={(event) => { event.preventDefault(); const result = addPaperCash(local.ledger, topUpAmount); if (result.ok) { local.topUp(topUpAmount); setOverlay(null); } }}><label htmlFor="local-topup-amount">Jumlah USD virtual</label><div className="terminal-amount"><span>$</span><input ref={topUpInput} id="local-topup-amount" inputMode="decimal" value={topUpAmount} onChange={(event) => setTopUpAmount(event.target.value)} /></div><p className="terminal-note">Kas saat ini {formatUsd(local.ledger.cashUsd)}. Top-up ini bukan setoran wallet.</p>{!addPaperCash(local.ledger, topUpAmount).ok && parsePaperAmount(topUpAmount) !== null && <p className="terminal-note" role="status">Jumlah kas virtual terlalu besar.</p>}<button type="submit" className="terminal-button" disabled={!addPaperCash(local.ledger, topUpAmount).ok}>Tambah ke ledger lokal</button></form></TerminalDrawer>
    <TerminalDrawer open={overlay === "reset"} onOpenChange={(open) => setOverlay(open ? "reset" : null)} title="Reset simulasi lokal" description="Kas virtual kembali ke $10,000; posisi dan riwayat lokal dihapus" restoreFocusRef={restoreFocus}><div className="terminal-reset"><p>Reset ledger pada browser ini?</p><button type="button" className="terminal-button" onClick={() => setOverlay(null)}>Batal</button><button type="button" className="terminal-button" onClick={() => { local.reset(); setOverlay(null); }}>Reset ledger lokal</button></div></TerminalDrawer>
    <ControlDialog open={controlOpen} onOpenChange={setControlOpen} data={data} restoreFocusRef={restoreFocus} />
    <DiagnosticsDialog open={diagOpen} onOpenChange={setDiagOpen} data={data} restoreFocusRef={restoreFocus} />
  </div>;
}
