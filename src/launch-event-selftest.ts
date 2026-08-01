import { strict as assert } from "node:assert";
import { normalizeNewTokenEvent } from "./discovery/pumpportal.js";

const common = {
  txType: "create",
  name: "Fixture Coin",
  symbol: "FIX",
  uri: "https://example.invalid/meta.json",
  bondingCurveKey: "curve-1",
  vSolInBondingCurve: 30,
  vTokensInBondingCurve: 1_073_000_000,
  marketCapSol: 27.96,
};

const legacy = normalizeNewTokenEvent({ ...common, mint: "base-token-1" }, 123);
assert(legacy.ok);
assert.equal(legacy.candidate.mint, "base-token-1");
assert.equal(legacy.candidate.detectedAt, 123);
assert.equal(legacy.candidate.priceSol, 30 / 1_073_000_000);

const v2 = normalizeNewTokenEvent({
  ...common,
  mint: "ambiguous-legacy-field",
  base_mint: "real-base-token",
  quote_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}, 456);
assert(v2.ok);
assert.equal(v2.candidate.mint, "real-base-token");
assert.equal(v2.candidate.quoteMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const malformedUsdc = normalizeNewTokenEvent({
  ...common,
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
});
assert.equal(malformedUsdc.ok, false);
if (!malformedUsdc.ok) assert.equal(malformedUsdc.reason, "QUOTE_MINT_AS_BASE");

const missing = normalizeNewTokenEvent(common);
assert.equal(missing.ok, false);
if (!missing.ok) assert.equal(missing.reason, "MISSING_BASE_MINT");

const feeCollectionMislabel = normalizeNewTokenEvent({
  ...common,
  mint: "old-token-mint",
  name: undefined,
  symbol: undefined,
  uri: undefined,
});
assert.equal(feeCollectionMislabel.ok, false);
if (!feeCollectionMislabel.ok) assert.equal(feeCollectionMislabel.reason, "MISSING_CREATE_METADATA");

console.log("launch-event-selftest: 13/13 passed");
