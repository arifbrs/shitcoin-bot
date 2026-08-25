import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "./config.js";
import { tokenBalanceOfOwner, totalSupplyUi, devTradeHistory, bondingCurvePriceSol, bondingCurvePricesMulti, holderCountWithSource, detectLaunchBundle, creatorFunders, quoteMintIsSol, pooledRpc } from "./safety/onchain.js";
import type { CurveState } from "./safety/onchain.js";
import { DevWatcher } from "./discovery/devwatch.js";
import { TradeStream } from "./discovery/tradestream.js";
import { pumpTradeStats, latestPriceSol } from "./safety/pump-trades.js";
import { pumpCandles } from "./safety/pump-candles.js";
import { jupiterSellSol, solPriceUsd } from "./execution/jupiter.js";
import { simulateBuyMainnet, devnetMirror } from "./execution/executor.js";
import { bridgeOpen, bridgeSellFraction, bridgeClose, bridgeStart, bridgeStop } from "./execution/live-bridge.js";
import { applyExecutionRealism, realismBanner } from "./execution/exec-realism.js";
import { assessBuySimulation, lateEnrichmentAction } from "./execution/semantics.js";
import {
  clampedScaleSellQty,
  counterfactualPostBuyReserves,
  curveEntryFill,
  curveExitProceedsSol,
  curveFeeFrac,
  curveSellSolGross,
  gasPerSideSol,
  launchpadFeePct,
  rebaseOverlayForAdoptedFill,
  replayObservedCurveDelta,
  syntheticAmmExitProceedsSol,
  syntheticAmmReservesFromQuote,
} from "./execution/curve-math.js";
import { feelingEnabled, judgeVibe, feelingHealth } from "./execution/feeling-agent.js";
import { readControl, writeControl, liveRisk } from "./control.js";
import { recordOutcome, assessActors } from "./memory/actor-memory.js";
import { classifySetup } from "./discovery/setup-filter.js";
import { gmgnEnabled, gmgnTokenInfo, gmgnTokenSecurity, gmgnCreatedTokens } from "./discovery/gmgn.js";
import { dexTokenPairs } from "./discovery/dexscreener.js";
import { logRecord, ui, logIntegrity } from "./util/log.js";
import { notify } from "./util/notify.js";
import { ExposureReservationBook } from "./util/exposure-reservations.js";
import type { Candidate } from "./types.js";

/** How often verifyLedger() logs a healthy heartbeat, so silence-means-dead is detectable. */
const INTEGRITY_BEAT_MS = 3_600_000;

export {
  clampedScaleSellQty,
  syntheticAmmExitProceedsSol,
  syntheticAmmReservesFromQuote,
} from "./execution/curve-math.js";

/** IMMUTABLE launch snapshot frozen at the entry decision — data available THEN, never mutated
 *  after (post-entry data goes to telemetry, not here). Kills target leakage. (owner spec #2) */
interface EntrySnapshot {
  decisionAt: number; decisionLatencyMs?: number;
  setupVerdict?: string; setupConfidence?: number; setupEvidence?: string[]; setupMissing?: string[];
  holders?: number | null; mcUsd?: number | null; organic?: number | null;
  // Entry ini lolos lewat cadangan kurva karena hitungan holder tak terbaca. Wajib ada di
  // snapshot: tanpa penanda, entry yang diloloskan kelonggaran menyatu dengan yang lolos
  // verifikasi penuh, dan kelonggaran itu tidak akan pernah bisa dinilai terpisah.
  holderFallbackUsed?: boolean;
  sniperPct?: number | null; bundlerPct?: number | null; devPct?: number | null;
  clusterVerdict?: string | null; devFundedBuyers?: number | null;
  actorRiskProb?: number | null; actorConfidence?: number | null;
  hasSocials?: boolean | null; execStage?: string | null; initialBuySol?: number | null;
}

interface Position {
  candidate: Candidate;
  entryPriceUsd: number;
  entryMcSol?: number; // RELIABLE entry market cap from the curve reserves (price×supply) — 100% coverage, not jupiter-dependent
  entryMcUsd?: number; // entryMcSol × sol-price-at-entry (for the MC-vs-outcome study — the <$3k rug-zone question)
  entryRealSol?: number; // REAL SOL paid into the curve at entry (0 on an untouched launch) — the unconfoundable demand signal
  sizeSol: number;
  openedAt: number;
  peakPriceUsd: number;
  armed: boolean; // TRUE once the dynamic trail is actually armed (peak ≥ the first band)
  devEntryBalance?: number | null; // creator's token holding at entry (buy-back/dump baseline)
  supply?: number | null; // total supply, to measure the dev's holding as a fraction
  devBuyBack: boolean; // creator has added to their holding since entry
  devOnlyBuys: boolean; // creator's tx history shows only buys, never sells (strong conviction)
  devDumped: boolean; // creator sold — a WARNING for the agent to weigh, no longer an auto-exit
  lastPriceUsd?: number; // most recent observed price (for live unrealized P&L)
  lastPnlPct?: number; // most recent unrealized P&L, net of modeled cost
  priceMode: "sol" | "usd"; // sol = bonding-curve pricing; usd = DexScreener
  bondingCurveKey?: string; // for live on-chain bonding-curve price reads
  /**
   * STABLE TRADE IDENTITY. Every record belonging to one position — OPEN, PARTIAL, CLOSE,
   * ticks, agent decisions, post-exit samples and the post-exit summary — carries this id.
   *
   * Mint is NOT an identity: the same mint can be entered more than once, and keying anything
   * by mint silently merges two different trades (and, in the post-exit tracker, made a
   * re-entry overwrite the previous one's tracking state). Analysis must group by tradeId.
   */
  tradeId: string;
  decisionId?: string; // id of the decision that produced this trade (candidate → gate → open)
  costPct: number; // MEASURED round-trip cost (fees + real price impact), fixed at entry
  originalSizeSol: number; // position size at entry (partial fractions are of this)
  // NOTE: `partialsTaken` was frozen at 0 — it was initialised at open and never incremented,
  // because the laddered scale-out tracks progress in `scaleTier` instead. The dashboard read it
  // as "take-profit progress", so the console showed 0 partials even on positions that had sold
  // three tiers. Kept ONLY so old persisted snapshots still parse; scaleTier is the truth.
  partialsTaken: number;
  partialPnlSol: number; // realized SOL from partial sells so far (added to final close)
  partialPnlIncludedInPrimary?: number; // audit P0-2 + manual-close-always-counts: how much of partialPnlSol already made it into the PRIMARY ledger (vs still pending, e.g. banked while execStage was would-fail)
  priceFailCount: number; // consecutive failed price reads (guards false LIQUIDITY_GONE)
  peakVSol: number; // highest curve SOL reserve seen (activity high-water mark)
  entryVSol: number; // curve SOL reserve at entry (baseline for development check)
  // FAITHFUL fill accounting (sol/bonding-curve mode): the actual token quantity bought
  // and the entry/last reserve state, so exit P&L = real curve-proceeds, not spot-ratio.
  tokenQty?: number; // tokens actually received at entry (constant-product buy); reduced after a scale-out
  originalTokenQty?: number; // tokens at entry BEFORE any partial — for replay-harness path valuation
  entryVTokens?: number; // curve token reserve at entry
  lastVSol?: number; // most recent curve SOL reserve (exit sell-walk uses this)
  lastRealSol?: number; // most recent REAL sol reserve — caps exit proceeds (can't take out more than there)
  lastVTokens?: number; // most recent curve token reserve
  /** Raw mainnet state used only to replay EXTERNAL deltas. Mainnet excludes our paper trades. */
  lastObservedVSol?: number;
  lastObservedRealSol?: number;
  entrySolIntoCurve?: number; // net SOL our hypothetical buy added after fee/gas/ATA
  deRisked?: boolean; // TRUE only once cumulative partial PROCEEDS ≥ original stake (true principal-first, owner spec)
  recoveredSol?: number; // cumulative GROSS SOL proceeds banked from partials (for the deRisked test)
  scaleTier?: number; // highest laddered scale-out tier index already sold (−1/undefined = none)
  execStage?: string; // theoretical | tx-built | would-fail | executable — how REAL this fill is (#2)
  entrySnapshot?: EntrySnapshot; // FROZEN at entry — data available AT decision time only (no leakage)
  peakExecProceeds?: number; // highest EXECUTABLE sell value seen (SOL) — trailing trails from THIS, not the marginal spot peak (#6)
  peakExecAtMs?: number; // when that executable high was set — drives fade tightening (resets on every new high)
  // STICKY development flag. `execPeakGainPct` is derived from peakExecProceeds, which the
  // scale-out ladder deliberately RESETS to undefined so the trail can re-seed on the smaller
  // remaining position. That reset also re-based the NO-DEVELOPMENT test, which reads the same
  // number — so a de-risked runner's peak fell back under the 5% floor while `heldMs` kept
  // counting from the original open, and the rule executed it as "never developed". Measured
  // 2026-08-11: 47 such closes, several already de-risked with net up to +129%. This flag records
  // the fact of development once and never unsets, so the "exempt forever" promise holds across
  // every partial. It must NOT be used for the trail — re-seeding there is intended.
  everDeveloped?: boolean;
  peakAtSec?: number; // seconds-since-open when the ATH was reached — the minute-to-peak signal (owner's idea: avg time-to-ATH → hold/TP benchmark)
  gradProceedsSol?: number; // VERIFIED graduation proceeds from a real Jupiter AMM sell quote (else undefined → estimate + UNVERIFIED)
  gradSyntheticNetReserves?: boolean; // synthetic AMM reserves reproduce Jupiter NET route output; never charge venue fee again
  lastGradQuoteMs?: number; // audit P1-7: throttle — a fresh Jupiter quote in EVERY 4s tick was the #1 cause of the tick blowing its interval (measured up to 147s)
  graduated: boolean; // passed the wait-and-see probation (showed real development)
  lastBusyMs: number; // last time the curve made a new activity high (rame)
  lastVibeMs: number; // last time the Feeling Agent judged this position (throttle)
  lastDevCheckMs?: number; // last polled dev balance (throttle — the WS watcher is the real-time path)
  devLastBalance?: number | null; // dev's most recently observed token balance (models their sell ahead of ours)
}

const STATE_PATH = join(config.logDir, "positions.json");

/** Fixed SOL gas (base tx + priority tip) as a % of the trade size, PER SIDE. */
function fixedGasPctPerSide(sizeSol: number): number {
  if (sizeSol <= 0) return 0;
  return ((config.risk.baseTxSol + config.exec.priorityFeeSol) / sizeSol) * 100;
}

/** Round-trip cost (%) for a swing/AMM trade when no live impact figure exists. */
function fallbackCostPct(liquidityUsd?: number, sizeSol: number = config.risk.paperTradeSizeSol): number {
  const slip = config.risk.fallbackSlipByLiquidity.find((b) => (liquidityUsd ?? 0) < b.underUsd)?.slipPct ?? 2;
  // AMM pool fee + fixed gas, both sides, on top of the slippage estimate.
  return slip + (config.risk.ammFeePct + fixedGasPctPerSide(sizeSol)) * 2;
}

/**
 * EXACT bonding-curve round-trip cost for a fast-follow trade of `sizeSol` on `pool`.
 * On a virtual x*y=k curve, buying `solIn` moves the average price by exactly
 * solIn/vSolReserves — no guessing. Round trip pays, on EACH side:
 * curve slippage + the LAUNCHPAD's own protocol fee (pump 0.95% / Meteora ~1% / etc.)
 * + the PumpPortal routing fee + fixed SOL gas. Fee is per-venue, not always pump.fun.
 */
/** vSol saat peluncuran pump.fun — selalu tepat 30 (MC 27,96◎). Dasar hitung pembelian non-dev. */
const PUMP_LAUNCH_VSOL = 30;

function bondingCurveCostPct(vSol: number | undefined, sizeSol: number, pool?: string): number {
  if (!vSol || vSol <= 0) return fallbackCostPct(undefined, sizeSol);
  const oneSideImpactPct = (sizeSol / vSol) * 100;
  const perSide = oneSideImpactPct + launchpadFeePct(pool) + config.risk.swapFeePct + fixedGasPctPerSide(sizeSol);
  // + one-off ATA rent, charged once on the buy (measured 0.00204◎ ≈ 4.1% of a 0.05◎ stake).
  const ataPct = sizeSol > 0 ? (config.risk.ataRentSol / sizeSol) * 100 : 0;
  return perSide * 2 + ataPct;
}

/**
 * Dynamic trailing band for a given PEAK gain. Returns the pullback % that triggers a
 * profit-lock sell, picked from the highest threshold the peak gain has reached — the
 * band loosens as gains grow (bank small winners tight, let mega-runners ride). Returns
 * null below the first threshold (not armed yet — a coin that never pumped isn't trailed).
 */
function dynamicTrailPct(peakGainPct: number): number | null {
  let trail: number | null = null;
  for (const t of config.risk.dynamicTrail) if (peakGainPct >= t.gain) trail = t.trail;
  return trail;
}

/**
 * Simulated positions with an ASYMMETRIC exit model built for memecoins:
 * let winners run via a trailing stop (capture 10-100x), cut losers fast via a
 * hard stop + short max-hold. Every P&L is NET of modeled fees + slippage, so
 * the numbers are honest (RESEARCH.md validity note). No wallet, ever.
 */

/** Parser revision stamped on every outcome, so a re-parse can be told from a re-measure. */
export const CURVE_PARSER_VERSION = "v4-quote-layout-2026-07-26";

/**
 * Protocol/curve regime for one position. NOT a quality judgement — a routing label, so that
 * standard curves, graduated AMM positions and anything we cannot yet classify are never pooled
 * into one expectancy. `UNKNOWN_REGIME` means unclassified, NOT broken: pump.fun now also has
 * buy_v2/sell_v2, non-SOL quote mints and Mayhem mode, and 33% of sampled live curves already
 * sit outside the standard reserve ratio. Primary reporting must exclude UNKNOWN_REGIME rather
 * than silently average it in.
 */
function regimeOf(pos: { graduated?: boolean; priceMode: string; candidate: { pool?: string; isMayhemMode?: boolean; quoteMint?: string } }): string {
  if (pos.graduated) return "GRADUATED_AMM";
  if (pos.priceMode !== "sol") return "USD_QUOTE";
  if (pos.candidate.isMayhemMode) return "PUMP_CURVE_MAYHEM";
  if (!quoteMintIsSol(pos.candidate.quoteMint)) return "NON_SOL_QUOTE";
  const pool = (pos.candidate.pool ?? "").toLowerCase();
  if (pool === "pump") return "PUMP_CURVE_V1";
  if (pool) return `POOL_${pool.toUpperCase()}`;
  return "UNKNOWN_REGIME";
}

export interface OpenResult {
  opened: boolean;
  code:
    | "OPENED"
    | "CAPACITY_OR_DUPLICATE"
    | "SETUP_TOXIC"
    | "SETUP_UNKNOWN"
    | "CLUSTER_CAP"
    | "REENTRY_BLOCK"
    | "COPYCAT"
    | "BROKE"
    | "NO_PRICE"
    | "NO_DEMAND"
    | "HOLDER_DATA_UNAVAILABLE"
    | "STALE_ENTRY"
    | "BUY_SIM_WOULD_FAIL"
    | "BUY_SIM_UNAVAILABLE"
    | "BUY_SIM_NEEDS_FUNDING"
    | "BUY_SIM_BUILD_UNAVAILABLE"
    | "ENTRY_MC_BAND" | "ENTRY_DEV_BUY"
    | "UNSUPPORTED_REGIME";
  detail?: string;
}

export class PaperTrader {
  private onSetupVerdict?: (mint: string, verdict: string, confidence?: number) => void; // stamp the observatory when we classify
  setSetupVerdictHook(fn: (mint: string, verdict: string, confidence?: number) => void): void { this.onSetupVerdict = fn; }
  private positions = new Map<string, Position>();
  private readonly clusterReservations = new ExposureReservationBook();
  // SUM of per-trade percentages — NOT a portfolio return. Kept only because the persisted
  // snapshot carries it; never display it as "cumulative %".
  private realizedPnlPct = 0;
  private realizedPnlSol = 0; // concrete cumulative profit/loss in SOL — EXECUTABLE ONLY (see below)
  private wins = 0;
  private losses = 0;
  // AUDIT P0-2 (2026-07-27): a "would-fail" buy (proven by mainnet simulation) could never have
  // actually spent SOL on real chain — the tx would revert before landing. Booking its paper P&L
  // into the primary ledger above therefore models a trade that never happened. `wins`/`losses`/
  // `realizedPnlSol(Pct)` above now count EXECUTABLE closes only (execStage === "executable");
  // everything else (would-fail / theoretical / tx-built / unresolved) still gets recorded here so
  // "what if it had filled anyway" stays answerable, but it must never drive tuning or bankroll math.
  private hypotheticalRealizedPnlPct = 0;
  private hypotheticalRealizedPnlSol = 0;
  private hypotheticalWins = 0;
  private hypotheticalLosses = 0;
  // AUDIT P0-1 SAFEGUARD (2026-07-27): the night of 2026-07-27 saw 264 consecutive would-fail
  // buy simulations (00:26-02:59 UTC, IncorrectProgramId — traced to PumpPortal's tx builder,
  // not our code) go undetected until a manual audit found it hours later. This alerts the
  // first time it happens again instead of waiting for someone to notice the numbers look off.
  private consecutiveWouldFail = 0;
  private lastWouldFailAlertAt = 0;
  // Re-entry memory: every mint we've closed, why, when, and how many times we've
  // touched it. Drives the smart re-entry guard (never re-buy a corpse).
  private exitHistory = new Map<string, { reason: string; at: number; attempts: number; lastPeakVSol: number }>();
  private lastDevnetMs = 0; // throttle: mirror at most one trade to a real devnet tx per window
  private recentSymbols = new Map<string, number>(); // symbol -> last-opened ms (copycat/spam guard)
  private runNumber = 1; // current 1-SOL trial (incremented on auto-reset)
  // Post-exit price tracking: after a close we keep sampling the token to learn whether
  // the exit was premature (did it run after we sold?) and the ideal hold time.
  /**
   * Keyed by tradeId, NOT mint. Keying by mint let a re-entry on the same token overwrite the
   * previous trade's tracking state, silently destroying one observation and attributing its
   * samples to the other.
   *
   * `summarised` is the idempotency flag: exactly one summary per tradeId, ever.
   */
  private postExit = new Map<string, {
    tradeId: string; decisionId?: string; mint: string; symbol?: string; reason: string;
    exitTs: number; exitPriceSol: number; exitPnlPct: number; heldSec: number;
    peakPct: number; peakAtSec: number; samples: number; summarised: boolean;
    policyId: string; armId: string; regimeId: string;
  }>();
  /**
   * Re-entrancy guard. `trackPostExit` awaits a network read PER TRACKED TOKEN, so a slow pass
   * routinely outlives the interval that scheduled it. Without this, a second pass walked the
   * same map concurrently: both logged samples for the same second, and both could reach the
   * window-expiry branch before either deleted the entry — which is why 1,638 (mint, secSinceExit)
   * pairs were duplicated, one of them 92 times over.
   */
  private postExitRunning = false;
  /** tradeIds already summarised — survives entry deletion, so a late pass cannot re-emit. */
  private postExitDone = new Set<string>();
  private postExitTimer?: ReturnType<typeof setInterval>;
  // Learned winner profile (pattern memory): avg entry conditions of coins that peaked
  // ≥100%. Refreshed lazily from the patterns log; fed to the agent as an analysis prior.
  private tradeSeq = 0; // monotonic within a process — combined with time+random for a stable unique tradeId
  private runMinBalanceSol = config.risk.startingFloatSol; // deepest balance this run (drawdown → live-float planning)

  /** Current paper balance = starting float + realized P&L (equity that has settled). */
  private balanceSol(): number {
    return config.risk.startingFloatSol + this.realizedPnlSol;
  }

  /** Capital tied up in currently-open positions. */
  private deployedSol(): number {
    let s = 0;
    for (const p of this.positions.values()) s += p.sizeSol;
    return s;
  }

  /** SOL reserved by opens that are in flight but not yet committed to `positions` (race guard). */
  private pendingSol = 0;

  /** Free capital available to open a new position (balance − deployed − in-flight reservations). */
  private freeSol(): number {
    return this.balanceSol() - this.deployedSol() - this.pendingSol;
  }

  /**
   * Position size for a new entry. Fixed unless COMPOUND=true, in which case it
   * scales with the balance — but is HARD-capped by the bonding curve's own
   * liquidity (maxCurveFracPct of vSol), because size beyond a few % of a tiny
   * fresh curve is destroyed by slippage. This cap is the real ceiling on
   * memecoin sniping: your account can grow, but each individual bet can't.
   */
  private sizeFor(c: Candidate): number {
    // Base size: fixed (live-tunable from the console), or compounding with balance.
    let size = config.risk.compound
      ? (Math.max(0, this.balanceSol()) * config.risk.riskPerTradePct) / 100
      : liveRisk("paperTradeSizeSol", config.risk.paperTradeSizeSol, [0.01, 5]);
    // LIQUIDITY CEILING (#7) — applies in BOTH modes now (was compound-only). Size beyond a
    // few % of a thin fresh curve is destroyed by slippage; even a fixed 0.1 SOL must be
    // capped when the curve is tiny, or the faithful proceeds math shows a huge self-impact
    // loss the strategy never intended to take.
    if (c.bcVSol && c.bcVSol > 0) {
      size = Math.min(size, (c.bcVSol * config.risk.maxCurveFracPct) / 100);
    }
    return Math.max(0.01, size);
  }
  private fastTimer?: ReturnType<typeof setInterval>;
  private slowTimer?: ReturnType<typeof setInterval>;
  // Real-time dev-wallet watcher (sub-second push on any dev transaction).
  private watcher = new DevWatcher((creator) => void this.onDevActivity(creator));
  private tradeStream = new TradeStream(); // live per-token crowd stats (who's buying)

