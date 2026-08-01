import { strict as assert } from "node:assert";
import { assessBuySimulation, lateEnrichmentAction } from "./execution/semantics.js";

const buyFailure = assessBuySimulation({
  built: true,
  ok: false,
  needsFunding: false,
  err: "program error",
});
assert.equal(buyFailure.stage, "would-fail");
assert.equal(buyFailure.entryExecutable, false);
assert.equal(buyFailure.retryable, false);
assert.equal(buyFailure.sellability, "UNTESTED");

const funded = assessBuySimulation({
  built: true,
  ok: true,
  needsFunding: false,
  err: null,
});
assert.equal(funded.stage, "executable");
assert.equal(funded.entryExecutable, true);
assert.equal(funded.retryable, false);

const unavailable = assessBuySimulation({
  built: true,
  ok: false,
  needsFunding: false,
  transportError: true,
  err: "research RPC yielded to trading",
});
assert.equal(unavailable.stage, "unavailable");
assert.equal(unavailable.entryExecutable, false);
assert.equal(unavailable.retryable, true);
assert.equal(unavailable.sellability, "UNTESTED");

const indexingRace = assessBuySimulation({
  built: true,
  ok: false,
  needsFunding: false,
  err: '{"InstructionError":[2,"IncorrectProgramId"]}',
});
assert.equal(indexingRace.stage, "would-fail");
assert.equal(indexingRace.entryExecutable, false);
assert.equal(indexingRace.retryable, true);

assert.equal(lateEnrichmentAction(false), "TELEMETRY");
assert.equal(lateEnrichmentAction(true), "EXIT_EXECUTION_SAFETY");

console.log("execution-semantics-selftest: 16/16 passed");
