import { strict as assert } from "node:assert";
import { rateLimitBenchPolicy } from "./safety/onchain.js";

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

console.log("rpc-quota-selftest: 7/7 passed");
