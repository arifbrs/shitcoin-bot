import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { config } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { botWallet, botPubkey } from "./wallet.js";
import { liveBuy, liveSell } from "./executor.js";
import type { LiveResult } from "./executor.js";
import { liveAllowed, halt, isHalted, spentLast24h as guardSpent24h } from "./guardian.js";
import { tokenBalanceOfOwner } from "../safety/onchain.js";
import { readControl, livePermitted as envLivePermitted } from "../control.js";
import { poolBalanceSol, poolSendRawTransaction, poolSignatureStatus, poolLatestBlockhash, poolAccountOwner, poolTokenAccountAmount } from "./rpc.js";

/**
 * LIVE BRIDGE — the hands. The paper trader stays the brain.
 *
 * The paper trader is 2,500 lines of validated decision logic with SYNCHRONOUS close()
 * and scaleOutLadder() paths. Rewriting those to await on-chain sends would mean
 * re-validating the one component whose behaviour we actually trust. So instead this
 * module MIRRORS its three decisions onto mainnet — open, partial, close — keyed by
 * `tradeId`, and keeps its own ledger of what we really hold.
 *
 * Consequences of that split, stated plainly because they are real:
 *   · Decisions are made on the paper model's marks, not on our fill. A live fill that
 *     differs from the modeled one is measured and logged, never fed back.
 *   · Live size is smaller than paper size, so live P&L% will not equal paper P&L%.
 *   · A trade the guardian refuses (exposure/daily cap) is simply not mirrored. Live is
 *     therefore a SUBSET of paper, and the two must be compared on matched tradeIds only.
 *
 * SAFETY INVARIANTS — every one of these exists because its absence is how you lose a bag:
 *   1. Real balance is truth. Every sell reads the on-chain token balance first and sells
 *      what is actually there, never what the paper model thinks is there.
 *   2. A confirmation TIMEOUT is not a failure. We keep polling for the tokens, and the
 *      sweeper keeps looking afterwards. We never conclude "no position" from a timeout.
 *   3. Nothing is ever forgotten while a balance is non-zero. A lot leaves the ledger only
 *      when the chain says the bag is gone.
 *   4. Any bag whose paper position no longer exists is swept (sold) automatically.
 *   5. Per-mint serialization: a sell can never overtake its own buy, or another sell.
 *   6. Unexplained balance movement between our own transactions → HALT.
 */

const STATE_PATH = join(config.logDir, "live-lots.json");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export type LotState =
  | "opening"  // buy sent, tokens not yet observed
  | "open"     // we hold a real bag
  | "closing"  // full exit requested, bag not yet confirmed empty
  | "closed"   // chain confirms nothing left
  | "stuck";   // a sell keeps failing — never dropped, retried by the sweeper

export interface LiveSell {
  at: number;
  reason: string;
  tokens: number | "all";
  solReceived: number | null; // measured from the balance delta; null if unreadable
  signature?: string;
  ok: boolean;
  err?: string | null;
}

export interface LiveLot {
  tradeId: string;
  mint: string;
  symbol?: string | null;
  pool: string;
  openedAt: number;
  closedAt?: number;
  requestedSol: number;   // what the paper trader staked
  liveSizeSol: number;    // what we actually asked the chain for
  spentSol: number;       // measured SOL leaving the wallet (incl. fees + ATA rent)
  tokensBought: number;   // real tokens observed after the buy
  proceedsSol: number;    // measured SOL returned by sells
  rentReclaimedSol: number;
  state: LotState;
  buySignature?: string;
  buyTimedOut?: boolean;
  sells: LiveSell[];
  sellFailures: number;
  lastErr?: string | null;
  ataClosed?: boolean;
}

interface BridgeState {
  lots: LiveLot[];
  expectedBalanceSol: number | null; // balance snapshot taken after our last own transaction
}

let lots = new Map<string, LiveLot>();
let expectedBalanceSol: number | null = null;
let inFlight = 0;
let started = false;
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let isPaperOpen: (tradeId: string) => boolean = () => false;

// ── persistence ───────────────────────────────────────────────────────────────

function save(): void {
  const s: BridgeState = { lots: [...lots.values()], expectedBalanceSol };
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    ui.warn(`[live] could not persist lot ledger: ${(e as Error).message}`);
  }
}

function load(): void {
  if (!existsSync(STATE_PATH)) return;
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<BridgeState>;
    lots = new Map((s.lots ?? []).filter((l) => l && typeof l.tradeId === "string").map((l) => [l.tradeId, l]));
    expectedBalanceSol = typeof s.expectedBalanceSol === "number" ? s.expectedBalanceSol : null;
  } catch {
    // A corrupt ledger means we do not know what we hold — the definition of unsafe.
    halt("live-lots.json unreadable — cannot know what bags we hold");
    ui.reject("[live] lot ledger corrupt → HALTED (fail-closed)");
  }
}

// ── plumbing ──────────────────────────────────────────────────────────────────

