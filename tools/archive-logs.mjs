#!/usr/bin/env node
/**
 * ARSIP LOG (round-3 A6) — kebijakan: KOMPRES, JANGAN PERNAH MENGHAPUS.
 *   node tools/archive-logs.mjs            → pratinjau (apa yang akan digzip, berapa besar)
 *   node tools/archive-logs.mjs --run      → eksekusi gzip in-place
 *   ARCHIVE_DAYS=30 default; ARCHIVE_DIR=logs/archive default
 *
 * Bukti audit tetap utuh: berkas .gz bisa didekompresi byte-per-byte; tidak ada satu byte pun
 * dibuang. Berkas yang masih segar (mtime < ARCHIVE_DAYS) tidak disentuh.
 */
import { readdirSync, statSync, createReadStream, createWriteStream, mkdirSync, unlinkSync } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

const LOG = "logs";
const DAYS = Number(process.env.ARCHIVE_DAYS ?? 30);
const ARCHIVE = process.env.ARCHIVE_DIR ?? join(LOG, "archive");
const RUN = process.argv.includes("--run");
const now = Date.now();

const SKIP_DIRS = new Set(["archive", "node_modules"]);
let totalSaved = 0, files = 0;

function existsSafe(p) { try { statSync(p); return true; } catch { return false; } }

async function gzipTo(src, dst) {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dst));
}

async function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name)); continue; }
    if (entry.name.endsWith(".gz") || entry.name.endsWith(".lock")) continue;
    const p = join(dir, entry.name);
    const ageDays = (now - statSync(p).mtimeMs) / 864e5;
    if (ageDays < DAYS) continue;
    const size = statSync(p).size;
    if (!RUN) { files++; totalSaved += size; console.log(`  [pratinjau] ${p} · ${(size / 1e6).toFixed(1)} MB · ${ageDays.toFixed(0)} hari`); continue; }
    mkdirSync(ARCHIVE, { recursive: true });
    const out = join(ARCHIVE, entry.name + ".gz");
    if (existsSafe(out)) { console.log(`  lewati (tujuan sudah ada): ${out}`); continue; }
    await gzipTo(p, out);
    const gzSize = statSync(out).size;
    unlinkSync(p);
    totalSaved += size - gzSize; files++;
    console.log(`  gzip: ${p} (${(size / 1e6).toFixed(1)} MB → ${(gzSize / 1e6).toFixed(1)} MB)`);
  }
}

await walk(LOG);
console.log(RUN ? `selesai: ${files} berkas diarsipkan, hemat ${(totalSaved / 1e6).toFixed(1)} MB`
  : `pratinjau: ${files} berkas / ${(totalSaved / 1e6).toFixed(1)} MB dapat diarsipkan (jalankan dengan --run)`);
