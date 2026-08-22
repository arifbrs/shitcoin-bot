import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { keychainRead, type KeySource } from "./keystore.js";

/**
 * Dedicated BOT wallet (separate from any main/Phantom wallet — CONCEPT.md D5).
 *
 * Storage, in priority order (execution/keystore.ts):
 *   1. macOS keychain  — where the key belongs once real money is involved
 *   2. gitignored 0600 file — the fallback, and still fine for devnet/simulate
 *   3. generate a new one — first run only
 *
 * The keychain is checked FIRST, so after `npm run wallet keychain-import` a stale key file
 * left on disk can never silently take precedence over the copy you migrated to.
 */
let cached: Keypair | null = null;
let cachedSource: KeySource = "none";

function fromSecret(secret: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(secret.trim()));
}

export function botWallet(): Keypair {
  if (cached) return cached;
  const fromKeychain = keychainRead();
  if (fromKeychain) {
    cached = fromSecret(fromKeychain);
    cachedSource = "keychain";
  } else if (existsSync(config.exec.keyFile)) {
    cached = fromSecret(readFileSync(config.exec.keyFile, "utf8"));
    cachedSource = "file";
  } else {
    cached = Keypair.generate();
    mkdirSync(dirname(config.exec.keyFile), { recursive: true });
    writeFileSync(config.exec.keyFile, bs58.encode(cached.secretKey));
    chmodSync(config.exec.keyFile, 0o600);
    cachedSource = "generated";
  }
  return cached;
}

/** Where the in-use key came from. Empty until botWallet() has been called at least once. */
export function walletSource(): KeySource {
  return cachedSource;
}

export function botPubkey(): string {
  return botWallet().publicKey.toBase58();
}

export async function balanceSol(rpcUrl: string): Promise<number> {
  const conn = new Connection(rpcUrl, "confirmed");
  const lamports = await conn.getBalance(botWallet().publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * WITHDRAW SOL out of the bot wallet to any address (your Phantom / main wallet).
 * The bot wallet is a normal Solana wallet whose key YOU hold — nothing is ever
 * trapped. `amountSol = "all"` sweeps everything minus a tiny fee buffer. Returns
 * the confirmed signature. This is the "get my money back" path.
 */
export async function withdrawSol(rpcUrl: string, destination: string, amountSol: number | "all"): Promise<{ signature: string; sentSol: number }> {
  const conn = new Connection(rpcUrl, "confirmed");
  const from = botWallet();
  const to = new PublicKey(destination); // throws on an invalid address = safety
  const balance = await conn.getBalance(from.publicKey);
  const FEE_BUFFER = 5_000; // leave lamports for the tx fee
  let lamports: number;
  if (amountSol === "all") {
    lamports = balance - FEE_BUFFER;
  } else {
    lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  }
  if (lamports <= 0) throw new Error(`nothing to withdraw (balance ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  if (lamports > balance - FEE_BUFFER) throw new Error(`insufficient balance: have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, need ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} + fee`);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  const signature = await sendAndConfirmTransaction(conn, tx, [from]);
  return { signature, sentSol: lamports / LAMPORTS_PER_SOL };
}
