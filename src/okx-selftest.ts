import { strict as assert } from "node:assert";
import bs58 from "bs58";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  okxRequestPath, okxSignature, okxCredentialWarnings, okxEnabled,
  OKX_ENDPOINTS, OKX_LIVE_ENDPOINTS, okxProbeAll, okxTopTokenPnl, okxSignalWallets,
  OKX_WALLET_TYPES, okxLeaderboardWalletTypeCodes, okxLeaderboardWalletTypeLabel,
  okxMemeTokenAgeMs, type OkxEndpointSpec, type OkxMemeToken,
} from "./discovery/okx.js";
import { OKX_WS_CHANNELS } from "./discovery/okx-ws.js";
import { plausibleRefPrice } from "./discovery/okx-outcome.js";
import { buildOkxCandidate } from "./discovery/okx-candidates.js";
import { decodeOkxSolanaTransaction } from "./execution/okx.js";
import { okxRadarHasExcludedType } from "./discovery/okx-radar.js";

/**
 * OKX selftest.
 *
 *   npm run okx:selftest            → offline. Signing contract + registry sanity. No network.
 *   npm run okx:selftest -- --live  → additionally probes EVERY registered endpoint once and
 *                                     prints which ones actually answer.
 *
 * The --live half is the point. Until it has been run, roughly two thirds of the endpoint
 * registry is inferred from OKX's CLI command names rather than read off their docs, and a wrong
 * path fails as a 60s-throttled warn() that is indistinguishable from "no data right now". One
 * one read-only sweep replaces that ambiguity with a table.
 */

const LIVE = process.argv.includes("--live");

// ── offline: signing contract (these fixtures are the auth spec; changing them is a breaking change)

const path = okxRequestPath("/api/v6/dex/market/token/advanced-info", {
  tokenContractAddress: "Mint / +",
  chainIndex: "501",
  omitted: undefined,
});
assert.equal(
  path,
  "/api/v6/dex/market/token/advanced-info?chainIndex=501&tokenContractAddress=Mint+%2F+%2B",
  "query bytes must be stable, encoded, and sorted before signing",
);

assert.equal(
  okxSignature("2026-08-28T00:00:00.000Z", "GET", "/api/v6/dex/aggregator/quote?amount=100&chainIndex=501", "", "test-secret"),
  "UtHMzXuv+PXScKYJ1pzks3zz4gHEcZpDX9XoJhmm7Sg=",
  "GET signature fixture changed",
);

assert.equal(
  okxSignature("2026-08-28T00:00:00.000Z", "POST", "/api/v6/dex/market/price-info", '[{"chainIndex":"501","tokenContractAddress":"Mint"}]', "test-secret"),
  "kPkbL3+qTAz2VCCMCH25b1cIui8wvLDynSVlIlDUWU4=",
  "POST signature must include the exact raw JSON body",
);

// ── offline: registry sanity

const ids = Object.keys(OKX_ENDPOINTS);
assert.equal(ids.length, 74, `attached rate-limit inventory contains exactly 74 DEX+Market endpoints; found ${ids.length}`);
for (const id of ids) {
  const spec = (OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)[id]!;
  assert.ok(spec.path.startsWith("/api/v6/"), `${id}: every OnchainOS path is /api/v6/* (got ${spec.path})`);
  assert.ok(spec.rps >= 1 && spec.rps <= 100, `${id}: implausible rps ${spec.rps}`);
  assert.ok(spec.method === "GET" || spec.method === "POST", `${id}: bad method`);
  assert.ok(spec.desc.length > 0, `${id}: an endpoint with no description is an endpoint nobody can audit`);
  assert.ok(["live", "params-unknown", "unavailable", "unprobed"].includes(spec.status), `${id}: bad status "${spec.status}"`);
}
const dupes = ids.map((i) => (OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)[i]!).map((s) => `${s.method} ${s.path}`);
assert.equal(new Set(dupes).size, dupes.length, "two registry entries share a method+path");

