/**
 * MESIN STATUS "LIMIT MENUNGGU" — KOHORT-11 (2026-10-13).
 *
 * Ini bagian yang tadi belum ada: tanpa ini, arm v59–v68 tidak bisa berjalan (akan entry di pasar
 * seperti arm lama, atau lebih buruk lagi: mengklaim terisi padahal tidak).
 *
 * Aturan (eksplisit, tanpa melihat masa depan):
 *  - target ditetapkan SEKALI saat sinyal: harga_saat_sinyal × (1 − jarak%).
 *  - tiap siklus lane memanggil evaluate() dengan HARGA SEKARANG:
 *      harga ≤ target  → "fill"  (posisi dibuka pada harga target, bukan harga sekarang)
 *      lewat deadline  → "expire" (dibuang tanpa posisi)
 *      selain itu      → "wait"
 *  - status tersimpan di berkas; restart TIDAK boleh menggandakan fill (status "filled"/"expired"
 *    bersifat final dan tetap terbaca setelah muat ulang).
 *
 * Tidak ada fee/slippage di sini — biaya nyata ditambahkan di penilaian (rh:realcost).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface PendingLimit {
  id: string;
  token: string;
  armId: string;
  cohort: string;
  signalMs: number;
  signalPrice: number;
  distPct: number;
  expiryMin: number;
  targetPrice: number;
  status: "waiting" | "filled" | "expired";
  settledMs: number | null;
  fillPrice: number | null;
}

export function limitFilePath(logDir: string): string {
  return `${logDir}/rh-limit-pending.json`;
}

export function makePending(args: { id: string; token: string; armId: string; cohort: string; signalMs: number; signalPrice: number; distPct: number; expiryMin: number }): PendingLimit {
  if (!(args.signalPrice > 0)) throw new Error("makePending: signalPrice harus > 0");
  if (!(args.distPct > 0 && args.distPct < 100)) throw new Error("makePending: distPct harus di antara 0 dan 100");
  if (!(args.expiryMin > 0)) throw new Error("makePending: expiryMin harus > 0");
  return { ...args, targetPrice: args.signalPrice * (1 - args.distPct / 100), status: "waiting", settledMs: null, fillPrice: null };
}

export function loadPending(path: string): { items: PendingLimit[]; corrupt: boolean } {
  if (!existsSync(path)) return { items: [], corrupt: false };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(j)) return { items: [], corrupt: true };
    return { items: j as PendingLimit[], corrupt: false };
  } catch {
    return { items: [], corrupt: true };
  }
}

export function savePending(path: string, items: PendingLimit[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(items, null, 1));
  renameSync(tmp, path);
}

export interface EvalResult { action: "fill" | "expire" | "wait"; fillPrice: number | null; reason: string }

/** Evaluasi satu item terhadap harga SEKARANG. Item yang sudah final tidak pernah berubah. */
export function evaluate(p: PendingLimit, priceNow: number | null, nowMs: number): EvalResult {
  if (p.status !== "waiting") return { action: "wait", fillPrice: null, reason: `final:${p.status}` };
  if (priceNow == null || !(priceNow > 0)) return { action: "wait", fillPrice: null, reason: "harga tidak tersedia" };
  const deadline = p.signalMs + p.expiryMin * 60_000;
  if (priceNow <= p.targetPrice) return { action: "fill", fillPrice: p.targetPrice, reason: "harga ≤ target" };
  if (nowMs > deadline) return { action: "expire", fillPrice: null, reason: "lewat masa berlaku" };
  return { action: "wait", fillPrice: null, reason: "menunggu" };
}

/** Terapkan evaluasi satu siklus ke seluruh daftar (murni): kembalikan daftar baru + kejadiannya. */
export function settle(items: PendingLimit[], priceOf: (token: string) => number | null, nowMs: number): { items: PendingLimit[]; filled: PendingLimit[]; expired: PendingLimit[] } {
  const filled: PendingLimit[] = [];
  const expired: PendingLimit[] = [];
  const next = items.map((p) => {
    const r = evaluate(p, priceOf(p.token), nowMs);
    if (r.action === "fill") { const q: PendingLimit = { ...p, status: "filled", settledMs: nowMs, fillPrice: r.fillPrice }; filled.push(q); return q; }
    if (r.action === "expire") { const q: PendingLimit = { ...p, status: "expired", settledMs: nowMs }; expired.push(q); return q; }
    return p;
  });
  return { items: next, filled, expired };
}

export function waitingOf(items: PendingLimit[]): PendingLimit[] {
  return items.filter((p) => p.status === "waiting");
}
