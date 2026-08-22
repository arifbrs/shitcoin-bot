import { diagnose, findBlindPositions } from "./watchdog.mjs";
const NOW = 1_700_000_000_000, M = 60_000;
const H = (o) => ({ at: NOW, inFlight: 1, maxConcurrent: 4, rps: 2.5, ...o });
let fail = 0;
const A = (name, got, want) => {
  const ok = (got.length > 0) === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(46)} ${got.length ? got.join(" · ") : "sehat"}`);
};
// sehat
A("normal", diagnose(H(), NOW - M, NOW - M, NOW).reasons, false);
A("sibuk penuh TAPI ada lalu lintas", diagnose(H({ inFlight: 4, rps: 7.8 }), NOW - M, NOW - M, NOW).reasons, false);
A("sepi tapi izin bebas", diagnose(H({ inFlight: 0, rps: 0 }), NOW - M, NOW - M, NOW).reasons, false);
A("belum ada rpc-health (baru boot)", diagnose(null, NOW, NOW, NOW).reasons, false);
A("keputusan sepi TAPI launch juga sepi", diagnose(H(), NOW - 30 * M, NOW - 30 * M, NOW).reasons, false);
// sakit — persis insiden 2026-08-07
A("INSIDEN: inFlight 4/4 dengan rps 0", diagnose(H({ inFlight: 4, rps: 0 }), NOW - M, NOW - M, NOW).reasons, true);
A("launch masuk, keputusan diam 20 menit", diagnose(H(), NOW - M, NOW - 20 * M, NOW).reasons, true);
A("rpc-health berhenti ditulis", diagnose(H({ at: NOW - 15 * M }), NOW - M, NOW - M, NOW).reasons, true);
A("dua gejala sekaligus", diagnose(H({ inFlight: 4, rps: 0 }), NOW - M, NOW - 20 * M, NOW).reasons, true);
// tepi
A("maxConcurrent 0 tidak dianggap buntu", diagnose(H({ inFlight: 0, maxConcurrent: 0, rps: 0 }), NOW - M, NOW - M, NOW).reasons, false);
A("mtime tidak diketahui tidak memicu", diagnose(H(), null, null, NOW).reasons, false);

// ── POSISI BUTA ────────────────────────────────────────────────────────────
const pos = (o) => ({ positions: [{ candidate: { mint: "M1", symbol: "SMILE" }, openedAt: NOW - o.ageSec * 1000, lastPriceUsd: o.price ?? null }] });
const B = (name, got, want) => {
  const ok = (got.length > 0) === want;
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(46)} ${got.length ? got.map((b) => b.sym + " " + b.ageSec + "s") : "tidak ada"}`);
};
B("SMILE nyata: 635s tanpa harga, tak pernah di-mark",
  findBlindPositions(pos({ ageSec: 635 }), new Set(), NOW), true);
B("baru dibuka 30s — belum waktunya",
  findBlindPositions(pos({ ageSec: 30 }), new Set(), NOW), false);
B("lama TAPI sudah pernah di-mark",
  findBlindPositions(pos({ ageSec: 600 }), new Set(["M1"]), NOW), false);
B("lama, tak ada tick, TAPI punya lastPriceUsd",
  findBlindPositions(pos({ ageSec: 600, price: 1.2e-7 }), new Set(), NOW), false);
B("tidak ada posisi terbuka", findBlindPositions({ positions: [] }, new Set(), NOW), false);
B("state kosong/rusak", findBlindPositions(null, new Set(), NOW), false);
B("posisi tanpa openedAt diabaikan",
  findBlindPositions({ positions: [{ candidate: { mint: "M2" } }] }, new Set(), NOW), false);

console.log(fail === 0 ? "  LULUS" : `  GAGAL ${fail}`);
process.exit(fail ? 1 : 0);
