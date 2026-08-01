import { config } from "./config.js";
import { authorityChecks, holderConcentration, totalSupplyUi, detectLaunchBundle, creatorFunders, launchBundleProbe, cachedCreatorFunders } from "./safety/onchain.js";
import { rugcheckEnrichment } from "./safety/rugcheck.js";
import { tokenMetadata } from "./safety/metadata.js";
import { jupiterTokenIntel } from "./safety/jupiter-token.js";
import { pumpTopHolders } from "./safety/pump-holders.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, GateCheck, GateResult } from "./types.js";

/**
 * Gate #2.5 (RESEARCH.md §6): local deployer-reputation cache. Serial rug
 * deployers dominate launches (~1% of creators = 50% of launches); once a
 * creator's token fails the gate hard, future launches from the same wallet
 * are rejected instantly.
 */
const repPath = join(config.logDir, "deployer-reputation.json");
const badDeployers = new Set<string>(
  existsSync(repPath) ? (JSON.parse(readFileSync(repPath, "utf8")) as string[]) : [],
);

/**
 * Gate failures that are genuinely a property of the CREATOR and damning enough to justify
 * refusing every future launch from that wallet.
 *
 * This list exists because the blacklist used to be triggered by ANY hard failure except two
 * RPC-error names — which meant a creator was banned forever because that one coin happened to be
 * priced above our MC ceiling (`snipe-mc-ceiling`), or because a seconds-old token had thin holder
 * data (`top10-concentration`, `single-holder`, `holder-data`), or because Jupiter had not indexed
 * its liquidity yet (`jup-liq-mc-ratio`). None of those say anything about the person. Across the
 * archived cohorts `deployer-reputation` became the single biggest reject reason at 9,746 hits, a
 * permanently growing list seeded largely by transient market conditions.
 */
const BLACKLIST_WORTHY = new Set([
  "mint-authority-renounced",   // kept the ability to print more supply — a deliberate dev choice
  "freeze-authority-renounced", // kept the ability to freeze holders — same
  "rugcheck-rugged-flag",       // the token is confirmed rugged
  "jup-serial-deployer",        // this wallet has minted hundreds of tokens
  "rug-cluster-dev",            // the dev directly funded their own early buyers
  "pump-dev-holdings",          // an extreme dev bag on a trusted sample
  "sell-simulation",            // the sell reverts — honeypot
]);

/** Should this set of failed hard checks ban the creator for good? */
export function shouldBlacklist(failedCheckNames: string[]): boolean {
  return failedCheckNames.some((n) => BLACKLIST_WORTHY.has(n));
}

export function markBadDeployer(creator: string | undefined): void {
  if (!creator || badDeployers.has(creator)) return;
  badDeployers.add(creator);
  writeFileSync(repPath, JSON.stringify([...badDeployers], null, 2));
}

function marketChecks(c: Candidate): GateCheck[] {
  // Fast-follow (snipe): hard ceiling on entry marketcap (in SOL) so we only
  // buy fresh/small bonding-curve tokens, never something already pumped.
  if (c.mode === "fast-follow") {
    if (c.marketCapSol === undefined) return [];
    return [
      {
        name: "snipe-mc-ceiling",
        passed: c.marketCapSol <= config.gate.snipeMaxEntryMcSol,
        hard: true,
        detail: `entry MC ${c.marketCapSol.toFixed(1)} SOL (max ${config.gate.snipeMaxEntryMcSol} SOL)`,
      },
    ];
  }

  return []; // non-fast-follow has no market checks (swing lane removed)
}

/**
 * Score = base safety score + community-momentum bonuses. Memecoins pay off
 * asymmetrically, so we reward the "small MC + real crowd forming" profile that
 * can run 10-100x, rather than mature/stable metrics.
 */
