/**
 * VARIAN/KOHORT OKX STRICT-PAPER (item 6, 2026-10-11).
 *
 * Sebelum ini lane OKX hanya punya SATU kebijakan per proses (`policyVersion = 6`): tidak ada
 * pembanding, jadi kerugiannya hanya terukur, tidak pernah diuji. Modul ini mendefinisikan arm
 * yang berjalan pada ALIRAN KANDIDAT YANG SAMA — penugasan ditentukan oleh hash id posisi, jadi
 * bukan pemilihan setelah melihat hasil (itu yang membuat perbandingan tidak sah).
 *
 * Knob exit sudah per-posisi (`position.adaptive`), sehingga varian cukup mengubah nilai itu:
 * tidak ada perilaku yang berubah diam-diam untuk arm dasar (v6 = nilai env saat ini, persis).
 */

export interface OkxBaseline {
  takeProfitPct: number;
  hardStopPct: number;
  maxHoldMs: number;
  pollMs: number;
  executionDelayMs: number;
  maxNoRoute: number;
}

export type OkxStrategy = "V5_TP5_SL8_T60_EXEC_DELAY" | "V6_FAST_RECHECK_TP5_SL8_T60" | "V7_FAST_STOP_SL6_T45";

export interface OkxVariant extends OkxBaseline {
  id: string;
  cohort: string;
  label: string;
  strategy: OkxStrategy;
}

/** Hash stabil (FNV-1a 32-bit) — penugasan arm harus deterministik dan bisa direproduksi. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Daftar arm. Arm PERTAMA selalu = kebijakan yang sedang berjalan (tanpa perubahan), supaya
 * perbandingan punya pembanding yang jujur, bukan pembanding yang sudah diperbaiki.
 */
export function okxVariants(baseline: OkxBaseline): OkxVariant[] {
  return [
    {
      ...baseline,
      id: "v6-dasar",
      cohort: "okx-kohort-1",
      label: `dasar (TP${baseline.takeProfitPct}/SL${baseline.hardStopPct}/T${Math.round(baseline.maxHoldMs / 1000)})`,
      strategy: "V6_FAST_RECHECK_TP5_SL8_T60",
    },
    {
      ...baseline,
      id: "v7-stop-responsif",
      cohort: "okx-kohort-1",
      label: "stop lebih responsif (SL6/T45)",
      hardStopPct: Math.max(baseline.hardStopPct, -6),
      maxHoldMs: Math.min(baseline.maxHoldMs, 45_000),
      strategy: "V7_FAST_STOP_SL6_T45",
    },
  ];
}

/** Arm untuk sebuah posisi: deterministik dari id, merata lintas populasi, tidak bisa diubah setelah hasil terlihat. */
export function variantFor(paperId: string, baseline: OkxBaseline): OkxVariant {
  const list = okxVariants(baseline);
  return list[hash32(paperId) % list.length]!;
}
