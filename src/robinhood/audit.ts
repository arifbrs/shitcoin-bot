/**
 * AUDIT P&L LANE ROBINHOOD — hitung ulang SETIAP trade dari harga mentah + model biaya, lalu
 * bandingkan dengan angka yang tercatat. Read-only, offline; nol panggilan API.
 *
 * PRINSIP: skrip ini SENGAJA tidak meng-import kode dari paper.ts. Definisi varian, rumus
 * slippage, dan aturan haircut ditulis ulang di sini — audit yang memakai kode yang diaudit
 * tidak membuktikan apa pun. Kalau paper.ts berubah, angka di sini HARUS ikut diubah manual.
 *
 * METODE (revisi 2026-10-07 malam — versi pertama salah menandai 9 varian karena membandingkan
 * equity state (akumulasi SEMUA close) terhadap Σ close ber-label life saja):
 *
 *   REPLAY URUT-WAKTU per varian. Equity di paper lane adalah REALIZED-ONLY (naik/turun hanya
 *   saat posisi ditutup), jadi urutan close merekonstruksi equity pada setiap titik secara persis.
 *   Life-2 ditangani di replay: label `life` yang naik → modal direset ke $100 pada titik itu.
 *   Dari replay ini dua hal diperiksa sekaligus:
 *     1. SIZING tiap entry == min(risk$5/stop%, cap$25, equity_saat_itu × 50%, 2% liq) — cap
 *        EQUITY kini ikut dihitung, yang sebelumnya luput dan menghasilkan alarm palsu.
 *     2. IDENTITY equity akhir == $100 + Σ pnl (dalam life berjalan), dibandingkan dgn state.
 *   Baris close lama tanpa label `life` diperlakukan sebagai life-1 (satu-satunya bagian history
 *   yang boleh tidak berlabel), dan jumlahnya dilaporkan.
 *
 * Yang diperiksa lain: aritmetika pnl penuh (fee 0.30%/sisi, gas $0.01/sisi, slippage 1%+impak),
 * pelanggaran batas risiko (stop nominal + biaya), sanity (open−close == posisi state, harga mati,
 * tidak ada tutup-dobel).
 *
 * Exit code: 0 = semua cocok; 1 = ada selisih (jangan percaya laporan sampai dibedah).
 *
 * Run: npm run rh:audit
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const DEX_FEE_PCT = 0.003, GAS_USD = 0.01, RISK_USD = 5, MAX_NOTIONAL = 25, START_EQUITY = 100;
const slipPct = (notional: number, liq: number | null): number =>
  Math.min(0.08, 0.01 + (liq && liq > 0 ? Math.min(0.06, (notional / liq) * 0.5) : 0.06));

/** STOP% tiap varian — HARUS dicocokkan manual dengan paper.ts bila varian berubah. */
const STOP: Record<string, number> = {
  "v01-konservatif": 18, "v02-momentum": 20, "v03-seimbang": 25, "v04-dip": 22, "v05-agresif-baru": 30,
  "v06-sniper": 35, "v07-runner": 30, "v08-moonshot": 40, "v09-scalp": 12, "v10-degen": 45,
};

interface Row { [k: string]: unknown }
const files = readdirSync(config.logDir).filter((f) => f.startsWith("rh-paper-") && f.endsWith(".jsonl")).sort();
/**
 * Baris yang sudah ditandai VOID (penutupan ganda, lihat src/robinhood/fix-dupes.ts) DIKECUALIKAN
 * dari perhitungan. Riwayat tidak dihapus — hanya tidak dihitung — supaya koreksi buku tetap bisa
 * diaudit: berkas voids menyebut baris mana dan kenapa.
 */