function scoreOf(checks: GateCheck[], c: Candidate): number {
  let score = 50;
  // COMPONENT LEDGER. Measured 2026-07-26: rawScore is INVERSELY related to outcome — the
  // 48-52 bucket (base 50, i.e. almost no bonus fired) wins 39% at -2.1% expectancy, while
  // the 62+ bucket wins 18% at -21.4%. The more this function likes a coin, the worse it does.
  // We could not diagnose WHICH bonus is responsible because none of them were recorded, so
  // every contribution is now stamped on the candidate and logged at entry. Diagnosis first,
  // re-weighting second — reweighting blind would just be curve-fitting.
  const parts: Record<string, number> = {};
  const add = (name: string, n: number) => { if (n) { score += n; parts[name] = Number(((parts[name] ?? 0) + n).toFixed(2)); } };
  // Generic soft-check contribution. Exclude checks scored explicitly below (no double-
  // count) AND checks that represent UNAVAILABLE/NEUTRAL data — a check that only "passed"
  // because the API was down must NOT earn +8 (availability bias: missing data rewarded as
  // if it were good). Those contribute 0 (neutral), per the audit.
  const scoredExplicitly = new Set(["metadata-immutable", "jup-organic-score", "jup-wash-trade", "pump-snipers", "pump-bundlers", "pump-dev-holdings", "pump-top10"]);
  const isNeutral = (name: string): boolean => name.endsWith("-unavailable") || name.endsWith("-skipped") || name.endsWith("-na");
  for (const chk of checks) {
    if (chk.hard || scoredExplicitly.has(chk.name) || isNeutral(chk.name)) continue;
    add(`check:${chk.name}`, chk.passed ? 8 : -8);
  }

  // Buy demand (crowd buying harder than selling)
  if (c.buys1h && c.sells1h) {
    const ratio = c.buys1h / Math.max(1, c.sells1h);
    if (ratio >= config.momentum.strongBuyRatio) add("buyRatioStrong", 12);
    add("buyRatioSlope", Math.min(10, (ratio - 1) * 6));
  }
  if ((c.buys1h ?? 0) >= config.momentum.heavyBuyCount1h) add("heavyBuys1h", 8); // large crowd

  // Small-marketcap sweet spot = most upside room
  if (c.marketCapUsd !== undefined && c.marketCapUsd <= config.gate.sweetSpotMcUsd) add("mcSweetSpot", 12);

  // Immutable metadata = dev can't bait-and-switch (soft positive)
  const immutable = checks.find((k) => k.name === "metadata-immutable");
  if (immutable) add("immutableMeta", immutable.passed ? 6 : -10);

  // Jupiter organic score: healthy organic activity boosts, wash-trade penalises.
  if (c.organicScore !== undefined) {
    if (c.organicScore >= config.jup.goodOrganicScore) add("organicScore", 10);
    else if (c.organicScore < config.jup.minOrganicScore) add("organicScoreLow", -8);
  }
  if (checks.find((k) => k.name === "jup-wash-trade")) add("washTrade", -12); // circular/wash pattern

  // pump.fun whale-quality (app metrics): sniper/bundler presence below the HARD kill
  // still penalises; a clean table (no snipers/bundlers) earns a small bonus.
  const top10 = checks.find((k) => k.name === "pump-top10");
  if (top10) add("top10Concentration", top10.passed ? 4 : -8); // concentrated top-10 = soft negative
  if (c.whaleManipPct !== undefined) {
    if (c.whaleManipPct >= 5) add("whaleManip", -10); // snipers/bundlers hold a meaningful chunk
    else if (c.whaleManipPct === 0) add("noWhaleManip", 6); // no snipers/bundlers = organic
  }

  // Community signals
  if (c.hasSocials) add("hasSocials", 6); // has socials/website (soft — gameable)
  if ((c.holders ?? 0) >= config.momentum.minHoldersForBonus) add("holderBase", 10); // real holder base

  // Distribution: small MC + many holders. holders per $10k of marketcap —
  // the higher, the more organic/distributed the crowd (owner's win indicator).
  if (c.holders && c.marketCapUsd && c.marketCapUsd > 0) {
    const holdersPerMc10k = c.holders / (c.marketCapUsd / 10_000);
    const bonus = Math.min(18, (holdersPerMc10k / config.momentum.holdersPerMc10kStrong) * 12);
    add("holdersPerMc", bonus);
  }

  // Keep the 0-100 clamp for the PASS threshold semantics, but also stash the UNCAPPED
  // raw score on the candidate — a saturating 100 can't tell a very-good coin from an
  // exceptional one, so ranking/pattern-memory use rawScore to differentiate (audit #5).
  c.rawScore = Math.round(score);
  c.scoreParts = parts; // per-bonus ledger — the only way to find WHICH one is inverted
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Run the layered gate, fast → slow, fail fast (CONCEPT.md D4). */
/**
 * Race a call against a deadline; returns null if the deadline wins (used for the fast gate).
 *
 * GHOST-REQUEST FIX (2026-07-28): this used to take an ALREADY-STARTED promise and Promise.race
 * it against a timer — the loser (usually the RPC/HTTP call itself, not the timer) kept running
 * in the background for its own full timeout + retries regardless, silently holding one of only
 * 4 concurrent RPC slots for up to ~21s after the gate had already moved on without it. Measured
 * live: RPC queueDepth 105, all 4 slots in-flight, P95 latency 7.7s, while the actual candidate
 * rate-cap (8rps) was barely used (1.1rps) — the slots were closed by stale work, not real load.
 * Now takes a FACTORY so a real AbortController can be created and its signal handed to the
 * callee from the very first attempt, threaded down to the actual fetch()/RPC call (see
 * fetchJson's `signal` option and onchain.ts's `rpc()`) — the loser actually stops.
 */
function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  // THE DEADLINE HAS TO BE A REAL CEILING, NOT A REQUEST (2026-07-31).
  //
  // The ghost-request fix above was right to hand the callee an AbortSignal, but in removing the
  // old Promise.race it also removed the only thing that actually BOUNDED the wait. What was left
  // just fired `ctrl.abort()` and then waited for `fn` to settle on its own — and an abort is a
  // request, not a guarantee. Any callee with internal retries, or one that never threads the
  // signal down to its real fetch, keeps the gate waiting for as long as it likes.
  //
  // Measured on the 24 real entries: `gateDeadlineMs` is 2,500 but observed gate time ran to
  // 82,913ms — 33x the supposed ceiling, with 5 of 24 over 15s. With only `maxConcurrentGate` (6)
  // workers, one 83-second gate holds a sixth of the entry capacity hostage, and everything behind
  // it queues. That is what put `preMs` (settle + queue wait) at a median of 16.6s against a 1.5s
  // settle, and it is bimodal exactly as head-of-line blocking predicts: five entries got in at
  // ~1,500ms while the rest waited 8-46s. Arrival rate was never the problem — capacity is ~35
  // candidates/min against a median 18, and only 0.9% of minutes exceed it.
  //
  // Latency here is not a tidiness concern. Measured independently against 378 live launches,
  // entering 60s late instead of at launch cuts the chance of a +43% move from 16.1% to 2.8%.
  //
  // So: race, AND abort. The race guarantees the caller is never blocked past `ms`; the abort
  // still tells the loser to stop, so the ghost-request fix keeps working. Both properties, which
  // is what this function was always meant to have.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve(null); }, ms);
  });
  return Promise.race([fn(ctrl.signal).catch(() => null), deadline])
    .finally(() => clearTimeout(timer));
}

