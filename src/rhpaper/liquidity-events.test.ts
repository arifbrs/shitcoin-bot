/** FINAL-3b: deteksi gerak likuiditas — ambang proporsional, pool baru, aman-2^53. */
import { test, eq, assert } from "../testing/harness.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDelta, liquidityEvents, decodeV3PoolEvents, MINT_TOPIC, BURN_TOPIC, type LiqEvent } from "./liquidity-events.js";

test("FINAL-2B klasifikasi V3: delta snapshot = ACTIVE_LIQUIDITY_CHANGE (bukan LP op) — lintas-tick ≠ deposit/penarikan", () => {
  eq(classifyDelta("1000000000000000000", "1200000000000000000").kind, "ACTIVE_LIQUIDITY_CHANGE", "+20% = perubahan in-range");
  eq(classifyDelta("1000000000000000000", "850000000000000000").kind, "ACTIVE_LIQUIDITY_CHANGE", "−15% = perubahan in-range");
  eq(classifyDelta("1000000000000000000", "1050000000000000000").kind, null, "+5% = netral");
  eq(classifyDelta("0", "5000000000000000000").kind, null, "pool baru ≠ add ke pool hidup");
  const big = classifyDelta("100000000000000000000000", "50000000000000000000000"); // >2^53
  eq(big.kind, "ACTIVE_LIQUIDITY_CHANGE", "raw > 2^53 aman (BigInt)");
  eq(big.deltaRaw, "-50000000000000000000000", "delta eksak");
});

test("FINAL P0-2: decode V3 BENAR — Mint likuiditas di kata data INDEKS 1 (sender non-indexed di depan)", () => {
  const POOL = "0xpooladdress000000000000000000000000000001";
  // Layout Mint asli: data = [sender(32), amount(32), amount0(32), amount1(32)].
  const data = "0x" + "11".repeat(32) + (250n).toString(16).padStart(64, "0") + "0".repeat(128);
  const evs = decodeV3PoolEvents(
    [{ address: POOL, topics: [MINT_TOPIC, "0x" + "22".repeat(32), "0x" + "33".repeat(32), "0x" + "44".repeat(32)], data, transactionHash: "0xtx1", blockNumber: 9200, logIndex: 2 }],
    { poolAddress: POOL, chainId: 4663, timestampMs: 1234 });
  eq(evs.length, 1, "satu event terdekode");
  eq(evs[0]!.kind, "LP_ADD_CONFIRMED", "Mint = LP_ADD_CONFIRMED");
  eq(evs[0]!.liquidityAmountRaw, "250", "likuiditas dari kata data INDEKS 1 (bukan 0) — bug lama diperbaiki");
  eq(evs[0]!.eventKey, "0xtx1:2", "kunci idempoten txHash:logIndex");
  eq(evs[0]!.chainId, 4663, "chainId tersimpan");
  eq(evs[0]!.timestampMs, 1234, "timestamp tersimpan");
  eq(evs[0]!.owner, "0x" + "22".repeat(20), "owner dari topic indexed");
});

test("FINAL P0-2: Burn likuiditas di kata 0; multi-event per tx; pool salah ditolak; log rusak dilewati", () => {
  const POOL = "0xpooladdress000000000000000000000000000001";
  const burnData = "0x" + (999n).toString(16).padStart(64, "0") + "0".repeat(128);
  const logs = [
    { address: POOL, topics: [BURN_TOPIC, "0x" + "22".repeat(32), "0x" + "33".repeat(32), "0x" + "44".repeat(32)], data: burnData, transactionHash: "0xtx2", blockNumber: 9300, logIndex: 0 },
    { address: POOL, topics: [MINT_TOPIC, "0x" + "22".repeat(32), "0x" + "33".repeat(32), "0x" + "44".repeat(32)], data: "0x" + "11".repeat(32) + (7n).toString(16).padStart(64, "0") + "0".repeat(128), transactionHash: "0xtx2", blockNumber: 9300, logIndex: 1 },
    { address: "0x" + "ff".repeat(20), topics: [MINT_TOPIC, "0x" + "22".repeat(32), "0x" + "33".repeat(32), "0x" + "44".repeat(32)], data: "0x" + (12345n).toString(16).padStart(64, "0") + "0".repeat(128), transactionHash: "0xtx2", blockNumber: 9300, logIndex: 2 }, // pool lain
    { address: POOL, topics: [MINT_TOPIC], data: "0x" + "0".repeat(128), transactionHash: "0xtx2", blockNumber: 9300, logIndex: 3 }, // topics tak lengkap
  ];
  const evs = decodeV3PoolEvents(logs, { poolAddress: POOL, chainId: 4663, timestampMs: 5 });
  eq(evs.length, 2, "multi-event pada satu tx; pool salah & log rusak ditolak");
  eq(evs[0]!.kind, "LP_REMOVE_CONFIRMED", "Burn pertama");
  eq(evs[0]!.liquidityAmountRaw, "999", "Burn: likuiditas di kata 0");
  eq(evs[1]!.kind, "LP_ADD_CONFIRMED", "Mint kedua pada tx yang sama");
  eq(evs[1]!.liquidityAmountRaw, "7", "jumlah eksak");
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
  eq(e.kind, "ACTIVE_LIQUIDITY_CHANGE", "arah benar (konfirmasi LP butuh decode Mint/Burn)");
  eq(e.token, "0xa", "token tepat");
  assert(e.ts === 2000, "waktu = snapshot kedua");
});
