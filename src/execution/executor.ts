import { Connection, VersionedTransaction, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "../config.js";
import { logRecord } from "../util/log.js";
import { botWallet } from "./wallet.js";
import { guardBuy, recordSpend, liveAllowed, liveExitAllowed, reconcile } from "./guardian.js";
import { pooledRpc } from "../safety/onchain.js";
import { poolBalanceSol, poolSendRawTransaction, poolSignatureStatus, signatureSubscriptionConn } from "./rpc.js";
import { jupiterSwapTx } from "./jupiter.js";
import { okxSwapTx } from "./okx.js";

/**
 * Execution layer. Builds REAL pump.fun transactions (via PumpPortal Local API)
 * and either simulates them against mainnet (no send, ~free) or — on devnet —
 * signs+sends+confirms to validate the plumbing. LIVE sends are hard-blocked.
 */

/** Build a real, unsigned pump.fun trade transaction via the PumpPortal Local API. */
async function buildTradeTx(
  pubkey: string,
  action: "buy" | "sell",
  mint: string,
  amount: number | string,
  denominatedInSol: boolean,
  pool = "auto",
  slippagePct: number = config.exec.slippagePct,
): Promise<Uint8Array | null> {
  // QUEUE-DEADLOCK FIX (2026-07-28): this fetch had NO timeout at all, unlike every other network
  // call in the codebase (fetchJson defaults to 10s via AbortController). simulateBuyMainnet calls
  // this BEFORE its own properly-bounded RPC simulate leg, and arm-coordinator.ts's drainEntryQueue
  // awaits the whole chain inside a try/finally with no external timeout — if PumpPortal's
  // trade-local endpoint ever stalls instead of erroring, this hangs forever, `entryRunning` never
  // resets to false, and the ENTIRE single-worker entry queue deadlocks permanently (every session,
  // old and new, piles up in pending-entry with no way out but a process restart). Found live:
  // after the admission-sampling fix, the queue was STILL stuck — arm-coordinator's own bookkeeping
  // pointed to a genuinely-hung request here, not remaining volume.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(config.exec.pumpPortalTradeLocalUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: pubkey,
        action,
        mint,
        denominatedInSol: denominatedInSol ? "true" : "false",
        amount,
        slippage: slippagePct,
        priorityFee: config.exec.priorityFeeSol,
        pool,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > 100 ? buf : null; // <100 bytes = an error body, not a tx
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Build a real, unsigned pump.fun BUY tx (amount in SOL). */
export function buildBuyTx(pubkey: string, mint: string, sizeSol: number, pool = "auto", slippagePct?: number): Promise<Uint8Array | null> {
  return buildTradeTx(pubkey, "buy", mint, sizeSol, true, pool, slippagePct);
}

/** Build a real, unsigned pump.fun SELL tx (amount in tokens). */
export function buildSellTx(pubkey: string, mint: string, tokenAmount: number | string, pool = "auto"): Promise<Uint8Array | null> {
  return buildTradeTx(pubkey, "sell", mint, tokenAmount, false, pool);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Confirm a signature — websocket push RACED against adaptive polling.
 *
 * The old loop was poll-only at a flat 1.5s cadence: a tx landing 400ms after send waited
 * ~1.1s more to be noticed, on every buy AND every sell. Two changes, both strictly
 * latency-only (the outcome semantics are byte-for-byte the old ones):
 *
 *   · WS subscription (`signatureSubscriptionConn`) fires the moment the block lands. A dead or
 *     throttled socket is inherently harmless — it just never fires, and polling carries on.
 *   · Polling starts IMMEDIATELY and runs 600ms while young, relaxing to 1.5s after 6s. The
 *     first poll already existed; the tight early band is what catches fast landings without
 *     paying the full-rate cost in the long tail (same shape as `waitForMintVisibility`).
 *
 * A TIMEOUT is still NOT a failure — the tx may still land — so it is reported distinctly so
 * the caller reconciles by on-chain balance rather than assuming either outcome.
 */
const SOL = "So11111111111111111111111111111111111111112";
const CONFIRM_COMMITMENT = "confirmed" as const;
const CONFIRM_FAST_POLL_MS = 600;
const CONFIRM_SLOW_POLL_MS = 1_500;
const CONFIRM_FAST_WINDOW_MS = 6_000;

interface ConfirmOutcome {
  confirmed: boolean;
  timedOut: boolean;
  err: string | null;
  /** Which leg won the race — the only way to know the websocket is actually contributing. */
  via: "ws" | "poll" | "timeout";
  ms: number;
}

async function confirmSig(sig: string, timeoutMs = 30_000): Promise<ConfirmOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let removeListener = () => {};

    const settle = (r: Omit<ConfirmOutcome, "ms">) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      clearTimeout(deadline);
      try { removeListener(); } catch { /* listener may already be auto-removed */ }
      resolve({ ...r, ms: Date.now() - start });
    };

    // Deadline last, so `settle` can always reference it.
    const deadline = setTimeout(() => settle({ confirmed: false, timedOut: true, err: "confirmation timeout", via: "timeout" }), timeoutMs);

    // Push leg: notification arrives within ms of the block landing. First of the two legs wins.
    try {
      const conn = signatureSubscriptionConn();
      if (conn) {
        const sid = conn.onSignature(sig, (result) => {
          settle(
            result.err
              ? { confirmed: false, timedOut: false, err: JSON.stringify(result.err), via: "ws" }
              : { confirmed: true, timedOut: false, err: null, via: "ws" },
          );
        }, CONFIRM_COMMITMENT);
        removeListener = () => { void conn.removeSignatureListener(sid); };
      }
    } catch { /* fall back to polling alone */ }

    // Poll leg: never sleeps before its FIRST check (the old code's immediate poll is preserved),
    // then tight while young, relaxed in the tail where each extra call buys nothing.
    const poll = async () => {
      try {
        const st = await poolSignatureStatus(sig);
        if (st.err) return settle({ confirmed: false, timedOut: false, err: st.err, via: "poll" });
        if (st.confirmed) return settle({ confirmed: true, timedOut: false, err: null, via: "poll" });
      } catch {
        // A poll that could not reach ANY endpoint says nothing about the transaction. Keep
        // polling until the deadline; the caller reconciles by balance either way.
      }
      pollTimer = setTimeout(poll, Date.now() - start < CONFIRM_FAST_WINDOW_MS ? CONFIRM_FAST_POLL_MS : CONFIRM_SLOW_POLL_MS);
    };
    void poll();
  });
}

