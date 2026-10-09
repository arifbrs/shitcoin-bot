import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";
import { okxTokenTradingInfo, okxEnabled } from "./okx.js";
import { OkxWsClient, type OkxWsEvent } from "./okx-ws.js";

/**
 * OKX SIGNAL / COPY OBSERVATORY — fixed-horizon outcome measurement.
 *
 * Every OKX event that claims to be informative (a smart-money buy, a whale buy, a tracked wallet
 * entering a position) is registered here with the price AT THE MOMENT WE SAW IT, then re-priced
 * at horizons fixed in advance: 60s / 300s / 900s / 2700s by default.
 *
 * ── THE ONE RULE THAT MAKES THIS WORTH RUNNING ────────────────────────────────────────────────
 * The reference price is the price when WE received the event, never the price the tracked wallet
 * paid. Those two differ by `detectLagMs`, and that gap is the entire question. A copy strategy
 * scored from the wallet's own fill price will look excellent and be unreachable — you cannot buy
 * at a price that had already moved before the event reached you. This is not a hypothetical: the
 * GMGN smart-money lane in this repo looked like it had edge until it turned out most of its buys
 * landed after our own entry. Same shape, same trap.
 *
 * Horizons are fixed BEFORE the outcome is known so a losing signal cannot be rescued by picking
 * a flattering window afterwards. Nothing here buys, sells, or votes on an entry.
 */

const HORIZONS = config.okx.horizonsSec;
/** Cap on simultaneously tracked observations. Each one costs a batched price read per horizon. */
const MAX_OPEN = Number(process.env.OKX_OBS_MAX_OPEN ?? 400);

export interface Observation {
  obsId: string;
  /** "signal" = OKX said smart money bought. "copy" = a wallet we track traded. */
  kind: "signal" | "copy";
  channel: string;
  mint: string;
  symbol: string | null;
  wallet: string | null;
  walletType: string | null;
  /** ms since epoch, when THIS process received the event. */
  detectedAt: number;
  /** OKX's own event time, when supplied — the numerator of the causality check. */
  sourceTs: number | null;
  detectLagMs: number | null;
  /** Price we could actually have referenced at detection. Null = never priced (recorded as such). */
  refPriceUsd: number | null;
  refMarketCapUsd: number | null;
  refLiquidityUsd: number | null;
  amountUsd: number | null;
  triggerWalletCount: number | null;
  /** horizonSec → pct change vs refPriceUsd. */
  outcomes: Record<number, number | null>;
  pending: number[];
}

const open = new Map<string, Observation>();
let seq = 0;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] != null) return obj[k];
  return undefined;
}

/**
 * Register an event. Priced asynchronously: the reference read must not block the WS handler, and
 * an observation that fails to price is kept with refPriceUsd=null rather than dropped — a silent
 * drop would bias the sample toward tokens OKX happens to price well, which is exactly the kind
 * of selection effect this observatory exists to avoid.
 */
export function observe(kind: Observation["kind"], e: OkxWsEvent): Observation | null {
  if (open.size >= MAX_OPEN) return null;
  const d = e.data;
  const token = (d.token ?? {}) as Record<string, unknown>;
  const mint = String(pick(d, ["tokenAddress", "tokenContractAddress", "mint"]) ?? pick(token, ["tokenAddress", "tokenContractAddress"]) ?? "");
  if (!mint) return null;

  const obs: Observation = {
    obsId: `okxobs-${Date.now().toString(36)}-${(seq++).toString(36)}`,
    kind,
    channel: e.channel,
    mint,
    symbol: (pick(d, ["symbol"]) ?? pick(token, ["symbol"]) ?? null) as string | null,
    wallet: (pick(d, ["triggerWalletAddress", "walletAddress", "trader", "userAddress"]) ?? null) as string | null,
    walletType: (pick(d, ["walletType", "tag"]) ?? null) as string | null,
    detectedAt: e.receivedAt,
    sourceTs: e.sourceTs,
    detectLagMs: e.detectLagMs,
    refPriceUsd: null,
    refMarketCapUsd: null,
    refLiquidityUsd: null,
    amountUsd: num(pick(d, ["amountUsd", "quoteAmountUsd", "volumeUsd", "valueUsd"])),
    triggerWalletCount: num(pick(d, ["triggerWalletCount", "addressCount"])),
    outcomes: Object.fromEntries(HORIZONS.map((h) => [h, null])),
    pending: [...HORIZONS],
  };
  open.set(obs.obsId, obs);

  void (async () => {
    const rows = await okxTokenTradingInfo([mint]);
    const row = rows?.[0];
    obs.refPriceUsd = num(row?.price);
    obs.refMarketCapUsd = num(row?.marketCap);
    obs.refLiquidityUsd = num(row?.liquidity);
    logRecord("events", {
      type: "okx-observation-open",
      obsId: obs.obsId, kind: obs.kind, channel: obs.channel, mint: obs.mint, symbol: obs.symbol,
      wallet: obs.wallet, walletType: obs.walletType, detectLagMs: obs.detectLagMs,
      refPriceUsd: obs.refPriceUsd, refMarketCapUsd: obs.refMarketCapUsd, refLiquidityUsd: obs.refLiquidityUsd,
      amountUsd: obs.amountUsd, triggerWalletCount: obs.triggerWalletCount, horizonsSec: HORIZONS,
      neverPriced: obs.refPriceUsd == null,
    });
  })();

  for (const h of HORIZONS) setTimeout(() => void settle(obs.obsId, h), h * 1000).unref?.();
  return obs;
}

