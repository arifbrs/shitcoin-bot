import { TokenBucket } from "../util/http.js";

/**
 * Solana Tracker Data API — used DELIBERATELY SPARINGLY, once per candidate at entry.
 *
 * BUDGET IS THE WHOLE DESIGN CONSTRAINT (owner, 2026-07-31). The free plan is documented at
 * 10,000 requests/month and 3 req/sec. Checking `/subscription` — an endpoint this project did
 * not know existed until the docs were actually read — showed the two keys already in `.env` at
 * NEGATIVE credits (-29, -9) with resets not until 2026-08-25 and 2026-08-29. In other words the
 * Data API had been dead for weeks and would stay dead for a month, which is the real reason
 * marks had been falling through to Jupiter/DexScreener and picking up junk. A third key with
 * 2,500 credits is what makes this module possible at all.
 *
 * So this is NOT in the mark path. Marking runs every 8s per open position; at that rate any
 * quota here is gone in hours. Marks stay on raptor (free, unmetered — see raptor.ts). This runs
 * exactly once per candidate that has already cleared every cheap gate, where one call buys a
 * lot: price, market cap, liquidity, supply, decimals, holder count, buy/sell counts, LP burn,
 * mint/freeze authority, 12 timeframes of price change, and a full risk block (sniper, insider,
 * bundler and top-10 concentration, plus a rugged flag and score) — replacing what would
 * otherwise be several separate lookups.
 *
 * ACCURACY VERIFIED BEFORE USE, not assumed. Cross-checked against GMGN on 8 live tokens at the
 * same moment: price and market cap agreed to within -0.45%..+2.53% (most under 1.3%), liquidity
 * within ~1%, and holder counts were essentially identical (1564/1564, 2050/2050, 1982/1983).
 * The one outlier was a $1.3k-market-cap corpse whose liquidity the two sources disagree wildly
 * on — far below Strategy 2's band, and rejected by the liveness gate long before this runs.
 *
 * MEASUREMENT, NOT GATING. Everything here is recorded onto the open event so the risk fields can
 * be correlated against real outcomes later. None of it blocks an entry yet. That restraint is
 * deliberate: the documented `bundlers` data was checked against six real closes and did NOT
 * separate winners from rugs — UNAWARE, the +25.77% winner, showed 352 bundler wallets and 68.9%
 * bundled supply, more than every confirmed rug in the sample. Wiring that into a gate on n=6
 * would have rejected the best trade of the day. Same mistake as the first ATH gate; not repeating it.
 */

const HOST = "https://data.solanatracker.io";

// Documented free-plan limit is 3 req/sec. Deliberately set to 2: this only ever fires on entry,
// so the headroom costs nothing and a 429 here means losing a candidate.
const bucket = TokenBucket.perSecond(2);

interface StPool {
  price?: { usd?: number }; marketCap?: { usd?: number }; liquidity?: { usd?: number };
  tokenSupply?: number; decimals?: number; lpBurn?: number; market?: string;
  security?: { freezeAuthority?: string | null; mintAuthority?: string | null };
}
interface StRiskGroup { count?: number; totalPercentage?: number }
interface StTokenResponse {
  pools?: StPool[]; holders?: number; buys?: number; sells?: number; txns?: number;
  events?: Record<string, { priceChangePercentage?: number }>;
  risk?: {
    rugged?: boolean; score?: number; top10?: number;
    snipers?: StRiskGroup; insiders?: StRiskGroup; bundlers?: StRiskGroup;
    risks?: Array<{ name?: string; level?: string; value?: string }>;
  };
}

export interface StSnapshot {
  priceUsd: number; mcUsd: number; liqUsd: number; supply: number; decimals: number;
  holders: number | null; buys: number | null; sells: number | null;
  lpBurn: number | null; market: string | null;
  freezeAuthority: string | null; mintAuthority: string | null;
  rugged: boolean | null; riskScore: number | null; top10Pct: number | null;
  sniperCount: number | null; sniperPct: number | null;
  insiderCount: number | null; insiderPct: number | null;
  bundlerCount: number | null; bundlerPct: number | null;
  dangerFlags: string[];
  change5mPct: number | null; change1hPct: number | null;
}

