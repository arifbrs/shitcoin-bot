import { strict as assert } from "node:assert";
import {
  deterministicArmSample,
  INTERLEAVED_ARM_SPEC,
  INTERLEAVED_ARM_SPEC_HASH,
} from "./experiments/arm-spec.js";

assert.equal(INTERLEAVED_ARM_SPEC.arms.length, 3);
assert.deepEqual(INTERLEAVED_ARM_SPEC.arms.map((a) => a.armId), ["A", "B", "C"]);
assert.equal(new Set(INTERLEAVED_ARM_SPEC.arms.map((a) => a.policyId)).size, 3);
assert.equal(INTERLEAVED_ARM_SPEC.horizonSec, 2_700);
assert.equal(INTERLEAVED_ARM_SPEC.commonExit.maxHoldSec, 2_700);
assert.equal(INTERLEAVED_ARM_SPEC.commonExit.noDevelopmentCut, false);
assert.equal(INTERLEAVED_ARM_SPEC.commonExit.useLlmAgent, false);
assert.equal(INTERLEAVED_ARM_SPEC.commonExit.tiers.reduce((n, t) => n + t.sellFrac, 0), 0.85);
assert.equal(INTERLEAVED_ARM_SPEC.commonExit.minRunnerFrac, 0.15);
assert.equal(deterministicArmSample("decision-1", 0), false);
assert.equal(deterministicArmSample("decision-1", 10_000), true);
assert.equal(
  deterministicArmSample("decision-stable", 5_000),
  deterministicArmSample("decision-stable", 5_000),
);
assert.throws(() => deterministicArmSample("bad", 10_001));
assert.match(INTERLEAVED_ARM_SPEC_HASH, /^[0-9a-f]{16}$/);

const n = 20_000;
let selected = 0;
for (let i = 0; i < n; i++) if (deterministicArmSample(`d-${i}`, 5_000)) selected++;
assert(selected > n * 0.48 && selected < n * 0.52, `half-arm assignment drifted: ${selected}/${n}`);

console.log("arm-spec-selftest: 14/14 passed");
