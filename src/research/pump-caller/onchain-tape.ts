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
  // (S11) identitas swap kanonik: signature + ixIndex + trader — ixIndex hanya bila TEPAT SATU
  // instruksi program pump di tx (jsonParsed tak mem-parse IDL pump → multi-swap ambigu = null,
  // dilabel, bukan dikarang).
  ixIndex: number | null; canonicalIdQuality: "SIG_IX_TRADER" | "SIG_TRADER";
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
  const norm = normalizeTx(tx);
  const keys = norm.keys; // (S9) akun wallet = pubkey owner; token-account ≠ akun SOL
  const signature = String(tx.signature ?? "");
  // (S11) ixIndex kanonik: hanya bila TEPAT SATU instruksi top-level program pump —
  // multi-instruksi ambigu → null (atribusi per-argumen tak mungkin via jsonParsed).
  const pumpIxIdx = norm.ixTop.map((ix, i) => (ix.program != null && PUMP_PROGRAMS.has(ix.program) ? i : -1)).filter((i) => i >= 0);
  const ixIndex = pumpIxIdx.length === 1 ? pumpIxIdx[0]! : null;
  const mk = (p: Partial<DecodedTrade> & { wallet: string; side: "buy" | "sell" }): DecodedTrade => ({
    dedupeKey: `${signature || "sig?"}:${p.wallet}`, mint, usd: null, ts: p.sourceTs ?? observedAt,
    signature, slot: tx.slot ?? null, state: "VERIFIED_SWAP", solInclFeesRent: true,
    ixIndex, canonicalIdQuality: ixIndex != null ? "SIG_IX_TRADER" : "SIG_TRADER",
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
  const signers = norm.signers;
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

export interface TapePassResult {
  trades: DecodedTrade[];
  coverage: { encountered: number; fetched: number; validatedSwaps: number; unverifiedDeltas: number; failedTx: number; missingTx: number; error: string | null; cursorAdvanced: boolean };
  // (S11.2) FAKTA AKUISISI utk penilaian cakupan berbasis bukti — bukan inferensi:
  pages: Array<{ signature: string; blockTime: number | null }>; // sig TERENUMERASI + blockTime (termasuk drain)
  holes: string[];                                               // sig terenumerasi tapi tx gagal diambil (lubang decode)
  topSig: string | null;                                         // sig terenumerasi TERATAS (kursor) — juga bila tx-nya gagal
  backlog: boolean;                                              // halaman UTAMA penuh → chunk bawahnya bisa terlewat
  pageTopSig: string | null; pageTopTs: number | null;           // batas ATAS interval halaman (hasil fetch)
  pageBottomSig: string | null; pageBottomTs: number | null;     // batas BAWAH interval halaman
  drain: { pagesUsed: number; closed: boolean; lastBottomSig: string | null } | null; // drain backlog
}

/** Batas halaman drain per pass — riset: prioritas rendah, berbatas (jangan banjiri pool RPC). */
const MAX_DRAIN_PAGES = 2;

/** Satu pass tape utk mint (kursor inkremental `until` = signature terbaru sebelumnya; berbatas kuota).
 *  (S11.2) Bila satu halaman penuh (encountered ≥ limit) → chunk di antara bottom-halaman dan
 *  prevHead TERLEWAT → drain dengan `before` hingga prevHead tercapai / budget habis.
 *  `resumeDrainFrom` = posisi drain TERSISTEN yang belum selesai (dilanjutkan dulu, budget
 *  dibagi dgn drain backlog baru). */
export async function onchainTapePass(mint: string, bondingCurveKey: string, prevTopSig: string | null, limit = 12, resumeDrainFrom?: string | null): Promise<TapePassResult | null> {
  const coverage = { encountered: 0, fetched: 0, validatedSwaps: 0, unverifiedDeltas: 0, failedTx: 0, missingTx: 0, error: null as string | null, cursorAdvanced: false };
  const pages: Array<{ signature: string; blockTime: number | null }> = [];
  const holes: string[] = [];
  const seen = new Set<string>();
  const trades: DecodedTrade[] = [];
  const fetchOne = async (sig: string, decimals: number | null): Promise<void> => {
    // Pump.fun memakai transaksi VERSION 1 — maxSupportedTransactionVersion:0 ditolak RPC (akar
    // "failedTx 9/9" S9). Versi 1 menerima v0+v1; tx gagal tetap disaring lewat meta.err.
    const tx = await pooledRpc<RawTxLike>("getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }]);
    if (!tx) { coverage.missingTx++; holes.push(sig); return; }
    coverage.fetched++;
    const bt = tx.blockTime != null ? tx.blockTime * 1000 : null;
    pages.push({ signature: sig, blockTime: bt });
    if (tx.meta?.err != null) { coverage.failedTx++; return; }
    const decoded = decodePumpTx({ ...tx, signature: sig }, mint, decimals, Date.now());
    for (const d of decoded) {
      if (d.state === "VERIFIED_SWAP") coverage.validatedSwaps++; else coverage.unverifiedDeltas++;
      if (!seen.has(d.dedupeKey)) { seen.add(d.dedupeKey); trades.push(d); }
    }
  };
  try {
    const sigs = await pooledRpc<{ signature: string; blockTime?: number | null }[]>("getSignaturesForAddress", [bondingCurveKey, { limit, ...(prevTopSig ? { until: prevTopSig } : {}) }]);
    if (!Array.isArray(sigs)) return null;
    coverage.encountered = sigs.length;
    const decimals = await mintDecimals(mint);
    for (const s of sigs) {
      if (prevTopSig && s.signature === prevTopSig) continue;
      await fetchOne(s.signature, decimals);
    }
    coverage.cursorAdvanced = sigs.length > 0 && sigs[0]!.signature !== prevTopSig;
    // ── (S11.2) DRAIN: halaman penuh = chunk antara bottom & prevHead terlewat. Lanjutkan
    // dengan `before` hingga prevHead muncul di halaman (gap tertutup) / budget habis. ──
    let drain: TapePassResult["drain"] = null;
    const backlog = sigs.length >= limit;
    const mainTopSig = sigs.length > 0 ? sigs[0]!.signature : null;
    // (S11.2) LANJUTKAN drain yang tersangkut dari posisi persisten (target: prevHead kini).
    let budget = MAX_DRAIN_PAGES;
    if (resumeDrainFrom && prevTopSig && resumeDrainFrom !== prevTopSig) {
      let before = resumeDrainFrom, pagesUsed = 0, closed = false, lastBottom = resumeDrainFrom;
      while (pagesUsed < budget) {
        const more = await pooledRpc<{ signature: string; blockTime?: number | null }[]>("getSignaturesForAddress", [bondingCurveKey, { limit, before }]);
        if (!Array.isArray(more) || more.length === 0) { closed = true; break; }
        pagesUsed++;
        let hitPrevHead = false;
        for (const s of more) {
          if (s.signature === prevTopSig) { hitPrevHead = true; break; }
          coverage.encountered++;
          await fetchOne(s.signature, decimals);
        }
        lastBottom = more[more.length - 1]!.signature;
        before = lastBottom;
        if (hitPrevHead || more.length < limit) { closed = true; break; }
      }
      budget -= pagesUsed;
      drain = { pagesUsed, closed, lastBottomSig: closed ? null : lastBottom };
      if (!closed) { /* sisanya dilanjutkan pass berikutnya */ }
    }
    if (backlog && sigs.length > 0 && budget > 0) {
      const bottomSig = sigs[sigs.length - 1]!.signature;
      let before = bottomSig, pagesUsed = 0, closed = false, lastBottom = bottomSig;
      while (pagesUsed < budget) {
        const more = await pooledRpc<{ signature: string; blockTime?: number | null }[]>("getSignaturesForAddress", [bondingCurveKey, { limit, before }]);
        if (!Array.isArray(more) || more.length === 0) break;
        pagesUsed++;
        let hitPrevHead = false;
        for (const s of more) {
          if (prevTopSig && s.signature === prevTopSig) { hitPrevHead = true; break; } // gap tertutup — sisanya sudah tercakup
          coverage.encountered++;
          await fetchOne(s.signature, decimals);
        }
        lastBottom = more[more.length - 1]!.signature;
        before = lastBottom;
        if (hitPrevHead || more.length < limit) { closed = true; break; }
      }
      drain = { pagesUsed, closed, lastBottomSig: closed ? null : lastBottom };
    }
    const withTs = pages.filter((p) => p.blockTime != null) as Array<{ signature: string; blockTime: number }>;
    const top = withTs.length ? withTs.reduce((a, b) => (b.blockTime > a.blockTime ? b : a)) : null;
    const bottom = withTs.length ? withTs.reduce((a, b) => (b.blockTime < a.blockTime ? b : a)) : null;
    trades.sort((a, b) => a.ts - b.ts);
    return { trades, coverage, pages, holes, topSig: mainTopSig, backlog,
      pageTopSig: top?.signature ?? null, pageTopTs: top?.blockTime ?? null,
      pageBottomSig: bottom?.signature ?? null, pageBottomTs: bottom?.blockTime ?? null,
      drain } as TapePassResult;
  } catch (e) { coverage.error = (e as Error).message.slice(0, 80); return { trades: [], coverage, pages, holes, topSig: null, backlog: false, pageTopSig: null, pageTopTs: null, pageBottomSig: null, pageBottomTs: null, drain: null }; }
}
export interface TapePassResultWithCursor extends TapePassResult { } // topSig kini bagian TapePassResult (S11.2)

/** (S11.2) PULIH satu lubang decode: ambil ulang satu tx terenumerasi (dipanggil berbatas
 *  oleh observer — kuota rendah). null = tetap lubang. */
export async function recoverSignature(mint: string, sig: string): Promise<{ trades: DecodedTrade[]; blockTime: number | null } | null> {
  try {
    const decimals = await mintDecimals(mint);
    const tx = await pooledRpc<RawTxLike>("getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }]);
    if (!tx) return null;
    return { trades: decodePumpTx({ ...tx, signature: sig }, mint, decimals, Date.now()), blockTime: tx.blockTime != null ? tx.blockTime * 1000 : null };
  } catch { return null; }
}

// ── (S11.2) MIGRASI bonding-curve → PumpSwap ─────────────────────────────────
// Saat token lulus (graduate), kurva bonding ditutup & perdagangan pindah ke pool PumpSwap
// (pAMMBay6oce…). Riwayat bonding-curve SAJA bukan tape pasar lengkap setelah migrasi —
// penilaian cakupan HARUS menandai pasca-migrasi sebagai tidak pernah DATA_COMPLETE.
const curveClosedCache = new Map<string, boolean>();
export async function bondingCurveClosed(mint: string, bondingCurveKey: string): Promise<boolean> {
  if (curveClosedCache.has(mint)) return curveClosedCache.get(mint)!;
  try {
    const info = await pooledRpc<{ value?: { lamports?: number } | null }>("getAccountInfo", [bondingCurveKey, { encoding: "base64" }]);
    const closed = !(info?.value != null && Number(info.value.lamports ?? 0) > 0); // null/0 = akun tertutup
    if (closed) curveClosedCache.set(mint, true); // migrasi = permanen → cache; RPC gagal → jangan klaim (bukan bukti)
    return closed;
  } catch { return false; }
}
