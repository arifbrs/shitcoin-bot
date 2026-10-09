import bs58 from "bs58";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { okxBuildSwap, type OkxDexQuote } from "../discovery/okx.js";

/** OKX's sentinel for native SOL. Jupiter uses the wrapped-SOL mint for the same intent. */
export const OKX_NATIVE_SOL = "11111111111111111111111111111111";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";

export interface DecodedOkxTransaction {
  bytes: Uint8Array;
  format: "versioned" | "legacy";
  feePayer: string;
}

export interface OkxSwapTransactionBuild extends DecodedOkxTransaction {
  quote: OkxDexQuote | null;
  buildMs: number;
  /** Worst-case output encoded by OKX after applying the requested slippage. */
  minReceiveAmountRaw: string | null;
  /** OKX's estimate in the chain's smallest native unit (lamports on Solana). */
  estimateGasFeeRaw: string | null;
  slippagePercent: string | null;
}

/**
 * Decode and structurally validate a Base58 Solana transaction returned by OKX.
 *
 * Checking the fee payer is important: the wallet must never blindly sign an opaque API payload
 * that asks a different account to authorize it. This is still not a simulation; preflight in the
 * rotating RPC send path remains the final transaction-level safety check.
 */
export function decodeOkxSolanaTransaction(
  encoded: string,
  expectedFeePayer?: string,
): DecodedOkxTransaction | null {
  if (!encoded || encoded.length > 100_000) return null;
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(encoded);
  } catch {
    return null;
  }
  if (bytes.length < 100) return null;

  try {
    const tx = VersionedTransaction.deserialize(bytes);
    const feePayer = tx.message.staticAccountKeys[0]?.toBase58() ?? "";
    if (!feePayer || (expectedFeePayer && feePayer !== expectedFeePayer)) return null;
    if (tx.message.header.numRequiredSignatures !== 1) return null;
    return { bytes, format: tx.version === "legacy" ? "legacy" : "versioned", feePayer };
  } catch {
    // OKX currently returns v0 transactions on Solana, but accepting legacy keeps the adapter
    // compatible with simple routes and mirrors executor.signSendConfirm's supported formats.
  }

  try {
    const tx = Transaction.from(bytes);
    const feePayer = tx.feePayer?.toBase58() ?? tx.signatures[0]?.publicKey.toBase58() ?? "";
    if (!feePayer || (expectedFeePayer && feePayer !== expectedFeePayer)) return null;
    return { bytes, format: "legacy", feePayer };
  } catch {
    return null;
  }
}

const okxMint = (mint: string): string => mint === WRAPPED_SOL_MINT ? OKX_NATIVE_SOL : mint;

/**
 * One-call Solana swap builder. `/aggregator/swap` already returns a ready-to-sign serialized
 * transaction, so there is no quote→build round trip on the critical path. Nothing is signed or
 * broadcast here.
 */
export async function okxSwapTx(
  inputMint: string,
  outputMint: string,
  amountRaw: number | string,
  userPublicKey: string,
): Promise<OkxSwapTransactionBuild | null> {
  const amount = typeof amountRaw === "number" ? String(Math.floor(amountRaw)) : amountRaw;
  if (!/^\d+$/.test(amount) || BigInt(amount) <= 0n || !userPublicKey) return null;

  const fromTokenAddress = okxMint(inputMint);
  const toTokenAddress = okxMint(outputMint);
  const started = Date.now();
  try {
    const rows = await okxBuildSwap(
      fromTokenAddress,
      toTokenAddress,
      amount,
      userPublicKey,
    );
    const row = rows?.[0];
    const quote = row?.routerResult;
    if (
      !quote ||
      quote.fromTokenAmount !== amount ||
      !quote.toTokenAmount || !/^\d+$/.test(quote.toTokenAmount) || BigInt(quote.toTokenAmount) <= 0n ||
      quote.fromToken?.tokenContractAddress !== fromTokenAddress ||
      quote.toToken?.tokenContractAddress !== toTokenAddress ||
      quote.fromToken?.isHoneyPot === true ||
      quote.toToken?.isHoneyPot === true ||
      (row?.tx?.from != null && row.tx.from !== userPublicKey)
    ) return null;
    const decoded = decodeOkxSolanaTransaction(row?.tx?.data ?? "", userPublicKey);
    if (!decoded) return null;
    return {
      ...decoded,
      quote,
      buildMs: Date.now() - started,
      minReceiveAmountRaw: typeof row.tx?.minReceiveAmount === "string" && /^\d+$/.test(row.tx.minReceiveAmount)
        ? row.tx.minReceiveAmount
        : null,
      estimateGasFeeRaw: typeof quote.estimateGasFee === "string" && /^\d+$/.test(quote.estimateGasFee)
        ? quote.estimateGasFee
        : null,
      slippagePercent: typeof row.tx?.slippagePercent === "string" ? row.tx.slippagePercent : null,
    };
  } catch {
    return null;
  }
}
