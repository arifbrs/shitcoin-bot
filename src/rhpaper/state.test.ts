import { test, eq } from "../testing/harness.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, auditLedger, emptyState, ledgerPath, loadState, saveState, withLock } from "./state.js";

test("state: simpan/muat bolak-balik (atomik) + kosong bila versi beda", () => {
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-"));
  const s = emptyState(); s.cycles = 7; s.pnlUsd = 1.25;
  saveState(s);
  eq(loadState().cycles, 7, "siklus tersimpan");
  writeFileSync(join(process.env.RHPAPER_DIR, "state.json"), JSON.stringify({ version: 1 }));
  eq(loadState().cycles, 0, "versi lama → state kosong");
});

test("state: ledger JSONL + audit menolak OPEN/CLOSE tanpa quoteRef", () => {
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-"));
  appendLedger({ action: "OPEN", quoteRef: "q1" });
  appendLedger({ action: "CLOSE", quoteRef: "q2" });
  appendLedger({ action: "CLOSE" });
  const lines = readFileSync(ledgerPath(), "utf8").trim().split("\n");
  const a = auditLedger(lines);
  eq(a.bad, 1, "satu baris tanpa bukti");
  eq(a.ok, false, "audit gagal");
});

test("state: lock menolak proses lain yang masih hidup", () => {
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-"));
  writeFileSync(join(process.env.RHPAPER_DIR, ".lock"), String(process.ppid));
  let threw = false;
  try { withLock(() => 1); } catch { threw = true; }
  eq(threw, true, "lock dipegang proses hidup");
});
