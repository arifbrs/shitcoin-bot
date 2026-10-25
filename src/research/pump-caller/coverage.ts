/**
 * (S11.2) PENILAIAN CAKUPAN WINDOW BERBASIS BUKTI AKUISISI — murni.
 *
 * Ganti inferensi boolean lama ("ada ≥1 swap di window = window tercakup") dengan penilaian
 * eksplisit dari REKAMAN PASS RPC (baris tape-coverage di jurnal):
 *   - tiap pass sukses merekam interval halaman [pageBottomTs, pageTopTs] + blok fakta
 *     (reconciled, holes, drain) — halaman `until`/`before` itu KONTIGU di rantai signature,
 *     jadi intervalnya benar-benar terenumerasi penuh;
 *   - pass dgn encountered ≥ limit membuat GAP terbuka (chunk antara bottom-halaman dan
 *     prevHead terlewat) → tertutup hanya oleh pass drain yang mencapai prevHead;
 *   - pass dgn holes (tx gagal diambil) = interval TERCEMARK → tidak pernah bukti DATA_COMPLETE
 *     sebelum semua lubang dipulihkan (baris recovery);
 *   - riwayat DI BAWAH tail (halaman pertama) tak pernah direkonstruksi (budget) → window yang
 *     mencakupnya = DATA_INCOMPLETE;
 *   - token pascamigrasi ke PumpSwap: tape bonding-curve SAJA tak pernah lengkap.
 *
 * Keempat status: WINDOW_NOT_MATURED / DATA_INCOMPLETE / DATA_COMPLETE / COVERAGE_UNKNOWN.
 * HANYA DATA_COMPLETE yang boleh menopang pernyataan definitif ("pengikut < 2").
 */

export interface CoverageRow {
  ts: number; // waktu pass
  encountered: number;
  missingTx: number;
  error: string | null;
  reconciled?: boolean;             // encountered < limit (ujung rantai tercapai saat itu)
  backlogPossible?: boolean;        // halaman utama penuh → chunk di bawahnya bisa terlewat
  pageTopTs?: number | null;        // blockTime sig TERBARU yang diambil
  pageBottomTs?: number | null;     // blockTime sig TERLAMA yang diambil (termasuk drain)
  prevHeadTs?: number | null;       // blockTime head sebelumnya (batas bawah chunk)
  holes?: string[];                 // sig terenumerasi tapi tx gagal diambil
  drain?: { pagesUsed: number; closed: boolean } | null;
  recovered?: string[];             // (recovery) lubang yang berhasil diambil ulang
}

export type WindowCoverage = "WINDOW_NOT_MATURED" | "DATA_INCOMPLETE" | "DATA_COMPLETE" | "COVERAGE_UNKNOWN";

interface Interval { lo: number; hi: number }

/** Kumpulkan interval halaman BERSIH (tanpa lubang aktif) + gap terbuka dari rekaman pass. */
function derive(rows: CoverageRow[]): { clean: Interval[]; gaps: Array<{ lo: number; hi: number }>; tailTs: number | null } {
  const recovered = new Set<string>();
  for (const r of rows) for (const s of r.recovered ?? []) recovered.add(s);
  const clean: Interval[] = [];
  const gaps: Array<{ lo: number; hi: number }> = [];
  let tailTs: number | null = null;
  let prevHeadTs: number | null = null;
  for (const r of rows) {
    if (r.error != null) continue; // pass gagal tak mengubah rantai (kursor tak bergeser)
    const top = r.pageTopTs ?? null, bottom = r.pageBottomTs ?? null;
    const holesOpen = (r.holes?.length ?? 0) > 0 && !(r.holes ?? []).every((s) => recovered.has(s));
    if (top != null && bottom != null) {
      if (tailTs == null || bottom < tailTs) tailTs = bottom; // tail = batas terlama yang pernah diambil
      // interval halaman (kontigu di rantai sig): [bottom, top]; tercemar bila lubang aktif.
      if (!holesOpen) clean.push({ lo: bottom, hi: top });
    }
    // (S11.2) GAP: halaman utama PENUH (backlog) → chunk antara prevHead (bawah) dan
    // pageBottom (atas) terlewat — tertutup hanya bila drain mencapai prevHead.
    if (prevHeadTs != null && r.backlogPossible === true && r.drain?.closed !== true
      && bottom != null && bottom > prevHeadTs) {
      gaps.push({ lo: prevHeadTs, hi: bottom });
    }
    prevHeadTs = top ?? prevHeadTs;
  }
  // gap yang seluruh intervalnya berada DI DALAM union halaman bersih (drain mengambilnya) = tertutup:
  const cleanGaps = gaps.filter((g) => !clean.some((c) => c.lo <= g.lo && c.hi >= g.hi)); // noop guard
  return { clean, gaps: cleanGaps, tailTs };
}