function loadVoidKeys(): Set<string> {
  const path = join(config.logDir, "rh-paper-voids.json");
  const keys = new Set<string>();
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { voids?: Array<{ variant: string; token: string; ts: string }> };
    for (const v of j.voids ?? []) keys.add(`${v.variant}|${v.token}|${v.ts}`);
  } catch { /* belum ada koreksi — normal */ }
  return keys;
}
const VOID_KEYS = loadVoidKeys();
const seenLifeKeys = new Set<string>();
const opens: Row[] = [], closes: Row[] = [], lives: Row[] = [];
let reconciledRows = 0;
const reconciledCloseKeys = new Set<string>();
for (const f of files) {
  let text: string;
  try { text = readFileSync(join(config.logDir, f), "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Row;
      // Baris hasil REKONSILIASI STARTUP (ditulis lane saat menemukan selisih ledger↔state akibat
      // proses berhenti di antara simpan & catat). ATURAN PARITY (2026-10-09):
      //   • OPEN rekonsiliasi  → IKUT dihitung (state memang memegang posisi itu; tanpa ini hitungan
      //     buka−tutup jadi kurang dari posisi state).
      //   • CLOSE rekonsiliasi → dibuang BERSAMA open pasangannya (state sudah menutupnya tetapi
      //     barisnya hilang; kalau hanya CLOSE yang dibuang, selisihnya berpindah ke arah lain).
      if (r["reconciled"] === true) {
        reconciledRows++;
        if (r["action"] === "RH_CLOSE") reconciledCloseKeys.add(`${r["variant"]}|${r["token"]}|${r["life"] ?? 1}`);
        else if (r["action"] === "RH_OPEN") opens.push(r);
        continue;
      }
      if (r["action"] === "RH_OPEN") {
        // Baris ber-void juga bisa berupa OPEN ("posisi hantu": ledger mencatat buka, state tidak
        // pernah menyimpannya karena proses berhenti sebelum simpan — lihat fix-dupes/2026-10-09).
        if (!VOID_KEYS.has(`${r["variant"]}|${r["token"]}|${r["ts"]}`)) opens.push(r);
      }
      else if (r["action"] === "RH_CLOSE") {
        // Baris ber-void (penutupan ganda) tidak dihitung — lihat loadVoidKeys().
        if (!VOID_KEYS.has(`${r["variant"]}|${r["token"]}|${r["ts"]}`)) closes.push(r);
      }
      // RH_LIFE = sumber kebenaran transisi life (Life-2). Dibaca langsung, bukan disimpulkan dari
      // label close: varian yang baru restart dan BELUM trading tidak punya close ber-label life
      // baru — tanpa event ini, replay salah mengira ia masih di life lama (terjadi live 2026-10-07).
      // DEDUPE (2026-10-09): transisi yang sama pernah tercatat 2–3× (state belum tersimpan saat
      // proses berhenti, lalu siklus berikutnya mengulang transisinya). Replay harus menghitung
      // transisi SEKALI per life — kalau tidak, equity direset berkali-kali dan identity melenceng.
      else if (r["action"] === "RH_LIFE") {
        const k = `${r["variant"]}|${r["life"]}`;
        if (!seenLifeKeys.has(k)) { seenLifeKeys.add(k); lives.push(r); }
      }
    } catch { /* baris terpotong — abaikan */ }
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : NaN);
const tsOf = (r: Row): number => Date.parse(String(r["ts"] ?? "")) || 0;
let maxDiff = 0, compared = 0, sizeMismatch = 0, lifeMismatch = 0, legacyNoLife = 0, equitySkip = 0, sizingDerived = 0, legacyZeroExit = 0;
const breaches: Array<{ v: string; sym: string; loss: number; intended: number; reason: string }> = [];
const replayResult = new Map<string, { equity: number; life: number }>();

// ── REPLAY per varian (urut waktu, life-aware lewat event RH_LIFE) ─────────────
const lifeEvents = new Map<string, Array<{ ts: number; life: number }>>();
for (const l of lives) {
  const v = String(l["variant"] ?? "");
  const life = typeof l["life"] === "number" ? (l["life"] as number) : null;
  if (!v || life == null) continue;
  const arr = lifeEvents.get(v) ?? [];
  arr.push({ ts: tsOf(l), life });
  lifeEvents.set(v, arr);
}
const byVariant = new Map<string, Row[]>();
for (const c of closes) {
  const v = String(c["variant"] ?? "");
  const arr = byVariant.get(v);
  if (arr) arr.push(c); else byVariant.set(v, [c]);
}
for (const [variant, rows] of byVariant) {
  const stop = STOP[variant];
  if (stop == null) continue;
  rows.sort((a, b) => tsOf(a) - tsOf(b));
  const evs = (lifeEvents.get(variant) ?? []).sort((a, b) => a.ts - b.ts);
  /** Life yang berlaku pada waktu t menurut event RH_LIFE (fallback: 1). */
  const lifeAt = (t: number): number => {
    let life = 1;
    for (const e of evs) { if (e.ts <= t) life = e.life; else break; }
    return life;
  };

  // PASS A — deret equity realized: gabungan event life (reset ke $100) + close (pnl), urut waktu.
  const series: Array<{ ts: number; equity: number }> = [];
  {
    const timeline: Array<{ ts: number; kind: "life" | "close"; life?: number; pnl?: number; labeledLife?: number | null }> = [
      ...evs.map((e) => ({ ts: e.ts, kind: "life" as const, life: e.life })),
      ...rows.map((c) => ({ ts: tsOf(c), kind: "close" as const, pnl: num(c["pnlUsd"]), labeledLife: typeof c["life"] === "number" ? (c["life"] as number) : null })),
    ].sort((a, b) => a.ts - b.ts);
    let equity = START_EQUITY;
    let life = 1;
    for (const item of timeline) {
      if (item.kind === "life") {
        // Reset life WAJIB jadi titik seri tersendiri — tanpa ini, titik terakhir masih membawa
        // equity life lama dan replay melaporkan angka yang salah (terjadi live 2026-10-07:
        // v07 replay=$3.87 vs state=$100 karena titik reset tidak tercatat).
        life = item.life as number; equity = START_EQUITY;
        series.push({ ts: item.ts, equity });
        continue;
      }
      if (item.labeledLife == null) legacyNoLife++;
      else if (item.labeledLife !== life) { life = item.labeledLife; equity = START_EQUITY; } // fallback bila event hilang
      equity += item.pnl ?? 0;
      series.push({ ts: item.ts, equity });
    }
    if (!series.length) series.push({ ts: 0, equity: START_EQUITY });
  }
  const equityBefore = (ts: number): number => {
    let eq = START_EQUITY;
    for (const p of series) { if (p.ts <= ts) eq = p.equity; else break; }
    return eq;
  };

  // PASS B — verifikasi per close.
  for (const c of rows) {
    const open = [...opens].reverse().find((x) => x["variant"] === variant && x["token"] === c["token"] && tsOf(x) <= tsOf(c));
    if (!open) continue;

    const notional = num(c["notionalUsd"]);
    const entryPrice = num(open["entryPriceUsd"]);
    const exitPrice = num(c["exitPriceUsd"]); // sudah final (haircut sudah diterapkan paper.ts)
    const liqIn = typeof open["liqUsd"] === "number" ? (open["liqUsd"] as number) : null;
    const liqOut = typeof c["liqUsd"] === "number" ? (c["liqUsd"] as number) : liqIn;

    // 1) aritmetika penuh
    if (notional > 0 && entryPrice > 0) {
      // BARIS WARISAN (sebelum 2026-10-10): `exitPrice.toFixed(10)` membulatkan harga rug sekecil
      // 2,16e-12 menjadi 0 — harga tercatat tak lagi menjelaskan PnL yang dihitung dari harga asli.
      // Baris seperti ini TIDAK bisa diverifikasi ulang dari ledger, jadi dihitung terpisah dan
      // dilewati secara terbuka (bukan dipaksa cocok, bukan disembunyikan). Penulisan ke depan
      // memakai toPrecision(12), jadi kelas ini berhenti di sini.
      if (exitPrice <= 1e-10 && num(c["pnlUsd"]) > -notional * 0.98) legacyZeroExit++;
      else {
        const slipIn = slipPct(notional, liqIn);
        const tokens = (notional - (notional * (DEX_FEE_PCT + slipIn) + GAS_USD)) / entryPrice;
        const gross = tokens * exitPrice;
        const slipOut = slipPct(gross, liqOut);
        const pnl = gross * (1 - DEX_FEE_PCT - slipOut) - GAS_USD - notional;
        const diff = Math.abs(pnl - num(c["pnlUsd"]));
        maxDiff = Math.max(maxDiff, diff); compared++;
        if (diff > 0.01) console.log(`  SELISIH: ${variant} ${String(c["symbol"])} hitung=$${pnl.toFixed(6)} tercatat=$${String(c["pnlUsd"])} beda=$${diff.toFixed(6)}`);
      }
    } else equitySkip++;

    // 2) SIZING: notional == min(risk/stop, 25, equity_SAAT-ENTRY×50%, 2% liq).
    // Equity saat entry diambil dari baris OPEN (`equityAtEntryUsd`, dicatat sejak 2026-10-07
    // malam); baris OPEN lama direkonstruksi dari deret close SEBELUM waktu open — bukan dari
    // equity saat close (itu yang bikin 9 alarm palsu).
    const loggedEq = typeof open["equityAtEntryUsd"] === "number" ? (open["equityAtEntryUsd"] as number) : null;
    const eqAtEntry = loggedEq ?? equityBefore(tsOf(open));
    if (loggedEq == null) sizingDerived++;
    const caps = [RISK_USD / (stop / 100), MAX_NOTIONAL, eqAtEntry * 0.5];
    if (liqIn != null && liqIn > 0) caps.push(liqIn * 0.02);
    const expected = Math.min(...caps);
    // Toleransi $0,005: baris OPEN lama mencatat equityAtEntryUsd hanya 2 desimal, dan cap 50%
    // dihitung dari equity penuh → beda maksimum ~$0,005 yang BUKAN pelanggaran aturan.
    if (Math.abs(notional - expected) > 0.005) {
      sizeMismatch++;
      console.log(`  SIZING ANEH: ${variant} ${String(c["symbol"])} notional=$${notional} harap=$${expected.toFixed(4)} (equity saat entry $${eqAtEntry.toFixed(2)}${loggedEq == null ? " [rekonstruksi]" : ""}, liq $${liqIn ?? "?"})`);
    }

    // 3) batas risiko
    const intended = notional * (stop / 100) + notional * 0.026 + GAS_USD * 2;
    const loss = -num(c["pnlUsd"]);
    if (loss > intended + 0.25) breaches.push({ v: variant, sym: String(c["symbol"] ?? "?"), loss, intended, reason: String(c["reason"] ?? "?") });
  }
  // Hasil replay: equity setelah titik terakhir di timeline; life terakhir menurut event RH_LIFE.
  const lastPoint = series[series.length - 1] as { ts: number; equity: number };
  replayResult.set(variant, { equity: lastPoint.equity, life: lifeAt(Number.MAX_SAFE_INTEGER) });
}

// ── BANDINGKAN hasil replay dgn state ─────────────────────────────────────────
const state = JSON.parse(readFileSync(join(config.logDir, "rh-paper-state.json"), "utf8")) as {
  variants?: Record<string, { equityUsd?: number; positions?: unknown[]; life?: number }>;
};
const openCount = Object.values(state.variants ?? {}).reduce((a, v) => a + (v.positions?.length ?? 0), 0);
for (const [id, v] of Object.entries(state.variants ?? {})) {
  const r = replayResult.get(id);
  if (!r) continue;
  const stateLife = v.life ?? 1;
  if (r.life !== stateLife) { lifeMismatch++; console.log(`  LIFE BEDA: ${id} replay life ${r.life} vs state ${stateLife}`); continue; }
  if (Math.abs(r.equity - (v.equityUsd ?? 0)) > 0.01) {
    lifeMismatch++;
    console.log(`  EQUITY BEDA: ${id} (life ${r.life}) replay=$${r.equity.toFixed(2)} state=$${(v.equityUsd ?? 0).toFixed(2)} (beda $${Math.abs(r.equity - (v.equityUsd ?? 0)).toFixed(2)})`);
  }
}
const livesDone = Object.values(state.variants ?? {}).reduce((a, v) => a + ((v.life ?? 1) - 1), 0);

// Tutup-dobel = dua penutupan untuk (varian|token) dalam ≤5 MENIT. Re-entry setelah cooldown 6 jam
// adalah perilaku SAH, jadi pasangan berjeda jam tidak boleh dihitung sebagai anomali (koreksi
// 2026-10-09: cek lama menghitung semua pasangan, sehingga selamanya merah padahal bukan bug).
const dupeTimes = new Map<string, number[]>();
for (const c of closes) {
  const k = `${c["variant"]}|${c["token"]}`;
  if (!dupeTimes.has(k)) dupeTimes.set(k, []);
  dupeTimes.get(k)!.push(Date.parse(String(c["ts"] ?? "")) || 0);
}
let dupCount = 0;
for (const list of dupeTimes.values()) {
  list.sort((a, b) => a - b);
  for (let i = 1; i < list.length; i++) if (list[i]! - list[i - 1]! <= 5 * 60_000) { dupCount++; break; }
}

// PARITY PER-KUNCI (2026-10-09). Hitungan global (open−close) sering menyesatkan: satu kunci
// "life lama" bisa menutupi kunci lain yang kurang. Di sini tiap kunci (varian|token|life)
// dibandingkan sendiri: sisa positif = posisi yang seharusnya masih dipegang.
// Selisih yang PUNYA PENJELASAN TERCATAT (baris rekonsiliasi untuk kunci itu) dihitung terpisah —
// tidak disembunyikan, tapi juga tidak lagi membuat seluruh pemeriksaan merah tanpa alasan jelas.
// Hanya OPEN RIIL yang boleh "dimakan" CLOSE rekonsiliasi. OPEN rekonsiliasi adalah baris
// penyeimbang yang memang ditulis untuk posisi yang DIPEGANG state — ia harus tetap terhitung.
const opensEffective = opens.filter((o) => {
  const key = `${o["variant"]}|${o["token"]}|${o["life"] ?? 1}`;
  return o["reconciled"] === true || !reconciledCloseKeys.has(key);
});
const keyResidual = new Map<string, number>();
for (const o of opensEffective) keyResidual.set(`${o["variant"]}|${o["token"]}|${o["life"] ?? 1}`, (keyResidual.get(`${o["variant"]}|${o["token"]}|${o["life"] ?? 1}`) ?? 0) + 1);
for (const c of closes) keyResidual.set(`${c["variant"]}|${c["token"]}|${c["life"] ?? 1}`, (keyResidual.get(`${c["variant"]}|${c["token"]}|${c["life"] ?? 1}`) ?? 0) - 1);
let expectedOpen = 0, explainedKeys = 0;
// (perhitungan per-kunci ditangani blok di bawah)
const stateHeld = new Map<string, number>();
for (const [id, vs] of Object.entries((state.variants ?? {}) as Record<string, { positions?: Array<{ token: string }>; life?: number }>)) {
  for (const p of vs.positions ?? []) stateHeld.set(`${id}|${p.token}|${vs.life ?? 1}`, (stateHeld.get(`${id}|${p.token}|${vs.life ?? 1}`) ?? 0) + 1);
}
// KOREKSI 2026-10-09: sisa positif per kunci BUKAN otomatis anomali — ia cocok dengan posisi yang
// memang dipegang state (re-entry dalam life yang sama: buka → tutup → buka lagi). Yang benar-benar
// salah adalah SELISIH antara sisa itu dan jumlah yang dipegang, per kunci.
let unexplainedGap = 0;
const unexplainedList: string[] = [];
for (const [key, r] of keyResidual) {
  if (r <= 0) continue;
  expectedOpen += r;
  const heldHere = stateHeld.get(key) ?? 0;
  const gap = r - heldHere;
  if (gap <= 0) continue;
  if (reconciledCloseKeys.has(key)) { explainedKeys += gap; continue; }
  unexplainedGap += gap;
  unexplainedList.push(`${key} (+${gap} vs state ${heldHere})`);
}
// Sisi sebaliknya: state memegang lebih banyak daripada yang dicatat ledger.
let extraHeld = 0;
for (const [key, held] of stateHeld) extraHeld += Math.max(0, held - Math.max(0, keyResidual.get(key) ?? 0));
const parityOk = unexplainedGap === 0 && extraHeld === 0;
console.log(`sumber: ${files.length} berkas rh-paper · ${opens.length} buka · ${closes.length} tutup · ${livesDone} life selesai (Life-2)${legacyNoLife ? ` · ${legacyNoLife} close lama tanpa label life dianggap life-1` : ""}${reconciledRows ? ` · ${reconciledRows} baris rekonsiliasi (dihitung terpisah, tidak diaudit)` : ""}`);
console.log(`\n1) ARITMETIKA   : ${compared} trade dihitung ulang (${equitySkip} dilewati: data harga tak lengkap${legacyZeroExit ? ` · ${legacyZeroExit} dilewati: harga keluar tercatat 0 karena presisi log lama, tak bisa diverifikasi ulang` : ""}) · selisih max $${maxDiff.toExponential(2)} ${maxDiff <= 0.01 ? "→ COCOK (selisih = pembulatan log)" : "→ TIDAK COCOK"}`);
console.log(`2) IDENTITY     : ${lifeMismatch ? `${lifeMismatch} varian BEDA (replay vs state)` : `semua varian: equity replay == $100 + Σpnl per-life`}`);
console.log(`3) SIZING       : ${sizeMismatch ? `${sizeMismatch} menyimpang` : "semua notional == min(risk$5/stop%, cap $25, 50% equity-SAAT-ENTRY, 2% liq)"}${sizingDerived ? ` (${sizingDerived} entry lama: equity direkonstruksi)` : ""}`);
console.log(`5) SANITY       : ledger bilang ${expectedOpen} posisi · state memegang ${[...stateHeld.values()].reduce((a, b) => a + b, 0)} ${parityOk ? "OK" : "BEDA"}${explainedKeys ? ` · ${explainedKeys} dijelaskan baris rekonsiliasi` : ""}${unexplainedList.length ? ` · TAK TERJELASKAN: ${unexplainedList.slice(0, 3).join(", ")}` : ""}${extraHeld ? ` · ${extraHeld} posisi di state tanpa catatan ledger` : ""} · (varian,token) tutup-dobel=${dupCount}`);

console.log(`\n4) BATAS RISIKO : ${breaches.length} dari ${closes.filter((c) => num(c["pnlUsd"]) < 0).length} trade rugi melebihi stop nominal + biaya`);
const totalLoss = closes.filter((c) => num(c["pnlUsd"]) < 0).reduce((a, c) => a + num(c["pnlUsd"]), 0);
const totalPnl = closes.reduce((a, c) => a + num(c["pnlUsd"]), 0);
if (breaches.length) {
  const byReason: Record<string, { n: number; excess: number }> = {};
  let excess = 0;
  for (const b of breaches) {
    const e = b.loss - b.intended;
    excess += e;
    byReason[b.reason] ??= { n: 0, excess: 0 };
    byReason[b.reason]!.n++; byReason[b.reason]!.excess += e;
  }
  for (const [r, x] of Object.entries(byReason)) console.log(`   ${r.padEnd(10)} ${x.n} trade · kelebihan $${x.excess.toFixed(2)}`);
  console.log(`   total kelebihan di luar niat $5: $${excess.toFixed(2)}`);
  console.log(`   sebab: stop_loss = harga GAP melewati stop antar-mark; pool_mati = rugi penuh; mark_basi = haircut 50%; liq_shield = perisai likuiditas kohort-4 (keluar sebelum stop)`);
}
console.log(`\nRINGKAS: total rugi $${totalLoss.toFixed(2)} · PnL bersih $${totalPnl.toFixed(2)} (mark-based, belum divalidasi pasar nyata)`);

// Gagal bila: aritmetika melenceng, identity melenceng, sizing menyimpang, ATAU ada kunci posisi
// yang tak terjelaskan (selisih yang punya baris rekonsiliasi TIDAK menggagalkan — itu sudah
// dilaporkan dengan nama kuncinya di baris SANITY, jadi tidak ada yang disembunyikan).
const failed = maxDiff > 0.01 || lifeMismatch > 0 || sizeMismatch > 0 || !parityOk;
process.exit(failed ? 1 : 0);
