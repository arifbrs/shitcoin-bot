/**
 * WICK & KONFIRMASI CANDLE — murni. Konteks wick satu candle + evaluasi 4 kebijakan entry
 * pada EVENT PASAR IDENTIK (candles pasca-stimulus). Candle tak-representatif (volume 0,
 * span >2× interval = gap) DITOLAK, bukan diarang.
 */
import type { Candle, WickContext, EntryPolicy, PolicyEvaluation, CandleInterval } from "./types.js";

export function wickContext(c: Candle, prevLow?: number): WickContext {
  const range = c.high - c.low || c.close;
  return {
    candle: c,
    upperWickPct: Number((((c.high - Math.max(c.open, c.close)) / range) * 100).toFixed(2)),
    lowerWickPct: Number((((Math.min(c.open, c.close) - c.low) / range) * 100).toFixed(2)),
    closeLocation: Number((((c.close - c.low) / range)).toFixed(3)), // 1 = tutup di puncak
    retracementFromHighPct: Number((((c.high - c.close) / c.high) * 100).toFixed(2)),
    higherLow: prevLow != null ? c.low > prevLow : null,
    buyerFollowThrough: c.close > c.open && c.volumeSol > 0 ? true : c.volumeSol > 0 ? false : null,
    volumeSol: c.volumeSol,
  };
}

/** Candle representatif: volume > 0 dan span ts ≤ 2× interval (gap/stale ditolak). */
export function representative(c: Candle, interval: CandleInterval, nextTs?: number): boolean {
  if (c.volumeSol <= 0) return false;
  if (nextTs != null && nextTs - c.ts > 2 * intervalMs(interval) + 1) return false;
  return Number.isFinite(c.open) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}

const intervalMs = (i: CandleInterval): number => (i === "1s" ? 1_000 : 60_000);

/**
 * Evaluasi 4 kebijakan pada stimulus (ts-stimulus, harga stimulus) + candle pasca-stimulus.
 * Semua kebijakan melihat DATA YANG SAMA; hasil = trigger/entry/reject-reason per kebijakan.
 * PULLBACK_WITH_BUYER_RECOVERY: entry saat harga sempat turun >20% dari close stimulus
 * lalu pulih melewati low itu dengan volume pembeli (close > low-min dan close naik).
 */
export function evaluatePolicies(stimulusTs: number, candlesAfter: Candle[], interval: CandleInterval): Record<EntryPolicy, PolicyEvaluation> {
  const reps = candlesAfter.filter((c) => c.ts >= stimulusTs && representative(c, interval)).sort((a, b) => a.ts - b.ts);
  const base: PolicyEvaluation = { policy: "IMMEDIATE_OBSERVED_ENTRY", triggered: reps.length >= 1, triggerTs: reps.length ? reps[0]!.ts : null, entryPrice: reps.length ? reps[0]!.open : null, requiredCandles: 1, observedCandles: reps.length, rejectReason: reps.length ? null : "TIDAK ADA CANDLE REPRESENTATIF" };
  const n4 = (n: number): PolicyEvaluation => reps.length >= n
    ? { policy: `CONFIRM_AFTER_4X_${interval.toUpperCase()}_CANDLES` as EntryPolicy, triggered: true, triggerTs: reps[n - 1]!.ts, entryPrice: reps[n - 1]!.close, requiredCandles: n, observedCandles: reps.length, rejectReason: null }
    : { policy: `CONFIRM_AFTER_4X_${interval.toUpperCase()}_CANDLES` as EntryPolicy, triggered: false, triggerTs: null, entryPrice: null, requiredCandles: n, observedCandles: reps.length, rejectReason: `CANDLE_KURANG (${reps.length}/${n})` };
  const pb = (() => {
    if (reps.length < 3) return { policy: "PULLBACK_WITH_BUYER_RECOVERY" as EntryPolicy, triggered: false, triggerTs: null, entryPrice: null, requiredCandles: 3, observedCandles: reps.length, rejectReason: `CANDLE_KURANG (${reps.length}/3)` };
    const ref = reps[0]!;
    let pulled = false, recovered: Candle | null = null;
    for (const c of reps.slice(1)) {
      if (!pulled && c.low < ref.close * 0.8) pulled = true;
      else if (pulled && c.close > ref.close * 0.8 && c.close > c.open) { recovered = c; break; }
    }
    return { policy: "PULLBACK_WITH_BUYER_RECOVERY" as EntryPolicy, triggered: recovered != null, triggerTs: recovered?.ts ?? null, entryPrice: recovered?.close ?? null, requiredCandles: 3, observedCandles: reps.length, rejectReason: recovered ? null : pulled ? "TARIK-NAPAS TIDAK PULIH DENGAN PEMBELI" : "TIDAK ADA PULLBACK ≥20%" };
  })();
  const confirmKey: EntryPolicy = interval === "1s" ? "CONFIRM_AFTER_4X_1S_CANDLES" : "CONFIRM_AFTER_4X_1M_CANDLES";
  return { IMMEDIATE_OBSERVED_ENTRY: base, [confirmKey]: n4(4), PULLBACK_WITH_BUYER_RECOVERY: pb } as Record<EntryPolicy, PolicyEvaluation>;
}