/** Keys are tried in order; the third was added because the first two are exhausted until late August. */
function keys(): string[] {
  return [
    process.env.SOLTRACKER_API_KEY_3?.trim(),
    process.env.SOLTRACKER_API_KEY?.trim(),
    process.env.SOLTRACKER_API_KEY_2?.trim(),
  ].filter((k): k is string => Boolean(k));
}

export const solanaTrackerEnabled = (): boolean => keys().length > 0;

/** Remaining credits for the first usable key, or null if it can't be read. */
export async function stCredits(): Promise<number | null> {
  const [key] = keys();
  if (!key) return null;
  try {
    await bucket.take();
    const r = await fetch(`${HOST}/credits`, { headers: { "x-api-key": key } });
    if (!r.ok) return null;
    const j = (await r.json()) as { credits?: number };
    return typeof j.credits === "number" ? j.credits : null;
  } catch { return null; }
}

/**
 * One full token snapshot. Returns null rather than a partial guess if the essential numbers
 * (price, supply, decimals) aren't all present and sane — same fail-closed posture as every other
 * data path in this project.
 */
export async function stTokenSnapshot(mint: string, timeoutMs = 8_000): Promise<StSnapshot | null> {
  for (const key of keys()) {
    await bucket.take();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let body: StTokenResponse | null = null;
    try {
      const r = await fetch(`${HOST}/tokens/${mint}`, { headers: { "x-api-key": key }, signal: ctrl.signal });
      // 403 = insufficient credits on THIS key, 429 = rate limited. Both mean "try the next key"
      // rather than "this token has no data" — conflating those is how a spent key silently looks
      // like a missing token.
      if (!r.ok) continue;
      body = (await r.json()) as StTokenResponse;
    } catch {
      continue;
    } finally {
      clearTimeout(t);
    }

    // Deepest pool is the one that actually prices the token; the rest are usually dust or
    // abandoned micro-pools (the same lesson that produced the dead-pool filter in token-market.ts).
    const pool = (body?.pools ?? []).slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const priceUsd = Number(pool?.price?.usd);
    const supply = Number(pool?.tokenSupply);
    const decimals = Number(pool?.decimals);
    if (!isFinite(priceUsd) || priceUsd <= 0) return null;
    if (!isFinite(supply) || supply <= 0) return null;
    if (!isFinite(decimals) || decimals < 0) return null;

    const risk = body?.risk ?? {};
    const num = (x: unknown): number | null => (typeof x === "number" && isFinite(x) ? x : null);
    return {
      priceUsd, supply, decimals,
      mcUsd: num(pool?.marketCap?.usd) ?? priceUsd * supply,
      liqUsd: num(pool?.liquidity?.usd) ?? 0,
      holders: num(body?.holders), buys: num(body?.buys), sells: num(body?.sells),
      lpBurn: num(pool?.lpBurn), market: pool?.market ?? null,
      freezeAuthority: pool?.security?.freezeAuthority ?? null,
      mintAuthority: pool?.security?.mintAuthority ?? null,
      rugged: typeof risk.rugged === "boolean" ? risk.rugged : null,
      riskScore: num(risk.score), top10Pct: num(risk.top10),
      sniperCount: num(risk.snipers?.count), sniperPct: num(risk.snipers?.totalPercentage),
      insiderCount: num(risk.insiders?.count), insiderPct: num(risk.insiders?.totalPercentage),
      bundlerCount: num(risk.bundlers?.count), bundlerPct: num(risk.bundlers?.totalPercentage),
      dangerFlags: (risk.risks ?? []).filter((x) => x.level === "danger").map((x) => x.name ?? "?"),
      change5mPct: num(body?.events?.["5m"]?.priceChangePercentage),
      change1hPct: num(body?.events?.["1h"]?.priceChangePercentage),
    };
  }
  return null;
}
