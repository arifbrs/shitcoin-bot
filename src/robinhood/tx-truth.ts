/**
 * KEBENARAN FILL PER-TRANSAKSI (round-5 #2) — status tx sukses ≠ fill.
 *
 * Bukti fill = receipt sukses + Transfer ERC-20 pada tx ITU yang menyerahkan tokenOutput
 * KEPADA dompet (nilai > 0). Saldo dompet yang sudah/bertambah tidak cukup (aktivitas
 * bersamaan, snapshot RPC basi, atau transfer tak terkait bisa menipu pemeriksa saldo).
 * Core murni (fillFromReceiptLogs) diuji adversarial; verifySwapFill hanya pembungkus RPC.
 */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ParsedLog { address: string; topics: string[]; data: string }

export interface FillProof {
  filled: boolean;
  reason: string | null;
  amountIn: bigint | null; // tokenInput keluar dari dompet pada tx ini (raw)
  amountOut: bigint | null; // tokenOutput masuk ke dompet pada tx ini (raw)
}

function topicToAddress(topic: string): string {
  return "0x" + topic.replace(/^0x/, "").padStart(64, "0").slice(24).toLowerCase();
}

/** Murni: bukti fill dari logs receipt. Nilai BigInt — tanpa konversi float. */
export function fillFromReceiptLogs(
  logs: ParsedLog[],
  opts: { status: string; owner: string; tokenIn: string; tokenOut: string },
): FillProof {
  const owner = opts.owner.toLowerCase(), tokenIn = opts.tokenIn.toLowerCase(), tokenOut = opts.tokenOut.toLowerCase();
  if (opts.status !== "0x1") return { filled: false, reason: "RECEIPT_FAILED", amountIn: null, amountOut: null };
  let amountIn: bigint | null = null, amountOut: bigint | null = null;
  for (const l of logs) {
    if (!l.topics || l.topics.length < 3 || l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const token = l.address.toLowerCase();
    const from = topicToAddress(l.topics[1]!), to = topicToAddress(l.topics[2]!);
    const data = l.data.slice(2);
    if (data.length < 64) continue;
    const value = BigInt("0x" + data.slice(-64));
    if (token === tokenIn && from === owner) amountIn = (amountIn ?? 0n) + value;
    if (token === tokenOut && to === owner) amountOut = (amountOut ?? 0n) + value;
  }
  if (amountOut == null || amountOut === 0n) {
    return { filled: false, reason: amountOut == null ? "NO_TOKEN_OUT_TRANSFER" : "ZERO_TOKEN_OUT", amountIn, amountOut };
  }
  return { filled: true, reason: null, amountIn, amountOut };
}

export type RpcCall = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { message?: string } }>;

export async function verifySwapFill(rpc: RpcCall, txHash: string, opts: { owner: string; tokenIn: string; tokenOut: string }): Promise<FillProof & { txHash: string }> {
  const r = await rpc("eth_getTransactionReceipt", [txHash]);
  if (r.error) return { filled: false, reason: "RECEIPT_RPC_ERROR", amountIn: null, amountOut: null, txHash };
  const x = r.result as { status?: string; logs?: ParsedLog[] } | null;
  if (!x) return { filled: false, reason: "RECEIPT_NOT_FOUND", amountIn: null, amountOut: null, txHash };
  const proof = fillFromReceiptLogs(Array.isArray(x.logs) ? x.logs : [], { status: String(x.status), owner: opts.owner, tokenIn: opts.tokenIn, tokenOut: opts.tokenOut });
  return { ...proof, txHash };
}
