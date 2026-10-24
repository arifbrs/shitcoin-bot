/**
 * REKAMAN HARIAN FORWARD-TEST (FINAL §1) — `npm run ft:daily`. OFFLINE.
 * Satu berkas JSON per hari (logs/forward-test-daily-<tanggal>.json), idempoten per hari.
 * Semua angka dari fungsi produksi teruji — skema KOHOR = cohortStats().json.groups
 * (bucket simNetFor: quote-only/v1/v2-defective/v3), entry sim diterima = fill model LOLOS
 * (bukan setiap baris OPEN), rekonsiliasi = validator funnel yang sama. dir bisa disuntik utk tes.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ftProgress } from "./ft-progress.js";
import { cohortStats } from "./cohort-stats.js";
import { benchmarkTable } from "./breakeven.js";

interface GroupBlock { arm: string; cohort: string; bucket: string; excludedFromProfitability: boolean; closeRows: number; expectancyPct: number }

export function dailyRecord(now = Date.now(), dir = "logs/rhpaper"): Record<string, unknown> {
  const ft = ftProgress(now, dir) as { downtime: Record<string, unknown> };
  const cs = cohortStats(now, dir);
  const csJson = cs.json as Record<string, unknown>;
  const groups = (csJson.groups ?? []) as GroupBlock[];
  const profitableGroups = groups.filter((g) => !g.excludedFromProfitability); // v2-defective dikecualikan
  return {
    date: new Date(now).toISOString().slice(0, 10),
    calcVersions: { ftProgress: "ft-progress-r7", cohortStats: "cohort-stats-final (simNetFor; groups)", breakeven: "breakeven-r6", daily: "ft-daily-final" },
    validObservationHoursTrailing7d: (ft.downtime as Record<string, unknown>).activeHoursTrailing7d,
    availabilityPctTrailing7d: (ft.downtime as Record<string, unknown>).availabilityPctTrailing7d,
    coverageFlags: { gapWindows: (ft.downtime as Record<string, unknown>).gapWindowsLast7d, missedSignalObservationsInGaps: (ft.downtime as Record<string, unknown>).missedSignalObservationsInGaps,
      warning: "periode dengan coverage rendah TIDAK dihitung penuh sebagai bukti kualitas" },
    eligibleOpportunities: Number(csJson.openRows) + Number(csJson.rejectRows),
    acceptedSimulatedEntries: Number(csJson.acceptedSimEntries), // fill model entry LOLOS (bukan semua OPEN)
    rejectedSignals: Number(csJson.rejectRows),
    accountingBreakdown: csJson.accountingBreakdown,
    funnelValidTrades: Number(csJson.funnelValidTrades),
    reconciliationNote: "groups = cohortStats(bucket simNetFor); funnelValidTrades = validator countFunnel (sama dgn rh:funnel/rh:replay); v2-defective excludedFromProfitability",
    unfilledOrUnexitable: { rejects: Number(csJson.rejectRows), stuck: Number(csJson.stuckRows) },
    netSimulatedPnL: groups, // semua bucket — konsumen memfilter excludedFromProfitability
    netSimulatedPnLForProfitability: profitableGroups.map((g) => ({ arm: g.arm, cohort: g.cohort, bucket: g.bucket, closeRows: g.closeRows, expectancyPct: g.expectancyPct })),
    costSensitivityBreakEven: benchmarkTable(),
    strategyVersions: [...new Set(groups.map((g) => `${g.arm}/${g.cohort}/${g.bucket}`))],
    dataQuality: { malformedRows: Number(csJson.malformed), ledgerFiles: (csJson.dataset as { ledgerFiles?: unknown })?.ledgerFiles ?? Number(csJson.files ?? 0) },
    sourceCommands: ["npm run ft:progress", "npm run rh:cohort-stats", "npm run rh:funnel", "npm run rh:replay", "npx tsx tools/breakeven-table.ts"],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = dailyRecord();
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `forward-test-daily-${day}.json`), JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  const profit = (r.netSimulatedPnLForProfitability as GroupBlock[]).length;
  console.log(`[ft:daily] ditulis logs/forward-test-daily-${day}.json · coverage7d=${r.availabilityPctTrailing7d}% · eligible=${r.eligibleOpportunities} · simEntriesDiterima=${r.acceptedSimulatedEntries} · funnelValid=${r.funnelValidTrades} · grupProfitabilitas=${profit}`);
}
