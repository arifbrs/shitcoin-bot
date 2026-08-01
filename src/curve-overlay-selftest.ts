import { strict as assert } from "node:assert";
import { config } from "./config.js";
import {
  counterfactualPostBuyReserves,
  curveEntryFill,
  curveExitProceedsSol,
  curveSellSolGross,
  gasPerSideSol,
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

console.log("curve-overlay-selftest: 13/13 passed");