/** Per-mint FIFO. Guarantees a sell never overtakes its own buy (invariant 5). */
const chains = new Map<string, Promise<void>>();
function enqueue(mint: string, job: () => Promise<void>): void {
  const prev = chains.get(mint) ?? Promise.resolve();
  const next = prev.then(job, job).catch((e) => {
    logRecord("live-exec", { type: "queue-error", mint, err: (e as Error)?.message ?? String(e) });
  });
  chains.set(mint, next);
  void next.then(() => { if (chains.get(mint) === next) chains.delete(mint); });
}

/**
 * Every touch of the outside world goes through here. Not architecture for its own sake:
 * it is the only way the state machine below — timed-out buys, late fills, orphan sweeps,
 * stuck exits — can be exercised deterministically instead of hoped about. See
 * `src/live-bridge-selftest.ts`, which drives all of it against a fake chain.
 */
export interface ChainOps {
  balanceSol(): Promise<number | null>;
  tokenBalance(mint: string): Promise<number | null>;
  buy(mint: string, sizeSol: number, deployedSol: number, pool: string): Promise<LiveResult>;
  sell(mint: string, amount: number | string, pool: string): Promise<LiveResult>;
  closeAta(mint: string): Promise<number>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realChain: ChainOps = {
  // Pooled, NOT a standalone Connection: a 429 on endpoint #0 must not make us blind. See
  // execution/rpc.ts for what that blindness costs (a stuck bag and a HALT).
  balanceSol: () => poolBalanceSol(botPubkey()),
  tokenBalance: (mint) => tokenBalanceOfOwner(botPubkey(), mint),
  buy: (mint, sizeSol, deployedSol, pool) => liveBuy(mint, sizeSol, deployedSol, pool),
  sell: (mint, amount, pool) => liveSell(mint, amount, pool),
  closeAta: (mint) => closeAtaOnChain(mint),
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
};

let chain: ChainOps = realChain;

async function readBalanceSol(): Promise<number | null> {
  return chain.balanceSol();
}

/** Snapshot the balance as "explained". Everything after this must be our own doing. */
async function snapshotBalance(): Promise<void> {
  const b = await readBalanceSol();
  if (b != null) { expectedBalanceSol = b; save(); }
}

let armedOverride: boolean | null = null;
let permittedOverride: boolean | null = null;

/**
 * PERMISSION (.env, out-of-band). Gates everything the bridge does at all — including
 * selling. Without it the module is completely inert.
 */
export function bridgePermitted(): boolean {
  if (permittedOverride != null) return permittedOverride;
  return envLivePermitted();
}

/**
 * ARMED = permission AND the console switch set to "live". Gates NEW BUYS ONLY.
 *
 * The asymmetry is deliberate and is the same one the kill switch already has: flipping the
 * button back to PAPER, or tripping a HALT, must stop us buying INSTANTLY while never
 * stopping us from getting out of what we already hold. A disarm that stranded live bags
 * would be a worse failure than the one it was trying to prevent.
 */
export function bridgeArmed(): boolean {
  if (!bridgePermitted()) return false;
  if (armedOverride != null) return armedOverride;
  return readControl().execMode === "live";
}

/** Real SOL currently committed to open bags — the exposure figure guardBuy needs. */
export function deployedLiveSol(): number {
  let s = 0;
  for (const l of lots.values()) {
    if (l.state === "opening" || l.state === "open" || l.state === "closing" || l.state === "stuck") {
      s += Math.max(0, l.spentSol || l.liveSizeSol) - l.proceedsSol;
    }
  }
  return Math.max(0, s);
}

/**
 * How much REAL SOL this trade gets.
 *
 * Fixed clip by default. With LIVE_COMPOUND=true it becomes a percentage of the wallet, which
 * is why the balance source matters: `expectedBalanceSol` is the snapshot taken after our own
 * last transaction, so it already reflects every fill and every fee. Using the paper trader's
 * balance instead would size off a notional 2 SOL float against a real 0.24 SOL wallet — an
 * 8x over-size on the very first trade.
 *
 * When the balance is UNKNOWN (no transaction yet this process, or every RPC failed) it falls
 * back to the fixed clip. It never guesses upward from an unknown: the guardian would catch an
 * over-size, but a sizing rule that inflates on missing data is the wrong shape regardless.
 *
 * The guardian caps still apply on top, and `paperSizeSol` caps it too so live can never stake
 * more than the model it is mirroring.
 */
function liveSizeFor(paperSizeSol: number, balanceSol: number | null = expectedBalanceSol): number {
  const cfg = config.exec.live;
  let base = cfg.sizeSol;
  if (cfg.compound && balanceSol != null && balanceSol > 0) {
    base = (balanceSol * cfg.riskPct) / 100;
  }
  base = Math.max(base, cfg.minSol);
  return Math.min(base, config.exec.guard.maxPerTradeSol, paperSizeSol);
}

// ── OPEN ──────────────────────────────────────────────────────────────────────

export function bridgeOpen(a: { tradeId: string; mint: string; symbol?: string | null; sizeSol: number; pool?: string }): void {
  if (!bridgeArmed()) return;
  if (lots.has(a.tradeId)) return; // idempotent — the paper trader can retry a tick
  // The lot is registered SYNCHRONOUSLY, before the buy is even attempted. Two bugs, both
  // caught by the selftest, live in the gap between this call and the buy completing:
  //   · a duplicate bridgeOpen in the same tick found no lot yet and bought AGAIN;
  //   · EARLY_CUT fires at <5s while a buy can take 30s to confirm — bridgeClose found no
  //     lot and silently dropped the exit, leaving a real bag to the sweeper.
  // Registering first closes both: the record exists, and the per-mint queue orders the
  // work behind the buy instead of discarding it.
  lots.set(a.tradeId, {
    tradeId: a.tradeId, mint: a.mint, symbol: a.symbol ?? null, pool: a.pool ?? "auto",
    openedAt: Date.now(), requestedSol: a.sizeSol, liveSizeSol: liveSizeFor(a.sizeSol),
    spentSol: 0, tokensBought: 0, proceedsSol: 0, rentReclaimedSol: 0,
    state: "opening", sells: [], sellFailures: 0,
  });
  save();
  enqueue(a.mint, () => doOpen(a).catch(() => { /* never surface into the paper loop */ }));
}

async function doOpen(a: { tradeId: string; mint: string; symbol?: string | null; sizeSol: number; pool?: string }): Promise<void> {
  const lot = lots.get(a.tradeId);
  if (!lot || lot.state === "closed") return;
  const gate = liveAllowed();
  if (!gate.ok) {
    lot.state = "closed";
    lot.closedAt = Date.now();
    lot.lastErr = gate.reason ?? null;
    save();
    logRecord("live-exec", { type: "open-skipped", tradeId: a.tradeId, mint: a.mint, symbol: a.symbol ?? null, reason: gate.reason });
    return;
  }
  const sizeSol = lot.liveSizeSol;

  inFlight++;
  try {
    const before = await readBalanceSol();
    const t0 = Date.now();
    const r = await chain.buy(a.mint, sizeSol, deployedLiveSol(), lot.pool);
    lot.buySignature = r.signature;
    lot.buyTimedOut = r.timedOut === true;
    lot.lastErr = r.err ?? null;

    if (!r.ok && !r.timedOut) {
      // A clean refusal (guard, no route, revert). No tokens, no money moved.
      lot.state = "closed";
      lot.closedAt = Date.now();
      save();
      logRecord("live-exec", { type: "buy-failed", tradeId: a.tradeId, mint: a.mint, symbol: a.symbol ?? null, sizeSol, err: r.err, ms: Date.now() - t0 });
      ui.warn(`[live] BUY ${a.symbol ?? a.mint} refused — ${r.err}`);
      return;
    }

    // INVARIANT 2: confirmed OR timed out, we now go look for the tokens. A timeout is
    // not evidence of anything; only the chain is.
    const deadline = Date.now() + (r.ok ? 25_000 : config.exec.live.buySettleMs);
    let tokens = 0;
    while (Date.now() < deadline) {
      const bal = await chain.tokenBalance(a.mint);
      if (bal != null && bal > 0) { tokens = bal; break; }
      await chain.sleep(2_000);
    }

    const after = await readBalanceSol();
    lot.spentSol = before != null && after != null ? Math.max(0, before - after) : sizeSol;
    lot.tokensBought = tokens;

    if (tokens > 0) {
      // Do NOT clobber a close requested while the buy was still in flight — the queued
      // sell runs next and needs to still see an exit in progress.
      if (lot.state !== "closing") lot.state = "open";
      save();
      await snapshotBalance();
      logRecord("live-exec", {
        type: "buy", tradeId: a.tradeId, mint: a.mint, symbol: a.symbol ?? null,
        requestedSol: a.sizeSol, liveSizeSol: sizeSol, spentSol: Number(lot.spentSol.toFixed(6)),
        tokens, sig: r.signature, timedOut: lot.buyTimedOut, ms: Date.now() - t0,
      });
      ui.pass(`[live] BUY ${a.symbol ?? a.mint} ${sizeSol} SOL → ${tokens.toFixed(0)} tok (${((Date.now() - t0) / 1000).toFixed(1)}s${lot.buyTimedOut ? ", late-confirm" : ""})`);
    } else {
      // Nothing arrived inside the window. We do NOT delete the lot — a tx can still land
      // afterwards. The sweeper keeps checking this mint (invariant 3).
      lot.state = "stuck";
      lot.lastErr = r.timedOut ? "buy timed out, no tokens observed in window" : "buy confirmed but no tokens observed";
      save();
      logRecord("live-exec", { type: "buy-unresolved", tradeId: a.tradeId, mint: a.mint, symbol: a.symbol ?? null, sig: r.signature, timedOut: r.timedOut, waitedMs: Date.now() - t0 });
      ui.warn(`[live] BUY ${a.symbol ?? a.mint} UNRESOLVED — no tokens seen; sweeper will keep watching`);
    }
  } finally {
    inFlight--;
  }
}

// ── SELL ──────────────────────────────────────────────────────────────────────

/** Mirror a scale-out. `fracOfOriginal` matches the paper record's `soldFrac`. */
export function bridgeSellFraction(tradeId: string, mint: string, fracOfOriginal: number, reason: string): void {
  if (!bridgePermitted()) return; // NOT bridgeArmed() — see the note on the asymmetry

  const lot = lots.get(tradeId);
  // A lot in state "opening" is legitimate here: the buy may still be confirming. The
  // per-mint queue makes this sell wait for it rather than dropping the instruction.
  if (!lot || lot.state === "closed") return;
  if (!(fracOfOriginal > 0)) return;
  enqueue(mint, () => doSell(tradeId, fracOfOriginal, reason).catch(() => {}));
}

/** Mirror a full exit. */
export function bridgeClose(tradeId: string, mint: string, reason: string): void {
  if (!bridgePermitted()) return; // an exit must survive a disarm

  const lot = lots.get(tradeId);
  if (!lot || lot.state === "closed") return;
  lot.state = "closing";
  save();
  enqueue(mint, () => doSell(tradeId, 1, reason).catch(() => {}));
}

async function doSell(tradeId: string, fracOfOriginal: number, reason: string): Promise<void> {
  const lot = lots.get(tradeId);
  if (!lot || lot.state === "closed") return;
  const full = fracOfOriginal >= 1;

  // NOTE: a HALT must not strand a bag. Selling returns money and is not capped by the
  // spend limits, so `liveSell` only requires the env lock + key, not an un-halted guard.
  inFlight++;
  try {
    // INVARIANT 1: the chain decides how much we can sell.
    const real = await chain.tokenBalance(lot.mint);
    if (real == null) {
      lot.sellFailures++;
      lot.lastErr = "token balance unreadable — refusing to sell blind";
      lot.state = "stuck";
      save();
      logRecord("live-exec", { type: "sell-deferred", tradeId, mint: lot.mint, reason, err: lot.lastErr, failures: lot.sellFailures });
      return;
    }
    if (real <= 0) {
      // Nothing to sell. If the buy never filled at all, this is not an exit — leave the
      // lot for the sweeper, which is the only thing allowed to conclude "never filled"
      // (and only after the settle window, because a buy can still land).
      if (lot.state === "opening" && lot.tokensBought === 0) return;
      await settleEmpty(lot, reason);
      return;
    }

    // Partial: a fraction of what we ORIGINALLY bought, clamped to what is really left.
    // Full: PumpPortal's "100%" — a literal balance sweep, so rounding can never strand dust.
    const amount: number | "100%" = full ? "100%" : Math.min(real, lot.tokensBought * fracOfOriginal);
    if (!full && (!(amount as number > 0))) return;

    const before = await readBalanceSol();
    const t0 = Date.now();
    const r = await chain.sell(lot.mint, amount, lot.pool);
    const after = await readBalanceSol();
    const got = before != null && after != null ? after - before : null;

    const rec: LiveSell = {
      at: Date.now(), reason, tokens: full ? "all" : (amount as number),
      solReceived: got != null ? Number(got.toFixed(6)) : null,
      signature: r.signature, ok: r.ok, err: r.err ?? null,
    };
    lot.sells.push(rec);

    if (r.ok || r.timedOut) {
      // Same rule as the buy: only the balance is evidence.
      const left = await chain.tokenBalance(lot.mint);
      if (got != null && got > 0) lot.proceedsSol += got;
      if (left != null && left <= 0) {
        await settleEmpty(lot, reason);
      } else {
        lot.state = full ? "closing" : "open";
        lot.sellFailures = r.ok ? 0 : lot.sellFailures + 1;
        save();
      }
      await snapshotBalance();
      logRecord("live-exec", {
        type: "sell", tradeId, mint: lot.mint, symbol: lot.symbol, reason,
        full, tokens: full ? null : amount, solReceived: rec.solReceived,
        remaining: left, sig: r.signature, timedOut: r.timedOut, ms: Date.now() - t0,
      });
      ui.pass(`[live] SELL ${lot.symbol ?? lot.mint} ${full ? "ALL" : `${(fracOfOriginal * 100).toFixed(0)}%`} ${reason} → ${rec.solReceived ?? "?"} SOL`);
    } else {
      lot.sellFailures++;
      lot.lastErr = r.err ?? "sell failed";
      lot.state = "stuck";
      save();
      logRecord("live-exec", { type: "sell-failed", tradeId, mint: lot.mint, symbol: lot.symbol, reason, err: r.err, failures: lot.sellFailures });
      ui.reject(`[live] SELL ${lot.symbol ?? lot.mint} FAILED (${lot.sellFailures}) — ${r.err}`);
      // A bag we cannot sell is the one failure mode that is not bounded by position size.
      if (lot.sellFailures >= config.exec.live.maxSellFailures && !isHalted().halted) {
        halt(`cannot exit ${lot.symbol ?? lot.mint} after ${lot.sellFailures} attempts — manual intervention needed`);
        ui.reject(`[live] KILL SWITCH — stuck bag ${lot.mint}`);
      }
    }
  } finally {
    inFlight--;
  }
}

/**
 * Queued settle. Re-reads the balance INSIDE the queue slot, so anything that ran ahead of it
 * (a sell that was in flight when the sweeper decided to act) has already been booked.
 */
async function settleIfEmpty(lot: LiveLot): Promise<void> {
  if (lot.state === "closed") return; // the sell we were racing already finished the job
  const bal = await chain.tokenBalance(lot.mint);
  if (bal == null) return;            // unreadable → try again next sweep, never assume empty
  if (bal > 0) return;                // a late fill landed; the normal exit path owns it now
  if (lot.state === "opening" || lot.state === "stuck") {
    // Nothing after the settle window and the tx never landed → genuinely no position.
    if (Date.now() - lot.openedAt > config.exec.live.buySettleMs + 60_000) await settleEmpty(lot, "NEVER_FILLED");
    return;
  }
  await settleEmpty(lot, "SWEEP_CONFIRMED_EMPTY");
}

/** The chain says the bag is gone. Book it, reclaim the rent, and stop tracking. */
async function settleEmpty(lot: LiveLot, reason: string): Promise<void> {
  // Idempotent by construction. Queuing fixes the known race; this makes a SECOND `settled`
  // record impossible for any future caller that forgets, because a duplicate here corrupts
  // realised P&L permanently — the log is append-only truth.
  if (lot.state === "closed") return;
  lot.state = "closed";
  lot.closedAt = Date.now();
  lot.sellFailures = 0;
  save();
  if (config.exec.live.closeAta) {
    const reclaimed = await chain.closeAta(lot.mint);
    if (reclaimed > 0) { lot.rentReclaimedSol += reclaimed; lot.ataClosed = true; save(); await snapshotBalance(); }
  }
  const net = lot.proceedsSol + lot.rentReclaimedSol - lot.spentSol;
  logRecord("live-exec", {
    type: "settled", tradeId: lot.tradeId, mint: lot.mint, symbol: lot.symbol, reason,
    spentSol: Number(lot.spentSol.toFixed(6)),
    proceedsSol: Number(lot.proceedsSol.toFixed(6)),
    rentReclaimedSol: Number(lot.rentReclaimedSol.toFixed(6)),
    netSol: Number(net.toFixed(6)),
    netPct: lot.spentSol > 0 ? Number(((net / lot.spentSol) * 100).toFixed(2)) : null,
    heldSec: Math.round((Date.now() - lot.openedAt) / 1000),
    sells: lot.sells.length,
  });
  const line = `[live] SETTLED ${lot.symbol ?? lot.mint} ${net >= 0 ? "+" : ""}${net.toFixed(5)} SOL`;
  net >= 0 ? ui.pass(line) : ui.reject(line);
}

// ── ATA rent reclaim ──────────────────────────────────────────────────────────

function ataFor(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/**
 * SPL Token `CloseAccount` (instruction 9). Hand-built rather than pulling in
 * @solana/spl-token for one 3-account instruction. Returns the SOL reclaimed (0 if there
 * was nothing to close). Refuses unless the account is provably empty and owned by the
 * classic token program.
 */
async function closeAtaOnChain(mint: string): Promise<number> {
  try {
    const owner = botWallet().publicKey;
    const ata = ataFor(owner, new PublicKey(mint));
    const info = await poolAccountOwner(ata.toBase58());
    if (!info) return 0;                                   // already closed / never existed
    if (info.owner !== TOKEN_PROGRAM.toBase58()) return 0;  // Token-2022 or not a token account
    const amount = await poolTokenAccountAmount(ata.toBase58());
    // `null` is UNREADABLE, not empty. Closing on an unreadable balance is how you burn a bag.
    if (amount == null || amount !== "0") return 0;

    const ix = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [
        { pubkey: ata, isSigner: false, isWritable: true },   // account to close
        { pubkey: owner, isSigner: false, isWritable: true }, // rent destination
        { pubkey: owner, isSigner: true, isWritable: false }, // authority
      ],
      data: Buffer.from([9]),
    });
    const before = await readBalanceSol();
    const blockhash = await poolLatestBlockhash();
    if (!blockhash) return 0;
    const tx = new Transaction().add(ix);
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    tx.sign(botWallet());
    const sig = await poolSendRawTransaction(tx.serialize());
    // Poll to a deadline rather than confirmTransaction(): the rent is small, and a slow
    // confirmation must never wedge an exit path behind it.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const st = await poolSignatureStatus(sig).catch(() => null);
      if (st?.confirmed || st?.err) break;
      await chain.sleep(1_500);
    }
    const after = await readBalanceSol();
    const delta = before != null && after != null ? after - before : 0;
    logRecord("live-exec", { type: "ata-closed", mint, sig, reclaimedSol: Number(delta.toFixed(6)) });
    return Math.max(0, delta);
  } catch (e) {
    logRecord("live-exec", { type: "ata-close-failed", mint, err: (e as Error).message });
    return 0; // rent is small; never let this path break an exit
  }
}

