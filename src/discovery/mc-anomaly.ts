/**
 * MARKET-CAP MARK CLASSIFIER — the pure decision half of Strategy 2's MC anomaly guard.
 *
 * Extracted from strategy2-papertrader.ts so it can be tested without a network, a State, or a
 * live position. The guard itself was a P0 fix (2026-07-28): position HOOD's `peakMcUsd` went
 * from a $2.50M entry to "$23.87B" on one bad Solana Tracker read, and because peaks are a
 * high-water mark that never comes back down, that number stood forever and poisoned every
 * trailing-stop calculation for that position. In production it has since flagged 527 marks,
 * confirmed 384 and rejected 140.
 *
 * It had no test. A guard with no test can be silently broken by an unrelated refactor and
 * nobody finds out until the next $23.87B peak — which is exactly the failure mode this file
 * exists to prevent.
 *
 * The rule, per the owner's spec, is deliberately NOT "a jump bigger than N× is fake": real
 * memecoins genuinely spike hundreds of times over, and a crude ratio cap would throw away the
 * moonshots this whole strategy is built to catch. The ratio only decides that a mark NEEDS
 * SCRUTINY. The verdict comes from the NEXT poll: if a follow-up read lands in the same
 * neighbourhood, the move was real and is trusted; if it does not, the first read was bad data
 * and is discarded — and the discarded value never touches `currentMcUsd` or `peakMcUsd`.
 */

/** Beyond this multiple (either direction) against the last trusted value → hold for confirmation. */
export const MC_ANOMALY_RATIO = 1000;
/** How close a follow-up read must land to the pending value for it to count as genuinely real. */
export const MC_CONFIRM_MIN = 0.2;
export const MC_CONFIRM_MAX = 5;

export type McMarkAction =
  /** Trust it: update currentMcUsd/peakMcUsd and run the exit checks. */
  | { action: "accept"; pending: undefined; stages: McMarkStage[]; ratio: number }
  /** Suspicious: park it in `pending`, update nothing, check no exits, wait for the next poll. */
  | { action: "hold"; pending: number; stages: McMarkStage[]; ratio: number };

export interface McMarkStage {
  stage: "confirmed" | "rejected" | "flagged";
  /** The value that was pending when this stage was decided (absent for a fresh flag). */
  pendingValue?: number;
  ratio?: number;
}

/**
 * Classify one incoming market-cap mark.
 *
 * @param baseline  the last TRUSTED market cap (`pos.currentMcUsd`) — never a pending value
 * @param pending   a value parked by a previous poll awaiting corroboration, if any
 * @param incoming  the raw mark just read from the market-data source
 *
 * A rejected pending value falls through to a FRESH classification of `incoming` against the
 * never-corrupted `baseline`, so one bad read cannot drag the baseline with it — and a second
 * equally-bad read is caught on its own merits rather than being waved through.
 */
export function classifyMcMark(baseline: number, pending: number | undefined, incoming: number): McMarkAction {
  const stages: McMarkStage[] = [];

  if (pending != null) {
    const confirmRatio = pending > 0 ? incoming / pending : 1;
    if (confirmRatio >= MC_CONFIRM_MIN && confirmRatio <= MC_CONFIRM_MAX) {
      // Poll-to-poll agreement is NOT enough on its own when both reads are absurd against the
      // baseline: a broken upstream returns similarly-broken values, so two garbage reads
      // corroborate each other and the guard waves the corruption through. Measured on 384 real
      // confirmations: 383 were DOWNWARD at a median ratio of 1.0e-7 (≈$166k → ≈$0.017), and the
      // positions they closed realised a median of −3.9% against a real routed quote — the
      // collapse never happened. Those spurious exits accounted for 74 of Strategy 2's 168
      // TRAIL_STOPs (44%).
      //
      // Only DOWNWARD collapses get this extra bar, and that asymmetry is measured, not assumed:
      // exactly 1 of the 384 was upward. Memecoins really do spike 1000×, so a corroborated pump
      // is still trusted immediately — the fat tail is the whole strategy and must not be gated.
      // A genuinely dead token still gets booked: it exits through the sell-quote-failure
      // write-off path (TRAIL_STOP_NO_LIQUIDITY_FORCED), which prices against a real route rather
      // than a market-cap feed.
      const baselineRatio = baseline > 0 ? incoming / baseline : 1;
      const absurdCollapse = baselineRatio < 1 / MC_ANOMALY_RATIO;
      if (absurdCollapse) {
        stages.push({ stage: "flagged", pendingValue: pending, ratio: baselineRatio });
        return { action: "hold", pending: incoming, stages, ratio: baselineRatio };
      }
      stages.push({ stage: "confirmed", pendingValue: pending, ratio: confirmRatio });
      return { action: "accept", pending: undefined, stages, ratio: confirmRatio };
    }
    stages.push({ stage: "rejected", pendingValue: pending, ratio: confirmRatio });
    // fall through — re-classify `incoming` against the baseline, which was never corrupted
  }

  const ratio = baseline > 0 ? incoming / baseline : 1;
  if (ratio > MC_ANOMALY_RATIO || ratio < 1 / MC_ANOMALY_RATIO) {
    stages.push({ stage: "flagged", ratio });
    return { action: "hold", pending: incoming, stages, ratio };
  }
  return { action: "accept", pending: undefined, stages, ratio };
}
