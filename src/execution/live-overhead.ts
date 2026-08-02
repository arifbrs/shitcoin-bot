/**
 * LIVE EXECUTION OVERHEAD — what a real fill would cost that paper trading does not pay.
 *
 * WHY THIS IS SEPARATE FROM THE COST MODEL
 * `costPct` on every trade already carries slippage, launchpad fees, routing and base gas, and
 * those numbers are comparable all the way back through 1,365 closed trades. Folding a new cost
 * into `pnlPct` would silently re-base every historical comparison and make the running cohort
 * incomparable with the one it is being measured against. So this is reported ALONGSIDE, never
 * subtracted: paper P&L keeps its meaning, and the live-adjusted figure is derived on top.
 *
 * WHAT IS MISSING TODAY
 * `config.exec.priorityFeeSol` is a hardcoded 0.00005 SOL, and the validator/Jito tip is not
 * modelled at all. The pump.fun app defaults its tip to 0.001 SOL — twenty times our modelled
 * priority fee. At the 0.03 SOL position this bot trades, that single tip is 3.33% per side,
 * 6.67% round trip, against a total modelled cost of 2.39%. In other words the largest live cost
 * is the one the model does not know about.
 *
 * The tip is CONDITIONAL, not certain: it buys MEV protection and landing priority, and a bot
 * routing through PumpPortal or Jito directly chooses its own. It is modelled because "we might
 * not pay it" is not a reason to plan as if it were zero — and because at our size it is the
 * difference between a strategy that looks near-breakeven and one that is clearly under water.
 *
 * FIXED COSTS PUNISH SMALL POSITIONS, and this is the real finding here:
 *   0.03 SOL → 6.67% round trip      0.25 SOL → 0.80%
 *   0.10 SOL → 2.00%                 1.00 SOL → 0.20%
 * The "small stake bounds the loss" logic is sound for rug risk and brutal for fixed costs.
 */
import { config } from "../config.js";

/** pump.fun app default. Env-tunable because the right tip is an execution-venue decision. */
const VALIDATOR_TIP_SOL = Number(process.env.VALIDATOR_TIP_SOL ?? 0.001);
/** Compute units a pump.fun buy/sell realistically consumes — used to price the priority fee. */
const COMPUTE_UNITS = Number(process.env.EXEC_COMPUTE_UNITS ?? 200_000);
/** Which percentile of the live fee market to assume. "medium" is the market's own middle. */
const FEE_TIER = (process.env.PRIORITY_FEE_TIER ?? "medium") as "low" | "medium" | "high" | "extreme";
const REFRESH_MS = 60_000;

interface QnFees { per_compute_unit?: Record<string, number> }
let cached: { microLamportsPerCu: number; at: number; source: "quicknode" | "config" } | null = null;

/**
 * Live priority-fee market rate from QuickNode's `qn_estimatePriorityFees` add-on, in
 * micro-lamports per compute unit. Falls back to the configured flat fee — never throws, and
 * never blocks a trading decision, because this is measurement, not a gate.
 */
async function priorityFeeMicroLamports(): Promise<{ value: number; source: "quicknode" | "config" }> {
  if (cached && Date.now() - cached.at < REFRESH_MS) return { value: cached.microLamportsPerCu, source: cached.source };
  const qn = (config.rpcEndpoints as string[]).find((u) => u.includes("quiknode.pro"));
  if (qn) {
    try {
      const res = await fetch(qn, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "qn_estimatePriorityFees", params: { last_n_blocks: 100, api_version: 2 } }),
        signal: AbortSignal.timeout(4_000),
      });
      const j = (await res.json()) as { result?: QnFees };
      const v = j.result?.per_compute_unit?.[FEE_TIER];
      if (typeof v === "number" && isFinite(v) && v > 0) {
        cached = { microLamportsPerCu: v, at: Date.now(), source: "quicknode" };
        return { value: v, source: "quicknode" };
      }
    } catch { /* fall through to the configured flat fee */ }
  }
  // Convert the flat configured fee back into a per-CU rate so both paths are comparable.
  const flat = (config.exec.priorityFeeSol * 1e9 * 1e6) / COMPUTE_UNITS;
  cached = { microLamportsPerCu: flat, at: Date.now(), source: "config" };
  return { value: flat, source: "config" };
}

export interface LiveOverhead {
  /** Priority fee for ONE side, in SOL, at the live market rate. */
  priorityFeeSol: number;
  /** Validator/Jito tip for ONE side, in SOL. */
  tipSol: number;
  /** Both sides together, in SOL — a round trip pays each of these twice. */
  roundTripSol: number;
  /** The same, as a percentage of the position — the number that actually matters at our size. */
  roundTripPct: number;
  /** Whether the priority fee came from the live market or the hardcoded fallback. */
  source: "quicknode" | "config";
  microLamportsPerCu: number;
}

/**
 * What a live round trip would cost on top of the modelled `costPct`, for a given position size.
 * Deliberately returns the components as well as the total: a single blended number would hide
 * that the tip dominates and the priority fee is nearly irrelevant at this size.
 */
export async function liveOverhead(sizeSol: number = config.risk.paperTradeSizeSol): Promise<LiveOverhead> {
  const { value: microLamportsPerCu, source } = await priorityFeeMicroLamports();
  const priorityFeeSol = (microLamportsPerCu * COMPUTE_UNITS) / 1e6 / 1e9;
  const roundTripSol = 2 * (priorityFeeSol + VALIDATOR_TIP_SOL);
  return {
    priorityFeeSol: Number(priorityFeeSol.toFixed(9)),
    tipSol: VALIDATOR_TIP_SOL,
    roundTripSol: Number(roundTripSol.toFixed(9)),
    roundTripPct: sizeSol > 0 ? Number(((roundTripSol / sizeSol) * 100).toFixed(3)) : 0,
    source,
    microLamportsPerCu: Number(microLamportsPerCu.toFixed(0)),
  };
}
