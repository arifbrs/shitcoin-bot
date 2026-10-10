/**
 * RH DEEP — analisis menyeluruh SEBELUM mengubah aturan (permintaan owner 2026-10-09:
 * "sebelum potong pool_mati & perbaiki kualitas stop, coba dalami keseluruhan dulu").
 *
 * Yang dijawab, semuanya dari ledger (void & baris rekonsiliasi dikecualikan):
 *   1. DEKOMPOSISI DOLAR: tiap kerugian dipecah jadi (a) niat stop, (b) kelebihan di luar niat
 *      (gap antar-mark), (c) rug penuh, (d) biaya model (fee+slippage+gas).
 *   2. UMUR: berapa lama posisi hidup sebelum mati — menentukan apakah "keluar lebih awal"
 *      SECARA FISIK mungkin (kalau mati < 2 menit, tak ada aturan keluar yang menolong).
 *   3. KONTRФAKTUAL: "kalau X dihilangkan/dibatasi, net jadi berapa" — plafon tiap intervensi.
 *   4. JEJAK RUG: dari rh-rug-trace, apakah harga/likuiditas sempat bergerak sebelum mati.
 *   5. BIAYA: berapa bagian kerugian yang sebenarnya hanya ongkos bolak-balik.
 *
 * Run: npm run rh:deep   (tulis logs/rh-deep-<tanggal>.md)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const lines: string[] = [];
const say = (s = ""): void => { lines.push(s); };
const money = (v: number): string => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`);

// ── muat ledger (void & rekonsiliasi dikecualikan) ──
const voids = new Set<string>();
try {
  const j = JSON.parse(readFileSync(join(config.logDir, "rh-paper-voids.json"), "utf8")) as { voids?: Array<{ variant: string; token: string; ts: string }> };
  for (const v of j.voids ?? []) voids.add(`${v.variant}|${v.token}|${v.ts}`);
} catch { /* belum ada */ }

interface Row { action?: string; variant: string; token: string; symbol?: string; life?: number; ts: string; pnlUsd?: number; pnlPct?: number; reason?: string; notionalUsd?: number; stopPct?: number; heldMin?: number; entryPriceUsd?: number; exitPriceUsd?: number; reconciled?: boolean }
const rows: Row[] = [];
for (const f of readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
  for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!line.includes('"RH_')) continue;
    try {
      const r = JSON.parse(line) as Row;
      if (r.reconciled === true) continue;
      if (voids.has(`${r.variant}|${r.token}|${r.ts}`)) continue;
      rows.push(r);
    } catch { /* rusak */ }
  }
}
const opens = rows.filter((r) => r.action === "RH_OPEN");
const closes = rows.filter((r) => r.action === "RH_CLOSE");
const openByKey = new Map<string, Row[]>();
for (const o of opens) {
  const k = `${o.variant}|${o.token}|${o.life ?? 1}`;
  if (!openByKey.has(k)) openByKey.set(k, []);
  openByKey.get(k)!.push(o);
}
for (const l of openByKey.values()) l.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

const DEX_FEE_PCT = 0.003, GAS_USD = 0.01, SLIP_BASE = 0.01;
const slipOf = (notional: number, liq: number | null): number => {
  if (!liq || liq <= 0) return 0.05;
  const impact = Math.min(0.05, notional / liq);
  return SLIP_BASE + impact;
};

const net = closes.reduce((a, c) => a + (c.pnlUsd ?? 0), 0);
say(`═══ RH DEEP — ANALISIS MENYELURUH (sebelum mengubah aturan) ═══`);
say(`ledger: ${opens.length} buka · ${closes.length} tutup · net ${money(net)} · ${voids.size} baris void dikecualikan`);
say();

// ── 1. DEKOMPOSISI DOLAR ──
say("── 1. KE MANA UANGNYA PERGI (dolar, per alasan keluar) ──");
const byReason = new Map<string, Row[]>();
for (const c of closes) {
  if (!byReason.has(c.reason ?? "?")) byReason.set(c.reason ?? "?", []);
  byReason.get(c.reason ?? "?")!.push(c);
}
let totalIntended = 0, totalExcess = 0, totalCost = 0;
for (const [reason, list] of [...byReason.entries()].sort((a, b) => a[1].reduce((x, c) => x + (c.pnlUsd ?? 0), 0) - b[1].reduce((x, c) => x + (c.pnlUsd ?? 0), 0))) {
  const pnl = list.reduce((a, c) => a + (c.pnlUsd ?? 0), 0);
  const intended = list.reduce((a, c) => a + (c.notionalUsd ?? 0) * ((c.stopPct ?? 40) / 100), 0);
  const excess = list.filter((c) => (c.pnlUsd ?? 0) < 0).reduce((a, c) => a + Math.max(0, -(c.pnlUsd ?? 0) - (c.notionalUsd ?? 0) * ((c.stopPct ?? 40) / 100)), 0);
  const cost = list.reduce((a, c) => {
    const n = c.notionalUsd ?? 0;
    return a + 2 * (n * (DEX_FEE_PCT + slipOf(n, null)) + GAS_USD);
  }, 0);
  if (pnl < 0) { totalIntended += intended; totalExcess += excess; }
  totalCost += cost;
  say(`  ${reason.padEnd(12)} n=${String(list.length).padStart(4)} · net ${money(pnl).padStart(10)} · niat-stop $${intended.toFixed(0).padStart(6)} · kelebihan-di-luar-niat $${excess.toFixed(0).padStart(5)} · ongkos-bolak-balik ≈$${cost.toFixed(0)}`);
}
say(`  ${"TOTAL".padEnd(12)}          · kerugian dari "niat" $${totalIntended.toFixed(0)} · kelebihan (gap) $${totalExcess.toFixed(0)} · ongkos model (fee+slip+gas, 2 sisi) ≈$${totalCost.toFixed(0)}`);
say();

