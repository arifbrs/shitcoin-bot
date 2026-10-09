/**
 * LAPISAN DATA ROBINHOOD CHAIN (Ethereum L2, chain ID 4663) — read-only, keyless.
 *
 * Sumber: GeckoTerminal (discovery + metrik pool + OHLCV historis) dan DexScreener (mark batch
 * + sinyal boosts/profiles). Keduanya GRATIS tanpa key; limit dijaga TokenBucket (GT free tier
 * ~30/menit → bucket 25/menit; DexScreener ratusan/menit → bucket 3/detik).
 *
 * Terverifikasi live 2026-10-07:
 *  - GT network id = "robinhood"; dex: uniswap-v2/v3/v4-robinhood, pancakeswap-v3-robinhood, dst.
 *  - Item pool GT: attributes.{base_token_price_usd, reserve_in_usd, volume_usd.{m5..h24},
 *    price_change_percentage.{m5..h24}, transactions.{m5..h24}.{buys,sells,buyers,sellers},
 *    pool_created_at, fdv_usd, market_cap_usd} + relationships.base_token.data.id = "robinhood_0x…".
 *  - OHLCV: data.attributes.ohlcv_list = [[unixDetik, open, high, low, close, volume], …] terbaru dulu.
 *  - DexScreener /latest/dex/tokens/{addr,addr,…} (≤30) → pairs chainId "robinhood".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TokenBucket, fetchJson, sleep } from "../util/http.js";
import { config } from "../config.js";
import { logRecord, ui } from "../util/log.js";

const GT = "https://api.geckoterminal.com/api/v2";
const DEX = "https://api.dexscreener.com";
const NETWORK = "robinhood";
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

// GT free tier MEMBATASI PER-IP dan jauh lebih ketat dari yang tertulis (terbukti live 2026-10-07:
// beberapa call beruntun → 429 beruntun). Bucket 12/menit + cooldown bersama antar-proses di file
// log — paper, backtest, dan review bisa jalan bersamaan tanpa saling membakar kuota.
const gtBucket = TokenBucket.perMinute(12);
const dexBucket = TokenBucket.perSecond(3);
const GT_COOLDOWN_PATH = join(config.logDir, "gt-cooldown.json");
let gtCooldownUntil = 0;

function readGtCooldown(): number {
  try {
    const j = JSON.parse(readFileSync(GT_COOLDOWN_PATH, "utf8")) as { until?: number };
    return Number(j.until) || 0;
  } catch { return 0; }
}
function setGtCooldown(ms: number): void {
  gtCooldownUntil = Math.max(gtCooldownUntil, Date.now() + ms);
  try { writeFileSync(GT_COOLDOWN_PATH, JSON.stringify({ until: gtCooldownUntil })); } catch { /* best-effort */ }
}
/**
 * Tunggu cooldown GT. Mengembalikan false bila sisa cooldown MELEBIHI maxWaitMs — pemanggil
 * memilih melewati call ini daripada memblokir. Penting untuk tick mark 30 detik: satu call GT
 * yang menunggu 120s cooldown akan membekukan seluruh tick (terjadi live 2026-10-07).
 */
async function gtWait(maxWaitMs = 120_000): Promise<boolean> {
  const until = Math.max(gtCooldownUntil, readGtCooldown());
  const wait = until - Date.now();
  if (wait <= 0) return true;
  if (wait > maxWaitMs) return false;
  await sleep(wait);
  return true;
}
async function gtJson<T>(url: string, maxWaitMs = 120_000): Promise<T> {
  if (!(await gtWait(maxWaitMs))) throw new Error("gt cool-down aktif — call dilewati");
  try {
    return await fetchJson<T>(url, { bucket: gtBucket, timeoutMs: 15_000, retries: 1 });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/429|rate ?limit/i.test(msg)) { setGtCooldown(45_000); ui.warn(`[rh-market] GT 429 — cooldown 45s (${msg.slice(0, 90)})`); }
    throw e;
  }
}

/** Aset besar/stable — BUKAN target strategi meme coin; pool-nya sering mendominasi daftar teratas. */
const MAJOR_SYMBOLS = new Set(["WETH", "ETH", "USDG", "USDC", "USDT", "DAI", "WBTC", "WSTETH", "STETH", "RETH", "USDE", "SUSDE", "SUSD", "WBNB", "WMATIC", "ARB", "OP"]);
export const isMajorSymbol = (symbol: string): boolean => MAJOR_SYMBOLS.has(symbol.trim().toUpperCase());

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export interface PoolMetrics {
  tokenAddress: string; poolAddress: string; symbol: string; name: string; dex: string;
  priceUsd: number | null; liqUsd: number | null; fdvUsd: number | null; mcUsd: number | null;
  vol: Record<string, number | null>; chg: Record<string, number | null>;
  buys: Record<string, number | null>; sells: Record<string, number | null>;
  createdAt: number | null; sources: string[];
}

