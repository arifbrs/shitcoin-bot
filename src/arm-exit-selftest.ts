import { strict as assert } from "node:assert";
import { ArmExitSimulation, type ArmMarketMark } from "./experiments/arm-exit.js";
import { INTERLEAVED_ARM_SPEC } from "./experiments/arm-spec.js";
import { config } from "./config.js";
import {
  curveExitProceedsSol,
  curveFeeFrac,
  curveSellSolGross,
  gasPerSideSol,
  syntheticAmmExitProceedsSol,
  syntheticAmmReservesFromQuote,
} from "./execution/curve-math.js";

const entry = { atMs: 1_000, pool: "pump" as const, vSol: 30, vTokens: 1_073_000_000, realSol: 0 };
const k = entry.vSol * entry.vTokens;
const mark = (sec: number, vSol: number, realSol = Math.max(0, vSol - 30)): ArmMarketMark => ({
  atMs: entry.atMs + sec * 1_000,
  complete: false,
  quoteSource: "bonding-curve",
  vSol,
  vTokens: k / vSol,
  realSol,
});

const flat = new ArmExitSimulation(entry);
const horizon = flat.onMark(mark(INTERLEAVED_ARM_SPEC.horizonSec, 30, 0));
assert(horizon.terminal?.status === "executable");
if (horizon.terminal?.status !== "executable") throw new Error("fixture");
assert.equal(horizon.terminal.reason, "FIXED_HORIZON");
assert(horizon.terminal.netExecutablePnlSol < 0, "flat round trip must lose fees");
assert(horizon.terminal.netExecutablePnlSol >= -INTERLEAVED_ARM_SPEC.stakeSol);
assert(horizon.terminal.netExecutablePnlSol > -0.01, "our own entry liquidity must not disappear");

const partial = new ArmExitSimulation(entry);
const firstRun = partial.onMark(mark(10, 38, 8));
assert.equal(firstRun.partials.length, 1);
assert(Math.abs(firstRun.partials[0]!.tokenQtySold / partial.originalQty - 0.4) < 1e-9);
assert(Math.abs(partial.snapshot().remainingQty / partial.originalQty - 0.6) < 1e-9);
assert.equal(partial.snapshot().nextTier, 1);
assert.equal(firstRun.terminal, undefined);

const secondRun = partial.onMark(mark(20, 50, 20));
assert(secondRun.partials.length >= 1);
assert(partial.snapshot().remainingQty / partial.originalQty >= 0.15 - 1e-9);

const originalAfterPartial = new ArmExitSimulation(entry);
originalAfterPartial.onMark(mark(10, 38, 8));
const state = originalAfterPartial.toState();
const restoredAfterPartial = ArmExitSimulation.fromState(JSON.parse(JSON.stringify(state)));
assert.deepEqual(restoredAfterPartial.toState(), state);
const nextMark = mark(30, 45, 15);
assert.deepEqual(restoredAfterPartial.onMark(nextMark), originalAfterPartial.onMark(nextMark));
assert.deepEqual(restoredAfterPartial.toState(), originalAfterPartial.toState());
assert.throws(() => ArmExitSimulation.fromState({ ...state, nextTier: 99 }));

const rug = new ArmExitSimulation(entry);
const rugResult = rug.onMark(mark(4, 1, 0));
assert(rugResult.terminal?.status === "executable");
if (rugResult.terminal?.status !== "executable") throw new Error("fixture");
assert.equal(rugResult.terminal.reason, "LIQUIDITY_GONE");
assert(rugResult.terminal.netExecutablePnlSol >= -INTERLEAVED_ARM_SPEC.stakeSol);

const missing = new ArmExitSimulation(entry);
const missingResult = missing.finishMissing(entry.atMs + 2_700_000, "horizon-quote-timeout");
assert.equal(missingResult.status, "missing-quote");
assert.throws(() => missing.onMark(mark(2_701, 30, 1)));

const graduated = new ArmExitSimulation(entry);
const grad = graduated.onMark({
  atMs: entry.atMs + 2_700_000,
  complete: true,
  quoteSource: "jupiter-amm",
  vSol: 100,
  vTokens: 1_000_000_000,
  realSol: 100,
  syntheticNetReserves: true,
});
assert(grad.terminal?.status === "executable");
if (grad.terminal?.status !== "executable") throw new Error("fixture");
assert.equal(grad.terminal.regimeId, "GRADUATED_AMM");
assert.equal(grad.terminal.quoteSource, "jupiter-amm");

