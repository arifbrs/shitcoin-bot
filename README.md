# Shitcoin — Memecoin Trading Bot

> **Status: DRY-RUN MVP BUILT (2026-07-20).** The zero-risk pipeline (discovery →
> safety gate → scoring → paper trading) is implemented and live-tested. No
> wallet, no transactions — see [Run the MVP](#run-the-mvp). Free-tier stack
> research: [`RESEARCH.md`](RESEARCH.md). Decisions: [`CONCEPT.md`](CONCEPT.md).

## Run it

```bash
cp .env.example .env   # paste free keys (Helius, RugCheck) + set DASHBOARD_PASSWORD
npm install
npm start              # runs the scanner + web together (one command)
```

Then open **http://localhost:4317** → landing page → **Sign in** (password from
`DASHBOARD_PASSWORD`, default `shitcoin`) → private console.

Works without any keys (public RPC, slower). Every decision + simulated trade is
logged to `logs/*.jsonl`. Modes: **fast-follow** (PumpPortal free WS, enters
seconds post-launch AFTER the gate — never competes for block 0, which is
insider-only) and **swing** (DexScreener real-time WS). Pass a mode with
`npm start -- --mode swing`.

### Web app (Shitcoin console)

Three pages, session-authenticated:

- **`/`** — public landing (what Shitcoin is, the 4-layer pipeline)
- **`/login`** — sign-in gate
- **`/app`** — private console: cumulative paper P&L, pass rate, gate
  effectiveness (what kills candidates), live decision + trade ledgers.
  Read-only — it observes `logs/*.jsonl`, it cannot place trades. Auto-refreshes
  every 5s.

Run pieces separately if you prefer: `npm run demo` (scanner only),
`npm run web` (web only).

> Original vision below (2026-06-21) — kept for context.

> **Status: PLANNING / IDEA STAGE — nothing built yet (as of 2026-06-21).**
> This document captures the vision so it isn't lost, and so any agent or
> developer understands *what* we're building, *why*, and *how* — **before**
> writing a single line of execution code. Read this fully first.

---

## Why (owner's intent)

