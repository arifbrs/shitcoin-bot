# Shitcoin — Free-Tier Stack Research (2026-07-20)

> Deep-research pass over 23 sources (official pricing pages, docs, GitHub repos,
> academic papers). Most claims come from **primary sources** but the adversarial
> verification stage was only partially completed (session limits), so treat
> exact numbers (rate limits, fees, prices) as **"verify at signup"** — providers
> change pricing. Directional conclusions are high-confidence.

---

## Verdict for the owner (TL;DR)

1. **A free-tier stack CANNOT win the same-block sniping game — and that's fine,
   because nobody external can.** >50% of pump.fun launches are sniped in the
   creation block itself by deployer-funded insider wallets (87% win rate; 55%
   fully dump within 1 minute). Solana has no global mempool, so same-block entry
   requires knowing the mint in advance (insider coordination). External bots —
   free OR paid — are structurally the exit liquidity for those insiders.
   *(arXiv 2512.11850; Pine Analytics via Solidus Labs)*
2. **Therefore: our "snipe mode" becomes "fast-follow mode"** — enter seconds
   after launch, **after** the safety gate passes. We deliberately skip the
   first block(s) where insiders dump. This converts our latency disadvantage
   into a filter advantage.
3. **The free stack is fully sufficient for the dry-run MVP** (discovery +
   safety gate + scoring + paper trading). Build it now.

---

## 1. Launch detection — what's actually free

