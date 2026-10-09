import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { config, configHash } from "./config.js";
import {
  okxCall, okxChainIndex, okxCredentialWarnings, okxEnabled,
  type OkxCallResult, type OkxMemeToken, type OkxRankedToken, type OkxSignal, type OkxWalletDexHistory,
  type OkxWalletDexTransaction,
} from "./discovery/okx.js";
import { okxRadarSelect } from "./discovery/okx-radar.js";
import { scoutVerdict, toScoutRow } from "./discovery/okx-scout.js";
import { classifyLaunch } from "./discovery/setup-filter.js";
import {
  finiteNumber, newStrictPaperState, rawInteger, strictExitMath, strictPaperId, strictRankingPolicy,
  strictRankingDisposition, strictScalpDecision,
  strictRiskAccepted, strictValueLagPolicy,
  type StrictCandidate, type StrictExit, type StrictPaperState, type StrictPosition, type StrictScalpExit,
  type StrictSellProof, type StrictSource,
} from "./discovery/okx-strict-paper-core.js";
import { OKX_STRICT_EPOCH, StrictLedger } from "./discovery/okx-strict-ledger.js";
import { OKX_NATIVE_SOL, okxSwapTx, type OkxSwapTransactionBuild } from "./execution/okx.js";
import { poolBalanceSol, poolSimulateUnsigned, poolUnsignedTransactionFee } from "./execution/rpc.js";
import { ui } from "./util/log.js";

/**
 * OKX STRICT PAPER V2
 *
 * This process imports no wallet, signer, executor or broadcaster. It asks OKX for the same
 * unsigned transaction used by Quick Buy, simulates the buy against current mainnet state, then
 * uses the quote's minimum-receive amount for fixed-horizon virtual exits. Nothing is signed and
 * nothing can be submitted from this dependency graph.
 */

