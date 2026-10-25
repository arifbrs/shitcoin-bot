/**
 * FILTER KUALITAS TRENCHES — ROBINHOOD CHAIN (2026-10-13) — `npm run rh:trench -- <alamat token>`.
 *
 * Kenapa ada: pengukuran 2026-10-13 menunjukkan 60 kandidat baru/jam dari `market trenches` tapi
 * HANYA 2 di pita $25–50k dan 0 lolos gate kita → trenches BUKAN sumber entry, ia sumber SINYAL
 * KUALITAS (bot/bundler/tax/burn/creator/callout). Alat ini mencari satu token di jendela trenches
 * dan menampilkan sinyalnya APA ADANYA. Ambang di bawah ini USULAN — bukan gate yang berlaku;
 * tidak ada arm berjalan yang diubah oleh alat ini.
 */
import { execFileSync } from "node:child_process";

type Row = Record<string, unknown>;
const num = (r: Row, k: string): number => Number(r[k] ?? 0);
const str = (r: Row, k: string): string => String(r[k] ?? "?");

function trenches(): Row[] {
  try {
    const out = execFileSync("npx", ["gmgn-cli", "market", "trenches", "--chain", "robinhood", "--type", "new_creation", "--filter-preset", "smart-money", "--limit", "80", "--raw"], { encoding: "utf8", timeout: 90_000, maxBuffer: 2e7 });
    const j = JSON.parse(out) as { data?: { new_creation?: Row[] }; new_creation?: Row[] };
    return (j.data?.new_creation ?? j.new_creation ?? []) as Row[];
  } catch (e) {
    console.log("  trenches gagal: " + String((e as Error).message).slice(0, 100));
    return [];
  }
}

function main(): void {
  const want = (process.argv[2] ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) { console.log("  pakai: npm run rh:trench -- 0x<40 hex alamat token>"); return; }
  const rows = trenches();
  console.log(`  jendela trenches: ${rows.length} token baru (preset smart-money)`);
  const hit = rows.find((r) => String(r.address ?? "").toLowerCase() === want);
  if (!hit) {
    console.log(`  ${want} TIDAK ada di jendela ini → tidak ada sinyal trenches untuk token ini (bukan berarti buruk; berarti belum terukur).`);
    return;
  }
  console.log(`  ${want} ADA di jendela trenches — sinyal mentah:`);
  for (const k of ["symbol", "bot_degen_rate", "bot_degen_count", "bundler_trader_amount_rate", "buy_tax", "sell_tax", "burn_status", "callout_count", "creator_balance_rate", "creator_created_inner_count", "creator_created_open_count", "complete_timestamp", "created_timestamp"]) {
    console.log(`    ${k.padEnd(30)} ${str(hit, k)}`);
  }
  console.log("  USULAN ambang (belum berlaku, menunggu keputusanmu): bot_degen_rate < 0,05 · buy_tax = 0 · burn_status = yes · callout_count >= 1");
}

main();
