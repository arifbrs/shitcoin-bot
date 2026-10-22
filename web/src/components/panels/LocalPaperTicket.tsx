import type { RefObject } from "react";
import { ArrowUpRight, LockKeyhole } from "lucide-react";
import { LiveNumber, TokenAvatar } from "@/components/panels/TerminalPrimitives";
import { paperOrderProblem, paperPortfolio, parsePaperAmount } from "@/lib/localPaper";
import type { PaperLedger } from "@/lib/localPaper";
import { formatCount, formatDuration, formatPercent, formatPrice, formatQuantity, formatSignedUsd, formatUsd, quoteProblem, sourceLabel } from "@/lib/terminal";
import type { PaperSide, QuoteView, TokenView } from "@/lib/terminal";
import type { StatsResponse } from "@/types/stats";

export interface LocalTicketProps {
  id: string;
  token: TokenView | null;
  quote: QuoteView | null;
  ledger: PaperLedger;
  side: PaperSide;
  amount: string;
  now: number;
  message: string | null;
  storageError: string | null;
  onSideChange: (side: PaperSide) => void;
  onAmountChange: (amount: string) => void;
  onSubmit: () => void;
  amountRef?: RefObject<HTMLInputElement | null>;
}

export function LocalPaperTicket(props: LocalTicketProps) {
  const { id, token, quote, ledger, side, amount, now, message, storageError, onSideChange, onAmountChange, onSubmit, amountRef } = props;
  const quoteError = token ? quoteProblem(token, quote, now) : "Pilih token dari scanner terlebih dahulu.";
  const amountUsd = parsePaperAmount(amount);
  const quantity = quoteError || amountUsd === null ? null : amountUsd / quote!.unitPriceUsd!;
  const owned = ledger.positions.find((position) => position.tokenKey === token?.assetKey)?.quantity ?? 0;
  return <form id={id} className="terminal-ticket-form" onSubmit={(event) => { event.preventDefault(); onSubmit(); }} aria-label="Form simulasi lokal">
    <div className="terminal-section-title"><h2>Paper ticket <span>/ {token?.symbol ?? "—"}</span></h2><span className="terminal-badge">BROWSER</span></div>
    <p className="terminal-local-label">SIMULASI LOKAL · tidak dikirim ke server</p>
    <div className="terminal-ticket-side">{(["buy", "sell"] as const).map((value) => <button key={value} type="button" aria-pressed={side === value} className={`terminal-side-${value}`} onClick={() => onSideChange(value)}>{value === "buy" ? "Buy" : "Sell"}<kbd>{value === "buy" ? "B" : "S"}</kbd></button>)}</div>
    <label htmlFor={`${id}-amount`} className="terminal-amount-label"><span>Jumlah USD</span><span>{side === "buy" ? "Kas virtual" : "Token lokal"} <b>{side === "buy" ? formatUsd(ledger.cashUsd) : `${formatQuantity(owned)} ${token?.symbol ?? "—"}`}</b></span></label>
    <div className="terminal-amount"><span>$</span><input ref={amountRef} id={`${id}-amount`} inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => onAmountChange(event.target.value)} placeholder="Masukkan jumlah" aria-describedby={`${id}-quote-note`} /><small>USD</small></div>
    <div className="terminal-presets">{["10", "100", "500", "1000"].map((value) => <button key={value} type="button" aria-pressed={Number(amount) === Number(value)} onClick={() => onAmountChange(value)}>{formatUsd(Number(value)).replace(".00", "")}</button>)}</div>
    <dl className="terminal-ticket-estimate"><div><dt>Harga unit layak</dt><dd>{quoteError ? "—" : formatPrice(quote?.unitPriceUsd)}</dd></div><div><dt>{side === "buy" ? "Estimasi token diterima" : "Estimasi token dijual"}</dt><dd>{formatQuantity(quantity)} {token?.symbol ?? "—"}</dd></div><div><dt>Sumber quote</dt><dd>{quote?.source ?? "—"}</dd></div></dl>
    <div id={`${id}-quote-note`} className="terminal-quote-note"><strong>{quoteError ? "Menunggu harga unit yang valid" : "Quote unit untuk simulasi lokal"}</strong><p>{quoteError ?? `Quote ${formatDuration((now - quote!.quotedAt!) / 1000)} lalu. Buy/Sell hanya dicatat di browser ini.`}</p></div>
    {paperOrderProblem(ledger, token, side, amount, quote, now) && !quoteError && <p className="terminal-inline-note" role="status">{paperOrderProblem(ledger, token, side, amount, quote, now)}</p>}
    {storageError && <p className="terminal-inline-note" role="alert">{storageError}</p>}
    {message && <p className="terminal-inline-note" role="status">{message}</p>}
    <p className="terminal-note">Saldo awal $10,000 virtual · tersimpan di browser ini</p>
  </form>;
}

