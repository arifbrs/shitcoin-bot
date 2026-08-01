/**
 * STRATEGY-2 CANDIDATE SCOUT — read-only, standalone, zero capital.
 *
 * Owner's spec: mid-cap ($100k-$400k+, "lebih tidak masalah"), many holders, a "mover"
 * (positive recent momentum), already past the ~98% early-death window ("lolos trenches").
 * Deliberately runs as its OWN process, on its OWN timer, writing to its OWN log stream — it
 * shares no state, no RPC budget, and no capital with PaperTrader/the sniper. It cannot affect
 * a single sniper decision.
 *
 * Owner's explicit methodology point: research this CONCURRENTLY with the sniper, not on a
 * separate day — comparing cohorts collected under different market conditions is exactly the
 * confound this whole project has spent a day eliminating for entry-policy arms. Running both
 * on the same wall-clock time is what makes a later comparison valid.
 *
 * "Callout" (social mention volume): LunarCrush requires a paid subscription we do not have
 * (verified 2026-07-26). GMGN's trending feed (added 2026-07-27, verified live against real
 * data) gives a real proxy instead: `renowned_count` (verified-KOL wallets holding),
 * `smart_degen_count` (smart-money wallets holding), `square_mentions` (GMGN's own community
 * feed mention count). Logged as a SEPARATE, parallel source (`source:"gmgn-trending"`) rather
 * than replacing Solana Tracker — the outcome-tracker can later show which source's candidates
 * actually did better, instead of assuming.
 *
 * Every logged row carries `firstSeenAt` (this scout's own clock, not the token's) — the
 * "badge with entry-observation time" the owner asked for. This is a WATCH, not an entry: no
 * position is opened. Building the actual buy/exit logic is a separate, later step once this
 * population is confirmed to behave as expected across real concurrent time.
 *
 * Run: npm run strategy2:scout
 */
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { gmgnEnabled, gmgnTrendingSol, gmgnTrenches, gmgnCreatedTokens } from "./gmgn.js";
import { dexBoostedTokens, dexCommunityTakeovers } from "./dexscreener.js";
import { jupiterTokenIntel, type JupTokenIntel } from "../safety/jupiter-token.js";

/**
 * "Dev belum jual" signal (owner request, 2026-07-29): Jupiter's free token-audit endpoint
 * already gives devBalancePct (% of supply the dev wallet still holds) — a direct read of
 * whether the dev has dumped, not a proxy. Cached per mint for a few minutes so a token seen
 * across multiple sources/polls in that window costs one Jupiter call, not several. Used two
 * ways: as a secondary enrichment on the mid-cap lanes below (devBalancePct/mintRenounced/
 * freezeRenounced only), and as the PRIMARY filter data for the new-launch/dev-holding lane
 * (full JupTokenIntel — holderCount/mcapUsd/liquidityUsd too). Additive only: never gates
 * mid-cap admission, purely logged for later scoring/filtering.
 */
const devSignalCache = new Map<string, { at: number; intel: JupTokenIntel | null }>();
const DEV_SIGNAL_TTL_MS = 5 * 60_000; // short enough that the 5min new-launch lane gets fresh reads
async function devSignal(mint: string): Promise<JupTokenIntel | null> {
  const cached = devSignalCache.get(mint);
  if (cached && Date.now() - cached.at < DEV_SIGNAL_TTL_MS) return cached.intel;
  const intel = await jupiterTokenIntel(mint).catch(() => null);
  devSignalCache.set(mint, { at: Date.now(), intel });
  if (devSignalCache.size > 2_000) {
    const oldest = devSignalCache.keys().next().value;
    if (oldest) devSignalCache.delete(oldest);
  }
  return intel;
}

interface Candidate {
  mint: string; sym: string; mcUsd: number; liqUsd: number; holders: number;
  riskScore: number | null; rugged: boolean | null;
  change1h: number | null; change4h: number | null; change24h: number | null;
  hasSocials: boolean; twitterUrl: string | null; createdAt: number | null;
}

