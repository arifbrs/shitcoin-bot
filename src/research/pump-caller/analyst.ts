/**
 * ANALIS BAYANGAN deterministik (riset-only) — SKIP/WATCH/PAPER_ENTRY terstruktur.
 * Bukan probabilitas terkalibrasi; tidak menandatangani/mengeksekusi apa pun.
 * Aturan TIDAK absolut ("tidak pernah dijual" dkk. tidak ada di jalur ini): setiap keputusan
 * mencatat alasan, bukti lawan, dan data kritis yang hilang. Biaya notional kecil ($3/$5)
 * dievaluasi eksplisit — biaya transaksi bisa membuat eksekusi tak masuk akal secara ekonomis.
 */
import type { AnalystInput, AnalystOutput, ShadowDecision } from "./types.js";

export const ANALYST_VERSION = "pump-caller-analyst-v1";
export const RESEARCH_NOTIONALS_USD = [3, 5] as const;
/** Model biaya riil-kertas (PARAMETER RISET v1 — belum terkalibrasi ke eksekusi nyata). */
export const PUMP_PAPER_COST_V1 = { takerFeePct: 1.0, slippagePct: 1.5, priorityFeeSol: 0.0005, fixedSolPerTrip: 0.001, roundTripOverheadPct: 2 * (1.0 + 1.5) }; // 5,0pp + 0,001 SOL tetap/putaran

export function analyze(input: AnalystInput): AnalystOutput {
  const reasons: string[] = [], contrary: string[] = [], missing: string[] = [];
  let score = 0;
  // ── Bukti caller (H1) ──
  const c = input.caller;
  if (!c) missing.push("posisi caller tidak tersedia");
  else {
    if (c.state === "HOLDING" || c.state === "ADDING") { reasons.push(`caller ${c.state.toLowerCase()} (${c.evidence})`); score += 1; }
    if (c.state === "PARTIAL_SELL") { reasons.push("caller partial-sell — masih ada sisa teramati"); score += 0.5; contrary.push("caller sudah menjual sebagian"); }
    if (c.state === "EXITED") contrary.push("caller teramati keluar");
    if (c.unrealizedPnlEstimateSol != null && c.unrealizedPnlEstimateSol < 0) { reasons.push("caller underwater (unrealized negatif) — kandidat rebound riset"); score += 1; }
    if (c.evidence === "insufficient") missing.push("bukti wallet caller kurang");
  }
  // ── Absorpsi (H2) ──
  const a = input.absorption;
  if (!a) missing.push("tape absorpsi tidak tersedia");
  else {
    if (a.netFlowSol > 0) { reasons.push(`net flow +${a.netFlowSol} SOL`); score += 1; }
    else contrary.push(`net flow ${a.netFlowSol} SOL`);
    if (a.largeBuys.length > 0) reasons.push(`${a.largeBuys.length} large-buy teramati`);
    if (a.followersFollow === true) { reasons.push("pembeli independen menyusul"); score += 1; }
    if (a.followersFollow === false) contrary.push("pembeli independen tidak menyusul");
    if (a.initialBuyerRapidSold === true) { contrary.push("pembeli awal cepat menjual"); score -= 1; }
    if (a.washSuspicion.bothSidesPct >= 30) { contrary.push(`overlap pembeli/penjual ${a.washSuspicion.bothSidesPct}% (indikasi wash)`); score -= 1; }
  }
  // ── Wick/konfirmasi (jalur entry) ──
  const w = input.wick;
  if (!w) missing.push("konteks candle/wick tidak tersedia");
  else {
    if (w.buyerFollowThrough === true) { reasons.push("buyer follow-through pada candle terakhir"); score += 1; }
    if (w.buyerFollowThrough === false) contrary.push("candle terakhir ditutup turun");
    if (w.upperWickPct > 40) contrary.push(`upper wick ${w.upperWickPct}% - tekanan jual di atas`);
    if (w.retracementFromHighPct > 30) contrary.push(`retracement ${w.retracementFromHighPct}% dari puncak`);
  }
  // ── Latensi (H3) ──
  if (!input.early) missing.push("timeline deteksi dini tidak tersedia");
  else if (input.early.detectionLagMs != null && input.early.detectionLagMs > 5 * 60_000) contrary.push(`deteksi terlambat ${(input.early.detectionLagMs / 60_000).toFixed(1)}m — peluang mungkin sudah lewat`);

  const decision: ShadowDecision = score >= 3 ? "PAPER_ENTRY" : score >= 1.5 ? "WATCH" : "SKIP";
  const notional = decision === "PAPER_ENTRY" ? RESEARCH_NOTIONALS_USD[0] : decision === "WATCH" ? null : null;
  let costWarning: string | null = null;
  if (notional != null) {
    const overheadUsd = (notional * PUMP_PAPER_COST_V1.roundTripOverheadPct) / 100;
    const overheadPctOfNotional = (overheadUsd / notional) * 100;
    costWarning = `biaya putaran termodel ${PUMP_PAPER_COST_V1.roundTripOverheadPct}pp ~ $${overheadUsd.toFixed(2)} pada notional $${notional} (${overheadPctOfNotional.toFixed(0)}% notional; eksekusi mungkin tak ekonomis)`;
  }
  return { decision, decidedAt: input.ts, strategyVersion: ANALYST_VERSION, reasons, contraryEvidence: contrary, missingData: missing, paperNotionalUsd: notional, executionCostWarning: costWarning };
}
