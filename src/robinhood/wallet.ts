/**
 * WALLET BOT — ROBINHOOD CHAIN (EVM, chain 4663) — 2026-10-13.
 *
 * Keputusan operator: bot memakai wallet SENDIRI (bukan MetaMask). Berkas ini:
 *  - membuat kunci EVM (viem) bila belum ada, menyimpannya 0600 di logs/ (gitignored),
 *  - menurunkan & menampilkan ALAMAT untuk pendanaan,
 *  - TIDAK menandatangani transaksi apa pun (signer hidup terpisah; lane tak pernah melihat kunci).
 *
 * Pakai: npm run rh:wallet            → tampilkan alamat + cara pendanaan
 *        npm run rh:wallet -- --new   → buat kunci baru (menimpa) — hanya bila memang mau
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const KEY_PATH = join(config.logDir, "rh-wallet.key");
const FUNDING_NOTE = [
  "  Dana yang dibutuhkan: (a) gas chain RH (aset native; ≈0,035–0,143 gwei → biaya praktis nol),",
  "  (b) modal swap (WETH untuk beli, atau token untuk jual). Kirim ke alamat di atas.",
  "  Untuk GMGN (bila paket dibuka): alamat ini harus diikat ke API key (binding di dashboard GMGN).",
];

async function main(): Promise<void> {
  const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
  const wantNew = process.argv.includes("--new");
  let key: `0x${string}` | null = null;
  if (!wantNew && existsSync(KEY_PATH)) {
    const raw = readFileSync(KEY_PATH, "utf8").trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(raw)) key = raw as `0x${string}`;
    else console.log("  PERINGATAN: berkas kunci ada tapi formatnya bukan hex 32 byte — tidak dipakai.");
  }
  if (!key) {
    key = generatePrivateKey();
    writeFileSync(KEY_PATH, key, { mode: 0o600 });
    try { chmodSync(KEY_PATH, 0o600); } catch { /* best-effort */ }
    console.log(`  kunci BARU dibuat: ${KEY_PATH} (0600, gitignored)`);
  }
  const account = privateKeyToAccount(key);
  console.log("\n  ══ WALLET BOT (Robinhood Chain, chainId 4663) ══");
  console.log(`  alamat : ${account.address}`);
  console.log(`  kunci  : ${KEY_PATH} (0600) — JANGAN pernah ditempel di chat/log; proses lane TIDAK membacanya`);
  console.log("\n  Cara pendanaan:");
  for (const l of FUNDING_NOTE) console.log(l);
  console.log("");
}

void main();