  /**
   * Rebuild the "already summarised" set from the post-exit log itself. A restart must not
   * re-emit a summary for a trade that already has one — the log IS the durable state, so
   * reconstructing from it needs no extra state file that could drift out of sync with it.
   */
  private hydratePostExitDone(): void {
    try {
      for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("post-exit") && x.endsWith(".jsonl"))) {
        for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
          if (!line.includes('"summary"')) continue;
          try { const r = JSON.parse(line) as { type?: string; tradeId?: string };
            if (r.type === "summary" && r.tradeId) this.postExitDone.add(r.tradeId);
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* no log dir yet */ }
  }

  start(): void {
    this.hydratePostExitDone();
    this.load();
    // Re-arm real-time dev watches for any restored open positions.
    for (const pos of this.positions.values()) {
      if (pos.candidate.creator) this.watcher.watch(pos.candidate.creator);
      this.tradeStream.watch(pos.candidate.mint); // resume crowd streaming for restored positions
    }
    // Fast-follow reacts on a tight loop (bonding-curve reads are cheap) so the
    // stop-loss fires near its threshold instead of slipping on a fast dump.
    // Swing polls slower (DexScreener rate limits).
    this.fastTimer = setInterval(() => void this.tick("fast-follow"), 4_000);
    if (config.postExit.enabled) this.postExitTimer = setInterval(() => void this.trackPostExit(), config.postExit.sampleMs);
    this.commandTimer = setInterval(() => this.pollCommand(), 2_000); // console command bus
    // Continuous ledger audit: the recorded numbers must reconcile with the booked P&L, always.
    this.integrityTimer = setInterval(() => this.verifyLedger(), 60_000);
    // Say it out loud, once. A ledger corrected to real execution and a raw one look identical
    // on screen, and the whole failure this fixes was a number nobody knew to distrust.
    const banner = realismBanner();
    if (banner) ui.info(banner);
    // LIVE BRIDGE. Disarmed unless BOTH locks are open. The probe is what lets its orphan
    // sweep tell "the brain still holds this" from "there is a real bag nobody owns" — the
    // difference between a tracked position and an abandoned one.
    bridgeStart(
      (tradeId) => {
        for (const p of this.positions.values()) if (p.tradeId === tradeId) return true;
        return false;
      },
      // REAL FILL WINS. Once live is armed there is no simulation to speak of — this engine is
      // the strategy, and the bridge is its hands. The only thing still modelled after a live
      // buy was the quantity: `curveEntryFill()` computes what the buy WOULD have got, while the
      // chain says what it DID get (slippage, a curve that moved in the 3-13s before landing, a
      // clip resized by compounding). Leaving the model in place meant every exit number
      // described a position nobody held. Now the position adopts reality the moment it lands.
      (fill) => {
        for (const pos of this.positions.values()) {
          if (pos.tradeId !== fill.tradeId) continue;
          if (!(fill.tokens > 0) || !(fill.spentSol > 0)) return;
          const before = { sizeSol: pos.sizeSol, tokenQty: pos.tokenQty ?? 0 };
          // RE-BASE THE COUNTERFACTUAL OVERLAY (P0, measured 2026-08-22). Swapping in the real
          // basis while the overlay still carried the PAPER entry's curve impact produced
          // fantasy executable marks: NEVER's exec peak jumped to +1668% (trail band loosened
          // to its top rung, winner gave everything back) purely because the cost basis shrank
          // ~12x under an unchanged proceeds number. The overlay must describe the position we
          // ACTUALLY hold: subtract the hypothetical paper buy's impact, add the real fill's.
          let overlayRebased = false;
          if (pos.lastVSol != null && pos.lastVTokens != null && pos.lastRealSol != null) {
            const next = rebaseOverlayForAdoptedFill(
              { vSol: pos.lastVSol, vTokens: pos.lastVTokens, realSol: pos.lastRealSol },
              { sizeSol: before.sizeSol, tokenQty: before.tokenQty },
              { spentSol: fill.spentSol, tokens: fill.tokens, pool: pos.candidate.pool },
            );
            pos.lastVSol = next.vSol;
            pos.lastVTokens = next.vTokens;
            pos.lastRealSol = next.realSol;
            overlayRebased = true;
          }
          // Scale-outs are fractions of the ORIGINAL, so both must move together or a partial
          // would sell a fraction of a quantity that no longer exists.
          pos.sizeSol = fill.spentSol;
          pos.originalSizeSol = fill.spentSol;
          pos.tokenQty = fill.tokens;
          pos.originalTokenQty = fill.tokens;
          // The high-water mark was tracked under the old (paper-scale) basis; keep it and the
          // trail re-seeds from the first honest post-adoption mark instead of inheriting fantasy.
          pos.peakExecProceeds = undefined;
          logRecord("events", {
            type: "live-fill-adopted", tradeId: pos.tradeId, mint: pos.candidate.mint, symbol: pos.candidate.symbol,
            modelledSizeSol: Number(before.sizeSol.toFixed(6)), realSizeSol: Number(fill.spentSol.toFixed(6)),
            modelledTokens: Number(before.tokenQty.toFixed(2)), realTokens: Number(fill.tokens.toFixed(2)),
            qtyDriftPct: before.tokenQty > 0 ? Number((((fill.tokens - before.tokenQty) / before.tokenQty) * 100).toFixed(2)) : null,
            overlayRebased,
            hwmReset: true,
            cfg: configHash,
          });
          this.save();
          return;
        }
      },
    );
  }

  private commandTimer?: ReturnType<typeof setInterval>;
  private integrityTimer?: ReturnType<typeof setInterval>;
  /** Last time verifyLedger() emitted its healthy heartbeat — see the beat in verifyLedger(). */
  private lastIntegrityBeatMs = 0;
  /** Execute a one-shot console command (flatten / close / reset-run) exactly once. */
  private pollCommand(): void {
    const c = readControl();
    const cmd = c.command;
    if (!cmd || !cmd.id || cmd.id <= (c.lastCommandId ?? 0)) return; // nothing new
    try {
      if (cmd.action === "flatten") {
        const n = this.positions.size;
        for (const [mint, pos] of [...this.positions]) this.close(mint, pos, pos.lastPriceUsd ?? pos.entryPriceUsd, "MANUAL_FLATTEN");
        ui.warn(`[control] FLATTEN — closed ${n} position(s) by console command`);
      } else if (cmd.action === "close" && cmd.mint) {
        const pos = this.positions.get(cmd.mint);
        if (pos) { this.close(cmd.mint, pos, pos.lastPriceUsd ?? pos.entryPriceUsd, "MANUAL_CLOSE"); ui.warn(`[control] CLOSE ${pos.candidate.symbol ?? cmd.mint} by console command`); }
      } else if (cmd.action === "reset-run") {
        for (const [mint, pos] of [...this.positions]) this.close(mint, pos, pos.lastPriceUsd ?? pos.entryPriceUsd, "MANUAL_FLATTEN");
        ui.warn(`[control] RESET-RUN requested by console`);
      }
    } catch (e) { ui.warn(`[control] command failed: ${(e as Error).message}`); }
    writeControl({ command: null, lastCommandId: cmd.id }); // mark done so it never re-runs
  }

  stop(): void {
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.commandTimer) clearInterval(this.commandTimer);
    if (this.integrityTimer) clearInterval(this.integrityTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    if (this.postExitTimer) clearInterval(this.postExitTimer);
    this.watcher.stop();
    this.tradeStream.stop();
    bridgeStop();
    this.save(); // persist open positions so a restart doesn't orphan them
  }

  canOpen(): boolean {
    // No fixed slot cap — CAPITAL decides. Open whenever free balance covers the
    // next trade size; otherwise the bot simply WAITS until an open position
    // closes and frees SOL, then resumes. The concurrent-position count is thus
    // naturally bounded by (free float ÷ size), not an arbitrary number.
    const nextSize = config.risk.compound
      ? Math.max(0.01, (Math.max(0, this.balanceSol()) * config.risk.riskPerTradePct) / 100)
      : config.risk.paperTradeSizeSol;
    return this.freeSol() >= nextSize;
  }

  /**
   * Smart re-entry gate. A mint we've closed before may be re-entered, but only
   * with a stricter, more-valid analysis than a first-time coin:
   *   - terminal exit (dev-dump / rug / drained / stopped-out) → NEVER again
   *   - too soon after a soft exit → wait out the cooldown (no whipsaw)
   *   - touched too many times already → stop chasing it
   *   - otherwise it must clear a HIGHER score AND show FRESH momentum (a new
   *     activity high beyond where we left it) — proof the hype genuinely revived.
   * Returns null to allow, or a string reason to block.
   */
  private reentryBlock(c: Candidate, score: number): string | null {
    const h = this.exitHistory.get(c.mint);
    if (!h) return null; // never traded before — normal first entry
    if ((config.risk.reentry.blockReasons as readonly string[]).includes(h.reason)) return `dead (${h.reason}, no re-buy)`;
    if (h.attempts >= config.risk.reentry.maxAttempts) return `touched ${h.attempts}x (max ${config.risk.reentry.maxAttempts})`;
    const sinceMs = Date.now() - h.at;
    if (sinceMs < config.risk.reentry.cooldownMs) return `cooldown ${Math.round((config.risk.reentry.cooldownMs - sinceMs) / 60_000)}m left`;
    const bar = config.risk.minScoreToOpen + config.risk.reentry.extraScore;
    if (score < bar) return `score ${score} < re-entry bar ${bar}`;
    // Fresh-momentum proof: current activity must exceed the level at last exit.
    const nowVSol = c.bcVSol ?? 0;
    if (h.lastPeakVSol > 0 && nowVSol > 0 && nowVSol <= h.lastPeakVSol) return `no revival (vSol ${nowVSol.toFixed(1)} ≤ last ${h.lastPeakVSol.toFixed(1)})`;
    return null; // stronger than a fresh coin AND revived — allow the re-entry
  }