Trade memecoins listed on [DexScreener](https://dexscreener.com) with a powerful,
automated bot. Goal: find promising new tokens early, filter out the scams, and
trade them on-chain — without babysitting charts manually.

This is a **separate project** from `pumpcloud-bot` (the Binance-futures bot).
They share *patterns*, not code — see [§ Relationship to pumpcloud-bot](#relationship-to-pumpcloud-bot).

---

## The one fact that shapes everything

**DexScreener's API is READ-ONLY market data. It cannot place trades.**
It is *eyes, not hands.* Discovery and monitoring come from DexScreener; the
actual buying/selling happens **on-chain** (e.g. Jupiter on Solana). Never design
around DexScreener "executing" anything.

---

## Architecture — 4 layers

DexScreener is only **layer 1**. A bot that just reads DexScreener and apes in
will get rugged. The value is in layers 2 and 3.

```
[1] DISCOVERY   — find new tokens / volume spikes
      DexScreener (token-profiles, boosts) + IDEALLY listen to the chain directly
      (new-pool events) because DexScreener lags by seconds–minutes.

[2] SAFETY / RUG CHECK   — THIS is what decides profit vs loss
      LP locked/burned? mint authority renounced? freeze authority revoked?
      holder distribution (does the dev hold >X%?)? is it a honeypot (can you SELL)?
      Tools: RugCheck (Solana), GoPlus Security API, Honeypot.is (EVM), Birdeye.

[3] EXECUTION   — on-chain swap (DexScreener CANNOT do this)
      Solana: Jupiter aggregator API + wallet keypair + RPC (Helius/Triton)
              + priority fees, optionally Jito bundles to dodge sandwich/MEV.
      EVM (Base/BSC): 0x / 1inch / Uniswap router.

[4] RISK MGMT   — position sizing, TP/SL/trailing, max % of pool liquidity per
      trade, anti-MEV. Note: memecoins are illiquid — exits can slip badly or
      fail entirely. Plan exits as carefully as entries.
```

---

## End-to-end flow

```
poll DexScreener new-pairs/boosts (respect 60/min)
  -> enrich: fetch pair detail (liquidity, volume, age, buy/sell ratio, FDV)
  -> SAFETY GATE: RugCheck/GoPlus — drop tokens with unlocked LP / un-renounced
                  mint / dev concentration / honeypot. Most candidates die here.
  -> SCORE/DECIDE: volume spike + buy/sell ratio + age + liquidity >= threshold
  -> EXECUTE swap (Jupiter quote -> sign with wallet -> send via RPC + priority fee)
  -> MONITOR position (DexScreener price + on-chain)
  -> EXIT: TP / SL / trailing — mind liquidity & slippage
```

---

## DexScreener API cheat-sheet (so we don't re-research)

- **Base URL:** `https://api.dexscreener.com`
- **No API key** needed for public endpoints. Free, rate-limited. Paid plan for higher limits.
- **Polling only** — no websocket/streaming in the public API.
- **Read-only.** No trading.

| Endpoint | Returns | Rate limit |
|---|---|---|
| `GET /token-profiles/latest/v1` | newly listed tokens (discovery feed) | 60/min |
| `GET /token-boosts/latest/v1` · `/top/v1` | boosted (paid-promo) tokens — hype signal & shill signal | 60/min |
| `GET /latest/dex/search?q={query}` | search pairs | 300/min |
| `GET /latest/dex/pairs/{chainId}/{pairId}` | pair detail: price, liquidity, volume, txns, FDV, age | 300/min |
| `GET /token-pairs/v1/{chainId}/{tokenAddress}` | all pairs for a token | 300/min |
| `GET /tokens/v1/{chainId}/{tokenAddresses}` | token data, batch (<=30 addresses) | 300/min |

Docs: <https://docs.dexscreener.com/api/reference>

---

## Open decisions — DECIDE BEFORE BUILDING EXECUTION

1. **Chain?** Solana (recommended — most memecoins live on Pump.fun → Raydium) vs EVM (Base/BSC).
2. **Strategy?**
   - *Snipe new launches* → must listen to the chain directly (Helius webhooks / Geyser gRPC); DexScreener alone is too slow to be first.
   - *Swing tokens that already have volume* → DexScreener polling is enough.
3. **Execution venue + RPC provider** (Solana: Jupiter + Helius/Triton).
4. **Safety API** (RugCheck vs GoPlus vs both).
5. **Wallet / key management** — hot wallet, key storage, spend limits, kill switch.
6. **Risk limits** — max $ per trade, max % of pool liquidity, daily loss cap.

---

## Hard truths / risks (do not ignore)

- **DexScreener lags.** By the time a token trends on its API, the early entry is often gone. To be early you must read the chain directly.
- **Most "opportunities" are scams.** Rugs, honeypots, bundled dev buys. The safety layer is the product; the data is the easy part.
- **MEV / sandwiching** is real on-chain — priority fees / Jito matter.
- **Illiquidity** — you can get stuck unable to exit. Size accordingly.
- This is a fundamentally **higher-risk, lower-predictability** domain than the Binance-futures bot.

---

## Relationship to pumpcloud-bot

Reuse the **pattern only**, never the code:

- `scanner -> gate -> Hermes -> execution` pipeline shape — copy the idea.
- **Hermes (via 9router)** can serve as the "second brain" scoring a token's legitimacy.
- Everything else is different: execution is a Solana wallet + Jupiter (not ccxt/Binance), gates are on-chain rug checks (not funding/RSI). **Do not import from pumpcloud-bot.**

---

## Suggested first milestone (MVP — zero risk, no wallet)

Build the read-only half first to prove the data pipeline before touching money:

1. DexScreener client (discovery: latest profiles/boosts + pair enrichment).
2. Safety filter (start with one provider, e.g. RugCheck or GoPlus).
3. A `demo`/CLI that prints scored candidate tokens — **no wallet, no swaps.**

Only after this is trustworthy: add layer 3 (wallet + Jupiter execution) behind a
clear live/dry-run switch.

---

## Tentative stack

TypeScript / Node · `@solana/web3.js` · Jupiter API · RugCheck / GoPlus · a paid
Solana RPC (Helius). To be confirmed once the open decisions above are settled.

---

## For agents reading this

- This project is **planning-only**. No code exists yet.
- **Do not build execution (wallet/swaps) before the safety layer**, and not before the owner has settled the [open decisions](#open-decisions--decide-before-building-execution).
- DexScreener cannot trade — don't design around it doing so.
- Keep it minimal; this is an idea being shaped, not a spec to maximally implement.