// ── 2. UMUR POSISI ──
say("── 2. UMUR POSISI (menentukan apakah 'keluar lebih awal' mungkin) ──");
for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const held = list.map((c) => c.heldMin ?? 0).sort((a, b) => a - b);
  const med = held[Math.floor(held.length / 2)] ?? 0;
  say(`  ${reason.padEnd(12)} median ${med.toFixed(1).padStart(6)} mnt · p10 ${(held[Math.floor(held.length * 0.1)] ?? 0).toFixed(1)} · p90 ${(held[Math.floor(held.length * 0.9)] ?? 0).toFixed(1)}`);
}
const rugs = closes.filter((c) => (c.pnlPct ?? 0) <= -90);
const rugHeld = rugs.map((c) => c.heldMin ?? 0).sort((a, b) => a - b);
say(`  → RUG (≤−90%): ${rugs.length} trade · median hidup ${(rugHeld[Math.floor(rugHeld.length / 2)] ?? 0).toFixed(1)} menit · p10 ${(rugHeld[Math.floor(rugHeld.length * 0.1)] ?? 0).toFixed(1)} mnt`);
say();

// ── 3. KONTRAFAKTUAL (plafon tiap intervensi) ──
say("── 3. KONTRAFAKTUAL: 'kalau X dihilangkan, net jadi berapa' ──");
const sum = (list: Row[]): number => list.reduce((a, c) => a + (c.pnlUsd ?? 0), 0);
const cf: Array<[string, Row[]]> = [
  ["semua trade (nyata)", closes],
  ["tanpa RUG penuh (≤−90%)", closes.filter((c) => (c.pnlPct ?? 0) > -90)],
  ["tanpa pool_mati", closes.filter((c) => c.reason !== "pool_mati")],
  ["tanpa stop_loss", closes.filter((c) => c.reason !== "stop_loss")],
  ["rugi dibatasi −$5 (niat)", closes.map((c) => ({ ...c, pnlUsd: Math.max(c.pnlUsd ?? 0, -5) }))],
  ["rugi dibatasi −$5 DAN tanpa rug", closes.filter((c) => (c.pnlPct ?? 0) > -90).map((c) => ({ ...c, pnlUsd: Math.max(c.pnlUsd ?? 0, -5) }))],
  ["hanya ambil untung (take_profit+trailing)", closes.filter((c) => c.reason === "take_profit" || c.reason === "trailing")],
];
for (const [label, list] of cf) {
  const v = sum(list);
  say(`  ${label.padEnd(42)} n=${String(list.length).padStart(4)} · net ${money(v).padStart(10)} ${v > net ? `(menghemat ${money(v - net)})` : ""}`);
}
say();

// ── 4. JEJAK RUG: apakah ada sinyal SEBELUM mati? ──
say("── 4. JEJAK RUG (rh-rug-trace): apakah harga/likuiditas bergerak sebelum mati? ──");
const traces: Array<Record<string, unknown>> = [];
for (const f of readdirSync(config.logDir).filter((f) => /^rh-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))) {
  for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!line.includes("rh-rug-trace")) continue;
    try { traces.push(JSON.parse(line) as Record<string, unknown>); } catch { /* rusak */ }
  }
}
const withMarks = traces.filter((t) => Array.isArray(t["marks"]) && (t["marks"] as unknown[]).length >= 2);
const withLiq = traces.filter((t) => Array.isArray(t["marks"]) && (t["marks"] as Array<{ liq: number | null }>).some((m) => m.liq != null));
let sawDrop = 0, noSignal = 0, lastGapMed: number[] = [];
for (const t of withMarks) {
  const marks = t["marks"] as Array<{ t: number; p: number; liq: number | null }>;
  const first = marks[0]!, last = marks[marks.length - 1]!;
  const priceDrop = first.p > 0 ? (1 - last.p / first.p) * 100 : 0;
  const liqs = marks.map((m) => m.liq).filter((x): x is number => x != null);
  const liqDrop = liqs.length >= 2 && liqs[0]! > 0 ? (1 - liqs[liqs.length - 1]! / liqs[0]!) * 100 : 0;
  if (priceDrop > 20 || liqDrop > 20) sawDrop++; else noSignal++;
  lastGapMed.push((last.t - marks[marks.length - 2]!.t) / 60000);
}
lastGapMed.sort((a, b) => a - b);
say(`  jejak tercatat: ${traces.length} · dengan ≥2 mark: ${withMarks.length} · punya angka likuiditas: ${withLiq.length}`);
say(`  dari yang punya ≥2 mark: ${sawDrop} menunjukkan penurunan (harga/likuiditas >20%) SEBELUM mati · ${noSignal} tanpa sinyal awal`);
say(`  jeda mark terakhir→sebelumnya: median ${(lastGapMed[Math.floor(lastGapMed.length / 2)] ?? 0).toFixed(1)} menit`);

