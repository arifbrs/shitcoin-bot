/**
 * UJI REALISME HARGA KELUAR (item 1, 2026-10-11) — `npm run rh:realism`.
 *
 * Pertanyaan yang dijawab: apakah keunggulan sebuah arm bertahan bila model dampak jual dibuat
 * lebih keras, dan apakah ia bertahan tanpa pemenang terbesarnya? Dua-duanya gerbang yang sudah
 * ditulis di rencana proyek: "positif bukan karena satu mint" dan "bertahan setelah fee/slippage
 * realistis".
 *
 * Yang TIDAK bisa dibuktikan alat ini, dan itu disebut di laporan: apakah harga TP benar-benar
 * BISA DIJUAL (butuh mark SETELAH keluar untuk membuktikannya).
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { exitProceedsUsd, DEX_FEE_PCT, GAS_USD, slipPct } from "./costs.js";
import { concentration, mean, bootstrapDiffCI } from "./stats.js";
import { priceRetention, retentionOf as retentionOfShared, summarizeTraces } from "./mark-trace.js";

interface CloseRow {
  variant: string;
  cohort?: string;
  symbol?: string;
  token: string;
  reason?: string;
  notionalUsd: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  liqUsd: number | null;
  entryLiqUsd?: number | null;
  pnlUsd: number;
  pnlPct?: number;
  ts: string;
}

const lines: string[] = [];
const say = (s = ""): void => { lines.push(s); };
const money = (v: number): string => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

function voidKeys(): Set<string> {
  const out = new Set<string>();
  try {
    const j = JSON.parse(readFileSync(join(config.logDir, "rh-paper-voids.json"), "utf8")) as { voids?: Array<{ variant: string; token: string; ts: string }> };
    for (const v of j.voids ?? []) out.add(`${v.variant}|${v.token}|${v.ts}`);
  } catch { /* belum ada */ }
  return out;
}

function loadCloses(): CloseRow[] {
  const voids = voidKeys();
  const out: CloseRow[] = [];
  const opens = new Map<string, { liqUsd: number | null; entryPriceUsd: number; notionalUsd: number }>();
  for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("rh-paper-") && x.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
      if (!line.includes('"RH_')) continue;
      try {
        const raw = JSON.parse(line) as CloseRow & { reconciled?: boolean; action?: string; life?: number };
        if (raw.reconciled === true) continue;
        if (voids.has(`${raw.variant}|${raw.token}|${raw.ts}`)) continue;
        if (raw.action === "RH_OPEN") {
          opens.set(`${raw.variant}|${raw.token}|${raw.life ?? 1}`, {
            liqUsd: raw.liqUsd ?? null,
            entryPriceUsd: raw.entryPriceUsd,
            notionalUsd: raw.notionalUsd,
          });
          continue;
        }
        if (raw.action !== "RH_CLOSE") continue;
        if (!raw.entryPriceUsd || !raw.exitPriceUsd || !raw.notionalUsd) continue;
        const open = opens.get(`${raw.variant}|${raw.token}|${raw.life ?? 1}`);
        out.push({ ...raw, entryLiqUsd: open?.liqUsd ?? raw.liqUsd ?? null });
      } catch { /* baris rusak */ }
    }
  }
  return out;
}

/**
 * PnL yang dihitung ulang dari baris, memakai model dampak dengan kekerasan k.
 *
 * JUMLAH TOKEN dihitung seperti bot menghitungnya saat membeli: notional dikurangi biaya beli
 * (fee + slippage masuk + gas), dibagi harga masuk. Versi pertama alat ini memakai notional/harga
 * masuk — terlalu banyak token — dan pemeriksaan dirinya sendiri menangkapnya (selisih $24,70);
 * itulah gunanya pemeriksaan diri: laporan yang tidak bisa mereproduksi angka tercatat tidak layak
 * dipakai untuk menyimpulkan apa pun.
 */
function tokenCount(c: CloseRow): number {
  const slipIn = slipPct(c.notionalUsd, c.entryLiqUsd ?? c.liqUsd ?? null);
  const tokens = (c.notionalUsd - (c.notionalUsd * (DEX_FEE_PCT + slipIn) + GAS_USD)) / c.entryPriceUsd;
  return Math.max(0, tokens);
}

