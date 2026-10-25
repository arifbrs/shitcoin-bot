/**
 * NORMALISASI TIMESTAMP (sprint §7B) — detik/milidetik/ISO ditangani EKSPLISIT;
 * nilai invalid DITOLAK (null), TIDAK diganti waktu-sekarang (bug lama).
 * Heuristik: angka <1e11 = detik; 1e11..1e13 = ms; >1e13 = mikrodetik (dibagi 1000).
 */
export function normalizeTradeTs(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return fromNumeric(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) return fromNumeric(Number(s));
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fromNumeric(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return n < 1e9 ? null : Math.round(n * 1000); // detik (≥2001); lebih kecil = sampah
  if (n < 1e13) return Math.round(n); // milidetik
  if (n < 1e16) return Math.round(n / 1000); // mikro
  return null; // nano/dst — ambigu, tolak
}

/** Usia kejadian vs observasi — null bila ts sumber invalid (jangan diarang usianya). */
export function ageMs(sourceTs: unknown, observedAt: number): number | null {
  const t = normalizeTradeTs(sourceTs);
  return t == null ? null : Math.max(0, observedAt - t);
}
