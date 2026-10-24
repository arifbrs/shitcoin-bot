/**
 * LOWCAP HUNTER — loop filter dua chain.
 * Masukan : logs/hunter/in-<tanggal>.json  { chain, token, symbol, mcapUsd, liquidityUsd, traders[] }
 * Keluaran: logs/hunter/gmgnimportall-<tanggal>.json   (semua yang lolos, siap impor)
 *           logs/hunter/tier-{S,A,B,C}-<tanggal>.json   (per tier)
 * Aturan  : mcap <1jt · liq <50rb · top trader ROI >300% & winrate >60% (30 hari)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RULES, passesToken, scoreToken, tierOf, type Scored, type TokenSnap, type TraderSnap } from "./filters.js";

const dir = "logs/hunter";
const date = new Date().toISOString().slice(0, 10);
type InRow = TokenSnap & { traders?: TraderSnap[] };

function main(): void {
  mkdirSync(dir, { recursive: true });
  const inFile = `${dir}/in-${date}.json`;
  if (!existsSync(inFile)) {
    console.log(`  [hunter] tidak ada masukan: ${inFile} — tulis kandidat dari GMGN ke berkas itu dulu`);
    return;
  }
  const rows = JSON.parse(readFileSync(inFile, "utf8")) as InRow[];
  const scored: Scored[] = rows.map((r) => scoreToken(r, r.traders ?? [])).filter((s) => passesToken(s.token));
  scored.sort((a, b) => b.score - a.score);

  // PEMBANDING: tiga varian aturan dihitung pada data yang sama, agar keputusan bisa diambil
  // setelah data cukup — bukan dari tiga token. Label utama tetap aturan ketat (RULES).
  const ruleSets: Record<string, (t: TraderSnap) => boolean> = {
    or: (t) => t.windowDays >= RULES.windowDays && (t.roiPct > RULES.roiMinPct || t.winratePct > RULES.winrateMinPct),
    soft: (t) => t.windowDays >= RULES.windowDays && t.roiPct > 150 && t.winratePct > 55,
    strict: (t) => t.windowDays >= RULES.windowDays && t.roiPct > RULES.roiMinPct && t.winratePct > RULES.winrateMinPct,
  };
  const variants: Record<string, Array<{ symbol: string; smart: number; tier: string; best: { roiPct: number; winratePct: number } | null }>> = {};
  for (const [name, fn] of Object.entries(ruleSets)) {
    variants[name] = scored.map((s) => {
      const smart = s.traders.filter(fn).sort((a, b) => b.roiPct - a.roiPct);
      const score = smart.length ? smart.length * (smart.reduce((x, y) => x + y.roiPct, 0) / smart.length) : 0;
      const best = smart[0] ? { roiPct: smart[0].roiPct, winratePct: smart[0].winratePct } : null;
      return { symbol: s.token.symbol, smart: smart.length, tier: tierOf(smart.length, score), best };
    });
  }
  const out = { ts: Date.now(), rules: RULES, chains: [...new Set(scored.map((s) => s.token.chain))], tokens: scored, variants };
  writeFileSync(`${dir}/gmgnimportall-${date}.json`, JSON.stringify(out, null, 2));
  for (const tier of ["S", "A", "B", "C"] as const) {
    const list = scored.filter((s) => s.tier === tier);
    writeFileSync(`${dir}/tier-${tier}-${date}.json`, JSON.stringify({ tier, count: list.length, tokens: list }, null, 2));
  }
  console.log(`  [hunter] masuk ${rows.length} → lolos filter ${scored.length} · ` +
    ["S", "A", "B", "C"].map((t) => `${t}=${scored.filter((s) => s.tier === t).length}`).join(" "));
  console.log(`  [hunter] keluaran: gmgnimportall-${date}.json + tier-*.json (${dir})`);
}

main();
