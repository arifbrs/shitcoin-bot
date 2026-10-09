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
  /**
   * Percent. `null` when nothing can honestly price the bag right now — a LIVE lot whose paper
   * twin is gone has no mark, and rendering 0.0% there would fabricate a fact about real money
   * (the card draws an em-dash instead). Never coerce to 0 at the source.
   */
  unrealizedPnl: number | null;
  /**
   * Perkiraan P&L yang benar-benar cair kalau posisi ini dijual sekarang, memakai kurva
   * eksekusi terukur. `unrealizedPnl` di atasnya adalah mark kuotasi — dan mark itulah yang
   * terbukti tidak bisa dieksekusi pada token yang sedang bergerak.
   */
  unrealizedPnlAdj?: number;
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
  /**
   * `null` balanceSol/floatSol = the on-chain read failed — UNKNOWN, never zero. Rendering
   * $0.00 there told the owner their funded wallet was empty (found live 2026-08-24); the
   * wallet panel draws an explicit "tidak terbaca" state instead.
   */
  s1: { balanceUsd: number | null; floatUsd: number | null; balanceSol: number | null; floatSol: number | null; wins: number; losses: number; open: number };
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
  /** null = on-chain balance unreadable (live view) — UNKNOWN, never zero. */
  floatSol: number | null;
  realizedSol: number;
  balanceSol: number | null;
  compounding: boolean;
  equity: Array<{ t: string; bal: number }>;
  openPositions: SniperOpenPosition[];
  /**
   * Baris dari rezim pembukuan LAIN, dilaporkan terpisah dan TIDAK pernah ikut dijumlah di
   * angka mana pun di atas. `corrected` menyatakan rezim mana yang sedang berlaku.
   */
  /**
   * true = kualifikasi "executable only" tidak bisa diterapkan (simulasi buy tidak berjalan
   * pada mode ini), jadi angka di atas memuat SEMUA trade rezim berlaku.
   */
  execStageUnresolved?: boolean;
  legacy?: { corrected: boolean; closed: number; realizedSol: number };
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
  /** Resolved asynchronously by the server's art cache — absent on the first tick after a trade. */
  img?: string | null;
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
  buyFailed: number;
  sellDeferred: number;
  exitReasons: Array<{ reason: string; n: number; netSol: number }>;
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
  /**
   * Set = pembelian dijeda karena saldo tidak cukup mendanai satu klip. Dibaca dari DISK oleh
   * server (proses web tidak berbagi memori dengan bridge), jadi panel bisa menampilkan keadaan
   * yang dulu hanya terlihat sebagai 177 baris log identik.
   */
  dryWallet?: { since: number; needSol: number; haveSol: number } | null;
  spentLast24h: number;
  caps: { maxPerTradeSol: number; maxDeployedSol: number; maxDailySpendSol: number; feeReserveSol: number; reconcileToleranceSol: number };
  clipSol: number;
  /** Real on-chain balance read by the web server. `null` = unknown, never zero. */
  walletSol?: number | null;
  summary: LiveSummary;
  lots?: Array<{
    tradeId: string; mint: string; symbol: string | null; state: string;
    spentSol: number; tokens: number; openedAt: number; heldSec: number;
    sells: number; proceedsSol: number; sellFailures: number; lastErr: string | null;
    img?: string | null;
  }>;
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

