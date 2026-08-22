/**
 * Exact shapes returned by the backend (src/server.ts) — hand-typed against the LIVE running
 * server's real JSON output (not guessed), so field names/nullability match reality. Verified by
 * curl-ing `/api/stats`, `/api/analytics`, `/api/wallet` against the live Strategy 2 process.
 *
 * Organized to mirror the panel catalog from the React rewrite plan: Strategy 2 fields (the
 * PRIMARY data path, per `strategy2Primary`) are listed first; legacy sniper-only fields (kept
 * only because several panels are hidden-but-still-rendered, per the old app.html's own comments
 * about "unguarded writes must not throw") follow below.
 */

// ── Strategy 2 (PRIMARY) ──────────────────────────────────────────────────────

export interface EquityPoint {
  bal: number;
}

export interface OpenPosition {
  /** Exit-proximity fields — what will close this position, and how much room is left. */
  img?: string | null;
  peakPct?: number;
  fromPeakPct?: number;
  trailPct?: number;
  budgetSec?: number;
  budgetLabel?: string;
  sizeSol?: number;
  entryCostUsd?: number;
  image?: string;
  mint: string;
  symbol: string;
  unrealizedPnl: number; // percent
  heldSec: number;
  entryPrice: number; // synthetic (always 1) for Strategy 2 — see marketCap/holders for the real numbers
  lastPrice: number; // synthetic (1 + unrealizedPnl/100)
  noManualClose: true;
  /** null when the strategy does not track it for open positions (Strategy 1) — never coerce to 0. */
  marketCap: number | null;
  holders: number | null;
}

export interface RecentTrade {
  img?: string | null;
  ts: string;
  symbol: string;
  reason: string; // "TRAIL_STOP" | "MAX_HOLD" | "MANUAL_FLATTEN" | "..._NO_LIQUIDITY_FORCED"
  pnlPct: number;
  pnlUsd: number;
  heldHours: number;
}

export interface BySourceRow {
  source: string; // "gmgn-trending" | "gmgn-trenches" | "unknown" | ...
  n: number; // closed trades
  wins: number;
  winRate: number;
  pnlUsd: number;
  openN: number; // currently-open positions from this source (may be >0 with n===0 — "no closes yet", not "missing")
}

/**
 * Why each admission gate turned a candidate away. Added 2026-07-31 — before this the API
 * reported `rejected: 0` as a literal, so the dashboard could not distinguish "the scout found
 * nothing" from "everything found was filtered out", which is exactly the ambiguity that made an
 * empty positions panel unreadable.
 */
export interface GateRejections {
  deadToken: number; // live liquidity ~0 / no swaps in the last hour
  staleMc: number; // live market cap outside the band the candidate row claimed
  unroutable: number; // alive and liquid, but no swap route exists
  bundle: number; // 2+ top holders bought in the same second
  ath: number; // trading within 15% of all-time-high price
  cost: number; // entry friction above the configured ceiling
}

export interface Strategy2Primary {
  totals: { gated: number; passed: number; rejected: number; passRate: number };
  gateRejections: GateRejections;
  /** Distinct candidates the scout surfaced — deliberately NOT the same as totals.gated. */
  seenMints: number;
  funnel: { passed: number; bought: number };
  paper: {
    opens: number;
    closed: number;
    open: number;
    wins: number;
    losses: number;
    winRate: number;
    floatSol: number; // USD despite the name — field reused from the sniper shape
    balanceSol: number; // USD despite the name
    /**
     * Seconds since the Strategy 2 trader last completed a poll; null if it never reported one.
     * Anything large means the numbers on screen are frozen, not calm — see StaleBanner.
     */
    heartbeatAgeSec: number | null;
    equity: EquityPoint[];
    openPositions: OpenPosition[];
  };
  recentTrades: RecentTrade[];
  bySource: BySourceRow[];
}

export interface Strategy2PaperSummary {
  startingFloatUsd: number;
  equityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  wins: number;
  losses: number;
  winRate: number;
  openPositions: Array<{ mint: string; sym: string; entryCostUsd: number; unrealizedPct: number; heldHours: number; mcUsd: number; holders: number | null }>;
}

