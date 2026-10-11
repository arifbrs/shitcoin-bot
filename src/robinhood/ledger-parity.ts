/**
 * PARITAS LEDGER↔STATE — SATU rumus, dipakai bersama (2026-10-10).
 *
 * Kenapa modul ini ada: audit dan rekonsiliasi dulu masing-masing menghitung "berapa posisi yang
 * seharusnya masih dipegang" dengan BASIS BERBEDA — rekonsiliasi memakai baris NYATA, audit memakai
 * baris EFEKTIF (OPEN riil yang kuncinya punya CLOSE rekonsiliasi tidak dihitung). Akibatnya
 * rekonsiliasi menulis baris penyeimbang yang tidak memuaskan audit, dan keduanya berputar tanpa
 * pernah selesai: audit merah, rekonsiliasi menulis lagi, audit tetap merah.
 *
 * Kini keduanya memanggil computeParity() yang sama. Rekonsiliasi menulis penyeimbang HANYA untuk
 * menutup selisih `residual − held`, sehingga setelah satu putaran selisihnya nol (atau dijelaskan
 * oleh baris rekonsiliasi) — konvergen, bukan berputar.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Baris ledger yang relevan untuk paritas. */
export interface ParityRow {
  action?: string;
  variant?: string;
  token?: string;
  life?: number;
  reconciled?: boolean;
  ts?: string;
}

export interface Parity {
  /** Sisa ledger per kunci `varian|token|life`: OPEN efektif − CLOSE riil. */
  residual: Map<string, number>;
  /** Posisi yang benar-benar dipegang state, dipetakan ke kunci ber-life sekarang. */
  held: Map<string, number>;
  /** Kunci yang punya CLOSE rekonsiliasi — selisihnya "dijelaskan", bukan hijau palsu. */
  reconciledCloseKeys: Set<string>;
  /** Jumlah baris mentah, untuk dilaporkan apa adanya. */
  counts: { opens: number; closes: number; reconciledRows: number };
}

export function keyOf(r: { variant?: string; token?: string; life?: number }): string {
  return `${r.variant}|${r.token}|${r.life ?? 1}`;
}

/** Baca semua baris RH_OPEN/RH_CLOSE dari berkas rh-paper-*.jsonl (void dikecualikan). */
export function readParityRows(logDir: string, voids: Set<string>): ParityRow[] {
  const out: ParityRow[] = [];
  for (const f of readdirSync(logDir).filter((x) => x.startsWith("rh-paper-") && x.endsWith(".jsonl")).sort()) {
    let text: string;
    try {
      text = readFileSync(join(logDir, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes('"RH_')) continue;
      try {
        const r = JSON.parse(line) as ParityRow;
        // RH_LIFE ikut dibaca (bukan untuk paritas — computeParity hanya memproses OPEN/CLOSE —
        // tetapi untuk menyelaraskan nomor life state dengan ledger yang append-only).
        if (r.action !== "RH_OPEN" && r.action !== "RH_CLOSE" && r.action !== "RH_LIFE") continue;
        // Baris RH_LIFE TIDAK punya token (ia peristiwa restart life, bukan transaksi) — dulu baris
        // ini ikut terbuang di sini, sehingga life dari ledger tak pernah terbaca dan penyelarasan
        // life di rekonsiliasi tak pernah menyala.
        if (!r.variant) continue;
        if (r.action !== "RH_LIFE" && !r.token) continue;
        if (voids.has(`${r.variant}|${r.token}|${r.ts}`)) continue;
        out.push(r);
      } catch {
        /* baris rusak */
      }
    }
  }
  return out;
}

/**
 * @param rows     hasil readParityRows()
 * @param heldRaw  posisi yang dipegang state, kunci `varian|token` → jumlah
 * @param lifeOf   life SEKARANG per varian (posisi selalu milik life berjalan)
 */
export function computeParity(rows: ParityRow[], heldRaw: Map<string, number>, lifeOf: (variant: string) => number): Parity {
  const reconciledCloseKeys = new Set<string>();
  for (const r of rows) if (r.action === "RH_CLOSE" && r.reconciled === true) reconciledCloseKeys.add(keyOf(r));

  const residual = new Map<string, number>();
  let opens = 0;
  let closes = 0;
  let reconciledRows = 0;
  for (const r of rows) {
    if (r.reconciled === true) reconciledRows++;
    if (r.action === "RH_OPEN") {
      // OPEN riil untuk kunci yang sudah punya CLOSE rekonsiliasi tidak dihitung: kunci itu
      // riwayatnya memang bolong dan sudah dijelaskan oleh baris rekonsiliasi.
      if (r.reconciled !== true && reconciledCloseKeys.has(keyOf(r))) continue;
      residual.set(keyOf(r), (residual.get(keyOf(r)) ?? 0) + 1);
      if (r.reconciled !== true) opens++;
    } else if (r.action === "RH_CLOSE" && r.reconciled !== true) {
      residual.set(keyOf(r), (residual.get(keyOf(r)) ?? 0) - 1);
      closes++;
    }
  }

  const held = new Map<string, number>();
  for (const [idToken, n] of heldRaw) {
    const sep = idToken.indexOf("|");
    const variant = idToken.slice(0, sep);
    const token = idToken.slice(sep + 1);
    const k = `${variant}|${token}|${lifeOf(variant)}`;
    held.set(k, (held.get(k) ?? 0) + n);
  }
  return { residual, held, reconciledCloseKeys, counts: { opens, closes, reconciledRows } };
}

/** Selisih `residual − held` untuk SETIAP kunci yang terlibat (positif = ledger berlebih). */
export function parityGaps(p: Parity): Map<string, number> {
  const gaps = new Map<string, number>();
  for (const [k, r] of p.residual) gaps.set(k, r - (p.held.get(k) ?? 0));
  for (const [k, h] of p.held) if (!gaps.has(k)) gaps.set(k, -h);
  return gaps;
}

/**
 * Berapa OPEN penyeimbang yang boleh ditulis untuk sebuah kunci.
 *
 * ATURAN YANG DIPELAJARI DENGAN MAHAL (2026-10-10): jangan menambal kekurangan yang bukan milik
 * posisi yang BENAR-BENAR dipegang. Residual negatif pada kunci life lama itu wajar — sisa OPEN
 * yang di-void sementara CLOSE-nya tetap ada. Dulu rekonsiliasi menambalnya tanpa syarat, sehingga
 * setiap putaran menulis baris baru yang lagi-lagi tidak memuaskan audit: berputar tanpa henti.
 */
export function compensatingOpenCount(gap: number, heldHere: number): number {
  if (gap >= 0 || heldHere <= 0) return 0;
  return Math.min(-gap, heldHere);
}

/**
 * Perlu menulis SATU baris CLOSE rekonsiliasi (penjelas) untuk kunci ini?
 * Satu baris per kunci sudah cukup: baris rekonsiliasi tidak mengurangi residual — ia menjelaskan.
 */
export function needsReconciledClose(gap: number, alreadyExplained: boolean): boolean {
  return gap > 0 && !alreadyExplained;
}