export function PaperSubmit({ id, token, quote, ledger, side, amount, now }: LocalTicketProps) {
  const problem = paperOrderProblem(ledger, token, side, amount, quote, now);
  const waiting = !token || quoteProblem(token, quote, now) !== null;
  return <div className="terminal-ticket-submit"><button type="submit" form={id} disabled={Boolean(problem)} className={`terminal-submit terminal-submit-${side}`} title={problem ?? undefined}>{waiting && <LockKeyhole size={14} />}{side === "buy" ? "Buy" : "Sell"} {token?.symbol ?? "token"} · {waiting ? "menunggu quote" : problem ? "jumlah tidak valid" : "lokal"}</button><p>Hanya ledger lokal · tanpa transaksi jaringan</p></div>;
}

export function LocalPositions({ ledger, now, onSelect, onReset }: { ledger: PaperLedger; now: number; onSelect: (key: string) => void; onReset: () => void }) {
  const portfolio = paperPortfolio(ledger, now);
  return <section className="terminal-context-section" aria-label="Posisi simulasi lokal"><div className="terminal-section-title"><h2>Posisi simulasi lokal</h2><span className="terminal-badge">BROWSER</span></div>{portfolio.positions.length ? <div className="terminal-local-positions">{portfolio.positions.map((position) => <button key={position.id} type="button" onClick={() => onSelect(position.tokenKey)}><span><strong>{position.symbol}</strong><small>{formatQuantity(position.quantity)} token · biaya {formatUsd(position.costBasisUsd)}</small><small>{position.stale ? "Mark terakhir · tertinggal" : "Mark unit terakhir"} · {position.markQuote ? formatDuration((now - position.markQuote.quotedAt!) / 1000) : "—"}</small></span><span><LiveNumber value={position.pnlUsd} signed width={9}>{formatSignedUsd(position.pnlUsd)}</LiveNumber><small>{formatPercent(position.pnlPct)}</small></span></button>)}</div> : <p className="terminal-context-empty">Belum ada posisi lokal</p>}<div className="terminal-context-footer"><span>Terpisah dari posisi paper server</span><button type="button" onClick={onReset}>Reset lokal</button></div></section>;
}

export function TokenContext({ token }: { token: TokenView | null }) {
  return <section className="terminal-context-section" aria-label="Konteks token"><div className="terminal-section-title"><h2>Konteks token</h2><span>{token?.chain ?? "—"}</span></div>{token && <div className="terminal-context-token"><TokenAvatar token={token} size={26} /><strong>{token.symbol}</strong><span>{sourceLabel(token.provenance)}</span></div>}<p className="terminal-note">Deskripsi token belum tersedia dari sumber saat ini.</p><dl className="terminal-context-changes">{([{ label: "1H", value: token?.change1h }, { label: "4H", value: token?.change4h }, { label: "24H", value: token?.change24h }]).map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd><LiveNumber value={metric.value ?? null} signed width={7}>{formatPercent(metric.value)}</LiveNumber></dd></div>)}</dl><dl className="terminal-context-data"><div><dt>Risk score</dt><dd>{formatCount(token?.riskScore)}</dd></div><div><dt>Rugged</dt><dd>{token?.rugged == null ? "— · belum terverifikasi" : token.rugged ? "Ya · sumber server" : "Tidak · sumber server"}</dd></div><div><dt>Buy / sell activity</dt><dd>—</dd></div></dl>{token?.twitterUrl && <a href={token.twitterUrl} target="_blank" rel="noopener noreferrer" className="terminal-button">X / Twitter <ArrowUpRight size={12} /></a>}<p className="terminal-note">{token?.sources.map(sourceLabel).join(" / ") ?? "Sumber —"}</p></section>;
}

export function OperationalContext({ data, age, onOpen }: { data: StatsResponse | null; age: number | null; onOpen: () => void }) {
  const heartbeat = data?.strategy2Primary?.paper.heartbeatAgeSec;
  return <section className="terminal-context-section" aria-label="Kontrol operasional server"><div className="terminal-section-title"><h2>Kontrol operasional</h2><span className="terminal-badge">SERVER</span></div><dl className="terminal-operational-data"><div><dt>Exec mode</dt><dd>{data?.control?.execMode ?? "—"}</dd></div><div><dt>Strategy 2 heartbeat</dt><dd>{formatDuration(heartbeat == null ? null : heartbeat + (age ?? 0))}</dd></div><div><dt>Paused</dt><dd>{data?.control?.paused == null ? "—" : data.control.paused ? "Ya" : "Tidak"}</dd></div><div><dt>Guardian halted</dt><dd>{data?.guardian?.halted == null ? "—" : data.guardian.halted ? "Ya" : "Tidak"}</dd></div></dl><button type="button" className="terminal-button" onClick={onOpen}>Buka kontrol yang tersedia<ArrowUpRight size={13} /></button><p className="terminal-note">Kondisi server mengikuti snapshot. Kontrol ini terpisah dari simulasi lokal.</p></section>;
}
