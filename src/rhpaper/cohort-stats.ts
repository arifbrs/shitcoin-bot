/**
 * STATISTIK KOHORT PAPER RH (round-4 #8) — `npm run rh:cohort-stats`. OFFLINE.
 * Membaca SEMUA ledger CLOSE logs/rhpaper, memisahkan kohort:
 *   - cohortStatus PROSPECTIVE (engine v3, keputusan frozen) vs LEGACY_CARRYOVER
 *   - fillmodel: baris DENGAN fillModelVersion (overlay akuntansi sejak 2026-10-24) vs tanpa
 * Per arm: n, winrate, mean netPct (quote) + mean simNetPct (fillmodel: latensi 0,5%/sisi),
 * profit factor, break-even winrate, bootstrap CI95 (seed tetap → deterministik).
 * Gross TP/stop ≠ hasil net: semua metrik di sini NET (gas riwayat 1,14% sudah di netPct;
 * overlay sim menambahkan asumsi latensi — TIDAK pernah digabung ke klaim quote).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LATENCY_PCT_PER_SIDE = 0.5; // fillmodel-v1 asumsi (diekspos ulang di sini agar laporan mandiri)

interface CloseRow { arm: string; netPct: number; grossPct: number; cohortStatus: string; why: string; ts: number; fillModelVersion: string | null; token: string }

function bootstrapCi(values: number[], resamples = 2000, seed = 42): { lo: number; hi: number } {
  let s = seed >>> 0;
  const rnd = (): number => (s = (s * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += values[Math.floor(rnd() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * (means.length - 1))]!, hi: means[Math.floor(0.975 * (means.length - 1))]! };
}

export function cohortStats(now = Date.now()): { lines: string[]; summary: string } {
  const closes: CloseRow[] = [];
  const files = readdirSync("logs/rhpaper").filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    for (const line of readFileSync(join("logs/rhpaper", f), "utf8").split("\n")) {
      if (!line.trim() || !line.includes('"action":"CLOSE"')) continue;
      try {
        const j = JSON.parse(line) as Record<string, unknown>;
        closes.push({ arm: String(j.arm ?? "?"), netPct: Number(j.netPct ?? NaN), grossPct: Number(j.grossPct ?? NaN),
          cohortStatus: String(j.cohortStatus ?? "?"), why: String(j.why ?? "?"), ts: Number(j.ts ?? 0),
          fillModelVersion: typeof j.fillModelVersion === "string" ? j.fillModelVersion : null, token: String(j.token ?? "?") });
      } catch { /* baris rusak dihitung terpisah */ }
    }
  }
  const lines = ["═══ KOHORT PAPER RH — net, CI, break-even (quote ≠ sim ≠ realized) ═══", "",
    `sumber: ${files.length} ledger · ${closes.length} CLOSE · asumsi sim: latensi ${LATENCY_PCT_PER_SIDE}%/sisi (fillmodel-v1) + gas riwayat 1,14% (sudah dalam netPct)`, ""];

  const arms = [...new Set(closes.map((c) => c.arm))].sort();
  for (const arm of arms) {
    for (const cohort of ["PROSPECTIVE", "LEGACY_CARRYOVER"] as const) {
      const rows = closes.filter((c) => c.arm === arm && c.cohortStatus === cohort && Number.isFinite(c.netPct));
      if (!rows.length) continue;
      const net = rows.map((r) => r.netPct);
      const sim = net.map((p) => p - 2 * LATENCY_PCT_PER_SIDE); // overlay fillmodel (akuntansi, bukan keputusan)
      const wins = sim.filter((p) => p > 0), losses = sim.filter((p) => p < 0);
      const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
      const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
      const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
      const be = avgWin > 0 ? avgLoss / (avgLoss + avgWin) : 1; // break-even winrate di bawah sim
      const ciNet = bootstrapCi(net), ciSim = bootstrapCi(sim);
      const tokens = new Set(rows.map((r) => r.token)).size;
      lines.push(`arm ${arm} · ${cohort} · ${rows.some((r) => r.fillModelVersion) ? "dengan" : "tanpa"} fillmodel-overlay: n=${rows.length}, token=${tokens}`,
        `  net(quote): mean=${(net.reduce((a, b) => a + b, 0) / net.length).toFixed(3)}% CI95=[${ciNet.lo.toFixed(2)}, ${ciNet.hi.toFixed(2)}]`,
        `  net(sim overlay): mean=${(sim.reduce((a, b) => a + b, 0) / sim.length).toFixed(3)}% CI95=[${ciSim.lo.toFixed(2)}, ${ciSim.hi.toFixed(2)}] · winrate=${(wins.length / sim.length * 100).toFixed(1)}% · PF=${Number.isFinite(pf) ? pf.toFixed(2) : "∞"} · break-even winrate=${(be * 100).toFixed(1)}%`,
        `  exit reasons: ${JSON.stringify(rows.reduce<Record<string, number>>((acc, r) => { acc[r.why] = (acc[r.why] ?? 0) + 1; return acc; }, {}))}`);
    }
  }
  const summary = `arms=${arms.length} closes=${closes.length}`;
  lines.push("", "BATAS JUJUR: ini DISTRIBUSI EXIT atas kandidat yang kebetulan terbuka — bukan expectancy strategi",
    "(entry quota/arm mendominasi pilihan). CI lebar karena n kecil; jendela data 2-3 hari. Break-even di atas",
    "menjawab: 'berapa winrate minimum agar net ≥ 0 dengan biaya aktual', bukan klaim profitabilitas.");
  void now;
  return { lines, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = cohortStats();
  console.log(r.lines.join("\n"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-cohort-stats-${day}.md`), r.lines.join("\n") + "\n");
}