/**
 * Same poll, but against an explicit Connection — for DEVNET only. The mainnet pool cannot be
 * used there: it is a different network, and a devnet signature will never appear on it.
 */
async function confirmSigVia(conn: Connection, sig: string, timeoutMs = 30_000): Promise<{ confirmed: boolean; timedOut: boolean; err: string | null }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const st = await conn.getSignatureStatuses([sig]);
      const v = st.value[0];
      if (v) {
        if (v.err) return { confirmed: false, timedOut: false, err: JSON.stringify(v.err) };
        if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return { confirmed: true, timedOut: false, err: null };
      }
    } catch { /* keep polling to the deadline */ }
    await sleep(1500);
  }
  return { confirmed: false, timedOut: true, err: "confirmation timeout" };
}

/**
 * Sign (with the bot's own key — instant, no approval) + send + confirm, all through the
 * rotating pool. Signing happens BEFORE any send, so the pool's failover cannot produce a
 * double spend — see the note in execution/rpc.ts.
 */
async function signSendConfirm(bytes: Uint8Array): Promise<LiveResult> {
  let signed: Uint8Array;
  try {
    const vtx = VersionedTransaction.deserialize(bytes);
    vtx.sign([botWallet()]); // <5ms local signature — the whole point: no human approval
    signed = vtx.serialize();
  } catch {
    try {
      // OKX currently returns v0 transactions, but its API contract also permits legacy Solana
      // transactions. Supporting both here prevents a valid route-format change becoming a
      // mysterious execution outage.
      const tx = Transaction.from(bytes);
      tx.partialSign(botWallet());
      signed = tx.serialize({ requireAllSignatures: true, verifySignatures: true });
    } catch (e) {
      return { ok: false, err: `transaction decode/sign failed: ${(e as Error).message}` };
    }
  }

  let sig: string;
  try {
    sig = await poolSendRawTransaction(signed);
  } catch (e) {
    // Nothing was sent successfully, so there is no position to reconcile.
    return { ok: false, err: (e as Error).message };
  }
  // Past this point a transaction EXISTS on the network. Never report it as a clean failure:
  // confirmSig distinguishes rejected from not-yet-confirmed, and the caller reconciles.
  const c = await confirmSig(sig);
  return { ok: c.confirmed, signature: sig, timedOut: c.timedOut, err: c.err, confirmVia: c.via, confirmMs: c.ms };
}

