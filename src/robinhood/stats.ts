/**
 * STATISTIK VERDICT — SATU sumber (2026-10-11).
 *
 * Dulu uji tanda + bootstrap hanya hidup di dalam verdict.ts dan tidak bisa dipakai modul lain
 * (realisme keluar, kualitas stop, verdict OKX). Kini diekspor, diuji, dan dipakai bersama.
 */

/** Uji tanda dua-sisi (exact binomial): peluang melihat pemisahan sebesar ini karena kebetulan. */
export function signTest(wins: number, n: number): number {
  if (n === 0) return 1;
  const choose = (a: number, b: number): number => {
    let r = 1;
    for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1);
    return r;
  };
  const pmf = (k: number): number => choose(n, k) * 0.5 ** n;
  const tail = Math.min(wins, n - wins);
  let p = 0;
  for (let k = 0; k <= tail; k++) p += pmf(k);
  return Math.min(1, 2 * p);
}

/** Interval kepercayaan 95% untuk rata-rata (bootstrap resample). */
export function bootstrapCI(values: number[], iters = 4000): [number, number] {
  if (values.length < 3) return [NaN, NaN];
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < values.length; j++) s += values[(Math.random() * values.length) | 0]!;
    means.push(s / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)]!, means[Math.floor(iters * 0.975)]!];
}

/** Interval kepercayaan 95% untuk SELISIH dua grup yang TIDAK berpasangan (a − b). */
export function bootstrapDiffCI(a: number[], b: number[], iters = 4000): [number, number] {
  if (a.length < 3 || b.length < 3) return [NaN, NaN];
  const rand = (arr: number[]): number => arr[(Math.random() * arr.length) | 0]!;
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sa = 0;
    let sb = 0;
    for (let j = 0; j < a.length; j++) sa += rand(a);
    for (let j = 0; j < b.length; j++) sb += rand(b);
    means.push(sa / a.length - sb / b.length);
  }
  means.sort((x, y) => x - y);
  return [means[Math.floor(iters * 0.025)]!, means[Math.floor(iters * 0.975)]!];
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((x, y) => x + y, 0) / values.length : NaN;
}

export function sd(values: number[]): number {
  if (values.length < 2) return NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, x) => a + (x - m) ** 2, 0) / (values.length - 1));
}

/**
 * Perkiraan jumlah trade yang dibutuhkan PER ARM untuk melihat efek sebesar `effect` (daya 80%,
 * alfa 5%, dua sisi). Dipakai sebagai gerbang: "sampel belum cukup" harus punya angka, bukan rasa.
 */
export function requiredNPerArm(effect: number, sdPerTrade: number): number {
  const e = Math.abs(effect);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(sdPerTrade)) return Infinity;
  return Math.ceil((2 * (1.96 + 0.84) ** 2 * sdPerTrade ** 2) / e ** 2);
}

export interface Concentration {
  /** Bagian net yang datang dari SATU trade terbaik (0..1). */
  topSharePct: number;
  netExclTop1: number;
  netExclTop2: number;
}

/**
 * Konsentrasi hasil pada sedikit pemenang. Gerbang rencana proyek: hasil positif tidak boleh
 * berasal dari satu mint — tanpa ini, satu kebetulan bisa tampak seperti sebuah edge.
 */
export function concentration(pnls: number[]): Concentration {
  const sorted = [...pnls].sort((x, y) => y - x);
  const total = sorted.reduce((x, y) => x + y, 0);
  const top1 = sorted[0] ?? 0;
  return {
    topSharePct: total !== 0 ? top1 / total : 0,
    netExclTop1: total - top1,
    netExclTop2: total - top1 - (sorted[1] ?? 0),
  };
}