// ── reconcile + sweep ─────────────────────────────────────────────────────────

/**
 * INVARIANT 6. Between our own transactions the wallet must not move. Anything else is a
 * bug, an external spend, a drainer, or a timed-out tx that landed after we gave up — all
 * of which mean we no longer understand our own position.
 */
async function reconcileTick(): Promise<void> {
  if (!bridgePermitted() || inFlight > 0 || isHalted().halted) return;
  const actual = await readBalanceSol();
  if (actual == null) return; // a transient RPC failure is not evidence of theft
  if (expectedBalanceSol == null) { expectedBalanceSol = actual; save(); return; }
  const drift = Math.abs(actual - expectedBalanceSol);
  if (drift > config.exec.guard.reconcileToleranceSol) {
    halt(`unexplained balance move: expected ${expectedBalanceSol.toFixed(4)}, on-chain ${actual.toFixed(4)} (drift ${drift.toFixed(4)})`);
    logRecord("live-exec", { type: "reconcile-halt", expected: expectedBalanceSol, actual, drift });
    ui.reject(`[live] KILL SWITCH — unexplained ${drift.toFixed(4)} SOL move`);
  }
}

/**
 * INVARIANT 4 + 3. Finds every bag reality disagrees with us about:
 *   · tokens that showed up after a buy we had given up on → adopt, then sell if orphaned
 *   · a lot whose paper position is gone but whose bag is not → sell it
 *   · a lot we believe is empty but is not → sell it
 *   · retries for stuck sells
 */
