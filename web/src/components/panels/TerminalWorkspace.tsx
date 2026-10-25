import { useState } from "react";
import { Copy, ListFilter, MoreHorizontal } from "lucide-react";
import { LiveNumber, TokenAvatar } from "@/components/panels/TerminalPrimitives";
import { TerminalChart } from "@/components/panels/TerminalChart";
import { formatCount, formatPercent, formatPrice, formatUsd, quoteProblem, sourceLabel } from "@/lib/terminal";
import type { QuoteView, TokenView } from "@/lib/terminal";

export function TerminalWorkspace({ token, quote, now, onScanner, onContext }: {
  token: TokenView | null;
  quote: QuoteView | null;
  now: number;
  onScanner: () => void;
  onContext: () => void;
}) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const eligible = token && quoteProblem(token, quote, now) === null;
  const price = eligible ? quote!.unitPriceUsd : null;
  const metrics = [
    { label: "Market cap", value: token?.marketCapUsd ?? null, text: formatUsd(token?.marketCapUsd, true) },
    { label: "Harga unit live", value: price, text: formatPrice(price) },
    { label: "Perubahan 24h", value: token?.change24h ?? null, text: formatPercent(token?.change24h), signed: true },
    { label: "Volume 24h", value: token?.volume24hUsd ?? null, text: formatUsd(token?.volume24hUsd, true) },
    { label: "Likuiditas", value: token?.liquidityUsd ?? null, text: formatUsd(token?.liquidityUsd, true) },
    { label: "Holders", value: token?.holders ?? null, text: formatCount(token?.holders) },
    { label: "Top 10", value: token?.top10Pct ?? null, text: token?.top10Pct == null ? "—" : `${formatCount(token.top10Pct)}%` },
  ];
  const metricCell = (metric: typeof metrics[number]) => <div key={metric.label} className="terminal-stat"><dt>{metric.label}</dt><dd><LiveNumber value={metric.value} signed={metric.signed} width={7}>{metric.text}</LiveNumber></dd></div>;
  const copy = async () => {
    if (!token?.contract) return;
    try { await navigator.clipboard.writeText(token.contract); setCopyMessage("Alamat kontrak disalin."); }
    catch { setCopyMessage("Alamat belum disalin. Pilih dan salin alamat kontrak yang terlihat."); }
  };
  return <>
    <section className="terminal-token-header" aria-label="Token terpilih">
      <TokenAvatar token={token ?? { symbol: "—", image: null }} size={44} />
      <div className="terminal-token-heading"><div><h1>{token?.name ?? token?.symbol ?? "Pilih token"}</h1>{token?.name && <span>{token.symbol}</span>}<span className="terminal-badge">{token?.chain ?? "—"}</span></div><p><span className="terminal-contract" title={token?.contract ?? undefined}>{token?.contract ?? "Kontrak —"}</span>{token?.contract && <button type="button" className="terminal-icon" aria-label={`Salin alamat kontrak ${token.symbol}`} onClick={() => void copy()}><Copy size={13} /></button>}</p><small title={token?.sources.map(sourceLabel).join(" / ")}>{token ? sourceLabel(token.provenance) : "Token, lane, varian, dan kohort dari sumber server"}</small></div>
      <button type="button" className="terminal-icon terminal-workspace-scanner" aria-label="Buka scanner token" onClick={onScanner}><ListFilter size={17} /></button><button type="button" className="terminal-icon terminal-context-action" aria-label="Konteks dan tautan token" onClick={onContext}><MoreHorizontal size={18} /></button>
    </section>
    {copyMessage && <p key={token?.key} className="terminal-inline-note" role="status">{copyMessage}</p>}
    <dl className="terminal-stats">{metrics.slice(0, 5).map(metricCell)}<div className="terminal-stat-pair">{metrics.slice(5).map(metricCell)}</div></dl>
    <TerminalChart token={token} now={now} />
  </>;
}
