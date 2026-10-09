/**
 * CHART DATA — satu sumber kebenaran untuk lilin (OHLCV), dipakai CLI `npm run chart` DAN endpoint
 * dashboard `/api/chart`. Tujuannya: kalau aturan sumber berubah, ia berubah di satu tempat.
 *
 * Hasil pengukuran 2026-10-08 (jangan diganti tanpa mengukur ulang):
 *   GeckoTerminal  OHLCV per POOL, tanpa kunci, lintas-chain; limit per-IP KETAT (429 cepat datang,
 *                  dan IP ini dipakai bersama lane Robinhood) → cache + jarak minimum di pemanggil.
 *   GMGN kline     lewat proxy lokal; chain wajib "sol"; kuota ketat (bobot 2/call) → CADANGAN saja.
 *   DexScreener    tidak punya data lilin sama sekali — jangan dicari di sana.
 */
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }
export type ChartSource = "geckoterminal" | "gmgn-kline";

export interface ChartOutcome {
  candles: Candle[];
  source: ChartSource | null;
  /** Status HTTP asli dari GT — 429 vs 404 punya arti yang berbeda dan harus dibedakan di UI. */
  status: number;
  pool: string | null;
  error: string | null;
}

const GT = "https://api.geckoterminal.com/api/v2";
const PROXY = `http://127.0.0.1:${process.env.GMGN_PROXY_PORT ?? 4319}/call`;

export const TF_GT: Record<string, [string, number]> = {
  "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15],
  "1h": ["hour", 1], "4h": ["hour", 4], "12h": ["hour", 12], "1d": ["day", 1],
};

async function fetchJson(url: string, timeoutMs = 12_000): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  } catch { return { status: 0, body: null }; }
}

/** Pool acuan = pool dengan cadangan USD terbesar (bukan pool sampingan yang likuiditasnya tipis). */
export async function findPool(chain: string, token: string): Promise<{ pool: string | null; status: number }> {
  const r = await fetchJson(`${GT}/networks/${chain}/tokens/${token}/pools`);
  if (r.status !== 200) return { pool: null, status: r.status };
  const data = (r.body as { data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }> } | null)?.data ?? [];
  const pools = data.filter((p) => p.attributes?.address);
  pools.sort((a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0));
  return { pool: pools[0]?.attributes?.address ?? null, status: 200 };
}

export async function gtCandles(chain: string, pool: string, tf: string, bars: number): Promise<{ candles: Candle[]; status: number }> {
  const spec = TF_GT[tf];
  if (!spec) return { candles: [], status: 0 };
  const r = await fetchJson(`${GT}/networks/${chain}/pools/${pool}/ohlcv/${spec[0]}?aggregate=${spec[1]}&limit=${Math.min(300, bars)}`);
  if (r.status !== 200) return { candles: [], status: r.status };
  const list = (r.body as { data?: { attributes?: { ohlcv_list?: number[][] } } } | null)?.data?.attributes?.ohlcv_list ?? [];
  const candles = list
    .map((x) => ({ t: (x[0] ?? 0) * 1000, o: Number(x[1]), h: Number(x[2]), l: Number(x[3]), c: Number(x[4]), v: Number(x[5]) }))
    .filter((c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.c > 0)
    .sort((a, b) => a.t - b.t);
  return { candles, status: 200 };
}

/** Cadangan Solana: GMGN kline (`chain` wajib "sol" — "solana" dijawab 40000300). */
export async function gmgnCandles(mint: string, tf: string): Promise<Candle[]> {
  try {
    const res = await fetch(PROXY, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "getTokenKline", args: ["sol", mint, tf] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ time?: number; open?: string; high?: string; low?: string; close?: string; volume?: string }> };
    if (!Array.isArray(body.data)) return [];
    return body.data
      .map((r) => ({ t: Number(r.time ?? 0), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume) }))
      .filter((c) => [c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.c > 0)
      .sort((a, b) => a.t - b.t);
  } catch { return []; }
}

/** Ambil lilin: GT dulu (gratis), GMGN hanya sebagai cadangan untuk Solana. */
export async function fetchCandles(input: {
  chain: string; token?: string; pool?: string; tf: string; bars: number; allowGmgn?: boolean;
}): Promise<ChartOutcome> {
  const { chain, token, tf, bars } = input;
  let pool = input.pool ?? null;
  let status = 0;
  if (!pool && token) {
    const found = await findPool(chain, token);
    pool = found.pool;
    status = found.status;
  }
  let candles: Candle[] = [];
  let source: ChartSource | null = null;
  if (pool) {
    const got = await gtCandles(chain, pool, tf, bars);
    candles = got.candles;
    status = got.status;
    if (candles.length) source = "geckoterminal";
  }
  if (!candles.length && token && chain !== "robinhood" && input.allowGmgn !== false) {
    const alt = await gmgnCandles(token, tf);
    if (alt.length) { candles = alt; source = "gmgn-kline"; }
  }
  const error = candles.length ? null
    : status === 429 ? "GT 429 — batas per-IP GeckoTerminal sedang penuh (dipakai bersama lane Robinhood). Tunggu ~1 menit."
    : status === 404 ? "GT 404 — token ini belum punya pool terindeks (biasanya baru beberapa menit)."
    : status === 0 ? "Koneksi ke GeckoTerminal gagal."
    : `Tidak ada lilin untuk ${tf} (pool terlalu sepi atau periode kosong).`;
  return { candles, source, status, pool, error };
}