// The four endpoints trader.ts's post-open snapshot depends on must never silently vanish.
for (const id of ["token.advancedInfo", "market.priceInfo", "trenches.devInfo", "trenches.bundleInfo"]) {
  assert.ok(ids.includes(id), `${id} is required by okxTokenShadowSnapshot()`);
}

// Every endpoint missing from the first pass must remain represented. Some are EVM-only, but
// omitting them would make a "full surface" claim false.
for (const id of [
  "dex.approve", "intent.auctionInfo", "intent.cancelOrder", "intent.cancelSignData",
  "intent.createOrder", "intent.orderList", "intent.orderStatus", "market.rwaTokens",
  "pre.checkApprovals", "pre.gasLimit", "pre.gasPrice", "pre.nonce",
]) assert.ok(ids.includes(id), `${id} from okx_api_rate_limits.txt is missing`);

// Write/order-specific paths must be never-probed, so a broad diagnostic cannot create, cancel,
// sign, or broadcast anything.
for (const id of [
  "dex.approve", "dex.swap", "dex.swapInstruction", "dex.broadcast", "dex.history",
  "intent.auctionInfo", "intent.cancelOrder", "intent.cancelSignData", "intent.createOrder",
  "intent.orderList", "intent.orderStatus", "post.txByHash", "post.txByAddress", "post.orders",
  "pre.checkApprovals", "pre.gasLimit", "pre.nonce", "pre.simulate",
]) {
  assert.equal((OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)[id]!.probe, "skip", `${id} is a WRITE endpoint and must be probe:"skip"`);
}

// Regression guards for the two previously broken parameter contracts.
assert.equal((OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)["token.hot"]!.probe, "hot");
assert.equal((OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)["trenches.details"]!.probe, "tokenWallet");

// PnL casing normaliser — OKX docs say tokenPnLUsd, an earlier draft of okx.ts said tokenPnlUsd.
assert.deepEqual(okxTopTokenPnl({ tokenContractAddress: "x", tokenPnLUsd: "12.5", tokenPnLPercent: "30" }), { usd: 12.5, pct: 30 });
assert.deepEqual(okxTopTokenPnl({ tokenContractAddress: "x", tokenPnlUsd: "12.5", tokenPnlPercent: "30" }), { usd: 12.5, pct: 30 });
assert.deepEqual(okxTopTokenPnl({ tokenContractAddress: "x" }), { usd: null, pct: null });

// WS channel table
assert.equal(Object.keys(OKX_WS_CHANNELS).length, 9, "OKX documents nine WS channels");

// The four the post-open snapshot uses must be recorded live, or the snapshot is decoration.

assert.deepEqual(okxSignalWallets({ triggerWalletAddress: "aaa,bbb , ccc" }), ["aaa", "bbb", "ccc"]);
assert.deepEqual(okxSignalWallets({}), []);

// Leaderboard and Signal deliberately use different enums. Pin the official leaderboard table
// and the migration path for cells written while the human-readable labels were still inferred.
assert.deepEqual(OKX_WALLET_TYPES, {
  kol: "1", developer: "2", smartMoney: "3", whale: "4", newWallet: "5",
  insider: "6", sniper: "7", suspectedPhishing: "8", bundledTrader: "9", pumpSmartMoney: "10",
});
assert.equal(okxLeaderboardWalletTypeLabel("3"), "smartMoney");
assert.deepEqual(okxLeaderboardWalletTypeCodes(["fresh(3)/1/3", "smartMoney(5)/2/4"]), ["3", "5"]);
assert.equal(okxRadarHasExcludedType(["kol", "developer"], ["developer", "sniper"]), true);
assert.equal(okxRadarHasExcludedType(["kol", "smartMoney"], ["developer", "sniper"]), false);

