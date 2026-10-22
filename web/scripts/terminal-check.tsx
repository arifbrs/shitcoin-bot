/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addPaperCash, createPaperLedger, fillPaperOrder, localPositionToken, paperPortfolio, parsePaperAmount, restorePaperLedger, updatePaperMarks } from "../src/lib/localPaper";
import type { PaperLedger } from "../src/lib/localPaper";
import { assetIdentity, filterTokens, formatCount, formatPercent, formatPrice, formatQuantity, formatSignedUsd, formatUsd, MAX_QUOTE_AGE_MS, quoteProblem, serverPositions, serverSignals, serverTrades, terminalTokens } from "../src/lib/terminal";
import type { QuoteView, TokenView } from "../src/lib/terminal";
import type { ScoutCandidate, StatsResponse } from "../src/types/stats";
import { LocalPaperTicket, PaperSubmit } from "../src/components/panels/LocalPaperTicket";
import { ServerLedger } from "../src/components/panels/ServerLedger";
import { TokenScanner } from "../src/components/panels/TokenScanner";
import { TerminalWorkspace } from "../src/components/panels/TerminalWorkspace";
import { TerminalStatus } from "../src/components/panels/TerminalChrome";
import { validCandles } from "../src/components/panels/CoinChart";

const now = Date.parse("2026-10-22T10:00:00Z");
const contract = "So11111111111111111111111111111111111111112";
const candidate: ScoutCandidate = { ts: new Date(now).toISOString(), type: "strategy2-candidate", strategyTag: "study", firstSeenAt: now, source: "scout", strategy2Epoch: "1", cfg: "1", mint: contract, sym: "TEST", mcUsd: 280_000, liqUsd: 74_000, holders: 641, riskScore: null, rugged: null, change1h: null, change4h: null, change24h: 0, hasSocials: false, twitterUrl: null, createdAt: null, isBoosted: false, isCommunityTakeover: false };
const token: TokenView = terminalTokens({ strategy2: { mode: "study", count: 1, candidates: [candidate] } })[0];
const quote: QuoteView = { tokenKey: token.assetKey!, unitPriceUsd: 2, quotedAt: now, source: "test · genuine unit quote", kind: "unit-quote", eligible: true, reason: null };
const execute = (ledger: PaperLedger, side: "buy" | "sell", amount: string, price: number, time = now) => {
  const result = fillPaperOrder(ledger, token, side, amount, { ...quote, unitPriceUsd: price, quotedAt: time }, time);
  if (!result.ok) throw new Error(result.error);
  assert.ok(Math.abs(result.ledger.cashUsd + result.ledger.positions.reduce((sum, position) => sum + position.costBasisUsd, 0) - result.ledger.depositedUsd - result.ledger.realizedPnlUsd) < 0.01);
  return result.ledger;
};

