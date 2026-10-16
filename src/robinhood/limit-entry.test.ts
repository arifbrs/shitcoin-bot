import { test, eq } from "../testing/harness.js";
import { LIMIT_MATRIX, LIMIT_EXTRA, ALL_LIMIT_RULES, limitArmId } from "./limit-entry.js";

test("kohort-11: ID arm lama v59-v68 TIDAK bergeser (sampel berjalan tidak boleh tercampur)", () => {
  eq(limitArmId(LIMIT_MATRIX[0]!), "v59-limit-d5-e15", "arm pertama");
  eq(limitArmId(LIMIT_MATRIX[1]!), "v60-limit-d5-e60", "arm kedua");
  eq(limitArmId(LIMIT_MATRIX[9]!), "v68-limit-d30-e60", "arm kesepuluh");
});

test("kohort-11: kombinasi baru memakai v69+ (tidak menimpa yang lama)", () => {
  eq(limitArmId(LIMIT_EXTRA[0]!), "v69-limit-d7.5-e15", "extra pertama");
  eq(limitArmId(LIMIT_EXTRA[5]!), "v74-limit-d12.5-e60", "extra terakhir");
});

test("kohort-11: TIDAK ADA ID kembar di seluruh matriks", () => {
  const ids = ALL_LIMIT_RULES.map((r) => limitArmId(r));
  eq(new Set(ids).size, ids.length, "jumlah ID unik = jumlah aturan");
});

test("kohort-11: aturan tak dikenal DITOLAK (gagal keras, bukan ID salah)", () => {
  let err = "";
  try { limitArmId({ distPct: 99, expiryMin: 7 }); } catch (e) { err = (e as Error).message; }
  if (!err.includes("tak dikenal")) throw new Error("seharusnya menolak aturan tak dikenal");
});
