import { test, eq } from "../testing/harness.js";
import { livePoolOk, cacheAgeMin, loadCache, type RoutableCache } from "./livepool-gate.js";

const cache: RoutableCache = { ts: 1_000_000, routable: [{ token: "0xAAAA000000000000000000000000000000000001", symbol: "SEXLA" }] };

test("livepool: token di daftar → LULUS", () => {
  eq(livePoolOk("0xaaaa000000000000000000000000000000000001", cache), true, "huruf besar/kecil tak masalah");
});

test("livepool: token tidak di daftar → DITOLAK", () => {
  eq(livePoolOk("0xbbbb000000000000000000000000000000000002", cache), false, "tidak ada");
});

test("livepool: cache KOSONG → DITOLAK (fail-closed, bukan asal lolos)", () => {
  eq(livePoolOk("0xaaaa000000000000000000000000000000000001", {}), false, "cache kosong");
  eq(livePoolOk("0xaaaa000000000000000000000000000000000001", { routable: [] }), false, "daftar kosong");
});

test("livepool: entri rusak tidak membuat token lain lolos", () => {
  const c: RoutableCache = { routable: [{ token: "" }, { token: "0xcccc" }] };
  eq(livePoolOk("0xaaaa000000000000000000000000000000000001", c), false, "aman");
});

test("livepool: usia cache terhitung (tua = sinyal mungkin tak berlaku)", () => {
  eq(cacheAgeMin(cache, 1_000_000 + 600_000), 10, "10 menit");
  eq(cacheAgeMin({}, 1), null, "tak diketahui");
});

test("livepool: berkas tak ada → cache kosong (tanpa lempar galat)", () => {
  eq(Object.keys(loadCache("/tidak/ada/rh-routable.json")).length, 0, "aman");
});