test("source adapters keep accounting units, identity, and absent quotes honest", () => {
  const data = {
    now: new Date(now).toISOString(),
    strategy2: { mode: "study", count: 1, candidates: [candidate] },
    market: { top: [{ mint: contract, symbol: "TEST", mcUsd: 300_000, ageMin: null, replies: 0 }], new: [], ageMs: null },
    strategy2Primary: { paper: { balanceSol: 1_234, floatSol: 1_000, openPositions: [{ mint: contract, symbol: "TEST", entryPrice: 1, lastPrice: 1.15, entryCostUsd: 250, unrealizedPnl: 15, heldSec: 60, marketCap: 280_000, holders: 641, noManualClose: true }] }, recentTrades: [{ symbol: "TEST", ts: new Date(now).toISOString(), reason: "CLOSE", pnlUsd: 37.5, pnlPct: 15, heldHours: 1 }] },
    strategy2Paper: { openPositions: [{ mint: contract, sym: "TEST", entryCostUsd: 250, unrealizedPct: 15, heldHours: 1, mcUsd: 280_000, holders: 641 }] },
    laneRobinhood: { updatedAt: new Date(now).toISOString(), variants: [{ id: "rsi-03", cohort: "C2", positions: [{ symbol: "ETH", lastPrice: 3_212.84, markAgeSec: 4, notionalUsd: 1_204.8 }] }, { id: "trend-07", cohort: "C1", positions: [{ symbol: "ETH", lastPrice: 3_212.84, markAgeSec: 4, notionalUsd: 804.2 }] }], recent: [{ variant: "rsi-03", symbol: "ETH", ts: new Date(now).toISOString(), action: "RH_CLOSE", reason: "CLOSE", pnlUsd: 0, pnlPct: 0, entryPriceUsd: null, exitPriceUsd: null }] },
    laneDex: { updatedAt: new Date(now).toISOString(), movers: [{ symbol: "ETH-ASSET", chain: "eth", token: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", chg24: 0, liqUsd: null, vol24: 0 }], promotions: [{ symbol: "ETH-ASSET", chain: "1", token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", chg24: null, liqUsd: null, vol24: null }] },
    laneOkxPaper: { updatedAt: null, open: [{ id: "one", symbol: "SI", source: "scanner", detectedAt: null, policyVersion: 3 }], recentCloses: [{ ts: new Date(now).toISOString(), symbol: "SI", pnlSol: 0.01, trigger: null }] },
  } as unknown as Partial<StatsResponse>;
  const tokens = terminalTokens(data);
  assert.equal(tokens.filter((item) => item.assetKey === token.assetKey).length, 1);
  assert.equal(tokens.filter((item) => item.symbol === "ETH-ASSET").length, 1);
  const robinhood = tokens.filter((item) => item.symbol === "ETH");
  assert.equal(robinhood.length, 2);
  assert.notEqual(robinhood[0].key, robinhood[1].key);
  assert.equal(filterTokens(tokens, "rsi-03", "all").length, 1);
  assert.equal(filterTokens(tokens, "c1", "positions").length, 1);
  assert.equal(filterTokens(tokens, "ethereum", "market").length, 1);
  const rows = serverPositions(data);
  assert.equal(rows.filter((row) => row.token.assetKey === token.assetKey).length, 1);
  assert.equal(rows[0].entryCostUsd, 250);
  assert.equal(rows[0].pnlUsd, null);
  assert.equal(rows[0].markPriceUsd, null);
  assert.ok(quoteProblem(rows[0].token, rows[0].token.quote, now));
  for (const row of rows.filter((item) => item.token.symbol === "ETH")) {
    assert.equal(row.entryCostUsd, null);
    assert.equal(row.pnlUsd, null);
    assert.equal(row.pnlPct, null);
    assert.equal(row.heldSeconds, null);
    assert.ok(quoteProblem(row.token, row.token.quote, now));
  }
  const trades = serverTrades(data);
  assert.equal(trades.find((row) => row.symbol === "SI")?.pnlUsd, null);
  assert.equal(trades.find((row) => row.symbol === "SI")?.pnlSol, 0.01);
  assert.equal(trades.find((row) => row.symbol === "TEST")?.entryPriceUsd, null);
  assert.equal(serverSignals(data, null)[0].tokenKey, token.assetKey);
  assert.equal(assetIdentity("eth", "0xABC"), assetIdentity("1", "0xabc"));
  assert.notEqual(assetIdentity("solana", contract), assetIdentity("sol", contract.toLowerCase()));
});

test("unavailable numbers stay em dashes and real zero stays zero", () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, "12"]) {
    for (const format of [formatUsd, formatPrice, formatPercent, formatCount, formatQuantity]) assert.equal(format(value), "—");
  }
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatPercent(0), "+0.00%");
  assert.equal(formatSignedUsd(-342.55), "-$342.55");
  assert.equal(formatUsd(1_070_000, true), "$1.07M");
  assert.equal(formatUsd(260_500, true), "$260.5K");
  assert.notEqual(formatQuantity(1e-9), "0");
});

