/**
 * OBSERVER & LAPORAN LANE PUMP-CALLER — `npm run pump:observe` / `npm run pump:report`.
 * observe: isi outcome marks (1m/5m/15m/1h/6h/24h/48h) untuk tiap keputusan bayangan dari
 * candle 1m/1s (idempoten; MISSING bila candle tak representatif/tak tersedia — tidak diarang).
 * report: ringkasan harian operator — keputusan, cakupan, hasil hipotesis vs baseline.
 */
import "dotenv/config";
import { swapApiCandles } from "./pumpfun-api.js";
import { read, markOutcome } from "./journal.js";
import { OUTCOME_HORIZONS_MIN } from "./types.js";
import { TRIGGERS, compare, type Outcome } from "./experiments.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function observe(): Promise<void> {
  const j = read();
  const decisions = j.rows.filter((r) => r.type === "shadow-decision" && typeof r.priceAtDecision === "number" && (r.priceAtDecision as number) > 0);
  let written = 0, missing = 0;
  for (const d of decisions) {
    const mint = String(d.mint), decidedAt = Number(d.ts), p0 = d.priceAtDecision as number;
    const candles = await swapApiCandles(mint, "1m", 60);
    for (const h of OUTCOME_HORIZONS_MIN) {
      const targetAt = decidedAt + h * 60_000;
      if (Date.now() < targetAt) continue;
      const tol = h <= 1 ? 30_000 : 60_000;
      const c = candles?.filter((x) => Math.abs(x.ts - targetAt) <= tol && x.volumeSol > 0).sort((a, b) => Math.abs(a.ts - targetAt) - Math.abs(b.ts - targetAt))[0];
      const did = String(d.decisionId);
      if (!c) { missing++; if (markOutcome({ decisionId: did, horizonMin: h, targetAt, checkedAt: Date.now(), status: "MISSING", reason: "CANDLE_TIDAK_REPRESENTATIF/TAKTERSEDIA", priceAtDecision: p0, priceAtTarget: null, changePct: null })) written++; continue; }
      const changePct = ((c.close - p0) / p0) * 100;
      if (markOutcome({ decisionId: did, horizonMin: h, targetAt, checkedAt: Date.now(), status: "OBSERVED", priceAtDecision: p0, priceAtTarget: c.close, changePct: Number(changePct.toFixed(4)) })) written++;
    }
  }
  console.log(`[pump:observe] keputusan=${decisions.length} mark baru=${written} (termasuk MISSING)`);
}

export function report(): void {
  const j = read();
  const decisions = j.rows.filter((r) => r.type === "shadow-decision");
  const marks = j.rows.filter((r) => r.type === "outcome-mark") as Array<Record<string, unknown>>;
  const byDecision = new Map<string, Map<number, number>>();
  for (const m of marks) {
    const id = String(m.decisionId);
    const map = byDecision.get(id) ?? new Map<number, number>();
    if (m.status === "OBSERVED" && typeof m.changePct === "number") map.set(Number(m.horizonMin), Number(m.changePct));
    byDecision.set(id, map);
  }
  const lines: string[] = ["═══ LAPORAN HARIAN PUMP-CALLER (riset nol-modal) ═══", "",
    `jurnal: ${j.rows.length} baris · rusak=${j.malformed} · duplikat-dilewati=${j.duplicates}`,
    `keputusan bayangan: ${decisions.length} (${tally(decisions)})`, ""];
  for (const h of OUTCOME_HORIZONS_MIN) {
    const obs = [...byDecision.values()].map((m) => m.get(h)).filter((v): v is number => v != null);
    if (!obs.length) { lines.push(`  ${h}m: belum ada hasil`); continue; }
    const mean = obs.reduce((a, b) => a + b, 0) / obs.length;
    lines.push(`  ${h}m: n=${obs.length} mean=${mean.toFixed(2)}% (bruto harga — BELUM net biaya)`);
  }
  lines.push("", "── Hipotesis pre-registrasi vs baseline (deskriptif) ──");
  for (const t of TRIGGERS) {
    const trig: Outcome[] = [], base: Outcome[] = [];
    for (const d of decisions) {
      const m = byDecision.get(String(d.decisionId))?.get(15);
      if (m == null) continue;
      const fires = (d.reasons as string[] | undefined)?.some((r) => r.includes(t.id.split("_")[0]!.toLowerCase())) ?? false;
      (fires ? trig : base).push({ mint: String(d.mint), changePct: m });
    }
    const cmp = compare(t.id, trig, base);
    lines.push(`  ${t.id}: trigger n=${cmp.nTrigger} vs baseline n=${cmp.nBaseline} · Δ=${cmp.diffPp}pp ${cmp.ci95Diff ? `CI=[${cmp.ci95Diff[0]}, ${cmp.ci95Diff[1]}]` : "(CI: n<5)"} · ${cmp.status} · baseline: ${t.baseline}`);
  }
  lines.push("", "CATATAN: caller timeline = BLOCKED_EXTERNAL tanpa PUMPFUN_API_KEY; hasil di atas dari",
    "tape/candle bebas-kunci + fixture (dilabel). Bukan bukti profitabilitas.");
  console.log(lines.join("\n"));
  writeFileSync(join("logs", `pump-caller-report-${new Date().toISOString().slice(0, 10)}.md`), lines.join("\n") + "\n");
}

function tally(decisions: Array<Record<string, unknown>>): string {
  const c: Record<string, number> = {};
  for (const d of decisions) c[String(d.decision)] = (c[String(d.decision)] ?? 0) + 1;
  return JSON.stringify(c);
}


