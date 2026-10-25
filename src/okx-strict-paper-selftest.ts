import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rawInteger, strictExitMath, strictPaperId, strictRankingDisposition, strictRankingPolicy,
  strictRiskAccepted, strictScalpDecision,
  strictValueLagPolicy,
} from "./discovery/okx-strict-paper-core.js";
import { StrictLedger, verifyStrictLedger } from "./discovery/okx-strict-ledger.js";
import { strictPaperReport } from "./okx-strict-paper-report.js";

assert.deepEqual(strictExitMath(30_010_000, 36_000_000, 20_000), {
  netSolLamports: 35_980_000,
  pnlLamports: 5_970_000,
  pnlPct: 5_970_000 / 30_010_000 * 100,
});
assert.deepEqual(strictExitMath(30_010_000, 10_000, 20_000), {
  netSolLamports: 0,
  pnlLamports: -30_010_000,
  pnlPct: -100,
});
assert.throws(() => strictExitMath(0, 1, 1));
assert.equal(rawInteger("1"), "1");
assert.equal(rawInteger("0"), null);
assert.equal(rawInteger("1.2"), null);
assert.equal(strictPaperId("scanner", "abc"), strictPaperId("scanner", "abc"));
assert.notEqual(strictPaperId("scanner", "abc"), strictPaperId("signal", "abc"));
assert.deepEqual(strictValueLagPolicy({ valueUsd: 0.00010488, minUsd: 100, valueLabel: "VALUE_USD",
  sourceTs: 10_000, detectedAt: 20_000, maxLagMs: 90_000 }), ["VALUE_USD<100"]);
assert.deepEqual(strictValueLagPolicy({ valueUsd: 500, minUsd: 500, valueLabel: "AMOUNT_USD",
  sourceTs: 10_000, detectedAt: 100_001, maxLagMs: 90_000 }), ["SOURCE_LAG_MS>90000"]);
assert.deepEqual(strictRankingPolicy({ firstTradeAt: 10_000, detectedAt: 70_000, maxAgeMs: 900_000,
  liquidityUsd: 20_000, minLiquidityUsd: 20_000, volumeUsd: 25_000, minVolumeUsd: 20_000,
  marketCapUsd: 250_000, maxMarketCapUsd: 250_000,
  holders: 100, minHolders: 100, buys: 60, sells: 40, minTransactions: 100, minBuyRatio: 0.5 }), []);
assert.deepEqual(strictRankingPolicy({ firstTradeAt: 10_000, detectedAt: 1_000_001, maxAgeMs: 900_000,
  liquidityUsd: 19_999, minLiquidityUsd: 20_000, volumeUsd: 19_999, minVolumeUsd: 20_000,
  marketCapUsd: 250_001, maxMarketCapUsd: 250_000,
  holders: 99, minHolders: 100, buys: 40, sells: 60, minTransactions: 100, minBuyRatio: 0.5 }), [
  "TOKEN_AGE_MS>900000", "LIQUIDITY_USD<20000", "VOLUME_USD<20000", "MARKET_CAP_USD>250000", "HOLDERS<100", "BUY_RATIO<0.5",
]);
assert.equal(strictRankingDisposition([], 300_000), "ACCEPT");
assert.equal(strictRankingDisposition(["VOLUME_USD<20000", "HOLDERS<100"], 300_000), "RECHECK");
assert.equal(strictRankingDisposition(["TOKEN_AGE_MS>300000", "VOLUME_USD<20000"], 300_000), "FINAL");
assert.equal(strictRiskAccepted("CLEAN", false), true);
assert.equal(strictRiskAccepted("UNKNOWN", false), false);
assert.equal(strictRiskAccepted("UNKNOWN", true), true);
assert.equal(strictRiskAccepted("TOXIC", true), false);
assert.equal(strictScalpDecision({ pnlPct: 5, ageMs: 5_000, takeProfitPct: 5,
  hardStopPct: -8, maxHoldMs: 60_000 }), "TAKE_PROFIT");
assert.equal(strictScalpDecision({ pnlPct: -8, ageMs: 5_000, takeProfitPct: 5,
  hardStopPct: -8, maxHoldMs: 60_000 }), "HARD_STOP");
assert.equal(strictScalpDecision({ pnlPct: 0, ageMs: 60_000, takeProfitPct: 5,
  hardStopPct: -8, maxHoldMs: 60_000 }), "MAX_HOLD");
assert.equal(strictScalpDecision({ pnlPct: 0, ageMs: 59_999, takeProfitPct: 5,
  hardStopPct: -8, maxHoldMs: 60_000 }), null);
