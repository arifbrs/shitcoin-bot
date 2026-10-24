/**
 * MODEL SIMULASI FILL (round-3 B3; metodologi dikunci round-8 P4) — "price mark bukan fill; quote bukan fill".
 * Lapisan akuntansi TERPISAH di atas quote engine paper: mengubah quote menjadi
 * simulasi eksekusi dengan aturan yang dibekukan dan diberi versi.
 *
 * METODOLOGI (A — multiplikatif pada JUMLAH OUTPUT, bukan penambahan pp pada netPnL):
 *   entry fill  → token diterima = quoteTokensOut × (1−l)   [harga masuk lebih buruk]
 *   exit fill   → WETH diterima = quoteWethOut × (1−l)      [harga keluar lebih buruk]
 *   putaran     → WETH diterima = quoteWethOut × (1−l)²     [dua kaki, masing-masing sekali]
 *   net sim     = quoteWethOut×(1−l)² − wethIn − gas   (BigInt, pemotongan per kaki = saldo
 *   aktual yang diterima; BUKAN desimal ideal). Dampak nonlinear pool TIDAK dimodelkan linear
 *   di sini — quote OKX sudah memuat dampak; (1−l) hanya latensi antara quote dan landing.
 *
 * Asumsi v1 (dibekukan; ubah = versi baru + kohort baru, jangan sentuh sampel lama):
 *   LIKUIDITAS TIDAK DIKETAHUI   → TIDAK ADA FILL (fail-closed; bukan fill dengan tebakan).
 *   UKURAN > 2% likuiditas USD   → TOLAK (REJECT_LIQUIDITY_SHARE).
 *   dampak harga ≥ 5%            → TOLAK (sama dengan gerbang quote; digandakan di sini agar
 *                                  model berdiri sendiri).
 *   slippage latensi             → 0,5% dari amountOut (drift adversarial antara quote dan
 *                                  landing; asumsi eksplisit, bukan pengukuran).
 *   fee pool/platform            → 0 tambahan: quote OKX aggregator sudah memasak fee + dampak
 *                                  (terverifikasi di exec.ts); gas ditangani ROUND_TRIP_GAS_WEI
 *                                  di engine — tidak digandakan di sini.
 * Hasil selalu diberi label SIMULASI — tidak pernah digabung ke PnL nyata/quote.
 */
export const FILL_MODEL_VERSION = "rhpaper-fillmodel-v1";

export interface FillAssumptions { maxLiquiditySharePct: number; latencySlippagePct: number; rejectImpactPct: number }
export const DEFAULT_ASSUMPTIONS: FillAssumptions = { maxLiquiditySharePct: 2, latencySlippagePct: 0.5, rejectImpactPct: 5 };

export interface FillInput {
  quoteAmountIn: string; // WETH masuk (raw)
  quoteAmountOut: string; // token keluar / WETH keluar (raw) menurut quote
  impactPct: number | null;
  liquidityUsd: number | null; // likuiditas pool pada saat keputusan
  sizeWethRaw: string; // ukuran trade untuk cek pangsa likuiditas
  ethUsd: number | null; // untuk konversi ukuran → USD; null = TOLAK (fail-closed)
}

export type SimulatedFill =
  | { filled: true; fillOutRaw: string; latencySlippagePct: number; version: typeof FILL_MODEL_VERSION }
  | { filled: false; reason: string; version: typeof FILL_MODEL_VERSION };

/** floor(amountOut × (1 − slippage%)) — BigInt murni, tanpa pecahan. */
export function applyLatencySlippage(amountOutRaw: string, slippagePct: number): string {
  const out = BigInt(amountOutRaw);
  const bps = BigInt(Math.round(slippagePct * 100)); // 0.5% → 50 bps
  return (out * (10_000n - bps) / 10_000n).toString();
}

/**
 * WETH keluar SIMULASI (metodologi A, eksak BigInt): quoteWethOut × (1−l)² dengan pemotongan
 * per kaki — mewakili dua fill nyata (token lebih sedikit di entry, harga lebih buruk di exit).
 * SATU-SATUNYA dasar net sim untuk baris fillmodel (round-8; jalur "netPct − overlay pp"
 * dibatalkan karena berbeda dari mekanisme ini sebesar ~0,005 pp dan menyamarkan basis).
 */
export function simulatedExitWeth(quoteWethOut: string, a: FillAssumptions = DEFAULT_ASSUMPTIONS): bigint {
  const bps = BigInt(Math.round(a.latencySlippagePct * 100));
  const once = BigInt(quoteWethOut) * (10_000n - bps) / 10_000n;
  return once * (10_000n - bps) / 10_000n;
}

/**
 * Overlay latensi per PUTARAN dalam pp — SATU-SATUNYA definisi (round-6 P2).
 * Eksak: (1 − (1−lat)²)×100 — persamaan analitik dari metodologi A ketika basis dikonversi
 * ke persen-entry; dipakai untuk tabel benchmark hipotetis, BUKAN pengganti
 * simulatedExitWeth() di perhitungan per-trade.
 */
export function latencyOverlayPct(a: FillAssumptions = DEFAULT_ASSUMPTIONS): number {
  const lat = a.latencySlippagePct / 100;
  return (1 - (1 - lat) * (1 - lat)) * 100;
}

export function simulateFill(input: FillInput, a: FillAssumptions = DEFAULT_ASSUMPTIONS): SimulatedFill {
  if (input.liquidityUsd == null || !Number.isFinite(input.liquidityUsd) || input.liquidityUsd <= 0) {
    return { filled: false, reason: "LIQUIDITY_UNKNOWN", version: FILL_MODEL_VERSION };
  }
  if (input.ethUsd == null || !Number.isFinite(input.ethUsd) || input.ethUsd <= 0) {
    return { filled: false, reason: "ETH_USD_UNKNOWN", version: FILL_MODEL_VERSION };
  }
  const sizeUsd = (Number(BigInt(input.sizeWethRaw)) / 1e18) * input.ethUsd;
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return { filled: false, reason: "SIZE_INVALID", version: FILL_MODEL_VERSION };
  if (sizeUsd > input.liquidityUsd * (a.maxLiquiditySharePct / 100)) {
    return { filled: false, reason: "REJECT_LIQUIDITY_SHARE", version: FILL_MODEL_VERSION };
  }
  if (input.impactPct != null && Math.abs(input.impactPct) >= a.rejectImpactPct) {
    return { filled: false, reason: "REJECT_IMPACT", version: FILL_MODEL_VERSION };
  }
  if (!/^\d+$/.test(input.quoteAmountOut) || BigInt(input.quoteAmountOut) <= 0n) {
    return { filled: false, reason: "QUOTE_AMOUNT_INVALID", version: FILL_MODEL_VERSION };
  }
  return { filled: true, fillOutRaw: applyLatencySlippage(input.quoteAmountOut, a.latencySlippagePct), latencySlippagePct: a.latencySlippagePct, version: FILL_MODEL_VERSION };
}
