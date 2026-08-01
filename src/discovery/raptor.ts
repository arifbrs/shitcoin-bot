import { TokenBucket } from "../util/http.js";

/**
 * Solana Tracker "raptor-beta" pool index — a price source derived from raw AMM reserves.
 *
 * WHY THIS EXISTS (owner, 2026-07-31). Both Solana Tracker Data API keys are spent, so the
 * primary mark source answers 403/429 on effectively every call. That left Jupiter carrying
 * every mark alone, with DexScreener behind it — and DexScreener was feeding back a dead pool's
 * $0.03 "market cap", which tripped the MC-anomaly guard and (until the same-day fix in
 * strategy2-papertrader) blinded the trailing stop for a full poll cycle. Measured live, the
 * raptor host still answers 200 for the SAME key that the Data API rejects, and did not throttle
 * at all across 10 back-to-back requests.
 *
 * It returns pool membership and RAW reserves rather than a computed price, which is actually the
 * more trustworthy input: reserves are the pool's own state, not a third party's aggregation.
 *
 * CALIBRATED, NOT ASSUMED. Three properties were measured against GMGN's live price across 18
 * real pools before any of this was wired in:
 *
 *  1. Only CONSTANT-PRODUCT pools can be priced from reserves. Concentrated-liquidity pools
 *     (Meteora DLMM, Whirlpool) came out 56-93% wrong, because their reserves say nothing about
 *     the active tick's price. They are excluded, not "corrected".
 *  2. The `Pump.fun` dex entry is the bonding curve and its reserves are VIRTUAL — every sample
 *     showed the same constant 115.0 / 30.0 "SOL" reserve and 85-99.9% price error. Excluded.
 *  3. `reserve_a`/`reserve_b` ORDER IS NOT STABLE. Some pools put the queried token in
 *     reserve_a, others in reserve_b, and the byte ordering of the mint versus SOL does not
 *     predict which (checked: all 21 sampled pools had mint > SOL, yet both orientations
 *     occurred). See resolveOrientation below for how this is settled.
 *
 * Accuracy once those three hold, measured end-to-end through this module: 12 of 12 memecoins
 * landed within 5% of GMGN's live price, most under 1.2%, best 0.12%. USDC — the one case that
 * broke an earlier orientation heuristic — prices at $1.0010 once an anchor is supplied, which is
 * why resolveOrientation now requires one.
 */

const HOST = "https://raptor-beta.solanatracker.io";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// No throttling was observed (10 back-to-back requests all 200), but an unmetered client against
// a beta endpoint is how a source gets taken away. This is deliberately well under anything that
// looked like a limit.
const bucket = TokenBucket.perSecond(10);

/** Constant-product AMMs only — see property (1) and (2) in the module comment. */
const CONSTANT_PRODUCT_DEX = new Set(["Pumpswap", "Raydium AMM", "Raydium CPMM", "Meteora AMM V2"]);

/** Below this the pool cannot price anything meaningfully and its ratio is noise. */
const MIN_POOL_SOL = 1;

interface RaptorPool {
  address: string; dex: string; quote: string;
  reserve_a: number; reserve_b: number; score: number; indexed?: boolean;
}
interface RaptorResponse { token: string; pool_count: number; pools: RaptorPool[] }

export interface RaptorMark {
  priceUsd: number;
  liqSol: number;
  liqUsd: number;
  dex: string;
  poolAddress: string;
  /** How the token/SOL sides were told apart. Always "anchor" — see resolveOrientation. */
  orientation: "anchor";
}

export const raptorEnabled = (): boolean => Boolean(process.env.SOLTRACKER_API_KEY?.trim());

