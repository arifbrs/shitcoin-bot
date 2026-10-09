import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";
import { okxTokenTradingInfo, okxEnabled } from "./okx.js";
import type { ScoutRow, ScoutVerdict } from "./okx-scout.js";

/**
 * FIXED-HORIZON OUTCOME TRACKER for the OKX scout.
 *
 * The scout produces a verdict per token. This decides whether that verdict is worth anything,
 * by re-pricing every scored token at horizons chosen BEFORE any outcome is known.
 *
 * ── FOUR RULES, EACH ONE PAID FOR BY A PAST MISTAKE IN THIS PROJECT ───────────────────────────
 *
 * 1. BOTH VERDICTS ARE TRACKED. Recording only the tokens we would have bought answers "did our
 *    picks go up" and cannot answer "did the filter discriminate". A gate that rejects nothing
 *    useful looks identical to a good one unless you price its rejects too.
 *
 * 2. THE REFERENCE PRICE IS TAKEN WHEN **WE** SAW THE TOKEN, never its launch price. The gap
 *    between the two is the part a live trade cannot recover, and pricing from launch is how the
 *    GMGN smart-money lane looked predictive while being unreachable.
 *
 * 3. HORIZONS ARE FIXED IN ADVANCE (OKX_HORIZONS_SEC). A losing signal must not be rescuable by
 *    picking a flattering window afterwards.
 *
 * 4. "COULD NOT PRICE IT" IS AN OUTCOME, NOT A DROP. Silently discarding unpriceable tokens
 *    biases the sample toward whatever OKX indexes well — precisely the tokens most likely to be
 *    healthy. NEVER_PRICED is recorded and counted.
 *
 * BATCHING. market/price-info accepts 100 mints per call, so settling 2,000 open observations
 * costs 20 requests, not 2,000. Without this the study would spend its whole rate budget on
 * bookkeeping and starve the scanner that feeds it.
 */

const STORE = join(config.logDir, "okx-outcome-open.json");
const HORIZONS = [...config.okx.horizonsSec].sort((a, b) => a - b);
const BATCH = 100;
/** Cap on simultaneously open observations. Each costs one slot in a batched price read. */
const MAX_OPEN = Number(process.env.OKX_OUTCOME_MAX_OPEN ?? 4_000);

/**
 * REFERENCE-PRICE SANITY FLOOR — and why it is applied to ONE side only.
 *
 * MEASURED over 15,149 registrations: 96.4% of reference prices sit in the 1e-6 decade, and the
 * next decade down holds ELEVEN. That 1,300x cliff is not a tail, it is corruption — values like
 * 4.7478e-12 are seven orders of magnitude below a pump.fun curve floor. A reference price is
 * taken seconds after launch, when the token is pinned at the bonding curve's opening price and
 * physically cannot be lower. One such row produced a +5,685,658,715% outcome and single-handedly
 * dragged the CLEAN mean to +565,291%.
 *
 * ⚠ THE SETTLEMENT PRICE IS DELIBERATELY NOT GUARDED. The same histogram on settlement prices
 * decays SMOOTHLY — 51,948 in the 1e-6 decade, 5,764 in the next, 1,778 after that. No cliff.
 * Those are real tokens that genuinely collapsed toward zero over 45 minutes, which is exactly
 * what memecoins do. Flooring them would delete the losses and leave the winners, biasing every
 * median in this study optimistically. The asymmetry is the point: a launch price cannot be
 * near-zero, an outcome price very much can.
 *
 * Rejected references become refPriceUsd = null, which routes into the existing NEVER_PRICED
 * path. They stay counted in the sample rather than vanishing from it.
 */
const MIN_REF_PRICE_USD = Number(process.env.OKX_MIN_REF_PRICE_USD ?? 1e-7);

/** null when the price is absent or physically impossible for a freshly launched token. */
export function plausibleRefPrice(p: number | null): number | null {
  return p != null && p >= MIN_REF_PRICE_USD ? p : null;
}

export interface OpenObservation {
  obsId: string;
  mint: string;
  symbol: string | null;
  verdict: "CLEAN" | "TOXIC" | "UNKNOWN";
  reasons: string[];
  coverage: number;
  /** ms epoch when WE first saw it — the clock every outcome is measured from. */
  seenAt: number;
  /** Token age at that moment. Separates "we were slow" from "the token was bad". */
  ageMsAtScan: number | null;
  refPriceUsd: number | null;
  refMarketCapUsd: number | null;
  /** Horizons not yet settled, in seconds. */
  pending: number[];
  /** The scout row, carried so an outcome can be re-fitted against any actor field later. */
  row: ScoutRow;
}

type Store = Record<string, OpenObservation>;
let open: Store = {};
let seq = 0;
let dirty = false;

function load(): void {
  if (!existsSync(STORE)) return;
  try {
    open = JSON.parse(readFileSync(STORE, "utf8")) as Store;
    const n = Object.keys(open).length;
    if (n > 0) ui.pass(`[okx-outcome] resumed ${n} open observations`);
  } catch (e) {
    ui.warn(`[okx-outcome] store unreadable, starting fresh: ${(e as Error).message}`);
    open = {};
  }
}

