/**
 * OBSERVER KONTINU LANE PUMP-CALLER (sprint) — tanpa Developer API di jalur kritis.
 * Discovery: reuse `listenNewTokens` PumpPortal (bebas-kunci). Tape/candle: swap-api publik.
 * Caller sosial: UNAVAILABLE (tidak dikarang); wallet dikenal (opsional, file operator) dilabel
 * KNOWN_WALLET — bukan caller terverifikasi. Semua modul murni lama dipakai di jalur nyata:
 * trackCallerPosition / evaluatePolicies / latencyView / absorptionView / analyze.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenNewTokens } from "../../discovery/pumpportal.js";
import { swapApiTrades, swapApiCandles, gmgnKlineCandles, gmgnPartialTape } from "./pumpfun-api.js";
import { onchainTapePass, bondingCurvePda, type TapePassResultWithCursor } from "./onchain-tape.js";
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
import { buildH2Event, evaluateConfirmation, eventPolicySet, priceAtTs, reduceH2Events, reduceH2Confirmations, reduceH2Decisions, H2_EVENT_VERSION, type H2Event } from "./h2-events.js";
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
const sigCursors = new Map<string, string | null>(); // (S9-P1) kursor signature per mint
const TAPE_PASS_LIMIT = 12;

// ── (S11.1) Kursor signature TERSISTEN lintas restart — restart tanpa kursor = refetch ≤12
// sig terakhir (duplikat terdedupe, tapi "0 missing" jadi tak bisa dibedakan dari refetch).
const cursorsFile = (): string => join(watchDir(), "sig-cursors.json");
let cursorsLoaded = false;
function loadSigCursors(): void {
  if (cursorsLoaded) return;
  cursorsLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(cursorsFile(), "utf8")) as Record<string, string>;
    for (const [mint, sig] of Object.entries(raw)) if (!sigCursors.has(mint)) sigCursors.set(mint, sig);
  } catch { /* belum ada / rusak → mulai kosong */ }
}
function saveSigCursors(): void {
  const out: Record<string, string> = {};
  for (const [mint, sig] of sigCursors) if (sig) out[mint] = sig;
  try { mkdirSync(watchDir(), { recursive: true }); writeFileSync(cursorsFile(), JSON.stringify(out)); } catch { /* best-effort */ }
}
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

export interface ObserveSummary { mints: number; newCandles: number; decisions: number; tradesSeen: number; pending: number; observed: number; missingFinal: number; fixtureExcluded: boolean; h2EventsNew: number; h2Pending: number; h2Confirmed: number; h2Rejected: number; h2Decisions: number; caretakerMints: number }

let passRunning = false; // (S8-P3) anti-overlap: satu pass pada satu waktu
const PASS_MAX_MS = Math.max(60_000, Number(process.env.PUMP_OBSERVE_PASS_MAX_MS ?? 120_000));

