/**
 * MODEL BIAYA & DAMPAK — SATU sumber (2026-10-11).
 *
 * Sebelum ini rumus yang sama hidup di tiga tempat (paper.ts, audit.ts, backtest.ts) dan satu
 * versi berbeda di deep.ts — angka yang keluar dari tiap alat bisa tidak sebanding tanpa ada
 * yang tahu. Semua konsumen kini memakai berkas ini.
 */

/** Uniswap standar 0.30% per sisi. */
export const DEX_FEE_PCT = 0.003;
/** L2 murah; terukur di RH chain ~$0.001-0.01 per swap. */
export const GAS_USD = 0.01;
/** Batas dampak per sisi (6%) dan batas total slippage (8%) — asumsi eksplisit, bukan tersembunyi. */
export const IMPACT_CAP = 0.06;
export const SLIP_CAP = 0.08;
/** Basis slippage minimum (1%) berlaku walau likuiditas tebal. */
export const SLIP_BASE = 0.01;

/** Slippage satu sisi sebagai fraksi. `k` = pengali kekerasan model (1 = model yang dipakai bot). */
export function slipPct(notionalUsd: number, liqUsd: number | null, k = 1): number {
  const impact = liqUsd && liqUsd > 0 ? Math.min(IMPACT_CAP, (notionalUsd / liqUsd) * 0.5 * k) : IMPACT_CAP;
  return Math.min(SLIP_CAP, SLIP_BASE + impact);
}

/**
 * Hasil bersih penjualan (USD) setelah fee, slippage, dan gas.
 * `haircut` = potongan tambahan per-alasan keluar (pool mati 0.75, mark basi 0.5) seperti di paper.
 */
export function exitProceedsUsd(
  grossUsd: number,
  liqUsd: number | null,
  opts: { k?: number; haircut?: number; feePct?: number; gasUsd?: number } = {},
): number {
  const { k = 1, haircut = 0, feePct = DEX_FEE_PCT, gasUsd = GAS_USD } = opts;
  const gross = grossUsd * (1 - haircut);
  const slip = slipPct(gross, liqUsd, k);
  return Math.max(0, gross * (1 - feePct - slip) - gasUsd);
}

/** PnL bersih sebuah trade bila harga keluar diganti model dampak yang lebih keras. */
export function netPnlUsd(
  qty: number,
  exitPriceUsd: number,
  entryNotionalUsd: number,
  liqUsd: number | null,
  opts: { k?: number; haircut?: number } = {},
): number {
  const proceeds = exitProceedsUsd(qty * exitPriceUsd, liqUsd, opts);
  return proceeds - entryNotionalUsd;
}

/**
 * ── SET BIAYA TERUKUR (2026-10-13/16) ─────────────────────────────────────────────────────────
 * Berasal dari DUA transaksi NYATA di jaringan Robinhood, bukan asumsi:
 *   masuk : 0,002 ETH → 15.802,271386 XZON (blok 89474510, tx 0x7c3928cc…) → biaya +1,01%
 *   keluar: 7.901,135693 XZON → 0,000957 ETH (blok 89477299, tx 0xaf3a30a6…) → biaya +1,12%
 * Fee pool yang dibaca dari kontrak pool = 1,00%; sisa selisih = slippage eksekusi (0,01%–0,12%).
 * Set ini TIDAK menggantikan konstanta model lama (arm yang berjalan harus tetap sebanding);
 * ia dipakai oleh alat penilai ulang agar tiap arm bisa dinilai dengan biaya nyata.
 */
export const MEASURED_FEE_PCT = 0.01;
export const MEASURED_SLIP_PCT = 0.0006;
export const MEASURED_GAS_USD = 0.0105;
export const MEASURED_ROUND_TRIP_PCT = 2 * MEASURED_FEE_PCT + 2 * MEASURED_SLIP_PCT;

/** Biaya satu putaran penuh (masuk+keluar) menurut pengukuran, dalam dolar, untuk notional tertentu. */
export function measuredRoundTripCostUsd(notionalUsd: number): number {
  return notionalUsd * MEASURED_ROUND_TRIP_PCT + 2 * MEASURED_GAS_USD;
}
