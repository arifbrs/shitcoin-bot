/**
 * VERDICT SELF-TEST.
 *
 * Aturan ini memutuskan apakah uang terus dipertaruhkan, jadi kegagalan yang dijaga bukan crash
 * melainkan aturan yang bisa dilonggarkan tanpa ada yang sadar: n kecil yang lolos, selang yang
 * melewati nol tapi dihitung menang, atau pemenang EKSPLORATIF yang menyelinap jadi GO.
 */
import { strict as assert } from "node:assert";
import { proven, verdictOf, VERDICT_SPEC, type Slice } from "./verdict.js";

let n = 0;
const ok = (name: string, cond: boolean): void => { assert.ok(cond, name); n++; };
const S = (p: Partial<Slice>): Slice => ({ label: "x", n: 500, ev: 10, ci: 3, sol: 1, exploratory: false, ...p });

ok("EV positif + selang bersih + n cukup = terbukti", proven(S({})));
ok("n kurang → TIDAK terbukti, berapa pun EV-nya", !proven(S({ n: VERDICT_SPEC.minN - 1, ev: 999, ci: 0.1 })));
ok("selang melewati nol → TIDAK terbukti", !proven(S({ ev: 5, ci: 6 })));
ok("selang menyentuh nol persis → TIDAK terbukti (batas ketat)", !proven(S({ ev: 5, ci: 5 })));
ok("EV negatif → TIDAK terbukti walau selangnya sempit", !proven(S({ ev: -5, ci: 0.1 })));

const before = new Date("2026-08-27T00:00:00Z");
const after = new Date("2026-09-03T00:00:00Z");
ok("tidak ada yang terbukti + sebelum tenggat = BELUM", verdictOf([S({ ev: -9 })], before) === "BELUM");
ok("tidak ada yang terbukti + lewat tenggat = STOP", verdictOf([S({ ev: -9 })], after) === "STOP");
ok("terdaftar & terbukti = GO", verdictOf([S({})], before) === "GO");
ok("  → GO tetap berlaku walau tenggat lewat", verdictOf([S({})], after) === "GO");

// Yang paling penting: pemenang eksploratif TIDAK boleh menyelamatkan strategi.
ok("pemenang EKSPLORATIF tidak bisa menyatakan GO",
  verdictOf([S({ ev: -9 }), S({ label: "MAX_HOLD", ev: 40, ci: 5, exploratory: true })], before) === "BELUM");
ok("  → dan setelah tenggat tetap STOP",
  verdictOf([S({ ev: -9 }), S({ label: "MAX_HOLD", ev: 40, ci: 5, exploratory: true })], after) === "STOP");

ok("daftar kosong + lewat tenggat = STOP", verdictOf([], after) === "STOP");
ok("spec beku (tidak bisa dilonggarkan saat berjalan)", Object.isFrozen(VERDICT_SPEC));
ok("  → dan ambang n-nya memang tinggi", VERDICT_SPEC.minN >= 200);

console.log(`verdict-selftest: ${n}/${n} passed`);
