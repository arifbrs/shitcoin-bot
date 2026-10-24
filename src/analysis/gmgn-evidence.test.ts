import { test, eq } from "../testing/harness.js";
import { exactCandidateMark, gmgnCandidateKey, latestAsOf, validExactLedger } from "./gmgn-evidence.js";

const c = { chain: "sol", mint: "m", source: "gmgn-trending", cfg: "a", strategy2Epoch: "e1", firstSeenAt: 1000 };
const o = { ...c, checkedAt: 2000, mcChangePct: 1 };
test("GMGN joins: chain/source/cfg/epoch/first-seen must all match", () => {
  eq(exactCandidateMark(c, o), true, "exact match");
  for (const different of [{ chain: "bsc" }, { source: "gmgn-trenches" }, { cfg: "b" }, { strategy2Epoch: "e2" }, { firstSeenAt: 1100 }, { checkedAt: 999 }]) {
    eq(exactCandidateMark(c, { ...o, ...different }), false, "no fallback on mismatched identity/time");
  }
  eq(gmgnCandidateKey({ ...c, cfg: "unknown" }), null, "unknown config is not a shared cohort");
});
test("GMGN joins: wallet score must exist before trade, regardless of file order", () => {
  const history = [{ at: 3000, winrate: 0.9 }, { at: 1000, winrate: 0.1 }, { at: 2000, winrate: 0.4 }];
  eq(latestAsOf(history, 2500)?.winrate, 0.4, "not latest future winner");
  eq(latestAsOf(history, 500), null, "not retroactively scored");
});
test("GMGN joins: unsafe legacy durable pairs stay excluded", () => {
  eq(validExactLedger({ ...c, mark: o }), false, "legacy exporter had unsafe joins");
  eq(validExactLedger({ ...c, pairingVersion: "gmgn-exact-v2", mark: o }), true, "new exact pair");
  eq(validExactLedger({ ...c, pairingVersion: "gmgn-exact-v2", mark: { ...o, cfg: "b" } }), false, "corrupt paired identity rejected");
});
