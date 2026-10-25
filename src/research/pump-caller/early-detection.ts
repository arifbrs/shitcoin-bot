/**
 * DETEKSI DINI INFLUENSER — join timeline (murni). Latensi deteksi-sosial vs latensi
 * eksekusi pasar DIPISAH. Tanpa look-ahead: hanya timestamp kejadian yang SUDAH terjadi
 * saat keputusan; followersAtBuy = nilai PADA saat beli (bukan nilai terkini).
 */
import type { EarlyTimeline, LatencyView } from "./types.js";

export function latencyView(t: EarlyTimeline): LatencyView {
  const parts: string[] = [];
  const detectionLagMs = t.callerBuyTs != null && t.firstObservedByBot >= t.callerBuyTs ? t.firstObservedByBot - t.callerBuyTs : null;
  const calloutLagMs = t.calloutPublishedTs != null && t.callerBuyTs != null && t.calloutPublishedTs >= t.callerBuyTs ? t.calloutPublishedTs - t.callerBuyTs : null;
  const executableLagMs = t.firstExecutableQuoteTs != null && t.firstObservedByBot >= t.firstObservedByBot - 1 ? Math.max(0, t.firstExecutableQuoteTs - t.firstObservedByBot) : null;
  if (t.callerBuyTs == null) parts.push("waktu beli caller tidak teramati");
  if (t.firstExecutableQuoteTs == null) parts.push("quote eksekusi pertama belum teramati");
  if (t.createdAt != null && t.callerBuyTs != null && t.callerBuyTs < t.createdAt) parts.push("ANOMALI: beli caller sebelum pembuatan token — data saling bertentangan");
  return { detectionLagMs, calloutLagMs, executableLagMs, note: parts.join("; ") || "lengkap" };
}

/** Peluang "sudah lewat" saat pertama teramati: harga sudah bergerak >movePct sebelum bot melihat. */
export function moveAlreadyOver(t: EarlyTimeline, priceAtCallerBuy: number | null, priceAtFirstObserve: number | null, movePct = 50): { over: boolean | null; movedPct: number | null } {
  if (priceAtCallerBuy == null || priceAtFirstObserve == null || priceAtCallerBuy <= 0) return { over: null, movedPct: null };
  const movedPct = ((priceAtFirstObserve - priceAtCallerBuy) / priceAtCallerBuy) * 100;
  return { over: movedPct >= movePct, movedPct: Number(movedPct.toFixed(2)) };
}
