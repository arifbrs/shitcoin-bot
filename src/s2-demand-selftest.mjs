/**
 * SELFTEST — gerbang permintaan S2 setelah diubah jadi gagal-TERBUKA khusus data hilang.
 *
 * Diukur 2026-08-11: cakupan Jupiter 5m cuma 30% untuk kelas token ini. Dari 239 kandidat yang
 * lolos gerbang statis, 168 (70%) gugur karena DATA HILANG, cuma 28 karena permintaan lemah.
 * Aturan barunya memisahkan "buruk" dari "tidak diketahui" — dan penanda entryDemandKnown WAJIB
 * ikut ke catatan penutupan, kalau tidak kelonggaran ini tidak akan pernah bisa dinilai.
 */
import { readFileSync } from "node:fs";
let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  → ${got}, harus ${want}`}`); if (!ok) fail++; };

const known = c => c.nb != null && c.bv != null && c.sv != null;
const ok = (c, require = true, admitUnknown = true) => {
  if (!require) return true;
  if (!known(c)) return admitUnknown;
  return c.nb > 0 && c.bv > c.sv;
};
console.log("A. perilaku gerbang");
check("permintaan kuat → diterima",            ok({nb:5,bv:900,sv:100}), true);
check("permintaan LEMAH (data ada) → DITOLAK", ok({nb:0,bv:100,sv:900}), false);
check("jual > beli (data ada) → DITOLAK",      ok({nb:3,bv:100,sv:900}), false);
check("data HILANG → diterima (gagal-terbuka)",ok({nb:null,bv:null,sv:null}), true);
check("data SEBAGIAN hilang → diterima",       ok({nb:5,bv:null,sv:100}), true);
check("toggle mati → semua diterima",          ok({nb:0,bv:1,sv:999}, false), true);
check("admitUnknown=false → kembali gagal-tertutup",
      ok({nb:null,bv:null,sv:null}, true, false), false);

console.log("B. sumber asli");
const pt = readFileSync("src/discovery/strategy2-papertrader.ts", "utf8");
const cfg = readFileSync("src/config.ts", "utf8");
check("gerbang memakai admitUnknownDemand", pt.includes("return config.strategy2Paper.admitUnknownDemand"), true);
check("bukti negatif TETAP menolak", pt.includes("c.netBuyers5m! > 0 && c.buyVolume5m! > c.sellVolume5m!"), true);
check("config admitUnknownDemand ada", cfg.includes("admitUnknownDemand:"), true);
check("bisa dikembalikan lewat env", cfg.includes('S2_ADMIT_UNKNOWN_DEMAND !== "false"'), true);
check("posisi menyimpan entryDemandKnown", pt.includes("entryDemandKnown: boolean;"), true);
check("KEDUA catatan penutupan membawanya",
  (pt.match(/entryDemandKnown: pos\.entryDemandKnown/g) || []).length === 2, true);
console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail}`);
process.exit(fail ? 1 : 0);
