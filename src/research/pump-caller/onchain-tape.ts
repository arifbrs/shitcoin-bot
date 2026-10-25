/**
 * TAPE ON-CHAIN TERDEKODE (S8-P4) — dari RPC Solana umum (pooledRpc, bebas-kunci):
 * getSignaturesForAddress(bondingCurve) → getTransaction → delta saldo token pemilik wallet.
 * HANYA transaksi nyata terdekode: signature+slot+wallet+arah+jumlah+SOL delta+blockTime.
 * Identitas dedupe = signature:owner. Ini bukan agregat; GMGN top-traders tetap kontekstual.
 * Terikat kuota: limit kecil (default 10), dipanggil berkala oleh observer dengan cooldown.
 */
import { pooledRpc } from "../../safety/onchain.js";
import type { TradeEvent } from "./types.js";

interface RawTx {
  slot?: number;
  blockTime?: number | null;
  transaction?: { message?: { accountKeys?: string[] } };
  meta?: {
    preBalances?: number[]; postBalances?: number[];
    preTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { uiAmount?: number | null; amount?: string } }>;
    postTokenBalances?: Array<{ accountIndex: number; mint: string; owner?: string; uiTokenAmount?: { uiAmount?: number | null; amount?: string } }>;
  } | null;
}

export interface DecodedTrade extends TradeEvent { signature: string; slot: number | null; sourceTs: number | null }

/** Murni: satu transaksi → trade terdekode per wallet-pemilik-mint (bisa multi). */
export function decodePumpTx(tx: Rawtx | RawTx, mint: string, observedAt: number): DecodedTrade[] {
  const meta = (tx as RawTx).meta;
  const keys = (tx as RawTx).transaction?.message?.accountKeys ?? [];
  if (!meta || !keys.length) return [];
  const tokenAmount = (b: { uiTokenAmount?: { uiAmount?: number | null; amount?: string } } | undefined): number | null => {
    const ui = b?.uiTokenAmount?.uiAmount;
    if (typeof ui === "number" && Number.isFinite(ui) && ui !== 0) return ui;
    const raw = b?.uiTokenAmount?.amount;
    if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(BigInt(raw) / 10n ** 6n) / 1e6; // lamports→unit (presisi mikro utk riset)
    return null;
  };
  const post = new Map<number, { owner?: string; amount: number | null }>();
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint) continue;
    post.set(b.accountIndex, { owner: b.owner ?? keys[b.accountIndex], amount: tokenAmount(b) });
  }
  const pre = new Map<number, number | null>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint !== mint) continue;
    pre.set(b.accountIndex, tokenAmount(b));
  }
  const out: DecodedTrade[] = [];
  const blockTime = meta ? ((tx as RawTx).blockTime ?? null) : null;
  const slot = (tx as RawTx).slot ?? null;
  const signature = String((tx as unknown as { signature?: string }).signature ?? "");
  for (const [idx, p] of post) {
    const owner = p.owner;
    if (!owner) continue;
    const before = pre.get(idx) ?? 0;
    if (p.amount == null) continue;
    const dTok = p.amount - before;
    if (Math.abs(dTok) < 1e-9) continue; // bukan perubahan mint ini utk wallet ini
    const solBefore = meta.preBalances?.[idx] ?? 0, solAfter = meta.postBalances?.[idx] ?? 0;
    const dSolLamports = solAfter - solBefore;
    const dSol = dSolLamports / 1e9;
    const side: "buy" | "sell" = dTok > 0 ? "buy" : "sell";
    const sol = Math.abs(dSol);
    const ts = blockTime != null ? blockTime * 1000 : null;
    out.push({
      dedupeKey: `${signature || "sig?"}:${owner}`, mint, wallet: owner, side,
      sol, usd: null, ts: ts ?? observedAt, // ts sumber blockTime; fallback observedAt diberi tahu via sourceTs
      signature, slot, sourceTs: ts,
    });
  }
  return out;
}
type Rawtx = Record<string, unknown>;

/** Ambil tape nyata utk mint (butuh bondingCurveKey dari event launch). Batas kuota ketat. */
export async function onchainTape(mint: string, bondingCurveKey: string, limit = 10): Promise<DecodedTrade[] | null> {
  try {
    const sigs = await pooledRpc<{ signature: string }[]>("getSignaturesForAddress", [bondingCurveKey, { limit }]);
    if (!Array.isArray(sigs) || !sigs.length) return null;
    const seen = new Set<string>();
    const out: DecodedTrade[] = [];
    for (const s of sigs.slice(0, limit)) {
      const tx = await pooledRpc<RawTx & { signature?: string }>("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0 }]);
      if (!tx) continue;
      const decoded = decodePumpTx({ ...tx, signature: s.signature } as RawTx, mint, Date.now());
      for (const d of decoded) { if (!seen.has(d.dedupeKey)) { seen.add(d.dedupeKey); out.push(d); } }
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  } catch { return null; }
}
