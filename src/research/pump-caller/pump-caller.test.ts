/** LANE PUMP-CALLER — tes: tracker, absorpsi, wick/policy, deteksi dini, analis, eksperimen, jurnal. */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, eq, approx, assert } from "../../testing/harness.js";
import { trackCallerPosition } from "./position-tracker.js";
import { absorptionView } from "./absorption.js";
import { wickContext, evaluatePolicies, representative } from "./wicks.js";
import { latencyView, moveAlreadyOver } from "./early-detection.js";
import { analyze, PUMP_PAPER_COST_V1 } from "./analyst.js";
import { TRIGGERS, compare } from "./experiments.js";
import { append, read, decisionIdFor } from "./journal.js";
import { FIX_TRADES, FIX_CANDLES_1S, FIX_USER_POSITIONS, FIX_USER_TRADES } from "./fixtures.js";
import { normalizeTradeTs } from "./timestamps.js";
import { admit } from "./watchlist.js";
import { resolveOutcome, paperForPolicy } from "./results.js";
import { reduceOutcomes, markOutcome } from "./journal.js";
import { decodePumpTx } from "./onchain-tape.js";
import { readFileSync } from "node:fs";
import type { CallerEvent, Candle, PolicyEvaluation } from "./types.js";

const MINT = "FixMint11111111111111111111111111111111111";
const ev = (dedupeKey: string, kind: "buy" | "sell", sol: number, ts: number, balanceAfter?: number): CallerEvent =>
  ({ dedupeKey, mint: MINT, callerId: "alpha", kind, sol, tokenAmount: null, ts, balanceAfter });

test("PC tracker: HOLDING → PARTIAL_SELL → EXITED berdasar BUKTI; dedupe; UNKNOWN tanpa bukti", () => {
  const holding = trackCallerPosition("alpha", MINT, [ev("s1", "buy", 0.5, 1000)]);
  eq(holding.state, "HOLDING", "beli teramati, tanpa jual");
  const partial = trackCallerPosition("alpha", MINT, [ev("s1", "buy", 0.5, 1000), ev("s2", "sell", 0.2, 2000, 12_000_000)]);
  eq(partial.state, "PARTIAL_SELL", "jual sebagian + sisa saldo teramati");
  eq(partial.observedTokenBalance, 12_000_000, "saldo teramati (bukan estimasi eksposur)");
  const exited = trackCallerPosition("alpha", MINT, [ev("s1", "buy", 0.5, 1000), ev("s2", "sell", 0.2, 2000, 0)]);
  eq(exited.state, "EXITED", "saldo 0 teramati");
  const dup = trackCallerPosition("alpha", MINT, [ev("s1", "buy", 0.5, 1000), ev("s1", "buy", 0.5, 1000)]);
  eq(dup.eventCount, 1, "dedupeKey ganda dihitung sekali");
  eq(dup.observedBuysSol, 0.5, "beli tidak terhitung dua");
  const unknown = trackCallerPosition("alpha", MINT, []);
  eq(unknown.state, "UNKNOWN", "tanpa event = UNKNOWN, bukan dikarang");
  // provider-position menang utk PnL est (teramati vs rekonstruksi dibedakan):
  const withProvider = trackCallerPosition("alpha", MINT, [ev("s1", "buy", 0.5, 1000)], FIX_USER_POSITIONS[0]);
  eq(withProvider.evidence, "provider-position", "posisi provider diprioritaskan");
  eq(withProvider.unrealizedPnlEstimateSol, -55, "unrealized dari provider");
  eq(withProvider.state, "HOLDING", "saldo provider > 0");
  void FIX_USER_TRADES;
});

