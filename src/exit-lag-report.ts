/**
 * EXIT-LAG REPORT — how much does selling late cost us?
 *
 * Paper marks an exit at the price on the tick that triggered it. Live sells later: measured
 * against the chain, p50 3.9s and p90 38.7s after the signal. This reads the dense probe the
 * trader now writes after every exit (`type: "lag"` in post-exit-*.jsonl) and turns it into two
 * answers:
 *
 *   1. THE DECAY CURVE. What the price does in the seconds after we decide to sell, by exit
 *      reason. If a token we are cutting keeps falling while we queue, that fall is a cost we
 *      have never charged anywhere.
 *   2. WHAT THE LAG COSTS. The curve evaluated at the live lag distribution — the number that
 *      says whether "get out faster" is worth engineering, and how much it is worth.
 *
 * It reports per exit reason because the reasons are not alike: an EARLY_CUT fires on a token
 * already falling, a TRAIL_LOCK on one that just stopped rising. Pooling them would average a
 * cost with a different thing entirely.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export interface LagRow { secSinceExit: number; pctVsExit: number | null; reason?: string }

/** Live signal→fill lag, measured on-chain 2026-08-25 across 875 mirrored exits. */
export const LIVE_LAG_QUANTILES = Object.freeze([
  { q: 0.10, sec: 1.2 }, { q: 0.25, sec: 2.4 }, { q: 0.50, sec: 3.9 },
  { q: 0.75, sec: 12.0 }, { q: 0.90, sec: 38.7 }, { q: 0.99, sec: 53.4 },
] as const);

export interface Bucket { fromSec: number; toSec: number; n: number; medianPct: number; meanPct: number }

/**
 * Median, not mean, inside each bucket.
 *
 * One token that 5x'd in the eight seconds after we sold would drag a mean far enough to
 * suggest lag is FREE. The question here is what happens to a typical exit, and the tail is
 * reported separately by the mean sitting next to it.
 */
export function lagDecayCurve(rows: LagRow[], edges: number[]): Bucket[] {
  const out: Bucket[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i] as number, to = edges[i + 1] as number;
    const v = rows
      .filter((r) => r.pctVsExit != null && r.secSinceExit >= from && r.secSinceExit < to)
      .map((r) => r.pctVsExit as number)
      .sort((a, b) => a - b);
    if (!v.length) continue;
    out.push({
      fromSec: from, toSec: to, n: v.length,
      medianPct: v[Math.floor(v.length / 2)] as number,
      meanPct: v.reduce((a, b) => a + b, 0) / v.length,
    });
  }
  return out;
}

/** Linear interpolation over the bucket centroids; flat outside the measured range. */
export function decayAt(curve: Bucket[], sec: number): number | null {
  if (!curve.length) return null;
  const pts = curve.map((b) => ({ x: (b.fromSec + b.toSec) / 2, y: b.medianPct })).sort((a, b) => a.x - b.x);
  const first = pts[0] as { x: number; y: number }, last = pts[pts.length - 1] as { x: number; y: number };
  if (sec <= first.x) return first.y;
  if (sec >= last.x) return last.y;
  let i = 0;
  while (i + 1 < pts.length && (pts[i + 1] as { x: number }).x <= sec) i++;
  const a = pts[i] as { x: number; y: number }, b = pts[i + 1] as { x: number; y: number };
  return a.y + ((sec - a.x) / (b.x - a.x)) * (b.y - a.y);
}

/** Expected cost of the lag, averaging the decay over the live lag quantiles. */
export function lagCostPct(curve: Bucket[]): number | null {
  const vals = LIVE_LAG_QUANTILES.map((q) => decayAt(curve, q.sec)).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function rows(): LagRow[] {
  const out: LagRow[] = [];
  for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("post-exit-") && x.endsWith(".jsonl")).sort()) {
    const p = join(config.logDir, f);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as LagRow & { type?: string };
        if (r.type === "lag" && typeof r.secSinceExit === "number") out.push(r);
      } catch { /* torn last line on a live file is normal */ }
    }
  }
  return out;
}

const EDGES = [0, 3, 6, 12, 25, 45, 90];

function main(): void {
  const all = rows();
  console.log("═══════ BIAYA JEDA KELUAR ═══════");
  console.log(`probe: ${all.length} sampel (${all.filter((r) => r.pctVsExit == null).length} tanpa harga)\n`);
  if (all.length < 50) {
    console.log("BELUM CUKUP DATA — probe baru mulai merekam. Butuh beberapa jam.");
    console.log(`offset yang direkam: ${config.postExit.lagProbeSec.join(", ")} detik setelah sinyal keluar.`);
    return;
  }
  const show = (label: string, rs: LagRow[]): void => {
    const curve = lagDecayCurve(rs, EDGES);
    if (!curve.length) return;
    console.log(`\n${label}  (n=${rs.filter((r) => r.pctVsExit != null).length})`);
    console.log("  detik        n     median     rata-rata");
    for (const b of curve) {
      console.log(`  ${(b.fromSec + "–" + b.toSec + "s").padEnd(11)} ${String(b.n).padStart(4)}  ` +
        `${((b.medianPct >= 0 ? "+" : "") + b.medianPct.toFixed(2) + "%").padStart(9)}  ` +
        `${((b.meanPct >= 0 ? "+" : "") + b.meanPct.toFixed(2) + "%").padStart(10)}`);
    }
    const cost = lagCostPct(curve);
    if (cost != null) {
      console.log(`  → pada sebaran jeda live: ${(cost >= 0 ? "+" : "") + cost.toFixed(2)}% per exit`);
    }
  };
  show("SEMUA EXIT", all);
  const byReason = new Map<string, LagRow[]>();
  for (const r of all) {
    const k = r.reason ?? "?";
    byReason.set(k, [...(byReason.get(k) ?? []), r]);
  }
  for (const [k, rs] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
    if (rs.filter((r) => r.pctVsExit != null).length >= 30) show(k, rs);
  }
  console.log("\nmedian dipakai, bukan rata-rata: satu token yang terbang setelah kita jual bisa");
  console.log("membuat rata-rata menyatakan jeda itu GRATIS. Rata-rata dicetak di sebelahnya.");
}

if (process.argv[1] && process.argv[1].includes("exit-lag-report")) main();