function recompute(c: CloseRow, k: number): number {
  const qty = tokenCount(c);
  // TIDAK ada haircut di sini: harga keluar yang TERCATAT sudah termasuk haircut per-alasan
  // (paper.ts: exitPrice = price × 0,75 utk pool_mati, × 0,5 utk mark_basi). Versi pertama alat ini
  // memotongnya lagi — dua kali potong — dan pemeriksaan diri menangkapnya (baris Musk yang sama:
  // tercatat +$8,08 vs hitung −$16,74). Sesudah dibetulkan, k=1 mereproduksi angka tercatat persis.
  const proceeds = exitProceedsUsd(qty * c.exitPriceUsd, c.liqUsd ?? null, { k });
  return proceeds - c.notionalUsd;
}

const closes = loadCloses();
say("═══ UJI REALISME HARGA KELUAR ═══");
say(`penutupan sah: ${closes.length} · void & baris rekonsiliasi dikecualikan`);

// PEMERIKSAAN DIRI: model k=1 harus mereproduksi PnL yang tercatat. Kalau tidak, seluruh laporan
// ini tidak layak dipercaya — jadi diperiksa lebih dulu, bukan diasumsikan.
let maxDiff = 0;
for (const c of closes) maxDiff = Math.max(maxDiff, Math.abs(recompute(c, 1) - c.pnlUsd));
say(`pemeriksaan diri k=1: selisih maks ${"$"}${maxDiff.toFixed(4)} vs PnL tercatat ${maxDiff <= 0.02 ? "→ model cocok, laporan layak" : "→ TIDAK COCOK, laporan tidak layak"}`);
if (maxDiff > 0.02) {
  const worst = [...closes].sort((a, b) => Math.abs(recompute(b, 1) - b.pnlUsd) - Math.abs(recompute(a, 1) - a.pnlUsd)).slice(0, 5);
  say("   baris paling menyimpang (untuk diperiksa, bukan disembunyikan):");
  for (const c of worst) {
    say(`     ${c.variant} ${c.symbol ?? "?"} ${c.reason ?? "?"} tercatat ${money(c.pnlUsd)} vs hitung ${money(recompute(c, 1))} · masuk ${c.entryPriceUsd} keluar ${c.exitPriceUsd} liq ${c.liqUsd ?? "?"}`);
  }
}

const cohorts = new Map<string, CloseRow[]>();
for (const c of closes) {
  const key = c.cohort ?? "(tanpa kohort)";
  if (!cohorts.has(key)) cohorts.set(key, []);
  cohorts.get(key)!.push(c);
}

interface ArmResult {
  name: string;
  n: number;
  net1: number;
  net2: number;
  net3: number;
  netExclTop1: number;
  topShare: number;
  tpN: number;
  verdict: string;
}

const results: ArmResult[] = [];
function analyzeArm(name: string, rows: CloseRow[]): ArmResult | null {
  if (rows.length < 5) return null;
  const k1 = rows.map((c) => recompute(c, 1));
  const net1 = k1.reduce((a, b) => a + b, 0);
  const net2 = rows.reduce((a, b) => a + recompute(c2(b), 2), 0);
  const net3 = rows.reduce((a, b) => a + recompute(c2(b), 3), 0);
  const conc = concentration(rows.map((c) => c.pnlUsd));
  const tp = rows.filter((c) => c.reason === "take_profit");
  const verdict =
    net2 > 0 && conc.netExclTop1 > 0 ? "TAHAN (k=2 & tanpa top-1 tetap positif)"
    : net1 > 0 && conc.netExclTop1 <= 0 ? "RAPUH (bergantung pemenang terbesar)"
    : net1 > 0 && net2 <= 0 ? "RAPUH (mati bila dampak jual 2× lebih keras)"
    : "ARTEFAK/TIDAK LAYAK (tidak positif)";
  return { name, n: rows.length, net1, net2, net3, netExclTop1: conc.netExclTop1, topShare: conc.topSharePct, tpN: tp.length, verdict };
}
// Helper kecil supaya pemanggilan recompute tetap terbaca.
function c2(c: CloseRow): CloseRow { return c; }

