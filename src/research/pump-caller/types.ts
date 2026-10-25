/**
 * LANE RISET PUMP CALLER — tipe domain (FINAL). Zero-capital, read-only.
 * Semua entitas bawa: sumber, timestamp, identitas (mint/wallet/signature-dedupe-key),
 * dan status ketersediaan data — tidak ada nilai karangan.
 */
export const PUMP_CALLER_SCHEMA = "pump-caller-v1";

export interface SourceStamp { source: "pumpfun-developer-api" | "swap-api" | "pumpportal" | "fixture" | "manual"; observedAt: number; fetchedAt: number }

// ── Adapter Pump.fun Developer API ──────────────────────────────────────────
export interface HomeFeedItem { coin: string; mint?: string; name?: string; symbol?: string; usdMarketCap?: number; description?: string; image?: string; createdBy?: string; createdAt?: number }
export interface Callout { calloutId: string; coin?: string; mint?: string; userId?: string; username?: string; text?: string; timestamp?: number }
export interface UserPosition { userId: string; mint: string; tokenAmount?: number; usdPosition?: number; solPosition?: number; realizedPnl?: number; unrealizedPnl?: number; avgCostSolPerToken?: number }
export interface UserTrade { id: string; userId?: string; mint: string; side?: "buy" | "sell"; solAmount?: number; tokenAmount?: number; timestamp?: number; signature?: string }
export interface MintPosition { mint: string; userId: string; tokenAmount?: number; usdPosition?: number; realizedPnl?: number; unrealizedPnl?: number }

export type ApiResult<T> = { ok: true; data: T; stamp: SourceStamp } | { ok: false; reason: string; blockedExternal: boolean };

// ── Perilaku pasar (tape) ────────────────────────────────────────────────────
export interface TradeEvent {
  dedupeKey: string; // identitas instruksional terbaik yang tersedia (signature bila ada)
  mint: string; wallet?: string; side: "buy" | "sell";
  sol: number; usd: number | null; ts: number; // ts = epoch ms sumber
}

export interface Candle { ts: number; open: number; high: number; low: number; close: number; volumeSol: number }
export type CandleInterval = "1s" | "1m";

// ── Caller & posisi ──────────────────────────────────────────────────────────
export type PositionState = "HOLDING" | "ADDING" | "PARTIAL_SELL" | "EXITED" | "UNKNOWN";

export interface CallerEvent {
  dedupeKey: string; mint: string; callerId: string;
  kind: "buy" | "sell" | "transfer";
  sol: number | null; tokenAmount: number | null; ts: number;
  balanceAfter?: number | null; // saldo teramati (bukan estimasi eksposur)
}

export interface CallerPosition {
  callerId: string; mint: string; state: PositionState;
  observedBuysSol: number; observedSellsSol: number;
  observedTokenBalance: number | null; // saldo teramati TERAKHIR (bukan eksposur awal)
  lastEventTs: number | null; eventCount: number;
  realizedPnlEstimateSol: number | null; // hanya bila sumber menyediakan (mis. user-positions)
  unrealizedPnlEstimateSol: number | null;
  evidence: "wallet-activity" | "provider-position" | "insufficient";
  note: string;
}

// ── Analitik ─────────────────────────────────────────────────────────────────
export interface AbsorptionParams { largeBuyUsd: number[]; smallSellUsdMin: number; smallSellUsdMax: number; largeByLiquidityShare: number }
export const DEFAULT_ABSORPTION: AbsorptionParams = { largeBuyUsd: [500, 1000], smallSellUsdMin: 5, smallSellUsdMax: 100, largeByLiquidityShare: 0.02 };

export interface AbsorptionView {
  largeBuys: Array<{ usd: number | null; sol: number; ts: number; wallet?: string }>;
  smallSells: number; smallSellUsdTotal: number | null;
  totalBuySol: number; totalSellSol: number; netFlowSol: number;
  uniqueBuyers: number; repeatBuyers: number; largeSellerExits: number;
  washSuspicion: { bothSidesPct: number; note: string };
  priceResponseAfterLargeBuy: { candleWindow: string; movePct: number | null } | null;
  followersFollow: boolean | null; // pembeli independen menyusul (bukan pembeli awal cepat jual)
  initialBuyerRapidSold: boolean | null;
}

// ── Wick & kebijakan konfirmasi ──────────────────────────────────────────────
export type EntryPolicy = "IMMEDIATE_OBSERVED_ENTRY" | "CONFIRM_AFTER_4X_1S_CANDLES" | "CONFIRM_AFTER_4X_1M_CANDLES" | "PULLBACK_WITH_BUYER_RECOVERY";

export interface WickContext { candle: Candle; upperWickPct: number; lowerWickPct: number; closeLocation: number; retracementFromHighPct: number; higherLow: boolean | null; buyerFollowThrough: boolean | null; volumeSol: number }

export interface PolicyEvaluation { policy: EntryPolicy; triggered: boolean; triggerTs: number | null; entryPrice: number | null; requiredCandles: number; observedCandles: number; rejectReason: string | null }

// ── Deteksi dini ─────────────────────────────────────────────────────────────
export interface EarlyTimeline { mint: string; createdAt: number | null; callerBuyTs: number | null; calloutPublishedTs: number | null; firstObservedByBot: number; firstExecutableQuoteTs: number | null; callerFollowersAtBuy: number | null }
export interface LatencyView { detectionLagMs: number | null; calloutLagMs: number | null; executableLagMs: number | null; note: string }

// ── Analis bayangan ──────────────────────────────────────────────────────────
export type ShadowDecision = "SKIP" | "WATCH" | "PAPER_ENTRY";
export interface AnalystInput {
  mint: string; ts: number;
  caller?: CallerPosition | null;
  absorption?: AbsorptionView | null;
  wick?: WickContext | null;
  early?: LatencyView | null;
  liquidityUsd?: number | null;
}
export interface AnalystOutput {
  decision: ShadowDecision; decidedAt: number; strategyVersion: string;
  reasons: string[]; contraryEvidence: string[]; missingData: string[];
  paperNotionalUsd: number | null; // 3 / 5 utk riset biaya; null utk SKIP
  executionCostWarning: string | null;
}

// ── Eksperimen prospektif ────────────────────────────────────────────────────
export const OUTCOME_HORIZONS_MIN = [1, 5, 15, 60, 360, 1440, 2880] as const;
export interface OutcomeMark { decisionId: string; horizonMin: number; targetAt: number; checkedAt: number; status: "OBSERVED" | "MISSING"; reason?: string; priceAtDecision: number; priceAtTarget: number | null; changePct: number | null }
