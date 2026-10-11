/**
 * PENYIMPANAN STATE — penjaga tulisan basi + tulis atomik (2026-10-11).
 *
 * Kelas bug yang ditutup di sini: salinan state LAMA ditulis menimpa state yang lebih baru,
 * sehingga `closedKeys` dan penghapusan posisi ikut ter-undo di berkas dan tick berikutnya
 * menutup posisi yang sama LAGI (terukur: 1 OPEN + 2 CLOSE identik, stateWrites mundur 732→714).
 * Karena itu semua penulisan lewat commitState(): nomornya harus LEBIH BARU dari yang ada
 * di berkas, kalau tidak tulisan ditolak dan dicatat.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Jendela penjaga idempotensi penutupan: penutupan kedua dalam 10 menit dianggap duplikat. */
export const CLOSE_DEDUP_MS = 10 * 60_000;

/** Boleh menulis? Nomor tulisan harus lebih baru dari yang ada di berkas. */
export function shouldAcceptWrite(diskWrites: number, nextWrites: number): boolean {
  return nextWrites > diskWrites;
}

/** Blokir penutupan? Ada penutupan sebelumnya untuk kunci yang sama di dalam jendela. */
export function shouldBlockClose(lastCloseMs: number | undefined, now: number, windowMs = CLOSE_DEDUP_MS): boolean {
  return lastCloseMs != null && now - lastCloseMs < windowMs;
}

/** Nomor tulisan terakhir yang tercatat di berkas (0 bila berkas belum ada / rusak). */
export function readStateWrites(path: string): number {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { stateWrites?: unknown };
    return Number(raw.stateWrites ?? 0);
  } catch {
    return 0;
  }
}

export type CommitResult = { written: true; stateWrites: number } | { written: false; diskWrites: number };

/**
 * Tulis state dengan penjaga monotonik + tulis atomik (temp → fsync → rename).
 * Menolak (tanpa menyentuh berkas) bila nomor tulisan tidak lebih baru dari yang di berkas.
 */
export function commitState<T extends object>(path: string, state: T): CommitResult {
  const holder = state as { stateWrites?: number };
  const nextWrites = (holder.stateWrites ?? 0) + 1;
  const diskWrites = readStateWrites(path);
  if (!shouldAcceptWrite(diskWrites, nextWrites)) return { written: false, diskWrites };
  holder.stateWrites = nextWrites;
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return { written: true, stateWrites: nextWrites };
}

/** Ada berkas state? */
export function stateExists(path: string): boolean {
  return existsSync(path);
}