for (const [cohort, rows] of [...cohorts.entries()].sort()) {
  say(`\n── ${cohort} (${rows.length} tutup)`);
  const byArm = new Map<string, CloseRow[]>();
  for (const c of rows) {
    if (!byArm.has(c.variant)) byArm.set(c.variant, []);
    byArm.get(c.variant)!.push(c);
  }
  for (const [arm, list] of [...byArm.entries()].sort()) {
    const r = analyzeArm(arm, list);
    if (!r) { say(`   ${arm.padEnd(22)} n=${list.length} (terlalu sedikit untuk dinilai)`); continue; }
    say(`   ${arm.padEnd(22)} n=${String(r.n).padStart(3)} · net ${money(r.net1).padStart(9)} · k=2 ${money(r.net2).padStart(9)} · k=3 ${money(r.net3).padStart(9)} · tanpa top-1 ${money(r.netExclTop1).padStart(9)} · top-1 ${(r.topShare * 100).toFixed(0)}% dari net · TP ${r.tpN}/${r.n}`);
    say(`      → ${r.verdict}`);
    results.push(r);
  }
}

// Dampak jual pada kemenangan TP: seberapa besar lompatan harga yang diklaim, dan di likuiditas berapa.
const tpWins = closes.filter((c) => c.reason === "take_profit" && c.pnlUsd > 0);
if (tpWins.length) {
  const markups = tpWins.map((c) => (c.exitPriceUsd / c.entryPriceUsd - 1) * 100).sort((a, b) => a - b);
  const liqs = tpWins.map((c) => c.liqUsd ?? 0).sort((a, b) => a - b);
  const p = (arr: number[], q: number): number => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))]!;
  say(`\n── KEMENANGAN TP (${tpWins.length})`);
  say(`   lompatan harga: p50 +${p(markups, 0.5).toFixed(0)}% · p90 +${p(markups, 0.9).toFixed(0)}% · maks +${p(markups, 0.999).toFixed(0)}%`);
  say(`   likuiditas keluar: p10 $${Math.round(p(liqs, 0.1)).toLocaleString()} · p50 $${Math.round(p(liqs, 0.5)).toLocaleString()}`);
  const tipis = tpWins.filter((c) => (c.liqUsd ?? 0) < 50_000);
  say(`   TP di pool < $50k: ${tipis.length}/${tpWins.length} (${(100 * tipis.length / tpWins.length).toFixed(0)}%)`);
  say(`   CATATAN JUJUR: laporan ini membuktikan model biaya bertahan, BUKAN bahwa harga itu benar-benar bisa dijual.`);
  say(`   Untuk itu dibutuhkan mark SETELAH keluar (harga 1–5 menit pasca-jual) — belum terekam untuk semua penutupan.`);
}

// ── HARGA PASCA-KELUAR (2026-10-11) ─────────────────────────────────────────────────────────
// Bagian ini menjawab pertanyaan yang tidak bisa dijawab model biaya: apakah harga saat keluar
// BENAR-BENAR bisa dijual? Caranya: bandingkan harga keluar dengan mark 1/3/5 menit sesudahnya.
// Kalau harga lenyap (retensi rendah), "keuntungan" itu tidak pernah bisa diuangkan.
interface TraceRow {
  token: string; symbol?: string; variant: string; reason: string; exitPriceUsd: number;
  closedAt: string; marks: Array<{ t: number; p: number | null; liq: number | null }>; complete?: boolean;
}
function loadTraces(): TraceRow[] {
  const out: TraceRow[] = [];
  for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("rh-events-") && x.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
      if (!line.includes('"rh-mark-after"')) continue;
      try { out.push(JSON.parse(line) as TraceRow); } catch { /* baris rusak */ }
    }
  }
  return out;
}

