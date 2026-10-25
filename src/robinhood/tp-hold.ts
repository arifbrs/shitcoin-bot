/**
 * ATURAN "TP HARUS BERTAHAN" (kohort-7, 2026-10-11).
 *
 * Dasar terukur: 89% kemenangan take_profit harganya LENYAP <1 menit sesudah kita jual
 * (retensi p50 0% dari 3.000+ jejak pasca-keluar). Dua bacaan yang sah — (a) kita menjual tepat di
 * puncak sebelum jatuh, atau (b) harga setinggi itu memang tidak pernah bisa dijual dan hanya
 * muncul satu tick. Uji ini memisahkan keduanya: TP baru dieksekusi bila harga BERTAHAN beberapa
 * tick, bukan sekali sentuh.
 *
 * Efek sampingnya jujur disebut: menunggu berarti kadang melewatkan puncak. Karena itu ia diuji
 * sebagai arm dengan KONTROL (yang langsung menjual seperti sekarang), bukan diterapkan langsung.
 */

/** Berapa tick beruntun harga harus ≥ ambang TP sebelum dijual. 0 = perilaku lama (sekali sentuh). */
export function tpHoldSatisfied(hitStreak: number, required: number): boolean {
  if (required <= 0) return true;
  return hitStreak >= required;
}

/** Perbarui hitungan tick yang bertahan di atas ambang TP. Turun di bawah ambang → hitungan nol lagi. */
export function nextTpHoldStreak(current: number, aboveThreshold: boolean): number {
  return aboveThreshold ? current + 1 : 0;
}
