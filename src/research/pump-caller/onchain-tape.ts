/**
 * TAPE ON-CHAIN TERDEKODE (S9-P0 dikoreksi) — dari RPC Solana umum (pooledRpc).
 * Validasi per transaksi:
 *   1. meta.err == null (tx GAGAL ditolak).
 *   2. Ada instruksi transfer token mint-tersebut (top-level / inner) → kaki SWAP terbukti;
 *      tanpa itu → delta saldo = UNVERIFIED_BALANCE_DELTA (bukan trade).
 *   3. SOL notional = delta lamports akun SOL MILIK WALLET (accountKeys[idx] == owner),
 *      BUKAN accountIndex token-account (bug lama). Label sol_incl_fees_rent (jujur).
 *   4. Desimal mint diambil dari getAccountInfo(mint) (cache) — bukan asumsi 6.
 *   5. Akun token hanya-pre / hanya-post (pembuatan/penutupan) ditangani; CloseAccount
 *      terdeteksi (penjualan penuh / keluar).
 * Hanya swap TERVALIDASI yang layak masuk riset; ambiguitas dilabel, tidak diarang.
 */
import { pooledRpc } from "../../safety/onchain.js";
import { PublicKey } from "@solana/web3.js";
import type { TradeEvent } from "./types.js";

// Program token ditemukan LIVE (2026-10-25): token pump memakai Token-2022 bawaan Pump
// ("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), plus SPL Token standar & Token-2022 umum.
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "TokenzQdBNbLkgHcc8TwG4m3ak7otR59gsCXsP3hHhHxn",
]);
// Program-ID RESMI dari pump-fun/pump-public-docs (S10-P0 — bukan tebakan):
//   docs/PUMP_PROGRAM_README.md: bonding curve = 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
//     buy(user, associated_user, mint, amount, max_sol_cost) / sell(..., min_sol_output)
//   docs/PUMP_SWAP_README.md: AMM = pAMMBay6oceH9fJKBRHGP5D4dD4sWpmSwMn52FMfXEA
//     buy(pool, user, baseOut, maxQuoteIn) / sell(pool, user, baseIn, minQuoteOut)
const PUMP_BONDING_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_SWAP_AMM = "pAMMBay6oceH9fJKBRHGP5D4dD4sWpmSwMn52FMfXEA";
const PUMP_PROGRAMS = new Set([PUMP_BONDING_CURVE, PUMP_SWAP_AMM]);
/** PDA bonding-curve utk mint (seeds resmi ["bonding-curve", mint], program pump) — mint manual
 *  tanpa event launch tetap dapat tape on-chain. */
export function bondingCurvePda(mint: string): string {
  try {
    return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_BONDING_CURVE))[0].toBase58();
  } catch { return ""; }
}

const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
]);

export interface RawTxLike {
  slot?: number; blockTime?: number | null; signature?: string;
  transaction?: { message?: { accountKeys?: string[]; instructions?: Array<{ programIdIndex?: number; accounts?: number[]; data?: string }> } };
  meta?: {
    err?: unknown | null;
    preBalances?: number[]; postBalances?: number[];
    innerInstructions?: Array<{ index?: number; instructions?: Array<{ programIdIndex?: number; accounts?: number[]; data?: string }> }>;
    preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { uiAmount?: number | null; amount?: string } }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { uiAmount?: number | null; amount?: string } }>;
  } | null;
}

export type TradeState = "VERIFIED_SWAP" | "UNVERIFIED_BALANCE_DELTA" | "FAILED_TX" | "NO_TOKEN_CHANGE" | "NO_META";
// poolSide=true → sisi vault pool (konfirmasi arah); hanya poolSide=false yang jadi trade ritel.
export interface DecodedTrade extends TradeEvent {
  signature: string; slot: number | null; sourceTs: number | null; poolSide?: boolean;
  state: TradeState; tokenAmountRaw: string | null; decimals: number | null;
  solInclFeesRent: boolean; closedTokenAccount: boolean; openedTokenAccount: boolean;
  reason?: string;
}

const TRANSFER_DISCRIMINATOR = "3"; // transfer(u64) — discriminator pertama byte transfer SPL

/** Deteksi: apakah ada instruksi transfer token utk mint ini (via perubahan account token mana pun
 *  dari mint ini) — dan apakah program pump termuat (konteks swap). Murni. */
