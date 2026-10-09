/**
 * STUDI ENTRY — fitur saat masuk vs hasil saat keluar, dari trade yang SUDAH terjadi.
 *
 * Kenapa ini ada (owner 2026-10-09: "hasil belum menjanjikan, upgrade dong"):
 * upgrade yang benar bukan menebak parameter baru, tapi mencari pemisah yang TERUKUR. Rekap
 * menunjukkan bentuk masalahnya — ekor rugi gemuk (kelebihan $1.072 di luar niat $5/stop) dan
 * ekor untung tipis (satu token menutupi sisanya). Studi ini menjawab pertanyaan yang lebih tajam:
 * fitur entry MANA yang prediktif untuk mati (pool_mati / ≤−50%) dan mana yang prediktif untuk
 * untung — sehingga gerbang kohort berikutnya punya dasar, bukan selera.
 *
 * Sumber: logs/rh-paper-*.jsonl (RH_OPEN + RH_CLOSE). Join per (varian|token|life) memakai open
 * terakhir sebelum close. Dedupe baris identik. Nol API, nol biaya.
 *
 * Run: npm run rh:study        (tulis logs/rh-study-<tanggal>.md juga)
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

interface OpenRow {
  ts: string; variant: string; token: string; symbol?: string; entryPriceUsd?: number; notionalUsd?: number;
  stopPct?: number; tpPct?: number; maxHoldMin?: number; liqUsd?: number; ageMin?: number;
  vol1hUsd?: number; vol24Usd?: number; buys1h?: number; buyRatio1h?: number;
  gmgnFlags?: string[]; gmgnTop10?: number; gmgnBurn?: string; gmgnBundlerPct?: number | null;
  gmgnDevStatus?: string | null; life?: number; cohort?: string; sources?: string;
}
interface CloseRow {
  ts: string; variant: string; token: string; symbol?: string; reason: string; pnlUsd?: number; pnlPct?: number;
  notionalUsd?: number; stopPct?: number; heldMin?: number; liqUsd?: number; life?: number; cohort?: string;
}

const lines: string[] = [];
const say = (s = ""): void => { lines.push(s); };

function readAll(): { opens: OpenRow[]; closes: CloseRow[]; files: string[] } {
  const files = readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const opens: OpenRow[] = [];
  const closes: CloseRow[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(config.logDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as OpenRow & CloseRow & { action?: string };
        const key = `${r.action}|${r.variant}|${r.token}|${r.ts}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (r.action === "RH_OPEN") opens.push(r as OpenRow);
        else if (r.action === "RH_CLOSE") closes.push(r as CloseRow);
      } catch { /* baris rusak */ }
    }
  }
  return { opens, closes, files };
}

