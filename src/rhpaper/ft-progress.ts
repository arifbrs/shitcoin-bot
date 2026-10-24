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
  // Downtime: celah terbesar antar-baris ledger 7 hari terakhir (jam).
  const cutoff = now - 7 * 86_400_000;
  const recent = timestamps.filter((t) => t >= cutoff).sort((a, b) => a - b);
  let maxGapH = 0;
  for (let i = 1; i < recent.length; i++) maxGapH = Math.max(maxGapH, (recent[i]! - recent[i - 1]!) / 3_600_000);
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
    ledger: { files: files.length, malformedRows: malformed }, downtime: { maxGapHoursLast7d: Number(maxGapH.toFixed(2)) }, arms };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = ftProgress();
  console.log(JSON.stringify(r, null, 2));
  writeFileSync(join("logs", "forward-test-progress.json"), JSON.stringify(r, null, 2));
}
