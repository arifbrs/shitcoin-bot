import { test, eq, approx } from "../testing/harness.js";
import { liquidityDropPct, priceRatio, onchainExitReason, type OnchainSnapshot, type OnchainBaseline } from "./onchain-liq.js";

const base = (liq: bigint, sqrt: bigint): OnchainBaseline => ({ liq: liq.toString(), sqrtPriceX96: sqrt.toString(), at: 0 });
const snap = (liq: bigint, sqrt: bigint): OnchainSnapshot => ({ pool: "0xpool", liq, sqrtPriceX96: sqrt, block: 1, at: 1 });

const L = 1_000_000n;
const S = 1_000_000n; // sqrtPriceX96 acuan

test("onchain: penurunan likuiditas dihitung sebagai fraksi yang hilang", () => {
  approx(liquidityDropPct(L, 650_000n), 0.35, 1e-9, "tinggal 65% → hilang 35%");
  approx(liquidityDropPct(L, L), 0, 1e-9, "tidak berubah");
  eq(liquidityDropPct(0n, 0n), 0, "acuan nol tidak meledak");
});

test("onchain: rasio harga dari sqrtPrice (kuadrat) benar arahnya", () => {
  approx(priceRatio(S, S), 1, 1e-9, "sama → 1");
  approx(priceRatio(S, 500_000n), 0.25, 1e-9, "sqrt separuh → harga seperempat");
  approx(priceRatio(S, 2_000_000n), 4, 1e-9, "sqrt dua kali → harga empat kali");
});

test("onchain: LP ditarik menyala pada ambang, dan menyebut ALASANNYA", () => {
  eq(onchainExitReason(snap(650_000n, S), base(L, S), 0.35), "onchain_lp_pull", "hilang 35% tepat ambang → keluar");
  eq(onchainExitReason(snap(800_000n, S), base(L, S), 0.35), null, "hilang 20% → tahan");
});

test("onchain: harga on-chain jatuh juga bisa memicu (konfirmasi independen dari mark)", () => {
  // harga turun 60% → sqrt turun ~36,8% (akar 0,4)
  const sqrtAfter = BigInt(Math.round(Number(S) * Math.sqrt(0.4)));
  eq(onchainExitReason(snap(L, sqrtAfter), base(L, S), 0.5), "onchain_price_drop", "harga −60% → keluar");
  eq(onchainExitReason(snap(L, sqrtAfter), base(L, S), 0.7), null, "harga −60% tapi ambang 70% → tahan");
});

test("onchain: LP ditarik diprioritaskan di atas harga (sebab paling berbahaya)", () => {
  const sqrtAfter = BigInt(Math.round(Number(S) * Math.sqrt(0.1)));
  eq(onchainExitReason(snap(100_000n, sqrtAfter), base(L, S), 0.35), "onchain_lp_pull", "dua-duanya menyala → nama LP ditarik");
});
