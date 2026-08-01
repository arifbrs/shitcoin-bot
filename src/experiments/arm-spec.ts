import { createHash } from "node:crypto";

/**
 * PRE-REGISTERED before the first e3 arm result exists. Editing any material field requires a
 * NEW armSetId/epoch; old and new results may never be pooled.
 *
 * Purpose: compare ENTRY/admission policies on the same launches. Every arm uses the same
 * deterministic 45-minute exit and executable fill model. No LLM, momentum, dev-vibe or future
 * setup verdict is allowed to influence an arm after admission.
 */
export const INTERLEAVED_ARM_SPEC = Object.freeze({
  // BUMPED 2026-07-28: arm-set-e3-entry-policy-v1's queue could not keep up with real incoming
  // volume (~24-30 decisions/min against a deliberately-capped ~30/min worker — see
  // arm-coordinator.ts's ENTRY_ATTEMPT_MS comment for why that cap is not being raised). That
  // produced hundreds of ENTRY_QUOTE_TIMEOUT results measuring coordinator congestion, not
  // strategy performance — implementationHash "46yxgj"'s data is quarantined, never pooled with
  // this spec. Fix here is REDUCED ADMISSION VOLUME via deterministic decisionId-hash sampling
  // (below), not a faster worker — an RPC-storm risk the owner explicitly declined to take.
  armSetId: "arm-set-e3-entry-policy-v2-sampled",
  measurementEpoch: "e3-interleaved-entry-policy-2026-07-28-sampled",
  frozenAt: "2026-07-28T20:30:00.000Z",
  stakeSol: 0.03,
  startingSol: 0.5,
  maxPositions: 16,
  maxPerCluster: 2,
  horizonSec: 45 * 60,
  exitPolicyId: "exit-principal-first-45m-v1",
  executionPolicyId: "pump-sol-curve-v4-fees-real-liquidity-v1",
  primaryRegimes: ["PUMP_CURVE_V1", "GRADUATED_AMM"] as const,
  commonExit: Object.freeze({
    // Safety floor and proven liquidity exhaustion remain bounded-risk exits.
    catastrophicStopPct: -70,
    liquidityGoneExit: true,
    // Principal-first, then a material residual runner. Fractions are of original quantity.
    tiers: [
      { gainPct: 30, sellFrac: 0.40 },
      { gainPct: 80, sellFrac: 0.30 },
      { gainPct: 200, sellFrac: 0.15 },
    ] as const,
    minRunnerFrac: 0.15,
    dynamicTrail: [
      { gainPct: 15, trailPct: 6 },
      { gainPct: 40, trailPct: 12 },
      { gainPct: 80, trailPct: 22 },
      { gainPct: 150, trailPct: 35 },
      { gainPct: 300, trailPct: 45 },
      { gainPct: 800, trailPct: 60 },
    ] as const,
    // The experiment tests the owner's 30–45 minute fat-tail thesis directly. A 45-second
    // no-development cut would change the question into a scalp and is therefore excluded.
    noDevelopmentCut: false,
    maxHoldSec: 45 * 60,
    useLlmAgent: false,
    useMomentumExit: false,
    useDevVibeExit: false,
  }),
  arms: [
    {
      armId: "A",
      policyId: "hard-execution-safety-only-v1",
      description: "Enter every valid SOL Pump launch that passes hard execution/safety checks.",
      predictiveSetup: "telemetry-only",
      // ADMISSION sample (2026-07-28, queue-capacity fix): ~33% of all decisionIds, hashed —
      // this IS now actually read by arm-admission.ts (previously a documentation-only field for
      // A/B; only C's was ever wired). Not a market/setup/quality filter — pure decisionId hash.
      deterministicSampleBps: 3_300,
    },
    {
      armId: "B",
      policyId: "setup-classifier-current-v1",
      description: "Arm A eligibility plus the frozen decision-time setup classifier; UNKNOWN is admitted.",
      predictiveSetup: "reject-toxic-admit-clean-and-unknown",
      // Same admission sample as A (paired comparison needs the same launches under both
      // policies) — B is never sampled independently of A.
      deterministicSampleBps: 3_300,
    },
    {
      armId: "C",
      policyId: "hard-safety-deterministic-half-v1",
      description: "DecisionId-hashed 50% subset of Arm A's ADMITTED sample (~16.5% of all candidates); no market/setup feature selects the subset.",
      predictiveSetup: "telemetry-only",
      deterministicSampleBps: 5_000,
    },
  ] as const,
});

/** Stable, feature-blind comparator assignment. Same decisionId always receives the same answer. */
export function deterministicArmSample(decisionId: string, sampleBps: number): boolean {
  if (!Number.isInteger(sampleBps) || sampleBps < 0 || sampleBps > 10_000) {
    throw new Error("sampleBps must be an integer in [0,10000]");
  }
  const bytes = createHash("sha256")
    .update(`${INTERLEAVED_ARM_SPEC.armSetId}:${decisionId}`)
    .digest();
  const bucket = bytes.readUInt32BE(0) % 10_000;
  return bucket < sampleBps;
}

/** Human-auditable immutable identity stamped on every future ARM_RESULT. */
export const INTERLEAVED_ARM_SPEC_HASH = createHash("sha256")
  .update(JSON.stringify(INTERLEAVED_ARM_SPEC))
  .digest("hex")
  .slice(0, 16);
