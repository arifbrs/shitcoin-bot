/**
 * SELFTEST — probe salin KOL, MODE POLLING (menggantikan websocket per 2026-08-15).
 *
 * Kenapa polling: kuota websocket TERPISAH dari kuota HTTP dan habis di kedua penyedia —
 * Helius menolak logsSubscribe dengan 429 meski panggilan HTTP-nya normal, QuickNode menerima
 * 1 langganan tapi menolak 7 dari 7 lalu menutup koneksi. Versi websocket sempat terjebak
 * 38 jam menyambung ulang tiap 5 detik: 20.277 error, dan hantaman itu memperpanjang limitnya.
 *
 * Penyaring berubah bersamaan, dan itu disengaja: getSignaturesForAddress TIDAK mengembalikan
 * log, jadi filter program-token versi websocket mustahil di sini. Penggantinya `err` — >99%
 * lalu lintas pada wallet terkenal adalah transaksi GAGAL milik bot penyalin yang kalah balap
 * (nyhrox: 46.627 dari 46.633 pesan dalam 90 detik). Membuangnya di sumber sudah memotong
 * hampir seluruh pemborosan; sisanya disaring oleh perubahan saldo token di handle().
 */
import { readFileSync } from "node:fs";
let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`  ${ok ? "✓" : "✗"} ${n}${ok ? "" : `  → ${got}, harus ${want}`}`); if (!ok) fail++; };

// Tiruan keputusan antre: buang yang gagal, buang yang sudah pernah dilihat, hormati batas antrean.
const seen = new Set();
const shouldQueue = (sig, err, qlen, max = 500, warmed = true) =>
  !err && !seen.has(sig) && warmed && qlen < max;

console.log("A. keputusan antre");
check("transaksi SUKSES baru → diantre",      shouldQueue("a", null, 0), true);
check("transaksi GAGAL → dibuang",            shouldQueue("b", {InstructionError:1}, 0), false);
seen.add("c");
check("signature sudah terlihat → dibuang",   shouldQueue("c", null, 0), false);
check("antrean penuh → dibuang (bukan menumpuk basi)", shouldQueue("d", null, 500), false);
check("belum disemai → dibuang (riwayat lama)", shouldQueue("e", null, 0, 500, false), false);

console.log("B. sumber asli");
const src = readFileSync("src/kol-copy-probe.mjs", "utf8");
check("memakai polling getSignaturesForAddress", src.includes('rpc("getSignaturesForAddress"'), true);
check("transaksi gagal dibuang di sumber", src.includes("if (s.err || seenSig.has(s.signature)) continue"), true);
check("antrean dibatasi", src.includes("queue.length >= QUEUE_MAX"), true);
check("sapuan pertama hanya menyemai", src.includes("if (!warmedUp) continue"), true);
check("deteksi trade dari perubahan saldo token, bukan tebakan venue",
  src.includes("preTokenBalances") && src.includes("postTokenBalances"), true);
check("TIDAK memakai daftar venue sebagai filter", !src.includes("PUMP_PROGRAMS"), true);
console.log(fail === 0 ? "\nLULUS" : `\nGAGAL ${fail}`);
process.exit(fail ? 1 : 0);
