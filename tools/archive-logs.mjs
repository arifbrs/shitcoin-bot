#!/usr/bin/env node
/**
 * ARSIP LOG (round-3 A6 / round-4 R4-5) — CLI tipis di atas tools/archive-lib.mjs.
 *   node tools/archive-logs.mjs            → pratinjau
 *   node tools/archive-logs.mjs --run      → eksekusi (gzip + verifikasi + manifest sha256)
 *   ARCHIVE_DAYS=30 default; ARCHIVE_DIR=logs/archive default
 * rh-live-*.jsonl TIDAK PERNAH diarsipkan (lihat archive-lib.mjs — sumber posisi live).
 */
import { archiveTree } from "./archive-lib.mjs";

const LOG = "logs";
const DAYS = Number(process.env.ARCHIVE_DAYS ?? 30);
const ARCHIVE = process.env.ARCHIVE_DIR ?? "logs/archive";
const RUN = process.argv.includes("--run");

const { candidates, manifests, savedBytes } = await archiveTree(LOG, { days: DAYS, archiveDir: ARCHIVE, run: RUN });
if (!RUN) for (const c of candidates) console.log(`  [pratinjau] ${c.path} · ${(c.size / 1e6).toFixed(1)} MB · ${c.ageDays.toFixed(0)} hari`);
for (const m of manifests) {
  if (m.ok === false) console.log(`  lewati: ${m.path} — ${m.reason}`);
  else console.log(`  gzip: ${m.file} (${(m.bytes / 1e6).toFixed(1)} MB) → ${m.gz} · sha256 ${m.sha256.slice(0, 12)}…`);
}
console.log(RUN
  ? `selesai: ${manifests.filter((m) => m.ok !== false).length} berkas diarsipkan + manifest; total sumber ${(savedBytes / 1e6).toFixed(1)} MB`
  : `pratinjau: ${candidates.length} berkas / ${(candidates.reduce((s, c) => s + c.size, 0) / 1e6).toFixed(1)} MB dapat diarsipkan (jalankan dengan --run)`);