/** Pasangkan setiap close dengan open terakhir sebelum close utk varian+token+life yang sama. */
function joinTrades(opens: OpenRow[], closes: CloseRow[]): Array<{ o: OpenRow; c: CloseRow }> {
  const byKey = new Map<string, OpenRow[]>();
  for (const o of opens) {
    const k = `${o.variant}|${o.token}|${o.life ?? 1}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(o);
  }
  for (const list of byKey.values()) list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const out: Array<{ o: OpenRow; c: CloseRow }> = [];
  for (const c of closes) {
    const list = byKey.get(`${c.variant}|${c.token}|${c.life ?? 1}`) ?? [];
    const before = list.filter((o) => Date.parse(o.ts) <= Date.parse(c.ts));
    const o = before[before.length - 1];
    if (o) out.push({ o, c });
  }
  return out;
}

const money = (v: number): string => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
const pctOf = (a: number, b: number): string => (b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`);

interface Stats { n: number; win: number; pnl: number; dead: number; median: number; p90: number; excess: number }
function stats(trades: Array<{ o: OpenRow; c: CloseRow }>): Stats {
  const pnls = trades.map((t) => t.c.pnlUsd ?? 0).sort((a, b) => a - b);
  const stopShare = trades.reduce((a, t) => a + (t.c.notionalUsd ?? 0) * ((t.c.stopPct ?? 40) / 100), 0);
  return {
    n: trades.length,
    win: trades.filter((t) => (t.c.pnlUsd ?? 0) >= 0).length,
    pnl: trades.reduce((a, t) => a + (t.c.pnlUsd ?? 0), 0),
    dead: trades.filter((t) => t.c.reason === "pool_mati" || (t.c.pnlPct ?? 0) <= -50).length,
    median: pnls[Math.floor(pnls.length / 2)] ?? 0,
    p90: pnls[Math.floor(pnls.length * 0.9)] ?? 0,
    // "niat" stop per trade = notional × stopPct — selisih di atas ini adalah kerugian yang
    // tidak diminta: gap antar-mark, rug, atau haircut mark_basi.
    excess: trades.reduce((a, t) => a + Math.max(0, -((t.c.pnlUsd ?? 0) + (t.c.notionalUsd ?? 0) * ((t.c.stopPct ?? 40) / 100))), 0),
  };
}
const fmtStats = (s: Stats): string =>
  `n=${String(s.n).padStart(3)} · win ${pctOf(s.win, s.n).padStart(4)} · net ${money(s.pnl).padStart(9)} · median ${money(s.median).padStart(8)} · p90 ${money(s.p90).padStart(8)} · mati ${pctOf(s.dead, s.n).padStart(4)} · kelebihan-di-luar-niat $${s.excess.toFixed(0)}`;

function bucketize(trades: Array<{ o: OpenRow; c: CloseRow }>, label: string, pick: (o: OpenRow) => number | null | undefined, edges: number[]): void {
  const withVal = trades.filter((t) => typeof pick(t.o) === "number" && Number.isFinite(pick(t.o)));
  const missing = trades.length - withVal.length;
  say(`\n— ${label} (tanpa data: ${missing})`);
  let lo = -Infinity;
  for (const hi of [...edges, Infinity]) {
    const list = withVal.filter((t) => { const v = pick(t.o) as number; return v >= lo && v < hi; });
    if (list.length) say(`   ${String(lo === -Infinity ? `<${hi}` : hi === Infinity ? `≥${lo}` : `${lo}–${hi}`).padStart(14)}  ${fmtStats(stats(list))}`);
    lo = hi;
  }
}

const { opens, closes, files } = readAll();
const trades = joinTrades(opens, closes);

say(`═══ STUDI ENTRY — fitur masuk vs hasil keluar ═══`);
say(`Berkas: ${files.join(", ")}`);
say(`Open ${opens.length} · Close ${closes.length} · berhasil dipasangkan ${trades.length} (${pctOf(trades.length, closes.length)} dari close)`);
say(`\nTOTAL: ${fmtStats(stats(trades))}`);

const byReason = new Map<string, Array<{ o: OpenRow; c: CloseRow }>>();
for (const t of trades) {
  if (!byReason.has(t.c.reason)) byReason.set(t.c.reason, []);
  byReason.get(t.c.reason)!.push(t);
}
say(`\n— PER ALASAN KELUAR`);
for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const s = stats(list);
  say(`   ${reason.padEnd(14)} ${fmtStats(s)} · median tahan ${(list.reduce((a, t) => a + (t.c.heldMin ?? 0), 0) / list.length).toFixed(0)}m`);
}

bucketize(trades, "LIKUIDITAS POOL saat masuk ($)", (o) => o.liqUsd, [5_000, 15_000, 40_000, 100_000]);
bucketize(trades, "UMUR TOKEN saat masuk (menit)", (o) => o.ageMin, [2, 5, 15, 60, 240]);
bucketize(trades, "RASIO BELI 1 jam", (o) => o.buyRatio1h, [0.5, 0.6, 0.7, 0.85]);
bucketize(trades, "VOLUME 1 jam ($)", (o) => o.vol1hUsd, [1_000, 5_000, 20_000, 100_000]);
bucketize(trades, "TOP-10 HOLDER (fraksi supply)", (o) => o.gmgnTop10, [0.15, 0.25, 0.4, 0.6]);
bucketize(trades, "DEV/FLAG BAHAYA (jumlah flag)", (o) => (o.gmgnFlags ?? []).length, [1, 2]);

