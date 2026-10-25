/**
 * KARTU KUALITAS EKSEKUSI — pembangun data (2026-10-11).
 *
 * Dipakai DUA pembaca: endpoint `/api/quality` (permintaan manual) dan payload `/api/stats`
 * (push SSE ke panel). Karena satu fungsi melayani keduanya, kartu dan endpoint tidak bisa
 * menampilkan angka yang berbeda.
 *
 * Semua dari berkas lokal, nol API: retensi harga pasca-keluar dihitung dengan `summarizeTraces`
 * (fungsi yang sama dipakai review 08:00 dan realism), sisanya ringkasan berkas laporan alat.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { summarizeTraces, type RetentionStat } from "./robinhood/mark-trace.js";

export interface ReportDigest {
  file: string;
  mtime: string;
  lines: string[];
}

export interface QualityView {
  day: string;
  traceRows: number;
  retention: RetentionStat[];
  stop: ReportDigest | null;
  realism: ReportDigest | null;
  okxArms: ReportDigest | null;
  note: string;
}

/** Ringkasan sebuah berkas laporan (nama, waktu tulis, baris penting) — atau null bila belum ada. */
export function reportDigest(logDir: string, pat: RegExp): ReportDigest | null {
  const files = readdirSync(logDir).filter((f) => pat.test(f)).sort();
  const file = files[files.length - 1];
  if (!file) return null;
  try {
    const full = join(logDir, file);
    const lines = readFileSync(full, "utf8").split("\n").filter((l) => l.trim()).slice(0, 120);
    return { file, mtime: statSync(full).mtime.toISOString(), lines };
  } catch {
    return null;
  }
}

export function buildQualityView(logDir: string): QualityView {
  const day = new Date().toISOString().slice(0, 10);
  let retention: RetentionStat[] = [];
  let traceRows = 0;
  try {
    const rows = readFileSync(join(logDir, `rh-events-${day}.jsonl`), "utf8").split("\n")
      .filter((l) => l.includes("rh-mark-after"))
      .map((l) => { try { return JSON.parse(l) as { reason: string; exitPriceUsd: number; marks: Array<{ p: number | null }> }; } catch { return null; } })
      .filter((r): r is { reason: string; exitPriceUsd: number; marks: Array<{ p: number | null }> } => r != null);
    traceRows = rows.length;
    retention = summarizeTraces(rows);
  } catch { /* belum ada jejak hari ini */ }
  return {
    day,
    traceRows,
    retention,
    stop: reportDigest(logDir, /^rh-stop-quality-\d{4}-\d{2}-\d{2}\.md$/),
    realism: reportDigest(logDir, /^rh-realism-\d{4}-\d{2}-\d{2}\.md$/),
    okxArms: reportDigest(logDir, /^okx-verdict-\d{4}-\d{2}-\d{2}\.md$/),
    note: "retensi rendah pada take_profit = harga tidak bertahan sesudah keluar (untung di atas kertas)",
  };
}
