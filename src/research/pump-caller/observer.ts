/**
 * OBSERVER KONTINU LANE PUMP-CALLER (sprint) — tanpa Developer API di jalur kritis.
 * Discovery: reuse `listenNewTokens` PumpPortal (bebas-kunci). Tape/candle: swap-api publik.
 * Caller sosial: UNAVAILABLE (tidak dikarang); wallet dikenal (opsional, file operator) dilabel
 * KNOWN_WALLET — bukan caller terverifikasi. Semua modul murni lama dipakai di jalur nyata:
 * trackCallerPosition / evaluatePolicies / latencyView / absorptionView / analyze.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { listenNewTokens } from "../../discovery/pumpportal.js";
import { swapApiTrades, swapApiCandles, gmgnKlineCandles, gmgnPartialTape } from "./pumpfun-api.js";
import { onchainTape } from "./onchain-tape.js";
import { normalizeTradeTs } from "./timestamps.js";
import { admit, loadWatchlist, saveWatchlist, policyFromEnv, watchDir, type WatchEntry } from "./watchlist.js";
import { absorptionView } from "./absorption.js";
import { wickContext, evaluatePolicies } from "./wicks.js";
import { latencyView } from "./early-detection.js";
import { analyze, ANALYST_VERSION } from "./analyst.js";
import { trackCallerPosition } from "./position-tracker.js";
import { TRIGGERS, type HypothesisId } from "./experiments.js";
import { append, read, decisionIdFor, reduceOutcomes, markOutcome } from "./journal.js";
import { resolveOutcome, paperForPolicy, completedCandles } from "./results.js";
import { OUTCOME_HORIZONS_MIN, type Candle, type TradeEvent, type EntryPolicy, type PolicyEvaluation } from "./types.js";

const TICK_MS = Math.max(15_000, Number(process.env.PUMP_OBSERVE_TICK_MS ?? 30_000));
const CONCURRENCY = Math.max(1, Number(process.env.PUMP_OBSERVE_CONCURRENCY ?? 4));
const CANDLE_1S_MS = 1_000, CANDLE_1M_MS = 60_000;

// GMGN-proxy ramah: panggilan DISERIALKAN (rantai promise) + cooldown per mint/jenis 60 dtk —
// proxy pace 10s dipakai bersama lane gmgn-full-watch; jangan membanjiri antrenya.
let gmgnChain: Promise<unknown> = Promise.resolve();
function serializedGmgn<T>(fn: () => Promise<T>): Promise<T> {
  const run = gmgnChain.then(fn, fn);
  gmgnChain = run.catch(() => undefined);
  return run as Promise<T>;
}
const gmgnCooldown = new Map<string, number>();
function gmgnAllowed(mint: string, kind: string): boolean {
  const k = `${mint}:${kind}`; const last = gmgnCooldown.get(k) ?? 0;
  if (Date.now() - last < 60_000) return false;
  gmgnCooldown.set(k, Date.now());
  return true;
}

let solUsdCache: { at: number; v: number | null } | null = null;
async function solUsdOf(): Promise<number | null> {
  if (solUsdCache && Date.now() - solUsdCache.at < 60_000) return solUsdCache.v;
  let v: number | null = null;
  try {
    const r = await fetch("https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5_000) });
    const j = (await r.json()) as Record<string, { usdPrice?: number }>;
    v = Object.values(j)[0]?.usdPrice ?? null;
  } catch { v = null; }
  solUsdCache = { at: Date.now(), v };
  return v;
}

// ── Persistensi candle inkremental (§7C) + trades mentah ──
function candlesFile(mint: string): string { return join(watchDir(), `candles-${mint}.jsonl`); }
export function loadCandles(mint: string): { "1s": Candle[]; "1m": Candle[] } {
  const out = { "1s": [] as Candle[], "1m": [] as Candle[] };
  const f = candlesFile(mint);
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line) as { interval?: "1s" | "1m"; candle?: Candle }; if (j.interval && j.candle) out[j.interval].push(j.candle); } catch { /* baris rusak dilewati */ }
  }
  return out;
}
function appendCandles(mint: string, interval: "1s" | "1m", cs: Candle[]): number {
  const seen = new Set(loadCandles(mint)[interval].map((c) => c.ts));
  const fresh = cs.filter((c) => !seen.has(c.ts));
  if (!fresh.length) return 0;
  appendFileSync(candlesFile(mint), fresh.map((c) => JSON.stringify({ interval, candle: c, fetchedAt: Date.now() })).join("\n") + "\n");
  return fresh.length;
}