/**
 * FAST SETUP GATE (sniper): ALL enrichment runs in ONE PARALLEL wave against a HARD DEADLINE.
 * Whatever finished by the deadline enriches the candidate; the rest stays UNKNOWN (the setup
 * classifier handles missing data). This is what makes entry fast — no summing sequential timeouts.
 *
 * OWNER #3 (entry <5s): this used to be FOUR sequential deadline-stages (authorities → batch →
 * top-holders → creator-funders) = up to ~10s of gate alone. Now it's ONE wave: the only
 * data-dependent chains — supply→pumpTopHolders and creator→creatorFunders — are `.then` chained
 * INSIDE the same Promise.all so they overlap everything else instead of adding stages. Worst-case
 * gate ≈ the supply→holders chain (2 deadlines), not 4. authorities still hard-reject, just
 * evaluated after the wave resolves (the other calls were already in flight — no time lost).
 */
export async function runSetupGate(c: Candidate): Promise<GateResult> {
  const checks: GateCheck[] = [];
  if (c.creator && badDeployers.has(c.creator)) return { verdict: "REJECT", checks: [{ name: "deployer-reputation", passed: false, hard: true, detail: "known bad deployer" }], score: 0 };
  const dl = config.setupFilter.gateDeadlineMs;

  // ── ONE parallel wave — RPC-LEAN (the latency fix) ──
  // MEASURED: this gate used to spend ~23 RPC per candidate, of which detectLaunchBundle
  // (~15: a signature page + 14 parallel getTransaction) and creatorFunders (4) were the
  // bulk — and BOTH were already re-run in the background after open() anyway. On a free
  // 8 req/s tier that made every candidate cost ~3s of pure budget, so bursts queued for
  // minutes (median detect→entry 490s). The hot path now costs ~3 RPC:
  //   authorityChecks (1) + totalSupplyUi (1) + launchBundleProbe (1)
  // launchBundleProbe derives the same-slot clustering from ONE signature page, so the
  // SAME_SLOT_BUNDLE veto — by far the most-fired toxic verdict — is preserved at entry.
  // Everything below is either an external API (no RPC budget) or resolved from cache.
  const cachedFunders = cachedCreatorFunders(c.creator); // immutable history → free on repeat creators
  const [auth, holdersChain, rc, meta, jup, bundle] = await Promise.all([
    withDeadline((signal) => authorityChecks(c.mint, 400, signal), dl), // short retry: a 5s sleep can never pay off inside a 2.5s deadline
    // supply (RPC) → top-holders (external API) as a chain within the wave
    withDeadline((signal) => totalSupplyUi(c.mint, signal), dl)
      .then((supply) => supply ? withDeadline((signal) => pumpTopHolders(c.mint, supply, signal), dl) : null)
      .catch(() => null),
    withDeadline((signal) => rugcheckEnrichment(c.mint, signal), dl), // external API
    withDeadline((signal) => tokenMetadata(c.mint, signal), dl),      // external API + 1 uncounted RPC
    withDeadline((signal) => jupiterTokenIntel(c.mint, signal), dl),  // external API
    withDeadline((signal) => launchBundleProbe(c.mint, undefined, signal), dl),  // 1 RPC; usually misses the deadline (see types.ts bundleProbe note)
  ]);
  if (cachedFunders) c.creatorFunders = cachedFunders;

  // authorities (the one FAST hard structural check). FAIL-CLOSED on timeout (audit fix): a timed-out
  // read means we DON'T know it's safe → flag missing so the classifier treats it as UNKNOWN.
  if (auth) {
    checks.push(...auth);
    const bad = checks.filter((k) => k.hard && !k.passed).map((k) => k.name);
    if (bad.length) { if (shouldBlacklist(bad)) markBadDeployer(c.creator); return { verdict: "REJECT", checks, score: 0 }; }
  }
  else c.authorityUnknown = true;

  if (bundle) c.launchBundle = bundle;
  if (rc) {
    checks.push(...rc.checks); if (rc.holders !== undefined) c.holders = rc.holders; if (!c.creator && rc.creator) c.creator = rc.creator;
    // A proven RUGGED flag is a hard reject even on the fast path.
    if (rc.checks.some((k) => k.name === "rugcheck-rugged-flag" && !k.passed)) { markBadDeployer(c.creator); return { verdict: "REJECT", checks, score: 0 }; } // rugged IS creator evidence
  }
  if (meta?.hasSocials) c.hasSocials = true;
  if (meta?.image) c.image = meta.image;
  if (jup) { if (jup.holderCount !== undefined) c.holders = jup.holderCount; if (jup.mcapUsd !== undefined && c.marketCapUsd === undefined) c.marketCapUsd = jup.mcapUsd; }
  const wh = holdersChain;
  if (wh) {
    c.whaleSniperPct = wh.sniperPct; c.whaleBundlerPct = wh.bundlerPct; c.whaleDevPct = wh.devPct; c.whaleTop10Pct = wh.top10Pct;
    c.rugCluster = wh.cluster; c.fundingParents = wh.fundingParents; c.holdersSample = wh.sample;
  }
  c.metaHash = c.symbol || c.name ? `${(c.name ?? "").toLowerCase()}|${(c.symbol ?? "").toLowerCase()}` : undefined;
  // CREATOR funding lineage (actor memory — NOT early-buyer funders). Only used here when it is
  // already CACHED from a previous launch by the same creator (free). A cold read costs 4 RPC and
  // is deferred to the background enrichment in open(), which is where actor memory reads it from
  // anyway. Cost: the ACTOR_RISK veto (0.5% of candidates) now lands post-entry instead of pre-.
  if (!c.creatorFunders?.length) { const late = cachedCreatorFunders(c.creator); if (late) c.creatorFunders = late; }
  // The setup classifier (in open()) makes the actual TOXIC/CLEAN/UNKNOWN decision. Gate just
  // enriches fast and passes structural — reject only on a proven hard structural failure.
  return { verdict: "PASS", checks, score: scoreOf(checks, c) };
}