test("local fill gating rejects missing, cached, synthetic, invalid, future, or stale quotes", () => {
  const invalid: Array<QuoteView | null> = [null, { ...quote, kind: "candle-close" }, { ...quote, kind: "synthetic" }, { ...quote, eligible: false }, { ...quote, unitPriceUsd: 0 }, { ...quote, unitPriceUsd: -1 }, { ...quote, unitPriceUsd: NaN }, { ...quote, unitPriceUsd: Infinity }, { ...quote, quotedAt: null }, { ...quote, quotedAt: now + 1 }, { ...quote, quotedAt: now - MAX_QUOTE_AGE_MS - 1 }, { ...quote, source: " " }, { ...quote, tokenKey: "wrong-token" }];
  for (const value of invalid) {
    const ledger = createPaperLedger();
    assert.equal(fillPaperOrder(ledger, token, "buy", "100", value, now).ok, false);
    assert.equal(ledger.cashUsd, 10_000);
    assert.equal(ledger.positions.length, 0);
  }
  assert.equal(quoteProblem(token, quote, now + MAX_QUOTE_AGE_MS), null);
  assert.equal(fillPaperOrder(createPaperLedger(), { ...token, contract: null }, "buy", "100", quote, now).ok, false);
  for (const amount of ["0", "-1", "NaN", "Infinity", "1e3", "1.001", "10001", "", "90071992547409999"]) assert.equal(fillPaperOrder(createPaperLedger(), token, "buy", amount, quote, now).ok, false);
  assert.equal(parsePaperAmount(" 100.25 "), 100.25);
  assert.equal(fillPaperOrder(createPaperLedger(), token, "sell", "1", quote, now).ok, false);
});

test("local buy, averaging, partial and full sells conserve cash and cost basis", () => {
  let ledger = execute(createPaperLedger(), "buy", "100", 2);
  assert.equal(ledger.cashUsd, 9_900);
  assert.equal(ledger.positions[0].quantity, 50);
  ledger = execute(ledger, "buy", "100", 4);
  assert.equal(ledger.positions[0].quantity, 75);
  assert.equal(ledger.positions[0].costBasisUsd, 200);
  assert.equal(fillPaperOrder(ledger, token, "sell", "301", { ...quote, unitPriceUsd: 4 }, now).ok, false);
  ledger = execute(ledger, "sell", "120", 4);
  assert.equal(ledger.positions[0].quantity, 45);
  assert.equal(ledger.positions[0].costBasisUsd, 120);
  assert.equal(ledger.realizedPnlUsd, 40);
  ledger = execute(ledger, "sell", "180", 4);
  assert.equal(ledger.positions.length, 0);
  assert.equal(ledger.cashUsd, 10_100);
  assert.equal(ledger.realizedPnlUsd, 100);
  assert.equal(paperPortfolio(ledger, now).pnlUsd, 100);
  assert.equal(ledger.fills.length, 4);
  assert.ok(restorePaperLedger(JSON.parse(JSON.stringify(ledger))));
  const topUp = addPaperCash(ledger, "1000");
  assert.equal(topUp.ok, true);
  if (topUp.ok) { assert.equal(topUp.ledger.depositedUsd, 11_000); assert.equal(paperPortfolio(topUp.ledger, now).pnlUsd, 100); }
  assert.equal(addPaperCash(ledger, "-1").ok, false);
  assert.equal(addPaperCash(ledger, "90071992547409.91").ok, false);
});

test("last genuine marks persist with stale labels; saved positions cannot authorize fills", () => {
  const bought = execute(createPaperLedger(), "buy", "100", 2);
  const newer = { ...quote, unitPriceUsd: 3, quotedAt: now + 1_000 };
  const marked = updatePaperMarks(bought, [{ ...token, quote: newer }]);
  assert.equal(paperPortfolio(marked, now + 1_000).positions[0].pnlUsd, 50);
  assert.equal(paperPortfolio(marked, now + MAX_QUOTE_AGE_MS + 1_001).equityUsd, 10_050);
  assert.equal(paperPortfolio(marked, now + MAX_QUOTE_AGE_MS + 1_001).stale, true);
  assert.equal(updatePaperMarks(marked, [{ ...token, quote: { ...quote, unitPriceUsd: 100 } }]), marked);
  assert.equal(updatePaperMarks(marked, [{ ...token, quote: { ...newer, kind: "candle-close", quotedAt: now + 2_000 } }]), marked);
  assert.equal(updatePaperMarks(marked, []), marked);
  const saved = localPositionToken(marked.positions[0]);
  assert.ok(quoteProblem(saved, saved.quote, now + 1_000));
  assert.equal(fillPaperOrder(marked, saved, "buy", "10", saved.quote, now + 1_000).ok, false);
  const unmarked = { ...marked, positions: marked.positions.map((position) => ({ ...position, markQuote: null })) };
  assert.equal(paperPortfolio(unmarked, now).equityUsd, null);
  assert.equal(paperPortfolio(unmarked, now).pnlUsd, null);
});

