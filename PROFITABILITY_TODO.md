# Papertrade Profitability Program

Objective: demonstrate positive **out-of-sample net executable expectancy**, not manufacture a
positive backtest. Profit cannot be guaranteed. Real-money trading remains prohibited until every
readiness gate below passes.

## Current verdict

- Latest meaningful live cohort (`f297nv`): 36 closed, 3 winners, `-0.474129 SOL`,
  `-0.01317 SOL/trade`, profit factor `0.216`.
- Current pre-change runtime monitoring (started around 16:00 WIB): 47/47 positions closed,
  9 winners, `-0.387915 SOL`. It still runs old code/config and is not e3 evidence.
- The current implementation is not profitable and is not yet a valid test of the intended
  30–45 minute fat-tail thesis: `NO_DEVELOPMENT=45s` and `MAX_HOLD=120s` turn it into a short scalp.
- Eight catastrophic exits produced about 75% of cohort loss.
- Runtime audit found an unsupported regime hidden inside standard Pump accounting: on cfg
  `4ieep7`, Mayhem was 15/62 closes but lost `-0.348153 SOL` (41% of loss) and caused all eight
  Mayhem catastrophic exits. Removing it still leaves the standard cohort negative
  (`-0.494036 SOL`), so this repairs safety/measurement but does not manufacture profitability.
- The old calibration target was invalid: a launch could be both BAD and WIN. Profit inference from
  that target is retired.
- Historical structural data are diagnostic only. Across pooled configs, CLEAN contains both more
  structural tails and more BAD_NO_PUMP than other verdicts. That ambiguity must be resolved by
  policy P&L, not by renaming labels.

## DONE — measurement foundation

- [x] `tradeId` is unique per opened position and persists through OPEN/PARTIAL/CLOSE/ticks/post-exit.
- [x] `decisionId` is minted at first candidate acceptance on PumpPortal and Bitquery paths and
  persists through decision/trade/path/post-exit records in the source prepared for the next run.
- [x] CLOSE carries epoch, policy, arm, regime, quote source, parser version, executable P&L/stage.
- [x] Post-exit tracking is keyed by `tradeId`, guarded against overlapping intervals, idempotent,
  and reconstructs completion from its own log.
- [x] Structural outcomes are mutually exclusive:
  `PUMP_THEN_RUG | BAD_NO_PUMP | GRADUATED_WIN | WIN_SURVIVED | ORDINARY | UNPRICEABLE | UNKNOWN`.
- [x] Structural reports explicitly refuse profit/edge claims.
- [x] Profit evaluator fails closed unless it receives complete paired, interleaved, executable
  `ARM_RESULT` records at a fixed policy, horizon, epoch, and recognized regime.
- [x] Exactly one authoritative decision record is emitted per candidate attempt; `openResult`
  carries the internal refusal code instead of writing a second decision row.
- [x] The legacy shadow harness is retired fail-closed; it can no longer publish expectancy from
  future verdicts, conditional terminal rows, depleted graduation reserves, or sparse path samples.
- [x] Future observatory rows stamp decision/epoch, first-price time, verdict-availability time,
  and a real fixed-horizon mark; capacity drops are explicit rather than silent.
- [x] Independent per-arm ledger primitive uses lamport accounting and isolates cash, pending
  reservations, slots, and cluster exposure (12/12 focused tests). Online wiring remains P1.
- [x] Live-paper actor exposure now reserves clusters synchronously across async opens; concurrent
  candidates cannot all pass against stale open-position counts.
- [x] Pump Mayhem is captured from the launch event, routed to `PUMP_CURVE_MAYHEM`, and rejected as
  an unsupported execution regime. It is no longer silently pooled with standard Pump curves.
- [x] Pump's current bonding-curve prefix is parsed through `quote_mint` (49/115/151-byte
  fixtures). Pubkey default and WSOL are recognized as SOL; explicit non-SOL quote curves are
  rejected before capital is committed and retained only as excluded coverage evidence.
