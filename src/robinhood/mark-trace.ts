/**
 * JEJAK PASCA-KELUAR (item 1 lanjutan, 2026-10-11).
 *
 * Pertanyaan terbesar yang masih terbuka: apakah harga TP (+185% p50!) benar-benar BISA DIJUAL,
 * atau mark yang lenyap begitu kita keluar? Satu-satunya cara menjawabnya: rekam harga SETELAH
 * keluar. Aturan slotnya murni dan diuji, supaya "3 mark" tidak berarti apa pun yang berbeda
 * tiap kali kode disentuh.
 */

/** Slot waktu pengambilan setelah penutupan: 1, 3, 5 menit. */
export const MARK_AFTER_SLOTS: readonly number[] = [60_000, 180_000, 300_000];

/** Batas jejak yang disimpan sekaligus — rem supaya pengukuran tidak membanjiri tick mark. */
export const MARK_TRACE_MAX = 60;

/** Jejak dianggap selesai bila semua slot terisi, atau sudah lewat 10 menit (apa adanya, ditandai). */
export const MARK_TRACE_GIVEUP_MS = 10 * 60_000;

/** Slot berikutnya yang belum terisi, atau null bila semua slot sudah terisi. */
export function nextMarkSlot(captured: number): number | null {
  return captured < MARK_AFTER_SLOTS.length ? MARK_AFTER_SLOTS[captured]! : null;
}

/** Sudah waktunya mengambil slot ke-`captured` untuk jejak berumur `elapsedMs`? */
export function shouldCaptureNow(captured: number, elapsedMs: number): boolean {
  const slot = nextMarkSlot(captured);
  return slot != null && elapsedMs >= slot;
}

/** Jejak selesai (semua slot terisi) atau menyerah (kelamaan)? */
export function traceFinished(captured: number, elapsedMs: number): boolean {
  return captured >= MARK_AFTER_SLOTS.length || elapsedMs > MARK_TRACE_GIVEUP_MS;
}

/**
 * Retensi harga = harga mark di slot terakhir dibanding harga keluar. 1 = harga bertahan,
 * 0,2 = tinggal seperlima (mark seperti itu tidak bisa diuangkan).
 */
export function priceRetention(exitPriceUsd: number, lastMarkPriceUsd: number | null): number | null {
  if (lastMarkPriceUsd == null || !(exitPriceUsd > 0) || !Number.isFinite(lastMarkPriceUsd)) return null;
  return lastMarkPriceUsd / exitPriceUsd;
}

export interface TraceLike {
  reason: string;
  exitPriceUsd: number;
  marks: Array<{ p: number | null }>;
}

export interface RetentionStat {
  reason: string;
  n: number;
  p50: number;
  p10: number;
  /** Berapa yang harganya lenyap (retensi <50%) — inilah "menang di atas kertas". */
  vanished: number;
}

/** Retensi terakhir sebuah jejak (mark terakhir yang ada ÷ harga keluar). */
export function retentionOf(t: TraceLike): number | null {
  const last = [...t.marks].reverse().find((m) => m.p != null)?.p ?? null;
  return priceRetention(t.exitPriceUsd, last);
}

/**
 * Ringkas retensi per alasan keluar. Satu implementasi, dipakai realism DAN review harian —
 * sebelumnya tiap alat menghitungnya sendiri dan bisa berbeda tanpa ada yang tahu.
 */
export function summarizeTraces(rows: TraceLike[]): RetentionStat[] {
  const byReason = new Map<string, number[]>();
  for (const t of rows) {
    const r = retentionOf(t);
    if (r == null) continue;
    if (!byReason.has(t.reason)) byReason.set(t.reason, []);
    byReason.get(t.reason)!.push(r);
  }
  const out: RetentionStat[] = [];
  for (const [reason, list] of byReason) {
    const s = [...list].sort((a, b) => a - b);
    const at = (q: number): number => s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
    out.push({ reason, n: list.length, p50: at(0.5), p10: at(0.1), vanished: list.filter((r) => r < 0.5).length });
  }
  return out.sort((a, b) => b.n - a.n);
}
