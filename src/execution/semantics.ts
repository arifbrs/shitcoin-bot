import type { SimResult } from "./executor.js";

export type ExecStage = "theoretical" | "tx-built" | "unavailable" | "executable" | "would-fail";

export interface BuySimulationAssessment {
  stage: ExecStage;
  entryExecutable: boolean;
  /**
   * The simulation is not executable yet, but retrying can produce a materially different
   * verdict. PumpPortal has been measured returning IncorrectProgramId for newly indexed Pump
   * mints and a successful simulation for the same mints minutes later.
   */
  retryable: boolean;
  /** A BUY simulation contains no evidence about whether a later SELL can execute. */
  sellability: "UNTESTED";
}

export function assessBuySimulation(sim: SimResult): BuySimulationAssessment {
  const stage: ExecStage = sim.transportError
    ? "unavailable"
    : !sim.built
      ? "theoretical"
      : sim.needsFunding
        ? "tx-built"
        : sim.ok
          ? "executable"
          : "would-fail";
  const retryable = sim.transportError === true ||
    (stage === "would-fail" && /IncorrectProgramId/i.test(sim.err ?? ""));
  return {
    stage,
    entryExecutable: stage === "executable",
    retryable,
    sellability: "UNTESTED",
  };
}

/** Predictive late setup evidence is telemetry; only proven SELL impossibility is a safety exit. */
export function lateEnrichmentAction(sellFailureProven: boolean): "EXIT_EXECUTION_SAFETY" | "TELEMETRY" {
  return sellFailureProven ? "EXIT_EXECUTION_SAFETY" : "TELEMETRY";
}
