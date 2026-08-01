import { config } from "./config.js";

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

/**
 * Binance public klines endpoint — no auth, no key. Returns closed + in-progress candles;
 * callers that need only CLOSED candles should drop the last row if its closeTime is in the
 * future relative to now (handled by the caller, not assumed here).
 */
export async function fetchCandles(limit = config.feed.candleLimit, endTime?: number): Promise<Candle[]> {
  const et = endTime ? `&endTime=${endTime}` : "";
  const url = `${config.feed.baseUrl}/api/v3/klines?symbol=${config.feed.symbol}&interval=${config.feed.interval}&limit=${limit}${et}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
    const rows = (await res.json()) as unknown[][];
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
    }));
  } finally {
    clearTimeout(t);
  }
}

/**
 * Paginate BACKWARD from now to assemble a long history (Binance caps a single call at 1000
 * candles). Used only for backtesting a meaningful sample size — live polling never needs this.
 */
export async function fetchCandlesRange(days: number): Promise<Candle[]> {
  const msPerCandle = intervalMs(config.feed.interval);
  const totalCandles = Math.ceil((days * 86_400_000) / msPerCandle);
  const out: Candle[] = [];
  let endTime: number | undefined;
  while (out.length < totalCandles) {
    const batch = await fetchCandles(1000, endTime);
    if (!batch.length) break;
    out.unshift(...batch);
    endTime = batch[0]!.openTime - 1;
    await new Promise((r) => setTimeout(r, 150)); // gentle on Binance's public rate limit
  }
  return out;
}

function intervalMs(interval: string): number {
  const unit = interval.slice(-1);
  const n = Number(interval.slice(0, -1));
  const mult = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "m" | "h" | "d"];
  if (!mult) throw new Error(`unknown interval unit: ${interval}`);
  return n * mult;
}