export interface ScoutCandidate {
  img?: string | null;
  ts: string;
  type: "strategy2-candidate";
  strategyTag: string;
  firstSeenAt: number;
  source: string;
  strategy2Epoch: string;
  cfg: string;
  mint: string;
  sym: string;
  mcUsd: number;
  liqUsd: number;
  holders: number;
  riskScore: number | null;
  rugged: boolean | null;
  change1h: number | null;
  change4h: number | null;
  change24h: number | null;
  hasSocials: boolean;
  twitterUrl: string | null;
  createdAt: number | null;
  isBoosted: boolean;
  isCommunityTakeover: boolean;
}

export interface Strategy2Scout {
  mode: string;
  count: number;
  candidates: ScoutCandidate[];
}

// ── Cross-cutting (used by both Strategy 2 and legacy panels) ─────────────────

/**
 * ONE bankroll in USD. Strategy 1 trades in SOL and Strategy 2 in USD; showing them as two
 * separate accounts meant wins scrolled through the journal while the headline balance sat
 * still. Money is combined here at the live rate; strategy stays a property of each trade.
 * Every USD field is null when no live SOL price is available — the SOL leg cannot be valued
 * without one, and guessing it is worse than saying so.
 */
export interface CombinedWallet {
  solUsd: number | null;
  totalUsd: number | null;
  floatUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  wins: number;
  losses: number;
  winRate: number;
  open: number;
  s1: { balanceUsd: number | null; floatUsd: number | null; balanceSol: number; floatSol: number; wins: number; losses: number; open: number };
  s2: { balanceUsd: number; floatUsd: number; wins: number; losses: number; open: number };
  /** Combined balance over time (both legs merged on wall-clock, SOL valued at the current rate). */
  equity: EquityPoint[];
}

/** Titik peluncuran untuk visual pasar di Hero: umur (detik) + market cap kurva (SOL). */
export interface LaunchPoint { a: number; mc: number }

export interface SystemInfo {
  dryRun: boolean;
  rpcTier: string;
  rugcheckKey: boolean;
  jupiterKey: boolean;
  snipeMaxMcSol: number;
  solscanBlockHeight?: number;
  solscanEpoch?: number;
  solUsd: number | null;
  uptimeSec: number;
  sniperAlive: boolean;
  strategy2Alive: boolean;
}

export interface ControlState {
  paused: boolean;
  execMode: "dry-run" | "simulate" | "devnet" | "live";
  command: { id: number; action: "flatten" | "close" | "reset-run"; mint?: string } | null;
  lastCommandId: number;
  risk: Partial<{ paperTradeSizeSol: number; catastrophicStopPct: number; scaleOutTriggerPct: number; minVelSol: number }>;
  strategy2Command: { id: number; action: "flatten" } | null;
  strategy2LastCommandId: number;
}

export interface MarketCoin {
  symbol: string;
  mint: string;
  /** null when the upstream feed omitted it — render "—", never "$0" (that reads as worthless). */
  mcUsd: number | null;
  ageMin: number | null;
  replies: number;
  /** Token art straight from pump.fun's coins response; null when it is not an https URL. */
  img?: string | null;
}

export interface MarketData {
  new: MarketCoin[];
  top: MarketCoin[];
  ageMs: number | null;
}

export interface MomentumRecent {
  symbol: string;
  grownPct: number;
  accel: number;
  ageSec: number;
  ts: string;
  buyPressurePct: number;
  uniqueBuyers: number;
  netBuyVolSol: number;
}

export interface MomentumInfo {
  confirmed: number;
  telemetry: number;
  dropped: number;
  recent: MomentumRecent[];
}

export interface AgentBeat {
  mood: string;
  say: string;
}

export interface AgentInfo {
  last: AgentBeat | null;
  recent: AgentBeat[];
}

export interface FeelingHealth {
  up: boolean;
  enabled: boolean;
  lastSuccessAt: number;
  consecutiveFailures: number;
  lastError: string | null;
  fallbackExits: number;
}

export interface FeelingInfo {
  enabled: boolean;
  model: string;
  calls: number;
  alive: number;
  dying: number;
  dead: number;
  exits: number;
  health: FeelingHealth;
  last: { vibe?: string; symbol?: string; reason?: string; confidence?: number; ts?: string } | null;
  recent: unknown[];
}

export interface RiskEnvelope {
  catastrophicStopPct: number;
  noDevelopment: { enabled: boolean; afterMs: number; minPeakPct: number };
  dynamicTrail: Array<{ gain: number; trail: number }>;
  scaleOutTiers: Array<{ gain: number; sell: number }>;
  entryMcBandSol: { floor: number; ceiling: number };
  /** What the sniper is REALLY entering at (last 200 opens) — the config above is the dashboard's own. */
  entryMcObserved: { n: number; min: number; median: number; max: number } | null;
}

