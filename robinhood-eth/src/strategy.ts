import { config } from "./config.js";
import type { Candle } from "./feed.js";

/** Exponential moving average. First `period-1` entries are NaN (not enough data yet). */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  }
  return out;
}

/** Average True Range, Wilder's smoothing. First `period` entries are NaN. */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length < period + 1) return out;
  const tr: number[] = [NaN];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!, prev = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close)));
  }
  const seed = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  out[period] = seed;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = (out[i - 1]! * (period - 1) + tr[i]!) / period;
  }
  return out;
}

export interface BarState {
  i: number;
  close: number;
  emaFast: number;
  emaSlow: number;
  atr: number;
  atrPct: number;
  tradable: boolean; // ATR% above the flat-market floor
  trendUp: boolean; // emaFast > emaSlow
}

/**
 * TREND-FOLLOWING BASELINE (audit-style honesty: this is a HYPOTHESIS, not a proven edge).
 * Long-only: enter when emaFast crosses above emaSlow in a tradable (non-flat) market; exit on
 * the reverse cross OR the ATR-based stop, whichever the caller's position-tracking hits first.
 */
export function computeStates(candles: Candle[]): BarState[] {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, config.strategy.emaFastPeriod);
  const slow = ema(closes, config.strategy.emaSlowPeriod);
  const atrs = atr(candles, config.strategy.atrPeriod);
  return candles.map((c, i) => {
    const atrPct = atrs[i]! > 0 ? (atrs[i]! / c.close) * 100 : 0;
    return {
      i, close: c.close, emaFast: fast[i]!, emaSlow: slow[i]!, atr: atrs[i]!, atrPct,
      tradable: atrPct >= config.strategy.minAtrPct,
      trendUp: fast[i]! > slow[i]!,
    };
  });
}

export type SignalAction = "enter-long" | "exit-long" | "hold";

/** Given the bar BEFORE and the bar NOW, what should a flat / long position do? */
export function decide(prev: BarState | undefined, now: BarState, inPosition: boolean): SignalAction {
  if (Number.isNaN(now.emaFast) || Number.isNaN(now.emaSlow) || Number.isNaN(now.atr)) return "hold"; // not enough history yet
  if (!inPosition) {
    if (!prev || Number.isNaN(prev.emaFast) || Number.isNaN(prev.emaSlow)) return "hold";
    const crossedUp = prev.emaFast <= prev.emaSlow && now.trendUp;
    return crossedUp && now.tradable ? "enter-long" : "hold";
  }
  // in a long position — exit on trend reversal (the ATR stop is checked separately by the
  // caller against intra-trade price, not just the bar close, since a stop must trigger
  // between candle closes too).
  return !now.trendUp ? "exit-long" : "hold";
}
