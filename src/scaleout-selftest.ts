import { strict as assert } from "node:assert";
import { clampedScaleSellQty, composeTradePnl } from "./trader.js";

const original = 100;
let remaining = original;
const first = clampedScaleSellQty(original, remaining, 0.4, 0.15);
remaining -= first;
const second = clampedScaleSellQty(original, remaining, 0.3, 0.15);
remaining -= second;
const third = clampedScaleSellQty(original, remaining, 0.15, 0.15);
remaining -= third;
const impossibleFourth = clampedScaleSellQty(original, remaining, 0.05, 0.15);

assert.equal(first, 40);
assert.equal(second, 30);
assert.equal(third, 15);
assert.equal(remaining, 15);
assert.equal(impossibleFourth, 0);
assert.equal(clampedScaleSellQty(100, 18, 0.05, 0.15), 3);

// ── KOMPOSISI P&L: mentah dan terbukukan harus SEBANDING ──────────────────────
// Bug yang dijaga di sini nyata dan lolos dari semua pemeriksaan lain: pada trade yang
// sudah scale-out, "mentah" dulu mencakup kaki sisa saja sementara "terbukukan" mencakup
// seluruh trade. Anastasia (2026-08-25) tercetak kaki +29,25% mentah di sebelah trade
// +30,74% terbukukan — kedua angka benar, perbandingannya tidak ada artinya, dan yang
// terbaca adalah "koreksi malah menaikkan pemenang".
{
  // Persis kasus Anastasia: 0,15 masuk, dua partial menyisakan 0,045 di kaki terakhir.
  const c = composeTradePnl({
    sizeSol: 0.045, originalSizeSol: 0.15,
    legPct: 17.20, rawLegPct: 29.25,
    partialSol: 0.038366, rawPartialSol: 0.052,
  });
  assert.ok(Math.abs(c.pnlPct - 30.74) < 0.01, `pnlPct ${c.pnlPct}`);
  // Yang penting: angka mentah memakai DENOMINATOR yang sama, jadi bisa dibandingkan.
  assert.ok(Math.abs(c.rawPnlPct - ((0.045 * 0.2925 + 0.052) / 0.15) * 100) < 1e-9);
  // Dan dengan koreksi yang memangkas untung, trade ini TIDAK boleh terbukukan lebih tinggi.
  assert.ok(c.pnlPct < c.rawPnlPct, `terbukukan ${c.pnlPct} >= mentah ${c.rawPnlPct}`);
}
{
  // Tanpa partial, keduanya harus jatuh tepat di kaki — kasus KATE.
  const c = composeTradePnl({
    sizeSol: 0.15, originalSizeSol: 0.15,
    legPct: 8.64, rawLegPct: 17.65, partialSol: 0, rawPartialSol: 0,
  });
  assert.ok(Math.abs(c.pnlPct - 8.64) < 1e-9);
  assert.ok(Math.abs(c.rawPnlPct - 17.65) < 1e-9);
}
{
  // Posisi berukuran nol tidak boleh melahirkan NaN ke dalam ledger.
  const c = composeTradePnl({ sizeSol: 0, originalSizeSol: 0, legPct: 10, rawLegPct: 10, partialSol: 0, rawPartialSol: 0 });
  assert.equal(c.pnlPct, 0);
  assert.equal(c.rawPnlPct, 0);
}

console.log("scaleout-selftest: 12/12 passed");