const envNum = (name: string, fallback: number, min: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const envRange = (name: string, fallback: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const STATE_PATH = join(config.logDir, "okx-strict-paper-v2-state.json");
const LOCK_PATH = join(config.logDir, "okx-strict-paper.lock");

const SCAN_MS = envNum("OKX_PAPER_SCAN_MS", 10_000, 2_000);
// Free/basic toplist is allowed at 5 RPS. v6 deliberately uses only 0.2 RPS (one call/5s),
// fast enough for REST paper evidence while the local monthly-budget cap prevents quota runaway.
const RANKING_MS = envNum("OKX_PAPER_RANKING_MS", 5_000, 1_000);
const RANKING_RECHECK_MS = envNum("OKX_PAPER_RANKING_RECHECK_MS", 5_000, 1_000);
const RANKING_MAX_ACCEPT_PER_PASS = Math.floor(envNum("OKX_PAPER_RANKING_MAX_ACCEPT_PER_PASS", 3, 1));
const SIGNAL_MS = envNum("OKX_PAPER_SIGNAL_MS", 30_000, 10_000);
const TRACKER_MS = envNum("OKX_PAPER_TRACKER_MS", 60_000, 15_000);
// 0.03 SOL repeatedly measured 20-28% entry overhead because fixed account/route costs dominate.
// 0.10 SOL keeps fixed account/route costs measurable; v6 rejects anything above its tighter cap.
const SIZE_SOL = envNum("OKX_PAPER_SIZE_SOL", 0.10, 0.001);
const SIZE_LAMPORTS = String(Math.round(SIZE_SOL * 1e9));
const HORIZONS = (process.env.OKX_PAPER_HORIZONS_SEC ?? "60,300,900,2700")
  .split(",").map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0)
  .sort((a, b) => a - b);
const PRIMARY_EXIT_HORIZON_SEC = Math.floor(envNum("OKX_PAPER_PRIMARY_EXIT_HORIZON_SEC", 60, 1));
const MAX_OPEN = Math.floor(envNum("OKX_PAPER_MAX_OPEN", 500, 1));
const PREMIUM_BUDGET = Math.floor(envNum("OKX_PAPER_PREMIUM_BUDGET_CALLS", 10_000, 1));
const BASIC_BUDGET = Math.floor(envNum("OKX_PAPER_BASIC_BUDGET_CALLS", 25_000, 1));
const TRACKER_WALLETS = Math.min(20, Math.floor(envNum("OKX_PAPER_TRACKER_WALLETS", 5, 0)));
const SIGNAL_MIN_WALLETS = Math.floor(envNum("OKX_PAPER_SIGNAL_MIN_WALLETS", 2, 1));
const SIGNAL_MIN_USD = envNum("OKX_PAPER_SIGNAL_MIN_USD", 500, 0);
const TRACKER_MIN_USD = envNum("OKX_PAPER_TRACKER_MIN_USD", 100, 0);
const MAX_SOURCE_LAG_MS = envNum("OKX_PAPER_MAX_SOURCE_LAG_MS", 90_000, 1_000);
const PAPER_POLICY_VERSION = 6;
const RANKING_MAX_AGE_MS = envNum("OKX_PAPER_RANKING_MAX_AGE_MS", 5 * 60_000, 30_000);
const RANKING_MIN_LIQUIDITY_USD = envNum("OKX_PAPER_RANKING_MIN_LIQUIDITY_USD", 20_000, 0);
const RANKING_MIN_VOLUME_USD = envNum("OKX_PAPER_RANKING_MIN_VOLUME_USD", 20_000, 0);
const RANKING_MAX_MARKET_CAP_USD = envNum("OKX_PAPER_RANKING_MAX_MARKET_CAP_USD", 250_000, 1);
const RANKING_MIN_HOLDERS = Math.floor(envNum("OKX_PAPER_RANKING_MIN_HOLDERS", 100, 0));
const RANKING_MIN_TRANSACTIONS = Math.floor(envNum("OKX_PAPER_RANKING_MIN_TRANSACTIONS", 100, 0));
const RANKING_MIN_BUY_RATIO = Math.min(1, envNum("OKX_PAPER_RANKING_MIN_BUY_RATIO", 0.6, 0));
const RANKING_WARM_START_MAX = Math.floor(envNum("OKX_PAPER_RANKING_WARM_START_MAX", 8, 0));
const MAX_PRICE_IMPACT_PERCENT = envNum("OKX_PAPER_MAX_PRICE_IMPACT_PERCENT", 5, 0);
const MAX_ENTRY_OVERHEAD_PCT = envNum("OKX_PAPER_MAX_ENTRY_OVERHEAD_PCT", 7, 0);
const MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT = envRange("OKX_PAPER_MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT", -12, -100, 0);
const SELL_CONFIRM_MS = envNum("OKX_PAPER_SELL_CONFIRM_MS", 1_500, 250);
const MAX_SELL_PROOF_DROP_PCT = envRange("OKX_PAPER_MAX_SELL_PROOF_DROP_PCT", 3, 0, 100);
const MAX_DETECT_TO_BUILD_MS = envNum("OKX_PAPER_MAX_DETECT_TO_BUILD_MS", 15_000, 500);
const WORKER_CONCURRENCY = Math.min(3, Math.floor(envNum("OKX_PAPER_WORKERS", 3, 1)));
const ALLOW_UNKNOWN_RISK = process.env.OKX_PAPER_ALLOW_UNKNOWN_RISK === "true";
const OBSERVE_UNKNOWN_RANKING = process.env.OKX_PAPER_OBSERVE_UNKNOWN_RANKING !== "false";
const EXIT_FEE_FLOOR_LAMPORTS = Math.floor(envNum("OKX_PAPER_EXIT_FEE_FLOOR_LAMPORTS", 20_000, 5_000));
const MAX_ENTRY_OVERHEAD_LAMPORTS = Math.floor(envNum("OKX_PAPER_MAX_ENTRY_OVERHEAD_LAMPORTS", 10_000_000, 100_000));
const SCALP_POLL_MS = envNum("OKX_PAPER_SCALP_POLL_MS", 5_000, 1_000);
const SCALP_TAKE_PROFIT_PCT = envNum("OKX_PAPER_SCALP_TAKE_PROFIT_PCT", 5, 0);
const SCALP_HARD_STOP_PCT = envRange("OKX_PAPER_SCALP_HARD_STOP_PCT", -8, -100, 0);
const SCALP_MAX_HOLD_MS = envNum("OKX_PAPER_SCALP_MAX_HOLD_SEC", 60, 5) * 1_000;
const SCALP_EXECUTION_DELAY_MS = envNum("OKX_PAPER_EXECUTION_DELAY_MS", 1_500, 0);
const SCALP_MAX_NO_ROUTE = Math.floor(envNum("OKX_PAPER_SCALP_MAX_NO_ROUTE", 3, 1));
const SCALP_NO_ROUTE_RETRY_MS = envNum("OKX_PAPER_SCALP_NO_ROUTE_RETRY_MS", 1_000, 250);
const PAYMENT_BACKOFF_MS = envNum("OKX_PAPER_PAYMENT_BACKOFF_MS", 15 * 60_000, 60_000);
const PAPER_WALLET = process.env.OKX_PAPER_WALLET?.trim()
  || process.env.OKX_PROBE_WALLET?.trim()
  || "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

mkdirSync(config.logDir, { recursive: true });

function loadState(): StrictPaperState {
  if (!existsSync(STATE_PATH)) return newStrictPaperState();
  const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<StrictPaperState>;
  if (parsed.version !== 2 || parsed.epoch !== OKX_STRICT_EPOCH) throw new Error("strict paper state has the wrong version/epoch");
  return {
    ...(parsed as StrictPaperState),
    primed: { scanner: false, ranking: false, signal: false, trackers: [], ...parsed.primed },
    budget: { premiumUsed: 0, basicUsed: 0, premiumPaused: false, basicPaused: false, ...parsed.budget },
    seen: parsed.seen ?? {}, rankingRecheck: parsed.rankingRecheck ?? {}, scoutCache: parsed.scoutCache ?? {},
    pendingCandidates: parsed.pendingCandidates ?? {}, positions: parsed.positions ?? {},
  };
}

let state = loadState();
let normalizedLegacyPosition = false;
for (const position of Object.values(state.positions)) {
  if (!Number.isInteger(position.policyVersion) || position.policyVersion < 1) {
    position.policyVersion = 3;
    normalizedLegacyPosition = true;
  }
}
for (const candidate of Object.values(state.pendingCandidates)) {
  if (!Number.isInteger(candidate.policyVersion) || candidate.policyVersion < 1) {
    candidate.policyVersion = 4;
    normalizedLegacyPosition = true;
  }
}
const ledger = new StrictLedger(config.logDir);
function isStrictSource(value: unknown): value is StrictSource {
  return value === "scanner" || value === "signal" || value === "tracker";
}

/** Ledger wins over the state snapshot after a crash. Every state mutation is synchronous, but a
 * process can still die in the few instructions between append and atomic rename; replay closes
 * that window so a recorded OPEN is never bought twice and a recorded exit is never forgotten.
 */
function reconcileStateFromLedger(): boolean {
  let changed = false;
  for (const row of ledger.startupRecords) {
    const paperId = typeof row.paperId === "string" ? row.paperId : null;
    const source = isStrictSource(row.source) ? row.source : null;
    const sourceKey = typeof row.sourceKey === "string" ? row.sourceKey : null;
    if (row.type !== "RANKING_FILTERED" && source && sourceKey && !state.seen[`${source}:${sourceKey}`]) {
      state.seen[`${source}:${sourceKey}`] = Date.parse(row.ts) || Date.now();
      changed = true;
    }

    if (row.type === "SOURCE_PRIMED" && source === "scanner") {
      if (row.lane === "toplist") state.primed.ranking = true;
      else state.primed.scanner = true;
      changed = true;
    }
    if (row.type === "SOURCE_PRIMED" && source === "signal") { state.primed.signal = true; changed = true; }
    if (row.type === "SOURCE_PRIMED" && source === "tracker" && typeof row.wallet === "string" && !state.primed.trackers.includes(row.wallet)) {
      state.primed.trackers.push(row.wallet); changed = true;
    }

    if (row.type === "CANDIDATE_ACCEPTED" && paperId && source && sourceKey && !state.positions[paperId]) {
      const candidate = row as unknown as StrictCandidate;
      if (typeof candidate.mint === "string" && typeof candidate.detectedAt === "number") {
        state.pendingCandidates[paperId] = candidate; changed = true;
      }
    }
    if (row.type === "CANDIDATE_TERMINAL" && paperId) {
      if (state.pendingCandidates[paperId]) { delete state.pendingCandidates[paperId]; changed = true; }
    }
    if (row.type === "POSITION_OPEN" && paperId && source && sourceKey) {
      if (!state.positions[paperId] && row.entry && typeof row.entry === "object") {
        state.positions[paperId] = {
          policyVersion: typeof row.policyVersion === "number" && Number.isInteger(row.policyVersion) ? row.policyVersion : 3,
          paperId, source, sourceKey,
          mint: String(row.mint ?? ""), symbol: typeof row.symbol === "string" ? row.symbol : null,
          wallet: typeof row.wallet === "string" ? row.wallet : null,
          walletType: typeof row.walletType === "string" ? row.walletType : null,
          sourceTs: typeof row.sourceTs === "number" ? row.sourceTs : null,
          detectedAt: typeof row.detectedAt === "number" ? row.detectedAt : Date.parse(row.ts),
          riskVerdict: row.riskVerdict as StrictPosition["riskVerdict"],
          riskReasons: Array.isArray(row.riskReasons) ? row.riskReasons.filter((v): v is string => typeof v === "string") : [],
          liveEligible: row.liveEligible === true,
          status: "OPEN", entry: row.entry as StrictPosition["entry"],
          adaptive: row.adaptive && typeof row.adaptive === "object"
            ? row.adaptive as StrictPosition["adaptive"] : undefined,
          pendingHorizons: Array.isArray(row.pendingHorizons) ? row.pendingHorizons.filter((v): v is number => typeof v === "number") : [],
          exits: [],
        };
        changed = true;
      }
      if (state.pendingCandidates[paperId]) { delete state.pendingCandidates[paperId]; changed = true; }
    }
    if (row.type === "POSITION_EXIT" && paperId) {
      const position = state.positions[paperId];
      const horizonSec = typeof row.horizonSec === "number" ? row.horizonSec : null;
      if (position && horizonSec != null && !position.exits.some((exit) => exit.horizonSec === horizonSec)) {
        const exit = row as unknown as StrictExit;
        position.exits.push(exit);
        position.pendingHorizons = position.pendingHorizons.filter((horizon) => horizon !== horizonSec);
        changed = true;
      }
    }
    if (row.type === "SCALP_EXIT" && paperId) {
      const position = state.positions[paperId];
      if (position?.adaptive && position.adaptive.status !== "EXITED") {
        position.adaptive.status = "EXITED";
        position.adaptive.exit = row as unknown as StrictScalpExit;
        changed = true;
      }
    }
    if (row.type === "POSITION_CLOSED" && paperId && state.positions[paperId]) {
      state.positions[paperId]!.status = "CLOSED";
      state.positions[paperId]!.pendingHorizons = [];
      changed = true;
    }
  }
  return changed;
}

let stateDirty = normalizedLegacyPosition || reconcileStateFromLedger();
function persist(): void {
  if (!stateDirty) return;
  state.updatedAt = nowIso();
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_PATH);
  stateDirty = false;
}
function dirty(): void { stateDirty = true; persist(); }

function acquireLock(): number {
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeFileSync(fd, String(process.pid));
    return fd;
  } catch {
    const pid = Number(readFileSync(LOCK_PATH, "utf8"));
    try { if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0); }
    catch {
      unlinkSync(LOCK_PATH);
      const fd = openSync(LOCK_PATH, "wx");
      writeFileSync(fd, String(process.pid));
      return fd;
    }
    throw new Error(`strict paper is already running (pid ${pid})`);
  }
}

const lockFd = acquireLock();
persist();
let stopping = false;
function releaseLock(): void {
  try { closeSync(lockFd); } catch { /* already closed */ }
  try { if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_PATH); } catch { /* best effort */ }
}

function budget(kind: "premium" | "basic", endpoint: string): boolean {
  const usedKey = kind === "premium" ? "premiumUsed" : "basicUsed";
  const pausedKey = kind === "premium" ? "premiumPaused" : "basicPaused";
  const cap = kind === "premium" ? PREMIUM_BUDGET : BASIC_BUDGET;
  if (state.budget[usedKey] >= cap) {
    if (!state.budget[pausedKey]) {
      state.budget[pausedKey] = true;
      ledger.append({ type: "BUDGET_PAUSED", kind, cap, endpoint });
      dirty();
      ui.warn(`[okx-paper] ${kind} source budget exhausted at ${cap}; entries paused, exits continue`);
    }
    return false;
  }
  state.budget[usedKey]++;
  dirty(); // reserve before the network call; a crash must not refund quota locally
  return true;
}

