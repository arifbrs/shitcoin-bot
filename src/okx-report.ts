import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Reads what the study found. Deliberately blunt: it prints the numbers and refuses to editorialise.
 *
 * The single question it answers is whether CLEAN and TOXIC separate. If their medians sit on top
 * of each other, the verdict is decoration and should be deleted rather than tuned — this project
 * has already measured one composite score to be INVERTED, so "tune it until it works" is a known
 * road to a confident wrong answer.
 */

interface Row {
  verdict: string; horizonSec: number; pctChange: number | null; status: string;
  devPct: number | null; bundlerPct: number | null; sniperPct: number | null;
  insiderPct: number | null; top10Pct: number | null; totalHolders: number | null;
  ageMsAtScan: number | null; hasSocials?: boolean;
}

const rows: Row[] = [];
for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("events-") && x.endsWith(".jsonl")).sort()) {
  for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!line.includes('"okx-outcome"')) continue;
    try { const o = JSON.parse(line) as Row & { type: string }; if (o.type === "okx-outcome") rows.push(o); } catch { /* skip */ }
  }
}

if (rows.length === 0) {
  console.log("Belum ada outcome. Jalankan `npm run okx:study` dan tunggu horizon pertama lewat.");
  process.exit(0);
}

const med = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : NaN; };
const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);
const fmt = (n: number): string => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—");

const horizons = [...new Set(rows.map((r) => r.horizonSec))].sort((a, b) => a - b);
const priced = rows.filter((r) => r.pctChange != null);
const neverPriced = rows.length - priced.length;

console.log(`\nOKX SCOUT STUDY — ${rows.length} outcome, ${neverPriced} NEVER_PRICED (${(neverPriced / rows.length * 100).toFixed(0)}%)\n`);
console.log("Pertanyaannya SATU: apakah CLEAN dan TOXIC terpisah?\n");
console.log("horizon".padEnd(10) + "n(CLEAN)".padEnd(10) + "med CLEAN".padEnd(12) + "n(TOXIC)".padEnd(10) + "med TOXIC".padEnd(12) + "selisih");
console.log("-".repeat(66));
for (const h of horizons) {
  const at = priced.filter((r) => r.horizonSec === h);
  const c = at.filter((r) => r.verdict === "CLEAN").map((r) => r.pctChange!);
  const t = at.filter((r) => r.verdict === "TOXIC").map((r) => r.pctChange!);
  const gap = c.length && t.length ? med(c) - med(t) : NaN;
  console.log(
    `${h}s`.padEnd(10) + String(c.length).padEnd(10) + fmt(med(c)).padEnd(12) +
    String(t.length).padEnd(10) + fmt(med(t)).padEnd(12) + fmt(gap),
  );
}

console.log("\nRata-rata (rentan ekor — median di atas yang harus dipercaya):");
for (const h of horizons) {
  const at = priced.filter((r) => r.horizonSec === h);
  const c = at.filter((r) => r.verdict === "CLEAN").map((r) => r.pctChange!);
  const t = at.filter((r) => r.verdict === "TOXIC").map((r) => r.pctChange!);
  console.log(`  ${h}s`.padEnd(10) + `CLEAN ${fmt(mean(c))}   TOXIC ${fmt(mean(t))}`);
}

// Per-signal check: does any single actor field separate outcomes on its own? A verdict that
// works only because ONE of its six inputs works should be replaced by that input.
const longest = horizons[horizons.length - 1]!;
const at = priced.filter((r) => r.horizonSec === longest);
if (at.length >= 40) {
  console.log(`\nPer-sinyal di ${longest}s (median hasil, dibelah di ambang gate):`);
  const cuts: Array<[string, (r: Row) => number | null, number]> = [
    ["devPct >15", (r) => r.devPct, 15],
    ["bundlerPct >30", (r) => r.bundlerPct, 30],
    ["sniperPct >40", (r) => r.sniperPct, 40],
    ["insiderPct >25", (r) => r.insiderPct, 25],
    ["top10Pct >60", (r) => r.top10Pct, 60],
  ];
  for (const [label, get, cut] of cuts) {
    const above = at.filter((r) => (get(r) ?? -1) > cut).map((r) => r.pctChange!);
    const below = at.filter((r) => { const v = get(r); return v != null && v <= cut; }).map((r) => r.pctChange!);
    if (above.length < 5 || below.length < 5) { console.log(`  ${label.padEnd(18)} sampel kurang (${above.length} vs ${below.length})`); continue; }
    console.log(`  ${label.padEnd(18)} di atas ${fmt(med(above))} (n=${above.length})   di bawah ${fmt(med(below))} (n=${below.length})   selisih ${fmt(med(below) - med(above))}`);
  }
}

const total = priced.filter((r) => r.horizonSec === horizons[0]).length;
console.log(`\nSampel per horizon terpendek: ${total}. Di bawah ~200 jangan simpulkan apa pun.`);