test("PC absorpsi: large-buy $500/$1000 + small-sell $5-100, netflow, followers, wash, rapid-sell", () => {
  const v = absorptionView(FIX_TRADES);
  eq(v.largeBuys.length, 2, "$600 dan $1000 lolos ambang");
  eq(v.smallSells, 1, "satu small-sell ($10; $4 di bawah $5)");
  approx(v.netFlowSol, 3 + 5 + 0.5 - 0.5 - 0.02 - 0.05, 1e-9, "net flow SOL");
  eq(v.uniqueBuyers, 3, "w1,w3,w4");
  eq(v.followersFollow, true, "w3+w4 menyusul w1 dalam 30s... w4 beli di 5000 > 1000+30s? — cek");
  eq(v.initialBuyerRapidSold, false, "pembeli awal tidak cepat jual");
  assert(v.washSuspicion.bothSidesPct > 0, "w4 dua sisi terdeteksi");
});

test("PC wick/policy: konteks wick; 4 kebijakan pada event identik; candle tak-representatif ditolak", () => {
  const c = { ts: 1, open: 10, high: 12, low: 9.5, close: 11.5, volumeSol: 3 };
  const w = wickContext(c, 9.4);
  eq(w.higherLow, true, "low > low sebelumnya");
  approx(w.upperWickPct, (12 - 11.5) / 2.5 * 100, 0.01, "upper wick 20%");
  eq(w.buyerFollowThrough, true, "close>open + volume>0");
  assert(!representative({ ...c, volumeSol: 0 }, "1s"), "volume 0 = tidak representatif");
  assert(!representative(c, "1s", c.ts + 10_000), "gap >2× interval = ditolak");
  const stimTs = FIX_CANDLES_1S[3]!.ts;
  const evals = evaluatePolicies(stimTs, FIX_CANDLES_1S, "1s");
  eq(evals.IMMEDIATE_OBSERVED_ENTRY.triggered, true, "langsung: candle pertama representatif");
  const confirm = evals.CONFIRM_AFTER_4X_1S_CANDLES!;
  eq(confirm.triggered, true, "4 candle tersedia");
  eq(confirm.requiredCandles, 4, "tepat 4");
  const sparse = evaluatePolicies(stimTs, FIX_CANDLES_1S.slice(3, 5), "1s"); // tepat 2 candle pasca-stimulus
  eq(sparse.CONFIRM_AFTER_4X_1S_CANDLES!.triggered, false, "candle kurang → tidak trigger");
  eq(sparse.CONFIRM_AFTER_4X_1S_CANDLES!.rejectReason, "CANDLE_KURANG (2/4)", "alasan eksplisit (2 candle pasca-stimulus)")
});

test("PC deteksi dini: latensi deteksi vs callout vs eksekusi terpisah; anomali & sudah-berlalu", () => {
  const v = latencyView({ mint: MINT, createdAt: 1000, callerBuyTs: 2000, calloutPublishedTs: 5000, firstObservedByBot: 3000, firstExecutableQuoteTs: 3500, callerFollowersAtBuy: 1200 });
  eq(v.detectionLagMs, 1000, "deteksi 1s pasca beli caller");
  eq(v.calloutLagMs, 3000, "callout 3s pasca beli");
  eq(v.executableLagMs, 500, "quote 0,5s pasca observasi");
  const anomali = latencyView({ mint: MINT, createdAt: 5000, callerBuyTs: 2000, calloutPublishedTs: null, firstObservedByBot: 3000, firstExecutableQuoteTs: null, callerFollowersAtBuy: null });
  assert(anomali.note.includes("ANOMALI"), "beli sebelum create terdeteksi");
  const over = moveAlreadyOver({ mint: MINT, createdAt: 1000, callerBuyTs: 2000, calloutPublishedTs: null, firstObservedByBot: 60_000, firstExecutableQuoteTs: null, callerFollowersAtBuy: null }, 100, 160);
  eq(over.over, true, "harga +60% sebelum teramati = peluang sudah berlalu");
});