  async open(c: Candidate, score = 100): Promise<OpenResult> {
    if (!this.canOpen() || this.positions.has(c.mint)) {
      return { opened: false, code: "CAPACITY_OR_DUPLICATE" };
    }

    // ── SETUP CLASSIFIER (deterministic, the entry decision — owner spec) ──
    // Classify TOXIC/CLEAN/UNKNOWN from launch data. TOXIC → hard skip. UNKNOWN → skip unless
    // we allow sniping the unknown (small bounded size, many shots). Momentum is NOT consulted.
    const setup = classifySetup(c);
    c.setup = setup;
    this.onSetupVerdict?.(c.mint, setup.verdict, setup.confidence); // stamp observatory → shadow setup ≠ blind (audit fix)
    if (setup.verdict === "TOXIC") {
      ui.reject(`[paper] TOXIC SKIP ${c.symbol ?? c.mint} — ${setup.evidence.join(", ")}`);
      return { opened: false, code: "SETUP_TOXIC", detail: setup.evidence.join(",") };
    }
    if (setup.verdict === "UNKNOWN" && !config.setupFilter.snipeUnknown) {
      ui.warn(`[paper] UNKNOWN SKIP ${c.symbol ?? c.mint} — missing ${setup.missing.join(",")}`);
      return { opened: false, code: "SETUP_UNKNOWN", detail: setup.missing.join(",") };
    }
    // EXPOSURE CAP: don't load many open positions from ONE creator/funder cluster.
    const clusterIds = [c.creator, ...(c.creatorFunders ?? [])].filter(Boolean) as string[];
    const openFromCluster = [...this.positions.values()].filter((p) => {
      const ids = [p.candidate.creator, ...(p.candidate.creatorFunders ?? [])].filter(Boolean) as string[];
      return ids.some((id) => clusterIds.includes(id));
    }).length + this.clusterReservations.overlappingCount(clusterIds);
    if (openFromCluster >= config.maxPerActorCluster) {
      ui.warn(`[paper] CLUSTER CAP ${c.symbol ?? c.mint} — already ${openFromCluster} open from this actor cluster`);
      return { opened: false, code: "CLUSTER_CAP", detail: String(openFromCluster) };
    }

    // Re-entry discipline: a token we already closed must clear a higher bar.
    const block = this.reentryBlock(c, score);
    if (block) {
      ui.warn(`[paper] RE-ENTRY BLOCKED ${c.symbol ?? c.mint} — ${block}`);
      logRecord("events", { type: "reentry-block", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol, reason: block });
      return { opened: false, code: "REENTRY_BLOCK", detail: block };
    }

    // Copycat/spam guard: never buy the same token NAME twice within the window —
    // pump.fun floods identical names (6× "ELONIUS" seen live) and buying them all
    // just burns fees. (Different mint, same symbol = copycat spam.)
    const sym = (c.symbol ?? "").trim().toUpperCase();
    if (sym) {
      const last = this.recentSymbols.get(sym);
      if (last && Date.now() - last < config.risk.copycatWindowMs) {
        ui.warn(`[paper] SKIP ${c.symbol} — copycat/spam (same name opened ${Math.round((Date.now() - last) / 60_000)}m ago)`);
        logRecord("events", { type: "copycat-skip", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol });
        return { opened: false, code: "COPYCAT", detail: sym };
      }
    }

    // STALE-ENTRY GUARD (P0 fix, 2026-07-28): see config.risk.staleEntryBudgetMs's doc comment —
    // reject before any capital/RPC commitment if detect→decide latency already blew the budget,
    // or if there's no detection timestamp to even judge staleness (fail-closed on unknown, same
    // posture as the holder-gate fix above).
    const entryLatencyMs = c.detectedAt != null ? Date.now() - c.detectedAt : null;
    if (entryLatencyMs == null || entryLatencyMs > config.risk.staleEntryBudgetMs) {
      const why = entryLatencyMs == null ? "no detection timestamp" : `${(entryLatencyMs / 1000).toFixed(1)}s since detect`;
      ui.warn(`[paper] SKIP ${c.symbol ?? c.mint} — STALE_ENTRY (${why}, budget ${(config.risk.staleEntryBudgetMs / 1000).toFixed(0)}s)`);
      logRecord("events", { type: "stale-entry-skip", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol, latencyMs: entryLatencyMs });
      return { opened: false, code: "STALE_ENTRY", detail: entryLatencyMs != null ? String(entryLatencyMs) : "no-timestamp" };
    }

    // Position size: fixed, or compounding (grows with balance, capped by curve liquidity).
    const sizeSol = this.sizeFor(c);

    // Can't trade money you don't have — if free capital can't cover the size,
    // the account is (near) broke. Refuse the trade instead of going negative.
    if (this.freeSol() < sizeSol) {
      ui.warn(`[paper] BROKE — free capital ${this.freeSol().toFixed(3)} SOL < ${sizeSol.toFixed(3)} needed; not opening (balance ${this.balanceSol().toFixed(3)})`);
      return { opened: false, code: "BROKE", detail: this.freeSol().toFixed(6) };
    }

    // ── CAPITAL RESERVATION (race fix) ──
    // open() is async and up to `maxConcurrentGate` (6) workers run it at once, but capital was
    // only ever checked against positions ALREADY in the map. Between the check above and
    // positions.set() below there are four awaits (curve read, retry, holder count, SOL price),
    // so N concurrent opens could all see the same free balance and all commit — over-deploying
    // by up to N×size. It has not bitten yet only because the float leaves ~40 slots and we never
    // fill them; it WOULD bite after an auto-reset (floor 0.6◎ = 12 slots) or a larger size.
    // Reserving synchronously here — before the first await — closes the window. Released in the
    // finally below: once committed the position itself is counted by deployedSol().
    const clusterReservation = this.clusterReservations.reserve(clusterIds);
    this.pendingSol += sizeSol;
    try {

    // Entry price MUST be a FRESH read at buy time — never the discovery-time
    // c.priceSol/c.priceUsd. Those are stale by the settle+gate window (~8-12s),
    // during which a developing token pumps; crediting that pre-entry move would
    // book a phantom instant gain (the "langsung naik" artifact) and fire the
    // partial-TP on profit we never actually captured. Enter at the price we could
    // truly buy at RIGHT NOW.
    let price: number | undefined;
    const liq = c.liquidityUsd; // logged only (DexScreener field; undefined on the pump lane)
    const priceMode = "sol" as const; // fast-follow bonding-curve only (swing lane removed)
    let entryVSol = c.bcVSol ?? 0; // refreshed from the live curve below
    // Dicatat ke posisi + trade: entry yang lolos lewat cadangan kurva harus bisa dipisahkan
    // saat analisis, kalau tidak kelonggarannya tidak akan pernah bisa dinilai.
    let holderFallbackUsed = false;
    let entryVTokens = 0; // curve token reserve at entry (for constant-product token qty)
    // REAL sol deposited in the curve at entry. Cleaner demand signal than MC alone: MC is a
    // function of the virtual reserves and starts at ~28 SOL on an untouched curve, whereas
    // realSol starts at ~0 and only rises when someone actually pays in. Logged (not gated) so
    // the next threshold tuning has a signal that cannot be confused with the launch constant.
    let entryRealSol: number | undefined;
    // ── PARALLEL ENTRY READS (latency fix) ──
    // MEASURED: the free RPC tier answers in ~2.9s per call under load (inFlight 7 at only 2.4
    // req/s — latency-bound, NOT rate-bound). open() issued the curve read and the holder count
    // SEQUENTIALLY, so entry work alone cost ~7.3s and pushed detect→entry from 3.1s to 11.3s.
    // They are independent, so the holder count starts NOW and is awaited after the curve read.
    // Same number of RPC, roughly half the wall time.
    const holderCountP = priceMode === "sol" ? holderCountWithSource(c.mint).catch(() => ({ count: null, source: null as null })) : Promise.resolve({ count: null, source: null as null });
    if (c.bondingCurveKey) {
      const first = await bondingCurvePriceSol(c.bondingCurveKey);
      const bc = first && first.priceSol > 0 ? first : await bondingCurvePriceSol(c.bondingCurveKey);
      if (bc) {
        // The live account is authoritative over a possibly incomplete launch event. Fail before
        // committing capital when the quote unit is not SOL or Mayhem can alter supply/liquidity.
        c.isMayhemMode = c.isMayhemMode === true || bc.isMayhemMode;
        c.isCashbackCoin = c.isCashbackCoin === true || bc.isCashbackCoin;
        if (bc.quoteMint) c.quoteMint = bc.quoteMint;
        if (bc.isMayhemMode || !bc.quoteIsSol) {
          const detail = bc.isMayhemMode
            ? "PUMP_CURVE_MAYHEM"
            : `NON_SOL_QUOTE:${bc.quoteMint ?? "unknown"}`;
          ui.reject(`[paper] SKIP ${c.symbol ?? c.mint} — unsupported execution regime ${detail}`);
          return { opened: false, code: "UNSUPPORTED_REGIME", detail };
        }
      }
      if (bc && bc.priceSol > 0) {
        price = bc.priceSol; // live entry price
        entryVSol = bc.vSol; entryVTokens = bc.vTokens; entryRealSol = bc.realSol; // live reserves for honest curve fill
      } else {
        // Fresh reads FAILED or the curve is already complete. Do NOT fall back to the stale
        // discovery price: honest no-entry beats a phantom fill.
        price = undefined;
      }
    }
    if (!price || price <= 0) {
      ui.warn(`[paper] no price for ${c.symbol ?? c.mint} — cannot simulate entry`);
      return { opened: false, code: "NO_PRICE" };
    }

    /**
     * ── GERBANG MURAH DULU (urutan diperbaiki 2026-08-15) ──
     *
     * MC-band dan dev-buy dulunya diperiksa JAUH di bawah, SESUDAH simulateBuyMainnet dan
     * pembacaan akun mint. Padahal keduanya tidak butuh apa pun dari langkah itu: entryMcSol
     * murni turunan cadangan kurva yang baru saja dibaca, dan devInitialBuySol datang dari
     * event pumpportal sebelum RPC apa pun. Jadi kita membayar simulasi penuh untuk kandidat
     * yang sudah pasti ditolak.
     *
     * TERUKUR 2026-08-15: ENTRY_MC_BAND menolak ~25% dari seluruh keputusan, sementara biaya
     * evaluasi mencapai 15,7 getAccountInfo per kandidat. Kuota Helius gratis (1 juta kredit
     * sebulan = 0,386 kredit/detik berkelanjutan) tidak muat untuk 5,8 kredit/detik yang
     * kita pakai, jadi memotong pekerjaan yang hasilnya dibuang adalah penghematan termurah.
     *
     * KEPUTUSAN TRADING TIDAK BERUBAH — gerbang sama, ambang sama, hanya lebih awal.
     */
    {
      const mcNow = (priceMode === "sol" && entryVSol && entryVTokens)
        ? (entryVSol / entryVTokens) * 1_000_000_000 : undefined;
      if (mcNow != null) {
        const band = config.gate.entryMcBandSol;
        if (mcNow < band.floor || mcNow > band.ceiling) {
          const why = mcNow < band.floor ? `below floor ${band.floor}` : `above ceiling ${band.ceiling}`;
          ui.reject(`[paper] SKIP ${c.symbol ?? c.mint} — entry MC ${mcNow.toFixed(1)} SOL ${why} SOL (MC band)`);
          return { opened: false, code: "ENTRY_MC_BAND", detail: `${mcNow.toFixed(1)} SOL ${why}` };
        }
      }
      const devMax = config.gate.entryDevBuyMaxSol;
      if (devMax > 0 && typeof c.devInitialBuySol === "number" && c.devInitialBuySol > devMax) {
        ui.reject(`[paper] SKIP ${c.symbol ?? c.mint} — dev bought ${c.devInitialBuySol.toFixed(2)} SOL at launch (max ${devMax})`);
        return { opened: false, code: "ENTRY_DEV_BUY", detail: `${c.devInitialBuySol.toFixed(2)} SOL > ${devMax}` };
      }
    }

    // DEMAND CONFIRMATION (fast-follow): measured by PEOPLE, not SOL amount. Enter
    // at ANY marketcap (small MC is fine — even ideal), but only once real buyers
    // have shown up. holders=1 is just the dev = dead-on-arrival; buying it only
    // burns a fee. This is the owner's "MC kecil tapi holder banyak" signal.
    if (priceMode === "sol") {
      const { count: holders, source: holderSource } = await holderCountP; // started in parallel with the curve read above
      // SETUP-SNIPER enters EARLY (holders naturally low), so we DON'T require the momentum-era
      // 10-holder demand bar (audit: that was the hybrid "demand confirmation"). We only reject
      // the truly dead-on-arrival case: holders ≤1 = just the dev, buying it only burns fee.
      const minHolders = (c.mode === "fast-follow" && config.entryMode === "setup") ? 2 : config.gate.minHoldersToSnipe;
      // P0 fix (2026-07-28): `holders != null && holders < minHolders` was FAIL-OPEN — a failed
      // RPC read (holders === null, e.g. getTokenLargestAccounts erroring, ~290-345 times/session
      // measured) made the whole condition false, letting entry through with ZERO demand
      // verification. A failed read must fail CLOSED, not silently pass — distinct code/reason
      // from "too few holders" so the two failure modes are never conflated in analysis.
      if (holders == null) {
        /**
         * CADANGAN KURVA — HANYA saat hitungan holder tidak terbaca.
         *
         * 2026-08-12: DAS Helius berhenti mengindeks mint baru, dan itu satu-satunya sumber yang
         * bisa menjawab pada detik ke-0 — `getTokenLargestAccounts` menolak Token-2022 yang
         * dipakai pump.fun ("not a Token mint"), dan GMGN kena rate-limit. Gerbang jadi
         * gagal-tertutup pada 46% keputusan dan laju entry jatuh dari ~17/jam ke 1/jam:
         * pengumpulan data berhenti total.
         *
         * Penggantinya kurva itu sendiri, yang TIDAK PERNAH buta karena sudah dibaca untuk harga
         * beberapa baris di atas. Peluncuran pump.fun selalu mulai di vSol 30, jadi
         * (entryVSol − 30 − devInitialBuySol) = SOL yang dibeli SELAIN dev — persis maksud gerbang
         * ini ("holders ≤1 = cuma dev = mati saat lahir").
         *
         * BATAS BUKTINYA, harus jujur: terukur pada 637 trade, median +13,2 SOL non-dev dan
         * 637/637 di atas 0,01 SOL — tapi itu trade yang MEMANG dibuka, jadi angka itu hanya
         * menunjukkan cadangan ini tidak akan memblokir yang selama ini lolos. Ia TIDAK
         * membuktikan cadangan ini menolak yang buruk. Karena itu ambangnya rendah (menolak yang
         * benar-benar mati saja) dan setiap pemakaian DITANDAI supaya bisa dinilai terpisah.
         *
         * Snapshot kurva di waktu KANDIDAT tidak dipakai — sudah diuji dan gugur: kelompok
         * holders 0, 1, dan ≥2 sama-sama ≈0 karena pembeli mendarat beberapa detik sesudahnya.
         * Yang dipakai di sini bacaan SEGAR waktu entry (entryVSol, diisi ~baris 581).
         */
        const devBuy = typeof c.devInitialBuySol === "number" ? c.devInitialBuySol : 0;
        const otherBuySol = entryVSol - PUMP_LAUNCH_VSOL - devBuy;
        const fb = config.gate.holderFallback;
        if (fb.enabled && entryVSol > 0 && otherBuySol >= fb.minOtherBuySol) {
          holderFallbackUsed = true;
          logRecord("events", { type: "holder-fallback-admit", decisionId: c.decisionId ?? null, mint: c.mint,
            symbol: c.symbol, entryVSol, devBuy, otherBuySol: Number(otherBuySol.toFixed(3)) });
        } else {
          ui.warn(`[paper] SKIP ${c.symbol ?? c.mint} — holder tak terbaca DAN kurva cuma menunjukkan ${otherBuySol.toFixed(2)} SOL pembelian non-dev`);
          logRecord("events", { type: "no-demand-skip", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol, holders: null, holderSource: null, reason: "holder-read-failed", otherBuySol: Number(otherBuySol.toFixed(3)) });
          return { opened: false, code: "HOLDER_DATA_UNAVAILABLE" };
        }
      }
      // `holders` bisa tetap null di sini kalau cadangan kurva yang meloloskan — dan itu BUKAN
      // "holder sedikit", jadi jangan diperlakukan sebagai angka. Cadangan sudah menilai
      // permintaan lewat kurva; pemeriksaan jumlah hanya berlaku saat jumlahnya benar-benar ada.
      if (holders != null && holders < minHolders) {
        ui.warn(`[paper] SKIP ${c.symbol ?? c.mint} — dead-on-arrival (${holders} holder${holders === 1 ? "" : "s"}, need ${minHolders})`);
        logRecord("events", { type: "no-demand-skip", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol, holders, reason: holders === 0 ? "zero-holders" : "below-minimum" });
        return { opened: false, code: "NO_DEMAND", detail: String(holders) };
      }
    }

    // MEASURE the real round-trip cost from the exact bonding-curve math (per-launchpad fee).
    const costPct = bondingCurveCostPct(entryVSol, sizeSol, c.pool);

    // FAST CRITICAL PATH (owner: entry <5s). The entry DECISION is already made (setup classifier +
    // deadline-bounded gate). Everything that used to run SERIALLY here — exec-sim (mainnet tx sim),
    // dev-balance, total-supply, devTradeHistory (up to 21 serial getTransaction!), plus a 3rd curve
    // re-read — added ~15-20s of RPC AFTER we'd already decided to enter, and NONE of it changes the
    // entry decision. It's DEFERRED to enrichAfterOpen() (background) right after we open. That drops
    // detect→open from ~18-28s to a couple of reads. See below for the exception (skipWouldFail).
    let execStage = "pending"; // filled by the background exec-sim; "pending" until it lands
    // EXEC-SIM stays synchronous ONLY when it actually GATES the entry (skipWouldFail on — off by
    // default). Otherwise it's pure telemetry and runs in the background.
    if (readControl().execMode === "simulate" && config.exec.skipWouldFail) {
      const sim = await simulateBuyMainnet(c.mint, sizeSol, c.pool ?? "auto");
      execStage = assessBuySimulation(sim).stage;
      if (execStage === "would-fail") {
        ui.reject(`[paper] SKIP ${c.symbol ?? c.mint} — BUY simulation would fail; entry not executable`);
        // DIAGNOSTIC (2026-07-28): this rejection fires far more than expected (1,336 times in a
        // short window) — sim.err was never persisted anywhere once skipWouldFail was turned on
        // (the OLD background exec-sim log only runs when skipWouldFail is OFF), so there was no
        // way to see WHY. Logging it here to find out whether this is genuine unexecutability or
        // a systemic issue (e.g. stale curve state from the same latency problem STALE_ENTRY
        // targets) — not a gating change, purely observability.
        // FAILURE-TIME SNAPSHOT (2026-07-31). `IncorrectProgramId` from the buy simulation is a
        // misleading error — it is what a token program returns when asked about a mint it does
        // not own, so the obvious reading is "the mint is not on chain yet". Four versions of that
        // theory were tested and all four were WRONG: the mint exists, it is owned by Token-2022,
        // `confirmed` sees it, both pool endpoints see it, and 23 of 25 failures had already
        // passed the pre-queue visibility wait seconds earlier. A hand-run simulation on a
        // visible mint succeeds. So the state at FAILURE time is what nobody has actually looked
        // at — every check so far ran minutes later, when the answer had already changed. This
        // captures it in the same instant, so the next diagnosis is evidence rather than a guess.
        let mintOwnerAtFailure: string | null = null;
        if (/IncorrectProgramId/.test(sim.err ?? "")) {
          try {
            const acc = await pooledRpc<{ value: { owner?: string } | null }>("getAccountInfo", [c.mint, { encoding: "base64", commitment: "confirmed" }]);
            mintOwnerAtFailure = acc?.value?.owner ?? "ACCOUNT_MISSING";
          } catch (e) { mintOwnerAtFailure = `LOOKUP_FAILED:${(e as Error).message.slice(0, 40)}`; }
        }
        logRecord("events", { type: "buy-sim-would-fail", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol, err: sim.err ?? null, detectAgeMs: c.detectedAt != null ? Date.now() - c.detectedAt : null, mintOwnerAtFailure });
        return { opened: false, code: "BUY_SIM_WOULD_FAIL", detail: sim.err ?? undefined };
      }
      if (execStage !== "executable") {
        // Fail closed without lying about the cause. A transport/yield/build/funding problem
        // contains no on-chain revert verdict, so it must not inflate BUY_SIM_WOULD_FAIL.
        const code = execStage === "unavailable"
          ? "BUY_SIM_UNAVAILABLE"
          : execStage === "tx-built"
            ? "BUY_SIM_NEEDS_FUNDING"
            : "BUY_SIM_BUILD_UNAVAILABLE";
        ui.warn(`[paper] SKIP ${c.symbol ?? c.mint} — BUY simulation ${execStage}; entry executability unverified`);
        logRecord("events", {
          type: "buy-sim-unavailable", decisionId: c.decisionId ?? null, mint: c.mint,
          symbol: c.symbol, stage: execStage, err: sim.err ?? null,
          detectAgeMs: c.detectedAt != null ? Date.now() - c.detectedAt : null,
        });
        return { opened: false, code, detail: sim.err ?? undefined };
      }
    }
    // Dev baseline (buy-back/dump tracking) is filled by enrichAfterOpen() a few seconds later —
    // a dev dump inside the first seconds is rare and the tracker just needs the baseline to exist soon.
    const devEntryBalance: number | null = null;
    const supply: number | null = null;
    const devOnlyBuys = false;
    // tokenQty off the curve reserves we ALREADY read at entry — no 3rd re-read. The re-read only
    // existed to compensate for the ~5-6s of pre-work above; with that work gone, this read IS fresh.
    let tokenQty: number | undefined;
    let entrySolIntoCurve: number | undefined;
    if (priceMode === "sol") {
      if (entryVTokens > 0) {
        const fill = curveEntryFill(entryVSol, entryVTokens, sizeSol, c.pool);
        tokenQty = fill.tokenQty;
        entrySolIntoCurve = fill.solIntoCurve;
      }
    }
    const postBuyReserves = tokenQty && entrySolIntoCurve != null
      ? counterfactualPostBuyReserves(
        { vSol: entryVSol, vTokens: entryVTokens, realSol: entryRealSol ?? 0 },
        { tokenQty, solIntoCurve: entrySolIntoCurve },
      )
      : null;
    // RELIABLE ENTRY MARKET CAP from the curve reserves (owner's <$3k rug-zone study). jupiter's
    // marketCapUsd only covers ~6% of fresh launches; the curve reserves we always read to price the
    // entry give MC for 100% of them. pump.fun fixed supply = 1e9 UI tokens, so MC_sol = price×1e9
    // (price = vSol/vTokens). Logged (NOT gated yet — owner: collect full-coverage unbiased data first).
    let entryMcSol: number | undefined, entryMcUsd: number | undefined;
    if (priceMode === "sol" && entryVSol > 0 && entryVTokens > 0) {
      entryMcSol = (entryVSol / entryVTokens) * 1_000_000_000;
      const solUsd = await solPriceUsd(); // cached ~60s → usually free
      if (solUsd && solUsd > 0) entryMcUsd = entryMcSol * solUsd;
    }
    // (MC band + dev-buy diperiksa LEBIH AWAL — lihat blok "GERBANG MURAH DULU" di atas.)
    const tradeId = `t${Date.now().toString(36)}${(this.tradeSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.positions.set(c.mint, {
      tradeId,
      decisionId: (c as { decisionId?: string }).decisionId,
      candidate: c,
      entryPriceUsd: price,
      entryMcSol,
      entryMcUsd,
      entryRealSol,
      sizeSol,
      openedAt: Date.now(),
      peakPriceUsd: price,
      tokenQty,
      originalTokenQty: tokenQty,
      entryVTokens,
      lastVSol: postBuyReserves?.vSol ?? entryVSol,
      lastVTokens: postBuyReserves?.vTokens ?? entryVTokens,
      lastRealSol: postBuyReserves?.realSol ?? entryRealSol,
      lastObservedVSol: entryVSol,
      lastObservedRealSol: entryRealSol ?? 0,
      entrySolIntoCurve,
      armed: false,
      devEntryBalance,
      supply,
      devBuyBack: false,
      devOnlyBuys,
      devDumped: false,
      priceMode,
      bondingCurveKey: c.bondingCurveKey,
      costPct,
      originalSizeSol: sizeSol,
      partialsTaken: 0,
      partialPnlSol: 0,
      priceFailCount: 0,
      peakVSol: entryVSol, // fresh live reserve at entry (not stale discovery vSol)
      entryVSol,
      graduated: false,
      lastBusyMs: Date.now(),
      lastVibeMs: 0,
      execStage,
      entrySnapshot: {
        decisionAt: Date.now(), decisionLatencyMs: c.detectedAt ? Date.now() - c.detectedAt : undefined,
        setupVerdict: c.setup?.verdict, setupConfidence: c.setup?.confidence, setupEvidence: c.setup?.evidence, setupMissing: c.setup?.missing,
        holderFallbackUsed,
        holders: c.holders ?? null, mcUsd: c.marketCapUsd != null ? Math.round(c.marketCapUsd) : null, organic: c.organicScore ?? null,
        sniperPct: c.whaleSniperPct ?? null, bundlerPct: c.whaleBundlerPct ?? null, devPct: c.whaleDevPct ?? null,
        clusterVerdict: c.rugCluster?.verdict ?? null, devFundedBuyers: c.rugCluster?.devFundedBuyers ?? null,
        hasSocials: c.hasSocials ?? null, execStage,
      },
    });
    if (sym) {
      this.recentSymbols.set(sym, Date.now()); // remember this name for the copycat guard
      // Bound it: the guard only cares about the last copycatWindowMs, but entries were never
      // removed — over a 24/7 run this Map grows with every symbol ever traded, forever.
      if (this.recentSymbols.size > 500) {
        const cutoff = Date.now() - config.risk.copycatWindowMs;
        for (const [s, at] of this.recentSymbols) if (at < cutoff) this.recentSymbols.delete(s);
      }
    }
    if (c.creator) this.watcher.watch(c.creator); // start real-time dev watch
    this.tradeStream.watch(c.mint); // start live crowd streaming for this token
    this.save();
    logRecord("paper-trades", { action: "OPEN", tradeId, decisionId: c.decisionId ?? null, measurementEpoch: config.measurementEpoch,
      policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live",
      mint: c.mint, symbol: c.symbol, mode: c.mode, price, liquidityUsd: liq, devOnlyBuys, execStage,
      decisionLatencyMs: c.detectedAt ? Date.now() - c.detectedAt : undefined, // #8: detect→entry latency (honest "how late do we enter")
      image: c.image ?? null, // token logo (free — from the metadata JSON the socials check already fetched)
      themeCrowd: c.themeCrowd ?? null, themeWord: c.themeWord ?? null, // narrative crowding at launch
      curveMcSol: entryMcSol != null ? Number(entryMcSol.toFixed(2)) : null, curveMcUsd: entryMcUsd != null ? Math.round(entryMcUsd) : null, // RELIABLE entry MC (100% coverage) for the rug-zone study
      entryRealSol: entryRealSol != null ? Number(entryRealSol.toFixed(4)) : null, // real SOL in the curve at entry — demand signal free of the ~28 SOL launch constant
      devInitialBuySol: c.devInitialBuySol ?? null, // dev's own buy inside the create tx (the launch-MC filter's basis) — first-class so "big dev buy → outcome?" is answerable from the record, not a join
      isMayhemMode: c.isMayhemMode ?? false,
      isCashbackCoin: c.isCashbackCoin ?? false,
      quoteMint: c.quoteMint ?? null,
      launchMcSol: c.marketCapSol ?? null, // MC at the create event (before our settle) — pairs with devInitialBuySol
      // RELIABLE demand-quality (RPC-based, not the sparse holder indexer) for the organic-vs-manufactured study:
      bundleSlotMax: c.launchBundle?.sameSlotMax ?? null, bundleShare: c.launchBundle?.bundledShare ?? null, bundleVerified: c.launchBundle?.verifiedBuys ?? null,
      creatorFunders: c.creatorFunders?.length ?? null,
      sv: config.strategyVersion, cfg: configHash });
    ui.pass(`[paper] OPEN ${c.symbol ?? c.mint} @ $${price} (${c.mode}, ${sizeSol.toFixed(3)} SOL sim${devOnlyBuys ? ", DEV-ONLY-BUYS" : ""})`);
    this.mirrorDevnet("buy", c.mint, c.symbol); // devnet mode: prove the real send pipeline
    // LIVE MIRROR (execution/live-bridge.ts). No-op unless EXEC_MODE=live AND
    // LIVE_TRADING_CONFIRMED=yes. Fire-and-forget by construction: the bridge must never
    // be able to slow down, block, or alter an entry decision.
    bridgeOpen({ tradeId, mint: c.mint, symbol: c.symbol, sizeSol, pool: c.pool });
    // POST-OPEN BACKGROUND ENRICHMENT (no deadline, OFF the critical path — this is what makes entry
    // fast). Fills everything that isn't needed to DECIDE the entry: exec-sim stage, dev baseline
    // (balance/supply/only-buys), and reliable demand-quality (verified bundle + creator funders).
    // Mutates the live position + logs events as each lands, so the CLOSE record carries them. Never
    // blocks or reverts the trade. (The gate's detectLaunchBundle/creatorFunders often time out on
    // fresh coins under the 2.5s deadline; re-running here with no deadline gives full coverage.)
    if (c.mode === "fast-follow" && priceMode === "sol") {
      void (async () => {
        try {
          // exec-sim (telemetry when not gating; the gating case already ran synchronously above)
          if (readControl().execMode === "simulate" && !config.exec.skipWouldFail) {
            const sim = await simulateBuyMainnet(c.mint, sizeSol, c.pool ?? "auto");
            const stage = assessBuySimulation(sim).stage;
            const p = this.positions.get(c.mint); if (p) p.execStage = stage;
            logRecord("events", { type: "exec-sim", mint: c.mint, symbol: c.symbol, stage, built: sim.built, wouldLand: sim.ok, err: sim.err, needsFunding: sim.needsFunding });
            this.trackExecSimStreak(stage, c.symbol ?? c.mint, sim.err);
          }
          // dev baseline + history in PARALLEL (devTradeHistory is the heavy 21-RPC one — now off the hot path)
          if (c.creator) {
            const [bal, sup, hist] = await Promise.all([
              tokenBalanceOfOwner(c.creator, c.mint),
              totalSupplyUi(c.mint),
              devTradeHistory(c.creator, c.mint, config.dev.historyLimit),
            ]);
            const p = this.positions.get(c.mint);
            if (p) { p.devEntryBalance = bal; p.supply = sup; p.devOnlyBuys = hist?.onlyBuys ?? false; }
            if (hist?.onlyBuys) logRecord("events", { type: "dev-only-buys", mint: c.mint, creator: c.creator, buys: hist.buys });
          }
          // TOKEN LOGO — one plain HTTP fetch of the metadata JSON whose URI arrived free in the
          // launch event. Deliberately here and not in the gate: it is pure display data, and the
          // gate's 2.5s deadline is already losing races to ~2.9s RPC calls. Costs no RPC budget.
          if (!c.image && c.metadataUri && /^https?:\/\//i.test(c.metadataUri)) {
            try {
              const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 4_000);
              const j = await fetch(c.metadataUri, { signal: ctl.signal }).then((r) => r.json() as Promise<Record<string, unknown>>).finally(() => clearTimeout(tm));
              const img = typeof j.image === "string" ? j.image : undefined;
              if (img && /^https?:\/\//i.test(img)) { c.image = img; this.save(); } // persist so the dashboard picks it up
            } catch { /* logo is cosmetic — never let it affect the trade */ }
          }
          // reliable demand-quality (verified bundle + creator funders) for the organic-vs-manufactured study
          if (!c.launchBundle?.verifiedBuys) { const b = await detectLaunchBundle(c.mint); if (b) c.launchBundle = b; }
          if (c.creator && (c.creatorFunders?.length ?? 0) === 0) { const f = await creatorFunders(c.creator); if (f?.length) c.creatorFunders = f; }
          // GMGN CROSS-CHECK (audit: dig deep on social/community/callout signals). Independent
          // of our own bundler/sniper/rug detection above — logged for comparison, NEVER gates
          // entry or exit. A brand-new mint hasn't accumulated meaningful GMGN stats yet (smart
          // money/KOL/wash-trading detection all need time to show up), so this is telemetry
          // only, same posture as the late-toxic-telemetry check below.
          if (gmgnEnabled) {
            const [info, sec] = await Promise.all([gmgnTokenInfo("sol", c.mint), gmgnTokenSecurity("sol", c.mint)]);
            if (info || sec) {
              logRecord("events", {
                type: "gmgn-enrichment", tradeId: this.positions.get(c.mint)?.tradeId, mint: c.mint, symbol: c.symbol,
                holderCount: info?.holder_count ?? null,
                smartWallets: info?.wallet_tags_stat?.smart_wallets ?? null, renownedWallets: info?.wallet_tags_stat?.renowned_wallets ?? null,
                sniperWallets: info?.wallet_tags_stat?.sniper_wallets ?? null, bundlerWallets: info?.wallet_tags_stat?.bundler_wallets ?? null,
                degenCallCount: info?.stat?.degen_call_count ?? null, signalCount: info?.stat?.signal_count ?? null,
                twitterUsername: info?.link?.twitter_username ?? null, website: info?.link?.website ?? null, telegram: info?.link?.telegram ?? null,
                isHoneypot: sec?.honeypot ?? null, burnStatus: sec?.burn_status ?? null,
                buyTax: sec?.buy_tax ?? null, sellTax: sec?.sell_tax ?? null, cfg: configHash,
              });
            }
          }
          // DEV REPUTATION CROSS-CHECK (audit: created-tokens vs our own on-chain actor-memory).
          // Our actor-memory only learns from launches WE have personally observed (a subset);
          // GMGN indexes a creator's FULL token history platform-wide, so its open_ratio is a
          // different, broader-sample view of the same question — logged for comparison, never
          // gates. `assessActors` here re-reads the in-memory store (no RPC) — it does not
          // duplicate the RPC-based lookup already done for the entry decision.
          if (gmgnEnabled && c.creator) {
            const gmgnHist = await gmgnCreatedTokens("sol", c.creator);
            if (gmgnHist) {
              const ours = assessActors(c.creator, c.creatorFunders);
              logRecord("events", {
                type: "dev-reputation-crosscheck", tradeId: this.positions.get(c.mint)?.tradeId, mint: c.mint, symbol: c.symbol, creator: c.creator,
                gmgnOpenCount: gmgnHist.open_count ?? null, gmgnOpenRatio: gmgnHist.open_ratio ?? null,
                gmgnTotalTokens: gmgnHist.tokens?.length ?? null, gmgnAthMc: gmgnHist.creator_ath_info?.ath_mc ?? null,
                ourRiskProbability: Number(ours.riskProbability.toFixed(3)), ourConfidence: Number(ours.confidence.toFixed(3)),
                ourSampleSize: ours.sampleSize, ourEvidence: ours.evidence, cfg: configHash,
              });
            }
          }
          // DEXSCREENER CROSS-CHECK (audit: independent liquidity/price reading — measured ~20%
          // disagreement vs GMGN on the same token, so a second source catches either one being
          // stale/wrong). Free, no key, never gates entry — telemetry only, same posture as above.
          {
            const pairs = await dexTokenPairs("solana", c.mint);
            const best = pairs?.[0];
            if (best) {
              logRecord("events", {
                type: "dexscreener-enrichment", tradeId: this.positions.get(c.mint)?.tradeId, mint: c.mint, symbol: c.symbol,
                priceUsd: best.priceUsd ? Number(best.priceUsd) : null, liquidityUsd: best.liquidity?.usd ?? null,
                fdv: best.fdv ?? null, volume24h: best.volume?.h24 ?? null, pairCreatedAt: best.pairCreatedAt ?? null, cfg: configHash,
              });
            }
          }
          // Late predictive enrichment is TELEMETRY. Paying entry costs and then immediately
          // exiting on information unavailable at decision time creates churn and changes an entry
          // filter into an unmeasured exit rule. Only a separately proven execution impossibility
          // may trigger a safety exit; bundle/actor risk cannot.
          const late = classifySetup(c);
          const p2 = this.positions.get(c.mint);
          if (p2 && late.verdict === "TOXIC" && lateEnrichmentAction(false) === "TELEMETRY") {
            logRecord("events", {
              type: "late-toxic-telemetry",
              tradeId: p2.tradeId,
              decisionId: p2.decisionId ?? null,
              mint: c.mint,
              symbol: c.symbol,
              evidence: late.evidence,
              acted: false,
              cfg: configHash,
            });
          }
        } catch { /* best-effort — analysis data, never blocks the trade */ }
      })();
    }
    return { opened: true, code: "OPENED" };
    } finally {
      // Always release the reservation: on success the position itself is now counted by
      // deployedSol(), and on any early return / throw the capital must go back to the pool.
      this.pendingSol -= sizeSol;
      this.clusterReservations.release(clusterReservation);
    }
  }

  /**
   * Real-time handler: a watched dev wallet just transacted (WebSocket push).
   * Re-check every open position of that creator immediately — no 20s wait.
   */
  /**
   * Mechanical dev-dump verdict — EXIT unless the position is a CLEAR live winner. No LLM: this
   * is the fast escape from a rug. "Clear winner" reuses the same green-runner thresholds the LLM
   * uses (up more than holdGreenAbovePct AND still within holdGreenDrawdownPct of its executable
   * peak) — in that case the dev is likely taking profit on a real runner and the trailing stop
   * manages it. Everything else exits immediately. Data: only 3% of dev-dumps ever recovered.
   */
  private devDumpVerdict(pos: Position, execPnl: number, execDrawdownPct: number): "EXIT" | "HOLD" {
    const clearWinner = execPnl > config.feeling.holdGreenAbovePct && execDrawdownPct > -config.feeling.holdGreenDrawdownPct;
    return clearWinner ? "HOLD" : "EXIT";
  }

  private async onDevActivity(creator: string): Promise<void> {
    for (const [mint, pos] of this.positions) {
      if (pos.candidate.creator !== creator) continue;
      const verdict = await this.trackDev(mint, pos, true); // WS push = real-time path, bypass the poll throttle
      if (verdict === "DUMP" && this.positions.has(mint) && !pos.devDumped) {
        // Dev sold ≥50% of their bag. This is the WebSocket push — the fastest signal we get
        // (sub-second). We escape MECHANICALLY here, right now, instead of the old behaviour of
        // firing the 11-16s LLM and losing the race to the drain. Only a clear live winner is
        // held (trailing stop then manages it). Falls back to the 4s tick's identical verdict if
        // the fresh price read fails. (Data: dev-dump = 49% rug / avg −44% / 3% recover.)
        pos.devDumped = true;
        logRecord("events", { type: "dev-dump-flag", mint, symbol: pos.candidate.symbol, note: "fast mechanical escape (WS push)" });
        if (!config.risk.agentFallback.devDumpExit) return;
        const price = await this.currentPrice(pos, mint); // refreshes reserves → execPnl below is fresh
        if (price && price > 0 && this.positions.has(mint)) {
          const execProceeds = (pos.tokenQty && pos.lastVSol && pos.lastVTokens)
            ? pos.graduated && pos.gradSyntheticNetReserves
              ? syntheticAmmExitProceedsSol(pos.lastVSol, pos.lastVTokens, pos.tokenQty, pos.lastRealSol)
              : curveExitProceedsSol(pos.lastVSol, pos.lastVTokens, pos.tokenQty, pos.candidate.pool, pos.graduated, pos.lastRealSol)
            : pos.sizeSol * (1 + (((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 - pos.costPct) / 100);
          const execPnl = ((execProceeds - pos.sizeSol) / pos.sizeSol) * 100;
          const execDd = pos.peakExecProceeds && pos.peakExecProceeds > 0 ? ((execProceeds - pos.peakExecProceeds) / pos.peakExecProceeds) * 100 : 0;
          if (this.devDumpVerdict(pos, execPnl, execDd) === "EXIT") {
            ui.reject(`[paper] DEV DUMP ${pos.candidate.symbol ?? mint} — fast mechanical exit @ ${execPnl.toFixed(0)}% (no LLM wait)`);
            this.close(mint, pos, price, "DEV_DUMP");
          } else {
            ui.info(`[paper] DEV DUMP ${pos.candidate.symbol ?? mint} — held: live winner +${execPnl.toFixed(0)}%, trailing manages`);
          }
        }
      }
    }
  }

  /**
   * The Feeling Agent as an ACTIVE READER: it ingests the position's LIVE picture —
   * new-buying growth (volume/rame), price momentum, live marketcap, community
   * (holders/organic score), and dev behavior — and forms a wait-and-see conviction
   * (hold if it's genuinely developing, exit FEELING if it's fading). Fired async so
   * the LLM latency never blocks the trading loop; best-effort.
   */
  private shadowInFlight = 0; // cap concurrent shadow judgments — the relay is slow (11-16s)

  /**
   * SHADOW JUDGMENT — the agent reads a position it is NOT allowed to manage, and the verdict is
   * logged but NEVER acted on. Purpose: the agent is deliberately restricted to de-risked runners
   * (1.5% of trades), which means we have no evidence about whether widening its mandate would
   * help or hurt — and we never will, because it never gets to speak. This produces that evidence
   * WITHOUT touching a single decision, so the running cohort stays clean: every shadow record
   * carries the verdict plus the live P&L, and the eventual outcome is joined from the CLOSE
   * record by mint. Bounded so a slow relay can never pile up.
   */
  private maybeShadowJudge(mint: string, pos: Position, execPnl: number, drawdownFromPeak: number, quietForMs: number, price: number): void {
    if (!config.feeling.shadow) return;
    if (this.shadowInFlight >= config.feeling.shadowMaxConcurrent) return;
    if (Date.now() - pos.lastVibeMs < config.feeling.everyMs) return;
    pos.lastVibeMs = Date.now();
    this.shadowInFlight++;
    void this.checkVibe(mint, pos, execPnl, drawdownFromPeak, quietForMs, price, true)
      .finally(() => { this.shadowInFlight--; });
  }

  private async checkVibe(mint: string, pos: Position, pnlPct: number, drawdownFromPeak: number, quietForMs: number, price: number, shadow = false): Promise<void> {
    const dev = pos.devDumped ? "dumped" : pos.devOnlyBuys ? "only-buys" : pos.devBuyBack ? "buy-back" : "quiet";
    // LIVE signals read from the evolving position, not a static entry snapshot.
    const buyingGrowthPct = pos.entryVSol > 0 ? ((pos.peakVSol - pos.entryVSol) / pos.entryVSol) * 100 : 0; // new SOL bought in
    const peakGainPct = pos.entryPriceUsd ? ((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 : 0;
    // Live marketcap estimate: entry MC scaled by the live price move (curve MC tracks price).
    const mcLive = pos.candidate.marketCapUsd && pos.entryPriceUsd ? pos.candidate.marketCapUsd * (price / pos.entryPriceUsd) : pos.candidate.marketCapUsd;
    // Live CROWD: who's actually trading right now (organic crowd vs lone whale).
    // Prefer the funded PumpPortal stream if present; otherwise poll pump.fun's FREE
    // swap-api trade tape so the agent always has real crowd data (no funded key).
    const cs = this.tradeStream.stats(mint);
    let crowd = cs
      ? { uniqueBuyers: cs.uniqueBuyers, buys: cs.buys, sells: cs.sells, buyRatio: cs.buyRatio, netBuyVolSol: cs.netBuyVolSol, lastTradeSecAgo: cs.lastTradeSecAgo }
      : null;
    if (!crowd) {
      const tr = await pumpTradeStats(mint);
      if (tr) crowd = { uniqueBuyers: tr.uniqueBuyers, buys: tr.buys, sells: tr.sells, buyRatio: tr.count > 0 ? tr.buys / tr.count : 0, netBuyVolSol: tr.netBuyVolSol, lastTradeSecAgo: tr.lastTradeSecAgo };
    }
    // Raw chart for the agent to READ (free candles from the mint).
    const cv = await pumpCandles(mint, config.pumpCandles.interval, config.pumpCandles.limit);
    const chart = cv ? { interval: cv.interval, closes: cv.closesIdx, vols: cv.vols, changePct: cv.changePct } : null;
    const v = await judgeVibe({
      symbol: pos.candidate.symbol ?? mint.slice(0, 6),
      mode: pos.candidate.mode,
      heldSec: Math.round((Date.now() - pos.openedAt) / 1000),
      priceFromEntryPct: Number(pnlPct.toFixed(1)),
      peakGainPct: Number(peakGainPct.toFixed(1)),
      drawdownFromPeakPct: Number(drawdownFromPeak.toFixed(1)),
      buyingGrowthPct: Number(buyingGrowthPct.toFixed(1)),
      secsSinceLastBuyingHigh: Math.round(quietForMs / 1000),
      marketCapUsd: mcLive ? Math.round(mcLive) : undefined,
      chart,
      holdersAtEntry: pos.candidate.holders,
      organicScore: pos.candidate.organicScore,
      whale: pos.candidate.whaleSniperPct !== undefined
        ? { sniperPct: Number((pos.candidate.whaleSniperPct ?? 0).toFixed(1)), bundlerPct: Number((pos.candidate.whaleBundlerPct ?? 0).toFixed(1)), devPct: Number((pos.candidate.whaleDevPct ?? 0).toFixed(1)), top10Pct: Number((pos.candidate.whaleTop10Pct ?? 0).toFixed(0)) }
        : null,
      crowd,
      devBehavior: dev,
      rugCluster: pos.candidate.rugCluster ? { clusterWallets: pos.candidate.rugCluster.clusterWallets, clusterPct: pos.candidate.rugCluster.clusterPct, devFundedBuyers: pos.candidate.rugCluster.devFundedBuyers, coordinated: pos.candidate.rugCluster.coordinated } : null,
      // NO winner-DNA / entrySignature prior anymore — it was LEAKAGE: confirmStats is captured
      // at T+45-180s (momentum-confirm) and was fed as "entry" data → the profile looked smart
      // using the future. The agent judges the LIVE picture on its own. (owner spec.)
    }, shadow); // shadow judgments must not count against the exit brain's liveness
    if (!v) return;
    // DECISION OUTCOME memory: log the agent's decision WITH evidence + the live P&L context,
    // so we can later measure the agent's REAL contribution in SOL (premature-exit rate, saved
    // losses, missed profit, confidence calibration) — not just "was it right %". (owner spec #5)
    logRecord("events", { type: "vibe", tradeId: pos.tradeId, decisionId: pos.decisionId ?? null,
      measurementEpoch: config.measurementEpoch, policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live",
      mint, symbol: pos.candidate.symbol, vibe: v.vibe, confidence: v.confidence,
      reason: v.reason, evidence: v.evidence ?? null, missingCritical: v.missingCritical ?? null,
      execPnlPct: Number((pos.lastPnlPct ?? pnlPct).toFixed(1)), peakGainPct: Number(peakGainPct.toFixed(1)), heldSec: Math.round((Date.now() - pos.openedAt) / 1000),
      // shadow = the agent was NOT allowed to act on this. Join to the CLOSE record by mint to
      // measure what its call would have been worth — the evidence for widening its mandate.
      shadow, deRisked: pos.deRisked ?? false,
      crowd, mode: pos.candidate.mode, cfg: configHash });
    if (shadow) { // observed only — never touches the position
      ui.info(`[shadow] ${pos.candidate.symbol ?? mint} → ${v.vibe} (${v.confidence}%) @ ${(pos.lastPnlPct ?? pnlPct).toFixed(0)}% — logged, not acted on`);
      return;
    }
    // ABSTAIN → hold (agent explicitly has insufficient data; forcing a decision = false certainty).
    if (v.vibe === "abstain") { ui.info(`[feeling] ${pos.candidate.symbol ?? mint} → ABSTAIN (${v.confidence}%): ${v.reason} — holding, insufficient data`); return; }
    // Only act if the position is still open and the agent is confidently bearish.
    if (this.positions.has(mint) && (v.vibe === "dying" || v.vibe === "dead") && v.confidence >= config.feeling.exitOnDyingConfidence) {
      // NEVER let the agent kill a live GREEN runner. A position that is UP and
      // still near its peak is momentum ALIVE — it must ride the trailing stop /
      // dev-sell, not be cut on a vibe. (The agent sold MERT at +58% calling it a
      // "wash" — that killed a winner. Price up is the strongest live signal.)
      if (pnlPct > config.feeling.holdGreenAbovePct && drawdownFromPeak > -config.feeling.holdGreenDrawdownPct) {
        ui.info(`[feeling] ${pos.candidate.symbol ?? mint} up +${pnlPct.toFixed(0)}% & riding — HOLD the winner (agent won't cut a green runner)`);
        return;
      }
      const price = await this.currentPrice(pos, mint);
      ui.reject(`[feeling] ${pos.candidate.symbol ?? mint} → ${v.vibe} (${v.confidence}%): ${v.reason} — exiting`);
      this.close(mint, pos, price ?? pos.lastPriceUsd ?? 0, "FEELING");
    } else if (v.vibe === "alive") {
      ui.info(`[feeling] ${pos.candidate.symbol ?? mint} → alive (${v.confidence}%): ${v.reason} — holding`);
    }
  }

