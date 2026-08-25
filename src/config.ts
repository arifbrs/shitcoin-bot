import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Audit fix (2026-07-29): every `Number(process.env.X ?? default)` in this file accepted NaN
 * (a non-numeric env value), 0, or negative numbers with zero validation — a NaN poll interval
 * would make setInterval behave unpredictably, a 0 poll would API-storm, a negative trailStopPct
 * would never trigger. Falls back to the given default (never crashes, never returns garbage)
 * and — for `min` — clamps below it rather than silently accepting an unsafe value.
 */
function numEnv(raw: string | undefined, fallback: number, min?: number): number {
  const n = Number(raw);
  if (!isFinite(n)) return fallback;
  if (min != null && n < min) return fallback;
  return n;
}

// Single lane: fast-follow bonding-curve sniper. (The swing/DexScreener lane was removed.)
export type Mode = "fast-follow";

const mode: Mode = "fast-follow";

const heliusKey = process.env.HELIUS_API_KEY?.trim() || undefined;

/**
 * RPC ENDPOINT POOL, in priority order. The pool is what the rotating failover in
 * safety/onchain.ts actually consumes; `rpcUrl`/`rpcBackupUrl` below stay exported only
 * because other modules (and the dashboard) still name them.
 *
 * Sources, highest priority first:
 *   RPC_URLS         — comma/newline separated list (the multi-key lane)
 *   RPC_URL          — single primary
 *   RPC_BACKUP_URL   — single backup
 *   Helius           — only if a key exists
 * Duplicates are dropped, order preserved. An empty pool falls back to the public endpoint,
 * which is far too throttled for this bot — that case is flagged via `usingPublicRpc`.
 */
