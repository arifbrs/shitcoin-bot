/**
 * H2 EVENT-DRIVEN (S11) — satu EVENT RISET per large-buy, bukan satu keputusan per token.
 *
 * REGISTRASI H2-EVENT-V2 (prospektif sejak S11 — ambang beku TIDAK diubah: large-buy
 * $500/$1000, small-sell $5–$100 dari DEFAULT_ABSORPTION):
 *   - Klasifikasi deteksi (BARU, bagian registrasi v2):
 *       PRE_ADMISSION : eventTs < admittedAt — historis saja, TIDAK boleh jadi keputusan
 *                       prospektif; ATRIBUSI (dev/bundler) TIDAK DIKONFIRMASI tanpa bukti
 *                       pendanaan wallet — dilabel launch-associated/unattributed.
 *       BACKFILL      : eventTs ≥ admittedAt tapi terdeteksi telat (> REALTIME_WINDOW_MS).
 *       REALTIME      : terdeteksi dalam window — SATU-satunya kelas yang boleh mendukung
 *                       keputusan prospektif + outcome.
 *   - Window konfirmasi per-event = komponen beku absorption.ts diterapkan pada event ini:
 *       pengikut ≥2 wallet beda dlm 30s; rapid-sell ≥70% nilai oleh wallet sama dlm 60s;
 *       net-flow SOL 60s > 0. Window belum selesai → PENDING (bukan kepastian palsu).
 *   - firstObservedAt IMMUTABLE (dari observasi pertama di jurnal; enrichment USD tidak
 *     boleh menggeser waktu terlihat pertama).
 *   - Keputusan riset baru (h2-decision) hanya setelah konfirmasi selesai, pada saat itu
 *     juga (no look-ahead); outcome dihitung dari harga keputusan candle-selesai.
 */
import type { TradeEvent, Candle, EntryPolicy, PolicyEvaluation } from "./types.js";
import { DEFAULT_ABSORPTION } from "./types.js";
import { completedCandles } from "./results.js";
import { evaluatePolicies } from "./wicks.js";
import type { WindowCoverage } from "./coverage.js";

export const H2_EVENT_VERSION = "h2-event-v2";
/**
 * (S11.1) Versi konfirmasi: v2 membedakan WINDOW_ELAPSED vs DATA_COMPLETE — waktu dinding
 * berlalu TIDAK membuktikan tape window tercakup. Penilaian ulang event lama dicatat sbg
 * baris konfirmasi BERVERSI BARU (jurnal append-only — riwayat asli tak tertimpa).
 */
export const CONFIRMATION_VERSION = "h2-conf-v3";
// v3: DATA_COMPLETE = bukti akuisisi RPC (assessWindowCoverage), bukan inferensi "ada ≥1 swap";
// hanya DATA_COMPLETE yang menopang penolakan definitif "pengikut < 2" / konfirmasi.
/** Window deteksi real-time (registrasi v2): 90 dtk ≈ 2–3 tick observer (35s). */
export const REALTIME_WINDOW_MS = 90_000;
/** Window konfirmasi per-event: rapid-sell 60s (pengikut 30s berada di dalamnya). */
export const CONFIRM_WINDOW_MS = 60_000;
const FOLLOW_WINDOW_MS = 30_000;
const RAPID_SELL_RATIO = 0.7;

export type DetectionClass = "PRE_ADMISSION" | "BACKFILL" | "REALTIME";

export interface H2Event {
  h2EventId: string; // kanonik = signature:trader — STABIL lintas pass/restart
  mint: string;
  signature: string;
  ixIndex: number | null; // where available (jsonParsed tak mem-parse IDL pump → sering null)
  canonicalIdQuality: "SIG_IX_TRADER" | "SIG_TRADER";
  wallet: string;
  sol: number; // notional swap (SOL) dari decoder — label sol_incl_fees_rent milik decoder
  usd: number;
  usdQuality: "APPROX_SOL_SPOT" | "OK"; // APPROX = sol × SOL/USD spot (Jupiter), bukan harga swap-waktu
  eventTs: number;
  firstObservedAt: number; // IMMUTABLE
  eligibleAt: number | null; // REALTIME: firstObservedAt (bila bot bisa bertindak); lainnya null
  observationLatencyMs: number | null;
  detectionClass: DetectionClass;
  admittedAt: number;
  hypothesisVersion: string;
  note: string;
}

