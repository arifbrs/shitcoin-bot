import { pooledRpc } from "../safety/onchain.js";

/**
 * MAINNET RPC FOR THE MONEY PATH — every call routed through the rotating pool.
 *
 * Why this file exists. `safety/onchain.ts` documents, twice and with measurements, that a raw
 * `new Connection(config.rpcUrl)` bypasses the pool completely: no rotation, no escalating
 * backoff, no rate limiting, and it keeps hammering endpoint #0 long after the pool has benched
 * it for 429s. `simulateBuyMainnet` was fixed for exactly that in July 2026 — but the LIVE
 * functions right next to it were not, because at the time nothing called them.
 *
 * The consequence, once they are wired up, is not a slow read. It is this: a 429 on endpoint #0
 * makes every balance read return null, the bridge correctly refuses to sell blind (fail-closed),
 * and after `maxSellFailures` it HALTS — with a real bag still on-chain. A stuck position caused
 * by one throttled free-tier key, while four other endpoints sat idle and healthy.
 *
 * ── On retrying a SEND across endpoints ──────────────────────────────────────────────────
 * Rotation on `sendTransaction` is safe here, and the reason is worth stating because the
 * opposite assumption ("never retry a send") is the usual one. We sign FIRST and then send the
 * identical serialized bytes: the signature is fixed before the first send, so the network
 * deduplicates: the same transaction landing twice is impossible. The realistic failure of a
 * retry is an expired blockhash, which is a clean rejection, not a double spend.
 */

const COMMITMENT = "confirmed" as const;

/** Wallet SOL. `null` means UNKNOWN (every endpoint failed) — never treat it as zero. */
export async function poolBalanceSol(pubkey: string): Promise<number | null> {
  try {
    const r = await pooledRpc<{ value: number }>("getBalance", [pubkey, { commitment: COMMITMENT }]);
    return typeof r?.value === "number" ? r.value / 1e9 : null;
  } catch {
    return null;
  }
}

/** Submit an already-signed transaction. Throws on total failure across the pool. */
export async function poolSendRawTransaction(bytes: Uint8Array): Promise<string> {
  return pooledRpc<string>("sendTransaction", [
    Buffer.from(bytes).toString("base64"),
    { encoding: "base64", skipPreflight: false, maxRetries: 2, preflightCommitment: COMMITMENT },
  ]);
}

export interface SigStatus {
  confirmed: boolean;
  err: string | null;
  found: boolean;
}

/** One signature-status poll. `found: false` = the network has not seen it (yet). */
export async function poolSignatureStatus(signature: string): Promise<SigStatus> {
  const r = await pooledRpc<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>(
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: false }],
  );
  const v = r?.value?.[0];
  if (!v) return { confirmed: false, err: null, found: false };
  if (v.err) return { confirmed: false, err: JSON.stringify(v.err), found: true };
  const done = v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized";
  return { confirmed: done, err: null, found: true };
}

export async function poolLatestBlockhash(): Promise<string | null> {
  try {
    const r = await pooledRpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: COMMITMENT }]);
    return r?.value?.blockhash ?? null;
  } catch {
    return null;
  }
}

export interface PoolAccount {
  owner: string;
  lamports: number;
}

/** Account owner + lamports, or `null` if the account does not exist. Throws on RPC failure. */
export async function poolAccountOwner(pubkey: string): Promise<PoolAccount | null> {
  const r = await pooledRpc<{ value: { owner: string; lamports: number } | null }>("getAccountInfo", [
    pubkey,
    { encoding: "base64", commitment: COMMITMENT },
  ]);
  return r?.value ? { owner: r.value.owner, lamports: r.value.lamports } : null;
}

/** Raw token amount as a string ("0" for empty). `null` = unreadable, NOT empty. */
export async function poolTokenAccountAmount(pubkey: string): Promise<string | null> {
  try {
    const r = await pooledRpc<{ value: { amount: string } }>("getTokenAccountBalance", [
      pubkey,
      { commitment: COMMITMENT },
    ]);
    return r?.value?.amount ?? null;
  } catch {
    return null;
  }
}
