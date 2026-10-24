/**
 * LAPORAN KEMAJUAN FORWARD-TEST (round-5 #6) — `npm run ft:progress`. OFFLINE, machine-readable.
 * Membuktikan seberapa banyak BUKTI PROSPEKTIF yang sudah terkumpul menuju gerbang riset
 * (≥14 hari & ≥100 trade selesai per versi strategi beku) — tanpa mengklaim profit.
 * Output: logs/forward-test-progress.json + stdout.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GATE_DAYS = 14, GATE_TRADES = 100;

export function ftProgress(now = Date.now()): Record<string, unknown> {
  const files = readdirSync("logs/rhpaper").filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const versions = new Map<string, { policyId: string; exits: string; firstTs: number; lastTs: number; opens: number; closes: number; rejects: number; simEligible: number; simFilled: number }>();
  let malformed = 0;
  const timestamps: number[] = [];
  for (const f of files) {
    for (const line of readFileSync(join("logs/rhpaper", f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { malformed++; continue; }
      const ts = Number(j.ts ?? 0);
      if (ts > 0) timestamps.push(ts);
      const action = String(j.action ?? "");
      if (action !== "OPEN" && action !== "REJECT") continue;
      const policyId = String(j.policyId ?? "legacy-unfrozen");
      const exits = JSON.stringify(j.exitPolicy ?? null);
      const key = `${j.arm ?? "?"}:${policyId}:${exits}`;
      const v = versions.get(key) ?? { policyId, exits, firstTs: ts, lastTs: ts, opens: 0, closes: 0, rejects: 0, simEligible: 0, simFilled: 0 };
      v.firstTs = Math.min(v.firstTs, ts); v.lastTs = Math.max(v.lastTs, ts);
      if (action === "OPEN") {
        v.opens++;
        const s = j.simFillEntry as { filled?: boolean } | undefined;
        if (s != null) { v.simEligible++; if (s.filled === true) v.simFilled++; }
      } else v.rejects++;
      versions.set(key, v);
    }
  }
  // Hitung CLOSE per versi: cocokkan policyId+arm dari baris CLOSE.
  const closeByKey = new Map<string, { n: number; ids: Set<string> }>();
  for (const f of files) {
    for (const line of readFileSync(join("logs/rhpaper", f), "utf8").split("\n")) {
      if (!line.includes('"action":"CLOSE"')) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        if (String(j.cohortStatus ?? "") !== "PROSPECTIVE") continue;
        const key = `${j.arm ?? "?"}:${String(j.policyId ?? "legacy-unfrozen")}:${JSON.stringify(j.exitPolicy ?? null)}`;
        const c = closeByKey.get(key) ?? { n: 0, ids: new Set<string>() };
        c.n++; if (j.tradeId) c.ids.add(String(j.tradeId));
        closeByKey.set(key, c);
      } catch { malformed++; }
    }
  }
  // Downtime & COVERAGE (round-7 P1 — denominator eksplisit, tidak lagi pakai span tersembunyi):
  //   availabilityPctTrailing7d  = waktu-aktif / 168 jam (jendela penuh) — angka paling jujur.
  //   availabilityPctCohortSpan  = waktu-aktif / [baris-pertama kohort → kini] — lama span saja.
  //   "aktif" = antar-baris ≤ GAP_THRESHOLD. Celah diklasifikasi: BEFORE_COHORT (sebelum baris
  //   pertama — lane memang belum jalan) vs OUTAGE (di dalam kohort — kegagalan sesungguhnya).
  const cutoff = now - 7 * 86_400_000;
  const recent = timestamps.filter((t) => t >= cutoff).sort((a, b) => a - b);
  const GAP_THRESHOLD = 30 * 60_000;
  const firstTs = recent[0] ?? now;
  let activeMs = 0, outageMs = 0, beforeCohortMs = 0;
  const gapWindows: Array<{ start: string; end: string; hours: number; class: "OUTAGE" | "BEFORE_COHORT" }> = [];
  let prev = cutoff;
  for (const t of recent) {
    const gap = t - prev;
    if (gap > GAP_THRESHOLD) {
      const cls = t === firstTs ? "BEFORE_COHORT" : "OUTAGE";
      if (cls === "OUTAGE") outageMs += gap; else beforeCohortMs += gap;
      gapWindows.push({ start: new Date(prev).toISOString(), end: new Date(t).toISOString(), hours: Number((gap / 3_600_000).toFixed(2)), class: cls });
    } else activeMs += gap;
    prev = Math.max(prev, t);
  }
  if (now - prev > GAP_THRESHOLD) {
    outageMs += now - prev;
    gapWindows.push({ start: new Date(prev).toISOString(), end: new Date(now).toISOString(), hours: Number(((now - prev) / 3_600_000).toFixed(2)), class: "OUTAGE" });
  } else activeMs += now - prev;
  const maxGapH = Math.max(0, ...gapWindows.filter((g) => g.class === "OUTAGE").map((g) => g.hours));
  const cohortSpanH = (now - firstTs) / 3_600_000;
  const coverage = {
    windowHours: 168,
    activeHoursTrailing7d: Number((activeMs / 3_600_000).toFixed(2)),
    availabilityPctTrailing7d: Number((100 * activeMs / (7 * 86_400_000)).toFixed(2)),
    cohortSpanHours: Number(cohortSpanH.toFixed(2)),
    activeHoursCohortSpan: Number((activeMs / 3_600_000).toFixed(2)),
    availabilityPctCohortSpan: cohortSpanH > 0 ? Number((100 * activeMs / (cohortSpanH * 3_600_000)).toFixed(2)) : null,
    outageHours: Number((outageMs / 3_600_000).toFixed(2)),
    beforeCohortHours: Number((beforeCohortMs / 3_600_000).toFixed(2)),
    gapWindowsLast7d: gapWindows,
    note: "availabilityPctTrailing7d memakai 168 jam penuh sebagai penyebut (round-6 salah pakai span); BEFORE_COHORT = lane memang belum dimulai, OUTAGE = kegagalan di dalam kohort. Uptime ≠ kelengkapan data pasar.",
  };
  // Observasi sinyal yang jatuh dalam celah OUTAGE saja (dari journal GMGN — yang bisa dihitung).
  let missedObservations = 0;
  try {
    const journal = readFileSync("logs/gmgn-observations/journal.jsonl", "utf8");
    const outageWindows = gapWindows.filter((g) => g.class === "OUTAGE");
    for (const line of journal.split("\n")) {
      if (!line.includes('"status":"MISSING"') || !line.includes("WINDOW_MISSED")) continue;
      try {
        const m = JSON.parse(line) as { targetAt?: number };
        if (typeof m.targetAt === "number" && outageWindows.some((g) => Date.parse(g.start) <= m.targetAt! && m.targetAt! <= Date.parse(g.end))) missedObservations++;
      } catch { /* baris rusak dilewati */ }
    }
  } catch { /* journal belum ada */ }
  void GATE_DAYS; void GATE_TRADES;

  const arms = [...versions.entries()].map(([key, v]) => {
    const c = closeByKey.get(key) ?? { n: 0, ids: new Set<string>() };
    const unique = Math.max(c.ids.size, 0);
    const daysSpan = Math.max((v.lastTs - v.firstTs) / 86_400_000, 0);
    return { key, policyId: v.policyId, firstSeen: new Date(v.firstTs).toISOString(), lastSeen: new Date(v.lastTs).toISOString(),
      opens: v.opens, closesProspectiveUnique: unique, rejects: v.rejects,
      simFillEligible: v.simEligible, simFillFilled: v.simFilled,
      daysCovered: Number(daysSpan.toFixed(2)),
      gateProgress: { daysPct: Number((Math.min(daysSpan / 14, 1) * 100).toFixed(1)), tradesPct: Number((Math.min(unique / 100, 1) * 100).toFixed(1)) },
      verdict: "TESTING — belum layak dinilai (n & hari di bawah gerbang)" };
  });
  return { generatedAt: new Date(now).toISOString(), gate: "≥14 hari & ≥100 trade selesai (per versi beku) — target riset MINIMUM, bukan bukti signifikansi",
    ledger: { files: files.length, malformedRows: malformed },
    downtime: { ...coverage, missedSignalObservationsInGaps: missedObservations,
      note2: "kalender ≠ jam observasi sah; 14 hari kalender dengan selisih ini BUKAN forward-test 14 hari" },
    arms };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = ftProgress();
  console.log(JSON.stringify(r, null, 2));
  writeFileSync(join("logs", "forward-test-progress.json"), JSON.stringify(r, null, 2));
}