function trimState(): void {
  const keepNewest = <T>(obj: Record<string, T>, limit: number, timestamp: (v: T) => number): Record<string, T> =>
    Object.fromEntries(Object.entries(obj).sort((a, b) => timestamp(b[1]) - timestamp(a[1])).slice(0, limit));
  if (Object.keys(state.seen).length > 100_000) state.seen = keepNewest(state.seen, 80_000, (v) => v);
  if (Object.keys(state.rankingRecheck).length > 10_000) {
    state.rankingRecheck = keepNewest(state.rankingRecheck, 8_000, (v) => v.at);
  }
  if (Object.keys(state.scoutCache).length > 10_000) state.scoutCache = keepNewest(state.scoutCache, 8_000, (v) => v.seenAt);
}

const safeRawNumber = (raw: string | null): number | null => {
  if (!raw) return null;
  const n = BigInt(raw);
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
};

type SellProofResult = {
  ok: true;
  built: OkxSwapTransactionBuild;
  proof: StrictSellProof;
  minimumLamports: number;
} | {
  ok: false;
  status: "NO_SELL_ROUTE_PRECHECK" | "DATA_INVALID" | "REJECTED_POLICY";
  details: Record<string, unknown>;
};

async function buildSellProof(
  mint: string,
  tokenAmountRaw: string,
  payerCostLamports: number,
  stage: "sell-preflight" | "sell-confirmation",
): Promise<SellProofResult> {
  const built = await okxSwapTx(mint, OKX_NATIVE_SOL, tokenAmountRaw, PAPER_WALLET);
  if (!built) return { ok: false, status: "NO_SELL_ROUTE_PRECHECK", details: { stage } };
  const quotedRaw = rawInteger(built.quote?.toTokenAmount);
  const minimumRaw = rawInteger(built.minReceiveAmountRaw);
  const minimumLamports = safeRawNumber(minimumRaw);
  if (!quotedRaw || !minimumRaw || minimumLamports == null) {
    return { ok: false, status: "DATA_INVALID", details: {
      stage, hasQuote: Boolean(quotedRaw), hasMinimum: Boolean(minimumRaw),
    } };
  }
  const priceImpactPercent = finiteNumber(built.quote?.priceImpactPercent);
  if (priceImpactPercent != null && priceImpactPercent > MAX_PRICE_IMPACT_PERCENT) {
    return { ok: false, status: "REJECTED_POLICY", details: { reason: "SELL_PRICE_IMPACT", stage,
      priceImpactPercent, maxPriceImpactPercent: MAX_PRICE_IMPACT_PERCENT } };
  }
  const estimate = safeRawNumber(rawInteger(built.estimateGasFeeRaw));
  const messageFee = await poolUnsignedTransactionFee(built.bytes);
  const estimatedFeeLamports = messageFee ?? Math.max(EXIT_FEE_FLOOR_LAMPORTS, estimate ?? 0);
  const math = strictExitMath(payerCostLamports, minimumLamports, estimatedFeeLamports);
  return {
    ok: true,
    built,
    minimumLamports,
    proof: {
      buildMs: built.buildMs,
      quotedSolLamports: quotedRaw,
      minSolLamports: minimumRaw,
      estimatedFeeLamports,
      feeSource: messageFee == null ? "OKX_ESTIMATE_FALLBACK" : "RPC_MESSAGE",
      priceImpactPercent,
      routeCount: Array.isArray(built.quote?.dexRouterList) ? built.quote.dexRouterList.length : 0,
      roundTripFloorPnlPct: math.pnlPct,
    },
  };
}

const epochMs = (value: unknown): number | null => {
  const n = finiteNumber(value);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1_000 : n;
};
const sourceSeenKey = (source: StrictSource, key: string) => `${source}:${key}`;

const sourceRetryAt = new Map<string, number>();
function sourceReady(source: string): boolean { return Date.now() >= (sourceRetryAt.get(source) ?? 0); }
function sourceFailure(source: string, endpoint: string, result: OkxCallResult<unknown>, context: Record<string, unknown> = {}): void {
  const backoffMs = result.httpStatus === 402 ? PAYMENT_BACKOFF_MS
    : result.httpStatus === 429 ? 60_000
      : 10_000;
  const retryAt = Date.now() + backoffMs;
  sourceRetryAt.set(source, retryAt);
  ledger.append({ type: "SOURCE_FETCH_FAILED", source, endpoint, httpStatus: result.httpStatus,
    code: result.code, msg: result.msg, quotaNotice: result.quotaNotice, elapsedMs: result.elapsedMs,
    backoffMs, retryAt, ...context });
  if (result.httpStatus === 402) ui.warn(`[okx-paper] ${source} paused ${Math.round(backoffMs / 60_000)}m: OKX Market API requires quota/payment`);
}

const workQueue: string[] = [];
let activeWorkers = 0;

function terminal(candidate: StrictCandidate, status: Exclude<import("./discovery/okx-strict-paper-core.js").StrictTerminal, "OPEN" | "CLOSED">, details: Record<string, unknown> = {}): void {
  ledger.append({ type: "CANDIDATE_TERMINAL", paperId: candidate.paperId, source: candidate.source, sourceKey: candidate.sourceKey,
    mint: candidate.mint, symbol: candidate.symbol, status, detectedAt: candidate.detectedAt,
    policyVersion: candidate.policyVersion, ...details });
  delete state.pendingCandidates[candidate.paperId];
  dirty();
}

function enqueue(candidate: Omit<StrictCandidate, "paperId" | "policyVersion">): void {
  const seenKey = sourceSeenKey(candidate.source, candidate.sourceKey);
  if (state.seen[seenKey]) return;
  const paperId = strictPaperId(candidate.source, candidate.sourceKey);
  const full: StrictCandidate = { policyVersion: PAPER_POLICY_VERSION, paperId, ...candidate };
  state.seen[seenKey] = Date.now();
  state.pendingCandidates[paperId] = full;
  trimState();
  ledger.append({ type: "CANDIDATE_ACCEPTED", ...full });
  dirty();
  workQueue.push(paperId);
  kickWorkers();
}