async function sweepTick(): Promise<void> {
  if (!bridgePermitted()) return; // keeps liquidating after a disarm
  for (const lot of [...lots.values()]) {
    if (lot.state === "closed") {
      // Drop only long-settled lots — and only after re-confirming the bag is really gone.
      if (lot.closedAt && Date.now() - lot.closedAt > 6 * 60 * 60_000) lots.delete(lot.tradeId);
      continue;
    }
    const bal = await chain.tokenBalance(lot.mint);
    if (bal == null) continue; // unknown → try again next sweep, never assume

    if (bal <= 0) {
      // MUST go through the per-mint queue, never settle inline.
      //
      // Found on the FIRST live run (2026-08-22, MELLO): the sweeper read a zero token balance
      // while an EARLY_CUT sell was still in flight — the tokens had already left the wallet but
      // the SOL had not arrived and `lot.proceedsSol` was still 0. It settled inline and booked
      // the trade at -100%, then the real sell settled it again at -25.9%. Two `settled` records
      // for one trade, and the live P&L read 2.5x worse than reality.
      //
      // The accounting damage was the visible half. The dangerous half: had that in-flight sell
      // FAILED, the lot would already be marked closed while a real bag was still on-chain —
      // invariant 3 broken, bag abandoned. Queuing makes the sweeper wait for the sell it was
      // racing, and the re-read below then sees the settled truth.
      enqueue(lot.mint, () => settleIfEmpty(lot));
      continue;
    }

    // We hold a real bag.
    if (lot.state === "opening" || (lot.state === "stuck" && lot.tokensBought === 0)) {
      lot.tokensBought = bal;
      lot.state = "open";
      save();
      logRecord("live-exec", { type: "late-fill-adopted", tradeId: lot.tradeId, mint: lot.mint, tokens: bal });
      ui.warn(`[live] late fill adopted ${lot.symbol ?? lot.mint} — ${bal.toFixed(0)} tok`);
    }

    const orphaned = !isPaperOpen(lot.tradeId);
    if (orphaned || lot.state === "closing" || lot.state === "stuck") {
      enqueue(lot.mint, () => doSell(lot.tradeId, 1, orphaned ? "ORPHAN_SWEEP" : "RETRY_EXIT").catch(() => {}));
    }
  }
  save();
}

