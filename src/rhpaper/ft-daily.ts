/**
 * REKAMAN HARIAN FORWARD-TEST (round-7 P6) — `npm run ft:daily`. OFFLINE.
 * Satu berkas JSON per hari (logs/forward-test-daily-<tanggal>.json) yang MENULIS ULANG dirinya
 * sepanjang hari (idempoten). Semua angka dari fungsi produksi teruji — tanpa transkripsi manual:
 *   coverage/uptime: ftProgress() · kohort & PnL: cohortStats() · sensitivitas biaya: benchmarkTable().
 * Periode observasi TIDAK SAH dihitung sebagai bukti (flag coveragePct + gap windows disertakan).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ftProgress } from "./ft-progress.js";
import { cohortStats } from "./cohort-stats.js";
import { benchmarkTable } from "./breakeven.js";

export function dailyRecord(now = Date.now()): Record<string, unknown> {
  const ft = ftProgress(now) as { downtime: Record<string, unknown> };
  const cs = cohortStats(now);
  const csJson = cs.json as Record<string, unknown>;
  return {
    date: new Date(now).toISOString().slice(0, 10),
    calcVersions: { ftProgress: "ft-progress-r7", cohortStats: "cohort-stats-r7", breakeven: "breakeven-r6" },
    validObservationHoursTrailing7d: (ft.downtime as Record<string, unknown>).activeHoursTrailing7d,
    availabilityPctTrailing7d: (ft.downtime as Record<string, unknown>).availabilityPctTrailing7d,
    coverageFlags: { gapWindows: (ft.downtime as Record<string, unknown>).gapWindowsLast7d, missedSignalObservationsInGaps: (ft.downtime as Record<string, unknown>).missedSignalObservationsInGaps,
      warning: "periode dengan coverage rendah TIDAK dihitung penuh sebagai bukti kualitas" },
    eligibleOpportunities: Number(cs.json.openRows) + Number(cs.json.rejectRows),
    acceptedSimulatedEntries: Number(cs.json.openRows),
    rejectedSignals: Number(cs.json.rejectRows),
    accountingBreakdown: cs.json.accountingBreakdown,
    unfilledOrUnexitable: { rejects: Number(cs.json.rejectRows), stuck: Number(cs.json.stuckRows) },
    netSimulatedPnL: csJson.arms,
    costSensitivityBreakEven: benchmarkTable(),
    strategyVersions: [...new Set(((csJson.arms ?? []) as Array<Record<string, unknown>>).map((a) => `${a.arm}/${a.cohort}/${a.overlay}`))],
    dataQuality: { malformedRows: Number(cs.json.malformed), ledgerFiles: Number(cs.json.files) },
    sourceCommands: ["npm run ft:progress", "npm run rh:cohort-stats", "npx tsx tools/breakeven-table.ts"],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = dailyRecord();
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `forward-test-daily-${day}.json`), JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log(`[ft:daily] ditulis logs/forward-test-daily-${day}.json · coverage7d=${r.availabilityPctTrailing7d}% · eligible=${r.eligibleOpportunities} · accepted=${r.acceptedSimulatedEntries} · rejected=${r.rejectedSignals}`);
}