test("PC analis: SKIP/WATCH/PAPER_ENTRY terstruktur; biaya notional-kecil dieksplisitkan; tanpa aturan absolut", () => {
  const skip = analyze({ mint: MINT, ts: 1 });
  eq(skip.decision, "SKIP", "tanpa bukti = SKIP");
  assert(skip.missingData.length >= 3, "data hilang dicatat");
  const rich = analyze({
    mint: MINT, ts: 2,
    caller: { callerId: "a", mint: MINT, state: "HOLDING", observedBuysSol: 1, observedSellsSol: 0, observedTokenBalance: 1000, lastEventTs: 1, eventCount: 2, realizedPnlEstimateSol: null, unrealizedPnlEstimateSol: -0.4, evidence: "wallet-activity", note: "" },
    absorption: { largeBuys: [{ usd: 800, sol: 4, ts: 1, wallet: "w1" }], smallSells: 3, smallSellUsdTotal: 30, totalBuySol: 9, totalSellSol: 1, netFlowSol: 8, uniqueBuyers: 5, repeatBuyers: 2, largeSellerExits: 0, washSuspicion: { bothSidesPct: 5, note: "" }, priceResponseAfterLargeBuy: { candleWindow: "1s", movePct: 3 }, followersFollow: true, initialBuyerRapidSold: false },
    wick: { candle: { ts: 1, open: 1, high: 1.2, low: 0.99, close: 1.15, volumeSol: 4 }, upperWickPct: 10, lowerWickPct: 5, closeLocation: 0.8, retracementFromHighPct: 4, higherLow: true, buyerFollowThrough: true, volumeSol: 4 },
    early: { detectionLagMs: 2_000, calloutLagMs: 1_000, executableLagMs: 100, note: "lengkap" },
  });
  eq(rich.decision, "PAPER_ENTRY", "bukti kuat → PAPER_ENTRY");
  eq(rich.paperNotionalUsd, 3, "notional riset $3");
  assert(rich.executionCostWarning && rich.executionCostWarning.includes("5pp"), `peringatan biaya 5pp (${rich.executionCostWarning})`);
  assert(!JSON.stringify(rich).toLowerCase().includes("must never"), "tanpa aturan absolut");
});

test("PC eksperimen: trigger pre-registrasi + perbandingan bootstrap vs baseline", () => {
  const h1 = TRIGGERS.find((t) => t.id === "UNDERWATER_CALLER_REBOUND")!;
  const fires = h1.trigger({ caller: { callerId: "a", mint: MINT, state: "HOLDING", observedBuysSol: 1, observedSellsSol: 0, observedTokenBalance: 1, lastEventTs: 1, eventCount: 1, realizedPnlEstimateSol: null, unrealizedPnlEstimateSol: -0.5, evidence: "provider-position", note: "" } });
  eq(fires.fires, true, "underwater + holding = trigger");
  const noFire = h1.trigger({ caller: null });
  eq(noFire.fires, false, "tanpa caller = tidak trigger");
  const trig = Array.from({ length: 8 }, (_, i) => ({ mint: `m${i}`, changePct: 2 + (i % 3) }));
  const base = Array.from({ length: 8 }, (_, i) => ({ mint: `b${i}`, changePct: -1 - (i % 2) }));
  const cmp = compare(h1.id, trig, base);
  eq(cmp.status, "DESCRIPTIVE", "n≥5 per sisi");
  assert(cmp.diffPp > 0 && cmp.ci95Diff && cmp.ci95Diff[0] > 0, "trigger > baseline dgn CI di luar 0 (data sintetis)");
  const ins = compare(h1.id, trig.slice(0, 2), base);
  eq(ins.status, "INSUFFICIENT", "n<5 = INSUFFICIENT");
});

