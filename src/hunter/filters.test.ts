import { test, eq } from "../testing/harness.js";
import { passesToken, passesTrader, scoreToken, tierOf } from "./filters.js";

const tok = (mcap: number, liq: number) => ({ chain: "robinhood", token: "0x" + "1".repeat(40), symbol: "T", mcapUsd: mcap, liquidityUsd: liq });

test("hunter: filter token mcap<1M & liq<50k", () => {
  eq(passesToken(tok(900_000, 40_000)), true, "lolos");
  eq(passesToken(tok(1_200_000, 40_000)), false, "mcap terlalu besar");
  eq(passesToken(tok(900_000, 60_000)), false, "likuiditas terlalu besar");
  eq(passesToken(tok(0, 10_000)), false, "mcap 0 ditolak");
});

test("hunter: trader ROI>300 & winrate>60 dalam 90 hari", () => {
  eq(passesTrader({ address: "a", roiPct: 350, winratePct: 65, windowDays: 90 }), true, "lolos");
  eq(passesTrader({ address: "a", roiPct: 250, winratePct: 65, windowDays: 90 }), false, "ROI kurang");
  eq(passesTrader({ address: "a", roiPct: 350, winratePct: 55, windowDays: 90 }), false, "winrate kurang");
  eq(passesTrader({ address: "a", roiPct: 350, winratePct: 65, windowDays: 30 }), false, "window kurang");
});

test("hunter: skor & tier", () => {
  const s3 = [400, 500, 600].map((r, i) => ({ address: "t" + i, roiPct: r, winratePct: 70, windowDays: 90 }));
  const sc = scoreToken(tok(500_000, 20_000), s3);
  eq(sc.smart.length, 3, "3 trader lolos");
  eq(sc.tier, "S", "tier S");
  eq(scoreToken(tok(500_000, 20_000), s3.slice(0, 1)).tier, "B", "1 trader → B");
  eq(scoreToken(tok(500_000, 20_000), []).tier, "C", "tanpa trader → C");
  eq(tierOf(2, 900), "A", "A bila 2 trader skor ≥800");
});