export async function runGate(c: Candidate): Promise<GateResult> {
  const checks: GateCheck[] = [];

  // Gate #0: deployer reputation (instant, local)
  if (c.creator && badDeployers.has(c.creator)) {
    checks.push({
      name: "deployer-reputation",
      passed: false,
      hard: true,
      detail: `creator ${c.creator} previously failed the gate`,
    });
    return { verdict: "REJECT", checks, score: 0 };
  }

  // Gate #1: on-chain authorities
  try {
    checks.push(...(await authorityChecks(c.mint)));
  } catch (err) {
    checks.push({ name: "authority-rpc", passed: false, hard: true, detail: (err as Error).message });
  }
  if (checks.some((k) => k.hard && !k.passed)) return { verdict: "REJECT", checks, score: 0 };

  // Gate #2: holder concentration
  let supply: number | null = null;
  try {
    supply = await totalSupplyUi(c.mint);
    checks.push(...(await holderConcentration(c.mint, supply)));
  } catch (err) {
    checks.push({ name: "holders-rpc", passed: false, hard: false, detail: (err as Error).message });
  }
  if (checks.some((k) => k.hard && !k.passed)) return { verdict: "REJECT", checks, score: 0 };

  // Swing-only market-quality checks (DexScreener data)
  checks.push(...marketChecks(c));
  if (checks.some((k) => k.hard && !k.passed)) return { verdict: "REJECT", checks, score: 0 };

  // Gate #3: RugCheck enrichment (best-effort, short timeout, never blocks).
  // Also feeds holder count into the community-momentum score.
  const rc = await rugcheckEnrichment(c.mint);
  checks.push(...rc.checks);
  if (rc.holders !== undefined) c.holders = rc.holders;
  if (!c.creator && rc.creator) c.creator = rc.creator; // dev wallet for buy-back/dump tracking
  if (checks.some((k) => k.hard && !k.passed)) return { verdict: "REJECT", checks, score: 0 };

  // Gate #3.5: on-chain metadata (soft signals from reference-bot dissection).
  // Mutable metadata = dev can bait-and-switch the token; on-chain socials give
  // fast-follow tokens a community signal DexScreener doesn't have yet.
  const meta = await tokenMetadata(c.mint);
  if (meta) {
    checks.push({
      name: "metadata-immutable",
      passed: !meta.isMutable,
      hard: false,
      detail: meta.isMutable ? "metadata is MUTABLE (dev can change name/image/socials)" : "metadata immutable",
    });
    if (meta.hasSocials) c.hasSocials = true; // enrich fast-follow, which lacks DexScreener socials
    if (meta.image) c.image = meta.image;
  }

  // Gate #4: Jupiter token intelligence (free; works on brand-new tokens).
  // Delivers the on-chain-forensics signals: wash-trade defense, bundled dev-buy,
  // serial-deployer, liquidity/marketcap ratio, holder count.
  const jup = await jupiterTokenIntel(c.mint);
  if (jup) {
    if (jup.holderCount !== undefined) c.holders = jup.holderCount; // more accurate than RugCheck
    if (jup.mcapUsd !== undefined && c.marketCapUsd === undefined) c.marketCapUsd = jup.mcapUsd;
    // HARD: serial deployer / rugger (dev minted a huge number of tokens)
    if (jup.devMints !== undefined) {
      checks.push({
        name: "jup-serial-deployer",
        passed: jup.devMints <= config.jup.serialDeployerMints,
        hard: true,
        detail: `dev has minted ${jup.devMints} tokens (max ${config.jup.serialDeployerMints})`,
      });
    }
    // HARD: dev still holds too much supply (bundled dev-buy)
    if (jup.devBalancePct !== undefined) {
      checks.push({
        name: "jup-dev-balance",
        passed: jup.devBalancePct <= config.jup.maxDevBalancePct,
        hard: true,
        detail: `dev holds ${jup.devBalancePct.toFixed(1)}% (max ${config.jup.maxDevBalancePct}%)`,
      });
    }
    // HARD: liquidity too thin vs marketcap (slippage-bomb) — only once liquidity exists
    if (jup.liqToMcRatio !== undefined && (jup.liquidityUsd ?? 0) > 0) {
      checks.push({
        name: "jup-liq-mc-ratio",
        passed: jup.liqToMcRatio >= config.jup.minLiqToMcRatio,
        hard: true,
        detail: `liq/MC ${(jup.liqToMcRatio * 100).toFixed(0)}% (min ${config.jup.minLiqToMcRatio * 100}%)`,
      });
    }
    // SOFT: wash-trade micro-bundle (txns without unique traders)
    if (jup.washSignal) {
      checks.push({ name: "jup-wash-trade", passed: false, hard: false, detail: "5m: many txns, ~1 unique trader (wash/circular)" });
    }
    // SOFT: organic score (fake-volume defense)
    if (jup.organicScore !== undefined) {
      c.organicScore = jup.organicScore;
      checks.push({
        name: "jup-organic-score",
        passed: jup.organicScore >= config.jup.minOrganicScore,
        hard: false,
        detail: `organic ${jup.organicScore.toFixed(0)}/100`,
      });
    }
    if (checks.some((k) => k.hard && !k.passed)) {
      if (shouldBlacklist(checks.filter((k) => k.hard && !k.passed).map((k) => k.name))) markBadDeployer(c.creator);
      return { verdict: "REJECT", checks, score: 0 };
    }
  }

  // Gate #5: pump.fun top-holders — the same metrics the pump.fun app shows (snipers
  // %, bundlers %, dev %, top-10 %), as % of supply. These are NOT rigid kill-lines:
  // every coin is different (heavy snipers can still run if a real crowd absorbs them;
  // thin snipers can still rug). So they are SOFT — they colour the score and, above
  // all, are handed to the Feeling Agent to READ in context (metric × real buy-tape ×
  // crowd), not to auto-reject. Only a genuinely EXTREME dev bag stays a hard backstop.
  const wh = await pumpTopHolders(c.mint, supply ?? undefined);
  if (wh) {
    c.whaleSniperPct = wh.sniperPct;
    c.whaleBundlerPct = wh.bundlerPct;
    c.whaleDevPct = wh.devPct;
    c.whaleTop10Pct = wh.top10Pct;
    c.whaleManipPct = Math.max(wh.sniperPct, wh.bundlerPct);
    c.whaleTop5Pct = wh.top10Pct;
    c.rugCluster = wh.cluster; // RUG-CLUSTER signal onto the candidate (agent reads it in context)
    c.fundingParents = wh.fundingParents; // funding lineage → actor memory + setup filter
    c.holdersSample = wh.sample; // sample confidence for the setup classifier
    c.metaHash = c.symbol || c.name ? `${(c.name ?? "").toLowerCase()}|${(c.symbol ?? "").toLowerCase()}` : undefined; // reused-metadata detection
    const soft = (name: string, ok: boolean, detail: string) => checks.push({ name, passed: ok, hard: false, detail });
    soft("pump-snipers", wh.sniperPct <= config.pumpHolders.maxSniperPct, `snipers ${wh.sniperPct.toFixed(1)}% of supply (app red >${config.pumpHolders.maxSniperPct}%, sample ${wh.sample})`);
    soft("pump-bundlers", wh.bundlerPct <= config.pumpHolders.maxBundlerPct, `bundlers ${wh.bundlerPct.toFixed(1)}% (app red >${config.pumpHolders.maxBundlerPct}%)`);
    soft("pump-top10", wh.top10Pct <= config.pumpHolders.maxTop10Pct, `top-10 ${wh.top10Pct.toFixed(0)}% (app red >${config.pumpHolders.maxTop10Pct}%)`);
    // RUG-CLUSTER: "beda wallet, 1 pendana" = coordinated dump setup (soft signal + score).
    soft("rug-cluster", !wh.cluster.coordinated, wh.cluster.coordinated
      ? `COORDINATED: ${wh.cluster.clusterWallets} wallets from 1 funder hold ${wh.cluster.clusterPct}%${wh.cluster.devFundedBuyers ? `, dev funded ${wh.cluster.devFundedBuyers} buyers` : ""}`
      : `funding independent (diversity ${wh.cluster.fundingDiversity})`);
    // HARD backstop: a DEV directly funding ≥ hardDevFundedBuyers early buyers = manufactured
    // demand from the deployer — the strongest organized-rug tell. Only when sample is trusted.
    if (wh.sample >= config.pumpHolders.minSample && wh.cluster.devFundedBuyers >= config.pumpHolders.hardDevFundedBuyers) {
      checks.push({ name: "rug-cluster-dev", passed: false, hard: true, detail: `dev wallet funded ${wh.cluster.devFundedBuyers} early buyers (manufactured demand → rug setup)` });
    }
    // The one HARD backstop: a genuinely extreme dev bag = rug fuel, and only when the
    // sample is trustworthy. Everything else is judgment, not a gate.
    const trusted = wh.sample >= config.pumpHolders.minSample;
    checks.push({
      name: "pump-dev-holdings",
      passed: !(trusted && wh.devPct > config.pumpHolders.hardDevPct),
      hard: true,
      detail: `dev holds ${wh.devPct.toFixed(1)}% of supply (hard reject >${config.pumpHolders.hardDevPct}%)`,
    });
    if (checks.some((k) => k.hard && !k.passed)) {
      if (shouldBlacklist(checks.filter((k) => k.hard && !k.passed).map((k) => k.name))) markBadDeployer(c.creator);
      return { verdict: "REJECT", checks, score: 0 };
    }
  }

  return { verdict: "PASS", checks, score: scoreOf(checks, c) };
}