interface GtPoolItem {
  id?: string; relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } };
  attributes?: {
    address?: string; name?: string; base_token_price_usd?: string; reserve_in_usd?: string;
    fdv_usd?: string; market_cap_usd?: string; pool_created_at?: string;
    volume_usd?: Record<string, string>; price_change_percentage?: Record<string, string>;
    transactions?: Record<string, { buys?: number; sells?: number }>;
  };
}
interface GtPoolsResponse { data?: GtPoolItem[] }

function tokenAddressOf(item: GtPoolItem): string | null {
  const id = item.relationships?.base_token?.data?.id ?? "";
  const addr = id.startsWith(`${NETWORK}_`) ? id.slice(NETWORK.length + 1) : "";
  return ADDRESS.test(addr) ? addr.toLowerCase() : null;
}

export function parseGtPool(item: GtPoolItem, source: string): PoolMetrics | null {
  const a = item.attributes;
  const tokenAddress = tokenAddressOf(item);
  if (!a?.address || !ADDRESS.test(a.address) || !tokenAddress) return null;
  const vol: Record<string, number | null> = {}, chg: Record<string, number | null> = {}, buys: Record<string, number | null> = {}, sells: Record<string, number | null> = {};
  for (const k of ["m5", "m15", "m30", "h1", "h6", "h24"]) {
    vol[k] = num(a.volume_usd?.[k]); chg[k] = num(a.price_change_percentage?.[k]);
    buys[k] = a.transactions?.[k]?.buys ?? null; sells[k] = a.transactions?.[k]?.sells ?? null;
  }
  const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
  return {
    tokenAddress, poolAddress: a.address.toLowerCase(), symbol: (a.name ?? "?").split("/")[0]?.trim() || "?",
    name: a.name ?? "?", dex: item.relationships?.dex?.data?.id ?? "?",
    priceUsd: num(a.base_token_price_usd), liqUsd: num(a.reserve_in_usd), fdvUsd: num(a.fdv_usd), mcUsd: num(a.market_cap_usd),
    vol, chg, buys, sells, createdAt: Number.isFinite(created) ? created : null, sources: [source],
  };
}

async function gtPools(query: string, source: string, pages = 1): Promise<PoolMetrics[]> {
  const out: PoolMetrics[] = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const res = await gtJson<GtPoolsResponse>(`${GT}/networks/${NETWORK}/${query}${query.includes("?") ? "&" : "?"}page=${p}`);
      for (const item of res.data ?? []) {
        const parsed = parseGtPool(item, source);
        if (parsed) out.push(parsed);
      }
    } catch (e) { ui.warn(`[rh-market] ${query} page ${p} gagal: ${(e as Error).message}`); }
  }
  return out;
}

export const gtTopPools = (pages = 1): Promise<PoolMetrics[]> => gtPools("pools", "gt-top", pages);
export const gtNewPools = (): Promise<PoolMetrics[]> => gtPools("new_pools", "gt-new");
export const gtTrendingPools = (): Promise<PoolMetrics[]> => gtPools("trending_pools", "gt-trending");

interface DexPair {
  chainId?: string; dexId?: string; pairAddress?: string; priceUsd?: string; liquidity?: { usd?: number };
  marketCap?: number; fdv?: number; volume?: Record<string, number>; priceChange?: Record<string, number>;
  txns?: Record<string, { buys?: number; sells?: number }>; pairCreatedAt?: number;
  baseToken?: { address?: string; symbol?: string; name?: string };
}
interface DexTokensResponse { pairs?: DexPair[] }

function parseDexPair(p: DexPair, source: string): PoolMetrics | null {
  const addr = p.baseToken?.address;
  if (p.chainId !== NETWORK || !addr || !ADDRESS.test(addr) || !p.pairAddress) return null;
  const vol: Record<string, number | null> = {}, chg: Record<string, number | null> = {}, buys: Record<string, number | null> = {}, sells: Record<string, number | null> = {};
  for (const k of ["m5", "h1", "h6", "h24"]) {
    vol[k] = num(p.volume?.[k]); chg[k] = num(p.priceChange?.[k]);
    buys[k] = p.txns?.[k]?.buys ?? null; sells[k] = p.txns?.[k]?.sells ?? null;
  }
  return {
    tokenAddress: addr.toLowerCase(), poolAddress: p.pairAddress.toLowerCase(), symbol: p.baseToken?.symbol ?? "?", name: p.baseToken?.name ?? "?",
    dex: p.dexId ?? "?", priceUsd: num(p.priceUsd), liqUsd: num(p.liquidity?.usd), fdvUsd: num(p.fdv), mcUsd: num(p.marketCap),
    vol, chg, buys, sells, createdAt: p.pairCreatedAt ?? null, sources: [source],
  };
}