// ── lifecycle + status ────────────────────────────────────────────────────────

/**
 * `paperOpenProbe` answers "does the brain still hold this trade?" — the input the orphan
 * sweep needs. Without it a bag whose paper position closed while a sell failed would sit
 * on-chain forever.
 */
export function bridgeStart(paperOpenProbe: (tradeId: string) => boolean): void {
  isPaperOpen = paperOpenProbe;
  load();
  // Timers follow PERMISSION, not the button, for two reasons: the owner can arm and disarm
  // from the console mid-session without a restart, and a disarm leaves the sweeper running
  // to liquidate whatever is still held.
  if (!bridgePermitted()) {
    if (config.exec.mode === "live") {
      ui.warn("[live] EXEC_MODE=live but LIVE_TRADING_CONFIRMED is not set — bridge is INERT (paper only)");
    }
    return;
  }
  if (started) return;
  started = true;
  const armed = bridgeArmed();
  // Print the sizing RULE, not the fixed clip. With compounding on, `live.sizeSol` is only the
  // fallback for an unreadable balance — logging it as "size" states a number the bot will not
  // actually use, on the one line an operator reads to confirm what they just armed.
  const L = config.exec.live;
  const sizing = L.compound ? `${L.riskPct}% saldo (floor ${L.minSol}, fallback ${L.sizeSol})` : `${L.sizeSol} fixed`;
  ui.warn(`[live] ⚠ LIVE PERMITTED — currently ${armed ? "ARMED (real SOL)" : "disarmed"}. size ${sizing} | caps: trade ${config.exec.guard.maxPerTradeSol} / exposure ${config.exec.guard.maxDeployedSol} / daily ${config.exec.guard.maxDailySpendSol}`);
  logRecord("live-exec", {
    type: "permitted", armed, caps: config.exec.guard, wallet: botPubkey(),
    sizing: L.compound ? "compound" : "fixed",
    riskPct: L.compound ? L.riskPct : null,
    minSol: L.minSol,
    fallbackSizeSol: L.sizeSol,
  });
  void snapshotBalance();
  reconcileTimer = setInterval(() => void reconcileTick().catch(() => {}), config.exec.live.reconcileMs);
  sweepTimer = setInterval(() => void sweepTick().catch(() => {}), config.exec.live.sweepMs);
}

