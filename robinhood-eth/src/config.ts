import "dotenv/config";

/**
 * ETH PAPER-TRADING CONFIG. Mirrors the Solana project's discipline: every number here is a
 * stated assumption, not a fact — measure before tuning, same as the sniper's arm-ledger work.
 *
 * SCOPE CHANGE FROM THE SOLANA BOT: Robinhood only lists established, liquid assets (BTC, ETH,
 * SOL, DOGE, ...) — there is no "brand-new launch" equivalent to snipe. This is a DIFFERENT
 * strategy family (trend/momentum on a liquid market), not a port of the pump.fun sniper.
 *
 * NO ROBINHOOD API KEY IS USED HERE. Price data comes from Binance's free public REST API
 * (no auth) as an ETH/USD proxy (ETHUSDT ≈ ETH/USD, USDT is a ~1:1 USD-pegged stablecoin — a
 * measurable, small basis difference, not assumed to be exactly zero). A Robinhood key only
 * becomes necessary if/when this moves from paper to live order placement — a separate,
 * explicit, later step.
 */
export const config = {
  dryRun: true as const,

  feed: {
    // Binance's global public REST API — free, no key, generous rate limits. ETHUSDT is the
    // most liquid ETH pair anywhere; USDT is a stablecoin, so this tracks ETH/USD closely but
    // NOT exactly — log the pair name everywhere so this proxy is never silently forgotten.
    baseUrl: "https://api.binance.com",
    symbol: "ETHUSDT",
    interval: "5m", // candle size — 5-minute bars, a reasonable middle ground for a swing strategy
    candleLimit: 500, // how many historical candles to pull per request (Binance max 1000)
    pollMs: 60_000, // re-check for a new closed candle once a minute (candles close every 5min)
  },

  strategy: {
    // TREND-FOLLOWING BASELINE (EMA crossover + ATR-based stop). This is a HYPOTHESIS to
    // measure via paper trading, not a proven edge — same posture as the Solana sniper's
    // "measure first" principle. Expect to revise these numbers once real paper data exists.
    emaFastPeriod: 12,
    emaSlowPeriod: 26,
    atrPeriod: 14,
    atrStopMult: 2.5, // stop-loss distance = ATR × this, below entry (long-only for now)
    minAtrPct: 0.15, // skip entries when ATR/price is below this % — market too flat to trade
  },

  risk: {
    startingFloatUsd: 1_000, // simulated starting bankroll
    riskPerTradePct: 1, // % of current equity risked per trade (position size derived from stop distance)
    maxConcurrentPositions: 1, // single-asset, single-position model for now (ETH only)
    // FEES: Robinhood's crypto fee schedule was NOT read (only Introduction/Authentication
    // pages were reviewed). This is a PLACEHOLDER, not a verified number — replace before
    // trusting any P&L conclusion. Modeled as a round-trip % cost (entry + exit combined).
    unverifiedRoundTripFeePct: 0.30, // TODO: replace with the real number from Robinhood's Fee Schedule page
  },

  logDir: new URL("../logs", import.meta.url).pathname,
};
