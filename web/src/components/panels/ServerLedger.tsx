import { LiveNumber, PanelFeedback, TokenAvatar } from "@/components/panels/TerminalPrimitives";
import { formatCount, formatDuration, formatPercent, formatPrice, formatSignedUsd, formatUsd, formatUtc, numericTone, sourceLabel } from "@/lib/terminal";
import type { PanelState, ServerPositionView, ServerSignalView, ServerTradeView } from "@/lib/terminal";
import type { DashboardSection } from "@/lib/dashboard";

export type ServerTab = "positions" | "trades" | "signals";

export function ServerLedger({ tab, onTabChange, positions, trades, signals, state, age, onSelectToken, onSelectLane, onRetry, signalError }: {
  tab: ServerTab;
  onTabChange: (tab: ServerTab) => void;
  positions: ServerPositionView[];
  trades: ServerTradeView[];
  signals: ServerSignalView[];
  state: PanelState;
  age: number | null;
  onSelectToken: (key: string) => void;
  onSelectLane: (lane: DashboardSection) => void;
  onRetry: () => void;
  signalError: string | null;
}) {
  const count = tab === "positions" ? positions.length : tab === "trades" ? trades.length : signals.length;
  return <section className="terminal-server-ledger" aria-label="Ledger paper server">
    <div className="terminal-tabs" aria-label="Tabel server">{([{ id: "positions", label: "Posisi" }, { id: "trades", label: "Trade" }, { id: "signals", label: "Sinyal" }] as const).map((item) => <button key={item.id} type="button" aria-label={`Tampilkan ${item.label.toLowerCase()} server`} aria-pressed={tab === item.id} onClick={() => onTabChange(item.id)}>{item.label}{tab === item.id && <span>{count}</span>}</button>)}<span className="terminal-badge">PAPER SERVER</span></div>
    {(state === "stale" || state === "error") && <div className="terminal-ledger-warning" role="status">Snapshot terakhir · {formatDuration(age)} · belum terverifikasi<button type="button" onClick={onRetry}>Hubungkan ulang</button></div>}
    {tab === "signals" && signalError && <div className="terminal-ledger-warning" role="alert">{signalError}<button type="button" onClick={onRetry}>Coba lagi</button></div>}
    <div className="terminal-table-scroll">
      {!count ? <PanelFeedback state={state} title={state === "loading" ? "Memuat ledger server…" : state === "error" ? "Ledger belum tersedia" : tab === "positions" ? "Belum ada posisi paper server" : tab === "trades" ? "Belum ada trade server" : "Belum ada sinyal dari sumber"} message="Setiap lane dan ledger tetap terpisah. Nilai yang belum tersedia ditampilkan —." onRetry={state === "error" ? onRetry : undefined} /> : tab === "positions" ? <PositionTable rows={positions} age={age} onSelect={onSelectToken} /> : tab === "trades" ? <TradeTable rows={trades} onSelectLane={onSelectLane} /> : <SignalTable rows={signals} onSelectToken={onSelectToken} onSelectLane={onSelectLane} />}
    </div>
    <footer className="terminal-ledger-footer"><span>{count} baris · {new Set((tab === "positions" ? positions.map((row) => row.token.provenance) : tab === "trades" ? trades.map((row) => row.provenance) : signals.map((row) => row.provenance)).map((source) => source.ledgerId ?? source.source)).size} sumber / ledger</span><span>Tidak dijumlah lintas ledger · bukan posisi lokal</span></footer>
  </section>;
}