// Radar/signal/copy may create an auditable candidate, but the normaliser has no state that can
// mean "approved" and execution remains hard-blocked. The ID must survive reconnect/replay.
const candidateEvent = {
  channel: "dex-market-new-signal-openapi-rest",
  receivedAt: 10_000,
  sourceTs: 9_000,
  detectLagMs: 1_000,
  data: { tokenAddress: "MintCandidate", symbol: "MIC", amountUsd: "250", walletType: "SMART_MONEY" },
};
const watchCandidate = buildOkxCandidate("signal", candidateEvent, { maxLagMs: 2_000, minAmountUsd: 100 });
assert.equal(watchCandidate?.status, "WATCH");
assert.equal(watchCandidate?.executionState, "BLOCKED");
assert.equal(
  buildOkxCandidate("signal", { ...candidateEvent, receivedAt: 11_000 }, { maxLagMs: 2_000, minAmountUsd: 100 })?.candidateId,
  watchCandidate?.candidateId,
  "a reconnect replay with the same source timestamp must dedupe",
);
assert.equal(buildOkxCandidate("signal", { ...candidateEvent, detectLagMs: 2_001 }, { maxLagMs: 2_000, minAmountUsd: 100 })?.status, "REJECT");
assert.equal(buildOkxCandidate("copy", candidateEvent, { maxLagMs: 2_000, minAmountUsd: 100 })?.status, "REJECT", "copy candidates require the followed wallet");
assert.equal(buildOkxCandidate("signal", { ...candidateEvent, data: {} }, { maxLagMs: 2_000, minAmountUsd: 0 }), null, "a candidate with no mint is invalid");

// REGRESSION GUARD. trenches.tokenList answers with a BARE ARRAY; an earlier wrapper required a
// `{ items: [] }` envelope and so returned null on every successful call. A scanner on top of it
// would have reported an empty market instead of an error. Age parsing is pinned here too, since
// the freshness measurement is the whole reason to poll this endpoint.
const sample: OkxMemeToken = { tokenAddress: "mint", createdTimestamp: "1000000" };
assert.equal(okxMemeTokenAgeMs(sample, 1_001_500), 1500, "age must be now - createdTimestamp in ms");
assert.equal(okxMemeTokenAgeMs({ tokenAddress: "m" }, 1_000), null, "missing timestamp is null, not NaN");
assert.equal(okxMemeTokenAgeMs({ tokenAddress: "m", createdTimestamp: "" }, 1_000), null, "empty timestamp is null");
assert.equal(okxMemeTokenAgeMs(sample, 999_999), null, "a future timestamp is rejected, not returned negative");

// REFERENCE-PRICE FLOOR. MEASURED: 96.4% of reference prices land in the 1e-6 decade and the next
// decade down holds 11 of 15,149 — a 1,300x cliff, i.e. corruption, not a tail. One 4.7478e-12
// row produced a +5,685,658,715% outcome and pulled the CLEAN mean to +565,291%.
assert.equal(plausibleRefPrice(4.7478e-12), null, "a launch price 7 orders below the curve floor is impossible");
assert.equal(plausibleRefPrice(1e-9), null, "below the floor is rejected");
assert.equal(plausibleRefPrice(2.9e-6), 2.9e-6, "the real pump.fun launch price must survive");
assert.equal(plausibleRefPrice(1e-7), 1e-7, "the floor itself is inclusive");
assert.equal(plausibleRefPrice(0.177), 0.177, "an expensive token must survive");
assert.equal(plausibleRefPrice(null), null, "absent stays absent");
// The guard must NOT be reused on settlement prices: those decay smoothly (51,948 -> 5,764 ->
// 1,778 across decades) because tokens really do collapse. Flooring them would delete the losses
// and leave the winners, biasing every median in the study optimistically.

// OKX Solana swap responses are opaque Base58 transactions. Pin both format decoding and the
// fee-payer check that prevents the bot from signing a payload built for another wallet.
const payer = Keypair.generate();
const unsigned = new Transaction({ recentBlockhash: "11111111111111111111111111111111", feePayer: payer.publicKey }).add(
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
).serialize({ requireAllSignatures: false, verifySignatures: false });
const encoded = bs58.encode(unsigned);
const decoded = decodeOkxSolanaTransaction(encoded, payer.publicKey.toBase58());
assert.equal(decoded?.format, "legacy");
assert.equal(decoded?.feePayer, payer.publicKey.toBase58());
assert.equal(decodeOkxSolanaTransaction(encoded, Keypair.generate().publicKey.toBase58()), null, "wrong fee payer must fail closed");
assert.equal(decodeOkxSolanaTransaction("not-base58-0OIl"), null, "malformed transaction must fail closed");

