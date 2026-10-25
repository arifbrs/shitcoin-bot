/**
 * RUNNER PENGUJI (2026-10-11) — `npm run test`.
 *
 * Menemukan semua `src/**\/*.test.ts` (node_modules dilewati), mengimpornya (pendaftaran kasus
 * terjadi saat impor), lalu menjalankannya dan keluar non-nol bila ada yang gagal.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registeredCases, runAll } from "../src/testing/harness.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function findTests(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findTests(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const files = findTests(join(ROOT, "src")).sort();
if (!files.length) {
  console.error("Tidak ada berkas *.test.ts ditemukan — penguji kosong itu sendiri kegagalan.");
  process.exit(1);
}

// Impor semua berkas tes lebih dulu: pendaftaran kasus terjadi di tingkat modul.
for (const f of files) {
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    console.error(`✘ GAGAL MEMUAT ${f.replace(ROOT + "/", "")}: ${(e as Error).message}`);
    process.exit(1);
  }
}

const total = registeredCases().length;
console.log(`── PENGUJI: ${total} kasus dari ${files.length} berkas ──`);
const t0 = Date.now();
const { passed, failed, failures } = await runAll();
const ms = Date.now() - t0;

for (const f of failures) console.log(`✘ ${f.name}\n    ${f.error}`);
console.log(`${failed === 0 ? "✓" : "✘"} ${passed} lulus · ${failed} gagal · ${ms}ms`);
process.exit(failed === 0 ? 0 : 1);
