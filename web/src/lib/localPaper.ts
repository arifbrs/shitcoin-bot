import { assetIdentity, finite, MAX_QUOTE_AGE_MS, quoteProblem, validTokenIdentity } from "@/lib/terminal";
import type { PaperSide, QuoteView, TokenView } from "@/lib/terminal";

export const PAPER_STORAGE_KEY = "shitcoin:local-paper:v1";
export interface LocalPosition {
  id: string;
  tokenKey: string;
  symbol: string;
  chain: string;
  contract: string;
  quantity: number;
  costBasisUsd: number;
  markQuote: QuoteView | null;
}
export interface PaperFill {
  tokenKey: string;
  symbol: string;
  side: PaperSide;
  amountUsd: number;
  quantity: number;
  priceUsd: number;
  quotedAt: number;
  source: string;
  timestamp: number;
}
export interface PaperLedger {
  version: 1;
  cashUsd: number;
  depositedUsd: number;
  realizedPnlUsd: number;
  positions: LocalPosition[];
  fills: PaperFill[];
}
export type PaperResult = { ok: true; ledger: PaperLedger } | { ok: false; error: string };
export const createPaperLedger = (): PaperLedger => ({ version: 1, cashUsd: 10_000, depositedUsd: 10_000, realizedPnlUsd: 0, positions: [], fills: [] });
const money = (amount: number): number => Math.round((amount + Number.EPSILON) * 100) / 100;
export function parsePaperAmount(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(Math.round(amount * 100)) ? money(amount) : null;
}
export function paperOrderProblem(ledger: PaperLedger, token: TokenView | null, side: PaperSide, amount: string, quote: QuoteView | null, now: number): string | null {
  if (!token) return "Pilih token terlebih dahulu.";
  const value = parsePaperAmount(amount);
  if (value === null) return "Masukkan jumlah USD positif dengan maksimal dua desimal.";
  if (side === "buy" && value > ledger.cashUsd) return "Jumlah melebihi kas virtual.";
  const quoteError = quoteProblem(token, quote, now);
  if (quoteError) return quoteError;
  const quantity = value / quote!.unitPriceUsd!;
  if (!Number.isFinite(quantity) || quantity <= 0) return "Jumlah token tidak dapat dihitung dengan quote ini.";
  const owned = ledger.positions.find((position) => position.tokenKey === token.assetKey)?.quantity ?? 0;
  if (side === "sell" && (owned <= 0 || quantity > owned * (1 + Number.EPSILON * 4))) return "Jumlah melebihi token yang dimiliki di ledger lokal.";
  return null;
}
/** All fills are immutable browser accounting. No network or operational-control dependency. */
export function fillPaperOrder(ledger: PaperLedger, token: TokenView, side: PaperSide, amount: string, quote: QuoteView | null, now: number): PaperResult {
  const error = paperOrderProblem(ledger, token, side, amount, quote, now);
  if (error) return { ok: false, error };
  const amountUsd = parsePaperAmount(amount)!;
  const priceUsd = quote!.unitPriceUsd!;
  const existing = ledger.positions.find((position) => position.tokenKey === token.assetKey);
  const quantity = side === "sell" ? Math.min(amountUsd / priceUsd, existing!.quantity) : amountUsd / priceUsd;
  let positions = ledger.positions.filter((position) => position.tokenKey !== token.assetKey);
  let realizedPnlUsd = ledger.realizedPnlUsd;
  if (side === "buy") {
    const position: LocalPosition = { id: token.assetKey!, tokenKey: token.assetKey!, symbol: token.symbol, chain: token.chain!, contract: token.contract!, quantity: (existing?.quantity ?? 0) + quantity, costBasisUsd: (existing?.costBasisUsd ?? 0) + amountUsd, markQuote: { ...quote! } };
    if (!Number.isFinite(position.quantity) || !Number.isFinite(position.costBasisUsd)) return { ok: false, error: "Jumlah posisi terlalu besar." };
    positions = [...positions, position];
  } else {
    const costSold = existing!.costBasisUsd * (quantity / existing!.quantity);
    realizedPnlUsd += amountUsd - costSold;
    const remaining = existing!.quantity - quantity;
    if (remaining > existing!.quantity * Number.EPSILON * 4) positions = [...positions, { ...existing!, quantity: remaining, costBasisUsd: Math.max(0, existing!.costBasisUsd - costSold), markQuote: { ...quote! } }];
  }
  const cashUsd = money(ledger.cashUsd + (side === "buy" ? -amountUsd : amountUsd));
  if (!Number.isFinite(cashUsd) || cashUsd < 0 || !Number.isFinite(realizedPnlUsd)) return { ok: false, error: "Saldo lokal tidak valid." };
  const fill: PaperFill = { tokenKey: token.assetKey!, symbol: token.symbol, side, amountUsd, quantity, priceUsd, quotedAt: quote!.quotedAt!, source: quote!.source, timestamp: now };
  return { ok: true, ledger: { ...ledger, cashUsd, realizedPnlUsd, positions, fills: [...ledger.fills, fill].slice(-500) } };
}
export function addPaperCash(ledger: PaperLedger, amount: string): PaperResult {
  const value = parsePaperAmount(amount);
  if (value === null || !Number.isSafeInteger(Math.round((ledger.depositedUsd + value) * 100))) return { ok: false, error: "Masukkan jumlah kas virtual yang valid." };
  const cashUsd = money(ledger.cashUsd + value);
  if (!Number.isSafeInteger(Math.round(cashUsd * 100))) return { ok: false, error: "Jumlah kas virtual terlalu besar." };
  return { ok: true, ledger: { ...ledger, cashUsd, depositedUsd: money(ledger.depositedUsd + value) } };
}
function genuineMark(position: LocalPosition, quote: QuoteView | null): boolean {
  return Boolean(quote && quote.kind === "unit-quote" && quote.tokenKey === position.tokenKey && finite(quote.unitPriceUsd) !== null && quote.unitPriceUsd! > 0 && finite(quote.quotedAt) !== null && quote.quotedAt! > 0 && typeof quote.source === "string" && quote.source.trim());
}
export function updatePaperMarks(ledger: PaperLedger, tokens: TokenView[]): PaperLedger {
  let changed = false;
  const positions = ledger.positions.map((position) => {
    const quote = tokens.find((token) => token.assetKey === position.tokenKey)?.quote ?? null;
    if (!genuineMark(position, quote) || (position.markQuote?.quotedAt ?? 0) >= quote!.quotedAt!) return position;
    changed = true;
    return { ...position, markQuote: { ...quote! } };
  });
  return changed ? { ...ledger, positions } : ledger;
}
export function paperPortfolio(ledger: PaperLedger, now: number) {
  let equityUsd: number | null = ledger.cashUsd;
  let stale = false;
  const positions = ledger.positions.map((position) => {
    const mark = genuineMark(position, position.markQuote) ? position.markQuote : null;
    const valueUsd = mark ? finite(position.quantity * mark.unitPriceUsd!) : null;
    const isStale = !mark || now - mark.quotedAt! > MAX_QUOTE_AGE_MS || now < mark.quotedAt!;
    stale ||= isStale;
    equityUsd = valueUsd === null || equityUsd === null ? null : finite(equityUsd + valueUsd);
    const pnlUsd = valueUsd === null ? null : finite(valueUsd - position.costBasisUsd);
    return { ...position, valueUsd, pnlUsd, pnlPct: pnlUsd === null || position.costBasisUsd <= 0 ? null : finite(pnlUsd / position.costBasisUsd * 100), stale: isStale };
  });
  const pnlUsd = equityUsd === null ? null : finite(equityUsd - ledger.depositedUsd);
  return { positions, equityUsd, pnlUsd, pnlPct: pnlUsd === null || ledger.depositedUsd <= 0 ? null : finite(pnlUsd / ledger.depositedUsd * 100), stale };
}
/** Reject corrupted/version-mismatched storage rather than accepting negative cash or positions. */
export function restorePaperLedger(value: unknown): PaperLedger | null {
  if (!value || typeof value !== "object") return null;
  const ledger = value as PaperLedger;
  if (ledger.version !== 1 || finite(ledger.cashUsd) === null || ledger.cashUsd < 0 || !Number.isSafeInteger(Math.round(ledger.cashUsd * 100)) || finite(ledger.depositedUsd) === null || ledger.depositedUsd <= 0 || !Number.isSafeInteger(Math.round(ledger.depositedUsd * 100)) || finite(ledger.realizedPnlUsd) === null || !Array.isArray(ledger.positions) || !Array.isArray(ledger.fills)) return null;
  const keys = new Set<string>();
  for (const position of ledger.positions) {
    if (!position || typeof position.symbol !== "string" || typeof position.chain !== "string" || typeof position.contract !== "string" || !validTokenIdentity({ ...position, assetKey: position.tokenKey }) || position.id !== position.tokenKey || keys.has(position.tokenKey) || finite(position.quantity) === null || position.quantity <= 0 || finite(position.costBasisUsd) === null || position.costBasisUsd < 0 || (position.markQuote !== null && !genuineMark(position, position.markQuote))) return null;
    keys.add(position.tokenKey);
  }
  for (const fill of ledger.fills) {
    if (!fill || typeof fill.tokenKey !== "string" || typeof fill.symbol !== "string" || typeof fill.source !== "string" || !fill.source.trim() || !["buy", "sell"].includes(fill.side) || [fill.amountUsd, fill.quantity, fill.priceUsd, fill.quotedAt, fill.timestamp].some((number) => finite(number) === null || number <= 0)) return null;
  }
  const booked = ledger.cashUsd + ledger.positions.reduce((sum, position) => sum + position.costBasisUsd, 0);
  if (!Number.isFinite(booked) || Math.abs(booked - ledger.depositedUsd - ledger.realizedPnlUsd) > 0.01) return null;
  return { ...ledger, positions: ledger.positions.map((position) => ({ ...position, tokenKey: assetIdentity(position.chain, position.contract)! })), fills: ledger.fills.slice(-500) };
}

/** A saved local position can be inspected, but cannot stand in for a new server quote. */
export function localPositionToken(position: LocalPosition): TokenView {
  const provenance = { lane: "overview" as const, ledgerId: "local-browser", variantId: null, cohortId: null, source: "Mark terakhir · ledger lokal", updatedAt: position.markQuote?.quotedAt ?? null };
  return { key: position.tokenKey, assetKey: position.tokenKey, symbol: position.symbol, name: null, image: null, chain: position.chain, contract: position.contract, provenance, sources: [provenance], categories: [], marketCapUsd: null, change24h: null, change1h: null, change4h: null, volume24hUsd: null, liquidityUsd: null, holders: null, top10Pct: null, riskScore: null, rugged: null, twitterUrl: null, quote: position.markQuote ? { ...position.markQuote, eligible: false, reason: "Token tidak tersedia di sumber saat ini. Menunggu quote server baru." } : null };
}