- [x] PumpPortal launch normalization now fails closed on feed/schema drift. Historical monitoring
  found 529/9,083 rows without mandatory CreateEvent metadata; 483 used USDC as `mint`. One sampled
  transaction decoded on-chain as `collect_creator_fee_v2`, not token creation. Such rows are
  explicitly logged as `launch-schema-reject` and never enter candidate/counterfactual joins.
- [x] `npm run correctness:selftest` passes 213 focused assertions plus TypeScript (including
  measurement 16, layout 18, reserve overlay 13, launch event 13, and arm exit 20).
- [x] The currently running paper bot was not restarted or reset while these source changes were made.

## P0 — correctness before any profitability experiment

Each item must have a fixture/replay test. No threshold tuning is allowed in this phase.

- [x] Bundle safety: raw same-slot transaction count must never be a hard skip. Hard skip requires
  verified distinct buy wallets (or another explicitly verified actor-level bundle proof).
- [x] Authority parity: counterfactual and live paths must apply the same mint/freeze authority
  execution-safety result. A failed hard authority check cannot become CLEAN/UNKNOWN.
- [x] Simulation semantics: a failed BUY simulation must not be labelled honeypot/NO_SELL.
  Buy failure, sell failure, and unavailable simulation are separate states.
- [x] Late enrichment policy: predictive late-TOXIC becomes telemetry. It may not create paid
  entry-then-immediate-exit churn. Only newly proven execution impossibility can trigger a safety exit.
- [x] Actor memory: eliminate lost updates caused by rereading stale disk state before delayed saves;
  test concurrent outcomes for the same and different actors.
- [ ] Online arm/replay parity (the invalid legacy shadow is already retired):
  - no future verdict may be used at time zero;
  - every launch is marked at a fixed horizon, never silently discarded for surviving;
  - graduation uses the same AMM quote/fallback rules as paper execution;
  - payout is capped by real liquidity;
  - all material live entry predicates are represented or the arm says explicitly that they are not.
- [x] Graduation math: test for fee double-charge and same-tick partial/close quantity reuse.
- [ ] Counterfactual reserve conservation: the paper buy must add its net quote input to the
  simulated virtual/real reserves. Subsequent mainnet marks exclude our paper trade, so replay
  external reserve deltas onto a persistent counterfactual state; partial sell impacts must persist.
  Prove a flat untouched curve round trip loses only modeled costs, not ~100% from `realSol=0`.
  - [x] Standard bonding-curve overlay is shared by PaperTrader and arm simulation; 13/13 fixtures
    prove invariant preservation, own-liquidity conservation, external-delta replay, and partial
    persistence.
  - [ ] Prove/implement continuity of that counterfactual impact through graduation into the
    synthetic Jupiter AMM state; do not assume mainnet migration included our paper trades.
- [x] Ladder invariant: the +600% tier must either sell a non-zero quantity or be removed; UI progress
  must equal actual remaining tokens.
- [x] Regime/quote correctness: USD/non-SOL quote, Mayhem, and unknown parser regimes are excluded
  from primary inference; paired arms must name the same regime. OLD-like apparent gains cannot
  enter P&L until quote units are validated.
- [x] Config fingerprint covers every material entry, execution, fee, hold, re-entry, and parser rule.

### P0 acceptance

- All fixtures pass.
- No known future leakage.
- No selected-only rows accepted as counterfactual.
- No would-fail result reported as executable.
- Replaying the same immutable input produces byte-equivalent arm outcomes.

## P1 — build the actual interleaved experiment

- [x] Pre-register exact arm definitions before looking at their outcome. `arm-set-e3-entry-policy-v1`
  freezes A=hard safety, B=current setup (UNKNOWN admitted), C=feature-blind deterministic 50% of A;
  all share the same executable 45-minute principal-first policy. No e3 result existed at freeze.
- [ ] Give every arm its own virtual cash, pending SOL, open-position slots, creator/cluster exposure,
  and reservation mutex. Shared market data are allowed; shared capital contention is not.
  - Primitive now also accounts for partial capital returns and quarantines unresolved quote value;
    online coordinator wiring is still required before this item can be checked.