function extractCandidates(rows: unknown[]): Candidate[] {
  const out: Candidate[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const pools = (r.pools as Array<Record<string, unknown>> | undefined) ?? [];
    const pool = pools[0] ?? {};
    const mc = ((pool.marketCap as Record<string, unknown> | undefined)?.usd as number) || 0;
    if (!(mc >= config.strategy2Scout.minMcUsd)) continue; // no upper bound enforced — "lebih tidak masalah"
    const liq = ((pool.liquidity as Record<string, unknown> | undefined)?.usd as number) || 0;
    const token = (r.token as Record<string, unknown> | undefined) ?? {};
    const risk = (r.risk as Record<string, unknown> | undefined) ?? {};
    const events = (r.events as Record<string, { priceChangePercentage?: number }> | undefined) ?? {};
    const socials = (token.strictSocials as Record<string, unknown> | undefined) ?? {};
    const twitterUrl = typeof socials.twitter === "string" ? socials.twitter : null;
    out.push({
      mint: String(token.mint ?? ""),
      sym: String(token.symbol ?? "?"),
      mcUsd: mc,
      liqUsd: liq,
      holders: (r.holders as number) || 0,
      riskScore: (risk.score as number) ?? null,
      rugged: (risk.rugged as boolean) ?? null,
      change1h: events["1h"]?.priceChangePercentage ?? null,
      change4h: events["4h"]?.priceChangePercentage ?? null,
      change24h: events["24h"]?.priceChangePercentage ?? null,
      hasSocials: twitterUrl !== null,
      twitterUrl,
      createdAt: (pool.createdAt as number) ?? null,
    });
  }
  return out.filter((c) => c.mint);
}

// DEXSCREENER FLAGS (audit: dig deep on distinctive signals) — refreshed on the SAME poll cycle,
// read by both poll() and pollGmgn() below rather than each fetching its own copy. May lag up
// to one poll interval behind the absolute latest boost/takeover list — acceptable for a signal
// that's inherently slow-moving (a takeover doesn't reverse within an hour).
let boostedMints = new Set<string>();
let takeoverMints = new Set<string>();
async function refreshDexFlags(): Promise<void> {
  const [boosts, takeovers] = await Promise.all([dexBoostedTokens(), dexCommunityTakeovers()]);
  if (boosts) boostedMints = new Set(boosts.filter((b) => b.chainId === "solana").map((b) => b.tokenAddress));
  if (takeovers) takeoverMints = new Set(takeovers.filter((t) => t.chainId === "solana").map((t) => t.tokenAddress));
  ui.info(`[strategy2-scout] dexscreener flags: ${boostedMints.size} boosted, ${takeoverMints.size} community-takeover (sol)`);
}

async function poll(): Promise<void> {
  const host = config.solTracker.host;
  if (!host) { ui.warn("[strategy2-scout] SOLTRACKER_HOST not set — cannot poll"); return; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`${host}/tokens/trending`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) { ui.warn(`[strategy2-scout] HTTP ${res.status}`); return; }
    const body = (await res.json()) as unknown[] | { data?: unknown[] };
    const rows = Array.isArray(body) ? body : (body.data ?? []);
    const candidates = extractCandidates(rows);
    const now = Date.now();
    for (const c of candidates) {
      const dev = await devSignal(c.mint);
      logRecord("events", {
        type: "strategy2-candidate",
        strategyTag: "strategy2-mid-cap-scout-v1",
        firstSeenAt: now, // this scout's own observation clock — the entry-position "badge" time
        source: "solana-tracker-trending",
        strategy2Epoch: config.strategy2Epoch, cfg: configHash, // stamped for traceability only — NOT part of sniper cohort isolation
        isBoosted: boostedMints.has(c.mint), isCommunityTakeover: takeoverMints.has(c.mint),
        jupDevBalancePct: dev?.devBalancePct ?? null, jupMintRenounced: dev?.mintRenounced ?? null, jupFreezeRenounced: dev?.freezeRenounced ?? null,
        // Audit fix (2026-07-29): "entry confirmation berbasis demand" — raw 5m buy/sell flow
        // from the SAME Jupiter response already being fetched for dev-balance, previously
        // discarded. Logged here so strategy2-papertrader.ts can gate admission on real recent
        // demand, not just static entry-time attributes (holder count, smart-money count).
        jupNetBuyers5m: dev?.netBuyers5m ?? null, jupBuyVolume5m: dev?.buyVolume5m ?? null, jupSellVolume5m: dev?.sellVolume5m ?? null,
        ...c,
      });
    }
    ui.info(`[strategy2-scout] poll: ${rows.length} trending, ${candidates.length} in MC band ($${config.strategy2Scout.minMcUsd.toLocaleString()}+)`);
  } catch (e) {
    ui.warn(`[strategy2-scout] poll failed: ${(e as Error).message}`);
  }
}

