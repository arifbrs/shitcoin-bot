/**
 * VERDICT KOHORT — jawaban "apakah efeknya nyata?" dari data yang SUDAH ada, bukan menunggu n besar.
 *
 * Kenapa tak perlu menunggu lama: sebagian arm punya GATE ENTRY IDENTIK dan hanya berbeda aturan
 * keluar (perisai −30%/−50% vs kontrol). Karena gerbangnya sama, arm-arm itu membuka TOKEN YANG
 * SAMA → bisa dibandingkan BERPASANGAN per token. Uji berpasangan membuang variasi antar-token
 * (yang paling besar di meme coin), sehingga efek kecil pun terbaca dengan sampel jauh lebih sedikit.
 *
 * Yang dihitung:
 *   1. Berpasangan  : uji tanda (exact binomial) atas selisih PnL per token + rata-rata selisih.
 *   2. Tak berpasangan: bootstrap CI 95% selisih rata-rata (band vs longgar) + estimasi n yang
 *      dibutuhkan untuk daya 80% pada efek sebesar yang teramati.
 * Semua angka dari ledger (void dikecualikan). Nol API.
 *
 * Run: npm run rh:verdict      (tulis juga logs/rh-verdict-<tanggal>.md)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
// `mean` diimpor sebagai meanOf: di dalam loop berpasangan ada variabel lokal bernama `mean`
// (rata-rata selisih pasangan) yang dulu menutupi fungsi impor — persis jenis kesalahan yang
// sekarang ditangkap typecheck, bukan dibiarkan jadi angka salah.
import { signTest, bootstrapCI, bootstrapDiffCI, mean as meanOf, sd as sdOf, requiredNPerArm, concentration } from "./stats.js";

interface CloseRow { ts: string; variant: string; token: string; symbol?: string; life?: number; pnlUsd?: number; reason: string; cohort?: string }

const VOID = new Set<string>();
try {
  const j = JSON.parse(readFileSync(join(config.logDir, "rh-paper-voids.json"), "utf8")) as { voids?: Array<{ variant: string; token: string; ts: string }> };
  for (const v of j.voids ?? []) VOID.add(`${v.variant}|${v.token}|${v.ts}`);
} catch { /* belum ada koreksi */ }

const closes: CloseRow[] = [];
for (const f of readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
  for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!line.includes('"RH_CLOSE"')) continue;
    try {
      const r = JSON.parse(line) as CloseRow;
      if (VOID.has(`${r.variant}|${r.token}|${r.ts}`)) continue;
      closes.push(r);
    } catch { /* baris rusak */ }
  }
}

/** Arm dengan GATE ENTRY identik — pembanding berpasangan yang sah. */
const GROUPS: Array<{ name: string; gate: string; arms: Record<string, string> }> = [
  {
    name: "PERISAI vs KONTROL (gate band rasio 0.70–0.85)",
    gate: "band",
    arms: { "tanpa perisai (v21,v32)": "v21-band-inti|v32-shield-kontrol-band", "perisai −30% (v29)": "v29-shield30-band", "perisai −50% (v30)": "v30-shield50-band" },
  },
  {
    name: "PERISAI vs KONTROL (gate longgar, tanpa batas rasio)",
    gate: "loose",
    arms: { "tanpa perisai (v23,v26,v33)": "v23-band-lebar|v26-band-kontrol|v33-shield-kontrol-longgar", "perisai −30% (v31)": "v31-shield30-longgar" },
  },
  {
    name: "KOHORT-5A: STOP lebih ketat (gate masuk band IDENTIK)",
    gate: "band",
    arms: {
      "stop −40% KONTROL (v40)": "v40-stop40-kontrol",
      "stop −30% (v39)": "v39-stop30-band",
      "stop −25% (v38)": "v38-stop25-band",
      "stop −20% (v37)": "v37-stop20-band",
    },
  },
  {
    name: "KOHORT-5B: PITA LIKUIDITAS (gate lain identik)",
    gate: "loose",
    arms: {
      "kontrol ≥$15k tanpa batas (v43)": "v43-liq-kontrol",
      "pita $25–100k (v41)": "v41-liq25-100",
      "pita $25–50k (v42)": "v42-liq25-50",
    },
  },
  {
    name: "KOHORT-6: keluar karena LIKUIDITAS vs kontrol (gate pita $25–50k identik)",
    gate: "loose",
    arms: {
      "KONTROL keluar harga saja (v44)": "v44-liqexit-kontrol",
      "likuiditas −50% (v45)": "v45-liqdrop50",
      "likuiditas −35% (v46)": "v46-liqdrop35",
    },
  },
];

