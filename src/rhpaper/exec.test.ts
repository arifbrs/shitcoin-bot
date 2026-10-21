import { test, eq } from "../testing/harness.js";
import { slippageFor, POOL_FEE_PCT } from "./exec.js";

test("exec: slippage dari dampak + margin, jepit 1–10%", () => {
  eq(slippageFor(0), 1, "dampak 0 → 1%");
  eq(slippageFor(2), 3, "dampak 2 → 3%");
  eq(slippageFor(8), 9, "dampak 8 → 9%");
  eq(slippageFor(50), 10, "dampak besar → 10% (batas)");
  eq(slippageFor(NaN), 5, "tak terbaca → 5%");
});

test("exec: fee pool = 0,01% (terukur), bukan 1%", () => {
  eq(POOL_FEE_PCT, 0.0001, "0,01%");
});