/**
 * SECOND, PARALLEL source — GMGN's trending feed with server-side social/smart-money filters.
 * Tagged `source:"gmgn-trending"` so it is never conflated with the Solana Tracker cohort above.
 * Read-only: no swap/order/cooking calls, same as every other function in this file.
 */
async function pollGmgn(): Promise<void> {
  if (!gmgnEnabled) return;
  try {
    const rows = await gmgnTrendingSol("1h", {
      limit: 100,
      filters: ["has_social"],
      order_by: "smart_degen_count",
      direction: "desc",
      min_marketcap: config.strategy2Scout.minMcUsd,
      min_holder_count: 50,
    });
    if (!rows) { ui.warn("[strategy2-scout] gmgn poll: no data (rate-limited, timed out, or disabled)"); return; }
    const now = Date.now();
    const devLookedUp = new Set<string>(); // dedupe within this poll — many rows can share one creator
    for (const r of rows) {
      const dev = await devSignal(r.address);
      logRecord("events", {
        type: "strategy2-candidate",
        strategyTag: "strategy2-mid-cap-scout-v1",
        firstSeenAt: now,
        source: "gmgn-trending",
        strategy2Epoch: config.strategy2Epoch, cfg: configHash,
        mint: r.address, sym: r.symbol, mcUsd: r.market_cap, liqUsd: r.liquidity, holders: r.holder_count,
        riskScore: null, rugged: r.rug_ratio != null ? r.rug_ratio > 0.3 : null, // GMGN's own documented danger threshold (workflow-token-research.md), not a guess
        // FIXED (2026-07-27, review caught this): the query below asks GMGN for the 1h
        // interval, so `price_change_percent` IS the 1h move — it was being stored as
        // change24h, silently mislabeling every gmgn-trending candidate's momentum window.
        change1h: r.price_change_percent ?? null, change4h: null, change24h: null,
        hasSocials: Boolean(r.twitter_username || r.website || r.telegram), twitterUrl: r.twitter_username ?? null,
        createdAt: r.creation_timestamp ?? null,
        isBoosted: boostedMints.has(r.address), isCommunityTakeover: takeoverMints.has(r.address),
        jupDevBalancePct: dev?.devBalancePct ?? null, jupMintRenounced: dev?.mintRenounced ?? null, jupFreezeRenounced: dev?.freezeRenounced ?? null,
        // Audit fix (2026-07-29): "entry confirmation berbasis demand" — raw 5m buy/sell flow
        // from the SAME Jupiter response already being fetched for dev-balance, previously
        // discarded. Logged here so strategy2-papertrader.ts can gate admission on real recent
        // demand, not just static entry-time attributes (holder count, smart-money count).
        jupNetBuyers5m: dev?.netBuyers5m ?? null, jupBuyVolume5m: dev?.buyVolume5m ?? null, jupSellVolume5m: dev?.sellVolume5m ?? null,
        // GMGN-EXCLUSIVE fields (audit: dig deep, don't speculate) — not available from Solana Tracker
        renownedCount: r.renowned_count ?? null, smartDegenCount: r.smart_degen_count ?? null,
        squareMentions: r.square_mentions ?? null, rugRatio: r.rug_ratio ?? null,
        bundlerRate: r.bundler_rate ?? null, sniperCount: r.sniper_count ?? null, isWashTrading: r.is_wash_trading ?? null,
        creator: r.creator ?? null,
      });
      // DEV REPUTATION CROSS-CHECK — trending (unlike trenches) has no inline open_ratio, so
      // fetch it here. Deduped per creator per poll to stay light on the shared GMGN budget.
      if (r.creator && !devLookedUp.has(r.creator)) {
        devLookedUp.add(r.creator);
        const hist = await gmgnCreatedTokens("sol", r.creator);
        if (hist) {
          logRecord("events", {
            type: "dev-reputation-crosscheck", mint: r.address, symbol: r.symbol, creator: r.creator, source: "gmgn-trending",
            gmgnOpenCount: hist.open_count ?? null, gmgnOpenRatio: hist.open_ratio ?? null,
            gmgnTotalTokens: hist.tokens?.length ?? null, gmgnAthMc: hist.creator_ath_info?.ath_mc ?? null, strategy2Epoch: config.strategy2Epoch, cfg: configHash,
          });
        }
      }
    }
    ui.info(`[strategy2-scout] gmgn poll: ${rows.length} candidates (has_social, MC $${config.strategy2Scout.minMcUsd.toLocaleString()}+, holders 50+)`);
  } catch (e) {
    ui.warn(`[strategy2-scout] gmgn poll failed: ${(e as Error).message}`);
  }
}