say(`\n— PER KOHORT (perbandingan adil: gate berbeda, exit sama)`);
const byCohort = new Map<string, Array<{ o: OpenRow; c: CloseRow }>>();
for (const t of trades) {
  const coh = t.c.cohort ?? t.o.cohort ?? "(tanpa kohort)";
  if (!byCohort.has(coh)) byCohort.set(coh, []);
  byCohort.get(coh)!.push(t);
}
for (const [coh, list] of [...byCohort.entries()].sort()) {
  // Varian PROBE (mis. v34 −5%, hanya untuk membuktikan mekanisme perisai menyala) tidak boleh
  // mengotori rata-rata kohort — ia sengaja keluar hampir seketika dan bukan hipotesis dagang.
  const real = list.filter((t) => !/probe/i.test(String(t.c.variant ?? "")));
  const probes = list.length - real.length;
  say(`   ${coh.padEnd(24)} ${fmtStats(stats(real))}${probes ? ` · (probe dikecualikan: ${probes})` : ""}`);
}

say(`\n— SUMBER DISCOVERY`);
const bySource = new Map<string, Array<{ o: OpenRow; c: CloseRow }>>();
for (const t of trades) {
  const src = t.o.sources ?? "(tak tercatat)";
  if (!bySource.has(src)) bySource.set(src, []);
  bySource.get(src)!.push(t);
}
for (const [src, list] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) say(`   ${src.padEnd(14)} ${fmtStats(stats(list))}`);

say(`\n— AUDIT RUG-SAAT-MASUK (kelengkapan) vs HASIL`);
const auditComplete = trades.filter((t) => (t.o.gmgnFlags ?? []).length >= 0 && typeof t.o.gmgnTop10 === "number" && (t.o.gmgnTop10 as number) > 0);
const auditIncomplete = trades.filter((t) => !(typeof t.o.gmgnTop10 === "number" && (t.o.gmgnTop10 as number) > 0));
say(`   ada data top10 ${fmtStats(stats(auditComplete))}`);
say(`   tanpa data top10 ${fmtStats(stats(auditIncomplete))}`);

say(`\n— KONTRIBUSI EKOR`);
const sorted = [...trades].sort((a, b) => (b.c.pnlUsd ?? 0) - (a.c.pnlUsd ?? 0));
const top10 = sorted.slice(0, Math.max(1, Math.round(sorted.length * 0.1)));
const rest = sorted.slice(top10.length);
say(`   10% teratas (n=${top10.length}): ${money(top10.reduce((a, t) => a + (t.c.pnlUsd ?? 0), 0))} — ${top10.map((t) => `${t.c.symbol}${money(t.c.pnlUsd ?? 0)}`).slice(0, 8).join(" ")}`);
say(`   sisanya (n=${rest.length}): ${money(rest.reduce((a, t) => a + (t.c.pnlUsd ?? 0), 0))}`);
const rugLoss = trades.filter((t) => (t.c.pnlPct ?? 0) <= -90).reduce((a, t) => a + (t.c.pnlUsd ?? 0), 0);
say(`   total dari trade ≤−90% (rug/route hilang): ${money(rugLoss)} dari ${trades.filter((t) => (t.c.pnlPct ?? 0) <= -90).length} trade`);

const text = lines.join("\n");
console.log(text);
const day = new Date().toISOString().slice(0, 10);
const out = join(config.logDir, `rh-study-${day}.md`);
try {
  writeFileSync(out, `${text}\n`);
  appendFileSync(join(config.logDir, "rh-study-ledger.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), trades: trades.length, net: stats(trades).pnl, file: `rh-study-${day}.md` })}\n`);
  console.log(`\nDisimpan: ${out}`);
} catch { /* best-effort */ }
if (!existsSync(out)) console.log("(gagal menyimpan berkas studi)");