async function gmgnProxyCooldownUntil(): Promise<number> {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.GMGN_PROXY_PORT ?? 4319}/health`, { signal: AbortSignal.timeout(2_000) });
    const j = (await r.json()) as { cooldownUntil?: number };
    return Number(j.cooldownUntil ?? 0);
  } catch { return 0; }
}

/**
 * (H2-P0) Isi `usd` trade on-chain (dekoder menulis null): usd = sol × SOL/USD spot.
 * Tanpa solUsd → dibiarkan null (absorptionView tak menilai; bukan menebak). Mutasi in-place
 * karena trade baru didekode pass ini — belum dipakai siapa pun.
 */
export function enrichOnchainUsd(trades: TradeEvent[], solUsd: number | null): void {
  if (solUsd == null || !(solUsd > 0)) return;
  for (const t of trades) if (t.usd == null && t.sol != null) t.usd = t.sol * solUsd;
}

/** Satu pass observasi atas watchlist (dipakai loop & manual). Tumpang-tindih = ditolak (no-op). */
export async function observePass(fixture = false): Promise<ObserveSummary> {
  if (passRunning) { const s: ObserveSummary = { mints: 0, newCandles: 0, decisions: 0, tradesSeen: 0, pending: 0, observed: 0, missingFinal: 0, fixtureExcluded: fixture, h2EventsNew: 0, h2Pending: 0, h2Confirmed: 0, h2Rejected: 0, h2Decisions: 0, caretakerMints: 0 }; return s; }
  passRunning = true;
  try { return await observePassInner(fixture); } finally { passRunning = false; }
}

async function observePassInner(fixture: boolean): Promise<ObserveSummary> {
  const passStart = Date.now();
  const gmgnBlockedUntil = await gmgnProxyCooldownUntil(); // koordinasi lintas-lane: hormati cooldown bersama
  const now = Date.now();
  const solUsd = await solUsdOf();
  const wl = (fixture ? [] : loadWatchlist()).slice(0, 64);
  // (S11) firstObservedAt IMMUTABLE: dari observasi PERTAMA trade di jurnal (read() dedupe
  // mempertahankan baris pertama = observedAt paling awal) — enrichment USD tak menggesernya.
  const firstSeen = new Map<string, number>();
  for (const r of read().rows) if (r.type === "trade" && typeof r.observedAt === "number") {
    const k = String(r.dedupeKey); const v = Number(r.observedAt);
    if (!firstSeen.has(k) || v < firstSeen.get(k)!) firstSeen.set(k, v);
  }
  const summary: ObserveSummary = { mints: 0, newCandles: 0, decisions: 0, tradesSeen: 0, pending: 0, observed: 0, missingFinal: 0, fixtureExcluded: fixture, h2EventsNew: 0, h2Pending: 0, h2Confirmed: 0, h2Rejected: 0, h2Decisions: 0, caretakerMints: 0 };
  for (let i = 0; i < wl.length; i += CONCURRENCY) {
    const batch = wl.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (entry) => {
      const mint = entry.mint;
      if (Date.now() - passStart > PASS_MAX_MS) return; // (S8-P3) durasi pass berbatas
      summary.mints++;
      // ── Tape trades: swap-api UTAMA; fallback GMGN top-traders PARSIAL (berlabel); keduanya
      // gagal → UNAVAILABLE (dicatat, TIDAK diarang). Timestamp invalid ditolak eksplisit. ──
      let trades: TradeEvent[] = []; let tapeSource = "swap-api"; let tapePartial = false; let tapeFull = false;
      // (S9-P0) UTAMA: tape on-chain TERVALIDASI (kursor inkremental + coverage + state per trade).
      if (entry.bondingCurveKey && gmgnAllowed(mint, "onchain")) {
        loadSigCursors();
        const pass: TapePassResultWithCursor | null = await onchainTapePass(mint, entry.bondingCurveKey, sigCursors.get(mint) ?? null, TAPE_PASS_LIMIT);
        if (pass) {
          sigCursors.set(mint, pass.topSig ?? sigCursors.get(mint) ?? null);
          saveSigCursors();
          // (S11.1) backlogPossible: pass mengembalikan sebanyak limit → BISA JADI ada tx lagi
          // yang belum terambil; "missing=0" bukan bukti cakupan penuh.
          append({ type: "tape-coverage", ts: Date.now(), mint, ...pass.coverage, limit: TAPE_PASS_LIMIT, backlogPossible: pass.coverage.encountered >= TAPE_PASS_LIMIT, source: "solana-rpc" });
          // (H2-P0) USD utk ambang beku $500/$5–$100: usd = sol × SOL/USD spot (Jupiter, cache 60s).
          // Derivasi TERLABELI via usdQuality di trade-batch; usd tetap null bila solUsd null →
          // absorptionView tak menilai (bukan menebak). Sisi pool ikut terisi (hanya bukti arah).
          enrichOnchainUsd(pass.trades, solUsd);
          // (S10-P0) hanya sisi TRADER (bukan vault pool) jadi trade riset; sisi pool tercatat
          // dgn poolSide=true sebagai bukti arah — TIDAK dihitung dua kali.
          const valid = pass.trades.filter((t) => t.state === "VERIFIED_SWAP" && !(t as { poolSide?: boolean }).poolSide);
          for (const t of pass.trades) append({ type: "trade", ...t, source: "solana-rpc", observedAt: Date.now() }); // UNVERIFIED + poolSide ikut tersimpan dgn label
          if (valid.length) { trades = valid; tapeSource = `solana-rpc-validated trader-side (${valid.length}; pool-side terpisah)`; tapeFull = true; }
          // (S11-P0) EVENT-DRIVEN H2: setiap large-buy → SATU event riset (id kanonik, dedupe
          // jurnal; klasifikasi deteksi v2; hanya REALTIME yang nanti jadi keputusan prospektif).
          for (const t of valid) {
            const ev = buildH2Event(t, { admittedAt: entry.admittedAt, now: Date.now(), priorFirstObservedAt: firstSeen.get(t.dedupeKey) ?? null });
            if (ev) { append({ type: "h2-event", ts: Date.now(), ...ev, discoveryCohort: entry.source }); summary.h2EventsNew++; }
          }
        }
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
      // (S9) gate keputusan memakai candle SELESAI saja — keputusan tanpa harga keputusan valid
      // (priceAtDecision null) lahir dari gate lama yang menghitung candle in-progress.
      const doneNow1s = completedCandles(store["1s"], 1_000, Date.now());
      const doneNow1m = completedCandles(store["1m"], CANDLE_1M_MS, Date.now());
      if (!decidedAlready && (doneNow1s.length >= 4 || doneNow1m.length >= 2)) {
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
  // ── (S11-P0) H2 evaluation pass: konfirmasi per-event → keputusan prospektif (REALTIME saja) ──
  await h2EvaluationPass(now, solUsd, wl, summary);
  // ── Outcome pass global (S8-P1: state = reduceOutcomes; tulis hanya saat transisi) ──
  // (S11) h2-decision ikut jalur outcome yang SAMA (anti-premature & toleransi identik).
  const states = reduceOutcomes(read().rows);
  // (S9) keputusan dgn priceAtDecision null (belum ada candle selesai saat memutuskan) tetap
  // dievaluasi: harga keputusan di-BACKFILL hanya dari candle yang SELESAI <= ts keputusan
  // (tanpa look-ahead); bila tak ada pun, tetap PENDING — tidak diarang.
  const decisions2 = read().rows.filter((r) => (r.type === "shadow-decision" || r.type === "h2-decision") && r.marketSource);
  for (const d of decisions2) {
    const store = loadCandles(String(d.mint));
    if (typeof d.priceAtDecision !== "number" || !(d.priceAtDecision as number > 0)) {
      const done = completedCandles(store["1m"], CANDLE_1M_MS, Number(d.ts));
      const atDecision = [...done].reverse().find((c) => c.ts + CANDLE_1M_MS <= Number(d.ts));
      if (atDecision) { d.priceAtDecision = atDecision.close; append({ type: "decision-price-backfill", ts: Date.now(), decisionId: d.decisionId, priceAtDecision: atDecision.close, candleTs: atDecision.ts, note: "close candle selesai <= ts keputusan (no look-ahead)" }); }
      else continue;
    }
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

/**
 * (S11-P0) Evaluasi H2 per-event: konfirmasi ber-window (PENDING→CONFIRMED/REJECTED) lalu
 * keputusan riset ber-timestamp BARU — HANYA utk kelas REALTIME (registrasi v2); PRE_ADMISSION/
 * BACKFILL tetap historis. Keputusan membawa paper-policy per event + outcome dijalankan oleh
 * outcome pass global (jalur sama dgn shadow-decision). Idempoten lintas restart via jurnal.
 */
async function h2EvaluationPass(now: number, solUsd: number | null, wl: WatchEntry[], summary: ObserveSummary): Promise<void> {
  const j = read();
  const events = reduceH2Events(j.rows);
  const confs = reduceH2Confirmations(j.rows);
  const decided = reduceH2Decisions(j.rows);
  const watched = new Set(wl.map((e) => e.mint));
  // Trade VERIFIED per mint dari jurnal (dedupe read() = observasi pertama; USD dari enrichment
  // terbaru bila ada — baris pra-patch ber-usd null dihitung UNKNOWN di window). Sisi POOL
  // dipisah: (S11.1) bukti cakupan window, BUKAN trade riset.
  const tradesByMint = new Map<string, TradeEvent[]>();
  const poolTradesByMint = new Map<string, TradeEvent[]>();
  for (const r of j.rows) {
    if (r.type !== "trade" || r.state !== "VERIFIED_SWAP") continue;
    const t: TradeEvent = { dedupeKey: String(r.dedupeKey), mint: String(r.mint), wallet: r.wallet ? String(r.wallet) : undefined,
      side: r.side === "sell" ? "sell" : "buy", sol: Number(r.sol ?? 0), usd: r.usd == null ? null : Number(r.usd), ts: Number(r.ts ?? 0) };
    if (r.poolSide === true) { const a = poolTradesByMint.get(t.mint); if (a) a.push(t); else poolTradesByMint.set(t.mint, [t]); continue; }
    const arr = tradesByMint.get(t.mint);
    if (arr) arr.push(t); else tradesByMint.set(t.mint, [t]);
  }
  for (const ev of events.values()) {
    const conf = evaluateConfirmation(ev, tradesByMint.get(ev.mint) ?? [], now, poolTradesByMint.get(ev.mint) ?? []);
    const prev = confs.get(ev.h2EventId);
    if (!prev || prev.state !== conf.state || prev.confirmationVersion !== conf.confirmationVersion) append({ type: "h2-confirmation", ts: now, ...conf });
    if (conf.state === "PENDING") { summary.h2Pending++; continue; }
    if (conf.state === "UNKNOWN") { summary.h2Pending++; continue; } // (S11.1) UNKNOWN ≠ konfirmasi; bukan keputusan
    if (conf.state === "CONFIRMED") summary.h2Confirmed++; else summary.h2Rejected++;
    if (ev.detectionClass !== "REALTIME") continue; // registrasi v2: hanya REALTIME prospektif
    const decisionId = `h2:${ev.h2EventId}:${H2_EVENT_VERSION}`;
    if (decided.has(decisionId)) continue;
    const store = loadCandles(ev.mint);
    const decisionTs = conf.asOf; // keputusan PADA SAAT konfirmasi selesai — no look-ahead
    const priceAtDecision = priceAtTs(decisionTs, store["1s"], store["1m"]);
    append({ type: "h2-decision", ts: decisionTs, mint: ev.mint, decisionId, h2EventId: ev.h2EventId,
      hypothesisVersion: H2_EVENT_VERSION, detectionClass: ev.detectionClass, confirmation: conf,
      canonicalIdQuality: ev.canonicalIdQuality, ixIndex: ev.ixIndex, usd: ev.usd, usdQuality: ev.usdQuality, sol: ev.sol,
      firstObservedAt: ev.firstObservedAt, eventTs: ev.eventTs, eligibleAt: ev.eligibleAt,
      observationLatencyMs: ev.observationLatencyMs, priceAtDecision,
      marketSource: `onchain-decoded; solUsd=${solUsd != null ? "OK" : "UNAVAILABLE"}`,
      decision: conf.state === "CONFIRMED" ? "H2_CONFIRMED" : "H2_REJECTED",
      triggerIds: [{ id: "LARGE_BUY_SMALL_SELL_ABSORPTION", fires: conf.state === "CONFIRMED", evidence: conf.reason }],
      // (S11.1) DUA kelompok policy — dilaporkan terpisah, tidak dicampur:
      //  counterfactual: diukur dari eventTs (hipotesis awal; BUKAN actionable)
      //  actionable: hanya setelah keputusan konfirmasi (triggerTs ≥ decisionTs by construction)
      entryPoliciesFromEvent: eventPolicySet(ev.eventTs, store["1s"], store["1m"], now),
      entryPoliciesFromDecision: eventPolicySet(decisionTs, store["1s"], store["1m"], now),
      note: "keputusan riset PER-EVENT (S11) — terpisah dari keputusan admisi token" });
    summary.h2Decisions++;
  }
  // ── (S11-P1) Caretaker lintas TTL: outcome PENDING utk mint yang sudah di-evict watchlist
  // tetap dikejar via kline GMGN (berbatas 4 mint/pass, serialized + cooldown — kuota hormat).
  const mintOfDecision = new Map<string, string>();
  for (const r of j.rows) if ((r.type === "shadow-decision" || r.type === "h2-decision") && r.mint) mintOfDecision.set(String(r.decisionId), String(r.mint));
  const pendingMints = new Set<string>();
  for (const s of reduceOutcomes(j.rows).values()) {
    if (s.status !== "PENDING") continue;
    const id = s.key.split(":").slice(1, -1).join(":"); // key = outcome:<decisionId>:<horizon>
    const mint = mintOfDecision.get(id);
    if (mint && !watched.has(mint)) pendingMints.add(mint);
  }
  let n = 0;
  for (const mint of pendingMints) {
    if (n >= 4) break;
    if (!gmgnAllowed(mint, "kline-caretaker")) continue;
    const g = await serializedGmgn(() => gmgnKlineCandles(mint, 240)).catch(() => null);
    if (g?.candles?.length) { summary.newCandles += appendCandles(mint, "1m", g.candles); summary.caretakerMints++; n++; }
  }
}

/**
 * (S11.1) DISCOVERY FALLBACK BERBATAS — saat feed PumpPortal tidak sehat, admisi kandidat
 * baru tetap berjalan dari sumber GMGN yang SUDAH diotorisasi (getTrendingSwaps via proxy
 * bersama, DISERIALKAN + berbatas). Kohor tetap "gmgn-trending" — TIDAK disamakan dengan
 * discovery launch real-time PumpPortal (dilabel discoveredBy berbeda; laporan memisahkan).
 */
const FALLBACK_AFTER_MS = 180_000; // feed dianggap turun setelah segini tanpa tanda hidup
const FALLBACK_EVERY_MS = 300_000; // maks 1 upaya / 5 menit — jangan banjiri proxy bersama
const FALLBACK_MAX_AGE_MIN = 30;
let lastFallbackAt = 0;
const fallbackTried = new Set<string>();

async function boundedDiscovery(wl: WatchEntry[], policy: ReturnType<typeof policyFromEnv>, onEvent?: (kind: string, info?: string) => void): Promise<number> {
  if (Date.now() - lastFallbackAt < FALLBACK_EVERY_MS) return 0;
  lastFallbackAt = Date.now();
  const { gmgnTrendingSol } = await import("../../discovery/gmgn.js");
  const rows = await serializedGmgn(() => gmgnTrendingSol("5m", { limit: 20 })).catch(() => null);
  if (!rows?.length) return 0;
  const watched = new Set(wl.map((e) => e.mint));
  const now = Date.now();
  const fresh = rows
    .filter((r) => String(r.address ?? "").endsWith("pump") && !watched.has(r.address) && !fallbackTried.has(r.address))
    .map((r) => ({ r, ageMin: (now - (r.creation_timestamp ?? 0) * 1000) / 60_000 }))
    .filter((o) => o.ageMin > 0 && o.ageMin <= FALLBACK_MAX_AGE_MIN)
    .sort((a, b) => b.r.volume - a.r.volume)
    .slice(0, 2);
  let entries = wl, admitted = 0;
  for (const { r } of fresh) {
    fallbackTried.add(r.address);
    const res = admit(entries, { mint: r.address, symbol: r.symbol, source: "gmgn-trending", priority: 100, bondingCurveKey: bondingCurvePda(r.address) }, policy, 0, now);
    entries = res.entries;
    if (res.admitted) {
      admitted++;
      append({ type: "token-observed", ts: now, mint: r.address, symbol: r.symbol, source: "gmgn-trending", discoveredBy: "gmgn-trending-fallback (pumpportal tidak sehat)", ageMinAtDiscovery: Number(((now - (r.creation_timestamp ?? 0) * 1000) / 60_000).toFixed(1)), detectedAt: now });
      onEvent?.("fallback-admit", `${r.symbol ?? r.address.slice(0, 6)} (umur ${((now - (r.creation_timestamp ?? 0) * 1000) / 60_000).toFixed(0)}m — kohor trending, BUKAN launch real-time)`);
    }
  }
  if (admitted) saveWatchlist(entries);
  return admitted;
}

/** Loop kontinu: feed PumpPortal → admission; tick → observePass. Kembalikan stop(). */
export function startObserver(onEvent?: (kind: string, info?: string) => void): () => void {
  const policy = policyFromEnv();
  let seq = 0;
  mkdirSync(watchDir(), { recursive: true });
  // (S11-P1) Kesehatan feed diekspos eksplisit (jurnal feed-health saat BERUBAH + log operator).
  let lastFeedState = "";
  let lastFeedOkAt = Date.now(); // (S11.1) tanda hidup terakhir — dasar keputusan fallback
  const feedHealth = (kind: string, detail?: string): void => {
    if (kind === "open") lastFeedOkAt = Date.now();
    const st = `${kind}`;
    if (st === lastFeedState) return;
    lastFeedState = st;
    append({ type: "feed-health", ts: Date.now(), feed: "pumpportal", state: kind, detail: detail ?? null });
    onEvent?.(kind === "open" ? "feed-open" : `feed-${kind}`, detail ?? "");
  };
  const stopFeed = listenNewTokens((c) => {
    seq++;
    lastFeedOkAt = Date.now(); // kandidat masuk = feed hidup
    const wl = loadWatchlist();
    const res = admit(wl, { mint: c.mint, symbol: c.symbol, source: "pumpportal", priority: Math.round((c.devInitialBuySol ?? 0) * 1000) + Math.round((c.marketCapSol ?? 0) / 10), bondingCurveKey: c.bondingCurveKey }, policy, seq, Date.now());
    saveWatchlist(res.entries);
    if (res.admitted) { append({ type: "token-observed", ts: Date.now(), mint: c.mint, symbol: c.symbol, source: "pumpportal", discoveredBy: "realtime-launch-feed", detectedAt: c.detectedAt, feedLagMs: Date.now() - c.detectedAt }); onEvent?.("admit", `${c.symbol ?? c.mint.slice(0, 6)} (lag ${((Date.now() - c.detectedAt) / 1000).toFixed(1)}s)`); }
  }, (e) => feedHealth(e.kind, e.detail));
  const timer = setInterval(() => {
    void (async () => {
      const s = await observePass();
      onEvent?.("tick", `mints=${s.mints} candles+${s.newCandles} keputusan=${s.decisions} outcome: obs=${s.observed} pend=${s.pending} miss=${s.missingFinal} | H2: event+${s.h2EventsNew} pend=${s.h2Pending} konf=${s.h2Confirmed}/${s.h2Confirmed + s.h2Rejected} keputusan=${s.h2Decisions} caretaker=${s.caretakerMints}`);
      // (S11.1) discovery fallback berbatas hanya saat feed tidak sehat; kohor tetap terpisah.
      if (Date.now() - lastFeedOkAt > FALLBACK_AFTER_MS) {
        const wlNow = loadWatchlist();
        const n = await boundedDiscovery(wlNow, policy, onEvent).catch(() => 0);
        if (n > 0) onEvent?.("fallback", `${n} kandidat GMGN trending di-admit (feed pumpportal turun)`);
      }
    })().catch((e) => onEvent?.("error", (e as Error).message));
  }, TICK_MS);
  onEvent?.("start", `observer kontinu: feed pumpportal, tick ${TICK_MS / 1000}s, kapasitas ${policy.capacity}, sampling 1/${policy.sampleEvery}`);
  return () => { stopFeed(); clearInterval(timer); };
}
