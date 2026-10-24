/** FINAL-3b: deteksi gerak likuiditas — ambang proporsional, pool baru, aman-2^53. */
import { test, eq, assert } from "../testing/harness.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyDelta, liquidityEvents, lpKindFromLogs, MINT_TOPIC, BURN_TOPIC, type LiqEvent } from "./liquidity-events.js";

test("FINAL-2B klasifikasi V3: delta snapshot = ACTIVE_LIQUIDITY_CHANGE (bukan LP op) — lintas-tick ≠ deposit/penarikan", () => {
  eq(classifyDelta("1000000000000000000", "1200000000000000000").kind, "ACTIVE_LIQUIDITY_CHANGE", "+20% = perubahan in-range");
  eq(classifyDelta("1000000000000000000", "850000000000000000").kind, "ACTIVE_LIQUIDITY_CHANGE", "−15% = perubahan in-range");
  eq(classifyDelta("1000000000000000000", "1050000000000000000").kind, null, "+5% = netral");
  eq(classifyDelta("0", "5000000000000000000").kind, null, "pool baru ≠ add ke pool hidup");
  const big = classifyDelta("100000000000000000000000", "50000000000000000000000"); // >2^53
  eq(big.kind, "ACTIVE_LIQUIDITY_CHANGE", "raw > 2^53 aman (BigInt)");
  eq(big.deltaRaw, "-50000000000000000000000", "delta eksak");
});

test("FINAL-2B konfirmasi LP: decode Mint/Burn pool membedakan LP ops dari lintas-tick", () => {
  // Lintas-tick: liquidity berubah TANPA Mint/Burn → tetap ACTIVE_LIQUIDITY_CHANGE.
  const tickOnly = lpKindFromLogs([]);
  eq(tickOnly.kind, null, "tanpa Mint/Burn = tidak terkonfirmasi LP op");
  // LP deposit nyata: event Mint pool V3 (amount uint128 = word pertama data).
  const mint = lpKindFromLogs([{ topics: [MINT_TOPIC, "0xsender", "0xowner", "0xtick"], data: "0x" + (250n).toString(16).padStart(64, "0") + "0".repeat(128), transactionHash: "0xtx1", blockNumber: 9200 }]);
  eq(mint.kind, "LP_ADD_CONFIRMED", "Mint = deposit LP terkonfirmasi");
  eq(mint.amountRaw, "250", "jumlah eksak dari data");
  eq(mint.txHash, "0xtx1", "txHash tersimpan");
  eq(mint.blockNumber, 9200, "blok tersimpan");
  const burn = lpKindFromLogs([{ topics: [BURN_TOPIC, "0xowner", "0xlower", "0xupper"], data: "0x" + (999n).toString(16).padStart(64, "0") + "0".repeat(128), transactionHash: "0xtx2", blockNumber: 9300 }]);
  eq(burn.kind, "LP_REMOVE_CONFIRMED", "Burn = penarikan LP terkonfirmasi");
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