// ── Boundary parity: bonding-curve -> Jupiter AMM ───────────────────────────
// Invariant: for the SAME remainingQty and the SAME underlying reserves, switching
// quoteSource must not create an executable-value jump beyond the explicit fee-schedule
// delta (curve fee vs AMM fee) plus the documented ATA-rent reclaim close() adds on any
// final sale. The AMM leg is priced with an exact-size quote for remainingQty via the
// same production helper papertrader.ts uses at graduation (syntheticAmmReservesFromQuote);
// curve reserves are NOT carried into the AMM leg.
{
  const boundary = new ArmExitSimulation(entry);
  boundary.onMark(mark(10, 38, 8)); // raw curve delta -> minimal partial sell (tier 0)
  boundary.onMark(mark(20, 42, 12)); // raw curve delta, no partial
  const state = boundary.toState();
  assert(state.remainingQty > 0 && state.remainingQty < boundary.originalQty);

  // Pre-boundary snapshot: executable value if we exited on the curve right now.
  const preBoundaryValue = curveExitProceedsSol(
    state.cfVSol, state.cfVTokens, state.remainingQty, entry.pool, false, state.cfRealSol,
  );

  const feeCurve = curveFeeFrac(entry.pool, false);
  const feeAmm = curveFeeFrac(entry.pool, true);
  const gas = gasPerSideSol();

  // Construct a Jupiter quote for the SAME underlying reserves/execution price as the curve
  // (isolates the fee-schedule change as the only permitted source of a jump).
  const grossAtGrad = curveSellSolGross(state.cfVSol, state.cfVTokens, state.remainingQty);
  const cappedGross = state.cfRealSol >= 0 ? Math.min(grossAtGrad, state.cfRealSol) : grossAtGrad;
  const netSolOutMatched = cappedGross * (1 - feeAmm);
  const quoteImpactPct = (state.remainingQty / (state.cfVTokens + state.remainingQty)) * 100;

  const matchedReserves = syntheticAmmReservesFromQuote(state.remainingQty, netSolOutMatched, quoteImpactPct);
  assert(matchedReserves, "production helper must reconstruct reserves from a valid exact-size quote");
  const directPostBoundary = syntheticAmmExitProceedsSol(
    matchedReserves!.solReserve, matchedReserves!.tokenReserve, state.remainingQty, matchedReserves!.solReserve,
  );

  const delta = directPostBoundary - preBoundaryValue;
  const expectedDelta = cappedGross * (feeCurve - feeAmm);
  assert(
    Math.abs(delta - expectedDelta) < 1e-9,
    `boundary jump must equal the explicit fee-schedule delta only: got ${delta}, expected ${expectedDelta}`,
  );

  // Full sim round trip through onMark(): confirm the ONLY extra jump vs the direct helper
  // computation is the documented ATA-rent reclaim credit close() applies on every final sale.
  const gradResult = boundary.onMark({
    atMs: entry.atMs + INTERLEAVED_ARM_SPEC.horizonSec * 1_000,
    complete: true,
    quoteSource: "jupiter-amm",
    vSol: matchedReserves!.solReserve,
    vTokens: matchedReserves!.tokenReserve,
    realSol: matchedReserves!.solReserve,
    syntheticNetReserves: true,
  });
  assert(gradResult.terminal?.status === "executable");
  if (gradResult.terminal?.status !== "executable") throw new Error("fixture");
  const ataReclaim = config.risk.ataReclaim ? Math.max(0, config.risk.ataRentSol - gas) : 0;
  assert(
    Math.abs(gradResult.terminal.finalProceedsSol - (directPostBoundary + ataReclaim)) < 1e-9,
    "sim close() must not add value beyond the documented ATA-rent reclaim",
  );

  // Negative control: a deliberately WORSE quote (same qty/impact, 10% less net SOL out) must
  // move executable value down by ~ the injected shortfall. This is a tautology guard: it proves
  // the pipeline actually reads the quote instead of silently reproducing the curve price.
  const worseNetSolOut = netSolOutMatched * 0.9;
  const worseReserves = syntheticAmmReservesFromQuote(state.remainingQty, worseNetSolOut, quoteImpactPct);
  assert(worseReserves, "worse quote must still reconstruct valid reserves");
  const worsePostBoundary = syntheticAmmExitProceedsSol(
    worseReserves!.solReserve, worseReserves!.tokenReserve, state.remainingQty, worseReserves!.solReserve,
  );
  assert(worsePostBoundary < directPostBoundary, "a worse quote must lower executable value");
  const worseDelta = worsePostBoundary - directPostBoundary;
  const expectedWorseDelta = -(0.1 * netSolOutMatched);
  assert(
    Math.abs(worseDelta - expectedWorseDelta) < 1e-9,
    `negative control magnitude off: got ${worseDelta}, expected ${expectedWorseDelta}`,
  );

  const boundaryWorse = new ArmExitSimulation(entry);
  boundaryWorse.onMark(mark(10, 38, 8));
  boundaryWorse.onMark(mark(20, 42, 12));
  const worseGradResult = boundaryWorse.onMark({
    atMs: entry.atMs + INTERLEAVED_ARM_SPEC.horizonSec * 1_000,
    complete: true,
    quoteSource: "jupiter-amm",
    vSol: worseReserves!.solReserve,
    vTokens: worseReserves!.tokenReserve,
    realSol: worseReserves!.solReserve,
    syntheticNetReserves: true,
  });
  assert(worseGradResult.terminal?.status === "executable");
  if (worseGradResult.terminal?.status !== "executable") throw new Error("fixture");
  assert(
    worseGradResult.terminal.finalProceedsSol < gradResult.terminal.finalProceedsSol,
    "sim must propagate a worse injected quote into lower final proceeds, not ignore it",
  );

  // Missing quote stays missing: the production helper refuses to fabricate reserves from a
  // degenerate quote, so callers (papertrader tick()) must hold rather than feed a phantom mark.
  assert.equal(syntheticAmmReservesFromQuote(state.remainingQty, 0, quoteImpactPct), null);
  assert.equal(syntheticAmmReservesFromQuote(0, netSolOutMatched, quoteImpactPct), null);
}

console.log("arm-exit-selftest: 36/36 passed");
