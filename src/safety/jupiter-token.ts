import { config } from "../config.js";
import { fetchJson, TokenBucket } from "../util/http.js";

/**
 * Jupiter Token Intelligence — one free endpoint that delivers most of what the
 * on-chain-forensics research recommended, and it indexes brand-new pump.fun
 * tokens (unlike DexScreener). Gives, per mint:
 *   - organicScore     : fake-volume / wash-trade defense (higher = more organic)
 *   - devBalancePct    : how much of supply the dev still holds (bundle signal)
 *   - devMints         : how many tokens this dev has ever minted (serial deployer)
 *   - topHoldersPct    : holder concentration (free, instant)
 *   - holderCount      : community size
 *   - liquidityUsd/mcap: for the liquidity/marketcap ratio gate
 *   - 5m trader stats  : numTraders vs numBuys (micro-bundle wash-trade heuristic)
 */
const bucket = TokenBucket.perMinute(config.limits.jupiterPerMin);
const BASE = config.jupiterApiKey ? config.jupiterBaseUrl : "https://lite-api.jup.ag";
const headers: Record<string, string> = config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {};

interface JupStats {
  priceChange?: number;
  buyVolume?: number;
  sellVolume?: number;
  numBuys?: number;
  numSells?: number;
  numTraders?: number;
  numNetBuyers?: number;
}
interface JupToken {
  id?: string; // the mint address itself — verified live 2026-07-29 present on every real response
  organicScore?: number;
  holderCount?: number;
  mcap?: number;
  fdv?: number;
  liquidity?: number;
  tags?: string[];
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devBalancePercentage?: number;
    devMigrations?: number;
    devMints?: number;
  };
  stats5m?: JupStats;
  stats1h?: JupStats;
}

export interface JupTokenIntel {
  organicScore?: number;
  holderCount?: number;
  mcapUsd?: number;
  liquidityUsd?: number;
  liqToMcRatio?: number; // liquidity / marketcap
  topHoldersPct?: number;
  devBalancePct?: number;
  devMints?: number; // serial-deployer signal
  mintRenounced?: boolean;
  freezeRenounced?: boolean;
  washSignal?: boolean; // 5m: many txns but ~1 unique trader (circular/wash)
  // Audit fix (2026-07-29): "entry confirmation berbasis demand" — Jupiter's stats5m already
  // carries the raw counts washSignal is derived from, but they were being discarded rather than
  // exposed. netBuyers5m/buyVolume5m/sellVolume5m let a caller confirm ACTUAL recent buy pressure
  // (not just "not obviously wash-traded") before treating a candidate as having real demand.
  netBuyers5m?: number;
  buyVolume5m?: number;
  sellVolume5m?: number;
}

/** Best-effort; null on failure or if the token isn't indexed yet. */
export async function jupiterTokenIntel(mint: string, signal?: AbortSignal): Promise<JupTokenIntel | null> {
  try {
    const arr = await fetchJson<JupToken[]>(`${BASE}/tokens/v2/search?query=${mint}`, {
      bucket,
      headers,
      timeoutMs: 4_000,
      retries: 1,
      signal,
    });
    // Audit fix (2026-07-29): this used to take the FIRST search result unconditionally
    // (`find(() => true)`) — Jupiter's search is a fuzzy/text search, not an exact-address
    // lookup, so a query that happens to match multiple tokens could silently return intel for
    // the WRONG mint. Verified live: the real response always carries `id` set to the queried
    // mint address itself. Require an exact match; if the array has no exact hit, treat it the
    // same as "not indexed" rather than trust a similarly-named different token.
    const t = Array.isArray(arr) ? arr.find((row) => row.id === mint) : undefined;
    if (!t) return null;
    const mcap = t.mcap;
    const liq = t.liquidity;
    const s = t.stats5m;
    const washSignal =
      !!s && (s.numBuys ?? 0) + (s.numSells ?? 0) >= 5 && (s.numTraders ?? 99) <= 1; // txns without unique traders
    return {
      organicScore: t.organicScore,
      holderCount: t.holderCount,
      mcapUsd: mcap,
      liquidityUsd: liq,
      liqToMcRatio: mcap && mcap > 0 && liq !== undefined ? liq / mcap : undefined,
      topHoldersPct: t.audit?.topHoldersPercentage,
      devBalancePct: t.audit?.devBalancePercentage,
      devMints: t.audit?.devMints,
      mintRenounced: t.audit?.mintAuthorityDisabled,
      freezeRenounced: t.audit?.freezeAuthorityDisabled,
      washSignal,
      netBuyers5m: s?.numNetBuyers,
      buyVolume5m: s?.buyVolume,
      sellVolume5m: s?.sellVolume,
    };
  } catch {
    return null;
  }
}
