/** FINAL-3b: deteksi gerak likuiditas — ambang proporsional, pool baru, aman-2^53. */
import { test, eq, assert } from "../testing/harness.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDelta, liquidityEvents, type LiqEvent } from "./liquidity-events.js";

test("R8-FINAL liq-events: ≥±10% = ADD/REMOVE; pool baru (dari 0) bukan event; aman-2^53", () => {
  eq(classifyDelta("1000000000000000000", "1200000000000000000").kind, "LIQUIDITY_ADD", "+20%");
  eq(classifyDelta("1000000000000000000", "850000000000000000").kind, "LIQUIDITY_REMOVE", "−15%");
  eq(classifyDelta("1000000000000000000", "1050000000000000000").kind, null, "+5% = netral");
  eq(classifyDelta("0", "5000000000000000000").kind, null, "pool baru ≠ add ke pool hidup");
  const big = classifyDelta("100000000000000000000000", "50000000000000000000000"); // >2^53
  eq(big.kind, "LIQUIDITY_REMOVE", "raw > 2^53 aman (BigInt)");
  eq(big.deltaRaw, "-50000000000000000000000", "delta eksak");
});

test("R8-FINAL liq-events: seri snapshot → event berurutan, token berbeda tak tercampur", () => {
  // Sintetis: dua snapshot dengan token A bergerak, token B statis.
  const rows = [
    { ts: 1000, rows: [{ token: "0xa", symbol: "A", poolLiquidityRaw: "1000", poolAddress: "0xp" }, { token: "0xb", symbol: "B", poolLiquidityRaw: "500", poolAddress: "0xq" }] },
    { ts: 2000, rows: [{ token: "0xa", symbol: "A", poolLiquidityRaw: "2000", poolAddress: "0xp" }, { token: "0xb", symbol: "B", poolLiquidityRaw: "500", poolAddress: "0xq" }] },
  ];
  const joined = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const dir = mkdtempSync(join(tmpdir(), "liq-ev-"));
  const file = dir + "/snap.jsonl";
  writeFileSync(file, joined);
  const r = liquidityEvents(file);
  eq(r.snapshots, 2, "dua snapshot");
  eq(r.tokens, 2, "dua token");
  eq(r.events.length, 1, "satu event (A saja)");
  const e = r.events[0] as LiqEvent;
  eq(e.kind, "LIQUIDITY_ADD", "arah benar");
  eq(e.token, "0xa", "token tepat");
  assert(e.ts === 2000, "waktu = snapshot kedua");
});
