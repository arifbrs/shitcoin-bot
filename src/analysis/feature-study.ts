/**
 * STUDI FITUR PROSPEKTIF (research checkpoint) — `npm run rh:feature-study`. OFFLINE.
 * Menghubungkan FITUR POINT-IN-TIME di baris OPEN (imbalanceH1, txnsH1, priceChangeH1,
 * pairAgeDays, liquidityUsd) dengan NET-SIM v3 (simNetFor) dari CLOSE yang lulus validator
 * funnel. Median-split per fitur → expectancy per paruh + CI bootstrap; ketersediaan observasi
 * dilaporkan (feature non-null / total). DESKRIPTIF — bukan pemilihan parameter; tidak ada
 * optimasi terhadap data ini (arm/TP/SL tetap beku).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countFunnel } from "../rhpaper/funnel.js";
import { simNetFor } from "../rhpaper/fillmodel.js";

const med = (a: number[]): number | null => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null);

function bootstrapMean(values: number[], resamples = 2000, seed = 42): { lo: number; hi: number } {
  if (values.length < 2) return { lo: NaN, hi: NaN };
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

export function featureStudy(dir = "logs/rhpaper", now = Date.now()): { lines: string[]; json: Record<string, unknown> } {
  const rawRows: Array<Record<string, unknown>> = [];
  for (const f of readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rawRows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* rusak */ }
    }
  }
  const valid = new Set(countFunnel(rawRows).validCompletedIds);
  const opens = new Map<string, Record<string, unknown>>();
  for (const j of rawRows) if (String(j.action ?? "") === "OPEN" && j.tradeId) opens.set(String(j.tradeId), j);

  // Trade v3 funnel-valid + fitur OPEN + net sim (otoritas simNetFor).
  interface Trade { netSimPct: number; features: Record<string, number | null> }
  const trades: Trade[] = [];
  let v3OpensWithFeatures = 0, v3OpensTotal = 0;
  for (const j of rawRows) {
    if (String(j.action ?? "") !== "CLOSE" || !valid.has(String(j.tradeId ?? ""))) continue;
    const o = opens.get(String(j.tradeId ?? ""));
    if (String(j.fillModelVersion ?? "") !== "rhpaper-fillmodel-v3" || !o) continue;
    const es = o.simFillEntry as { fillOutRaw?: string } | undefined;
    const xs = j.simFillExit as { fillOutRaw?: string } | undefined;
    if (typeof j.entryWethRaw !== "string" || typeof j.exitWethRaw !== "string") continue;
    const s = simNetFor({ version: "rhpaper-fillmodel-v3", entryWethRaw: j.entryWethRaw, exitQuoteWethRaw: j.exitWethRaw,
      entrySimFillOutRaw: es?.fillOutRaw ?? null, exitSimFillOutRaw: xs?.fillOutRaw ?? null });
    trades.push({ netSimPct: s.netPct, features: {
      imbalanceH1: numOrNull(o.imbalanceH1), txnsH1: numOrNull(o.txnsH1), priceChangeH1: numOrNull(o.priceChangeH1),
      pairAgeDays: numOrNull(o.pairAgeDays), liquidityUsd: numOrNull(o.liquidityUsd) } });
  }
  for (const [, o] of opens) {
    if (String(o.fillModelVersion ?? "") !== "rhpaper-fillmodel-v3") continue;
    v3OpensTotal++;
    if (o.imbalanceH1 != null || o.txnsH1 != null || o.pairAgeDays != null) v3OpensWithFeatures++;
  }

  const lines: string[] = ["═══ STUDI FITUR PROSPEKTIF (v3, funnel-valid) — deskriptif, tanpa optimasi ═══", "",
    `trade v3 valid: ${trades.length} · OPEN v3 dgn fitur perilaku: ${v3OpensWithFeatures}/${v3OpensTotal} (${v3OpensTotal ? ((v3OpensWithFeatures / v3OpensTotal) * 100).toFixed(0) : "?"}% ketersediaan)`];

  const FEATURES = ["imbalanceH1", "txnsH1", "priceChangeH1", "pairAgeDays", "liquidityUsd"] as const;
  const results: Array<Record<string, unknown>> = [];
  for (const feat of FEATURES) {
    const pairs = trades.map((t) => ({ f: t.features[feat], net: t.netSimPct })).filter((x): x is { f: number; net: number } => x.f != null);
    const avail = pairs.length;
    if (avail < 4) { lines.push(`  ${feat}: n=${avail} — TERLALU SEDIKIT utk median-split (dilaporkan, tidak disimpulkan)`); results.push({ feature: feat, n: avail, status: "INSUFFICIENT" }); continue; }
    const m = med(pairs.map((x) => x.f))!;
    const lo = pairs.filter((x) => x.f <= m).map((x) => x.net);
    const hi = pairs.filter((x) => x.f > m).map((x) => x.net);
    const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    const ciLo = bootstrapMean(lo), ciHi = bootstrapMean(hi);
    const spread = mean(hi) - mean(lo);
    lines.push(`  ${feat}: n=${avail} (split median ${m.toFixed(2)}) · paruh-bawah mean=${mean(lo).toFixed(3)}% CI=[${ciLo.lo.toFixed(2)},${ciLo.hi.toFixed(2)}] · paruh-atas mean=${mean(hi).toFixed(3)}% CI=[${ciHi.lo.toFixed(2)},${ciHi.hi.toFixed(2)}] · Δ=${spread >= 0 ? "+" : ""}${spread.toFixed(3)}pp`);
    results.push({ feature: feat, n: avail, median: m, meanLowHalf: Number(mean(lo).toFixed(4)), meanHighHalf: Number(mean(hi).toFixed(4)),
      ciLowHalf: [Number(ciLo.lo.toFixed(3)), Number(ciLo.hi.toFixed(3))], ciHighHalf: [Number(ciHi.lo.toFixed(3)), Number(ciHi.hi.toFixed(3))],
      spreadPp: Number(spread.toFixed(4)), status: "DESCRIPTIVE" });
  }
  lines.push("", "ATURAN: ini asosiasi observasional pada kohor beku — bukan pemilihan parameter;",
    "hipotesis hanya naik status setelah pre-registrasi & sampel prospektif baru terkumpul.");
  const json = { generatedAt: now, calcVersion: "feature-study-v1 (simNetFor; median-split; bootstrap CI)", v3ValidTrades: trades.length, featureAvailability: { withBehavior: v3OpensWithFeatures, totalV3Opens: v3OpensTotal }, features: results };
  return { lines, json };
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = featureStudy();
  console.log(r.lines.join("\n"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-feature-study-${day}.json`), JSON.stringify(r.json, null, 2));
}