function PositionTable({ rows, age, onSelect }: { rows: ServerPositionView[]; age: number | null; onSelect: (key: string) => void }) {
  return <table className="terminal-table"><caption className="sr-only">Posisi paper server, terpisah dari simulasi lokal dan wallet live</caption><thead><tr><th>Token / lane</th><th>Notional / biaya</th><th>PnL</th><th className="terminal-column-detail">Mark / MCap</th><th className="terminal-column-detail">Umur / mark age</th><th className="terminal-column-control">Kontrol</th></tr></thead><tbody>{rows.map((row) => {
    const cost = row.entryCostUsd ?? row.notionalUsd;
    const markAge = row.markAgeSeconds === null ? null : row.markAgeSeconds + (age ?? 0);
    return <tr key={row.key}>
      <td><button type="button" className="terminal-table-token" onClick={() => onSelect(row.token.key)}><TokenAvatar token={row.token} size={26} /><span><strong>{row.token.symbol}</strong><small title={sourceLabel(row.token.provenance)}>{sourceLabel(row.token.provenance)}</small></span></button></td>
      <td><LiveNumber value={cost} width={9}>{formatUsd(cost)}</LiveNumber><small>{row.entryCostUsd !== null ? "Biaya masuk USD" : row.notionalUsd !== null ? "Notional USD" : "—"}</small></td>
      <td>{row.pnlUsd !== null && <LiveNumber value={row.pnlUsd} signed width={9}>{formatSignedUsd(row.pnlUsd)}</LiveNumber>}{row.pnlPct !== null ? <LiveNumber value={row.pnlPct} signed>{formatPercent(row.pnlPct)}</LiveNumber> : row.pnlUsd === null ? "—" : null}{(row.pnlPct !== null || row.pnlUsd !== null) && <small>Unrealized · server</small>}</td>
      <td className="terminal-column-detail"><LiveNumber value={row.markPriceUsd ?? row.marketCapUsd} width={9}>{row.markPriceUsd !== null ? formatPrice(row.markPriceUsd) : formatUsd(row.marketCapUsd, true)}</LiveNumber><small>{row.markPriceUsd !== null ? "Mark USD / token" : row.marketCapUsd !== null ? "MCap · bukan harga" : "—"}</small></td>
      <td className="terminal-column-detail">{row.heldSeconds !== null ? <>{formatDuration(row.heldSeconds)}<small>Held · snapshot</small></> : markAge !== null ? <>{formatDuration(markAge)}<small>{markAge > 60 ? "Mark age · tertinggal" : "Mark age"}</small></> : row.detectedAt !== null ? <>{formatUtc(row.detectedAt)}<small>Terdeteksi</small></> : "—"}</td>
      <td className="terminal-column-control"><small>{row.noManualClose ? "Dikelola strategi" : "Kontrol operasional"}</small></td>
    </tr>;
  })}</tbody></table>;
}

function TradeTable({ rows, onSelectLane }: { rows: ServerTradeView[]; onSelectLane: (lane: DashboardSection) => void }) {
  return <table className="terminal-table"><caption className="sr-only">Trade server per lane dan ledger; denominasi PnL mengikuti sumber</caption><thead><tr><th>Token / lane</th><th>Aksi</th><th>PnL</th><th className="terminal-column-detail">Entry / exit USD</th><th className="terminal-column-detail">Waktu UTC</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td><button type="button" className="terminal-table-token" onClick={() => onSelectLane(row.provenance.lane)}><span><strong>{row.symbol}</strong><small>{sourceLabel(row.provenance)}</small></span></button></td><td>{row.action}<small title={row.reason ?? undefined}>{row.reason ?? "—"}</small></td><td>{row.pnlUsd !== null ? <span className={numericTone(row.pnlUsd)}>{formatSignedUsd(row.pnlUsd)}</span> : row.pnlSol !== null ? <span className={numericTone(row.pnlSol)}>{row.pnlSol >= 0 ? "+" : ""}{formatCount(row.pnlSol)} SOL</span> : "—"}{row.pnlPct !== null && <small className={numericTone(row.pnlPct)}>{formatPercent(row.pnlPct)}</small>}</td><td className="terminal-column-detail">{formatPrice(row.entryPriceUsd)}<small>Exit {formatPrice(row.exitPriceUsd)}</small></td><td className="terminal-column-detail">{formatUtc(row.timestamp)}<small>{row.heldSeconds === null ? "—" : `Held ${formatDuration(row.heldSeconds)}`}</small></td></tr>)}</tbody></table>;
}

function SignalTable({ rows, onSelectToken, onSelectLane }: { rows: ServerSignalView[]; onSelectToken: (key: string) => void; onSelectLane: (lane: DashboardSection) => void }) {
  return <table className="terminal-table"><caption className="sr-only">Sinyal observasi dari sumber server, bukan eksekusi atau quote unit</caption><thead><tr><th>Token / sumber</th><th>Sinyal</th><th>MCap</th><th className="terminal-column-detail">Holders</th><th className="terminal-column-detail">Waktu UTC</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td><button type="button" className="terminal-table-token" onClick={() => row.tokenKey ? onSelectToken(row.tokenKey) : onSelectLane(row.provenance.lane)}><span><strong>{row.symbol}</strong><small>{sourceLabel(row.provenance)}</small></span></button></td><td>{row.kind}<small>{row.detail ?? "—"}</small></td><td>{formatUsd(row.marketCapUsd, true)}</td><td className="terminal-column-detail">{formatCount(row.holders)}</td><td className="terminal-column-detail">{formatUtc(row.timestamp)}</td></tr>)}</tbody></table>;
}
