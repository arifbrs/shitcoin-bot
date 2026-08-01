import { config } from "../config.js";
import { fetchJson, TokenBucket } from "../util/http.js";

/**
 * pump.fun CANDLES (OHLCV) — FREE, no-auth: swap-api.pump.fun/v1/coins/{mint}/candles.
 * This is the coin's actual chart. We DO NOT pre-judge it into "uptrend/downtrend"
 * flags — that would make the agent rigid and wrong. Instead we hand the Feeling Agent
 * the RAW recent candle series (closes indexed to the first = 100 so it's readable and
 * token-size-agnostic, plus per-candle volume) and let it READ the shape itself:
 * higher-lows, breakouts, fading tops, volume drying up — a trader's eye, not a rule.
 *
 * Verified live 2026-07-22. Intervals: 1s/1m/5m/15m/1h. Best-effort → null.
 */
const bucket = TokenBucket.perMinute(config.pumpCandles.perMin);
const BASE = "https://swap-api.pump.fun";

interface RawCandle {
  timestamp?: number;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
}

export interface CandleView {
  interval: string;
  count: number;
  closesIdx: number[]; // recent closes, indexed so the FIRST shown candle = 100 (shape, size-agnostic)
  vols: number[]; // per-candle volume in SOL, same order (oldest → newest)
  changePct: number; // % move across the shown window (newest vs oldest close)
}

const num = (v: string | number | undefined): number => (typeof v === "string" ? parseFloat(v) || 0 : v ?? 0);

/** Raw recent candles for the agent to read. `interval` e.g. "1m". null on failure. */
export async function pumpCandles(mint: string, interval = "1m", limit = 10): Promise<CandleView | null> {
  try {
    const arr = await fetchJson<RawCandle[]>(`${BASE}/v1/coins/${mint}/candles?interval=${interval}&limit=${limit}`, {
      bucket,
      timeoutMs: 4_000,
      retries: 1,
    });
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const closes = arr.map((c) => num(c.close)).filter((n) => n > 0);
    const vols = arr.map((c) => Number(num(c.volume).toFixed(2)));
    if (closes.length < 2) return null;
    const base = closes[0]!;
    const closesIdx = closes.map((c) => Number(((c / base) * 100).toFixed(1)));
    const changePct = Number((((closes[closes.length - 1]! - base) / base) * 100).toFixed(1));
    return { interval, count: closes.length, closesIdx, vols, changePct };
  } catch {
    return null;
  }
}