| Channel | Free? | Latency class | Notes |
|---|---|---|---|
| **PumpPortal WS `subscribeNewToken` / `subscribeMigration`** | ✅ FREE, keyless | ~1–3s | Best free launch feed. (Their *trade*-stream now costs 0.01 SOL/10k trades since 2026-05-01 — we don't need it.) |
| `logsSubscribe` WebSocket (any RPC incl. Helius free) | ✅ | ~sub-second–2s | Universally supported; the chainstack bot's default listener. |
| Helius LaserStream **WSS** | ✅ (Free+ tier) | claims ~200ms faster than standard WS | Standard WS methods only on free; `transactionSubscribe` needs paid. |
| Helius webhooks | ✅ (free tier, availability of count unclear) | seconds | Fine for monitoring, not entry. |
| **Geyser/Yellowstone gRPC** | ❌ NOT free anywhere | ms | Helius: mainnet gRPC = Business $499/mo. Shyft: $199/mo. Chainstack: paid. |
| Shred delivery / pre-confirmations | ❌ ($800–1000/mo) | sub-ms | The "best for snipers" tier — insider-race gear we don't need. |
| DexScreener polling | ✅ | minutes | Swing discovery + price monitoring only (unchanged from CONCEPT.md). |

Latency reality: polling-RPC pipeline ≈ ~870ms+; Geyser/shreds sub-ms; paid
relays (Helius Atlas ~20ms) vs standard RPC send ~200ms. Free tier is seconds
behind the front — irrelevant once we adopt fast-follow.

## 2. Free RPC tiers (verify at signup)

| Provider | Free tier | Notes |
|---|---|---|
| **Helius** | 1M credits/mo, 10 RPS RPC (2 RPS DAS/Enhanced), **1 sendTransaction/s**, no staked conns, no sendBundle | Solana specialist; WS + webhooks free. First paid: $49/mo (10M, 50 RPS, 5 sendTx/s, staked conns). |
| **QuickNode** | 10M credits/mo, 15 RPS | Most free credits. |
| **Chainstack** | 3M req/mo, 25 RPS | Highest free RPS. |
| **Shyft** | 10 RPC RPS, 1 API RPS, unlimited credits; incl. callbacks + staked connections; NO gRPC | gRPC from $199/mo. |
| Triton | none | Paid HFT infra. |

Plan: **Helius free (primary) + QuickNode or Chainstack free (backup/spread)**.
Multiple free keys across *different providers* is fine; multiple keys at one
provider doesn't multiply limits (Jupiter enforces per-org).

## 3. Safety gate — free tooling

- **On-chain (free, any RPC):** `getAccountInfo` (jsonParsed) → mint/freeze
  authority; `getTokenLargestAccounts` → holder concentration. Cheapest,
  strongest signals. Gate #1–2 as designed in CONCEPT.md.
- **RugCheck:** free with account + API key (`X-API-KEY` header). Reported
  ~10 reports/min unauthenticated, ~60/min authenticated. Returns risk level +
  0–100 score, LP lock, holder data. 429s expected → backoff. Enrichment only.
- **GoPlus:** free base tier; has **Solana** Token Security API, transaction
  simulation API, and a free malicious-address DB (screen deployer wallets —
  cheap, powerful: ~1% of creators produce 50% of all launches).
- **Key new signal from research:** creator-wallet reputation. Serial deployers
  dominate launches; screening the deployer against GoPlus malicious DB + our
  own "seen this deployer rug before" cache is nearly free and high-yield.
- Typical rug completes **in under 5 minutes** → max-hold-time and exit logic
  must operate on a minutes-or-faster timescale.

## 4. Execution (for later — NOT built in MVP)

- **PumpPortal Local Transaction API:** builds unsigned tx, we sign + send via
  our own RPC. **0.5% fee/trade** (Lightning variant 1%). Covers pump.fun curve,
  PumpSwap, Raydium (+LaunchLab/CPMM), letsbonk — one API for all venues, with
  slippage/priority-fee params and Jito bundle support. → Bonding-curve path.
- **Jupiter (free key): 1 RPS / 60 rpm shared bucket** across Swap/Price/Token
  APIs (keyless: 0.5 RPS). Execute/submit endpoints have separate 20–100 RPS
  buckets. → Fine for swing trades + sell-simulation, NOT for hot polling.
- Helius free tier's **1 sendTransaction/s** caps live trade throughput; fine at
  our trade frequency (max 3 concurrent positions).
- Post-graduation venue is **PumpSwap** (pump.fun's own AMM), not Raydium
  (confirmed 3-0). Buy instructions changed at the 2026-04-28 program upgrade
  (confirmed 2-0) → validates CONCEPT.md's choice to avoid hand-built
  instructions; PumpPortal/Jupiter absorb that churn.

## 5. Reality check (the numbers)

- **98.6%** of pump.fun tokens = rug/pump-and-dump patterns; only ~97k of 7M+
  tokens ever held >$1k liquidity (~1.4%). **<2% graduate.** (Solidus Labs)
- **93%** of Raydium V4 pools showed soft-rug characteristics; median rug ≈ $2.8k.
- Insider same-block snipers: 15,000+ SOL net profit in one month across 15k+
  launches; 4,600+ sniper wallets funded by 10,400+ deployers.
- Open-source reference bot (chainstacklabs) carries educational-only
  disclaimer, makes **no profitability claims**.
- Conclusion: profit, if any, comes from **selection (the gate), not speed**.
  Dry-run P&L simulation over days/weeks is the only honest way to find out —
  which is exactly the MVP.

## 6. Revisions to CONCEPT.md decisions

| Decision | Change |
|---|---|
| D2 Snipe mode | → **Fast-follow mode**: enter seconds post-launch, post-gate. Never compete for block 0. Discovery via PumpPortal WS (free) + logsSubscribe fallback. |
| D3 Execution | Jupiter stays for swing + sell-sim; **PumpPortal Local API (0.5%)** for bonding-curve trades. Geyser dropped (not free). Jito via PumpPortal bundles when live. |
| D4 Safety | Add **deployer-reputation check** (GoPlus malicious DB + local rug-history cache) as gate #2.5. |
| D6 Risk | Max hold ≤5 min for fast-follow. **Asymmetric exit model (2026-07-20):** fixed take-profit removed — a memecoin can run 10-100x, so a fixed TP clips winners. Instead: **trailing stop** (arms at +25%, exits on 35% pullback from peak) lets runners run; **hard stop -35%** + short max-hold cut losers fast; many small bets (max 5 concurrent). |
| Targeting (new) | Target **small marketcap** (hard-drop MC > $300k; sweet-spot bonus < $100k) + **community momentum** score (buy velocity, holder count from RugCheck, socials present, boost). The edge is small-cap + real crowd forming, not mature-crypto metrics. |
| Paper validity (new) | P&L is now **net of modeled fees + slippage** (0.5%/side + liquidity-based slippage 2-8%); positions **persist to disk** (no orphaned opens); dashboard reads the authoritative ledger from `positions.json`. |
| Dev-wallet tracking (new) | Track the creator wallet's token holding over time (`getTokenAccountsByOwner`): **DEV_DUMP** (creator sells ≥50% of entry holding → exit the position, rug escape) and **DEV_BUYBACK** (creator's holding grows ≥0.3% of supply → long-term-conviction signal; defers the max-hold cap so a committed dev's coin can keep running). Creator comes from PumpPortal (fast-follow) or RugCheck (swing). **Blind spot:** a dev buying back via a *separate* wallet is not caught — same limitation as bundling. |
| Dev "only-buys" history (new) | At entry, scan the creator's last 20 txns (`getSignaturesForAddress` + `getTransaction`, diff their token balance per tx) → **DEV_ONLY_BUYS** when the dev has only ever bought this token, never sold ("dev yakin MC naik"). Sets a conviction flag that also defers max-hold. Verified live: real detections (LOSTBULL, Heaven). Best-effort, bounded, per opened position only. |
| Distribution signal (new) | **Holders-per-marketcap** score bonus: small MC + many holders = organic/distributed = the owner's "acuan kemenangan". `holders / (MC/$10k)`, graded, capped +18. Needs holder count (RugCheck) — sparse without a RugCheck key. |
| Real-time dev watch (new) | Dev DUMP/BUYBACK detection moved off the 20s poll onto **WebSocket push** (`logsSubscribe` mentions=creator over the RPC WS): the instant a watched dev transacts we re-check — **verified sub-second (first push +0.89s)**. 20s poll kept as backstop. Console shows per-position dev indicators (square-dot, no emoji: Dev only-buys / buy-back / watched / unknown) and a colored dot per exit reason in the ledger. |
| Connect Phantom / fund flow (new, 2026-07-20) | Controls view now has a **Connect Phantom** button — the architecturally-correct use of connect-wallet: NOT for trading (bot auto-signs from its own key), but to **fund the bot's float**. Flow: connect via `window.solana` → show user address+balance → enter SOL amount → server builds the transfer blockhash (`/api/blockhash`, keeps Helius key server-side) → `window.solana.signAndSendTransaction` (user approves in Phantom) → SOL moves user→bot. web3.js served locally from node_modules (`/vendor/solana-web3.js`, no CDN — VPS/offline-safe). The bot address (`ayDYr5jGkV83…`) is a REAL mainnet keypair (verified on-curve, has a Solscan page) that receives real SOL; key in gitignored `.keys/`. Phantom popup itself is user-side (untestable here); endpoints + page verified. |
| Web remote-control (new, 2026-07-20) | The console is now a real remote control (VPS-ready): a **Controls** view (sidebar 06) with Pause/Resume scanner + Exec-mode switch (dry-run/simulate/devnet; Live is a disabled locked button) + Bot-wallet panel (address + balances). Bot and web are separate processes; they coordinate via `logs/control.json` (`src/control.ts` — web writes, bot polls each candidate). Endpoints: POST `/api/control` (auth-gated, live is hard-blocked server-side too), GET `/api/wallet`. Verified live: pausing from the browser actually stops the bot opening positions, cross-process, no restart. `npm start` still launches everything in one command. |
| Execution layer / live-phase prep (new, 2026-07-20) | Built a staged executor with `EXEC_MODE` (dry-run → simulate → devnet → live). **simulate**: builds the REAL pump.fun buy tx via PumpPortal trade-local (verified: 641-byte unsigned tx) and runs `simulateTransaction` on mainnet — validates the trade would actually LAND (catches honeypots/edge cases). No send, ~free; needs ~0.05 SOL in the bot wallet (never spent) for the buy-sim to complete, else logs needsFunding. Wired into paper trader (logs exec-sim events per entry, verified live). **devnet**: full keypair+sign+send+confirm self-transfer plumbing test (code verified; blocked only by devnet faucet daily rate-limit). Dedicated bot wallet (`ayDYr5jGkV83…`) in gitignored `.keys/` (0600). **LIVE is hard-blocked** in code until keychain key storage exists — never real money from a plaintext key. CLI: `npm run wallet [status|devnet-test|simulate <mint>]`. Still unvalidatable without real money: landing latency + MEV. |
| Measured cost, not guessed (new) | The biggest paper-trading assumption was slippage (a guessed 8/4/2% bucket). Now **measured**: fast-follow uses **exact bonding-curve math** (buy moves avg price by exactly solIn/vSolReserves — verified ~1.67% round-trip for 0.1 SOL vs the old 9% guess); swing uses **Jupiter live quotes** (`api.jup.ag/swap/v1/quote`, real priceImpactPct both ways — BONK measured ~1.02%). Plus a **Jupiter sell-simulation** (reverse quote) that skips honeypots / one-way-liquidity tokens before entry. SOL/USD price derived from a real Jupiter quote. Cost is fixed at entry per position (`costPct`) and P&L is net of it. Jupiter free key in .env (JUPITER_API_KEY). Still NOT modeled (only a live micro-test can prove): latency-to-fill, our own tx landing, MEV/sandwich. |
| Live-monitoring fixes (2026-07-21) | Watched it trade live and fixed two findings: **(A)** stop-loss slipped badly (set −35%, one trade filled at −63.5%) because a single 20s poll missed fast memecoin dumps — split into two timers: fast-follow polls every **4s** (cheap bonding-curve reads), swing every 20s. Stop now fires near threshold. **(B)** gate pass-rate was ~48% (too loose for a 98.6%-rug market) — added `minScoreToOpen` (default 62): passing the hard gate no longer buys; the momentum/dev/metadata **score** must clear the bar too, turning soft signals into a real entry filter. Verified live (candidates scoring 50 now filtered). |
| Solscan Pro (rejected 2026-07-21) | Owner supplied a Solscan API key, but it is **free-tier**: every V2 Pro endpoint (token holders, account defi-activities, token meta, even monitor/usage) returns 401 "upgrade your api key level". Not integrated — it would 401 on every call. Everything it offers we already have free: holders (RugCheck + getTokenLargestAccounts), dev trade history (Helius getSignatures+getTransaction), metadata (on-chain Metaplex), price (Jupiter/curve/DexScreener). Do NOT pay for Solscan Pro at this stage. |
| Correctness audit (2026-07-21) | Ran the stack live and audited every calculation. Fixed: **(1)** a rug (`LIQUIDITY_GONE`, price 0) could log a loss worse than −100% (−100 − cost) — now floored at −100% and only buy-side cost applies when you can't sell. **(2)** `metadata-immutable` was double-counted in scoring (once in the generic soft-check loop at ±8, again explicitly at +6/−10) — excluded from the generic loop. **(3)** ambiguity: `rugcheck-score` always scored +8 regardless of risk; verified RugCheck normalised score direction (LOWER=safer: USDC=1, BONK=7, risky≈70+) and now penalise elevated-risk tokens (−8 above 20/100). **(4)** logic: a committed-dev position (buy-back / only-buys) whose price stayed between −35% and +25% could stay open forever (defers max-hold, never arms trailing) — added a 12h absolute hard cap. **(5)** display: fast-follow positions showed MC "—" (only USD populated) — now show marketCapSol in SOL. All verified live, typecheck clean. |
| Feeling Agent — LLM vibe judge (2026-07-21) | Added the "right-brain" the metric gate lacked. An LLM judges each OPEN position's vibe (momentum alive/dying/dead) from its momentum picture, and exits (FEELING) when confidently bearish — flexible reasoning, not rigid rules. `src/execution/feeling-agent.ts`, fired async (never blocks the tick), throttled to once/90s per position, best-effort (skips on failure). Verified live: `BUNK → dying (75%): "Panic low holders, zero momentum, flat trend = imminent death" → exit`. **LLM caveat:** owner's Anthropic Pro subscription does NOT work for API (separate product). Two sketchy relays were REJECTED (one served HTML not API; hcnsec.cn works but is an unofficial China relay serving Chinese open models — NOT Claude — via the Anthropic format). Using it because the input is NON-SENSITIVE (token metrics only, never keys/wallet) and **Qwen3.5-397B** gave genuinely good judgments; config in .env (FEELING_LLM_*, leave key empty to disable). For production, an official Anthropic/OpenRouter key or local Ollama is safer. |
| Strategy reshape: sniper-entry + hold-while-busy (2026-07-21, owner-directed) | Owner clarified their winning style: KEEP the sniper (early/cheap entry at the open) but HOLD while the token is busy (rame) and exit when it goes quiet (sepi) — not on a 5-min timer. "Win-rate doesn't matter, memecoin is judged by PnL." Implemented: fast-follow max-hold extended 5min→**3 days** (backstop); the real exit is a new **QUIET signal** — track the bonding curve's SOL reserve (vSol, rises as people buy = activity); if it makes no new high for `quietWindowMs` (default 180s) after a 45s min-hold, momentum is dead → exit QUIET. Swing uses DexScreener 1h volume as the same activity proxy. Verified live: positions track peakVSol + "sepi_selama" (time since last activity high); tokens going quiet approach the 180s exit. Kept dev-dump escape, trailing (drastic drop), partial-TP. Owner also raised: (a) trailing = fees — clarified it's 1 sell/position, cost already modeled; (b) can the bot have "feeling"? — proposed an LLM "Feeling Agent" (vibe/FOMO judge using metrics + LunarCrush social) as the next step, not yet built. |
| LIQUIDITY_GONE false-positive fix (2026-07-21) | Monitoring recap found LIQUIDITY_GONE (−100%) was the dominant loss (5 of 35 trades one session). Bug: a SINGLE failed price read after 60s booked a total loss — but a failed bonding-curve/DexScreener read is often a transient RPC/API hiccup, not a rug. Fixed: require **3 consecutive** failed reads before realizing −100% (`priceFailCount`, reset on any good read). Removes false total losses. |
| Postgres / Supabase persistence (2026-07-21) | Added a Supabase-ready DB layer (`src/db.ts`, `pg`). Set `DATABASE_URL` (local Postgres OR Supabase — same code/schema, migration = swap the URL) → `npm run db:init` creates tables (decisions, trades, events), then every `logRecord` **dual-writes** to files AND Postgres. Files stay the source of truth; DB is additive and no-op when DATABASE_URL is unset (nothing breaks). Verified end-to-end against a real local Postgres (schema + dual-write + read-back). |
| Batch upgrade from 2 forensics PDFs (2026-07-21) | Owner supplied "Analisis Ekosistem Memecoin" + "Forensik On-Chain / Meteora DLMM" PDFs. Key find: **Jupiter `tokens/v2/search`** (free, works keyless via lite-api, indexes brand-new tokens) returns organicScore, devBalancePercentage, devMints, topHoldersPercentage, holderCount, liquidity, mcap, and 5m trader stats — delivering most of both PDFs' signals from ONE endpoint. Built `src/safety/jupiter-token.ts` + wired into gate: **HARD** rejects for serial-deployer (devMints>500 — a fresh token's dev had 4893 mints), dev-balance >15% (bundled dev-buy), liq/MC ratio <5% (slippage-bomb); **SOFT** organic-score (+10/-8) and wash-trade micro-bundle (numTraders≤1 with ≥5 txns → -12). Also added: **partial take-profit** (bank 50% at +100%, rest trails — addresses the +61%→-1.8% round-trip), **dev-dump haircut** (-25%, since we can't fill at pre-dump price — makes DEV_DUMP wins honest), **restart guard** (skip snapshot positions already closed in the log — fixes the duplicate-close artifact), and **SOL-accounting for partials** (PARTIAL events banked separately; server sums CLOSE legs + PARTIAL). All verified live, typecheck clean. Meteora DLMM noted as a separate LP/yield mode (not sniping) — deferred. Still pending: smart-money wallet source (PDFs gave methodology, not a wallet list). |
| Sniper tuning (new, 2026-07-21) | "Buy before listing" is impossible on pump.fun — a token is tradeable the instant it's created; there is no pre-listing window, and only the deployer knows the mint before creation (same-block = insider-only). "Seconds after, small MC" IS fast-follow. Added a **hard snipe-MC ceiling** (`snipe-mc-ceiling`, `SNIPE_MAX_MC_SOL`, default 80 SOL) using pump.fun's `marketCapSol` — previously the MC ceiling only applied to swing (USD), so fresh snipes weren't MC-gated. Fresh curves measured 28-38 SOL (~$2-3k). Also made the settle delay tunable (`SNIPE_SETTLE_MS`, min 2s): lower = earlier/smaller-MC entry but thinner safety data + more insider-dump risk. Both shown in the console System panel. |
| Fast-follow pricing (new) | Brand-new tokens aren't on DexScreener yet, so paper entries used to fail ("no price, cannot simulate entry") — meaning fast-follow (our edge mode) was gated but never simulated. **Fixed:** price fast-follow from the pump.fun **bonding curve** — entry from the PumpPortal event (`vSolInBondingCurve/vTokensInBondingCurve`), live exits by reading the bonding-curve account on-chain (`bondingCurvePriceSol`, layout verified: u64 vTokenReserves@8, vSolReserves@16, complete@48). Positions carry a priceMode (sol vs usd). Graduation (`complete=true`) auto-closes the position (GRADUATED) since the venue/units change. Verified live: fast-follow now opens + tracks real P&L (+35%, -22%…) + DEV_DUMP escapes priced from the curve. |
| Web app v2 (new) | Private console rebuilt as an **app shell**: fixed sidebar menu with distinct views (Overview / Positions / Gate / Decisions / Ledger) via hash routing — clearly separate from the public landing. Live updates via **Server-Sent Events** (`/api/stream`, auth-gated; server `fs.watch`es the log dir and pushes a fresh snapshot on any change — verified ~instant), with a 5s poll only as fallback if the stream drops. No emoji anywhere — indicators use the Technical-Minimalist square-dot style. |

## 7. Services to register (all free)

1. **Helius** — free API key → RPC + WS + webhooks. *(primary RPC)*
2. **QuickNode or Chainstack** — free key → backup RPC.
3. **RugCheck** (rugcheck.xyz) — account + API key (shown once — save it).
4. **GoPlus** — free tier key for Solana token security + malicious address DB.
5. **Jupiter** (portal) — free API key (1 RPS) for later swing/sell-sim.
6. PumpPortal — **no signup needed** for the WS feed we use.

DexScreener: no key needed.

---

## 8. Reference-repo audit (2026-07-20) — READ THIS

Owner supplied 10 GitHub repos + DexScreener WS docs. All cloned and read at
source level (not just READMEs). Verdicts:

| Repo | Verdict | Why |
|---|---|---|
| **origami-xyz/shitcoin-sniper-bot** | 🚨 **MALWARE — DO NOT RUN** | `src/utils/nodewin.js` XOR-decrypts (`^4`) a bundled `node.log` into `node.exe` and silently `spawn`s it detached on Windows. Ships `private_keys.txt`, `proxies.txt`, a .NET `nodewin.dll`. Classic trojan dropper disguised as an "airdrop/sniper checker". Quarantined in scratchpad; never copy from it. |
| **Tronzit-Veca/Shitcoin-Raydium-bot** | ⚠️ Rug-*creation* toolkit | Not a sniper — it's the attacker's tool: `createPool`, `create-and-buy`, `removeLiquidityFaster`, `revokeAuthority`. No exfiltration found, but it's for *making* rugs. Value to us = reverse map of what our gate must catch (dev buys same block, then fast LP pull). Its Jito bundle code is a valid reference only. |
| **w3laba/DexScreener-Trending** | ⚠️ Manipulation bot | Puppeteer + proxy farm to fake DexScreener "trending". Confirms boosts/trending are gameable → we treat boost as a *soft* score signal only, never a gate. |
| **hedgey-finance/dexscreener-api** | ✅ Benign, outdated | Clean TS client but uses the old `dexscreener.io/latest/dex` base. Reference only; our own client is current. |
| **greengod63/DexScreener-Scraping** | ✅ Benign, off-target | Python, Etherscan/EVM supply checks. Not Solana. |
| bscscan-python, BscScan, layerzero-shitcoin, shitfolio, 26medias/shitfolio | ✅ Off-target | EVM/BSC tooling; irrelevant to a Solana bot. |

**Rule going forward:** never run or copy code from random "sniper/shitcoin"
repos. They are a top malware/wallet-drainer vector. We build our own; we read
theirs only as reference, sandboxed.

### Second dissection (2026-07-20) — trading-flow ideas
Dissected 3 more repos at source level (audited clean: no malware/exfil/postinstall):
- **solana-labs/solana** — the Rust protocol monorepo, not a bot. Nothing directly usable.
- **fs260338508512481/solana-pumpfun-sniper-trading-bot** — Raydium CPMM sniper (Geyser listener → queue → Jito). Clean; keys are local-signing from .env (the "not for prod" plaintext pattern).
- **cortsdine/solana-trading-bot-v3** — Raydium sniper with a **pluggable executor** interface + **filters**.

**Adopted (built + verified live):**
- **Mutable-metadata signal** — read the Metaplex metadata account on-chain; `isMutable=true` means the dev can still change name/image/socials after launch (bait-and-switch vector). New soft gate check `metadata-immutable` (+6 immutable / −10 mutable). Our own hand-rolled borsh parser, verified against BONK.
- **On-chain socials at launch** — parse the metadata `uri` JSON for twitter/telegram/website, so **fast-follow** tokens get a community signal before DexScreener indexes them (previously only swing had socials).

**Noted for LIVE phase (their executor pattern, not built — live-only, untestable dry):**
- **Pluggable `executeAndConfirm` executor** with a retry loop (`maxBuyRetries`) — send buy N times until confirmed. This is the right abstraction for our live send path.
- **Jito multi-region bundle executor** — submit the (tip-tx + swap) bundle to ALL Jito regional block-engines in parallel (mainnet/amsterdam/frankfurt/ny/tokyo), random tip account, tip via `SystemProgram.transfer`. This is the anti-MEV / competitive-landing piece for when we go live.
- **Bounded TP/SL polling** (`timesToCheck = duration/interval`) — we already do better (trailing stop + dev-dump escape), so kept ours.

### DexScreener WebSocket — VERIFIED LIVE, now integrated
`wss://api.dexscreener.com` (needs `Origin: https://dexscreener.com` header)
pushes snapshot streams, no key: `/token-profiles/latest/v1`,
`/token-boosts/latest/v1`, `/community-takeovers/latest/v1`, `/token-boosts/top/v1`,
`/ads/latest/v1`. All three we use tested live and returning data.
→ Replaced 30s REST polling with real-time push (`src/discovery/dexscreener-ws.ts`).
Boosts feed the score (+8, soft); community-takeovers are a distinct swing signal.