test("PC jurnal: append/read dedupe; outcome-mark idempoten lintas restart", () => {
  const prev = process.env.PUMP_CALLER_DIR;
  process.env.PUMP_CALLER_DIR = mkdtempSync(join(tmpdir(), "pc-journal-"));
  try {
    append({ type: "token-observed", ts: 1, mint: MINT, source: "fixture" });
    append({ type: "token-observed", ts: 2, mint: MINT, source: "fixture" }); // duplikat kunci sama
    const j1 = read();
    eq(j1.rows.filter((r) => r.type === "token-observed").length, 1, "token-observed idempoten per mint");
    const did = decisionIdFor(MINT, 123, "v1");
    eq(markOutcome({ decisionId: did, horizonMin: 1, targetAt: 124_000, checkedAt: 125_000, status: "OBSERVED", priceAtDecision: 1, priceAtTarget: 1.1, changePct: 10 }), true, "mark pertama ditulis");
    eq(markOutcome({ decisionId: did, horizonMin: 1, targetAt: 124_000, checkedAt: 130_000, status: "OBSERVED", priceAtDecision: 1, priceAtTarget: 1.2, changePct: 20 }), false, "mark ulang TIDAK menimpa (idempoten)");
    const marks = read().rows.filter((r) => r.type === "outcome-mark");
    eq(marks.length, 1, "tetap satu baris");
    eq(marks[0]!.changePct, 10, "nilai pertama yang bertahan");
  } finally { if (prev === undefined) delete process.env.PUMP_CALLER_DIR; else process.env.PUMP_CALLER_DIR = prev; }
});

test("PC cost-model: overhead putaran v1 = 5,0pp (parameter riset, berlabel)", () => {
  eq(PUMP_PAPER_COST_V1.roundTripOverheadPct, 5.0, "2×(fee 1% + slip 1,5%)");
});

test("SPRINT timestamps: detik/ms/mikro/ISO eksplisit; invalid DITOLAK (tanpa fallback now)", () => {
  eq(normalizeTradeTs(1_790_000_000), 1_790_000_000_000, "detik");
  eq(normalizeTradeTs(1_790_000_000_000), 1_790_000_000_000, "ms");
  eq(normalizeTradeTs(1_790_000_000_000_000), 1_790_000_000_000, "mikro");
  eq(normalizeTradeTs("2026-10-25T00:00:00Z"), Date.parse("2026-10-25T00:00:00Z"), "ISO");
  eq(normalizeTradeTs("1790000000"), 1_790_000_000_000, "string numerik detik");
  eq(normalizeTradeTs(null), null, "null ditolak");
  eq(normalizeTradeTs(123), null, "terlalu kecil = sampah, ditolak");
  eq(normalizeTradeTs(-5), null, "negatif ditolak");
  eq(normalizeTradeTs("bukan-tanggal"), null, "string sampah ditolak — BUKAN diganti waktu-sekarang");
});

test("SPRINT watchlist: bounded + sampling + TTL + alasan penolakan tercatat", () => {
  const prev = process.env.PUMP_CALLER_DIR;
  process.env.PUMP_CALLER_DIR = mkdtempSync(join(tmpdir(), "pc-wl-"));
  try {
    const policy = { capacity: 2, ttlMs: 3_600_000, sampleEvery: 1 };
    const M = (i: number) => `${"A".repeat(i % 2)}${String(i).padStart(5, "0")}`.padEnd(44, "k"); // dummy base58-ish
    const mint = (i: number) => ("C" + String(i).padEnd(43, "k"));
    let wl = admit([], { mint: mint(1), source: "manual", priority: 10 }, policy, 1, 1000).entries;
    eq(wl.length, 1, "manual selalu admit (tanpa sampling)");
    const dup = admit(wl, { mint: mint(1), source: "manual", priority: 10 }, policy, 2, 2000);
    eq(dup.admitted, false, "duplikat ditolak");
    let r3 = admit(wl, { mint: mint(2), source: "pumpportal", priority: 5 }, policy, 3, 3000);
    wl = r3.entries; eq(wl.length, 2, "kapasitas 2 tercapai");
    const full = admit(wl, { mint: mint(3), source: "pumpportal", priority: 1 }, policy, 4, 4000);
    eq(full.admitted, false, "kapasitas penuh + prioritas rendah = ditolak");
    const evict = admit(wl, { mint: mint(4), source: "pumpportal", priority: 999 }, policy, 5, 5000);
    eq(evict.admitted, true, "prioritas tinggi meng-evict terendah");
    const sampling = { capacity: 10, ttlMs: 3_600_000, sampleEvery: 3 };
    eq(admit([], { mint: mint(9), source: "pumpportal", priority: 1 }, sampling, 1, 1000).admitted, false, "seq 1 dari 3: sampling tolak");
    eq(admit([], { mint: mint(9), source: "pumpportal", priority: 1 }, sampling, 3, 1000).admitted, true, "seq 3 dari 3: admit");
    const rej = readFileSync(join(process.env.PUMP_CALLER_DIR!, "watchlist-rejected.jsonl"), "utf8");
    assert(rej.includes("CAPACITY_FULL") && rej.includes("SAMPLING"), "alasan penolakan tercatat");
  } finally { if (prev === undefined) delete process.env.PUMP_CALLER_DIR; else process.env.PUMP_CALLER_DIR = prev; }
});

