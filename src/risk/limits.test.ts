import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, eq, assert } from "../testing/harness.js";
import { loadLimits, killSwitchActive, checkEntryAllowed, type RiskLimits } from "./limits.js";

const L = (over: Partial<RiskLimits> = {}): RiskLimits => ({
  maxDailyLossUsd: 0,
  maxTotalNotionalUsd: 0,
  maxOpenPositions: 0,
  killFile: join(mkdtempSync(join(tmpdir(), "kill-")), "KILL"),
  ...over,
});

test("risiko: batas 0 berarti tidak dibatasi (paper tidak berubah perilaku)", () => {
  const r = checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 9999, openPositions: 500, dayPnlUsd: -1e9 }, L());
  eq(r.allowed, true, "tanpa batas → selalu boleh");
});

test("risiko: kill switch menghentikan SEMUA entry baru", () => {
  const l = L();
  assert(!killSwitchActive(l.killFile), "awalnya tidak aktif");
  writeFileSync(l.killFile, "");
  assert(killSwitchActive(l.killFile), "aktif setelah berkas dibuat");
  const r = checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 0, openPositions: 0, dayPnlUsd: 0 }, l);
  eq(r.allowed, false, "diblokir");
  assert((r.reason ?? "").includes("kill switch"), "sebabnya disebut");
  rmSync(l.killFile);
});

test("risiko: batas rugi harian memblokir pada ambang, bukan sesudahnya", () => {
  const l = L({ maxDailyLossUsd: 50 });
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 0, openPositions: 0, dayPnlUsd: -49.99 }, l).allowed, true, "di bawah ambang → boleh");
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 0, openPositions: 0, dayPnlUsd: -50 }, l).allowed, false, "tepat ambang → blokir");
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 0, openPositions: 0, dayPnlUsd: -80 }, l).allowed, false, "lewat ambang → blokir");
});

test("risiko: batas modal total dihitung dari yang SUDAH terbuka + yang akan dibuka", () => {
  const l = L({ maxTotalNotionalUsd: 100 });
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 75, openPositions: 3, dayPnlUsd: 0 }, l).allowed, true, "75+25 = 100 → boleh");
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 76, openPositions: 3, dayPnlUsd: 0 }, l).allowed, false, "101 > 100 → blokir");
});

test("risiko: batas jumlah posisi terbuka", () => {
  const l = L({ maxOpenPositions: 10 });
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 0, openPositions: 9, dayPnlUsd: 0 }, l).allowed, true, "9/10 → boleh");
  eq(checkEntryAllowed({ notionalUsd: 25, openNotionalUsd: 0, openPositions: 10, dayPnlUsd: 0 }, l).allowed, false, "10/10 → blokir");
});

test("risiko: limit dibaca dari env, nilai tak masuk akal diabaikan", () => {
  const l = loadLimits({ RISK_MAX_DAILY_LOSS_USD: "50", RISK_MAX_TOTAL_NOTIONAL_USD: "abc", RISK_MAX_OPEN_POSITIONS: "-5", RISK_KILL_FILE: "/tmp/x" });
  eq(l.maxDailyLossUsd, 50, "angka sah dipakai");
  eq(l.maxTotalNotionalUsd, 0, "bukan angka → tanpa batas");
  eq(l.maxOpenPositions, 0, "negatif → tanpa batas");
  eq(l.killFile, "/tmp/x", "berkas kill switch bisa dikonfigurasi");
});