export function bridgeStop(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  reconcileTimer = sweepTimer = undefined;
  started = false;
  save();
}

export interface LiveTradeRow {
  ts: string;
  tradeId: string;
  mint: string;
  symbol: string | null;
  reason: string;
  spentSol: number;
  proceedsSol: number;
  netSol: number;
  netPct: number | null;
  heldSec: number;
}

export interface LiveSummary {
  trades: number;      // settled lots that actually held a bag
  wins: number;
  losses: number;
  spentSol: number;    // real SOL that left the wallet on buys
  proceedsSol: number; // real SOL returned by sells (+ reclaimed ATA rent)
  netSol: number;
  netPct: number | null;
  neverFilled: number; // buys that never produced a bag — not trades, but worth seeing
  recent: LiveTradeRow[];  // newest first
  equitySol: number[];     // cumulative net after each trade, oldest first
  // EXECUTION HEALTH — costs that exist only live and have no paper counterpart. Paper never
  // fails to build a transaction and never has to defer a sell, so these are exactly the
  // numbers that tell you whether the plumbing (not the strategy) is losing money.
  buyFailed: number;
  sellDeferred: number;
  exitReasons: Array<{ reason: string; n: number; netSol: number }>;
}

/**
 * Realised live P&L, read from the append-only `live-exec` log rather than from `lots`.
 *
 * The in-memory ledger drops settled lots after 6h, so it can only ever answer "what is open
 * right now". A dashboard that showed live P&L from it would silently reset itself overnight —
 * and it would do so while sitting under a red LIVE badge, which is the worst possible place
 * for a number to quietly become wrong.
 */