/** Window beririsan dgn region tercatat (gabungan interval boleh terdiri dari banyak halaman). */
const intersects = (ivs: Array<{ lo: number; hi: number }>, t0: number, t1: number): boolean =>
  ivs.some((iv) => iv.lo <= t1 && iv.hi >= t0);

/** Window [t0,t1] tercakup penuh union interval bersih tanpa memotong gap? */
function coveredByClean(clean: Interval[], gaps: Array<{ lo: number; hi: number }>, t0: number, t1: number): boolean {
  if (!intersects(clean, t0, t1)) return false;
  if (gaps.some((g) => g.lo < t1 && g.hi > t0)) return false; // gap memotong window
  // union harus menutup window tanpa celah di dalamnya:
  const ivs = clean.filter((c) => c.hi >= t0 && c.lo <= t1).sort((a, b) => a.lo - b.lo);
  let reach = t0;
  for (const iv of ivs) { if (iv.lo > reach + 1) return false; reach = Math.max(reach, iv.hi); }
  return reach >= t1;
}

/** Penilaian cakupan window [t0, t1] pada asOf — murni, dari rekaman pass. */
export function assessWindowCoverage(
  rows: CoverageRow[], t0: number, t1: number, asOf: number,
  opts: { migrated?: boolean; hasLedger?: boolean } = {},
): { state: WindowCoverage; reason: string } {
  if (asOf < t1) return { state: "WINDOW_NOT_MATURED", reason: `window berakhir ${((t1 - asOf) / 1000).toFixed(0)}s lagi` };
  if (opts.migrated) return { state: "DATA_INCOMPLETE", reason: "MIGRASI_PUMPSWAP — tape bonding-curve saja bukan tape pasar lengkap setelah migrasi" };
  if (opts.hasLedger === false || rows.length === 0) return { state: "COVERAGE_UNKNOWN", reason: "tidak ada rekaman akuisisi utk mint ini" };
  const { clean, gaps, tailTs } = derive(rows);
  if (tailTs != null && t0 < tailTs) return { state: "DATA_INCOMPLETE", reason: `window menyentuh riwayat di bawah tail (${new Date(tailTs).toISOString().slice(11, 19)}) — tidak direkonstruksi (budget)` };
  if (!intersects(clean, t0, t1) && !gaps.some((g) => g.lo < t1 && g.hi > t0)) {
    // tak ada interval bersih maupun gap yang menyentuh window → window berada di luar
    // region terenumerasi (mis. sebelum observasi kita) → tidak bisa dinilai
    return { state: "COVERAGE_UNKNOWN", reason: "window di luar region akuisisi tercatat" };
  }
  if (coveredByClean(clean, gaps, t0, t1)) return { state: "DATA_COMPLETE", reason: "window tertutup penuh oleh interval halaman bersih tanpa gap" };
  return { state: "DATA_INCOMPLETE", reason: gaps.length ? `gap akuisisi terbuka memotong window (${gaps.length})` : "interval halaman tidak menutup window (lubang/backlog belum pulih)" };
}
