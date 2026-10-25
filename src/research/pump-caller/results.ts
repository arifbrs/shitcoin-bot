/**
 * OUTCOME PENDING→OBSERVED/MISSING_FINAL (§7D) + PAPER REALISTIS (§10) — murni.
 * - Mark dibuat PENDING saat keputusan; observe pass mencoba isi dari CANDLE SELESAI
 *   (close time ≤ checkedAt); retry berbatas (grace 2×interval + 5 percobaan) sebelum
 *   MISSING_FINAL. Tidak ada harga karangan saat outage.
 * - Paper no-look-ahead: entry = close candle SELESAI pertama ≥ (decision ts + delay policy);
 *   open candle yang baru teramati belakangan BUKAN harga eksekusi realistis.
 * - MFE/MAE dari candle antara entry dan horizon; biaya model v1; notional $3/$5 eksplisit.
 */
import type { Candle, EntryPolicy, PolicyEvaluation } from "./types.js";
import { PUMP_PAPER_COST_V1 } from "./analyst.js";

export const GRACE_FACTOR = 2;
export const MAX_ATTEMPTS = 5;

export type OutcomeStatus = "PENDING" | "OBSERVED" | "MISSING_FINAL";

/** Candle SELESAI: open-time + interval ≤ asOf (candle in-progress tak boleh jadi bukti). */
export function completedCandles(candles: Candle[], intervalMs: number, asOf: number): Candle[] {
  return candles.filter((c) => c.ts + intervalMs <= asOf).sort((a, b) => a.ts - b.ts);
}

/** Transisi status murni: PENDING → OBSERVED (harga close candle selesai terdekat) / tetap PENDING / MISSING_FINAL. */
export function resolveOutcome(p: {
  status: OutcomeStatus; targetAt: number; attempts: number; horizonMin: number;
  candles: Candle[]; intervalMs: number; asOf: number;
}): { status: OutcomeStatus; priceAtTarget: number | null; reason?: string; attempts: number } {
  if (p.status !== "PENDING") return { status: p.status, priceAtTarget: null, attempts: p.attempts };
  const tol = Math.max(30_000, p.horizonMin * 60_000 * 0.5);
  const done = completedCandles(p.candles, p.intervalMs, p.asOf);
  // Kandidat = candle SELESAI yang CLOSE-TIME-nya berjarak <= tol dari target (bukan sembarang ts).
  const c = done.filter((x) => Math.abs((x.ts + p.intervalMs) - p.targetAt) <= tol)
    .sort((a, b) => Math.abs((a.ts + p.intervalMs) - p.targetAt) - Math.abs((b.ts + p.intervalMs) - p.targetAt))[0];
  if (c) return { status: "OBSERVED", priceAtTarget: c.close, attempts: p.attempts + 1 };
  // belum jatuh tempo → tetap PENDING (bukan MISSING); jatuh tempo + kehabisan percobaan → FINAL.
  if (p.asOf < p.targetAt) return { status: "PENDING", priceAtTarget: null, attempts: p.attempts, reason: "BELUM_JATUH_TEMPO" };
  const graceMs = p.horizonMin * 60_000 * GRACE_FACTOR + 5 * 60_000;
  if (p.asOf < p.targetAt + graceMs || p.attempts < MAX_ATTEMPTS) return { status: "PENDING", priceAtTarget: null, attempts: p.attempts + 1, reason: `RETRY (${p.attempts + 1}/${MAX_ATTEMPTS})` };
  return { status: "MISSING_FINAL", priceAtTarget: null, attempts: p.attempts + 1, reason: "CANDLE_TAK_TERSEDIA_SETELAH_GRACE" };
}

/** Biaya tetap per putaran (S8-P5): fee prioritas SOL — dikurangkan dlm USD bila harga SOL ada. */
export function netUsdAfterCosts(grossPct: number, costPp: number, fixedSolPerTrip: number, solUsd: number | null): Record<string, number | null> {
  const fixedUsd = solUsd != null ? fixedSolPerTrip * solUsd : null;
  return {
    "3": Number((((3 * grossPct) / 100) - (3 * costPp) / 100 - (fixedUsd ?? 0)).toFixed(4)),
    "5": Number((((5 * grossPct) / 100) - (5 * costPp) / 100 - (fixedUsd ?? 0)).toFixed(4)),
  };
}

