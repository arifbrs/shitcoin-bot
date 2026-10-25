import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Separate process + dynamic import are intentional: config.ts reads LOG_DIR at import time, so
// this exercises the real persistence code without contaminating the user's measurement logs.
const root = mkdtempSync(join(tmpdir(), "okx-candidates-"));
process.env.LOG_DIR = root;

try {
  const { enqueueOkxCandidate, flushOkxCandidates, okxCandidateCount, okxCandidateLedgerPath } = await import("./discovery/okx-candidates.js");
  const event = {
    channel: "dex-market-new-signal-openapi-rest",
    receivedAt: 20_000,
    sourceTs: 19_000,
    detectLagMs: 1_000,
    data: { tokenAddress: "CandidateMint", symbol: "CAND", amountUsd: "500", walletType: "SMART_MONEY" },
  };

  const first = enqueueOkxCandidate("signal", event);
  assert.equal(first?.status, "WATCH");
  assert.equal(first?.executionState, "BLOCKED");
  assert.equal(enqueueOkxCandidate("signal", event), null, "same source event must be idempotent");
  assert.equal(okxCandidateCount(), 1);

  const rejected = enqueueOkxCandidate("copy", {
    ...event,
    sourceTs: 1,
    detectLagMs: 120_000,
    data: { tokenAddress: "StaleMint", amountUsd: "1" },
  });
  assert.equal(rejected?.status, "REJECT");
  assert.ok(rejected?.reasons.includes("COPY_WALLET_MISSING"));
  assert.equal(rejected?.executionState, "BLOCKED");

  flushOkxCandidates();
  const stored = JSON.parse(readFileSync(okxCandidateLedgerPath(), "utf8")) as { candidates?: unknown[] };
  assert.equal(stored.candidates?.length, 2, "WATCH and REJECT evidence are both persisted");
  const events = readFileSync(join(root, `events-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").trim().split("\n");
  assert.equal(events.length, 2, "duplicates must not create a second audit event");
  console.log("okx-candidate-selftest: 8/8 passed — temp ledger only, no network, no signing");
} finally {
  // The only recursive delete target is the exact directory mkdtempSync created above.
  if (!root.startsWith(join(tmpdir(), "okx-candidates-"))) throw new Error("refusing unsafe temp cleanup");
  rmSync(root, { recursive: true, force: true });
}
