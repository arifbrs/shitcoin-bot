/**
 * Selftest for the Strategy 2 market-cap anomaly guard (src/discovery/mc-anomaly.ts).
 *
 * The guard has run in production since 2026-07-28 and has rejected 140 corrupt marks, but it
 * had NO test until 2026-08-01 — so any refactor could have silently disarmed it, and the only
 * way to find out would have been another permanently-poisoned peak. The headline case pinned
 * here is the real one that caused the fix: HOOD, $2.50M → "$23.87B" → $2.6M.
 *
 * Run: npm run mc-anomaly:selftest   (also part of npm run correctness:selftest)
 */
import assert from "node:assert/strict";
import { classifyMcMark, MC_ANOMALY_RATIO, MC_CONFIRM_MIN, MC_CONFIRM_MAX } from "./discovery/mc-anomaly.js";

let checks = 0;
const ok = (label: string, fn: () => void): void => { fn(); checks++; console.log(`  ✓ ${label}`); };

console.log("MC anomaly guard — selftest\n");

// ── THE HOOD CASE: spike then recovery ───────────────────────────────────────
// The whole point of the fix. The $23.87B read must be held (never trusted outright), and the
// real $2.6M that follows must still be accepted — proving the guard rejects the bad mark
// WITHOUT also throwing away the legitimate value that comes after it.
ok("HOOD: $2.5M → $23.87B is HELD, not trusted", () => {
  const v = classifyMcMark(2_500_000, undefined, 23_873_371_949);
  assert.equal(v.action, "hold");
  assert.equal(v.pending, 23_873_371_949);
  assert.equal(v.stages.at(-1)?.stage, "flagged");
});

ok("HOOD: the following $2.6M REJECTS the pending spike and is itself accepted", () => {
  const v = classifyMcMark(2_500_000, 23_873_371_949, 2_600_000);
  assert.equal(v.action, "accept", "the real recovery value must be usable");
  assert.equal(v.pending, undefined, "the corrupt pending value must be discarded");
  assert.deepEqual(v.stages.map((s) => s.stage), ["rejected"]);
});

ok("HOOD: peak never sees the $23.87B — a hold updates nothing", () => {
  // Replays the exact three-poll sequence against a high-water mark, which is what actually
  // got corrupted in production (peaks never come back down, so one bad write is permanent).
  let current = 2_500_000, peak = 2_500_000, pending: number | undefined;
  for (const mc of [23_873_371_949, 2_600_000]) {
    const v = classifyMcMark(current, pending, mc);
    pending = v.pending;
    if (v.action === "accept") { current = mc; peak = Math.max(peak, mc); }
  }
  assert.equal(peak, 2_600_000);
  assert.ok(peak < 23_873_371_949 / 1000, "the corrupt value must never have reached the peak");
});

// ── A REAL MOONSHOT MUST SURVIVE ─────────────────────────────────────────────
// The owner's explicit spec: do NOT use a naive ">Nx = reject" rule. Memecoins genuinely spike,
// and rejecting those would throw away the fat tail the whole strategy exists to catch.
ok("a real 50× pump is accepted immediately — no scrutiny needed", () => {
  const v = classifyMcMark(100_000, undefined, 5_000_000);
  assert.equal(v.action, "accept");
  assert.equal(v.stages.length, 0);
});

ok("an extreme-but-REAL spike is held once, then confirmed by the next poll", () => {
  const first = classifyMcMark(10_000, undefined, 50_000_000); // 5000× → needs scrutiny
  assert.equal(first.action, "hold");
  const second = classifyMcMark(10_000, first.pending, 45_000_000); // corroborates
  assert.equal(second.action, "accept", "a sustained spike must be believed");
  assert.equal(second.stages.at(-1)?.stage, "confirmed");
});

// ── CRASHES, THE DIRECTION ACTUALLY SEEN IN PRODUCTION ───────────────────────
// The 527 real flags were mostly marks collapsing to ~$0.03 from six figures, not upward jumps.
ok("a collapse to ~$0 is held, not booked as a total loss", () => {
  const v = classifyMcMark(166_523, undefined, 0.03);
  assert.equal(v.action, "hold");
});

ok("two agreeing GARBAGE reads do NOT confirm each other (the 44%-of-exits bug)", () => {
  // Measured: 383 of 384 production "confirmations" were downward at ~1e-7 vs baseline, and the
  // positions they closed realised a median of −3.9% against a real routed quote. Poll-to-poll
  // agreement proves nothing when the upstream is returning garbage twice.
  const first = classifyMcMark(166_523, undefined, 0.03);
  const second = classifyMcMark(166_523, first.pending, 0.04);
  assert.equal(second.action, "hold", "an absurd collapse must never be trusted on feed agreement alone");
  assert.equal(second.stages.at(-1)?.stage, "flagged");
});

ok("a decline that recovers to a PLAUSIBLE level is confirmed — the bar is absurdity, not direction", () => {
  // First read is absurd vs baseline (6e-4) so it is held. The follow-up corroborates it
  // (400/100 = 4×, inside the window) AND lands above the absurdity floor vs the baseline
  // (2.4e-3), so it is a real, if brutal, decline and gets trusted.
  const first = classifyMcMark(166_523, undefined, 100);
  assert.equal(first.action, "hold");
  const second = classifyMcMark(166_523, first.pending, 400);
  assert.equal(second.action, "accept");
  assert.equal(second.stages.at(-1)?.stage, "confirmed");
});

// ── BOUNDARIES ───────────────────────────────────────────────────────────────
ok("exactly at the ratio threshold is NOT flagged (strict >)", () => {
  assert.equal(classifyMcMark(1_000, undefined, 1_000 * MC_ANOMALY_RATIO).action, "accept");
});

ok("just beyond the ratio threshold IS flagged", () => {
  assert.equal(classifyMcMark(1_000, undefined, 1_000 * MC_ANOMALY_RATIO * 1.01).action, "hold");
});

ok("confirmation window edges are inclusive", () => {
  const lo = classifyMcMark(1, 1_000_000, 1_000_000 * MC_CONFIRM_MIN);
  const hi = classifyMcMark(1, 1_000_000, 1_000_000 * MC_CONFIRM_MAX);
  assert.equal(lo.action, "accept");
  assert.equal(hi.action, "accept");
});

ok("upward corroboration is still trusted — the fat tail is never gated", () => {
  // Two different corrupt reads in a row. The second must be measured against the untouched
  // baseline, not against the first corrupt value (which would have made it look reasonable).
  // 19B vs a 23.87B pending is inside the confirmation window, so poll-to-poll agreement alone
  // would have accepted it. It is upward, so the collapse bar does not apply — this documents
  // that the UPWARD path still trusts corroboration, by design (memecoins do spike).
  const v = classifyMcMark(2_500_000, 23_873_371_949, 19_000_000_000);
  assert.equal(v.action, "accept");
  assert.equal(v.stages.at(-1)?.stage, "confirmed");
});

ok("a zero/unknown baseline never flags — nothing to compare against", () => {
  assert.equal(classifyMcMark(0, undefined, 999_999_999).action, "accept");
});

console.log(`\n${checks} checks passed.`);