assert.deepEqual(
  ids.filter((id) => (OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)[id]!.status === "unprobed").sort(),
  ["dex.broadcast", "intent.cancelOrder", "intent.cancelSignData", "intent.createOrder", "intent.orderStatus"].sort(),
  "only state-changing or real-order-ID endpoints may remain unprobed",
);

const byStatus = (st: string) => ids.filter((i) => (OKX_ENDPOINTS as Record<string, OkxEndpointSpec>)[i]!.status === st).length;
console.log(`okx-selftest: offline OK — ${ids.length} endpoints: ${byStatus("live")} live, ${byStatus("params-unknown")} params-unknown, ${byStatus("unavailable")} unavailable, ${byStatus("unprobed")} unprobed`);

for (const w of okxCredentialWarnings()) console.log(`  ⚠ ${w}`);

// ── live probe

if (!LIVE) {
  console.log("  (run with --live to probe every endpoint against OKX)");
  process.exit(0);
}

if (!okxEnabled) {
  console.error("\n--live requested but OKX is disabled. Set in .env:");
  console.error("  OKX_SHADOW_ENABLED=true  OKX_API_KEY=…  OKX_SECRET_KEY=…  OKX_API_PASSPHRASE=…  OKX_PROJECT_ID=…");
  process.exit(1);
}

// A well-known live Solana mint and a wallet with public DEX history. Both are only probe fodder:
// nothing is bought, sold, or written on-chain.
// A pump.fun mint this bot actually traded. USDC was the earlier default and it made every
// trenches endpoint look broken: those endpoints only know launchpad tokens, so a blue-chip
// probe target returns empty and is indistinguishable from a wrong path.
const SAMPLE_MINT = process.env.OKX_PROBE_MINT?.trim() || "A3qpypVnDXRiyhmGMztPmw9FyFJaUqTgUmcUnmospump";
const SAMPLE_WALLET = process.env.OKX_PROBE_WALLET?.trim() || "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

console.log(`\nProbing every safe/read-only endpoint from the ${ids.length}-endpoint registry…\n`);
const results = await okxProbeAll(SAMPLE_MINT, SAMPLE_WALLET);

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
console.log(pad("ENDPOINT", 22) + pad("RECORDED", 16) + pad("NOW", 8) + "DETAIL");
console.log("-".repeat(88));

let surprises = 0;
for (const { id, spec, result } of results) {
  const now = result.ok ? "OK" : result.regionBlocked ? "REGION" : "FAIL";
  const detail = result.ok
    ? `${result.elapsedMs}ms`
    : `HTTP ${result.httpStatus ?? "-"} code ${result.code ?? "-"} ${result.msg ?? ""}`.trim();
  // A drift is the registry's recorded status disagreeing with what the server just did — either
  // something we marked live has broken, or something we wrote off has come back.
  const expectedOk = spec.status === "live";
  const surprising = expectedOk !== result.ok && !result.regionBlocked;
  if (surprising) surprises++;
  console.log(pad(id, 22) + pad(spec.status, 16) + pad(now, 8) + detail + (surprising ? "   ←" : ""));
}

const ok = results.filter((r) => r.result.ok).length;
const region = results.filter((r) => r.result.regionBlocked).length;
console.log("-".repeat(88));
console.log(`${ok}/${results.length} answered (registry records ${OKX_LIVE_ENDPOINTS.length} live)${region ? `, ${region} region-blocked` : ""}, ${surprises} drifted (marked ←)`);
if (region > 0) console.log("Region block (code 50125/80001) means OKX DEX is unavailable from this IP — not a code problem.");
if (surprises > 0) console.log("A drift means OKX changed under us — update `status` in OKX_ENDPOINTS and re-check any consumer that depended on it.");
console.log("Full per-endpoint records: grep '\"type\":\"okx-endpoint-probe\"' logs/events-*.jsonl");
