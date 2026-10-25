import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, eq, assert } from "../testing/harness.js";
import {
  CLOSE_DEDUP_MS,
  shouldAcceptWrite,
  shouldBlockClose,
  readStateWrites,
  commitState,
} from "./state-store.js";

function tmpState(): string {
  return join(mkdtempSync(join(tmpdir(), "state-store-")), "state.json");
}

test("state: tulisan hanya diterima bila nomornya LEBIH BARU dari berkas", () => {
  eq(shouldAcceptWrite(5, 6), true, "6 > 5 → terima");
  eq(shouldAcceptWrite(6, 6), false, "sama → tolak (inilah yang menutup kelas tulisan basi)");
  eq(shouldAcceptWrite(7, 6), false, "mundur → tolak");
  eq(shouldAcceptWrite(0, 1), true, "berkas belum ada → terima");
});

test("state: commitState menolak tulisan basi dan berkas TIDAK berubah (regresi 2026-10-10)", () => {
  const path = tmpState();
  const hidup = { stateWrites: 0, catatan: "baru" };
  const r1 = commitState(path, hidup);
  eq(r1.written, true, "tulisan pertama diterima");
  eq(readStateWrites(path), 1, "nomor tulisan tercatat");

  // Penulis basi: salinannya dimuat SEBELUM commit pertama (stateWrites masih 0).
  const basi = { stateWrites: 0, catatan: "basi" };
  const r2 = commitState(path, basi);
  eq(r2.written, false, "tulisan basi DITOLAK");
  const isi = JSON.parse(readFileSync(path, "utf8")) as { catatan: string; stateWrites: number };
  eq(isi.catatan, "baru", "isi berkas tetap dari penulis baru, bukan ditimpa yang basi");
  eq(isi.stateWrites, 1, "nomor tidak mundur");
});

test("state: penulis yang sah tetap bisa menulis berulang (nomor naik monoton)", () => {
  const path = tmpState();
  const s = { stateWrites: 0 };
  for (let i = 1; i <= 5; i++) {
    const r = commitState(path, s);
    eq(r.written, true, `tulisan ke-${i} diterima`);
    eq(readStateWrites(path), i, `nomor tulisan = ${i}`);
  }
});

test("state: berkas rusak/absen dianggap nomor 0 (fail-open ke tulis pertama)", () => {
  const path = tmpState();
  eq(readStateWrites(path), 0, "belum ada berkas");
  writeFileSync(path, "{ rusak");
  eq(readStateWrites(path), 0, "JSON rusak → 0");
  const r = commitState(path, { stateWrites: 0, x: 1 });
  eq(r.written, true, "tulisan pertama setelah rusak diterima");
  assert(existsSync(path), "berkas ada setelah commit");
  eq(readStateWrites(path), 1, "nomor baru");
});

test("state: tulis atomik tidak meninggalkan berkas .tmp", () => {
  const path = tmpState();
  commitState(path, { stateWrites: 0 });
  eq(existsSync(`${path}.tmp`), false, "berkas sementara sudah di-rename");
});

test("state: penjaga idempotensi menutup hanya di dalam jendela 10 menit", () => {
  const now = 1_000_000_000;
  eq(shouldBlockClose(now - 1_000, now), true, "1 detik lalu → blokir");
  eq(shouldBlockClose(now - CLOSE_DEDUP_MS + 1, now), true, "tepat di dalam jendela → blokir");
  eq(shouldBlockClose(now - CLOSE_DEDUP_MS, now), false, "tepat di batas → boleh");
  eq(shouldBlockClose(now - 6 * 3_600_000, now), false, "6 jam lalu (cooldown re-entry) → boleh");
  eq(shouldBlockClose(undefined, now), false, "belum pernah menutup → boleh");
});

test("state: jendela dedup persis 10 menit (aturan yang disepakati, bukan angka liar)", () => {
  eq(CLOSE_DEDUP_MS, 600_000, "10 menit");
});
