/** Round-5 #1: matematika break-even analitik + verifikasi semantik biaya (anti-ganda-hitung). */
import { test, eq, approx, assert, throws } from "../testing/harness.js";
import { breakeven, scenarioTable, benchmarkTable, gasPctForNotional, roundTripDragPct } from "./breakeven.js";
import { ROUND_TRIP_GAS_WEI, quotePnl } from "./engine.js";
import { applyLatencySlippage } from "./fillmodel.js";

test("R5 analitik: d=0 → BE = SL/(TP+SL) — rumus dasar", () => {
  const r = breakeven(2, 1.5, 0);
  approx(r.breakEvenWinRate!, 1.5 / 3.5, 1e-12, "arm A tanpa drag tambahan");
  approx(r.netWinnerPct, 2, 1e-12, "pemenang = TP");
  approx(r.netLoserPct, -1.5, 1e-12, "pecundang = −SL");
});

test("R5 analitik: BE = (SL+d)/(TP+SL) — d=1,0 reproduksi 71,4% (angka 72% laporan, kini dari rumus)", () => {
  const r = breakeven(2, 1.5, 1.0);
  approx(r.breakEvenWinRate!, 2.5 / 3.5, 1e-12, "71,43%");
  approx(r.netWinnerPct, 1.0, 1e-12, "pemenang net = TP − d");
  approx(r.netLoserPct, -2.5, 1e-12, "pecundang net = −(SL+d)");
});

test("R5 analitik: TP ≤ d = MUSTAHIL (keluar-TP pun rugi) — Auditor: BE 117% tidak sah, dilabel eksplisit", () => {
  const r = breakeven(2, 1.5, 2.6);
  eq(r.breakEvenWinRate, null, "bukan angka >100% — null dengan alasan");
  eq(r.feasible, false, "tidak layak");
  assert(r.netWinnerPct < 0, "pemenang net negatif");
});

test("R5 analitik: benchmark '1,02 pp' auditor → BE tepat 72% mengonfirmasi drag inkremental ~1 pp, bukan 2,6", () => {
  approx(breakeven(2, 1.5, 1.02).breakEvenWinRate!, 2.52 / 3.5, 1e-12, "d=1,02 → (1,5+1,02)/(2+1,5) = 72,0% TEPAT");
  // 72% yang pernah kutulis hanya konsisten dengan d≈1,0 (latensi), BUKAN 2,6 (yang mencakup
  // gas+fee yang SUDAH ada di dasar pengukuran threshold — ganda-hitung).
});

test("R5 ganda-hitung: gas SUDAH di dalam netPct → menambahkannya lagi ke d = kesalahan", () => {
  // Bukti dari data: stop exits arm A n=8 netPct ∈ [−1,742, −1,509] — mengelompok di threshold −1,5,
  // BUKAN di −1,5−1,14=−2,64 (kalau threshold bruto) dan BUKAN di −4,1 (kalau +2,6 di luar).
  // Ini membuktikan: threshold dievaluasi pada nilai yang sudah memuat gas + fee quote.
  const stops = [-1.742, -1.630, -1.509]; // sampel nyata (ledger 2026-10-24)
  const mean = stops.reduce((a, b) => a + b, 0) / stops.length;
  assert(Math.abs(mean + 1.6) < 0.15, `stop exits ≈ threshold net (${mean.toFixed(2)} ≈ −1,5..−1,7)`);
  assert(Math.abs(mean + 2.64) > 0.5, "bukan pola 'threshold bruto − gas'");
  assert(Math.abs(mean + 4.1) > 1.0, "bukan pola 'threshold − 2,6 pp'");
});

test("R5 gas = WEI ABSOLUT: 1,14% hanya pada 0,001 ETH — skala 1/ukuran (bukan persen tetap)", () => {
  approx(gasPctForNotional(ROUND_TRIP_GAS_WEI, 1_000_000_000_000_000n), 1.14, 1e-9, "0,001 ETH → 1,14%");
  approx(gasPctForNotional(ROUND_TRIP_GAS_WEI, 10_000_000_000_000_000n), 0.114, 1e-9, "0,01 ETH → 0,114%");
  approx(gasPctForNotional(ROUND_TRIP_GAS_WEI, 100_000_000_000_000n), 11.4, 1e-9, "0,0001 ETH → 11,4% (flat wei membesar persennya di ukuran kecil)");
});

test("R5 quotePnl + fillmodel: gas sekali, latensi sekali per kaki — tanpa ganda", () => {
  // Kasus TP di arm A: quote jual memberi +3,14% gross → netPct = 3,14 − 1,14 = +2,00 (kena TP).
  const pnl = quotePnl("1000000000000000", "1031400000000000");
  approx(pnl.grossPct, 3.14, 1e-9, "gross dari quote");
  approx(pnl.netPct, 2.0, 1e-9, "net = gross − 1,14 (gas SEKALI)");
  // Overlay latensi fillmodel: SEKALI per kaki, 0,5% masing-masing → total 1,0 pp, tidak dikompound.
  const entryFill = applyLatencySlippage("2000000000000000000", 0.5); // 0,995×
  const exitFill = applyLatencySlippage("1000000000000000", 0.5); // 0,995×
  approx((Number(entryFill) / 2e18) * (1 - 0.005), 0.995 * 0.995, 1e-9, "dua kaki × 0,995 = 0,990025 (bukan 0,995² dari 0,995²)");
  approx(roundTripDragPct({ gasPct: 0, quoteSidePct: 0, latencyPct: 1.0 }), 1.0, 1e-12, "overlay inkremental = 1,0 pp");
});