export interface PostExitInfo {
  tracked: number;
  premature: number;
  prematurePct: number;
  avgMissedUpsidePct: number;
  worst: Array<{ symbol: string; exitReason?: string; exitPnlPct?: number; maxRiseAfterExitPct?: number; peakAtSec?: number }>;
}

export interface TotalsInfo {
  gated: number;
  passed: number;
  rejected: number;
  passRate: number;
  launches: number;
  takeovers: number;
}

export interface FunnelInfo {
  passed: number;
  bought: number;
}

// ── Legacy sniper-only fields (kept typed — several hidden panels still render them so
// pull()'s unguarded field access never throws; sniperAlive is always false in practice now) ──

export interface SniperOpenPosition {
  symbol: string;
  mode?: string;
  mint?: string;
  image?: string;
  entryPrice?: number;
  lastPrice?: number;
  unrealizedPnl?: number;
  peak?: number;
  heldSec?: number;
  armed?: boolean;
  graduated?: boolean;
  partialsTaken?: number;
  devOnlyBuys?: boolean;
  devBuyBack?: boolean;
  hasCreator?: boolean;
  holders?: number;
  marketCap?: number;
  marketCapSol?: number;
  deRisked?: boolean;
  coordinated?: boolean;
  rawScore?: number;
  velSol?: number;
}

export interface SniperPaper {
  opens: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number;
  sumOfTradePcts: number;
  returnPctOfFloat: number;
  exitReasons: Record<string, number>;
  tradeSizeSol: number;
  floatSol: number;
  realizedSol: number;
  balanceSol: number;
  compounding: boolean;
  equity: Array<{ t: string; bal: number }>;
  openPositions: SniperOpenPosition[];
}

export interface RecentDecision {
  ts: string;
  symbol: string;
  mint: string;
  mode: string;
  source: string;
  verdict: "PASS" | "REJECT";
  score: number;
  action: string;
  marketCap?: number;
  holders?: number;
  failed: string[];
}

export interface DnaProfile {
  n: number;
  holders: number | null;
  mcUsd: number | null;
  sniperPct: number | null;
  bundlerPct: number | null;
  devPct: number | null;
  entryLatencySec: number | null;
  cleanSetupPct: number | null;
  executablePct: number | null;
}

export interface PatternsInfo {
  total: number;
  winnerDNA: DnaProfile;
  moonDNA: DnaProfile;
  loserDNA: DnaProfile;
  topMoons: Array<{ peakPct?: number; holders?: number; mcUsd?: number; setupVerdict?: string; launchpad?: string }>;
}

export interface RunsInfo {
  completed: number;
  current: number;
  profitable: number;
  avgFinalSol: number | null;
  bestSol: number | null;
  worstSol: number | null;
  avgMinSol: number | null;
  avgRunPnl: number | null;
  ci: { lo: number; hi: number } | null;
  edge: "proven-positive" | "proven-negative" | "inconclusive" | "need-more-runs";
  strategyVersion: string;
  cfg: string;
  recent: Array<{ run?: number; trades?: number; finalSol?: number; pnlSol?: number; minSol?: number; reason?: string; cfg?: string | null; sameCfg?: boolean | null; measurementInvalid?: boolean }>;
  /** Across EVERY run and config — the only lifetime figure on the payload; everything else resets. */
  lifetime: { runs: number; profitable: number; pnlSol: number; trades: number };
}

export interface RpcInfo {
  rps: number;
  capacity: number;
  utilPct: number;
  hot: number;
  research: number;
  skipped: number;
  errors: number;
  rateLimited: number;
  inFlight: number;
  maxConcurrent: number;
  curveRejected: number;
  curveRejectReason: string | null;
  topMethods: Array<{ method: string; n: number }>;
  stale?: boolean;
  at?: number;
}

export interface GuardianInfo {
  halted: boolean;
  haltReason: string | null;
  spentLast24h: number;
  caps: { maxPerTradeSol: number; maxDeployedSol: number; maxDailySpendSol: number; feeReserveSol: number; reconcileToleranceSol: number };
  liveConfirmed: boolean;
}

/** Live-bridge readout (src/execution/live-bridge.ts). Armed only behind the double lock. */
export interface LiveTradeRow {
  ts: string; tradeId: string; mint: string; symbol: string | null; reason: string;
  spentSol: number; proceedsSol: number; netSol: number; netPct: number | null; heldSec: number;
}