export interface H2Confirmation {
  h2EventId: string;
  state: "PENDING" | "CONFIRMED" | "REJECTED" | "UNKNOWN";
  asOf: number;
  eventTs: number;
  flowWindow: { startTs: number; endTs: number; complete: boolean; netFlowSol: number | null };
  followers: { windowMs: number; distinctWallets: number | null; complete: boolean };
  rapidSell: { ratio: number | null; unknownUsdSells: number; state: "NO" | "YES" | "UNKNOWN" | "PENDING" };
  smallSellsInWindow: number; // $5–$100 (ambang beku); USD null tidak dihitung (lihat unknown)
  smallSellsUnknown: number; // (S11.1) trade dlm window tanpa USD — tidak dihitung sbg 0
  // (S11.1) DATA_COMPLETE ≠ WINDOW_ELAPSED: bukti swap terverifikasi (sisi trader ATAU pool)
  // di DALAM window menetapkan tape window benar-benar tercakup; tanpa itu, "0 pengikut"
  // TIDAK boleh dibaca sbg nol pembeli (bisa jadi celah tape).
  dataComplete: boolean;
  verifiedTradesInWindow: number;
  poolSideInWindow: number;
  // (S11.2) status cakupan EKSPLISIT dari rekaman akuisisi RPC — bukan inferensi:
  coverage: { state: WindowCoverage; reason: string };
  confirmationVersion: string;
  reason: string;
}

export function canonicalSwapId(signature: string, wallet: string): string {
  return `${signature || "sig?"}:${wallet || "wallet?"}`;
}

/** Klasifikasi deteksi v2 — murni. PRE_ADMISSION memakai eventTs; BACKFILL/REALTIME memakai latensi. */
export function classifyDetection(eventTs: number, admittedAt: number, firstObservedAt: number): { cls: DetectionClass; latencyMs: number } {
  const latencyMs = Math.max(0, firstObservedAt - eventTs);
  if (eventTs < admittedAt) return { cls: "PRE_ADMISSION", latencyMs };
  return { cls: latencyMs <= REALTIME_WINDOW_MS ? "REALTIME" : "BACKFILL", latencyMs };
}

/**
 * Bangun event dari SATU trade large-buy. firstObservedAt = MIN(observasi jurnal sebelumnya, sekarang)
 * — immutabel lintas restart. `priorFirstObservedAt` dibaca dari jurnal (baris trade pertama per
 * dedupeKey). Bukan large-buy → null (bukan event).
 */
