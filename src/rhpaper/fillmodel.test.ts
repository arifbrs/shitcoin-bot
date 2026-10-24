/** (B3) round-3: model simulasi fill — fail-closed, batas likuiditas, matematika slippage. */
import { test, eq, assert } from "../testing/harness.js";
import { simulateFill, applyLatencySlippage, DEFAULT_ASSUMPTIONS, FILL_MODEL_VERSION } from "./fillmodel.js";

const WETH = "1000000000000000000"; // 1 WETH
const happy = { quoteAmountIn: WETH, quoteAmountOut: "2000000000000000000", impactPct: 0.3, sizeWethRaw: WETH, ethUsd: 2361 as number | null };

test("B3 fail-closed: likuiditas tak diketahui → TIDAK ada fill (bukan fill dengan tebakan)", () => {
  for (const liq of [null, Number.NaN, 0, -5]) {
    const r = simulateFill({ ...happy, liquidityUsd: liq });
    assert(!r.filled && r.reason === "LIQUIDITY_UNKNOWN", `likuiditas ${liq} ditolak`);
  }
});

test("B3 fail-closed: harga ETH tak diketahui → tidak ada fill", () => {
  const r = simulateFill({ ...happy, liquidityUsd: 100_000, ethUsd: null });
  assert(!r.filled && r.reason === "ETH_USD_UNKNOWN", "tanpa harga USD, pangsa likuiditas tak bisa dihitung → tolak");
});

test("B3 pangsa likuiditas: ≤2% lolos, >2% ditolak", () => {
  const liq = 100_000; // 2% = $2.000
  const size1 = (2_000 / 2361 * 1e18).toString(); // tepat di batas → lolos
  const r1 = simulateFill({ ...happy, liquidityUsd: liq, sizeWethRaw: size1 });
  assert(r1.filled, "tepat 2% masih lolos");
  const size2 = (2_001 / 2361 * 1e18).toString();
  const r2 = simulateFill({ ...happy, liquidityUsd: liq, sizeWethRaw: size2 });
  assert(!r2.filled && r2.reason === "REJECT_LIQUIDITY_SHARE", "sedikit di atas 2% ditolak");
});

test("B3 dampak ≥5% ditolak; negatif absolut juga dihitung", () => {
  const r1 = simulateFill({ ...happy, liquidityUsd: 1_000_000, impactPct: 5 });
  assert(!r1.filled && r1.reason === "REJECT_IMPACT", "5% tepat ditolak (≥)");
  const r2 = simulateFill({ ...happy, liquidityUsd: 1_000_000, impactPct: -7 });
  assert(!r2.filled && r2.reason === "REJECT_IMPACT", "dampak negatif besar juga ditolak");
  const r3 = simulateFill({ ...happy, liquidityUsd: 1_000_000, impactPct: null });
  assert(r3.filled, "dampak tidak tersedia → bukan alasan tolak di model (gerbang quote yang menahan)");
});

test("B3 slippage latensi: floor BigInt eksak (0,5% → 50 bps)", () => {
  eq(applyLatencySlippage("2000000000000000000", 0.5), "1990000000000000000", "2 WETH → 1,99 WETH");
  eq(applyLatencySlippage("999999999999", 0.5), (999999999999n * 9950n / 10000n).toString(), "floor, bukan pembulatan ke atas");
  const r = simulateFill({ ...happy, liquidityUsd: 1_000_000 });
  if (!r.filled) throw new Error("harusnya fill: likuiditas cukup, dampak kecil");
  eq(r.version, FILL_MODEL_VERSION, "versi model tercatat di hasil");
  eq(r.latencySlippagePct, DEFAULT_ASSUMPTIONS.latencySlippagePct, "asumsi yang dipakai tercatat");
  eq(r.fillOutRaw, applyLatencySlippage("2000000000000000000", 0.5), "fill = quote − slippage latensi");
});