assert.throws(() => strictScalpDecision({ pnlPct: Number.NaN, ageMs: 0, takeProfitPct: 5,
  hardStopPct: -8, maxHoldMs: 60_000 }));

const noRouteReport = strictPaperReport([
  { type: "POSITION_OPEN", paperId: "p1", source: "scanner", sourceKey: "toplist:mint", liveEligible: false, policyVersion: 4 },
  { type: "POSITION_EXIT", paperId: "p1", source: "scanner", sourceKey: "toplist:mint", liveEligible: false,
    policyVersion: 4, horizonSec: 60, status: "EXIT_NO_ROUTE", pnlPct: -100, pnlLamports: -100_000_000, buildMs: null },
] as never[]);
const noRouteSummary = (noRouteReport.exitSummary as Array<Record<string, unknown>>)[0]!;
assert.equal(noRouteSummary.routeFailures, 1);
assert.equal(noRouteSummary.policyVersion, 4);
assert.equal(noRouteSummary.meanPnlPct, -100, "an unsellable position must remain a full loss in aggregate PnL");
assert.equal(noRouteSummary.totalPnlSol, -0.1);
assert.deepEqual(noRouteReport.policyCohorts, [{ policyVersion: 4, accepted: 0, opened: 1,
  rejectedOrFailed: 0, exitObservations: 1, scalpExits: 0 }]);

const scalpNoRouteReport = strictPaperReport([
  { type: "POSITION_OPEN", paperId: "p6", source: "scanner", sourceKey: "toplist:v6:mint6",
    liveEligible: true, policyVersion: 6 },
  { type: "SCALP_EXIT", paperId: "p6", source: "scanner", sourceKey: "toplist:v6:mint6",
    liveEligible: true, policyVersion: 6, status: "EXIT_NO_ROUTE", triggerReason: "ROUTE_LOST",
    pnlPct: -100, pnlLamports: -100_000_000, executionDelayMs: 0, triggerToExecutionGapPct: null },
] as never[]);
const scalpNoRouteSummary = (scalpNoRouteReport.scalpSummary as Array<Record<string, unknown>>)[0]!;
assert.equal(scalpNoRouteSummary.routeFailures, 1);
assert.equal(scalpNoRouteSummary.meanPnlPct, -100, "a lost scalp route must remain a full loss");
assert.equal(scalpNoRouteSummary.totalPnlSol, -0.1);
assert.deepEqual(scalpNoRouteSummary.triggerCounts, { ROUTE_LOST: 1 });
const purchaseGate = scalpNoRouteReport.purchaseReadiness as Record<string, unknown>;
assert.equal(purchaseGate.status, "WAITING_FOR_SAMPLE");
assert.equal(purchaseGate.passed, false);
assert.equal(purchaseGate.observations, 1);

const dir = mkdtempSync(join(tmpdir(), "okx-strict-paper-selftest-"));
try {
  const ledger = new StrictLedger(dir);
  ledger.append({ type: "TEST", value: 1 });
  ledger.append({ type: "TEST", value: 2 });
  assert.equal(verifyStrictLedger(ledger.path).ok, true);

  const lines = readFileSync(ledger.path, "utf8").trim().split("\n");
  const tampered = JSON.parse(lines[0]!) as Record<string, unknown>;
  tampered.value = 999;
  lines[0] = JSON.stringify(tampered);
  writeFileSync(ledger.path, `${lines.join("\n")}\n`);
  const result = verifyStrictLedger(ledger.path);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /record hash mismatch/);
  assert.throws(() => new StrictLedger(dir), /not trustworthy/);
} finally {
  // This path is created by mkdtemp under the OS temp directory and cannot target project data.
  rmSync(dir, { recursive: true, force: true });
}

// Paper runtime must not acquire the ability to sign or submit by an innocent-looking import.
const here = fileURLToPath(new URL(".", import.meta.url));
const paperSource = readFileSync(join(here, "okx-strict-paper.ts"), "utf8");
const imports = [...paperSource.matchAll(/^import[\s\S]*?from\s+["']([^"']+)["'];/gm)].map((m) => m[1]);
for (const forbidden of ["execution/wallet", "execution/executor", "broadcast", "signer"]) {
  assert.equal(imports.some((path) => path?.includes(forbidden)), false, `paper runtime imported forbidden module: ${forbidden}`);
}
assert.equal(/poolSendRawTransaction|signSendConfirm|sendTransaction\s*\(/.test(paperSource), false, "paper runtime contains a submit path");

console.log("okx-strict-paper-selftest: OK — math, tamper detection, deterministic IDs, no signing/broadcast imports");
