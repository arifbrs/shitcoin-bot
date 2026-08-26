/**
 * EXIT-LAG SELF-TEST.
 *
 * The estimate this produces is meant to decide whether "sell faster" is worth engineering, so
 * the failure that matters is a curve that says lag is free when it is not — or the reverse.
 * Both come from the same place: one runaway token in a thin bucket.
 */
import { strict as assert } from "node:assert";
import { lagDecayCurve, decayAt, lagCostPct, LIVE_LAG_QUANTILES, type LagRow } from "./exit-lag-report.js";

const EDGES = [0, 3, 6, 12, 25, 45, 90];
let n = 0;
const ok = (name: string, cond: boolean): void => { assert.ok(cond, name); n++; };

// Turun mantap: harga meluruh makin jauh dari sinyal.
{
  const rows: LagRow[] = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ secSinceExit: 2, pctVsExit: -1 }, { secSinceExit: 8, pctVsExit: -5 },
      { secSinceExit: 30, pctVsExit: -12 });
  }
  const c = lagDecayCurve(rows, EDGES);
  ok("tiap pita terisi", c.length === 3);
  ok("kurva menurun sesuai data", (c[0]!.medianPct) > (c[1]!.medianPct) && (c[1]!.medianPct) > (c[2]!.medianPct));
  ok("interpolasi berada di antara dua titik", (() => {
    const v = decayAt(c, 12)!; return v < c[1]!.medianPct && v > c[2]!.medianPct;
  })());
  ok("di luar jangkauan → datar, tidak diekstrapolasi liar", decayAt(c, 10_000) === c[2]!.medianPct);
  const cost = lagCostPct(c)!;
  ok("biaya jeda negatif ketika harga meluruh", cost < 0);
  ok("  → dan besarannya masuk akal, bukan ekstrapolasi", cost > -12 && cost < -1);
}

// SATU token terbang tidak boleh menyatakan jeda itu gratis.
{
  const rows: LagRow[] = [];
  for (let i = 0; i < 40; i++) rows.push({ secSinceExit: 8, pctVsExit: -6 });
  rows.push({ secSinceExit: 8, pctVsExit: 5_000 }); // satu 50x pasca-exit
  const c = lagDecayCurve(rows, EDGES);
  const b = c.find((x) => x.fromSec === 6)!;
  ok("median menahan satu pencilan", Math.abs(b.medianPct - -6) < 0.001);
  ok("  → sementara rata-rata jelas tertarik (karena itu keduanya dilaporkan)", b.meanPct > 100);
}

// Pita kosong tidak boleh menjadi titik palsu di kurva.
{
  const c = lagDecayCurve([{ secSinceExit: 2, pctVsExit: -1 }], EDGES);
  ok("hanya pita yang punya data yang muncul", c.length === 1);
  ok("kurva kosong tidak melahirkan angka", decayAt([], 5) === null && lagCostPct([]) === null);
}

// Sampel tanpa harga adalah data hilang, bukan nol.
{
  const c = lagDecayCurve([{ secSinceExit: 2, pctVsExit: null }, { secSinceExit: 2, pctVsExit: -4 }], EDGES);
  ok("null diabaikan, tidak dihitung sebagai 0%", c[0]!.n === 1 && Math.abs(c[0]!.medianPct - -4) < 1e-9);
}

// Sebaran jeda yang dipakai harus yang TERUKUR dari chain, bukan angka bulat pilihan tangan.
{
  ok("kuantil jeda live terdaftar", LIVE_LAG_QUANTILES.length >= 5);
  ok("  → p50 3,9s dan p90 38,7s seperti yang diukur", 
    LIVE_LAG_QUANTILES.some((q) => q.q === 0.5 && q.sec === 3.9) &&
    LIVE_LAG_QUANTILES.some((q) => q.q === 0.9 && q.sec === 38.7));
}

console.log(`exit-lag-selftest: ${n}/${n} passed`);
