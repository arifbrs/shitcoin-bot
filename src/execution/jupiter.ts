import { config } from "../config.js";
import { fetchJson, TokenBucket } from "../util/http.js";

const bucket = TokenBucket.perMinute(config.limits.jupiterPerMin);
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LAMPORTS = 1e9;

const headers: Record<string, string> = config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {};

interface QuoteResponse {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan?: unknown[];
}

/** Raw Jupiter quote. Returns null on any failure (route not found, honeypot, etc.). */
async function quote(inputMint: string, outputMint: string, amountRaw: number): Promise<QuoteResponse | null> {
  try {
    const url = `${config.jupiterBaseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountRaw)}&slippageBps=300`;
    const q = await fetchJson<QuoteResponse>(url, { bucket, headers, timeoutMs: 5_000, retries: 1 });
    return q?.outAmount ? q : null;
  } catch {
    return null;
  }
}

/** SOL price in USD, derived from a real 1-SOL → USDC quote. Cached ~60s. */
let solCache = { price: 0, at: 0 };
export async function solPriceUsd(): Promise<number | null> {
  if (Date.now() - solCache.at < 60_000 && solCache.price > 0) return solCache.price;
  const q = await quote(SOL_MINT, USDC_MINT, LAMPORTS);
  if (!q) return solCache.price > 0 ? solCache.price : null;
  const price = Number(q.outAmount) / 1e6; // USDC has 6 decimals; 1 SOL in
  solCache = { price, at: Date.now() };
  return price;
}

/**
 * REAL sell quote for a GRADUATED coin: how much SOL we'd actually get for `tokenQtyUi`
 * tokens routed through the live AMM (PumpSwap/Raydium) via Jupiter. This replaces the
 * curve-price ESTIMATE for graduation exits (which mispriced against the frozen bonding
 * curve). pump.fun tokens are 6-decimals; SOL out is lamports. Returns null if no route
 * (then the caller keeps the conservative estimate + UNVERIFIED tag). netSol is already
 * net of AMM impact; the caller still subtracts the fixed gas.
 */
export async function jupiterSellSol(tokenMint: string, tokenQtyUi: number): Promise<{ solOut: number; impactPct: number } | null> {
  if (!(tokenQtyUi > 0)) return null;
  const q = await quote(tokenMint, SOL_MINT, tokenQtyUi * 1e6); // 6-decimal token → lamports SOL
  if (!q) return null;
  return { solOut: Number(q.outAmount) / LAMPORTS, impactPct: Math.abs(Number(q.priceImpactPct)) * 100 };
}

/**
 * Build a REAL, UNSIGNED Jupiter swap transaction (v1 /swap). This is the execution leg
 * Strategy 2's live mirror uses: the paper brain picks the token and size, this turns it into
 * bytes. Returns null on any failure (no route, API down) — the caller treats that as a clean
 * refusal, never as a position.
 */
export async function jupiterSwapTx(
  inputMint: string,
  outputMint: string,
  amountRaw: number,
  userPublicKey: string,
): Promise<Uint8Array | null> {
  try {
    const q = await quote(inputMint, outputMint, amountRaw);
    if (!q) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${config.jupiterBaseUrl}/swap/v1/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ quoteResponse: q, userPublicKey, wrapAndUnwrapSol: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { swapTransaction?: string };
      if (!j.swapTransaction) return null;
      const buf = Buffer.from(j.swapTransaction, "base64");
      return buf.length > 100 ? new Uint8Array(buf) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
