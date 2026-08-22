/**
 * SELFTEST — jaminan "sekali berkembang, kebal NO_DEVELOPMENT selamanya".
 *
 * Bug yang dijaga (diperbaiki 2026-08-11): scale-out mereset pos.peakExecProceeds supaya trail
 * menyesuaikan ke posisi sisa. execPeakGainPct diturunkan dari HWM yang sama, dan NO_DEVELOPMENT
 * membacanya — jadi runner yang sudah de-risked terhitung ulang di bawah 5% sementara heldMs
 * tetap dari pembukaan awal, lalu dieksekusi sebagai "tidak pernah berkembang". Terukur: 47 kali.
 *
 * Dua lapis pemeriksaan, sengaja:
 *   A. mesin keadaan — meniru urutan tick sungguhan dan menguji hasilnya
 *   B. sumber asli — memastikan latch benar-benar ada DAN berada SEBELUM penjaga di trader.ts
 * Lapis B ada karena lapis A menguji tiruan; tanpa B, kode asli bisa berubah tanpa test ini gagal.
 */
import { readFileSync } from "node:fs";

const MIN_PEAK = 5, AFTER_MS = 30_000;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  → dapat ${got}, harus ${want}`}`);
  if (!ok) fail++;
};

/** Meniru satu posisi melalui deret tick. Mengembalikan alasan penutupan, atau null. */
function run(ticks) {
  const pos = { sizeSol: 1, peakExecProceeds: undefined, everDeveloped: false };
  for (const t of ticks) {
    if (t.partial) { pos.sizeSol = t.newSize; pos.peakExecProceeds = undefined; continue; }
    if (pos.peakExecProceeds == null || t.proceeds > pos.peakExecProceeds) pos.peakExecProceeds = t.proceeds;
    const gain = ((pos.peakExecProceeds - pos.sizeSol) / pos.sizeSol) * 100;
    if (gain >= MIN_PEAK) pos.everDeveloped = true;                 // latch — HARUS sebelum penjaga
    if (!pos.everDeveloped && t.heldMs >= AFTER_MS && gain < MIN_PEAK) return "NO_DEVELOPMENT";
  }
  return null;
}

console.log("A. mesin keadaan");
// Skenario bug: naik +50%, ambil partial (HWM direset, sisa dinilai ulang di ~impas), tahan lewat 30s.
check("runner de-risked TIDAK dipotong setelah partial", run([
  { heldMs: 5_000,  proceeds: 1.50 },            // +50% → berkembang
  { partial: true,  newSize: 0.60 },             // scale-out: HWM direset, sisa lebih kecil
  { heldMs: 35_000, proceeds: 0.60 },            // sisa impas → gain terhitung 0%, dulu di sini mati
  { heldMs: 45_000, proceeds: 0.61 },
]), null);
// Kendali negatif: yang memang tidak pernah bergerak HARUS tetap dipotong, kalau tidak
// perbaikan ini diam-diam mematikan aturannya.
check("yang benar-benar mati TETAP dipotong", run([
  { heldMs: 5_000,  proceeds: 0.99 },
  { heldMs: 35_000, proceeds: 0.97 },
]), "NO_DEVELOPMENT");
check("belum sampai 30 detik: belum dipotong", run([
  { heldMs: 5_000,  proceeds: 0.98 },
  { heldMs: 20_000, proceeds: 0.95 },
]), null);
check("berkembang TEPAT di ambang 5% ikut kebal", run([
  { heldMs: 5_000,  proceeds: 1.05 },
  { partial: true,  newSize: 0.70 },
  { heldMs: 40_000, proceeds: 0.70 },
]), null);

console.log("B. sumber asli trader.ts");
const src = readFileSync("src/trader.ts", "utf8");
const iLatch = src.indexOf("if (execPeakGainPct >= noDev.minPeakPct) pos.everDeveloped = true;");
const iGuard = src.indexOf("!pos.everDeveloped && heldMs >= noDev.afterMs");
check("latch everDeveloped ada", iLatch > -1, true);
check("penjaga memakai everDeveloped", iGuard > -1, true);
check("latch berada SEBELUM penjaga", iLatch > -1 && iGuard > -1 && iLatch < iGuard, true);
check("reset HWM scale-out masih ada (trail harus tetap re-seed)",
  src.includes("pos.peakExecProceeds = undefined;"), true);

console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail} pemeriksaan`);
process.exit(fail === 0 ? 0 : 1);
