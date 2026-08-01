import "dotenv/config";
import { ui } from "../util/log.js";

/**
 * GMGN OpenAPI — read-only wrapper. Every call here goes through the LOCAL rate-limit proxy
 * (gmgn-proxy.ts, its own process — see that file's header for why) instead of calling GMGN
 * directly. That process holds the one real OpenApiClient and the one real shared rate limiter;
 * this file only knows how to reach it over local HTTP. Used by: Strategy 2 Scout, the sniper's
 * post-open enrichment (cross-check only, never gates entry — see papertrader.ts), Strategy 2's
 * paper trader, KOL/Smart-money watch, and the multi-launchpad observatory.
 *
 * No API key or private key is loaded in THIS file at all (review fix, 2026-07-27) — only
 * gmgn-proxy.ts needs GMGN_API_KEY, and none of the methods reachable through it are signed
 * routes, so a private key was never actually used by anything in this file to begin with.
 *
 * Timeout is a REAL AbortController on the fetch to the local proxy (review fix — the previous
 * Promise.race against gmgn-cli's OpenApiClient never actually cancelled the underlying
 * request, since that client's fetch call didn't accept a signal). Errors are logged with their
 * real status/message rather than silently collapsed to null, though callers still just see
 * null on failure (best-effort — a GMGN hiccup must never break a caller).
 */
