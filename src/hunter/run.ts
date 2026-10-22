/**
 * LOWCAP HUNTER — loop filter dua chain.
 * Masukan : logs/hunter/in-<tanggal>.json  { chain, token, symbol, mcapUsd, liquidityUsd, traders[] }
 * Keluaran: logs/hunter/gmgnimportall-<tanggal>.json   (semua yang lolos, siap impor)
 *           logs/hunter/tier-{S,A,B,C}-<tanggal>.json   (per tier)
 * Aturan  : mcap <1jt · liq <50rb · top trader ROI >300% & winrate >60% (90 hari)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RULES, passesToken, scoreToken, type Scored, type TokenSnap, type TraderSnap } from "./filters.js";

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

  const out = { ts: Date.now(), rules: RULES, chains: [...new Set(scored.map((s) => s.token.chain))], tokens: scored };
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
