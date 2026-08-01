# Claude adversarial review handoff — 2026-07-26

Read-only review. Do not edit files, tune thresholds, restart/reset the running paper bot, enable
real trading, or claim profitability. Return exactly:

1. `DONE` — verified changes with file:line evidence and tests;
2. `NOT DONE` — missing/incomplete requirements ranked P0/P1;
3. `WRONG` — correctness bugs or invalid assumptions, with minimal failing fixture;
4. `MONITORING` — facts requiring future e3 data;
5. `NEXT` — smallest safe implementation sequence.

## Objective

Positive out-of-sample **net executable** paper expectancy, not a flattering backtest. Real funds
remain prohibited until `PROFITABILITY_TODO.md` P0–P3 pass.

## Work completed since your quota stopped

- Decision/trade identity and post-exit idempotency remain in source.
- Structural diagnostic target is mutually exclusive; old BAD/WIN profit calibration retired.
- `src/analysis/profit-contract.ts` now requires paired arm identity, arm spec hash, parser,
  regime, quote source, fixed horizon, common exit/execution policies. Missing quotes are explicit
  `null`, never zero. Non-primary regimes are retained but excluded by `src/profit-evaluator.ts`.
- Pump account parser v4 reads the official current prefix:
  creator@49, Mayhem@81, cashback@82, quote mint@83..115. Default pubkey/WSOL are SOL; explicit
  non-SOL is rejected before paper capital commit. Fixtures cover 49/115/151-byte accounts.
- Mayhem and non-SOL quote regimes are excluded from primary inference.
- PumpPortal feed drift guard: 529/9,083 historical `launch` rows lacked mandatory CreateEvent
  metadata; 483 reported USDC as `mint`. One sampled signature decoded on-chain as
  `collect_creator_fee_v2`, not create. `normalizeNewTokenEvent()` now rejects these rows explicitly.
- Arm set pre-registered before any e3 result:
  `arm-set-e3-entry-policy-v1`; A hard execution safety, B decision-time setup (UNKNOWN admitted),
  C feature-blind deterministic half of A. Common deterministic 45-minute principal-first exit;
  no LLM/momentum/dev-vibe/no-development cut.
- Independent ledger supports capital, reservations, slots, cluster exposure, partial capital
  returns, and missing-quote quarantine per arm. Ledger and exit state now have deterministic,
  validated restart serialization; fixtures compare post-restart transitions byte-for-byte.
- Curve math extracted to `src/execution/curve-math.ts`; both PaperTrader and future arm engine use
  it. `src/experiments/arm-exit.ts` implements the frozen deterministic exit.
- Online coordinator/wiring and paired resampling are NOT done. No e3 ARM_RESULT exists. Current
  running process is old v11/config and remains monitoring-only; it currently has zero positions.

## New P0 conservation fix requiring attack

PaperTrader and the initial arm simulator computed the tokens received from the hypothetical buy,
but future marks used raw mainnet reserves, which correctly exclude our paper trade. That erased our
net quote input and could value an early Arm A entry against `realSol=0` as an almost total loss.
`counterfactualPostBuyReserves()` + `replayObservedCurveDelta()` now initialize a post-buy overlay,
replay only external mainnet reserve deltas, and retain paper partial impacts. The flat-curve fixture
now recovers principal minus costs instead of losing ~100%.

Attack the implementation. In particular, determine whether applying observed quote-reserve deltas
while preserving the counterfactual invariant is valid through external sells, curve completion,
and migration. Bonding-curve conservation is implemented; continuity into a later synthetic
Jupiter AMM reserve state is still NOT proven and should remain a P0 blocker.

## Highest-value questions

1. Are account offsets and default/WSOL semantics correct against the current official Pump IDL?
2. Can `normalizeNewTokenEvent()` reject a genuine CreateEvent, or still admit fee/claim events?
3. Does arm contract ever permit missing/unexecutable data to become P&L?
4. Does `VirtualArmLedger.partial()/quarantine()` conserve lamports and isolate arms?
5. Does `ArmExitSimulation` double-charge/omit fee, gas, ATA reclaim, self-impact, real-liquidity
   cap, same-tick partial walk, graduation quote, or runner quantity?
   In particular, test conservation of our hypothetical entry SOL across later raw-mainnet marks.
6. Are A/B/C admission decisions frozen without future leakage and truly feature-blind for C?
7. What exact blockers remain before a controlled no-reset restart into e3 is scientifically valid?

## Run

```text
npm run correctness:selftest
# or individually:
npm run typecheck
npm run measurement:selftest
npm run curve-layout:selftest
npm run curve-overlay:selftest
npm run launch-event:selftest
npm run setup:selftest
npm run execution-semantics:selftest
npm run actor-memory:selftest
npm run arm-spec:selftest
npm run arm-admission:selftest
npm run arm-ledger:selftest
npm run arm-exit:selftest
npm run exposure-reservations:selftest
npm run scaleout:selftest
npm run graduation-math:selftest
npm run profit:evaluate   # MUST refuse: no ARM_RESULT yet
npm run shadow            # MUST refuse: legacy harness retired
```