async function settle(obsId: string, horizonSec: number): Promise<void> {
  const obs = open.get(obsId);
  if (!obs) return;
  obs.pending = obs.pending.filter((h) => h !== horizonSec);

  if (obs.refPriceUsd == null || obs.refPriceUsd <= 0) {
    // Recorded, not discarded — "we could not price it" is itself an outcome, and a signal source
    // whose tokens are frequently unpriceable is worth less than its win rate suggests.
    logRecord("events", { type: "okx-observation", obsId, kind: obs.kind, channel: obs.channel, mint: obs.mint,
      horizonSec, pctChange: null, verdict: "NEVER_PRICED", detectLagMs: obs.detectLagMs });
  } else {
    const rows = await okxTokenTradingInfo([obs.mint]);
    const now = num(rows?.[0]?.price);
    const pct = now == null ? null : ((now - obs.refPriceUsd) / obs.refPriceUsd) * 100;
    obs.outcomes[horizonSec] = pct;
    logRecord("events", {
      type: "okx-observation", obsId, kind: obs.kind, channel: obs.channel, mint: obs.mint,
      symbol: obs.symbol, wallet: obs.wallet, walletType: obs.walletType,
      horizonSec, refPriceUsd: obs.refPriceUsd, priceUsd: now,
      pctChange: pct == null ? null : Number(pct.toFixed(2)),
      detectLagMs: obs.detectLagMs, amountUsd: obs.amountUsd, triggerWalletCount: obs.triggerWalletCount,
      verdict: pct == null ? "NEVER_PRICED" : "ok",
    });
  }

  if (obs.pending.length === 0) {
    logRecord("events", {
      type: "okx-observation-summary", obsId, kind: obs.kind, channel: obs.channel,
      mint: obs.mint, symbol: obs.symbol, wallet: obs.wallet, walletType: obs.walletType,
      detectLagMs: obs.detectLagMs, refPriceUsd: obs.refPriceUsd, outcomes: obs.outcomes,
    });
    open.delete(obsId);
  }
}

/**
 * Wire the observatory onto a live WS client.
 *
 * Signal channels register as "signal"; address-tracker registers as "copy" and ONLY for buys —
 * a tracked wallet's sell is recorded by the caller's own exit study, and scoring a sell on a
 * "price went up" horizon would invert its meaning.
 */
export function attachOkxObservatory(client: OkxWsClient): void {
  if (!okxEnabled) { ui.warn("[okx-obs] REST disabled — cannot price observations, not attaching"); return; }
  client.onEvent((e) => {
    if (e.channel === "dex-market-new-signal-openapi" || e.channel === "kol_smartmoney-tracker-activity") {
      observe("signal", e);
      return;
    }
    if (e.channel === "address-tracker-activity") {
      const side = String(e.data.tradeType ?? e.data.side ?? e.data.direction ?? "").toLowerCase();
      if (side && !side.includes("buy")) return;
      observe("copy", e);
    }
  });
  ui.pass(`[okx-obs] attached — horizons ${HORIZONS.join("/")}s, max ${MAX_OPEN} open`);
}

export function okxObservatoryOpenCount(): number { return open.size; }
