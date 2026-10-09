import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { TokenBucket } from "../util/http.js";
import { ui, logRecord } from "../util/log.js";

/**
 * OKX OnchainOS REST adapter — FULL SURFACE.
 *
 * Phase 2 (2026-08-29): the owner's decision is to build every OKX Web3 capability, because the
 * incumbent fast-follow lane is measurably losing (cfg ou6ep0: 781 trades at -12.59% EV). This
 * module is therefore no longer a four-call shadow snapshot; it exposes token, market, trenches,
 * signal, social, portfolio and aggregator groups.
 *
 * This adapter never signs or broadcasts by itself. Transaction endpoints return unsigned data;
 * the execution layer may opt in to signing a Solana `/swap` response locally, behind the same
 * guardian and circuit-breaker used by the existing Jupiter route.
 *
 * ── THE HONESTY PROBLEM THIS FILE SOLVES ──────────────────────────────────────────────────────
 * As of this writing OKX has NEVER returned a single byte to this repo: `grep okx-enrichment
 * logs/*.jsonl` is empty and .env carries no OKX credentials. Every path below was therefore
 * either confirmed against OKX's published docs or inferred from the official `onchainos` CLI
 * command names — and inferred is not the same as true. Rather than let that difference hide
 * until a silent 60s-throttled warn() swallows it, each endpoint carries a `verified` flag and
 * `npm run okx:selftest -- --live` probes every one of them and prints which actually answer.
 * Unverified paths become measured facts on first contact instead of load-bearing guesses.
 */

const SOLANA_CHAIN_INDEX = "501";
const apiKey = process.env.OKX_API_KEY?.trim() ?? "";
const secretKey = process.env.OKX_SECRET_KEY?.trim() ?? "";
const passphrase = process.env.OKX_API_PASSPHRASE?.trim() ?? "";
const projectId = process.env.OKX_PROJECT_ID?.trim() ?? "";
/**
 * ONE BUCKET PER ENDPOINT. OKX rate-limits per endpoint, not per key, so a single shared bucket
 * made a leaderboard sweep wait behind an unrelated token read. config.okx.maxRps is now a CEILING
 * applied on top of each endpoint's own published allowance, not the allowance itself.
 */
const buckets = new Map<string, TokenBucket>();
function bucketFor(id: string, rps: number): TokenBucket {
  let b = buckets.get(id);
  if (!b) {
    // Published limits are hard ceilings, not safe targets. Keep 20% rolling-window headroom;
    // the first evenly-spaced 5 rps version still lost one of 24 radar cells to OKX 50011.
    const effectiveRps = Math.min(rps, config.okx.maxRps) * 0.8;
    // Capacity 1 deliberately removes the initial burst. TokenBucket.perSecond(5) starts with
    // five tokens and can issue ~9 calls in its first second as it refills; OKX uses a fixed
    // endpoint window and answered 50011/429 during the 24-cell radar sweep. Even spacing keeps
    // a steady cadence (with the headroom above) instead of losing a cell to the startup burst.
    b = new TokenBucket(1, effectiveRps / 1000);
    buckets.set(id, b);
  }
  return b;
}

export const okxEnabled = config.okx.enabled;
export const okxChainIndex = SOLANA_CHAIN_INDEX;

export type OkxQueryValue = string | number | boolean | undefined;
export type OkxQuery = Record<string, OkxQueryValue>;
type Query = OkxQuery;
type Method = "GET" | "POST";

interface OkxEnvelope<T> {
  code: string | number;
  msg?: string;
  data?: T;
  /** Quota/payment notices (OKX Agent Payments Protocol). Dropping these silently is how a
   *  "free quota exhausted" turns into an unexplained outage — so they are surfaced, not eaten. */
  notifications?: Array<{ code?: string; msg?: string; confirming?: boolean }>;
}

// ── ENDPOINT REGISTRY ─────────────────────────────────────────────────────────────────────────

export type OkxGroup = "token" | "market" | "trenches" | "signal" | "social" | "portfolio" | "balance" | "dex";

/** How the probe should synthesise sample arguments for this endpoint. "skip" = never call it. */
export type OkxProbeKind =
  | "none" | "chain" | "token" | "batchToken" | "stage" | "candles" | "search" | "search2"
  | "symbol" | "signal" | "leaderboard" | "wallet" | "walletToken" | "walletChains" | "quote"
  | "chainsPlural" | "tokenAddr" | "tokenWallet" | "cluster" | "keyword" | "balanceBody"
  | "newsId" | "hot" | "rwa" | "gasPrice" | "skip";

export interface OkxEndpointSpec {
  group: OkxGroup;
  method: Method;
  path: string;
  /**
   * OKX's published per-endpoint limit. Market/index/balance endpoints allow 5 rps and aggregator
   * endpoints 3 — NOT the single global 1 rps this adapter originally assumed, which was throttling
   * every sweep to a fifth of its allowance for no reason.
   */
  rps: number;
  probe: OkxProbeKind;
  /**
   * MEASURED against the live API — never copied from documentation. OKX's docs gave two paths
   * that 404 and omitted a dozen that work, so only a real response sets this.
   *
   *   "live"           answered code 0 with data
   *   "params-unknown" path exists (400/51000) but the request shape is unsolved
   *   "unavailable"    404, or not entitled on this key
   *   "unprobed"       never called yet — a write-path entry, or awaiting the next probe
   */
  status: "live" | "params-unknown" | "unavailable" | "unprobed";
  desc: string;
}

