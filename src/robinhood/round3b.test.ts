/** A1/A2 round-3: gerbang withdraw (murni) + audit env duplikat + control.json fail-closed. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, assert, throws } from "../testing/harness.js";
import { validateWithdraw, withdrawPolicyFromEnv, isSolanaAddress, type WithdrawPolicy } from "../execution/withdraw-gate.js";
import { duplicateEnvKeys, duplicateSecurityKeys, SECURITY_KEYS } from "../util/env-audit.js";

const DEST = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"; // alamat base58 sah (bentuk, bukan milik siapa pun)
const OTHER = "BnQ7jA9WLnGkpwFZ6LBfB3vWqxSibHa7m4DpXBYh6bYt";

test("A1 withdraw: jumlah NaN/≤0 ditolak eksplisit (temuan F9), 'all' = saldo − fee", () => {
  const base: WithdrawPolicy = { allowlist: [], maxSol: null, origin: null, expectedOrigin: null };
  const d1 = validateWithdraw({ destination: DEST, amount: Number("bukan-angka"), balanceSol: 1, feeSol: 0.000005 }, base);
  assert(!d1.ok && d1.reason.includes("NaN"), "NaN ditolak dengan alasan jelas");
  const d2 = validateWithdraw({ destination: DEST, amount: 0, balanceSol: 1, feeSol: 0.000005 }, base);
  assert(!d2.ok, "nol ditolak");
  const d3 = validateWithdraw({ destination: DEST, amount: "all", balanceSol: 1, feeSol: 0.000005 }, base);
  assert(d3.ok && Math.abs(d3.amountSol - (1 - 0.000005)) < 1e-12, "'all' = saldo − fee");
  const d4 = validateWithdraw({ destination: DEST, amount: 2, balanceSol: 1, feeSol: 0.000005 }, base);
  assert(!d4.ok && d4.reason.includes("spendable"), "lebih besar dari saldo ditolak");
});

test("A1 withdraw: allowlist + plafon hanya aktif bila diisi (default OFF = perilaku lama); origin terpisah", () => {
  const strict: WithdrawPolicy = { allowlist: [DEST], maxSol: 0.05, origin: "http://127.0.0.1:4317", expectedOrigin: "http://127.0.0.1:4317" };
  const d1 = validateWithdraw({ destination: OTHER, amount: 0.01, balanceSol: 1, feeSol: 0.000005 }, strict);
  assert(!d1.ok && d1.reason.includes("ALLOWLIST"), "tujuan di luar allowlist ditolak");
  const d2 = validateWithdraw({ destination: DEST, amount: 0.9, balanceSol: 1, feeSol: 0.000005 }, strict);
  assert(!d2.ok && d2.reason.includes("plafon"), "plafon ditegakkan");
  const d3 = validateWithdraw({ destination: DEST, amount: 0.01, balanceSol: 1, feeSol: 0.000005 },
    { allowlist: [DEST], maxSol: null, origin: "http://evil.example", expectedOrigin: "http://127.0.0.1:4317" });
  assert(!d3.ok && d3.reason.includes("origin"), "origin tak cocok ditolak (CSRF lintas-origin)");
  const off: WithdrawPolicy = { allowlist: [], maxSol: null, origin: null, expectedOrigin: null };
  assert(validateWithdraw({ destination: OTHER, amount: 0.9, balanceSol: 1, feeSol: 0.000005 }, off).ok, "tanpa env: perilaku lama (tujuan bebas, tanpa plafon)");
});

test("A1 withdraw: saldo tak terbaca = TOLAK fail-closed", () => {
  const d = validateWithdraw({ destination: DEST, amount: "all", balanceSol: Number.NaN, feeSol: 0.000005 }, { allowlist: [], maxSol: null, origin: null, expectedOrigin: null });
  assert(!d.ok && d.reason.includes("fail-closed"), "RPC gagal → bukan 'all' = 0, tapi tolak");
});

test("A1 withdraw: env tidak sah ditolak dengan pesan, bukan didiamkan", () => {
  const bad = withdrawPolicyFromEnv({ WITHDRAW_MAX_SOL: "abc" }, null, null);
  assert("error" in bad, "plafon non-angka ditolak");
  const bad2 = withdrawPolicyFromEnv({ WITHDRAW_ALLOWLIST: "bukan-alamat" }, null, null);
  assert("error" in bad2, "allowlist alamat rusak ditolak");
  const ok = withdrawPolicyFromEnv({ WITHDRAW_ALLOWLIST: DEST + ", " + OTHER, WITHDRAW_MAX_SOL: "0.05" }, null, null);
  assert(!("error" in ok) && ok.allowlist.length === 2 && ok.maxSol === 0.05, "env sah diterima, spasi dibersihkan");
});

test("A1 isSolanaAddress: bentuk base58 32–44 karakter", () => {
  assert(isSolanaAddress(DEST), "sah");
  assert(!isSolanaAddress("0x629Ec42444A43A0E02A572587E3A49904542F4E8"), "alamat EVM bukan Solana");
  assert(!isSolanaAddress("short"), "terlalu pendek");
});

test("A2 env-audit: duplikat terdeteksi; irisan keamanan menggerakkan fail-closed arming", () => {
  const text = "A=1\nB=2\n# B=3 (komentar tidak dihitung)\nA=9\nMAX_DAILY_SPEND_SOL=0.10\nMAX_DAILY_SPEND_SOL=9999\n";
  eq(duplicateEnvKeys(text).join(","), "A,MAX_DAILY_SPEND_SOL", "duplikat terdeteksi, komentar diabaikan");
  eq(duplicateSecurityKeys(text).join(","), "MAX_DAILY_SPEND_SOL", "irisan keamanan tepat satu");
  assert((SECURITY_KEYS as readonly string[]).includes("MAX_DAILY_SPEND_SOL"), "kunci itu memang daftar keamanan");
  eq(duplicateSecurityKeys("LIVE_TRADING_CONFIRMED=no\n").join(","), "", "tanpa duplikat = kosong");
});

test("A2 control.json: korup = fail-closed (paused + dry-run); tulis atomik meninggalkan state utuh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "control-test-"));
  process.env.CONTROL_DIR = dir;
  const { readControl, writeControl } = await import("../control.js");
  writeFileSync(join(dir, "control.json"), "{korup");
  const c = readControl();
  eq(c.paused, true, "korup = JEDA (fail-closed, bukan fail-open)");
  eq(c.execMode, "dry-run", "korup = dry-run");
  writeFileSync(join(dir, "control.json"), JSON.stringify({ paused: false, execMode: "simulate", lastCommandId: 7 }));
  const c2 = readControl();
  eq(c2.paused, false, "state sah terbaca utuh");
  eq(c2.lastCommandId, 7, "one-shot id utuh");
  const c3 = writeControl({ paused: true });
  eq(c3.paused, true, "tulis atomik tmp→rename");
  eq(readControl().execMode, "simulate", "tulis parsial tidak menghancurkan field lain");
  delete process.env.CONTROL_DIR;
});