const lines: string[] = [];
const say = (s = ""): void => { lines.push(s); };
const money = (v: number): string => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

// Uji tanda + bootstrap kini dari stats.ts (satu sumber, diuji oleh stats.test.ts).

say("═══ VERDICT KOHORT (dari ledger, void dikecualikan) ═══");
say(`penutupan sah: ${closes.length}`);

for (const grp of GROUPS) {
  say(`\n── ${grp.name}`);
  const armRows = new Map<string, Map<string, CloseRow[]>>();
  for (const [label, ids] of Object.entries(grp.arms)) {
    const set = new Set(ids.split("|"));
    const byToken = new Map<string, CloseRow[]>();
    for (const c of closes.filter((c) => set.has(c.variant))) {
      const k = `${c.token}|${c.life ?? 1}`;
      if (!byToken.has(k)) byToken.set(k, []);
      byToken.get(k)!.push(c);
    }
    armRows.set(label, byToken);
    const n = [...byToken.values()].reduce((a, l) => a + l.length, 0);
    const pnl = [...byToken.values()].flat().reduce((a, c) => a + (c.pnlUsd ?? 0), 0);
    say(`   ${label.padEnd(28)} n=${String(n).padStart(3)} · net ${money(pnl).padStart(9)}${n ? ` · rata-rata ${money(pnl / n)}/trade` : ""}`);
  }
  // GERBANG SAMPEL & KONSENTRASI (2026-10-11) — dua hal yang membuat hasil positif bisa menipu:
  // (a) net yang bergantung pada satu mint, (b) sampel yang jauh dari cukup. Keduanya dicetak
  // dengan angka, supaya "belum terbukti" punya alasan yang bisa diperiksa.
  for (const [label, byToken] of armRows) {
    const pnls = [...byToken.values()].flat().map((c) => c.pnlUsd ?? 0);
    if (pnls.length < 5) continue;
    const conc = concentration(pnls);
    const need = requiredNPerArm(meanOf(pnls), sdOf(pnls));
    const rapuh = conc.topSharePct > 0.5 && conc.netExclTop1 <= 0;
    say(`      ${label}: top-1 ${(conc.topSharePct * 100).toFixed(0)}% dari net · tanpa top-1 ${money(conc.netExclTop1)}${rapuh ? " · RAPUH (net bergantung satu mint)" : ""} · perlu ≈${Number.isFinite(need) ? need : "∞"} trade/arm untuk membuktikan efek sebesar ini`);
  }
  const labels = Object.keys(grp.arms);
  for (let i = 1; i < labels.length; i++) {
    const a = armRows.get(labels[0]!)!, b = armRows.get(labels[i]!)!;
    const diffs: number[] = [];
    for (const [k, rows] of b) {
      if (!a.has(k)) continue; // hanya token yang DIBUKA KEDUA arm (gate identik → seharusnya banyak)
      const pa = a.get(k)!.reduce((x, c) => x + (c.pnlUsd ?? 0), 0);
      const pb = rows.reduce((x, c) => x + (c.pnlUsd ?? 0), 0);
      diffs.push(pb - pa);
    }
    if (!diffs.length) { say(`   ${labels[i]} vs ${labels[0]}: belum ada token yang tumpang tindih → belum bisa dinilai berpasangan`); continue; }
    const wins = diffs.filter((d) => d > 0).length;
    const ties = diffs.filter((d) => d === 0).length;
    const p = signTest(wins, diffs.length - ties);
    const mean = diffs.reduce((x, d) => x + d, 0) / diffs.length;
    const [lo, hi] = bootstrapCI(diffs);
    const verdict = diffs.length - ties < 6 ? "BELUM CUKUP (pasangan <6)" : p <= 0.01 ? "KUAT (p≤0,01)" : p <= 0.05 ? "INDIKASI (p≤0,05)" : "BELUM TERBUKTI";
    say(`   ${labels[i]} vs ${labels[0]}: ${diffs.length} pasangan token (${ties} seri) · menang ${wins} · rata-rata selisih ${money(mean)} · p=${p.toFixed(3)} → ${verdict}`);
    if (Number.isFinite(lo)) say(`      bootstrap 95% selisih: ${money(lo)} … ${money(hi)}`);
    // TAK BERPASANGAN (2026-10-11): untuk arm pita likuiditas, tumpang tindih token memang kecil
    // (arm hanya menerima band-nya sendiri), sehingga uji berpasangan tak bisa menjawab. Di sini
    // dijawab dengan bootstrap dua-grup + perkiraan n yang dibutuhkan.
    if (diffs.length - ties < 6) {
      const pa = [...a.values()].flat().map((c) => c.pnlUsd ?? 0);
      const pb = [...b.values()].flat().map((c) => c.pnlUsd ?? 0);
      const [lo2, hi2] = bootstrapDiffCI(pb, pa);
      const selisih = meanOf(pb) - meanOf(pa);
      const need = requiredNPerArm(selisih, Math.sqrt((sdOf(pb) ** 2 + sdOf(pa) ** 2) / 2));
      if (Number.isFinite(lo2)) {
        say(`      TAK BERPASANGAN (pasangan terlalu sedikit): selisih rata-rata ${money(selisih)}/trade · bootstrap 95% ${money(lo2)} … ${money(hi2)}${lo2 > 0 ? " → arah positif konsisten" : hi2 < 0 ? " → arah negatif konsisten" : " → masih melewati nol: belum konklusif"} · perlu ≈${Number.isFinite(need) ? need : "∞"} trade/arm`);
      }
    }
  }
}

