import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

/**
 * Dedicated BOT wallet (separate from any main/Phantom wallet — CONCEPT.md D5).
 *
 * Storage: for devnet + simulate (worthless devnet SOL / never-spent simulate
 * float) the key lives in a gitignored file with 0600 perms. **LIVE mode must
 * use the OS keychain and is hard-blocked here** until that is built — never
 * run real money from a plaintext key file.
 */
let cached: Keypair | null = null;

export function botWallet(): Keypair {
  if (cached) return cached;
  if (existsSync(config.exec.keyFile)) {
    cached = Keypair.fromSecretKey(bs58.decode(readFileSync(config.exec.keyFile, "utf8").trim()));
  } else {
    cached = Keypair.generate();
    mkdirSync(dirname(config.exec.keyFile), { recursive: true });
    writeFileSync(config.exec.keyFile, bs58.encode(cached.secretKey));
    chmodSync(config.exec.keyFile, 0o600);
  }
  return cached;
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
