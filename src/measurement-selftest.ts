import { strict as assert } from "node:assert";
import { mintId } from "./util/ids.js";
import { structuralOutcome } from "./analysis/structural-outcome.js";
import { expandArmResultSets, validatePairedArmResults, type ArmResult } from "./analysis/profit-contract.js";

const ids = new Set(Array.from({ length: 2_000 }, () => mintId("d")));
assert.equal(ids.size, 2_000, "decision ids must be unique");

assert.equal(structuralOutcome({ outcome: "rapid-rug", peakGainPct: 201 }), "PUMP_THEN_RUG");
assert.equal(structuralOutcome({ outcome: "drained", peakGainPct: 20 }), "BAD_NO_PUMP");
assert.equal(structuralOutcome({ outcome: "graduated", peakGainPct: 80 }), "GRADUATED_WIN");
assert.equal(structuralOutcome({ outcome: "faded", peakGainPct: 150 }), "WIN_SURVIVED");
assert.equal(structuralOutcome({ outcome: "unpriceable", peakGainPct: 9_421 }), "UNPRICEABLE");

const base = {
  recordType: "ARM_RESULT", source: "interleaved-paper", counterfactualComplete: true,
  measurementEpoch: "e2-test", armSetId: "set-1", armSpecHash: "spec-1",
  implementationHash: "impl-1", decisionId: "d1", mint: "mint1",
  launchAt: 1, horizonSec: 2_700, regimeId: "PUMP_CURVE_V1",
  exitPolicyId: "exit-1", executionPolicyId: "exec-1", parserVersion: "parser-1",
  quoteSource: "bonding-curve", action: "ENTER", execStage: "executable",
} as const;
const paired: ArmResult[] = [
  { ...base, armId: "A", policyId: "hard-safety", netExecutablePnlSol: -0.01 },
  { ...base, armId: "B", policyId: "setup", netExecutablePnlSol: 0.02 },
  { ...base, armId: "C", policyId: "blind", action: "POLICY_SKIP", execStage: "not-entered", skipReason: "randomized-out", netExecutablePnlSol: 0 },
];
assert.equal(validatePairedArmResults(paired, ["A", "B", "C"]).ok, true);
assert.equal(validatePairedArmResults(expandArmResultSets([{
  recordType: "ARM_RESULT_SET",
  armSetId: "set-1",
  decisionId: "d1",
  results: paired,
}]), ["A", "B", "C"]).ok, true);
assert.equal(validatePairedArmResults(expandArmResultSets([{
  recordType: "ARM_RESULT_SET",
  armSetId: "wrong-set",
  decisionId: "d1",
  results: paired,
}]), ["A", "B", "C"]).ok, false);
assert.equal(validatePairedArmResults(paired.slice(0, 2), ["A", "B", "C"]).ok, false);
assert.equal(validatePairedArmResults([{ action: "CLOSE", netExecutablePnlSol: 1 }], ["A", "B"]).ok, false);
assert.equal(validatePairedArmResults([{ ...paired[0], regimeId: "UNKNOWN_REGIME" }, ...paired.slice(1)], ["A", "B", "C"]).ok, false);
assert.equal(validatePairedArmResults([{ ...paired[0], regimeId: "NON_SOL_QUOTE" }, ...paired.slice(1)], ["A", "B", "C"]).ok, false);
assert.equal(validatePairedArmResults(paired.map((row) => ({ ...row, regimeId: "NON_SOL_QUOTE" })), ["A", "B", "C"]).ok, true);
assert.equal(validatePairedArmResults([
  { ...paired[0], execStage: "missing-quote", missingReason: "rpc-timeout", netExecutablePnlSol: null },
  ...paired.slice(1),
], ["A", "B", "C"]).ok, true);
assert.equal(validatePairedArmResults([
  { ...paired[0], execStage: "missing-quote", netExecutablePnlSol: 0 },
  ...paired.slice(1),
], ["A", "B", "C"]).ok, false);
assert.equal(validatePairedArmResults([{ ...paired[0], action: "POLICY_SKIP", execStage: "not-entered" }, ...paired.slice(1)], ["A", "B", "C"]).ok, false);
assert.equal(validatePairedArmResults([{ ...paired[0], exitPolicyId: "exit-2" }, ...paired.slice(1)], ["A", "B", "C"]).ok, false);

console.log("measurement-selftest: 18/18 passed");
