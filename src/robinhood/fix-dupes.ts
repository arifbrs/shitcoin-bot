/**
 * KOREKSI PENUTUPAN GANDA (sekali-jalan, 2026-10-09).
 *
 * Temuan audit: 7 penutupan ganda — posisi yang sama ditutup DUA kali (max_hold lalu mark_basi,
 * 0–1 menit) di v03/v06, membukukan PnL dua kali dan membuat identitas replay-vs-state menyimpang.
 * Jejak dari masa sebelum pemisahan kunci (siklus & tick mark bisa menutup dari salinan state
 * masing-masing). Penjaga di paper.ts mencegah terulang; skrip ini membereskan BUKUNYA.
 *
 * Cara kerja (riwayat TIDAK dihapus, sesuai aturan proyek):
 *   1. Pilih SATU penutupan sah per (varian|token|life): yang PERTAMA; yang menyusul dalam ≤5 menit
 *      ditandai VOID → logs/rh-paper-voids.json (dibaca `rh:audit`).
 *   2. Dengan --apply: equity/realized/trades varian disesuaikan (PnL void dikembalikan), dengan
 *      cadangan state lebih dulu. Tanpa --apply: hanya melaporkan.
 *
 * Run: npx tsx src/robinhood/fix-dupes.ts            (laporan saja)
 *      npx tsx src/robinhood/fix-dupes.ts --apply    (tulis voids + perbaiki state)
 * SEBAIKNYA lane dihentikan dulu (state ditulis lane setiap tick) — lihat urutan di laporan.
 */
import { copyFileSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const APPLY = process.argv.includes("--apply");
const DUP_WINDOW_MS = 5 * 60_000;
const STATE_PATH = join(config.logDir, "rh-paper-state.json");
const VOIDS_PATH = join(config.logDir, "rh-paper-voids.json");

interface CloseRow {
  ts: string; action?: string; variant: string; token: string; symbol?: string; reason: string;
  pnlUsd?: number; notionalUsd?: number; life?: number; cohort?: string;
}

const rows: CloseRow[] = [];
for (const f of readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
  for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!line.includes('"RH_CLOSE"')) continue;
    try { rows.push(JSON.parse(line) as CloseRow); } catch { /* baris rusak */ }
  }
}
console.log(`baris RH_CLOSE dibaca: ${rows.length}`);

const groups = new Map<string, CloseRow[]>();
for (const r of rows) {
  const k = `${r.variant}|${r.token}|${r.life ?? 1}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

const voids: Array<CloseRow & { voidedBecause: string; firstTs: string }> = [];
for (const [, list] of groups) {
  list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  for (let i = 1; i < list.length; i++) {
    const gap = Date.parse(list[i]!.ts) - Date.parse(list[i - 1]!.ts);
    if (gap <= DUP_WINDOW_MS) {
      voids.push({ ...list[i]!, voidedBecause: `tutup ${(gap / 60_000).toFixed(1)}m setelah penutupan sah (${list[i - 1]!.reason})`, firstTs: list[i - 1]!.ts });
    }
  }
}

const total = voids.reduce((a, v) => a + (v.pnlUsd ?? 0), 0);
console.log(`penutupan ganda terdeteksi: ${voids.length} · total PnL yang terlanjur dibukukan dua kali: $${total.toFixed(2)}`);
for (const v of voids) console.log(`  VOID ${v.variant.padEnd(22)} ${String(v.symbol).padEnd(12)} ${v.ts.slice(11, 19)} ${String(v.reason).padEnd(11)} pnl ${v.pnlUsd?.toFixed(2)} — ${v.voidedBecause}`);

if (!APPLY) {
  console.log("\n(laporan saja — jalankan dengan --apply untuk menulis voids + memperbaiki state)");
  process.exit(0);
}

writeFileSync(VOIDS_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), windowMs: DUP_WINDOW_MS, totalVoidedUsd: Number(total.toFixed(4)), voids }, null, 1)}\n`);
console.log(`\nvoids ditulis: ${VOIDS_PATH}`);

const backup = `${STATE_PATH}.bak-${Date.now()}`;
copyFileSync(STATE_PATH, backup);
console.log(`cadangan state: ${backup}`);

const st = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
  variants: Record<string, { equityUsd: number; realizedUsd: number; trades: number; wins: number; losses: number; peakEquityUsd?: number }>;
  corrections?: Array<Record<string, unknown>>;
};
const perVariant = new Map<string, { pnl: number; n: number }>();
for (const v of voids) {
  const cur = perVariant.get(v.variant) ?? { pnl: 0, n: 0 };
  cur.pnl += v.pnlUsd ?? 0;
  cur.n += 1;
  perVariant.set(v.variant, cur);
}
for (const [variant, { pnl, n }] of perVariant) {
  const vs = st.variants[variant];
  if (!vs) { console.log(`  ! varian ${variant} tidak ada di state`); continue; }
  const before = vs.equityUsd;
  vs.equityUsd = Number((vs.equityUsd - pnl).toFixed(4)); // PnL void dikembalikan
  vs.realizedUsd = Number((vs.realizedUsd - pnl).toFixed(4));
  vs.trades = Math.max(0, vs.trades - n);
  if (pnl < 0) vs.losses = Math.max(0, vs.losses - n); // void di sini semuanya rugi; pengaman bila tidak
  console.log(`  ${variant.padEnd(22)} equity $${before.toFixed(2)} → $${vs.equityUsd.toFixed(2)} (kembalikan $${(-pnl).toFixed(2)}, ${n} trade)`);
}
st.corrections = [...(st.corrections ?? []), {
  at: new Date().toISOString(), type: "void-close-dupes", voids: voids.length, pnlRestoredUsd: Number(total.toFixed(4)),
  variants: [...perVariant.keys()], voidsFile: "rh-paper-voids.json",
}];
writeFileSync(`${STATE_PATH}.tmp`, JSON.stringify(st));
renameSync(`${STATE_PATH}.tmp`, STATE_PATH);
console.log(`state diperbaiki: ${STATE_PATH}`);