// Tak berpasangan: band (semua arm band) vs longgar (semua arm longgar)
const bandArms = new Set(["v21-band-inti", "v29-shield30-band", "v30-shield50-band", "v32-shield-kontrol-band", "v22-band-fresh", "v27-band-volpita", "v28-band-top10"]);
const looseArms = new Set(["v23-band-lebar", "v26-band-kontrol", "v31-shield30-longgar", "v33-shield-kontrol-longgar"]);
const band = closes.filter((c) => bandArms.has(c.variant)).map((c) => c.pnlUsd ?? 0);
const loose = closes.filter((c) => looseArms.has(c.variant)).map((c) => c.pnlUsd ?? 0);
say(`\n── BAND (semua arm) vs LONGGAR (semua arm) — tak berpasangan`);
say(`   band   n=${band.length} · rata-rata ${band.length ? money(band.reduce((a, b) => a + b, 0) / band.length) : "—"}/trade`);
say(`   longgar n=${loose.length} · rata-rata ${loose.length ? money(loose.reduce((a, b) => a + b, 0) / loose.length) : "—"}/trade`);
if (band.length >= 5 && loose.length >= 5) {
  const mb = band.reduce((a, b) => a + b, 0) / band.length;
  const ml = loose.reduce((a, b) => a + b, 0) / loose.length;
  const rand = (arr: number[]): number => arr[(Math.random() * arr.length) | 0]!;
  const means: number[] = [];
  for (let i = 0; i < 4000; i++) {
    let sb = 0, sl = 0;
    for (let j = 0; j < band.length; j++) sb += rand(band);
    for (let j = 0; j < loose.length; j++) sl += rand(loose);
    means.push(sb / band.length - sl / loose.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(4000 * 0.025)]!, hi = means[Math.floor(4000 * 0.975)]!;
  say(`   selisih rata-rata ${money(mb - ml)} · bootstrap 95%: ${money(lo)} … ${money(hi)}${lo > 0 ? " → arah positif KONSISTEN (band lebih baik)" : hi < 0 ? " → arah negatif konsisten (band lebih buruk)" : " → masih melewati nol: belum konklusif"}`);
  const sd = Math.sqrt(band.concat(loose).reduce((a, x) => a + (x - (mb + ml) / 2) ** 2, 0) / (band.length + loose.length - 1));
  const effect = Math.abs(mb - ml) || 0.01;
  const needPerArm = Math.ceil((2 * (1.96 + 0.84) ** 2 * sd ** 2) / effect ** 2);
  say(`   SD per trade $${sd.toFixed(2)} · efek teramati ${money(effect)}/trade → perkiraan n yang dibutuhkan ≈ ${needPerArm} trade per arm (daya 80%)`);
} else say(`   (butuh ≥5 trade per arm untuk bootstrap — sekarang ${band.length} vs ${loose.length})`);

const text = lines.join("\n");
console.log(text);
const out = join(config.logDir, `rh-verdict-${new Date().toISOString().slice(0, 10)}.md`);
try { writeFileSync(out, `${text}\n`); console.log(`\nDisimpan: ${out}`); } catch { /* best-effort */ }