/** Normalisasi bentuk lintas-encoding: json (accountKeys string, ix.data base58) vs jsonParsed
 *  (accountKeys {pubkey}, ix.programId + parsed.type). Evidence hanya butuh: program, parsed type,
 *  dan accounts-indices yang menyentuh akun token mint. */
export interface NormIx { program: string | null; type: string | null; accounts: number[]; pubkeysTouched: string[] }
export function normalizeTx(tx: RawTxLike): { keys: string[]; ixTop: NormIx[]; ixInner: NormIx[]; signers: Set<string> } {
  const rawKeys = tx.transaction?.message?.accountKeys ?? [];
  const keys = rawKeys.map((k) => (typeof k === "string" ? k : String((k as unknown as { pubkey?: string })?.pubkey ?? "")));
  const signers = new Set<string>(rawKeys.map((k) => (typeof k === "string" ? k : String((k as unknown as { pubkey?: string; signer?: boolean })?.pubkey ?? "")))
    .filter((pk, i) => typeof rawKeys[i] === "string" || (rawKeys[i] as unknown as { signer?: boolean })?.signer === true));
  const norm = (ix: Record<string, unknown> | undefined): NormIx => {
    const parsed = ix?.parsed && typeof ix.parsed === "object" ? (ix.parsed as { type?: string; info?: Record<string, unknown> }) : undefined;
    // kumpulkan semua nilai pubkey-string dari parsed.info (source/destination/account/...)
    const pubkeysTouched: string[] = [];
    for (const v of Object.values(parsed?.info ?? {})) if (typeof v === "string" && v.length >= 32 && v.length <= 44) pubkeysTouched.push(v);
    return {
      program: typeof ix?.programId === "string" ? ix.programId
        : ix?.programIdIndex != null ? (keys[Number(ix.programIdIndex)] ?? null) : null,
      type: parsed?.type ?? null,
      accounts: Array.isArray(ix?.accounts) ? (ix.accounts as number[]).map(Number) : [],
      pubkeysTouched,
    };
  };
  const ixTop = (tx.transaction?.message?.instructions ?? []).map((i) => norm(i as unknown as Record<string, unknown>));
  const ixInner = (tx.meta?.innerInstructions ?? []).flatMap((x) => (x.instructions ?? []).map((i) => norm(i as unknown as Record<string, unknown>)));
  return { keys, ixTop, ixInner, signers };
}

export interface SwapEvidence { pumpSwapPresent: boolean; closedAccounts: number; tokenAccountPubkeys: string[] }
export function txSwapEvidence(tx: RawTxLike, mint: string): SwapEvidence {
  const { keys, ixTop, ixInner } = normalizeTx(tx);
  // Akun token mint (indeks) → PUBKEY-nya; instruksi jsonParsed tak membawa accounts-idx,
  // melainkan parsed.info.{source,destination,...} berupa pubkey — cocokkan lewat pubkey.
  const tokenAccountPubkeys = new Set<string>();
  for (const b of [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])]) if (b.mint === mint) tokenAccountPubkeys.add(keys[b.accountIndex] ?? "");
  // (S10-P0) SWAP dibuktikan oleh instruksi buy/sell PROGRAM PUMP RESMI (docs.pump.fun),
  // bukan oleh transfer token (transfer biasa ≠ trade; vault pool ikut berpindah tiap swap).
  let pumpSwapPresent = false, closedAccounts = 0;
  for (const ix of [...ixTop, ...ixInner]) {
    if (ix.program != null && TOKEN_PROGRAMS.has(ix.program) && ix.type === "closeAccount") closedAccounts++;
    if (ix.program != null && PUMP_PROGRAMS.has(ix.program)) pumpSwapPresent = true;
  }
  return { pumpSwapPresent, closedAccounts, tokenAccountPubkeys: [...tokenAccountPubkeys] };
}

