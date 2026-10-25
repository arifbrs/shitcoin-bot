import { test, eq, approx, assert } from "../testing/harness.js";
import { signTest, bootstrapCI, bootstrapDiffCI, mean, sd, requiredNPerArm, concentration } from "./stats.js";

test("stats: signTest pada 11 menang dari 28 = 0,345 (angka yang dipakai verdict kohort-5A)", () => {
  approx(signTest(11, 28), 0.345, 0.005, "p dua-sisi 11/28");
});

test("stats: signTest ekstrem kecil dan seri netral", () => {
  assert(signTest(0, 10) < 0.01, "nol menang dari 10 harus sangat kecil");
  approx(signTest(5, 10), 1, 1e-9, "separuh menang = tak ada bukti apa pun");
  eq(signTest(0, 0), 1, "tanpa data p=1");
});

test("stats: bootstrapCI mengurung rata-rata dan terurut", () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const [lo, hi] = bootstrapCI(v, 2000);
  assert(lo <= hi, "batas bawah ≤ batas atas");
  assert(lo <= mean(v) && mean(v) <= hi, "rata-rata harus di dalam interval");
});

test("stats: bootstrapCI menolak sampel terlalu kecil (jujur, bukan angka palsu)", () => {
  const [lo, hi] = bootstrapCI([1, 2]);
  assert(Number.isNaN(lo) && Number.isNaN(hi), "sampel <3 → NaN");
});

test("stats: bootstrapDiffCI memisahkan grup yang jelas berbeda", () => {
  const a = [10, 11, 12, 13, 14, 15];
  const b = [1, 2, 3, 4, 5, 6];
  const [lo, hi] = bootstrapDiffCI(a, b, 2000);
  assert(lo > 0, `interval harus di atas nol, dapat [${lo}, ${hi}]`);
});

test("stats: bootstrapDiffCI melewati nol bila grup serupa", () => {
  const a = [5, 6, 7, 8, 9, 10];
  const b = [5, 6, 7, 8, 9, 10];
  const [lo, hi] = bootstrapDiffCI(a, b, 2000);
  assert(lo <= 0 && hi >= 0, `interval harus memuat nol, dapat [${lo}, ${hi}]`);
});

test("stats: requiredN turun bila efek membesar, dan tak hingga bila efek nol", () => {
  const n1 = requiredNPerArm(1, 5);
  const n2 = requiredNPerArm(5, 5);
  assert(n2 < n1, "efek lebih besar butuh sampel lebih sedikit");
  eq(requiredNPerArm(0, 5), Infinity, "efek nol tak akan pernah terbukti");
});

test("stats: concentration mendeteksi hasil yang bergantung pada satu pemenang", () => {
  const c = concentration([78, 12, 10, 5, -10, -7]);
  approx(c.topSharePct, 78 / 88, 1e-9, "bagian top-1");
  approx(c.netExclTop1, 10, 1e-9, "net tanpa top-1");
  approx(c.netExclTop2, -2, 1e-9, "net tanpa top-2");
});

test("stats: concentration pada net negatif tidak membalik tanda secara menyesatkan", () => {
  const c = concentration([39, -250, -100]);
  approx(c.netExclTop1, -350, 1e-9, "net tanpa top-1 tetap negatif");
});

test("stats: mean/sd pada data kosong tidak mengarang angka", () => {
  assert(Number.isNaN(mean([])), "mean kosong = NaN");
  assert(Number.isNaN(sd([1])), "sd satu titik = NaN");
  approx(sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-4, "sd contoh baku");
});
