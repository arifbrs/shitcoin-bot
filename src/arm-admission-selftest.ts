import { strict as assert } from "node:assert";
import { planArmAdmissions } from "./experiments/arm-admission.js";
import type { Candidate, GateResult } from "./types.js";

const candidate = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  source: "pumpportal",
  mode: "fast-follow",
  decisionId: id,
  mint: `mint-${id}`,
  pool: "pump",
  bondingCurveKey: `curve-${id}`,
  detectedAt: 1,
  ...extra,
});
const pass: GateResult = { verdict: "PASS", checks: [], score: 50 };
const hardReject: GateResult = {
  verdict: "REJECT",
  checks: [{ name: "mint-authority", hard: true, passed: false, detail: "active" }],
  score: 0,
};

// "unknown" happens to hash into the ~33% admission sample under arm-set-e3-entry-policy-v2-sampled.
const unknown = planArmAdmissions(candidate("unknown"), pass, {
  verdict: "UNKNOWN", confidence: 0.3, evidence: [], missing: ["FUNDING_DATA"],
});
assert.equal(unknown.intents.find((x) => x.armId === "A")?.action, "ENTER_INTENT");
assert.equal(unknown.intents.find((x) => x.armId === "B")?.action, "ENTER_INTENT");

// "toxic0" (not "toxic" — that decisionId hashes OUTSIDE the admission sample under the v2-sampled
// spec, which would make this test's real target — the toxic-setup skip on B specifically —
// indistinguishable from a plain non-admission skip on A too) is confirmed admitted.
const toxic = planArmAdmissions(candidate("toxic0"), pass, {
  verdict: "TOXIC", confidence: 0.8, evidence: ["SAME_SLOT_BUNDLE"], missing: [],
});
assert.equal(toxic.intents.find((x) => x.armId === "A")?.action, "ENTER_INTENT");
assert.equal(toxic.intents.find((x) => x.armId === "B")?.action, "POLICY_SKIP");
assert.equal(toxic.intents.find((x) => x.armId === "B")?.reason.startsWith("SETUP_TOXIC"), true);

// QUEUE-CAPACITY FIX (2026-07-28): a decisionId hashing OUTSIDE the ~33% admission sample must
// skip ALL THREE arms for the SAME reason — pure decisionId hash, no market/setup feature — and
// must do so even for an otherwise-perfectly-clean PASS/UNKNOWN candidate.
const notSampled = planArmAdmissions(candidate("notsampled0"), pass, {
  verdict: "UNKNOWN", confidence: 0.3, evidence: [], missing: ["FUNDING_DATA"],
});
assert(notSampled.intents.every((x) => x.action === "POLICY_SKIP"));
assert(notSampled.intents.every((x) => x.reason === "NOT_SAMPLED_ADMISSION"));

const rejected = planArmAdmissions(candidate("reject"), hardReject);
assert(rejected.intents.every((x) => x.action === "POLICY_SKIP"));
assert(rejected.intents.every((x) => x.reason.includes("HARD_GATE")));

const mayhem = planArmAdmissions(candidate("mayhem", { isMayhemMode: true }), pass);
assert(mayhem.intents.every((x) => x.action === "POLICY_SKIP"));
assert(mayhem.intents.every((x) => x.reason === "UNSUPPORTED_MAYHEM_MODE"));

const nonSol = planArmAdmissions(candidate("usdc", {
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}), pass);
assert(nonSol.intents.every((x) => x.action === "POLICY_SKIP"));
assert(nonSol.intents.every((x) => x.reason === "UNSUPPORTED_NON_SOL_QUOTE"));

// "chalf0" is confirmed admitted (A/B enter) AND selected into C's 50% sub-sample, so this
// actually exercises C's determinism rather than just repeating the non-admission skip twice.
const c1 = planArmAdmissions(candidate("chalf0"), pass);
const c2 = planArmAdmissions(candidate("chalf0"), pass);
assert.deepEqual(c1.intents.find((x) => x.armId === "C"), c2.intents.find((x) => x.armId === "C"));
assert.equal(c1.intents.find((x) => x.armId === "C")?.action, "ENTER_INTENT");

// "chalfB12" is confirmed admitted (A/B enter) but NOT selected into C's 50% sub-sample — proves
// C's sub-sample draw is independent of the admission draw (not just a nested subset of it, which
// would make C == A instead of ~half of A).
const cHalfSkip = planArmAdmissions(candidate("chalfB12"), pass);
assert.equal(cHalfSkip.intents.find((x) => x.armId === "A")?.action, "ENTER_INTENT");
assert.equal(cHalfSkip.intents.find((x) => x.armId === "C")?.action, "POLICY_SKIP");
assert.equal(cHalfSkip.intents.find((x) => x.armId === "C")?.reason, "DETERMINISTIC_HALF_NOT_SELECTED");

assert.throws(() => planArmAdmissions(candidate("bad", { decisionId: undefined }), pass));

console.log("arm-admission-selftest: 19/19 passed");
