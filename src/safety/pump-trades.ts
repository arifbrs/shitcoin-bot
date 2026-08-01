import { config } from "../config.js";
import { fetchJson, TokenBucket } from "../util/http.js";

/**
 * pump.fun PER-TOKEN TRADES (real buy-pressure / crowd) — FREE, no-auth, no funded
 * key. `swap-api.pump.fun/v2/coins/{mint}/trades` returns the recent fills, each:
 *   type ("buy"|"sell"), userAddress, amountSol, priceSol, timestamp
 *
 * This is the momentum/crowd signal the research said needed a funded PumpPortal
 * key (subscribeTokenTrade) — pump.fun's own swap API serves it publicly. We distil
 * a window of trades into buy-pressure, unique buyers, net SOL flow, whale buys, and
 * ACCELERATION (recent-half trade rate ÷ earlier-half) for the momentum checkpoint.
 *
 * Verified live 2026-07-22 (v1 is 410 Gone; v2 is the live path). Best-effort → null.
 */
const bucket = TokenBucket.perMinute(config.pumpTrades.perMin);
const BASE = "https://swap-api.pump.fun";

interface RawTrade {
  type?: string;
  userAddress?: string;
  amountSol?: string | number;
  timestamp?: string;
}
interface RawResp {
  trades?: RawTrade[];
}

export interface PumpTradeStats {
  count: number; // trades in the window
  buys: number;
  sells: number;
  buyPressurePct: number; // buys / (buys+sells) * 100
  uniqueBuyers: number;
  netBuyVolSol: number; // Σ buy SOL − Σ sell SOL (accumulation vs distribution)
  whaleBuys: number; // buys ≥ whaleSol
  accel: number; // trade-rate in the recent half ÷ the earlier half (>1 = speeding up)
  lastTradeSecAgo: number;
  /**
   * WASH-TRADE METRICS — computed here because this free swap-api tape is the one that ACTUALLY
   * runs. Two earlier homes were tried and rejected on evidence: the Bitquery tape (its free
   * STREAMING quota dies after ~1h — measured 2026-07-26 on a same-day token) and the PumpPortal
   * `subscribeTokenTrade` stream (needs a funded PUMPPORTAL_API_KEY we do not have, so it never
   * starts). This endpoint is free, keyless, and already called on every entry.
   *
   * `bothSidesPct` — share of wallets appearing as BOTH buyer and seller in the window. It is
   * the strongest published discriminator: Bitquery's investigation of five confirmed
   * wash-traded tokens measured 95-98% here, versus below 30% for genuine retail flow.
   *
   * Why this matters here: our gate score is measurably INVERTED — coins scoring 62+ win 18%,
   * coins sitting near the unscored base of 50 win 39% — and the bonuses it pays out (holder
   * count, buy ratio, heavy buy counts) are precisely what a wash fleet manufactures. This
   * measures the manufacturing itself rather than its symptoms.
   *
   * MEASUREMENT ONLY. Nothing gates on these until they are regressed against our own realised
   * P&L; the thresholds above are Bitquery's, measured on their data, not ours.
   */
  bothSidesPct: number;
  tradesPerTrader: number;
  avgTradeSol: number;
  washScore: number;
}


/**
 * Wash metrics over one window. A wallet present in BOTH the buyer and seller sets is
 * double-counted in `buyers.size + sellers.size`, so subtracting the distinct-trader count
 * leaves exactly the both-sides population. Trades with no userAddress are ignored rather
 * than folded in as a single empty-string "trader", which would fake a huge overlap.
 */
