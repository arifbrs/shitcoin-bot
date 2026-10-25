import { strict as assert } from "node:assert";
import { config } from "./config.js";
import {
  counterfactualPostBuyReserves,
  curveEntryFill,
  curveExitProceedsSol,
  curveSellSolGross,
  gasPerSideSol,
  rebaseOverlayForAdoptedFill,
  replayObservedCurveDelta,
} from "./execution/curve-math.js";

const observed = { vSol: 30, vTokens: 1_073_000_000, realSol: 0 };
const fill = curveEntryFill(observed.vSol, observed.vTokens, 0.03, "pump");
const postBuy = counterfactualPostBuyReserves(observed, fill);
assert(fill.tokenQty > 0);
assert(fill.solIntoCurve > 0);
assert(Math.abs(postBuy.vSol * postBuy.vTokens - observed.vSol * observed.vTokens) < 1);
assert.equal(postBuy.realSol, fill.solIntoCurve);

const unchanged = replayObservedCurveDelta(postBuy, observed, observed);
assert.deepEqual(unchanged, postBuy, "a raw unchanged mainnet mark must not erase our paper buy");
let proceeds = curveExitProceedsSol(
  unchanged.vSol,
  unchanged.vTokens,
  fill.tokenQty,
  "pump",
  false,
  unchanged.realSol,
);
if (config.risk.ataReclaim) proceeds += Math.max(0, config.risk.ataRentSol - gasPerSideSol());
assert(proceeds > 0.02, `flat round trip unexpectedly destroyed principal: ${proceeds}`);
assert(proceeds < 0.03, "flat round trip must still pay modeled costs");

const marketBought = { vSol: 32, vTokens: observed.vTokens, realSol: 2 };
const advanced = replayObservedCurveDelta(postBuy, observed, marketBought);
assert.equal(advanced.vSol, postBuy.vSol + 2);
assert.equal(advanced.realSol, postBuy.realSol + 2);
assert(Math.abs(advanced.vSol * advanced.vTokens - postBuy.vSol * postBuy.vTokens) < 1);

const partialQty = fill.tokenQty * 0.4;
const partialGross = curveSellSolGross(advanced.vSol, advanced.vTokens, partialQty);
const afterPartial = {
  vSol: advanced.vSol - partialGross,
  vTokens: advanced.vTokens + partialQty,
  realSol: Math.max(0, advanced.realSol - partialGross),
};
const unchangedAfterPartial = replayObservedCurveDelta(afterPartial, marketBought, marketBought);
assert.deepEqual(
  unchangedAfterPartial,
  afterPartial,
  "the next raw mark must not erase a prior hypothetical partial sell",
);

// ── LIVE-FILL ADOPTION RE-BASE (regression: the +1668% fantasy peak) ─────────────
// A real fill replaced a paper entry ~12x smaller in basis. Without re-basing, the SAME
// proceeds divided by the shrunken basis read as a massive gain and poisoned the trail HWM.
const paperSize = 0.15;
const realSize = 0.0126;
const paperFill = curveEntryFill(postBuy.vSol, postBuy.vTokens, paperSize, "pump");
const withPaperEntry = counterfactualPostBuyReserves(postBuy, paperFill);
// Production reports the CHAIN's token count for the real fill; model it consistently here.
// (A 12x-smaller buy does NOT get 1/12th the tokens — the curve is concave — so deriving the
// quantity from the same curveEntryFill math is what keeps the scenario physically coherent.)
const realFill = curveEntryFill(postBuy.vSol, postBuy.vTokens, realSize, "pump");
const rebased = rebaseOverlayForAdoptedFill(
  withPaperEntry,
  { sizeSol: paperSize, tokenQty: paperFill.tokenQty },
  { spentSol: realSize, tokens: realFill.tokenQty, pool: "pump" },
);
// The re-based overlay must describe exactly what a native REAL-sized entry would have built:
const directReal = counterfactualPostBuyReserves(postBuy, realFill);
assert(
  Math.abs(rebased.vSol - directReal.vSol) < 1e-9,
  `vSol re-base mismatch: ${rebased.vSol} vs ${directReal.vSol}`,
);
assert(
  Math.abs(rebased.vTokens - directReal.vTokens) / directReal.vTokens < 1e-9,
  `vTokens re-base mismatch: ${rebased.vTokens} vs ${directReal.vTokens}`,
);
// And the executable P&L under the REAL basis must stay sane (no four-figure gains from
// an accounting flip): mark-to-market on flat reserves ≈ small negative after costs.
const flatProceeds = curveSellSolGross(rebased.vSol, rebased.vTokens, realFill.tokenQty)
  * (1 - 0.01) - gasPerSideSol();
const flatPnlPct = ((flatProceeds - realSize) / realSize) * 100;
assert(flatPnlPct < 50 && flatPnlPct > -100, `adopted-basis mark exploded: ${flatPnlPct}%`);

console.log("curve-overlay-selftest: 19/19 passed");