export const OKX_ENDPOINTS = {

  // ── token ─────────────────────────────────────────────────────────────────
  "token.advancedInfo": { group: "token", method: "GET", path: "/api/v6/dex/market/token/advanced-info", rps: 5, probe: "token", status: "live", desc: "risk / holder concentration / dev+sniper+bundle percentages" },
  "token.basicInfo": { group: "token", method: "POST", path: "/api/v6/dex/market/token/basic-info", rps: 5, probe: "batchToken", status: "live", desc: "name, symbol, decimals, supply" },
  "token.search": { group: "token", method: "GET", path: "/api/v6/dex/market/token/search", rps: 5, probe: "search", status: "live", desc: "search by name / symbol / address (params: chains, search)" },
  "token.holder": { group: "token", method: "GET", path: "/api/v6/dex/market/token/holder", rps: 5, probe: "token", status: "live", desc: "top holder addresses and balances" },
  "token.topTrader": { group: "token", method: "GET", path: "/api/v6/dex/market/token/top-trader", rps: 5, probe: "token", status: "live", desc: "top trader PnL on this token" },
  "token.hot": { group: "token", method: "GET", path: "/api/v6/dex/market/token/hot-token", rps: 5, probe: "hot", status: "live", desc: "trending / X-mentioned tokens; rankingType 4 or 5 is required" },
  "token.toplist": { group: "token", method: "GET", path: "/api/v6/dex/market/token/toplist", rps: 5, probe: "chainsPlural", status: "live", desc: "token ranking list (was mis-pathed as token/ranking)" },
  "token.topLiquidity": { group: "token", method: "GET", path: "/api/v6/dex/market/token/top-liquidity", rps: 5, probe: "token", status: "live", desc: "deepest-liquidity tokens (was mis-pathed as token/liquidity-pool)" },
  "cluster.list": { group: "token", method: "GET", path: "/api/v6/dex/market/token/cluster/list", rps: 5, probe: "token", status: "live", desc: "holder clusters — wallets moving together" },
  "cluster.overview": { group: "token", method: "GET", path: "/api/v6/dex/market/token/cluster/overview", rps: 5, probe: "token", status: "live", desc: "cluster distribution summary" },
  "cluster.topHolders": { group: "token", method: "GET", path: "/api/v6/dex/market/token/cluster/top-holders", rps: 5, probe: "cluster", status: "live", desc: "top-10/50/100 holder cluster analytics" },
  "cluster.chains": { group: "token", method: "GET", path: "/api/v6/dex/market/token/cluster/supported/chain", rps: 5, probe: "none", status: "live", desc: "chains supporting clustering" },

  // ── market ────────────────────────────────────────────────────────────────
  "market.price": { group: "market", method: "POST", path: "/api/v6/dex/market/price", rps: 5, probe: "batchToken", status: "live", desc: "single token price" },
  "market.priceInfo": { group: "market", method: "POST", path: "/api/v6/dex/market/price-info", rps: 5, probe: "batchToken", status: "live", desc: "batch price/mc/liquidity/holders — MAX 100 tokens" },
  "market.candles": { group: "market", method: "GET", path: "/api/v6/dex/market/candles", rps: 5, probe: "candles", status: "live", desc: "OHLC candles" },
  "market.histCandles": { group: "market", method: "GET", path: "/api/v6/dex/market/historical-candles", rps: 5, probe: "candles", status: "live", desc: "historical OHLC" },
  "market.trades": { group: "market", method: "GET", path: "/api/v6/dex/market/trades", rps: 5, probe: "token", status: "live", desc: "recent trade activity (NOT under /token/)" },
  "market.chains": { group: "market", method: "GET", path: "/api/v6/dex/market/supported/chain", rps: 5, probe: "none", status: "live", desc: "chains supported by the market API" },
  "index.current": { group: "market", method: "POST", path: "/api/v6/dex/index/current-price", rps: 5, probe: "batchToken", status: "live", desc: "aggregate index price" },
  "index.historical": { group: "market", method: "GET", path: "/api/v6/dex/index/historical-price", rps: 5, probe: "token", status: "live", desc: "historical index price" },
  "market.rwaTokens": { group: "market", method: "GET", path: "/api/v6/dex/market/rwa/tokens", rps: 5, probe: "rwa", status: "live", desc: "tokenized real-world assets; server currently requires category (47=all)" },

  // ── trenches ──────────────────────────────────────────────────────────────
  "trenches.tokenList": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/tokenList", rps: 5, probe: "stage", status: "live", desc: "NEW / MIGRATING (24h) and MIGRATED (3d) scans" },
  "trenches.details": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/tokenDetails", rps: 5, probe: "tokenWallet", status: "live", desc: "meme-token detail relative to a required walletAddress" },
  "trenches.devInfo": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/tokenDevInfo", rps: 5, probe: "token", status: "live", desc: "dev launch history, rug count, funding address" },
  "trenches.bundleInfo": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/tokenBundleInfo", rps: 5, probe: "token", status: "live", desc: "bundler / sniper concentration" },
  "trenches.apedWallet": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/apedWallet", rps: 5, probe: "token", status: "live", desc: "co-investor ('same car') wallets" },
  "trenches.similar": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/similarToken", rps: 5, probe: "token", status: "live", desc: "other tokens by the same creator" },
  "trenches.chains": { group: "trenches", method: "GET", path: "/api/v6/dex/market/memepump/supported/chainsProtocol", rps: 5, probe: "none", status: "live", desc: "launchpad protocol ids (was mis-pathed as memepump/chains)" },

  // ── signal ────────────────────────────────────────────────────────────────
  "signal.list": { group: "signal", method: "POST", path: "/api/v6/dex/market/signal/list", rps: 5, probe: "signal", status: "live", desc: "smart-money / whale / KOL buy signals (JSON ARRAY body)" },
  "signal.chains": { group: "signal", method: "GET", path: "/api/v6/dex/market/signal/supported/chain", rps: 5, probe: "none", status: "live", desc: "chains that emit signals (slash, not hyphen)" },
  "leaderboard.list": { group: "signal", method: "GET", path: "/api/v6/dex/market/leaderboard/list", rps: 5, probe: "leaderboard", status: "live", desc: "top traders — REQUIRES timeFrame+sortBy, 50 rows" },
  "leaderboard.chains": { group: "signal", method: "GET", path: "/api/v6/dex/market/leaderboard/supported/chain", rps: 5, probe: "none", status: "live", desc: "chains with a leaderboard" },

  // ── social ────────────────────────────────────────────────────────────────
  "social.newsLatest": { group: "social", method: "GET", path: "/api/v6/dex/market/social/news/latest", rps: 3, probe: "chain", status: "live", desc: "latest news feed" },
  "social.newsBySymbol": { group: "social", method: "GET", path: "/api/v6/dex/market/social/news/by-symbol", rps: 3, probe: "symbol", status: "live", desc: "news for one symbol" },
  "social.newsSearch": { group: "social", method: "GET", path: "/api/v6/dex/market/social/news/search", rps: 3, probe: "keyword", status: "live", desc: "full-text news search" },
  "social.newsDetail": { group: "social", method: "GET", path: "/api/v6/dex/market/social/news/detail", rps: 3, probe: "newsId", status: "live", desc: "full text of one news item" },
  "social.newsPlatforms": { group: "social", method: "GET", path: "/api/v6/dex/market/social/news/platforms", rps: 3, probe: "none", status: "live", desc: "news source platforms" },
  "social.sentimentRank": { group: "social", method: "GET", path: "/api/v6/dex/market/social/sentiment/ranking", rps: 3, probe: "chain", status: "live", desc: "market-wide sentiment ranking" },
  "social.sentimentSymbol": { group: "social", method: "GET", path: "/api/v6/dex/market/social/sentiment/symbol", rps: 3, probe: "symbol", status: "live", desc: "per-symbol sentiment" },
  "social.vibeTimeline": { group: "social", method: "GET", path: "/api/v6/dex/market/social/vibe/timeline", rps: 3, probe: "tokenAddr", status: "live", desc: "token hotness over time" },
  "social.vibeKols": { group: "social", method: "GET", path: "/api/v6/dex/market/social/vibe/top-kols", rps: 3, probe: "tokenAddr", status: "live", desc: "top KOLs talking about a token" },

  // ── portfolio ─────────────────────────────────────────────────────────────
  "portfolio.overview": { group: "portfolio", method: "GET", path: "/api/v6/dex/market/portfolio/overview", rps: 5, probe: "wallet", status: "live", desc: "wallet PnL / win rate (REQUIRES timeFrame)" },
  "portfolio.recentPnl": { group: "portfolio", method: "GET", path: "/api/v6/dex/market/portfolio/recent-pnl", rps: 5, probe: "wallet", status: "live", desc: "recent PnL (was mis-pathed as portfolio/pnl-list)" },
  "portfolio.tokenPnl": { group: "portfolio", method: "GET", path: "/api/v6/dex/market/portfolio/token/latest-pnl", rps: 5, probe: "walletToken", status: "live", desc: "per-token PnL for a wallet" },
  "portfolio.dexHistory": { group: "portfolio", method: "GET", path: "/api/v6/dex/market/portfolio/dex-history", rps: 5, probe: "wallet", status: "live", desc: "wallet DEX trade history (was portfolio/transaction-list)" },
  "portfolio.chains": { group: "portfolio", method: "GET", path: "/api/v6/dex/market/portfolio/supported/chain", rps: 5, probe: "none", status: "live", desc: "chains supporting address analysis" },

  // ── balance ───────────────────────────────────────────────────────────────
  "balance.allTokens": { group: "balance", method: "GET", path: "/api/v6/dex/balance/all-token-balances-by-address", rps: 5, probe: "walletChains", status: "live", desc: "every token balance for an address" },
  "balance.tokens": { group: "balance", method: "POST", path: "/api/v6/dex/balance/token-balances-by-address", rps: 5, probe: "balanceBody", status: "live", desc: "specific token balances" },
  "balance.totalValue": { group: "balance", method: "GET", path: "/api/v6/dex/balance/total-value-by-address", rps: 5, probe: "walletChains", status: "live", desc: "total portfolio value" },
  "balance.chains": { group: "balance", method: "GET", path: "/api/v6/dex/balance/supported/chain", rps: 5, probe: "none", status: "live", desc: "chains supporting balance reads" },

  // ── dex ───────────────────────────────────────────────────────────────────
  "dex.quote": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/quote", rps: 3, probe: "quote", status: "live", desc: "route + price impact, for comparison against Jupiter/GMGN" },
  "dex.allTokens": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/all-tokens", rps: 3, probe: "chain", status: "live", desc: "tokens the aggregator can route" },
  "dex.approve": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/approve-transaction", rps: 3, probe: "skip", status: "live", desc: "EVM-only unsigned ERC-20 approval transaction builder" },
  "dex.liquidity": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/get-liquidity", rps: 3, probe: "chain", status: "live", desc: "liquidity sources / DEXes" },
  "dex.chains": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/supported/chain", rps: 3, probe: "none", status: "live", desc: "chains the aggregator supports" },
  "dex.history": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/history", rps: 3, probe: "skip", status: "live", desc: "swap status by chainIndex + txHash" },
  "intent.auctionInfo": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/intent/auction-info", rps: 5, probe: "skip", status: "live", desc: "EVM intent-auction result by auctionId or txHash" },
  "intent.cancelOrder": { group: "dex", method: "POST", path: "/api/v6/dex/aggregator/intent/cancel-order", rps: 5, probe: "skip", status: "unprobed", desc: "EVM intent cancellation submission; requires wallet signature" },
  "intent.cancelSignData": { group: "dex", method: "POST", path: "/api/v6/dex/aggregator/intent/cancel-signdata", rps: 5, probe: "skip", status: "unprobed", desc: "build EIP-712 data for cancelling an intent order" },
  "intent.createOrder": { group: "dex", method: "POST", path: "/api/v6/dex/aggregator/intent/create-order", rps: 5, probe: "skip", status: "unprobed", desc: "submit an EIP-712-signed EVM intent order" },
  "intent.orderList": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/intent/order-list", rps: 5, probe: "skip", status: "live", desc: "EVM intent orders by walletAddress or orderUid" },
  "intent.orderStatus": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/intent/order-status", rps: 5, probe: "skip", status: "unprobed", desc: "EVM intent status by orderUid" },
  "post.txByHash": { group: "dex", method: "GET", path: "/api/v6/dex/post-transaction/transaction-detail-by-txhash", rps: 5, probe: "skip", status: "live", desc: "transaction detail by chainIndex + txHash" },
  "post.txByAddress": { group: "dex", method: "GET", path: "/api/v6/dex/post-transaction/transactions-by-address", rps: 5, probe: "skip", status: "live", desc: "transaction history by address + chains" },
  "pre.checkApprovals": { group: "dex", method: "POST", path: "/api/v6/dex/pre-transaction/check-approvals", rps: 3, probe: "skip", status: "live", desc: "EVM allowance preflight by address, chain and up to 10 tokens" },
  "pre.gasLimit": { group: "dex", method: "POST", path: "/api/v6/dex/pre-transaction/gas-limit", rps: 3, probe: "skip", status: "live", desc: "estimate gas/compute units from transaction data" },
  "pre.gasPrice": { group: "dex", method: "GET", path: "/api/v6/dex/pre-transaction/gas-price", rps: 3, probe: "gasPrice", status: "live", desc: "priority-fee tiers, including Solana microlamports per compute unit" },
  "pre.nonce": { group: "dex", method: "GET", path: "/api/v6/dex/pre-transaction/nonce", rps: 3, probe: "skip", status: "live", desc: "next account nonce by address + chainIndex" },
  "pre.simulate": { group: "dex", method: "POST", path: "/api/v6/dex/pre-transaction/simulate", rps: 3, probe: "skip", status: "live", desc: "simulate explicit transaction data; money path still uses its own RPC preflight" },
  "pre.chains": { group: "dex", method: "GET", path: "/api/v6/dex/pre-transaction/supported/chain", rps: 3, probe: "none", status: "live", desc: "chains the pre-transaction API supports" },
  "post.orders": { group: "dex", method: "GET", path: "/api/v6/dex/post-transaction/orders", rps: 3, probe: "skip", status: "live", desc: "broadcast-order status by address + chainIndex" },
  "dex.swap": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/swap", rps: 3, probe: "skip", status: "live", desc: "build an unsigned swap transaction; Solana tx.data is Base58" },
  "dex.swapInstruction": { group: "dex", method: "GET", path: "/api/v6/dex/aggregator/swap-instruction", rps: 3, probe: "skip", status: "live", desc: "build raw Solana swap instructions" },
  "dex.broadcast": { group: "dex", method: "POST", path: "/api/v6/dex/pre-transaction/broadcast-transaction", rps: 3, probe: "skip", status: "unprobed", desc: "broadcast an explicitly supplied signed tx; never called by broad probes" },
} as const satisfies Record<string, OkxEndpointSpec>;