export function buildH2Event(
  trade: TradeEvent & { signature?: string; ixIndex?: number | null; poolSide?: boolean; state?: string },
  ctx: { admittedAt: number; now: number; priorFirstObservedAt?: number | null; usdQuality?: H2Event["usdQuality"] },
): H2Event | null {
  const usd = trade.usd;
  const minLargeUsd = DEFAULT_ABSORPTION.largeBuyUsd[0] ?? 500;
  if (trade.side !== "buy" || usd == null || !(usd >= minLargeUsd)) return null;
  if (trade.poolSide) return null; // sisi pool bukan trader
  const signature = String(trade.signature ?? trade.dedupeKey.split(":")[0] ?? "");
  const firstObservedAt = Math.min(ctx.priorFirstObservedAt ?? ctx.now, ctx.now);
  const { cls, latencyMs } = classifyDetection(trade.ts, ctx.admittedAt, firstObservedAt);
  const ixIndex = trade.ixIndex ?? null;
  return {
    h2EventId: canonicalSwapId(signature, trade.wallet ?? ""),
    mint: trade.mint, signature, ixIndex,
    canonicalIdQuality: ixIndex != null ? "SIG_IX_TRADER" : "SIG_TRADER",
    wallet: trade.wallet ?? "",
    sol: trade.sol, usd,
    usdQuality: ctx.usdQuality ?? "APPROX_SOL_SPOT",
    eventTs: trade.ts, firstObservedAt,
    eligibleAt: cls === "REALTIME" ? firstObservedAt : null,
    observationLatencyMs: latencyMs,
    detectionClass: cls, admittedAt: ctx.admittedAt,
    hypothesisVersion: H2_EVENT_VERSION,
    note: cls === "PRE_ADMISSION"
      ? "large-buy PRA-ADMISI — analisis historis saja; atribusi dev/bundler TIDAK dikonfirmasi (tanpa bukti pendanaan wallet)"
      : cls === "BACKFILL"
        ? "post-admisi tapi terdeteksi lewat backfill — historis, bukan peluang real-time"
        : "terdeteksi real-time dalam window registrasi v2 — memenuhi syarat keputusan prospektif",
  };
}

/** Semua trade window utk satu event (trader-side VERIFIED; sumber = jurnal, dedupe dedupeKey). */
function windowTrades(trades: TradeEvent[], eventTs: number, endTs: number): TradeEvent[] {
  return trades.filter((t) => t.ts > eventTs && t.ts <= endTs);
}

/**
 * Konfirmasi H2 per-event (S11.1): WINDOW_ELAPSED ≠ DATA_COMPLETE.
 *   - Data lengkap = ada bukti swap terverifikasi (sisi trader ATAU pool) DI DALAM window —
 *     sisi pool direkam utk SETIAP swap, jadi kehadirannya menetapkan tape window tercakup.
 *   - Tanpa itu: PENDING (retry — tape bisa datang belakangan), "0 pengikut" tidak dibaca
 *     sbg nol pembeli.
 *   - rapid-sell UNKNOWN TIDAK mengonfirmasi → state UNKNOWN (bukan CONFIRMED).
 *   - `poolTrades` = swap sisi pool terverifikasi utk mint (bukti cakupan, bukan trade riset).
 */