export interface PaperResult { solUsd?: number | null;
  policy: EntryPolicy; triggered: boolean;
  entryTs: number | null; entryPrice: number | null; decisionToEntryMs: number | null;
  exitTs: number | null; exitPrice: number | null;
  grossPct: number | null; costPp: number; netPct: number | null;
  netUsd: Record<string, number | null>; // per notional $3/$5
  mfePct: number | null; maePct: number | null;
  exitLiquidityObserved: boolean | null; // volume candle exit > 0
  skipReason: string | null;
}

/** Simulasi paper satu keputusan × satu policy (murni; candle harus sudah selesai saat evaluasi). */
export function paperForPolicy(
  decision: { decisionTs: number; priceAtDecision: number },
  policy: PolicyEvaluation, horizonMin: number,
  candles: Candle[], intervalMs: number, asOf: number,
  costs = PUMP_PAPER_COST_V1, solUsd: number | null = null,
): PaperResult {
  const costPp = costs.roundTripOverheadPct;
  const base: PaperResult = { policy: policy.policy, triggered: false, entryTs: null, entryPrice: null, decisionToEntryMs: null, exitTs: null, exitPrice: null,
    grossPct: null, costPp, netPct: null, netUsd: { "3": null, "5": null }, mfePct: null, maePct: null, exitLiquidityObserved: null, solUsd,
    skipReason: policy.rejectReason ?? (policy.triggered ? null : "POLICY_TIDAK_TRIGGER") };
  if (!policy.triggered || policy.triggerTs == null || policy.entryPrice == null) return base;
  // Entry REALISTIS: close candle SELESAI pertama setelah triggerTs (bukan open yang basi).
  const done = completedCandles(candles, intervalMs, asOf);
  const entryCandle = done.find((c) => c.ts >= policy.triggerTs!);
  if (!entryCandle) return { ...base, skipReason: "CANDLE_ENTRY_SELESAI_BELUM_ADA" };
  const entry = entryCandle.close, entryTs = entryCandle.ts + intervalMs;
  // (S8-P2) exit = candle SELESAI pertama yang close-time >= horizon (menutupi horizon),
  // dalam toleransi sempit satu interval — bukan candle dari jauh sebelum horizon.
  const exitAt = decision.decisionTs + horizonMin * 60_000;
  const exitCandle = done.find((c) => c.ts + intervalMs >= exitAt && c.ts + intervalMs <= exitAt + Math.max(30_000, intervalMs));
  if (!exitCandle) return { ...base, entryTs, entryPrice: entry, decisionToEntryMs: entryTs - decision.decisionTs, triggered: true, skipReason: "HORIZON_BELUM_MATANG" };
  const grossPct = ((exitCandle.close - entry) / entry) * 100;
  const netPct = grossPct - costPp;
  const span = done.filter((c) => c.ts >= entryCandle.ts && c.ts <= exitCandle.ts);
  const mfe = span.length ? Math.max(...span.map((c) => (c.high - entry) / entry * 100)) : null;
  const mae = span.length ? Math.min(...span.map((c) => (c.low - entry) / entry * 100)) : null;
  return { policy: policy.policy, triggered: true, entryTs, entryPrice: entry, decisionToEntryMs: entryTs - decision.decisionTs,
    exitTs: exitCandle.ts + intervalMs, exitPrice: exitCandle.close,
    grossPct: Number(grossPct.toFixed(4)), costPp, netPct: Number(netPct.toFixed(4)),
    netUsd: netUsdAfterCosts(grossPct, costPp, costs.fixedSolPerTrip, solUsd),
    mfePct: mfe != null ? Number(mfe.toFixed(4)) : null, maePct: mae != null ? Number(mae.toFixed(4)) : null,
    exitLiquidityObserved: exitCandle.volumeSol > 0, skipReason: null };
}
