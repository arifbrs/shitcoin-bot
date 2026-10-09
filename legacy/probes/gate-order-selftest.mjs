/**
 * SELFTEST — gerbang murah harus berjalan SEBELUM pekerjaan mahal.
 *
 * Terukur 2026-08-15: biaya evaluasi 15,7 getAccountInfo per kandidat, dan ENTRY_MC_BAND
 * menolak ~25% keputusan — tapi ia diperiksa SESUDAH simulateBuyMainnet, jadi seperempat
 * simulasi terbuang untuk kandidat yang sudah pasti ditolak. Kuota Helius gratis hanya
 * 0,386 kredit/detik berkelanjutan lawan 5,8 yang kita pakai, jadi urutan ini bukan
 * kerapian — ia menentukan berapa lama kunci bertahan.
 *
 * Invarian yang dijaga: MC-band dan dev-buy hanya boleh bergantung pada pembacaan kurva
 * (yang memang wajib untuk mengetahui MC), TIDAK pada simulasi.
 */
import { readFileSync } from "node:fs";
const src = readFileSync("src/trader.ts", "utf8");
const lines = src.split("\n");
const at = (needle) => lines.findIndex(l => l.includes(needle)) + 1;
let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  → ${got}, harus ${want}`}`); if (!ok) fail++; };

const curve  = at('const first = await bondingCurvePriceSol');
const mcBand = at('code: "ENTRY_MC_BAND"');
const devBuy = at('code: "ENTRY_DEV_BUY"');
const sim    = at('await simulateBuyMainnet');
const bundle = at('await detectLaunchBundle');

console.log(`  posisi: kurva ${curve} · MC-band ${mcBand} · dev-buy ${devBuy} · simulasi ${sim} · bundle ${bundle}`);
check("MC-band SESUDAH pembacaan kurva (butuh MC)", mcBand > curve, true);
check("MC-band SEBELUM simulateBuyMainnet",          mcBand < sim,   true);
check("dev-buy SEBELUM simulateBuyMainnet",          devBuy < sim,   true);
check("detectLaunchBundle SESUDAH MC-band",          bundle > mcBand, true);
check("hanya SATU tempat memeriksa MC-band",
  (src.match(/code: "ENTRY_MC_BAND"/g) || []).length === 1, true);
check("hanya SATU tempat memeriksa dev-buy",
  (src.match(/code: "ENTRY_DEV_BUY"/g) || []).length === 1, true);
console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail}`);
process.exit(fail ? 1 : 0);