async function processCandidate(candidate: StrictCandidate): Promise<void> {
  if (candidate.policyVersion !== PAPER_POLICY_VERSION) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "STALE_POLICY_CANDIDATE",
      activePolicyVersion: PAPER_POLICY_VERSION });
  }
  if (candidate.source !== "scanner" || !candidate.sourceKey.startsWith("toplist:")) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "LANE_SHADOW_ONLY_V6" });
  }
  const queueLagMs = Date.now() - candidate.detectedAt;
  if (queueLagMs > MAX_DETECT_TO_BUILD_MS) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "STALE_CANDIDATE_QUEUE", queueLagMs,
      maxDetectToBuildMs: MAX_DETECT_TO_BUILD_MS });
  }
  const open = Object.values(state.positions).filter((p) => p.status === "OPEN").length;
  if (open >= MAX_OPEN) return terminal(candidate, "REJECTED_CAPACITY", { open, maxOpen: MAX_OPEN });
  if (candidate.riskVerdict !== "SOURCE_NATIVE" && candidate.riskVerdict !== "CLEAN") {
    return terminal(candidate, "REJECTED_RISK", { riskVerdict: candidate.riskVerdict, reasons: candidate.riskReasons });
  }

  // Unknown tracker/signal tokens use the old Micincloud on-chain setup classifier. Run that in
  // parallel with OKX's build so safety latency does not stack on top of route latency.
  const riskPromise = candidate.riskVerdict === "SOURCE_NATIVE"
    ? classifyLaunch(candidate.mint).catch((error) => ({ verdict: "UNKNOWN" as const, confidence: 0,
      evidence: [], missing: [`CORE_GATE_ERROR:${(error as Error).message}`] }))
    : Promise.resolve(null);
  const buildPromise = okxSwapTx(OKX_NATIVE_SOL, candidate.mint, SIZE_LAMPORTS, PAPER_WALLET);
  const [resolvedRisk, built] = await Promise.all([riskPromise, buildPromise]);
  if (resolvedRisk) {
    candidate.riskVerdict = resolvedRisk.verdict;
    candidate.riskReasons = [...resolvedRisk.evidence, ...resolvedRisk.missing.map((reason) => `MISSING:${reason}`)];
    ledger.append({ type: "RISK_RESOLVED", paperId: candidate.paperId, source: candidate.source,
      mint: candidate.mint, verdict: resolvedRisk.verdict, confidence: resolvedRisk.confidence,
      evidence: resolvedRisk.evidence, missing: resolvedRisk.missing, engine: "MICINCLOUD_SETUP" });
    dirty();
    const observeUnknown = ALLOW_UNKNOWN_RISK
      || (OBSERVE_UNKNOWN_RANKING && candidate.source === "scanner" && candidate.sourceKey.startsWith("toplist:"));
    if (!strictRiskAccepted(resolvedRisk.verdict, observeUnknown)) {
      return terminal(candidate, "REJECTED_RISK", { riskVerdict: resolvedRisk.verdict, reasons: candidate.riskReasons });
    }
  }
  if (!built) return terminal(candidate, "NO_BUY_ROUTE");

  const quotedTokenRaw = rawInteger(built.quote?.toTokenAmount);
  const minTokenRaw = rawInteger(built.minReceiveAmountRaw);
  const decimals = finiteNumber(built.quote?.toToken?.decimal);
  const priceImpact = finiteNumber(built.quote?.priceImpactPercent);
  if (!quotedTokenRaw || !minTokenRaw || priceImpact == null || decimals == null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return terminal(candidate, "DATA_INVALID", {
      stage: "buy-build", hasQuote: Boolean(quotedTokenRaw), hasMinimum: Boolean(minTokenRaw), decimals,
    });
  }
  if (priceImpact > MAX_PRICE_IMPACT_PERCENT) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "PRICE_IMPACT", priceImpactPercent: priceImpact,
      maxPriceImpactPercent: MAX_PRICE_IMPACT_PERCENT, buildMs: built.buildMs });
  }
  const quotedBig = BigInt(quotedTokenRaw);
  const minimumBig = BigInt(minTokenRaw);
  if (minimumBig > quotedBig) return terminal(candidate, "DATA_INVALID", { stage: "buy-minimum-above-quote" });
  const minReceiveHaircutPct = Number((quotedBig - minimumBig) * 1_000_000n / quotedBig) / 10_000;

  const sim = await poolSimulateUnsigned(built.bytes, PAPER_WALLET);
  if (!sim) return terminal(candidate, "BUY_SIM_UNAVAILABLE", { buildMs: built.buildMs });
  if (!sim.ok) return terminal(candidate, "BUY_SIM_FAILED", {
    buildMs: built.buildMs, simErr: sim.err, unitsConsumed: sim.unitsConsumed, logsTail: sim.logs.slice(-12),
  });
  if (sim.payerCostLamports == null || sim.payerCostLamports <= 0) {
    return terminal(candidate, "DATA_INVALID", { stage: "buy-simulation", payerCostLamports: sim.payerCostLamports });
  }
  const size = Number(SIZE_LAMPORTS);
  const minimumCost = size + (sim.feeLamports ?? 5_000);
  if (sim.payerCostLamports < minimumCost || sim.payerCostLamports > size + MAX_ENTRY_OVERHEAD_LAMPORTS) {
    return terminal(candidate, "DATA_INVALID", { stage: "buy-simulation-balance-delta", payerCostLamports: sim.payerCostLamports,
      minimumCost, maximumCost: size + MAX_ENTRY_OVERHEAD_LAMPORTS });
  }
  const payerCostLamports = sim.payerCostLamports;
  const entryOverheadLamports = payerCostLamports - size;
  const entryOverheadPct = entryOverheadLamports / size * 100;
  if (entryOverheadPct > MAX_ENTRY_OVERHEAD_PCT) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "ENTRY_OVERHEAD", payerCostLamports,
      entryOverheadLamports, entryOverheadPct, maxEntryOverheadPct: MAX_ENTRY_OVERHEAD_PCT,
      feeLamports: sim.feeLamports, unitsConsumed: sim.unitsConsumed });
  }

  // A buy route is not enough: most baseline losses came from tokens that could not be sold at
  // the evaluation horizon. Prove an unsigned reverse route exists before recording an entry and
  // price the round trip from minimum receives, never from the optimistic quote.
  const preflight = await buildSellProof(candidate.mint, minTokenRaw, payerCostLamports, "sell-preflight");
  if (!preflight.ok) return terminal(candidate, preflight.status, preflight.details);
  if (preflight.proof.roundTripFloorPnlPct < MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "ROUNDTRIP_FLOOR",
      stage: "sell-preflight", roundTripFloorPnlPct: preflight.proof.roundTripFloorPnlPct,
      minPreflightRoundTripPnlPct: MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT });
  }

  const firstProofAt = Date.now();
  await sleep(SELL_CONFIRM_MS);
  const confirmation = await buildSellProof(candidate.mint, minTokenRaw, payerCostLamports, "sell-confirmation");
  if (!confirmation.ok) return terminal(candidate, confirmation.status, confirmation.details);
  if (confirmation.proof.roundTripFloorPnlPct < MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "ROUNDTRIP_FLOOR",
      stage: "sell-confirmation", roundTripFloorPnlPct: confirmation.proof.roundTripFloorPnlPct,
      minPreflightRoundTripPnlPct: MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT });
  }
  const confirmedAt = Date.now();
  const minReceiveDropPct = (preflight.minimumLamports - confirmation.minimumLamports)
    / preflight.minimumLamports * 100;
  if (minReceiveDropPct > MAX_SELL_PROOF_DROP_PCT) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "SELL_PROOF_DETERIORATION",
      minReceiveDropPct, maxSellProofDropPct: MAX_SELL_PROOF_DROP_PCT,
      firstMinSolLamports: preflight.proof.minSolLamports,
      confirmationMinSolLamports: confirmation.proof.minSolLamports });
  }
  const builtAt = Date.now();
  const detectToBuildMs = builtAt - candidate.detectedAt;
  if (detectToBuildMs > MAX_DETECT_TO_BUILD_MS) {
    return terminal(candidate, "REJECTED_POLICY", { reason: "DETECT_TO_BUILD_LATENCY", detectToBuildMs,
      maxDetectToBuildMs: MAX_DETECT_TO_BUILD_MS });
  }
  const position: StrictPosition = {
    policyVersion: candidate.policyVersion,
    paperId: candidate.paperId, source: candidate.source, sourceKey: candidate.sourceKey,
    mint: candidate.mint, symbol: candidate.symbol, wallet: candidate.wallet, walletType: candidate.walletType,
    sourceTs: candidate.sourceTs, detectedAt: candidate.detectedAt,
    riskVerdict: candidate.riskVerdict, riskReasons: candidate.riskReasons,
    liveEligible: candidate.riskVerdict === "CLEAN",
    status: "OPEN",
    entry: {
      detectedAt: candidate.detectedAt, builtAt, buildMs: built.buildMs,
      detectToBuildMs, sizeLamports: SIZE_LAMPORTS,
      quotedTokenRaw, minTokenRaw, tokenDecimals: decimals, priceImpactPercent: priceImpact,
      minReceiveHaircutPct, payerCostLamports, entryOverheadLamports, entryOverheadPct,
      feeLamports: sim.feeLamports, unitsConsumed: sim.unitsConsumed,
      txBytes: built.bytes.length, txFormat: built.format,
      preflightExit: { ...preflight.proof, confirmation: { ...confirmation.proof,
        confirmedAt, separationMs: confirmedAt - firstProofAt, minReceiveDropPct } },
    },
    adaptive: {
      strategy: "V6_FAST_RECHECK_TP5_SL8_T60", status: "MONITORING",
      takeProfitPct: SCALP_TAKE_PROFIT_PCT, hardStopPct: SCALP_HARD_STOP_PCT,
      maxHoldMs: SCALP_MAX_HOLD_MS, pollMs: SCALP_POLL_MS,
      executionDelayMs: SCALP_EXECUTION_DELAY_MS, maxConsecutiveNoRoute: SCALP_MAX_NO_ROUTE,
      nextCheckAt: builtAt + SCALP_POLL_MS, checks: 0, consecutiveNoRoute: 0,
      peakPnlPct: null, exit: null,
    },
    pendingHorizons: [...HORIZONS], exits: [],
  };
  state.positions[position.paperId] = position;
  delete state.pendingCandidates[position.paperId];
  ledger.append({ type: "POSITION_OPEN", ...position, signed: false, broadcast: false, simulationOk: true });
  dirty();
  ui.pass(`[okx-paper] OPEN v${PAPER_POLICY_VERSION} toplist ${candidate.symbol ?? candidate.mint.slice(0, 8)} · ${position.liveEligible ? "LIVE-ELIGIBLE" : "PAPER-ONLY"} · ${built.buildMs}ms buy · sell proofs ${preflight.built.buildMs}/${confirmation.built.buildMs}ms · floor ${confirmation.proof.roundTripFloorPnlPct.toFixed(2)}% · ${position.entry.detectToBuildMs}ms detect→build`);
}