export interface LiveResult {
  ok: boolean;
  signature?: string;
  timedOut?: boolean; // sent but not confirmed within the window — reconcile, don't assume
  err?: string | null;
  /** Confirmation telemetry: which leg won (ws push vs poll) and how long it took. */
  confirmVia?: "ws" | "poll" | "timeout";
  confirmMs?: number;
  /** Wallet SOL read right BEFORE the buy (buys only) — lets the caller bracket the spend
   *  without a second RPC round trip. Absent on sells and pre-buy refusals. */
  balanceBefore?: number;
  /** GMGN route: the order id to poll for the authoritative on-chain outcome. */
  orderId?: string;
  /** GMGN route (buy): tokens actually received per the order report. */
  tokensOut?: number;
  /** GMGN route (sell): SOL actually received per the order report. */
  solOut?: number;
  /** Route-build latency before local signing, when the provider exposes it. */
  buildMs?: number;
  txFormat?: "versioned" | "legacy";
}

/**
 * LIVE BUY on mainnet. Double-locked and fully guarded:
 *   1. liveAllowed()  — env opt-in + key present + not halted
 *   2. read the REAL on-chain balance (fail-closed if unreadable)
 *   3. guardBuy()     — per-trade / exposure / 24h-spend caps, fail-closed
 *   4. build → sign (own key) → send → confirm
 *   5. recordSpend()  — only after a real confirmation
 * `deployedSol` is the caller's current open exposure (for the exposure cap).
 */
export async function liveBuy(mint: string, sizeSol: number, deployedSol: number, pool = "auto"): Promise<LiveResult> {
  const gate = liveAllowed();
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };

  const kp = botWallet();
  // PARALLEL BUILD (2026-08-24): the PumpPortal build does not depend on the wallet balance,
  // so start it NOW and let it overlap the balance read instead of queueing behind it.
  // Measured live: buy exec p50 2.6s; this removes the smaller of the two waits (~0.15-1s)
  // from the critical path. Failure semantics unchanged: whichever leg fails first returns
  // its original error; the discarded build promise is side-effect-free.
  const buildPromise = buildBuyTx(kp.publicKey.toBase58(), mint, sizeSol, pool);
  const balanceSol = await poolBalanceSol(kp.publicKey.toBase58());
  if (balanceSol == null) return { ok: false, err: "balance read failed on every endpoint — refusing (fail-closed)" };

  const verdict = guardBuy(sizeSol, balanceSol, deployedSol);
  if (!verdict.ok) return { ok: false, err: `guard: ${verdict.reason}` };

  const bytes = await buildPromise;
  if (!bytes) return { ok: false, err: "buy tx build failed (no route / bad mint)" };

  const r = await signSendConfirm(bytes);
  if (r.ok) recordSpend(sizeSol); // circuit-breaker ledger — only on real confirmation
  return { ...r, balanceBefore: balanceSol }; // caller's spentSol bracket, free (no extra read)
}

/**
 * LIVE SELL on mainnet. A sell returns SOL (doesn't spend principal), so it is capped by
 * nothing — not the spend limits, and not the kill switch. See liveExitAllowed().
 *
 * `pool` matters more than it looks. A token that pumps hard GRADUATES off the bonding curve
 * onto an AMM, and a sell still addressed to the curve fails with 0x1775. Callers exiting a
 * position should pass "auto" and let PumpPortal resolve the venue that exists NOW, rather than
 * the one that existed at entry.
 */
