import { test, eq, assert } from "../testing/harness.js";
import { GmgnAbandonedError, GmgnCooldownError, GmgnRequestGate, gmgnRetryAt } from "./gmgn-request-gate.js";

test("gmgn gate: concurrent callers are serialized and spaced", async () => {
  let now = 1_000;
  const starts: number[] = [];
  const gate = new GmgnRequestGate(10_000, {}, () => now, async (ms) => { now += ms; });
  const values = await Promise.all([1, 2, 3].map((v) => gate.run(async () => { starts.push(now); return v; })));
  eq(JSON.stringify(values), "[1,2,3]", "responses stay paired");
  eq(JSON.stringify(starts), "[1000,11000,21000]", "no burst at wake-up");
  eq(gate.pending, 0, "queue drained");
});

test("gmgn gate: abandoned upstream 429 still blocks queued and later callers", async () => {
  let now = 1_000;
  let gone = false;
  let calls = 0;
  const gate = new GmgnRequestGate(10_000, {}, () => now, async (ms) => { now += ms; });
  const first = gate.run(async () => {
    calls++; gone = true;
    throw { status: 429, resetAtUnix: 100, message: "RATE_LIMIT_BANNED" };
  }, () => gone);
  const second = gate.run(async () => { calls++; });
  const results = await Promise.allSettled([first, second]);
  assert(results.every((r) => r.status === "rejected"), "both rejected");
  eq(calls, 1, "only first upstream sent");
  eq(gate.snapshot().cooldownUntil, 105_000, "structured reset + buffer retained");
  const later = await gate.run(async () => { calls++; }).catch((e: unknown) => e);
  assert(later instanceof GmgnCooldownError, "local cooldown error");
  eq(calls, 1, "no request during ban");
});

test("gmgn gate: disconnected queued caller never spends quota", async () => {
  let now = 1_000;
  let gone = false;
  let calls = 0;
  const gate = new GmgnRequestGate(10_000, { nextCallAt: 5_000 }, () => now, async (ms) => { now += ms; gone = true; });
  const result = await gate.run(async () => { calls++; }, () => gone).catch((e: unknown) => e);
  assert(result instanceof GmgnAbandonedError, "cancelled before dispatch");
  eq(calls, 0, "zero upstream calls");
});

test("gmgn gate: persisted cooldown survives restart", async () => {
  const gate = new GmgnRequestGate(10_000, { cooldownUntil: 100_000 }, () => 50_000);
  const result = await gate.run(async () => 1).catch((e: unknown) => e);
  assert(result instanceof GmgnCooldownError, "restart cannot clear ban");
});

test("gmgn gate: parses reset and uses conservative unknown-ban fallback", () => {
  eq(gmgnRetryAt(new Error("HTTP 429 (~42s remaining)"), 1_000), 48_000, "remaining seconds");
  eq(gmgnRetryAt(new Error("RATE_LIMIT_BANNED"), 1_000), 306_000, "unknown ban = five minutes + buffer");
  eq(gmgnRetryAt(new Error("HTTP 502"), 1_000), null, "network failure is not a ban");
});