/** Atomic write: a torn store on a crash would silently lose every pending 45-minute horizon. */
function persist(): void {
  if (!dirty) return;
  const tmp = `${STORE}.tmp`;
  writeFileSync(tmp, JSON.stringify(open));
  renameSync(tmp, STORE);
  dirty = false;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/**
 * Register a batch of freshly scouted tokens. One price read per 100 tokens supplies every
 * reference price; a token OKX cannot price is still registered, with refPriceUsd = null.
 */
export async function registerBatch(rows: Array<{ row: ScoutRow; verdict: ScoutVerdict }>): Promise<number> {
  if (!okxEnabled || rows.length === 0) return 0;
  const room = MAX_OPEN - Object.keys(open).length;
  if (room <= 0) { ui.warn(`[okx-outcome] at capacity (${MAX_OPEN}) — not registering`); return 0; }
  const take = rows.slice(0, room);
  const now = Date.now();

  const prices = new Map<string, { price: number | null; mc: number | null }>();
  for (let i = 0; i < take.length; i += BATCH) {
    const mints = take.slice(i, i + BATCH).map((r) => r.row.mint);
    const info = await okxTokenTradingInfo(mints);
    for (const row of info ?? []) {
      prices.set(row.tokenContractAddress, { price: num(row.price), mc: num(row.marketCap) });
    }
  }

  let n = 0, rejected = 0;
  for (const { row, verdict } of take) {
    const raw = prices.get(row.mint);
    const guarded = plausibleRefPrice(raw?.price ?? null);
    if (raw?.price != null && guarded == null) rejected++;
    const p = { price: guarded, mc: raw?.mc ?? null };
    const obsId = `okxobs-${now.toString(36)}-${(seq++).toString(36)}`;
    open[obsId] = {
      obsId, mint: row.mint, symbol: row.symbol,
      verdict: verdict.verdict, reasons: verdict.reasons, coverage: verdict.coverage,
      seenAt: now, ageMsAtScan: row.ageMsAtScan,
      refPriceUsd: p.price, refMarketCapUsd: p.mc,
      pending: [...HORIZONS], row,
    };
    n++;
    logRecord("events", {
      type: "okx-outcome-open", obsId, mint: row.mint, symbol: row.symbol,
      verdict: verdict.verdict, reasons: verdict.reasons, coverage: Number(verdict.coverage.toFixed(2)),
      ageMsAtScan: row.ageMsAtScan, refPriceUsd: p.price, refMarketCapUsd: p.mc,
      neverPriced: p.price == null,
      // Distinguishes "OKX had no price" from "OKX returned an impossible one" — the second is a
      // data-quality signal about the feed, and collapsing them would hide it.
      refPriceRejected: raw?.price != null && p.price == null,
      rawRefPriceUsd: raw?.price ?? null,
      horizonsSec: HORIZONS, cfg: config.strategyVersion,
    });
  }
  if (rejected > 0) {
    ui.warn(`[okx-outcome] ${rejected} reference price(s) below ${MIN_REF_PRICE_USD} — recorded as unpriceable`);
    logRecord("events", { type: "okx-refprice-rejected", count: rejected, floorUsd: MIN_REF_PRICE_USD });
  }
  dirty = true; persist();
  return n;
}

/** Settle every horizon that has come due. Batched: one price read per 100 due observations. */
export async function settleDue(now = Date.now()): Promise<{ settled: number; closed: number }> {
  if (!okxEnabled) return { settled: 0, closed: 0 };

  const due: Array<{ obs: OpenObservation; horizonSec: number }> = [];
  for (const obs of Object.values(open)) {
    for (const h of obs.pending) {
      if (now - obs.seenAt >= h * 1000) due.push({ obs, horizonSec: h });
    }
  }
  if (due.length === 0) return { settled: 0, closed: 0 };

  const mints = [...new Set(due.map((d) => d.obs.mint))];
  const prices = new Map<string, number | null>();
  for (let i = 0; i < mints.length; i += BATCH) {
    const info = await okxTokenTradingInfo(mints.slice(i, i + BATCH));
    for (const row of info ?? []) prices.set(row.tokenContractAddress, num(row.price));
  }

  let settled = 0, closed = 0;
  for (const { obs, horizonSec } of due) {
    obs.pending = obs.pending.filter((h) => h !== horizonSec);
    const nowPrice = prices.get(obs.mint) ?? null;
    const ref = obs.refPriceUsd;
    const pct = ref != null && ref > 0 && nowPrice != null ? ((nowPrice - ref) / ref) * 100 : null;
    logRecord("events", {
      type: "okx-outcome", obsId: obs.obsId, mint: obs.mint, symbol: obs.symbol,
      verdict: obs.verdict, coverage: Number(obs.coverage.toFixed(2)),
      horizonSec, refPriceUsd: ref, priceUsd: nowPrice,
      pctChange: pct == null ? null : Number(pct.toFixed(2)),
      // Every actor field travels with the outcome so thresholds can be re-fitted from data
      // instead of defended from intuition.
      devPct: obs.row.devPct, bundlerPct: obs.row.bundlerPct, sniperPct: obs.row.sniperPct,
      insiderPct: obs.row.insiderPct, freshWalletPct: obs.row.freshWalletPct,
      top10Pct: obs.row.top10Pct, totalHolders: obs.row.totalHolders,
      marketCapUsd: obs.row.marketCapUsd, buyRatio1h: obs.row.buyRatio1h,
      bondingPercent: obs.row.bondingPercent, hasSocials: obs.row.hasSocials,
      ageMsAtScan: obs.ageMsAtScan,
      status: pct == null ? "NEVER_PRICED" : "ok",
      cfg: config.strategyVersion,
    });
    settled++;
    if (obs.pending.length === 0) { delete open[obs.obsId]; closed++; }
  }
  dirty = true; persist();
  return { settled, closed };
}

export function openCount(): number { return Object.keys(open).length; }
export function outcomeHorizons(): number[] { return [...HORIZONS]; }
export function initOutcomeStore(): void { load(); }
export function flushOutcomeStore(): void { dirty = true; persist(); }