export async function liveSell(mint: string, tokenAmount: number | string, pool = "auto"): Promise<LiveResult> {
  const gate = liveExitAllowed(); // NOT liveAllowed(): a halt must never trap a bag

  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };
  const kp = botWallet();
  const bytes = await buildSellTx(kp.publicKey.toBase58(), mint, tokenAmount, pool);
  if (!bytes) return { ok: false, err: "sell tx build failed" };
  return signSendConfirm(bytes);
}

/**
 * Post-trade safety check the live loop should call periodically: compare the
 * trader's expected hot-wallet SOL to the real on-chain balance. Any unexplained
 * drift trips the kill switch. Returns the guardian verdict.
 */
export async function reconcileWallet(expectedSol: number): Promise<{ ok: boolean; reason?: string; actualSol: number }> {
  const kp = botWallet();
  // null (every endpoint failed) → -1 → reconcile() fails closed + halts.
  const actualSol = (await poolBalanceSol(kp.publicKey.toBase58())) ?? -1;
  const v = reconcile(expectedSol, actualSol);
  return { ok: v.ok, reason: v.reason, actualSol };
}

export interface SimResult {
  built: boolean; // PumpPortal returned a valid tx (construction validated)
  ok: boolean; // the tx would succeed on-chain right now
  err: string | null; // simulation error (e.g. honeypot / freeze / curve complete)
  needsFunding: boolean; // wallet has no SOL — fund ~0.05 SOL (never spent) for full sim
  /** No simulation verdict exists because the RPC transport/budget failed before a response. */
  transportError?: boolean;
  unitsConsumed?: number;
}

/**
 * SIMULATE mode: build the real buy tx and run it through mainnet
 * simulateTransaction (sigVerify off, blockhash replaced) — validates that the
 * BUY would actually LAND and succeed on the real chain. This does not simulate SELL and
 * therefore cannot prove or disprove a honeypot. Sends nothing; costs nothing.
 */
/**
 * pump.fun's `TooMuchSolRequired` (Anchor 6002) — the curve wants more SOL than the built
 * transaction is willing to spend, because the price moved between PumpPortal quoting it and the
 * chain executing it.
 *
 * Escalated per-candidate rather than by raising the global slippage, because the measurement
 * says the problem is rare: of 26 live candidates sampled, 24 (92%) simulated fine at the
 * configured 10% and only one needed 20%. Today's log agrees — 831 of 832 simulation failures
 * were the mint-visibility race, and exactly ONE was 6002. Raising `slippagePct` globally would
 * loosen the price ceiling on every trade to recover ~4% of them, which is a real cost paid on
 * the 92% that never needed it. A retry pays only where the error actually occurs.
 *
 * One escalation, not a ladder: past this the price has genuinely run away from us, and chasing
 * it is a worse trade, not a better fill.
 */
const SLIPPAGE_ESCALATION_PCT = 25;
const isTooMuchSolRequired = (err: string | null): boolean => Boolean(err && /"Custom":\s*6002/.test(err));