  /** Current price for a position + ATOMICALLY refresh its curve reserves, so a close()
   *  right after uses fresh (vSol,vTokens) for the executable proceeds — not reserves from
   *  a tick 12-24s before the LLM answered (#4). */
  private async currentPrice(pos: Position, _mint: string): Promise<number | undefined> {
    if (pos.bondingCurveKey) {
      const bc = await bondingCurvePriceSol(pos.bondingCurveKey);
      if (bc && !bc.complete && bc.vTokens > 0) this.applyObservedCurve(pos, bc);
      return bc && bc.priceSol > 0 ? bc.priceSol : undefined;
    }
    return undefined;
  }

  /** Preserve our hypothetical buy/partials while replaying only external mainnet reserve deltas. */
  private applyObservedCurve(pos: Position, bc: CurveState): void {
    if (
      pos.lastObservedVSol == null
      || pos.lastObservedRealSol == null
      || pos.lastVSol == null
      || pos.lastVTokens == null
      || pos.lastRealSol == null
    ) {
      // Legacy persisted position from before overlay accounting: do not invent its missing entry
      // impact. Start delta tracking at the first new observation and keep it outside e3 inference.
      pos.lastObservedVSol = bc.vSol;
      pos.lastObservedRealSol = bc.realSol;
      pos.lastVSol = bc.vSol;
      pos.lastVTokens = bc.vTokens;
      pos.lastRealSol = bc.realSol;
      return;
    }
    const next = replayObservedCurveDelta(
      { vSol: pos.lastVSol, vTokens: pos.lastVTokens, realSol: pos.lastRealSol },
      { vSol: pos.lastObservedVSol, realSol: pos.lastObservedRealSol },
      bc,
    );
    pos.lastVSol = next.vSol;
    pos.lastVTokens = next.vTokens;
    pos.lastRealSol = next.realSol;
    pos.lastObservedVSol = bc.vSol;
    pos.lastObservedRealSol = bc.realSol;
  }

