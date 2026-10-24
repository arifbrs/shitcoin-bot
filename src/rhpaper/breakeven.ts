/**
 * MATEMATIKA BREAK-EVEN (round-5 #1) — murni, teruji analitik.
 *
 * SEMANTIK TERVERIFIKASI (bukti kode + data, lihat PLAN_PROGRESS round-5):
 *   - TP/stop dievaluasi pada `pnl.netPct` (engine.ts shouldExit) = selisih quote jual vs masuk
 *     MINUS gas FLAT. Biaya sisi-quote (fee pool + platform + dampak harga, DUA kaki) SUDAH
 *     terkandung di dalam quote — tidak ditambahkan lagi.
 *   - Gas = WEI ABSOLUT (ROUND_TRIP_GAS_WEI = 11,4e12) — BUKAN persen; 1,14% hanya benar pada
 *     notional 0,001 ETH (berskala 1/ukuran; pada 0,01 ETH = 0,114%).
 *   - fillmodel-v1: latensi 0,5%/kaki, diterapkan SEKALI per fill — overlay 1,0 pp per putaran.
 *
 * Rumus (turunan): pemenang net = TP − d; pecundang net = −(SL + d), dengan d = drag TAMBAHAN
 * yang belum ada di dasar pengukuran threshold (bukan gas, bukan fee quote).
 *   BE(p) = (SL + d) / (TP + SL)          [berlaku untuk TP/SL simetris-drag]
 *   layak (feasible) ⇔ TP > d             [kalau tidak, keluar-TP pun net rugi]
 * Kasus khusus d = 0 → BE = SL/(TP+SL).
 */
export interface BreakevenResult {
  netWinnerPct: number; // hasil net saat keluar TP (dengan drag d)
  netLoserPct: number; // hasil net saat keluar SL
  breakEvenWinRate: number | null; // null = mustahil (bahkan keluar TP tetap rugi)
  feasible: boolean;
  note: string;
}

export function breakeven(takePct: number, stopPct: number, incrementalDragPct = 0): BreakevenResult {
  if (!(takePct > 0) || !(stopPct > 0)) throw new Error("breakeven: TP dan SL harus > 0");
  if (incrementalDragPct < 0) throw new Error("breakeven: drag tidak boleh negatif");
  const netWinnerPct = takePct - incrementalDragPct;
  const netLoserPct = -(stopPct + incrementalDragPct);
  if (netWinnerPct <= 0) {
    return { netWinnerPct, netLoserPct, breakEvenWinRate: null, feasible: false,
      note: "MUSTAHIL: bahkan keluar-TP net rugi (TP ≤ drag tambahan) — strategi tidak layak di bawah asumsi biaya ini" };
  }
  const be = (stopPct + incrementalDragPct) / (takePct + stopPct);
  return { netWinnerPct, netLoserPct, breakEvenWinRate: be, feasible: true,
    note: "syarat perlu, bukan cukup: winrate ≥ BE pada distribusi exit nyata belum berarti expectancy > 0 (exit 'waktu' & kegagalan eksekusi ikut menentukan)" };
}

/** Standbiaya per putaran, dipecah komponen dengan SumberEksplisit — alat anti-ganda-hitung. */
export interface CostStack { gasPct: number; quoteSidePct: number; latencyPct: number }
export function roundTripDragPct(stack: CostStack): number {
  return stack.gasPct + stack.quoteSidePct + stack.latencyPct;
}

/** Gas persen dari notional: wei FLAT → persen = gas/notional. */
export function gasPctForNotional(gasWei: bigint, notionalWei: bigint): number {
  if (notionalWei <= 0n) throw new Error("gasPctForNotional: notional harus > 0");
  return Number(gasWei * 1_000_000n / notionalWei) / 10_000;
}

/** Tabel skenario analitik: 0 biaya · 1,14 (gas-bruto hipotetis) · 1,0 (fillmodel) · 2,6 (hipotetis). */
export function scenarioTable(arms: Array<{ name: string; takePct: number; stopPct: number }>): string[] {
  const drags: Array<{ label: string; d: number }> = [
    { label: "d=0 (nol biaya tambahan; threshold sudah net)", d: 0 },
    { label: "d=1,00 pp (overlay latensi fillmodel-v1: 0,5%×2 kaki)", d: 1.0 },
    { label: "d=1,14 pp (hipotetis: gas dianggap BELUM di dalam threshold)", d: 1.14 },
    { label: "d=2,60 pp (hipotetis: seluruh drag bruto di luar threshold)", d: 2.6 },
  ];
  const lines: string[] = [];
  for (const arm of arms) {
    lines.push(`arm ${arm.name} (TP ${arm.takePct}% / SL ${arm.stopPct}%):`);
    for (const { label, d } of drags) {
      const r = breakeven(arm.takePct, arm.stopPct, d);
      lines.push(`  ${label} → pemenang net ${r.netWinnerPct.toFixed(2)}% · pecundang net ${r.netLoserPct.toFixed(2)}% · BE=${r.breakEvenWinRate == null ? "MUSTAHIL" : (r.breakEvenWinRate * 100).toFixed(1) + "%"}${r.feasible ? "" : " ← TIDAK LAYAK"}`);
    }
  }
  return lines;
}

/**
 * TABEL BENCHMARK AUDITOR (round-6 P1) — SATU-SATUNYA sumber angka BE yang boleh dikutip laporan.
 * Invariant anti-transkripsi: laporan menyalin keluaran ini verbatim (tools/breakeven-table.ts);
 * breakeven.test.ts mengunci tiap nilai terhadap fungsi produksi yang sama.
 * Ekspektasi auditor round-6: A/1,0=71,428571 · A/2,6=INFEASIBLE · B/1,14=53,50 · B/2,6=90,00 ·
 * C/1,14=44,857143 · C/2,6=65,714286 — semuanya direproduksi.
 */
export function benchmarkTable(): string[] {
  const ARMS: Array<{ name: string; takePct: number; stopPct: number }> = [
    { name: "A", takePct: 2, stopPct: 1.5 },
    { name: "B", takePct: 3, stopPct: 1 },
    { name: "C", takePct: 5, stopPct: 2 },
  ];
  const DRAGS = [0, 1.0, 1.14, 2.6];
  const lines = [
    "Rumus: BE = (SL + d) / (TP + SL); layak ⇔ TP > d. Threshold SUDAH memuat gas + fee quote;",
    "d = drag INKREMENTAL (fillmodel-v1 latensi 0,5%/kaki → d = 1,0 pp). Gas = wei absolut.", "",
  ];
  for (const arm of ARMS) {
    lines.push(`Arm ${arm.name} (TP ${arm.takePct}% / SL ${arm.stopPct}%):`);
    for (const d of DRAGS) {
      const r = breakeven(arm.takePct, arm.stopPct, d);
      const be = r.breakEvenWinRate == null ? "INFEASIBLE" : (r.breakEvenWinRate * 100).toFixed(6) + "%";
      lines.push(`  d=${d.toFixed(2)} pp → netWin=${r.netWinnerPct.toFixed(2)}% netLoss=${r.netLoserPct.toFixed(2)}% BE=${be}${r.feasible ? "" : "  [TP ≤ d]"}`);
    }
  }
  return lines;
}
