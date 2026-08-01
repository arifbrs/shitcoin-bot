/**
 * Profitability evaluator for future interleaved arm output.
 *
 * Until `logs/arm-results-*.jsonl` contains complete paired ARM_RESULT rows, this command exits
 * non-zero with a refusal. It never treats selected paper CLOSE rows or sparse observatory paths
 * as counterfactual evidence.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { expandArmResultSets, isPrimaryInferenceRegime, validatePairedArmResults, type ArmResult } from "./analysis/profit-contract.js";

const requiredArms = (process.env.ARM_IDS ?? "A,B,C").split(",").map((x) => x.trim()).filter(Boolean);
const files = existsSync(config.logDir)
  ? readdirSync(config.logDir).filter((f) => f.startsWith("arm-results-") && f.endsWith(".jsonl"))
  : [];
const rows: unknown[] = [];
for (const file of files) {
  for (const line of readFileSync(join(config.logDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { rows.push({ parseError: true, file }); }
  }
}

const validation = validatePairedArmResults(expandArmResultSets(rows), requiredArms);
if (!validation.ok) {
  console.error("REFUSED: profitability conclusion is not identifiable yet.");
  for (const err of validation.errors.slice(0, 50)) console.error(`- ${err}`);
  console.error("Required evidence: complete interleaved-paper ARM_RESULT rows for the same decision, fixed policy/horizon, recognized regime, and executable P&L.");
  process.exitCode = 2;
} else {
  const complete = [...validation.pairs.values()]
    .filter((m) => requiredArms.every((arm) => m.has(arm)));
  const primary = complete.filter((m) => {
    const regimes = new Set([...m.values()].map((r) => r.regimeId));
    return regimes.size === 1 && isPrimaryInferenceRegime([...regimes][0]!);
  });
  const excludedByRegime: Record<string, number> = {};
  for (const pair of complete) {
    const regime = [...new Set([...pair.values()].map((r) => r.regimeId))][0] ?? "UNKNOWN_REGIME";
    if (!isPrimaryInferenceRegime(regime)) excludedByRegime[regime] = (excludedByRegime[regime] ?? 0) + 1;
  }
  if (!primary.length) {
    console.error("REFUSED: no complete paired decisions remain in a primary inference regime.");
    console.error(JSON.stringify({ excludedByRegime }));
    process.exitCode = 2;
  } else {
  const missingQuotePairs = primary.filter((pair) =>
    [...pair.values()].some((r) => r.action === "ENTER" && r.execStage === "missing-quote"));
  const evaluable = primary.filter((pair) =>
    [...pair.values()].every((r) => r.action !== "ENTER" || (r.execStage === "executable" && Number.isFinite(r.netExecutablePnlSol))));
  const traded = evaluable.filter((pair) =>
    [...pair.values()].some((r) => r.action === "ENTER" && r.execStage === "executable"));
  if (!traded.length) {
    console.error("REFUSED: no primary-regime pair contains an executable entered arm.");
    console.error(JSON.stringify({
      primaryPairs: primary.length,
      missingQuotePairs: missingQuotePairs.length,
      skipOnlyPairs: evaluable.length,
    }));
    process.exitCode = 2;
  } else {
  const report = requiredArms.map((armId) => {
    const results = traded.map((m) => m.get(armId) as ArmResult);
    const pnl = results.map((r) => r.netExecutablePnlSol as number);
    return {
      armId,
      policyId: validation.policiesByArm.get(armId),
      pairedDecisions: pnl.length,
      entered: results.filter((r) => r.action === "ENTER").length,
      policySkips: results.filter((r) => r.action === "POLICY_SKIP").length,
      capacitySkips: results.filter((r) => r.action === "CAPACITY_SKIP").length,
      expectancySol: pnl.reduce((a, b) => a + b, 0) / pnl.length,
      totalPnlSol: pnl.reduce((a, b) => a + b, 0),
    };
  });
  console.log(JSON.stringify({
    status: "DESCRIPTIVE_ONLY",
    note: "Paired bootstrap by decision plus time/creator blocking is still required before inference.",
    measurementEpoch: validation.measurementEpoch,
    armSpecHash: validation.armSpecHash,
    implementationHash: validation.implementationHash,
    exitPolicyId: validation.exitPolicyId,
    executionPolicyId: validation.executionPolicyId,
    parserVersion: validation.parserVersion,
    horizonSec: validation.horizonSec,
    primaryPairs: primary.length,
    evaluablePairs: traded.length,
    missingQuotePairs: missingQuotePairs.length,
    skipOnlyPairs: evaluable.length - traded.length,
    evaluablePct: Number((traded.length / primary.length * 100).toFixed(2)),
    excludedByRegime,
    report,
  }, null, 2));
  }
  }
}