// KONTRAFAKTUAL STOP KETAT — memakai MARK NYATA (bukan asumsi): untuk tiap jejak, cari mark
// PERTAMA yang sudah menyentuh ambang stop tertentu, lalu hitung hasil keluar di situ. Ini menjawab
// "apakah stop lebih ketat menyelamatkan uang?" dengan angka dari kejadian sesungguhnya.
for (const stopPct of [20, 30, 40]) {
  let saved = 0, couldAct = 0, notReached = 0;
  for (const t of withMarks) {
    const marks = t["marks"] as Array<{ t: number; p: number }>;
    const entry = Number(t["entryPriceUsd"] ?? 0);
    const pnlPct = Number(t["pnlPct"] ?? -100);
    if (!(entry > 0)) continue;
    const hit = marks.find((m) => m.p >= 0 && m.p <= entry * (1 - stopPct / 100));
    if (hit) { couldAct++; saved += -pnlPct / 100 - (stopPct / 100); } else notReached++;
  }
  const perNotional = 12.5; // notional tipikal $12,50 (risk $5 / stop 40%)
  say(`  stop −${stopPct}%: bisa bertindak di ${couldAct}/${withMarks.length} jejak (${notReached} tidak pernah menyentuh ambang) → perkiraan penyelamatan ≈ $${(saved * perNotional).toFixed(0)} (n=${couldAct} × rata-rata selisih)`);
}
say();

// ── 5. BIAYA vs KERUGIAN ──
say("── 5. BIAYA BOLAK-BALIK vs KERUGIAN TOTAL ──");
say(`  ongkos model (fee 0,30%/sisi + slippage 1%+impak + gas) ≈ $${totalCost.toFixed(0)} dari kerugian bruto $${Math.abs(closes.filter((c) => (c.pnlUsd ?? 0) < 0).reduce((a, c) => a + (c.pnlUsd ?? 0), 0)).toFixed(0)} (${pct(totalCost, Math.abs(closes.filter((c) => (c.pnlUsd ?? 0) < 0).reduce((a, c) => a + (c.pnlUsd ?? 0), 0)))})`);
say();

// ── 6. PEMISAH MASUK (ulang di data terkini) ──
say("── 6. PEMISAH MASUK — diukur ulang di data terkini (per trade) ──");
const entryOf = (c: Row): Row | undefined => {
  const list = openByKey.get(`${c.variant}|${c.token}|${c.life ?? 1}`) ?? [];
  const before = list.filter((o) => Date.parse(o.ts) <= Date.parse(c.ts));
  return before[before.length - 1];
};
const pairs = closes.map((c) => ({ c, o: entryOf(c) })).filter((p) => p.o) as Array<{ c: Row; o: Row }>;
const bucket = (label: string, pick: (o: Row) => number | null | undefined, edges: number[]): void => {
  const vals = pairs.filter((p) => typeof pick(p.o) === "number" && Number.isFinite(pick(p.o)));
  if (!vals.length) return;
  say(`  ${label}`);
  let lo = -Infinity;
  for (const hi of [...edges, Infinity]) {
    const list = vals.filter((p) => { const v = pick(p.o) as number; return v >= lo && v < hi; });
    if (list.length >= 5) {
      const pnl = list.reduce((a, p) => a + (p.c.pnlUsd ?? 0), 0);
      const w = list.filter((p) => (p.c.pnlUsd ?? 0) >= 0).length;
      const dead = list.filter((p) => p.c.reason === "pool_mati" || (p.c.pnlPct ?? 0) <= -50).length;
      say(`     ${String(lo === -Infinity ? `<${hi}` : hi === Infinity ? `≥${lo}` : `${lo}–${hi}`).padStart(12)} n=${String(list.length).padStart(4)} · net ${money(pnl).padStart(9)} · ${(pnl / list.length).toFixed(2)}/trade · win ${pct(w, list.length).padStart(4)} · mati ${pct(dead, list.length).padStart(4)}`);
    }
    lo = hi;
  }
};
bucket("likuiditas masuk ($)", (o) => (o as unknown as { liqUsd?: number }).liqUsd, [10_000, 25_000, 50_000, 100_000]);
say();

const text = lines.join("\n");
console.log(text);
const out = join(config.logDir, `rh-deep-${new Date().toISOString().slice(0, 10)}.md`);
try { writeFileSync(out, `${text}\n`); console.log(`\nDisimpan: ${out}`); } catch { /* best-effort */ }
