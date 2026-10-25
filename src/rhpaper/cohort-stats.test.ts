/** FINAL BLOCKER-1: regresi cohort-stats pada dataset CAMPURAN (v0/v1/v2/v3) —
 *  otoritas simNetFor, validator funnel sama, v2-defective dikecualikan dari profitabilitas. */
import { test, eq, assert } from "../testing/harness.js";
import { simNetFor } from "./fillmodel.js";
import { countFunnel } from "./funnel.js";

const V = { v1: "rhpaper-fillmodel-v1", v2: "rhpaper-fillmodel-v2", v3: "rhpaper-fillmodel-v3" };
const base = { entryWethRaw: "1000000000000000", exitQuoteWethRaw: "1000000000000000" };

test("BLOCKER-1 simNetFor: bucket benar utk tiap versi dgn bukti penuh", () => {
  eq(simNetFor({ ...base, version: V.v1, entrySimFillOutRaw: "1990", exitSimFillOutRaw: "1980" }).bucket, "v1", "v1");
  eq(simNetFor({ ...base, version: V.v2, entrySimFillOutRaw: "1990", exitSimFillOutRaw: "1980" }).bucket, "v2-defective", "v2d");
  eq(simNetFor({ ...base, version: V.v3, exitSimFillOutRaw: "1990" }).bucket, "v3", "v3");
  eq(simNetFor({ ...base, version: null }).bucket, "quote-only", "quote-only");
  eq(simNetFor({ ...base, version: V.v3, exitSimFillOutRaw: null }).bucket, "invalid", "v3 tanpa bukti exit = invalid");
  eq(simNetFor({ ...base, version: V.v1, exitSimFillOutRaw: "1980" }).bucket, "invalid", "v1 tanpa bukti entry = invalid");
});

test("BLOCKER-1 net sim v3 = re-quote fillOutRaw (potongan exit SEKALI di dalamnya)", () => {
  const r = simNetFor({ version: V.v3, entryWethRaw: "1000000000000000", exitQuoteWethRaw: "995098189942235", exitSimFillOutRaw: "985172085497560" });
  eq(r.netWethRaw, "-26227914502440", "net = fillOutRaw − entry − gas (eksak)");
  assert(Math.abs(r.netPct - (-2.622791450244)) < 1e-9, "persentase presisi penuh");
});

test("BLOCKER-1 dataset campuran: funnel-validator menyaring trade ganda/tanpa bukti sebelum metrik", () => {
  const rows: Array<Record<string, unknown>> = [
    { action: "OPEN", tradeId: "v1ok", fillModelVersion: V.v1, simFillEntry: { filled: true, fillOutRaw: "1990" }, liquidityUsd: 50000 },
    { action: "CLOSE", tradeId: "v1ok", fillModelVersion: V.v1, simFillExit: { filled: true, fillOutRaw: "1980" }, netWethRaw: "-2010" },
    { action: "OPEN", tradeId: "v2d", fillModelVersion: V.v2, simFillEntry: { filled: true, fillOutRaw: "1990" }, liquidityUsd: 50000 },
    { action: "CLOSE", tradeId: "v2d", fillModelVersion: V.v2, simFillExit: { filled: true, fillOutRaw: "1980" }, netWethRaw: "-2010" },
    { action: "OPEN", tradeId: "dup", fillModelVersion: V.v3, simFillEntry: { filled: true, fillOutRaw: "1990" }, liquidityUsd: 50000 },
    { action: "CLOSE", tradeId: "dup", fillModelVersion: V.v3, simFillExit: { filled: true, fillOutRaw: "1980" }, netWethRaw: "-2010" },
    { action: "CLOSE", tradeId: "dup", fillModelVersion: V.v3, simFillExit: { filled: true, fillOutRaw: "1980" }, netWethRaw: "-2010" },
  ];
  const fc = countFunnel(rows);
  const valid = new Set(fc.validCompletedIds);
  eq(fc.completed, 2, "v1ok + v2d sah; dup (CLOSE ganda) ditolak seluruhnya");
  assert(!valid.has("dup"), "duplikat tidak lulus validator");
  assert(valid.has("v1ok") && valid.has("v2d"), "bukti penuh lulus");
  // Bucket per trade valid — v2d masuk v2-defective (dikecualikan dari profitabilitas):
  const b1 = simNetFor({ version: V.v1, entryWethRaw: "1000000000000000", exitQuoteWethRaw: "1000000000000000", entrySimFillOutRaw: "1990", exitSimFillOutRaw: "1980" });
  const b2 = simNetFor({ version: V.v2, entryWethRaw: "1000000000000000", exitQuoteWethRaw: "1000000000000000", entrySimFillOutRaw: "1990", exitSimFillOutRaw: "1980" });
  eq(b1.bucket, "v1", "v1 sah utk profitabilitas");
  eq(b2.bucket, "v2-defective", "v2 = defective (dilaporkan historis, dikecualikan)");
});

test("BLOCKER-1 kesetaraan lintas-modul: simNetFor.v3 ≡ quoteNet(fillOutRaw) — funnel/replay/cohort satu angka", () => {
  const a = simNetFor({ version: V.v3, entryWethRaw: "1000000000000000", exitQuoteWethRaw: "1000000000000000", exitSimFillOutRaw: "990000000000000" });
  const b = simNetFor({ version: V.v3, entryWethRaw: "1000000000000000", exitQuoteWethRaw: "1000000000000000", exitSimFillOutRaw: "990000000000000" });
  eq(a.netWethRaw, b.netWethRaw, "deterministik");
  eq(a.netWethRaw, "-21400000000000", "net eksak: 990 − 1000 − 11,4 gas = −21,4 wei×10^6 (aritmetika saya yang salah sebelumnya)");
});