export interface DexPromotionView {
  chain: string; token: string; amountUsd: number; symbol: string | null;
  liqUsd: number | null; vol24: number | null; chg24: number | null;
}
export interface DexMoverView { symbol: string; chain: string; token: string; chg24: number | null; liqUsd: number | null; vol24: number | null }
export interface DexMetaView { slug: string; tokens: number; vol: number }
/** Lane DexScreener (2026-10-08): 13 endpoint REST + 6 stream WebSocket realtime (diukur gratis). */
export interface LaneDexResponse {
  updatedAt: string; watchlistTotal: number; seenTotal: number; cycles24h: number;
  lastCycle: { ts: string; calls: number; ms: number; watch: number } | null;
  ws: { ts: string; alive: number; streams: string } | null;
  wsReconnects: number;
  discovered: Record<string, number>;
  metas: DexMetaView[]; promotions: DexPromotionView[]; movers: DexMoverView[];
  quotaCost: 0;
}
export interface OkxPaperCloseView { ts: string; symbol: string; pnlSol: number; trigger: string | null }
/** Lane OKX strict-paper (2026-10-08): uang kertas, tanpa signer/broadcast, ledger hash-chain. */
export interface LaneOkxPaperResponse {
  updatedAt: string | null;
  open: Array<{ id: string; symbol: string; source: string; detectedAt: number | null; policyVersion: number | null }>;
  closedTotal: number; pending: number; scoutCache: number;
  budget: { premiumUsed?: number; basicUsed?: number; premiumPaused?: boolean; basicPaused?: boolean } | null;
  primed: { scanner: boolean; ranking: boolean; signal: boolean; trackers: number };
  activity24h: Record<string, number>;
  rejectReasons: Array<[string, number]>;
  recentCloses: OkxPaperCloseView[];
  ledger: { ok: boolean; records: number; lastSeq: number; error: string | null };
  quotaCost: 0;
}
/** Grafik per koin (2026-10-08): lilin dari GeckoTerminal (gratis) / GMGN kline (cadangan Solana). */
export interface ChartCandleView { t: number; o: number; h: number; l: number; c: number; v: number }
export interface ChartResponse {
  chain: string; token: string | null; pool: string | null; tf: string; bars: number;
  source: "geckoterminal" | "gmgn-kline" | null;
  error: string | null;
  candles: ChartCandleView[];
  cached: boolean;
}
export interface StatsResponse {
  /** Lane Robinhood (push via SSE, 2026-10-07) — panel 10 varian tidak lagi polling. */
  laneRobinhood?: RobinhoodPaperResponse;
  /** Lane DexScreener + OKX paper (push via SSE, 2026-10-08). */
  laneDex?: LaneDexResponse;
  laneOkxPaper?: LaneOkxPaperResponse;
  /** Kesehatan lane dari mtime berkas state (2026-10-09) — kartu status TIDAK lagi hardcode AKTIF. */
  laneHealth?: Record<string, { ageSec: number | null; fresh: boolean }>;
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

// ── /api/okx/overview response ───────────────────────────────────────────────

export interface OkxEndpointCounts {
  live: number;
  "params-unknown": number;
  unavailable: number;
  unprobed: number;
}

export interface OkxStatus {
  enabled: boolean;
  executionEnabled: boolean;
  executionRouteSelected: boolean;
  executionArmed: boolean;
  executionBlockers: string[];
  executionChecksAtOrder: string[];
  controlMode: string;
  paused: boolean;
  guardianHalted: boolean;
  route: "jupiter" | "okx" | "gmgn";
  slippagePercent: number;
  websocketEnabled: boolean;
  websocketChannels: string[];
  restSignalFallback: boolean;
  restSignalPollMs: number;
  copyShadow: boolean;
  candidateQueueEnabled: boolean;
  candidateMaxLagMs: number;
  candidateMinAmountUsd: number;
  trackedWallets: number;
  restCopyMaxWallets: number;
  endpointTotal: number;
  endpointCounts: OkxEndpointCounts;
  warnings: string[];
  endpoints: Array<Record<string, unknown>>;
}

export interface OkxRadarWalletView {
  walletAddress: string;
  sweepCount: number;
  cellHits: number;
  walletTypes: string[];
  realizedPnlUsd: number | null;
  winRatePercent: number | null;
  avgBuyValueUsd: number | null;
  txs: number | null;
  lastActiveTimestamp: number | null;
}

export interface OkxSourceEventView {
  ts: string | null;
  channel: string;
  mint: string;
  symbol: string | null;
  wallet: string | null;
  walletType: string | null;
  amountUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  detectLagMs: number | null;
  status?: "WATCH" | "REJECT" | null;
  executionState?: "BLOCKED" | null;
  reasons?: string[];
}

export interface OkxOutcomeAggregate {
  kind?: "signal" | "copy" | string;
  verdict?: "CLEAN" | "TOXIC" | "UNKNOWN" | string;
  horizonSec: number;
  total: number;
  priced: number;
  unpriced: number;
  winRatePercent: number | null;
  avgPct: number | null;
  medianPct: number | null;
}

export interface OkxOutcomeEventView {
  ts: string | null;
  kind: string | null;
  mint: string | null;
  symbol: string | null;
  wallet: string | null;
  verdict: string | null;
  horizonSec: number | null;
  pctChange: number | null;
  status: string | null;
}

export interface OkxStrictPaperExitSummary {
  policyVersion: number;
  source: string;
  lane: string;
  eligibility: "live-eligible" | "paper-only";
  horizonSec: number;
  observations: number;
  built: number;
  routeFailures: number;
  wins: number;
  winRatePct: number | null;
  medianPnlPct: number | null;
  meanPnlPct: number | null;
  totalPnlSol: number;
  medianBuildMs: number | null;
}

export interface OkxStrictPaperScalpSummary {
  policyVersion: number;
  source: string;
  lane: string;
  eligibility: "live-eligible" | "paper-only";
  observations: number;
  built: number;
  routeFailures: number;
  wins: number;
  winRatePct: number | null;
  medianPnlPct: number | null;
  meanPnlPct: number | null;
  totalPnlSol: number;
  triggerCounts: Record<string, number>;
  medianExecutionDelayMs: number | null;
  medianTriggerToExecutionGapPct: number | null;
}

export interface OkxPaperPurchaseReadiness {
  purpose: "PAID_WEBSOCKET_LATENCY_AB_ONLY";
  scope: string;
  status: "WAITING_FOR_SAMPLE" | "READY_FOR_PAID_WEBSOCKET_AB" | "EDGE_NOT_PROVEN";
  passed: boolean;
  observations: number;
  minimumObservations: number;
  totalPnlSol: number;
  meanPnlPct: number | null;
  medianPnlPct: number | null;
  lower95MeanPnlPct: number | null;
  recent30MeanPnlPct: number | null;
  routeFailurePct: number | null;
  requirements: Record<string, boolean>;
  disclaimer: string;
}

export interface OkxStrictPaperView {
  available: boolean;
  ledgerIntegrity: "OK" | "FAILED" | "MISSING";
  error: string | null;
  epoch?: string;
  ledgerRecords?: number;
  firstRecordAt?: string | null;
  lastRecordAt?: string | null;
  candidateFunnel?: {
    accepted: number;
    opened: number;
    pendingAccepted: number;
    rejectedOrFailed: number;
    terminalCounts: Record<string, number>;
  };
  positions?: { opened: number; allHorizonsObserved: number; exitObservations: number; scalpExitObservations: number };
  purchaseReadiness?: OkxPaperPurchaseReadiness;
  candidateDecisionLatency?: Array<{
    policyVersion: number; lane: string; observations: number;
    medianDecisionMs: number | null; p95DecisionMs: number | null;
  }>;
  rankingThroughput?: Array<{
    policyVersion: number; cycles: number; evaluatedSnapshots: number;
    transientFilteredSnapshots: number; expired: number; accepted: number;
    filterChanges: number; medianApiMs: number | null;
    observedCallsPerHour: number | null;
    configuredPollMs: number | null; configuredRecheckMs: number | null;
  }>;
  latestStatus?: Record<string, unknown> | null;
  exitSummary: OkxStrictPaperExitSummary[];
  scalpSummary?: OkxStrictPaperScalpSummary[];
}

export interface OkxOverviewResponse {
  generatedAt: string;
  status: OkxStatus;
  processes: { lane: boolean; study: boolean; paper: boolean };
  radar: {
    available: boolean;
    totalWallets: number;
    copyableWallets: number;
    updatedAt: string | null;
    topWallets: OkxRadarWalletView[];
    lastSweep: Record<string, unknown> | null;
    lastSelection: Record<string, unknown> | null;
  };
  lane: {
    mode: "shadow-copy" | "signals-only";
    status: Record<string, unknown> | null;
    signals: { total: number; recent: OkxSourceEventView[] };
    copies: { total: number; liveExecution: false; recent: OkxSourceEventView[] };
    candidates: { total: number; liveExecution: false; recent: OkxSourceEventView[] };
    outcomes: OkxOutcomeAggregate[];
    recentOutcomes: OkxOutcomeEventView[];
  };
  study: {
    status: Record<string, unknown> | null;
    outcomes: OkxOutcomeAggregate[];
    recent: OkxOutcomeEventView[];
  };
  paper: OkxStrictPaperView;
  lastLocalEventAt: string | null;
  quotaCost: 0;
}

// ── LANE VIEWS (multi-lane dashboard, 2026-10-07) ────────────────────────────
export interface RobinhoodVariantView {
  id: string; equityUsd: number; pnlUsd: number; trades: number; wins: number; losses: number;
  winRate: number | null; maxDdPct: number; openPositions: number;
  life: number; cumulativePnlUsd: number; bankrupt: boolean;
  exposureUsd: number;
  positions: Array<{ symbol: string; lastPrice: number; markAgeSec: number | null; notionalUsd: number }>;
  status: string;
}
export interface RobinhoodTradeView {
  action: string; variant: string; symbol: string; pnlUsd: number | null; pnlPct: number | null;
  reason: string | null; ts: string; entryPriceUsd: number | null; exitPriceUsd: number | null;
}
export interface RobinhoodPaperResponse {
  updatedAt: string; startEquityUsd: number; laneDays: number; cycles: number; openTotal: number;
  variants: RobinhoodVariantView[]; recent: RobinhoodTradeView[];
  backtestMd: string | null; backtestFile: string | null; reviewMd: string | null; reviewFile: string | null;
}
export interface GmgnOverviewResponse {
  updatedAt: string;
  signals24h: Array<{ signalType: number; count: number; sample: Array<{ sym: string; mcUsd: number | null; ts: string }> }>;
  recentSignals: Array<{ sym: string; signalType: number; mcUsd: number | null; triggerMc: number | null; ath: number | null; holders: number | null; rugRatio: number | null; ts: string }>;
  wallets: Array<{ wallet: string; tags: string[]; winrate: number | null; realizedProfit: number | null; tokens: number | null; at: number }>;
  walletsScored: number;
  watchedTrades24h: number;
  watchedRecent: Array<{ symbol: string; side: string; maker: string; amountUsd: number | null; watchType: string; ts: string }>;
  lastCycle: { ts: string; calls: number; ms: number; positions: number; candidates: number; signals: number; walletsScored: number } | null;
  reportMd: string | null; reportFile: string | null;
}
