import { config } from "../config.js";

export function launchpadFeePct(pool: string | undefined): number {
  const table = config.risk.launchpadFeePct;
  return table[(pool ?? "").toLowerCase()] ?? table.default ?? 1.0;
}

export function curveFeeFrac(pool: string | undefined, graduated: boolean): number {
  return ((graduated ? config.risk.ammFeePct : launchpadFeePct(pool)) + config.risk.swapFeePct) / 100;
}

export const gasPerSideSol = (): number => config.risk.baseTxSol + config.exec.priorityFeeSol;

export function curveBuyTokens(vQuote: number, vTokens: number, quoteIn: number): number {
  if (vQuote <= 0 || vTokens <= 0 || quoteIn <= 0) return 0;
  return (vTokens * quoteIn) / (vQuote + quoteIn);
}

export function curveSellSolGross(vSol: number, vTokens: number, tokenQty: number): number {
  if (vSol <= 0 || vTokens <= 0 || tokenQty <= 0) return 0;
  return (vSol * tokenQty) / (vTokens + tokenQty);
}

export interface CurveEntryFill {
  tokenQty: number;
  solIntoCurve: number;
}

export interface CurveReserves {
  vSol: number;
  vTokens: number;
  realSol: number;
}

/** Curve state immediately after OUR hypothetical paper buy. */
export function counterfactualPostBuyReserves(
  observed: CurveReserves,
  fill: CurveEntryFill,
): CurveReserves {
  return {
    vSol: observed.vSol + fill.solIntoCurve,
    vTokens: observed.vTokens - fill.tokenQty,
    realSol: observed.realSol + fill.solIntoCurve,
  };
}

/**
 * Apply the market's observed reserve DELTA to a counterfactual curve that already contains our
 * paper trades. Re-reading raw mainnet state would otherwise erase our own entry/partials.
 */
export function replayObservedCurveDelta(
  counterfactual: CurveReserves,
  previousObserved: Pick<CurveReserves, "vSol" | "realSol">,
  nextObserved: Pick<CurveReserves, "vSol" | "realSol">,
): CurveReserves {
  const invariant = counterfactual.vSol * counterfactual.vTokens;
  const vSol = Math.max(1e-12, counterfactual.vSol + (nextObserved.vSol - previousObserved.vSol));
  return {
    vSol,
    vTokens: invariant / vSol,
    realSol: Math.max(0, counterfactual.realSol + (nextObserved.realSol - previousObserved.realSol)),
  };
}

export function curveEntryFill(vSol: number, vTokens: number, sizeSol: number, pool?: string): CurveEntryFill {
  const tradeSol = Math.max(0, sizeSol - gasPerSideSol() - config.risk.ataRentSol);
  const solIntoCurve = tradeSol * (1 - curveFeeFrac(pool, false));
  return { tokenQty: curveBuyTokens(vSol, vTokens, solIntoCurve), solIntoCurve };
}

export function curveEntryTokenQty(vSol: number, vTokens: number, sizeSol: number, pool?: string): number {
  return curveEntryFill(vSol, vTokens, sizeSol, pool).tokenQty;
}

export function curveExitProceedsSol(
  vSol: number,
  vTokens: number,
  tokenQty: number,
  pool: string | undefined,
  graduated: boolean,
  realSol?: number,
): number {
  let gross = curveSellSolGross(vSol, vTokens, tokenQty);
  if (realSol != null && realSol >= 0) gross = Math.min(gross, realSol);
  return Math.max(0, gross * (1 - curveFeeFrac(pool, graduated)) - gasPerSideSol());
}

export function syntheticAmmReservesFromQuote(
  tokenQty: number,
  netSolOut: number,
  impactPct: number,
): { solReserve: number; tokenReserve: number } | null {
  if (!(tokenQty > 0) || !(netSolOut > 0)) return null;
  const impact = Math.min(0.99, Math.max(1e-4, impactPct / 100));
  const execPrice = netSolOut / tokenQty;
  const tokenReserve = (tokenQty * (1 - impact)) / impact;
  const solReserve = (execPrice / (1 - impact)) * tokenReserve;
  return tokenReserve > 0 && solReserve > 0 && Number.isFinite(tokenReserve) && Number.isFinite(solReserve)
    ? { solReserve, tokenReserve }
    : null;
}

export function syntheticAmmExitProceedsSol(
  solReserve: number,
  tokenReserve: number,
  tokenQty: number,
  realSol?: number,
): number {
  let routeNet = curveSellSolGross(solReserve, tokenReserve, tokenQty);
  if (realSol != null && realSol >= 0) routeNet = Math.min(routeNet, realSol);
  return Math.max(0, routeNet - gasPerSideSol());
}

export function clampedScaleSellQty(
  originalQty: number,
  remainingQty: number,
  sellFrac: number,
  minKeepFrac: number,
): number {
  const requested = originalQty * sellFrac;
  const minKeepQty = originalQty * minKeepFrac;
  return Math.max(0, Math.min(requested, remainingQty - minKeepQty));
}
