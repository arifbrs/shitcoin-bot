/**
 * SELFTEST — "kosong" tidak boleh dibaca sebagai "nol" pada hitungan holder.
 *
 * Terukur 2026-08-12: DAS Helius berhenti mengindeks mint baru sekitar 03:50 UTC dan
 * mengembalikan array kosong. Kode lama mempercayainya sebagai 0 holder, jadi bot menolak koin
 * hidup — 5 sampel yang ditolak "0 holder" ternyata punya 2/19/12/20/2 pemegang menurut
 * getTokenLargestAccounts. SELURUH entry berhenti 43 menit; jeda normal median 1,7 menit.
 *
 * Ini konflasi yang sama yang sudah dijaga di tempat lain: `drained` vs `readFail` pada harga,
 * `holders == null` vs `holders < min` di papertrader. Satu sumber yang buta tidak boleh
 * mengeluarkan angka yang terdengar pasti.
 */
import { readFileSync } from "node:fs";
let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  → ${got}, harus ${want}`}`); if (!ok) fail++; };

// Tiruan cabang keputusan: DAS dipercaya HANYA kalau mengembalikan minimal satu akun.
const trustDas = accounts => Array.isArray(accounts) && accounts.length > 0;
console.log("A. cabang keputusan");
check("DAS 3 akun → dipercaya",            trustDas([{},{},{}]), true);
check("DAS KOSONG → TIDAK dipercaya",      trustDas([]), false);
check("DAS undefined → tidak dipercaya",   trustDas(undefined), false);
check("DAS bukan array → tidak dipercaya", trustDas({}), false);

console.log("B. sumber asli");
const src = readFileSync("src/safety/onchain.ts", "utf8");
check("syarat panjang > 0 terpasang", src.includes("Array.isArray(accounts) && accounts.length > 0"), true);
check("jalur cadangan getTokenLargestAccounts masih ada",
  src.includes('rpc<LargestAccounts>("getTokenLargestAccounts"'), true);
check("jalur cadangan GMGN masih ada", src.includes("holderCountViaGmgn"), true);
check("kegagalan baca tetap mengembalikan null (bukan 0) di papertrader",
  readFileSync("src/papertrader.ts","utf8").includes('return { opened: false, code: "HOLDER_DATA_UNAVAILABLE" }'), true);
console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail}`);
process.exit(fail ? 1 : 0);
