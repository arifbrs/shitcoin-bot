/**
 * EKSPERIMEN PROSPEKTIF PRE-REGISTRASI (3 hipotesis) + evaluasi vs baseline — murni.
 * Kohor evaluasi TIDAK dipakai untuk memilih ambang; trigger hipotesis dibekukan di sini.
 */
import type { CallerPosition, AbsorptionView, LatencyView } from "./types.js";

export type HypothesisId = "UNDERWATER_CALLER_REBOUND" | "LARGE_BUY_SMALL_SELL_ABSORPTION" | "EARLY_INFLUENCER_CALLER_CASCADE";
export const EXPERIMENT_VERSION = "pump-caller-experiments-v1";

export interface TriggerRule { id: HypothesisId; trigger: (ctx: { caller?: CallerPosition | null; absorption?: AbsorptionView | null; early?: LatencyView | null }) => { fires: boolean; reason: string }; baseline: string }

/** Trigger DIBEKUAN sebelum evaluasi (pre-registrasi) — jangan di-tune dari hasil. */
export const TRIGGERS: TriggerRule[] = [
  {
    id: "UNDERWATER_CALLER_REBOUND",
    trigger: ({ caller }) => (caller && (caller.state === "HOLDING" || caller.state === "PARTIAL_SELL") && caller.unrealizedPnlEstimateSol != null && caller.unrealizedPnlEstimateSol < 0
      ? { fires: true, reason: `caller ${caller.state} underwater ${caller.unrealizedPnlEstimateSol} SOL` }
      : { fires: false, reason: "caller tidak underwater / bukti kurang" }),
    baseline: "semua token teramati dgn aktivitas caller (tanpa syarat underwater)",
  },
  {
    id: "LARGE_BUY_SMALL_SELL_ABSORPTION",
    trigger: ({ absorption }) => (absorption && absorption.largeBuys.length > 0 && absorption.netFlowSol > 0 && absorption.initialBuyerRapidSold !== true && absorption.followersFollow === true
      ? { fires: true, reason: `large-buy + netflow +${absorption.netFlowSol} SOL + pengikut menyusul` }
      : { fires: false, reason: "absorpsi tidak terpenuhi" }),
    baseline: "token dgn tape trades tapi tanpa large-buy",
  },
  {
    id: "EARLY_INFLUENCER_CALLER_CASCADE",
    trigger: ({ early, caller }) => (early && early.detectionLagMs != null && early.detectionLagMs <= 5 * 60_000 && caller && caller.state !== "UNKNOWN"
      ? { fires: true, reason: `caller terdeteksi dlm ${(early.detectionLagMs / 1000).toFixed(0)}s` }
      : { fires: false, reason: "deteksi >5m atau caller tak terverifikasi" }),
    baseline: "token sama, trigger pada large-buy non-caller pertama",
  },
];

export interface Outcome { mint: string; changePct: number } // changePct pd horizon tertentu
export interface Comparison { id: HypothesisId; nTrigger: number; nBaseline: number; meanTriggerPct: number; meanBaselinePct: number; diffPp: number; ci95Diff: [number, number] | null; status: "INSUFFICIENT" | "DESCRIPTIVE" }

/** Perbandingan trigger vs baseline + bootstrap CI diff (seed tetap). n<5 per sisi = INSUFFICIENT. */
export function compare(id: HypothesisId, trigger: Outcome[], baseline: Outcome[], resamples = 2000, seed = 42): Comparison {
  const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  const t = trigger.map((x) => x.changePct), b = baseline.map((x) => x.changePct);
  const diffPp = mean(t) - mean(b);
  let ci: [number, number] | null = null;
  if (t.length >= 5 && b.length >= 5) {
    let s = seed >>> 0;
    const rnd = (): number => (s = (s * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;
    const diffs: number[] = [];
    for (let i = 0; i < resamples; i++) {
      const st = t.map(() => t[Math.floor(rnd() * t.length)]!);
      const sb = b.map(() => b[Math.floor(rnd() * b.length)]!);
      diffs.push(mean(st) - mean(sb));
    }
    diffs.sort((x, y) => x - y);
    ci = [diffs[Math.floor(0.025 * diffs.length)]!, diffs[Math.floor(0.975 * diffs.length)]!];
  }
  return { id, nTrigger: t.length, nBaseline: b.length, meanTriggerPct: Number(mean(t).toFixed(3)), meanBaselinePct: Number(mean(b).toFixed(3)),
    diffPp: Number(diffPp.toFixed(3)), ci95Diff: ci ? [Number(ci[0].toFixed(3)), Number(ci[1].toFixed(3))] : null,
    status: t.length >= 5 && b.length >= 5 ? "DESCRIPTIVE" : "INSUFFICIENT" };
}
