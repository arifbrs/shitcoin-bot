import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { OKX_STRICT_EPOCH, verifyStrictLedger, type StrictLedgerRecord } from "./discovery/okx-strict-ledger.js";

type Row = StrictLedgerRecord & Record<string, unknown>;

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number | null, digits = 3): number | null {
  return value == null ? null : Number(value.toFixed(digits));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values: number[], pct: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * pct) - 1))] ?? null;
}

export interface ExitSummary {
  policyVersion: number;
  source: string;
  lane: string;
  eligibility: "live-eligible" | "paper-only";
  horizonSec: number;
  observations: number;
  built: number;
  routeFailures: number;
  wins: number;
  winRatePct: number | null;
  medianPnlPct: number | null;
  meanPnlPct: number | null;
  totalPnlSol: number;
  medianBuildMs: number | null;
}

export interface ScalpSummary {
  policyVersion: number;
  source: string;
  lane: string;
  eligibility: "live-eligible" | "paper-only";
  observations: number;
  built: number;
  routeFailures: number;
  wins: number;
  winRatePct: number | null;
  medianPnlPct: number | null;
  meanPnlPct: number | null;
  totalPnlSol: number;
  triggerCounts: Record<string, number>;
  medianExecutionDelayMs: number | null;
  medianTriggerToExecutionGapPct: number | null;
}

function lane(row: Row): string {
  const source = typeof row.source === "string" ? row.source : "unknown";
  const sourceKey = typeof row.sourceKey === "string" ? row.sourceKey : "";
  return source === "scanner" && sourceKey.startsWith("toplist:") ? "toplist" : source;
}

function policyVersion(row: Row): number {
  return typeof row.policyVersion === "number" && Number.isInteger(row.policyVersion) ? row.policyVersion : 3;
}

