# Shitcoin — Mature Concept Spec

> **Status: CONCEPT — MATURING.** This document fills every open decision from
> `README.md` with a concrete answer + justification, drawn from deep research
> (reference sniper repo, 2026 ecosystem state, safety-tooling reality, execution
> best-practice). Nothing here is built yet. **Build nothing until the owner
> signs off on every decision in [§ Decisions](#decisions).**
>
> Last researched: 2026-06-21.
>
> **2026-07-20 update:** deep research on the free-tier stack completed — see
> [`RESEARCH.md`](RESEARCH.md). Key revisions: snipe mode → **fast-follow mode**
> (same-block sniping is insider-only; we enter seconds post-launch, post-gate),
> Geyser dropped (not free on any tier), PumpPortal free WS = launch feed,
> PumpPortal Local API (0.5%) = bonding-curve execution path, deployer-reputation
> added to the safety gate. Owner approved starting the dry-run MVP (no wallet).

---

## Decisions

Each "open decision" from the README is resolved below. The reasoning is in
[§ Research basis](#research-basis); this section is the verdict.

### D1 — Chain: **Solana (only)**

- **Verdict:** Solana. Do not build EVM support.
- **Why:** ~90% of memecoin launch volume in 2026 is Solana-native (pump.fun +
  letsbonk.fun / Raydium LaunchLab). The entire sniper toolchain — Geyser gRPC,
  Helius RPC, Jupiter, Jito, PumpPortal — is Solana-only. EVM memecoins
  (Base/BSC) are a rounding error for sniping and would double the surface area.
- **Implication:** stack is `@solana/web3.js` (or `solana-py`), SPL Token +
  Token-2022, Jupiter, Helius. No ccxt, no EVM wallets.

### D2 — Strategy: **Hybrid (snipe + swing), sniping gated by safety**

- **Verdict:** Two modes, switchable:
  - **Snipe mode (the edge):** listen to the chain directly for new launches on
    pump.fun + letsbonk.fun bonding curves. DexScreener is NOT used for
    discovery here (too slow — confirmed). Every candidate must pass the full
    [Safety gate](#d4--safety-layered-on-chain--rugcheck--holder-analysis--sell-sim)
    before buying.
  - **Swing mode (lower-risk):** poll DexScreener for tokens that already have
    volume/liquidity. DexScreener polling is sufficient here.
- **The central tension, made explicit:** sniping wants to be *first in*
  (sub-second), safety wants *time to analyze* (the RugCheck API adds latency).
  We resolve this by making the **gate fast and on-chain** (authority checks
  via RPC = milliseconds), and treating RugCheck as *enrichment*, not the gate.
  We accept being a few hundred ms slower than a yolo sniper in exchange for
  not buying 98.7% fraud tokens.
- **Why not snipe only:** pure sniping without a gate is statistically a loss
  (Solidus Labs: ~98.7% of pump.fun tokens show fraud signs).
- **Why not swing only:** the alpha (early entry) is gone.

### D3 — Execution: **Jupiter Ultra API + Helius RPC + Jito bundles**

- **Verdict:**
  - **RPC:** Helius (primary) + one backup (Chainstack or Triton). Helius gives
    Geyser, webhooks, Sender (low-latency submission), Priority Fee API, and Jito
    bundle relay in one provider.
  - **Swap router:** **Jupiter Ultra API** for ALL swaps — bonding-curve buys,
    post-graduation AMM (PumpSwap/Raydium) sells, and swing-mode trades. Jupiter
    abstracts the venue so we never hand-build Anchor instructions.
  - **MEV:** wrap every swap in a **Jito bundle** (atomic, anti-sandwich). Add a
    dynamic **priority fee** (percentile-based) AND a **Jito tip** — they are not
    interchangeable (priority fee = on-chain scheduler signal; Jito tip =
    off-chain auction payment).
  - **Submission:** Helius Sender for lowest latency.
- **Why Jupiter over direct program calls (what chainstacklabs/pumpfun-bonkfun-bot does):**
  the reference bot hand-builds buy/sell instructions from IDL discriminators,
  and its account shape is pinned to the 2026-04-28 pump.fun program upgrade —
  **it breaks on the next pump.fun program change.** Jupiter absorbs that churn.
  We trade a few ms of routing overhead for anti-fragility.
- **Latency budget:** Geyser `processed` event → safety gate (<100ms target,
  on-chain only) → Jupiter quote → sign → Jito bundle via Sender. Blockhash
  cached + refreshed every 5s (chainstack pattern).

### D4 — Safety: **Layered (on-chain → RugCheck → holder analysis → sell-sim)**

> RugCheck is a **first filter, not a verdict.** Academic + community sources
> confirm it misses coordinated multi-wallet rugs, bundled dev buys, and
> fragmented sells. We layer defenses.

**Gate order (fast → slow; fail fast):**

1. **On-chain authority checks (gate, <50ms, mandatory):**
   - Mint authority = null (renounced) — else REJECT.
   - Freeze authority = null — else REJECT.
   - LP/bonding-curve state healthy (not `complete` unless we intend AMM buy).
   These are the strongest, most manipulation-resistant signals and they cost
   one `getAccountInfo` batch.
2. **Holder-distribution analysis (gate, our own code, ~100ms):**
   `getLargestTokenAccounts` → compute top-10 concentration and detect bundling
   (many wallets funded by the same source tx). Reject if dev/insider cluster
   holds > threshold. This catches what RugCheck's per-address check misses.
3. **RugCheck API (enrichment, async, best-effort):**
   `https://api.rugcheck.xyz/v1/tokens/{mint}/report` — adds socials, mint-top-
   holder %, community votes. **Must NOT block the buy path** (rate-limited,
   adds latency); used to *score* and to *log*, with a hard 429 backoff.
4. **Sell-simulation (gate for AMM/swing tokens):** before buying a
   post-graduation token, request a Jupiter **quote for the reverse swap** and/or
   `simulateTransaction`. If we can't sell, we don't buy (honeypot defense).
   On bonding curves this is less critical (permissionless sell) but still run
   it when time allows.
5. **Metadata/social sanity (soft signal):** name/symbol blocklist, social-link
   presence. Not a hard gate, but feeds the score.

**Known blind spots we explicitly accept / mitigate:**
- Fragmented rugs (dumps split across wallets under threshold) — mitigated by
  exit-side monitoring + tight `max_hold_time`, not by entry detection.
- Brand-new tokens have no history — holder analysis is thin in the first
  seconds; we rely on authority checks + small size here.

### D5 — Wallet / key management

- **Verdict:**
  - **Hot wallet** (sniping can't do a KMS/HSM round-trip per trade).
  - **Key storage: OS keychain** (macOS Keychain via `security` CLI or a lib),
    *not* plaintext in `.env` (the reference bot's `.env` approach is explicitly
    "NOT FOR PRODUCTION"). Unlocked once at startup into memory.
  - **Float isolation:** the trading wallet holds only a small **trading float**
    (e.g. 2–5 SOL). Main funds live in a separate, disconnected wallet. Refill
    the float manually.
  - **Kill switch:** (a) global env/flag, (b) a watched file (touch to halt), and
    (c) auto-halt on daily-loss-cap hit or abnormal error rate.

### D6 — Risk limits (configurable, sane defaults)

| Limit | Default | Rationale |
|---|---|---|
| Max $ per trade | 0.1 SOL | small while proving |
| Max % of pool/curve liquidity per trade | 10% | buying more moves price against us + blocks exit |
| Daily loss cap | 3 losing trades **or** 0.3 SOL | stop the bleed |
| Max concurrent positions | 3 | focus + exit capacity |
| Max hold time | configurable (e.g. 10 min) | memecoins decay fast |
| Slippage hard cap | configurable (e.g. 15%) | protect against bad fills |
| TP / SL / trailing | per-strategy | exit discipline |

Every swap carries a `min_amount_out = expected * (1 - slippage)`.

---

## Architecture

```
                 ┌─────────────────────────────────────────────────────┐
   DISCOVERY     │  Geyser gRPC (pump.fun + letsbonk programs)         │ SNIPE
                 │  DexScreener polling (latest profiles/boosts)       │ SWING
                 └───────────────┬─────────────────────────────────────┘
                                 ▼
                 ┌─────────────────────────────────────────────────────┐
   ENRICH        │  pair/token detail: liquidity, volume, age,         │
                 │  buy/sell ratio, FDV (DexScreener + on-chain)        │
                 └───────────────┬─────────────────────────────────────┘
                                 ▼
                 ┌─────────────────────────────────────────────────────┐
   SAFETY GATE   │  1. on-chain authority (mint/freeze renounced)      │
   (fast→slow)   │  2. holder distribution + bundle detection          │
                 │  3. RugCheck enrichment (async, non-blocking)       │
                 │  4. sell-simulation (honeypot)                      │
                 │  5. metadata/social sanity                          │
                 └───────────────┬─────────────────────────────────────┘
                       (most candidates die here)
                                 ▼
                 ┌─────────────────────────────────────────────────────┐
   DECIDE        │  SCORE: volume spike + buy/sell ratio + age +       │
                 │  liquidity + safety score → above threshold?        │
                 │  + risk limits satisfied (D6)?                      │
                 └───────────────┬─────────────────────────────────────┘
                                 ▼
                 ┌─────────────────────────────────────────────────────┐
   EXECUTE       │  Jupiter Ultra quote → add priority fee + Jito tip  │
                 │  → sign → Jito bundle via Helius Sender             │
                 │  (atomic, anti-sandwich)                            │
                 └───────────────┬─────────────────────────────────────┘
                                 ▼
                 ┌─────────────────────────────────────────────────────┐
   MONITOR+EXIT  │  price (DexScreener + on-chain) → TP / SL /         │
                 │  trailing / max_hold_time. Exit via Jupiter + Jito. │
                 │  ATA cleanup (reclaim rent) after sell.             │
                 └─────────────────────────────────────────────────────┘
```

**Modes / switches (non-negotiable):**
- `DRY_RUN=true` (default) — runs the entire pipeline, logs the decision +
  simulated P&L, **sends no transaction.** This is the MVP surface.
- `LIVE=true` — actually swaps. Gated behind explicit config + a wallet with funds.

---

## MVP — zero-risk, no wallet (build this first)

1. **DexScreener client** — discovery (latest profiles/boosts) + pair enrichment.
   Respects rate limits (token bucket).
2. **Safety layer** — start with the on-chain authority gate + holder analysis
   (the parts that need only an RPC, no paid API). Add RugCheck as enrichment.
3. **CLI / `demo`** — prints scored candidate tokens with the full reasoning
   (why kept, why rejected). **No wallet, no swaps, no key.**
4. **Logging** — every decision + reason, to disk, for post-hoc analysis.

Only after this is trustworthy over days of dry runs do we add [layer 3 — execution].

---

## Edge cases & hard truths (nothing missing)

These are the things that *will* bite us if not designed for up front.

1. **DexScreener lag** — seconds-to-minutes. Not used for snipe discovery; only
   swing discovery + price monitoring.
2. **Pump.fun program upgrades break direct calls** — the reference bot's buy ix
   is pinned to the 2026-04-28 upgrade. **We avoid this by using Jupiter**, not
   hand-built instructions.
3. **Transaction confirmed-but-failed** — a tx can confirm yet have `meta.err`.
   Always verify via `getTransaction` and check `meta.err` before treating a buy
   as success (chainstack pattern; keep it).
4. **Blockhash staleness** — cache + refresh every 5s; don't block the buy path
   on a fresh fetch (chainstack pattern).
5. **Token-2022 vs SPL Token** — pump.fun create-v2 uses Token-2022; letsbonk
   defaults to SPL Token. ATA creation must use the matching program. Handle both.
6. **Graduation / migration** — when a bonding-curve token graduates to
   PumpSwap/Raydium, the buy/sell path changes. Listen for graduation events and
   switch execution (Jupiter handles both venues, so this is mostly routing).
7. **MEV / sandwich** — Jito bundles, always, for any size.
8. **Exit liquidity** — you can get stuck unable to sell. (a) Cap trade size vs
   pool liquidity (D6), (b) run sell-simulation before buying, (c) tight
   `max_hold_time`.
9. **RugCheck rate limits + latency** — 429s expected; exponential backoff; never
   on the buy-critical path.
10. **RugCheck blind spots** — coordinated wallets, bundled buys, fragmented
    rugs. Mitigated by our own holder analysis (gate #2) + exit-side monitoring.
11. **RPC rate limits** — token bucket on every RPC call; 429 backoff with
    `Retry-After` (chainstack pattern).
12. **Priority fee starvation** — dynamic fee from `getRecentPrioritizationFees`
    (70th percentile + bump + hard cap, chainstack pattern).
13. **ATA rent leakage** — burn + `closeAccount` after sells (chainstack cleanup
    pattern) or the float bleeds rent over many trades.
14. **Sniper-bot entanglement** — our own early buys look like sniper activity to
    downstream observers; irrelevant to us but relevant if we ever do holder
    analysis on our own positions.
15. **Float refill discipline** — never auto-refill from the main wallet; manual
    only, to cap blast radius.

---

## Tentative stack (to confirm at build time)

- **Language:** TypeScript / Node (aligns with `@solana/web3.js` + Jupiter SDK).
  (Python is viable via `solana-py` — the reference bot uses it — but TS matches
  the broader Solana/JS ecosystem.)
- `@solana/web3.js`, `@solana/spl-token` (+ Token-2022)
- Jupiter Ultra API client
- Helius SDK (RPC, webhooks, Sender, Jito bundle relay)
- RugCheck REST client (our own thin wrapper w/ 429 backoff)
- DexScreener REST client (our own, token-bucketed)
- Config: YAML + env-var substitution; secrets from OS keychain.

---

## Research basis (sources that shaped the decisions)

**Reference repo (real architecture, not marketing):**
`chainstacklabs/pumpfun-bonkfun-bot` — Python, Geyser/logs/block/PumpPortal
listeners, direct program calls (NO Jupiter, NO Jito), **NO safety checks**,
plaintext key in `.env`, buy-ix pinned to 2026-04-28 pump.fun upgrade. We copy
its *patterns* (blockhash cache, 429 backoff, token bucket, percentile priority
fee, tx-confirm-via-meta.err, ATA cleanup) and reject its *fragility + zero safety*.

**Ecosystem 2026:** letsbonk.fun flipped pump.fun mid-2025 (~50% vs ~41% by
mid-2026); both are Solana bonding-curve launchpads → Raydium/PumpSwap on
graduation. EVM is negligible for sniping.

**Execution:** Jupiter Ultra API + Helius Sender + Jito bundles is the documented
2026 best-practice for landing trades; priority fee and Jito tip are distinct and
both needed.

**Safety:** RugCheck is a first filter only; it misses coordinated/fragmented
rugs (academic: "How To Cook The Fragmented Rug Pull", arXiv 2511.15463;
"RPHunter", arXiv 2506.18398). ~98.7% of pump.fun tokens show fraud signs
(Solidus Labs) → safety gate is the product.

---

## For agents reading this

- This is **concept, not code.** Build nothing until the owner approves every
  item in [§ Decisions](#decisions).
- **Build the MVP (dry-run, no wallet) first.** Execution (layer 3) comes only
  after the safety layer is proven trustworthy over many dry runs.
- DexScreener **cannot trade** — never design around it executing anything.
- **Never store keys in plaintext env.** Never auto-refill the float.
- If something here contradicts new research, update *this doc* and re-confirm
  with the owner before acting.
