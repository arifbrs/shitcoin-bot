/**
 * PENILAI ULANG BIAYA NYATA — `npm run rh:realcost [notionalUsd]`.
 *
 * KOREKSI PENTING (kesalahanku versi pertama, 2026-10-13): versi awal MENGURANGKAN biaya terukur
 * dari net yang SUDAH memuat biaya model lama → biaya dihitung DUA KALI. Yang benar: hitung SELISIH
 * per sisi antara model lama dan pengukuran, lalu terapkan selisih itu ke net lama.
 *
 * Fakta yang membuat selisih ini bisa dihitung tanpa menebak:
 *   - Model lama per sisi = DEX_FEE_PCT (0,30%) + slip ≥ SLIP_BASE (1,00%) = **≥1,30%**.
 *   - Yang TERUKUR per sisi = fee 1,00% + slip 0,01–0,12% = **≈1,06%**.
 *   → Model lama SELALU ≥ pengukuran, jadi net nyata SELALU ≥ net lama; selisih dipakai sebagai
 *     PERBAIKAN MINIMUM (lantai), bukan perbaikan pasti: komponen "impact" slippage model lama
 *     (bergantung likuiditas tiap trade, tak tersedia di keluaran studi) membuat perbaikan nyata
 *     bisa lebih besar — dan itu TIDAK kuklaim.
 */
import { execFileSync } from "node:child_process";
import { DEX_FEE_PCT, SLIP_BASE, MEASURED_FEE_PCT, MEASURED_SLIP_PCT } from "./costs.js";

const num = (s: string): number => Number(s.replace(/[^0-9.]/g, "")) * (s.includes("−") || s.includes("-") ? -1 : 1);
const OLD_PER_SIDE_FLOOR = DEX_FEE_PCT + SLIP_BASE;
const MEASURED_PER_SIDE = MEASURED_FEE_PCT + MEASURED_SLIP_PCT;

function main(): void {
  const notional = Number(process.argv[2] ?? 25);
  const deltaPerTrade = (OLD_PER_SIDE_FLOOR - MEASURED_PER_SIDE) * 2 * notional;
  console.log("  ══ PENILAIAN ULANG DENGAN BIAYA TERUKUR (selisih, bukan tambahan biaya) ══");
  console.log(`  model lama (lantai) ${(OLD_PER_SIDE_FLOOR * 100).toFixed(2)}%/sisi vs terukur ${(MEASURED_PER_SIDE * 100).toFixed(2)}%/sisi`);
  console.log(`  asumsi eksplisit: notional $${notional} → PERBAIKAN MINIMUM $${deltaPerTrade.toFixed(4)} per putaran`);
  let out = "";
  try { out = execFileSync("npx", ["tsx", "src/robinhood/study.ts"], { encoding: "utf8", timeout: 120_000, maxBuffer: 2e7, cwd: process.cwd() }); }
  catch (e) { console.log("  studi gagal: " + String((e as Error).message).slice(0, 90)); return; }
  const rows: Array<{ label: string; n: number; net: number }> = [];
  for (const line of out.split("\n")) {
    if (/^\s*TOTAL:/.test(line)) continue;
    const m = line.match(/^\s*(.+?)\s+n=(\d+)\s*·.*?\bnet\s+([−+-]?\$[\d.,]+)/);
    if (m && m[1] && m[3]) rows.push({ label: m[1].trim(), n: Number(m[2]), net: num(m[3]) });
  }
  if (!rows.length) { console.log("  (tak ada baris terbaca dari studi)"); return; }
  console.log("  keluarga exit".padEnd(26) + "n".padStart(6) + "net (model lama)".padStart(18) + "perbaikan min".padStart(15) + "net ≥".padStart(14));
  for (const r of rows) {
    const fix = r.n * deltaPerTrade;
    console.log("  " + r.label.slice(0, 24).padEnd(24) + String(r.n).padStart(6) + ("$" + r.net.toFixed(2)).padStart(18) + ("+$" + fix.toFixed(2)).padStart(15) + ("$" + (r.net + fix).toFixed(2)).padStart(14));
  }
  console.log("  (kolom 'net ≥' = batas bawah; perbaikan nyata bisa lebih besar bila impact slippage model lama > 0)");
}

main();