- [ ] Run all arms on the same `decisionId` and immutable entry snapshot.
- [ ] Hold entry policy constant within each arm for an epoch. Entry-policy comparisons use the same
  exit ladder, fees, slippage, quote path, and fixed 45-minute horizon.
  - Frozen pure exit simulator and shared curve-math module pass fixtures; live shared-market-data
    wiring and AMM quote fan-out remain incomplete.
- [ ] Record a complete result for every arm, including SKIP as its counterfactual policy outcome.
  Missing quotes remain missing; they are never imputed as zero or success.
- [ ] Generate `ARM_RESULT` only after all required arm outcomes for that decision are final.
- [ ] Keep current production-like paper actions separate from arm ledgers.

Candidate arm family (must be frozen before collection):

- `A`: hard execution/safety only; predictive setup signals are telemetry.
- `B`: current setup classifier policy.
- `C`: comparator policy selected before the epoch (for example a pre-registered blind/randomized
  admissible subset). It must not be retrospectively chosen from the best historical result.

### P1 acceptance

- At least 99% of admitted decisions have all required arms.
- Zero cross-arm capital/exposure interference.
- Policy ID, horizon, epoch, parser, and regime are complete on every accepted result.
- Profit evaluator no longer refuses the dataset for schema/completeness reasons.

## P2 — inference, not dashboard optimism

- [ ] Primary metric: mean `netExecutablePnlSol` per admitted decision and total bankroll path.
- [ ] Secondary: profit factor, loss/tail contribution, drawdown, time-in-capital, and ruin probability.
- [ ] Compare arms with paired resampling by `decisionId`/mint.
- [ ] Estimate absolute uncertainty with time and creator/cluster blocks; row bootstrap is forbidden.
- [ ] Report unconditional tail contribution, p50/p90/p95/p99/max, and frequency. Never replace a
  fat-tail report with median or maximum alone.
- [ ] Separate regimes and epochs. Pooled cross-config output is diagnostic only.
- [ ] Freeze one candidate policy, then evaluate it on untouched future time blocks. No retuning on
  the holdout.

### Minimum evidence gate

- A pre-registered arm has positive mean net executable P&L on untouched time blocks.
- Paired improvement over the hard-safety baseline has a confidence interval excluding zero.
- Positive result is not attributable to one mint, creator cluster, would-fail trade, unknown regime,
  or stale/synthetic quote.
- Positive expectancy persists after realistic fees, slippage, failed fills, and capital constraints.
- Required sample is determined by uncertainty/effective clusters, not a convenient raw row count.

## P3 — only after positive out-of-sample paper evidence

- [ ] Forward paper validation with the winning policy frozen.
- [ ] Stress fees/slippage/latency and remove the largest winner.
- [ ] Validate ATA rent/reclaim against actual transaction construction.
- [ ] Define kill switches, daily loss limit, actor exposure, and maximum total capital.
- [ ] Independent code/data review.

Real funds remain blocked until P0–P3 pass. Passing is evidence of a paper edge, not a guarantee that
the edge survives deployment.

## Monitoring

- Current live process: monitor only; do not restart/reset automatically.
- Current process loaded before the latest `decisionId` source changes, so it cannot certify P1.
- Current process also predates the v4 quote-layout parser and Mayhem/non-SOL admission guard; its
  runtime P&L is monitoring evidence only and must not be pooled with the next measurement epoch.
- Track by epoch/config:
  entry latency p50/p90/p99, candidate-to-open conversion, executable/would-fail/missing quote counts,
  post-exit unique summaries per tradeId, regime coverage, catastrophic contribution, and RPC health.
- Do not draw a latency conclusion before several hundred comparable epoch-new decisions.

## Claude handoff

When Claude capacity is available, send:

1. completed files and test outputs;
2. explicit request for adversarial review of identity propagation, outcome exclusivity, and the
   fail-closed arm contract;
3. the P0 list above, asking Claude to return `DONE / NOT DONE / MONITORING / BLOCKED` with file-line
   evidence and tests;
4. instruction not to tune thresholds, restart/reset the bot, claim profit, or enable real trading.