export interface LiveSummary {
  trades: number;
  wins: number;
  losses: number;
  spentSol: number;
  proceedsSol: number;
  netSol: number;
  netPct: number | null;
  neverFilled: number;
  recent: LiveTradeRow[];
  equitySol: number[];
}

export interface LiveBridgeStatus {
  /** .env lock. False = the LIVE button is unavailable and no amount of clicking changes that. */
  permitted: boolean;
  armed: boolean;
  halted: boolean;
  haltReason: string | null;
  openLots: number;
  deployedSol: number;
  realizedSol: number;
  wallet: string;
  expectedBalanceSol: number | null;
  spentLast24h: number;
  caps: { maxPerTradeSol: number; maxDeployedSol: number; maxDailySpendSol: number; feeReserveSol: number; reconcileToleranceSol: number };
  clipSol: number;
  summary: LiveSummary;
}

export interface ExecSimInfo {
  total: number;
  ladder: { theoretical: number; "tx-built": number; unavailable: number; "would-fail": number; executable: number };
  executable: number;
  needsFunding: number;
  wouldFail: number;
  funded: boolean;
  recent: unknown[];
}

export interface ExecLiveInfo {
  venue: string;
  fired: number;
  confirmed: number;
  failed: number;
  needsFunding: number;
  avgSignMs: number | null;
  avgMs: number | null;
  lastSig: string | null;
  recent: unknown[];
}

export interface EntryLatency {
  n: number;
  medianSec: number;
  avgSec: number;
}

export interface LatencyBreakdown {
  n: number;
  allTime: { pre: number | null; gate: number | null; open: number | null; total: number | null };
  recent: { n: number; pre: number | null; gate: number | null; open: number | null; total: number | null };
}

export interface DataIntegrity {
  ok?: boolean;
  driftSol?: number;
  toleranceSol?: number;
  rows?: number;
  badNumericFields?: string[];
}

// ── Top-level /api/stats response ─────────────────────────────────────────────

export interface PipelineData {
  sources: Array<{ n: string; d: string; v: number; eng: string }>;
  skip: Record<string, number>;
  exits: Record<string, number>;
  gated: number;
  bought: number;
  openNow?: number;
  passedS2: number;
}

export interface BandWatch {
  floorSol: number; ceilSol: number; source: string;
  cfgFloorSol: number; cfgCeilSol: number; drift: boolean;
  launchMcSol: number; launchMedian: number | null; entryMedian: number | null;
  launches: number[];
  entries: Array<{ ts: string; mint?: string; sym: string; mcSol: number; img?: string | null; ageSec: number | null }>;
}

export interface StatsResponse {
  stall?: { launchAgeSec: number | null; decisionAgeSec: number | null; deadlocked: boolean; starved: boolean; stalled: boolean };
  bandWatch?: BandWatch;
  pipeline?: PipelineData;
  now: string;
  mode: string;
  usingPublicRpc: boolean;
  control: ControlState;
  combined: CombinedWallet;
  system: SystemInfo;
  totals: TotalsInfo;
  rpc: RpcInfo | null;
  strategy2Paper: Strategy2PaperSummary | null;
  strategy2Primary: Strategy2Primary | null;
  latencyBreakdown: LatencyBreakdown | null;
  setupToxicCodes: Record<string, number>;
  launchMcSkip: { n: number; floor: number };
  lateToxic: { n: number; recent: unknown[] };
  tickSlow: number;
  dataIntegrity: DataIntegrity | null;
  strategy2: Strategy2Scout;
  risk: RiskEnvelope;
  byMode: Record<string, number>;
  rejectionReasons: Record<string, number>;
  funnel: FunnelInfo;
  devSummary: { onlyBuys: number; buyBack: number; watched: number; unknown: number; dumpEvents: number; buybackEvents: number; onlyBuysEvents: number };
  pnlStats: { avgWin: number; avgLoss: number; best: number; worst: number; expectancy: number };
  execSim: ExecSimInfo;
  feeling: FeelingInfo;
  flow: { held: number; partials: number; guards: Array<{ key: string; label: string; n: number; kind: string }> };
  agent: AgentInfo;
  agentScorecard: { decisions: number; stateless: boolean; verdictMix: Record<string, number>; shadowOnly: number; exitQuality: unknown[]; note: string };
  runs: RunsInfo;
  launchField?: LaunchPoint[];
  momentum: MomentumInfo;
  market: MarketData;
  patterns: PatternsInfo;
  entryLatency: EntryLatency | null;
  byModePnl: Record<string, { closed: number; pnlSol: number; wins: number }>;
  postExit: PostExitInfo;
  scan: Array<{ s: string; p: boolean }>;
  guardian: GuardianInfo;
  liveBridge?: LiveBridgeStatus;
  execLive: ExecLiveInfo;
  paper: SniperPaper;
  paperHypothetical: { closed: number; wins: number; losses: number; winRate: number; sumOfTradePcts: number; realizedSol: number; wouldFailClosed: number };
  recentDecisions: RecentDecision[];
  recentTrades: Array<{ ts: string; symbol: string; reason?: string; pnlPct: number; image?: string; img?: string | null; grossPnlPct?: number; costPct?: number; pnlSol?: number; heldSec?: number; devOnlyBuys?: boolean }>;
}