async function runWorker(): Promise<void> {
  if (activeWorkers >= WORKER_CONCURRENCY) return;
  activeWorkers++;
  try {
    while (!stopping && workQueue.length) {
      const id = workQueue.shift()!;
      const candidate = state.pendingCandidates[id];
      if (candidate) await processCandidate(candidate);
    }
  } finally {
    activeWorkers--;
    if (!stopping && workQueue.length) kickWorkers();
  }
}

function kickWorkers(): void {
  const needed = Math.min(WORKER_CONCURRENCY - activeWorkers, workQueue.length);
  for (let i = 0; i < needed; i++) void runWorker();
}

async function buildVirtualExit(position: StrictPosition, horizonSec: number, retryNoRoute: boolean): Promise<StrictExit> {
  let built = await okxSwapTx(position.mint, OKX_NATIVE_SOL, position.entry.minTokenRaw, PAPER_WALLET);
  if (!built && retryNoRoute) {
    await sleep(600);
    built = await okxSwapTx(position.mint, OKX_NATIVE_SOL, position.entry.minTokenRaw, PAPER_WALLET);
  }
  if (!built) {
    const math = strictExitMath(position.entry.payerCostLamports, 0, 0);
    return { horizonSec, attemptedAt: Date.now(), status: "EXIT_NO_ROUTE", buildMs: null,
      quotedSolLamports: null, minSolLamports: null, estimatedFeeLamports: 0,
      feeSource: "NO_ROUTE", ...math, priceImpactPercent: null,
      simulation: "NOT_APPLICABLE_VIRTUAL_BALANCE" };
  }
  const quoted = rawInteger(built.quote?.toTokenAmount);
  const minimum = rawInteger(built.minReceiveAmountRaw);
  const minimumN = safeRawNumber(minimum);
  if (!quoted || !minimum || minimumN == null) {
    const math = strictExitMath(position.entry.payerCostLamports, 0, 0);
    return { horizonSec, attemptedAt: Date.now(), status: "EXIT_DATA_INVALID", buildMs: built.buildMs,
      quotedSolLamports: quoted, minSolLamports: minimum, estimatedFeeLamports: 0,
      feeSource: "NO_ROUTE", ...math, priceImpactPercent: finiteNumber(built.quote?.priceImpactPercent),
      simulation: "NOT_APPLICABLE_VIRTUAL_BALANCE" };
  }
  const estimate = safeRawNumber(rawInteger(built.estimateGasFeeRaw));
  const messageFee = await poolUnsignedTransactionFee(built.bytes);
  const fee = messageFee ?? Math.max(EXIT_FEE_FLOOR_LAMPORTS, estimate ?? 0);
  const math = strictExitMath(position.entry.payerCostLamports, minimumN, fee);
  return { horizonSec, attemptedAt: Date.now(), status: "BUILT", buildMs: built.buildMs,
    quotedSolLamports: quoted, minSolLamports: minimum, estimatedFeeLamports: fee,
    feeSource: messageFee == null ? "OKX_ESTIMATE_FALLBACK" : "RPC_MESSAGE",
    ...math, priceImpactPercent: finiteNumber(built.quote?.priceImpactPercent),
    simulation: "NOT_APPLICABLE_VIRTUAL_BALANCE" };
}

const settling = new Set<string>();
async function settle(position: StrictPosition, horizonSec: number): Promise<void> {
  const key = `${position.paperId}:${horizonSec}`;
  if (settling.has(key)) return;
  settling.add(key);
  try {
    const exit = await buildVirtualExit(position, horizonSec, true);
    position.exits.push(exit);
    position.pendingHorizons = position.pendingHorizons.filter((h) => h !== horizonSec);
    if (position.pendingHorizons.length === 0) position.status = "CLOSED";
    ledger.append({ type: "POSITION_EXIT", paperId: position.paperId, source: position.source,
      sourceKey: position.sourceKey, riskVerdict: position.riskVerdict, liveEligible: position.liveEligible,
      policyVersion: position.policyVersion, mint: position.mint, symbol: position.symbol,
      entryCostLamports: position.entry.payerCostLamports, ...exit });
    if (position.status === "CLOSED") ledger.append({ type: "POSITION_CLOSED", paperId: position.paperId,
      source: position.source, sourceKey: position.sourceKey, riskVerdict: position.riskVerdict,
      policyVersion: position.policyVersion, liveEligible: position.liveEligible, mint: position.mint });
    dirty();
  } finally { settling.delete(key); }
}

async function settleDue(): Promise<void> {
  const now = Date.now();
  const due: Array<[StrictPosition, number]> = [];
  for (const position of Object.values(state.positions)) {
    if (position.status !== "OPEN") continue;
    for (const horizon of position.pendingHorizons) if (now - position.entry.builtAt >= horizon * 1_000) due.push([position, horizon]);
  }
  // Avoid a reconnect/restart burst starving fresh entries. The endpoint bucket still enforces
  // the hard RPS ceiling; this bounds the amount of queued work per scheduler tick.
  await Promise.all(due.slice(0, 4).map(([p, h]) => settle(p, h)));
}

const scalpChecking = new Set<string>();
async function recordScalpExit(
  position: StrictPosition,
  triggerReason: StrictScalpExit["triggerReason"],
  triggerAt: number,
  triggerPnlPct: number | null,
  finalQuote: StrictExit,
): Promise<void> {
  const adaptive = position.adaptive;
  if (!adaptive || adaptive.status !== "MONITORING") return;
  const executedAt = Date.now();
  const { horizonSec: _horizonSec, ...filled } = finalQuote;
  const exit: StrictScalpExit = {
    ...filled,
    triggerReason,
    triggerAt,
    triggerPnlPct,
    executedAt,
    executionDelayMs: executedAt - triggerAt,
    triggerToExecutionGapPct: triggerPnlPct == null ? null : finalQuote.pnlPct - triggerPnlPct,
  };
  adaptive.status = "EXITED";
  adaptive.exit = exit;
  ledger.append({ type: "SCALP_EXIT", paperId: position.paperId, source: position.source,
    sourceKey: position.sourceKey, riskVerdict: position.riskVerdict, liveEligible: position.liveEligible,
    policyVersion: position.policyVersion, mint: position.mint, symbol: position.symbol,
    entryCostLamports: position.entry.payerCostLamports, strategy: adaptive.strategy,
    checks: adaptive.checks, peakPnlPct: adaptive.peakPnlPct, ...exit });
  dirty();
  const label = exit.status === "BUILT" ? `${exit.pnlPct.toFixed(2)}%` : `${exit.status} (-100%)`;
  ui.info(`[okx-paper] SCALP ${triggerReason} ${position.symbol ?? position.mint.slice(0, 8)} · fill ${label} · trigger→fill ${exit.executionDelayMs}ms`);
}

