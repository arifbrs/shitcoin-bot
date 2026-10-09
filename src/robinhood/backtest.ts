/**
 * BACKTEST ROBINHOOD CHAIN — replay aturan 10 varian di candle historis NYATA (GeckoTerminal).
 *
 * Kenapa bentuknya begini (jujur di muka, sesuai disiplin repo ini):
 *  - Sumber candle: GT OHLCV per pool. Yang tersedia HANYA pool yang masih hidup dan terindeks
 *    sekarang → ada SURVIVORSHIP BIAS (pool yang sudah mati/rug tidak ikut). Kolom "cats" di
 *    laporan menandai berapa aturan yang TIDAK bisa diuji (jumlah txns/buys tidak ada di OHLCV).
 *  - Aturan yang butuh jumlah transaksi (minBuys1h, rasio beli/jual, rasio jual) DILEWATI di
 *    backtest; aturan harga/volume/umur/likuiditas-current tetap diuji apa adanya.
 *  - Likuiditas tidak punya sejarah di GT → dipakai likuiditas SEKARANG sebagai filter statis.
 *  - Eksekusi memakai model biaya yang SAMA dengan paper lane (fee 0.30%/sisi, gas $0.01/sisi,
 *    slippage 1% + dampak ukuran). Entry di open candle BERIKUTNYA setelah sinyal (tanpa
 *    look-ahead); SL dicek lebih dulu daripada TP di dalam satu candle (pesimistis).
 *  - Risk $5/trade dengan sizing identik paper (notional = 5/stopPct, cap $25 & 2% liq).
 *
 * Dua jendela waktu karena profil hold berbeda:
 *  - varian hold pendek (v05-v10)  → candle 5 menit, ~3,5 hari terakhir
 *  - varian hold panjang (v01-v04) → candle 1 jam, ~21 hari terakhir
 *
 * Run: npm run rh:backtest   (RH_BT_POOLS=20 utk membatasi jumlah pool)
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { ui } from "../util/log.js";
import { gtTopPools, gtNewPools, gtTrendingPools, gtOhlcv, isMajorSymbol, type Candle, type PoolMetrics } from "./market.js";

const POOL_CAP = intEnv(process.env.RH_BT_POOLS, 24, 4);
const MIN_LIQ = numEnv(process.env.RH_BT_MIN_LIQ, 20_000, 1_000);
const RISK_USD = numEnv(process.env.RH_RISK_USD, 5, 0.5);
const MAX_NOTIONAL_USD = numEnv(process.env.RH_MAX_NOTIONAL_USD, 25, 1);
const DEX_FEE_PCT = 0.003, GAS_USD = 0.01;
const COOLDOWN_MS = 6 * 3_600_000;

function numEnv(v: string | undefined, def: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}
function intEnv(v: string | undefined, def: number, min: number): number { return Math.round(numEnv(v, def, min)); }

function slipPct(notionalUsd: number, liqUsd: number | null): number {
  const impact = liqUsd && liqUsd > 0 ? Math.min(0.06, (notionalUsd / liqUsd) * 0.5) : 0.06;
  return Math.min(0.08, 0.01 + impact);
}

interface BtVariant {
  id: string; stopPct: number; tpPct: number | null; trailFromPct: number | null; trailPct: number | null; maxHoldMin: number;
  minAgeMin: number; maxAgeMin: number | null; minLiqUsd: number; minVol24Usd: number; minVol1hUsd: number;
  ch1Min: number | null; ch1Max: number | null; ch24Min: number | null;
  skippedRules: string[];
}
const VARIANTS: BtVariant[] = [
  { id: "v01-konservatif", stopPct: 18, tpPct: 35, trailFromPct: 18, trailPct: 12, maxHoldMin: 1440, minAgeMin: 1440, maxAgeMin: null, minLiqUsd: 150_000, minVol24Usd: 150_000, minVol1hUsd: 0, ch1Min: null, ch1Max: null, ch24Min: -50, skippedRules: ["rasio beli 1j ≥0.45"] },
  { id: "v02-momentum", stopPct: 20, tpPct: 45, trailFromPct: 20, trailPct: 15, maxHoldMin: 720, minAgeMin: 360, maxAgeMin: null, minLiqUsd: 100_000, minVol24Usd: 80_000, minVol1hUsd: 0, ch1Min: 5, ch1Max: 80, ch24Min: 0, skippedRules: ["rasio beli 1j ≥0.50"] },
  { id: "v03-seimbang", stopPct: 25, tpPct: 50, trailFromPct: 25, trailPct: 20, maxHoldMin: 360, minAgeMin: 60, maxAgeMin: 1440, minLiqUsd: 60_000, minVol24Usd: 40_000, minVol1hUsd: 0, ch1Min: null, ch1Max: null, ch24Min: -60, skippedRules: ["rasio beli 1j ≥0.55"] },
  { id: "v04-dip", stopPct: 22, tpPct: 40, trailFromPct: null, trailPct: null, maxHoldMin: 480, minAgeMin: 120, maxAgeMin: null, minLiqUsd: 60_000, minVol24Usd: 30_000, minVol1hUsd: 0, ch1Min: -30, ch1Max: -8, ch24Min: -65, skippedRules: [] },
  { id: "v05-agresif-baru", stopPct: 30, tpPct: 70, trailFromPct: 35, trailPct: 25, maxHoldMin: 180, minAgeMin: 0, maxAgeMin: 60, minLiqUsd: 30_000, minVol24Usd: 0, minVol1hUsd: 8_000, ch1Min: null, ch1Max: null, ch24Min: null, skippedRules: ["buys1h ≥25"] },
  { id: "v06-sniper", stopPct: 35, tpPct: 90, trailFromPct: null, trailPct: null, maxHoldMin: 120, minAgeMin: 0, maxAgeMin: 20, minLiqUsd: 15_000, minVol24Usd: 0, minVol1hUsd: 0, ch1Min: null, ch1Max: null, ch24Min: null, skippedRules: ["buys1h ≥12", "rasio jual ≤0.45"] },
  { id: "v07-runner", stopPct: 30, tpPct: null, trailFromPct: 30, trailPct: 25, maxHoldMin: 240, minAgeMin: 0, maxAgeMin: 360, minLiqUsd: 40_000, minVol24Usd: 0, minVol1hUsd: 10_000, ch1Min: 3, ch1Max: null, ch24Min: null, skippedRules: ["rasio beli 1j ≥0.50"] },
  { id: "v08-moonshot", stopPct: 40, tpPct: 250, trailFromPct: 100, trailPct: 40, maxHoldMin: 720, minAgeMin: 0, maxAgeMin: 180, minLiqUsd: 25_000, minVol24Usd: 0, minVol1hUsd: 0, ch1Min: null, ch1Max: null, ch24Min: null, skippedRules: ["buys1h ≥20"] },
  { id: "v09-scalp", stopPct: 12, tpPct: 18, trailFromPct: null, trailPct: null, maxHoldMin: 45, minAgeMin: 0, maxAgeMin: 180, minLiqUsd: 50_000, minVol24Usd: 0, minVol1hUsd: 15_000, ch1Min: null, ch1Max: null, ch24Min: null, skippedRules: ["rasio beli 1j ≥0.57"] },
  { id: "v10-degen", stopPct: 45, tpPct: 120, trailFromPct: null, trailPct: null, maxHoldMin: 60, minAgeMin: 0, maxAgeMin: 10, minLiqUsd: 8_000, minVol24Usd: 0, minVol1hUsd: 0, ch1Min: null, ch1Max: null, ch24Min: null, skippedRules: ["buys1h ≥6"] },
];
const SHORT_HOLD = new Set(["v05-agresif-baru", "v06-sniper", "v07-runner", "v08-moonshot", "v09-scalp", "v10-degen"]);

interface TradeResult { variant: string; pool: string; symbol: string; entryAt: number; exitAt: number; entryPrice: number; exitPrice: number; pnlUsd: number; pnlPct: number; reason: string; heldMin: number }

function rollingFeatures(candles: Candle[], stepMin: number): Array<{ vol1h: number; vol6h: number; vol24h: number; ch1: number | null; ch6: number | null; ch24: number | null }> {
  const n = candles.length;
  const vol = candles.map((c) => c.v);
  const prefix = [0];
  for (let i = 0; i < n; i++) prefix.push((prefix[i] as number) + (vol[i] as number));
  const winSum = (i: number, bars: number): number => {
    const from = Math.max(0, i - bars + 1);
    return (prefix[i + 1] as number) - (prefix[from] as number);
  };
  const chg = (i: number, bars: number): number | null => {
    const j = i - bars;
    if (j < 0) return null;
    const prev = candles[j] as Candle;
    return ((candles[i] as Candle).c / prev.c - 1) * 100;
  };
  const perH = Math.max(1, Math.round(60 / stepMin));
  return candles.map((_, i) => ({
    vol1h: winSum(i, perH), vol6h: winSum(i, perH * 6), vol24h: winSum(i, perH * 24),
    ch1: chg(i, perH), ch6: chg(i, perH * 6), ch24: chg(i, perH * 24),
  }));
}

function simulate(pool: PoolMetrics, candles: Candle[], stepMin: number, v: BtVariant): TradeResult[] {
  const feats = rollingFeatures(candles, stepMin);
  const trades: TradeResult[] = [];
  const perH = Math.max(1, Math.round(60 / stepMin));
  // WARMUP ADAPTIF (bug ditemukan live 2026-10-07): warmup 24 jam tetap membuat varian cepat
  // (v05-v10) NOL trade — pool baru cuma punya ~20 jam candle 5m, jadi loop tak pernah mulai dan
  // justru varian yang paling butuh uji di fase awal pool malah tak teruji. Warmup kini mengikuti
  // kebutuhan fitur varian: 24 jam hanya bila aturannya memakai vol24/ch24.
  const needs24h = v.minVol24Usd > 0 || v.ch24Min != null;
  let lastExitAt = 0;
  let i = Math.max(1, needs24h ? perH * 24 : perH);
  while (i < candles.length - 1) {
    const c = candles[i] as Candle;
    const f = feats[i] as { vol1h: number; vol6h: number; vol24h: number; ch1: number | null; ch6: number | null; ch24: number | null };
    const ageMin = pool.createdAt ? (c.t - pool.createdAt) / 60_000 : null;
    const liq = pool.liqUsd;
    const ok =
      ageMin != null && ageMin >= v.minAgeMin && (v.maxAgeMin == null || ageMin <= v.maxAgeMin) &&
      liq != null && liq >= v.minLiqUsd &&
      f.vol24h >= v.minVol24Usd && f.vol1h >= v.minVol1hUsd &&
      (v.ch1Min == null || (f.ch1 != null && f.ch1 >= v.ch1Min)) &&
      (v.ch1Max == null || (f.ch1 != null && f.ch1 <= v.ch1Max)) &&
      (v.ch24Min == null || (f.ch24 != null && f.ch24 >= v.ch24Min)) &&
      c.t - lastExitAt >= COOLDOWN_MS;
    if (!ok) { i++; continue; }

    const entryCandle = candles[i + 1] as Candle; // entry di OPEN candle berikutnya — tanpa look-ahead
    const entryPrice = entryCandle.o;
    const stopRisk = v.stopPct / 100;
    let notional = Math.min(RISK_USD / stopRisk, MAX_NOTIONAL_USD);
    if (liq != null && liq > 0) notional = Math.min(notional, liq * 0.02);
    if (notional < 2) { i++; continue; }
    const slipIn = slipPct(notional, liq);
    const tokens = (notional - (notional * (DEX_FEE_PCT + slipIn) + GAS_USD)) / entryPrice;
    const stopPrice = entryPrice * (1 - stopRisk);
    const tpPrice = v.tpPct != null ? entryPrice * (1 + v.tpPct / 100) : null;
    let peak = entryPrice;
    let exitIdx = -1, exitPrice = 0, reason = "max_hold";

    for (let j = i + 1; j < candles.length; j++) {
      const k = candles[j] as Candle;
      peak = Math.max(peak, k.h);
      if (k.l <= stopPrice) { exitIdx = j; exitPrice = stopPrice; reason = "stop_loss"; break; }
      if (tpPrice != null && k.h >= tpPrice) { exitIdx = j; exitPrice = tpPrice; reason = "take_profit"; break; }
      if (v.trailFromPct != null && v.trailPct != null && peak >= entryPrice * (1 + v.trailFromPct / 100)) {
        const trailStop = peak * (1 - v.trailPct / 100);
        if (k.l <= trailStop) { exitIdx = j; exitPrice = trailStop; reason = "trailing"; break; }
      }
      if ((k.t - entryCandle.t) / 60_000 >= v.maxHoldMin) { exitIdx = j; exitPrice = k.c; reason = "max_hold"; break; }
    }
    if (exitIdx < 0) break; // data habis saat posisi masih terbuka — jangan paksa trade fiktif
    const gross = tokens * exitPrice;
    const slipOut = slipPct(gross, liq);
    const proceeds = gross * (1 - DEX_FEE_PCT - slipOut) - GAS_USD;
    const pnl = proceeds - notional;
    trades.push({
      variant: v.id, pool: pool.poolAddress, symbol: pool.symbol, entryAt: entryCandle.t, exitAt: (candles[exitIdx] as Candle).t,
      entryPrice, exitPrice, pnlUsd: Number(pnl.toFixed(4)), pnlPct: Number(((pnl / notional) * 100).toFixed(2)),
      reason, heldMin: ((candles[exitIdx] as Candle).t - entryCandle.t) / 60_000,
    });
    lastExitAt = (candles[exitIdx] as Candle).t;
    i = exitIdx + 1;
  }
  return trades;
}

const q = (a: number[], p: number): number => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor(p * (s.length - 1))] as number) : NaN; };

async function main(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const t0 = Date.now();
  console.log(`[rh-backtest] mengumpulkan pool Robinhood (top+new+trending, liq ≥ $${MIN_LIQ.toLocaleString()})…`);
  const [top, fresh, trending] = await Promise.all([gtTopPools(2), gtNewPools(), gtTrendingPools()]);
  const byPool = new Map<string, PoolMetrics>();
  let majorsSkipped = 0;
  for (const p of [...top, ...fresh, ...trending]) {
    if (!p.poolAddress || (p.liqUsd ?? 0) < MIN_LIQ) continue;
    if (isMajorSymbol(p.symbol)) { majorsSkipped++; continue; } // WETH/USDG/dll bukan target meme coin
    if (!byPool.has(p.poolAddress)) byPool.set(p.poolAddress, p);
  }
  // Diurut VOLUME 24 jam, bukan likuiditas: meme coin yang layak diuji adalah yang bertransaksi,
  // bukan sekadar kolam besar (pool stable/major sudah disingkirkan di atas).
  const pools = [...byPool.values()].sort((a, b) => (b.vol["h24"] ?? 0) - (a.vol["h24"] ?? 0)).slice(0, POOL_CAP);
  console.log(`[rh-backtest] ${pools.length} pool meme diuji (${majorsSkipped} pool major/stable diskip). Mengambil candle…`);

  const allTrades: TradeResult[] = [];
  let candle5m = 0, candle1h = 0;
  for (const pool of pools) {
    const short = await gtOhlcv(pool.poolAddress, "minute", 5, 1000);
    const long = await gtOhlcv(pool.poolAddress, "hour", 1, 500);
    if (short.length > 50) candle5m++;
    if (long.length > 50) candle1h++;
    for (const v of VARIANTS) {
      const candles = SHORT_HOLD.has(v.id) ? short : long;
      const step = SHORT_HOLD.has(v.id) ? 5 : 60;
      if (candles.length < 200) continue;
      allTrades.push(...simulate(pool, candles, step, v));
    }
    ui.info(`[rh-backtest] ${pool.symbol}: 5m ${short.length} candle, 1h ${long.length} candle (total trade sementara ${allTrades.length})`);
  }

  const lines: string[] = [];
  const say = (s = ""): void => { lines.push(s); console.log(s); };
  say(`BACKTEST ROBINHOOD CHAIN — ${day}`);
  say(`Pool diuji: ${pools.length} (candle 5m: ${candle5m}, candle 1h: ${candle1h}). Risk $${RISK_USD}/trade, cap notional $${MAX_NOTIONAL_USD}.`);
  say(`BIAYA: fee ${(DEX_FEE_PCT * 100).toFixed(2)}%/sisi + gas $${GAS_USD}/sisi + slippage 1%+impak.`);
  say(`CATATAN BIAS: hanya pool yang MASIH HIDUP (survivorship); likuiditas dipakai nilai SEKARANG (tanpa sejarah);`);
  say(`aturan berbasis jumlah transaksi (buys/rasio) DILEWATI — lihat kolom "aturan dilewati".`);
  say();
  say("varian                 trade  win%   med%    avg%   total$   maxDD$  exit(TP/SL/trail/hold)  aturan dilewati");
  const summaryRows: Array<{ id: string; s: ReturnType<typeof statsOf> }> = [];
  for (const v of VARIANTS) {
    const t = allTrades.filter((x) => x.variant === v.id);
    if (!t.length) { say(`${v.id.padEnd(22)} 0 trade (tidak ada sinyal pada jendela data)`); continue; }
    const s = statsOf(t);
    summaryRows.push({ id: v.id, s });
    say(`${v.id.padEnd(22)} ${String(t.length).padStart(5)}  ${s.winRate.padStart(5)}  ${s.med.padStart(6)}  ${s.avg.padStart(6)}  ${s.total.padStart(7)}  ${s.maxDd.padStart(6)}  ${s.reasons.padEnd(22)}  ${v.skippedRules.join("; ") || "—"}`);
  }
  say();
  const best = summaryRows.filter((r) => r.s.n >= 15).sort((a, b) => Number(b.s.total) - Number(a.s.total))[0];
  if (best) say(`Terbaik (n≥15): ${best.id} → total $${best.s.total}, win ${best.s.winRate}, med ${best.s.med}.`);
  else say("Belum ada varian dengan n≥15 trade di jendela ini — jalankan lagi setelah data bertambah.");
  say();
  say(`Selesai dalam ${((Date.now() - t0) / 1000).toFixed(0)}s. Hasil mentah (semua trade) tidak disimpan; ringkasan ini + state paper yang jadi sumber keputusan.`);

  try { writeFileSync(join(config.logDir, `rh-backtest-${day}.md`), lines.join("\n") + "\n"); } catch { /* best-effort */ }

  function statsOf(t: TradeResult[]): { n: number; winRate: string; med: string; avg: string; total: string; maxDd: string; reasons: string } {
    const pnls = t.map((x) => x.pnlUsd);
    const pcts = t.map((x) => x.pnlPct);
    const wins = pnls.filter((p) => p >= 0).length;
    let cum = 0, peak = 0, maxDd = 0;
    for (const p of pnls) { cum += p; peak = Math.max(peak, cum); maxDd = Math.max(maxDd, peak - cum); }
    const byReason = (r: string): number => t.filter((x) => x.reason === r).length;
    return {
      n: t.length,
      winRate: `${((wins / t.length) * 100).toFixed(0)}%`,
      med: `${q(pcts, 0.5).toFixed(1)}%`,
      avg: `${(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(1)}%`,
      total: cum.toFixed(2),
      maxDd: maxDd.toFixed(2),
      reasons: `${byReason("take_profit")}/${byReason("stop_loss")}/${byReason("trailing")}/${byReason("max_hold")}`,
    };
  }
}

void main();
