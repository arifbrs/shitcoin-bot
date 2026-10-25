/**
 * ADAPTER Pump.fun DEVELOPER API (read-only, backend-only) — FINAL.
 * Endpoint terdokumentasi: /home-feed/new, /home-feed, /callout/coin/{coin},
 * /callout/{calloutId}, /user-positions/{userId}, /user-trades/{id}, /mint-positions/{mint}.
 * Kunci HANYA server-side (env PUMPFUN_API_KEY). TANPA kunci → setiap panggilan live
 * gagal ter-tutup (gagal-tutup) `PUMPFUN_API_KEY_MISSING` (blockedExternal) — TIDAK ada
 * respons karangan; fixture deterministik dipakai untuk pengujian offline.
 */
import { ApiResult, HomeFeedItem, Callout, UserPosition, UserTrade, MintPosition, SourceStamp, type Candle, type CandleInterval, type TradeEvent } from "./types.js";

const BASE = process.env.PUMPFUN_API_BASE?.trim() || "https://frontendapi.pump.fun";
const SWAP_BASE = "https://swap-api.pump.fun";

function key(): string | null {
  const k = process.env.PUMPFUN_API_KEY?.trim();
  return k && k.length > 8 ? k : null;
}

async function devGet<T>(path: string): Promise<ApiResult<T>> {
  const k = key();
  if (!k) return { ok: false, reason: "PUMPFUN_API_KEY_MISSING (Developer API butuh persetujuan operator — BLOCKED_EXTERNAL)", blockedExternal: true };
  try {
    const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: `PUMPFUN_HTTP_${res.status} (scope/izin)`, blockedExternal: true };
    if (!res.ok) return { ok: false, reason: `PUMPFUN_HTTP_${res.status}`, blockedExternal: false };
    const fetchedAt = Date.now();
    return { ok: true, data: (await res.json()) as T, stamp: { source: "pumpfun-developer-api", observedAt: fetchedAt, fetchedAt } };
  } catch (e) {
    return { ok: false, reason: `PUMPFUN_NETWORK:${(e as Error).name}`, blockedExternal: false };
  }
}

export const pumpfunApi = {
  homeFeedNew: (): Promise<ApiResult<HomeFeedItem[]>> => devGet<HomeFeedItem[]>("/home-feed/new"),
  homeFeed: (): Promise<ApiResult<HomeFeedItem[]>> => devGet<HomeFeedItem[]>("/home-feed"),
  calloutsForCoin: (coin: string): Promise<ApiResult<Callout[]>> => devGet<Callout[]>(`/callout/coin/${encodeURIComponent(coin)}`),
  callout: (calloutId: string): Promise<ApiResult<Callout>> => devGet<Callout>(`/callout/${encodeURIComponent(calloutId)}`),
  userPositions: (userId: string): Promise<ApiResult<UserPosition[]>> => devGet<UserPosition[]>(`/user-positions/${encodeURIComponent(userId)}`),
  userTrades: (id: string): Promise<ApiResult<UserTrade[]>> => devGet<UserTrade[]>(`/user-trades/${encodeURIComponent(id)}`),
  mintPositions: (mint: string): Promise<ApiResult<MintPosition[]>> => devGet<MintPosition[]>(`/mint-positions/${encodeURIComponent(mint)}`),
  hasKey: () => key() != null,
};

// ── Sumber bebas-kunci (swap-api, terverifikasi live 2026-07-22) ──────────────
const num = (v: unknown): number => (typeof v === "string" ? parseFloat(v) || 0 : typeof v === "number" ? v : 0);

/** Tape trades mentah ter-timestamp (best-effort → null; identitas dedupe terbaik yang tersedia). */
export async function swapApiTrades(mint: string, solUsd: number | null): Promise<TradeEvent[] | null> {
  try {
    const res = await fetch(`${SWAP_BASE}/v2/coins/${mint}/trades`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { trades?: Array<Record<string, unknown>> };
    const fetchedAt = Date.now();
    return (body.trades ?? []).map((t) => {
      const side = String(t.type ?? "").toLowerCase() === "sell" ? "sell" : "buy";
      const sol = num(t.amountSol);
      const ts = typeof t.timestamp === "string" ? (parseFloat(t.timestamp) * 1000) : (num(t.timestamp) || fetchedAt);
      const wallet = t.userAddress ? String(t.userAddress) : undefined;
      // swap-api tidak mengekspos signature; identitas instruksional terbaik = wallet+ts+side+sol.
      return { dedupeKey: `${wallet ?? "?"}:${ts}:${side}:${sol}`, mint, wallet, side, sol, usd: solUsd != null ? sol * solUsd : null, ts };
    });
  } catch { return null; }
}

/** OHLCV mentah (reuse endpoint candle publik; interval 1s/1m didukung sumber). */
export async function swapApiCandles(mint: string, interval: CandleInterval, limit: number): Promise<Candle[] | null> {
  try {
    const res = await fetch(`${SWAP_BASE}/v1/coins/${mint}/candles?interval=${interval}&limit=${limit}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const arr = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr) || arr.length < 2) return null;
    return arr
      .map((c) => ({ ts: num(c.timestamp) * 1000, open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volumeSol: num(c.volume) }))
      .filter((c) => c.high > 0 && c.low > 0 && c.close > 0)
      .sort((a, b) => a.ts - b.ts);
  } catch { return null; }
}