/** Sinyal DexScreener: token Robinhood yang sedang di-boost / punya profil baru (promosi = minat). */
export async function dexPromotedTokens(): Promise<string[]> {
  const out = new Set<string>();
  for (const path of ["token-boosts/latest/v1", "token-boosts/top/v1", "token-profiles/latest/v1"]) {
    try {
      const res = await fetchJson<Array<{ chainId?: string; tokenAddress?: string }>>(`${DEX}/${path}`, { bucket: dexBucket, timeoutMs: 12_000, retries: 2 });
      for (const item of res ?? []) if (item.chainId === NETWORK && item.tokenAddress && ADDRESS.test(item.tokenAddress)) out.add(item.tokenAddress.toLowerCase());
    } catch (e) { ui.warn(`[rh-market] dex ${path} gagal: ${(e as Error).message}`); }
  }
  return [...out];
}

/**
 * Discovery gabungan: pool teratas + pool baru + trending (GT) digabung dengan token yang
 * dipromosikan (DexScreener). Satu token = satu baris; data GT lebih kaya (txns per jendela)
 * sehingga menang atas baris Dex bila token muncul di keduanya.
 */
export async function discoverPools(opts: { topPages?: number } = {}): Promise<PoolMetrics[]> {
  const [top, fresh, trending, promoted] = await Promise.all([
    gtTopPools(opts.topPages ?? 1), gtNewPools(), gtTrendingPools(), dexPromotedTokens(),
  ]);
  const byToken = new Map<string, PoolMetrics>();
  const add = (rows: PoolMetrics[], source: string): void => {
    for (const r of rows) {
      const prev = byToken.get(r.tokenAddress);
      if (!prev) { byToken.set(r.tokenAddress, r); continue; }
      if (prev.sources.includes(source)) continue;
      prev.sources.push(source);
      // GT menang untuk metrik per-jendela; Dex mengisi bila GT kosong.
      for (const k of Object.keys(r.vol)) if (prev.vol[k] == null) prev.vol[k] = r.vol[k] ?? null;
      for (const k of Object.keys(r.chg)) if (prev.chg[k] == null) prev.chg[k] = r.chg[k] ?? null;
    }
  };
  add(top, "gt-top"); add(fresh, "gt-new"); add(trending, "gt-trending");
  for (const addr of promoted) {
    if (!byToken.has(addr)) byToken.set(addr, { tokenAddress: addr, poolAddress: "", symbol: "?", name: "?", dex: "dex-promoted", priceUsd: null, liqUsd: null, fdvUsd: null, mcUsd: null, vol: {}, chg: {}, buys: {}, sells: {}, createdAt: null, sources: ["dex-promoted"] });
  }
  return [...byToken.values()]
    .filter((r) => !isMajorSymbol(r.symbol)) // major/stable bukan target strategi meme coin
    .sort((a, b) => (b.vol["h24"] ?? 0) - (a.vol["h24"] ?? 0))
    .slice(0, 80);
}

export interface TokenMark { tokenAddress: string; symbol: string | null; priceUsd: number | null; liqUsd: number | null; chg: Record<string, number | null>; at: number; source: string }

/** Mark batch via DexScreener (≤30 alamat/call). Token tanpa pair Robinhood di-skip (bukan error). */
export async function markTokens(addresses: string[]): Promise<Map<string, TokenMark>> {
  const out = new Map<string, TokenMark>();
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => ADDRESS.test(a)))];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    try {
      const res = await fetchJson<DexTokensResponse>(`${DEX}/latest/dex/tokens/${chunk.join(",")}`, { bucket: dexBucket, timeoutMs: 12_000, retries: 2 });
      const best = new Map<string, DexPair>();
      for (const p of res.pairs ?? []) {
        if (p.chainId !== NETWORK || !p.baseToken?.address) continue;
        const key = p.baseToken.address.toLowerCase();
        if (!chunk.includes(key)) continue;
        const prev = best.get(key);
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(key, p);
      }
      for (const [key, p] of best) {
        const chg: Record<string, number | null> = {};
        for (const k of ["m5", "h1", "h6", "h24"]) chg[k] = num(p.priceChange?.[k]);
        out.set(key, { tokenAddress: key, symbol: p.baseToken?.symbol ?? null, priceUsd: num(p.priceUsd), liqUsd: num(p.liquidity?.usd), chg, at: Date.now(), source: "dexscreener" });
      }
    } catch (e) { ui.warn(`[rh-market] mark batch gagal (${chunk.length} addr): ${(e as Error).message}`); }
  }
  return out;
}