const traces = loadTraces();
say(`\n── HARGA PASCA-KELUAR (${traces.length} jejak terekam)`);
if (!traces.length) {
  say("   belum ada jejak: perekaman baru aktif setelah lane berjalan dengan kode ini (1/3/5 menit pasca-jual).");
} else {
  // SATU RUMUS (2026-10-11): peringkasan retensi memakai fungsi bersama `summarizeTraces` — sama
  // persis dengan yang dipakai review 08:00 dan kartu dashboard. Sebelumnya berkas ini punya salinan
  // inline-nya sendiri, dan dua salinan matematika yang sama adalah cara paling mudah membuat tiga
  // angka berbeda untuk satu kenyataan.
  for (const s of summarizeTraces(traces)) {
    say(`   ${s.reason.padEnd(14)} n=${String(s.n).padStart(3)} · retensi p50 ${(s.p50 * 100).toFixed(0)}% · p10 ${(s.p10 * 100).toFixed(0)}% · harga lenyap (<50%): ${s.vanished} (${((100 * s.vanished) / s.n).toFixed(0)}%)`);
  }
  // Dampak "harga jujur": nilai ulang SETIAP penutupan berjejak memakai mark pasca-keluar.
  const key = (r: { variant: string; token: string }): string => `${r.variant}|${r.token}`;
  const traceByKey = new Map<string, TraceRow[]>();
  for (const t of traces) {
    const k = key(t);
    if (!traceByKey.has(k)) traceByKey.set(k, []);
    traceByKey.get(k)!.push(t);
  }
  let deltaAll = 0;
  let matched = 0;
  const deltaByCohort = new Map<string, number>();
  for (const c of closes) {
    const list = traceByKey.get(key(c));
    if (!list) continue;
    const closer = list.reduce<TraceRow | null>((best, t) => {
      const d = Math.abs(Date.parse(t.closedAt) - Date.parse(c.ts));
      if (d > 5_000) return best;
      if (!best) return t;
      return Math.abs(Date.parse(best.closedAt) - Date.parse(c.ts)) <= d ? best : t;
    }, null);
    if (!closer) continue;
    const r = retentionOfShared(closer);
    if (r == null) continue;
    matched++;
    const proceeds = (c as CloseRow & { proceedsUsd?: number }).proceedsUsd ?? Math.max(0, c.pnlUsd + c.notionalUsd);
    const delta = proceeds * (r - 1);
    deltaAll += delta;
    const coh = c.cohort ?? "(tanpa kohort)";
    deltaByCohort.set(coh, (deltaByCohort.get(coh) ?? 0) + delta);
  }
  if (matched) {
    say(`   penilaian ulang di mark pasca-keluar (${matched} penutupan berjejak): selisih ${"$"}${deltaAll.toFixed(2)} dari net tercatat`);
    for (const [coh, d] of [...deltaByCohort.entries()].sort((a, b) => a[1] - b[1])) {
      const list = closes.filter((c) => (c.cohort ?? "(tanpa kohort)") === coh);
      const net = list.reduce((a, c) => a + c.pnlUsd, 0);
      say(`      ${coh.padEnd(26)} net tercatat ${money(net).padStart(9)} → di mark pasca-keluar ${money(net + d).padStart(9)} (selisih ${money(d)})`);
    }
    say(`   BACA: bila angka "di mark pasca-keluar" jauh lebih buruk, sebagian keuntungan hanya ada di atas kertas.`);
  }
}


const large = results.filter((r) => r.n >= 20);
if (large.length >= 2) {
  const best = [...large].sort((a, b) => b.net2 - a.net2)[0]!;
  const worst = [...large].sort((a, b) => a.net2 - b.net2)[0]!;
  say(`\n── PERBANDINGAN (model k=2, arm n≥20)`);
  say(`   terbaik ${best.name} ${money(best.net2 / best.n)}/trade · terburuk ${worst.name} ${money(worst.net2 / worst.n)}/trade`);
}

const text = lines.join("\n");
console.log(text);
const out = join(config.logDir, `rh-realism-${new Date().toISOString().slice(0, 10)}.md`);
try { writeFileSync(out, `${text}\n`); console.log(`\nDisimpan: ${out}`); } catch { /* best-effort */ }
void mean; void bootstrapDiffCI; void DEX_FEE_PCT; void GAS_USD;