export function liveSummary(): LiveSummary {
  const out: LiveSummary = { trades: 0, wins: 0, losses: 0, spentSol: 0, proceedsSol: 0, netSol: 0, netPct: null, neverFilled: 0, recent: [], equitySol: [], buyFailed: 0, sellDeferred: 0, exitReasons: [] };
  type SettledRow = { ts?: string; type?: string; tradeId?: string; mint?: string; symbol?: string | null; reason?: string; spentSol?: number; proceedsSol?: number; rentReclaimedSol?: number; netSol?: number; netPct?: number | null; heldSec?: number };
  const seen = new Map<string, SettledRow>();
  const rows: SettledRow[] = [];
  let files: string[];
  try {
    files = readdirSync(config.logDir).filter((f) => f.startsWith("live-exec-") && f.endsWith(".jsonl")).sort();
  } catch { return out; }
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(config.logDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let r: SettledRow;
      try { r = JSON.parse(line) as SettledRow; } catch { continue; }
      if (r.type === "buy-failed") { out.buyFailed++; continue; }
      if (r.type === "sell-deferred") { out.sellDeferred++; continue; }
      if (r.type !== "settled") continue;
      // The log is append-only and is never rewritten, so the duplicate `settled` rows the
      // sweeper race already produced stay on disk as the honest record of what happened. The
      // READER is what must not be fooled: last row per tradeId wins, because the later one is
      // the one written after the sell was booked.
      if (r.tradeId) seen.set(r.tradeId, r);
      else rows.push(r);
      // A buy that never filled moved no money and is not a trade. Counting it would drag the
      // win rate toward zero with rows that never had a position. (Applied below, after dedupe.)
    }
  }
  // Chronological, so the equity series reads left-to-right like every other curve here.
  const settled = [...seen.values(), ...rows].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  let cum = 0;
  for (const r of settled) {
    if (r.reason === "NEVER_FILLED" && !(r.spentSol! > 0)) { out.neverFilled++; continue; }
    out.trades++;
    out.spentSol += r.spentSol ?? 0;
    out.proceedsSol += (r.proceedsSol ?? 0) + (r.rentReclaimedSol ?? 0);
    const net = r.netSol ?? 0;
    out.netSol += net;
    net >= 0 ? out.wins++ : out.losses++;
    cum += net;
    out.equitySol.push(Number(cum.toFixed(6)));
    out.recent.push({
      ts: r.ts ?? "", tradeId: r.tradeId ?? "", mint: r.mint ?? "", symbol: r.symbol ?? null,
      reason: r.reason ?? "?", spentSol: r.spentSol ?? 0, proceedsSol: r.proceedsSol ?? 0,
      netSol: net, netPct: r.netPct ?? null, heldSec: r.heldSec ?? 0,
    });
  }
  // Per-reason attribution: which exit rule is actually costing or making the money.
  const byReason = new Map<string, { n: number; netSol: number }>();
  for (const t of out.recent) {
    const e = byReason.get(t.reason) ?? { n: 0, netSol: 0 };
    e.n++; e.netSol += t.netSol;
    byReason.set(t.reason, e);
  }
  out.exitReasons = [...byReason.entries()]
    .map(([reason, v]) => ({ reason, n: v.n, netSol: Number(v.netSol.toFixed(6)) }))
    .sort((a, b) => b.n - a.n);

  out.recent.reverse();                       // newest first for the journal
  out.recent = out.recent.slice(0, 40);
  out.equitySol = out.equitySol.slice(-120);  // bound the payload
  out.netPct = out.spentSol > 0 ? (out.netSol / out.spentSol) * 100 : null;
  return out;
}

