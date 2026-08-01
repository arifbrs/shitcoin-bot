import { fetchCandles } from "./feed.js";
import { computeStates } from "./strategy.js";
import { EthPaperTrader } from "./papertrader.js";
import { config } from "./config.js";
import { ui } from "./log.js";

/**
 * LIVE paper-trading loop — polls Binance's free public feed, re-derives the full indicator
 * series each poll (simple, correct; not optimized for incremental updates yet), and processes
 * any NEWLY CLOSED candle exactly once. Nothing here places a real order: this is dry-run only.
 */
async function main(): Promise<void> {
  ui.info(`[eth-paper] starting — ${config.feed.symbol} ${config.feed.interval} candles, poll every ${config.feed.pollMs / 1000}s. DRY-RUN, no API key, no real orders.`);
  const trader = new EthPaperTrader();
  let lastProcessedCloseTime = 0;

  async function poll(): Promise<void> {
    try {
      const candles = await fetchCandles(config.feed.candleLimit);
      const now = Date.now();
      // Drop any candle whose closeTime is still in the future (Binance includes the
      // in-progress candle) — only act on CLOSED bars, never an incomplete one.
      const closed = candles.filter((c) => c.closeTime <= now);
      if (closed.length < 2) return;
      const states = computeStates(closed);
      const lastIdx = closed.length - 1;
      const lastCandle = closed[lastIdx]!;
      if (lastCandle.closeTime <= lastProcessedCloseTime) return; // already handled this bar
      lastProcessedCloseTime = lastCandle.closeTime;
      trader.processBar(states, lastIdx, lastCandle);
      ui.info(`[eth-paper] bar closed @ $${lastCandle.close.toFixed(2)} — ${trader.summary()}`);
    } catch (e) {
      ui.warn(`[eth-paper] poll failed: ${(e as Error).message}`);
    }
  }

  void poll();
  const timer = setInterval(() => void poll(), config.feed.pollMs);
  const shutdown = () => { clearInterval(timer); ui.info(`[eth-paper] shutdown — final: ${trader.summary()}`); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
