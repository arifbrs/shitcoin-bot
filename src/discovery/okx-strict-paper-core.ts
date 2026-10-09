import { createHash } from "node:crypto";
import type { ScoutRow, ScoutVerdict } from "./okx-scout.js";

export type StrictSource = "scanner" | "signal" | "tracker";
export type StrictTerminal =
  | "OPEN"
  | "CLOSED"
  | "REJECTED_RISK"
  | "REJECTED_POLICY"
  | "REJECTED_CAPACITY"
  | "NO_BUY_ROUTE"
  | "NO_SELL_ROUTE_PRECHECK"
  | "BUY_SIM_FAILED"
  | "BUY_SIM_UNAVAILABLE"
  | "DATA_INVALID";

export interface StrictSellProof {
  buildMs: number;
  quotedSolLamports: string;
  minSolLamports: string;
  estimatedFeeLamports: number;
  feeSource: "RPC_MESSAGE" | "OKX_ESTIMATE_FALLBACK";
  priceImpactPercent: number | null;
  routeCount: number;
  roundTripFloorPnlPct: number;
}

export interface StrictEntry {
  detectedAt: number;
  builtAt: number;
  buildMs: number;
  detectToBuildMs: number;
  sizeLamports: string;
  quotedTokenRaw: string;
  minTokenRaw: string;
  tokenDecimals: number;
  priceImpactPercent: number | null;
  minReceiveHaircutPct: number;
  payerCostLamports: number;
  entryOverheadLamports: number;
  entryOverheadPct: number;
  feeLamports: number | null;
  unitsConsumed: number | null;
  txBytes: number;
  txFormat: "versioned" | "legacy";
  /** Conservative, unsigned sell-route proof captured before the virtual position opens. */
  preflightExit: StrictSellProof & {
    /** A second independent build, separated in time, so one transient route cannot open a trade. */
    confirmation: StrictSellProof & {
      confirmedAt: number;
      separationMs: number;
      minReceiveDropPct: number;
    };
  };
}

export interface StrictExit {
  horizonSec: number;
  attemptedAt: number;
  status: "BUILT" | "EXIT_NO_ROUTE" | "EXIT_DATA_INVALID";
  buildMs: number | null;
  quotedSolLamports: string | null;
  minSolLamports: string | null;
  estimatedFeeLamports: number;
  feeSource: "RPC_MESSAGE" | "OKX_ESTIMATE_FALLBACK" | "NO_ROUTE";
  netSolLamports: number;
  pnlLamports: number;
  pnlPct: number;
  priceImpactPercent: number | null;
  simulation: "NOT_APPLICABLE_VIRTUAL_BALANCE";
}

export type StrictScalpTriggerReason = "TAKE_PROFIT" | "HARD_STOP" | "MAX_HOLD" | "ROUTE_LOST";

export type StrictScalpExit = Omit<StrictExit, "horizonSec"> & {
  triggerReason: StrictScalpTriggerReason;
  triggerAt: number;
  triggerPnlPct: number | null;
  executedAt: number;
  executionDelayMs: number;
  triggerToExecutionGapPct: number | null;
};

export interface StrictAdaptiveScalp {
  strategy: "V5_TP5_SL8_T60_EXEC_DELAY" | "V6_FAST_RECHECK_TP5_SL8_T60";
  status: "MONITORING" | "EXITED";
  takeProfitPct: number;
  hardStopPct: number;
  maxHoldMs: number;
  pollMs: number;
  executionDelayMs: number;
  maxConsecutiveNoRoute: number;
  nextCheckAt: number;
  checks: number;
  consecutiveNoRoute: number;
  peakPnlPct: number | null;
  exit: StrictScalpExit | null;
}

