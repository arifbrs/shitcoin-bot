import { test, eq, approx, assert } from "../testing/harness.js";
import { DEX_FEE_PCT, GAS_USD, SLIP_BASE, SLIP_CAP, IMPACT_CAP, slipPct, exitProceedsUsd, netPnlUsd } from "./costs.js";

test("costs: slippage punya lantai 1% walau likuiditas sangat tebal", () => {
  // Bukan persis 1%: dampak tetap dihitung (25/10jt × 0,5 = 0,000125%) — yang dijaga adalah
  // lantainya tidak pernah turun di bawah 1%.
  approx(slipPct(25, 10_000_000), SLIP_BASE, 1e-4, "likuiditas $10M");
  assert(slipPct(25, 10_000_000) >= SLIP_BASE, "tidak boleh di bawah lantai");
});

test("costs: dampak naik seiring notional dan dibatasi 6%", () => {
  const kecil = slipPct(25, 100_000);
  const besar = slipPct(100_000, 100_000);
  assert(besar > kecil, "notional lebih besar harus lebih berdampak");
  approx(besar, SLIP_BASE + IMPACT_CAP, 1e-9, "dampak mentok di cap");
});

test("costs: slippage total dibatasi 8%", () => {
  assert(slipPct(1e9, 1) <= SLIP_CAP + 1e-12, "slippage tidak boleh melewati cap total");
});

test("costs: likuiditas null dianggap paling buruk (cap dampak)", () => {
  approx(slipPct(25, null), SLIP_BASE + IMPACT_CAP, 1e-9, "likuiditas tak diketahui");
});

test("costs: model keras k=2 tidak pernah lebih ringan dari k=1", () => {
  for (const liq of [10_000, 25_000, 50_000, 100_000, 1_000_000]) {
    assert(slipPct(25, liq, 2) >= slipPct(25, liq, 1), `k=2 harus ≥ k=1 pada liq ${liq}`);
  }
});

test("costs: hasil bersih = bruto − fee − slippage − gas", () => {
  const gross = 50;
  const liq = 50_000;
  const got = exitProceedsUsd(gross, liq);
  const want = gross * (1 - DEX_FEE_PCT - slipPct(gross, liq)) - GAS_USD;
  approx(got, want, 1e-9, "rumus bersih");
});

test("costs: haircut 75% (pool mati) memangkas hasil secara nyata", () => {
  const tanpa = exitProceedsUsd(50, 50_000);
  const dengan = exitProceedsUsd(50, 50_000, { haircut: 0.75 });
  assert(dengan < tanpa * 0.3, "haircut 0.75 harus menyisakan kurang dari 30%");
});

test("costs: hasil tidak pernah negatif (kebal harga ekstrem)", () => {
  assert(exitProceedsUsd(0.0000001, 1) >= 0, "hasil tidak boleh negatif");
});

test("costs: PnL bersih trade = hasil − notional masuk", () => {
  const qty = 1000;
  const exitPrice = 0.03; // 1000 × 0.03 = $30 bruto
  const notional = 25;
  const pnl = netPnlUsd(qty, exitPrice, notional, 50_000);
  approx(pnl, exitProceedsUsd(30, 50_000) - notional, 1e-9, "PnL bersih");
  assert(pnl < 30 - notional, "fee/slippage harus mengurangi, bukan menambah");
});