/**
 * THIRD, PARALLEL source — GMGN `market trenches` (near_completion + completed), which exposes
 * filters trending/rank does NOT have: dev-reputation (creator_created_open_ratio), Twitter
 * follower count (x_user_follower), Telegram call count (tg_call_count) — a more literal
 * "callout" signal than square_mentions. Tagged `source:"gmgn-trenches"`, own comparison lane.
 * Filters are deliberately loose (max_rug_ratio 0.3, not a hard "safe" gate) — log broadly,
 * decide real thresholds from outcome data later, same posture as every other source here.
 */
async function pollGmgnTrenches(): Promise<void> {
  if (!gmgnEnabled) return;
  try {
    const t = await gmgnTrenches("sol", ["near_completion", "completed"], undefined, 80, {
      min_marketcap: config.strategy2Scout.minMcUsd,
      min_holder_count: 50,
      max_rug_ratio: 0.3,
    });
    if (!t) { ui.warn("[strategy2-scout] gmgn trenches poll: no data"); return; }
    const now = Date.now();
    const rows = [...(t.near_completion ?? []), ...(t.completed ?? [])];
    for (const r of rows) {
      if (!r.address) continue;
      const dev = await devSignal(r.address);
      logRecord("events", {
        type: "strategy2-candidate",
        strategyTag: "strategy2-mid-cap-scout-v1",
        firstSeenAt: now,
        source: "gmgn-trenches",
        strategy2Epoch: config.strategy2Epoch, cfg: configHash,
        mint: r.address, sym: r.symbol ?? "?", mcUsd: r.market_cap ?? 0, liqUsd: r.liquidity ?? 0, holders: r.holder_count ?? 0,
        riskScore: null, rugged: r.rug_ratio != null ? r.rug_ratio > 0.3 : null, // GMGN's own documented danger threshold (workflow-token-research.md), not a guess
        change1h: null, change4h: null, change24h: null,
        hasSocials: Boolean(r.has_at_least_one_social), twitterUrl: r.twitter_handle ?? null,
        createdAt: r.created_timestamp ?? null,
        isBoosted: boostedMints.has(r.address), isCommunityTakeover: takeoverMints.has(r.address),
        jupDevBalancePct: dev?.devBalancePct ?? null, jupMintRenounced: dev?.mintRenounced ?? null, jupFreezeRenounced: dev?.freezeRenounced ?? null,
        // Audit fix (2026-07-29): "entry confirmation berbasis demand" — raw 5m buy/sell flow
        // from the SAME Jupiter response already being fetched for dev-balance, previously
        // discarded. Logged here so strategy2-papertrader.ts can gate admission on real recent
        // demand, not just static entry-time attributes (holder count, smart-money count).
        jupNetBuyers5m: dev?.netBuyers5m ?? null, jupBuyVolume5m: dev?.buyVolume5m ?? null, jupSellVolume5m: dev?.sellVolume5m ?? null,
        // GMGN-TRENCHES-EXCLUSIVE fields — not on the trending/rank endpoint at all
        renownedCount: r.renowned_count ?? null, smartDegenCount: r.smart_degen_count ?? null,
        rugRatio: r.rug_ratio ?? null, bundlerRate: r.bundler_trader_amount_rate ?? null,
        sniperCount: r.sniper_count ?? null, isWashTrading: r.is_wash_trading ?? null,
        launchpadPlatform: r.launchpad_platform ?? null,
        creator: r.creator ?? null, // feeds the dev-reputation cross-check
        xFollowers: r.x_user_follower ?? null, tgCallCount: r.tg_call_count ?? null,
        creatorCreatedOpenRatio: r.creator_created_open_ratio ?? null,
      });
    }
    ui.info(`[strategy2-scout] gmgn trenches poll: ${rows.length} candidates (near_completion+completed, MC $${config.strategy2Scout.minMcUsd.toLocaleString()}+, rug<0.3)`);
  } catch (e) {
    ui.warn(`[strategy2-scout] gmgn trenches poll failed: ${(e as Error).message}`);
  }
}

