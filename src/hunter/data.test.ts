import { test, eq } from "../testing/harness.js";
import { hunterNumber, hunterToken, hunterTrader } from "./data.js";

test("hunter: missing/null stats are unavailable, not zero ROI/winrate", () => {
  for (const v of [undefined, null, "", " ", true, {}, "NaN"]) eq(hunterNumber(v), null, "not a valid observation");
  eq(hunterTrader("w", {}), null, "API failure is not a tier-C trader");
  eq(hunterTrader("w", { realized_profit_pnl: "0", pnl_stat: { winrate: 0 } })?.roiPct, 0, "real zero preserved");
  eq(hunterTrader("w", { realized_profit_pnl: 3.5, pnl_stat: { winrate: 0.65 } })?.winratePct, 65, "documented ratio → percentage");
});
test("hunter: no total-supply fallback or invented zero market cap", () => {
  eq(hunterToken("robinhood", "t", "T", { price: { price: 2 }, total_supply: 100, liquidity: 100 }), null, "total supply isn't circulating supply");
  eq(hunterToken("robinhood", "t", "T", { price: { price: 2 }, circulating_supply: 100, liquidity: 100 })?.mcapUsd, 200, "verified formula");
});