/**
 * `IncorrectProgramId` from the ATA leg is TRANSIENT, and only a direct experiment settled it.
 *
 * The error means a token program was asked about a mint it does not own, so every reading of it
 * pointed at the mint not being on chain yet. Four versions of that theory were tested and all
 * four failed: at failure time the mint exists and is Token-2022-owned (21 of 21 sampled), both
 * pool endpoints see it, `confirmed` sees it, and 23 of 25 failures had already cleared the
 * pre-queue visibility wait. What finally decided it was replaying the EXACT SAME transaction
 * bytes a few minutes later against the same node: identical input, and it succeeded past the
 * instruction that had failed.
 *
 * So the account query and the simulation bank do not agree during a short window after launch —
 * `getAccountInfo` can already report the initialized mint while the bank the simulation runs
 * against has not caught up. Waiting longer before the first attempt is the wrong trade (measured
 * on 378 live launches: entering 60s late instead of at launch drops the odds of a +43% move from
 * 16.1% to 2.8%), so the first attempt stays as early as possible and only the failures pay.
 *
 * THE WINDOW WAS MEASURED, and it is far longer than it looked. A first attempt at this used a
 * single 900ms retry, reasoning from one replay that had succeeded "a bit later"; it recovered
 * 0 of 12 in production. So the window was measured properly: eight brand-new mints were caught
 * within seconds of launch, one transaction built per mint, and the SAME bytes re-simulated every
 * 2s until they passed. Every one of the eight succeeded at a token age of 12-15 seconds — never
 * sooner, never much later:
 *
 *     DONZEL 12.8s · ROCKON 12.0s · Homer 12.2s · Reflect 12.5s · Bakari 13.6s · TOM OG 13.9-15.4s
 *
 * So a pump.fun buy simply cannot be simulated for roughly the first twelve seconds of a token's
 * life through this path, no matter how fast the bot gets. That is a floor, not a tuning knob —
 * and it means the detect→entry work (31.8s → ~4s) now runs into a hard external limit rather
 * than a code one.
 *
 * Retrying across that window is therefore the whole fix: the bot attempts immediately, then
 * keeps re-simulating until the chain will accept it, entering at the earliest moment physically
 * possible. The budget covers the measured 12-15s with margin; past it a persistent
 * `IncorrectProgramId` means something real, not a race, and must stay visible as such — so the
 * original error is preserved rather than masked.
 */
const RACE_RETRY_INTERVAL_MS = 2_000;
const RACE_RETRY_BUDGET_MS = 16_000;
const isTransientProgramIdRace = (err: string | null): boolean => Boolean(err && /IncorrectProgramId/.test(err));

export async function simulateBuyMainnet(mint: string, sizeSol: number, pool = "auto"): Promise<SimResult> {
  let first = await simulateBuyOnce(mint, sizeSol, pool);
  if (isTransientProgramIdRace(first.err)) {
    const startedAt = Date.now();
    for (;;) {
      if (Date.now() - startedAt >= RACE_RETRY_BUDGET_MS) break;
      await new Promise((r) => setTimeout(r, RACE_RETRY_INTERVAL_MS));
      const again = await simulateBuyOnce(mint, sizeSol, pool);
      if (again.ok || !isTransientProgramIdRace(again.err)) {
        logRecord("events", { type: "buy-sim-race-retry", mint, waitedMs: Date.now() - startedAt, recovered: again.ok, err: again.ok ? null : again.err });
        first = again;
        break;
      }
    }
    if (isTransientProgramIdRace(first.err)) {
      logRecord("events", { type: "buy-sim-race-retry", mint, waitedMs: Date.now() - startedAt, recovered: false, err: first.err });
    }
  }
  if (!isTooMuchSolRequired(first.err)) return first;
  const retry = await simulateBuyOnce(mint, sizeSol, pool, SLIPPAGE_ESCALATION_PCT);
  logRecord("events", {
    type: "buy-sim-slippage-escalated", mint,
    fromPct: config.exec.slippagePct, toPct: SLIPPAGE_ESCALATION_PCT,
    recovered: retry.ok, err: retry.ok ? null : retry.err,
  });
  return retry.ok ? retry : first; // keep the ORIGINAL error when the retry also fails — that is the honest diagnosis
}

async function simulateBuyOnce(mint: string, sizeSol: number, pool = "auto", slippagePct?: number): Promise<SimResult> {
  const pubkey = botWallet().publicKey.toBase58();
  const bytes = await buildBuyTx(pubkey, mint, sizeSol, pool, slippagePct);
  if (!bytes) return { built: false, ok: false, needsFunding: false, err: "tx build failed (no route / bad mint)" };
  try {
    // Pooled raw RPC instead of a standalone `Connection` — see `pooledRpc`'s doc comment.
    // `bytes` is already the wire-serialized tx from the PumpPortal API; base64 it directly
    // rather than round-tripping through `VersionedTransaction.deserialize`, which
    // `conn.simulateTransaction` would only reserialize before sending anyway.
    const sim = await pooledRpc<{ value: { err: unknown; unitsConsumed?: number } }>("simulateTransaction", [
      Buffer.from(bytes).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true },
    ]);
    const err = sim.value.err ? JSON.stringify(sim.value.err) : null;
    // AccountNotFound / insufficient funds = the wallet isn't funded, not a bad token.
    const needsFunding = err !== null && /AccountNotFound|insufficient|InsufficientFunds/i.test(err);
    return { built: true, ok: err === null, needsFunding, err, unitsConsumed: sim.value.unitsConsumed };
  } catch (e) {
    return { built: true, ok: false, needsFunding: false, transportError: true, err: (e as Error).message };
  }
}