export function strictPaperReport(records: readonly Row[]): Record<string, unknown> {
  // Old rows predate per-position tagging. Infer their cohort from the most recent RUN_START;
  // explicit position tags still win so a v3 position settling during a v4 run stays v3.
  const inferredPolicy = new Map<Row, number>();
  let activePolicyVersion = 3;
  for (const row of records) {
    if (row.type === "RUN_START" && typeof row.policyVersion === "number" && Number.isInteger(row.policyVersion)) {
      activePolicyVersion = row.policyVersion;
    }
    inferredPolicy.set(row, typeof row.policyVersion === "number" && Number.isInteger(row.policyVersion)
      ? row.policyVersion : activePolicyVersion);
  }
  const rowPolicyVersion = (row: Row) => inferredPolicy.get(row) ?? policyVersion(row);
  const accepted = records.filter((row) => row.type === "CANDIDATE_ACCEPTED");
  const opens = records.filter((row) => row.type === "POSITION_OPEN");
  const exits = records.filter((row) => row.type === "POSITION_EXIT");
  const scalpExits = records.filter((row) => row.type === "SCALP_EXIT");
  const closed = records.filter((row) => row.type === "POSITION_CLOSED");
  const terminal = records.filter((row) => row.type === "CANDIDATE_TERMINAL");
  const terminalCounts: Record<string, number> = {};
  for (const row of terminal) {
    const status = typeof row.status === "string" ? row.status : "UNKNOWN";
    terminalCounts[status] = (terminalCounts[status] ?? 0) + 1;
  }

  const openedIds = new Set(opens.map((row) => String(row.paperId ?? "")));
  const terminalIds = new Set(terminal.map((row) => String(row.paperId ?? "")));
  const pendingAccepted = accepted.filter((row) => {
    const id = String(row.paperId ?? "");
    return !openedIds.has(id) && !terminalIds.has(id);
  }).length;

  const groups = new Map<string, Row[]>();
  for (const row of exits) {
    const source = typeof row.source === "string" ? row.source : "unknown";
    const horizon = number(row.horizonSec);
    if (horizon == null) continue;
    const eligibility = row.liveEligible === true ? "live-eligible" : "paper-only";
    const key = JSON.stringify([rowPolicyVersion(row), source, lane(row), eligibility, horizon]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const exitSummary: ExitSummary[] = [...groups.entries()].map(([key, rows]) => {
    const [version, source, discoveryLane, eligibility, horizon] = JSON.parse(key) as [number, string, string, "live-eligible" | "paper-only", number];
    const built = rows.filter((row) => row.status === "BUILT");
    // EXIT_NO_ROUTE is a real outcome, not missing data. settle() records it as -100%; excluding
    // it here would create survivor bias and make an unsellable shitcoin disappear from PnL.
    const pnls = rows.map((row) => number(row.pnlPct)).filter((v): v is number => v !== null);
    const pnlLamports = rows.map((row) => number(row.pnlLamports)).filter((v): v is number => v !== null);
    const buildMs = built.map((row) => number(row.buildMs)).filter((v): v is number => v !== null);
    return {
      policyVersion: version, source, lane: discoveryLane, eligibility, horizonSec: horizon, observations: rows.length, built: built.length,
      routeFailures: rows.length - built.length, wins: pnls.filter((v) => v > 0).length,
      winRatePct: round(pnls.length ? pnls.filter((v) => v > 0).length / pnls.length * 100 : null, 2),
      medianPnlPct: round(median(pnls)),
      meanPnlPct: round(pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : null),
      totalPnlSol: round(pnlLamports.reduce((sum, value) => sum + value, 0) / 1e9, 9) ?? 0,
      medianBuildMs: round(median(buildMs), 1),
    };
  }).sort((a, b) => a.policyVersion - b.policyVersion || a.horizonSec - b.horizonSec || a.lane.localeCompare(b.lane) || a.eligibility.localeCompare(b.eligibility));

  const scalpGroups = new Map<string, Row[]>();
  for (const row of scalpExits) {
    const source = typeof row.source === "string" ? row.source : "unknown";
    const eligibility = row.liveEligible === true ? "live-eligible" : "paper-only";
    const key = JSON.stringify([rowPolicyVersion(row), source, lane(row), eligibility]);
    const group = scalpGroups.get(key) ?? [];
    group.push(row);
    scalpGroups.set(key, group);
  }
  const scalpSummary: ScalpSummary[] = [...scalpGroups.entries()].map(([key, rows]) => {
    const [version, source, discoveryLane, eligibility] = JSON.parse(key) as
      [number, string, string, "live-eligible" | "paper-only"];
    const built = rows.filter((row) => row.status === "BUILT");
    // SCALP_EXIT is already the post-delay execution build. Trigger quotes are deliberately absent
    // from PnL so a fleeting TP cannot be counted as a fill.
    const pnls = rows.map((row) => number(row.pnlPct)).filter((v): v is number => v !== null);
    const pnlLamports = rows.map((row) => number(row.pnlLamports)).filter((v): v is number => v !== null);
    const executionDelay = rows.map((row) => number(row.executionDelayMs)).filter((v): v is number => v !== null);
    const executionGaps = rows.map((row) => number(row.triggerToExecutionGapPct)).filter((v): v is number => v !== null);
    const triggerCounts: Record<string, number> = {};
    for (const row of rows) {
      const reason = typeof row.triggerReason === "string" ? row.triggerReason : "UNKNOWN";
      triggerCounts[reason] = (triggerCounts[reason] ?? 0) + 1;
    }
    return {
      policyVersion: version, source, lane: discoveryLane, eligibility,
      observations: rows.length, built: built.length, routeFailures: rows.length - built.length,
      wins: pnls.filter((v) => v > 0).length,
      winRatePct: round(pnls.length ? pnls.filter((v) => v > 0).length / pnls.length * 100 : null, 2),
      medianPnlPct: round(median(pnls)),
      meanPnlPct: round(pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : null),
      totalPnlSol: round(pnlLamports.reduce((sum, value) => sum + value, 0) / 1e9, 9) ?? 0,
      triggerCounts,
      medianExecutionDelayMs: round(median(executionDelay), 1),
      medianTriggerToExecutionGapPct: round(median(executionGaps)),
    };
  }).sort((a, b) => a.policyVersion - b.policyVersion || a.lane.localeCompare(b.lane)
    || a.eligibility.localeCompare(b.eligibility));

  const entryBreakdown: Record<string, number> = {};
  for (const row of opens) {
    const key = `v${rowPolicyVersion(row)}:${lane(row)}:${row.liveEligible === true ? "live-eligible" : "paper-only"}`;
    entryBreakdown[key] = (entryBreakdown[key] ?? 0) + 1;
  }

  const latencyGroups = new Map<string, Row[]>();
  for (const row of opens) {
    const eligibility = row.liveEligible === true ? "live-eligible" : "paper-only";
    const key = JSON.stringify([rowPolicyVersion(row), lane(row), eligibility]);
    const group = latencyGroups.get(key) ?? [];
    group.push(row);
    latencyGroups.set(key, group);
  }
  const entryLatencySummary = [...latencyGroups.entries()].map(([key, rows]) => {
    const [version, discoveryLane, eligibility] = JSON.parse(key) as
      [number, string, "live-eligible" | "paper-only"];
    const entries = rows.map((row) => row.entry).filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object");
    const detectToBuild = entries.map((entry) => number(entry.detectToBuildMs)).filter((v): v is number => v !== null);
    const buyBuild = entries.map((entry) => number(entry.buildMs)).filter((v): v is number => v !== null);
    return {
      policyVersion: version, lane: discoveryLane, eligibility, observations: rows.length,
      medianDetectToBuildMs: round(median(detectToBuild), 1),
      p95DetectToBuildMs: round(percentile(detectToBuild, 0.95), 1),
      medianBuyBuildMs: round(median(buyBuild), 1),
    };
  }).sort((a, b) => a.policyVersion - b.policyVersion || a.lane.localeCompare(b.lane));

  const resolvedByPaperId = new Map<string, Row>();
  for (const row of [...terminal, ...opens].sort((a, b) => a.seq - b.seq)) {
    const id = typeof row.paperId === "string" ? row.paperId : null;
    if (id && !resolvedByPaperId.has(id)) resolvedByPaperId.set(id, row);
  }
  const decisionLatencyGroups = new Map<string, number[]>();
  for (const row of accepted) {
    const id = typeof row.paperId === "string" ? row.paperId : null;
    const detectedAt = number(row.detectedAt);
    const resolved = id ? resolvedByPaperId.get(id) : null;
    const resolvedAt = resolved && typeof resolved.ts === "string" ? Date.parse(resolved.ts) : NaN;
    if (detectedAt == null || !Number.isFinite(resolvedAt) || resolvedAt < detectedAt) continue;
    const key = JSON.stringify([rowPolicyVersion(row), lane(row)]);
    const group = decisionLatencyGroups.get(key) ?? [];
    group.push(resolvedAt - detectedAt);
    decisionLatencyGroups.set(key, group);
  }
  const candidateDecisionLatency = [...decisionLatencyGroups.entries()].map(([key, values]) => {
    const [version, discoveryLane] = JSON.parse(key) as [number, string];
    return { policyVersion: version, lane: discoveryLane, observations: values.length,
      medianDecisionMs: round(median(values), 1), p95DecisionMs: round(percentile(values, 0.95), 1) };
  }).sort((a, b) => a.policyVersion - b.policyVersion || a.lane.localeCompare(b.lane));

  const rankingCycles = records.filter((row) => row.type === "RANKING_CYCLE");
  const rankingCycleGroups = new Map<number, Row[]>();
  for (const row of rankingCycles) {
    const version = rowPolicyVersion(row);
    const group = rankingCycleGroups.get(version) ?? [];
    group.push(row);
    rankingCycleGroups.set(version, group);
  }
  const rankingThroughput = [...rankingCycleGroups.entries()].map(([version, rows]) => {
    const sum = (key: string) => rows.reduce((total, row) => total + (number(row[key]) ?? 0), 0);
    const apiMs = rows.map((row) => number(row.apiMs)).filter((v): v is number => v !== null);
    const timestamps = rows.map((row) => typeof row.ts === "string" ? Date.parse(row.ts) : NaN)
      .filter(Number.isFinite).sort((a, b) => a - b);
    const observedMs = timestamps.length > 1 ? timestamps.at(-1)! - timestamps[0]! : null;
    return {
      policyVersion: version, cycles: rows.length,
      evaluatedSnapshots: sum("evaluated"), transientFilteredSnapshots: sum("transientFiltered"),
      expired: sum("expired"), accepted: sum("accepted"), filterChanges: sum("filterChanges"),
      medianApiMs: round(median(apiMs), 1),
      observedCallsPerHour: observedMs && observedMs > 0
        ? round((rows.length - 1) / observedMs * 3_600_000, 1) : null,
      configuredPollMs: number(rows.at(-1)?.pollMs), configuredRecheckMs: number(rows.at(-1)?.recheckMs),
    };
  }).sort((a, b) => a.policyVersion - b.policyVersion);

  const policyCohorts = [...new Set([...accepted, ...opens, ...terminal, ...exits, ...scalpExits].map(rowPolicyVersion))]
    .sort((a, b) => a - b)
    .map((version) => ({
      policyVersion: version,
      accepted: accepted.filter((row) => rowPolicyVersion(row) === version).length,
      opened: opens.filter((row) => rowPolicyVersion(row) === version).length,
      rejectedOrFailed: terminal.filter((row) => rowPolicyVersion(row) === version).length,
      exitObservations: exits.filter((row) => rowPolicyVersion(row) === version).length,
      scalpExits: scalpExits.filter((row) => rowPolicyVersion(row) === version).length,
    }));

  const graduationRows = scalpExits.filter((row) => rowPolicyVersion(row) === 6
    && row.source === "scanner" && lane(row) === "toplist" && row.liveEligible === true);
  const graduationPnls = graduationRows.map((row) => number(row.pnlPct)).filter((v): v is number => v !== null);
  const graduationPnlLamports = graduationRows.map((row) => number(row.pnlLamports)).filter((v): v is number => v !== null);
  const graduationMean = mean(graduationPnls);
  const sampleVariance = graduationPnls.length > 1 && graduationMean != null
    ? graduationPnls.reduce((sum, value) => sum + (value - graduationMean) ** 2, 0) / (graduationPnls.length - 1)
    : null;
  const lower95MeanPnlPct = sampleVariance == null || graduationMean == null
    ? null : graduationMean - 1.96 * Math.sqrt(sampleVariance / graduationPnls.length);
  const recentWindow = graduationPnls.slice(-30);
  const recentMeanPnlPct = mean(recentWindow);
  const routeFailurePct = graduationRows.length
    ? graduationRows.filter((row) => row.status !== "BUILT").length / graduationRows.length * 100 : null;
  const graduationRequirements = {
    minimumSample: graduationRows.length >= 100,
    completePnl: graduationPnls.length === graduationRows.length,
    positiveTotalPnl: graduationPnlLamports.reduce((sum, value) => sum + value, 0) > 0,
    positive95LowerMean: lower95MeanPnlPct != null && lower95MeanPnlPct > 0,
    recent30Positive: recentWindow.length === 30 && (recentMeanPnlPct ?? 0) > 0,
    routeFailureAtMost5Pct: routeFailurePct != null && routeFailurePct <= 5,
  };
  const graduationPassed = Object.values(graduationRequirements).every(Boolean);
  const purchaseReadiness = {
    purpose: "PAID_WEBSOCKET_LATENCY_AB_ONLY",
    scope: "v6 fast-recheck toplist live-eligible post-delay scalp fills",
    status: graduationRows.length < 100 ? "WAITING_FOR_SAMPLE"
      : graduationPassed ? "READY_FOR_PAID_WEBSOCKET_AB" : "EDGE_NOT_PROVEN",
    passed: graduationPassed,
    observations: graduationRows.length,
    minimumObservations: 100,
    totalPnlSol: round(graduationPnlLamports.reduce((sum, value) => sum + value, 0) / 1e9, 9) ?? 0,
    meanPnlPct: round(graduationMean),
    medianPnlPct: round(median(graduationPnls)),
    lower95MeanPnlPct: round(lower95MeanPnlPct),
    recent30MeanPnlPct: round(recentMeanPnlPct),
    routeFailurePct: round(routeFailurePct, 2),
    requirements: graduationRequirements,
    disclaimer: "Passing permits a paid WebSocket A/B test, not live-money trading or guaranteed profit.",
  };

  const latestStatus = [...records].reverse().find((row) => row.type === "STATUS") ?? null;
  return {
    epoch: records[0]?.epoch ?? OKX_STRICT_EPOCH,
    generatedAt: new Date().toISOString(),
    ledgerRecords: records.length,
    firstRecordAt: records[0]?.ts ?? null,
    lastRecordAt: records.at(-1)?.ts ?? null,
    candidateFunnel: {
      accepted: accepted.length,
      opened: opens.length,
      pendingAccepted,
      rejectedOrFailed: terminal.length,
      terminalCounts,
    },
    positions: {
      opened: opens.length,
      liveEligibleOpened: opens.filter((row) => row.liveEligible === true).length,
      paperOnlyOpened: opens.filter((row) => row.liveEligible !== true).length,
      allHorizonsObserved: closed.length,
      exitObservations: exits.length,
      scalpExitObservations: scalpExits.length,
      entryBreakdown,
    },
    entryLatencySummary,
    candidateDecisionLatency,
    rankingThroughput,
    policyCohorts,
    purchaseReadiness,
    latestStatus,
    exitSummary,
    scalpSummary,
  };
}

function runCli(): void {
  const legacy = process.argv.includes("--v1");
  const expectedEpoch = legacy ? "OKX-STRICT-PAPER-V1" : OKX_STRICT_EPOCH;
  const path = join(config.logDir, legacy ? "okx-strict-paper-v1.jsonl" : "okx-strict-paper-v2.jsonl");
  const verified = verifyStrictLedger(path, expectedEpoch);
  if (!verified.ok) {
    console.error(`OKX strict paper report REFUSED: ${verified.error}`);
    process.exitCode = 2;
    return;
  }
  const report = strictPaperReport(verified.records);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ledgerIntegrity: "OK", ...report }, null, 2));
    return;
  }
  const funnel = report.candidateFunnel as Record<string, unknown>;
  const positions = report.positions as Record<string, unknown>;
  console.log(`${report.epoch} · ledger integrity OK · ${report.ledgerRecords} records`);
  console.log(`Candidates: accepted=${funnel.accepted} opened=${funnel.opened} pending=${funnel.pendingAccepted} rejected/failed=${funnel.rejectedOrFailed}`);
  console.log(`Positions: opened=${positions.opened} live-eligible=${positions.liveEligibleOpened} paper-only=${positions.paperOnlyOpened} all-horizons-observed=${positions.allHorizonsObserved} fixed-exits=${positions.exitObservations} scalp-fills=${positions.scalpExitObservations}`);
  console.table(report.policyCohorts as Array<Record<string, unknown>>);
  console.log("Paid WebSocket gate:", report.purchaseReadiness);
  const latencyTable = report.entryLatencySummary as Array<Record<string, unknown>>;
  if (latencyTable.length) console.table(latencyTable);
  const decisionLatencyTable = report.candidateDecisionLatency as Array<Record<string, unknown>>;
  if (decisionLatencyTable.length) console.table(decisionLatencyTable);
  const throughputTable = report.rankingThroughput as Array<Record<string, unknown>>;
  if (throughputTable.length) console.table(throughputTable);
  const scalpTable = report.scalpSummary as ScalpSummary[];
  if (scalpTable.length) {
    console.log("Adaptive scalp (post-delay execution builds):");
    console.table(scalpTable);
  } else console.log("No adaptive scalp fills yet.");
  const table = report.exitSummary as ExitSummary[];
  if (table.length) {
    console.log("Fixed-horizon diagnostics:");
    console.table(table);
  }
  else console.log("No settled exit observations yet.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