export interface PoolMark { poolAddress: string; priceUsd: number | null; liqUsd: number | null; at: number; source: "geckoterminal" }

/**
 * MARK BATCH dari GeckoTerminal: satu call `/tokens/multi/{addr,addr,…}` (≤30 alamat) mengembalikan
 * price_usd + total_reserve_in_usd untuk SEMUA alamat sekaligus (terverifikasi live 2026-10-07).
 * Ini jalur mark utama untuk token yang belum terindeks DexScreener — jauh lebih hemat daripada
 * satu call per pool, dan itulah yang membuat cadence mark 30 detik mungkin dijalankan.
 */
export async function gtTokenMarks(addresses: string[], maxWaitMs = 1_500): Promise<Map<string, { priceUsd: number | null; liqUsd: number | null }>> {
  const out = new Map<string, { priceUsd: number | null; liqUsd: number | null }>();
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => ADDRESS.test(a)))];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    try {
      const res = await gtJson<{ data?: Array<{ attributes?: { address?: string; price_usd?: string; total_reserve_in_usd?: string } }> }>(
        `${GT}/networks/${NETWORK}/tokens/multi/${chunk.join(",")}`, maxWaitMs,
      );
      for (const item of res.data ?? []) {
        const a = item.attributes;
        const addr = a?.address?.toLowerCase();
        if (!addr || !chunk.includes(addr)) continue;
        const price = num(a?.price_usd);
        if (price == null || price <= 0) continue;
        out.set(addr, { priceUsd: price, liqUsd: num(a?.total_reserve_in_usd) });
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (!/dilewati/.test(msg)) logRecord("rh-events", { type: "rh-mark-error", source: "geckoterminal-multi", error: msg });
    }
  }
  return out;
}

/**
 * Mark langsung dari POOL GT (bukan batch Dex). Ini fallback wajib: token Robinhood yang baru
 * beberapa menit sering BELUM terindeks DexScreener, dan tanpa fallback ini posisi hidup dipaksa
 * tutup "mark_basi" di 50% (terjadi live 2026-10-07: 9 trade hari-0 mati begitu, padahal poolnya
 * sehat). Sumber = sama dengan discovery, jadi cakupannya konsisten.
 */
export async function gtPoolMark(poolAddress: string, maxWaitMs = 1_500): Promise<PoolMark | null> {
  if (!ADDRESS.test(poolAddress)) return null;
  try {
    const res = await gtJson<{ data?: { attributes?: { base_token_price_usd?: string; reserve_in_usd?: string } } }>(
      `${GT}/networks/${NETWORK}/pools/${poolAddress}`,
      maxWaitMs,
    );
    const price = num(res.data?.attributes?.base_token_price_usd);
    if (price == null || price <= 0) return null;
    return { poolAddress: poolAddress.toLowerCase(), priceUsd: price, liqUsd: num(res.data?.attributes?.reserve_in_usd), at: Date.now(), source: "geckoterminal" };
  } catch (e) {
    logRecord("rh-events", { type: "rh-mark-error", poolAddress, source: "geckoterminal", error: (e as Error).message });
    return null;
  }
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/** Candle historis GT — satu-satunya sumber backtest yang jujur (OHLCV nyata, bukan proxy). */
export async function gtOhlcv(poolAddress: string, kind: "minute" | "hour", aggregate: number, limit: number): Promise<Candle[]> {
  if (!ADDRESS.test(poolAddress)) return [];
  try {
    const res = await gtJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(
      `${GT}/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${kind}?aggregate=${aggregate}&limit=${Math.min(1000, limit)}`,
    );
    const list = res.data?.attributes?.ohlcv_list ?? [];
    return list
      .map((r) => ({ t: (r[0] ?? 0) * 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }))
      .filter((c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.c > 0)
      .sort((a, b) => a.t - b.t);
  } catch (e) {
    logRecord("rh-events", { type: "rh-ohlcv-error", poolAddress, kind, aggregate, error: (e as Error).message });
    return [];
  }
}
