/**
 * CALLER POSITION TRACKER — murni. Events (dedupe by dedupeKey) → state posisi caller.
 * BUKTI vs ESTIMASI dipisah: observedTokenBalance = saldo TERAMATI terakhir (bukan eksposur
 * awal); state EXITED butuh bukti kuat (sisa saldo 0 teramati ATAU provider-position nol),
 * bukan sekadar tidak ada event. UNKNOWN bila bukti kurang.
 */
import type { CallerEvent, CallerPosition, UserPosition } from "./types.js";

/** Reduksi murni — event urut-waktu, dedupe dedupeKey, idempoten terhadap input ganda. */
export function trackCallerPosition(callerId: string, mint: string, events: CallerEvent[], provider?: UserPosition | null): CallerPosition {
  const seen = new Set<string>();
  const ordered = [...events].sort((a, b) => a.ts - b.ts).filter((e) => {
    if (seen.has(e.dedupeKey)) return false;
    seen.add(e.dedupeKey);
    return e.mint === mint && e.callerId === callerId;
  });
  let buysSol = 0, sellsSol = 0, lastBalance: number | null = null, lastEventTs: number | null = null;
  const buyWallets = new Map<string, number>();
  let addedAfterFirst = false;
  for (const e of ordered) {
    lastEventTs = e.ts;
    if (e.kind === "buy") { buysSol += e.sol ?? 0; if (buyWallets.size > 0) addedAfterFirst = true; buyWallets.set(e.dedupeKey, 1); }
    if (e.kind === "sell") sellsSol += e.sol ?? 0;
    if (e.balanceAfter != null) lastBalance = e.balanceAfter;
  }
  // Prioritaskan bukti provider (posisi resmi) bila ada — tetap bedakan teramati vs estimasi.
  const providerBalance = provider?.tokenAmount;
  const providerRealized = provider?.realizedPnl ?? null;
  const providerUnrealized = provider?.unrealizedPnl ?? null;
  const effectiveBalance = providerBalance ?? lastBalance;
  const notes: string[] = [];
  let state: CallerPosition["state"];
  if (ordered.length === 0 && provider == null) {
    state = "UNKNOWN";
    notes.push("tanpa event & tanpa posisi provider — bukti tidak cukup");
  } else if (effectiveBalance != null && effectiveBalance <= 0) {
    state = "EXITED";
    notes.push(providerBalance != null ? "posisi provider = 0" : "saldo teramati 0");
  } else if (sellsSol > 0 && effectiveBalance != null && effectiveBalance > 0) {
    state = "PARTIAL_SELL";
    notes.push(`terjual teramati ${sellsSol.toFixed(3)} SOL; sisa ${effectiveBalance} token teramati`);
  } else if (addedAfterFirst) {
    state = "ADDING";
    notes.push("beli tambahan teramati setelah beli awal");
  } else if (buysSol > 0 || effectiveBalance != null) {
    state = "HOLDING";
    notes.push(effectiveBalance != null ? `sisa ${effectiveBalance} token teramati` : "hanya event beli teramati — eksposur awal tak diketahui persis");
  } else {
    state = "UNKNOWN";
    notes.push("event ada tapi tanpa besaran yang bisa ditafsirkan");
  }
  return {
    callerId, mint, state,
    observedBuysSol: Number(buysSol.toFixed(6)), observedSellsSol: Number(sellsSol.toFixed(6)),
    observedTokenBalance: effectiveBalance,
    lastEventTs, eventCount: ordered.length,
    realizedPnlEstimateSol: providerRealized, unrealizedPnlEstimateSol: providerUnrealized,
    evidence: provider != null ? "provider-position" : ordered.length > 0 ? "wallet-activity" : "insufficient",
    note: notes.join("; "),
  };
}