async function checkAdaptive(position: StrictPosition): Promise<void> {
  const adaptive = position.adaptive;
  if (!adaptive || adaptive.status !== "MONITORING" || scalpChecking.has(position.paperId)) return;
  scalpChecking.add(position.paperId);
  try {
    const triggerQuote = await buildVirtualExit(position, 0, false);
    adaptive.checks++;
    if (triggerQuote.status !== "BUILT") {
      adaptive.consecutiveNoRoute++;
      if (adaptive.consecutiveNoRoute < adaptive.maxConsecutiveNoRoute) {
        adaptive.nextCheckAt = Date.now() + SCALP_NO_ROUTE_RETRY_MS;
        dirty();
        return;
      }
      await recordScalpExit(position, "ROUTE_LOST", Date.now(), null, triggerQuote);
      return;
    }

    adaptive.consecutiveNoRoute = 0;
    adaptive.peakPnlPct = adaptive.peakPnlPct == null
      ? triggerQuote.pnlPct : Math.max(adaptive.peakPnlPct, triggerQuote.pnlPct);
    const triggerReason = strictScalpDecision({
      pnlPct: triggerQuote.pnlPct,
      ageMs: Date.now() - position.entry.builtAt,
      takeProfitPct: adaptive.takeProfitPct,
      hardStopPct: adaptive.hardStopPct,
      maxHoldMs: adaptive.maxHoldMs,
    });
    if (!triggerReason) {
      adaptive.nextCheckAt = Date.now() + adaptive.pollMs;
      dirty();
      return;
    }

    const triggerAt = Date.now();
    await sleep(adaptive.executionDelayMs);
    // The trigger quote is never treated as a fill. A fresh post-delay build is the only PnL
    // recorded, matching the adverse movement and route loss that a real submit path would face.
    const finalQuote = await buildVirtualExit(position, 0, false);
    await recordScalpExit(position, triggerReason, triggerAt, triggerQuote.pnlPct, finalQuote);
  } finally {
    scalpChecking.delete(position.paperId);
  }
}

async function checkAdaptiveDue(): Promise<void> {
  const now = Date.now();
  const due = Object.values(state.positions).filter((position) =>
    position.adaptive?.status === "MONITORING" && position.adaptive.nextCheckAt <= now);
  await Promise.all(due.slice(0, 2).map((position) => checkAdaptive(position)));
}

function scannerSourceKey(t: OkxMemeToken): string { return t.tokenAddress; }
function signalSourceKey(s: OkxSignal): string {
  return [s.cursor ?? "", s.timestamp ?? "", s.token?.tokenAddress ?? "", s.triggerWalletAddress ?? "", s.amountUsd ?? ""].join(":");
}
function trackerSourceKey(wallet: string, t: OkxWalletDexTransaction): string {
  return [wallet, t.time ?? "", t.tokenContractAddress, t.type, t.amount ?? "", t.valueUsd ?? ""].join(":");
}

function rankingSourceKey(t: OkxRankedToken): string {
  return `toplist:v${PAPER_POLICY_VERSION}:${t.tokenContractAddress}`;
}

let rankingBusy = false;
async function rankingOnce(): Promise<void> {
  if (rankingBusy || !sourceReady("ranking") || !budget("basic", "token/toplist")) return;
  rankingBusy = true;
  try {
    const call = await okxCall<OkxRankedToken[]>("token.toplist", {
      chains: okxChainIndex, sortBy: "5", timeFrame: "1", limit: "100",
    });
    if (!call.ok || !Array.isArray(call.data)) { sourceFailure("ranking", "token.toplist", call); return; }
    const detectedAt = Date.now();
    const firstPass = !state.primed.ranking;
    let acceptedThisPass = 0;
    let evaluatedThisPass = 0;
    let transientFiltered = 0;
    let expiredThisPass = 0;
    let cooldownSkipped = 0;
    let filterChanges = 0;
    const acceptCap = firstPass
      ? Math.min(RANKING_WARM_START_MAX, RANKING_MAX_ACCEPT_PER_PASS)
      : RANKING_MAX_ACCEPT_PER_PASS;
    const rows = [...call.data].sort((a, b) => (epochMs(b.firstTradeTime) ?? 0) - (epochMs(a.firstTradeTime) ?? 0));
    for (const t of rows) {
      const mint = t.tokenContractAddress;
      if (!mint) continue;
      const key = rankingSourceKey(t);
      if (state.seen[sourceSeenKey("scanner", key)]) continue;
      const previous = state.rankingRecheck[key];
      if (previous && detectedAt - previous.at < RANKING_RECHECK_MS) {
        cooldownSkipped++;
        continue;
      }
      evaluatedThisPass++;
      const firstTradeAt = epochMs(t.firstTradeTime);
      const reasons = strictRankingPolicy({
        firstTradeAt, detectedAt, maxAgeMs: RANKING_MAX_AGE_MS,
        liquidityUsd: finiteNumber(t.liquidity), minLiquidityUsd: RANKING_MIN_LIQUIDITY_USD,
        volumeUsd: finiteNumber(t.volume), minVolumeUsd: RANKING_MIN_VOLUME_USD,
        marketCapUsd: finiteNumber(t.marketCap), maxMarketCapUsd: RANKING_MAX_MARKET_CAP_USD,
        holders: finiteNumber(t.holders), minHolders: RANKING_MIN_HOLDERS,
        buys: finiteNumber(t.txsBuy), sells: finiteNumber(t.txsSell),
        minTransactions: RANKING_MIN_TRANSACTIONS, minBuyRatio: RANKING_MIN_BUY_RATIO,
      });
      if (reasons.length === 0 && acceptedThisPass >= acceptCap) {
        reasons.push(`PASS_ACCEPT_CAP>${acceptCap}`);
      }
      if (reasons.length) {
        const expired = strictRankingDisposition(reasons, RANKING_MAX_AGE_MS) === "FINAL";
        if (expired) {
          expiredThisPass++;
          delete state.rankingRecheck[key];
          state.seen[sourceSeenKey("scanner", key)] = detectedAt;
          ledger.append({ type: "CANDIDATE_TERMINAL", paperId: strictPaperId("scanner", key),
            source: "scanner", sourceKey: key, mint, symbol: t.tokenSymbol ?? null,
            sourceTs: detectedAt, detectedAt, firstTradeAt, status: "REJECTED_POLICY",
            policyVersion: PAPER_POLICY_VERSION, reasons, raw: t });
        } else {
          // Liquidity, volume, holders and buy ratio change quickly after launch. A failed early
          // snapshot is an observation, not a terminal candidate decision; recheck it until age-out.
          transientFiltered++;
          const signature = reasons.slice().sort().join("|");
          if (previous?.signature !== signature) {
            filterChanges++;
            ledger.append({ type: "RANKING_FILTERED", policyVersion: PAPER_POLICY_VERSION,
              source: "scanner", lane: "toplist", sourceKey: key, mint,
              symbol: t.tokenSymbol ?? null, detectedAt, firstTradeAt, reasons, raw: t });
          }
          state.rankingRecheck[key] = { at: detectedAt, signature };
        }
        continue;
      }
      delete state.rankingRecheck[key];
      acceptedThisPass++;
      enqueue({ source: "scanner", sourceKey: key, mint, symbol: t.tokenSymbol ?? null,
        wallet: null, walletType: null, sourceTs: detectedAt, detectedAt,
        riskVerdict: "SOURCE_NATIVE", riskReasons: [], raw: { ...t, firstTradeAt, discoveryLane: "toplist" } });
    }
    trimState();
    ledger.append({ type: "RANKING_CYCLE", policyVersion: PAPER_POLICY_VERSION,
      source: "scanner", lane: "toplist", rows: rows.length, evaluated: evaluatedThisPass,
      cooldownSkipped, transientFiltered, expired: expiredThisPass, filterChanges,
      accepted: acceptedThisPass, acceptCap, apiMs: call.elapsedMs, pollMs: RANKING_MS,
      recheckMs: RANKING_RECHECK_MS });
    dirty();
    if (firstPass) {
      state.primed.ranking = true;
      ledger.append({ type: "SOURCE_PRIMED", source: "scanner", lane: "toplist", rows: rows.length,
        warmAccepted: acceptedThisPass, warmStartMax: RANKING_WARM_START_MAX });
      dirty();
    }
  } finally { rankingBusy = false; }
}

