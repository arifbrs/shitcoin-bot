/**
 * SELFTEST — jeda bertingkat pada waitForMintVisible.
 *
 * Terukur pada 26.111 mint-settle: p50 328ms, p75 639ms, p90 8,9 detik, p99 159 detik.
 * Polling tetap 250ms membayar ekor panjang itu dengan tarif penuh — 36,3 panggilan per
 * kandidat, yaitu 68% dari SELURUH konsumsi RPC. Kuota Helius gratis cuma 0,386 kredit/detik,
 * jadi ini bukan kerapian melainkan penentu berapa hari bot bisa hidup sebulan.
 *
 * Invarian: kasus CEPAT tidak boleh melambat berarti (polling awal tetap rapat), dan
 * jumlah panggilan pada kasus lambat harus turun drastis.
 */
import { readFileSync } from "node:fs";
let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  → ${got}, harus ${want}`}`); if (!ok) fail++; };

/** Meniru jadwal: berapa panggilan & kapan mint ketemu, untuk mint yang muncul di `visibleAt` ms. */
function sim(visibleAt, cap = 8000, tiered = true) {
  let t = 0, delay = 250, calls = 0, polls = 0;
  for (;;) {
    calls++;
    if (t >= visibleAt) return { calls, foundAt: t };
    if (t >= cap) return { calls, foundAt: null };
    t += Math.min(delay, Math.max(0, cap - t));
    if (tiered && ++polls >= 3) delay = Math.min(Math.round(delay * 1.6), 2500);
  }
}
console.log("A. perilaku jadwal");
const fast = sim(328), fastOld = sim(328, 8000, false);
console.log(`    p50 (328ms): bertingkat ${fast.calls} panggilan @${fast.foundAt}ms · tetap ${fastOld.calls} @${fastOld.foundAt}ms`);
check("kasus p50 IDENTIK dengan sebelumnya", fast.calls === fastOld.calls && fast.foundAt === fastOld.foundAt, true);
check("kasus p50 tidak melambat >300ms", (fast.foundAt - fastOld.foundAt) <= 300, true);
const slow = sim(8000), slowOld = sim(8000, 8000, false);
console.log(`    kasus lambat (8s): bertingkat ${slow.calls} · tetap ${slowOld.calls}`);
// Ambang 60% dipilih supaya ada ruang bagi tiga polling rapat di awal (yang sengaja
// dipertahankan agar kasus cepat identik). Nilai nyata sekarang ~70%; ambang di bawahnya
// supaya test menangkap regresi tanpa gagal karena penyetelan kecil yang disengaja.
check(`kasus lambat hemat >60% panggilan (nyata ${(100-slow.calls/slowOld.calls*100).toFixed(0)}%)`,
  slow.calls < slowOld.calls * 0.4, true);
check("berhenti di cap, tidak selamanya", sim(999999).foundAt === null, true);

console.log("B. sumber asli");
const src = readFileSync("src/safety/onchain.ts", "utf8");
check("jeda melebar (×1.6)", src.includes("Math.round(delay * 1.6)"), true);
check("tiga polling pertama tetap rapat", src.includes("if (++polls >= 3)"), true);
check("jeda dibatasi 2500ms", src.includes("2_500"), true);
check("tetap fail-open (bukan gerbang)", src.includes("return { visible: false, waitedMs: Date.now() - started }"), true);
check("cap maxWaitMs masih dihormati", src.includes("Date.now() - started >= maxWaitMs"), true);
console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail}`);
process.exit(fail ? 1 : 0);