const rpcPool = (() => {
  const raw = [
    ...(process.env.RPC_URLS ?? "").split(/[\n,]/),
    process.env.RPC_URL ?? "",
    process.env.RPC_BACKUP_URL ?? "",
    heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : "",
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of raw) {
    const t = u.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length ? out : ["https://api.mainnet-beta.solana.com"];
})();

export const config = {
  mode,
  /**
   * MEASUREMENT EPOCH. Records written before the trade-identity / post-exit-idempotency /
   * truth-schema work of 2026-07-26 lack `tradeId`, contain duplicated post-exit samples
   * (1,638 duplicate points, one repeated 92x), and were scored against a target that
   * labelled 43% of its own "wins" as bad. They remain useful for DIAGNOSIS but must never
   * be pooled into primary inference. Anything without `measurementEpoch` is legacy.
   *
   * BUMPED to e2b (2026-07-28, P0 audit fix round): e2-2026-07-26 rows can carry three known
   * bugs now fixed — (1) the holder demand-gate was FAIL-OPEN (a failed RPC read let entry
   * through with zero demand verification, code HOLDER_DATA_UNAVAILABLE now rejects instead),
   * (2) would-fail buy simulations were only discovered AFTER paper capital was committed
   * (SKIP_WOULD_FAIL now runs the check fail-closed BEFORE commit), (3) no latency ceiling existed
   * on entries (STALE_ENTRY now rejects candidates whose detect→decide latency already blew a
   * provisional budget). This is still "e2 lineage" methodology, not the future e3 online-arm
   * experiment (arm-set-e3-entry-policy-v1, not yet wired) — do not conflate the two names.
   */
  measurementEpoch: "e2b-2026-07-28",
  /**
   * STRATEGY-2 MEASUREMENT EPOCH — separate from the sniper's epoch above (different
   * experiment, different correctness bugs). Records before this epoch (2026-07-27 review) had:
   * 1h momentum mislabeled as 24h, no source attribution surviving into outcome records, no
   * momentum/quality ranking on paper-trade entries (a position was opened on a ~$1.67B market
   * cap token), and incomplete quote cost accounting. That data was CLEARED (not quarantined —
   * owner's explicit instruction, 2026-07-27: "clear datanya, feelingku gak enak") since it was
   * one day old and small. Anything without `strategy2Epoch` from here on is pre-fix legacy.
   *
   * BUMPED to s2e3 (2026-07-28, operational validation round): s2e2 fixed anomalous MC marks
   * but the declared $400K upper bound remained dead while paper admission silently used $50M,
   * and Solana Tracker failures could stall mark/exit confirmation indefinitely. s2e3 enforces
   * the configured range and records/falls back to an independent DexScreener MC mark.
   *
   * Previously bumped to s2e2 (2026-07-28, P0 audit fix round): s2e1 rows can carry an unvalidated
   * peakMcUsd/currentMcUsd mark (HOOD's peak read $23.87B off a single bad Solana Tracker poll
   * and stood forever as an unbeatable high-water mark). The MC-anomaly guard (hold-for-
   * confirmation, see strategy2-papertrader.ts's poll()) is now in place.
   */
  // BUMPED to s2e4 (2026-07-29, owner-requested full reset): Strategy 2 promoted to the
  // dashboard's primary strategy — equity/positions/candidate-history reset to zero and all
  // rolling logs truncated (full backup taken first, see logs/archive-full-reset-*). This epoch
  // exists so any stray pre-reset row that somehow survives is excluded on sight, same posture
  // as every prior bump.
  // BUMPED to s2e5 (2026-07-29, owner: convert to scalping): trailStopPct 20→8, maxHoldHours
  // 48→2, maxConcurrentPositions capped→uncapped. A material change to the exit thesis, so new
  // entries/closes are tagged separately from the s2e4 cohort — existing open positions keep
  // their original s2e4 tag on close (openedEpoch is frozen at entry), but are immediately
  // evaluated against the NEW tighter thresholds every poll (the exit check reads live config,
  // not a frozen-at-entry copy) — this is what actually fixes "hours with no exit movement" for
  // the positions already open, not just future ones.
  // BUMPED to s2e6 (2026-07-29, owner: found a 99% loss caused by 15min poll lag on a fast
  // collapse): pollMs 15min→3min so mark-to-market/exit-check reacts within minutes, not up to a
  // quarter-hour late. Separates the "slow detection" cohort (s2e5) from this one.
  // BUMPED to s2e7 (2026-07-29, owner: "harus realtime"): pollMs 3min→30s + concurrent (12-wide)
  // position checks + overlap guard. Separates the s2e6 (3min, sequential) cohort from this one.
  // BUMPED to s2e8 (2026-07-29, owner found live): RobinHub/PIPEDOG sat at MC~$0 for 3h+, 264
  // failed sell-quote retries, never realized as a loss — dead pools can never get a GMGN sell
  // route. closePosition() now force-writes-off a position after SELL_QUOTE_FAIL_LIMIT (10)
  // consecutive failures, using the MC ratio as the honest implied exit value. Existing zombie
  // positions still carry their own openedEpoch (s2e5) on close — this bump only affects NEW
  // entries going forward.
  // BUMPED to s2e9 (2026-07-29, external audit): exposure cap (maxExposurePct, replaces the
  // uncapped-position risk), MAX_HOLD now fires even when mark is unavailable, emergency flatten
  // wired up for Strategy 2, atomic state writes, source-filter defensive fix, finite validation
  // on quotes/config. Also, `cfg` (configHash) now actually reflects Strategy 2 parameters —
  // previously blind to every strategy2* config change (verified: TRAIL_PCT=8 and =20 hashed
  // identically). This epoch bump is belt-and-suspenders on top of that hash fix.
  // BUMPED to s2e10 (2026-07-29, second-pass external re-audit): exposure cap now enforced
  // against the REAL post-quote entryCostUsd (not a stale pre-check) so it can no longer
  // overshoot by one position; codeFingerprint() finally includes the Strategy 2 files
  // themselves; quote validation now requires positive (not just finite) numbers and treats a
  // non-finite sol_cost as a skip, not an assumed $0; dashboard trade-journal/candidate stores
  // are now epoch-filtered at ingestion (equity/wins/losses remain a continuous running account
  // total by design — same "never wipe, tag and filter" philosophy as codeHash itself).
  // BUMPED to s2e11 (2026-07-29, two data-driven fixes from a third-party audit + live
  // verification): (1) TRAIL_STOP now requires a REAL GMGN quote to corroborate the drawdown
  // before committing — confirmed live that DexScreener/Solana Tracker can report a stale/dead
  // pool's price (Cybercat: DexScreener said marketCap:0.03 with 0 volume in every window, while
  // GMGN's routing found a live pool and quoted +16.14%) while MAX_HOLD/MANUAL_FLATTEN remain
  // wall-clock/operator-forced and bypass this check; (2) the composite candidate score's
  // smart-money/renowned/holder weights are flipped to negative — 125 real closes showed WINS
  // averaged FEWER of all three than LOSSES, the same inversion pattern already documented for
  // the sniper's rawScore. Both are new hypotheses to measure, not proven edges.
  // BUMPED to s2e12 (2026-07-29): Solana Tracker confirmed 100% rate-limited (135/135 calls
  // failed today, "Rate limit reached"), forcing every position onto DexScreener, which
  // live-confirmed can report a stale/dead pool's price for a token still very much alive
  // elsewhere. Jupiter's free token search is now tried BEFORE DexScreener in the
  // tokenMarketSnapshot() cascade — verified live to return a sane MC where DexScreener didn't.
  // BUMPED to s2e13 (2026-07-29): backup Solana Tracker account wired in (own separate free-tier
  // quota) as a same-tier fallback when the primary secure-subdomain account fails — verified
  // live via a direct curl that the standard data.solanatracker.io + x-api-key path returns the
  // identical response shape. Honest caveat: this roughly doubles a very small quota (each free
  // tier is ~2,500 credits/month, ~83 calls/day) — nowhere near enough for 30s realtime polling
  // across many open positions. Jupiter + DexScreener + the peakRealizedValueUsd verification
  // guard remain the real backstop; this is a marginal, not a structural, fix.
  // BUMPED to s2e14 (2026-07-29, owner: "gas semua" — the full remaining audit backlog in one
  // pass rather than one-by-one): (1) freshCandidates() fixed to read a multi-day file window
  // instead of only today's file (was a genuine midnight-rollover bug); (2) Jupiter search now
  // requires an EXACT mint match instead of trusting the first fuzzy-search result; (3) demand-
  // confirmation admission gate — requires Jupiter's real 5m net-buyer/buy-volume flow before
  // admitting a candidate (config-gated: requireDemandConfirmation); (4) cost-aware admission —
  // rejects an entry whose own real quote implies >maxEntryFrictionPct one-way cost; (5) per-
  // source (gmgn-trending vs gmgn-trenches vs future lanes) win/loss/pnl breakdown, shown on the
  // dashboard instead of blended into one number; (6) a new /api/strategy2-control-arm endpoint
  // joining strategy2-outcome (already covers EVERY scouted candidate, bought or not) against
  // strategy2-paper-open, so "what would have happened if we'd skipped" is finally answerable
  // instead of just theoretically present in raw logs.
  // BUMPED to s2e15 (2026-07-30): equity hit $0.70 (from $1000 start) after a 9-rug day
  // (-$459 from bundle-style instant rugs, +$71 from 20 normal closes, net -$388) — the
  // minPositionUsd=$50 floor (added earlier the same day to fix a DIFFERENT deadlock) meant
  // every one of those rugs cost ~$50 instead of ~$18, and the bundle-cluster admission gate
  // (see detectBundleCluster in strategy2-papertrader.ts) went live only partway through the
  // day, after most of the damage. Owner's call: reset equity and start a clean epoch NOW that
  // the gate is active for the whole session, so its real effect (rug rate going forward) can be
  // measured without yesterday's pre-gate losses blended in.
  // s2e16 (2026-07-31): entry semantics changed materially, so the previous cohort is not
  // comparable. Three things moved at once — entry MC/liquidity/holders now come from a LIVE
  // snapshot instead of a candidate row that could be hours stale (measured: one row was 36% off
  // after a single minute); the bundle threshold went 2→3 after the admission funnel showed it
  // was rejecting 95% of candidates, 62% of them on the weakest two-wallet case; and every entry
  // now carries a Solana Tracker risk block for later correlation. Mixing these with s2e15 would
  // blend three different admission rules into one win rate.
  strategy2Epoch: "s2e16-2026-07-31",
  // Historically this comment read "there is no live path in this codebase" — true until
  // 2026-08-22, when execution/live-bridge.ts wired liveBuy/liveSell (which had existed with
  // ZERO callers) into the paper trader's open/partial/close. Real spending is still inert
  // unless EXEC_MODE=live AND LIVE_TRADING_CONFIRMED=yes. Nothing reads this flag.
  dryRun: true as const,
  rpcEndpoints: rpcPool,
  rpcUrl: rpcPool[0]!,
  rpcBackupUrl: rpcPool[1],
  // How long an endpoint sits out after it rate-limits us. Long enough that we stop hammering
  // a spent free tier, short enough that a burst-throttle (QuickNode's is a burst window that
  // recovers in seconds) doesn't cost us the endpoint for the rest of the session.
  rpcCooldownMs: Number(process.env.RPC_COOLDOWN_MS ?? 90_000),
  /**
   * PER-ENDPOINT `getMultipleAccounts` limits, MEASURED 2026-07-26 by ramping batch size:
   *   QuickNode 5 (-32615) · PublicNode 10 (blocked param) · Solana Tracker 100 · FluxRPC 100
   *
   * A single global cap is wrong in both directions. Set to 100 (the spec) every batch failed
   * on QuickNode, benching our fastest endpoint. Set to 5 (the smallest) a 100-key watchlist
   * read became TWENTY calls instead of one — measured: getMultipleAccounts hit 13,900 calls,
   * RPC saturated at 104%, 151 candidates queued and entries lagging. Both extremes hurt.
   *
   * So the limit travels with the endpoint: small reads (a few open positions) stay on the
   * 34ms endpoint, while a large watchlist sweep is routed to one that takes it in one call.
   * Keys are matched as host substrings; anything unlisted gets `default`.
   */
  rpcBatchLimits: {
    "quiknode.pro": 5,
    "publicnode.com": 10,
    "solanatracker.io": 100,
    "fluxrpc.com": 100,
    "helius-rpc.com": 100,
    default: 5, // unknown provider → assume the most restrictive we have seen
  } as Record<string, number>,
  usingPublicRpc: rpcPool[0] === "https://api.mainnet-beta.solana.com",
  rugcheckApiKey: process.env.RUGCHECK_API_KEY?.trim() || undefined,
  /**
   * OWNER DECISION 2026-08-23: RUGCHECK_ENABLED=false bypasses the RugCheck API entirely.
   * The API's 429s/timeouts were (a) slowing the gate's parallel batch to its deadline and
   * (b) leaving ~18% of entries without rug data anyway (fail-open), so the owner chose to
   * drop the layer rather than pay latency for partial coverage. What REMAINS on the entry
   * path: the free instant structural checks (mint/freeze authority) + holder analysis +
   * metadata + Jupiter intel. Re-enable by removing the env line (default = enabled).
   */
  rugcheckEnabled: process.env.RUGCHECK_ENABLED !== "false",
  /**
   * S2 LIVE MIRROR (owner, 2026-08-24: "1 inti") — Strategy 2 executes for real when the
   * console switch is LIVE, via Jupiter, with its OWN smaller caps. Shares the guardian's
   * halt + 24h spend ledger with S1. S2_LIVE_ENABLED=false freezes the mirror back to
   * paper-only without touching the brain.
   */
  s2LiveEnabled: process.env.S2_LIVE_ENABLED !== "false",
  s2MaxPerTradeSol: Number(process.env.S2_MAX_PER_TRADE_SOL ?? 0.02),
  s2MaxDeployedSol: Number(process.env.S2_MAX_DEPLOYED_SOL ?? 0.06),
  /**
   * Execution route for the S2 live mirror: "jupiter" (default — non-custodial, tx signed
   * locally, no platform fee) or "gmgn" (official OpenAPI swap — ±1%/side platform fee, and
   * the bot wallet must be imported into the owner's GMGN account: server-side execution).
   * Fees per route are logged per trade so the comparison stays measurable.
   */
  s2ExecRoute: (process.env.S2_EXEC_ROUTE ?? "jupiter").toLowerCase() === "gmgn" ? "gmgn" : "jupiter",
  jupiterApiKey: process.env.JUPITER_API_KEY?.trim() || undefined,
  // PumpPortal API key (portal.pumpportal.fun). The free WS covers new-token
  // launches; the per-token TRADE stream (subscribeTokenTrade — live buyers/
  // sellers, unique traders) needs a key funded with ≥0.02 SOL. Leave empty to
  // disable the crowd stream (agent then reads crowd=null and still works).
  pumpPortalApiKey: process.env.PUMPPORTAL_API_KEY?.trim() || undefined,
  // Solscan: free key only reaches /chaininfo (network stats). Token/holder/dev
  // data is Pro-only, so this is a network-health readout, not a trading signal.
  solscanApiKey: process.env.SOLSCAN_API_KEY?.trim() || undefined,
  solscanChainInfoUrl: "https://public-api.solscan.io/chaininfo",
  /**
   * Solana Tracker Data API — used ONLY at graduation time (rare, ~1-3/hour) to get a REAL
   * holder count and risk flag. Our own on-chain `getTokenLargestAccounts`-based holderCount()
   * is capped at 20 (Solana's own protocol limit on that method) — MEASURED 2026-07-26 to return
   * exactly 19 for every token with >=20 holders, making it useless for comparing tokens that all
   * have a real audience. This is measurement-only: nothing here reads back into any entry/exit
   * decision. ⚠ SOLTRACKER_HOST is itself a bearer credential (the secure subdomain needs no
   * separate key) — treat it like an API key.
   */
  solTracker: {
    host: process.env.SOLTRACKER_HOST?.trim() || undefined,
    apiKey: process.env.SOLTRACKER_API_KEY?.trim() || undefined,
    // Backup account, own separate free-tier quota (owner, 2026-07-29) — same key-farming pattern
    // as Helius. No dedicated secure-subdomain for this one, so it's accessed via the STANDARD
    // data.solanatracker.io host + x-api-key header (verified live: identical response shape —
    // pools[].marketCap.usd, holders, risk — to the primary secure-subdomain path).
    backupApiKey: process.env.SOLTRACKER_API_KEY_2?.trim() || undefined,
  },
  /**
   * STRATEGY-2 SCOUT (owner: "MC 100k-400k+, holder banyak, mover, sudah lolos trenches" — run
   * CONCURRENTLY with the sniper, not researched separately on a different day's market, so any
   * future comparison isn't confounded by different market conditions). READ-ONLY candidate
   * logger — no capital, no buy/sell, completely separate from PaperTrader. Deliberately
   * excluded from `configHash`: it cannot affect a single sniper decision, so it must not force
   * a sniper cohort split every time its own settings change.
   */
  strategy2Scout: {
    enabled: process.env.STRATEGY2_SCOUT !== "false",
    pollMs: numEnv(process.env.STRATEGY2_POLL_MS, 60 * 60_000, 10_000), // hourly — Solana Tracker budget is shared, finite
    minMcUsd: numEnv(process.env.STRATEGY2_MIN_MC, 100_000, 0),
    maxMcUsd: numEnv(process.env.STRATEGY2_MAX_MC, 400_000, 0), // enforced by Strategy 2 paper admission
  },

  /**
   * NEW-LAUNCH / DEV-HOLDING lane (owner request, 2026-07-29): a SECOND, separate thesis from the
   * mid-cap-mover scout above — brand-new pump.fun tokens (not yet mid-cap, may still be on the
   * bonding curve), filtered on whether the dev wallet still holds a meaningful share of supply
   * (jupDevBalancePct) rather than on holder count or momentum. Observation-only for now, same
   * posture the mid-cap scout itself started with before paper-trading was layered on top — logs
   * EVERY looked-up candidate (including ones that don't clear minDevBalancePct) so the threshold
   * itself can be tuned from real outcome data later, not guessed up front.
   */
  strategy2NewScout: {
    enabled: process.env.STRATEGY2_NEWSCOUT !== "false",
    pollMs: numEnv(process.env.STRATEGY2_NEWSCOUT_POLL_MS, 5 * 60_000, 10_000), // 5min — "new" is a narrow window, unlike the hourly mid-cap lane
    maxAgeMin: numEnv(process.env.STRATEGY2_NEWSCOUT_MAX_AGE_MIN, 180, 1), // 3h — still "new" by this thesis
    minDevBalancePct: numEnv(process.env.STRATEGY2_NEWSCOUT_MIN_DEV_PCT, 3, 0), // meaningfully holding, not dust — advisory flag only, not a hard log filter
  },

  /**
   * STRATEGY-2 OUTCOME TRACKER — the scout above only logs an entry snapshot (MC/holders at
   * time of observation). Without re-checking the SAME mint later, that snapshot can never
   * answer "did this candidate actually do well" — it's a watchlist, not evidence. This closes
   * that loop: re-fetch each tracked mint at fixed horizons after its first sighting and log
   * the delta. Also read-only, zero capital, its own process — never touches PaperTrader.
   */
  strategy2Outcome: {
    enabled: process.env.STRATEGY2_OUTCOME !== "false",
    pollMs: numEnv(process.env.STRATEGY2_OUTCOME_POLL_MS, 30 * 60_000, 10_000), // check for due horizons every 30min
    horizonsHours: (process.env.STRATEGY2_OUTCOME_HORIZONS ?? "6,24,48")
      .split(",").map((s) => Number(s.trim())).filter((n) => n > 0),
  },

  /**
   * STRATEGY-2 PAPER TRADER — actually simulates buy/hold/sell on scout candidates (owner:
   * "harus akurat, fee juga jangan asumsi"). Entry/exit value comes from GMGN's REAL routed
   * swap quote (order quote — platform fee + pool fee + price impact all baked in, verified
   * live), never a modeled/assumed fee %. Peak tracking between entry and exit uses mcUsd
   * (cheap, frequent) — only the ACTUAL open/close moment pays for a real quote. Exit is a
   * trailing stop from peak, with a max-hold safety net (owner's choice: combine both).
   * Its own process, own log stream, own simulated USD float — zero interaction with the
   * Solana sniper's SOL ledger.
   */
  strategy2Paper: {
    enabled: process.env.STRATEGY2_PAPER !== "false",
    startingFloatUsd: numEnv(process.env.STRATEGY2_START_USD, 1_000, 1),
    riskPerTradePct: numEnv(process.env.STRATEGY2_RISK_PCT, 5, 0.01), // slower-moving, established tokens → larger % per trade than the sniper's SOL sizing
    // SCALPING mode (owner, 2026-07-29): positions were sitting for hours with neither exit
    // trigger firing (20% trail from peak rarely hit on a slow mid-cap mover, 48h was too far
    // off to matter) — that's a "ride it out" profile, not scalping. Tightened both so a
    // position turns over in a couple hours at most: small pullback from peak locks in
    // whatever gain existed, and the hard timeout guarantees no position idles for "several
    // hours" with zero exit movement the way the old 48h ceiling allowed.
    trailStopPct: numEnv(process.env.STRATEGY2_TRAIL_PCT, 8, 0.01), // exit if value falls this far from its peak
    maxHoldHours: numEnv(process.env.STRATEGY2_MAX_HOLD_HOURS, 2, 0.01), // hard timeout — forces turnover instead of multi-hour idle holds
    // Owner (2026-07-29): no concurrency cap — every candidate that clears freshCandidates()'s
    // filters gets bought, no queueing on a slot limit. Sizing per trade (riskPerTradePct % of
    // CURRENT equityUsd) is unaffected by how many positions are already open, so this doesn't
    // change per-trade risk — it only changes how many trades can run at once.
    maxConcurrentPositions: numEnv(process.env.STRATEGY2_MAX_POS, Infinity, 1),
    // Audit found (2026-07-29): removing the position-count cap above with no companion exposure
    // cap meant aggregate open-position cost was completely unbounded — every new entry sizes
    // off CURRENT equityUsd (which doesn't drop until a position CLOSES), so N simultaneous
    // positions could commit N × riskPerTradePct% of the SAME undiminished equity. This bounds
    // TOTAL committed capital instead of position count — unlimited positions are still fine as
    // long as their combined entry cost never exceeds this share of equity, which is what the
    // owner actually wants (fast turnover, many trades) without the uncapped-leverage risk.
    maxExposurePct: numEnv(process.env.STRATEGY2_MAX_EXPOSURE_PCT, 100, 1),
    // Floor added (owner, 2026-07-30) after a verified deadlock: riskPerTradePct sizes off
    // CURRENT equity with no floor, so as equity fell from $1000→$365.63 the 5% position size
    // fell from $50→~$18.90. GMGN's own quote data (logs/events-2026-07-29.jsonl,
    // strategy2-cost-rejected, n=300 real rejections just before this fix) showed the ROUTE'S
    // extra/hidden cost (`sol_cost` overhead beyond the nominal swap) sits at a near-constant
    // ~$0.62-0.63 regardless of token or position size — i.e. it is a FIXED cost, not a
    // percentage one. At ~$18.90 that fixed cost alone is already ~3.3% (entryFrictionPct in
    // those logs), which is why the SAME handful of candidates (PIPETRUMP/BULLIEVE/DEER/etc.)
    // kept getting rejected hundreds of times over 4+ hours — not bad luck, a guaranteed miss.
    // $50 brings that same ~$0.63 fixed cost down to ~1.25%, with real margin under the ceiling
    // below. Below $1000 equity this means actual risk-per-trade temporarily exceeds
    // riskPerTradePct's nominal 5% (floor wins) — accepted tradeoff to keep the bot able to enter
    // at all while it's down, rather than being structurally locked out of every real quote.
    minPositionUsd: numEnv(process.env.STRATEGY2_MIN_POSITION_USD, 50, 1),
    // TIGHTENED 15min→3min→30s (owner, 2026-07-29): first cut (3min) came from a real trade
    // ("鲣鸟") found ~99% down the poll AFTER entry — entryMcUsd===peakMcUsd (price never ticked
    // up before crashing), 8% trailing stop fired correctly but ~15min too late to matter. Owner
    // then asked for realtime — true sub-second isn't honest here (Solana Tracker/DexScreener are
    // polled HTTP endpoints, not a push feed; GMGN quotes cost real rate-limit budget per call),
    // so 30s is the practical floor. Made SAFE to run this often by two companion changes in
    // strategy2-papertrader.ts: mark-to-market now checks up to 12 positions concurrently instead
    // of one-by-one (was the real bottleneck once positions went uncapped — sequential checks on
    // 30+ positions could take longer than the interval itself), and an overlap guard skips a
    // tick rather than let two poll() calls race the same state file if one ever runs long.
    pollMs: numEnv(process.env.STRATEGY2_PAPER_POLL_MS, 30_000, 5_000),
    // Read-only routing address for GMGN's quote endpoint — it never signs or submits anything,
    // so ANY syntactically valid Solana address prices identically. Not a real funded wallet.
    quoteFromAddress: "ayDYr5jGkV83e5ZN4bPZRWipUgtPzoBs2JZ1kqtkH8w",
    // Audit fix (2026-07-29): "entry confirmation berbasis demand" — require Jupiter's 5m
    // buy-flow data to show real recent demand (net buyers > 0, buy volume > sell volume) before
    // admitting a candidate. Config-gated since Jupiter 5m-stats coverage for this token class
    // hasn't been measured at scale yet — a one-line toggle if it turns out too strict.
    // Saat data permintaan Jupiter TIDAK ADA (bukan lemah — benar-benar tidak tersedia), terima
    // kandidatnya dan tandai. Diukur 2026-08-11: cakupan Jupiter cuma 30% untuk kelas token ini,
    // jadi gagal-tertutup membuang 70% kandidat tanpa bukti apa pun. Lihat blok demandConfirmed
    // di strategy2-papertrader.ts. Setel "false" untuk kembali ke gagal-tertutup.
    admitUnknownDemand: process.env.S2_ADMIT_UNKNOWN_DEMAND !== "false",
    requireDemandConfirmation: (process.env.STRATEGY2_REQUIRE_DEMAND ?? "true") !== "false",
    // Audit fix (2026-07-29): "cost-aware admission" — measured round-trip friction (entry+exit
    // combined) averaged ~3-4% across real closes. Reject an entry if the REAL quote's own
    // extraCost ratio alone (one-way) already implies an unusually costly/illiquid route — a
    // route this expensive one-way is a bad bet regardless of which direction the token moves.
    // Bumped 3→4 (owner, 2026-07-30, alongside minPositionUsd above): the fixed ~$0.62-0.63
    // route overhead measured live varies a little (0.6216-0.6275 across 300 real quotes) with
    // network/priority-fee conditions, not just position size — 4% keeps a real buffer above the
    // ~1.25% floor minPositionUsd targets instead of re-creating a new hairline ceiling.
    maxEntryFrictionPct: numEnv(process.env.STRATEGY2_MAX_ENTRY_FRICTION_PCT, 4, 0.1),
    /**
     * BUNDLE GATE THRESHOLD — how many of the top 10 holders must share the exact same
     * `start_holding_at` second before a candidate is treated as coordinated.
     *
     * Raised 2→3 (owner, 2026-07-31) once the admission funnel was finally visible in the API.
     * The gate was rejecting 711 of 748 evaluated candidates — 95% — and the distribution showed
     * why: 443 of those 711 (62%) were the weakest possible case, exactly TWO wallets. On
     * pump.fun, where snipe bots race every launch, two of the top ten landing in the same second
     * is ordinary traffic rather than evidence of a funded cluster. The strong signal is
     * elsewhere and survives untouched: 247 rejections had clusters of 5 or more, which is very
     * hard to produce without coordination.
     *
     * The original 2 came from an n=7 hand-check and was never measured at scale; on the same
     * day, Solana Tracker's own bundler data failed to separate winners from rugs on six real
     * closes (UNAWARE, the +25.77% winner, was the MOST bundled token in the sample). So this is
     * a correction of an over-tight filter, not a claim that bundling is harmless — cluster
     * sizes below the threshold are still logged (`strategy2-bundle-observed`) so the question
     * "do 2-wallet clusters actually underperform?" gets answered by real paired outcomes
     * instead of another guess.
     */
    bundleMinCluster: numEnv(process.env.STRATEGY2_BUNDLE_MIN_CLUSTER, 3, 2),
    // SCALE-OUT (owner, 2026-07-30): a real, live trade proved why a single all-or-nothing
    // trailing stop isn't enough — Kimi K3 ran entry $125,118 MC → peak $547,401 MC (+337.6%),
    // then the pool's liquidity vanished entirely BETWEEN TWO 30s polls (confirmed via
    // logs/events-2026-07-29.jsonl: MC read $541,416 → $0.03 one tick later, corroborated on the
    // next poll too). No trailing-stop width, however tight, can react to a move that happens
    // faster than the poll interval — closePosition()'s own no-liquidity forced-write-off kicked
    // in correctly, but the position had already given back its entire realized gain because
    // NONE of it had been locked in before the rug. These tiers realize a portion of the ORIGINAL
    // position (not a moving % of whatever remains) as real, quote-verified USD the moment gain
    // from entry crosses each threshold — so a subsequent instant rug can only erase the portion
    // still riding the trailing stop, never the whole trade. Sized to leave real upside on the
    // table (34% of the original size still fully exposed to the ratcheted trailing stop above)
    // rather than fully de-risking, since the strategy's ~21% win rate depends on letting winners
    // run — this is a partial hedge against the "collapse tail" risk, not profit-maximization.
    scaleOutTiers: [
      { gainFromEntryPct: 100, sellFractionOfOriginal: 0.33 },
      { gainFromEntryPct: 200, sellFractionOfOriginal: 0.33 },
    ] as Array<{ gainFromEntryPct: number; sellFractionOfOriginal: number }>,
    // FEELING AGENT for Strategy 2 (owner, 2026-07-30): previously only src/trader.ts (the
    // now-archived sniper, Strategy 1) ever called judgeVibe — Strategy 2's exits were purely
    // mechanical (MC-based trailing stop/max-hold/scale-out above), and the dashboard's Feeling
    // Agent panel sat permanently empty as a result (nothing was ever calling it). This is NOT
    // shadow-only: a high-confidence "dead" verdict can close a position early, same as any other
    // reason, always through a REAL GMGN quote (see AGENT_DEAD in checkExitAndUpdate) — never
    // assumed. `agentCanExit: false` turns it back into observation-only (still judges and still
    // feeds the dashboard bubble/vibe log) without a code change, if that turns out too aggressive.
    agentEnabled: (process.env.STRATEGY2_AGENT_ENABLED ?? "true") !== "false",
    agentCanExit: (process.env.STRATEGY2_AGENT_CAN_EXIT ?? "true") !== "false",
    agentMinConfidenceToExit: numEnv(process.env.STRATEGY2_AGENT_EXIT_CONFIDENCE, 70, 1),
    agentJudgeCooldownMs: numEnv(process.env.STRATEGY2_AGENT_COOLDOWN_MS, 120_000, 1_000), // don't re-judge the same position more than once per ~2min
    agentMinHoldSecToJudge: numEnv(process.env.STRATEGY2_AGENT_MIN_HOLD_SEC, 60, 5), // skip brand-new entries — nothing to read yet
  },

  // Feeling Agent (LLM vibe judge). NON-SENSITIVE prompts only.
  feeling: {
    url: process.env.FEELING_LLM_URL?.trim() || undefined,
    key: process.env.FEELING_LLM_KEY?.trim() || undefined,
    model: process.env.FEELING_LLM_MODEL?.trim() || "MiniMax-M3",
    /**
     * MODEL CHAIN, tried in order — a pinned model alone is a single point of failure.
     *
     * Measured 2026-08-09 against the real agent prompt: `auto` failed 3 of 4 calls (hanging past
     * 30s) while `step-3.5-flash` answered in 14,0s and 15,6s with valid JSON, comfortably inside
     * the 22s timeout. `DeepSeek-V4-Flash` and `MiniMax-M3` both timed out at 25s, `Qwen3.6-35B-A3B`
     * returned 429.
     *
     * But pinning is exactly what this relay punishes: a retired model answers HTTP 410 and the
     * agent goes fully dark — that already happened with `Qwen3.5-397B-A17B`. So the fast model
     * leads and `auto` stays the backstop, keeping the relay's own routing as the last line
     * rather than the first.
     */
    modelChain: (process.env.FEELING_LLM_MODELS?.trim() || "step-3.5-flash,auto")
      .split(",").map((m) => m.trim()).filter(Boolean),
    // TOKEN BUDGET + TIMEOUT for the LLM call. The relay's `auto` routing is NON-DETERMINISTIC:
    // one call lands on a fast non-reasoning model (agnes-2.0-flash: ~50 tokens, 1.4s), the next
    // on a REASONING model (stepfun step-3.7-flash: emits `reasoning_content` first, `content`
    // only after, 9-11s). Verified live: at max_tokens 200 the reasoning phase ate the whole
    // budget → finish_reason "length" → content:null → EVERY call to that route failed "no-json"
    // (the ~50% that hit the fast model succeeded — which is why it looked flaky, not dead).
    // MEASURED reality of this relay (api.hcnsec.cn): it is SLOW and variable under load. Valid
    // replies typically take 11-16s (MiniMax-M3 11.4s, DeepSeek-V4-Flash 12-16s); pinning a
    // specific model does NOT help (same latency, and some names — sensenova-u1-fast — just error),
    // so we keep `auto`, which is also resilient to model churn (a pinned model that gets retired
    // returns HTTP 410 = total outage). The ORIGINAL bug was unrelated to speed: max_tokens 200
    // let a reasoning route spend its whole budget on `reasoning_content`, leaving `content` null →
    // every such call failed "no-json". 1000 tokens was believed to fix that — RE-VERIFIED live
    // 2026-07-30 (Strategy 2's first-ever vibe call, logs/events-2026-07-29.jsonl "llm-call"):
    // BOTH attempts still came back finishReason:"length", 18.8s and 9.6s, meaning 1000 was STILL
    // not enough for whatever model `auto` routed to that time — the ORIGINAL diagnosis (reasoning
    // eats the budget before content) was right, the token number chosen for it just wasn't big
    // enough. Bumped to 2500 (timeout scaled to match: 18.8s was already the FULL-1000-token
    // generation time, so a 2.5x token budget needs real headroom, not the same 22s).
    maxTokens: Number(process.env.FEELING_MAX_TOKENS ?? 2500),
    timeoutMs: Number(process.env.FEELING_TIMEOUT_MS ?? 40_000),
    // The agent is an ACTIVE READER of GRADUATED positions (ones that passed
    // probation / showed development). It only sees the surviving minority — the
    // cheap probation metric already cut the obvious duds — so it can afford to
    // read them often (rich live signals: buying growth, momentum, MC, community).
    everyMs: 60_000, // re-read each graduated position this often (active conviction)
    minHoldMs: 60_000, // floor (graduation ~70s already gates it in practice)
    exitOnDyingConfidence: 70, // exit if the agent says dying/dead with ≥ this confidence
    // SHADOW MEASUREMENT. The agent may only ACT on de-risked runners (~1.5% of trades), which is
    // deliberate — it once cut a winner at +58%. But that also means there is no evidence either
    // way about widening its mandate, and there never will be while it stays silent. In shadow it
    // judges the positions it cannot touch and the verdict is logged only; joining those records
    // to the CLOSE outcome by mint answers "would the agent have helped?" with data instead of
    // opinion. Decisions are unaffected, so the running cohort stays valid.
    shadow: process.env.FEELING_SHADOW !== "false",
    shadowMaxConcurrent: 2, // the relay takes 11-16s per call — never let judgments pile up
    // Shadow uses its OWN, shorter minimum hold. Reusing the acting agent's 60s left a 60-90s
    // window (the no-development cut fires at 90s), so almost nothing was ever sampled. Shadow
    // never acts, so there is no reason to bind it to the acting agent's caution.
    shadowMinHoldMs: 30_000,
    // The agent NEVER cuts a live green runner: if a position is up ≥ this AND is
    // still within this drawdown of its peak, it rides the trailing stop instead.
    holdGreenAbovePct: 3, // up more than this = a winner in progress
    holdGreenDrawdownPct: 18, // and within 18% of its peak = still riding, don't cut
  },

  pumpPortalWsUrl: "wss://pumpportal.fun/api/data",
  rugcheckBaseUrl: "https://api.rugcheck.xyz/v1",
  jupiterBaseUrl: "https://api.jup.ag",

  // Safety gate thresholds (CONCEPT.md D4 + RESEARCH.md revisions)
  gate: {
    top10ConcentrationMax: 0.35, // reject if top-10 non-curve holders own >35%
    singleHolderMax: 0.15, // reject if any single non-curve holder owns >15%
    sweetSpotMcUsd: 100_000, // score bonus if MC is below this (early)
    // SNIPE (fast-follow): only enter very fresh/small bonding-curve tokens.
    // pump.fun reports marketCapSol; a fresh curve starts around ~28-35 SOL.
    snipeMaxEntryMcSol: Number(process.env.SNIPE_MAX_MC_SOL ?? 80), // hard: skip anything already pumped past this
    // ENTRY MC BAND (owner: "mc tinggi tapi tidak terlalu tinggi, mc rendah jangan terlalu rendah").
    // Enforced on the RELIABLE curve-derived entry MC (curveMcSol = price×1e9, 100% coverage), NOT
    // jupiter USD (sparse + drifts with SOL price). Anchored to the pump.fun launch level ~28 SOL:
    //   floor  — below this the coin has BLED below launch = the dead/rug zone (data: <~$3k = 59% rug,
    //            median peak 0%). "jangan terlalu rendah".
    //   ceiling — above this it already PUMPED hard before our (18-28s) entry = overpaying the curve
    //            AND the zone where dev-manufactured pumps bait snipers. "tinggi tapi tidak terlalu tinggi".
    // PROVISIONAL (launch-anchored, not yet tuned from full curveMcSol-outcome data). Env-overridable.
    // RE-DERIVED FROM FULL-COVERAGE curveMcSol OUTCOME DATA (125 closes, 2026-07-25). The old
    // 22/55 band was INERT — a bare pump.fun curve starts at vSol 30 / vTokens 1.073e9 ≈ 27.96
    // SOL, so 22 sat below every real entry (only 2 of 125 trades were under it) and the band
    // never actually filtered anything. What the data shows:
    //   MC ≤ 28.1 (bare launch, no net buying):  48 trades, 0 wins, 93-100% dead in EVERY age
    //                                            band — being early does not redeem it.
    //   MC 30-45:                                27 trades, 15% win, less than half the
    //                                            per-trade bleed (−0.016 vs −0.032 SOL).
    //   MC > 45:                                 already-pumped; win rate holds but bleed worsens.
    // floor 30 ≈ launch +7%: real net SOL has entered the curve. This is a STATE test at entry,
    // not a momentum wait — no time is spent, we just refuse curves nobody has bought.
    // HONEST: every band is still net negative. This halves the bleed, it does not create edge —
    // and n is small above the floor. Re-derive once the latency fix produces truly fresh entries.
    /**
     * DEV'S OWN BUY AT LAUNCH — reject above this.
     *
     * Measured 2026-08-10 across 1.689 band-cohort trades, then re-validated inside the live
     * cohort alone (`qdoru7`, n=1.002) before shipping: dev buys under 3 SOL returned +2,28%
     * against −3,79% above it, a 6,07-point gap at t=+1,61 with split-half winning 95% of 400
     * resamples. It is INDEPENDENT of the MC-band lever (correlation +0,073) and survives inside
     * every MC slice, so it is a second axis rather than a rediscovery of the first.
     *
     * The mechanism is not hit rate — that is 44% vs 45%, identical. It is magnitude: winners
     * average +54,9% vs +44,9% and losers −41,5% vs −45,4%. A dev who buys heavily into his own
     * launch owns supply that has to be sold into whatever rally follows.
     *
     * NOT monotonic at the bottom: the 0–1 SOL bucket (+1,71%) is weaker than 1–2 (+9,93%) and
     * 2–3 (+8,61%), which reads as "no skin in the game" also being a warning. Only the ceiling
     * is enforced; do not add a floor without measuring that separately.
     *
     * Costs ~54% of entries, so data accrues about twice as slowly. Set 0 to disable.
     */
    entryDevBuyMaxSol: Number(process.env.ENTRY_DEV_BUY_MAX_SOL ?? 0),
    entryMcBandSol: {
      floor: Number(process.env.ENTRY_MC_FLOOR_SOL ?? 30),   // ~1.07× launch — demand actually showed up
      ceiling: Number(process.env.ENTRY_MC_CEIL_SOL ?? 45),  // ~1.6× launch — don't buy the pump
    },
    /**
     * ── A/B LANTAI ENTRY-MC (2026-08-25) ──
     * Setiap kandidat diberi arm dari hash decisionId-nya SAJA, lalu lantai arm itu yang
     * memutuskan. LO memakai loFloorSol, HI memakai lantai produksi di atas; plafonnya sama.
     * Ada karena pita produksi terukur −2,47% ±0,96 di n=3.710 setelah koreksi eksekusi,
     * sementara pita 46–54 nol observasi — menurunkan lantai tanpa ini murni tebakan.
     * Lihat experiments/mc-band-ab.ts. Mati secara default.
     */
    entryMcAb: {
      enabled: process.env.ENTRY_MC_AB === "true",
      loFloorSol: Number(process.env.ENTRY_MC_AB_LO_FLOOR_SOL ?? 46),
    },
    // ── LAUNCH-TIME MC FLOOR (owner's idea) — applied at the CREATE EVENT, before the queue ──
    // A pump.fun curve's virtual reserves are identical for every token at birth (vSol 30 /
    // vTokens 1.073e9 → MC 27.96), so a dev CANNOT choose a starting market cap. Any MC above
    // 27.96 at creation is exactly the dev's own buy inside the create tx. That makes launch MC
    // a free, instant, zero-RPC measure of the creator's skin in the game.
    // MEASURED (13,737 launches; 1,337 followed to a terminal outcome; 403 of our own closes):
    //   dev buy 0        → 85% fade, 0.9% ever ran, our worst bucket at −0.031 SOL/trade
    //   dev buy 0-0.25   → −0.026 SOL/trade
    //   dev buy 0.25-0.5 → −0.024 SOL/trade, and the HIGHEST runner rate (7% peaked ≥+100%)
    //   dev buy 1-2      → 2% drained, −0.021 SOL/trade
    //   dev buy 2+       → 0% drained (0 of 310), −0.019 SOL/trade, but only 3-5% ever run
    // So the owner's instinct holds for RUG risk and per-trade bleed — monotonically — but a big
    // dev buy also buys a coin that fades instead of running. Default 28.1 = "the dev bought
    // SOMETHING", which drops the unambiguously worst bucket (41% of all launches) while keeping
    // the band the runners live in. Raise toward 30 for fewer, safer, flatter coins.
    launchMcFloorSol: Number(process.env.LAUNCH_MC_FLOOR_SOL ?? 28.1),
    // DEMAND CONFIRMATION — measured the RIGHT way: by how many PEOPLE bought, NOT
    // by an arbitrary SOL/marketcap floor (owner's thesis is "MC KECIL tapi HOLDER
    // BANYAK" — small MC + many holders is the BEST case; a SOL floor wrongly killed
    // it). Enter at ANY marketcap, but only once real buyers show up (holders=1 is
    // just the dev = dead-on-arrival). Live holder count from getTokenLargestAccounts.
    // Cadangan saat hitungan holder TIDAK TERBACA: pakai pembelian non-dev dari kurva segar
    // (entryVSol − 30 − devInitialBuySol). Dipasang 2026-08-12 setelah DAS Helius berhenti
    // mengindeks mint baru dan laju entry jatuh dari ~17/jam ke 1/jam. Ambang sengaja RENDAH —
    // tugasnya cuma menolak yang benar-benar mati (cuma dev), bukan menyeleksi kualitas.
    holderFallback: {
      enabled: process.env.HOLDER_FALLBACK !== "false",
      minOtherBuySol: Number(process.env.HOLDER_FALLBACK_MIN_SOL ?? 0.5),
    },
    minHoldersToSnipe: Number(process.env.MIN_HOLDERS_SNIPE ?? 10), // ≥ this many real buyers = demand
  },

  // MOMENTUM CHECKPOINTS (diegodiaz-style, curve-based). STOP blind-sniping — a new
  // token goes on a WATCHLIST and is only bought once its bonding curve shows
  // CONFIRMED, ACCELERATING net buying. vSol only rises on net buys, so vSol growth
  // = real demand and vSol-growth acceleration = building momentum. FREE (no trade
  // stream / no JWT). This directly attacks why the bot bled: buying dead tokens.
  checkpoint: {
    enabled: process.env.CHECKPOINT !== "false",
    // FAST SCAN (owner: "koinnya cepat, jangan lambat"). The batch getMultipleAccounts read
    // (one RPC for the whole watchlist) lets us poll fast + watch many without hitting the
    // RPC limit — so we catch fast movers and enter EARLIER instead of buying the peak.
    pollMs: 5_000, // re-read the whole (batched) watchlist every 5s — fast enough for memecoin speed
    maxWatch: 80, // watch far more at once (batch read makes it cheap) → stop dropping launches when full
    zombieMs: 45_000, // drop dead-on-arrival faster to free slots for fresh launches
    zombieGrowthPct: 4, // "dead" = grew < this by zombieMs. Separate from confirm's bar so slow-burners aren't killed early.
    confirmMs: 45_000, // enter EARLIER once momentum is real (was 90s = buying after the initial pump)
    timeoutMs: 300_000, // give up after 5 min with no confirmation (was 8 — free the slot sooner)
    minGrowthPct: 20, // curve must have grown ≥ this vs first sample = real net buying happened
    minAccel: 1.0, // recent vSol-growth RATE ≥ this × the earlier = momentum holding/building (not fading)
    minVelSol: 0.01, // PRIMARY signal (audit #5): net SOL/s flowing in NOW must be ≥ this — real live inflow, not a stalled earlier pump. Robust vs the ratio (can't be faked by a tiny divisor).
  },

  // Community-momentum scoring weights (soft signals — the "banyak komunitas" edge)
  momentum: {
    minHoldersForBonus: 150, // RugCheck holder count above this = real community forming
    strongBuyRatio: 2.0, // buys ≥ 2x sells (1h) = demand
    heavyBuyCount1h: 300, // many distinct buys/hr = crowd
    // Distribution: holders per $10k of marketcap. Small MC + many holders =
    // organic/distributed = the owner's "acuan kemenangan". Higher = better.
    holdersPerMc10kStrong: 40, // ≥40 holders per $10k MC = strongly distributed
  },

  // Jupiter token-intelligence gate (from on-chain-forensics research). Free.
  jup: {
    minLiqToMcRatio: 0.05, // reject if liquidity < 5% of marketcap (slippage-bomb, PDF: <10% bad)
    maxDevBalancePct: 15, // reject if dev still holds >15% of supply (bundled dev-buy)
    serialDeployerMints: 500, // dev who minted >500 tokens = serial deployer/rugger → reject
    minOrganicScore: 5, // soft: below this = little organic activity (or wash); score penalty
    goodOrganicScore: 60, // soft: above this = healthy organic activity; score bonus
  },

  // pump.fun top-holders (free whale-quality endpoint, advanced-api-v2). Snipers/
  // bundlers among the top holders = manufactured demand that dumps on real buyers.
  pumpHolders: {
    perMin: 60, // rate cap for the top-holders endpoint
    // These mirror pump.fun's OWN app "red lines" but are used as SOFT signals (score +
    // Feeling-Agent context), NOT rigid gates — every coin is different. The agent reads
    // the metric against the live buy-tape/crowd and judges; it does not auto-reject.
    maxSniperPct: 10, // app red >10% snipers — soft penalty + agent context
    maxBundlerPct: 10, // app red >10% bundlers — soft penalty + agent context
    maxTop10Pct: 20, // app red >20% top-10 concentration — soft penalty + agent context
    hardDevPct: 50, // the ONE hard backstop: dev holding >50% of supply = obvious rug fuel
    minSample: 12, // only apply the hard dev backstop when ≥ this many holders returned (else too fresh)
    hardDevFundedBuyers: 3, // rug-cluster hard backstop: dev wallet directly funded ≥ this many early buyers = manufactured demand (organized-rug tell)
  },

  // pump.fun per-token trades (free real buy-pressure, swap-api v2). Replaces the
  // funded-PumpPortal trade stream — powers momentum-checkpoint confirm + agent crowd.
  pumpTrades: {
    perMin: 120, // rate cap for the trades endpoint (polled per watched/held token)
    whaleSol: 1.0, // a single buy ≥ this SOL counts as a whale buy
    minBuyPressurePct: 58, // checkpoint: buys must be ≥58% of window trades to confirm
    minUniqueBuyers: 10, // checkpoint: ≥10 distinct buyers = real crowd (was 5 — thin-buyer pumps like ALLEARS/6-buyer leaked through)
    extremeGrowthPct: 100, // above this curve growth, a verified HEALTHY tape is MANDATORY (extreme pump + thin/unverifiable crowd = manipulation → reject)
  },

  // Bitquery multi-launchpad stream — ONE realtime WS feed across ALL Solana launchpads
  // (pump.fun + Meteora DBC/Believe/Bonkfun + smaller ones). Because it carries REAL
  // trades, it does detection AND momentum-confirmation in one place (venue-agnostic,
  // no per-launchpad curve reads). A mint is confirmed when its live tape shows a real,
  // accelerating, buy-dominant crowd — same idea as the pump.fun checkpoint but for all.
  bitquery: {
    /**
     * TOKEN POOL, tried in order. Bitquery's free tier meters STREAMING time separately from
     * HTTP queries: a spent token still answers GraphQL queries fine but the websocket
     * subscription is refused with "access restricted by time limit: usage quota reached".
     * So a token being "alive" is not evidence the stream will run — only the stream is.
     * BITQUERY_TOKENS is a comma/newline list; BITQUERY_TOKEN is appended after it.
     */
    tokens: (() => {
      const raw = [...(process.env.BITQUERY_TOKENS ?? "").split(/[\n,]/), process.env.BITQUERY_TOKEN ?? ""];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const t of raw) { const s = t.trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } }
      return out;
    })(),
    enabled: (process.env.BITQUERY_TOKENS || process.env.BITQUERY_TOKEN) ? process.env.BITQUERY !== "false" : false,
    token: process.env.BITQUERY_TOKEN?.trim() || undefined,
    endpoint: "wss://streaming.bitquery.io/eap",
    launchpads: ["pump", "dynamic_bonding_curve"], // start with pump.fun + Meteora DBC (covers Believe/Bonkfun)
    confirm: {
      minAgeMs: 45_000, // let a real crowd form before confirming
      maxAgeMs: 600_000, // give up if not confirmed within 10 min
      minUniqueBuyers: 12, // ≥ this many distinct buyers = real crowd, not one wallet
      minBuyPressurePct: 60, // buys ≥ this % of trades in the window
      minAccel: 1.15, // recent trade-rate ÷ earlier ≥ this = accelerating
      minNetBuyUsd: 300, // net (buy − sell) USD flow must be positive by ≥ this = real money in
    },
    pruneMs: 900_000, // drop tracked mints from memory after this
    maxTracked: 4000, // cap memory
  },

  // POST-EXIT tracking: after we close a position, keep sampling the token's price for
  // a window so we can learn — did it keep running after we sold (exit premature?), how
  // long to peak, how much upside we left. This is how the bot learns its own hold time.
  postExit: {
    enabled: process.env.POST_EXIT !== "false",
    windowMs: 45 * 60_000, // keep watching each closed token for 45 min after exit
    sampleMs: 30_000, // sample its price this often
    maxTracked: 40, // cap concurrently-tracked closed tokens (bounds swap-api load)
    prematureRisePct: 25, // if price rose ≥ this % vs our exit within the window → exit was PREMATURE
  },

  // pump.fun candles (free OHLCV, swap-api v1) — raw chart fed to the Feeling Agent.
  pumpCandles: {
    perMin: 120, // rate cap for the candles endpoint (polled per held token on each vibe)
    interval: "1m", // timeframe the agent reads
    limit: 10, // how many recent candles to hand the agent
  },

  // Dev/creator wallet tracking (buy-back = long-term signal; dump = rug escape)
  dev: {
    dumpExitPct: 0.5, // creator sells ≥50% of entry holding → exit position (DEV_DUMP)
    buybackSupplyFrac: 0.003, // creator's holding grows ≥0.3% of supply → buy-back (works from a 0 baseline)
    historyLimit: 20, // how many of the creator's recent txns to scan for the buy-only pattern
    // Backstop poll cadence per open position. The REAL-TIME dev-dump path is the DevWatcher
    // WebSocket push (free, sub-second); this poll only covers a missed push. It used to run on
    // every 4s tick per position (~2.5 req/s at 10 positions) and was a top-3 consumer of the
    // RPC budget that entries needed.
    pollMs: Number(process.env.DEV_POLL_MS ?? 20_000),
  },

  // Auto-reset trials: when a 1-SOL run bleeds out (broke) it is pointless to sit
  // idle — record the run's result to a ledger, then reset to a fresh 1 SOL and go
  // again. Many independent trials reveal the TRUE distribution (does the fat tail
  // ever pay?) far better than one run, and the per-run drawdown tells us how much
  // spare float a live account needs to survive a bad streak.
  autoReset: {
    enabled: process.env.AUTO_RESET !== "false", // on by default
    resetFloorFrac: 0.3, // dead when balance < this fraction of the STARTING float (scales with any float)
    minTradesBeforeBroke: 20, // give each run at least this many shots at the fat tail first
    maxTradesPerRun: 300, // also cap a run's length so survivors get recorded too
  },

  // Risk limits (CONCEPT.md D6) — used by the paper trader
  risk: {
    paperTradeSizeSol: Number(process.env.PAPER_TRADE_SIZE_SOL ?? 0.03), // small stake (owner's model): a rug = a small bounded loss; winners scale out on the way up. More shots at the fat tail per SOL.
    // Compounding: when ON, position size grows with the (paper) balance instead
    // of a fixed amount — but HARD-capped by the bonding curve's own liquidity,
    // because a big buy into a tiny fresh curve just eats itself in slippage.
    compound: process.env.COMPOUND === "true",
    riskPerTradePct: Number(process.env.RISK_PER_TRADE_PCT ?? 20), // % of balance per trade when compounding
    maxCurveFracPct: Number(process.env.MAX_CURVE_FRAC_PCT ?? 3), // cap: never exceed this % of the curve's SOL (slippage ceiling)
    startingFloatSol: Number(process.env.STARTING_FLOAT_SOL ?? 0.5),
    // Passing the hard gate isn't enough to buy — the SCORE (momentum + dev +
    // metadata signals) must clear this bar too. Turns 48% "pass" into a real
    // entry filter. Tune via MIN_SCORE_TO_OPEN.
    minScoreToOpen: Number(process.env.MIN_SCORE_TO_OPEN ?? 62),
    // No fixed cap on concurrent positions — CAPITAL decides (see canOpen). The
    // bot opens while free float covers the next size and auto-waits when it
    // doesn't. Count is bounded naturally by (free float ÷ trade size).

    // Copycat/spam guard: pump.fun is flooded with identical-name tokens (seen
    // live: 6 simultaneous "ELONIUS"). Never buy the same symbol twice within this
    // window — it's spam, and buying all of them just burns fees.
    copycatWindowMs: Number(process.env.COPYCAT_WINDOW_MS ?? 30 * 60_000),

    // STALE-ENTRY GUARD (P0 fix, 2026-07-28): a candidate whose detect→decide latency has
    // already blown past a real, generous ceiling no longer describes a "snipe" — the setup
    // context (early holders, curve state, competing bots) has almost certainly moved on.
    // REMEASURED 2026-08-22 (live, decisions↔live-exec join, n=104): detect→fill P50 ≈10s /
    // P90 ≈14s — the old "P50 54s / P90 670s" figure was an RPC-queue-congestion artefact of
    // 2026-07-28, fixed by the pool work; this budget is NOT the bottleneck anymore. The
    // remaining ~7s decision→fill is execution (tx build + send + confirm), addressed by the
    // websocket confirmation path in executor.ts, not by moving this guard.
    // PROVISIONAL — NOT tuned from the dataset it's meant to protect. 120s here is a structural
    // "this isn't a snipe anymore" bound, not a percentile reverse-engineered from the same
    // trades used to judge profitability.
    staleEntryBudgetMs: Number(process.env.STALE_ENTRY_BUDGET_MS ?? 120_000),

    // Smart RE-ENTRY: a token we already closed can be entered again, but only
    // with a HIGHER bar — never blindly re-buy a corpse. Exits split in two:
    //   terminal (dev rugged / drained / dumped-through-stop) → NEVER re-enter
    //   soft (just went sepi / timed out / trailed off a peak) → re-enter allowed
    //     but only after a cooldown AND at a stricter score, and capped in count.
    reentry: {
      // dead/scam — no re-buy, ever. SETUP_TOXIC_LATE joins them: the full (post-entry) enrichment
      // proved the setup toxic, which is a permanent property of that launch, not a passing mood.
      // NO_DEVELOPMENT stays SOFT on purpose — "it hadn't moved yet" is not proof of a corpse, so
      // it may be reconsidered after the cooldown at the stricter re-entry score.
      blockReasons: ["DEV_DUMP", "LIQUIDITY_GONE", "STALE", "STOP_LOSS", "SETUP_TOXIC_LATE"],
      cooldownMs: 15 * 60_000, // after a soft exit, wait this long before reconsidering
      extraScore: 10, // re-entry must clear minScoreToOpen + this (needs to look STRONGER than a fresh coin)
      maxAttempts: 3, // hard ceiling on how many times we'll ever touch one mint
    },
    // Sniper HOLD model (owner's style): enter early/cheap, then HOLD while the
    // token is busy (rame) and exit when it goes quiet (sepi) — not on a timer.
    /**
     * HOLD CAP. The comment here used to say "the real exit is the QUIET/volume signal" — that
     * signal no longer exists (its `quietWindowMs`/`quietMinHoldMs` config was removed as dead),
     * so the 3-day value was the ONLY cap and effectively meant "never".
     *
     * That left a real hole. A position whose EXECUTABLE peak lands between the no-development
     * threshold (5%) and the first trail band (15%) matches no exit rule at all: too good for the
     * no-dev cut, not good enough to arm the trail, and above the -70% catastrophic floor. One
     * such position sat 54 minutes bleeding to -42% while every rule declined to fire.
     *
     * MEASURED over 172 closed trades: winners hold a median of 10s, p90 48s, and the longest
     * winner EVER was 91s. Trades held past 60s won 12% and averaged -28.9%. So 120s is chosen to
     * sit clear of every winner we have ever had while still bounding the zombies — on this data
     * it would have cut 3 trades, all losers, none of them winners.
     *
     * This bounds the worst case; it does not create edge. It is capital hygiene, and it is
     * fitted to the CURRENT regime — if a coin ever needs 3 minutes to run, this cuts it.
     */
    maxHoldMsFastFollow: Number(process.env.MAX_HOLD_MS ?? 120_000),
    absoluteMaxHoldMs: Number(process.env.ABS_MAX_HOLD_MS ?? 120_000), // hard cap
    // NOTE: the `probation` block (windowMs/minCurveGrowthPct/minPeakGainPct) was REMOVED. Its
    // code path was deleted long ago and only comments referenced it, so it sat here looking like
    // an active 70s observation window that did not exist. Its job is now done by
    // `noDevelopment` below, which is tuned on measured data. This is the same defect class as the
    // old trailArmPct/targetTpPct leftovers: config that reads as live and quietly misleads.
    // Only `quietGrowthPct` survives here: the QUIET auto-close was removed (a stopwatch cut was
    // killing fat tails), so quietWindowMs/quietMinHoldMs had no reader. Quietness is now just a
    // signal handed to the agent. quietGrowthPct is still used to decide "did the curve make a new
    // activity high" in tick().
    quietGrowthPct: 1, // vSol must grow ≥1% to count as "still busy"
    // Asymmetric exit model: let winners run via a trailing stop, cut losers fast.
    // DYNAMIC TRAILING (profit-lock) — the fix for the round-trip bleed. The trail %
    // LOOSENS as the peak gain grows (lathan-style), so small/medium winners are
    // banked tightly while a rare mega-runner is let free. Chosen by the HIGHEST peak
    // gain reached (never shrinks back). trail:100 = effectively never stops out.
    // Reads from PEAK gain, exits when price pulls back ≥ trail% from that peak.
    // Data basis: 277 post-exit samples showed 87-98% of sold coins never recover, so
    // locking profit on the pullback is safe; the loose 100% band protects the fat tail.
    dynamicTrail: [
      { gain: 15, trail: 6 },   // +15% peak → bank on a 6% pullback (tight)
      { gain: 40, trail: 12 },  // +40% → 12%
      { gain: 80, trail: 22 },  // +80% → 22%
      { gain: 150, trail: 35 }, // +150% → 35% (room to breathe)
      // WINNER BRAKE (was `trail: 100` = no stop at all above +300%, leaving only the LLM agent —
      // which by design only runs once de-risked and can be down). MEASURED on the 290 real tick
      // paths: of the 4 that peaked above +300%, TWO round-tripped all the way to −76% and −73%.
      // The whole cohort realized +15% with no brake vs +411% with a 45% band. A wide band still
      // lets a mega-runner breathe (it must give back nearly half its peak to trigger) but it can
      // no longer hand back the entire move. Matches the observed +527%→+20% and +550%→+108%.
      { gain: 300, trail: 45 }, // +300% → 45% giveback allowed
      { gain: 800, trail: 60 }, // +800% → 60% (a true moon gets the most rope, but not infinite)
    ],
    // FADE TIGHTENING — the band is chosen by how high the coin got, but says nothing about how
    // long ago that was. Measured: median time-to-peak is 82s and ~70% of runners peak inside 2
    // minutes, so a position still drifting a minute after its high has most likely finished
    // climbing and is now just giving the gain back slowly — too slowly to trip a wide band.
    // Once `afterPeakSec` has elapsed with no new high, the active band is multiplied by
    // `bandMult` (a 22% band becomes 13%), so the exit happens while the gain is still there.
    // The timer RESETS on every new peak, so a coin that is genuinely still climbing is untouched.
    // HONEST EVIDENCE: on 297 archived paths this changed the outcome of only 3 of them (+77% of
    // a stake, but 41% of that from a single path); it improved 3 and worsened 0, and won 90% of
    // 200 split-half runs. Direction is consistent and the mechanism is sound, but n=3 events —
    // treat as UNPROVEN until the live cohort produces more. Set FADE_TIGHTEN=false to disable.
    fadeTighten: {
      enabled: process.env.FADE_TIGHTEN !== "false",
      afterPeakSec: Number(process.env.FADE_AFTER_SEC ?? 60), // seconds since the last new high
      bandMult: Number(process.env.FADE_BAND_MULT ?? 0.6),    // 22% band → 13%
    },
    // NO-DEVELOPMENT CUT — the fix for capital stuck in coins that simply never move.
    // The old 70s probation was removed and nothing replaced it: below the −70% catastrophic
    // floor there was no exit at all, so a position could sit at −51% for hours (MAX_HOLD is
    // 3 days). MEASURED on 290 real paths: "by 90s the position never printed +5% executable"
    // catches 187/250 non-runners (75%) while killing only 2/25 eventual runners (8%) — the
    // single largest improvement available in the exit scheme (+257% of a stake across the
    // cohort; +395% combined with the winner brake). Requiring +10% instead of +5% is WORSE
    // (kills more runners for little extra), and adding a −35% soft stop on top is redundant
    // (it slightly REDUCES the total) — both tested, both rejected.
    noDevelopment: {
      enabled: process.env.NO_DEV_CUT !== "false",
      // RE-TUNED 2026-07-26 on the CURRENT cohort. The 90s window was derived from archive data
      // collected when entry latency was ~490s — we arrived long after launch, so the deaths we
      // saw were the slow tail. Now that entry is ~3s we hold coins through their FIRST seconds,
      // and they die far faster: of 74 CATASTROPHIC exits, median hold was 34s and **92% were
      // already dead before the 90s cut could act**. The cut was firing after the damage.
      // Measured on 313 current-cohort paths: 45s catches 90% of non-runners while killing
      // **0 of 31 runners** — strictly better than 90s (+215% of a stake across the cohort).
      // Do NOT go shorter: 20s starts killing 23% of runners, 15s kills 35%.
      afterMs: Number(process.env.NO_DEV_MS ?? 45_000),
      minPeakPct: Number(process.env.NO_DEV_PEAK_PCT ?? 5), // executable peak gain it must have printed by then
    },
    // EARLY CUT (2026-08-11). BEDA JENIS dari noDevelopment di atas: yang itu menguji PUNCAK
    // ("belum pernah naik"), yang ini menguji HARGA SEKARANG ("sudah jatuh"). Peringatan
    // "jangan lebih pendek dari 45s" di atas berlaku untuk uji puncak — memotong berdasarkan
    // puncak di detik ke-15 membunuh 35% runner karena runner sering belum sempat naik.
    // Posisi yang SUDAH −10% di 5 detik pertama adalah populasi yang berbeda jauh.
    // Validasi lengkap ada di trader.ts pada blok EARLY CUT.
    earlyCut: {
      enabled: process.env.EARLY_CUT !== "false",
      withinMs: Number(process.env.EARLY_CUT_MS ?? 5_000),
      pnlPct: Number(process.env.EARLY_CUT_PCT ?? -10), // dikunci −10, bukan −5 yang optimum di grid
    },
    // NOTE: the exit is the DYNAMIC TRAIL (dynamicTrail above) + catastrophic + dev-dump + agent —
    // NOT a fixed stop or a take-profit target. Removed dead config (trailArmPct/trailingStopPct/
    // *Fast/stopLossPct/targetTpPct) that looked active but was never read (they misled analysis —
    // e.g. targetTpPct made it look like a +300% auto-sell existed; it did not).
    // Dev-dump exit haircut: when the dev dumps, the price is collapsing as they
    // sell — we can't realistically fill at the pre-dump price. Apply a
    // conservative penalty so paper DEV_DUMP wins aren't fantasy.
    devDumpHaircutPct: 25,
    // STALE exit haircut: a position we couldn't price for ~60s (15 failed reads) may have
    // died during the read-fail window; its last reserves are optimistic. Haircut the
    // faithful proceeds on a STALE close so we don't over-credit a possibly-dead token.
    staleHaircutPct: 35,
    // ── MECHANICAL FALLBACK (#5) — the safety net for when the LLM agent is DOWN ──
    // The agent (thinking, flexible) is the primary exit brain. But it's a single point
    // of failure: if the API dies, positions would be left with no downside rem. So when
    // the agent is unavailable (deadAfterFailures consecutive LLM failures), a RULE-BASED
    // net takes over — rigid by design, but better than an unmanaged bleed. When the agent
    // recovers, it resumes deciding. Dynamic trailing still locks winners in BOTH modes.
    agentFallback: {
      deadAfterFailures: 3, // legacy; liveness now uses hardDownFailures + minSuccessRate below
      // LIVENESS, re-derived from measurement. The relay times out on ~1/3 of calls, and at that
      // rate a 3-in-a-row streak shows up in ~51% of 21-call stretches — so the old consecutive
      // test declared DOWN by chance while 67% of calls were answering fine. A flaky-but-usable
      // agent is not a dead one. DOWN now requires either a genuinely hard-down relay, or a recent
      // window that is actually bad.
      hardDownFailures: 6,   // consecutive failures that mean the relay really is gone
      minSuccessRate: 0.34,  // below this over the last 12 trading-path calls → degraded → DOWN
      stopLossPct: -55, // while DOWN, hard-stop a position this far underwater (tighter — no brain watching)
      devDumpExit: true, // while DOWN, a dev dump exits immediately (agent isn't there to weigh it)
    },
    // ALWAYS-ON CATASTROPHIC GUARD (#3) — the hard floor that runs from SECOND 1 on EVERY
    // tick, INDEPENDENT of the agent. The agent (or fallback) decides hold/exit WITHIN this
    // envelope but can NEVER disable it. Deep enough (−70% of EXECUTABLE value) that it only
    // catches disasters — it does not kill winners (winners are up, not down 70%), preserving
    // the "let the fat tail run, no rigid SL on normal moves" thesis. This is the safety net
    // for going LIVE: a fast bleed is stopped even if the LLM is mid-thought or wrong.
    catastrophicStopPct: -70,
    // LADDERED SCALE-OUT (owner's model: "ambil partial saat naik tinggi"). Instead of ONE
    // sell, take partials at rising tiers so we BANK the run progressively — capturing more
    // of the peak on the many medium winners — while a runner TAIL keeps riding the dynamic
    // trail for the rare moon. Loss is bounded (spot, small stake); this is the winning side
    // of the asymmetric math (data: losers already avg −8%; the lever is capturing winners).
    // Each tier fires ONCE when executable P&L crosses its gain. The un-sold remainder
    // (1 − Σ sell) rides dynamicTrail uncapped. NOTE: parameters are a PRINCIPLED default,
    // not overfit to the noisy archived data — clean v-run data will tune them.
    scaleOut: {
      enabled: true,
      // TRUE PRINCIPAL-FIRST (audit fix): recover the FULL stake by +100%, then let the rest ride.
      // At +50% (1.5×) sell 20% → banks 0.30 stake; at +100% (2×) sell 35% → banks 0.70 → TOTAL ≈1.0
      // stake recovered by +100% (principal home). Remaining 30% rides the trail to the fat tail;
      // smaller later tiers only shave a bit so the runner stays meaningful.
      // OWNER'S THESIS, VALIDATED: "TP before the dev sells — even a partial on the first 50-90%
      // of the move is already profit; the rest is the dev's decision." Tested on 297 real tick
      // paths: pulling the FIRST tier down from +50%/20% to +30%/40% is worth +136% of a stake
      // across the cohort. Split-half cross-validation (200 random splits, selected on one half
      // and scored on the untouched half) : this beats the old ladder in 97% of out-of-sample
      // splits, median +67% — so it is a real effect, not a grid-search artifact.
      // Selling almost everything early is NOT the answer (+40%/85% tested = −79%, worse): the
      // gain comes from banking the common small move sooner while a real runner still rides.
      // Principal-first is preserved and arrives EARLIER: 0.40×1.30 + 0.30×1.80 = 1.06 stake
      // recovered by +80% (the old ladder needed +100%).
      tiers: [
        { gain: 30, sell: 0.40 },   // +30% → bank 0.52 stake (most coins that move at all reach here)
        { gain: 80, sell: 0.30 },   // +80% → bank 0.54 → principal fully home by here
        { gain: 200, sell: 0.15 },  // +200% → shave the runner
      ],                            // 15% remainder rides uncapped to the fat tail
      minKeepFrac: 0.15,            // never sell below this remaining (keep a real runner for the moon)
    },
    // Cost model so paper P&L is honest (RESEARCH.md validity note).
    // Slippage is now MEASURED, not guessed: bonding-curve math (fast-follow) or
    // Jupiter quote priceImpactPct (swing). This bucket is only the fallback when
    // a live impact figure is unavailable.
    // ITEMISED REAL FEES (per side) so paper P&L never flatters itself. A round
    // trip pays each of these TWICE (buy + sell). Previously only the routing fee
    // was counted — pump.fun's own 1% and the fixed SOL gas were missing, which
    // understated cost by ~2%+ per trade.
    swapFeePct: Number(process.env.ROUTING_FEE_PCT ?? 0.5), // interface/routing fee, per side (PumpPortal path). Set 0 when executing DIRECTLY via Jito (no router). VERIFY from a real tx before trusting.
    // PER-LAUNCHPAD protocol fee (per side, TOTAL trader pays) — updated to the 2026 fee
    // schedule (re-audit found the old numbers UNDERSTATED cost → expectancy too high).
    //   pump.fun bonding curve = 1.25% (0.95% protocol + 0.30% creator).
    //   PumpSwap / graduated AMM = ~1.0% at low MC (canonical tiers 0.25–1.25%; was wrongly 0.25%).
    //   Meteora DBC / Bonk / LaunchLab ~1%. Conservative: never flatter. VERIFY from real tx before live.
    launchpadFeePct: {
      pump: 1.25,                    // pump.fun bonding curve = 0.95% protocol + 0.30% creator (2026 schedule)
      "dynamic_bonding_curve": 1.0,  // Meteora DBC (Believe/Bonkfun) — per-pool configurable, conservative estimate
      bonk: 1.0,                     // LetsBonk / Raydium LaunchLab
      raydium_launchpad: 1.0,
      pumpswap: 1.0, pump_amm: 1.0, raydium: 1.0, // post-graduation AMM pools (canonical ~1% low-MC tier, was 0.25% — understated)
      default: 1.0,                  // unknown launchpad → assume 1% (conservative, never flatter)
    } as Record<string, number>,
    ammFeePct: 1.0, // graduated AMM pool fee, per side (was 0.25% — canonical PumpSwap is ~1% at our MC range)
    baseTxSol: 0.000005, // Solana base network fee per signature (priorityFee is in exec)
    // ── ASSOCIATED TOKEN ACCOUNT RENT — MEASURED, and previously not modelled AT ALL ──
    // Buying a token you have never held requires creating its SPL associated token account, and
    // that account must be rent-exempt: a fixed 0.00203928 SOL, paid on the BUY. Every token this
    // bot buys is brand new, so this is paid on EVERY entry. On a 0.05◎ stake it is **4.1% of the
    // position** — larger than the entire modelled round-trip fee — and it was simply absent from
    // the cost model, so every paper P&L was flattered by that much.
    // Confirmed on-chain: pump.fun buys that create an ATA show exactly ~0.00199–0.00204 SOL of
    // extra SOL leaving the buyer beyond the swap itself.
    // It IS recoverable by closing the account after selling, but this bot never closes them, so
    // counting it as a cost is the honest (and conservative) treatment.
    ataRentSol: Number(process.env.ATA_RENT_SOL ?? 0.00203928),
    // ── EXECUTION REALISM (audit 2026-08-25) ──
    // Book paper P&L at the rate live actually delivers it, using the transfer function that
    // `npm run live:truth` measures from chain-verified trades. Default ON: the same 680 trades
    // that paper scored +3.84% returned −9.08% in real SOL, and a simulator whose headline number
    // is unreachable is not a conservative simulator, it is a broken one. Set EXEC_REALISM=false
    // to see the raw model (the raw figures stay in every CLOSE record either way).
    execRealism: process.env.EXEC_REALISM !== "false",
    // ── RECLAIMING THAT RENT (SPL Token CloseAccount) ──
    // Per the SPL Token spec, CloseAccount returns the account's full rent-exempt lamports to a
    // destination of your choosing, and for a non-native account the only precondition is a ZERO
    // token balance. Our exit always sells the entire remaining quantity, so that precondition is
    // met on every trade — the ~0.00204◎ is recoverable, not spent, minus one cheap close tx.
    // This matters far more than it looks: on a 0.05◎ stake it is 4.1% per trade, so treating it
    // as a pure cost would understate the strategy by ~4 points and could reject a viable edge.
    // Modelled as recovered by DEFAULT because any competent live implementation reclaims it.
    // ⚠ This is a COMMITMENT: the live execution path must actually issue CloseAccount after the
    // sell, otherwise paper is flattered by exactly this amount. Set ATA_RECLAIM=false to model
    // the pessimistic case where the rent is abandoned.
    ataReclaim: process.env.ATA_RECLAIM !== "false",
    fallbackSlipByLiquidity: [
      { underUsd: 10_000, slipPct: 8 },
      { underUsd: 50_000, slipPct: 4 },
      { underUsd: Infinity, slipPct: 2 },
    ],
  },

  // Client-side pacing to respect free-tier limits
  limits: {
    // Client-side RPS cap. MUST reflect the provider we ACTUALLY call, which is RPC_URL when
    // set — not whichever key merely exists in .env. Keying this off `heliusKey` was a latent
    // trap: a dead/exhausted Helius key still sitting in .env kept us pacing to Helius's limit
    // while every request went somewhere else entirely. Set RPC_MAX_RPS to the number on your
    // provider's dashboard; the fallbacks below are deliberately conservative guesses, not facts.
    rpcMaxRps: Number(process.env.RPC_MAX_RPS ?? (rpcPool[0]!.includes("api.mainnet-beta.solana.com") ? 2 : 10)),
    // Share of the RPC budget the RESEARCH lane (counterfactual observatory, backfill
    // enrichment) may use. Research also yields whenever a trading RPC is in flight, so
    // this is a ceiling on idle-capacity use, not a reservation. MEASURED cause of the
    // 490s detect→entry latency: research was competing 1:1 with live entries.
    researchRpcFrac: Number(process.env.RESEARCH_RPC_FRAC ?? 0.2),
    rugcheckPerMin: process.env.RUGCHECK_API_KEY ? 30 : 5,
    jupiterPerMin: process.env.JUPITER_API_KEY ? 55 : 25, // keyed 60/min, keyless 30/min
    // AUDIT P1-6: the token bucket caps the AVERAGE rate but its burst allowance equals its
    // capacity (= rpcMaxRps) — after any idle gap, that many requests can leave in the same
    // instant. Measured: a burst hit ~28.7 rps against an 8 rps budget. This caps how many HOT
    // requests may be simultaneously in flight, independent of how many tokens are banked,
    // smoothing bursts without slowing the steady-state rate (concurrent ≠ per-second).
    rpcMaxConcurrent: Number(process.env.RPC_MAX_CONCURRENT ?? 4),
  },

  // Execution layer (live-phase prep). Modes, safest → riskiest:
  //   dry-run  — no wallet, no tx (pure price simulation; current default)
  //   simulate — build REAL pump.fun tx + simulateTransaction on mainnet (no send, ~free)
  //   devnet   — full sign+send+confirm on devnet with faucet SOL (plumbing test)
  //   live     — real mainnet money (HARD-GATED, not enabled here)
  exec: {
    mode: (process.env.EXEC_MODE?.trim() || "dry-run") as "dry-run" | "simulate" | "devnet" | "live",
    devnetRpc:
      process.env.DEVNET_RPC?.trim() ||
      (heliusKey ? `https://devnet.helius-rpc.com/?api-key=${heliusKey}` : "https://api.devnet.solana.com"),
    keyFile: new URL("../.keys/bot-wallet.key", import.meta.url).pathname,
    pumpPortalTradeLocalUrl: "https://pumpportal.fun/api/trade-local",
    priorityFeeSol: 0.00005,
    slippagePct: 10,
    // ENTRY LATENCY (owner #3: entry <5s). Launches arrive in bursts; a fully-serial drain made
    // candidate #5 wait for #1-4's whole gate+open (≈gateDeadline each) → 12-18s to entry. The
    // gate is I/O-bound (RPC awaits), so we run up to this many candidates through gate+open
    // CONCURRENTLY. Bounded so we never blow the RPC budget. Combined with a smaller settle this
    // brings first-entry to ~3-4s. Env-overridable.
    maxConcurrentGate: Number(process.env.MAX_CONCURRENT_GATE ?? 6),
    // #2: skip a paper entry when mainnet tx-sim proves it REVERTS (honeypot/would-fail).
    // Independent of wallet funding — a would-fail is a real reject. Off by default so we
    // observe first; turn on (SKIP_WOULD_FAIL=true) once the sim path is trusted.
    skipWouldFail: process.env.SKIP_WOULD_FAIL === "true",
    // LIVE opt-in: real-money execution is DOUBLE-LOCKED. The web console can only
    // ever reach dry-run/simulate/devnet (control.ts). Actual mainnet spending also
    // requires this out-of-band env flag, which a browser can never set. Both locks
    // must be open. Default: closed.
    liveConfirmed: process.env.LIVE_TRADING_CONFIRMED === "yes",
    /**
     * LIVE BRIDGE — the module that mirrors the paper trader's decisions onto the real
     * chain (execution/live-bridge.ts). It only ever runs when EXEC_MODE=live AND
     * LIVE_TRADING_CONFIRMED=yes, i.e. behind the same double lock as everything else.
     *
     * `sizeSol` is deliberately SEPARATE from paperTradeSizeSol: the paper trader keeps
     * running its own (larger) size for measurement continuity while real money goes out
     * in a much smaller clip. It is additionally clamped to guard.maxPerTradeSol.
     */
    live: {
      sizeSol: Number(process.env.LIVE_TRADE_SIZE_SOL ?? 0.02),
      /**
       * COMPOUNDING. Off by default, and that default is a risk decision rather than a
       * convenience one: compounding multiplies whatever edge exists, INCLUDING a negative one.
       * A fixed clip loses linearly; a compounding clip that is wrong about its edge loses
       * faster on the way down than it gained on the way up. Turn it on once live EV is
       * established, not before.
       *
       * Sizes off the REAL on-chain balance (the bridge's post-transaction snapshot), never off
       * the paper float — the paper trader runs a notional 2 SOL and would size ~8x too large.
       * It scales DOWN as well as up, which is the honest half of the same rule.
       */
      compound: process.env.LIVE_COMPOUND === "true",
      riskPct: Number(process.env.LIVE_RISK_PCT ?? 5),
      // Floor so a drawdown cannot shrink the clip into dust that no longer clears fees, and
      // so a single bad streak does not silently stop the bot from trading at all.
      minSol: Number(process.env.LIVE_MIN_SOL ?? 0.005),
      // Reconcile the on-chain balance against our own post-transaction snapshot. Any
      // unexplained move between our transactions → HALT (drainer / unknown spend / a
      // timed-out tx that landed after we gave up on it).
      reconcileMs: Number(process.env.LIVE_RECONCILE_MS ?? 60_000),
      // Sweep: sell any real bag whose paper position is already gone, retry stuck sells,
      // and reclaim ATA rent. This is what makes a timed-out buy safe — a bag that lands
      // after we stopped waiting is found and liquidated instead of sitting untracked.
      sweepMs: Number(process.env.LIVE_SWEEP_MS ?? 45_000),
      // How long to keep polling for tokens after a buy whose confirmation timed out.
      // A timeout is NOT a failure — the tx may still land. Never assume "no position".
      buySettleMs: Number(process.env.LIVE_BUY_SETTLE_MS ?? 180_000),
      // Reclaim the ~0.00204 SOL ATA rent after a bag is fully sold. At a 0.02 SOL clip
      // that rent is ~10% of the stake — leaving it on the table would make live P&L
      // diverge from the paper model, which books the reclaim.
      closeAta: process.env.LIVE_CLOSE_ATA !== "false",
      // Consecutive failed sells on one lot before the kill switch trips. A bag we cannot
      // sell is the one failure mode that turns a bounded loss into an unbounded one.
      maxSellFailures: Number(process.env.LIVE_MAX_SELL_FAILURES ?? 6),
    },
    // GUARDIAN caps — the blast-radius limits on real money. Deliberately tiny;
    // raise only once the live edge is proven. Every real spend is gated by these
    // (execution/guardian.ts), fail-closed, and persisted so a crash can't reset them.
    guard: {
      maxPerTradeSol: Number(process.env.MAX_PER_TRADE_SOL ?? 0.05), // hard cap on any single buy
      maxDeployedSol: Number(process.env.MAX_DEPLOYED_SOL ?? 0.3), // max SOL live in open positions at once
      maxDailySpendSol: Number(process.env.MAX_DAILY_SPEND_SOL ?? 0.5), // rolling-24h spend circuit breaker
      feeReserveSol: 0.01, // always leave this in the wallet for tx fees — never spend it
      reconcileToleranceSol: 0.02, // internal ledger vs on-chain drift beyond this → auto-HALT
    },
  },

  // ACTOR/CLUSTER memory thresholds (probabilistic, not permanent-blacklist).
  actorMemory: {
    serialLaunchMin: 3, // need ≥ this many launches before "serial rugger" applies
    serialRugRate: 0.6, // rug+abandon rate ≥ this → serial-rugger evidence
    fastDevSellSec: 90, // median dev-sell faster than this = DEV_FAST_SELLER
    confidentSample: 20, // sample size at which confidence ≈ 1
    toxicRiskProb: 0.7, // riskProbability ≥ this (with confidence) → hard-skip
    toxicConfidence: 0.4, // only hard-skip on actor risk when confidence ≥ this
    halfLifeDays: 14, // reputation confidence decays with a ~2-week half-life (no permanent blacklist)
  },
  // EXPOSURE cap: max concurrent open positions sharing one creator/funder cluster.
  maxPerActorCluster: 2,
  // COUNTERFACTUAL observatory: follow ALL launches (bought or not) → the shadow dataset.
  observatory: {
    enabled: process.env.OBSERVATORY !== "false",
    sampleMs: 3_000, maxWatch: 200, maxAgeSec: 3_600, maxSamplesPerLaunch: 12,
    rapidRugSec: 120, // drained within this = "rapid-rug" (explicit outcome, not dropped)
    // COUNTERFACTUAL: classify launches we DIDN'T enter too (for a real setup-vs-blind shadow).
    classifyAll: process.env.CLASSIFY_ALL !== "false",
    maxClassifyPerTick: 3, // rate limit — at most this many enrichment-classifications per 3s tick
    minClassifyAgeSec: 5, // only classify launches that survived the first few seconds (worth the RPC)
  },
  // SETUP classifier thresholds + whether to snipe UNKNOWN setups.
  setupFilter: {
    hardBundlerPct: 40, // bundler holds >this% of supply (valid sample) = TOXIC
    snipeUnknown: true, // enter on UNKNOWN (data missing) too — small size, bounded loss (owner: many shots). Set false to require CLEAN.
    gateDeadlineMs: 2_500, // FAST gate: enrichment runs in parallel, only what finishes in this window is used; the rest = UNKNOWN. Keeps entry a sniper, not a wait.
    sameSlotBundleMax: 5, // ≥ this many buys in ONE slot at launch = coordinated bundle → TOXIC
  },

  // Env-overridable so a TEST RUN CAN NEVER TOUCH PRODUCTION STATE. The live-bridge selftest
  // used to stash/restore the real control.json, guard.json and live-lots.json of a RUNNING
  // bot — a window in which the bot reads whatever the test happened to write. For a file that
  // decides whether real money is spent, "we put it back afterwards" is not isolation.
  logDir: process.env.LOG_DIR?.trim() || new URL("../logs/", import.meta.url).pathname,

  // FROZEN strategy tag for the clean experiment (#6). Bump this whenever entry/exit
  // logic changes materially — runs with different tags must NOT be pooled as one
  // backtest. v5 = v4 + EXECUTABLE-proceeds trailing HWM (trails from what we could really
  // sell, not the marginal spot peak) + curve-size cap on BOTH fixed & compound + real
  // reserves + executable-lifecycle tagging + graduation flagged UNVERIFIED.
  // v12 retires unverified-bundle hard skips, separates BUY failure from sell impossibility,
  // and makes late predictive toxicity telemetry-only. It is a measurement-correctness cohort,
  // not a claim that the strategy is profitable.
  strategyVersion: "v12-measurement-correctness",
  // ENTRY PARADIGM. "setup" (default) = SNIPER: enter early on launch, gated by SETUP
  // (structural safety + rug-cluster + dev lineage), momentum is telemetry only. "momentum"
  // = legacy indicator-wait (kept only for the shadow comparison). Owner: memecoin ≠ futures,
  // don't wait for indicators to confirm — you just overpay on the bonding curve.
  entryMode: (process.env.ENTRY_MODE?.trim() as "setup" | "momentum") || "setup",
} as const;

