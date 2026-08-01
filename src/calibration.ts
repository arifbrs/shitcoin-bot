/**
 * STRUCTURAL OUTCOME DIAGNOSTIC.
 *
 * This report describes launch behaviour. It does NOT calibrate trading profit and must never
 * be used to claim edge: a launch can pump then rug and still be profitable for a partial-exit
 * policy, while a surviving token can lose after fees and slippage.
 *
 * Profitability belongs to profit-evaluator.ts and requires complete, paired, interleaved arm
 * results with executable net P&L at a fixed policy and horizon.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "./config.js";
import {
  isStructuralTail,
  structuralOutcome,
  type StructuralOutcome,
} from "./analysis/structural-outcome.js";

const LOG = config.logDir;
const CFG = process.argv[2] ?? configHash;
const CLASSES: StructuralOutcome[] = [
  "PUMP_THEN_RUG",
  "BAD_NO_PUMP",
  "GRADUATED_WIN",
  "WIN_SURVIVED",
  "ORDINARY",
  "UNPRICEABLE",
  "UNKNOWN",
];

interface Rec {
  mint: string;
  verdict?: string;
  conf?: number;
  outcome: string;
  peakGainPct: number;
  ts: number;
  structural: StructuralOutcome;
}

function load(): Rec[] {
  const dirs = CFG === "all"
    ? [LOG, ...readdirSync(LOG).filter((d) => d.startsWith("archive")).map((d) => join(LOG, d))]
    : [LOG];
  const byMint = new Map<string, Rec>();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.startsWith("path") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (!row.obs || !row.summary) continue;
          if (CFG !== "all" && row.cfg !== CFG) continue;
          const base = {
            outcome: String(row.outcome ?? ""),
            peakGainPct: Number(row.peakGainPct ?? 0),
          };
          byMint.set(row.mint, {
            mint: row.mint,
            verdict: row.setupVerdict,
            conf: row.setupConfidence,
            ...base,
            ts: Date.parse(row.ts ?? "") || 0,
            structural: structuralOutcome(base),
          });
        } catch {
          // Historical malformed rows are excluded, never repaired by assumption.
        }
      }
    }
  }
  return [...byMint.values()];
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const rate = (rows: Rec[], pred: (row: Rec) => boolean): number =>
  rows.length ? rows.filter(pred).length / rows.length : Number.NaN;
const showRate = (x: number): string => Number.isFinite(x) ? pct(x) : "n/a";

function classRates(rows: Rec[]): Record<string, string> {
  return Object.fromEntries(CLASSES.map((kind) => [
    kind,
    showRate(rate(rows, (row) => row.structural === kind)),
  ]));
}

function verdictDiagnostic(rows: Rec[]): void {
  console.log(`\n══ 1) MUTUALLY-EXCLUSIVE OUTCOMES — cfg ${CFG} — ${rows.length} launches ══`);
  if (!rows.length) {
    console.log("  No terminal observatory data for this cohort.");
    return;
  }
  const table: object[] = [];
  for (const verdict of ["TOXIC", "CLEAN", "UNKNOWN"]) {
    const group = rows.filter((row) => (row.verdict ?? "UNKNOWN") === verdict);
    if (!group.length) continue;
    const rates = classRates(group);
    table.push({
      verdict,
      n: group.length,
      pumpThenRug: rates.PUMP_THEN_RUG,
      badNoPump: rates.BAD_NO_PUMP,
      graduated: rates.GRADUATED_WIN,
      winSurvived: rates.WIN_SURVIVED,
      ordinary: rates.ORDINARY,
      unpriceable: rates.UNPRICEABLE,
      unknown: rates.UNKNOWN,
      structuralTail: showRate(rate(group, (row) => isStructuralTail(row.structural))),
    });
  }
  console.table(table);
  console.log("  PUMP_THEN_RUG stays separate because it may be valuable to a partial-exit policy.");
}

function temporalStability(rows: Rec[]): void {
  console.log("\n══ 2) TEMPORAL STABILITY — older 70% vs newer 30% ══");
  const dated = rows.filter((row) => row.ts > 0).sort((a, b) => a.ts - b.ts);
  if (dated.length < 20) {
    console.log(`  Need ≥20 dated launches; have ${dated.length}.`);
    return;
  }
  const cut = Math.floor(dated.length * 0.7);
  const olderRows = dated.slice(0, cut);
  const newerRows = dated.slice(cut);
  const table: object[] = [];
  for (const verdict of ["TOXIC", "CLEAN", "UNKNOWN"]) {
    const older = olderRows.filter((row) => (row.verdict ?? "UNKNOWN") === verdict);
    const newer = newerRows.filter((row) => (row.verdict ?? "UNKNOWN") === verdict);
    if (!older.length && !newer.length) continue;
    table.push({
      verdict,
      olderN: older.length,
      newerN: newer.length,
      olderPumpThenRug: showRate(rate(older, (row) => row.structural === "PUMP_THEN_RUG")),
      newerPumpThenRug: showRate(rate(newer, (row) => row.structural === "PUMP_THEN_RUG")),
      olderBadNoPump: showRate(rate(older, (row) => row.structural === "BAD_NO_PUMP")),
      newerBadNoPump: showRate(rate(newer, (row) => row.structural === "BAD_NO_PUMP")),
      olderTail: showRate(rate(older, (row) => isStructuralTail(row.structural))),
      newerTail: showRate(rate(newer, (row) => isStructuralTail(row.structural))),
    });
  }
  console.table(table);
  console.log("  This checks descriptive stability only; it does not estimate expectancy.");
}

function matchedStructuralControl(rows: Rec[]): void {
  console.log("\n══ 3) SAME-WINDOW STRUCTURAL COMPARISON — CLEAN vs non-CLEAN ══");
  const dated = rows.filter((row) => row.ts > 0 && row.verdict);
  if (dated.length < 20) {
    console.log(`  Need ≥20 verdict-carrying launches; have ${dated.length}.`);
    return;
  }
  const windowMs = 30 * 60 * 1000;
  const start = Math.min(...dated.map((row) => row.ts));
  const windows = new Map<number, Rec[]>();
  for (const row of dated) {
    const key = Math.floor((row.ts - start) / windowMs);
    const group = windows.get(key) ?? [];
    group.push(row);
    windows.set(key, group);
  }

  const diffs = {
    tail: [] as number[],
    pumpThenRug: [] as number[],
    badNoPump: [] as number[],
  };
  let cleanN = 0;
  let otherN = 0;
  for (const group of windows.values()) {
    const clean = group.filter((row) => row.verdict === "CLEAN");
    const other = group.filter((row) => row.verdict !== "CLEAN");
    if (!clean.length || !other.length) continue;
    cleanN += clean.length;
    otherN += other.length;
    diffs.tail.push(
      rate(clean, (row) => isStructuralTail(row.structural))
      - rate(other, (row) => isStructuralTail(row.structural)),
    );
    diffs.pumpThenRug.push(
      rate(clean, (row) => row.structural === "PUMP_THEN_RUG")
      - rate(other, (row) => row.structural === "PUMP_THEN_RUG"),
    );
    diffs.badNoPump.push(
      rate(clean, (row) => row.structural === "BAD_NO_PUMP")
      - rate(other, (row) => row.structural === "BAD_NO_PUMP"),
    );
  }
  if (!diffs.tail.length) {
    console.log("  No window contains both CLEAN and non-CLEAN launches.");
    return;
  }
  const mean = (xs: number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  console.table([{
    pairedWindows: diffs.tail.length,
    cleanN,
    nonCleanN: otherN,
    cleanMinusOtherTail: showRate(mean(diffs.tail)),
    cleanMinusOtherPumpThenRug: showRate(mean(diffs.pumpThenRug)),
    cleanMinusOtherBadNoPump: showRate(mean(diffs.badNoPump)),
  }]);
  console.log("  These are structural prevalence differences, not P&L lift or causal evidence.");
}

const records = load();
console.log(`\nSTRUCTURAL OUTCOME DIAGNOSTIC — NOT PROFIT CALIBRATION${CFG === "all" ? " — pooled configs, indicative only" : ""}`);
verdictDiagnostic(records);
temporalStability(records);
matchedStructuralControl(records);
console.log("\nProfit claims are refused here; use complete paired ARM_RESULT data.\n");