export interface BridgeStatus {
  permitted: boolean; // .env lock — the browser can never change this
  armed: boolean;     // permitted AND the console switch is on "live"
  halted: boolean;
  haltReason: string | null;
  openLots: number;
  deployedSol: number;
  realizedSol: number;
  wallet: string;
  expectedBalanceSol: number | null;
  spentLast24h: number;
  caps: typeof config.exec.guard;
  clipSol: number;
  summary: LiveSummary;
}

/** Snapshot for the dashboard. */
export function bridgeStatus(): BridgeStatus {
  let openLots = 0;
  let realized = 0;
  for (const l of lots.values()) {
    if (l.state !== "closed") openLots++;
    else realized += l.proceedsSol + l.rentReclaimedSol - l.spentSol;
  }
  const h = isHalted();
  const armed = bridgeArmed();
  return {
    permitted: bridgePermitted(),
    armed,
    halted: h.halted,
    haltReason: h.reason,
    openLots,
    deployedSol: Number(deployedLiveSol().toFixed(5)),
    realizedSol: Number(realized.toFixed(5)),
    wallet: bridgePermitted() ? botPubkey() : "",
    expectedBalanceSol,
    spentLast24h: guardSpent24h(),
    caps: config.exec.guard,
    clipSol: config.exec.live.sizeSol,
    summary: liveSummary(),
  };
}

// ── test seams ────────────────────────────────────────────────────────────────
// Exported so the money-path state machine is PROVEN rather than assumed. None of these
// are referenced by the trading code; swapping the chain is the only way to rehearse a
// timed-out buy or an unsellable bag without a real one.

export function __setChainForTest(ops: Partial<ChainOps> | null): void {
  chain = ops ? { ...realChain, ...ops } : realChain;
}
export function __setArmedForTest(v: boolean | null): void { armedOverride = v; }
export function __setPermittedForTest(v: boolean | null): void { permittedOverride = v; }
export function __setPaperProbeForTest(fn: (tradeId: string) => boolean): void { isPaperOpen = fn; }
export function __lotsForTest(): Map<string, LiveLot> { return lots; }
export function __resetForTest(): void { lots = new Map(); expectedBalanceSol = null; inFlight = 0; chains.clear(); }
export async function __drainForTest(): Promise<void> {
  // Two rounds: a sweep can enqueue new work onto a chain that was already draining.
  for (let i = 0; i < 4; i++) await Promise.all([...chains.values()]);
}
export const __sweepForTest = () => sweepTick();
export const __reconcileForTest = () => reconcileTick();
export const __liveSizeForTest = liveSizeFor;
export function __setBalanceForTest(v: number | null): void { expectedBalanceSol = v; }
export const __ataForTest = (owner: string, mint: string) => ataFor(new PublicKey(owner), new PublicKey(mint)).toBase58();
