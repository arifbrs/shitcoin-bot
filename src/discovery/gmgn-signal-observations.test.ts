import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, eq, assert, approx, throws } from "../testing/harness.js";
import { acquireObservationLock, appendObservation, dexPriceSnapshot, dueMarkTargets, gmgnPriceSnapshot,
  journalPath, makeSignalMark, observeSignal, readObservationJournal, type ObservationJournal, type SignalObservation } from "./gmgn-signal-observations.js";

const row = { id: "upstream-1", token_address: "mintA", signal_type: 12, trigger_at: 100, signal_times: 1, data: { symbol: "A" } };
const signal = (): SignalObservation => observeSignal("sol", row, 120_000, 119_000)!;
const journal = (s = signal()): ObservationJournal => ({ signals: [s], marks: [], malformed: 0, duplicates: 0 });
const pairs = (price = "2") => [{ chainId: "solana", pairAddress: "p1", baseToken: { address: "mintA" }, priceUsd: price, marketCap: 2000, liquidity: { usd: 100 } }];

test("GMGN observations: identity preserves chain, trigger/count, and upstream ID", () => {
  const s = signal();
  eq(s.triggerAt, 100_000, "seconds → milliseconds"); eq(s.observationDelayMs, 20_000, "feed delay recorded");
  eq(observeSignal("sol", row, 140_000, 139_000)!.signalId, s.signalId, "repeated poll is same event");
  eq(observeSignal("sol", { ...row, signal_times: 2 }, 140_000, 139_000)!.signalId, s.signalId, "aggregate count change is not a new trigger");
  assert(observeSignal("sol", { ...row, trigger_at: 110, signal_times: 2 }, 120_000, 119_000)!.signalId !== s.signalId, "successive trigger not collapsed");
  assert(observeSignal("robinhood", row, 120_000, 119_000)!.signalId !== s.signalId, "chains never joined");
});

test("GMGN observations: missing identity/trigger is explicit, not invented", () => {
  const s = observeSignal("sol", { ...row, id: "", trigger_at: undefined }, 120_000, 119_000)!;
  eq(s.identityQuality, "ambiguous", "cannot dedupe reliably"); eq(s.triggerAt, null, "unknown trigger");
  const target = dueMarkTargets(journal(s), 120_000)[0]!;
  eq(makeSignalMark(target, dexPriceSnapshot("sol", s.mint, pairs(), 120_000), 120_000).status, "MISSING", "ambiguous identity not admitted as outcome evidence");
});

test("GMGN observations: durable entry/marks survive restart and never enter events stream", () => {
  const root = mkdtempSync(join(tmpdir(), "gmgn-journal-"));
  const s = signal(); appendObservation(s, root);
  const target = dueMarkTargets(readObservationJournal(root), 120_000)[0]!;
  appendObservation(makeSignalMark(target, dexPriceSnapshot("sol", s.mint, pairs(), 120_000), 120_000), root);
  const reloaded = readObservationJournal(root);
  eq(reloaded.signals.length, 1, "entry preserved"); eq(reloaded.marks.length, 1, "mark preserved");
  eq(dueMarkTargets(reloaded, 120_000).length, 0, "no duplicate entry mark after restart");
  assert(!readFileSync(journalPath(root), "utf8").includes("strategy2-candidate"), "journal cannot trigger trader admission");
});

test("GMGN observations: late horizons stay missing; one late snapshot cannot backfill", () => {
  const s = signal(), j = journal(s);
  const entryTarget = dueMarkTargets(j, 120_000)[0]!;
  const entry = makeSignalMark(entryTarget, dexPriceSnapshot("sol", s.mint, pairs(), 120_000), 120_000);
  j.marks.push(entry);
  const late = 120_000 + 7 * 3_600_000;
  const due = dueMarkTargets(j, late);
  eq(due.length, 3, "15m, 1h, 6h due, 24h not due");
  for (const target of due) {
    const m = makeSignalMark(target, dexPriceSnapshot("sol", s.mint, pairs("3"), late), late, entry);
    eq(m.status, "MISSING", "late snapshot rejected"); eq(m.priceChangePct, null, "not a 15m/1h/6h profit"); eq(m.checkedAt, late, "actual response time retained");
  }
});

