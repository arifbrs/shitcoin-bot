/**
 * ENTRY-LATENCY REPORT — where the entry budget actually goes.
 *
 * The decay curve puts peak value at 4 seconds after launch. Measured entry latency is p50
 * 2.92s / p90 5.97s, all of it inside open(): half our entries land at or past the peak. That
 * makes this the largest untouched lever in the strategy, and until the trader was instrumented
 * there was no number saying WHICH part of the 2.92s could be moved.
 *
 * Reads the `stageMs` breakdown from OPEN records and prints it, stage by stage, so the fix
 * goes where the time is rather than where it feels like it should be.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

interface Open { action?: string; stageMs?: Record<string, number>; openMs?: number; detectMs?: number | null; ts?: string }

const rows: Open[] = [];
for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("paper-trades-") && x.endsWith(".jsonl")).sort()) {
  const p = join(config.logDir, f);
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as Open;
      if (r.action === "OPEN" && r.stageMs) rows.push(r);
    } catch { /* torn last line is normal on a live file */ }
  }
}

const q = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(p * (s.length - 1))] ?? 0;
};

console.log("═══════ RINCIAN LATENSI MASUK ═══════");
console.log(`OPEN dengan instrumentasi: ${rows.length}\n`);
if (rows.length < 20) {
  console.log("BELUM CUKUP — instrumentasi baru terpasang, butuh beberapa entry.");
  console.log("Puncak nilai ada di detik ke-4; itu anggaran yang harus dilawan.");
} else {
  // Every stage any record mentions — a stage that only fires sometimes (buySim) must not be
  // silently dropped, and its n is what says how often it fires at all.
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.stageMs ?? {})))].filter((n) => n !== "curveReads");
  console.log("tahap             n     p50       p90       p99");
  for (const n of names) {
    const v = rows.map((r) => r.stageMs?.[n]).filter((x): x is number => typeof x === "number");
    if (!v.length) continue;
    console.log(`${n.padEnd(16)} ${String(v.length).padStart(4)}  ${(q(v, .5) + "ms").padStart(7)}  ${(q(v, .9) + "ms").padStart(7)}  ${(q(v, .99) + "ms").padStart(7)}`);
  }
  const total = rows.map((r) => r.openMs).filter((x): x is number => typeof x === "number");
  const det = rows.map((r) => r.detectMs).filter((x): x is number => typeof x === "number");
  console.log(`${"TOTAL open()".padEnd(16)} ${String(total.length).padStart(4)}  ${(q(total, .5) + "ms").padStart(7)}  ${(q(total, .9) + "ms").padStart(7)}  ${(q(total, .99) + "ms").padStart(7)}`);
  if (det.length) {
    console.log(`${"deteksi → masuk".padEnd(16)} ${String(det.length).padStart(4)}  ${(q(det, .5) + "ms").padStart(7)}  ${(q(det, .9) + "ms").padStart(7)}  ${(q(det, .99) + "ms").padStart(7)}`);
    console.log(`\n  → ${(det.filter((x) => x > 4000).length / det.length * 100).toFixed(0)}% entry mendarat SESUDAH puncak nilai di detik ke-4`);
  }
  const reads = rows.map((r) => r.stageMs?.curveReads).filter((x): x is number => typeof x === "number");
  if (reads.length) {
    const twice = reads.filter((x) => x === 2).length;
    console.log(`\npembacaan kurva ganda: ${twice}/${reads.length} (${(twice / reads.length * 100).toFixed(0)}%)`);
    console.log(twice / reads.length > 0.15
      ? "  → cukup sering: RPC menjawab kosong lalu kita membayar round trip kedua. Ini bisa diperbaiki."
      : "  → jarang: satu round trip memang harganya segitu; perbaikannya di penyedia RPC, bukan di kode ini.");
  }
}