  private ticking: Record<string, boolean> = {}; // per-mode re-entrancy guard
  // AUDIT P1-7: rolling tick-duration window (per mode) for p50/p95/p99, plus a consecutive-
  // breach counter so a STILL-slow monitoring loop alerts instead of just logging one event
  // per occurrence (measured: tick took up to 147s against a 4s target, unnoticed until audited).
  private tickDurations: Record<string, number[]> = {};
  private consecutiveSlowTicks: Record<string, number> = {};
  private static readonly TICK_WINDOW = 100;
  private async tick(mode: "fast-follow"): Promise<void> {
    // MUTEX (#4): a tick fans out multiple RPC per position and can exceed its 4s interval.
    // Without this, ticks overlap and can double-process a position. Skip if already running.
    if (this.ticking[mode]) return;
    this.ticking[mode] = true;
    const tickStart = Date.now();
    try {
    // BATCH-read all this-mode bonding-curve reserves in ONE getMultipleAccounts RPC (#9),
    // instead of one serial read per position (which grows effective tick-age with count).
    const ffKeys = [...this.positions.values()]
      .filter((p) => p.candidate.mode === mode && p.priceMode === "sol" && p.bondingCurveKey)
      .map((p) => p.bondingCurveKey!);
    // Always batch, even for ONE position: `> 1` meant a single position fell through to the
    // per-position serial read below, which is the exact path we are trying to avoid.
    const curveBatch = ffKeys.length ? await bondingCurvePricesMulti(ffKeys) : new Map();
    for (const [mint, pos] of this.positions) {
      /**
       * NEVER-PRICED ESCAPE — checked BEFORE the venue filter, on purpose.
       *
       * Every exit rule is defined against the position's peak, the peak comes from a price, and
       * a position that has never been priced has no peak. So NO_DEVELOPMENT cannot fire at 45s,
       * MAX_HOLD cannot fire at 120s, and the position is immortal. Measured 2026-08-07: of 347
       * positions opened that day exactly one (SMILE) was never marked, and it sat for 635s until
       * closed by hand — the next-worst blind window all day was 68s.
       *
       * The reason it also escaped the existing `priceFailCount >= 15` net is that the net only
       * counts reads that were ATTEMPTED. `ffKeys` filters on `priceMode === "sol" && bondingCurveKey`
       * and this loop filters on venue, so a position excluded by any of those is never read at
       * all: no read, no failure, no counter, no escape. Placing this check above the venue filter
       * is what makes it cover every one of those paths instead of only the one we happened to see.
       *
       * Closes at ENTRY price, never a fabricated loss — we genuinely do not know what it was worth.
       */
      if (pos.lastPriceUsd == null) {
        const blindMs = Date.now() - pos.openedAt;
        const budget = Math.max(config.risk.maxHoldMsFastFollow, config.risk.noDevelopment.afterMs);
        if (blindMs > budget * 2) {
          ui.warn(`[paper] ${pos.candidate.symbol ?? mint} tidak pernah berharga ${Math.round(blindMs / 1000)}s — ditutup di harga entry`);
          this.close(mint, pos, pos.entryPriceUsd, "NEVER_PRICED");
          continue;
        }
      }
      if (pos.candidate.mode !== mode) continue; // this timer only handles its venue
      const maxHold = config.risk.maxHoldMsFastFollow;
      const heldMs = Date.now() - pos.openedAt;

      // Price source depends on venue: bonding curve (on-chain) vs DexScreener.
      let price: number | undefined;
      let busy = false; // did activity (curve reserve / volume) make a new high this tick?
      // A missing price has two very different causes we must NOT conflate:
      //   drained  — the venue POSITIVELY reports no value left (real rug → -100%)
      //   readFail — the read itself failed (RPC/API hiccup → hold, never fake a loss)
      // On-chain verification proved the old "3 fails → -100%" booked false rugs on
      // tokens that were still live (and even mislabeled a GRADUATED winner).
      let drained = false;
      let readFail = false;
      if (pos.bondingCurveKey) {
        // Use the batched read when available (fresh this tick); else a single read.
        // BATCH ONLY — never fall back to a blocking single read here. That fallback ran INSIDE
        // the position loop, so one missed key cost ~2.9s (the measured per-RPC latency) and every
        // later position in the same tick waited for it. With the mutex holding off the next tick,
        // a few misses blinded the whole book: positions were priced at a median 19% of the
        // expected 4s cadence and 79 of 137 got under 25% — which is why tiers and trailing could
        // not fire on coins that spiked and died between reads. A miss now simply retries on the
        // next tick, which is 4s away rather than 30s.
        const bc = curveBatch.get(pos.bondingCurveKey);
        if (!bc) {
          readFail = true; // RPC returned nothing — transient, not a rug
        } else if (bc.complete) {
          // GRADUATED to an AMM. DON'T auto-close (audit fix: that made the runner miss the whole
          // post-migration AMM rise — where memecoins often do their biggest move). Instead switch
          // to AMM valuation: mark graduated, value the remaining tokenQty via a real Jupiter sell
          // quote, and let the trailing stop / catastrophic / agent manage it from here like any
          // other position. Only exit when the trail actually fires.
          pos.graduated = true;
          // AUDIT P1-7: a synchronous, per-position Jupiter network call INSIDE the 4s tick was
          // the measured #1 cause of ticks blowing their interval (up to 147s with just 1-7
          // positions open — this call, not position count, was the driver). Throttled to once
          // per 15s per position; between refreshes the tick reuses the last known AMM price
          // instead of re-quoting, same as a bonding-curve read failure just holds the last price.
          const gradQuoteDue = !pos.lastGradQuoteMs || Date.now() - pos.lastGradQuoteMs >= 15_000;
          if (pos.tokenQty && pos.tokenQty > 0 && gradQuoteDue) {
            pos.lastGradQuoteMs = Date.now();
            const jq = await jupiterSellSol(mint, pos.tokenQty);
            if (jq && jq.solOut > 0) {
              pos.gradProceedsSol = Math.max(0, jq.solOut - gasPerSideSol());
              price = jq.solOut / pos.tokenQty; // executable average SOL/token for the quoted qty
              pos.lastPriceUsd = price;
              // DEPTH-AWARE AMM VALUATION (owner #4): reconstruct the effective constant-product
              // AMM reserves from this quote so EVERY downstream sell (ladder tiers, trail mark,
              // final close) prices off real AMM depth per-tier — not the dead, frozen bonding
              // curve. For a CP pool selling q tokens: impact = q/(Rt+q) and execPrice = Rs/(Rt+q),
              // so  Rt = q(1-impact)/impact ,  Rs = execPrice/(1-impact) · Rt. One quote → correct
              // depth for any partial size, no per-tier network call.
              const synthetic = syntheticAmmReservesFromQuote(pos.tokenQty, jq.solOut, jq.impactPct);
              if (synthetic) {
                pos.lastVSol = synthetic.solReserve;
                pos.lastVTokens = synthetic.tokenReserve;
                pos.lastRealSol = synthetic.solReserve;
                pos.gradSyntheticNetReserves = true;
              }
            } else {
              // No AMM route yet (pool still migrating) — hold, retry next tick. Don't fabricate.
              readFail = true;
            }
          } else if (pos.lastPriceUsd != null) {
            // Not due for a fresh quote (or no tokenQty left) — reuse the last verified AMM
            // price/reserves rather than re-fetching. Same information the previous tick had.
            price = pos.lastPriceUsd;
          } else {
            readFail = true; // never got a first quote yet — hold, don't fabricate a price
          }
          // fall through to normal management (trail/agent) instead of continue+close
        } else if (bc.priceSol > 0) {
          price = bc.priceSol;
          this.applyObservedCurve(pos, bc);
          // vSol rises as people buy = "rame". A new high means it's still busy.
          if (bc.vSol > pos.peakVSol * (1 + config.risk.quietGrowthPct / 100)) {
            pos.peakVSol = bc.vSol;
            pos.lastBusyMs = Date.now();
            busy = true;
          }
        } else {
          // Read succeeded but the curve reports ~no reserve/price = truly drained.
          drained = bc.vSol < 2;
          readFail = !drained; // priced 0 with reserves still present = weird read, treat as transient
        }
      }
      void busy;

      if (price === undefined) {
        if (drained) {
          // POSITIVELY confirmed: the bonding curve has no reserve left. Real rug.
          this.close(mint, pos, 0, "LIQUIDITY_GONE");
          continue;
        }
        // Otherwise the READ failed — a failed read is NOT proof of a rug. Stay
        // patient; only give up after a long stall, and then close at the LAST
        // KNOWN price (real P&L), NEVER a fabricated -100%.
        if (readFail) pos.priceFailCount = (pos.priceFailCount ?? 0) + 1;
        // Leave a trace of the blindness. Without this a position that cannot be priced writes
        // NOTHING to the tick stream, so "never marked" and "no open positions" look identical in
        // the logs — which is exactly why the SMILE stall took a manual investigation to find.
        logRecord("ticks", {
          tradeId: pos.tradeId, mint, symbol: pos.candidate.symbol, cfg: configHash,
          heldSec: Math.round((Date.now() - pos.openedAt) / 1000),
          unpriced: true, drained, readFail, priceFailCount: pos.priceFailCount ?? 0,
        });
        if (pos.priceFailCount >= 15) {
          const last = pos.lastPriceUsd ?? pos.entryPriceUsd;
          this.close(mint, pos, last, "STALE"); // can't price it anymore; book last-seen value
        }
        continue;
      }
      pos.priceFailCount = 0; // a good read resets the counter

      if (price > pos.peakPriceUsd) { pos.peakPriceUsd = price; pos.peakAtSec = Math.round((Date.now() - pos.openedAt) / 1000); } // stamp WHEN the ATH happened
      const pnlFromEntry = ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100;
      const drawdownFromPeak = ((price - pos.peakPriceUsd) / pos.peakPriceUsd) * 100; // spot-based (agent context)
      pos.lastPriceUsd = price;
      // EXECUTABLE mark-to-market: sell-sim our tokenQty into the CURRENT curve reserves
      // (real self-impact + fees) → the SOL we could actually get right now. This drives
      // BOTH the live P&L and the trailing high-water mark (#6). Falls back to spot−cost
      // for swing/usd positions with no reserve state.
      const execProceeds = (pos.graduated && pos.gradSyntheticNetReserves && pos.tokenQty && pos.lastVSol && pos.lastVTokens)
        ? syntheticAmmExitProceedsSol(pos.lastVSol, pos.lastVTokens, pos.tokenQty, pos.lastRealSol)
        : (pos.graduated && pos.gradProceedsSol != null)
        ? pos.gradProceedsSol // direct full-quantity quote fallback when reserve reconstruction failed
        : (pos.tokenQty && pos.lastVSol && pos.lastVTokens)
          ? curveExitProceedsSol(pos.lastVSol, pos.lastVTokens, pos.tokenQty, pos.candidate.pool, pos.graduated, pos.lastRealSol)
          : pos.sizeSol * (1 + (pnlFromEntry - pos.costPct) / 100);
      pos.lastPnlPct = ((execProceeds - pos.sizeSol) / pos.sizeSol) * 100;
      // Trail from the EXECUTABLE high-water mark, not the marginal spot peak (which
      // overstates what we could realize when we dump our own size). #6.
      if (pos.peakExecProceeds == null || execProceeds > pos.peakExecProceeds) {
        pos.peakExecProceeds = execProceeds;
        pos.peakExecAtMs = Date.now(); // stamp the high — fade tightening measures time since THIS
      }
      const execPeakGainPct = ((pos.peakExecProceeds - pos.sizeSol) / pos.sizeSol) * 100;
      const execDrawdownPct = pos.peakExecProceeds > 0 ? ((execProceeds - pos.peakExecProceeds) / pos.peakExecProceeds) * 100 : 0;
      // REPLAY-HARNESS PATH: log the reserve state + original qty each tick, so the SAME
      // price path can later be run through DIFFERENT exit schemes (no-partial / ladder /
      // principal-first) offline. This is what lets us TEST exit designs on identical paths
      // by EXECUTABLE value from entry — not chart peaks. Additive/non-material.
      if (pos.priceMode === "sol" && pos.lastVSol && pos.lastVTokens && pos.originalTokenQty) {
        logRecord("path", { tradeId: pos.tradeId, decisionId: pos.decisionId ?? null, measurementEpoch: config.measurementEpoch,
          policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live", regimeId: regimeOf(pos),
          mint, sym: pos.candidate.symbol, sec: Math.round((Date.now() - pos.openedAt) / 1000),
          vSol: Number(pos.lastVSol.toFixed(4)), vTokens: Number(pos.lastVTokens.toFixed(2)),
          origQty: Number(pos.originalTokenQty.toFixed(2)), sizeSol: Number(pos.originalSizeSol.toFixed(5)),
          pool: pos.candidate.pool, cfg: configHash });
      }

      // Dev/creator wallet tracking. Fired WITHOUT await: it is throttled to dev.pollMs and each
      // call is an RPC, so awaiting it per position serialised N×2.9s into a single 4s tick — the
      // main driver of the 8.1s median (128.9s worst) tick times. The real-time dev-dump path is
      // the DevWatcher WebSocket push, which is faster and free; this poll only sets the flag,
      // and the flag is consumed by the always-on escape at the top of the NEXT tick.
      void this.trackDev(mint, pos).then((dev) => {
        if (dev === "DUMP" && !pos.devDumped) {
        // Flag only — the agent (checkVibe below) reads dev-dump against price/crowd
        // and decides. No auto-exit (dev-dump ≠ rug).
          pos.devDumped = true;
          logRecord("events", { type: "dev-dump-flag", mint, symbol: pos.candidate.symbol, note: "flagged by poll; escape fires next tick" });
        }
      });

      // No 70s "probation" cut anymore — the holder-gate already ensured real demand
      // at ENTRY, so we now WAIT AND SEE patiently and let the dev-sell + LLM agent
      // (below) decide the exit, not a stopwatch.

      // "Sepi" is NO LONGER a rigid auto-close. The data proved a stopwatch cut kills
      // the fat tail (coins we closed on a quiet at −2%..−51% later ran +300%..+8987%).
      // Quietness is now just a SIGNAL handed to the agent (secsSinceLastBuyingHigh),
      // which reads it against the chart/tape/crowd and decides — a brief pause in a
      // coin consolidating higher is HOLD, not death. Only a real death signal exits.
      const quietForMs = Date.now() - pos.lastBusyMs;

      // ── ALWAYS-ON CATASTROPHIC GUARD (#3) — runs FIRST, from second 1, on EVERY tick,
      // independent of the agent. Uses the EXECUTABLE mark-to-market P&L (curve sell-sim of
      // our tokenQty), not the marginal spot. The agent decides WITHIN this envelope; it can
      // never disable this floor. Only catches disasters (−70%), so winners are untouched.
      const execPnl = pos.lastPnlPct ?? (pnlFromEntry - pos.costPct); // faithful mark-to-market

      /**
       * PER-TICK MARK. Recorded because the ONE remaining lever cannot be measured without it.
       *
       * The structure of our losses is now known: 53% of entries never rise at all and lose
       * -38.7% while being held a median of 21s, whereas winners reveal themselves at a median
       * of 6s. Cutting a position that has not moved by ~10s is therefore the only untested
       * change with a plausible mechanism — but "what would that position have been worth at
       * 10s?" is unanswerable today. The observatory path is far too sparse for it: median 10
       * samples per mint, and 17% of the gaps between samples exceed 60 SECONDS. Reconstructing
       * a 5-20s horizon from it produced an obviously bogus +41.8% expectancy, non-monotonic in
       * the cut time — an artefact of "the next sample" landing minutes later on tokens that had
       * meanwhile mooned.
       *
       * One line per tick per open position gives a dense, faithful mark for exactly the trades
       * we care about, and turns that question into arithmetic within hours. It costs one log
       * write per 5s per position and changes no behaviour.
       */
      logRecord("ticks", {
        tradeId: pos.tradeId, decisionId: pos.decisionId ?? null, measurementEpoch: config.measurementEpoch,
        policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live", regimeId: regimeOf(pos),
        mint, symbol: pos.candidate.symbol, cfg: configHash,
        heldSec: Math.round(heldMs / 1000),
        execPnlPct: Number(execPnl.toFixed(2)),   // what we could ACTUALLY realise now
        spotPnlPct: Number(pnlFromEntry.toFixed(2)),
        peakPct: Number((pos.peakPriceUsd > 0 && pos.entryPriceUsd > 0 ? ((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 : 0).toFixed(2)),
        // `peakPct` above is the SPOT peak from entry and never re-bases. `execPeakGainPct` DOES
        // re-base on every partial (the trail re-seed). Logging both is what makes the NO-DEV
        // exemption auditable — without the pair, a re-based peak looks identical to a position
        // that genuinely never moved, which is exactly how the cut-runner bug stayed invisible.
        execPeakGainPct: Number(execPeakGainPct.toFixed(2)),
        everDeveloped: pos.everDeveloped === true,
        partialCount: (pos.scaleTier ?? -1) + 1, // sama persis dengan catatan penutupan (baris ~1942)
        vSol: pos.lastVSol ?? null, vTokens: pos.lastVTokens ?? null,
      });

      if (execPnl <= liveRisk("catastrophicStopPct", config.risk.catastrophicStopPct, [-95, -20])) {
        this.close(mint, pos, price, "CATASTROPHIC");
        continue;
      }

      // ── DEV-DUMP FAST ESCAPE — mechanical, always-on, NO LLM ──
      // The old design handed a dev dump to the LLM agent (11-16s round-trip) to judge. On a real
      // rug the dev drains the curve in that window, so the close lost the race — MEASURED: of 61
      // dev-dump cases, 49% rugged (avg −44%), only 3% ever recovered, and 24 bled all the way to
      // the −70% CATASTROPHIC floor because the exit waited. Dev selling ≥50% of their own bag is
      // the single strongest rug signal, so we now EXIT INSTANTLY and mechanically (this fires on
      // the 4s tick; onDevActivity fires the same verdict sub-second off the WS push). The only
      // hold is a CLEAR live winner (dev taking profit on a runner) — the trailing stop manages
      // that from here, no LLM needed. Applies to ALL positions incl. de-risked (agent no longer
      // gates the escape) and from second 1 (no minHoldMs gate — first-minute rugs need it most).
      if (pos.devDumped && config.risk.agentFallback.devDumpExit && this.devDumpVerdict(pos, execPnl, execDrawdownPct) === "EXIT") {
        this.close(mint, pos, price, "DEV_DUMP");
        continue;
      }

      // ── EARLY CUT — potong cepat yang lahir dari 55-100 (2026-08-11) ──
      // Kurva peluruhan sudah lama bilang nilai memuncak beberapa detik setelah entry lalu bocor;
      // ini memanennya. Aturan: dalam `withinMs` pertama, kalau P&L EKSEKUTABEL sudah di bawah
      // `pnlPct`, keluar sekarang — jangan tunggu NO_DEVELOPMENT di detik ke-30.
      //
      // Divalidasi pada 478 trade pita 55-100 dengan SELISIH BERPASANGAN (bukan selisih tingkat —
      // memakai SD tingkat 63,2 poin di sini adalah kesalahan statistik; yang benar SD selisih
      // 16,7 poin karena mayoritas trade tak tersentuh aturan):
      //   keluar di tick pemicu   +3,15 ±1,54
      //   keluar di tick berikut  +2,21 ±1,40   ← asumsi realistis, ini yang dipakai memutuskan
      //   dua tick kemudian       +1,56 ±1,24
      // Pangkas-ekor LULUS TERBALIK (buang 5 efek terbesar → +3,86, efeknya NAIK) jadi ini bukan
      // ulah segelintir trade raksasa seperti kandidat trail x2 yang dulu gugur. Split-half 400x:
      // 400/400 kedua paruh positif. Konsisten di ketiga hari data.
      //
      // Ambang dikunci -10, BUKAN -5 yang optimum di grid: parameternya dipilih dari 12 sel pada
      // data yang sama, dan sel juara paling terkena inflasi pemilihan. Seluruh 12 sel positif,
      // jadi memilih yang bukan puncak tetap aman dan jauh lebih jujur.
      //
      // TIDAK dikecualikan oleh everDeveloped — sengaja. Simulasi tidak memakai pengecualian itu,
      // dan menambahkannya di sini berarti yang berjalan bukan lagi yang diukur.
      //
      // CATATAN kejujuran: simulasi memakai tick TERAKHIR di dalam jendela, sedangkan aturan hidup
      // menembak pada tick PERTAMA yang menembus. Itu lebih awal, dan uji kelambatan di atas
      // menunjukkan lebih awal tidak merugikan — tapi keduanya tidak identik.
      const early = config.risk.earlyCut;
      if (early.enabled && heldMs <= early.withinMs && execPnl < early.pnlPct) {
        this.close(mint, pos, price, "EARLY_CUT");
        continue;
      }

      // ── NO-DEVELOPMENT CUT — the capital-stuck fix, always-on, agent-independent ──
      // A position that has not printed even a small executable gain within the window is not
      // "waiting to run", it is dead money holding a slot: 75% of non-runners are caught here
      // vs 8% of real runners lost (measured on the tick paths). Runs AFTER the catastrophic
      // guard and BEFORE the scale-out, so it can never fire on a position that has already
      // climbed (execPeakGainPct ≥ minPeakPct means it developed and is exempt forever).
      const noDev = config.risk.noDevelopment;
      // Latch BEFORE the test, so a position that is developed right now can never be cut by it.
      if (execPeakGainPct >= noDev.minPeakPct) pos.everDeveloped = true;
      if (noDev.enabled && !pos.everDeveloped && heldMs >= noDev.afterMs && execPeakGainPct < noDev.minPeakPct) {
        this.close(mint, pos, price, "NO_DEVELOPMENT");
        continue;
      }

      // LADDERED SCALE-OUT — take partials at rising tiers as the winner climbs (owner's
      // "ambil partial saat naik tinggi"). Banks the run progressively; a runner tail keeps
      // riding the trail for the fat tail. Each tier fires once (guarded by scaleTier).
      if (config.risk.scaleOut.enabled && pos.priceMode === "sol" && pos.tokenQty && pos.lastVSol && pos.lastVTokens) {
        this.scaleOutLadder(mint, pos, execPnl);
      }

      // EXIT BRAIN: agent (thinking, flexible) when ALIVE; mechanical net when DOWN.
      // The LLM reads the full live picture and decides HOLD vs EXIT — the wait-and-see
      // judge the owner wants. But it's a single point of failure, so #5:
      const health = feelingHealth();
      // ENFORCED IN CODE (audit fix, was prompt-only): the agent is a RunnerStateAgent — it may
      // only manage the RESIDUAL RUNNER, i.e. AFTER the principal has been banked (deRisked).
      // Before de-risk, exits are MECHANICAL only (catastrophic + trailing); the agent isn't even
      // consulted, so it can't cut a position early / kill a would-be winner before we're safe.
      const agentManages = feelingEnabled && health.alive && pos.deRisked; // agent ONLY on the residual runner
      if (agentManages) {
        if (heldMs > config.feeling.minHoldMs && Date.now() - pos.lastVibeMs > config.feeling.everyMs) {
          pos.lastVibeMs = Date.now();
          void this.checkVibe(mint, pos, execPnl, drawdownFromPeak, quietForMs, price);
        }
      } else {
        // MECHANICAL net: before de-risk (agent not allowed) OR agent down. Rigid by design.
        // (Dev-dump is handled by the always-on fast escape above — no longer duplicated here.)
        // The agent still WATCHES these in shadow so its mandate can later be judged on evidence.
        if (feelingEnabled && health.alive && heldMs > config.feeling.shadowMinHoldMs) {
          this.maybeShadowJudge(mint, pos, execPnl, drawdownFromPeak, quietForMs, price);
        }
        // The fallback stop still respects the hold floor. NOTE: no `continue` when the floor
        // isn't met — the dynamic trailing stop below must run on EVERY tick regardless.
        if (heldMs > config.feeling.minHoldMs) {
          const mtmPnl = pos.lastPnlPct ?? (pnlFromEntry - pos.costPct);
          if (mtmPnl <= config.risk.agentFallback.stopLossPct) {
            this.close(mint, pos, price, "FALLBACK_STOP"); // catastrophic floor only
            continue;
          }
        }
      }

      // DYNAMIC TRAILING PROFIT-LOCK — the round-trip fix. Not a fixed stop (those
      // gap through on a rug — SHEEP −77%); this trails from the PEAK with a band that
      // LOOSENS as the peak gain grows. It only ever locks a WIN (armed above +15%),
      // so it can't book a fresh loss — a coin that never pumped is left to the agent /
      // dev-dump / graduated exits above. A mega-runner (+300%) gets a 100% band = never
      // trail-stopped, left to ride. This is the layer that was missing when Cowl went
      // +94%→−100%: it would have banked ~+55% on the pullback instead.
      // Uses the EXECUTABLE peak/drawdown (#6) — the band is chosen by the highest sellable
      // gain, and it triggers on a pullback in what we could ACTUALLY realize, not the spot.
      let trailPct = dynamicTrailPct(execPeakGainPct); // null until armed (+15% executable)
      // Keep `armed` truthful. It was set false at open and never set anywhere else — a leftover
      // of the removed fixed-trail design (its `trailArmPct` config is long gone), yet it was
      // still persisted and shown on the dashboard, so the console always read "not armed" no
      // matter how far a position had run. It now reflects the real state: is the trail live?
      pos.armed = trailPct !== null;
      // FADE TIGHTENING: the band above encodes how HIGH the coin got but not how LONG AGO. A
      // position drifting well past its high has most likely finished climbing (median peak is
      // 82s), and a wide band lets it bleed the gain away too slowly to ever trigger. Tighten
      // once no new high has been set for `afterPeakSec`. The stamp resets on every new high, so
      // a coin still climbing is never affected.
      const fade = config.risk.fadeTighten;
      let faded = false;
      if (trailPct !== null && fade.enabled && pos.peakExecAtMs) {
        const sincePeakSec = (Date.now() - pos.peakExecAtMs) / 1000;
        if (sincePeakSec >= fade.afterPeakSec) { trailPct *= fade.bandMult; faded = true; }
      }
      if (trailPct !== null && trailPct < 100 && execDrawdownPct <= -trailPct) {
        if (faded) logRecord("events", { type: "fade-tighten-exit", mint, symbol: pos.candidate.symbol,
          execPeakGainPct: Number(execPeakGainPct.toFixed(1)), execDrawdownPct: Number(execDrawdownPct.toFixed(1)),
          tightenedBandPct: Number(trailPct.toFixed(1)), secSincePeak: Math.round((Date.now() - (pos.peakExecAtMs ?? 0)) / 1000), cfg: configHash });
        this.close(mint, pos, price, "TRAIL_LOCK");
      } else if (heldMs >= config.risk.absoluteMaxHoldMs) {
        // Capital hygiene backstop — don't let a stuck zombie hold a slot forever.
        this.close(mint, pos, price, "MAX_HOLD");
      }
    }
    if (this.positions.size) this.save(); // persist live prices/P&L for the dashboard
    // #8 staleness telemetry: if a tick takes longer than its own interval, positions are
    // NOT being read every interval (the audit's tick-age concern) — surface it.
    const tickMs = Date.now() - tickStart;
    const interval = mode === "fast-follow" ? 4_000 : 20_000;
    const durs = (this.tickDurations[mode] ??= []);
    durs.push(tickMs);
    if (durs.length > PaperTrader.TICK_WINDOW) durs.shift();
    if (tickMs > interval && this.positions.size > 0) {
      const sorted = [...durs].sort((a, b) => a - b);
      const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
      logRecord("events", { type: "tick-slow", mode, tickMs, interval, positions: this.positions.size, batched: ffKeys.length,
        p50Ms: pct(0.5), p95Ms: pct(0.95), p99Ms: pct(0.99) });
      this.consecutiveSlowTicks[mode] = (this.consecutiveSlowTicks[mode] ?? 0) + 1;
      if (this.consecutiveSlowTicks[mode]! >= 2) {
        ui.warn(`[paper] ${mode} tick has missed its ${interval}ms interval ${this.consecutiveSlowTicks[mode]} times in a row (latest ${tickMs}ms) — positions are going stale between reads`);
        notify("integrity", `${mode} monitoring tick has been slow ${this.consecutiveSlowTicks[mode]}x in a row (latest ${tickMs}ms vs ${interval}ms target, p95=${pct(0.95)}ms) — open positions are not being re-priced on schedule.`);
      }
    } else {
      this.consecutiveSlowTicks[mode] = 0;
    }
    } finally {
      this.ticking[mode] = false; // release the per-mode mutex
    }
  }

  /**
   * Compare the creator's current token holding to their holding at entry.
   * Returns "DUMP" if they sold a large share (rug escape), else updates the
   * buy-back conviction flag. No-op when the creator is unknown.
   */
  private async trackDev(mint: string, pos: Position, force = false): Promise<"DUMP" | "OK"> {
    const creator = pos.candidate.creator;
    if (!creator || pos.devEntryBalance == null) return "OK";
    // RPC THROTTLE (latency fix): this ran on EVERY 4s tick for EVERY open position — with 10
    // positions that alone is 2.5 req/s of an 8 req/s budget, competing directly with entries.
    // The real-time path for a dev dump is the DevWatcher WebSocket push (onDevActivity →
    // force=true), which is both faster and free; this poll is only the backstop for a missed
    // push, so a 20s cadence loses nothing.
    if (!force && Date.now() - (pos.lastDevCheckMs ?? 0) < config.dev.pollMs) return "OK";
    pos.lastDevCheckMs = Date.now();
    const now = await tokenBalanceOfOwner(creator, mint);
    if (now == null) return "OK";
    pos.devLastBalance = now; // what the dev STILL holds — used to model their sell landing ahead of ours

    // Dump: creator sold a large share of a holding they actually had.
    if (pos.devEntryBalance > 0 && now <= pos.devEntryBalance * (1 - config.dev.dumpExitPct)) {
      const dropPct = Math.round((1 - now / pos.devEntryBalance) * 100);
      logRecord("events", { type: "dev-dump", mint, creator, dropPct });
      return "DUMP";
    }

    // Buy-back: creator's holding grew by a meaningful fraction of supply
    // (measured vs supply so a 0→positive first dev-buy is caught, which is the
    // common pump.fun case where the dev buys on the curve like everyone).
    if (!pos.devBuyBack && pos.supply && pos.supply > 0) {
      const grewFrac = (now - pos.devEntryBalance) / pos.supply;
      if (grewFrac >= config.dev.buybackSupplyFrac) {
        pos.devBuyBack = true;
        const addPctOfSupply = (grewFrac * 100).toFixed(2);
        logRecord("events", { type: "dev-buyback", mint, creator, addPctOfSupply });
        ui.pass(`[paper] DEV BUY-BACK ${pos.candidate.symbol ?? mint} — creator added ${addPctOfSupply}% of supply (long-term signal)`);
      }
    }
    return "OK";
  }

  /**
   * DEVNET mirror: when the console is in devnet mode, drive the REAL execution
   * pipeline (build→sign→send→confirm) for this trade signal against devnet with
   * faucet SOL. Throttled + best-effort: it NEVER blocks or breaks the paper loop
   * (paper accounting is authoritative; this only proves the transport is live).
   */
  private mirrorDevnet(kind: "buy" | "sell", mint: string, symbol?: string): void {
    if (readControl().execMode !== "devnet") return;
    if (Date.now() - this.lastDevnetMs < 15_000) return; // don't hammer the devnet RPC/faucet
    this.lastDevnetMs = Date.now();
    void devnetMirror(kind)
      .then((r) => {
        logRecord("events", { type: "devnet-exec", kind, mint, symbol, ok: r.ok, sig: r.signature, ms: r.ms, signMs: r.signMs, needsFunding: r.needsFunding, err: r.err });
        if (r.ok) ui.info(`[devnet] ${kind} ${symbol ?? mint} — signed ${r.signMs}ms, confirmed ${r.ms}ms, sig ${r.signature?.slice(0, 12)}…`);
        else if (r.needsFunding) ui.warn(`[devnet] ${kind} ${symbol ?? mint} — awaiting faucet SOL (send devnet SOL to the bot address to activate)`);
        else ui.warn(`[devnet] ${kind} ${symbol ?? mint} — send failed: ${r.err}`);
      })
      .catch(() => { /* best-effort: never surface into the paper loop */ });
  }

  /**
   * LADDERED SCALE-OUT (owner's "ambil partial saat naik tinggi"). As execPnl climbs, sell
   * the configured fraction at each rising tier it has crossed — banking the run
   * progressively (captures more of the peak on medium winners) while the un-sold runner
   * tail keeps riding the dynamic trail for the fat tail. Each tier fires exactly once
   * (guarded by pos.scaleTier). All accounting is the faithful curve walk.
   */
  private scaleOutLadder(mint: string, pos: Position, execPnl: number): void {
    if (!this.positions.get(mint)) return;
    if (!pos.tokenQty || pos.tokenQty <= 0 || !pos.lastVSol || !pos.lastVTokens) return;
    const tiers = config.risk.scaleOut.tiers;
    const startTier = pos.scaleTier ?? -1;
    // WALK the reserves across tiers fired on the SAME tick (audit fix: they used to all price
    // off the same pre-sell reserves = too optimistic). Each sell moves vSol down / vTokens up.
    let wVSol = pos.lastVSol, wVTokens = pos.lastVTokens, wRealSol = pos.lastRealSol;
    for (let i = startTier + 1; i < tiers.length; i++) {
      const t = tiers[i]!;
      if (execPnl < t.gain) break; // tiers are ascending — stop at the first not-yet-reached
      // Sell fraction is of the ORIGINAL token quantity. Use the qty RECORDED at entry rather
      // than reconstructing it from the tier fractions: reconstruction assumes every prior tier
      // sold exactly its configured fraction, which is false whenever minKeepFrac clamped one —
      // the error then compounds into every later tier's size. originalTokenQty is the measured
      // truth, so the fractions stay exact.
      const originalQty = pos.originalTokenQty ?? (pos.tokenQty / (1 - this.soldSoFar(pos)));
      const qSell = clampedScaleSellQty(
        originalQty,
        pos.tokenQty,
        t.sell,
        config.risk.scaleOut.minKeepFrac,
      );
      // A tier clamped to zero did not happen. Never advance UI/accounting progress on a
      // non-event; later tiers cannot sell more while the same min-keep invariant applies.
      if (qSell <= 0) break;
      const proceeds = pos.graduated && pos.gradSyntheticNetReserves
        ? syntheticAmmExitProceedsSol(wVSol, wVTokens, qSell, wRealSol)
        : curveExitProceedsSol(wVSol, wVTokens, qSell, pos.candidate.pool, pos.graduated, wRealSol);
      // move the sim reserves after this sell so the NEXT tier prices off the reduced pool
      const grossOut = curveSellSolGross(wVSol!, wVTokens!, qSell);
      wVSol = (wVSol ?? 0) - grossOut; wVTokens = (wVTokens ?? 0) + qSell; if (wRealSol != null) wRealSol = Math.max(0, wRealSol - grossOut);
      const costBasis = pos.sizeSol * (qSell / pos.tokenQty);
      // Same correction as the final leg, for the same reason: a scale-out at +50% is exactly
      // the kind of gain the chain says only half-materialises. Leaving partials raw while
      // correcting the remaining leg would quietly restore the optimism through the side door.
      const rawBanked = proceeds - costBasis;
      const bankedRealism = costBasis > 0
        ? applyExecutionRealism((rawBanked / costBasis) * 100)
        : { pct: 0, applied: false, ratio: null, band: null, bandN: null, calN: null };
      const bankedPnl = costBasis > 0 ? costBasis * (bankedRealism.pct / 100) : rawBanked;
      pos.partialPnlSol += bankedPnl;
      this.hypotheticalRealizedPnlSol += bankedPnl; // audit P0-2: hypothetical always, primary gated below
      // Owner (2026-07-27, after a profitable MANUAL_CLOSE on a would-fail-stage position
      // didn't show up anywhere): a would-fail buy is still excluded from primary AT PARTIAL
      // TIME (execStage may still flip later) — but if the position later gets manually
      // closed, close() below back-fills this partial's share too via partialPnlIncludedInPrimary.
      if (pos.execStage === "executable") { this.realizedPnlSol += bankedPnl; pos.partialPnlIncludedInPrimary = (pos.partialPnlIncludedInPrimary ?? 0) + bankedPnl; }
      pos.recoveredSol = (pos.recoveredSol ?? 0) + proceeds; // cumulative GROSS proceeds banked
      pos.tokenQty -= qSell;
      pos.sizeSol -= costBasis;
      pos.scaleTier = i;
      // TRUE principal-first (owner spec): "de-risked / house money" is only real once the
      // cumulative partial PROCEEDS have returned the ORIGINAL stake — NOT after the first tier
      // (which only banks ~22% at +50%). Uses executable proceeds after fee+impact, not chart %.
      pos.deRisked = (pos.recoveredSol ?? 0) >= pos.originalSizeSol;
      // Re-seed the trail HWM to the smaller remaining position. The fade-tightening CLOCK must
      // re-seed with it: the runner tail is a fresh position, and leaving the old stamp would let
      // an already-elapsed timer apply a tightened band immediately after a partial — cutting the
      // very runner the tail exists to keep.
      pos.peakExecProceeds = undefined;
      pos.peakExecAtMs = Date.now();
      // ── FULL PARTIAL RECORD (owner: "catat semua, jangan asumsi") ──
      // Previously this logged the TIER THRESHOLD as `atGainPct` and the CONFIGURED fraction as
      // `soldFrac`. Both are intentions, not events: a tick can gap from +25% straight to +47%
      // (the tier fires at +47%, not +30%), and minKeepFrac can clamp the sold amount below the
      // configured fraction. Reading those two fields as outcomes silently turns a measurement
      // into an assumption. Now every field is what ACTUALLY happened, with the intended values
      // kept alongside under explicit names so the two can never be confused.
      // Jupiter-derived synthetic reserves already reproduce NET route output. The embedded
      // venue/route fee is not separately identifiable, so never invent or charge it again.
      const feeSol = pos.graduated && pos.gradSyntheticNetReserves
        ? null
        : grossOut * curveFeeFrac(pos.candidate.pool, pos.graduated);
      logRecord("paper-trades", {
        action: "PARTIAL", tradeId: pos.tradeId, decisionId: pos.decisionId ?? null, measurementEpoch: config.measurementEpoch,
        policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live", regimeId: regimeOf(pos),
        reason: "SCALE_OUT_LADDER", tier: i, mint, symbol: pos.candidate.symbol, mode: pos.candidate.mode,
        execStage: pos.execStage ?? null, // audit P0-2: lets replay/dashboard exclude would-fail partials too
        // WHAT ACTUALLY HAPPENED
        execPnlPct: Number(execPnl.toFixed(2)),                 // real executable P&L when the tier fired
        soldFrac: Number((qSell / originalQty).toFixed(4)),     // real fraction of the original qty sold
        tokenQtySold: Number(qSell.toFixed(2)),
        proceedsSol: Number(proceeds.toFixed(6)),              // NET SOL received (after fee + gas)
        grossOutSol: Number(grossOut.toFixed(6)),              // before fee + gas
        feeSol: feeSol == null ? null : Number(feeSol.toFixed(6)),
        feeEmbeddedInQuote: feeSol == null || undefined,
        gasSol: Number(gasPerSideSol().toFixed(6)),
        costBasisSol: Number(costBasis.toFixed(6)),
        pnlSol: Number(bankedPnl.toFixed(6)),
        priceSolAtSale: wVSol && wVTokens ? Number((wVSol / wVTokens).toExponential(6)) : null,
        vSolAtSale: wVSol != null ? Number(wVSol.toFixed(6)) : null,   // reserves AFTER this leg's walk
        vTokensAtSale: wVTokens != null ? Number(wVTokens.toFixed(2)) : null,
        realSolAtSale: wRealSol != null ? Number(wRealSol.toFixed(6)) : null,
        // POSITION STATE AFTER THE SALE
        remainingSizeSol: Number(pos.sizeSol.toFixed(6)),
        remainingQty: Number(pos.tokenQty.toFixed(2)),
        remainingFrac: Number((pos.tokenQty / originalQty).toFixed(4)),
        recoveredSol: Number((pos.recoveredSol ?? 0).toFixed(6)), // cumulative banked vs stake
        deRisked: pos.deRisked ?? false,
        heldSec: Math.round((Date.now() - pos.openedAt) / 1000),
        // WHAT WAS INTENDED (config), kept separate so it is never mistaken for the outcome
        tierGainPct: t.gain, tierSellFrac: t.sell,
        clamped: Math.abs(qSell / originalQty - t.sell) > 1e-6, // minKeepFrac reduced the sale
        sv: config.strategyVersion, cfg: configHash,
      });
      ui.pass(`[paper] SCALE-OUT ${pos.candidate.symbol ?? mint} tier +${t.gain}% — sold ${(t.sell * 100).toFixed(0)}% (+${bankedPnl.toFixed(4)} SOL); ${(this.remainingFrac(pos) * 100).toFixed(0)}% still riding`);
      // LIVE MIRROR: same fraction-of-ORIGINAL the record books as `soldFrac`, so the live
      // ladder tracks the paper ladder tier for tier. The bridge clamps it to the real balance.
      bridgeSellFraction(pos.tradeId, mint, qSell / originalQty, `SCALE_OUT_T${i}`);
    }
    if ((pos.scaleTier ?? -1) > startTier) {
      // Persist our hypothetical partial impact. The next raw mainnet mark excludes this paper
      // sell, so applyObservedCurve() must replay only the external delta onto THESE reserves.
      pos.lastVSol = wVSol;
      pos.lastVTokens = wVTokens;
      pos.lastRealSol = wRealSol;
    }
    this.save();
  }
  /** Fraction of the ORIGINAL position already sold across fired tiers. */
  private soldSoFar(pos: Position): number {
    const tiers = config.risk.scaleOut.tiers;
    let s = 0; for (let i = 0; i <= (pos.scaleTier ?? -1); i++) s += tiers[i]?.sell ?? 0;
    return Math.min(0.95, s);
  }
  private remainingFrac(pos: Position): number { return Math.max(0, 1 - this.soldSoFar(pos)); }

  private close(mint: string, pos: Position, price: number, reason: string): void {
    // IDEMPOTENT GUARD (#4): overlapping ticks + async checkVibe + dev-push can all try to
    // close the SAME position. Only the first wins. Identity check (not just has()) also
    // rejects a stale `pos` whose mint was since re-opened as a different position.
    const live = this.positions.get(mint);
    if (!live || live !== pos) return;

    // The spot price move (display/telemetry only — NOT how P&L is booked anymore).
    const grossPnl = pos.entryPriceUsd > 0 ? ((price - pos.entryPriceUsd) / pos.entryPriceUsd) * 100 : 0;
    let legPnlPct: number; // realized % on the remaining leg
    let effCostPct: number; // emergent cost (impact + fees + haircut) = gross − realized
    let proceedsSol: number | undefined;
    // ── ITEMISED EXIT COST (owner: "fee jangan asumsi") ──
    // `costPct` alone is an EMERGENT blend of price impact + protocol fee + gas + any haircut,
    // so "berapa fee yang dibayar?" could only be answered by re-deriving it from config — i.e.
    // by assumption. These capture each component of the actual exit leg as SOL.
    let exitGrossSol: number | null = null, exitFeeSol: number | null = null, exitHaircutSol: number | null = null, ataReclaimedSol = 0;
    if (pos.tokenQty && pos.tokenQty > 0 && pos.priceMode === "sol") {
      // FAITHFUL EXIT: sell the ACTUAL tokenQty back into the EXIT reserves (real two-sided
      // slippage + self-impact of dumping our size + per-venue fee). No fixed costPct.
      let net: number;
      if (
        (reason === "GRADUATED" || pos.graduated)
        && pos.gradSyntheticNetReserves
        && pos.lastVSol
        && pos.lastVTokens
      ) {
        // Reserve reconstruction reproduces Jupiter's NET route output for the CURRENT remaining
        // quantity. It stays correct after same-tick partials and receives no second venue fee.
        let routeNetGross = curveSellSolGross(pos.lastVSol, pos.lastVTokens, pos.tokenQty);
        if (pos.lastRealSol != null && pos.lastRealSol >= 0) routeNetGross = Math.min(routeNetGross, pos.lastRealSol);
        exitGrossSol = routeNetGross;
        exitFeeSol = null; // embedded in the Jupiter quote; not separately identifiable
        net = syntheticAmmExitProceedsSol(pos.lastVSol, pos.lastVTokens, pos.tokenQty, pos.lastRealSol);
      } else if ((reason === "GRADUATED" || pos.graduated) && pos.gradProceedsSol != null) {
        // VERIFIED graduation: a real Jupiter AMM sell quote for tokenQty (#Fase-A-2). This is
        // the direct full-quantity fallback when reserve reconstruction was unavailable.
        net = pos.gradProceedsSol;
      } else if ((reason === "GRADUATED" || pos.graduated) && price > 0) {
        // Fallback estimate (no Jupiter route): value tokenQty at the graduation price net of
        // AMM fee + gas. Stays flagged UNVERIFIED in the log.
        net = Math.max(0, pos.tokenQty * price * (1 - curveFeeFrac(pos.candidate.pool, true)) - gasPerSideSol());
      } else {
        const vSolX = price <= 0 ? 0 : (pos.lastVSol ?? pos.entryVSol); // drained/rug → 0 reserve → ~0 proceeds
        const vTokX = pos.lastVTokens ?? pos.entryVTokens ?? 0;
        net = curveExitProceedsSol(vSolX, vTokX, pos.tokenQty, pos.candidate.pool, pos.graduated, pos.lastRealSol);
        // Same walk the proceeds function performs, captured so the fee is recorded, not inferred.
        let g = curveSellSolGross(vSolX, vTokX, pos.tokenQty);
        if (pos.lastRealSol != null && pos.lastRealSol >= 0) g = Math.min(g, pos.lastRealSol);
        exitGrossSol = g;
        exitFeeSol = g * curveFeeFrac(pos.candidate.pool, pos.graduated);
      }
      const beforeHaircut = net;
      // ── DEV-DUMP FILL MODEL (replaces a flat 25% guess) ──
      // MEASURED PROBLEM: the flat haircut was DOUBLE-COUNTING. The escape reads fresh reserves
      // from chain immediately before closing (currentPrice → lastVSol/lastVTokens), so whatever
      // the dev has already sold is ALREADY in the price; multiplying by 0.75 on top charged it
      // twice. Over 26 dev-dump exits that penalty was 0.261◎ — 14× the real fees and more than
      // half the entire run's loss — turning flat coins (median peak +0.0%) into −33% trades.
      // The flat number made sense only in the OLD flow, where we waited 11-16s for the LLM and
      // exited on stale reserves.
      // WHAT IS STILL REAL: we are racing the dev, so any part of their bag not yet sold can land
      // ahead of our fill. That is modelled from the balance we actually track — walk the dev's
      // REMAINING holding through the curve first, then take our proceeds from the reserves that
      // leaves. Faithful and measured, not a guess. If the balance is unknown we fall back to the
      // conservative flat haircut rather than flattering the fill.
      if (reason === "DEV_DUMP") {
        const devQty = pos.devLastBalance;
        // KNOWN balance — including ZERO, which is the DOMINANT case: pump.fun devs typically
        // sell their whole bag, and the dump is detected once ≥50% is gone. A first version of
        // this guarded on `devQty > 0` and so fell through to the flat haircut exactly when the
        // dev had nothing left to sell — the one case where NO extra penalty is correct, because
        // the reserves we just re-read already contain their completed sale. Measured: that bug
        // left the haircut at 12.8× the real fees instead of removing it.
        if (devQty != null && pos.lastVSol && pos.lastVTokens && pos.tokenQty) {
          if (devQty > 0) {
            const devOut = curveSellSolGross(pos.lastVSol, pos.lastVTokens, devQty); // their remainder lands first
            const vS = Math.max(0, pos.lastVSol - devOut), vT = pos.lastVTokens + devQty;
            const afterReal = pos.lastRealSol != null ? Math.max(0, pos.lastRealSol - devOut) : undefined;
            const after = pos.graduated && pos.gradSyntheticNetReserves
              ? syntheticAmmExitProceedsSol(vS, vT, pos.tokenQty, afterReal)
              : curveExitProceedsSol(vS, vT, pos.tokenQty, pos.candidate.pool, pos.graduated, afterReal);
            net = Math.min(net, after); // never fill better than behind them
          }
          // devQty === 0 → nothing left to front-run us; fresh reserves are the honest fill.
        } else {
          net *= 1 - config.risk.devDumpHaircutPct / 100; // balance genuinely unknown → stay conservative
        }
      }
      // STALE (verify): a token we couldn't price for ~60s may have died during the read-fail
      // window — the last reserves are optimistic. Haircut the proceeds so STALE isn't over-credited.
      if (reason === "STALE") net *= 1 - config.risk.staleHaircutPct / 100;
      exitHaircutSol = beforeHaircut - net; // 0 unless a DEV_DUMP/STALE penalty actually applied
      // RECLAIM the ATA rent on the final exit. The position is fully sold here, so the token
      // balance is zero and SPL CloseAccount can return the rent-exempt lamports (minus the close
      // transaction's own gas). Charged at entry in curveEntryTokenQty(); returned here.
      if (config.risk.ataReclaim) {
        ataReclaimedSol = Math.max(0, config.risk.ataRentSol - gasPerSideSol());
        net += ataReclaimedSol;
      }
      proceedsSol = net;
      const legSol0 = Math.max(-pos.sizeSol, net - pos.sizeSol); // can't lose more than the size put in
      legPnlPct = (legSol0 / pos.sizeSol) * 100;
      effCostPct = grossPnl - legPnlPct; // what the curve+fees actually cost vs the spot move
    } else {
      // Swing/USD fallback (no bonding-curve reserves): spot ratio minus fixed modeled cost.
      const cost = price <= 0 ? pos.costPct / 2 : pos.costPct;
      const extraHaircut = reason === "DEV_DUMP" || pos.devDumped ? config.risk.devDumpHaircutPct : 0;
      legPnlPct = Math.max(-100, grossPnl - cost - extraHaircut);
      effCostPct = cost + extraHaircut;
    }
    // ── EXECUTION REALISM ────────────────────────────────────────────────────
    // The model has now said what the trade was worth. This says what it would have BEEN PAID,
    // using the measured transfer function between this simulator's claims and the chain's
    // answer on the same trades (see execution/exec-realism.ts). Applied here and nowhere else:
    // every exit DECISION above ran on the raw mark and is untouched — only the booking changes.
    const rawLegPnlPct = legPnlPct;
    const realism = applyExecutionRealism(legPnlPct);
    legPnlPct = realism.pct;
    // Keep the itemised trail coherent: cost is defined as gross minus what we realized, so it
    // has to absorb the execution reality too, otherwise the record no longer adds up.
    effCostPct = grossPnl - legPnlPct;
    const legSol = pos.sizeSol * (legPnlPct / 100); // SOL from the remaining leg
    // Total realized for this trade = remaining leg + any partial already banked (0 today).
    const pnlSol = legSol + pos.partialPnlSol;
    // Original notional (pre-partial) for a representative % of the whole trade.
    const pnlPct = (pnlSol / pos.originalSizeSol) * 100;
    // HYPOTHETICAL ledger — every close, regardless of whether the buy would have executed.
    this.hypotheticalRealizedPnlPct += legPnlPct;
    this.hypotheticalRealizedPnlSol += legSol;
    if (pnlSol >= 0) this.hypotheticalWins++; else this.hypotheticalLosses++;
    // PRIMARY ledger — EXECUTABLE, OR a MANUAL close/flatten (owner 2026-07-27: "kalau aku close
    // manual pun itu profit, harusnya dihitung" — a would-fail buy sim is excluded by DEFAULT
    // since it never really would have spent SOL, but a human's deliberate decision to close is
    // real regardless of what the entry-simulation predicted, so it overrides the exclusion).
    const manualOverride = reason === "MANUAL_CLOSE" || reason === "MANUAL_FLATTEN";
    if (pos.execStage === "executable" || manualOverride) {
      // Back-fill any partial proceeds this position banked while it was still excluded (e.g.
      // would-fail at partial-time, only qualifying now via manualOverride) — otherwise a
      // manually-closed trade with prior partials would undercount by exactly that amount.
      const partialPending = pos.partialPnlSol - (pos.partialPnlIncludedInPrimary ?? 0);
      this.realizedPnlPct += legPnlPct; // note: partial's % already logged separately
      this.realizedPnlSol += legSol + partialPending;
      if (pnlSol >= 0) this.wins++;
      else this.losses++;
    }
    this.positions.delete(mint);
    this.tradeStream.unwatch(mint); // stop crowd streaming for a closed token
    // Remember this exit for the smart re-entry guard: why we left, when, how
    // many times we've now touched it, and the activity level at exit (so a
    // future re-entry must show a genuinely fresh high).
    const prev = this.exitHistory.get(mint);
    // Bound the re-entry memory. It is only consulted within the cooldown/attempt window, but was
    // only ever cleared on a run reset — so on a 24/7 run it accumulated one entry per mint ever
    // traded. Keep a generous window (well past any cooldown) and drop the rest.
    if (this.exitHistory.size > 2_000) {
      const cutoff = Date.now() - 24 * 60 * 60_000;
      for (const [m, h] of this.exitHistory) if (h.at < cutoff) this.exitHistory.delete(m);
    }
    this.exitHistory.set(mint, {
      reason,
      at: Date.now(),
      attempts: (prev?.attempts ?? 0) + 1,
      lastPeakVSol: pos.peakVSol ?? 0,
    });
    // Stop watching this creator if no other open position needs it.
    const creator = pos.candidate.creator;
    if (creator && ![...this.positions.values()].some((p) => p.candidate.creator === creator)) {
      this.watcher.unwatch(creator);
    }
    this.save();
    logRecord("paper-trades", {
      action: "CLOSE",
      // ── TRUTH SCHEMA ──────────────────────────────────────────────────────────
      // Primary target is `netExecutablePnlSol`: SOL actually realisable for OUR quantity
      // under a fixed policy and horizon. Descriptive outcomes (pump-then-rug, faded,
      // graduated) stay LABELS — they must never define profit again.
      //
      // The evaluation harness this replaces scored a launch as BAD when it drained and WIN
      // when it peaked >=100%, as two independent predicates. Measured: 52 launches satisfied
      // BOTH — 43% of everything it called a win — with a median peak of +201% and a max of
      // +9421%. Those are exactly the trades a partial-harvest policy exists to capture, and
      // the harness was scoring them as failures.
      tradeId: pos.tradeId,
      decisionId: pos.decisionId ?? null,
      measurementEpoch: config.measurementEpoch, // legacy rows lack this — never pool them
      policyId: config.strategyVersion,       // which exit policy produced this number
      armId: process.env.ARM_ID ?? "live",    // interleaved A/B/C arms land here
      regimeId: regimeOf(pos),                // curve/protocol regime — never pooled blindly
      quoteSource: pos.graduated ? "jupiter-amm" : pos.priceMode === "sol" ? "bonding-curve" : "dexscreener",
      parserVersion: CURVE_PARSER_VERSION,
      netExecutablePnlSol: Number(pnlSol.toFixed(6)),
      netExecutablePnlPct: Number(pnlPct.toFixed(2)),
      mint,
      symbol: pos.candidate.symbol,
      reason,
      entry: pos.entryPriceUsd,
      exit: price,
      peak: pos.peakPriceUsd,
      grossPnlPct: Number(grossPnl.toFixed(2)),
      costPct: Number(effCostPct.toFixed(2)),
      // ── WHAT THE MODEL SAID, BESIDE WHAT EXECUTION WOULD PAY ──
      // Never overwrite the raw figure: comparing cohorts across the day this landed is only
      // possible because both numbers survive in the same row.
      rawPnlPct: Number(rawLegPnlPct.toFixed(2)),
      execRealismApplied: realism.applied,
      execRealismRatio: realism.ratio,
      execRealismBand: realism.band,
      execRealismCalN: realism.calN,
      pnlPct: Number(pnlPct.toFixed(2)),
      sizeSol: pos.sizeSol,
      tokenQty: pos.tokenQty != null ? Number(pos.tokenQty.toFixed(2)) : undefined, // faithful fill: qty sold
      proceedsSol: proceedsSol != null ? Number(proceedsSol.toFixed(5)) : undefined, // real SOL back from the curve
      pnlSol: Number(legSol.toFixed(6)), // remaining-leg SOL (partial banked separately at PARTIAL)
      tradePnlSol: Number(pnlSol.toFixed(6)), // total trade SOL incl. partial (for display)
      partialSol: Number(pos.partialPnlSol.toFixed(6)),
      // ── ITEMISED COSTS + RECONCILIATION TRAIL (measured, never re-derived from config) ──
      exitGrossSol: exitGrossSol != null ? Number(exitGrossSol.toFixed(6)) : null,   // before fee/gas/haircut
      exitFeeSol: exitFeeSol != null ? Number(exitFeeSol.toFixed(6)) : null,         // protocol + routing on the exit leg
      exitHaircutSol: exitHaircutSol != null ? Number(exitHaircutSol.toFixed(6)) : null, // DEV_DUMP/STALE penalty, 0 if none
      // The dev's remaining balance drives the DEV_DUMP fill model. Logged so "was the penalty
      // modelled or did it fall back to the flat guess?" is answerable from the record — the
      // exact question that exposed the inverted-condition bug in the first version.
      devLastBalance: pos.devLastBalance != null ? Number(pos.devLastBalance.toFixed(2)) : null,
      image: pos.candidate.image ?? null,
      themeCrowd: pos.candidate.themeCrowd ?? null, themeWord: pos.candidate.themeWord ?? null,
      gasSol: Number(gasPerSideSol().toFixed(6)),
      ataRentSol: Number(config.risk.ataRentSol.toFixed(6)), // charged at entry (measured on-chain)
      ataReclaimedSol: Number(ataReclaimedSol.toFixed(6)), // returned by SPL CloseAccount at exit

      entrySizeSol: Number(pos.originalSizeSol.toFixed(6)),   // stake at entry (sizeSol shrinks as partials sell)
      entryPriceSol: pos.entryPriceUsd,                        // fast-follow prices ARE SOL/token
      exitPriceSol: price,
      entryQty: pos.originalTokenQty != null ? Number(pos.originalTokenQty.toFixed(2)) : null,
      exitQty: pos.tokenQty != null ? Number(pos.tokenQty.toFixed(2)) : null, // qty left for this final leg
      entryVSol: Number((pos.entryVSol ?? 0).toFixed(6)), entryVTokens: Number((pos.entryVTokens ?? 0).toFixed(2)),
      exitVSol: pos.lastVSol != null ? Number(pos.lastVSol.toFixed(6)) : null,
      exitVTokens: pos.lastVTokens != null ? Number(pos.lastVTokens.toFixed(2)) : null,
      exitRealSol: pos.lastRealSol != null ? Number(pos.lastRealSol.toFixed(6)) : null,
      partialCount: (pos.scaleTier ?? -1) + 1, // how many PARTIAL rows belong to this trade
      recoveredSol: Number((pos.recoveredSol ?? 0).toFixed(6)),
      heldSec: Math.round((Date.now() - pos.openedAt) / 1000),
      devBuyBack: pos.devBuyBack,
      devOnlyBuys: pos.devOnlyBuys,
      mode: pos.candidate.mode, // per-mode data isolation (owner wants clean per-mode validation)
      // Graduation now uses a REAL Jupiter AMM sell quote when available (verified); only flag
      // UNVERIFIED when we had to fall back to the curve-price estimate (no route).
      graduationUnverified: (pos.graduated && pos.gradProceedsSol == null) || undefined,
      gradVerified: pos.graduated ? pos.gradProceedsSol != null : undefined,
      // ── SELF-CONTAINED ANALYTICS (owner: "answer with DATA not assumptions") ──
      // Every CLOSE now carries the peak reached, how much of it we captured, and the FULL
      // entry signature — so any question (fat-tail math, winner-DNA, capture rate, latency)
      // is answered by reading the trade record alone, never by modelling/guessing.
      peakPct: (() => { const e = pos.entryPriceUsd; return e > 0 ? Number((((pos.peakPriceUsd - e) / e) * 100).toFixed(1)) : 0; })(),
      peakAtSec: pos.peakAtSec ?? 0, // WHEN the ATH happened (sec from open) — owner's minute-to-ATH benchmark
      fadedAfterPeakSec: pos.peakAtSec != null ? Math.max(0, Math.round((Date.now() - pos.openedAt) / 1000) - pos.peakAtSec) : null, // how long it took to exit AFTER the peak (held into the fade)
      // % of the peak move we actually banked. DEFINED ONLY for a winning trade on a real peak:
      //   • peak < 5%  → dividing by ~0 produced values in the hundreds of millions
      //   • realized ≤ 0 → "captured −690% of the peak" is not a fraction of anything; a losing
      //     trade captured nothing, and mixing these into a mean silently destroys it
      // Losses are measured by pnlPct/tradePnlSol; capture is a winners-only metric by definition.
      capturePct: (() => { const e = pos.entryPriceUsd; const pk = e > 0 ? ((pos.peakPriceUsd - e) / e) * 100 : 0;
        const realized = (pnlSol / pos.originalSizeSol) * 100;
        return pk >= 5 && realized > 0 ? Number((realized / pk * 100).toFixed(1)) : null; })(),
      // entry signature (momentum confirm)
      velSol: pos.candidate.confirmStats?.velSol ?? null,
      buyers: pos.candidate.confirmStats?.uniqueBuyers ?? null,
      buyPressurePct: pos.candidate.confirmStats?.buyPressurePct ?? null,
      accel: pos.candidate.confirmStats?.accel ?? null,
      confirmGrownPct: pos.candidate.confirmStats?.grownPct ?? null,
      confirmAgeSec: pos.candidate.confirmStats?.ageSec ?? null,
      // safety / quality signals at entry
      coordinated: pos.candidate.rugCluster?.coordinated ?? null,
      clusterWallets: pos.candidate.rugCluster?.clusterWallets ?? null,
      devFundedBuyers: pos.candidate.rugCluster?.devFundedBuyers ?? null,
      rawScore: pos.candidate.rawScore ?? null,
      // Per-component score ledger. rawScore is measurably INVERTED against outcome (48-52
      // bucket: 39% win / -2.1%; 62+ bucket: 18% win / -21.4%), and without this we cannot
      // tell which bonus causes it. Logged on every close so the answer becomes measurable.
      scoreParts: pos.candidate.scoreParts ?? null,
      // Wash-trade tape metrics at confirm time. The leading hypothesis for the score inversion
      // is that our bonuses reward what a wash fleet manufactures; these measure that directly.
      bothSidesPct: pos.candidate.washStats?.bothSidesPct ?? null,
      tradesPerTrader: pos.candidate.washStats?.tradesPerTrader ?? null,
      avgTradeSol: pos.candidate.washStats?.avgTradeSol ?? null,
      washScore: pos.candidate.washStats?.washScore ?? null,
      sniperPct: pos.candidate.whaleSniperPct != null ? Number(pos.candidate.whaleSniperPct.toFixed(1)) : null,
      bundlerPct: pos.candidate.whaleBundlerPct != null ? Number(pos.candidate.whaleBundlerPct.toFixed(1)) : null,
      devPct: pos.candidate.whaleDevPct != null ? Number(pos.candidate.whaleDevPct.toFixed(1)) : null,
      holders: pos.candidate.holders ?? null,
      mcUsd: pos.candidate.marketCapUsd != null ? Math.round(pos.candidate.marketCapUsd) : null, // jupiter MC (sparse, ~6% coverage)
      curveMcSol: pos.entryMcSol != null ? Number(pos.entryMcSol.toFixed(2)) : null, // RELIABLE entry MC from curve (100% coverage) — the rug-zone study field
      curveMcUsd: pos.entryMcUsd != null ? Math.round(pos.entryMcUsd) : null,
      entryRealSol: pos.entryRealSol != null ? Number(pos.entryRealSol.toFixed(4)) : null, // real SOL paid in at entry — demand signal free of the launch constant
      devInitialBuySol: pos.candidate.devInitialBuySol ?? null, // dev's own buy at launch — the filter's basis, joined per trade
      launchMcSol: pos.candidate.marketCapSol ?? null, // MC at the create event (dev buy only)
      // RELIABLE demand-quality (RPC-based) for organic-vs-manufactured — joined with curveMcSol per trade
      bundleSlotMax: pos.candidate.launchBundle?.sameSlotMax ?? null, bundleShare: pos.candidate.launchBundle?.bundledShare ?? null,
      bundleVerified: pos.candidate.launchBundle?.verifiedBuys ?? null, creatorFunders: pos.candidate.creatorFunders?.length ?? null,
      organic: pos.candidate.organicScore ?? null,
      // execution reality
      execStage: pos.execStage ?? null,
      launchpad: pos.candidate.pool ?? null,
      isMayhemMode: pos.candidate.isMayhemMode ?? false,
      isCashbackCoin: pos.candidate.isCashbackCoin ?? false,
      quoteMint: pos.candidate.quoteMint ?? null,
      deRisked: pos.deRisked ?? false,
      scaleTier: pos.scaleTier ?? null,
      sv: config.strategyVersion, cfg: configHash,
    });
    // PATTERN MEMORY — snapshot the ENTRY conditions alongside the OUTCOME. Over many
    // trades this builds a learned profile: which entry signatures precede a +1000%
    // runner vs a dud. The bot's own "why did it moon" reference (owner's idea).
    // ONLY momentum entries (fast-follow with a real confirm signature) belong here —
    // a swing/DexScreener entry has no buyers/buy-pressure/accel fingerprint, so it would
    // pollute the winner-DNA with null columns (the "—" bug in the DNA tab). Skip those.
    // PATTERN = the FROZEN entry SNAPSHOT (data available AT ENTRY only, no leakage) + outcome.
    // The old version logged confirmStats (T+45-180s momentum data) as the entry signature —
    // that was target leakage. Now we log the entrySnapshot captured at open, so cohort
    // analysis (winner/loser/skipped) compares SETUP evidence, not future momentum.
    const c = pos.candidate, snap = pos.entrySnapshot;
    const peakPct = pos.entryPriceUsd > 0 ? Number((((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(1)) : 0;
    logRecord("patterns", {
      tradeId: pos.tradeId, decisionId: pos.decisionId ?? null, measurementEpoch: config.measurementEpoch,
      policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live", regimeId: regimeOf(pos),
      symbol: c.symbol, mint, launchpad: c.pool, reason,
      // FROZEN ENTRY SNAPSHOT (setup evidence only — no post-entry momentum)
      setupVerdict: snap?.setupVerdict ?? null, setupConfidence: snap?.setupConfidence ?? null, setupEvidence: snap?.setupEvidence ?? null,
      // WHICH data was missing is why a setup landed UNKNOWN rather than CLEAN. It was captured in
      // the snapshot but never written here, so "why are most setups UNKNOWN?" was unanswerable
      // from the record — exactly the kind of gap that forces guessing.
      setupMissing: snap?.setupMissing ?? null,
      holders: snap?.holders ?? null, mcUsd: snap?.mcUsd ?? null, organic: snap?.organic ?? null,
      sniperPct: snap?.sniperPct ?? null, bundlerPct: snap?.bundlerPct ?? null, devPct: snap?.devPct ?? null,
      clusterVerdict: snap?.clusterVerdict ?? null, devFundedBuyers: snap?.devFundedBuyers ?? null,
      actorRiskProb: snap?.actorRiskProb ?? null, actorConfidence: snap?.actorConfidence ?? null,
      hasSocials: snap?.hasSocials ?? null, execStage: pos.execStage ?? null, decisionLatencyMs: snap?.decisionLatencyMs ?? null,
      // OUTCOME
      peakPct, peakAtSec: pos.peakAtSec ?? null, closePnlPct: Number(pnlPct.toFixed(1)),
      // Same winners-only definition as the CLOSE record. The old form divided by `peakPct || 1`,
      // which on a flat coin silently substituted a 1% denominator and manufactured a capture
      // figure out of nothing — worse than the CLOSE bug because it never even looked wrong.
      capturePct: (() => { const realized = pos.originalSizeSol > 0 ? (pnlSol / pos.originalSizeSol) * 100 : 0;
        return peakPct >= 5 && realized > 0 ? Number((realized / peakPct * 100).toFixed(1)) : null; })(),
      heldSec: Math.round((Date.now() - pos.openedAt) / 1000), bigWin: peakPct >= 100, moon: peakPct >= 500,
      cfg: configHash,
    });
    // Actor memory: attribute this outcome to the creator + funding lineage (probabilistic).
    recordOutcome({ creator: c.creator, funders: c.creatorFunders, metaHash: c.metaHash,
      // "rugged" = the ACTOR rugged (drained liquidity or dev dumped), NOT merely that OUR trade
      // lost (a −80% from our own trailing/exit timing isn't the actor's fault — audit fix).
      rugged: reason === "LIQUIDITY_GONE" || (pos.devDumped === true),
      abandoned: reason === "STALE" || reason === "MAX_HOLD",
      sellableWin: pnlPct > 0, devSellSec: pos.devDumped ? Math.round((Date.now() - pos.openedAt) / 1000) : null, at: Date.now() });
    const line = `[paper] CLOSE ${pos.candidate.symbol ?? mint} ${reason} net ${pnlPct.toFixed(1)}% = ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL | ${this.wins}W/${this.losses}L, cum ${this.realizedPnlSol >= 0 ? "+" : ""}${this.realizedPnlSol.toFixed(3)} SOL`;
    pnlPct >= 0 ? ui.pass(line) : ui.reject(line);

    // Register the token for POST-EXIT tracking — keep watching its price so we can
    // later learn if this exit was premature and what the ideal hold would have been.
    this.registerPostExit(pos, mint, pos.candidate.symbol, reason, price, pnlPct, Math.round((Date.now() - pos.openedAt) / 1000));
    this.mirrorDevnet("sell", mint, pos.candidate.symbol); // devnet mode: prove the real send pipeline
    // LIVE MIRROR: sell the whole real bag. If this sell fails the bridge keeps the lot and
    // its sweeper retries — a closed paper position never abandons a real one.
    bridgeClose(pos.tradeId, mint, reason);
    this.maybeResetRun();
  }

  // REMOVED: getWinnerDNA(). It computed an average "winner profile" from the patterns log and
  // was only ever consumed by the agent prompt rule that has itself been deleted — the profile
  // was built from confirmStats (captured at T+45-180s, i.e. AFTER entry), so feeding it back as
  // an entry prior was target leakage. Dead since that removal; deleting it so nothing silently
  // re-wires a leaky prior back into the decision path.

  /** Start tracking a just-closed token's price to learn if the exit was premature. */
  private registerPostExit(pos: Position, mint: string, symbol: string | undefined, reason: string, exitPrice: number, exitPnlPct: number, heldSec: number): void {
    if (!config.postExit.enabled) return;
    if (this.postExit.size >= config.postExit.maxTracked) return; // bound load
    const tradeId = pos.tradeId;
    // Baseline in SOL from the swap-api tape so post-exit samples are same-unit,
    // regardless of the position's price mode. Fire-and-forget.
    void latestPriceSol(mint).then((p) => {
      const base = p ?? (exitPrice > 0 ? exitPrice : 0);
      if (base <= 0) return;
      if (this.postExitDone.has(tradeId) || this.postExit.has(tradeId)) return; // never track one trade twice
      this.postExit.set(tradeId, {
        tradeId, decisionId: pos.decisionId, mint, symbol, reason, exitTs: Date.now(),
        exitPriceSol: base, exitPnlPct, heldSec, peakPct: 0, peakAtSec: 0, samples: 0,
        summarised: false, policyId: config.strategyVersion, armId: process.env.ARM_ID ?? "live",
        regimeId: regimeOf(pos),
      });
    });
  }

  /**
   * Sample every tracked closed token's live price. Records the peak move vs our exit
   * and, when the window ends, writes a post-exit summary — the data that answers
   * "should we have held longer?" across many trades.
   */
  private async trackPostExit(): Promise<void> {
    if (this.postExit.size === 0 || this.postExitRunning) return; // re-entrancy guard (see field docs)
    this.postExitRunning = true;
    try {
    for (const [key, t] of [...this.postExit]) {
      const mint = t.mint;
      const ageMs = Date.now() - t.exitTs;
      const price = await latestPriceSol(mint);
      if (price && price > 0) {
        const pct = ((price - t.exitPriceSol) / t.exitPriceSol) * 100;
        t.samples++;
        if (pct > t.peakPct) { t.peakPct = pct; t.peakAtSec = Math.round(ageMs / 1000); }
        logRecord("post-exit", {
          type: "sample", tradeId: t.tradeId, decisionId: t.decisionId ?? null,
          measurementEpoch: config.measurementEpoch, policyId: t.policyId, armId: t.armId, regimeId: t.regimeId,
          mint, symbol: t.symbol, secSinceExit: Math.round(ageMs / 1000), pctVsExit: Number(pct.toFixed(1)),
        });
      }
      if (ageMs >= config.postExit.windowMs && !t.summarised && !this.postExitDone.has(t.tradeId)) {
        t.summarised = true; this.postExitDone.add(t.tradeId); // exactly one summary per tradeId+horizon
        // Verdict: did it run enough after we sold that our exit was premature?
        const premature = t.peakPct >= config.postExit.prematureRisePct;
        logRecord("post-exit", {
          type: "summary", tradeId: t.tradeId, decisionId: t.decisionId ?? null,
          measurementEpoch: config.measurementEpoch, policyId: t.policyId, armId: t.armId, regimeId: t.regimeId,
          horizonSec: Math.round(config.postExit.windowMs / 1000), mint, symbol: t.symbol, exitReason: t.reason, exitPnlPct: Number(t.exitPnlPct.toFixed(1)),
          heldSec: t.heldSec, maxRiseAfterExitPct: Number(t.peakPct.toFixed(1)), peakAtSec: t.peakAtSec,
          windowMin: Math.round(config.postExit.windowMs / 60000), verdict: premature ? "premature" : "ok",
        });
        const tag = premature ? `PREMATURE — lari +${t.peakPct.toFixed(0)}% ${t.peakAtSec}s setelah exit` : `ok (max +${t.peakPct.toFixed(0)}% pasca-exit)`;
        ui.info(`[post-exit] ${t.symbol ?? mint} (${t.reason}): ${tag}`);
        this.postExit.delete(key);
      } else if (ageMs >= config.postExit.windowMs) {
        this.postExit.delete(key); // window over but already summarised — just stop tracking
      }
    }
    } finally { this.postExitRunning = false; }
  }

  /**
   * End-of-trial check: a 1-SOL run that has bled below the floor (can't afford a
   * trade, nothing open to recover) or hit the trade cap is recorded to the run
   * ledger and reset to a fresh 1 SOL — so the bot never sits idle-broke, and many
   * trials reveal the true distribution (and the drawdown a live float must survive).
   */
  /**
   * AUDIT P0-1 SAFEGUARD — alert on a consecutive run of would-fail buy simulations instead of
   * waiting for a manual audit to notice hours later. Fires once at 10-in-a-row (early warning,
   * well under the 264 that went unnoticed on 2026-07-27), then again every +50 so a still-broken
   * regression keeps nagging without spamming every single trade.
   */
  private trackExecSimStreak(stage: string, label: string, err?: string | null): void {
    if (stage === "executable") { this.consecutiveWouldFail = 0; return; }
    if (stage !== "would-fail") return; // theoretical/tx-built are funding/routing issues, not this
    this.consecutiveWouldFail++;
    const n = this.consecutiveWouldFail;
    if (n === 10 || (n > 10 && n % 50 === 0)) {
      const msg = `${n} consecutive BUY simulations would-fail on mainnet (latest: ${label}${err ? `, ${err}` : ""}). ` +
        `Either PumpPortal's tx builder or the RPC pool is broken — paper trades opening right now are not executable. See PROFITABILITY_TODO / audit P0-1.`;
      ui.warn(`[exec-sim] ${msg}`);
      if (Date.now() - this.lastWouldFailAlertAt > 5 * 60_000) { // don't re-notify inside the same 5min burst
        notify("integrity", msg);
        this.lastWouldFailAlertAt = Date.now();
      }
    }
  }

  private resetting = false; // guard: liquidation below calls close()→maybeResetRun (recursion)
  private maybeResetRun(): void {
    if (!config.autoReset.enabled || this.resetting) return;
    const trigBal = this.balanceSol();
    if (trigBal < this.runMinBalanceSol) this.runMinBalanceSol = trigBal; // track deepest drawdown
    const trades = this.wins + this.losses;
    const broke = trigBal < config.risk.startingFloatSol * config.autoReset.resetFloorFrac && trades >= config.autoReset.minTradesBeforeBroke;
    const maxed = trades >= config.autoReset.maxTradesPerRun;
    if (!broke && !maxed) return;

    // MARK-TO-MARKET (#4): do NOT abandon open positions to a dead run — liquidate each at
    // its last known price through the normal close() path so its P&L is BOOKED into the
    // run's final equity. Guarded by `resetting` so close()→maybeResetRun doesn't recurse.
    this.resetting = true;
    try { for (const [mint, pos] of [...this.positions]) this.close(mint, pos, pos.lastPriceUsd ?? pos.entryPriceUsd, "RUN_RESET"); }
    finally { this.resetting = false; } // a throw mid-liquidation must never strand the flag true (would disable auto-reset forever)

    const bal = this.balanceSol(); // now settled — every position liquidated into realizedPnlSol
    const pnl = this.realizedPnlSol;
    const start = config.risk.startingFloatSol;
    logRecord("run-ledger", {
      run: this.runNumber, reason: broke ? "broke" : "maxtrades", trades: this.wins + this.losses, wins: this.wins, losses: this.losses,
      startSol: start, finalSol: Number(bal.toFixed(4)), pnlSol: Number(pnl.toFixed(4)), minSol: Number(this.runMinBalanceSol.toFixed(4)),
      strategyVersion: config.strategyVersion, cfg: configHash, // tag so #6 never pools different strategy versions/configs
      // AUDIT P0-2: the figures above are EXECUTABLE-ONLY (would-fail closes excluded). These are
      // the full, unfiltered "if every simulated buy had actually landed" figures, kept alongside
      // for comparison — never to be read as the run's real performance.
      hypotheticalTrades: this.hypotheticalWins + this.hypotheticalLosses,
      hypotheticalWins: this.hypotheticalWins, hypotheticalLosses: this.hypotheticalLosses,
      hypotheticalPnlSol: Number(this.hypotheticalRealizedPnlSol.toFixed(4)),
    });
    // A RESET marker in the trade log partitions the run for the dashboard balance.
    logRecord("paper-trades", { action: "RESET", run: this.runNumber, finalSol: Number(bal.toFixed(4)), pnlSol: Number(pnl.toFixed(4)) });
    const line = `[paper] ══ RUN #${this.runNumber} ${broke ? "BROKE" : "capped"} — ${this.wins + this.losses} trades, final ${bal.toFixed(3)} SOL (${pnl >= 0 ? "+" : ""}${pnl.toFixed(3)}), min ${this.runMinBalanceSol.toFixed(3)}. Fresh ${start} SOL → run #${this.runNumber + 1} ══`;
    pnl >= 0 ? ui.pass(line) : ui.reject(line);

    // Clear residual per-run state (positions already liquidated above).
    for (const [mint, pos] of this.positions) { if (pos.candidate.creator) this.watcher.unwatch(pos.candidate.creator); this.tradeStream.unwatch(mint); }
    this.positions.clear();
    this.exitHistory.clear();
    this.realizedPnlSol = 0;
    this.realizedPnlPct = 0;
    this.wins = 0;
    this.losses = 0;
    this.hypotheticalRealizedPnlSol = 0;
    this.hypotheticalRealizedPnlPct = 0;
    this.hypotheticalWins = 0;
    this.hypotheticalLosses = 0;
    this.runNumber++;
    this.runMinBalanceSol = start;
    this.save();
  }

  /**
   * LEDGER RECONCILIATION — proves the recorded numbers ARE the numbers the bot traded on.
   * Re-reads the append-only log for the current run and checks that
   *   Σ(PARTIAL.pnlSol) + Σ(CLOSE.pnlSol)  ==  the in-memory realized P&L
   * If those ever diverge, some P&L was booked without a record (or a record double-counts) and
   * every analysis built on the log is wrong. Rather than trusting that silently, the mismatch is
   * logged as a `data-integrity` event and warned on the console. Also reports any NaN/Infinity
   * caught by the log sanitizer. Cheap (reads only the current day's trade log) and read-only.
   */
  private verifyLedger(): void {
    try {
      let logged = 0, rows = 0;
      const files = readdirSync(config.logDir).filter((f) => f.startsWith("paper-trades") && f.endsWith(".jsonl")).sort();
      const allLines: string[] = [];
      for (const f of files) allLines.push(...readFileSync(join(config.logDir, f), "utf8").split("\n"));

      // Same tradeId-based qualification as load()'s PASS 1 — must match exactly, or a
      // manually-closed would-fail trade reads as "unexplained drift" here.
      const qualifies = new Map<string, boolean>();
      for (const line of allLines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { action?: string; tradeId?: string; execStage?: string; reason?: string };
          if (r.action !== "CLOSE" || !r.tradeId) continue;
          qualifies.set(r.tradeId, r.execStage === "executable" || r.reason === "MANUAL_CLOSE" || r.reason === "MANUAL_FLATTEN");
        } catch { /* skip malformed line */ }
      }

      for (const line of allLines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { action?: string; tradeId?: string; pnlSol?: number; execStage?: string };
          if (r.action === "RESET") { logged = 0; rows = 0; continue; } // tally is per-run
          const ok = (r.tradeId && qualifies.has(r.tradeId)) ? qualifies.get(r.tradeId)! : r.execStage === "executable";
          if ((r.action === "CLOSE" || r.action === "PARTIAL") && ok) { logged += r.pnlSol ?? 0; rows++; }
        } catch { /* skip partial line */ }
      }
      // ROUNDING-AWARE TOLERANCE. Logged amounts are written at 6dp, so each record can differ
      // from the in-memory value by up to half an ulp and the error accumulates with row count.
      // A fixed 1e-6 threshold would therefore fire on healthy data once a few hundred trades
      // accumulate — and an alarm that cries wolf is worse than no alarm, because it trains you
      // to ignore the one time it is real. Verified on 403 archived closes: the only "mismatches"
      // found were exactly 1e-5, i.e. pure toFixed rounding, not lost P&L.
      const drift = logged - this.realizedPnlSol;
      const tolerance = Math.max(1e-6, rows * 1e-6);
      const ok = Math.abs(drift) <= tolerance;
      if (!ok || logIntegrity.badFields > 0) {
        logRecord("events", { type: "data-integrity", ok, rows,
          loggedPnlSol: Number(logged.toFixed(9)), memoryPnlSol: Number(this.realizedPnlSol.toFixed(9)),
          driftSol: Number(drift.toFixed(9)), toleranceSol: Number(tolerance.toFixed(9)),
          badNumericFields: logIntegrity.badFields, lastBad: logIntegrity.lastBad, cfg: configHash });
        if (!ok) {
          ui.warn(`[integrity] ledger drift ${drift.toFixed(9)} SOL across ${rows} records — the log does NOT match booked P&L`);
          // Silent data corruption is the worst 24/7 failure: the bot keeps trading and every
          // number you later analyse is wrong. This is worth waking someone up for.
          notify("integrity", `Ledger drift ${drift.toFixed(6)}◎ over ${rows} records — recorded P&L no longer matches booked P&L.`);
        }
        if (logIntegrity.badFields > 0) ui.warn(`[integrity] ${logIntegrity.badFields} non-finite numeric field(s) rejected, last: ${logIntegrity.lastBad}`);
      } else if (Date.now() - this.lastIntegrityBeatMs >= INTEGRITY_BEAT_MS) {
        // POSITIVE HEARTBEAT. This audit only ever logged on FAILURE, and it is wrapped in a
        // catch-all — so an audit that throws on every run (a bad path, a rename) is
        // indistinguishable from a healthy one: both are perfectly silent. A periodic "ok"
        // makes silence itself the alarm. Hourly, so it cannot flood the event log.
        this.lastIntegrityBeatMs = Date.now();
        logRecord("events", { type: "data-integrity-ok", rows, loggedPnlSol: Number(logged.toFixed(9)),
          memoryPnlSol: Number(this.realizedPnlSol.toFixed(9)), driftSol: Number(drift.toFixed(9)), cfg: configHash });
      }
    } catch (err) {
      // Never let an audit break trading — but never let it die silently either. Before this,
      // a permanently-throwing audit looked exactly like a permanently-passing one.
      logRecord("events", { type: "data-integrity-error", error: (err as Error)?.message ?? String(err), cfg: configHash });
    }
  }

  summary(): string {
    // % is P&L against the starting float (honest), NOT the sum of per-trade percentages.
    const pctOfFloat = (this.realizedPnlSol / config.risk.startingFloatSol) * 100;
    return `${this.wins}W/${this.losses}L, cum ${this.realizedPnlSol >= 0 ? "+" : ""}${this.realizedPnlSol.toFixed(3)} SOL (${pctOfFloat >= 0 ? "+" : ""}${pctOfFloat.toFixed(1)}%), open ${this.positions.size}`;
  }

  // (removed realizedSol() — never called; the dashboard derives realized P&L from the
  //  append-only trade log, which is the durable source of truth.)

  // ── Persistence: survive restarts, no orphaned OPEN log lines ───────────────
  private save(): void {
    try {
      writeFileSync(STATE_PATH, JSON.stringify({
        positions: [...this.positions.values()], wins: this.wins, losses: this.losses, realizedPnlPct: this.realizedPnlPct,
        hypotheticalWins: this.hypotheticalWins, hypotheticalLosses: this.hypotheticalLosses, hypotheticalRealizedPnlPct: this.hypotheticalRealizedPnlPct,
      }));
    } catch { /* best-effort */ }
  }

  private load(): void {
    // Rebuild the running tally from the append-only paper-trades log — the
    // durable source of truth, so restarts never lose history.
    // Time-ordered close map: latest CLOSE timestamp per mint. A snapshot OPEN is only
    // dropped if the log proves it was closed AT OR AFTER it was opened — a genuine
    // earlier re-entry (closed, then re-opened later) is no longer wrongly discarded (#4).
    const closedAt = new Map<string, number>();
    try {
      const files = readdirSync(config.logDir).filter((f) => f.startsWith("paper-trades") && f.endsWith(".jsonl")).sort();
      const allLines: string[] = [];
      for (const f of files) allLines.push(...readFileSync(join(config.logDir, f), "utf8").split("\n"));

      // PASS 1: which tradeIds qualify for the PRIMARY ledger — executable, OR ended in a
      // manual close/flatten (owner 2026-07-27: a deliberate manual close counts regardless of
      // what the entry simulation predicted). Read from the CLOSE record only, since that is
      // where the final execStage/reason for the whole trade lives.
      const qualifies = new Map<string, boolean>();
      for (const line of allLines) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { action?: string; tradeId?: string; execStage?: string; reason?: string };
          if (rec.action !== "CLOSE" || !rec.tradeId) continue;
          qualifies.set(rec.tradeId, rec.execStage === "executable" || rec.reason === "MANUAL_CLOSE" || rec.reason === "MANUAL_FLATTEN");
        } catch { /* skip malformed line */ }
      }

      // PASS 2: the actual tally, same structure as before but using the PASS-1 decision
      // (falling back to the record's own execStage for legacy rows with no tradeId).
      for (const line of allLines) {
        if (!line.trim()) continue;
        try {
            const rec = JSON.parse(line) as { action?: string; mint?: string; tradeId?: string; pnlPct?: number; pnlSol?: number; tradePnlSol?: number; sizeSol?: number; ts?: string; execStage?: string };
            // A RESET marker ends a trial: zero the running tally so we load only
            // the CURRENT run, and bump the trial counter.
            if (rec.action === "RESET") {
              this.realizedPnlSol = 0; this.realizedPnlPct = 0; this.wins = 0; this.losses = 0;
              this.hypotheticalRealizedPnlSol = 0; this.hypotheticalRealizedPnlPct = 0;
              this.hypotheticalWins = 0; this.hypotheticalLosses = 0;
              this.runNumber++; continue;
            }
            // AUDIT P0-2 + manual-override: a would-fail buy never actually spent SOL UNLESS a
            // human deliberately closed it anyway — see PASS 1 above.
            const executable = (rec.tradeId && qualifies.has(rec.tradeId)) ? qualifies.get(rec.tradeId)! : rec.execStage === "executable";
            if (rec.action === "PARTIAL") {
              this.hypotheticalRealizedPnlSol += rec.pnlSol ?? 0;
              if (executable) this.realizedPnlSol += rec.pnlSol ?? 0;
              continue;
            }
            if (rec.action !== "CLOSE") continue;
            if (rec.mint) closedAt.set(rec.mint, Math.max(closedAt.get(rec.mint) ?? 0, rec.ts ? Date.parse(rec.ts) : Date.now()));
            const pnl = rec.pnlPct ?? 0;
            const pnlSolVal = rec.pnlSol ?? (rec.sizeSol ?? config.risk.paperTradeSizeSol) * (pnl / 100);
            this.hypotheticalRealizedPnlPct += pnl;
            this.hypotheticalRealizedPnlSol += pnlSolVal;
            if ((rec.tradePnlSol ?? rec.pnlSol ?? pnl) >= 0) this.hypotheticalWins++; else this.hypotheticalLosses++;
            if (executable) {
              this.realizedPnlPct += pnl;
              this.realizedPnlSol += pnlSolVal;
              if ((rec.tradePnlSol ?? rec.pnlSol ?? pnl) >= 0) this.wins++; else this.losses++;
            }
        } catch { /* skip partial line */ }
      }
      if (this.wins + this.losses > 0) {
        // Report P&L against the FLOAT, not the sum of per-trade percentages. Summing percentages
        // is not a portfolio return: 18 trades averaging −21% printed "cum −390.7%", which reads as
        // losing 3.9× the account and is impossible. realizedPnlSol ÷ float is the real figure.
        const pct = (this.realizedPnlSol / config.risk.startingFloatSol) * 100;
        ui.info(`[paper] history: ${this.wins}W/${this.losses}L, ${this.realizedPnlSol >= 0 ? "+" : ""}${this.realizedPnlSol.toFixed(4)} SOL (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% of float) — from log`);
      }
    } catch { /* no log yet */ }

    // Restore currently-open positions from the transient snapshot.
    if (!existsSync(STATE_PATH)) return;
    try {
      const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { positions: Position[] };
      // Guard: skip any snapshot position that the log shows already closed
      // (prevents the duplicate-close artifact seen after chaotic restarts).
      for (const p of s.positions ?? []) {
        const ct = closedAt.get(p.candidate.mint);
        if (ct != null && ct >= p.openedAt) continue; // closed AFTER it was opened → genuinely done
        // Migrate snapshots written before tiered TP: derive the new fields from
        // the old single-tier shape so a restart never NaNs the P&L math.
        const legacy = p as Position & { partialTaken?: boolean };
        if (p.originalSizeSol == null) {
          p.partialsTaken = legacy.partialTaken ? 1 : 0;
          p.originalSizeSol = legacy.partialTaken ? p.sizeSol / 0.5 : p.sizeSol;
        }
        // Migrate pre-field snapshots. graduated defaults FALSE now (it doubles as the
        // AMM-vs-curve fee selector — a still-on-curve restored position must charge the
        // launchpad fee, not the AMM 0.25%). The next tick sets it true if bc.complete.
        if (p.graduated == null) { p.graduated = false; p.entryVSol = p.entryVSol ?? p.peakVSol ?? 0; }
        this.positions.set(p.candidate.mint, p);
      }
      if (this.positions.size) ui.info(`[paper] restored ${this.positions.size} open position(s) from disk`);
    } catch { /* start fresh */ }
  }
}