export interface StrictPosition {
  /** Entry policy cohort. Never aggregate materially different rules into one result. */
  policyVersion: number;
  paperId: string;
  source: StrictSource;
  sourceKey: string;
  mint: string;
  symbol: string | null;
  wallet: string | null;
  walletType: string | null;
  sourceTs: number | null;
  detectedAt: number;
  riskVerdict: ScoutVerdict["verdict"] | "SOURCE_NATIVE";
  riskReasons: string[];
  /** False means the observation is useful for paper research but may never be mirrored live. */
  liveEligible: boolean;
  status: "OPEN" | "CLOSED";
  entry: StrictEntry;
  /** Prospective decision outcome. Fixed horizons below remain untouched diagnostics. */
  adaptive?: StrictAdaptiveScalp;
  pendingHorizons: number[];
  exits: StrictExit[];
}

export interface CachedScout {
  row: ScoutRow;
  verdict: ScoutVerdict;
  seenAt: number;
}

export interface StrictCandidate {
  /** Captured at discovery so a restart cannot promote an old candidate into a new cohort. */
  policyVersion: number;
  paperId: string;
  source: StrictSource;
  sourceKey: string;
  mint: string;
  symbol: string | null;
  wallet: string | null;
  walletType: string | null;
  sourceTs: number | null;
  detectedAt: number;
  riskVerdict: ScoutVerdict["verdict"] | "SOURCE_NATIVE";
  riskReasons: string[];
  raw: Record<string, unknown>;
}

export interface StrictPaperState {
  version: 2;
  epoch: "OKX-STRICT-PAPER-V2";
  startedAt: string;
  updatedAt: string;
  primed: { scanner: boolean; ranking: boolean; signal: boolean; trackers: string[] };
  budget: { premiumUsed: number; basicUsed: number; premiumPaused: boolean; basicPaused: boolean };
  seen: Record<string, number>;
  /** Transient toplist rows are re-evaluated until their five-minute eligibility window closes. */
  rankingRecheck: Record<string, { at: number; signature: string }>;
  scoutCache: Record<string, CachedScout>;
  pendingCandidates: Record<string, StrictCandidate>;
  positions: Record<string, StrictPosition>;
}

export function newStrictPaperState(): StrictPaperState {
  const now = new Date().toISOString();
  return {
    version: 2,
    epoch: "OKX-STRICT-PAPER-V2",
    startedAt: now,
    updatedAt: now,
    primed: { scanner: false, ranking: false, signal: false, trackers: [] },
    budget: { premiumUsed: 0, basicUsed: 0, premiumPaused: false, basicPaused: false },
    seen: {}, rankingRecheck: {}, scoutCache: {}, pendingCandidates: {}, positions: {},
  };
}

export function strictPaperId(source: StrictSource, sourceKey: string): string {
  return createHash("sha256").update(`${source}:${sourceKey}`).digest("hex").slice(0, 24);
}

export function rawInteger(value: unknown): string | null {
  return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n ? value : null;
}

export function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function strictValueLagPolicy(input: {
  valueUsd: number | null;
  minUsd: number;
  valueLabel: "AMOUNT_USD" | "VALUE_USD";
  sourceTs: number | null;
  detectedAt: number;
  maxLagMs: number;
}): string[] {
  const reasons: string[] = [];
  if (input.valueUsd == null) reasons.push(`${input.valueLabel}_INVALID`);
  else if (input.valueUsd < input.minUsd) reasons.push(`${input.valueLabel}<${input.minUsd}`);
  if (input.sourceTs == null) reasons.push("SOURCE_TIMESTAMP_INVALID");
  else if (input.detectedAt - input.sourceTs > input.maxLagMs) reasons.push(`SOURCE_LAG_MS>${input.maxLagMs}`);
  return reasons;
}

