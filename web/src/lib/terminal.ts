import type { DashboardSection } from "@/lib/dashboard";
import type { GmgnOverviewResponse, StatsResponse } from "@/types/stats";

export type PanelState = "loading" | "ready" | "empty" | "error" | "stale";
export type PaperSide = "buy" | "sell";
export type ScannerFilter = "all" | "positions" | "scout" | "market" | "solana";
export interface Provenance {
  lane: DashboardSection;
  ledgerId: string | null;
  variantId: string | null;
  cohortId: string | null;
  source: string;
  updatedAt: number | null;
}
export interface QuoteView {
  tokenKey: string;
  unitPriceUsd: number | null;
  quotedAt: number | null;
  source: string;
  kind: "unit-quote" | "candle-close" | "synthetic";
  eligible: boolean;
  reason: string | null;
}
export interface TokenView {
  key: string;
  assetKey: string | null;
  symbol: string;
  name: string | null;
  image: string | null;
  chain: string | null;
  contract: string | null;
  provenance: Provenance;
  sources: Provenance[];
  categories: Array<"positions" | "scout" | "market">;
  marketCapUsd: number | null;
  change24h: number | null;
  change1h: number | null;
  change4h: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holders: number | null;
  top10Pct: number | null;
  riskScore: number | null;
  rugged: boolean | null;
  twitterUrl: string | null;
  quote: QuoteView | null;
}
export interface ServerPositionView {
  key: string;
  token: TokenView;
  notionalUsd: number | null;
  entryCostUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  markPriceUsd: number | null;
  marketCapUsd: number | null;
  heldSeconds: number | null;
  markAgeSeconds: number | null;
  detectedAt: number | null;
  noManualClose: boolean;
}
export interface ServerTradeView {
  key: string;
  symbol: string;
  provenance: Provenance;
  action: string;
  reason: string | null;
  timestamp: number | null;
  pnlUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  entryPriceUsd: number | null;
  exitPriceUsd: number | null;
  heldSeconds: number | null;
}
export interface ServerSignalView {
  key: string;
  tokenKey: string | null;
  symbol: string;
  provenance: Provenance;
  kind: string;
  timestamp: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  detail: string | null;
}

