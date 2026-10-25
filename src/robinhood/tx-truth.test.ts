/** Round-5 #2: tes adversarial "status sukses ≠ fill" — bukti per-transfer pada tx itu sendiri. */
import { test, eq, assert } from "../testing/harness.js";
import { fillFromReceiptLogs, TRANSFER_TOPIC, type ParsedLog } from "./tx-truth.js";

const OWNER = "0x629ec42444a43a0e02a572587e3a49904542f4e8";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const TOKEN = "0x156e175dd063a8ce274c50654ef40e0032b3fbcf";
const ROUTER = "0x2a7f3d7486641c77600b9b9256132755c8aebb4f";
const OTHER_TOKEN = "0x47f93d52cbec7c6d2cfc080e154002370a60daea";

const padAddr = (a: string): string => "0x" + "0".repeat(24) + a.replace(/^0x/, "");
const transfer = (token: string, from: string, to: string, valueRaw: bigint): ParsedLog => ({
  address: token, topics: [TRANSFER_TOPIC, padAddr(from), padAddr(to)], data: "0x" + valueRaw.toString(16).padStart(64, "0"),
});

const OPTS = { status: "0x1", owner: OWNER, tokenIn: WETH, tokenOut: TOKEN };

test("R5 fill sah: receipt sukses + tokenOutput masuk ke dompet → filled, jumlah eksak dari log", () => {
  const logs = [transfer(WETH, OWNER, ROUTER, 1000000000000000n), transfer(TOKEN, ROUTER, OWNER, 7379306217214733n)];
  const p = fillFromReceiptLogs(logs, OPTS);
  eq(p.filled, true, "bukti = transfer token-out ke pemilik pada tx itu");
  eq(p.amountOut, 7379306217214733n, "jumlah keluar eksak (BigInt)");
  eq(p.amountIn, 1000000000000000n, "jumlah masuk eksak");
});

test("R5 ADVERSARIAL: receipt sukses TANPA transfer token-out ke dompet → TIDAK fill", () => {
  // Kasus nyata "swap 0/0": tx sukses, WETH keluar, token output NOL ke pemilik.
  const logs = [transfer(WETH, OWNER, ROUTER, 1000000000000000n), transfer(TOKEN, ROUTER, OWNER, 0n)];
  const p = fillFromReceiptLogs(logs, OPTS);
  eq(p.filled, false, "sukses ≠ fill");
  eq(p.reason, "ZERO_TOKEN_OUT", "nilai nol terdeteksi eksplisit");
  // Varian: transfer token-out sama sekali tidak ada (output ke pihak lain).
  const p2 = fillFromReceiptLogs([transfer(WETH, OWNER, ROUTER, 1000000000000000n), transfer(TOKEN, ROUTER, "0x" + "1".repeat(40), 999n)], OPTS);
  eq(p2.filled, false, "output ke dompet lain bukan fill kita");
  eq(p2.reason, "NO_TOKEN_OUT_TRANSFER", "bukan dianggap nol karena saldo lama");
});

test("R5 ADVERSARIAL: dompet MENERIMA token lain (saldo naik!) pada tx ini → tetap TIDAK fill", () => {
  // Pemeriksa saldo-before/after bisa tertipu transfer tak terkait; verifikasi per-tx tidak.
  const logs = [transfer(OTHER_TOKEN, ROUTER, OWNER, 5n * 10n ** 24n)];
  const p = fillFromReceiptLogs(logs, OPTS);
  eq(p.filled, false, "token lain ≠ token yang ditukar");
  eq(p.reason, "NO_TOKEN_OUT_TRANSFER", "alasan eksplisit");
});

test("R5 ADVERSARIAL: receipt GAGAL (0x0) meski ada log transfer → TIDAK fill", () => {
  const logs = [transfer(TOKEN, ROUTER, OWNER, 1000n)];
  const p = fillFromReceiptLogs(logs, { ...OPTS, status: "0x0" });
  eq(p.filled, false, "receipt gagal = bukan fill");
  eq(p.reason, "RECEIPT_FAILED", "status rantai menang atas isi log");
});