export interface DevnetTestResult {
  pubkey: string;
  balanceSol: number;
  signature?: string;
  confirmed: boolean;
  error?: string;
}

/**
 * DEVNET plumbing test: sign + send + confirm a real (self-transfer) transaction
 * on devnet with faucet SOL. Validates the whole send path — keypair, signing,
 * RPC submission, confirmation, error handling — without touching mainnet or
 * real money. (pump.fun itself isn't deployed on devnet, so this exercises the
 * transport, not the trade.)
 */
export async function devnetPlumbingTest(): Promise<DevnetTestResult> {
  const kp = botWallet();
  const pubkey = kp.publicKey.toBase58();
  const conn = new Connection(config.exec.devnetRpc, "confirmed");
  // The very first call was unguarded: when the devnet endpoint answers 429 (free-tier
  // quota, routine) this threw straight out of the self-test, which then looked like the
  // suite had BROKEN rather than like an environment limit. Every other leg here already
  // returns a described failure; this one now does too.
  let balanceSol: number;
  try {
    balanceSol = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
  } catch (e) {
    return { pubkey, balanceSol: -1, confirmed: false, error: `devnet balance read failed: ${(e as Error).message}` };
  }

  if (balanceSol < 0.01) {
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      balanceSol = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    } catch (e) {
      return { pubkey, balanceSol, confirmed: false, error: `airdrop failed (devnet faucet limit): ${(e as Error).message}` };
    }
  }

  try {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey }).add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1000 }),
    );
    tx.sign(kp);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, "confirmed");
    return { pubkey, balanceSol, signature: sig, confirmed: true };
  } catch (e) {
    return { pubkey, balanceSol, confirmed: false, error: (e as Error).message };
  }
}

/** LIVE sends are intentionally not implemented — hard block. */
export function assertNotLive(): void {
  if (config.exec.mode === "live") {
    throw new Error("EXEC_MODE=live is hard-blocked: real-money execution + keychain key storage are not built yet.");
  }
}

// ── Devnet execution bridge ─────────────────────────────────────────────────
// pump.fun isn't deployed on devnet, so a devnet "trade" can't be a real buy.
// Instead each paper open/close MIRRORS to a real devnet self-transfer: it drives
// the exact live pipeline — build → sign (own key, no approval) → send → confirm —
// end-to-end with worthless faucet SOL, proving the transport is boring before a
// single real lamport moves. Best-effort: any failure is reported, never thrown.

let lastAirdropMs = 0;

