/**
 * SCANNER paper 1:1 — kandidat HANYA dari token yang lolos QUOTE BELI + QUOTE JUAL.
 * Aturan plan: jika salah satu arah tidak punya rute, token TIDAK masuk kandidat (tidak ada mark).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CHAIN, WETH, decimalsOf, envOf, okxGet, quoteBuy, quoteSell } from "./exec.js";
import { dir } from "./state.js";

export interface Candidate { token: string; symbol: string; decimals: number; buyOk: boolean; sellOk: boolean; buyOut?: string; sellOut?: string; impactPct?: number }

const cachePath = (date = new Date().toISOString().slice(0, 10)) => dir() + "/candidates-" + date + ".json";

/** Token dari daftar OKX (rantai RH), hanya yang kontraknya bukan WETH/USDG dan simbolnya masuk akal. */
export async function listTokens(): Promise<Array<{ token: string; symbol: string }>> {
  const env = envOf();
  const r = await okxGet(`/api/v6/dex/aggregator/all-tokens?chainIndex=${CHAIN}`, env);
  const rows = ((r.data as Array<Record<string, unknown>>) ?? []);
  const skip = new Set([WETH.toLowerCase(), "0x5fc5360d0400a0fd4f2af552add042d716f1d168"]);
  return rows
    .map((t) => ({ token: String(t.tokenContractAddress ?? "").toLowerCase(), symbol: String(t.tokenSymbol ?? "?") }))
    .filter((t) => !skip.has(t.token) && isAcceptable(t.symbol, t.token));
}

/** Penyaring kualitas kandidat: buang token yang "menumpang nama" aset mapan (kasus nyata: token bernama ETH). */
const RESERVED = new Set(["ETH", "WETH", "USDG", "USDC", "USDT", "BTC", "WBTC"]);
export function isAcceptable(symbol: string, token: string): boolean {
  const sym = symbol.trim().toUpperCase();
  if (!sym || sym.length < 2 || sym.length > 20) return false;
  if (RESERVED.has(sym)) return false;
  if (sym.includes("HTTP") || sym.includes("://")) return false;
  return /^0x[0-9a-f]{40}$/i.test(token);
}

/** Uji dua arah. Gagal salah satu → TIDAK kandidat. */
export async function probe(token: string, symbol: string, maker: string, usdRaw = "1000000000000000"): Promise<Candidate> {
  const dec = await decimalsOf(token);
  const buy = await quoteBuy(token, usdRaw, maker);
  let sellOk = false; let sellOut: string | undefined;
  if (buy.ok) {
    const q1e18 = "1" + "0".repeat(dec);
    const sell = await quoteSell(token, q1e18, maker);
    sellOk = Boolean(sell.ok);
    sellOut = sell.quote?.amountOut;
  }
  return { token, symbol, decimals: dec, buyOk: buy.ok, sellOk, buyOut: buy.quote?.amountOut, sellOut, impactPct: buy.quote?.impactPct };
}

/** Pindai sampai `want` kandidat yang lolos dua arah; hasil disimpan sebagai cache harian. */
export async function scanCandidates(maker: string, want = 5, limit = 40): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const all = await listTokens();
  for (const t of all.slice(0, limit)) {
    const c = await probe(t.token, t.symbol, maker);
    if (c.buyOk && c.sellOk) out.push(c);
    if (out.length >= want) break;
  }
  mkdirSync(dir(), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify({ ts: Date.now(), candidates: out }));
  return out;
}

export function loadCandidates(date = new Date().toISOString().slice(0, 10)): Candidate[] {
  try { if (!existsSync(cachePath(date))) return []; return (JSON.parse(readFileSync(cachePath(date), "utf8")).candidates as Candidate[]) ?? []; } catch { return []; }
}