export function strictRankingPolicy(input: {
  firstTradeAt: number | null;
  detectedAt: number;
  maxAgeMs: number;
  liquidityUsd: number | null;
  minLiquidityUsd: number;
  volumeUsd: number | null;
  minVolumeUsd: number;
  marketCapUsd: number | null;
  maxMarketCapUsd: number;
  holders: number | null;
  minHolders: number;
  buys: number | null;
  sells: number | null;
  minTransactions: number;
  minBuyRatio: number;
}): string[] {
  const reasons: string[] = [];
  const ageMs = input.firstTradeAt == null ? null : input.detectedAt - input.firstTradeAt;
  if (ageMs == null || ageMs < 0) reasons.push("FIRST_TRADE_TIME_INVALID");
  else if (ageMs > input.maxAgeMs) reasons.push(`TOKEN_AGE_MS>${input.maxAgeMs}`);
  if (input.liquidityUsd == null) reasons.push("LIQUIDITY_USD_INVALID");
  else if (input.liquidityUsd < input.minLiquidityUsd) reasons.push(`LIQUIDITY_USD<${input.minLiquidityUsd}`);
  if (input.volumeUsd == null) reasons.push("VOLUME_USD_INVALID");
  else if (input.volumeUsd < input.minVolumeUsd) reasons.push(`VOLUME_USD<${input.minVolumeUsd}`);
  if (input.marketCapUsd == null) reasons.push("MARKET_CAP_USD_INVALID");
  else if (input.marketCapUsd > input.maxMarketCapUsd) reasons.push(`MARKET_CAP_USD>${input.maxMarketCapUsd}`);
  if (input.holders == null) reasons.push("HOLDERS_INVALID");
  else if (input.holders < input.minHolders) reasons.push(`HOLDERS<${input.minHolders}`);
  if (input.buys == null || input.sells == null || input.buys < 0 || input.sells < 0) {
    reasons.push("TRANSACTIONS_INVALID");
  } else {
    const transactions = input.buys + input.sells;
    if (transactions < input.minTransactions) reasons.push(`TRANSACTIONS<${input.minTransactions}`);
    else if (transactions === 0 || input.buys / transactions < input.minBuyRatio) reasons.push(`BUY_RATIO<${input.minBuyRatio}`);
  }
  return reasons;
}

export function strictRankingDisposition(reasons: readonly string[], maxAgeMs: number): "ACCEPT" | "RECHECK" | "FINAL" {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("invalid ranking max age");
  if (reasons.length === 0) return "ACCEPT";
  // Age only moves in one direction. Market activity, liquidity, holders and even temporarily
  // missing fields can improve on the next toplist snapshot, so they are never terminal early.
  return reasons.includes(`TOKEN_AGE_MS>${maxAgeMs}`) ? "FINAL" : "RECHECK";
}

export function strictRiskAccepted(verdict: "CLEAN" | "TOXIC" | "UNKNOWN", allowUnknown: boolean): boolean {
  return verdict === "CLEAN" || (allowUnknown && verdict === "UNKNOWN");
}

export function strictScalpDecision(input: {
  pnlPct: number;
  ageMs: number;
  takeProfitPct: number;
  hardStopPct: number;
  maxHoldMs: number;
}): Exclude<StrictScalpTriggerReason, "ROUTE_LOST"> | null {
  if (![input.pnlPct, input.ageMs, input.takeProfitPct, input.hardStopPct, input.maxHoldMs].every(Number.isFinite)) {
    throw new Error("invalid scalp decision input");
  }
  if (input.pnlPct <= input.hardStopPct) return "HARD_STOP";
  if (input.pnlPct >= input.takeProfitPct) return "TAKE_PROFIT";
  if (input.ageMs >= input.maxHoldMs) return "MAX_HOLD";
  return null;
}

export function strictExitMath(entryCostLamports: number, minReceiveLamports: number, estimatedFeeLamports: number): {
  netSolLamports: number; pnlLamports: number; pnlPct: number;
} {
  if (!Number.isSafeInteger(entryCostLamports) || entryCostLamports <= 0) throw new Error("invalid entry cost");
  if (!Number.isSafeInteger(minReceiveLamports) || minReceiveLamports < 0) throw new Error("invalid exit receive");
  if (!Number.isSafeInteger(estimatedFeeLamports) || estimatedFeeLamports < 0) throw new Error("invalid exit fee");
  const netSolLamports = Math.max(0, minReceiveLamports - estimatedFeeLamports);
  const pnlLamports = netSolLamports - entryCostLamports;
  return { netSolLamports, pnlLamports, pnlPct: pnlLamports / entryCostLamports * 100 };
}