export function evaluateConfirmation(
  event: H2Event, trades: TradeEvent[], asOf: number, poolTrades: TradeEvent[] = [],
  coverage: { state: WindowCoverage; reason: string } = { state: "COVERAGE_UNKNOWN", reason: "penilaian cakupan tidak diberikan" },
): H2Confirmation {
  const t0 = event.eventTs, endTs = t0 + CONFIRM_WINDOW_MS;
  const flowComplete = asOf >= endTs;
  const w = windowTrades(trades, t0, endTs);
  const poolW = poolTrades.filter((t) => t.ts > t0 && t.ts <= endTs);
  const verifiedTradesInWindow = w.length, poolSideInWindow = poolW.length;
  // (S11.2) DATA_COMPLETE kini DARI BUKTI AKUISISI (param coverage) — bukan dari kehadiran swap.
  const dataComplete = coverage.state === "DATA_COMPLETE";
  const buys = w.filter((t) => t.side === "buy"), sells = w.filter((t) => t.side === "sell");
  const netFlowSol = flowComplete
    ? Number((buys.reduce((s, x) => s + x.sol, 0) - sells.reduce((s, x) => s + x.sol, 0)).toFixed(6))
    : null;
  const followersComplete = asOf >= t0 + FOLLOW_WINDOW_MS;
  const followers = buys.filter((b) => b.wallet && b.wallet !== event.wallet && b.ts <= t0 + FOLLOW_WINDOW_MS);
  // (S11.1) tanpa cakupan data: distinctWallets tetap null — TIDAK dihitung sbg 0 pembeli.
  const distinctWallets = followersComplete && dataComplete ? new Set(followers.map((f) => f.wallet)).size : null;
  const rapid = sells.filter((s) => s.wallet === event.wallet);
  const rapidKnownUsd = rapid.reduce((s, x) => s + (x.usd ?? 0), 0);
  const unknownUsdSells = rapid.filter((x) => x.usd == null).length;
  const rapidState: H2Confirmation["rapidSell"]["state"] = !flowComplete ? "PENDING"
    : rapidKnownUsd >= event.usd * RAPID_SELL_RATIO ? "YES"
      : unknownUsdSells > 0 ? "UNKNOWN" : "NO";
  const smallSellsInWindow = sells.filter((s) => s.usd != null && s.usd >= DEFAULT_ABSORPTION.smallSellUsdMin && s.usd <= DEFAULT_ABSORPTION.smallSellUsdMax).length;
  const smallSellsUnknown = sells.filter((s) => s.usd == null).length;
  let state: H2Confirmation["state"], reason: string;
  if (!flowComplete || coverage.state === "WINDOW_NOT_MATURED") { state = "PENDING"; reason = `WINDOW_NOT_MATURED (${Math.max(0, endTs - asOf)}ms tersisa)`; }
  else if (coverage.state === "COVERAGE_UNKNOWN") { state = "UNKNOWN"; reason = `COVERAGE_UNKNOWN — ${coverage.reason}; tidak ada penilaian definitif`; }
  else if (coverage.state === "DATA_INCOMPLETE") { state = "PENDING"; reason = `DATA_INCOMPLETE — ${coverage.reason}; "0 pengikut" tidak disimpulkan`; }
  else if (rapidState === "YES") { state = "REJECTED"; reason = `rapid-sell ≥70% (ratio ${rapids(rapidKnownUsd, event.usd)}) oleh wallet pembeli — bukan absorpsi`; }
  else if (distinctWallets == null) { state = "PENDING"; reason = "WINDOW_PENGIKUT_BELUM_LENGKAP"; }
  else if (distinctWallets < 2) { state = "REJECTED"; reason = `pengikut ${distinctWallets}/2 wallet independen dlm 30s (window DATA_COMPLETE dari bukti akuisisi)`; }
  else if (netFlowSol == null || netFlowSol <= 0) { state = "REJECTED"; reason = `net-flow ${netFlowSol ?? "?"} SOL ≤ 0 dlm 60s (berbasis SOL — robust thd USD null)`; }
  else if (rapidState === "UNKNOWN") { state = "UNKNOWN"; reason = `rapid-sell tak terverifikasi (${unknownUsdSells} jual tanpa USD) — TIDAK BOLEH mengonfirmasi`; }
  else { state = "CONFIRMED"; reason = `pengikut ${distinctWallets} wallet, rapid-sell NO, net-flow +${netFlowSol} SOL, small-sell ${smallSellsInWindow}${smallSellsUnknown ? ` (+${smallSellsUnknown} tanpa USD)` : ""}`; }
  return { h2EventId: event.h2EventId, state, asOf, eventTs: t0,
    flowWindow: { startTs: t0, endTs, complete: flowComplete, netFlowSol },
    followers: { windowMs: FOLLOW_WINDOW_MS, distinctWallets, complete: followersComplete },
    rapidSell: { ratio: flowComplete ? Number((rapidKnownUsd / (event.usd || 1)).toFixed(4)) : null, unknownUsdSells, state: rapidState },
    smallSellsInWindow, smallSellsUnknown, dataComplete, verifiedTradesInWindow, poolSideInWindow,
    coverage, confirmationVersion: CONFIRMATION_VERSION, reason };
}
const rapids = (usd: number, ref: number): string => `${((usd / (ref || 1)) * 100).toFixed(0)}%`;

