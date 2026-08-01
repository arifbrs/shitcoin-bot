import { classifySetup, type SetupVerdict } from "../discovery/setup-filter.js";
import { quoteMintIsSol } from "../safety/onchain.js";
import type { Candidate, GateResult } from "../types.js";
import { deterministicArmSample, INTERLEAVED_ARM_SPEC } from "./arm-spec.js";

export type ArmIntent =
  | { armId: "A" | "B" | "C"; policyId: string; action: "ENTER_INTENT"; reason: "POLICY_ADMIT" }
  | { armId: "A" | "B" | "C"; policyId: string; action: "POLICY_SKIP"; reason: string };

export interface ArmDecisionPlan {
  decisionId: string;
  mint: string;
  setup: SetupVerdict;
  intents: ArmIntent[];
}

function commonExecutionSkip(c: Candidate, gate: GateResult): string | null {
  if (!c.decisionId) return "MISSING_DECISION_ID";
  if (!c.bondingCurveKey) return "MISSING_BONDING_CURVE";
  if ((c.pool ?? "pump").toLowerCase() !== "pump") return "UNSUPPORTED_POOL";
  if (c.isMayhemMode) return "UNSUPPORTED_MAYHEM_MODE";
  if (!quoteMintIsSol(c.quoteMint)) return "UNSUPPORTED_NON_SOL_QUOTE";
  if (c.honeypot) return "PROVEN_SELL_FAILURE";
  if (gate.verdict === "REJECT") {
    const failed = gate.checks.filter((check) => check.hard && !check.passed).map((check) => check.name);
    return `HARD_GATE:${failed.join(",") || "REJECT"}`;
  }
  return null;
}

/**
 * Freeze all three admission decisions from one decision-time snapshot. No future setup verdict,
 * momentum, peak, quote or outcome may be passed back into this function.
 */
export function planArmAdmissions(
  c: Candidate,
  gate: GateResult,
  setupAtDecision: SetupVerdict = classifySetup(c),
): ArmDecisionPlan {
  if (!c.decisionId) throw new Error("decisionId must exist before arm admission");
  const commonSkip = commonExecutionSkip(c, gate);
  const byId = new Map(INTERLEAVED_ARM_SPEC.arms.map((arm) => [arm.armId, arm]));
  const intent = (armId: "A" | "B" | "C", skip: string | null): ArmIntent => {
    const arm = byId.get(armId)!;
    return skip
      ? { armId, policyId: arm.policyId, action: "POLICY_SKIP", reason: skip }
      : { armId, policyId: arm.policyId, action: "ENTER_INTENT", reason: "POLICY_ADMIT" };
  };

  // ADMISSION SAMPLING (2026-07-28, queue-capacity fix): reduces how many decisions ever reach
  // the entry queue, WITHOUT raising ENTRY_ATTEMPT_MS (owner's explicit call — that risked an RPC
  // storm and didn't fix the actual volume/capacity mismatch). Salted distinctly from C's own draw
  // (`admission:` prefix vs `c-subset:` below) so the two are statistically independent — without
  // that, C's 5,000bps draw would just be a strict subset of A's 3,300bps draw by construction
  // (same underlying hash, nested thresholds), giving C 100% of A's admits instead of the
  // intended ~50%. Pure decisionId hash — no market cap, score, holder count, or strategy feature
  // ever selects who is sampled in.
  const admitBps = byId.get("A")!.deterministicSampleBps;
  const admitted = deterministicArmSample(`admission:${c.decisionId}`, admitBps);
  const NOT_SAMPLED = "NOT_SAMPLED_ADMISSION";

  const aSkip = commonSkip ?? (admitted ? null : NOT_SAMPLED);
  // B rides the SAME admission draw as A (paired comparison needs identical launches under both
  // policies) and differs only by the decision-time predictive setup classifier on top. UNKNOWN is
  // intentionally admitted in this paper experiment, exactly as pre-registered.
  const bSkip = commonSkip ?? (!admitted ? NOT_SAMPLED : setupAtDecision.verdict === "TOXIC"
    ? `SETUP_TOXIC:${setupAtDecision.evidence.join(",") || "unspecified"}`
    : null);
  // C is a feature-blind deterministic half of A's ADMITTED sample (~16.5% of all candidates
  // overall). Hash assignment happens even when A's admission draw fails, but common execution
  // safety and non-admission always win over the randomized policy skip reason.
  const cBps = byId.get("C")!.deterministicSampleBps;
  const cSelected = admitted && deterministicArmSample(`c-subset:${c.decisionId}`, cBps);
  const cSkip = commonSkip ?? (!admitted ? NOT_SAMPLED : cSelected ? null : "DETERMINISTIC_HALF_NOT_SELECTED");

  return {
    decisionId: c.decisionId,
    mint: c.mint,
    setup: {
      verdict: setupAtDecision.verdict,
      confidence: setupAtDecision.confidence,
      evidence: [...setupAtDecision.evidence],
      missing: [...setupAtDecision.missing],
    },
    intents: [intent("A", aSkip), intent("B", bSkip), intent("C", cSkip)],
  };
}
