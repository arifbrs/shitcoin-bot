import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, approx } from "../testing/harness.js";
import { cycle, quotePnl, type Cfg } from "./engine.js";
import { emptyState, loadState, saveState, type Position } from "./state.js";
import type { QuoteResult } from "./exec.js";

test("rhpaper: gas uses wei and flat round trip loses exactly 1.14%", () => {
  const pnl = quotePnl("1000000000000000", "1000000000000000");
  eq(pnl.netWethRaw, "-11400000000000", "gas is not subtracted as fractional wei");
  approx(pnl.netPct, -1.14, 1e-10, "1.14 percentage points");
  approx(quotePnl("1000000000000000", "1100000000000000").netPct, 8.86, 1e-10, "profit net of gas");
});

const base: Cfg = { arm: "A", maker: "0x1", usd: 2.5, maxPositions: 0, stopPct: 1, takePct: 2, tpHoldMin: 240 };
const pos = (arm: string): Position => ({ arm, token: "0x" + arm, symbol: arm, entryTs: Date.now(), entryQuoteRef: "{}", entryUsd: 2.5, entryWethRaw: "1000000000000000", qtyRaw: "2000" });
const sell: QuoteResult = { ok: true, quote: { ts: 1, route: "test", amountIn: "2000", amountOut: "1030000000000000", impactPct: 0, slippagePct: 1 } };
const io = { quoteBuy: async () => sell, quoteSell: async () => sell, loadCandidates: () => [], cacheStale: () => false, scanCandidates: async () => [] };

test("rhpaper: arm A cannot mark or close arm B, and frozen exit policy survives tuning", async () => {
  const previous = process.env.RHPAPER_DIR;
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-arm-"));
  try {
    const s = emptyState();
    const a = pos("A"); a.exitPolicy = { stopPct: 1, takePct: 5, tpHoldMin: 240 };
    s.positions = [a, pos("B")]; saveState(s);
    let calls = 0;
    const result = await cycle(base, { ...io, quoteSell: async () => { calls++; return sell; } });
    eq(calls, 1, "only A is quoted");
    eq(result.closed, 0, "A retains +5% policy, not newly supplied +2%");
    eq(loadState().positions.find((p) => p.arm === "B")?.marks, undefined, "B untouched");
  } finally { if (previous === undefined) delete process.env.RHPAPER_DIR; else process.env.RHPAPER_DIR = previous; }
});

test("rhpaper: stuck position is retried and can recover", async () => {
  const previous = process.env.RHPAPER_DIR;
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-stuck-"));
  try {
    const s = emptyState(); const a = pos("A"); a.stuck = true; s.positions = [a]; s.stuck = 1; saveState(s);
    const result = await cycle({ ...base, takePct: 10 }, io);
    eq(result.closed, 0, "not at take");
    eq(loadState().positions[0]?.stuck, false, "quote recovered");
    eq(loadState().stuck, 0, "quarantine count recovered");
  } finally { if (previous === undefined) delete process.env.RHPAPER_DIR; else process.env.RHPAPER_DIR = previous; }
});

test("rhpaper: full-size reverse floor below stop refuses entry", async () => {
  const previous = process.env.RHPAPER_DIR;
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-floor-"));
  try {
    let reverseAmount = "";
    const result = await cycle({ ...base, maxPositions: 1 }, {
      ...io, loadCandidates: () => [{ token: "0xt", symbol: "T", decimals: 18, buyOk: true, sellOk: true }],
      quoteBuy: async () => ({ ok: true, quote: { ...sell.quote!, amountIn: "1000000000000000", amountOut: "999999" } }),
      quoteSell: async (_token, amount) => { reverseAmount = amount; return { ok: true, quote: { ...sell.quote!, amountOut: "990000000000000" } }; },
    });
    eq(reverseAmount, "999999", "reverse uses all bought tokens");
    eq(result.opened, 0, "no instant stop churn");
    eq(loadState().positions.length, 0, "no invalid position");
  } finally { if (previous === undefined) delete process.env.RHPAPER_DIR; else process.env.RHPAPER_DIR = previous; }
});