async function fetchPools(mint: string, timeoutMs = 8_000): Promise<RaptorPool[] | null> {
  const key = process.env.SOLTRACKER_API_KEY?.trim();
  if (!key) return null;
  await bucket.take();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${HOST}/token/${mint}`, { headers: { "x-api-key": key }, signal: ctrl.signal });
    if (!r.ok) return null;
    const body = (await r.json()) as RaptorResponse;
    return Array.isArray(body?.pools) ? body.pools : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Decide which reserve is SOL and which is the token, and return the resulting price.
 *
 * An anchor price is REQUIRED, and that is a deliberate narrowing after a failed attempt at
 * doing without one. The first version fell back to "the side with the smaller raw value is SOL"
 * when no anchor was given, reasoning that a memecoin's token reserve (1e13-1e17 raw) always
 * dwarfs a SOL reserve (1e11-1e13 lamports). That heuristic scored 12/12 within 5% on real
 * memecoins — and still silently produced a WRONG price for USDC, returning $0.0056 for a $1
 * token. The band guard meant to catch that (`price > 0.01`) did not fire, because the wrong
 * orientation happens to yield a SMALL number, not a large one. The measured separation is also
 * thinner than it looks: the reserve-magnitude ratio ranged from 104x (Bonk) to 55,000x across
 * healthy memecoins, against 13x for USDC — a gap too narrow to defend a threshold on.
 *
 * So rather than tune a guard around a heuristic, the heuristic is gone. Every caller in this
 * codebase already HAS an anchor — the entry price when a position opens, the last trusted mark
 * on every poll afterwards — so requiring one costs nothing and removes an entire class of
 * silent, orders-of-magnitude-wrong answers. Verified: with an anchor, USDC prices at $1.0010.
 *
 * Picking between the two orientations by anchor is unambiguous rather than delicate, because
 * they differ by orders of magnitude, never by a few percent — so no plausible price move can
 * make the wrong one look closer.
 */
function resolveOrientation(
  pool: RaptorPool, decimals: number, solUsd: number, anchorPriceUsd: number,
): { priceUsd: number; liqSol: number; orientation: RaptorMark["orientation"] } | null {
  const priceIf = (solRaw: number, tokRaw: number): number | null => {
    const solAmt = solRaw / 1e9;
    const tokAmt = tokRaw / 10 ** decimals;
    if (!(solAmt > 0) || !(tokAmt > 0)) return null;
    const p = (solAmt / tokAmt) * solUsd;
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  const asB = priceIf(pool.reserve_b, pool.reserve_a); // token in reserve_a
  const asA = priceIf(pool.reserve_a, pool.reserve_b); // token in reserve_b

  const dist = (p: number | null) => (p == null ? Infinity : Math.abs(Math.log(p / anchorPriceUsd)));
  const dB = dist(asB), dA = dist(asA);
  if (!Number.isFinite(Math.min(dB, dA))) return null;
  return dB <= dA
    ? { priceUsd: asB!, liqSol: pool.reserve_b / 1e9, orientation: "anchor" }
    : { priceUsd: asA!, liqSol: pool.reserve_a / 1e9, orientation: "anchor" };
}

/**
 * Live price for `mint` from the deepest constant-product SOL pool.
 *
 * `decimals`, `solUsd` and `anchorPriceUsd` are all caller-supplied because the caller already
 * has each one (decimals is static per mint and worth caching; SOL price is needed for sizing
 * anyway; the anchor is the entry price or the last trusted mark). Looking them up here would
 * cost an extra call per mark, which is exactly the overhead this module exists to avoid.
 * See resolveOrientation for why the anchor is mandatory rather than optional.
 */
export async function raptorPrice(
  mint: string, decimals: number, solUsd: number, anchorPriceUsd: number,
): Promise<RaptorMark | null> {
  if (!(solUsd > 0) || !(anchorPriceUsd > 0) || !Number.isFinite(decimals) || decimals < 0) return null;
  const pools = await fetchPools(mint);
  if (!pools) return null;

  let best: RaptorMark | null = null;
  for (const p of pools) {
    if (p.quote !== SOL_MINT || !CONSTANT_PRODUCT_DEX.has(p.dex)) continue;
    const solved = resolveOrientation(p, decimals, solUsd, anchorPriceUsd);
    if (!solved || solved.liqSol < MIN_POOL_SOL) continue;
    if (!best || solved.liqSol > best.liqSol) {
      best = {
        priceUsd: solved.priceUsd,
        liqSol: solved.liqSol,
        liqUsd: solved.liqSol * solUsd * 2, // both sides of a constant-product pool
        dex: p.dex,
        poolAddress: p.address,
        orientation: solved.orientation,
      };
    }
  }
  return best;
}