function washMetrics(all: RawTrade[], buysArr: RawTrade[], sellsArr: RawTrade[]): { bothSidesPct: number; tradesPerTrader: number; avgTradeSol: number; washScore: number } {
  const addr = (x: RawTrade): string | undefined => (x.userAddress ? String(x.userAddress) : undefined);
  const buyers = new Set(buysArr.map(addr).filter(Boolean) as string[]);
  const sellers = new Set(sellsArr.map(addr).filter(Boolean) as string[]);
  const traders = new Set(all.map(addr).filter(Boolean) as string[]).size;
  const bothSides = traders > 0 ? (buyers.size + sellers.size - traders) / traders : 0;
  const tradesPerTrader = traders > 0 ? all.length / traders : 0;
  const avgTradeSol = all.length > 0 ? all.reduce((a, x) => a + num(x.amountSol), 0) / all.length : 0;
  // Published cut is <$5 per trade. Expressed in SOL (~0.025 at $200/SOL) so the metric never
  // depends on a USD price we would have to fetch and could get wrong.
  const smallTrade = avgTradeSol < 0.025 ? 1 : 0.4;
  const score = Math.log10(Math.max(tradesPerTrader, 1)) * smallTrade * (bothSides > 0.3 ? bothSides : 0.2);
  return {
    bothSidesPct: Number((bothSides * 100).toFixed(1)),
    tradesPerTrader: Number(tradesPerTrader.toFixed(2)),
    avgTradeSol: Number(avgTradeSol.toFixed(5)),
    washScore: Number(score.toFixed(3)),
  };
}

const num = (v: string | number | undefined): number => Math.abs(typeof v === "string" ? parseFloat(v) || 0 : v ?? 0);

/**
 * Latest traded price in SOL from the swap-api tape. Works BEFORE and AFTER a token
 * graduates off the bonding curve (unlike a curve read), so it's the price source for
 * post-exit tracking — where a graduated runner (e.g. +8987%) must stay trackable.
 * Returns null if no trades / failure.
 */
export async function latestPriceSol(mint: string): Promise<number | null> {
  try {
    const resp = await fetchJson<{ trades?: Array<{ priceSol?: string | number }> }>(`${BASE}/v2/coins/${mint}/trades?limit=1`, {
      bucket,
      timeoutMs: 4_000,
      retries: 1,
    });
    const p = resp?.trades?.[0]?.priceSol;
    const n = typeof p === "string" ? parseFloat(p) : p;
    return n && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Fetch up to `limit` recent trades and distil momentum stats. null if none/failed. */
export async function pumpTradeStats(mint: string, limit = 60): Promise<PumpTradeStats | null> {
  try {
    const resp = await fetchJson<RawResp>(`${BASE}/v2/coins/${mint}/trades?limit=${limit}`, {
      bucket,
      timeoutMs: 4_000,
      retries: 1,
    });
    const t = resp?.trades ?? [];
    if (t.length === 0) return null;
    const isBuy = (x: RawTrade): boolean => (x.type ?? "").toLowerCase() === "buy";
    const buysArr = t.filter(isBuy);
    const sellsArr = t.filter((x) => !isBuy(x));
    const buyVol = buysArr.reduce((s, x) => s + num(x.amountSol), 0);
    const sellVol = sellsArr.reduce((s, x) => s + num(x.amountSol), 0);
    const buyPressurePct = t.length > 0 ? (buysArr.length / t.length) * 100 : 0;

    // Acceleration: trades are newest-first, so the recent half is the front of the
    // array. Compare trade-rate (trades ÷ seconds spanned) recent vs earlier.
    const ts = (x: RawTrade): number => (x.timestamp ? Date.parse(x.timestamp) : 0);
    const times = t.map(ts).filter((n) => n > 0);
    const lastTradeSecAgo = times.length ? Math.max(0, (Date.now() - Math.max(...times)) / 1000) : 999;
    const mid = Math.floor(t.length / 2);
    const rate = (arr: RawTrade[]): number => {
      const tt = arr.map(ts).filter((n) => n > 0);
      if (tt.length < 2) return 0;
      const span = (Math.max(...tt) - Math.min(...tt)) / 1000;
      return span > 0 ? arr.length / span : 0;
    };
    const recentRate = rate(t.slice(0, mid + 1));
    const earlyRate = rate(t.slice(mid));
    const accel = earlyRate > 0.001 ? recentRate / earlyRate : recentRate > 0 ? 2 : 0;

    return {
      count: t.length,
      buys: buysArr.length,
      sells: sellsArr.length,
      buyPressurePct,
      uniqueBuyers: new Set(buysArr.map((x) => x.userAddress)).size,
      netBuyVolSol: buyVol - sellVol,
      whaleBuys: buysArr.filter((x) => num(x.amountSol) >= config.pumpTrades.whaleSol).length,
      accel,
      lastTradeSecAgo,
      ...washMetrics(t, buysArr, sellsArr),
    };
  } catch {
    return null;
  }
}
