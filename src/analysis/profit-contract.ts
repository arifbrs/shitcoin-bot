/**
 * Fail-closed contract for profitability evaluation.
 *
 * This does not synthesize missing counterfactuals. A record is admissible only when an
 * interleaved paper arm produced executable P&L for the same decision, fixed horizon and policy.
 * Selected live CLOSE records intentionally cannot satisfy this schema.
 */
export interface ArmResult {
  recordType: "ARM_RESULT";
  source: "interleaved-paper";
  counterfactualComplete: true;
  measurementEpoch: string;
  armSetId: string;
  armSpecHash: string;
  implementationHash: string;
  decisionId: string;
  mint: string;
  creator?: string;
  launchAt: number;
  entryAt?: number;
  entryLatencyMs?: number;
  entryVSol?: number;
  entryVTokens?: number;
  entryRealSol?: number;
  armId: string;
  /** Entry/admission policy unique to this arm. */
  policyId: string;
  /** Must be identical across compared arms. */
  exitPolicyId: string;
  /** Fees, quote, fill and slippage model; must be identical across compared arms. */
  executionPolicyId: string;
  parserVersion: string;
  horizonSec: number;
  regimeId: string;
  quoteSource: "bonding-curve" | "jupiter-amm" | "none";
  action: "ENTER" | "POLICY_SKIP" | "CAPACITY_SKIP";
  execStage: "executable" | "missing-quote" | "not-entered";
  exitAt?: number;
  exitReason?: string;
  skipReason?: string;
  missingReason?: string;
  netExecutablePnlSol: number | null;
}

/** One JSONL line containing the complete paired decision; avoids crash-created half sets. */
export interface ArmResultSet {
  recordType: "ARM_RESULT_SET";
  armSetId: string;
  decisionId: string;
  results: ArmResult[];
}

export function expandArmResultSets(rows: unknown[]): unknown[] {
  const expanded: unknown[] = [];
  for (const row of rows) {
    const set = row as Partial<ArmResultSet>;
    if (set.recordType !== "ARM_RESULT_SET") {
      expanded.push(row);
      continue;
    }
    if (!set.armSetId || !set.decisionId || !Array.isArray(set.results)) {
      expanded.push({ recordType: "INVALID_ARM_RESULT_SET" });
      continue;
    }
    for (const result of set.results) {
      if (result.armSetId !== set.armSetId || result.decisionId !== set.decisionId) {
        expanded.push({ recordType: "INVALID_ARM_RESULT_SET_IDENTITY" });
      } else {
        expanded.push(result);
      }
    }
  }
  return expanded;
}

export interface PairedValidation {
  ok: boolean;
  errors: string[];
  pairs: Map<string, Map<string, ArmResult>>;
  policiesByArm: Map<string, string>;
  exitPolicyId?: string;
  executionPolicyId?: string;
  armSpecHash?: string;
  implementationHash?: string;
  parserVersion?: string;
  horizonSec?: number;
  measurementEpoch?: string;
}

/**
 * Regimes whose quote/fill units are validated for the primary SOL-denominated experiment.
 *
 * GRADUATED_AMM is deliberately NOT here. PaperTrader's graduation handling (trader.ts
 * ~line 1015-1040) is the stronger of two designs we considered — it takes a REAL Jupiter sell
 * quote for our exact tokenQty at the moment of graduation and reconstructs a synthetic
 * constant-product model from it, rather than naively replaying reserve deltas across the
 * graduation boundary (which would be wrong: the bonding-curve account zeroes/freezes at
 * completion, so a delta computed across that boundary is an artifact, not a real reserve move).
 * But "the mechanism is sound" is not the same claim as "continuity through graduation is
 * proven" — PROFITABILITY_TODO.md's own P0 list still has this unchecked:
 *   "[ ] Prove/implement continuity of that counterfactual impact through graduation into the
 *   synthetic Jupiter AMM state; do not assume mainnet migration included our paper trades."
 * Until that item is checked, GRADUATED_AMM results must not be pooled into a profitability
 * conclusion — so it stays excluded here even though ArmExitSimulation and arm-spec.ts's
 * (separate, frozen, pre-registration-only) `primaryRegimes` list both already target it as a
 * regime the experiment RUNS in. Running in a regime and trusting its data for inference are
 * different bars; this constant is the second one.
 */
export const PRIMARY_INFERENCE_REGIMES = new Set(["PUMP_CURVE_V1"]);
/** Explicitly routed but excluded regimes are retained as coverage/skip evidence, never pooled. */
export const EXCLUDED_INFERENCE_REGIMES = new Set(["PUMP_CURVE_MAYHEM", "NON_SOL_QUOTE", "USD_QUOTE", "GRADUATED_AMM"]);
export function isPrimaryInferenceRegime(regimeId: string): boolean {
  return PRIMARY_INFERENCE_REGIMES.has(regimeId);
}

