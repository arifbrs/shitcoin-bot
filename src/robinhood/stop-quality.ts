/**
 * KUALITAS STOP (item 2, 2026-10-11) — `npm run rh:stop`.
 *
 * Temuan yang memicu alat ini: stop nominal −20% tetapi realisasinya sampai −50%. Jadi kerugian
 * tidak hanya datang dari `pool_mati`; stop sendiri bocor. Alat ini mengukur bocornya:
 * berapa jauh realisasi melewati nominal, pada likuiditas berapa, dan berapa besar bagiannya
 * dari seluruh kerugian.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

interface CloseRow {
  variant: string;
  cohort?: string;
  symbol?: string;
  token: string;
  reason?: string;
  notionalUsd: number;
  stopPct?: number;
  pnlUsd: number;
  pnlPct?: number;
  liqUsd: number | null;
  ts: string;
}

const lines: string[] = [];
const say = (s = ""): void => { lines.push(s); };
const money = (v: number): string => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

function loadCloses(): CloseRow[] {
  const voids = new Set<string>();
  try {
    const j = JSON.parse(readFileSync(join(config.logDir, "rh-paper-voids.json"), "utf8")) as { voids?: Array<{ variant: string; token: string; ts: string }> };
    for (const v of j.voids ?? []) voids.add(`${v.variant}|${v.token}|${v.ts}`);
  } catch { /* belum ada */ }
  const out: CloseRow[] = [];
  for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("rh-paper-") && x.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
      if (!line.includes('"RH_CLOSE"')) continue;
      try {
        const r = JSON.parse(line) as CloseRow & { reconciled?: boolean };
        if (r.reconciled === true) continue;
        if (voids.has(`${r.variant}|${r.token}|${r.ts}`)) continue;
        if (typeof r.pnlPct !== "number") continue;
        out.push(r);
      } catch { /* baris rusak */ }
    }
  }
  return out;
}

const closes = loadCloses();
const KERUGIAN = closes.filter((c) => c.pnlUsd < 0);
const totalLoss = KERUGIAN.reduce((a, c) => a + c.pnlUsd, 0);
const totalPnl = closes.reduce((a, c) => a + c.pnlUsd, 0);

say("═══ KUALITAS STOP — seberapa jauh realisasi melewati nominal ═══");
say(`${closes.length} penutupan sah · kerugian total ${money(totalLoss)} · net ${money(totalPnl)}`);

// Kelompokkan berdasarkan alasan keluar. "Bocor" = realisasi lebih dalam dari nominal stop varian.
interface Bucket { n: number; loss: number; overshoot: number[]; extreme: number }
const MENGANDUNG_STOP = new Set(["stop_loss", "likuiditas_hilang", "liq_shield", "trailing_stop", "mark_basi"]);
const byReason = new Map<string, Bucket>();
for (const c of KERUGIAN) {
  const reason = c.reason ?? "?";
  const b = byReason.get(reason) ?? { n: 0, loss: 0, overshoot: [], extreme: 0 };
  b.n++;
  b.loss += c.pnlUsd;
  const nominal = c.stopPct ?? 40;
  const realisasi = c.pnlPct ?? 0;
  b.overshoot.push(realisasi + nominal); // negatif bila lebih dalam dari nominal
  if (realisasi <= -2 * nominal) b.extreme++;
  byReason.set(reason, b);
}

const p = (arr: number[], q: number): number => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!;
};

say("\n── PER ALASAN KELUAR (hanya yang rugi)");
for (const [reason, b] of [...byReason.entries()].sort((a, b) => a[1].loss - b[1].loss)) {
  const andil = totalLoss !== 0 ? (b.loss / totalLoss) * 100 : 0;
  say(`   ${reason.padEnd(18)} n=${String(b.n).padStart(4)} · rugi ${money(b.loss).padStart(10)} (${andil.toFixed(0)}% dari total rugi) · lewat nominal: p50 ${pct(p(b.overshoot, 0.5))} p90 ${pct(p(b.overshoot, 0.9))} · ≥2× nominal: ${b.extreme}`);
}

// Bocor khusus stop_loss: nominal vs realisasi
const stopLoss = KERUGIAN.filter((c) => c.reason === "stop_loss");
if (stopLoss.length) {
  const overs = stopLoss.map((c) => (c.pnlPct ?? 0) + (c.stopPct ?? 40));
  const bocor = overs.filter((o) => o < -5);
  const lossBocor = bocor.reduce((a, o, i) => a + (overs[i]! < -5 ? stopLoss[i]!.pnlUsd : 0), 0);
  say(`\n── BOCOR PADA stop_loss (${stopLoss.length} penutupan)`);
  say(`   lewat nominal >5 poin: ${bocor.length} (${(100 * bocor.length / stopLoss.length).toFixed(0)}%) · kerugian mereka ${money(lossBocor)}`);
  say(`   p50 ${pct(p(overs, 0.5))} · p90 ${pct(p(overs, 0.9))} · terburuk ${pct(p(overs, 0.999))}`);
}

// Bocor menurut pita likuiditas keluar
say("\n── MENURUT PITA LIKUIDITAS (keluar)");
const bands: Array<[string, (l: number) => boolean]> = [
  ["< $25k", (l) => l < 25_000],
  ["$25–50k", (l) => l >= 25_000 && l < 50_000],
  ["$50–100k", (l) => l >= 50_000 && l < 100_000],
  ["≥ $100k", (l) => l >= 100_000],
];
for (const [label, test] of bands) {
  const rows = KERUGIAN.filter((c) => test(c.liqUsd ?? 0));
  if (!rows.length) continue;
  const overs = rows.map((c) => (c.pnlPct ?? 0) + (c.stopPct ?? 40));
  const rug = rows.filter((c) => (c.pnlPct ?? 0) <= -80).length;
  say(`   ${label.padEnd(9)} n=${String(rows.length).padStart(4)} · rugi ${money(rows.reduce((a, c) => a + c.pnlUsd, 0)).padStart(10)} · lewat nominal p50 ${pct(p(overs, 0.5))} · −80% atau lebih: ${rug} (${(100 * rug / rows.length).toFixed(0)}%)`);
}

// Jawaban ringkas untuk pertanyaan "kenapa 90% kerugian dari sini"
const rugTotal = KERUGIAN.filter((c) => (c.pnlPct ?? 0) <= -80);
const rugLoss = rugTotal.reduce((a, c) => a + c.pnlUsd, 0);
say(`\n── RINGKASAN`);
say(`   penutupan ≤ −80%: ${rugTotal.length} dari ${KERUGIAN.length} penutupan rugi · menyumbang ${money(rugLoss)} (${totalLoss !== 0 ? ((rugLoss / totalLoss) * 100).toFixed(0) : "0"}% dari total rugi)`);
say(`   bocor stop (realisasi > 5 poin lebih dalam dari nominal) menyumbang ${money(KERUGIAN.filter((c) => ((c.pnlPct ?? 0) + (c.stopPct ?? 40)) < -5).reduce((a, c) => a + c.pnlUsd, 0))}`);

const text = lines.join("\n");
console.log(text);
const out = join(config.logDir, `rh-stop-quality-${new Date().toISOString().slice(0, 10)}.md`);
try { writeFileSync(out, `${text}\n`); console.log(`\nDisimpan: ${out}`); } catch { /* best-effort */ }