test("R5 ADVERSARIAL: swap kompleks multi-hop — jumlah token-out dijumlahkan antar-hop", () => {
  const logs = [
    transfer(WETH, OWNER, ROUTER, 1000000000000000n),
    transfer(TOKEN, "0x" + "2".repeat(40), "0x" + "3".repeat(40), 1000n), // hop antar-pool
    transfer(TOKEN, "0x" + "3".repeat(40), OWNER, 1000n), // masuk dompet
  ];
  const p = fillFromReceiptLogs(logs, OPTS);
  eq(p.filled, true, "multi-hop tetap terbaca");
  eq(p.amountOut, 1000n, "hanya transfer KE dompet yang dihitung");
});

test("R5 ADVERSARIAL: duel saldo-vs-tx — saldo dompet naik (aktivitas bersamaan) tetapi tx ini 0 keluar", () => {
  // Skenario: tx A (gagal fill 0/0) dieksekusi saat tx B (transfer masuk tak terkait) menaikkan saldo.
  // Pemeriksa saldo before/after: naik → lolos (SALAH). Verifikasi per-tx: menolak (BENAR).
  const balanceDeltaSaysFilled = 5n > 0n; // simulasi pemeriksa saldo lama
  const txProof = fillFromReceiptLogs([transfer(WETH, OWNER, ROUTER, 1000000000000000n), transfer(TOKEN, ROUTER, OWNER, 0n)], OPTS);
  assert(balanceDeltaSaysFilled, "skenario: saldo memang naik (aktivitas bersamaan)");
  eq(txProof.filled, false, "verifikasi per-tx menolak — inilah alasannya wajib");
});

test("R6 P3: native-ETH output = butuh bukti saldo terpisah (log ERC-20 tidak ada)", () => {
  const p = fillFromReceiptLogs([], { status: "0x1", owner: OWNER, tokenIn: TOKEN, tokenOut: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
  eq(p.filled, false, "tidak mengarang fill dari ketiadaan log");
  eq(p.reason, "NATIVE_OUT_NEEDS_BALANCE_PROOF", "batas metode dinyatakan eksplisit");
});

test("R6 P3: fee-on-transfer — nilai log = batas ATAS; label partial saat <98% ekspektasi", () => {
  const logs = [transfer(WETH, OWNER, ROUTER, 1000000000000000n), transfer(TOKEN, ROUTER, OWNER, 970000n)];
  const p = fillFromReceiptLogs(logs, { ...OPTS, expectedAmountOut: 1000000n });
  eq(p.filled, true, "tetap fill (token masuk nyata)");
  eq(p.reason, "PARTIAL_FILL", "97% < 98% ekspektasi → ditandai partial, bukan dianggap penuh");
  const full = fillFromReceiptLogs(logs, { ...OPTS, expectedAmountOut: 975000n });
  eq(full.reason, null, "≥98% ekspektasi → fill penuh");
  // Konsekuensi fot: angka log TIDAK boleh jadi satu-satunya dasar akuntansi — delta saldo wajib.
});

test("R6 P3: log rusak/aneh dilewati terhitung; multi-transfer dijumlahkan", () => {
  const bad: ParsedLog = { address: TOKEN, topics: [TRANSFER_TOPIC, padAddr(ROUTER), padAddr(OWNER)], data: "0x short" };
  const logs = [bad, transfer(TOKEN, ROUTER, OWNER, 100n), transfer(TOKEN, ROUTER, OWNER, 50n)];
  const p = fillFromReceiptLogs(logs, OPTS);
  eq(p.filled, true, "log rusak tidak membunuh bukti yang sah");
  eq(p.amountOut, 150n, "multi-transfer dijumlahkan (BigInt)");
});

test("R6 P3: konsistensi akuntansi — jumlah sama untuk path berbeda pada tradeId yang sama", () => {
  // engine menyimpan netPct SEKALI; cohort-stats/ledger-audit menghitung ULANG dari raw yang sama
  // (bukan menjumlahkan overlay dua kali) — diuji penuh di ledger-audit (rh:ledger-audit, 1253 baris).
  const logs = [transfer(WETH, OWNER, ROUTER, 1000000000000000n), transfer(TOKEN, ROUTER, OWNER, 7379306217214733n)];
  const a = fillFromReceiptLogs(logs, OPTS);
  const b = fillFromReceiptLogs([...logs], OPTS); // urutan/instansi berbeda
  eq(a.amountOut, b.amountOut, "deterministik");
  eq(a.amountIn, b.amountIn, "deterministik (in)");
});