test("SPRINT outcomes: PENDING→OBSERVED dari candle SELESAI; retry berbatas; candle in-progress TIDAK dipakai", () => {
  const c = (ts: number, close = 2): Candle => ({ ts, open: 1, high: 3, low: 0.5, close, volumeSol: 1 });
  // horizon 1m, target 61_000; candle 60_000 SELESAI di asOf=61_500 (60k+60s<=61.5k).
  const r1 = resolveOutcome({ status: "PENDING", attempts: 0, targetAt: 61_000, horizonMin: 1, candles: [c(0), c(60_000, 2.2)], intervalMs: 60_000, asOf: 121_000 });
  eq(r1.status, "OBSERVED", "close candle selesai terdekat dipakai");
  eq(r1.priceAtTarget, 2, "harga = close candle [0,60s) (close-time 60k terdekat ke target 61k) - bukan open, bukan candle 60k yg baru selesai di 120k");
  // satu-satunya candle yg bisa melayani target masih IN-PROGRESS (selesai 120k, asOf 110k):
  const r2 = resolveOutcome({ status: "PENDING", attempts: 0, targetAt: 100_000, horizonMin: 1, candles: [c(60_000, 2.2)], intervalMs: 60_000, asOf: 110_000 });
  eq(r2.status, "PENDING", "candle in-progress TIDAK dipakai → PENDING (retry), bukan MISSING permanen");
  // kehabisan percobaan setelah grace → MISSING_FINAL.
  const r3 = resolveOutcome({ status: "PENDING", attempts: 5, targetAt: 400_000, horizonMin: 1, candles: [c(60_000)], intervalMs: 60_000, asOf: 400_000 + 60_000 * 2 + 6 * 60_000 }); // target 400k: candle 60k (close 120k) jauh dari toleransi 30k
  eq(r3.status, "MISSING_FINAL", "final setelah grace + 5 percobaan");
});

test("SPRINT paper no-look-ahead: entry = close candle SELESAI pasca-trigger; MFE/MAE; biaya 5pp", () => {
  const c = (ts: number, o: number, h: number, l: number, cl: number): Candle => ({ ts, open: o, high: h, low: l, close: cl, volumeSol: 1 });
  const candles = [c(0, 1, 1.1, .9, 1.0), c(60_000, 1.0, 1.2, .95, 1.1), c(120_000, 1.1, 1.3, 1.0, 1.2), c(180_000, 1.2, 1.25, .8, .9), c(240_000, .9, .95, .85, .88)];
  const policy: PolicyEvaluation = { policy: "IMMEDIATE_OBSERVED_ENTRY", triggered: true, triggerTs: 10_000, entryPrice: 1.0, requiredCandles: 1, observedCandles: 5, rejectReason: null };
  const pr = paperForPolicy({ decisionTs: 5_000, priceAtDecision: 1.0 }, policy, 4, candles, 60_000, 300_000);
  eq(pr.entryTs, 120_000, "entry = close candle SELESAI pertama ≥ trigger (candle 60k selesai di 120k)");
  eq(pr.entryPrice, 1.1, "harga eksekusi = close 1.1 (open candle yang basi TIDAK dipakai)");
  assert(pr.exitPrice != null && pr.grossPct != null, "exit matang");
  assert(pr.mfePct != null && pr.maePct != null, "MFE/MAE terisi");
  eq(pr.costPp, 5.0, "biaya model 5pp");
  assert(pr.netPct != null && Math.abs(pr.netPct - ((pr.grossPct ?? 0) - 5)) < 1e-9, "net = gross − biaya");
  // look-ahead: evaluasi SEBELUM candle entry selesai → skip eksplisit, bukan harga karangan.
  const early = paperForPolicy({ decisionTs: 5_000, priceAtDecision: 1.0 }, policy, 4, candles.slice(0, 1), 60_000, 60_000);
  eq(early.skipReason, "CANDLE_ENTRY_SELESAI_BELUM_ADA", "tanpa candle selesai = skip berlabel");
});

