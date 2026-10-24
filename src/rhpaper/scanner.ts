/**
 * SCANNER paper 1:1 — kandidat HANYA dari token yang lolos QUOTE BELI + QUOTE JUAL.
 * Aturan plan: jika salah satu arah tidak punya rute, token TIDAK masuk kandidat (tidak ada mark).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { CHAIN, WETH, decimalsOf, envOf, okxGet, quoteBuy, quoteSell } from "./exec.js";
import { dir } from "./state.js";

export interface Candidate { token: string; symbol: string; decimals: number; buyOk: boolean; sellOk: boolean; buyOut?: string; sellOut?: string; impactPct?: number | null;
  liquidityUsd?: number | null; liquiditySource?: "dexscreener" | null; liquidityReason?: string | null; liquidityAt?: number | null }

/** (B3) Likuiditas USD dari baris DexScreener untuk mint — murni, bisa diuji. */
export function liquidityFromDexRows(chain: string, mint: string, rows: unknown[]): number | null {
  const dexChain = chain === "sol" ? "solana" : chain === "eth" ? "ethereum" : chain;
  let best: number | null = null;
  for (const r of rows) {
    const row = r as { chainId?: string; baseToken?: { address?: string }; liquidity?: { usd?: number } };
    if (row?.chainId !== dexChain || row.baseToken?.address?.toLowerCase() !== mint.toLowerCase()) continue;
    const usd = Number(row.liquidity?.usd);
    if (Number.isFinite(usd) && usd > 0 && (best == null || usd > best)) best = usd;
  }
  return best;
}

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
    const sell = await quoteSell(token, buy.quote!.amountOut, maker);
    sellOk = Boolean(sell.ok);
    sellOut = sell.quote?.amountOut;
  }
  return { token, symbol, decimals: dec, buyOk: buy.ok, sellOk, buyOut: buy.quote?.amountOut, sellOut, impactPct: buy.quote?.impactPct };
}

/** Pindai sampai `want` kandidat yang lolos dua arah; hasil disimpan sebagai cache harian.
 *  (B3) Likuiditas DexScreener diambil SEKALI per batch (gratis, tanpa kunci) untuk model fill. */
export async function scanCandidates(maker: string, want = 5, limit = 40): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const all = await listTokens();
  for (const t of all.slice(0, limit)) {
    const c = await probe(t.token, t.symbol, maker);
    if (c.buyOk && c.sellOk) out.push(c);
    if (out.length >= want) break;
  }
  // (R8 P3) Likuiditas point-in-time dengan PROVENANCE: sumber, alasan, waktu — supaya
  // LIQUIDITY_UNKNOWN bisa dibedakan (provider tak punya pair vs gagal fetch vs kondisi pasar).
  // Satu percobaan ulang berbatas pada kegagalan jaringan; TANPA fallback snapshot tua.
  if (out.length) {
    const fetchLiq = async (): Promise<{ ok: boolean; rows: unknown[]; error: string | null }> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(`https://api.dexscreener.com/tokens/v1/${"robinhood"}/${out.map((c) => c.token).join(",")}`, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) {
            const data: unknown = await res.json();
            return { ok: true, rows: Array.isArray(data) ? data as unknown[] : [], error: Array.isArray(data) ? null : "DEX_RESPONSE_SHAPE" };
          }
          if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2_000)); continue; } // retry berbatas
          return { ok: false, rows: [], error: `DEX_HTTP_${res.status}` };
        } catch (e) {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 2_000)); continue; }
          return { ok: false, rows: [], error: `DEX_NETWORK:${(e as Error).name}` };
        }
      }
      return { ok: false, rows: [], error: "DEX_UNREACHABLE" };
    };
    const liq = await fetchLiq();
    const at = Date.now();
    for (const c of out) {
      c.liquidityAt = at;
      if (!liq.ok || liq.error) { c.liquidityUsd = null; c.liquiditySource = null; c.liquidityReason = liq.error ?? "DEX_FAILED"; continue; }
      const usd = liquidityFromDexRows("robinhood", c.token, liq.rows);
      c.liquidityUsd = usd;
      c.liquiditySource = usd != null ? "dexscreener" : null;
      c.liquidityReason = usd != null ? null : "DEXSCREENER_NO_PAIR"; // provider memang tak punya pair ≠ kondisi pasar
    }
  }
  mkdirSync(dir(), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify({ ts: Date.now(), candidates: out }));
  return out;
}

/** Cache dianggap basi bila lebih tua dari `min` menit (default 30) — tanpa ini kandidat tak pernah diperbarui. */
export function cacheStale(min = 30, date = new Date().toISOString().slice(0, 10)): boolean {
  try {
    if (!existsSync(cachePath(date))) return true;
    return (Date.now() - statSync(cachePath(date)).mtimeMs) / 60000 >= min;
  } catch { return true; }
}

export function loadCandidates(date = new Date().toISOString().slice(0, 10)): Candidate[] {
  try { if (!existsSync(cachePath(date))) return []; return (JSON.parse(readFileSync(cachePath(date), "utf8")).candidates as Candidate[]) ?? []; } catch { return []; }
}