const PROXY_PORT = Number(process.env.GMGN_PROXY_PORT ?? 4319);
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}/call`;
export const gmgnEnabled = Boolean(process.env.GMGN_API_KEY?.trim());
// 8s was too tight (found live, 2026-07-27, first cold-start poll of all 5 research processes):
// gmgn-cli's own OpenApiClient auto-retries ONCE on a real 429 — original request + up to a 5s
// backoff (its DEFAULT_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS) + 1s buffer + the retry request itself,
// which legitimately runs 8-12s end to end. An 8s client-side abort was cancelling that mid-retry
// on every process's very first poll, discarding a response that was about to succeed anyway.
const CALL_TIMEOUT_MS = 15_000;

async function callProxy<T>(method: string, args: unknown[]): Promise<T | null> {
  if (!gmgnEnabled) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(PROXY_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args }), signal: ctrl.signal,
    });
    const body = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
    if (!res.ok) {
      ui.warn(`[gmgn] ${method} failed: HTTP ${res.status} ${body?.error ?? "(no body)"}`);
      return null;
    }
    return body?.data ?? null;
  } catch (e) {
    const isAbort = (e as Error).name === "AbortError";
    ui.warn(`[gmgn] ${method} ${isAbort ? "timed out and was cancelled" : "call failed"}: ${(e as Error).message}. Is gmgn-proxy running (npm run gmgn:proxy)?`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface GmgnTrendingRow {
  address: string; symbol: string; market_cap: number; liquidity: number; holder_count: number;
  smart_degen_count: number; renowned_count: number; square_mentions: number; rug_ratio: number;
  bundler_rate: number; sniper_count: number; is_wash_trading: boolean;
  twitter_username?: string; website?: string; telegram?: string;
  price_change_percent: number; volume: number; creation_timestamp: number;
  creator?: string;
}

/** market trending, chain=sol, with GMGN's server-side social/smart-money filters. */
export async function gmgnTrendingSol(interval: "1m" | "5m" | "1h" | "6h" | "24h", extra: Record<string, unknown> = {}): Promise<GmgnTrendingRow[] | null> {
  const res = await callProxy<{ data?: { rank?: unknown[] } }>("getTrendingSwaps", ["sol", interval, extra]);
  const rows = res?.data?.rank;
  return Array.isArray(rows) ? (rows as GmgnTrendingRow[]) : null;
}

export interface GmgnTokenInfo {
  wallet_tags_stat?: { smart_wallets: number; renowned_wallets: number; sniper_wallets: number; bundler_wallets: number; rat_trader_wallets: number };
  stat?: { signal_count: number; degen_call_count: number; top_rat_trader_percentage: string; top_bundler_trader_percentage: string };
  link?: { twitter_username?: string; website?: string; telegram?: string };
  holder_count?: number;
  symbol?: string;
  decimals?: number;
  // CORRECTION (2026-07-31, audit): the earlier note here claimed this token's ATH lives at
  // `dev.ath_token_info.ath_mc`. That was WRONG and the ATH-proximity gate built on it was
  // comparing against the wrong token entirely. Verified live on mint Hzeue…DZbLn (symbol
  // "John"): `dev.ath_token_info.ath_token` is `JF4J6bz…XNrF` (symbol "DOG") — a DIFFERENT
  // mint. `dev` describes the CREATOR, so `dev.ath_token_info` is the creator's own
  // highest-ATH token to date, useful as a dev-pedigree signal but never as this token's ATH.
  // THIS token's all-time high is the top-level `ath_price` (quote-currency price, same unit
  // as `price.price`), so an ATH ratio must be computed price-vs-price, not MC-vs-MC.
  ath_price?: number | string;
  liquidity?: number | string;
  circulating_supply?: number | string;
  total_supply?: number | string;
  price?: {
    price?: number | string;
    swaps_1h?: number; swaps_5m?: number;
    volume_1h?: number | string; volume_5m?: number | string;
    buys_1h?: number; sells_1h?: number;
  };
  dev?: {
    creator_address?: string; creator_token_status?: string; creator_open_count?: number;
    /** The CREATOR's best-ever token — NOT this mint. See the ath_price note above. */
    ath_token_info?: { ath_token?: string; ath_mc?: string; symbol?: string };
  };
}
export async function gmgnTokenInfo(chain: string, mint: string): Promise<GmgnTokenInfo | null> {
  return callProxy<GmgnTokenInfo>("getTokenInfo", [chain, mint]);
}

export interface GmgnTokenSecurity {
  is_honeypot: number | null; honeypot: number; is_open_source: number | null; open_source: number;
  top_10_holder_rate: string; burn_status: string; buy_tax: string; sell_tax: string;
}
export async function gmgnTokenSecurity(chain: string, mint: string): Promise<GmgnTokenSecurity | null> {
  return callProxy<GmgnTokenSecurity>("getTokenSecurity", [chain, mint]);
}

/** One real trade by a tagged (KOL / smart-money) wallet — verified live shape, NOT `{data:[...]}`. */
export interface GmgnQuote {
  input_amount: string; output_amount: string; min_output_amount: string; slippage: number;
  // VERIFIED live shape (2026-07-27): amount_in_usd/amount_out_usd/exchange live under `tx`,
  // NOT at the top level — an earlier version of this interface had them at top level and
  // silently produced NaN/undefined until caught by an isolated test against the real API.
  tx?: {
    amount_in_usd?: string; amount_out_usd?: string; exchange?: string;
    // VERIFIED live 2026-07-27: sol_cost is a REAL, additional SOL-denominated cost beyond the
    // swap's nominal input/output amount (a 0.1 SOL buy quote showed sol_cost=0.10697 SOL, i.e.
    // ~0.007 SOL — roughly $0.55 at the time — of overhead NOT reflected in amount_in_usd at
    // all). Exact composition (ATA rent? priority fee? slippage buffer?) is NOT confirmed —
    // treated conservatively as pure additional cost by every caller, never silently dropped.
    sol_cost?: string;
    quote?: { priceImpactPct?: string; platformFee?: string; routePlan?: Array<{ swapInfo?: { feeAmount?: string } }> };
  };
}
/**
 * REAL routed swap quote — no assumed fee %. `amount_in_usd`/`amount_out_usd` already have
 * GMGN's platform fee + the pool's own swap fee + price impact baked in (verified live
 * 2026-07-27: 1 SOL → CATE showed an explicit 0.01 SOL platform fee + 0.0183 SOL pool fee,
 * $76.38 in vs $76.12 out). `fromAddress` only needs to be a syntactically valid Solana
 * address for routing — this never signs or submits anything (exist-auth only, no private key).
 */
export async function gmgnQuote(chain: string, fromAddress: string, inputToken: string, outputToken: string, amountRaw: string, slippagePct = 10): Promise<GmgnQuote | null> {
  return callProxy<GmgnQuote>("quoteOrder", [chain, fromAddress, inputToken, outputToken, amountRaw, slippagePct]);
}

export interface GmgnActivityRow {
  transaction_hash: string; maker: string; base_address: string; // mint traded
  side: "buy" | "sell"; timestamp: number; amount_usd: number; price_usd: number;
  base_token?: { symbol?: string; launchpad?: string };
  maker_info?: { twitter_username?: string; twitter_name?: string; tags?: string[] };
}
export async function gmgnKol(chain = "sol", limit = 50): Promise<GmgnActivityRow[] | null> {
  const res = await callProxy<{ list?: unknown[] }>("getKol", [chain, limit]);
  return Array.isArray(res?.list) ? (res!.list as GmgnActivityRow[]) : null;
}
export async function gmgnSmartMoney(chain = "sol", limit = 50): Promise<GmgnActivityRow[] | null> {
  const res = await callProxy<{ list?: unknown[] }>("getSmartMoney", [chain, limit]);
  return Array.isArray(res?.list) ? (res!.list as GmgnActivityRow[]) : null;
}

/**
 * ONE top holder/trader row for a specific mint — VERIFIED live shape (2026-07-27, CATE,
 * tag=smart_degen). `profit` equalled `realized_profit` exactly for a wallet that had fully
 * exited (unrealized_profit: 0) in the one sample checked — whether `profit` = realized-only or
 * realized+unrealized for a still-HOLDING wallet was not confirmed; treat both fields as
 * separately meaningful rather than assuming which one is "the" answer.
 */
export interface GmgnHolderRow {
  address: string; amount_percentage?: number; usd_value?: number;
  profit?: number; realized_profit?: number; unrealized_profit?: number;
  realized_pnl?: number; unrealized_pnl?: number | null; // ratios (e.g. 1.6 = +160%), NOT percentages already multiplied
  wallet_tag_v2?: string; is_suspicious?: boolean;
  [key: string]: unknown;
}
export async function gmgnTopHolders(chain: string, mint: string, tag?: string, orderBy = "amount_percentage", limit = 20): Promise<GmgnHolderRow[] | null> {
  const extra: Record<string, string | number> = { limit, order_by: orderBy, direction: "desc" };
  if (tag) extra.tag = tag;
  const res = await callProxy<{ list?: unknown[] }>("getTokenTopHolders", [chain, mint, extra]);
  return Array.isArray(res?.list) ? (res!.list as GmgnHolderRow[]) : null;
}

/**
 * `market signal` (token_signal) — a discrete EVENT feed (price spikes, smart-money buys, large
 * buys — GMGN's own description), NOT a steady-state ranking like trending/trenches.
 *
 * CORRECTION (2026-07-27): an earlier version of this comment claimed `signal_type` was
 * completely undocumented — that was WRONG, caught by a second read of the actual gmgn-skills
 * repo (this file's earlier check only read the .ts source, not skills/gmgn-market/SKILL.md,
 * which has a documented reference table). Known codes as of that table:
 *   1=general/K-line spike, 6=price spike, 7=all-time-high, 10=bundler sell,
 *   11=community takeover, 12=smart-money buy, 13=platform call, 14=large buy, 20=KOL buy
 *   (17-19, 21 = platform-specific claims). The API itself still rejects 14/15/16 in the
 * *filter* request even though 14 has a documented meaning — so the queryable set and the
 * documented set don't fully match; verify a code actually WORKS before depending on it.
 */
export const SIGNAL_TYPES = {
  GENERAL_SPIKE: 1, PRICE_SPIKE: 6, ATH: 7, BUNDLER_SELL: 10, COMMUNITY_TAKEOVER: 11,
  SMART_MONEY_BUY: 12, PLATFORM_CALL: 13, LARGE_BUY: 14, KOL_BUY: 20,
} as const;
export interface GmgnSignalRow {
  id: string; token_address: string; signal_type: number; ath?: number; market_cap?: number;
  trigger_at?: number; trigger_mc?: number; signal_times?: number;
  data?: { symbol?: string; launchpad_platform?: string; creator?: string; holder_count?: number; rug_ratio?: number; [key: string]: unknown };
}
export async function gmgnTokenSignal(chain: string, groups: Array<{ signal_type?: number[]; mc_min?: number; mc_max?: number }>): Promise<GmgnSignalRow[] | null> {
  const res = await callProxy<unknown>("getTokenSignalV2", [chain, groups]);
  return Array.isArray(res) ? (res as GmgnSignalRow[]) : null;
}

/**
 * ONE row of `market trenches` — richer than `market trending`: dev-reputation, follower/call
 * counts, and full risk-ratio filters are ONLY available here, not on the trending/rank
 * endpoint. Fields marked optional were not all confirmed in the one live sample pulled during
 * development (the JSON was large and truncated in review) — treat any specific field as
 * unverified until read from a real response, per this project's "no assumptions" rule.
 */
export interface GmgnTrenchesRow {
  address: string; symbol?: string; name?: string; holder_count?: number;
  market_cap?: number; liquidity?: number; progress?: number; created_timestamp?: number;
  launchpad?: string; launchpad_platform?: string; exchange?: string;
  creator?: string; creator_created_count?: number; creator_created_open_count?: number; creator_created_open_ratio?: number;
  renowned_count?: number; smart_degen_count?: number; rug_ratio?: number;
  bundler_trader_amount_rate?: number; callout_count?: number; has_at_least_one_social?: boolean;
  // VERIFIED live 2026-07-27 (field names confirmed from a real response, not guessed from
  // the filter names): Twitter follower count is `x_user_follower`, NOT `x_follower_count`.
  x_user_follower?: number; tg_call_count?: number; twitter_handle?: string;
  is_wash_trading?: boolean; sniper_count?: number; is_honeypot?: string;
  [key: string]: unknown; // catch-all — verify unfamiliar fields against a live response before relying on them
}
export interface GmgnTrenchesResult { new_creation?: GmgnTrenchesRow[]; near_completion?: GmgnTrenchesRow[]; completed?: GmgnTrenchesRow[]; }

/**
 * `market trenches` — new_creation / near_completion / completed, with server-side filters far
 * richer than trending (dev reputation, Twitter follower count, Telegram call count, insider/
 * bundler/rug ratios). `platforms` omitted = GMGN's own full default list for the chain (many
 * more launchpads than just Pump.fun — letsbonk, bags, believe, boop, moonshot_app, etc.).
 */
export async function gmgnTrenches(chain: string, types: string[], platforms?: string[], limit = 80, filters?: Record<string, number | string>): Promise<GmgnTrenchesResult | null> {
  return callProxy<GmgnTrenchesResult>("getTrenches", [chain, types, platforms, limit, filters]);
}

/** A developer wallet's full token-creation history — cross-checks our own on-chain actor-memory. */
export interface GmgnCreatedTokenEntry {
  token_address: string; symbol?: string; is_open?: boolean; market_cap?: string; pool_liquidity?: string;
  holders?: number; create_timestamp?: number;
  [key: string]: unknown;
}
export interface GmgnCreatorHistory {
  last_create_timestamp?: number; inner_count?: number; open_count?: number; open_ratio?: string;
  creator_ath_info?: { ath_token?: string; ath_mc?: string; token_symbol?: string };
  tokens: GmgnCreatedTokenEntry[];
}
/**
 * VERIFIED live shape (2026-07-27): `{last_create_timestamp, inner_count, open_count,
 * open_ratio, creator_ath_info, tokens:[...]}` — NOT `{list:[...]}` or a bare array as the
 * REST convention elsewhere in this file might suggest. `open_ratio` is the dev's overall
 * graduation rate across every token they've ever created — the reputation signal.
 */
export async function gmgnCreatedTokens(chain: string, walletAddress: string, extra: Record<string, string | number> = {}): Promise<GmgnCreatorHistory | null> {
  const r = await callProxy<GmgnCreatorHistory>("getCreatedTokens", [chain, walletAddress, extra]);
  return r && Array.isArray(r.tokens) ? r : null;
}