export function validatePairedArmResults(rows: unknown[], requiredArms: string[]): PairedValidation {
  const errors: string[] = [];
  const pairs = new Map<string, Map<string, ArmResult>>();
  const required = [...new Set(requiredArms)].sort();
  if (required.length < 2) errors.push("need at least two distinct required arms");

  const policiesByArm = new Map<string, string>();
  let exitPolicyId: string | undefined;
  let executionPolicyId: string | undefined;
  let armSpecHash: string | undefined;
  let implementationHash: string | undefined;
  let parserVersion: string | undefined;
  let horizonSec: number | undefined;
  let measurementEpoch: string | undefined;

  for (const [i, raw] of rows.entries()) {
    const r = raw as Partial<ArmResult>;
    const prefix = `row ${i + 1}`;
    if (r.recordType !== "ARM_RESULT" || r.source !== "interleaved-paper" || r.counterfactualComplete !== true) {
      errors.push(`${prefix}: not a complete interleaved ARM_RESULT`);
      continue;
    }
    if (
      !r.measurementEpoch || !r.decisionId || !r.mint || !r.armSetId || !r.armId
      || !r.armSpecHash || !r.implementationHash || !r.policyId || !r.exitPolicyId || !r.executionPolicyId
      || !r.parserVersion || !r.quoteSource
    ) {
      errors.push(`${prefix}: missing identity/policy fields`);
      continue;
    }
    if (
      !r.regimeId
      || (!PRIMARY_INFERENCE_REGIMES.has(r.regimeId) && !EXCLUDED_INFERENCE_REGIMES.has(r.regimeId))
    ) errors.push(`${prefix}: unclassified regime`);
    if (r.action === "ENTER") {
      if (r.execStage === "executable") {
        if (!Number.isFinite(r.netExecutablePnlSol)) errors.push(`${prefix}: invalid executable P&L`);
      } else if (r.execStage === "missing-quote") {
        if (r.netExecutablePnlSol !== null) errors.push(`${prefix}: missing quote must have null P&L`);
        if (!r.missingReason) errors.push(`${prefix}: missing quote lacks missingReason`);
      } else {
        errors.push(`${prefix}: entered result has invalid execution stage`);
      }
    } else if (r.action === "POLICY_SKIP" || r.action === "CAPACITY_SKIP") {
      if (r.execStage !== "not-entered") errors.push(`${prefix}: skipped result has an execution stage`);
      if (r.netExecutablePnlSol !== 0) errors.push(`${prefix}: skipped result must have zero P&L`);
      if (!r.skipReason) errors.push(`${prefix}: skipped result lacks skipReason`);
    } else {
      errors.push(`${prefix}: invalid arm action`);
    }
    if (!(Number.isFinite(r.horizonSec) && r.horizonSec! > 0)) errors.push(`${prefix}: invalid fixed horizon`);

    const priorPolicy = policiesByArm.get(r.armId);
    if (priorPolicy && priorPolicy !== r.policyId) errors.push(`${prefix}: arm ${r.armId} changed policyId`);
    else policiesByArm.set(r.armId, r.policyId);
    exitPolicyId ??= r.exitPolicyId;
    executionPolicyId ??= r.executionPolicyId;
    armSpecHash ??= r.armSpecHash;
    implementationHash ??= r.implementationHash;
    parserVersion ??= r.parserVersion;
    horizonSec ??= r.horizonSec;
    measurementEpoch ??= r.measurementEpoch;
    if (r.exitPolicyId !== exitPolicyId) errors.push(`${prefix}: mixed exit policy`);
    if (r.executionPolicyId !== executionPolicyId) errors.push(`${prefix}: mixed execution policy`);
    if (r.armSpecHash !== armSpecHash) errors.push(`${prefix}: mixed arm specification`);
    if (r.implementationHash !== implementationHash) errors.push(`${prefix}: mixed implementation`);
    if (r.parserVersion !== parserVersion) errors.push(`${prefix}: mixed parser version`);
    if (r.horizonSec !== horizonSec) errors.push(`${prefix}: mixed horizon`);
    if (r.measurementEpoch !== measurementEpoch) errors.push(`${prefix}: mixed measurement epoch`);

    const key = `${r.armSetId}:${r.decisionId}`;
    const armMap = pairs.get(key) ?? new Map<string, ArmResult>();
    if (armMap.has(r.armId)) errors.push(`${prefix}: duplicate arm ${r.armId} for ${key}`);
    else armMap.set(r.armId, r as ArmResult);
    pairs.set(key, armMap);
  }

  for (const [key, armMap] of pairs) {
    const missing = required.filter((arm) => !armMap.has(arm));
    if (missing.length) errors.push(`${key}: missing paired arms ${missing.join(",")}`);
    const mints = new Set([...armMap.values()].map((r) => r.mint));
    if (mints.size > 1) errors.push(`${key}: arms do not reference the same mint`);
    const regimes = new Set([...armMap.values()].map((r) => r.regimeId));
    if (regimes.size > 1) errors.push(`${key}: arms do not reference the same market regime`);
    const quoteSources = new Set([...armMap.values()].map((r) => r.quoteSource));
    if (quoteSources.size > 1) errors.push(`${key}: arms do not reference the same quote source`);
  }

  if (!rows.length) errors.push("no arm-result rows");
  if (!pairs.size) errors.push("no valid paired decisions");
  return {
    ok: errors.length === 0,
    errors,
    pairs,
    policiesByArm,
    exitPolicyId,
    executionPolicyId,
    armSpecHash,
    implementationHash,
    parserVersion,
    horizonSec,
    measurementEpoch,
  };
}
