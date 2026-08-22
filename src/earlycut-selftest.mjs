/**
 * SELFTEST — aturan EARLY CUT (dipasang 2026-08-11).
 *
 * Aturan: dalam `withinMs` pertama, kalau P&L EKSEKUTABEL sudah di bawah `pnlPct`, keluar.
 * Divalidasi pada 478 trade (selisih berpasangan +2,21 ±1,40 pada asumsi eksekusi realistis;
 * pangkas-ekor lulus terbalik; split-half 400/400). Memotong 29% trade, mengorbankan 1 dari
 * 25 runner.
 *
 * Dua lapis, sama seperti [nodev-exempt-selftest]: lapis A menguji mesin keadaan tiruan,
 * lapis B menguji SUMBER ASLI. Lapis A sendirian akan lulus palsu kalau kode asli berubah —
 * itu terbukti waktu perbaikan NO_DEV sengaja dibalikkan dan hanya lapis B yang gagal.
 */
import { readFileSync } from "node:fs";

const WITHIN_MS = 5_000, PCT = -10;
let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  → dapat ${got}, harus ${want}`}`);
  if (!ok) fail++;
};

/** Meniru urutan tick. Mengembalikan "EARLY_CUT" atau null. */
function run(ticks) {
  for (const t of ticks) if (t.heldMs <= WITHIN_MS && t.execPnl < PCT) return "EARLY_CUT";
  return null;
}

console.log("A. mesin keadaan");
check("jatuh −15% di detik 4 → dipotong",
  run([{ heldMs: 4_000, execPnl: -15 }]), "EARLY_CUT");
check("jatuh −15% tapi baru di detik 8 → TIDAK dipotong (di luar jendela)",
  run([{ heldMs: 4_000, execPnl: -2 }, { heldMs: 8_000, execPnl: -15 }]), null);
check("−9% di dalam jendela → TIDAK dipotong (belum menembus ambang)",
  run([{ heldMs: 4_000, execPnl: -9 }]), null);
check("tepat −10,0% → TIDAK dipotong (perbandingan ketat, bukan ≤)",
  run([{ heldMs: 4_000, execPnl: -10 }]), null);
check("naik dulu lalu jatuh dalam jendela → tetap dipotong (TIDAK ada pengecualian everDeveloped)",
  run([{ heldMs: 2_000, execPnl: 40 }, { heldMs: 5_000, execPnl: -12 }]), "EARLY_CUT");
check("pemenang mulus → tidak tersentuh",
  run([{ heldMs: 4_000, execPnl: 8 }, { heldMs: 30_000, execPnl: 90 }]), null);
check("batas jendela persis 5000ms ikut diperiksa",
  run([{ heldMs: 5_000, execPnl: -20 }]), "EARLY_CUT");

console.log("B. sumber asli");
const pt = readFileSync("src/trader.ts", "utf8");
const cfg = readFileSync("src/config.ts", "utf8");
const iEarly = pt.indexOf("heldMs <= early.withinMs && execPnl < early.pnlPct");
const iNoDev = pt.indexOf("!pos.everDeveloped && heldMs >= noDev.afterMs");
const iCata  = pt.indexOf('this.close(mint, pos, price, "CATASTROPHIC")');
check("penjaga EARLY_CUT ada di trader", iEarly > -1, true);
check("berjalan SESUDAH penjaga catastrophic", iCata > -1 && iEarly > iCata, true);
check("berjalan SEBELUM NO_DEVELOPMENT", iNoDev > -1 && iEarly < iNoDev, true);
check("memakai execPnl (eksekutabel), bukan P&L spot", pt.includes("execPnl < early.pnlPct"), true);
check("config.risk.earlyCut ada", cfg.includes("earlyCut: {"), true);
check("ambang dikunci −10 (bukan −5 yang optimum grid)",
  cfg.includes("EARLY_CUT_PCT ?? -10"), true);
check("bisa dimatikan lewat env tanpa ubah kode",
  cfg.includes('process.env.EARLY_CUT !== "false"'), true);

console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail} pemeriksaan`);
process.exit(fail === 0 ? 0 : 1);
