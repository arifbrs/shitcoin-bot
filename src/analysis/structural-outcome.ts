/**
 * Mutually-exclusive structural outcomes for observatory diagnostics.
 *
 * These labels describe what the launch did. They are deliberately NOT a profit target:
 * a PUMP_THEN_RUG can be highly profitable for a principal-first policy, while a launch that
 * survives can still lose money after fees. Trading edge must be evaluated separately from
 * paired, executable per-arm P&L.
 */
export type StructuralOutcome =
  | "PUMP_THEN_RUG"
  | "BAD_NO_PUMP"
  | "GRADUATED_WIN"
  | "WIN_SURVIVED"
  | "ORDINARY"
  | "UNPRICEABLE"
  | "UNKNOWN";

export interface StructuralInput {
  outcome?: string;
  peakGainPct?: number;
}

export function structuralOutcome(r: StructuralInput): StructuralOutcome {
  const outcome = r.outcome ?? "";
  const peak = Number.isFinite(r.peakGainPct) ? r.peakGainPct! : 0;
  const unpriceable = outcome === "unpriceable";
  const badTerminal = outcome === "drained" || outcome === "rapid-rug";
  const fatTail = peak >= 100 || outcome === "graduated";

  if (unpriceable) return "UNPRICEABLE";
  if (badTerminal && fatTail) return "PUMP_THEN_RUG";
  if (badTerminal) return "BAD_NO_PUMP";
  if (outcome === "graduated") return "GRADUATED_WIN";
  if (fatTail) return "WIN_SURVIVED";
  if (outcome === "faded") return "ORDINARY";
  return "UNKNOWN";
}

export const isStructuralTail = (x: StructuralOutcome): boolean =>
  x === "PUMP_THEN_RUG" || x === "GRADUATED_WIN" || x === "WIN_SURVIVED";
