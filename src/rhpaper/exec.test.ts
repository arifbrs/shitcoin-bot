import { test, eq } from "../testing/harness.js";
import { slippageFor, POOL_FEE_PCT, quoteImpact, parseRouterQuote } from "./exec.js";

test("exec: slippage dari dampak + margin, jepit 1–10%", () => {
  eq(slippageFor(0), 1, "dampak 0 → 1%");
  eq(slippageFor(2), 3, "dampak 2 → 3%");
  eq(slippageFor(8), 9, "dampak 8 → 9%");
  eq(slippageFor(50), 10, "dampak besar → 10% (batas)");
  eq(slippageFor(NaN), 5, "tak terbaca → 5%");
  eq(slippageFor(-2), 3, "negative impact uses magnitude");
});

test("exec: impact missing/high refuses BUY but never blocks SELL solely on impact", () => {
  eq(parseRouterQuote({ toTokenAmount: "100", priceImpactPercent: null }, "1000", true).ok, false, "buy fails closed");
  eq(parseRouterQuote({ toTokenAmount: "100", priceImpactPercent: "6" }, "1000", true).ok, false, "high-impact buy refused");
  const sell = parseRouterQuote({ toTokenAmount: "100", priceImpactPercent: null }, "1000", false);
  eq(sell.ok, true, "sell allowed with available output"); eq(sell.quote?.impactPct, null, "missing impact not zero");
  eq(parseRouterQuote({ toTokenAmount: "100", priceImpactPercent: "90" }, "1000", false).ok, true, "large realized exit not hidden");
});

test("exec: built router quote requires exact raw input and a nonzero integer output", () => {
  eq(parseRouterQuote({ toTokenAmount: "1.2", priceImpactPercent: "0" }, "1000", true).ok, false, "fractional raw amount refused");
  eq(parseRouterQuote({ toTokenAmount: "0", priceImpactPercent: "0" }, "1000", true).ok, false, "zero output refused");
  eq(parseRouterQuote({ toTokenAmount: "100", fromTokenAmount: "999", priceImpactPercent: "0" }, "1000", true).ok, false, "input mismatch refused");
  eq(parseRouterQuote({ toTokenAmount: "100", fromTokenAmount: "1000", priceImpactPercent: "0" }, "1000", true, 123).quote?.ts, 123, "actual quote timestamp retained");
});

test("exec: fee pool = 0,01% (terukur), bukan 1%", () => {
  eq(POOL_FEE_PCT, 0.0001, "0,01%");
});

test("exec: current OKX priceImpactPercent field is read, missing is not zero", () => {
  eq(quoteImpact({ priceImpactPercent: "7.2" }), 7.2, "current field");
  eq(quoteImpact({ priceImpactPercentage: "7.2" }), null, "wrong field is unavailable");
  eq(quoteImpact({ priceImpactPercent: null }), null, "null is unavailable");
  eq(quoteImpact({ priceImpactPercent: "" }), null, "empty is unavailable");
});
