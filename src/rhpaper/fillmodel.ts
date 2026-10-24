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
 *   (P0-4 v2) EXIT sekarang RE-QUOTE NYATA atas kuantitas sim entry (engine memanggil
 *   quoteSell(simTokens)) — bukan penskalaan proporsional; (1−l) tetap APROKSIMASI LATENSI
 *   yang dimodelkan (belum terkalibrasi fill nyata) — dilabel, tidak diklaim biaya terukur.
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
/** (P0-4) v2 = perubahan metodologi MATERIAL: gerbang exit memakai likuiditas WAKTU-KELUAR
 *  (bukan likuiditas entry yang disimpan), kuantitas exit = token yang benar-benar diterima
 *  simulasi entry (bukan qty quote penuh), dan usia quote dibatasi (STALE_QUOTE). Kohort v1
 *  tetap utuh — baris lama TIDAK dinaikkan ke standar v2. */
export const FILL_MODEL_VERSION = "rhpaper-fillmodel-v2";

export interface FillAssumptions { maxLiquiditySharePct: number; latencySlippagePct: number; rejectImpactPct: number }
export const DEFAULT_ASSUMPTIONS: FillAssumptions = { maxLiquiditySharePct: 2, latencySlippagePct: 0.5, rejectImpactPct: 5 };

export interface FillInput {
  quoteAmountIn: string; // WETH masuk (raw)
  quoteAmountOut: string; // token keluar / WETH keluar (raw) menurut quote
  impactPct: number | null;
  liquidityUsd: number | null; // likuiditas pool pada saat keputusan SISI INI (entry→entry-time; exit→exit-time)
  sizeWethRaw: string; // ukuran trade untuk cek pangsa likuiditas
  ethUsd: number | null; // untuk konversi ukuran → USD; null = TOLAK (fail-closed)
  quoteAgeMs?: number | null; // (P0-4) usia quote saat dipakai — >90s = STALE_QUOTE (tolak)
  simulatedTokensRaw?: string | null; // (P0-4, sisi exit) token yang BENAR-BENAR diterima sim entry;
  // WETH keluar = quoteOut × (simTokens/quoteTokens) × (1−l) — re-quote semantik atas kuantitas berubah
  quoteTokensRaw?: string | null; // (P0-4) qty yang dikutip pada exitQuoteOut (biasanya qty penuh entry)
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
  // (FINAL-2) pangsa likuiditas dihitung BigInt murni (mikro-USD) — aman-2^53 untuk posisi besar;
  // ethUsd float dikonversi ke mikro sekali dengan pembulatan eksplisit (satu-satunya Number di sini).
  if (!Number.isFinite(input.ethUsd) || input.ethUsd <= 0) {
    return { filled: false, reason: "ETH_USD_UNKNOWN", version: FILL_MODEL_VERSION };
  }
  const sizeUsdMicro = BigInt(input.sizeWethRaw) * BigInt(Math.round(input.ethUsd * 1e6)) / 10n ** 18n;
  const liquidityUsdMicro = BigInt(Math.round(input.liquidityUsd * 1e6));
  if (sizeUsdMicro <= 0n) return { filled: false, reason: "SIZE_INVALID", version: FILL_MODEL_VERSION };
  if (sizeUsdMicro * 100n > liquidityUsdMicro * BigInt(Math.round(a.maxLiquiditySharePct))) {
    return { filled: false, reason: "REJECT_LIQUIDITY_SHARE", version: FILL_MODEL_VERSION };
  }
  if (input.impactPct != null && Math.abs(input.impactPct) >= a.rejectImpactPct) {
    return { filled: false, reason: "REJECT_IMPACT", version: FILL_MODEL_VERSION };
  }
  if (input.quoteAgeMs != null && (!Number.isFinite(input.quoteAgeMs) || input.quoteAgeMs > 90_000)) {
    return { filled: false, reason: "STALE_QUOTE", version: FILL_MODEL_VERSION };
  }
  if (!/^\d+$/.test(input.quoteAmountOut) || BigInt(input.quoteAmountOut) <= 0n) {
    return { filled: false, reason: "QUOTE_AMOUNT_INVALID", version: FILL_MODEL_VERSION };
  }
  // (P0-4) sisi exit: skalakan ke kuantitas sim entry (re-quote semantik), lalu potongan latensi.
  let out = BigInt(input.quoteAmountOut);
  if (input.simulatedTokensRaw != null && input.quoteTokensRaw != null && /^\d+$/.test(input.simulatedTokensRaw) && /^\d+$/.test(input.quoteTokensRaw)) {
    const q = BigInt(input.quoteTokensRaw);
    if (q === 0n) return { filled: false, reason: "QUOTE_QTY_INVALID", version: FILL_MODEL_VERSION };
    out = out * BigInt(input.simulatedTokensRaw) / q;
  }
  return { filled: true, fillOutRaw: applyLatencySlippage(out.toString(), a.latencySlippagePct), latencySlippagePct: a.latencySlippagePct, version: FILL_MODEL_VERSION };
}
