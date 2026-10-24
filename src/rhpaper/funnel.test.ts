/** FINAL P0-3: regresi false-completion — bukti exit TIDAK boleh diwarisi dari state entry. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq } from "../testing/harness.js";
import { countFunnel } from "./funnel.js";

const OPEN_OK = { action: "OPEN", tradeId: "t1", token: "0xa", symbol: "A", arm: "A", liquidityUsd: 50000,
  simFillEntry: { filled: true }, fillModelVersion: "rhpaper-fillmodel-v2" };
const CLOSE_FULL = { action: "CLOSE", tradeId: "t1", token: "0xa", symbol: "A", arm: "A",
  simFillExit: { filled: true }, fillModelVersion: "rhpaper-fillmodel-v2", netWethRaw: "-1" };

test("P0-3: kasus asli false-completion — CLOSE TANPA simFillExit + OPEN entry-filled = TIDAK dihitung", () => {
  const r = countFunnel([OPEN_OK, { action: "CLOSE", tradeId: "t1", token: "0xa", arm: "A" }]); // tanpa simFillExit
  eq(r.completed, 0, "skenario lama menghitung ini via state entry — kini 0");
  eq(r.invalidCloses, 1, "dilaporkan invalid, tidak dibuang diam-diam");
  eq(r.exitSignals, 1, "tetap terhitung sebagai exit signal");
});

test("P0-3: bukti penuh di baris masing-masing = completed; duplikat tradeId ditolak", () => {
  const full = countFunnel([OPEN_OK, CLOSE_FULL]);
  eq(full.completed, 1, "entry-fill di OPEN + exit-fill di CLOSE = sah");
  const dupClose = countFunnel([OPEN_OK, CLOSE_FULL, { ...CLOSE_FULL, ts: 999 }]);
  eq(dupClose.completed, 1, "CLOSE ganda untuk tradeId sama → tetap 1 (uniqueness)");
  const dupOpen = countFunnel([{ ...OPEN_OK }, { ...OPEN_OK, ts: 5 }, CLOSE_FULL]);
  eq(dupOpen.completed, 0, "OPEN ganda → pasangan tidak unik → 0 completed");
});

test("P0-3: versi tidak cocok ditolak; exit gagal model = exitSimRejected bukan completed", () => {
  const mixed = countFunnel([OPEN_OK, { ...CLOSE_FULL, fillModelVersion: "rhpaper-fillmodel-v1" }]);
  eq(mixed.completed, 0, "fillModelVersion OPEN ≠ CLOSE → tidak sah");
  eq(mixed.invalidCloses, 1, "dilaporkan");
  const rejected = countFunnel([OPEN_OK, { ...CLOSE_FULL, simFillExit: { filled: false, reason: "LIQUIDITY_UNKNOWN" } }]);
  eq(rejected.completed, 0, "exit ditolak model ≠ completed");
  eq(rejected.exitSimRejected, 1, "masuk kategori tak-bisa-keluar");
});

test("P0-3: entry tidak lolos model → completed 0 walau exit terisi", () => {
  const r = countFunnel([{ ...OPEN_OK, simFillEntry: { filled: false, reason: "LIQUIDITY_UNKNOWN" } }, CLOSE_FULL]);
  eq(r.completed, 0, "entry tidak sah → tidak ada trade");
});