/**
 * FOURTH source, SEPARATE THESIS (owner request, 2026-07-29): "koin baru tapi dev belum jual" —
 * the opposite end of the spectrum from the three lanes above, which all deliberately target
 * tokens that already survived the trenches and are already mid-cap. This one watches pump.fun's
 * own free "just created" feed (no auth, the same live source server.ts already uses for the
 * "new launches" market widget) and filters on whether the DEV WALLET still holds a meaningful
 * share of supply — a direct dump/no-dump read from Jupiter, not a holder-count or momentum proxy.
 * Tagged `source:"new-launch-dev-holding"`, its own comparison lane, never pooled with the other
 * three. OBSERVATION-ONLY for now: logs every looked-up candidate (including ones that don't
 * clear minDevBalancePct, so the threshold itself can be tuned from real outcome data rather than
 * guessed) — same posture the mid-cap scout itself started with before paper-trading was layered
 * on top. Not wired into strategy2-papertrader.ts's buying logic; that is a deliberate separate
 * decision so this thesis's data can be judged on its own before any capital (even simulated)
 * touches it.
 */
interface PumpFunCoin { symbol?: string; mint?: string; usd_market_cap?: number; created_timestamp?: number; reply_count?: number }
async function pollNewLaunchDevHold(): Promise<void> {
  try {
    const res = await fetch("https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false", { headers: { accept: "application/json" } });
    if (!res.ok) { ui.warn(`[strategy2-scout] new-launch poll: HTTP ${res.status}`); return; }
    const arr = (await res.json()) as PumpFunCoin[];
    const now = Date.now();
    const maxAgeMs = config.strategy2NewScout.maxAgeMin * 60_000;
    const fresh = (Array.isArray(arr) ? arr : []).filter((c) => c.mint && c.created_timestamp && now - c.created_timestamp <= maxAgeMs);
    let logged = 0, devHolding = 0;
    for (const c of fresh) {
      const intel = await devSignal(c.mint!);
      if (!intel) continue; // not indexed by Jupiter yet — too fresh, skip rather than log a null-signal row
      const passesDevHoldFloor = (intel.devBalancePct ?? 0) >= config.strategy2NewScout.minDevBalancePct;
      if (passesDevHoldFloor) devHolding++;
      logged++;
      logRecord("events", {
        type: "strategy2-candidate",
        strategyTag: "strategy2-new-launch-dev-hold-v1",
        firstSeenAt: now,
        source: "new-launch-dev-holding",
        strategy2Epoch: config.strategy2Epoch, cfg: configHash,
        mint: c.mint, sym: c.symbol ?? "?",
        mcUsd: intel.mcapUsd ?? c.usd_market_cap ?? 0, liqUsd: intel.liquidityUsd ?? 0, holders: intel.holderCount ?? 0,
        ageMin: Math.round((now - c.created_timestamp!) / 60_000),
        jupDevBalancePct: intel.devBalancePct ?? null, jupMintRenounced: intel.mintRenounced ?? null, jupFreezeRenounced: intel.freezeRenounced ?? null,
        jupNetBuyers5m: intel.netBuyers5m ?? null, jupBuyVolume5m: intel.buyVolume5m ?? null, jupSellVolume5m: intel.sellVolume5m ?? null,
        passesDevHoldFloor, organicScore: intel.organicScore ?? null, washSignal: intel.washSignal ?? null,
        replies: c.reply_count ?? 0,
      });
    }
    ui.info(`[strategy2-scout] new-launch poll: ${fresh.length} younger than ${config.strategy2NewScout.maxAgeMin}min, ${logged} indexed by Jupiter, ${devHolding} clear dev-hold floor (${config.strategy2NewScout.minDevBalancePct}%+)`);
  } catch (e) {
    ui.warn(`[strategy2-scout] new-launch poll failed: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  // Audit fix (2026-07-29): this used to `return` here on STRATEGY2_SCOUT=false, which killed
  // the new-launch/dev-hold lane too even though it has its OWN independent enabled flag
  // (STRATEGY2_NEWSCOUT) that never got checked because main() had already exited. The two lanes
  // are a genuinely different thesis (see pollNewLaunchDevHold()'s doc comment) and are meant to
  // be toggled independently.
  const midCapOn = config.strategy2Scout.enabled;
  const newLaunchOn = config.strategy2NewScout.enabled;
  if (!midCapOn && !newLaunchOn) { console.log("[strategy2-scout] disabled (both STRATEGY2_SCOUT=false and STRATEGY2_NEWSCOUT=false)"); return; }
  console.log(`[strategy2-scout] mid-cap mover lane: ${midCapOn ? `watching MC >= $${config.strategy2Scout.minMcUsd.toLocaleString()}, polling every ${config.strategy2Scout.pollMs / 60_000}min` : "disabled (STRATEGY2_SCOUT=false)"}. Read-only, zero capital, zero sniper interaction.`);
  console.log(`[strategy2-scout] gmgn parallel source: ${gmgnEnabled ? "enabled" : "disabled (no GMGN_API_KEY)"}`);
  console.log(`[strategy2-scout] new-launch/dev-hold lane: ${newLaunchOn ? `enabled (age<=${config.strategy2NewScout.maxAgeMin}min, poll ${config.strategy2NewScout.pollMs / 60_000}min, observation-only)` : "disabled (STRATEGY2_NEWSCOUT=false)"}`);
  let timer: ReturnType<typeof setInterval> | null = null;
  if (midCapOn) {
    await refreshDexFlags(); // populate boosted/takeover sets BEFORE the first poll logs candidates
    void poll();
    void pollGmgn();
    void pollGmgnTrenches();
    setInterval(() => void refreshDexFlags(), config.strategy2Scout.pollMs);
    setInterval(() => void pollGmgn(), config.strategy2Scout.pollMs);
    setInterval(() => void pollGmgnTrenches(), config.strategy2Scout.pollMs);
    timer = setInterval(() => void poll(), config.strategy2Scout.pollMs);
  }
  let newScoutTimer: ReturnType<typeof setInterval> | null = null;
  if (newLaunchOn) {
    void pollNewLaunchDevHold();
    newScoutTimer = setInterval(() => void pollNewLaunchDevHold(), config.strategy2NewScout.pollMs);
  }
  const shutdown = () => { if (timer) clearInterval(timer); if (newScoutTimer) clearInterval(newScoutTimer); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