test("corrupt browser storage is rejected instead of becoming virtual money", () => {
  const ledger = execute(createPaperLedger(), "buy", "100", 2);
  for (const value of [null, "ledger", {}, { ...ledger, version: 2 }, { ...ledger, cashUsd: -1 }, { ...ledger, cashUsd: 1e20 }, { ...ledger, cashUsd: ledger.cashUsd + 20 }, { ...ledger, depositedUsd: 0 }, { ...ledger, realizedPnlUsd: Infinity }, { ...ledger, positions: [ledger.positions[0], ledger.positions[0]] }, { ...ledger, positions: [{ ...ledger.positions[0], quantity: -1 }] }, { ...ledger, fills: [{ ...ledger.fills[0], side: "broadcast" }] }]) assert.equal(restorePaperLedger(value), null);
  assert.deepEqual(restorePaperLedger(JSON.parse(JSON.stringify(ledger))), ledger);
});

test("local ticket cannot submit unsupported server marks and shows no invented quantities", () => {
  const props = { id: "check-ticket", token, quote: null, ledger: createPaperLedger(), side: "buy" as const, amount: "100", now, message: null, storageError: null, onSideChange: () => {}, onAmountChange: () => {}, onSubmit: () => {} };
  const html = renderToStaticMarkup(<><LocalPaperTicket {...props} /><PaperSubmit {...props} /></>);
  assert.ok(html.includes("SIMULASI LOKAL · tidak dikirim ke server"));
  assert.ok(html.includes("menunggu quote"));
  assert.match(html, /<button[^>]+disabled=""[^>]*class="terminal-submit/);
  assert.ok(html.includes("— TEST"));
  assert.ok(!/NaN|undefined|Infinity/.test(html));
  const ready = renderToStaticMarkup(<PaperSubmit {...props} quote={quote} />);
  assert.ok(!ready.includes('disabled=""'));
  assert.ok(ready.includes("Buy TEST · lokal"));
});

test("empty terminal panels render with lane access and server/local separation", () => {
  const html = renderToStaticMarkup(<><TerminalWorkspace token={null} quote={null} now={now} onScanner={() => {}} onContext={() => {}} /><ServerLedger tab="positions" onTabChange={() => {}} positions={[]} trades={[]} signals={[]} state="ready" age={0} onSelectToken={() => {}} onSelectLane={() => {}} onRetry={() => {}} signalError={null} /><TokenScanner tokens={[]} selectedKey={null} query="" onQueryChange={() => {}} onPaste={() => {}} tab="tokens" onTabChange={() => {}} filter="all" onFilterChange={() => {}} onSelect={() => {}} onLaneSelect={() => {}} section="overview" data={null} age={null} healthy={false} state="loading" onRetry={() => {}} /><TerminalStatus data={null} equityUsd={10_000} pnlPct={0} localStale={false} status="connecting" age={null} healthy={false} now={now} /></>);
  assert.ok(html.includes("PAPER SERVER"));
  assert.ok(html.includes("Belum ada posisi paper server"));
  for (const lane of ["Robinhood", "GMGN", "DexScreener", "Solana"]) assert.ok(html.includes(`Buka lane ${lane}`));
  assert.ok(html.includes("LOKAL"));
  assert.ok(!/PRATINJAU|DATA CONTOH|Stable|NaN|undefined|Infinity/.test(html));
});

test("chart validation rejects malformed OHLC and keeps chronological unique history", () => {
  const candle = { t: now, o: 1, h: 3, l: 0.5, c: 2, v: 0 };
  const candles = validCandles([candle, { ...candle, t: now - 1_000 }, { ...candle, c: 2.5 }, { ...candle, t: now + 1_000, h: 1 }, { ...candle, t: now + 2_000, v: -1 }, { ...candle, t: now + 3_000, c: NaN }]);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].t, now - 1_000);
  assert.equal(candles[1].c, 2.5);
});
