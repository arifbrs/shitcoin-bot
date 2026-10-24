/** FINAL §1/§2: integrasi ft-daily×cohort-stats (skema groups) + MDD bermodal-awal eksplisit. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, approx, assert } from "../testing/harness.js";
import { maxDrawdownWei, cohortStats } from "./cohort-stats.js";
import { dailyRecord } from "./ft-daily.js";

test("FINAL §2 MDD: SEMUA-RUGI → MDD = total-rugi/modal (bukan 0% seperti versi lama)", () => {
  // 3 trade rugi 2,6% masing-masing atas modal 3×1e15 → ekuitas turun monoton.
  const trades = [1, 2, 3].map((ts) => ({ ts, netWei: -26_000_000_000_000n }));
  const mdd = maxDrawdownWei(trades, 3_000_000_000_000_000n);
  approx(mdd, (78_000_000_000_000n * 10000n / 3_000_000_000_000_000n).toString() === "260" ? 2.6 : Number(78n * 10_000n / 3_000n) / 10000, 1e-9, "≈2,6% total");
  assert(mdd > 2.5 && mdd < 2.7, `semua-rugi MDD=${mdd}% (versi lama salah 0%)`);
});

test("FINAL §2 MDD: campuran & positif — puncak-dari-ekuitas, urut waktu, input tak-urut tetap benar", () => {
  // +1% lalu −3% lalu +2%: puncak setelah gain; MDD dari puncak itu.
  const cap = 1_000_000_000_000_000n;
  const mdd = maxDrawdownWei([
    { ts: 3, netWei: 20_000_000_000_000n },
    { ts: 1, netWei: 10_000_000_000_000n },
    { ts: 2, netWei: -30_000_000_000_000n },
  ], cap);
  // ekuitas: 1.01e15 → 0.98e15 → 1.00e15; puncak 1.01e15; trough 0.98 → dd = 30/1010 ≈ 2,9703%
  approx(mdd, 2.9703, 1e-3, "≈2,97% dari puncak");
  const allPos = maxDrawdownWei([{ ts: 1, netWei: 5_000_000_000_000n }, { ts: 2, netWei: 3_000_000_000_000n }], 1_000_000_000_000_000n);
  eq(allPos, 0, "selalu naik → 0% (sah: tak ada penurunan)");
});

test("FINAL §1 ft-daily×cohort-stats: groups terpakai, entry-sim = fill model, v2-defective dikecualikan", () => {
  const dir = mkdtempSync(join(tmpdir(), "ftdaily-"));
  const rows = [
    // v3 sah (1 completed) + v2-defective (1 completed) + OPEN tanpa sim-entry (entri ditolak model).
    { action: "OPEN", tradeId: "v3a", arm: "A", token: "0xt1", symbol: "T1", usd: 2.5, ts: 1000, fillModelVersion: "rhpaper-fillmodel-v3", liquidityUsd: 50000, simFillEntry: { filled: true, fillOutRaw: "1990" } },
    { action: "CLOSE", tradeId: "v3a", arm: "A", token: "0xt1", ts: 2000, why: "stop", netPct: -2.6, netWethRaw: "-27000000000000", entryWethRaw: "1000000000000000", exitWethRaw: "984000000000000", fillModelVersion: "rhpaper-fillmodel-v3", cohortStatus: "PROSPECTIVE", measurementVersion: "rhpaper-units-arm-v3", simFillExit: { filled: true, fillOutRaw: "974000000000000" } },
    { action: "OPEN", tradeId: "v2a", arm: "B", token: "0xt2", symbol: "T2", usd: 2.5, ts: 3000, fillModelVersion: "rhpaper-fillmodel-v2", liquidityUsd: 50000, simFillEntry: { filled: true, fillOutRaw: "1990" } },
    { action: "CLOSE", tradeId: "v2a", arm: "B", token: "0xt2", ts: 4000, why: "stop", netPct: -2.6, netWethRaw: "-27000000000000", entryWethRaw: "1000000000000000", exitWethRaw: "984000000000000", fillModelVersion: "rhpaper-fillmodel-v2", cohortStatus: "PROSPECTIVE", measurementVersion: "rhpaper-units-arm-v3", simFillExit: { filled: true, fillOutRaw: "974000000000000" } },
    { action: "OPEN", tradeId: "nosim", arm: "C", token: "0xt3", symbol: "T3", usd: 2.5, ts: 5000, fillModelVersion: "rhpaper-fillmodel-v3", simFillEntry: { filled: false, reason: "LIQUIDITY_UNKNOWN" } },
  ];
  writeFileSync(join(dir, "ledger-2026-01-01.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const cs = cohortStats(Date.parse("2026-01-02"), dir);
  const daily = dailyRecord(Date.parse("2026-01-02"), dir) as Record<string, unknown>;
  // acceptedSimulatedEntries = fill model LOLOS (2), bukan jumlah OPEN (3):
  eq(Number(daily.acceptedSimulatedEntries), 2, "entri sim diterima = fill model lolos (bukan semua OPEN)");
  eq(Number(daily.funnelValidTrades), 2, "validator funnel: v3a + v2a");
  const groups = daily.netSimulatedPnL as Array<Record<string, unknown>>;
  assert(Array.isArray(groups) && groups.length >= 2, "groups terisi");
  const v2g = groups.find((g) => g.bucket === "v2-defective");
  assert(v2g && v2g.excludedFromProfitability === true, "v2-defective teridentifikasi & dikecualikan");
  const profitList = daily.netSimulatedPnLForProfitability as Array<Record<string, unknown>>;
  assert(profitList.every((g) => g.bucket !== "v2-defective"), "daftar profitabilitas bebas v2-defective");
  assert((daily.strategyVersions as string[]).some((s) => s.includes("/v3")), "strategyVersions memuat identitas bucket v3");
  assert((daily.strategyVersions as string[]).some((s) => s.includes("v2-defective")), "strategyVersions memuat identitas v2-defective (transparan)");
  // Rekonsiliasi angka harian dgn cohort-stats (sumber sama):
  eq(Number(daily.funnelValidTrades), Number(cs.json.funnelValidTrades), "daily ≡ cohort-stats (funnelValid)");
  const mddV3 = (groups.find((g) => g.bucket === "v3") as { maxDrawdownPct?: number } | undefined)?.maxDrawdownPct;
  assert(mddV3 != null && mddV3 > 0, "MDD v3 semua-rugi > 0% (bukan 0 versi lama)");
});