test("S8-P1 masking: PENDING lama TIDAK menutupi OBSERVED belakangan; terminal tak tertimpa", () => {
  const prev = process.env.PUMP_CALLER_DIR;
  process.env.PUMP_CALLER_DIR = mkdtempSync(join(tmpdir(), "pc-mask-"));
  try {
    append({ type: "outcome-mark", ts: 1000, decisionId: "d1", horizonMin: 1, targetAt: 60_000, status: "PENDING", attempts: 1, priceAtDecision: 1, priceAtTarget: null, changePct: null });
    append({ type: "outcome-mark", ts: 90_000, decisionId: "d1", horizonMin: 1, targetAt: 60_000, status: "OBSERVED", attempts: 2, priceAtDecision: 1, priceAtTarget: 1.2, changePct: 20 });
    const s = reduceOutcomes(read().rows).get("outcome:d1:1")!;
    eq(s.status, "OBSERVED", "transisi terakhir-lah state (bukan baris pertama)");
    eq(s.priceAtTarget, 1.2, "harga hasil transisi");
    // terminal: baris PENDING setelah OBSERVED diabaikan
    append({ type: "outcome-mark", ts: 95_000, decisionId: "d1", horizonMin: 1, targetAt: 60_000, status: "PENDING", attempts: 9, priceAtDecision: 1, priceAtTarget: null, changePct: null });
    eq(reduceOutcomes(read().rows).get("outcome:d1:1")!.status, "OBSERVED", "terminal tak tertimpa");
    // markOutcome no-op saat terminal; attempts-naik saat PENDING ditulis
    eq(markOutcome({ decisionId: "d1", horizonMin: 1, targetAt: 60_000, checkedAt: 99_000, status: "OBSERVED", priceAtDecision: 1, priceAtTarget: 1.3, changePct: 30 }), false, "no-op setelah terminal");
    append({ type: "outcome-mark", ts: 10_000, decisionId: "d2", horizonMin: 1, targetAt: 60_000, status: "PENDING", attempts: 1, priceAtDecision: 1, priceAtTarget: null, changePct: null });
    eq(markOutcome({ decisionId: "d2", horizonMin: 1, targetAt: 60_000, checkedAt: 20_000, status: "PENDING", priceAtDecision: 1, priceAtTarget: null, changePct: null }), true, "attempts naik saat PENDING = ditulis");
    eq(markOutcome({ decisionId: "d2", horizonMin: 1, targetAt: 60_000, checkedAt: 21_000, status: "PENDING", priceAtDecision: 1, priceAtTarget: null, changePct: null }), true, "lagi (attempts 3)");
  } finally { if (prev === undefined) delete process.env.PUMP_CALLER_DIR; else process.env.PUMP_CALLER_DIR = prev; }
});

