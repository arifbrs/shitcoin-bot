/**
 * STUDI GMGN — dari kandidat GMGN yang tercatat beserta outcome-nya, fitur mana yang
 * benar-benar memisahkan yang naik dari yang rug?
 *
 * Bukan tebakan: baris di sini hasil join `strategy2-candidate` (fitur saat pertama terlihat)
 * dengan `strategy2-outcome` (mcChangePct). Read-only: nol kuota GMGN, tidak menulis state.
 *
 * KENYATAAN DATA (terverifikasi 2026-10-07, jangan diabaikan):
 *  - Horizon nominal (6/24/48) TIDAK bisa dipercaya secara historis: tracker pernah berjalan
 *    telat, jadi satu snapshot segar ditulis ke semua horizon yang due sekaligus (84% mint
 *    ber-multi-horizon punya currentMcUsd identik). Karena itu laporan ini memakai MARK
 *    PERTAMA per kandidat + umur mark sebenarnya, bukan label horizon.
 *  - Sebagian kandidat sudah terotasi keluar dari logs (reset/arsip), sehingga outcome-nya
 *    menganggur tanpa pasangan. Angka kehilangan itu dicetak eksplisit.
 *  - mcChangePct murni MARK; biaya aktual, latency, dan sellability belum diukur.
 *  - Bucket n<25 ditandai "!" (jangan dipakai keputusan). Sampel menumpuk di beberapa jam
 *    yang sama (regim pasar sama) — hipotesis, bukan aturan entry.
 *
 * Run: npm run gmgn:study
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { gmgnCandidateKey, gmgnCohortKey, validExactLedger } from "./analysis/gmgn-evidence.js";

interface Cand {
  chain: string; mint: string; sym: string; source: string; cfg: string; epoch: string;
  firstSeenAt: number; entryMcUsd: number; row: Record<string, unknown>;
}
interface Out {
  cfg: string; epoch: string; firstSeenAt: number; checkedAt: number; ageH: number;
  mcChangePct: number | null; currentMcUsd: number | null; ruggedNow: boolean | null;
}

function eventFiles(): string[] {
  const dirs = [config.logDir];
  try {
    for (const e of readdirSync(config.logDir)) {
      if (!e.startsWith("archive")) continue;
      const p = join(config.logDir, e);
      try { if (statSync(p).isDirectory()) dirs.push(p); } catch { /* skip */ }
    }
  } catch { /* no logs yet */ }
  const files: string[] = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (f.startsWith("events-") && f.endsWith(".jsonl")) files.push(join(d, f));
    } catch { /* skip */ }
  }
  return files.sort();
}

const cands = new Map<string, Cand>();
const outsByCandidate = new Map<string, Out[]>();
let outRows = 0;
let invalidIdentityRows = 0;

for (const f of eventFiles()) {
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { continue; }
  for (const line of text.split("\n")) {
    if (!line.includes("strategy2-")) continue;
    const isCand = line.includes('"strategy2-candidate"');
    const isOut = line.includes('"strategy2-outcome"');
    if (!isCand && !isOut) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const mint = String(r["mint"] ?? "");
    const source = String(r["source"] ?? "unknown");
    if (!mint) continue;
    if (isCand) {
      const key = gmgnCohortKey(r);
      if (!key || !gmgnCandidateKey(r)) { invalidIdentityRows++; continue; }
      const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
      const prev = cands.get(key);
      if (!prev || firstSeenAt < prev.firstSeenAt) {
        cands.set(key, {
          chain: String(r["chain"] ?? "sol"), mint, sym: String(r["sym"] ?? "?"), source, cfg: String(r["cfg"]),
          epoch: String(r["strategy2Epoch"] ?? "unknown"), firstSeenAt, entryMcUsd: Number(r["mcUsd"] ?? 0), row: r,
        });
      }
    } else if (isOut) {
      outRows++;
      const checkedAt = Number(r["checkedAt"] ?? 0);
      const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
      const key = gmgnCandidateKey(r);
      if (!key || !Number.isFinite(checkedAt) || checkedAt < firstSeenAt) { invalidIdentityRows++; continue; }
      const o: Out = {
        cfg: String(r["cfg"] ?? "unknown"), epoch: String(r["strategy2Epoch"] ?? "unknown"),
        firstSeenAt, checkedAt, ageH: (checkedAt - firstSeenAt) / 3_600_000,
        mcChangePct: typeof r["mcChangePct"] === "number" ? r["mcChangePct"] : null,
        currentMcUsd: typeof r["currentMcUsd"] === "number" ? r["currentMcUsd"] : null,
        ruggedNow: typeof r["ruggedNow"] === "boolean" ? r["ruggedNow"] : null,
      };
      const arr = outsByCandidate.get(key);
      if (arr) arr.push(o); else outsByCandidate.set(key, [o]);
    }
  }
}

