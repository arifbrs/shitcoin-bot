/**
 * ENTRY BERBASIS LIMIT — KOHORT-11 (2026-10-13) — modul MURNI, belum disambungkan ke lane.
 *
 * Alasan: hasil ukur live menunjukkan biaya nyata 2,12% per putaran (fee 1,00% + slip 0,06% per sisi).
 * Pertanyaan yang belum terjawab: berapa JARAK limit di bawah harga dan MASA BERLAKU yang memberi
 * hasil terbaik? Jawaban tidak boleh ditebak — ia harus datang dari data. Modul ini menyediakan
 * (a) matriks varian yang akan diuji, dan (b) aturan fill yang eksplisit dan bisa diuji unit.
 *
 * ATURAN FILL (eksplisit, sengaja konservatif):
 *  - target = harga tick pertama × (1 − distPct/100). Order hanya terisi bila ADA tick dengan harga ≤ target.
 *  - fillPrice = target (limit terisi pada harga limit atau lebih baik; kita TIDAK mengklaim lebih baik).
 *  - bila tak ada tick ≤ target sampai expiryMenit → tidak terisi ("no_dip" bila harga tak pernah turun
 *    sejauh itu, "expired" bila turun tapi tak sampai target).
 *  - tidak ada model antrean/fee di sini: biaya nyata ditambahkan di penilaian (rh:realcost), bukan di sini.
 */
export interface Tick { tMin: number; price: number }
export interface LimitRule { distPct: number; expiryMin: number }
export type LimitReason = "filled" | "no_dip" | "expired";
export interface LimitResult { filled: boolean; fillPrice: number | null; waitedMin: number | null; reason: LimitReason }

/** Matriks yang akan diuji: 5 jarak × 2 masa berlaku = 10 arm. Nomor lanjut setelah v58. */
export const LIMIT_DISTANCES = [5, 10, 15, 20, 30] as const;
export const LIMIT_EXPIRIES_MIN = [15, 60] as const;
export const LIMIT_MATRIX: LimitRule[] = LIMIT_DISTANCES.flatMap((distPct) => LIMIT_EXPIRIES_MIN.map((expiryMin) => ({ distPct, expiryMin })));

/**
 * TAMBAHAN (2026-10-16): jarak menengah + masa 30 menit, supaya kurva jarak↔laju-fill lebih halus.
 * PENTING — arm lama v59-v68 sudah berjalan dan sampelnya sudah terkumpul: peta ID lama TIDAK BOLEH
 * bergeser. Karena itu pemetaan lama dipertahankan apa adanya, dan kombinasi baru memakai v69+.
 * limitArmId() MELEMPAR galat untuk aturan yang tak dikenal — lebih baik gagal keras daripada
 * mengembalikan ID yang salah dan mencampur sampel (kelas bug yang dilarang).
 */
export const LIMIT_EXTRA: LimitRule[] = [7.5, 12.5].flatMap((distPct) => [15, 30, 60].map((expiryMin) => ({ distPct, expiryMin })));
export const ALL_LIMIT_RULES: LimitRule[] = [...LIMIT_MATRIX, ...LIMIT_EXTRA];

export function limitArmId(rule: LimitRule): string {
  const key = (r: LimitRule): boolean => r.distPct === rule.distPct && r.expiryMin === rule.expiryMin;
  const i = LIMIT_MATRIX.findIndex(key);
  if (i >= 0) return `v${59 + i}-limit-d${rule.distPct}-e${rule.expiryMin}`;
  const j = LIMIT_EXTRA.findIndex(key);
  if (j >= 0) return `v${69 + j}-limit-d${rule.distPct}-e${rule.expiryMin}`;
  throw new Error(`limitArmId: aturan tak dikenal (jarak ${rule.distPct}% · masa ${rule.expiryMin}m) — menolak mengembalikan ID yang mungkin salah`);
}

export function simulateLimitEntry(ticks: Tick[], rule: LimitRule): LimitResult {
  if (!ticks.length) throw new Error("simulateLimitEntry: tick kosong");
  const first = ticks[0]!;
  const target = first.price * (1 - rule.distPct / 100);
  let lowest = first.price;
  for (const tk of ticks) {
    if (tk.tMin > rule.expiryMin) break;
    if (tk.price < lowest) lowest = tk.price;
    if (tk.price <= target) return { filled: true, fillPrice: target, waitedMin: tk.tMin, reason: "filled" };
  }
  return { filled: false, fillPrice: null, waitedMin: null, reason: lowest <= target ? "expired" : "no_dip" };
}
