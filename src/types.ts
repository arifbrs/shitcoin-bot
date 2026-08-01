export interface Candidate {
  source: "pumpportal" | "bitquery";
  mode: "fast-follow";
  mint: string;
  /**
   * Stable id for ONE decision attempt: candidate accepted → gate → open (or early
   * skip/reject). Minted exactly once, at first acceptance (`enqueue()` for the pumpportal
   * lane, the bitquery `onConfirmed` callback for that lane), BEFORE the launch-MC floor,
   * the queue, or the gate ever see the candidate. Every downstream consumer holds the SAME
   * object reference, so mutating this field once here is what makes it durable through the
   * whole lifecycle without any copying logic.
   *
   * A re-detection of the same mint (a fresh Candidate object from a fresh detection event)
   * gets a NEW decisionId — `positions.has(mint)` in `PaperTrader.open()` already refuses to
   * open a second position on a still-open mint, so a genuine re-entry can only happen once
   * the previous trade's lifecycle is over, i.e. it is unambiguously a new attempt.
   */
  decisionId?: string;
  name?: string;
  symbol?: string;
  creator?: string;
  pool?: string; // pump | bonk | pumpswap | raydium | ...
  isMayhemMode?: boolean; // Pump Mayhem mints extra supply and can exhaust sell liquidity
  isCashbackCoin?: boolean; // protocol regime flag; telemetry until separately modelled
  /**
   * Pump v2 quote mint. Missing/default means the legacy SOL-quoted curve; an explicit
   * non-default mint is NOT denominated in SOL and must never enter SOL P&L.
   */
  quoteMint?: string;
  priceSol?: number; // bonding-curve price (SOL/token) for fast-follow entries
  bondingCurveKey?: string; // pump.fun bonding curve account, for live on-chain pricing
  bcVSol?: number; // virtual SOL reserves — for EXACT bonding-curve price-impact math
  marketCapSol?: number;
  /** SOL the creator bought in their own create transaction — their skin in the game, known
   *  at launch for free. Every pump.fun curve starts at the same reserves, so this is the
   *  only thing that makes one launch's market cap differ from another's at birth. */
  devInitialBuySol?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  buys1h?: number;
  sells1h?: number;
  hasSocials?: boolean;
  /** Token logo URL, lifted from the metadata JSON the socials check already fetches (no extra request). */
  image?: string;
  /** Off-chain metadata URI, delivered free in the launch event (no RPC). Source for the logo. */
  metadataUri?: string;
  /** How many coins sharing this one's name-theme launched in the previous 6h (see narrative.ts).
   *  MEASURED ONLY — recorded on every trade so it can be validated against real P&L before it is
   *  ever allowed to gate an entry. */
  themeCrowd?: number;
  themeWord?: string;
  holders?: number;
  organicScore?: number; // Jupiter organic-vs-fake volume score (0-100)
  whaleManipPct?: number; // max(sniper%, bundler%) — quick manip proxy
  whaleTop5Pct?: number; // alias of top10 concentration (kept for existing readers)
  whaleSniperPct?: number; // pump.fun app metric: % of supply held by first-10s snipers
  whaleBundlerPct?: number; // pump.fun app metric: % of supply held by bundlers
  whaleDevPct?: number; // pump.fun app metric: % of supply still held by dev
  whaleTop10Pct?: number; // pump.fun app metric: % of supply held by top-10 non-team wallets
  // Momentum metrics AT CONFIRM (snapshot of the conditions that got it bought) — the
  // raw material for pattern memory: correlate entry conditions with the eventual outcome.
  confirmStats?: { grownPct?: number; accel?: number; velSol?: number; buyPressurePct?: number; uniqueBuyers?: number; netBuyVolSol?: number; ageSec?: number };
  /**
   * Wash-trade metrics from the live Bitquery tape, captured at confirm time. `bothSidesPct` is
   * the share of wallets appearing as BOTH buyer and seller — the strongest published
   * discriminator (confirmed wash tokens 95-98%, genuine retail below 30%). Measurement only:
   * nothing gates on these until they are regressed against our own realised P&L.
   */
  washStats?: { bothSidesPct: number | null; tradesPerTrader: number | null; washScore: number | null;
                avgTradeSol?: number; avgTradeUsd?: number | null;
                buyers?: number; buys?: number; sells?: number; buyPressurePct?: number; netBuyVolUsd?: number };
  // Rug-cluster: coordinated funding of "different" wallets from one source = organized-rug setup.
  rugCluster?: { clusterWallets: number; clusterPct: number; fundingDiversity: number | null; devFundedBuyers: number; coordinated: boolean; verdict: "TOXIC" | "CLEAN" | "UNKNOWN" };
  honeypot?: boolean; // SELL simulation proved exit impossible; BUY failure must never set this
  authorityUnknown?: boolean; // authority check timed out — safety UNVERIFIED (not clean)
  launchBundle?: { sameSlotMax: number; bundledShare: number; earlyTxs: number; verifiedBuys?: boolean }; // same-slot bundle; sameSlotMax = distinct BUYER wallets/slot when verifiedBuys, else tx-count proxy
  // NOTE: a `bundleProbe` prefetch field lived here. It was reverted after the prefetch appeared
  // to blow entry latency — but that verdict was measured while the RPC key was being 429'd and
  // every call cost ~3s of backoff. Now that fail-fast failover is in, the prefetch is worth
  // RE-TESTING before concluding it is unaffordable.
  fundingParents?: string[]; // EARLY-BUYER funders (from top-holders) — for the rug-cluster ONLY
  creatorFunders?: string[]; // who funded the CREATOR wallet — the correct lineage for actor memory
  holdersSample?: number; // # holders the API returned (sample confidence for setup checks)
  metaHash?: string; // hash of name/symbol/uri — detect reused metadata across launches
  setup?: { verdict: "TOXIC" | "CLEAN" | "UNKNOWN"; confidence: number; evidence: string[]; missing: string[] }; // frozen setup verdict at entry
  rawScore?: number; // UNCAPPED gate score (0-100 saturates; raw differentiates great vs ok — audit #5)
  scoreParts?: Record<string, number>; // per-bonus contributions to rawScore, so an inverted component is findable
  detectedAt: number;
}

export interface GateCheck {
  name: string;
  passed: boolean;
  hard: boolean; // hard gate = failure rejects; soft = only affects score
  detail: string;
}

export interface GateResult {
  verdict: "PASS" | "REJECT";
  checks: GateCheck[];
  score: number; // 0..100, only meaningful when verdict is PASS
}

export interface Decision {
  decisionId?: string | null;
  measurementEpoch?: string;
  cfg?: string;
  candidate: Candidate;
  gate: GateResult;
  action: "PAPER_BUY" | "SKIP";
  reasons: string[];
  openResult?: { opened: boolean; code: string; detail?: string };
  at: number;
}
