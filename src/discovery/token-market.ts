import { config } from "../config.js";
import { dexTokenPairs } from "./dexscreener.js";
import { jupiterTokenIntel } from "../safety/jupiter-token.js";

export interface TokenMarketSnapshot {
  mcUsd: number | null;
  holders: number | null;
  riskScore: number | null;
  rugged: boolean | null;
  source: "solana-tracker" | "solana-tracker+jupiter" | "jupiter" | "solana-tracker+dexscreener" | "dexscreener";
  primaryStatus: number | "disabled" | "network-error";
}

interface TrackerToken {
  pools?: Array<{ marketCap?: { usd?: number } }>;
  holders?: number;
  risk?: { score?: number; rugged?: boolean };
}

const finitePositive = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0;

/**
 * Read one token market snapshot without fabricating a value. Solana Tracker remains primary
 * because it also supplies holder/risk fields.
 *
 * FALLBACK ORDER CHANGED (2026-07-29, live-confirmed): Solana Tracker's daily quota was found
 * exhausted under Strategy 2's realtime scalping cadence — measured 135/135 calls failing with
 * HTTP 403 "Rate limit reached, please wait and try again" in one day, pushing every position
 * onto whatever the next fallback is. DexScreener USED to be that fallback, but live-confirmed
 * (via a direct API call, not a parsing bug on our side) that it can report a stale/dead POOL's
 * price for a token that's still very much alive elsewhere: Cybercat showed marketCap:0.03 with
 * 0 volume in every window on DexScreener's own dashboard, while GMGN's routing found a live pool
 * and quoted a real +16.14% exit for the same token at the same moment. Jupiter's free token
 * search (no key required, already used elsewhere in this project for dev-balance checks) is now
 * tried BEFORE DexScreener — verified live to return a sane, non-garbage market cap ($313,275)
 * for the exact token DexScreener got wrong. DexScreener stays as the LAST resort (not removed —
 * still useful when Jupiter hasn't indexed a token yet either). This cascade is defense-in-depth,
 * not a replacement for the peakRealizedValueUsd/TRAIL_STOP real-quote verification guard in
 * strategy2-papertrader.ts, which remains the actual backstop against any of these being wrong.
 */
/** One HTTP attempt against a Solana Tracker endpoint. Shared by the primary and backup paths. */
async function fetchTracker(url: string, headers?: Record<string, string>): Promise<{ tracker: TrackerToken | null; status: number | "network-error" }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(url, { headers, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    if (res.ok) return { tracker: (await res.json()) as TrackerToken, status: res.status };
    return { tracker: null, status: res.status };
  } catch {
    return { tracker: null, status: "network-error" };
  }
}

export async function tokenMarketSnapshot(mint: string): Promise<TokenMarketSnapshot | null> {
  const host = config.solTracker.host;
  let tracker: TrackerToken | null = null;
  let primaryStatus: TokenMarketSnapshot["primaryStatus"] = host ? "network-error" : "disabled";
  if (host) {
    const r = await fetchTracker(`${host}/tokens/${mint}`);
    tracker = r.tracker;
    primaryStatus = r.status;
  }
  // Backup account fallback (owner, 2026-07-29) — own separate free-tier quota, accessed via the
  // standard host + x-api-key header (verified live: identical response shape to the primary
  // secure-subdomain path). Only tried when the primary genuinely failed (non-2xx/network-error),
  // never when the primary simply had no MC for this particular mint — that's a real "no data"
  // answer, not a quota problem, and re-asking the backup account wouldn't change it.
  if (!tracker && config.solTracker.backupApiKey && primaryStatus !== "disabled") {
    const r = await fetchTracker(`https://data.solanatracker.io/tokens/${mint}`, { "x-api-key": config.solTracker.backupApiKey });
    if (r.tracker) { tracker = r.tracker; primaryStatus = r.status; }
  }

  const trackerMc = tracker?.pools?.map((p) => p.marketCap?.usd).find(finitePositive) ?? null;
  const holders = typeof tracker?.holders === "number" ? tracker.holders : null;
  const riskScore = typeof tracker?.risk?.score === "number" ? tracker.risk.score : null;
  const rugged = typeof tracker?.risk?.rugged === "boolean" ? tracker.risk.rugged : null;
  if (trackerMc != null) {
    return { mcUsd: trackerMc, holders, riskScore, rugged, source: "solana-tracker", primaryStatus };
  }

  const jup = await jupiterTokenIntel(mint).catch(() => null);
  if (jup && finitePositive(jup.mcapUsd)) {
    return {
      mcUsd: jup.mcapUsd!,
      holders: holders ?? jup.holderCount ?? null,
      riskScore, rugged,
      source: tracker ? "solana-tracker+jupiter" : "jupiter",
      primaryStatus,
    };
  }

  // DEAD-POOL FILTER (2026-07-31, traced from a real trade). This used to accept any pair with a
  // finite positive marketCap/fdv and sort by `liquidity?.usd ?? 0`. Both halves were too loose:
  // a mint usually has several DexScreener pairs, including abandoned micro-pools, and $0.03 is
  // "finite positive", so a dead pool's marketCap qualified. Worse, when no pair reported
  // liquidity at all the `?? 0` made every key equal and the sort became arbitrary — so which
  // pool won was luck. That is where the repeated $0.03 marks came from: not a broken DexScreener
  // but us reading a corpse pool and calling it the token's market cap. Downstream, each one
  // tripped the MC-anomaly guard, which (until the fix in strategy2-papertrader's fast check)
  // blinded the trailing stop for a full poll cycle.
  //
  // A pool with no real liquidity cannot price anything, so require liquidity to be a real
  // positive number and pick the deepest. If nothing qualifies, fall through to the "no MC"
  // branch below and report honestly rather than inventing a number from a dead pool.
  const pairs = await dexTokenPairs("solana", mint);
  const best = (pairs ?? [])
    .filter((p) => (finitePositive(p.marketCap) || finitePositive(p.fdv)) && finitePositive(p.liquidity?.usd))
    .sort((a, b) => (b.liquidity!.usd!) - (a.liquidity!.usd!))[0];
  const dexMc = best && (finitePositive(best.marketCap) ? best.marketCap : finitePositive(best.fdv) ? best.fdv : null);
  if (dexMc == null) {
    // Tracker can still provide useful holder/risk evidence even when neither source has MC.
    return tracker
      ? { mcUsd: null, holders, riskScore, rugged, source: "solana-tracker", primaryStatus }
      : null;
  }
  return {
    mcUsd: dexMc,
    holders,
    riskScore,
    rugged,
    source: tracker ? "solana-tracker+dexscreener" : "dexscreener",
    primaryStatus,
  };
}
