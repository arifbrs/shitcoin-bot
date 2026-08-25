/**
 * ENTRY-MC BAND A/B — does lowering the floor from 55 to 46 help, hurt, or do nothing?
 *
 * WHY THIS EXISTS. With the ledger corrected to real execution (see execution/exec-realism.ts),
 * the band actually in production measures −2.47% ±0.96 over 3,710 trades. That confidence
 * interval excludes zero: the current floor is not "unproven", it is losing. Meanwhile 10% of
 * all decisions are rejected for sitting between 46 and 55 SOL — about 5.7 trades an hour, a
 * third more volume than we currently take.
 *
 * And we cannot say a word about whether those trades would be any good. Every retained log
 * since 2026-08-08 was produced under a 55–74 floor: 4,964 trades, minimum entry MC 55.0,
 * maximum 74.0, not one observation outside it. Lowering the floor on that basis would be a
 * guess, and the whole point of the work this sits on top of was to stop guessing.
 *
 * WHY NOT THE e3 ARM HARNESS. It exists and it is well-tested, but it runs its own 45-minute
 * horizon exit with no EARLY_CUT. Production cuts below 5 seconds. An answer from that harness
 * would be an answer about a different strategy, which is worse than no answer because it looks
 * like one.
 *
 * THE DESIGN. Each candidate is assigned, by hash of its decisionId alone, to exactly one arm,
 * and that arm's floor decides admission. Two complete policies over random halves of the same
 * flow — so `LO` vs `HI` answers the question directly, and filtering `LO` to entries below the
 * control floor answers the narrower "is 46–54 itself any good?".
 *
 * Assignment is FEATURE-BLIND on purpose. Nothing about the token — market cap, dev buy, theme,
 * holders — may influence which arm sees it, or the comparison stops being between policies and
 * becomes between two differently-selected populations.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

export const MC_BAND_AB_SPEC = Object.freeze({
  experimentId: "mc-band-floor-46-vs-55-v1",
  frozenAt: "2026-08-25T10:45:00.000Z",
  /**
   * PRE-REGISTERED so it cannot be chosen after seeing the answer.
   *
   * Primary question: is `LO`'s realised EV (execution-corrected, SOL-weighted) higher than
   * `HI`'s? Secondary: is the 46–54 slice on its own distinguishable from zero?
   *
   * Stopping rule: 400 closed trades per arm, or 7 days, whichever comes first. Below that,
   * report the interval and decide nothing — the band this replaces took 3,710 trades to
   * separate from zero, so a few dozen will not settle anything.
   */
  minTradesPerArm: 400,
  maxDays: 7,
  splitBps: 5_000, // half and half
} as const);

export type McArm = "LO" | "HI";

export interface McBandVerdict {
  /** null = this candidate is not in the experiment; use the production band. */
  arm: McArm | null;
  floor: number;
  ceiling: number;
}

/**
 * Stable, feature-blind arm assignment. The same decisionId always lands in the same arm, and
 * the experiment's own id is in the hash so this split is independent of every other experiment
 * that ever hashes the same decisionIds.
 */
export function mcArmFor(decisionId: string): McArm {
  const bytes = createHash("sha256").update(`${MC_BAND_AB_SPEC.experimentId}:${decisionId}`).digest();
  return bytes.readUInt32BE(0) % 10_000 < MC_BAND_AB_SPEC.splitBps ? "LO" : "HI";
}

/**
 * The band this candidate must clear.
 *
 * A candidate with no decisionId is EXCLUDED rather than defaulted into an arm: assigning it to
 * the control would quietly bias the control with everything the pipeline failed to identify.
 * It still trades, under the production band, and its rows carry no arm tag — so they can never
 * be pooled into either side.
 */
export function mcBandFor(decisionId: string | null | undefined): McBandVerdict {
  const prod = config.gate.entryMcBandSol;
  if (!config.gate.entryMcAb.enabled || !decisionId) {
    return { arm: null, floor: prod.floor, ceiling: prod.ceiling };
  }
  const arm = mcArmFor(decisionId);
  return {
    arm,
    floor: arm === "LO" ? config.gate.entryMcAb.loFloorSol : prod.floor,
    ceiling: prod.ceiling,
  };
}

/** One line for startup, so an interleaved run can never be mistaken for a single policy. */
export function mcBandAbBanner(): string | null {
  if (!config.gate.entryMcAb.enabled) return null;
  const prod = config.gate.entryMcBandSol;
  return `[mc-ab] A/B lantai entry-MC AKTIF — LO ${config.gate.entryMcAb.loFloorSol}–${prod.ceiling} vs HI ${prod.floor}–${prod.ceiling}, ` +
    `split ${MC_BAND_AB_SPEC.splitBps / 100}%, berhenti di ${MC_BAND_AB_SPEC.minTradesPerArm} trade/arm atau ${MC_BAND_AB_SPEC.maxDays} hari`;
}
