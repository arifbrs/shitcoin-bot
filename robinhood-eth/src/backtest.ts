import { fetchCandles, fetchCandlesRange } from "./feed.js";
import { computeStates } from "./strategy.js";
import { EthPaperTrader } from "./papertrader.js";
import { config } from "./config.js";
import { ui } from "./log.js";

/**
 * INSTANT historical read on the strategy hypothesis — Binance gives up to 1000 candles for
 * free, no key, so this runs the EXACT same bar-by-bar logic as live paper trading against
 * real past ETH price action. This is diagnostic, not a promise: past bars are not future
 * bars, and the fee number is a placeholder (see config.ts) until Robinhood's real schedule
 * is read. Treat this as "is the hypothesis even plausible" — not a validated edge.
 */
async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 30);
  ui.info(`[backtest] fetching ~${days}d of ${config.feed.interval} candles for ${config.feed.symbol} (paginated)...`);
  const candles = days > 0 ? await fetchCandlesRange(days) : await fetchCandles(config.feed.candleLimit);
  ui.info(`[backtest] got ${candles.length} candles, ${new Date(candles[0]!.openTime).toISOString()} → ${new Date(candles[candles.length - 1]!.closeTime).toISOString()}`);

  const states = computeStates(candles);
  const trader = new EthPaperTrader();
  for (let i = 1; i < candles.length; i++) {
    trader.processBar(states, i, candles[i]!);
  }
  ui.info(`[backtest] done — ${trader.summary()}`);
  ui.warn(`[backtest] REMINDER: fee model is UNVERIFIED (${config.risk.unverifiedRoundTripFeePct}% round-trip placeholder) — read Robinhood's real Fee Schedule page before trusting this number.`);
}

main();