export const MAX_QUOTE_AGE_MS = 60_000;
export const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
export const timestamp = (value: string | number | null | undefined): number | null => {
  const parsed = typeof value === "string" ? Date.parse(value) : finite(value);
  return parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
export function normalizeChain(chain: string | null | undefined): string | null {
  const key = chain?.trim().toLowerCase();
  if (!key) return null;
  const aliases: Record<string, string> = { sol: "solana", eth: "ethereum", "1": "ethereum", "101": "solana", bnb: "bsc", "56": "bsc", "8453": "base", "4663": "robinhood", "ethereum-l2": "robinhood", arb: "arbitrum", "42161": "arbitrum", "137": "polygon", "10": "optimism" };
  return aliases[key] ?? key;
}
const evmChains = new Set(["ethereum", "robinhood", "base", "bsc", "arbitrum", "polygon", "optimism", "avalanche"]);
export function assetIdentity(chain: string | null, contract: string | null): string | null {
  const normalized = normalizeChain(chain);
  if (!normalized || !contract?.trim()) return null;
  return `${normalized}:${evmChains.has(normalized) ? contract.trim().toLowerCase() : contract.trim()}`;
}
export function validTokenIdentity(token: Pick<TokenView, "chain" | "contract" | "assetKey">): boolean {
  const chain = normalizeChain(token.chain);
  const address = token.contract;
  if (!chain || !address || assetIdentity(chain, address) !== token.assetKey) return false;
  return chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : evmChains.has(chain) && /^0x[0-9a-fA-F]{40}$/.test(address);
}
export function quoteProblem(token: Pick<TokenView, "chain" | "contract" | "assetKey">, quote: QuoteView | null, now: number): string | null {
  if (!quote || quote.kind !== "unit-quote") return "Harga unit belum tersedia. Close candle cache, market cap, dan harga sintetis tidak dipakai untuk order.";
  if (!validTokenIdentity(token) || quote.tokenKey !== token.assetKey) return "Identitas kontrak token belum tersedia atau tidak cocok dengan quote.";
  if (!quote.eligible) return quote.reason ?? "Quote belum layak untuk simulasi lokal.";
  if (finite(quote.unitPriceUsd) === null || quote.unitPriceUsd! <= 0) return "Harga unit harus positif dan finite.";
  if (typeof quote.source !== "string" || !quote.source.trim() || timestamp(quote.quotedAt) === null) return "Sumber atau waktu quote belum terverifikasi.";
  const age = now - quote.quotedAt!;
  if (!Number.isFinite(age) || age < 0 || age > MAX_QUOTE_AGE_MS) return "Quote sudah tertinggal. Menunggu harga unit baru (maksimal 60 detik).";
  return null;
}

const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatUsd(value: unknown, compact = false): string {
  const number = finite(value);
  if (number === null) return "—";
  const absolute = Math.abs(number);
  const text = compact && absolute >= 1e6 ? `${(absolute / 1e6).toFixed(2)}M` : compact && absolute >= 1e3 ? `${(absolute / 1e3).toFixed(1)}K` : usd.format(absolute);
  return `${number < 0 ? "-" : ""}$${text}`;
}
export function formatSignedUsd(value: unknown): string {
  const number = finite(value);
  return number === null ? "—" : `${number >= 0 ? "+" : "-"}${formatUsd(Math.abs(number))}`;
}
export function formatPercent(value: unknown): string {
  const number = finite(value);
  return number === null ? "—" : `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}
export function formatPrice(value: unknown): string {
  const number = finite(value);
  if (number === null) return "—";
  if (number === 0) return "$0.00";
  const decimals = Math.min(18, Math.max(2, 3 - Math.floor(Math.log10(Math.abs(number)))));
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: decimals })}`;
}
export function formatCount(value: unknown): string {
  const number = finite(value);
  return number === null ? "—" : number.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
export function formatQuantity(value: unknown): string {
  const number = finite(value);
  if (number === null) return "—";
  const decimals = number === 0 ? 0 : Math.min(18, Math.max(6, 3 - Math.floor(Math.log10(Math.abs(number)))));
  return number.toLocaleString("en-US", { maximumFractionDigits: decimals });
}
export function formatDuration(value: unknown): string {
  const number = finite(value);
  if (number === null) return "—";
  const seconds = Math.max(0, Math.floor(number));
  return seconds < 60 ? `${seconds} dtk` : seconds < 3600 ? `${Math.floor(seconds / 60)} mnt` : `${Math.floor(seconds / 3600)} jam`;
}
export function formatUtc(value: unknown): string {
  const number = finite(value);
  return number === null || !Number.isFinite(new Date(number).getTime()) ? "—" : `${new Date(number).toISOString().slice(11, 19)} UTC`;
}
export const numericTone = (value: unknown): string => finite(value) === null || value === 0 ? "" : Number(value) > 0 ? "terminal-gain" : "terminal-loss";
export function sourceLabel(provenance: Provenance): string {
  return [provenance.source, provenance.variantId, provenance.cohortId].filter(Boolean).join(" · ");
}
function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function provenance(lane: DashboardSection, source: string, updatedAt: number | null, ledgerId: string | null = null, variantId: string | null = null, cohortId: string | null = null): Provenance {
  return { lane, source, updatedAt, ledgerId, variantId, cohortId };
}
function tokenView(symbol: string, chain: string | null, contract: string | null, origin: Provenance, category: TokenView["categories"][number], fallback = ""): TokenView {
  const normalized = normalizeChain(chain);
  const address = contract?.trim() || null;
  const assetKey = assetIdentity(normalized, address);
  const key = assetKey ?? ["symbol", origin.lane, origin.ledgerId, origin.variantId, origin.cohortId, symbol, fallback].map((part) => encodeURIComponent(part ?? "")).join(":");
  return { key, assetKey, symbol: symbol || "—", name: null, image: null, chain: normalized, contract: address, provenance: origin, sources: [origin], categories: [category], marketCapUsd: null, change24h: null, change1h: null, change4h: null, volume24hUsd: null, liquidityUsd: null, holders: null, top10Pct: null, riskScore: null, rugged: null, twitterUrl: null, quote: null };
}

/** Presentation only: never rewrites or combines server accounting. S2 summaries overlap. */
export function serverPositions(data: Partial<StatsResponse> | null): ServerPositionView[] {
  if (!data) return [];
  const rows: ServerPositionView[] = [];
  const snapshot = timestamp(data.now);
  const s2Mints = new Set<string>();
  for (const position of data.strategy2Primary?.paper?.openPositions ?? []) {
    s2Mints.add(position.mint);
    const token = tokenView(position.symbol, "solana", position.mint, provenance("solana", "Strategy 2", snapshot, "strategy2"), "positions");
    token.image = safeUrl(position.img ?? position.image);
    token.marketCapUsd = finite(position.marketCap);
    token.holders = finite(position.holders);
    token.quote = { tokenKey: token.assetKey ?? token.key, unitPriceUsd: null, quotedAt: null, source: "Strategy 2 · harga sintetis", kind: "synthetic", eligible: false, reason: "Harga Strategy 2 sintetis, bukan harga unit token." };
    const sameLedger = data.strategy2Paper?.openPositions?.find((row) => row.mint === position.mint);
    rows.push({ key: `strategy2:${token.key}`, token, notionalUsd: null, entryCostUsd: finite(position.entryCostUsd) ?? finite(sameLedger?.entryCostUsd), pnlUsd: null, pnlPct: finite(position.unrealizedPnl), markPriceUsd: null, marketCapUsd: token.marketCapUsd, heldSeconds: finite(position.heldSec), markAgeSeconds: null, detectedAt: null, noManualClose: true });
  }
  for (const position of data.strategy2Paper?.openPositions ?? []) {
    if (s2Mints.has(position.mint)) continue;
    const token = tokenView(position.sym, "solana", position.mint, provenance("solana", "Strategy 2", snapshot, "strategy2"), "positions");
    token.marketCapUsd = finite(position.mcUsd);
    token.holders = finite(position.holders);
    rows.push({ key: `strategy2:${token.key}`, token, notionalUsd: null, entryCostUsd: finite(position.entryCostUsd), pnlUsd: null, pnlPct: finite(position.unrealizedPct), markPriceUsd: null, marketCapUsd: token.marketCapUsd, heldSeconds: finite(position.heldHours) === null ? null : position.heldHours * 3600, markAgeSeconds: null, detectedAt: null, noManualClose: true });
  }
  for (const variant of data.laneRobinhood?.variants ?? []) {
    const occurrences = new Map<string, number>();
    for (const position of variant.positions ?? []) {
      const occurrence = occurrences.get(position.symbol) ?? 0;
      occurrences.set(position.symbol, occurrence + 1);
      const origin = provenance("robinhood", "Robinhood", timestamp(data.laneRobinhood?.updatedAt), `robinhood:${variant.id}`, variant.id, variant.cohort);
      const token = tokenView(position.symbol, "robinhood", null, origin, "positions", String(occurrence));
      const markAge = finite(position.markAgeSec);
      token.quote = { tokenKey: token.key, unitPriceUsd: finite(position.lastPrice), quotedAt: snapshot !== null && markAge !== null ? snapshot - markAge * 1000 : null, source: `Robinhood · ${variant.id} · mark`, kind: "unit-quote", eligible: false, reason: "Robinhood menyediakan simbol dan mark, tanpa alamat token. Identitas kontrak belum tersedia." };
      rows.push({ key: token.key, token, notionalUsd: finite(position.notionalUsd), entryCostUsd: null, pnlUsd: null, pnlPct: null, markPriceUsd: finite(position.lastPrice), marketCapUsd: null, heldSeconds: null, markAgeSeconds: markAge, detectedAt: null, noManualClose: true });
    }
  }
  for (const position of data.laneOkxPaper?.open ?? []) {
    const policy = finite(position.policyVersion);
    const token = tokenView(position.symbol, null, null, provenance("overview", `OKX paper${position.source ? ` · ${position.source}` : ""}${policy === null ? "" : ` · policy ${policy}`}`, timestamp(data.laneOkxPaper?.updatedAt), "okx-paper"), "positions", position.id);
    rows.push({ key: `okx:${position.id}`, token, notionalUsd: null, entryCostUsd: null, pnlUsd: null, pnlPct: null, markPriceUsd: null, marketCapUsd: null, heldSeconds: null, markAgeSeconds: null, detectedAt: timestamp(position.detectedAt), noManualClose: true });
  }
  return rows;
}

export function terminalTokens(data: Partial<StatsResponse> | null): TokenView[] {
  if (!data) return [];
  const tokens = new Map<string, TokenView>();
  const add = (token: TokenView) => {
    const existing = tokens.get(token.key);
    if (!existing) { tokens.set(token.key, token); return; }
    const metricFields = ["marketCapUsd", "change24h", "change1h", "change4h", "volume24hUsd", "liquidityUsd", "holders", "top10Pct", "riskScore"] as const;
    for (const field of metricFields) if (existing[field] === null && token[field] !== null) existing[field] = token[field];
    existing.image ??= token.image;
    existing.name ??= token.name;
    existing.rugged ??= token.rugged;
    existing.twitterUrl ??= token.twitterUrl;
    existing.quote ??= token.quote;
    existing.sources.push(...token.sources.filter((source) => !existing.sources.some((old) => sourceLabel(old) === sourceLabel(source) && old.ledgerId === source.ledgerId)));
    existing.categories = [...new Set([...existing.categories, ...token.categories])];
  };
  for (const candidate of data.strategy2?.candidates ?? []) {
    const token = tokenView(candidate.sym, "solana", candidate.mint, provenance("solana", `Scout · ${candidate.source || "strategy2-candidate"}`, timestamp(candidate.ts)), "scout");
    Object.assign(token, { image: safeUrl(candidate.img), marketCapUsd: finite(candidate.mcUsd), liquidityUsd: finite(candidate.liqUsd), holders: finite(candidate.holders), change1h: finite(candidate.change1h), change4h: finite(candidate.change4h), change24h: finite(candidate.change24h), riskScore: finite(candidate.riskScore), rugged: typeof candidate.rugged === "boolean" ? candidate.rugged : null, twitterUrl: safeUrl(candidate.twitterUrl) });
    add(token);
  }
  const snapshot = timestamp(data.now);
  const marketAge = finite(data.market?.ageMs);
  for (const coin of [...(data.market?.top ?? []), ...(data.market?.new ?? [])]) {
    const token = tokenView(coin.symbol, "solana", coin.mint, provenance("solana", "Pasar · pump.fun", snapshot !== null && marketAge !== null ? snapshot - marketAge : null), "market");
    token.image = safeUrl(coin.img);
    token.marketCapUsd = finite(coin.mcUsd);
    add(token);
  }
  for (const coin of [...(data.laneDex?.movers ?? []), ...(data.laneDex?.promotions ?? [])]) {
    const token = tokenView(coin.symbol || (coin.token ? `${coin.token.slice(0, 6)}…` : "—"), coin.chain, coin.token, provenance("dex", "DexScreener", timestamp(data.laneDex?.updatedAt)), "market");
    token.change24h = finite(coin.chg24);
    token.volume24hUsd = finite(coin.vol24);
    token.liquidityUsd = finite(coin.liqUsd);
    add(token);
  }
  for (const position of serverPositions(data)) add(position.token);
  return [...tokens.values()];
}

export function filterTokens(tokens: TokenView[], query: string, filter: ScannerFilter): TokenView[] {
  const search = query.trim().toLowerCase();
  return tokens.filter((token) => (filter === "all" || (filter === "solana" ? token.chain === "solana" : token.categories.includes(filter))) && [token.symbol, token.name, token.contract, token.chain, ...token.sources.flatMap((source) => [source.lane, source.source, source.variantId, source.cohortId, source.ledgerId])].some((text) => text?.toLowerCase().includes(search)));
}

export function serverTrades(data: Partial<StatsResponse> | null): ServerTradeView[] {
  if (!data) return [];
  const rows: ServerTradeView[] = [];
  const occurrences = new Map<string, number>();
  const rowKey = (key: string) => {
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return `${key}:${occurrence}`;
  };
  for (const trade of data.strategy2Primary?.recentTrades ?? []) {
    rows.push({ key: rowKey(`s2:${trade.ts}:${trade.symbol}`), symbol: trade.symbol, provenance: provenance("solana", "Strategy 2", timestamp(trade.ts), "strategy2"), action: "Tutup", reason: trade.reason ?? null, timestamp: timestamp(trade.ts), pnlUsd: finite(trade.pnlUsd), pnlSol: null, pnlPct: finite(trade.pnlPct), entryPriceUsd: null, exitPriceUsd: null, heldSeconds: finite(trade.heldHours) === null ? null : trade.heldHours * 3600 });
  }
  for (const trade of data.laneRobinhood?.recent ?? []) {
    const cohort = data.laneRobinhood?.variants?.find((variant) => variant.id === trade.variant)?.cohort ?? null;
    rows.push({ key: rowKey(`rh:${trade.ts}:${trade.variant}:${trade.symbol}:${trade.action}`), symbol: trade.symbol, provenance: provenance("robinhood", "Robinhood", timestamp(trade.ts), `robinhood:${trade.variant}`, trade.variant, cohort), action: trade.action === "RH_OPEN" ? "Buka" : trade.action === "RH_CLOSE" ? "Tutup" : trade.action, reason: trade.reason, timestamp: timestamp(trade.ts), pnlUsd: finite(trade.pnlUsd), pnlSol: null, pnlPct: finite(trade.pnlPct), entryPriceUsd: finite(trade.entryPriceUsd), exitPriceUsd: finite(trade.exitPriceUsd), heldSeconds: null });
  }
  for (const trade of data.laneOkxPaper?.recentCloses ?? []) {
    rows.push({ key: rowKey(`okx:${trade.ts}:${trade.symbol}:${trade.trigger ?? ""}`), symbol: trade.symbol, provenance: provenance("overview", "OKX paper", timestamp(trade.ts), "okx-paper"), action: "Tutup", reason: trade.trigger, timestamp: timestamp(trade.ts), pnlUsd: null, pnlSol: finite(trade.pnlSol), pnlPct: null, entryPriceUsd: null, exitPriceUsd: null, heldSeconds: null });
  }
  return rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export function serverSignals(data: Partial<StatsResponse> | null, gmgn: GmgnOverviewResponse | null): ServerSignalView[] {
  const rows: ServerSignalView[] = (data?.strategy2?.candidates ?? []).map((candidate) => ({ key: `scout:${candidate.mint}:${candidate.ts}`, tokenKey: assetIdentity("solana", candidate.mint), symbol: candidate.sym, provenance: provenance("solana", `Scout · ${candidate.source}`, timestamp(candidate.ts)), kind: "Kandidat", timestamp: timestamp(candidate.ts), marketCapUsd: finite(candidate.mcUsd), holders: finite(candidate.holders), detail: candidate.strategyTag || null }));
  for (const [index, signal] of (gmgn?.recentSignals ?? []).entries()) rows.push({ key: `gmgn:${signal.ts}:${signal.sym}:${index}`, tokenKey: null, symbol: signal.sym, provenance: provenance("gmgn", "GMGN", timestamp(signal.ts)), kind: signal.signalType === 12 ? "Smart-money buy" : signal.signalType === 20 ? "KOL buy" : `Sinyal ${signal.signalType}`, timestamp: timestamp(signal.ts), marketCapUsd: finite(signal.mcUsd), holders: finite(signal.holders), detail: null });
  return rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}
