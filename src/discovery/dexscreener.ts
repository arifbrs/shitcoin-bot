import { TokenBucket } from "../util/http.js";

/**
 * DexScreener public API — free, no key, no auth. Documented limit: 60 req/min per endpoint
 * group (https://docs.dexscreener.com/api/reference). Used for TWO things GMGN/Solana Tracker
 * don't have (verified live 2026-07-27):
 *   1. Token Boosts  — who is actively PAYING to promote a token right now (marketing spend
 *      signal — ambiguous on its own, cross-reference with rug/wash signals, never trust alone)
 *   2. Community Takeovers — a token whose original team left and a new community "CTO"'d it
 *      (a distinct lifecycle event neither GMGN nor Solana Tracker label)
 * Also used as an INDEPENDENT price/liquidity cross-check (measured real disagreement vs GMGN:
 * ~20% liquidity gap on the same token) — two independently-wrong-in-different-ways sources
 * catch a stale/bad reading from either one alone.
 */
const BASE = "https://api.dexscreener.com";
const bucket = TokenBucket.perMinute(50); // conservative under the documented 60/min ceiling
const TIMEOUT_MS = 8_000;

async function get<T>(path: string): Promise<T | null> {
  await bucket.take();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // best-effort — never break a caller over a DexScreener hiccup
  } finally {
    clearTimeout(t);
  }
}

export interface DexBoostRow { chainId: string; tokenAddress: string; description?: string; links?: Array<{ type?: string; url: string }>; totalAmount: number; amount: number; }
export interface DexTakeoverRow { chainId: string; tokenAddress: string; description?: string; links?: Array<{ type?: string; label?: string; url: string }>; }

/** Latest tokens with an ACTIVE paid boost right now. */
export async function dexBoostedTokens(): Promise<DexBoostRow[] | null> {
  const rows = await get<DexBoostRow[]>("/token-boosts/latest/v1");
  return Array.isArray(rows) ? rows : null;
}

/** Latest community-takeover ("CTO") events — original team gone, a new community took over. */
export async function dexCommunityTakeovers(): Promise<DexTakeoverRow[] | null> {
  const rows = await get<DexTakeoverRow[]>("/community-takeovers/latest/v1");
  return Array.isArray(rows) ? rows : null;
}

export interface DexPair {
  priceUsd?: string; liquidity?: { usd?: number }; fdv?: number; marketCap?: number;
  volume?: { h24?: number; h6?: number; h1?: number }; pairCreatedAt?: number;
}
/** Independent price/liquidity reading for a mint — cross-check, not a replacement source. */
export async function dexTokenPairs(chainId: string, tokenAddress: string): Promise<DexPair[] | null> {
  const rows = await get<DexPair[]>(`/tokens/v1/${chainId}/${tokenAddress}`);
  return Array.isArray(rows) ? rows : null;
}