// COMPLETE CONFIG HASH — a fingerprint of EVERY material strategy param PLUS a code
// fingerprint. Stamped on every record so two different strategies/code states can NEVER
// share a hash. This is what makes RESETTING UNNECESSARY: never wipe data — just tag it and
// filter analytics by hash. Version numbers are vanity; the hash is the real identity.
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) & 0xffffffff;
  return (h >>> 0).toString(36).slice(0, 7);
}
// Code fingerprint: hash the SOURCE of the files that define trading behaviour, so a bug
// fix / logic edit changes the hash automatically (no manual version bump, no reset).
function codeFingerprint(): string {
  try {
    const base = new URL(".", import.meta.url).pathname;
    const files = [
      // Renamed 2026-08-22: "trader" was never a simulator, it is the strategy engine.
      // This list is BY NAME, so a rename that forgets it makes the fingerprint silently stop
      // watching the very file whose changes must fork a cohort.
      "config.ts", "trader.ts", "gate.ts", "index.ts", "control.ts",
      "discovery/pumpportal.ts", "discovery/bitquery.ts", "discovery/momentum.ts",
      "discovery/setup-filter.ts", "discovery/launch-observatory.ts", "discovery/devwatch.ts",
      "discovery/tradestream.ts", "discovery/narrative.ts",
      "memory/actor-memory.ts",
      "safety/onchain.ts", "safety/pump-holders.ts", "safety/pump-trades.ts",
      "safety/pump-candles.ts", "safety/rugcheck.ts", "safety/metadata.ts", "safety/jupiter-token.ts",
      "execution/executor.ts", "execution/semantics.ts", "execution/jupiter.ts",
      "execution/feeling-agent.ts", "execution/guardian.ts", "execution/wallet.ts",
      // Added with the live path: live-bridge feeds the REAL fill back into the position, so its
      // logic changes what the strategy does — not merely how an order is sent.
      "execution/live-bridge.ts", "execution/rpc.ts", "execution/keystore.ts",
      "execution/curve-math.ts",
      "experiments/arm-spec.ts", "experiments/arm-admission.ts",
      "experiments/arm-ledger.ts", "experiments/arm-exit.ts", "experiments/arm-coordinator.ts",
      // Audit fix (2026-07-29, re-audit): the strategy2Paper/strategy2Scout/strategy2NewScout
      // CONFIG blocks were added to the hash material above, but this file list — which is what
      // makes a LOGIC change (not just a config value) auto-bump the hash — still had zero
      // Strategy 2 files. Today's actual bug fixes (exposure cap, MAX_HOLD-on-stale-mark, atomic
      // writes, etc.) changed real behavior without touching a single config value, so without
      // this the hash wouldn't have moved on its own — only the manual strategy2Epoch bump did.
      "discovery/strategy2-scout.ts", "discovery/strategy2-papertrader.ts",
      "discovery/strategy2-outcome-tracker.ts", "discovery/token-market.ts",
    ];
    let acc = "";
    for (const f of files) { try { acc += readFileSync(join(base, f), "utf8"); } catch { /* skip */ } }
    return djb2(acc);
  } catch { return "nocode"; }
}
const { url: _feelingUrl, key: _feelingKey, ..._feelingMaterial } = config.feeling;
const {
  devnetRpc: _devnetRpc,
  keyFile: _keyFile,
  pumpPortalTradeLocalUrl: _tradeLocalUrl,
  liveConfirmed: _liveConfirmed,
  // `live` is excluded for the SAME reason `liveConfirmed` is: it cannot change a single paper
  // decision. The live bridge mirrors what the paper trader already decided — its clip size,
  // sweep interval and settle window never touch entry, exit or sizing in the model. Leaving it
  // in fragmented cohort 7xk6ol (1,067 trades) on the restart that first enables live, which
  // would have destroyed the comparison at exactly the moment it mattered most.
  live: _liveBridgeMaterial,
  ..._execMaterial
} = config.exec;
void _liveBridgeMaterial;
const _cfgMaterial = JSON.stringify({
  measurementEpoch: config.measurementEpoch,
  strategyVersion: config.strategyVersion,
  mode: config.mode,
  entryMode: config.entryMode,
  risk: config.risk,
  gate: config.gate,
  checkpoint: config.checkpoint,
  momentum: config.momentum,
  jup: config.jup,
  pumpHolders: config.pumpHolders,
  pumpTrades: config.pumpTrades,
  pumpCandles: config.pumpCandles,
  dev: config.dev,
  feeling: _feelingMaterial,
  exec: _execMaterial,
  setupFilter: config.setupFilter,
  actorMemory: config.actorMemory,
  maxPerActorCluster: config.maxPerActorCluster,
  autoReset: config.autoReset,
  observatory: config.observatory,
  postExit: config.postExit,
  limits: config.limits,
  bitquery: {
    enabled: config.bitquery.enabled,
    launchpads: config.bitquery.launchpads,
    confirm: config.bitquery.confirm,
    pruneMs: config.bitquery.pruneMs,
    maxTracked: config.bitquery.maxTracked,
  },
  settleMs: process.env.SNIPE_SETTLE_MS ?? "1500",
  // Audit fix (2026-07-29): configHash was completely blind to every Strategy 2 parameter —
  // verified live: STRATEGY2_TRAIL_PCT=8 and =20 hashed identically. strategy2Epoch (bumped
  // manually on every material Strategy 2 change this session) was the ONLY thing actually
  // isolating cohorts; this makes `cfg` tell the truth too, independent of remembering to bump
  // the epoch by hand.
  // Booking policy is material: the same trades under EXEC_REALISM produce a different
  // ledger, so rows either side of this flag must never be pooled.
  execRealism: config.risk.execRealism,
  // Admission berubah per-arm: baris LO dan HI tidak boleh dianggap satu populasi
  // dengan baris dari run tanpa A/B.
  entryMcAb: config.gate.entryMcAb,
  strategy2Scout: config.strategy2Scout,
  strategy2NewScout: config.strategy2NewScout,
  strategy2Paper: config.strategy2Paper,
});
export const codeHash = codeFingerprint();
// Full identity = material config + code fingerprint. Changes on ANY material edit → records
// self-isolate, so we run ONE continuous stream forever and compare by filtering this hash.
export const configHash = djb2(_cfgMaterial + "|" + codeHash);
