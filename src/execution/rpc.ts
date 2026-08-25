import { Connection } from "@solana/web3.js";
import { pooledRpc, healthyRpcUrls } from "../safety/onchain.js";

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

/**
 * ONE long-lived Connection used ONLY for signature subscriptions (websocket push).
 *
 * Why: `confirmSig` used to discover a landed transaction purely by polling, on a 1.5s cadence —
 * so a tx that lands 400ms after send waits ~1.1s more to be noticed. A websocket notification
 * arrives within milliseconds of the block landing. Measured 2026-08-22: buy exec p50 was 5.41s
 * with the poll-only loop; every ~100-1500ms shaved here is entry/exit latency straight off the
 * money path.
 *
 * web3.js derives the wss:// endpoint from the https:// URL automatically, and a failed socket is
 * INHERENTLY safe here: the caller always keeps its polling fallback running, so a silent
 * websocket costs nothing — it just stops contributing. Cached per endpoint URL (one persistent
 * socket instead of a per-trade handshake); rebuilt lazily if health rotation moves the pick.
 * The connection is never used for method calls — those stay on the rotating pool.
 */
let sigSubConn: { url: string; conn: Connection } | null = null;

export function signatureSubscriptionConn(): Connection | null {
  const url = healthyRpcUrls()[0];
  if (!url) return null;
  if (sigSubConn?.url === url) return sigSubConn.conn;
  try {
    sigSubConn = { url, conn: new Connection(url, { commitment: COMMITMENT }) };
    return sigSubConn.conn;
  } catch {
    sigSubConn = null;
    return null;
  }
}

export async function poolLatestBlockhash(): Promise<string | null> {
  try {
    const r = await pooledRpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: COMMITMENT }]);
    return r?.value?.blockhash ?? null;
  } catch {
    return null;
  }
}

/** Blockhash + its expiry height (what /api/blockhash serves the browser funding flow). */
export async function poolLatestBlockhashFull(): Promise<{ blockhash: string; lastValidBlockHeight: number } | null> {
  try {
    const r = await pooledRpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: COMMITMENT }]);
    return r?.value?.blockhash ? { blockhash: r.value.blockhash, lastValidBlockHeight: r.value.lastValidBlockHeight } : null;
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

/**
 * REAL SOL MOVEMENT OF ONE CONFIRMED TRANSACTION, for our wallet.
 *
 * Returns `post − pre` lamports for `pubkey`, in SOL: negative for a buy (SOL left), positive
 * for a sell (SOL came back). `null` means UNREADABLE — never "zero".
 *
 * WHY THIS EXISTS (audit, 2026-08-25). Both legs used to measure money with a wallet-balance
 * bracket taken around the swap. That is wrong in two different directions and both were
 * measured in production:
 *
 *   · CONTAMINATED. The `after` read happens outside the exec lock, so any other transaction
 *     landing in the gap is attributed to this trade. On 2026-08-22..24 that inflated one 0.01◎
 *     buy to a booked 0.0368◎, and pushed 25% of buys BELOW their own order size.
 *   · ASYMMETRIC. The 2026-08-24 "exact spend" fix replaced the buy bracket with the order size
 *     (0.01◎) while the sell leg kept its balance delta — which includes the ATA rent coming
 *     back. Every trade after it was booked ≈0.0023◎ too good: +20.6% of notional, verified
 *     against 135/135 on-chain transactions. It turned a real −15.65% into a printed +1.71%.
 *
 * The transaction's own pre/post balances are immune to both: they are that transaction's
 * effect and nothing else's, no matter what else the wallet was doing at the same moment.
 * Fees, priority fees, ATA rent paid and ATA rent reclaimed are all inside the number.
 */
export async function poolTxWalletDelta(signature: string, pubkey: string): Promise<number | null> {
  try {
    const r = await pooledRpc<{
      meta: { preBalances: number[]; postBalances: number[]; err: unknown } | null;
      transaction: { message: { accountKeys: Array<{ pubkey: string } | string> } };
    }>("getTransaction", [
      signature,
      { commitment: COMMITMENT, maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
    ]);
    if (!r?.meta) return null;                       // not yet visible, or dropped
    const keys = r.transaction?.message?.accountKeys ?? [];
    const i = keys.findIndex((k) => (typeof k === "string" ? k : k?.pubkey) === pubkey);
    if (i < 0) return null;                          // our wallet is not in this tx at all
    const pre = r.meta.preBalances?.[i], post = r.meta.postBalances?.[i];
    if (typeof pre !== "number" || typeof post !== "number") return null;
    return (post - pre) / 1e9;
  } catch {
    return null;
  }
}