export type OkxEndpointId = keyof typeof OKX_ENDPOINTS;

/** Ids measured as answering. Use this, not the raw key list, to decide what a consumer may
 *  depend on — an "unprobed" or "unavailable" id has no business behind a trading decision. */
export const OKX_LIVE_ENDPOINTS = (Object.keys(OKX_ENDPOINTS) as OkxEndpointId[])
  .filter((id) => (OKX_ENDPOINTS[id] as OkxEndpointSpec).status === "live");

// ── AUTH ──────────────────────────────────────────────────────────────────────────────────────

/** Stable query ordering means the bytes signed are always exactly the bytes sent. */
export function okxRequestPath(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

/** Public pure helper so the authentication contract can be fixture-tested without a network. */
export function okxSignature(
  timestamp: string,
  method: Method,
  requestPath: string,
  bodyText: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(timestamp + method + requestPath + bodyText)
    .digest("base64");
}

// ── REQUEST ───────────────────────────────────────────────────────────────────────────────────

const warningAt = new Map<string, number>();
function warn(key: string, message: string): void {
  const now = Date.now();
  if (now - (warningAt.get(key) ?? 0) < 60_000) return;
  warningAt.set(key, now);
  ui.warn(`[okx] ${message}`);
}

/** OKX returns these when the caller's IP is in a blocked region — a distinct failure from a bad
 *  path or a bad key, and one no amount of retrying fixes. Named so the logs say so. */
const REGION_BLOCK_CODES = new Set(["50125", "80001"]);

export interface OkxCallResult<T> {
  ok: boolean;
  data: T | null;
  httpStatus: number | null;
  code: string | null;
  msg: string | null;
  regionBlocked: boolean;
  quotaNotice: string | null;
  elapsedMs: number;
}

/** One authenticated call. Returns the full outcome so callers (and the selftest) can tell a
 *  404 path from a 401 key from a region block — `request()` below flattens it when unneeded. */
export async function okxCall<T>(
  id: OkxEndpointId,
  query: Query = {},
  body?: unknown,
  signal?: AbortSignal,
): Promise<OkxCallResult<T>> {
  const spec = OKX_ENDPOINTS[id] as OkxEndpointSpec;
  const started = Date.now();
  const miss = (msg: string): OkxCallResult<T> => ({
    ok: false, data: null, httpStatus: null, code: null, msg,
    regionBlocked: false, quotaNotice: null, elapsedMs: Date.now() - started,
  });
  if (!okxEnabled) return miss("disabled");
  if (signal?.aborted) return miss("aborted");

  const requestPath = okxRequestPath(spec.path, query);
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  await bucketFor(id, spec.rps).take();
  if (signal?.aborted) return miss("aborted");

  const timestamp = new Date().toISOString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.okx.timeoutMs);
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "OK-ACCESS-KEY": apiKey,
      "OK-ACCESS-SIGN": okxSignature(timestamp, spec.method, requestPath, bodyText, secretKey),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": passphrase,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (projectId) headers["OK-ACCESS-PROJECT"] = projectId;

    const res = await fetch(`${config.okx.baseUrl}${requestPath}`, {
      method: spec.method,
      headers,
      body: body === undefined ? undefined : bodyText,
      signal: ctrl.signal,
    });
    const envelope = (await res.json().catch(() => null)) as OkxEnvelope<T> | null;
    const code = envelope == null ? "invalid-json" : envelope.code == null ? null : String(envelope.code);
    const quotaNotice = envelope?.notifications?.map((n) => n.msg ?? n.code).filter(Boolean).join("; ") || null;
    const regionBlocked = code != null && REGION_BLOCK_CODES.has(code);
    const out: OkxCallResult<T> = {
      ok: res.ok && code === "0" && envelope?.data != null,
      data: envelope?.data ?? null,
      httpStatus: res.status,
      code,
      msg: envelope?.msg ?? null,
      regionBlocked,
      quotaNotice,
      elapsedMs: Date.now() - started,
    };
    if (quotaNotice) warn(`quota:${id}`, `${id}: quota notice — ${quotaNotice}`);
    if (regionBlocked) warn("region", `region-blocked (code ${code}) — OKX DEX is unavailable from this IP`);
    else if (!out.ok) warn(`${res.status}:${code ?? "none"}:${id}`, `${id} failed: HTTP ${res.status}, code ${code ?? "none"}, ${envelope?.msg ?? "no message"}`);
    return out;
  } catch (error) {
    if (signal?.aborted) return miss("aborted");
    const kind = (error as Error).name === "AbortError" ? "timeout" : "network";
    warn(`${kind}:${id}`, `${id} ${kind}: ${(error as Error).message}`);
    return miss(`${kind}: ${(error as Error).message}`);
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

/**
 * Flattened form for the common case: data, or null.
 *
 * GATED ON `ok`, NOT just on `data`. The first version returned `result.data` unconditionally,
 * and OKX answers some errors with HTTP 200 + code 51000 + a non-null, non-array `data`. That
 * slipped an object past a caller's `if (!page || page.length === 0)` guard — `.length` on an
 * object is undefined, which is neither falsy-checked nor equal to 0 — and crashed the radar
 * with "rows is not iterable". Any caller that trusts the return type needs the failure to be
 * null, not a shape that merely looks absent.
 */
async function request<T>(id: OkxEndpointId, query: Query = {}, body?: unknown, signal?: AbortSignal): Promise<T | null> {
  const r = await okxCall<T>(id, query, body, signal);
  return r.ok ? r.data : null;
}

/**
 * Credential preflight. `config.okx.enabled` deliberately does NOT require OKX_PROJECT_ID, but the
 * DEX API generally wants the OK-ACCESS-PROJECT header — a key set that passes the config gate and
 * then 401s on every call is the exact failure this reports up front instead of at 60s intervals.
 */
export function okxCredentialWarnings(): string[] {
  const out: string[] = [];
  if (!okxEnabled) out.push("OKX disabled (needs OKX_SHADOW_ENABLED=true plus key/secret/passphrase)");
  if (okxEnabled && !projectId) out.push("OKX_PROJECT_ID is empty — OK-ACCESS-PROJECT will be omitted and OKX may reject every call");
  return out;
}

// ── TYPES ─────────────────────────────────────────────────────────────────────────────────────

export interface OkxTokenAdvancedInfo {
  chainIndex?: string;
  createTime?: string;
  creatorAddress?: string;
  lpBurnedPercent?: string;
  riskControlLevel?: string;
  top10HoldPercent?: string;
  devHoldingPercent?: string;
  bundleHoldingPercent?: string;
  suspiciousHoldingPercent?: string;
  sniperHoldingPercent?: string;
  snipersClearAddressCount?: string;
  snipersTotal?: string;
  devRugPullTokenCount?: string;
  devCreateTokenCount?: string;
  devLaunchedTokenCount?: string;
  [key: string]: unknown;
}

export interface OkxTokenTradingInfo {
  chainIndex: string;
  tokenContractAddress: string;
  time?: string;
  price?: string;
  marketCap?: string;
  liquidity?: string;
  holders?: string;
  priceChange5M?: string;
  priceChange1H?: string;
  priceChange4H?: string;
  priceChange24H?: string;
  volume5M?: string;
  volume1H?: string;
  volume4H?: string;
  volume24H?: string;
  txs5M?: string;
  txs1H?: string;
  txs4H?: string;
  txs24H?: string;
  [key: string]: unknown;
}

export interface OkxTokenDeveloperInfo {
  devLaunchedInfo?: { totalToken?: string; rugPullCount?: string; migratedCount?: string; goldenGemCount?: string };
  devHoldingInfo?: { devHoldingPercent?: string; devAddress?: string; fundingAddress?: string; devBalance?: string; lastFundedTimestamp?: string };
}

export interface OkxTokenBundleInfo {
  bundlerAthPercent?: string;
  totalBundlers?: string;
  bundledValueNative?: string;
  bundledTokenAmount?: string;
}

export interface OkxApedWallet {
  walletAddress: string;
  walletType?: "SMART_MONEY" | "INFLUENCER" | "NORMAL" | string;
  holdingUsd?: string;
  holdingPercent?: string;
  totalPnl?: string;
  pnlPercent?: string;
}

/**
 * REAL shape, captured from a live tokenList response on 2026-08-29 — not from the docs.
 * The key correction: the field is `tokenAddress`, NOT `tokenContractAddress` as every other
 * endpoint in this API uses. An earlier version of this interface had the wrong name, which
 * would have made every trenches row parse to undefined without erroring.
 */
export interface OkxMemeToken {
  tokenAddress: string;
  chainIndex?: string;
  protocolId?: string;
  quoteTokenAddress?: string;
  symbol?: string;
  name?: string;
  logoUrl?: string;
  creatorAddress?: string;
  createdTimestamp?: string;
  migratedBeginTimestamp?: string;
  migratedEndTimestamp?: string;
  /** Bonding-curve progress as a percent string. Can be "" on a token that has not traded. */
  bondingPercent?: string;
  aped?: unknown;
  bagsFeeClaimed?: unknown;
  market?: {
    marketCapUsd?: string;
    volumeUsd1h?: string;
    txCount1h?: string;
    buyTxCount1h?: string;
    sellTxCount1h?: string;
  };
  /** Everything the setup gate cares about arrives here, pre-computed by OKX. */
  tags?: {
    totalHolders?: string;
    top10HoldingsPercent?: string;
    devHoldingsPercent?: string;
    bundlersPercent?: string;
    snipersPercent?: string;
    insidersPercent?: string;
    freshWalletsPercent?: string;
    suspectedPhishingWalletPercent?: string;
  };
  social?: {
    x?: string;
    website?: string;
    telegram?: string;
    communityTakeover?: boolean;
    dexScreenerPaid?: boolean;
    liveOnPumpFun?: boolean;
  };
  [key: string]: unknown;
}

export type OkxMemeStage = "NEW" | "MIGRATING" | "MIGRATED";

export interface OkxSignal {
  timestamp: string;
  chainIndex: string;
  token: { tokenAddress: string; symbol?: string; name?: string; logo?: string; marketCapUsd?: string; holders?: string; top10HolderPercent?: string };
  price?: string;
  walletType?: "SMART_MONEY" | "WHALE" | "INFLUENCER" | string;
  triggerWalletCount?: string;
  /** COMMA-SEPARATED list of the wallets that triggered this signal, not one address —
   *  confirmed on a live payload (3 wallets in one string). Use okxSignalWallets(). */
  triggerWalletAddress?: string;
  amountUsd?: string;
  soldRatioPercent?: string;
  cursor?: string;
}

/** Split the comma-joined trigger-wallet string into real addresses. */
export function okxSignalWallets(sig: Pick<OkxSignal, "triggerWalletAddress">): string[] {
  return (sig.triggerWalletAddress ?? "").split(",").map((w) => w.trim()).filter(Boolean);
}

export interface OkxLeaderboardWallet {
  walletAddress: string;
  realizedPnlUsd?: string;
  realizedPnlPercent?: string;
  winRatePercent?: string;
  avgBuyValueUsd?: string;
  txVolume?: string;
  txs?: string;
  lastActiveTimestamp?: string;
  topPnlTokenList?: Array<{
    tokenContractAddress: string;
    tokenSymbol?: string;
    // OKX's docs spell these with a capital L (tokenPnLUsd) while earlier drafts of this file
    // used tokenPnlUsd. Both are declared so a casing mismatch degrades to one missing field
    // instead of silently reading undefined on every row.
    tokenPnLUsd?: string;
    tokenPnlUsd?: string;
    tokenPnLPercent?: string;
    tokenPnlPercent?: string;
  }>;
}

export interface OkxDexQuote {
  chainIndex?: string;
  fromTokenAmount?: string;
  toTokenAmount?: string;
  tradeFee?: string;
  estimateGasFee?: string;
  priceImpactPercent?: string;
  dexRouterList?: unknown[];
  fromToken?: { tokenContractAddress?: string; tokenSymbol?: string; decimal?: string; isHoneyPot?: boolean; taxRate?: string };
  toToken?: { tokenContractAddress?: string; tokenSymbol?: string; decimal?: string; isHoneyPot?: boolean; taxRate?: string };
  [key: string]: unknown;
}

export interface OkxWalletOverview {
  walletAddress?: string;
  realizedPnlUsd?: string;
  unrealizedPnlUsd?: string;
  totalPnlUsd?: string;
  winRatePercent?: string;
  txs?: string;
  txVolumeUsd?: string;
  avgBuyValueUsd?: string;
  [key: string]: unknown;
}

export interface OkxWalletDexTransaction {
  type: "1" | "2" | "3" | "4" | string;
  chainIndex?: string;
  tokenContractAddress: string;
  tokenSymbol?: string;
  valueUsd?: string;
  amount?: string;
  price?: string;
  marketCap?: string;
  pnlUsd?: string;
  time?: string;
  [key: string]: unknown;
}

export interface OkxWalletDexHistory {
  cursor?: string;
  transactionList?: OkxWalletDexTransaction[];
}

/**
 * Live shape returned by token/toplist. Unlike memepump/tokenList it uses
 * tokenContractAddress + firstTradeTime and carries market activity but no actor profile.
 */
export interface OkxRankedToken {
  chainIndex?: string;
  tokenContractAddress: string;
  tokenSymbol?: string;
  firstTradeTime?: string;
  price?: string;
  marketCap?: string;
  liquidity?: string;
  holders?: string;
  volume?: string;
  change?: string;
  txs?: string;
  txsBuy?: string;
  txsSell?: string;
  uniqueTraders?: string;
  [key: string]: unknown;
}

/** One row returned by `/aggregator/swap`. On Solana `tx.data` is a Base58 serialized tx. */
export interface OkxSwapData {
  routerResult?: OkxDexQuote;
  tx?: {
    data?: string;
    from?: string;
    to?: string;
    value?: string;
    gas?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Normalise the PnL casing ambiguity above at the one place it matters. */
export function okxTopTokenPnl(row: NonNullable<OkxLeaderboardWallet["topPnlTokenList"]>[number]): { usd: number | null; pct: number | null } {
  const num = (v?: string) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return { usd: num(row.tokenPnLUsd ?? row.tokenPnlUsd), pct: num(row.tokenPnLPercent ?? row.tokenPnlPercent) };
}

// ── TOKEN ─────────────────────────────────────────────────────────────────────────────────────

export function okxTokenAdvancedInfo(mint: string, signal?: AbortSignal): Promise<OkxTokenAdvancedInfo | null> {
  return request("token.advancedInfo", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}

export async function okxTokenTradingInfo(mints: string[], signal?: AbortSignal): Promise<OkxTokenTradingInfo[] | null> {
  // MAX 100 per call is OKX's documented cap, not a guess — slicing here keeps a caller that
  // hands over a whole watchlist from silently losing the tail.
  const unique = [...new Set(mints.filter(Boolean))].slice(0, 100);
  if (unique.length === 0) return [];
  return request("market.priceInfo", {}, unique.map((mint) => ({ chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint })), signal);
}

export function okxTokenBasicInfo(mints: string[], signal?: AbortSignal): Promise<unknown[] | null> {
  const unique = [...new Set(mints.filter(Boolean))].slice(0, 100);
  if (unique.length === 0) return Promise.resolve([]);
  return request("token.basicInfo", {}, unique.map((mint) => ({ chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint })), signal);
}

/** NOTE the parameter names: `chains` and `search`, not chainIndex/keyword. OKX is not uniform. */
export function okxTokenSearch(q: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("token.search", { chains: SOLANA_CHAIN_INDEX, search: q }, undefined, signal);
}
export function okxTokenHolders(mint: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("token.holder", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export function okxTokenTopTraders(mint: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("token.topTrader", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export function okxTokenTrades(mint: string, filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("market.trades", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint, ...filters }, undefined, signal);
}
export function okxTokenRanking(filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("token.toplist", { chainIndex: SOLANA_CHAIN_INDEX, ...filters }, undefined, signal);
}
export function okxHotTokens(filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("token.hot", {
    rankingType: "4", // 4=trending, 5=X-mentioned; required by the API
    chainIndex: SOLANA_CHAIN_INDEX,
    rankBy: "15", // OKX token score
    rankingTimeFrame: "2", // one hour
    limit: "100",
    ...filters,
  }, undefined, signal);
}
export function okxTokenLiquidity(mint: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("token.topLiquidity", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export function okxCandles(mint: string, bar = "1m", limit = 100, signal?: AbortSignal): Promise<unknown | null> {
  return request("market.candles", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint, bar, limit }, undefined, signal);
}
/** POST with an array body, and on /dex/index/ — the one endpoint that breaks both conventions. */
export function okxIndexPrice(mints: string[], signal?: AbortSignal): Promise<unknown | null> {
  const unique = [...new Set(mints.filter(Boolean))].slice(0, 100);
  if (unique.length === 0) return Promise.resolve([]);
  return request("index.current", {}, unique.map((m) => ({ chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: m })), signal);
}

export function okxRwaTokens(filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("market.rwaTokens", { category: "47", limit: "100", ...filters }, undefined, signal);
}

// ── TRENCHES ──────────────────────────────────────────────────────────────────────────────────

export function okxTrenchChains(signal?: AbortSignal): Promise<unknown | null> {
  return request("trenches.chains", {}, undefined, signal);
}

/**
 * Trenches scan.
 *
 * MEASURED SHAPE, and it is not what the earlier wrapper assumed. `data` is a BARE ARRAY of
 * rows — there is no `{ cursor, items }` envelope. The previous version returned null unless
 * `data.items` was an array, so it returned null on every single call while the endpoint was
 * answering perfectly. It had no caller yet, which is the only reason this went unnoticed: a
 * scanner built on it would have silently found nothing and looked like a quiet market.
 *
 * Two further measured facts:
 *  - `limit` is IGNORED. Asking for 5 returns 30. Treat the page size as fixed.
 *  - There is NO cursor anywhere in the response, so this endpoint cannot be paged. What you
 *    get is the newest 30; anything older has to be caught by polling often enough.
 */
export async function okxMemeTokens(
  stage: OkxMemeStage,
  filters: Query = {},
  signal?: AbortSignal,
): Promise<OkxMemeToken[] | null> {
  const data = await request<OkxMemeToken[]>(
    "trenches.tokenList",
    { ...filters, chainIndex: SOLANA_CHAIN_INDEX, stage },
    undefined,
    signal,
  );
  return Array.isArray(data) ? data : null;
}

/** Age in ms of a trenches row at a given instant, or null when the timestamp is unusable. */
export function okxMemeTokenAgeMs(t: OkxMemeToken, now = Date.now()): number | null {
  const created = Number(t.createdTimestamp ?? 0);
  if (!Number.isFinite(created) || created <= 0) return null;
  const age = now - created;
  return age >= 0 ? age : null;
}

export function okxTokenDetails(mint: string, walletAddress: string, signal?: AbortSignal): Promise<unknown | null> {
  if (!walletAddress) return Promise.resolve(null);
  return request("trenches.details", {
    chainIndex: SOLANA_CHAIN_INDEX,
    tokenContractAddress: mint,
    walletAddress,
  }, undefined, signal);
}
export function okxTokenDeveloperInfo(mint: string, signal?: AbortSignal): Promise<OkxTokenDeveloperInfo | null> {
  return request("trenches.devInfo", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export function okxTokenBundleInfo(mint: string, signal?: AbortSignal): Promise<OkxTokenBundleInfo | null> {
  return request("trenches.bundleInfo", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export function okxSimilarTokens(mint: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("trenches.similar", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export async function okxTokenApedWallets(mint: string, signal?: AbortSignal): Promise<OkxApedWallet[] | null> {
  const data = await request<{ apedWalletList?: OkxApedWallet[] }>(
    "trenches.apedWallet",
    { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint },
    undefined,
    signal,
  );
  return Array.isArray(data?.apedWalletList) ? data.apedWalletList : null;
}

// ── SIGNAL + LEADERBOARD ──────────────────────────────────────────────────────────────────────

export function okxSignalChains(signal?: AbortSignal): Promise<unknown | null> {
  return request("signal.chains", {}, undefined, signal);
}

/** NOTE: this endpoint is POST with a JSON ARRAY body — verified against OKX docs, not a typo. */
export function okxLatestSignals(filters: Query = {}, signal?: AbortSignal): Promise<OkxSignal[] | null> {
  return request("signal.list", {}, [{
    chainIndex: SOLANA_CHAIN_INDEX,
    walletType: "1,2,3",
    limit: "100",
    ...filters,
  }], signal);
}

export function okxLeaderboardChains(signal?: AbortSignal): Promise<unknown | null> {
  return request("leaderboard.chains", {}, undefined, signal);
}

/**
 * Leaderboard wallet-type codes from OKX's published API contract. These are deliberately named
 * "leaderboard" because Signal API uses a different 1/2/3 enum (Smart Money/KOL/Whale).
 */
export const OKX_WALLET_TYPES = {
  kol: "1",
  developer: "2",
  smartMoney: "3",
  whale: "4",
  newWallet: "5",
  insider: "6",
  sniper: "7",
  suspectedPhishing: "8",
  bundledTrader: "9",
  pumpSmartMoney: "10",
} as const;

const OKX_WALLET_TYPE_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(OKX_WALLET_TYPES).map(([label, code]) => [code, label])),
) as unknown as Readonly<Record<string, keyof typeof OKX_WALLET_TYPES>>;

export function okxLeaderboardWalletTypeLabel(code: string): keyof typeof OKX_WALLET_TYPES | null {
  return OKX_WALLET_TYPE_LABELS[code] ?? null;
}

/** Recover authoritative codes from persisted radar cells, including cells written before the
 * labels were corrected. The integer in `label(code)/sort/timeframe` has always been authoritative.
 */
export function okxLeaderboardWalletTypeCodes(cells: readonly string[], explicit: readonly string[] = []): string[] {
  const codes = new Set(explicit.filter((code) => okxLeaderboardWalletTypeLabel(code) !== null));
  for (const cell of cells) {
    const code = /\((\d+)\)\//.exec(cell)?.[1];
    if (code && okxLeaderboardWalletTypeLabel(code)) codes.add(code);
  }
  return [...codes].sort((a, b) => Number(a) - Number(b));
}

/**
 * Top traders.
 *
 * MEASURED: returns 50 rows per call, not the 20 the docs state. `timeFrame` and `sortBy` are
 * both REQUIRED — omitting timeFrame returns 51000, it does not default.
 * timeFrame: 1=1D 2=3D 3=7D 4=1M 5=3M · sortBy: 1=PnL 2=WinRate 3=Txs 4=Volume 5=ROI
 */
export function okxSmartMoneyLeaderboard(filters: Query = {}, signal?: AbortSignal): Promise<OkxLeaderboardWallet[] | null> {
  return request("leaderboard.list", { chainIndex: SOLANA_CHAIN_INDEX, timeFrame: "3", sortBy: "1", ...filters }, undefined, signal);
}

// ── SOCIAL ────────────────────────────────────────────────────────────────────────────────────

export function okxNews(filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("social.newsLatest", filters, undefined, signal);
}
export function okxSentiment(filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("social.sentimentRank", filters, undefined, signal);
}
export function okxTokenVibe(mint: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("social.vibeTimeline", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}
export function okxTokenKols(mint: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("social.vibeKols", { chainIndex: SOLANA_CHAIN_INDEX, tokenContractAddress: mint }, undefined, signal);
}

// ── ADDRESS / PORTFOLIO ───────────────────────────────────────────────────────────────────────

export function okxPortfolioChains(signal?: AbortSignal): Promise<unknown | null> {
  return request("portfolio.chains", {}, undefined, signal);
}
/** timeFrame is REQUIRED here — omitting it returns 51000 "timeFrame param error", not a default. */
export function okxWalletOverview(wallet: string, timeFrame = "3", signal?: AbortSignal): Promise<OkxWalletOverview | null> {
  return request("portfolio.overview", { chainIndex: SOLANA_CHAIN_INDEX, walletAddress: wallet, timeFrame }, undefined, signal);
}
export function okxWalletPnlList(wallet: string, filters: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("portfolio.recentPnl", { chainIndex: SOLANA_CHAIN_INDEX, walletAddress: wallet, ...filters }, undefined, signal);
}
export function okxWalletTransactions(wallet: string, filters: Query = {}, signal?: AbortSignal): Promise<OkxWalletDexHistory | null> {
  return request("portfolio.dexHistory", { chainIndex: SOLANA_CHAIN_INDEX, walletAddress: wallet, ...filters }, undefined, signal);
}

// ── AGGREGATOR + TRANSACTION TOOLBOX ──────────────────────────────────────────────────────────

/** Quote only: useful for route/price-impact comparison, never builds or submits a transaction. */
export function okxDexQuote(
  fromTokenAddress: string,
  toTokenAddress: string,
  amountRaw: string,
  options: Query = {},
  signal?: AbortSignal,
): Promise<OkxDexQuote[] | null> {
  return request("dex.quote", {
    amount: amountRaw,
    chainIndex: SOLANA_CHAIN_INDEX,
    fromTokenAddress,
    toTokenAddress,
    swapMode: "exactIn",
    ...options,
  }, undefined, signal);
}

export function okxDexTokens(chainIndex = SOLANA_CHAIN_INDEX, signal?: AbortSignal): Promise<unknown | null> {
  return request("dex.allTokens", { chainIndex }, undefined, signal);
}

export function okxDexLiquidity(chainIndex = SOLANA_CHAIN_INDEX, signal?: AbortSignal): Promise<unknown | null> {
  return request("dex.liquidity", { chainIndex }, undefined, signal);
}

/** EVM only: returns unsigned ERC-20 approval calldata; it never submits the approval. */
export function okxApproveTransaction(
  chainIndex: string,
  tokenContractAddress: string,
  approveAmount: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  return request("dex.approve", { chainIndex, tokenContractAddress, approveAmount }, undefined, signal);
}

/** Build an unsigned swap. The execution layer is the only place allowed to sign it. */
export function okxBuildSwap(
  fromTokenAddress: string,
  toTokenAddress: string,
  amountRaw: string,
  userWalletAddress: string,
  options: Query = {},
  signal?: AbortSignal,
): Promise<OkxSwapData[] | null> {
  return request("dex.swap", {
    chainIndex: SOLANA_CHAIN_INDEX,
    amount: amountRaw,
    fromTokenAddress,
    toTokenAddress,
    userWalletAddress,
    swapMode: "exactIn",
    slippagePercent: String(config.okx.slippagePercent),
    ...options,
  }, undefined, signal);
}

export function okxBuildSwapInstructions(
  fromTokenAddress: string,
  toTokenAddress: string,
  amountRaw: string,
  userWalletAddress: string,
  options: Query = {},
  signal?: AbortSignal,
): Promise<unknown | null> {
  return request("dex.swapInstruction", {
    chainIndex: SOLANA_CHAIN_INDEX,
    amount: amountRaw,
    fromTokenAddress,
    toTokenAddress,
    userWalletAddress,
    swapMode: "exactIn",
    slippagePercent: String(config.okx.slippagePercent),
    ...options,
  }, undefined, signal);
}

export function okxDexHistory(chainIndex: string, txHash: string, isFromMyProject = false, signal?: AbortSignal): Promise<unknown | null> {
  return request("dex.history", { chainIndex, txHash, isFromMyProject }, undefined, signal);
}

export function okxIntentAuctionInfo(query: { auctionId?: string; txHash?: string }, signal?: AbortSignal): Promise<unknown | null> {
  return request("intent.auctionInfo", query, undefined, signal);
}

export function okxIntentOrderList(query: { userWalletAddress?: string; orderUid?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<unknown | null> {
  return request("intent.orderList", query, undefined, signal);
}

export function okxIntentOrderStatus(orderUid: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("intent.orderStatus", { orderUid }, undefined, signal);
}

/** EVM-only write-adjacent wrappers. Callers must supply already-signed EIP-712 material. */
export function okxCreateIntentOrder(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown | null> {
  return request("intent.createOrder", {}, body, signal);
}
export function okxIntentCancelSignData(userWalletAddress: string, orderUid: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("intent.cancelSignData", {}, { userWalletAddress, orderUid }, signal);
}
export function okxCancelIntentOrder(userWalletAddress: string, orderUid: string, signature: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("intent.cancelOrder", {}, { userWalletAddress, orderUid, signature }, signal);
}

export function okxGasPrice(chainIndex = SOLANA_CHAIN_INDEX, signal?: AbortSignal): Promise<unknown | null> {
  return request("pre.gasPrice", { chainIndex }, undefined, signal);
}
export function okxGasLimit(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown | null> {
  return request("pre.gasLimit", {}, body, signal);
}
export function okxCheckApprovals(
  address: string,
  chainIndex: string,
  tokenContractAddresses: string[],
  signal?: AbortSignal,
): Promise<unknown | null> {
  const tokens = [...new Set(tokenContractAddresses.filter(Boolean))].slice(0, 10)
    .map((tokenContractAddress) => ({ tokenContractAddress }));
  if (!address || !chainIndex || tokens.length === 0) return Promise.resolve(null);
  return request("pre.checkApprovals", {}, { address, chainIndex, tokens }, signal);
}
export function okxTransactionNonce(address: string, chainIndex: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("pre.nonce", { address, chainIndex }, undefined, signal);
}
export function okxSimulateTransaction(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown | null> {
  return request("pre.simulate", {}, body, signal);
}
export function okxBroadcastTransaction(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown | null> {
  return request("dex.broadcast", {}, body, signal);
}
export function okxPostOrders(address: string, chainIndex: string, options: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("post.orders", { address, chainIndex, ...options }, undefined, signal);
}
export function okxTransactionByHash(chainIndex: string, txHash: string, signal?: AbortSignal): Promise<unknown | null> {
  return request("post.txByHash", { chainIndex, txHash }, undefined, signal);
}
export function okxTransactionsByAddress(address: string, chains: string, options: Query = {}, signal?: AbortSignal): Promise<unknown | null> {
  return request("post.txByAddress", { address, chains, ...options }, undefined, signal);
}

// ── POST-OPEN SHADOW SNAPSHOT (unchanged contract — trader.ts depends on this) ────────────────

export interface OkxShadowSnapshot {
  advanced: OkxTokenAdvancedInfo | null;
  market: OkxTokenTradingInfo | null;
  developer: OkxTokenDeveloperInfo | null;
  bundle: OkxTokenBundleInfo | null;
}

/** Four independent reads; partial data is retained when one premium endpoint is unavailable. */
export async function okxTokenShadowSnapshot(mint: string, signal?: AbortSignal): Promise<OkxShadowSnapshot | null> {
  if (!okxEnabled) return null;
  const [advanced, marketRows, developer, bundle] = await Promise.all([
    okxTokenAdvancedInfo(mint, signal),
    okxTokenTradingInfo([mint], signal),
    okxTokenDeveloperInfo(mint, signal),
    okxTokenBundleInfo(mint, signal),
  ]);
  const market = marketRows?.find((row) => row.tokenContractAddress === mint) ?? marketRows?.[0] ?? null;
  return advanced || market || developer || bundle ? { advanced, market, developer, bundle } : null;
}

/**
 * Probe every registered endpoint once, deriving arguments from each spec's `probe` kind.
 *
 * WHY ARGUMENTS ARE PER-KIND AND NOT GENERIC. An earlier version sent a bare {chainIndex} to
 * everything and four working endpoints reported as broken: a 400 saying "parameter required" is
 * the server telling you the PATH IS RIGHT, and only a 404 says otherwise. Misreading the first
 * as the second is precisely the failure this probe exists to prevent.
 *
 * WRITE-PATH AND ORDER-SPECIFIC ENDPOINTS ARE NEVER CALLED. `probe: "skip"` keeps unsigned
 * builders, broadcast, intent mutation and private order lookups out of a broad probe sweep.
 */
export async function okxProbeAll(sampleMint: string, sampleWallet: string): Promise<Array<{ id: string; spec: OkxEndpointSpec; result: OkxCallResult<unknown> }>> {
  const C = SOLANA_CHAIN_INDEX;
  const OKX_NATIVE_SOL = "11111111111111111111111111111111";
  const tok = { chainIndex: C, tokenContractAddress: sampleMint };
  // The fixed probe mint can age out of the Trenches detail index. tokenList is probed first;
  // when it answers, its newest row becomes the detail target later in the same sweep.
  let currentMemeMint = sampleMint;

  const argsFor = (spec: OkxEndpointSpec): { query: Query; body?: unknown } => {
    switch (spec.probe) {
      case "none":        return { query: {} };
      case "chain":       return { query: { chainIndex: C, limit: "10" } };
      case "token":       return { query: tok };
      case "tokenWallet": return { query: { chainIndex: C, tokenContractAddress: currentMemeMint, walletAddress: sampleWallet } };
      case "batchToken":  return { query: {}, body: [tok] };
      case "stage":       return { query: { chainIndex: C, stage: "NEW", limit: "10" } };
      case "candles":     return { query: { ...tok, bar: "1m", limit: "10" } };
      case "search":      return { query: { chains: C, search: "sol" } };
      case "search2":     return { query: { chainIndex: C, search: "solana", limit: "5" } };
      // Parameter names below are what the server ITSELF asked for in its 400s — `chains` plural,
      // `tokenSymbols`, `keyword`, `tokenAddress` (not tokenContractAddress), `rangeFilter`.
      // OKX is not internally consistent about any of them.
      case "symbol":      return { query: { chainIndex: C, tokenSymbols: "SOL", limit: "5" } };
      // sortBy is 2=change / 5=volume / 6=market cap — the server enumerated them in its own 51000.
      case "chainsPlural":return { query: { chains: C, sortBy: "5", timeFrame: "1", limit: "10" } };
      case "hot":         return { query: { rankingType: "4", chainIndex: C, rankBy: "15", rankingTimeFrame: "2", limit: "10" } };
      case "rwa":         return { query: { category: "47", limit: "10" } };
      case "gasPrice":    return { query: { chainIndex: C } };
      case "tokenAddr":   return { query: { chainIndex: C, tokenAddress: sampleMint } };
      case "cluster":     return { query: { ...tok, rangeFilter: "1" } };
      case "keyword":     return { query: { chainIndex: C, keyword: "solana", limit: "5" } };
      case "balanceBody": return { query: {}, body: { address: sampleWallet, tokenContractAddresses: [{ chainIndex: C, tokenContractAddress: sampleMint }] } };
      // No stable sample id exists for a news item, so this one can only fail cleanly here; it is
      // exercised for real by feeding it an id from social.newsLatest.
      case "newsId":      return { query: { chainIndex: C, articleId: "1" } };
      case "signal":      return { query: {}, body: [{ chainIndex: C, limit: "1" }] };
      case "leaderboard": return { query: { chainIndex: C, timeFrame: "3", sortBy: "1" } };
      case "wallet":      return { query: { chainIndex: C, walletAddress: sampleWallet, timeFrame: "3" } };
      case "walletToken": return { query: { chainIndex: C, walletAddress: sampleWallet, tokenContractAddress: sampleMint } };
      case "walletChains":return { query: { chains: C, address: sampleWallet } };
      case "quote":       return { query: { chainIndex: C, amount: "100000000", swapMode: "exactIn", fromTokenAddress: OKX_NATIVE_SOL, toTokenAddress: sampleMint } };
      default:            return { query: { chainIndex: C } };
    }
  };

  const out: Array<{ id: string; spec: OkxEndpointSpec; result: OkxCallResult<unknown> }> = [];
  for (const id of Object.keys(OKX_ENDPOINTS) as OkxEndpointId[]) {
    const spec = OKX_ENDPOINTS[id] as OkxEndpointSpec;
    if (spec.probe === "skip") continue;
    const { query, body } = argsFor(spec);
    const result = await okxCall<unknown>(id, query, body);
    if (id === "trenches.tokenList" && Array.isArray(result.data)) {
      const newest = result.data[0] as { tokenAddress?: unknown } | undefined;
      if (typeof newest?.tokenAddress === "string" && newest.tokenAddress) currentMemeMint = newest.tokenAddress;
    }
    out.push({ id, spec, result });
    logRecord("events", {
      type: "okx-endpoint-probe", id, group: spec.group, method: spec.method, path: spec.path,
      rps: spec.rps, recordedStatus: spec.status, ok: result.ok, httpStatus: result.httpStatus,
      code: result.code, msg: result.msg, regionBlocked: result.regionBlocked, elapsedMs: result.elapsedMs,
    });
  }
  return out;
}
