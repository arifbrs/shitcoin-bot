import { test, eq, assert } from "../testing/harness.js";
import { tpHoldSatisfied, nextTpHoldStreak } from "./tp-hold.js";

test("tp-hold: kontrol (required 0) menjual PADA sentuhan pertama — perilaku lama utuh", () => {
  eq(tpHoldSatisfied(0, 0), true, "tanpa syarat tahan → langsung");
  eq(tpHoldSatisfied(5, 0), true, "tetap langsung");
});

test("tp-hold: syarat tahan hanya terpenuhi setelah cukup tick", () => {
  eq(tpHoldSatisfied(2, 3), false, "2 < 3 → tahan dulu");
  eq(tpHoldSatisfied(3, 3), true, "3 = 3 → boleh jual");
  eq(tpHoldSatisfied(4, 3), true, "4 ≥ 3 → boleh jual");
});

test("tp-hold: hitungan tick nol lagi begitu harga turun di bawah ambang", () => {
  eq(nextTpHoldStreak(0, true), 1, "sentuhan pertama");
  eq(nextTpHoldStreak(1, true), 2, "bertahan");
  eq(nextTpHoldStreak(2, false), 0, "turun → hitungan direset (tidak boleh diakumulasi dari lonjakan yang terputus)");
});

test("tp-hold: lonjakan terputus tidak pernah memenuhi syarat tahan", () => {
  // Tiga sentuhan yang selalu diselingi turun → harus tetap 0, bukan 3.
  let streak = 0;
  for (const above of [true, false, true, false, true, false]) {
    streak = nextTpHoldStreak(streak, above);
    assert(!tpHoldSatisfied(streak, 3), `streak ${streak} tidak boleh lolos syarat 3`);
  }
});