/** Mark PERTAMA with exact chain/mint/source/cfg/epoch/first-seen. No legacy fallback. */
interface Joined { c: Cand; o: Out; ageH: number }
const joined: Joined[] = [];
let paired = 0;
for (const c of cands.values()) {
  const list = outsByCandidate.get(gmgnCandidateKey(c as unknown as Record<string, unknown>)!);
  if (!list?.length) continue;
  const first = list.reduce((a, b) => (a.checkedAt <= b.checkedAt ? a : b));
  if (first.mcChangePct == null) continue;
  paired++;
  joined.push({ c, o: first, ageH: Number.isFinite(first.ageH) ? first.ageH : NaN });
}

// LEDGER DURABEL (ditulis gmgn-report harian): pasangan kandidat+mark yang sudah diekspor dan
// SELAMAT dari retensi 7 hari stream events (terverifikasi 2026-10-07: events lama memang
// terhapus saat proses pertama menyentuh log.ts). Begitu jendela 7 hari lewat, ini sumber utama.
let ledgerCount = 0;
let excludedLegacyLedger = 0;
{
  const have = new Set(joined.map((j) => gmgnCandidateKey(j.c as unknown as Record<string, unknown>)));
  const ledgerPairs = new Map<string, Record<string, unknown>>();
  try { excludedLegacyLedger = readFileSync(join(config.logDir, "gmgn-study-ledger.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length; } catch { /* none */ }
  try {
    const text = readFileSync(join(config.logDir, "gmgn-study-ledger-v2.jsonl"), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        if (!validExactLedger(r)) { invalidIdentityRows++; continue; }
        const key = gmgnCandidateKey(r)!;
        if (have.has(key)) continue;
        const prev = ledgerPairs.get(key);
        if (!prev || (r.mark as { checkedAt: number }).checkedAt < (prev.mark as { checkedAt: number }).checkedAt) ledgerPairs.set(key, r);
      } catch { /* baris rusak — abaikan */ }
    }
  } catch { /* ledger belum ada */ }
  for (const r of ledgerPairs.values()) {
    const mark = r.mark as Record<string, unknown>;
    if (typeof mark.mcChangePct !== "number" || !Number.isFinite(mark.mcChangePct)) continue;
    const firstSeenAt = r.firstSeenAt as number, checkedAt = mark.checkedAt as number;
    const cfg = String(r.cfg), epoch = String(r.strategy2Epoch), ageH = (checkedAt - firstSeenAt) / 3_600_000;
    joined.push({
      c: { chain: String(r.chain ?? "sol"), mint: String(r.mint), sym: String(r.sym ?? "?"), source: String(r.source), cfg, epoch,
        firstSeenAt, entryMcUsd: Number(r.entryMcUsd ?? 0), row: (r.features ?? {}) as Record<string, unknown> },
      o: { cfg, epoch, firstSeenAt, checkedAt, ageH, mcChangePct: mark.mcChangePct,
        currentMcUsd: typeof mark.currentMcUsd === "number" ? mark.currentMcUsd : null,
        ruggedNow: typeof mark.ruggedNow === "boolean" ? mark.ruggedNow : null }, ageH,
    });
    ledgerCount++;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const q = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[Math.floor(p * (s.length - 1))] as number) : NaN;
};
const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(0)}%` : "—");
const med = (a: number[]): string => (a.length ? `${q(a, 0.5) >= 0 ? "+" : ""}${q(a, 0.5).toFixed(0)}%` : "—");

interface Stats { n: number; medS: string; up: string; g50: string; g100: string; l50: string; dead: string; ageS: string }
function stats(rows: Joined[]): Stats {
  const ch = rows.map((r) => r.o.mcChangePct as number);
  const ages = rows.map((r) => r.ageH).filter((x) => Number.isFinite(x));
  // 'mati' hanya dihitung dari baris yang MEMANG punya data mark (currentMcUsd/ruggedNow);
  // baris ledger lama bisa saja tidak membawanya — jangan hitung mereka sebagai hidup ATAU mati.
  const deadable = rows.filter((r) => r.o.currentMcUsd != null || r.o.ruggedNow != null);
  return {
    n: rows.length,
    medS: med(ch),
    up: pct(ch.filter((x) => x > 0).length, ch.length),
    g50: pct(ch.filter((x) => x >= 50).length, ch.length),
    g100: pct(ch.filter((x) => x >= 100).length, ch.length),
    l50: pct(ch.filter((x) => x <= -50).length, ch.length),
    dead: deadable.length ? pct(deadable.filter((r) => ((r.o.currentMcUsd ?? Number.POSITIVE_INFINITY) < 5_000) || r.o.ruggedNow === true).length, deadable.length) : "—",
    ageS: ages.length ? `${q(ages, 0.5).toFixed(0)}h` : "—",
  };
}
const rowLine = (label: string, s: Stats): string =>
  `  ${(label + " ").padEnd(26)} n=${String(s.n).padStart(4)}${s.n < 25 ? "!" : " "} med ${s.medS.padStart(6)}  up ${s.up.padStart(4)}  ≥+50 ${s.g50.padStart(4)}  ≥+100 ${s.g100.padStart(4)}  ≤−50 ${s.l50.padStart(4)}  mati ${s.dead.padStart(4)}  umur ${s.ageS.padStart(4)}`;

function byNum(rows: Joined[], get: (c: Cand) => number | null, edges: number[]): Array<{ label: string; rows: Joined[] }> {
  const n = edges.length + 1;
  const fmt = (v: number): string => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `${v}`);
  const labels: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) labels.push(`<${fmt(edges[0] as number)}`);
    else if (i === n - 1) labels.push(`≥${fmt(edges[n - 2] as number)}`);
    else labels.push(`${fmt(edges[i - 1] as number)}–${fmt(edges[i] as number)}`);
  }
  const groups = labels.map((label) => ({ label, rows: [] as Joined[] }));
  for (const r of rows) {
    const v = get(r.c);
    if (v == null) continue;
    let i = 0;
    while (i < edges.length && v >= (edges[i] as number)) i++;
    (groups[i] as { rows: Joined[] }).rows.push(r);
  }
  return groups.filter((g) => g.rows.length);
}
function byBool(rows: Joined[], get: (c: Cand) => boolean | null): Array<{ label: string; rows: Joined[] }> {
  return [
    { label: "ya", rows: rows.filter((r) => get(r.c) === true) },
    { label: "tidak", rows: rows.filter((r) => get(r.c) === false) },
  ].filter((g) => g.rows.length);
}
function byCat(rows: Joined[], get: (c: Cand) => string | null): Array<{ label: string; rows: Joined[] }> {
  const m = new Map<string, Joined[]>();
  for (const r of rows) {
    const v = get(r.c) ?? "?";
    const arr = m.get(v);
    if (arr) arr.push(r); else m.set(v, [r]);
  }
  return [...m.entries()].map(([label, rr]) => ({ label, rows: rr })).sort((a, b) => b.rows.length - a.rows.length);
}

const gmgn = joined.filter((r) => r.c.source === "gmgn-trending" || r.c.source === "gmgn-trenches");
const ofSource = (src: string): Joined[] => joined.filter((r) => r.c.source === src);
const cntSource = (src: string): number => [...cands.values()].filter((c) => c.source === src).length;

function section(t: string): void { console.log(`\n═══ ${t} ═══`); }

console.log("STUDI GMGN — fitur kandidat vs mark pertama (mark-based, belum potong fee)");
console.log(`${eventFiles().length} file events (${config.logDir} + arsip). Kandidat unik: ${cands.size}. Baris outcome: ${outRows}. Dipasangkan dari events: ${paired}. Dari ledger durabel: ${ledgerCount}.`);
console.log(`Exact identities only. Invalid/unattributable rows=${invalidIdentityRows}; unsafe v1 ledger rows excluded=${excludedLegacyLedger}. Historical exploratory marks, NOT net profit.`);

section("KUALITAS DATA");
{
  const mintsWithOut = outsByCandidate.size;
  const knownCandidates = new Set([...cands.values()].map((c) => gmgnCandidateKey(c as unknown as Record<string, unknown>)));
  const orphan = [...outsByCandidate.keys()].filter((k) => !knownCandidates.has(k)).length;
  const collapse = (() => {
    let multi = 0, same = 0;
    for (const [, list] of outsByCandidate) {
      if (list.length < 2) continue;
      multi++;
      const horizonsLike = new Set(list.map((o) => o.checkedAt));
      if (horizonsLike.size < list.length) {
        const mcSet = new Set(list.filter((o) => o.currentMcUsd != null).map((o) => o.currentMcUsd));
        if (mcSet.size === 1) same++;
      }
    }
    return { multi, same };
  })();
  console.log(`  pasangan aktif: ${paired} dari events + ${ledgerCount} dari ledger durabel.`);
  if (mintsWithOut) console.log(`  identitas punya outcome di events: ${mintsWithOut} — ${orphan} tanpa kandidat exact; hilang/salah identitas tidak dipasangkan paksa.`);
  else console.log(`  (tidak ada outcome exact di events; ledger exact ${ledgerCount} pasangan.)`);
  if (collapse.multi) console.log(`  mark duplikat dlm satu waktu-check: ${collapse.same}/${collapse.multi} mint multi-mark → ${((collapse.same / collapse.multi) * 100).toFixed(0)}% angka 6/24/48 jam historis sebenarnya SATU snapshot (label horizon tidak bisa dipercaya).`);
  const byPct = {
    "≤8h": joined.filter((r) => r.ageH <= 8).length,
    "8–30h": joined.filter((r) => r.ageH > 8 && r.ageH <= 30).length,
    "30–60h": joined.filter((r) => r.ageH > 30 && r.ageH <= 60).length,
    ">60h": joined.filter((r) => r.ageH > 60).length,
  };
  console.log(`  umur mark pertama aktual: ${JSON.stringify(byPct)} — label horizon tidak dianggap valid tanpa timestamp yang tepat.`);
}

section("CAKUPAN & IDENTITAS LANE");
for (const src of ["gmgn-trending", "gmgn-trenches", "new-launch-dev-holding", "solana-tracker-trending"]) {
  const c = cntSource(src);
  if (!c && !ofSource(src).length) continue;
  console.log(`  ${src.padEnd(24)} kandidat ${String(c).padStart(6)}  ber-mark ${String(ofSource(src).length).padStart(5)} (${c ? ((ofSource(src).length / c) * 100).toFixed(0) : 0}%)`);
}

section("BASELINE PER SUMBER (mark pertama; umur = kapan mark diambil sejak first seen)");
for (const src of ["gmgn-trending", "gmgn-trenches", "new-launch-dev-holding", "solana-tracker-trending"]) {
  const rr = ofSource(src);
  if (rr.length < 5) continue;
  console.log(rowLine(src, stats(rr)));
}

section(`FITUR GMGN (trending+trenches, n=${gmgn.length}) — mark pertama`);
if (!gmgn.length) {
  console.log("  (belum ada pasangan kandidat-outcome untuk lane GMGN di arsip yang tersisa)");
} else {
  console.log(rowLine("SEMUA (baseline)", stats(gmgn)));
  const feats: Array<[string, Array<{ label: string; rows: Joined[] }>]> = [
    ["smartDegenCount", byNum(gmgn, (c) => num(c.row["smartDegenCount"]), [1, 6, 26, 101])],
    ["renownedCount", byNum(gmgn, (c) => num(c.row["renownedCount"]), [1, 6, 26])],
    ["holders", byNum(gmgn, (c) => num(c.row["holders"]), [200, 1_000, 10_000, 100_000])],
    ["mcUsd", byNum(gmgn, (c) => num(c.row["mcUsd"]), [100_000, 250_000, 1_000_000, 10_000_000])],
    ["liqUsd", byNum(gmgn, (c) => num(c.row["liqUsd"]), [20_000, 100_000, 500_000])],
    ["change1h (trending saja)", byNum(gmgn.filter((r) => r.c.source === "gmgn-trending"), (c) => num(c.row["change1h"]), [-5, 0, 5, 20])],
    ["rugRatio", byNum(gmgn, (c) => num(c.row["rugRatio"]), [0.05, 0.15, 0.3])],
    ["bundlerRate", byNum(gmgn, (c) => num(c.row["bundlerRate"]), [0.1, 0.3, 0.6])],
    ["sniperCount", byNum(gmgn, (c) => num(c.row["sniperCount"]), [1, 10, 40])],
    ["isWashTrading", byBool(gmgn, (c) => bool(c.row["isWashTrading"]))],
    ["jupNetBuyers5m", byNum(gmgn, (c) => num(c.row["jupNetBuyers5m"]), [1, 20])],
    ["jupDevBalancePct", byNum(gmgn, (c) => num(c.row["jupDevBalancePct"]), [1, 3, 10])],
    ["xFollowers (trenches saja)", byNum(gmgn.filter((r) => r.c.source === "gmgn-trenches"), (c) => num(c.row["xFollowers"]), [1_000, 10_000, 100_000])],
    ["tgCallCount (trenches saja)", byNum(gmgn.filter((r) => r.c.source === "gmgn-trenches"), (c) => num(c.row["tgCallCount"]), [1, 6])],
    ["launchpad (trenches saja)", byCat(gmgn.filter((r) => r.c.source === "gmgn-trenches"), (c) => (typeof c.row["launchpadPlatform"] === "string" ? (c.row["launchpadPlatform"] as string) : null))],
    ["hasSocials", byBool(gmgn, (c) => bool(c.row["hasSocials"]))],
    ["isBoosted", byBool(gmgn, (c) => bool(c.row["isBoosted"]))],
  ];
  for (const [name, groups] of feats) {
    if (groups.length < 2) continue;
    console.log(`\n  ── ${name}`);
    for (const g of groups) console.log(rowLine(g.label, stats(g.rows)));
  }
}

section("PEMENANG TERATAS (mark pertama, ≥+100%)");
const winners = [...gmgn].filter((r) => (r.o.mcChangePct as number) >= 100)
  .sort((a, b) => (b.o.mcChangePct as number) - (a.o.mcChangePct as number)).slice(0, 10);
if (!winners.length) console.log("  (tidak ada)");
for (const w of winners) {
  console.log(`  ${w.c.sym.padEnd(12)} ${w.c.source.padEnd(14)} +${(w.o.mcChangePct as number).toFixed(0)}% (umur ${w.ageH.toFixed(0)}h)  mc $${Math.round(w.c.entryMcUsd).toLocaleString()}  h=${w.c.row["holders"]}  sdg=${w.c.row["smartDegenCount"] ?? "—"}  ren=${w.c.row["renownedCount"] ?? "—"}  rug=${typeof w.c.row["rugRatio"] === "number" ? (w.c.row["rugRatio"] as number).toFixed(2) : "—"}  bundler=${typeof w.c.row["bundlerRate"] === "number" ? (w.c.row["bundlerRate"] as number).toFixed(2) : "—"}`);
}

section("BUCKET TERBAIK (n≥25) MENURUT P(≥+50%)");
{
  const ranked: Array<{ name: string; label: string; s: Stats }> = [];
  const push = (name: string, groups: Array<{ label: string; rows: Joined[] }>): void => {
    for (const g of groups) {
      const s = stats(g.rows);
      if (s.n >= 25) ranked.push({ name, label: g.label, s });
    }
  };
  push("smartDegenCount", byNum(gmgn, (c) => num(c.row["smartDegenCount"]), [1, 6, 26, 101]));
  push("renownedCount", byNum(gmgn, (c) => num(c.row["renownedCount"]), [1, 6, 26]));
  push("holders", byNum(gmgn, (c) => num(c.row["holders"]), [200, 1_000, 10_000, 100_000]));
  push("mcUsd", byNum(gmgn, (c) => num(c.row["mcUsd"]), [100_000, 250_000, 1_000_000, 10_000_000]));
  push("liqUsd", byNum(gmgn, (c) => num(c.row["liqUsd"]), [20_000, 100_000, 500_000]));
  push("rugRatio", byNum(gmgn, (c) => num(c.row["rugRatio"]), [0.05, 0.15, 0.3]));
  push("bundlerRate", byNum(gmgn, (c) => num(c.row["bundlerRate"]), [0.1, 0.3, 0.6]));
  push("launchpad (trenches)", byCat(gmgn.filter((r) => r.c.source === "gmgn-trenches"), (c) => (typeof c.row["launchpadPlatform"] === "string" ? (c.row["launchpadPlatform"] as string) : null)));
  ranked.sort((a, b) => Number(b.s.g50.replace("%", "")) - Number(a.s.g50.replace("%", "")));
  const base = stats(gmgn);
  console.log(`  baseline P(≥+50%) = ${base.g50} (n=${base.n}, med ${base.medS})`);
  for (const r of ranked.slice(0, 10)) console.log(rowLine(`${r.name}: ${r.label}`, r.s));
}

section("CATATAN");
console.log("  - 'mati' = currentMcUsd < $5k atau ruggedNow=true.");
console.log("  - Belum multivariat — satu fitur dilihat sendirian; pakai sebagai hipotesis, bukan aturan entry.");
console.log("  - Belum dipotong biaya aktual, slippage/latency, atau rug saat rute jual hilang. Friction tetap 3–4% tidak diasumsikan benar.");
console.log("  - Bucket terbaik dipilih setelah melihat hasil: eksplorasi in-sample, bukan bukti edge. Konfigurasi/epoch berbeda tidak eksperimen berpasangan.");
console.log("  - Untuk jawaban yang layak dipercaya, koleksi BARU dgn mark tepat waktu + kandidat yang tidak terotasi (prosesnya harus jalan terus).");