/** Ensure the devnet wallet has a little SOL for the mirror; airdrop is throttled. */
export async function ensureDevnetFunds(conn: Connection): Promise<number> {
  const kp = botWallet();
  let bal = 0;
  try {
    bal = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    return -1; // RPC read failed
  }
  if (bal >= 0.02) return bal;
  // Throttle airdrop attempts (faucets are rate-limited: ~1 SOL/project/day).
  if (Date.now() - lastAirdropMs < 5 * 60_000) return bal;
  lastAirdropMs = Date.now();
  try {
    const sig = await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    bal = (await conn.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
  } catch {
    /* faucet limited — leave bal as-is; mirror will report needsFunding */
  }
  return bal;
}

export interface MirrorResult {
  ok: boolean;
  signature?: string;
  ms: number;
  signMs?: number;
  needsFunding: boolean;
  err: string | null;
}

/**
 * Mirror one trade signal to a REAL devnet transaction (self-transfer proxy).
 * Proves the automatic sign+send+confirm path against a live chain, for free.
 */
export async function devnetMirror(kind: "buy" | "sell"): Promise<MirrorResult> {
  void kind; // label only; the tx shape is identical (transport proof)
  const t0 = Date.now();
  const kp = botWallet();
  const conn = new Connection(config.exec.devnetRpc, "confirmed");
  const bal = await ensureDevnetFunds(conn);
  if (bal < 0.001) {
    return { ok: false, ms: Date.now() - t0, needsFunding: true, err: "no devnet SOL (faucet rate-limited)" };
  }
  try {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: kp.publicKey }).add(
      SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 5000 }),
    );
    const ts = Date.now();
    tx.sign(kp); // ← the whole point: instant, own key, NO approval
    const signMs = Date.now() - ts;
    const sig = await conn.sendRawTransaction(tx.serialize());
    const c = await confirmSigVia(conn, sig, 25_000);
    return { ok: c.confirmed, signature: sig, ms: Date.now() - t0, signMs, needsFunding: false, err: c.err };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, needsFunding: false, err: (e as Error).message };
  }
}
export interface S2Caps {
  maxPerTradeSol: number;
  maxDeployedSol: number;
}

/** LIVE BUY for the S2 mirror: SOL → token via Jupiter, guardian-guarded with S2 caps. */
export async function jupiterBuyLive(
  tokenMint: string,
  sizeSol: number,
  deployedSol: number,
  caps: S2Caps,
): Promise<LiveResult> {
  const gate = liveAllowed();
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };
  const kp = botWallet();
  const balanceSol = await poolBalanceSol(kp.publicKey.toBase58());
  if (balanceSol == null) return { ok: false, err: "balance read failed on every endpoint — refusing (fail-closed)" };
  const verdict = guardBuy(sizeSol, balanceSol, deployedSol, Date.now(), caps);
  if (!verdict.ok) return { ok: false, err: `guard: ${verdict.reason}` };
  const bytes = await jupiterSwapTx(SOL, tokenMint, Math.round(sizeSol * 1e9), kp.publicKey.toBase58());
  if (!bytes) return { ok: false, err: "jupiter swap build failed (no route / api down)" };
  const r = await signSendConfirm(bytes);
  if (r.ok) recordSpend(sizeSol);
  return { ...r, balanceBefore: balanceSol };
}

/** LIVE SELL for the S2 mirror: token → SOL, full bag sweep semantics like liveSell. */
export async function jupiterSellLive(tokenMint: string, tokenQtyUi: number): Promise<LiveResult> {
  const gate = liveExitAllowed(); // a halt must never strand a bag
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };
  const kp = botWallet();
  const bytes = await jupiterSwapTx(tokenMint, SOL, Math.round(tokenQtyUi * 1e6), kp.publicKey.toBase58());
  if (!bytes) return { ok: false, err: "jupiter swap build failed (no route / api down)" };
  return signSendConfirm(bytes);
}

// ── S2 EXEC ROUTE: OKX ONCHAINOS ───────────────────────────────────────────
// OKX builds a ready-to-sign Solana transaction in one REST call. The wallet key remains local;
// submission and confirmation use this project's own rotating RPC pool and guardian ledger.

const okxExecutionGate = (): { ok: true } | { ok: false; reason: string } => {
  if (!config.okx.enabled) return { ok: false, reason: "OKX REST disabled or credentials incomplete" };
  if (!config.okx.executionEnabled) return { ok: false, reason: "OKX_EXECUTION_ENABLED != true" };
  return { ok: true };
};