// ── Wallet dikenal (opsional, operator) — label KNOWN_WALLET, bukan caller terverifikasi ──
interface KnownWallet { address: string; label: string; evidence: string }
function knownWallets(): KnownWallet[] {
  const f = join(watchDir(), "known-wallets.json");
  if (!existsSync(f)) return [];
  try {
    const rows = JSON.parse(readFileSync(f, "utf8")) as KnownWallet[];
    return Array.isArray(rows) ? rows.filter((w) => typeof w.address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.address)) : [];
  } catch { return []; }
}

export interface ObserveSummary { mints: number; newCandles: number; decisions: number; tradesSeen: number; pending: number; observed: number; missingFinal: number; fixtureExcluded: boolean }

let passRunning = false; // (S8-P3) anti-overlap: satu pass pada satu waktu
const PASS_MAX_MS = Math.max(60_000, Number(process.env.PUMP_OBSERVE_PASS_MAX_MS ?? 120_000));

async function gmgnProxyCooldownUntil(): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.GMGN_PROXY_PORT ?? 4319}/health`, { signal: AbortSignal.timeout(2_000) });
    const j = (await r.json()) as { cooldownUntil?: number };
    return Number(j.cooldownUntil ?? 0);
  } catch { return 0; }
}

/** Satu pass observasi atas watchlist (dipakai loop & manual). Tumpang-tindih = ditolak (no-op). */
export async function observePass(fixture = false): Promise<ObserveSummary> {
  if (passRunning) { const s: ObserveSummary = { mints: 0, newCandles: 0, decisions: 0, tradesSeen: 0, pending: 0, observed: 0, missingFinal: 0, fixtureExcluded: fixture }; return s; }
  passRunning = true;
  try { return await observePassInner(fixture); } finally { passRunning = false; }
}

async function observePassInner(fixture: boolean): Promise<ObserveSummary> {
  const passStart = Date.now();
  const gmgnBlockedUntil = await gmgnProxyCooldownUntil(); // koordinasi lintas-lane: hormati cooldown bersama
  const now = Date.now();
  const solUsd = await solUsdOf();
  const wl = (fixture ? [] : loadWatchlist()).slice(0, 64);
  const summary: ObserveSummary = { mints: 0, newCandles: 0, decisions: 0, tradesSeen: 0, pending: 0, observed: 0, missingFinal: 0, fixtureExcluded: fixture };
  for (let i = 0; i < wl.length; i += CONCURRENCY) {
    const batch = wl.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (entry) => {
      const mint = entry.mint;
      if (Date.now() - passStart > PASS_MAX_MS) return; // (S8-P3) durasi pass berbatas
      summary.mints++;
      // ── Tape trades: swap-api UTAMA; fallback GMGN top-traders PARSIAL (berlabel); keduanya
      // gagal → UNAVAILABLE (dicatat, TIDAK diarang). Timestamp invalid ditolak eksplisit. ──
      let trades: TradeEvent[] = []; let tapeSource = "swap-api"; let tapePartial = false; let tapeFull = false;
      // (S8-P4) UTAMA: tape on-chain TERDEKODE (signature+slot+wallet+delta saldo; blockTime nyata).
      if (entry.bondingCurveKey && gmgnAllowed(mint, "onchain")) {
        const decoded = await onchainTape(mint, entry.bondingCurveKey, 10);
        if (decoded && decoded.length) { trades = decoded; tapeSource = "solana-rpc-decoded (signature:owner)"; tapeFull = true; }
      }
      if (!trades.length) {
        const raw = await swapApiTrades(mint, solUsd);
        if (raw) for (const t of raw) {
          const ts = normalizeTradeTs((t as unknown as { tsRaw?: unknown }).tsRaw ?? t.ts);
          if (ts == null) { append({ type: "trade-rejected", ts: now, mint, dedupeKey: t.dedupeKey, reason: "TIMESTAMP_INVALID", source: "swap-api" }); continue; }
          trades.push({ ...t, ts });
        }
        if (trades.length) tapeFull = true;
      }
      if (!trades.length && Date.now() < gmgnBlockedUntil) {
        append({ type: "trade-batch", ts: now, mint, count: 0, source: "UNAVAILABLE (swap-api 403; GMGN proxy cooldown lintas-lane)", usdQuality: "UNAVAILABLE" });
      } else if (!trades.length) {
        const partial = gmgnAllowed(mint, "tape") ? await serializedGmgn(() => gmgnPartialTape(mint)) : null;
        if (partial) { trades = partial.trades; tapeSource = partial.source; tapePartial = true; }
      }
      if (trades.length) {
        summary.tradesSeen += trades.length;
        append({ type: "trade-batch", ts: now, mint, count: trades.length, source: tapeSource, partialTape: tapePartial, solUsd, usdQuality: solUsd != null ? "OK" : "UNAVAILABLE_SOLUSD" });
        for (const t of trades.slice(-120)) append({ type: "trade", ...t, source: tapeSource, observedAt: now });
      } else {
        append({ type: "trade-batch", ts: now, mint, count: 0, source: "UNAVAILABLE (swap-api 403 Cloudflare + GMGN kosong)", usdQuality: "UNAVAILABLE" });
      }
      // ── Candles: swap-api utama; fallback GMGN kline 1m (OHLCV PENUH, berlabel sumber) ──
      const c1s = await swapApiCandles(mint, "1s", 60);
      const c1mSwap = await swapApiCandles(mint, "1m", 60);
      let c1m = c1mSwap; let candleSource = "swap-api";
      if (!c1mSwap || !c1mSwap.length) {
        const g = gmgnAllowed(mint, "kline") ? await serializedGmgn(() => gmgnKlineCandles(mint, 60)) : null;
        if (g) { c1m = g.candles; candleSource = g.source; }
      }
      summary.newCandles += appendCandles(mint, "1s", c1s ?? []) + appendCandles(mint, "1m", c1m ?? []);
      if (c1m?.length && !c1mSwap?.length) append({ type: "candle-source", ts: now, mint, interval: "1m", source: candleSource, count: c1m.length });
      const store = loadCandles(mint);
      // ── Keputusan: SATU keputusan per mint per sesi admisi (idempoten via decisionId mint:admittedAt) ──
      const decidedAlready = read().rows.some((r) => r.type === "shadow-decision" && r.mint === mint && Number(r.admittedAt) === entry.admittedAt);
      if (!decidedAlready && (store["1s"].length >= 4 || store["1m"].length >= 2)) {
        const decidedAt = now;
        const abs = trades.length && !tapePartial ? absorptionView(trades, undefined, null, store["1s"]) : null; // parsial bias → tidak dinilai
        const done1m = completedCandles(store["1m"], CANDLE_1M_MS, decidedAt);
        const done1s = completedCandles(store["1s"], CANDLE_1S_MS, decidedAt);
        const last = done1s[done1s.length - 1] ?? done1m[done1m.length - 1] ?? null;
        const prev = done1s.length > 1 ? done1s[done1s.length - 2]! : undefined;
        const wick = last ? wickContext(last, prev?.low) : null;
        // Wallet dikenal → posisi dari tape (bukti wallet-activity); bukan caller terverifikasi.
        const known = tapeFull ? knownWallets() : []; // (S8-P4) posisi wallet hanya dari tape PENUH — bukan agregat GMGN
        let callerPos: ReturnType<typeof trackCallerPosition> | null = null; let knownWalletHit: KnownWallet | null = null;
        if (known.length && trades.length) {
          const hit = known.find((w) => trades.some((t) => t.wallet === w.address));
          if (hit) {
            knownWalletHit = hit;
            const evts = trades.filter((t) => t.wallet === hit.address)
              .map((t) => ({ dedupeKey: t.dedupeKey, mint, callerId: hit!.address, kind: t.side as "buy" | "sell", sol: t.sol, tokenAmount: null, ts: t.ts }));
            callerPos = trackCallerPosition(hit.address, mint, evts);
          }
        }
        const early = latencyView({ mint, createdAt: entry.admittedAt, callerBuyTs: knownWalletHit ? trades.find((t) => t.wallet === knownWalletHit!.address && t.side === "buy")?.ts ?? null : null, calloutPublishedTs: null, firstObservedByBot: entry.admittedAt, firstExecutableQuoteTs: store["1s"][0]?.ts ?? null, callerFollowersAtBuy: null });
        const policyInput = abs && abs.largeBuys.length ? abs.largeBuys[0]!.ts : decidedAt;
        const evals1s = evaluatePolicies(policyInput, store["1s"], "1s");
        const evals1m = evaluatePolicies(policyInput, store["1m"], "1m");
        const out = analyze({ mint, ts: decidedAt, caller: callerPos, absorption: abs, wick, early: knownWalletHit ? early : null, liquidityUsd: null });
        // Trigger terstruktur (§7F): id hipotesis + bukti pada saat keputusan — bukan teks bebas.
        const triggerIds: Array<{ id: HypothesisId | "KNOWN_WALLET_EARLY_BUY"; fires: boolean; evidence: string }> = [];
        const ctx = { caller: callerPos, absorption: abs, early: knownWalletHit ? early : null };
        for (const t of TRIGGERS) triggerIds.push({ id: t.id, fires: t.trigger(ctx).fires, evidence: t.trigger(ctx).reason });
        triggerIds.push({ id: "KNOWN_WALLET_EARLY_BUY", fires: knownWalletHit != null && (early.detectionLagMs ?? Infinity) <= 5 * 60_000, evidence: knownWalletHit ? `wallet dikenal ${knownWalletHit.label} (${knownWalletHit.evidence}) — PROXY, bukan caller terverifikasi` : "tidak ada wallet dikenal di tape" });
        const decisionId = decisionIdFor(mint, entry.admittedAt, ANALYST_VERSION);
        append({ type: "shadow-decision", ts: decidedAt, mint, decisionId, admittedAt: entry.admittedAt, decision: out.decision, strategyVersion: out.strategyVersion,
          marketSource: `tape=${tapeFull ? (tapeSource.includes("rpc") ? "onchain-decoded" : "swap-api") : tapePartial ? "gmgn-parsial" : "UNAVAILABLE"}; candle=${candleSource}`, socialFields: "UNAVAILABLE (tanpa Developer API)", callerIdentityConfidence: knownWalletHit ? "KNOWN_WALLET_PROXY" : null,
          reasons: out.reasons, contraryEvidence: out.contraryEvidence, missingData: out.missingData,
          paperNotionalUsd: out.paperNotionalUsd, executionCostWarning: out.executionCostWarning,
          priceAtDecision: last?.close ?? null, triggerIds,
          entryPolicies: { "1s": evals1s, "1m": evals1m } as Record<string, Record<EntryPolicy, PolicyEvaluation>>,
          skipReason: out.decision === "SKIP" ? (out.missingData[0] ?? "bukti pasar kurang") : null });
        summary.decisions++;
      }
      entry.lastObservedAt = Date.now(); // (S8-P3) kesegaran watchlist diperbarui saat sukses
    }));
  }
  saveWatchlist(wl.map((e) => ({ ...e, lastObservedAt: loadWatchlist().find((x) => x.mint === e.mint)?.lastObservedAt ?? e.lastObservedAt })));
  // ── Outcome pass global (S8-P1: state = reduceOutcomes; tulis hanya saat transisi) ──
  const states = reduceOutcomes(read().rows);
  const decisions2 = read().rows.filter((r) => r.type === "shadow-decision" && r.marketSource && typeof r.priceAtDecision === "number");
  for (const d of decisions2) {
    const store = loadCandles(String(d.mint));
    for (const h of OUTCOME_HORIZONS_MIN) {
      const key = `outcome:${d.decisionId}:${h}`;
      const cur = states.get(key);
      if (cur && cur.status !== "PENDING") { if (cur.status === "OBSERVED") summary.observed++; else summary.missingFinal++; continue; }
      const targetAt = Number(d.ts) + h * 60_000;
      const res = resolveOutcome({ status: "PENDING", attempts: cur?.attempts ?? 0, targetAt, horizonMin: h,
        candles: store["1m"], intervalMs: CANDLE_1M_MS, asOf: Date.now() });
      const wrote = markOutcome({ decisionId: String(d.decisionId), horizonMin: h, targetAt, checkedAt: Date.now(),
        status: res.status, reason: res.reason ?? undefined,
        priceAtDecision: Number(d.priceAtDecision), priceAtTarget: res.priceAtTarget ?? null,
        changePct: res.priceAtTarget != null ? Number((((res.priceAtTarget - Number(d.priceAtDecision)) / Number(d.priceAtDecision)) * 100).toFixed(4)) : null });
      if (wrote) {
        if (res.status === "OBSERVED") summary.observed++;
        else if (res.status === "MISSING_FINAL") summary.missingFinal++;
        else summary.pending++;
      } else if (cur) summary.pending++;
    }
  }
  return summary;
}

/** Loop kontinu: feed PumpPortal → admission; tick → observePass. Kembalikan stop(). */
export function startObserver(onEvent?: (kind: string, info?: string) => void): () => void {
  const policy = policyFromEnv();
  let seq = 0;
  mkdirSync(watchDir(), { recursive: true });
  const stopFeed = listenNewTokens((c) => {
    seq++;
    const wl = loadWatchlist();
    const res = admit(wl, { mint: c.mint, symbol: c.symbol, source: "pumpportal", priority: Math.round((c.devInitialBuySol ?? 0) * 1000) + Math.round((c.marketCapSol ?? 0) / 10), bondingCurveKey: c.bondingCurveKey }, policy, seq, Date.now());
    saveWatchlist(res.entries);
    if (res.admitted) { append({ type: "token-observed", ts: Date.now(), mint: c.mint, symbol: c.symbol, source: "pumpportal", detectedAt: c.detectedAt, feedLagMs: Date.now() - c.detectedAt }); onEvent?.("admit", `${c.symbol ?? c.mint.slice(0, 6)} (lag ${((Date.now() - c.detectedAt) / 1000).toFixed(1)}s)`); }
  });
  const timer = setInterval(() => { void observePass().then((s) => onEvent?.("tick", `mints=${s.mints} candles+${s.newCandles} keputusan=${s.decisions} outcome: obs=${s.observed} pend=${s.pending} miss=${s.missingFinal}`)).catch((e) => onEvent?.("error", (e as Error).message)); }, TICK_MS);
  onEvent?.("start", `observer kontinu: feed pumpportal, tick ${TICK_MS / 1000}s, kapasitas ${policy.capacity}, sampling 1/${policy.sampleEvery}`);
  return () => { stopFeed(); clearInterval(timer); };
}