/** Murni: satu transaksi → trade per wallet pemilik (multi-wallet didukung). */
export function decodePumpTx(tx: RawTxLike, mint: string, decimals: number | null, observedAt: number): DecodedTrade[] {
  const meta = tx.meta;
  const keys = normalizeTx(tx).keys; // (S9) akun wallet = pubkey owner; token-account ≠ akun SOL
  const signature = String(tx.signature ?? "");
  const mk = (p: Partial<DecodedTrade> & { wallet: string; side: "buy" | "sell" }): DecodedTrade => ({
    dedupeKey: `${signature || "sig?"}:${p.wallet}`, mint, usd: null, ts: p.sourceTs ?? observedAt,
    signature, slot: tx.slot ?? null, state: "VERIFIED_SWAP", solInclFeesRent: true,
    closedTokenAccount: false, openedTokenAccount: false, ...p,
  } as DecodedTrade);
  if (!meta) return [mk({ wallet: "?", side: "buy", sol: 0, tokenAmountRaw: null, state: "NO_META", reason: "meta null" })].filter((t) => t.state !== "NO_META") as DecodedTrade[];
  if (meta.err != null) return []; // FAILED_TX: tx gagal = bukan trade (dicatat caller via coverage)
  const evidence = txSwapEvidence(tx, mint);
  // SOL index milik wallet: cari idx yang accountKeys-nya == owner (akun sistem wallet), BUKAN token acct.
  const ownerSolIdx = new Map<string, number>();
  keys.forEach((k, i) => { if (!ownerSolIdx.has(k)) ownerSolIdx.set(k, i); });
  const rawAmount = (b: { uiTokenAmount?: { uiAmount?: number | null; amount?: string } } | undefined): bigint | null => {
    const a = b?.uiTokenAmount?.amount;
    return typeof a === "string" && /^\d+$/.test(a) ? BigInt(a) : null;
  };
  const post = new Map<number, { owner?: string; raw: bigint | null }>();
  for (const b of meta.postTokenBalances ?? []) if (b.mint === mint) post.set(b.accountIndex, { owner: b.owner ?? keys[b.accountIndex], raw: rawAmount(b) });
  const pre = new Map<number, { owner?: string; raw: bigint | null }>();
  for (const b of meta.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.accountIndex, { owner: b.owner ?? keys[b.accountIndex], raw: rawAmount(b) });
  const out: DecodedTrade[] = [];
  // (S10-P0) poolSide: pemilik akun token ADALAH program pool (PDA) — vault bonding-curve/pool
  // AMM. Sisi pool BUKAN trade ritel; hanya dipakai konfirmasi arah, tak dihitung independen.
  const signers = normalizeTx(tx).signers;
  // poolSide: pemilik akun token = PDA vault (tak menandatangani tx) atau program pool itu
  // sendiri — sisi AMM, bukan trader ritel. Trader = signer (pembayar fee).
  const isPoolOwned = (owner: string): boolean => owner === PUMP_BONDING_CURVE || owner === PUMP_SWAP_AMM || !signers.has(owner);
  for (const [idx, p] of post) {
    const owner = p.owner;
    if (!owner || p.raw == null) continue;
    const before = pre.get(idx)?.raw ?? 0n;
    const dRaw = p.raw - before;
    if (dRaw === 0n) continue;
    const side: "buy" | "sell" = dRaw > 0n ? "buy" : "sell";
    // SOL delta dari AKUN WALLET owner (bukan idx token-account):
    const solIdx = ownerSolIdx.get(owner);
    const solDeltaLamports = solIdx != null ? (meta.postBalances?.[solIdx] ?? 0) - (meta.preBalances?.[solIdx] ?? 0) : null;
    const sol = solDeltaLamports != null ? Math.abs(solDeltaLamports) / 1e9 : null;
    const state: TradeState = evidence.pumpSwapPresent ? "VERIFIED_SWAP" : "UNVERIFIED_BALANCE_DELTA";
    out.push(mk({
      wallet: owner, side, sol: sol ?? 0, tokenAmountRaw: (dRaw < 0n ? -dRaw : dRaw).toString(), decimals: decimals ?? null,
      state, sourceTs: tx.blockTime != null ? tx.blockTime * 1000 : null,
      poolSide: isPoolOwned(owner),
      closedTokenAccount: side === "sell" && evidence.closedAccounts > 0 && p.raw === 0n,
      openedTokenAccount: side === "buy" && !pre.has(idx),
      reason: state === "UNVERIFIED_BALANCE_DELTA" ? "tanpa instruksi buy/sell program pump — transfer biasa ≠ swap" : isPoolOwned(owner) ? "sisi POOL (vault) — bukan trade ritel" : undefined,
    }));
  }
  // akun token hanya-PRE (ditutup di tx ini; saldo post 0 / hilang) → penjualan penuh/keluar:
  for (const [idx, b] of pre) {
    if (post.has(idx) || b.raw == null || b.raw === 0n) continue;
    const owner = b.owner ?? keys[idx];
    if (!owner) continue;
    const solIdx = ownerSolIdx.get(owner);
    const sol = solIdx != null ? Math.abs((meta.postBalances?.[solIdx] ?? 0) - (meta.preBalances?.[solIdx] ?? 0)) / 1e9 : 0;
    out.push(mk({ wallet: owner, side: "sell", sol, tokenAmountRaw: b.raw.toString(), decimals: decimals ?? null,
      state: evidence.pumpSwapPresent ? "VERIFIED_SWAP" : "UNVERIFIED_BALANCE_DELTA",
      sourceTs: tx.blockTime != null ? tx.blockTime * 1000 : null, closedTokenAccount: true }));
  }
  return out;
}