export async function okxBuyLive(
  tokenMint: string,
  sizeSol: number,
  deployedSol: number,
  caps: S2Caps,
): Promise<LiveResult> {
  const providerGate = okxExecutionGate();
  if (!providerGate.ok) return { ok: false, err: `okx blocked: ${providerGate.reason}` };
  const gate = liveAllowed();
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };

  const kp = botWallet();
  const owner = kp.publicKey.toBase58();
  // Build and balance read are independent. Overlap them so OKX's measured ~200-300ms builder
  // does not sit behind an RPC round trip on the entry path.
  const buildPromise = okxSwapTx(SOL, tokenMint, Math.round(sizeSol * 1e9), owner);
  const balanceSol = await poolBalanceSol(owner);
  if (balanceSol == null) return { ok: false, err: "balance read failed on every endpoint — refusing (fail-closed)" };
  const verdict = guardBuy(sizeSol, balanceSol, deployedSol, Date.now(), caps);
  if (!verdict.ok) return { ok: false, err: `guard: ${verdict.reason}` };

  const built = await buildPromise;
  if (!built) return { ok: false, err: "okx swap build failed (no route / malformed transaction / api down)" };
  const r = await signSendConfirm(built.bytes);
  if (r.ok) recordSpend(sizeSol);
  return { ...r, balanceBefore: balanceSol, buildMs: built.buildMs, txFormat: built.format };
}

export async function okxSellLive(tokenMint: string, tokenQtyUi: number, decimals: number): Promise<LiveResult> {
  const providerGate = okxExecutionGate();
  if (!providerGate.ok) return { ok: false, err: `okx blocked: ${providerGate.reason}` };
  const gate = liveExitAllowed(); // a global halt must never trap a bag
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };
  const kp = botWallet();
  const amountRaw = Math.round(tokenQtyUi * 10 ** decimals);
  const built = await okxSwapTx(tokenMint, SOL, amountRaw, kp.publicKey.toBase58());
  if (!built) return { ok: false, err: "okx sell build failed (no route / malformed transaction / api down)" };
  const r = await signSendConfirm(built.bytes);
  return { ...r, buildMs: built.buildMs, txFormat: built.format };
}

// ── S2 EXEC ROUTE: GMGN ─────────────────────────────────────────────────────
// Alternatif eksekusi S2 (S2_EXEC_ROUTE=gmgn). Model GMGN: submit order → poll order_id
// sampai terminal. from_address = dompet bot — owner WAJIB meng-import wallet itu ke akun
// GMGN-nya sendiri (model server-side GMGN). Fee platform ±1%/sisi terekam di event.

import { gmgnSwap } from "../discovery/gmgn.js";

export async function gmgnBuyLive(
  tokenMint: string,
  sizeSol: number,
  deployedSol: number,
  caps: S2Caps,
): Promise<LiveResult> {
  const gate = liveAllowed();
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };
  const kp = botWallet();
  const balanceSol = await poolBalanceSol(kp.publicKey.toBase58());
  if (balanceSol == null) return { ok: false, err: "balance read failed on every endpoint — refusing (fail-closed)" };
  const verdict = guardBuy(sizeSol, balanceSol, deployedSol, Date.now(), caps);
  if (!verdict.ok) return { ok: false, err: `guard: ${verdict.reason}` };
  const r = await gmgnSwap({
    fromAddress: kp.publicKey.toBase58(),
    inputToken: SOL, outputToken: tokenMint,
    amountRaw: String(Math.round(sizeSol * 1e9)),
  });
  if (!r.ok) return { ok: false, err: `gmgn: ${r.err ?? r.status}`, orderId: r.orderId };
  recordSpend(sizeSol);
  const tokensOut = r.outRaw && r.outDecimals != null ? Number(r.outRaw) / 10 ** r.outDecimals : undefined;
  return { ok: true, orderId: r.orderId, balanceBefore: balanceSol, tokensOut };
}

export async function gmgnSellLive(tokenMint: string, bagUi: number, decimals: number): Promise<LiveResult> {
  const gate = liveExitAllowed(); // a halt must never strand a bag
  if (!gate.ok) return { ok: false, err: `live blocked: ${gate.reason}` };
  const kp = botWallet();
  const r = await gmgnSwap({
    fromAddress: kp.publicKey.toBase58(),
    inputToken: tokenMint, outputToken: SOL,
    amountRaw: String(Math.round(bagUi * 10 ** decimals)),
  });
  if (!r.ok) return { ok: false, err: `gmgn: ${r.err ?? r.status}`, orderId: r.orderId };
  const solOut = r.outRaw ? Number(r.outRaw) / 1e9 : undefined;
  return { ok: true, orderId: r.orderId, solOut };
}
