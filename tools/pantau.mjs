#!/usr/bin/env node
/**
 * PANTAU — satu perintah untuk menjawab "apakah live sudah profit?" dari log append-only,
 * tanpa menyentuh proses yang sedang berjalan.
 *
 *   node tools/pantau.mjs            → ringkasan hari ini
 *   node tools/pantau.mjs --all      → gabung semua live-exec-*.jsonl yang ada
 *
 * Epoch: "pra-fix" vs "pasca-fix" dipisah pada 2026-08-22T15:00Z (22:00 WIB) — momen deploy
 * rebase overlay + HWM reset + konfirmasi WS. Semua metrik kualitas (capture rate dsb.) hanya
 * bermakna pada epoch pasca-fix; angka pra-fix disertai sebagai baseline pembanding saja.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "logs";
const FIX_EPOCH_ISO = "2026-08-22T15:00:00Z"; // deploy perbaikan HWM fantasi + WS confirm
const FIX_EPOCH = Date.parse(FIX_EPOCH_ISO);
const ALL = process.argv.includes("--all");

const fmtSol = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(4)}◎`;
const pct = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);

function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function collectExecFiles() {
  if (!ALL) {
    const today = new Date().toISOString().slice(0, 10);
    const files = [join(LOG_DIR, `live-exec-${today}.jsonl`)];
    // Sertakan kemarin kalau hari ini masih kosong (baru lewat tengah malam).
    if (!existsSync(files[0])) {
      const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
      files.unshift(join(LOG_DIR, `live-exec-${y}.jsonl`));
    }
    return files.filter((f) => existsSync(f));
  }
  return readdirSync(LOG_DIR)
    .filter((f) => /^live-exec-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort()
    .map((f) => join(LOG_DIR, f));
}

function tsMs(r) {
  const t = r.ts ? Date.parse(r.ts) : 0;
  return Number.isFinite(t) ? t : 0;
}

// ── 1. LOT LIVE (uang nyata) ────────────────────────────────────────────────
function lotStats() {
  const raw = JSON.parse(readFileSync(join(LOG_DIR, "live-lots.json"), "utf8"));
  const lots = Array.isArray(raw) ? raw : (raw.lots ?? []);
  const closed = lots.filter((l) => l.state === "closed" && (l.spentSol ?? 0) > 0);
  const open = lots.filter((l) => l.state !== "closed");
  const rows = closed.map((l) => ({
    net: (l.proceedsSol ?? 0) + (l.rentReclaimedSol ?? 0) - (l.spentSol ?? 0),
    spent: l.spentSol ?? 0,
    heldSec: l.closedAt && l.openedAt ? Math.round((l.closedAt - l.openedAt) / 1000) : null,
    sells: (l.sells ?? []).length,
  }));
  const spent = rows.reduce((a, r) => a + r.spent, 0);
  const ret = spent + rows.reduce((a, r) => a + r.net, 0);
  const wins = rows.filter((r) => r.net > 0).length;
  const reasons = {};
  for (const l of closed) {
    const last = (l.sells ?? [])[l.sells.length - 1];
    const reason = last?.reason ?? l.lastErr ?? "?";
    reasons[reason] = reasons[reason] ?? { n: 0, net: 0 };
    reasons[reason].n++;
    reasons[reason].net += (l.proceedsSol ?? 0) + (l.rentReclaimedSol ?? 0) - (l.spentSol ?? 0);
  }
  return { total: lots.length, closed: rows.length, open: open.length, spent, ret, wins, rows, reasons };
}

// ── 2. EPOCH: pisahkan pra/pasca-fix berdasarkan openedAt lot ───────────────
function toMs(v) {
  const n = Number(v ?? 0);
  return n > 1e12 ? n : n * 1000; // beberapa lot lama menyimpan detik, bukan ms
}

function epochLots() {
  const raw = JSON.parse(readFileSync(join(LOG_DIR, "live-lots.json"), "utf8"));
  const all = Array.isArray(raw) ? raw : (raw.lots ?? []);
  const tradable = all.filter((l) => l.state === "closed" && (l.spentSol ?? 0) > 0);
  return {
    pre: tradable.filter((l) => toMs(l.openedAt) <= FIX_EPOCH),
    post: tradable.filter((l) => toMs(l.openedAt) > FIX_EPOCH),
  };
}

function summarizeLots(list) {
  const rows = list.map((l) => ({ net: (l.proceedsSol ?? 0) + (l.rentReclaimedSol ?? 0) - (l.spentSol ?? 0) }));
  const net = rows.reduce((a, r) => a + r.net, 0);
  const wins = rows.filter((r) => r.net > 0).length;
  return { n: rows.length, net, wins, wr: rows.length ? (wins / rows.length) * 100 : 0 };
}

// ── 3. LATENCY + leg konfirmasi ─────────────────────────────────────────────
function latency(rows) {
  const buys = rows.filter((r) => (r.type || r.kind) === "buy" && typeof r.ms === "number");
  const cut = FIX_EPOCH;
  const post = buys.filter((r) => tsMs(r) > cut);
  const mss = post.map((r) => r.ms);
  const viaWs = post.filter((r) => r.confirmVia === "ws").length;
  const viaPoll = post.filter((r) => r.confirmVia === "poll").length;
  const unknown = post.length - viaWs - viaPoll;
  return { n: post.length, p50: med(mss), p90: mss.length ? [...mss].sort((a, b) => a - b)[Math.floor(mss.length * 0.9)] : null, viaWs, viaPoll, unknown };
}

// ── 4. CAPTURE RATE pasca-fix (ticks × settled) ─────────────────────────────
function captureRate() {
  // HANYA ticks pasca-fix: sebelum deploy rebase-overlay, execPeakGainPct bisa fantasi
  // (+1600% dari basis menyusut) dan memasukkannya ke sini mengulang kebohongan yang sama.
  const tickFiles = readdirSync(LOG_DIR).filter((f) => /^ticks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const settledNet = new Map(); // tradeId → net%
  for (const f of collectExecFiles()) {
    for (const r of readJsonl(f)) {
      if ((r.type || r.kind) === "settled" && typeof r.netPct === "number" && tsMs(r) > FIX_EPOCH)
        settledNet.set(r.tradeId, r.netPct);
    }
  }
  const lastTick = new Map();
  for (const f of tickFiles) {
    for (const r of readJsonl(join(LOG_DIR, f))) {
      if ((r.armId ?? "") !== "live") continue;
      if (tsMs(r) <= FIX_EPOCH) continue; // era bug HWM — peak-nya tidak boleh dipercaya
      lastTick.set(r.tradeId, r); // baris terakhir per trade = kondisi akhir
    }
  }
  const pairs = [];
  for (const [tid, t] of lastTick) {
    const peak = t.execPeakGainPct;
    const real = settledNet.get(tid);
    if (peak == null || real == null || peak <= 5) continue;
    pairs.push({ sym: t.symbol, peak, real, cap: real / peak });
  }
  const caps = pairs.map((p) => p.cap).sort((a, b) => a - b);
  const medCap = med(caps);
  const goodPairs = pairs.filter((p) => p.peak >= 15);
  return { n: pairs.length, medCap, bigN: goodPairs.length, bigMedianPeak: med(goodPairs.map((p) => p.peak)), bigMedianReal: med(goodPairs.map((p) => p.real)) };
}

// ── cetak ────────────────────────────────────────────────────────────────────
const files = collectExecFiles();
let execRows = [];
for (const f of files) execRows = execRows.concat(readJsonl(f));

const lots = lotStats();

console.log("═══════════════ PANTAU LIVE ═══════════════");
console.log(`sumber: ${files.map((f) => f.split("/").pop()).join(", ")}`);
console.log("");

console.log("── DOMPET LIVE (semua lot tertutup) ──");
const wrAll = lots.closed ? ((lots.wins / lots.closed) * 100).toFixed(0) : "0";
const net = lots.ret - lots.spent;
console.log(`lot tertutup ${lots.closed} · terbuka ${lots.open} · modal ${lots.spent.toFixed(4)}◎ → balik ${lots.ret.toFixed(4)}◎`);
console.log(`NET ${fmtSol(net)} (${lots.spent > 0 ? pct((net / lots.spent) * 100) : "-"}) · winrate ${lots.wins}/${lots.closed} = ${wrAll}%`);

console.log("");
console.log("── SEJARAH PENUH (settled events, semua file — sumber kebenaran kumulatif) ──");
// live-lots.json DIPANGKAS sweeper (lot lama dibuang), jadi ringkasan berbasis lot
// underreporting. Settled events di live-exec-*.jsonl bersifat append-only: dedupe per
// tradeId (baris terakhir menang), NEVER_FILLED tanpa modal bukan trade.
{
  const seen = new Map();
  const allFiles = readdirSync(LOG_DIR).filter((f) => /^live-exec-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => join(LOG_DIR, f));
  for (const f of allFiles) {
    for (const r of readJsonl(f)) {
      if ((r.type || r.kind) !== "settled") continue;
      if (r.tradeId) seen.set(r.tradeId, r); else seen.set(`${f}:${r.ts}`, r);
    }
  }
  const trades = [...seen.values()].filter((r) => !(r.reason === "NEVER_FILLED" && !(r.spentSol > 0)));
  const net = trades.reduce((a, r) => a + (r.netSol ?? 0), 0);
  const wins = trades.filter((r) => (r.netSol ?? 0) >= 0).length;
  const byDay = new Map();
  for (const r of trades) {
    const d = (r.ts ?? "").slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + (r.netSol ?? 0));
  }
  console.log(`total: ${trades.length} trade · NET ${fmtSol(net)} · WR ${wins}/${trades.length} = ${trades.length ? ((wins / trades.length) * 100).toFixed(0) : 0}%`);
  for (const [d, v] of [...byDay.entries()].sort()) console.log(`  ${d}: ${fmtSol(v)}`);
}

console.log("");
console.log("── EPOCH ──");
const { pre: preLots, post: postLots } = epochLots();
const sPre = summarizeLots(preLots);
const sPost = summarizeLots(postLots);
if (sPre.n === 0 && sPost.n > 0) {
  // live-lots.json hanya menyimpan lot yang belum terlalu lama settle (sweeper memangkasnya),
  // jadi lot era-bug biasanya sudah tidak ada di file — pembanding pra-fix sering kosong.
  console.log(`pra-fix  (< ${FIX_EPOCH_ISO}): lot sudah dipangkas dari file oleh sweeper — baseline lihat riwayat analisis`);
} else {
  console.log(`pra-fix  (< ${FIX_EPOCH_ISO}): ${String(sPre.n).padStart(3)} lot · NET ${fmtSol(sPre.net)} · WR ${sPre.wr.toFixed(0)}%`);
}
console.log(`pasca-fix(≥ ${FIX_EPOCH_ISO}): ${String(sPost.n).padStart(3)} lot · NET ${fmtSol(sPost.net)} · WR ${sPost.wr.toFixed(0)}%   ← inilah angka penentu`);

console.log("");
console.log("── ALASAN EXIT (net per alasan, semua epoch) ──");
const reasonRows = Object.entries(lots.reasons).sort((a, b) => b[1].n - a[1].n);
for (const [reason, v] of reasonRows.slice(0, 8)) {
  console.log(`${reason.padEnd(22)} ${String(v.n).padStart(3)}×  NET ${fmtSol(v.net)}`);
}

console.log("");
console.log("── LATENCY BUY (pasca-fix) ──");
const lat = latency(execRows);
if (lat.n) {
  console.log(`n=${lat.n} · p50=${((lat.p50 ?? 0) / 1000).toFixed(2)}s · p90=${((lat.p90 ?? 0) / 1000).toFixed(2)}s`);
  console.log(`leg konfirmasi: ws=${lat.viaWs} poll=${lat.viaPoll} tanpa-telemetri=${lat.unknown}${lat.viaWs === 0 && lat.viaPoll === 0 ? "  (belum ada trade pasca-deploy telemetri)" : ""}`);
  if (lat.viaPoll > lat.viaWs * 3 && lat.viaWs > 0) console.log("  ⚠ polling mendominasi — websocket kemungkinan tidak tersambung, periksa wss endpoint");
} else {
  console.log("belum ada buy pasca-fix");
}

console.log("");
console.log("── CAPTURE RATE WINNER (pasca-fix, ticks live) ──");
const cap = captureRate();
if (cap.bigN >= 5) {
  console.log(`posisi peak≥15%: n=${cap.bigN} · median peak ${cap.bigMedianPeak?.toFixed(0)}% → median realisasi ${cap.bigMedianReal?.toFixed(0)}%`);
  console.log(`capture ratio median: ${(cap.medCap * 100)?.toFixed(0)}%  ← patokan lama era-bug: <10%. Sehat kalau ≥40%`);
} else {
  console.log(`sampel belum cukup (${cap.bigN}/5 posisi peak≥15%) — tunggu trade bertambah`);
}

console.log("");
console.log("── VONIS ──");
if (sPost.n < 30) {
  console.log(`SAMPEL KURANG: ${sPost.n}/30 lot pasca-fix. Jangan ubah ukuran/threshold sekarang — biarkan data menumpuk.`);
} else {
  const verdict =
    sPost.net > 0 && sPost.wr >= 45
      ? "✅ pasca-fix POSITIF dengan sampel cukup — layak pertimbangkan naik ukuran pelan-pelan"
      : sPost.net > -0.02
        ? "🟡 pasca-fix hampir impas — biaya tetap 0,01◎ masih dominan; evaluasi latency dulu sebelum menyerah"
        : "❌ pasca-fix masih negatif dengan sampel cukup — jangan naikkan modal; bedah alasan exit teratas di atas";
  console.log(verdict);
}
