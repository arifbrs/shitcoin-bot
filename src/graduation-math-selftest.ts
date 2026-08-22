import { strict as assert } from "node:assert";
import { config } from "./config.js";
import {
  syntheticAmmExitProceedsSol,
  syntheticAmmReservesFromQuote,
} from "./trader.js";

const qty = 1_000;
const quotedNetSol = 0.5;
const reserves = syntheticAmmReservesFromQuote(qty, quotedNetSol, 10);
assert(reserves);
const gas = config.risk.baseTxSol + config.exec.priorityFeeSol;

const full = syntheticAmmExitProceedsSol(
  reserves.solReserve,
  reserves.tokenReserve,
  qty,
  reserves.solReserve,
);
assert(Math.abs(full - (quotedNetSol - gas)) < 1e-10, "full synthetic walk must reproduce Jupiter net quote minus gas");

const firstQty = 400;
const first = syntheticAmmExitProceedsSol(
  reserves.solReserve,
  reserves.tokenReserve,
  firstQty,
  reserves.solReserve,
);
const firstRouteNet = first + gas;
const second = syntheticAmmExitProceedsSol(
  reserves.solReserve - firstRouteNet,
  reserves.tokenReserve + firstQty,
  qty - firstQty,
  reserves.solReserve - firstRouteNet,
);
assert(Math.abs((first + second) - (quotedNetSol - 2 * gas)) < 1e-10, "partial then close must use remaining quantity");
assert(Math.abs((full - (first + second)) - gas) < 1e-10, "only the extra transaction gas may differ");
assert.equal(syntheticAmmReservesFromQuote(0, quotedNetSol, 10), null);
assert.equal(syntheticAmmReservesFromQuote(qty, 0, 10), null);

console.log("graduation-math-selftest: 6/6 passed");
