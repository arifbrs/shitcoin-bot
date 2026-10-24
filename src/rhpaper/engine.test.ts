import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, approx, assert } from "../testing/harness.js";
import { cycle, quotePnl, type Cfg } from "./engine.js";
import { simulatedExitWeth, latencyOverlayPct } from "./fillmodel.js";
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

test("R8 P6: fixture ujung-ke-ujung — likuiditas → entry sim → posisi → exit sim → net eksak (offline, deterministik)", async () => {
  const previous = process.env.RHPAPER_DIR;
  process.env.RHPAPER_DIR = mkdtempSync(join(tmpdir(), "rhpaper-e2e-"));
  try {
    const ethUsd = async (): Promise<number | null> => 2361; // disuntik: deterministik, tanpa jaringan
    const liqCandidate = { token: "0xliq", symbol: "LIQ", decimals: 18, buyOk: true, sellOk: true, liquidityUsd: 50_000, liquiditySource: "dexscreener" as const, liquidityAt: 1 };
    // Entry quote: 1e15 wei → 2.000 token. Exit quote (qty penuh): 1.020.000 wei → gross +2%.
    const entryQuote = { ts: 1, route: "test", amountIn: "1000000000000000", amountOut: "2000000000000000000000", impactPct: 0.1, slippagePct: 1 };
    const exitQuote = { ts: 2, route: "test", amountIn: "2000000000000000000000", amountOut: "1020000000000000", impactPct: 0.1, slippagePct: 1 };
    let phase = 0;
    const io = {
      quoteBuy: async () => ({ ok: true, quote: entryQuote }),
      quoteSell: async () => ({ ok: true, quote: exitQuote }),
      loadCandidates: () => [liqCandidate], cacheStale: () => false, scanCandidates: async () => [liqCandidate], ethUsd,
    };
    // Siklus 1: buka (sim entry harus fill — likuiditas $50k ≫ 2% × $2,36).
    await cycle({ ...base, maxPositions: 1 }, io);
    const afterOpen = loadState();
    eq(afterOpen.positions.length, 1, "posisi terbuka");
    eq(afterOpen.positions[0]!.liquidityUsd, 50_000, "likuiditas tersimpan di posisi");
    assert(afterOpen.positions[0]!.tradeId, "tradeId ada");
    phase++;
    // Siklus 2: tutup (netPct = (1.020.000−1.000.000−11.400)/1.000.000 ... dalam pp = +0,86% → di bawah TP 5%? base.takePct=5 → tidak keluar.
    // Paksa keluar via stop: exit quote 980.000 → net −3,14% < −1 (base.stopPct=1)... base di atas: stopPct 1.
    const exitQuoteLoss = { ...exitQuote, amountOut: "980000000000000" };
    const io2 = { ...io, quoteSell: async () => ({ ok: true, quote: exitQuoteLoss }) };
    await cycle({ ...base, maxPositions: 1 }, io2);
    const ledger = readFileSync(join(afterOpenPositionsDir(), "ledger-" + new Date().toISOString().slice(0, 10) + ".jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const openRow = ledger.find((r) => r.action === "OPEN")!;
    const closeRow = ledger.find((r) => r.action === "CLOSE")!;
    eq((openRow.simFillEntry as { filled: boolean }).filled, true, "sim entry fill (fixture)");
    eq((openRow.liquidityUsd as number), 50_000, "likuiditas di baris OPEN");
    eq((closeRow.simFillExit as { filled: boolean }).filled, true, "sim exit fill (fixture)");
    // Net sim eksak: quotePnl(entry, simulatedExitWeth(exitQuoteOut)) — jalur yang sama dengan cohort-stats.
    const simOut = simulatedExitWeth("980000000000000").toString();
    const expected = quotePnl("1000000000000000", simOut).netPct;
    // Jalur komposit (eksak, metodologi A) vs aproksimasi overlay-additive: beda <0,03 pp karena
    // drag sebenarnya menskala dengan rasio exit/entry (0,98 di fixture) — komposit yang dipakai.
    const simExpectancy = Number(closeRow.netPct) - latencyOverlayPct();
    approx(expected, simExpectancy, 0.03, "net sim komposit dekat aproksimasi overlay (beda = rasio exit/entry)");
    approx(expected, Number(closeRow.netPct) - 0.9975 * 0.98, 1e-4, "komposit eksak = netPct − overlay×(exit/entry)");
    void phase;
  } finally { if (previous === undefined) delete process.env.RHPAPER_DIR; else process.env.RHPAPER_DIR = previous; }
});

function afterOpenPositionsDir(): string { return process.env.RHPAPER_DIR ?? "logs/rhpaper"; }

test("FINAL-2: representasi persis — netWethRaw = bilangan rasional eksak; netPct = double 10 desimal", () => {
  const simOut = simulatedExitWeth("995098189942235");
  const pnl = quotePnl("1000000000000000", simOut.toString());
  eq(pnl.netWethRaw, "-26227914502440", "numerik rasional EKSAK disimpan (wei, BigInt-string)");
  eq(pnl.netPct, -2.622791450244, "netPct terbaca 10 desimal — double memuat 13 digit signifikan ini persis");
  // Yang DISIMPAN di ledger = keduanya (netWethRaw string eksak + netPct number); yang DITAMPILKAN
  // laporan boleh dibulatkan, asal berasal dari nilai ini (rh:ledger-audit memvalidasi tiap baris).
});