/** Desimal mint (cache per proses) dari getAccountInfo — tanpa asumsi. */
const decimalsCache = new Map<string, number | null>();
export async function mintDecimals(mint: string): Promise<number | null> {
  if (decimalsCache.has(mint)) return decimalsCache.get(mint) ?? null;
  let d: number | null = null;
  try {
    const info = await pooledRpc<{ value?: { data?: [string, string] | { content?: string } } }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const raw = info?.value?.data;
    const hex = Array.isArray(raw) ? raw[0] : raw?.content;
    if (typeof hex === "string" && hex.startsWith("0x")) d = Number(BigInt(hex.slice(0, 66)).toString(16).slice(-2)); // mint layout: desimal di byte 44
    if (Array.isArray(raw)) { // base64 jsonParsed: coba field parsed
      const jp = info?.value?.data as unknown as { parsed?: { info?: { decimals?: number } } };
      if (jp?.parsed?.info?.decimals != null) d = jp.parsed.info.decimals;
    }
  } catch { d = null; }
  decimalsCache.set(mint, d);
  return d;
}

export interface TapePassResult { trades: DecodedTrade[]; coverage: { encountered: number; fetched: number; validatedSwaps: number; unverifiedDeltas: number; failedTx: number; missingTx: number; error: string | null; cursorAdvanced: boolean } }

/** Satu pass tape utk mint (kursor inkremental `until` = signature terbaru sebelumnya; berbatas kuota). */
export async function onchainTapePass(mint: string, bondingCurveKey: string, prevTopSig: string | null, limit = 12): Promise<TapePassResult | null> {
  const coverage = { encountered: 0, fetched: 0, validatedSwaps: 0, unverifiedDeltas: 0, failedTx: 0, missingTx: 0, error: null as string | null, cursorAdvanced: false };
  try {
    const sigs = await pooledRpc<{ signature: string }[]>("getSignaturesForAddress", [bondingCurveKey, { limit, ...(prevTopSig ? { until: prevTopSig } : {}) }]);
    if (!Array.isArray(sigs)) return null;
    coverage.encountered = sigs.length;
    const decimals = await mintDecimals(mint);
    const seen = new Set<string>();
    const trades: DecodedTrade[] = [];
    for (const s of sigs) {
      if (prevTopSig && s.signature === prevTopSig) continue;
      // Pump.fun memakai transaksi VERSION 1 — maxSupportedTransactionVersion:0 ditolak RPC (akar
      // "failedTx 9/9" S9). Versi 1 menerima v0+v1; tx gagal tetap disaring lewat meta.err.
      const tx = await pooledRpc<RawTxLike>("getTransaction", [s.signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }]);
      if (!tx) { coverage.missingTx++; continue; }
      coverage.fetched++;
      if (tx.meta?.err != null) { coverage.failedTx++; continue; }
      const decoded = decodePumpTx({ ...tx, signature: s.signature }, mint, decimals, Date.now());
      for (const d of decoded) {
        if (d.state === "VERIFIED_SWAP") coverage.validatedSwaps++; else coverage.unverifiedDeltas++;
        if (!seen.has(d.dedupeKey)) { seen.add(d.dedupeKey); trades.push(d); }
      }
    }
    coverage.cursorAdvanced = sigs.length > 0 && sigs[0]!.signature !== prevTopSig;
    trades.sort((a, b) => a.ts - b.ts);
    return { trades, coverage, ...(coverage.cursorAdvanced ? { topSig: sigs[0]!.signature } : {}) } as TapePassResult;
  } catch (e) { coverage.error = (e as Error).message.slice(0, 80); return { trades: [], coverage }; }
}
export interface TapePassResultWithCursor extends TapePassResult { topSig?: string }