// ── /api/analytics response ───────────────────────────────────────────────────

export interface McBandRow {
  label: string;
  n: number;
  deadPct: number;
  winPct: number;
  sol: number;
  solPerTrade: number;
  inBand: boolean;
}

export interface ExitLedgerRow {
  reason: string;
  n: number;
  sol: number;
  avgPnlPct: number;
  medianHoldMin: number;
}

export interface AnalyticsResponse {
  cfg: string;
  version: string;
  trades: number;
  outcomeDistribution: { rug: number; flat_0_20: number; small_20_100: number; big_100_500: number; moon_500plus: number };
  mcBand: { coverage: number; of: number; floor: number; ceiling: number; bands: McBandRow[] };
  exitLedger: ExitLedgerRow[];
  captureRate: { n: number; meanPct: number; medianPct: number };
  fatTail: { totalPnlSol: number; winners: number; winnerPnlSol: number; losers: number; loserPnlSol: number; avgLoserPct: number; biggestWinSol: number };
  signalEdge: Array<{ label: string; n: number; avgPeakWith: number; avgPeakWithout: number }>;
  rugClusterEdge: { flagged: number; flaggedAvgPnlPct: number; clean: number; cleanAvgPnlPct: number };
  scaleOut: { fired: number; avgTradePnlSol: number };
  timeToAth: { n: number; medianMin: number; avgMin: number; bandByMinute: Record<string, number>; bigWinnerMedianMin: number | null; note: string };
  note: string;
}

// ── /api/cohorts response ─────────────────────────────────────────────────────
// Every sniper config that has traded, grouped by its `cfg` hash. The hash shifts on any
// material parameter change, so each setting's trades self-isolate and a tuning change can be
// compared against the setting it replaced.

export interface Cohort {
  cfg: string;
  current: boolean;
  trades: number;
  evPct: number;
  /** evPct minus the live execution overhead — what this cohort would have earned for real. */
  evLivePct?: number;
  /** Position size THIS cohort actually traded — the overhead % depends entirely on it. */
  sizeSol?: number;
  overheadPct?: number;
  totalSol: number;
  winPct: number;
  bleedPct: number;
  medianHoldSec: number;
  avgPeakPct: number;
  firstTs: string | null;
  lastTs: string | null;
  reasons: Record<string, { n: number; avgPnlPct: number }>;
}

export interface CohortsResponse {
  activeCfg: string;
  /** Tip + priority fee a real fill pays on top of paper cost. Never folded into evPct. */
  liveOverhead?: { tipSol: number; prioSol: number; sizeSol: number; pct: number; note: string };
  cohorts: Cohort[];
  delta: {
    cfgNew: string;
    cfgOld: string;
    evPctDelta: number;
    winPctDelta: number;
    bleedPctDelta: number;
    medianHoldSecDelta: number;
    verdict: string;
  } | null;
  caveat: string;
}

// ── /api/strategy2-control-arm response ───────────────────────────────────────

export interface ControlArmRow {
  source: string;
  boughtN: number;
  boughtAvgMcChangePct6h: number | null;
  skippedN: number;
  skippedAvgMcChangePct6h: number | null;
  note: string;
}

// ── /api/wallet response ───────────────────────────────────────────────────────

export interface WalletInfo {
  address: string;
  mainnet: number;
  devnet: number;
}

export interface WithdrawResult {
  ok: boolean;
  signature?: string;
  sentSol?: number;
  error?: string;
}