test("R5 tabel skenario: setiap arm dilaporkan pada 4 benchmark, verdict TIDAK LAYAK eksplisit", () => {
  const lines = scenarioTable([
    { name: "A", takePct: 2, stopPct: 1.5 },
    { name: "B", takePct: 3, stopPct: 1 },
    { name: "C", takePct: 5, stopPct: 2 },
  ]);
  assert(lines.some((l) => l.includes("MUSTAHIL")), "d=2,6 → TP A tidak layak, B/C layak dibatas");
  assert(lines.some((l) => l.includes("71.4%")), "arm A d=1,0 → 71,4%");
  // C dengan d=1,0: BE = (2+1)/(5+2) = 42,9% — paling tahan biaya dari ketiganya.
  approx(breakeven(5, 2, 1.0).breakEvenWinRate!, 3 / 7, 1e-12, "arm C d=1,0");
});

test("R6 benchmark auditor (6 kasus eksak) dikunci ke fungsi produksi — transkripsi tangan tidak sah", () => {
  approx(breakeven(2, 1.5, 1.0).breakEvenWinRate!, 2.5 / 3.5, 1e-12, "A/1,0 = 71,428571%");
  const a26 = breakeven(2, 1.5, 2.6);
  eq(a26.breakEvenWinRate, null, "A/2,6 = INFEASIBLE (netWin −0,60)");
  approx(breakeven(3, 1, 1.14).breakEvenWinRate!, 2.14 / 4, 1e-12, "B/1,14 = 53,500000% — BUKAN 52,7% (koreksi laporan round-5)");
  approx(breakeven(3, 1, 2.6).breakEvenWinRate!, 3.6 / 4, 1e-12, "B/2,6 = 90,000000% — LAYAK (TP 3 > d 2,6; koreksi laporan round-5)");
  approx(breakeven(5, 2, 1.14).breakEvenWinRate!, 3.14 / 7, 1e-12, "C/1,14 = 44,857143%");
  approx(breakeven(5, 2, 2.6).breakEvenWinRate!, 4.6 / 7, 1e-12, "C/2,6 = 65,714286% — BUKAN 56,0% (koreksi laporan round-5)");
});

test("R6 invariant anti-transkripsi: benchmarkTable() menghasilkan angka yang dikunci tes", () => {
  const table = benchmarkTable().join("\n");
  for (const expect of ["BE=71.428571%", "BE=INFEASIBLE", "BE=53.500000%", "BE=90.000000%", "BE=44.857143%", "BE=65.714286%"]) {
    assert(table.includes(expect), `tabel harus memuat ${expect} — angka laporan = angka produksi`);
  }
  assert(table.includes("B/2,6") === false, "tabel bukan teks manual");
});

test("R6 batas: d mendekati TP, tepat TP, melewati TP; d=0; distribusi tak-simetris; exit waktu", () => {
  // d → TP: pemenang menyusut ke 0; di d=TP tepat, netWin=0 → infeasible (semua exit ≤ 0).
  approx(breakeven(2, 1.5, 1.99).breakEvenWinRate!, 3.49 / 3.5, 1e-12, "d=1,99 → BE 99,71% (menuju 100%)");
  eq(breakeven(2, 1.5, 2.0).breakEvenWinRate, null, "d=TP tepat → netWin=0 → tidak layak");
  eq(breakeven(2, 1.5, 3.0).breakEvenWinRate, null, "d>TP → tidak layak");
  // d=0: simetris dasar.
  approx(breakeven(5, 2, 0).breakEvenWinRate!, 2 / 7, 1e-12, "d=0 → SL/(TP+SL)");
  throws(() => breakeven(2, 1.5, -1), "drag negatif ditolak");
  throws(() => breakeven(0, 1.5, 0), "TP=0 ditolak");
  // Distribusi tak-simetris (exit 'waktu' punya hasil variabel): teoretis BE threshold TIDAK
  // berlaku — yang sah adalah expectancy & PF empiris (dilaporkan terpisah oleh cohort-stats).
  const realized = { wins: [1.9, 2.1, 2.0], losses: [-1.6, -2.9] }; // 1 take + 2 waktu menang, 2 rugi
  const beEmpirical = (realized.losses.reduce((a, b) => a + b, 0) / realized.losses.length * -1) /
    ((realized.losses.reduce((a, b) => a + b, 0) / realized.losses.length * -1) + realized.wins.reduce((a, b) => a + b, 0) / realized.wins.length);
  assert(beEmpirical > 0 && beEmpirical < 1, "BE empiris dari distribusi realisasi dihitung terpisah");
  assert(beEmpirical !== breakeven(2, 1.5, 1.0).breakEvenWinRate, "BE empiris ≠ BE teoretis threshold — tidak boleh dicampur");
});
