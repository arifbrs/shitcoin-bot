import { test, eq, assert } from "../testing/harness.js";
import { hash32, okxVariants, variantFor, type OkxBaseline } from "./okx-variants.js";

const BASE: OkxBaseline = { takeProfitPct: 5, hardStopPct: -8, maxHoldMs: 60_000, pollMs: 3_000, executionDelayMs: 500, maxNoRoute: 3 };

test("okx varian: arm dasar SAMA PERSIS dengan kebijakan yang berjalan (pembanding jujur)", () => {
  const v6 = okxVariants(BASE)[0]!;
  eq(v6.takeProfitPct, BASE.takeProfitPct, "TP tidak berubah");
  eq(v6.hardStopPct, BASE.hardStopPct, "SL tidak berubah");
  eq(v6.maxHoldMs, BASE.maxHoldMs, "hold tidak berubah");
  eq(v6.id, "v6-dasar", "id arm dasar");
});

test("okx varian: arm v7 lebih ketat (stop lebih cepat, hold lebih pendek), bukan lebih longgar", () => {
  const v7 = okxVariants(BASE)[1]!;
  assert(v7.hardStopPct >= BASE.hardStopPct, "stop tidak boleh lebih dalam dari dasar");
  assert(v7.maxHoldMs <= BASE.maxHoldMs, "hold tidak boleh lebih panjang dari dasar");
  assert(v7.hardStopPct !== BASE.hardStopPct || v7.maxHoldMs !== BASE.maxHoldMs, "harus ada bedanya, kalau tidak uji ini kosong");
});

test("okx varian: penugasan deterministik — id sama selalu dapat arm sama", () => {
  for (const id of ["abc-1", "abc-2", "0xdeadbeef", "paper-xyz"]) {
    eq(variantFor(id, BASE).id, variantFor(id, BASE).id, `id ${id} stabil`);
  }
});

test("okx varian: pembagian arm merata (tidak menumpuk di satu arm)", () => {
  const counts = new Map<string, number>();
  for (let i = 0; i < 2000; i++) {
    const v = variantFor(`kandidat-${i}`, BASE);
    counts.set(v.id, (counts.get(v.id) ?? 0) + 1);
  }
  eq(counts.size, okxVariants(BASE).length, "semua arm terpakai");
  for (const [id, n] of counts) {
    const share = n / 2000;
    assert(share > 0.35 && share < 0.65, `arm ${id} dapat ${(share * 100).toFixed(1)}% (harus sekitar 50%)`);
  }
});

test("okx varian: hash32 stabil dan berbeda antar-input", () => {
  eq(hash32("abc"), hash32("abc"), "stabil");
  assert(hash32("abc") !== hash32("abd"), "input beda → hash beda (praktis)");
  assert(Number.isInteger(hash32("x")) && hash32("x") >= 0, "selalu bilangan bulat non-negatif");
});