let scanBusy = false;
async function scanOnce(): Promise<void> {
  if (scanBusy || !sourceReady("scanner") || !budget("premium", "memepump/tokenList")) return;
  scanBusy = true;
  try {
    const call = await okxCall<OkxMemeToken[]>("trenches.tokenList", { chainIndex: okxChainIndex, stage: "NEW" });
    if (!call.ok || !Array.isArray(call.data)) { sourceFailure("scanner", "trenches.tokenList", call); return; }
    const rows = call.data;
    const detectedAt = Date.now();
    if (!state.primed.scanner) {
      for (const t of rows) {
        const row = toScoutRow(t, detectedAt); const verdict = scoutVerdict(row);
        state.seen[sourceSeenKey("scanner", scannerSourceKey(t))] = detectedAt;
        state.scoutCache[row.mint] = { row, verdict, seenAt: detectedAt };
      }
      state.primed.scanner = true;
      ledger.append({ type: "SOURCE_PRIMED", source: "scanner", rows: rows.length });
      dirty(); return;
    }
    for (const t of [...rows].reverse()) {
      const key = scannerSourceKey(t);
      if (state.seen[sourceSeenKey("scanner", key)]) continue;
      const row = toScoutRow(t, detectedAt); const verdict = scoutVerdict(row);
      state.scoutCache[row.mint] = { row, verdict, seenAt: detectedAt };
      if (verdict.verdict !== "CLEAN") {
        const candidate: StrictCandidate = { policyVersion: PAPER_POLICY_VERSION,
          paperId: strictPaperId("scanner", key), source: "scanner", sourceKey: key,
          mint: row.mint, symbol: row.symbol, wallet: null, walletType: null, sourceTs: row.createdAt,
          detectedAt, riskVerdict: verdict.verdict, riskReasons: verdict.reasons, raw: row as unknown as Record<string, unknown> };
        state.seen[sourceSeenKey("scanner", key)] = detectedAt;
        ledger.append({ type: "CANDIDATE_TERMINAL", ...candidate, status: "REJECTED_RISK" });
        dirty(); continue;
      }
      state.seen[sourceSeenKey("scanner", key)] = detectedAt;
      ledger.append({ type: "SHADOW_OBSERVATION", policyVersion: PAPER_POLICY_VERSION,
        source: "scanner", lane: "trenches", sourceKey: key, mint: row.mint, symbol: row.symbol,
        detectedAt, sourceTs: row.createdAt, verdict: verdict.verdict,
        reason: "LANE_SHADOW_ONLY_V6", raw: row as unknown as Record<string, unknown> });
      dirty();
    }
  } finally { scanBusy = false; }
}

let signalBusy = false;
async function signalOnce(): Promise<void> {
  if (signalBusy || !sourceReady("signal") || !budget("premium", "signal/list")) return;
  signalBusy = true;
  try {
    const call = await okxCall<OkxSignal[]>("signal.list", {}, [{
      chainIndex: okxChainIndex, walletType: "1,2,3", limit: "100",
    }]);
    if (!call.ok || !Array.isArray(call.data)) { sourceFailure("signal", "signal.list", call); return; }
    const rows = call.data;
    if (!state.primed.signal) {
      for (const s of rows) state.seen[sourceSeenKey("signal", signalSourceKey(s))] = Date.now();
      state.primed.signal = true;
      ledger.append({ type: "SOURCE_PRIMED", source: "signal", rows: rows.length });
      dirty(); return;
    }
    for (const s of [...rows].reverse()) {
      const key = signalSourceKey(s);
      if (state.seen[sourceSeenKey("signal", key)]) continue;
      const detectedAt = Date.now();
      const wallets = Math.max(0, Math.floor(finiteNumber(s.triggerWalletCount) ?? 0));
      const amount = finiteNumber(s.amountUsd);
      const mint = s.token?.tokenAddress ?? "";
      const sourceTs = epochMs(s.timestamp);
      const cached = state.scoutCache[mint];
      const reasons = strictValueLagPolicy({ valueUsd: amount, minUsd: SIGNAL_MIN_USD, valueLabel: "AMOUNT_USD",
        sourceTs, detectedAt, maxLagMs: MAX_SOURCE_LAG_MS });
      if (wallets < SIGNAL_MIN_WALLETS) reasons.push(`TRIGGER_WALLETS<${SIGNAL_MIN_WALLETS}`);
      if (cached?.verdict.verdict === "TOXIC") reasons.push(...cached.verdict.reasons.map((r) => `SCOUT:${r}`));
      if (!mint || reasons.length) {
        state.seen[sourceSeenKey("signal", key)] = detectedAt;
        ledger.append({ type: "CANDIDATE_TERMINAL", paperId: strictPaperId("signal", key), source: "signal", sourceKey: key,
          mint, symbol: s.token?.symbol ?? null, status: mint ? "REJECTED_POLICY" : "DATA_INVALID",
          policyVersion: PAPER_POLICY_VERSION, reasons, raw: s });
        dirty(); continue;
      }
      state.seen[sourceSeenKey("signal", key)] = detectedAt;
      ledger.append({ type: "SHADOW_OBSERVATION", policyVersion: PAPER_POLICY_VERSION,
        source: "signal", lane: "signal", sourceKey: key, mint, symbol: s.token?.symbol ?? null,
        wallet: s.triggerWalletAddress ?? null, walletType: s.walletType ?? null,
        sourceTs, detectedAt, wallets, amountUsd: amount, reason: "LANE_SHADOW_ONLY_V6", raw: s });
      dirty();
    }
  } finally { signalBusy = false; }
}

let trackerBusy = false;
const trackerLastEnd = new Map<string, number>();
async function trackerOnce(): Promise<void> {
  if (trackerBusy || TRACKER_WALLETS === 0) return;
  trackerBusy = true;
  try {
    const wallets = okxRadarSelect({ limit: TRACKER_WALLETS });
    for (const radarWallet of wallets) {
      const wallet = radarWallet.walletAddress;
      const sourceKey = `tracker:${wallet}`;
      if (!sourceReady(sourceKey)) continue;
      if (!budget("basic", "portfolio/dex-history")) break;
      const end = Date.now(); const begin = Math.max(0, (trackerLastEnd.get(wallet) ?? end - 5 * 60_000) - 5_000);
      const call = await okxCall<OkxWalletDexHistory>("portfolio.dexHistory", {
        chainIndex: okxChainIndex, walletAddress: wallet, begin: String(begin), end: String(end), type: "1", limit: "100",
      });
      if (!call.ok || !call.data || typeof call.data !== "object") {
        sourceFailure(sourceKey, "portfolio.dexHistory", call, { wallet });
        continue;
      }
      const page = call.data;
      trackerLastEnd.set(wallet, end);
      const rows = Array.isArray(page.transactionList) ? [...page.transactionList].reverse() : [];
      if (!state.primed.trackers.includes(wallet)) {
        for (const t of rows) state.seen[sourceSeenKey("tracker", trackerSourceKey(wallet, t))] = end;
        state.primed.trackers.push(wallet); ledger.append({ type: "SOURCE_PRIMED", source: "tracker", wallet, rows: rows.length }); dirty(); continue;
      }
      for (const t of rows) {
        const key = trackerSourceKey(wallet, t);
        if (t.type !== "1" || !t.tokenContractAddress || state.seen[sourceSeenKey("tracker", key)]) continue;
        const detectedAt = Date.now();
        const valueUsd = finiteNumber(t.valueUsd);
        const sourceTs = epochMs(t.time);
        const policyReasons = strictValueLagPolicy({ valueUsd, minUsd: TRACKER_MIN_USD, valueLabel: "VALUE_USD",
          sourceTs, detectedAt, maxLagMs: MAX_SOURCE_LAG_MS });
        if (policyReasons.length) {
          state.seen[sourceSeenKey("tracker", key)] = detectedAt;
          ledger.append({ type: "CANDIDATE_TERMINAL", paperId: strictPaperId("tracker", key), source: "tracker", sourceKey: key,
            mint: t.tokenContractAddress, symbol: t.tokenSymbol ?? null, wallet, walletTypes: radarWallet.walletTypes,
            detectedAt, sourceTs, status: "REJECTED_POLICY", policyVersion: PAPER_POLICY_VERSION,
            reasons: policyReasons, valueUsd, raw: t });
          dirty(); continue;
        }
        const cached = state.scoutCache[t.tokenContractAddress];
        if (cached?.verdict.verdict === "TOXIC") {
          state.seen[sourceSeenKey("tracker", key)] = end;
          ledger.append({ type: "CANDIDATE_TERMINAL", paperId: strictPaperId("tracker", key), source: "tracker", sourceKey: key,
            mint: t.tokenContractAddress, symbol: t.tokenSymbol ?? null, wallet, status: "REJECTED_RISK",
            policyVersion: PAPER_POLICY_VERSION, reasons: cached.verdict.reasons, raw: t });
          dirty(); continue;
        }
        state.seen[sourceSeenKey("tracker", key)] = detectedAt;
        ledger.append({ type: "SHADOW_OBSERVATION", policyVersion: PAPER_POLICY_VERSION,
          source: "tracker", lane: "tracker", sourceKey: key, mint: t.tokenContractAddress,
          symbol: t.tokenSymbol ?? null, wallet,
          walletType: radarWallet.walletTypes.join(",") || "RADAR_SELECTED", sourceTs, detectedAt,
          valueUsd, verdict: cached?.verdict.verdict ?? "SOURCE_NATIVE",
          reason: "LANE_SHADOW_ONLY_V6", raw: t });
        dirty();
      }
    }
  } finally { trackerBusy = false; }
}

