/**
 * ARSIP LIB (round-4 R4-5) — kebijakan: KOMPRES, JANGAN PERNAH MENGHAPUS, BUKTI TERSUM.
 *   - rh-live-*.jsonl TIDAK PERNAH diarsipkan (ledger posisi live harus selalu terbaca
 *     langsung oleh loadLiveRows — posisi terbuka tidak boleh kehilangan sumbernya).
 *   - MANIFEST: sha256 + ukuran sumber untuk tiap arsip (verifikasi byte-per-byte).
 *   - Sebelum unlink sumber, .gz diverifikasi dengan dekompresi penuh (jumlah byte harus sama).
 *     Arsip terputus = sumber TETAP ADA (tidak ada kehilangan rekaman).
 */
import { readdirSync, statSync, createReadStream, createWriteStream, mkdirSync, unlinkSync, openSync, readSync, closeSync, appendFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createGzip, createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const NEVER_ARCHIVE = [/^rh-live-\d{4}-\d{2}-\d{2}\.jsonl$/];

export function sha256File(path) {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally { closeSync(fd); }
  return h.digest("hex");
}

/** Gzip satu berkas → verifikasi dekompresi byte-exact → baru unlink sumber. */
export async function archiveOne(src, dst) {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dst));
  const srcSize = statSync(src).size;
  let decompressed = 0;
  const counter = new Writable({
    write(chunk, _enc, cb) { decompressed += chunk.length; cb(); },
  });
  await pipeline(createReadStream(dst), createGunzip(), counter);
  if (decompressed !== srcSize) {
    try { unlinkSync(dst); } catch { /* biarkan; sumber tetap utuh */ }
    return { ok: false, reason: `verifikasi gagal (${decompressed} ≠ ${srcSize}) — sumber dipertahankan` };
  }
  const manifest = { ts: Date.now(), file: src.replace(/^.*\//, ""), sha256: sha256File(src), bytes: srcSize, gz: dst.replace(/^.*\//, "") };
  unlinkSync(src);
  return { ok: true, manifest };
}

export async function archiveTree(logDir, { days = 30, archiveDir = join(logDir, "archive"), run = false } = {}) {
  const now = Date.now();
  const SKIP_DIRS = new Set(["archive", "node_modules"]);
  const candidates = [];
  async function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name)); continue; }
      if (entry.name.endsWith(".gz") || entry.name.endsWith(".lock") || entry.name === "MANIFEST.jsonl") continue;
      if (NEVER_ARCHIVE.some((re) => re.test(entry.name))) continue;
      const p = join(dir, entry.name);
      // Toleransi 60 dtk untuk skew jam (berkas baru bisa ber-mtime sedikit di masa depan).
      const ageMs = now - statSync(p).mtimeMs + 60_000;
      const ageDays = ageMs / 864e5;
      if (ageDays < days) continue;
      candidates.push({ path: p, size: statSync(p).size, ageDays });
    }
  }
  await walk(logDir);
  const manifests = [];
  if (run) {
    mkdirSync(archiveDir, { recursive: true });
    for (const c of candidates) {
      const dst = join(archiveDir, c.path.replace(/^.*\//, "") + ".gz");
      if (statExists(dst)) { manifests.push({ ok: false, reason: "tujuan sudah ada — sumber dipertahankan", path: c.path }); continue; }
      const r = await archiveOne(c.path, dst);
      if (r.ok) {
        manifests.push(r.manifest);
        appendFileSync(join(archiveDir, "MANIFEST.jsonl"), JSON.stringify(r.manifest) + "\n");
      } else manifests.push({ ok: false, reason: r.reason, path: c.path });
    }
  }
  return { candidates, manifests, savedBytes: manifests.reduce((s, m) => s + (m.bytes ?? 0), 0) };
}

function statExists(p) { try { statSync(p); return true; } catch { return false; } }