test("GMGN observations: return uses measured entry price and actual times, never trigger MC", () => {
  const s = signal(), j = journal(s);
  const e = dueMarkTargets(j, 120_000)[0]!;
  const entry = makeSignalMark(e, dexPriceSnapshot("sol", s.mint, pairs(), 180_000), 180_000);
  j.marks.push(entry);
  const t = dueMarkTargets(j, 1_020_000)[0]!;
  const mark = makeSignalMark(t, dexPriceSnapshot("sol", s.mint, pairs("3"), 1_080_000, "p1"), 1_080_000, entry);
  eq(mark.status, "OBSERVED", "inside fixed tolerance"); approx(mark.priceChangePct!, 50, 1e-10, "price change");
  eq(mark.actualAgeMinutes, 16, "actual signal age"); eq(mark.returnSpanMinutes, 15, "actual measured return interval");
  eq(mark.executionState, "PRICE_MARK_ONLY_NOT_EXECUTED", "never real P&L");
});

test("GMGN observations: missing entry, vanished pair, wrong chain, and network error do not become zero", () => {
  const s = signal(), j = journal(s);
  const entry = makeSignalMark(dueMarkTargets(j, 120_000)[0]!, dexPriceSnapshot("sol", s.mint, pairs(), 120_000), 120_000);
  j.marks.push(entry); const t = dueMarkTargets(j, 1_020_000)[0]!;
  const otherPair = dexPriceSnapshot("sol", s.mint, [{ ...pairs()[0]!, pairAddress: "p2", liquidity: { usd: 10000 } }], 1_020_000, "p1");
  eq(makeSignalMark(t, otherPair, 1_020_000, entry).reason, "PAIR_UNAVAILABLE", "no switching to surviving pool");
  const wrong = { ...dexPriceSnapshot("sol", s.mint, pairs(), 1_020_000), chain: "bsc" };
  eq(makeSignalMark(t, wrong, 1_020_000, entry).reason, "SOURCE_IDENTITY_MISMATCH", "no cross-chain marks");
  eq(makeSignalMark(t, null, 1_020_000, entry, "DEX_HTTP_429").priceChangePct, null, "error isn't flat return");
  eq(makeSignalMark(t, dexPriceSnapshot("sol", s.mint, pairs(), 1_020_000), 1_020_000).reason, "ENTRY_UNAVAILABLE", "no inferred buy price");
});

test("GMGN observations: reject quote-token price and do not substitute FDV for market cap", () => {
  const snapshot = dexPriceSnapshot("sol", "mintA", [{ ...pairs()[0]!, baseToken: { address: "other" }, quoteToken: { address: "mintA" } }], 1);
  eq(snapshot.priceUsd, null, "price belongs to base token, not quote token");
  const noMc = dexPriceSnapshot("sol", "mintA", [{ ...pairs()[0]!, marketCap: null, fdv: 999999 }], 1);
  eq(noMc.mcUsd, null, "FDV is not market cap");
  eq(gmgnPriceSnapshot("robinhood", "0xa", { price: { price: "2" }, total_supply: "100" }, 1).mcUsd, null, "no total-supply fallback");
});

test("GMGN observations: corrupt/duplicate journals fail closed without overwriting evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "gmgn-corrupt-"));
  appendObservation(signal(), root); appendObservation(signal(), root);
  throws(() => readObservationJournal(root), "duplicate detected"); eq(readObservationJournal(root, false).duplicates, 1, "offline report can diagnose");
  writeFileSync(journalPath(root), "{incomplete");
  throws(() => readObservationJournal(root), "torn tail detected"); eq(readFileSync(journalPath(root), "utf8"), "{incomplete", "evidence preserved");
});

test("GMGN observations: exclusive role lock refuses duplicate collector", () => {
  const root = mkdtempSync(join(tmpdir(), "gmgn-lock-"));
  const release = acquireObservationLock("collector", root);
  try { throws(() => acquireObservationLock("collector", root), "same process cannot acquire twice"); }
  finally { release(); }
  acquireObservationLock("collector", root)();
});