async function main(): Promise<void> {
  if (!okxEnabled) throw new Error("OKX is disabled or credentials are incomplete");
  if (HORIZONS.length === 0) throw new Error("OKX_PAPER_HORIZONS_SEC has no valid horizon");
  if (!HORIZONS.includes(PRIMARY_EXIT_HORIZON_SEC)) {
    throw new Error("OKX_PAPER_PRIMARY_EXIT_HORIZON_SEC must be included in OKX_PAPER_HORIZONS_SEC");
  }
  new PublicKey(PAPER_WALLET); // syntax only; no signer is ever loaded
  for (const warning of okxCredentialWarnings()) ui.warn(`[okx-paper] ${warning}`);
  const balance = await poolBalanceSol(PAPER_WALLET);
  if (balance == null || balance < SIZE_SOL + 0.005) throw new Error("paper simulation wallet is unreadable or lacks enough SOL for the configured size");

  ledger.append({ type: "RUN_START", pid: process.pid, signed: false, broadcast: false,
    sourceMode: config.okx.wsEnabled ? "ws-not-wired-strict-v2" : "rest-sampled",
    sizeSol: SIZE_SOL, horizonsSec: HORIZONS, primaryExitHorizonSec: PRIMARY_EXIT_HORIZON_SEC,
    scanMs: SCAN_MS, rankingMs: RANKING_MS, signalMs: SIGNAL_MS,
    trackerMs: TRACKER_MS, trackerWallets: TRACKER_WALLETS, premiumBudget: PREMIUM_BUDGET,
    basicBudget: BASIC_BUDGET, paperWallet: PAPER_WALLET, paperWalletBalanceSufficient: true,
    policyVersion: PAPER_POLICY_VERSION, configHash, node: process.version,
    policy: {
      signalMinWallets: SIGNAL_MIN_WALLETS, signalMinUsd: SIGNAL_MIN_USD,
      trackerMinUsd: TRACKER_MIN_USD, maxSourceLagMs: MAX_SOURCE_LAG_MS,
      rankingMaxAgeMs: RANKING_MAX_AGE_MS,
      rankingMinLiquidityUsd: RANKING_MIN_LIQUIDITY_USD,
      rankingMinVolumeUsd: RANKING_MIN_VOLUME_USD,
      rankingMaxMarketCapUsd: RANKING_MAX_MARKET_CAP_USD,
      rankingMinHolders: RANKING_MIN_HOLDERS,
      rankingMinTransactions: RANKING_MIN_TRANSACTIONS,
      rankingMinBuyRatio: RANKING_MIN_BUY_RATIO,
      rankingWarmStartMax: RANKING_WARM_START_MAX,
      observeUnknownRanking: OBSERVE_UNKNOWN_RANKING,
      maxPriceImpactPercent: MAX_PRICE_IMPACT_PERCENT,
      maxEntryOverheadPct: MAX_ENTRY_OVERHEAD_PCT,
      minPreflightRoundTripPnlPct: MIN_PREFLIGHT_ROUNDTRIP_PNL_PCT,
      sellConfirmationMs: SELL_CONFIRM_MS,
      maxSellProofDropPct: MAX_SELL_PROOF_DROP_PCT,
      maxDetectToBuildMs: MAX_DETECT_TO_BUILD_MS,
      workerConcurrency: WORKER_CONCURRENCY,
      maxEntryOverheadLamports: MAX_ENTRY_OVERHEAD_LAMPORTS,
      allowUnknownRisk: ALLOW_UNKNOWN_RISK,
      slippagePercent: config.okx.slippagePercent,
      exitFeeFloorLamports: EXIT_FEE_FLOOR_LAMPORTS,
      unknownRiskEngine: "MICINCLOUD_SETUP",
      entryLane: "toplist-only",
      shadowLanes: ["trenches", "signal", "tracker"],
      adaptiveScalp: {
        strategy: "V6_FAST_RECHECK_TP5_SL8_T60",
        rankingRecheckMs: RANKING_RECHECK_MS,
        rankingMaxAcceptPerPass: RANKING_MAX_ACCEPT_PER_PASS,
        pollMs: SCALP_POLL_MS,
        takeProfitPct: SCALP_TAKE_PROFIT_PCT,
        hardStopPct: SCALP_HARD_STOP_PCT,
        maxHoldMs: SCALP_MAX_HOLD_MS,
        executionDelayMs: SCALP_EXECUTION_DELAY_MS,
        maxConsecutiveNoRoute: SCALP_MAX_NO_ROUTE,
        noRouteRetryMs: SCALP_NO_ROUTE_RETRY_MS,
      },
    } });

  // Resume work that was persisted before a crash/restart.
  workQueue.push(...Object.keys(state.pendingCandidates)); kickWorkers();
  await Promise.all([scanOnce(), rankingOnce(), signalOnce(), trackerOnce()]);
  await settleDue();
  await checkAdaptiveDue();

  const scanTimer = setInterval(() => void scanOnce(), SCAN_MS);
  const rankingTimer = setInterval(() => void rankingOnce(), RANKING_MS);
  const signalTimer = setInterval(() => void signalOnce(), SIGNAL_MS);
  const trackerTimer = setInterval(() => void trackerOnce(), TRACKER_MS);
  const settleTimer = setInterval(() => void settleDue(), 2_000);
  const scalpTimer = setInterval(() => void checkAdaptiveDue(), 1_000);
  const statusTimer = setInterval(() => {
    const positions = Object.values(state.positions);
    const status = { open: positions.filter((p) => p.status === "OPEN").length,
      closed: positions.filter((p) => p.status === "CLOSED").length,
      scalpMonitoring: positions.filter((p) => p.adaptive?.status === "MONITORING").length,
      scalpExited: positions.filter((p) => p.adaptive?.status === "EXITED").length,
      pendingCandidates: Object.keys(state.pendingCandidates).length,
      activeWorkers,
      premiumUsed: state.budget.premiumUsed, premiumBudget: PREMIUM_BUDGET,
      basicUsed: state.budget.basicUsed, basicBudget: BASIC_BUDGET,
      pausedSources: [...sourceRetryAt.entries()].filter(([, at]) => at > Date.now()).map(([source, retryAt]) => ({ source, retryAt })) };
    ledger.append({ type: "STATUS", ...status });
    ui.info(`[okx-paper] open=${status.open} closed=${status.closed} queue=${status.pendingCandidates} premium=${status.premiumUsed}/${PREMIUM_BUDGET} basic=${status.basicUsed}/${BASIC_BUDGET}`);
  }, 60_000);

  const stop = () => {
    if (stopping) return; stopping = true;
    clearInterval(scanTimer); clearInterval(rankingTimer); clearInterval(signalTimer); clearInterval(trackerTimer);
    clearInterval(settleTimer); clearInterval(scalpTimer); clearInterval(statusTimer);
    persist(); ledger.append({ type: "RUN_STOP", pid: process.pid, pendingCandidates: Object.keys(state.pendingCandidates).length,
      openPositions: Object.values(state.positions).filter((p) => p.status === "OPEN").length });
    releaseLock(); process.exit(0);
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  ui.pass(`[okx-paper] ${OKX_STRICT_EPOCH} v${PAPER_POLICY_VERSION} running · ${SIZE_SOL} SOL · unsigned only · toplist entries + shadow radar/signal`);
}

void main().catch((error) => {
  try { ledger.append({ type: "RUN_FATAL", error: (error as Error).message }); } catch { /* ledger itself may be the failure */ }
  releaseLock();
  console.error(`[okx-paper] fatal: ${(error as Error).message}`);
  process.exit(1);
});
