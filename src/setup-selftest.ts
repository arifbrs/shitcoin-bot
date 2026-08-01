import { strict as assert } from "node:assert";
import { classifySetup, hardAuthorityEvidence } from "./discovery/setup-filter.js";
import type { Candidate } from "./types.js";

const candidate = (extra: Partial<Candidate>): Candidate => ({
  source: "pumpportal",
  mode: "fast-follow",
  mint: `mint-${Math.random()}`,
  detectedAt: Date.now(),
  ...extra,
});

const proxy = classifySetup(candidate({
  launchBundle: { sameSlotMax: 14, bundledShare: 1, earlyTxs: 14, verifiedBuys: false },
}));
assert.notEqual(proxy.verdict, "TOXIC", "unverified transaction-count proxy must not hard skip");

const verified = classifySetup(candidate({
  launchBundle: { sameSlotMax: 14, bundledShare: 1, earlyTxs: 14, verifiedBuys: true },
}));
assert.equal(verified.verdict, "TOXIC", "verified distinct-buyer bundle may hard skip");
assert(verified.evidence.includes("SAME_SLOT_BUNDLE"));

const authorityTimeout = classifySetup(candidate({
  authorityUnknown: true,
  rugCluster: {
    verdict: "CLEAN",
    clusterWallets: 0,
    clusterPct: 0,
    fundingDiversity: 1,
    devFundedBuyers: 0,
    coordinated: false,
  },
}));
assert.equal(authorityTimeout.verdict, "UNKNOWN", "funding evidence cannot override unknown authority");

assert.deepEqual(hardAuthorityEvidence(null), []);
assert.deepEqual(
  hardAuthorityEvidence([
    { name: "mint authority", passed: false, hard: true, detail: "active" },
    { name: "soft info", passed: false, hard: false, detail: "missing" },
  ]),
  ["AUTHORITY_MINT_AUTHORITY"],
);

const mayhem = classifySetup(candidate({ isMayhemMode: true }));
assert.equal(mayhem.verdict, "TOXIC");
assert(mayhem.evidence.includes("UNSUPPORTED_MAYHEM_MODE"));

const nonSolQuote = classifySetup(candidate({ quoteMint: "NonDefaultQuoteMint1111111111111111111111" }));
assert.equal(nonSolQuote.verdict, "TOXIC");
assert(nonSolQuote.evidence.includes("UNSUPPORTED_NON_SOL_QUOTE"));

const wrappedSol = classifySetup(candidate({ quoteMint: "So11111111111111111111111111111111111111112" }));
assert.notEqual(wrappedSol.verdict, "TOXIC", "v2 WSOL instruction account still denotes a native-SOL curve");

console.log("setup-selftest: 11/11 passed");