// ── Paper per-event (no look-ahead; ketersediaan 1s eksplisit) ──────────────
export type PolicyAvailability = "OK" | "UNAVAILABLE_1S" | "PENDING_HORIZON" | "PENDING_CANDLES";
export interface EventPolicyEval { policy: EntryPolicy; interval: "1s" | "1m"; availability: PolicyAvailability; evaluation: PolicyEvaluation }

/** Ketersediaan candle 1s: sumber tak pernah menyediakan → UNAVAILABLE_1S (bukan "gagal trigger"). */
export function eventPolicySet(eventTs: number, store1s: Candle[], store1m: Candle[], asOf: number): Record<EntryPolicy, EventPolicyEval> {
  const done1s = completedCandles(store1s, 1_000, asOf).filter((c) => c.ts >= eventTs);
  const done1m = completedCandles(store1m, 60_000, asOf).filter((c) => c.ts >= eventTs);
  const avail1s: PolicyAvailability = done1s.length === 0 ? "UNAVAILABLE_1S" : done1s.length < 4 ? "PENDING_CANDLES" : "OK";
  const avail1m: PolicyAvailability = done1m.length < 4 ? "PENDING_CANDLES" : "OK";
  const wrap = (ev: PolicyEvaluation, interval: "1s" | "1m"): EventPolicyEval =>
    ({ policy: ev.policy, interval, availability: ev.policy === "CONFIRM_AFTER_4X_1S_CANDLES" ? avail1s : interval === "1s" ? avail1s : avail1m, evaluation: ev });
  const e1s = evaluatePolicies(eventTs, done1s, "1s");
  const e1m = evaluatePolicies(eventTs, done1m, "1m");
  // 1s store: CONFIRM_AFTER_4X_1M juga dinilai pada 1m; IMMEDIATE + PULLBACK di kedua store.
  return {
    IMMEDIATE_OBSERVED_ENTRY: wrap(e1s.IMMEDIATE_OBSERVED_ENTRY, "1s"),
    CONFIRM_AFTER_4X_1S_CANDLES: wrap(e1s.CONFIRM_AFTER_4X_1S_CANDLES, "1s"),
    CONFIRM_AFTER_4X_1M_CANDLES: wrap(e1m.CONFIRM_AFTER_4X_1M_CANDLES, "1m"),
    PULLBACK_WITH_BUYER_RECOVERY: wrap(e1m.PULLBACK_WITH_BUYER_RECOVERY, "1m"),
  };
}

/** Harga keputusan no-look-ahead: close candle SELESAI terakhir ≤ ts (1s dipilih dulu, lalu 1m). */
export function priceAtTs(ts: number, store1s: Candle[], store1m: Candle[]): number | null {
  const d1s = completedCandles(store1s, 1_000, ts);
  const last1s = d1s[d1s.length - 1];
  if (last1s) return last1s.close;
  const d1m = completedCandles(store1m, 60_000, ts);
  return d1m.length ? d1m[d1m.length - 1]!.close : null;
}

// ── Reduksi jurnal (append-only → state) ────────────────────────────────────
export function reduceH2Events(rows: Array<Record<string, unknown>>): Map<string, H2Event> {
  const m = new Map<string, H2Event>();
  for (const r of rows) if (r.type === "h2-event") m.set(String(r.h2EventId), r as unknown as H2Event);
  return m;
}
/** Konfirmasi: baris TERAKHIR per event menang (jurnal urut-waktu). */
export function reduceH2Confirmations(rows: Array<Record<string, unknown>>): Map<string, H2Confirmation> {
  const m = new Map<string, H2Confirmation>();
  for (const r of rows) if (r.type === "h2-confirmation") m.set(String(r.h2EventId), r as unknown as H2Confirmation);
  return m;
}
/** Keputusan H2 yang sudah ada (idempoten lintas restart). */
export function reduceH2Decisions(rows: Array<Record<string, unknown>>): Set<string> {
  const s = new Set<string>();
  for (const r of rows) if (r.type === "h2-decision") s.add(String(r.decisionId));
  return s;
}