test("S8-P2 premature: asOf < target → PENDING selalu; candle jauh-sebelum-target tak dipakai; hanya candle menutupi target", () => {
  const c = (ts: number, close = 2): Candle => ({ ts, open: 1, high: 3, low: .5, close, volumeSol: 1 });
  const early = resolveOutcome({ status: "PENDING", attempts: 0, targetAt: 3_600_000, horizonMin: 60, candles: [c(3_540_000, 9.9)], intervalMs: 60_000, asOf: 3_500_000 });
  eq(early.status, "PENDING", "belum jatuh tempo = PENDING meski candle ada");
  const stale = resolveOutcome({ status: "PENDING", attempts: 9, targetAt: 3_600_000, horizonMin: 60, candles: [c(0, 9.9)], intervalMs: 60_000, asOf: 3_600_000 + 8 * 60_000 * 60_000 }); // lewat grace 7,5 juta ms
  eq(stale.status, "MISSING_FINAL", "candle 1 jam sebelum target BUKAN hasil → FINAL, bukan OBSERVED palsu");
  const good = resolveOutcome({ status: "PENDING", attempts: 0, targetAt: 3_600_000, horizonMin: 60, candles: [c(3_540_000, 5), c(3_600_000, 6)], intervalMs: 60_000, asOf: 3_700_000 });
  eq(good.status, "OBSERVED", "candle yg close-time ≥ target dipakai");
  eq(good.priceAtTarget, 5, "candle dgn close-time TEPAT di target (=3,6jt) adalah yg pertama memenuhi >=target");
});

test("S8-P4 onchain decode: delta saldo token pemilik → BUY/SELL + SOL delta; identitas signature:owner", () => {
  const mint = "Mint1111111111111111111111111111111111111111";
  const tx = {
    slot: 100, blockTime: 1_790_000_000, signature: "sigAAA",
    transaction: { message: { accountKeys: ["OwnerW111111111111111111111111111111111111111", "Curve111111111111111111111111111111111111111"] } },
    meta: {
      preBalances: [1_000_000_000, 5_000_000_000], postBalances: [900_000_000, 5_100_000_000],
      preTokenBalances: [{ accountIndex: 0, mint, owner: "OwnerW111111111111111111111111111111111111111", uiTokenAmount: { uiAmount: 100 } }],
      postTokenBalances: [{ accountIndex: 0, mint, owner: "OwnerW111111111111111111111111111111111111111", uiTokenAmount: { uiAmount: 250 } }],
    },
  };
  const trades = decodePumpTx(tx as never, mint, 1_790_000_500_000);
  eq(trades.length, 1, "satu wallet berubah");
  const t = trades[0]!;
  eq(t.side, "buy", "token bertambah = BUY");
  eq(t.signature, "sigAAA", "signature asli");
  eq(t.slot, 100, "slot asli");
  eq(t.sourceTs, 1_790_000_000_000, "timestamp sumber = blockTime");
  assert(t.sol > 0 && Math.abs(t.sol - 0.1) < 1e-9, "SOL delta 0.1 (beli: SOL berkurang, diambil absolut)");
  eq(t.dedupeKey, "sigAAA:OwnerW111111111111111111111111111111111111111", "identitas signature:owner");
  // jual: token berkurang
  const txSell = { ...tx, signature: "sigBBB", meta: { ...tx.meta, preBalances: [900_000_000, 5_100_000_000], postBalances: [950_000_000, 5_050_000_000],
    preTokenBalances: [{ accountIndex: 0, mint, owner: "OwnerW111111111111111111111111111111111111111", uiTokenAmount: { uiAmount: 250 } }], postTokenBalances: [{ accountIndex: 0, mint, owner: "OwnerW111111111111111111111111111111111111111", uiTokenAmount: { uiAmount: 100 } }] } };
  eq(decodePumpTx(txSell as never, mint, 0)[0]!.side, "sell", "token berkurang = SELL");
  // mint lain / tanpa perubahan → kosong
  eq(decodePumpTx({ ...tx, meta: null } as never, mint, 0).length, 0, "tanpa meta = kosong");
});
