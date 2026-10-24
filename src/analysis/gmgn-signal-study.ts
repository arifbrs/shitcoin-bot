/**
 * STUDI SINYAL GMGN (round-3 B2) — `npm run gmgn:signal-study`. OFFLINE, nol kuota.
 *
 * Mereproduksi angka laporan (n, missing, median) lalu menambahkan KONTROL yang diminta audit:
 *   C1 bobot setara per token (dedupe token/hari) — anti konsentrasi
 *   C2 kelayakan entry riil: delay observasi vs trigger (feed telat = entry mustahil)
 *   C3 konsentrasi: pangsa sinyal di 3 token teratas
 *   C4 join wallet point-in-time: skor wallet dengan scoredAt ≤ tradeAt (bukan skor terkini)
 * Tidak ada pemilihan pemenang: semua chain × tipe × horizon dilaporkan.
 */
import "dotenv/config";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readObservationJournal, observationDir } from "../discovery/gmgn-signal-observations.js";
import { config } from "../config.js";

const med = (a: number[]): number | null => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null);
const mean = (a: number[]): number | null => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const f2 = (v: number | null): string => (v == null ? "—" : v.toFixed(2) + "%");

/** Bootstrap 95% CI (LCG ber-seed → deterministik & dapat direproduksi). */
export function bootstrapCi(values: number[], resamples = 2000, seed = 42): { meanLo: number; meanHi: number; medLo: number; medHi: number } {
  let s = seed >>> 0;
  const rnd = (): number => (s = (s * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;
  const means: number[] = [], meds: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample: number[] = [];
    for (let k = 0; k < values.length; k++) sample.push(values[Math.floor(rnd() * values.length)]!);
    means.push(sample.reduce((x, y) => x + y, 0) / sample.length);
    meds.push([...sample].sort((x, y) => x - y)[Math.floor(sample.length / 2)]!);
  }
  means.sort((x, y) => x - y); meds.sort((x, y) => x - y);
  const q = (arr: number[], p: number): number => arr[Math.floor(p * (arr.length - 1))]!;
  return { meanLo: q(means, 0.025), meanHi: q(means, 0.975), medLo: q(meds, 0.025), medHi: q(meds, 0.975) };
}

export function study(now = Date.now(), dir = observationDir()): string[] {
  const j = readObservationJournal(dir, false);
  const lines: string[] = ["═══ B2 STUDI SINYAL — reproduksi + kontrol (harga, bukan profit) ═══", "",
    `journal: ${j.signals.length} sinyal · ${j.marks.length} mark · malformed=${j.malformed} duplicate=${j.duplicates}`,
    "Seleksi (dibekukan di kolektor): tipe 12 (smart-money) & 20 (KOL), mc_min $10k, entry = mark0 ≤5m,",
    "horizon 15m/60m/360m/1440m, mark dari pasangan DexScreener terkunci / info token GMGN.",
    "CATATAN reproduksi: journal bergerak (mark terisi bertahap), jadi snapshot laporan lama ≠ angka kini;",
    "file studi ini bertanda waktu — bandingkan hanya file dengan rentang waktu yang sama.", ""];

  const groups = new Map<string, typeof j.signals>();
  for (const s of j.signals) {
    const k = `${s.chain} · tipe ${s.signalType}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }

  for (const [name, signals] of groups) {
    const marks = new Map(j.marks.map((m) => [m.markId, m]));
    lines.push(`── ${name}: n=${signals.length}, token unik=${new Set(signals.map((s) => s.mint)).size}, UTC-hari=${new Set(signals.map((s) => new Date(s.observedAt).toISOString().slice(0, 10))).size}`);
    // DEKOMPOSISI delay (round-4): delay total = usia-kejadian-saat-request + antrean lokal.
    // cycle 15 menit TIDAK bisa menjelaskan delay berjam-jam → bila ageAtRequest dominan, usia
    // itu ada di SISI PROVIDER (kejadian tua saat diterbitkan / daftar bergerak lambat / truncation).
    const ages: number[] = [], queues: number[] = [];
    for (const s of signals) {
      if (s.triggerAt != null) {
        const age = s.requestStartedAt - s.triggerAt;
        if (age >= 0) ages.push(age);
      }
      const q = s.observedAt - s.requestStartedAt;
      if (q >= 0) queues.push(q);
    }
    const totalDelay = signals.map((s) => s.observationDelayMs).filter((v): v is number => v != null && v >= 0);
    const feasibleByAge = ages.filter((d) => d <= 300_000).length;
    const pct = (arr: number[], p: number): string => (arr.length ? (med([...arr].sort((x, y) => x - y).slice(Math.floor(p * (arr.length - 1)), Math.floor(p * (arr.length - 1)) + 1))! / 60_000).toFixed(1) + "m" : "?");
    const freshOneCycle = ages.filter((d) => d <= 15 * 60_000).length;
    lines.push(`   delay total (observedAt−triggerAt) med=${totalDelay.length ? (med(totalDelay)! / 60_000).toFixed(1) + "m" : "?"} — DEKOMPOSISI: usia-saat-request p10/p50/p90 = ${pct(ages, 0.1)}/${pct(ages, 0.5)}/${pct(ages, 0.9)} (≤5m: ${feasibleByAge}/${ages.length}; ≤15m=1 siklus: ${freshOneCycle}) · antrean-lokal med=${queues.length ? (med(queues)! / 1000).toFixed(1) + "s" : "?"}`,
      `   → usia dominan di sisi provider. ${freshOneCycle > 0 ? `PERINGATAN DIMENSI LAIN: ${freshOneCycle} sinyal berusia ≤15 mnt = feed TIDAK sepenuhnya basa — segmen segar ada; klaim 'tidak bisa dieksekusi' berlaku untuk mayoritas, bukan seluruh feed.` : "tidak ada sinyal berusia ≤15 mnt pada sampel ini — feed murni mengirim kejadian tua (atau semantik trigger berbeda = UNKNOWN)."}`);
    // C3: konsentrasi
    const byToken = new Map<string, number>();
    for (const s of signals) byToken.set(s.mint, (byToken.get(s.mint) ?? 0) + 1);
    const top3 = [...byToken.values()].sort((a, b) => b - a).slice(0, 3).reduce((x, y) => x + y, 0);
    lines.push(`   konsentrasi: 3 token teratas memegang ${top3}/${signals.length} sinyal (${signals.length ? ((top3 / signals.length) * 100).toFixed(0) : "?"}%)`);
    // missing accounting
    const reasons: Record<string, number> = {};
    const ids = new Set(signals.map((s) => s.signalId));
    for (const m of j.marks) if (ids.has(m.signalId) && m.status === "MISSING") reasons[m.reason ?? "?"] = (reasons[m.reason ?? "?"] ?? 0) + 1;
    lines.push(`   missing: ${JSON.stringify(reasons)}`);
    // horizon × [semua | dedupe-token] — C1. Baris "entry" (h=0) tidak punya return (definisi),
    // jadi ia menampilkan jumlah mark entry berstatus OBSERVED, bukan median return.
    for (const h of [0, 15, 60, 360, 1440]) {
      const ret: number[] = [];
      const retPerToken = new Map<string, number[]>();
      let marksObserved = 0;
      for (const s of signals) {
        if (now < s.observedAt + h * 60_000) continue;
        const m = marks.get(`${s.signalId}:${s.policy.id}:${h}`);
        if (m?.status === "OBSERVED") marksObserved++;
        if (m?.status === "OBSERVED" && m.priceChangePct != null && Number.isFinite(m.priceChangePct)) {
          ret.push(m.priceChangePct);
          const list = retPerToken.get(s.mint) ?? [];
          list.push(m.priceChangePct);
          retPerToken.set(s.mint, list);
        }
      }
      const dedup = [...retPerToken.values()].map((arr) => arr.reduce((x, y) => x + y, 0) / arr.length); // rata-rata token → bobot setara token
      const due = signals.filter((s) => now >= s.observedAt + h * 60_000).length;
      if (h === 0) {
        lines.push(`   entry  due=${due} mark-entry-OBSERVED=${marksObserved}`);
        continue;
      }
      const ci = ret.length >= 5 ? ` · CI95 mean=[${bootstrapCi(ret).meanLo.toFixed(2)}, ${bootstrapCi(ret).meanHi.toFixed(2)}] med=[${bootstrapCi(ret).medLo.toFixed(2)}, ${bootstrapCi(ret).medHi.toFixed(2)}]` : " · CI: n<5 belum bermakna";
      lines.push(`   ${(h ? h + "m" : "entry").padEnd(6)} due=${due} (matured) observed=${ret.length} missing=${due - ret.length - signals.filter((s) => now < s.observedAt + h * 60_000 && marks.has(`${s.signalId}:${s.policy.id}:${h}`)).length} · semua: med=${f2(med(ret))} mean=${f2(mean(ret))} · C1 dedupe-token: med=${f2(med(dedup))} mean=${f2(mean(dedup))}${ci}`);
    }
    lines.push("");
  }

  // C4: join wallet point-in-time (bukan skor terkini yang bocor masa depan)
  lines.push("── C4 join wallet × outcome point-in-time ──");
  const statePath = join(config.logDir, "gmgn-full-watch-state.json");
  const scores = new Map<string, number>(); // wallet → scoredAt terbaru
  if (existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, "utf8")) as { walletQuality?: Record<string, { at: number }> };
      for (const [w, q] of Object.entries(st.walletQuality ?? {})) scores.set(w, Math.max(scores.get(w) ?? 0, q.at));
    } catch { /* state rusak → join = 0, dilaporkan */ }
  }
  let trades = 0, joinable = 0, futureLeak = 0;
  const files = readdirSync(config.logDir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-7);
  for (const f of files) {
    for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
      if (!line.includes('"gmgn-watched-trade"')) continue;
      try {
        const r = JSON.parse(line) as { maker?: string; tradeAt?: number };
        if (!r.maker || typeof r.tradeAt !== "number") continue;
        trades++;
        const scoredAt = scores.get(r.maker);
        if (scoredAt == null) continue;
        if (scoredAt > r.tradeAt) { futureLeak++; continue; } // skor diperoleh SETELAH trade → tidak boleh dipakai
        joinable++;
      } catch { /* baris rusak dilewati */ }
    }
  }
  lines.push(`   trade terpantau (7 hari): ${trades} · skor wallet ada SEBELUM trade: ${joinable} · skor muncul setelah trade (dibuang, anti-leak): ${futureLeak}`,
    `   join memenuhi syarat outcome (skor-≤-trade + mark horizon tersedia): belum bisa dihitung bila < 30 sampel —`,
    `   keputusan: INSUFFICIENT. Skor wallet TIDAK dipromosikan jadi fitur prediktif dari data ini.`);
  lines.push("", "BATAS JUJUR: jendela data masih ±2 hari (journal baru sejak 2026-10-23). Angka -3,01% 60m pada laporan lama",
    "dilaporkan ulang di sini dengan kontrol: bobot setara-token, delay entry riil, konsentrasi. Kesimpulan sementara:",
    "feed sinyal telat (med jam-an) → mayoritas sinyal TIDAK BISA dieksekusi realistis; hasil negatif belum uji-signifikan (n kecil).");
  return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lines = study();
  console.log(lines.join("\n"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `gmgn-signal-study-${day}.md`), lines.join("\n") + "\n");
}
