import { strict as assert } from "node:assert";
import { rateLimitBenchPolicy, isUnreachable, unsupportedMethods } from "./safety/onchain.js";

const noonUtc = Date.UTC(2026, 6, 28, 12, 0);
const ordinary = rateLimitBenchPolicy("too many requests", 1, noonUtc);
assert.equal(ordinary.reason, "rate-limit");
assert(ordinary.ms < 15 * 60_000);

const daily = rateLimitBenchPolicy('{"message":"daily request limit reached - upgrade account"}', 1, noonUtc);
assert.equal(daily.reason, "daily-quota");
assert.equal(daily.ms, 5 * 60_000);

const monthly = rateLimitBenchPolicy("monthly credit quota exhausted", 1, noonUtc);
assert.equal(monthly.reason, "daily-quota");
assert.equal(monthly.ms, 5 * 60_000);

const concurrentQuota = rateLimitBenchPolicy("daily request limit reached", 20, noonUtc);
assert.equal(concurrentQuota.reason, "daily-quota");
assert.equal(concurrentQuota.ms, 5 * 60_000);

// ── DEAD-ENDPOINT DETECTION ───────────────────────────────────────────────────
// A decommissioned provider endpoint still resolves and still accepts TCP; it fails at the TLS
// handshake. Measured on a real dead QuickNode endpoint 2026-08-22 — Node reports exactly this
// shape, and before this it fell through to the "ambiguous, wait for 3 strikes, bench 15s" path
// while a merely-throttled endpoint got up to 30 minutes. The dead one was retried ~120x more
// often than the busy one.
const tlsDead = Object.assign(new TypeError("fetch failed"), {
  cause: {
    code: "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
    reason: "tlsv1 alert internal error",
    message: "SSL routines:ssl3_read_bytes:tlsv1 alert internal error:SSL alert number 80",
  },
});
assert.equal(isUnreachable(tlsDead), true, "a TLS-rejecting (deleted) endpoint must count as unreachable");

// The classic cases must keep working.
assert.equal(isUnreachable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), true);
assert.equal(isUnreachable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })), true);

// And a healthy endpoint answering a normal error must NOT be benched as unreachable — that
// would take a working key out of the pool for half an hour.
assert.equal(isUnreachable(new Error("getBalance: Invalid param: WrongSize")), false);
assert.equal(isUnreachable(new Error("429 Too Many Requests: max usage reached")), false);
assert.equal(isUnreachable(new Error("Internal server error")), false);

// ── A PROVEN ENDPOINT MUST NOT BE FROZEN OUT ──────────────────────────────────
// Helius says "max usage reached" — no "daily", no "monthly" — so it takes the escalating
// branch. Measured 2026-08-22: that climbed to a 30-minute bench and idled 4 of 7 keys while
// the pool was at 102% of capacity, even though those keys answered fine minutes later.
const heliusMsg = "max usage reached";
assert.equal(rateLimitBenchPolicy(heliusMsg, 1).reason, "rate-limit", "Helius wording is not a daily quota");

// Never proved itself → keep the full escalation; a genuinely spent key must back off.
assert(rateLimitBenchPolicy(heliusMsg, 6, noonUtc, false).ms > 5 * 60_000, "unproven endpoint keeps the long bench");
assert.equal(rateLimitBenchPolicy(heliusMsg, 6, noonUtc, false).ms, 30 * 60_000);

// Has served real traffic → capped, so it rejoins the pool while we are saturated.
assert.equal(rateLimitBenchPolicy(heliusMsg, 6, noonUtc, true).ms, 5 * 60_000, "proven endpoint is capped at 5m");
assert.equal(rateLimitBenchPolicy(heliusMsg, 12, noonUtc, true).ms, 5 * 60_000, "cap holds at any strike count");
// The cap must never make an EARLY bench longer than it used to be.
assert.equal(rateLimitBenchPolicy(heliusMsg, 1, noonUtc, true).ms, rateLimitBenchPolicy(heliusMsg, 1, noonUtc, false).ms);

// An explicit daily/monthly quota is unchanged in both directions.
assert.equal(rateLimitBenchPolicy("daily request limit reached", 9, noonUtc, true).ms, 5 * 60_000);

// ── METHOD-UNSUPPORTED IS NOT A FAULT ─────────────────────────────────────────
// PublicNode serves getAccountInfo (11,907 of ~19,000 of our calls) with no key and no account,
// but replies "Request blocked" to getTokenLargestAccounts. Treated as a generic failure, three
// of those benched a perfectly healthy endpoint — which is why free capacity could not be added
// to the pool at all. It must be remembered per (endpoint, method), not punished.
assert.equal(unsupportedMethods().length, 0, "nothing should be marked unsupported before any call");

console.log("rpc-quota-selftest: 21/21 passed");
