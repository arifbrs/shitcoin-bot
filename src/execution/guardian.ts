import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { keyAvailable } from "./keystore.js";

/**
 * GUARDIAN — the money-safety layer. EVERY real-SOL spend must pass through here.
 *
 * Design stance: FAIL CLOSED. If any safety fact is unknown (balance unreadable,
 * exposure unknown, state corrupt), REFUSE the trade. A missed trade costs
 * nothing; a wrong trade costs real money. Caps are persisted to disk so a crash
 * loop or restart can never silently reset the daily circuit breaker.
 *
 * This module never sends a transaction and never touches a key — it only says
 * yes/no. The executor asks; the guardian decides.
 */

const PATH = join(config.logDir, "guard.json");
const DAY_MS = 24 * 60 * 60 * 1000;

interface GuardState {
  halted: boolean; // hard kill switch — no live spend while true
  haltReason: string | null;
  spends: Array<{ at: number; sol: number }>; // rolling ledger backing the 24h cap
}

function load(): GuardState {
  if (!existsSync(PATH)) return { halted: false, haltReason: null, spends: [] };
  try {
    const s = JSON.parse(readFileSync(PATH, "utf8")) as Partial<GuardState>;
    return {
      halted: Boolean(s.halted),
      haltReason: s.haltReason ?? null,
      spends: Array.isArray(s.spends) ? s.spends.filter((e) => typeof e?.at === "number" && typeof e?.sol === "number") : [],
    };
  } catch {
    // Corrupt state = an unknown = fail closed. Treat as halted until a human clears it.
    return { halted: true, haltReason: "guard.json unreadable — fail-closed", spends: [] };
  }
}

function save(s: GuardState): void {
  writeFileSync(PATH, JSON.stringify(s, null, 2));
}

function prune(s: GuardState, now: number): void {
  s.spends = s.spends.filter((e) => e.at > now - DAY_MS);
}

/** Total real SOL spent in the trailing 24h (the circuit-breaker window). */
export function spentLast24h(now = Date.now()): number {
  const s = load();
  prune(s, now);
  return s.spends.reduce((a, e) => a + e.sol, 0);
}

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Gate a buy of `sizeSol`. FAIL CLOSED on every unknown:
 *   walletBalanceSol < 0  → balance could not be read (RPC failure) → refuse
 *   deployedSol      < 0  → current exposure unknown → refuse
 * All caps come from config.exec.guard and are checked against the persisted
 * 24h spend ledger.
 */
export function guardBuy(sizeSol: number, walletBalanceSol: number, deployedSol: number, now = Date.now()): GuardVerdict {
  const g = config.exec.guard;
  const s = load();
  prune(s, now);

  if (s.halted) return { ok: false, reason: `HALTED: ${s.haltReason ?? "kill switch"}` };
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) return { ok: false, reason: "invalid (non-positive) size" };
  if (sizeSol > g.maxPerTradeSol) return { ok: false, reason: `size ${sizeSol} > per-trade cap ${g.maxPerTradeSol}` };
  if (!Number.isFinite(walletBalanceSol) || walletBalanceSol < 0) return { ok: false, reason: "wallet balance unreadable — fail-closed" };
  if (!Number.isFinite(deployedSol) || deployedSol < 0) return { ok: false, reason: "exposure unknown — fail-closed" };
  // Never spend money you don't have; always keep a fee reserve.
  if (sizeSol + g.feeReserveSol > walletBalanceSol) {
    return { ok: false, reason: `insufficient balance: need ${(sizeSol + g.feeReserveSol).toFixed(4)}, have ${walletBalanceSol.toFixed(4)}` };
  }
  // Total simultaneous exposure cap.
  if (deployedSol + sizeSol > g.maxDeployedSol) {
    return { ok: false, reason: `exposure ${(deployedSol + sizeSol).toFixed(3)} > cap ${g.maxDeployedSol}` };
  }
  // Rolling 24h spend circuit breaker.
  const spent = s.spends.reduce((a, e) => a + e.sol, 0);
  if (spent + sizeSol > g.maxDailySpendSol) {
    return { ok: false, reason: `24h spend ${(spent + sizeSol).toFixed(3)} > cap ${g.maxDailySpendSol}` };
  }
  return { ok: true };
}

/** Record a real spend against the 24h circuit breaker. Call ONLY after a buy confirms. */
export function recordSpend(sol: number, now = Date.now()): void {
  if (!Number.isFinite(sol) || sol <= 0) return;
  const s = load();
  prune(s, now);
  s.spends.push({ at: now, sol });
  save(s);
}

/** Trip the kill switch — no live spend until resumed. Idempotent. */
export function halt(reason: string): void {
  const s = load();
  s.halted = true;
  s.haltReason = reason;
  save(s);
}

/** Clear the kill switch (a deliberate human action). */
export function resume(): void {
  const s = load();
  s.halted = false;
  s.haltReason = null;
  save(s);
}

export function isHalted(): { halted: boolean; reason: string | null } {
  const s = load();
  return { halted: s.halted, reason: s.haltReason };
}

/**
 * Reconcile the trader's expected hot-wallet balance against the REAL on-chain
 * balance. A drift beyond tolerance means something we don't understand moved the
 * money (a bug, an external spend, a drainer) → HALT immediately. Fail-closed on
 * an unreadable balance too.
 */
export function reconcile(expectedSol: number, actualSol: number): GuardVerdict {
  if (!Number.isFinite(actualSol) || actualSol < 0) {
    halt("reconcile: on-chain balance unreadable");
    return { ok: false, reason: "balance unreadable — HALTED" };
  }
  const drift = Math.abs(expectedSol - actualSol);
  if (drift > config.exec.guard.reconcileToleranceSol) {
    halt(`reconcile drift ${drift.toFixed(4)} SOL (expected ${expectedSol.toFixed(4)}, on-chain ${actualSol.toFixed(4)})`);
    return { ok: false, reason: `drift ${drift.toFixed(4)} SOL — HALTED` };
  }
  return { ok: true };
}

/**
 * The master live gate. Real mainnet spending needs BOTH locks open:
 *   1. LIVE_TRADING_CONFIRMED=yes  (out-of-band env; a browser can never set it)
 *   2. a signing key is reachable — keychain OR file (execution/keystore.ts)
 * and the kill switch must not be tripped. Any failure → not allowed.
 */
export function liveAllowed(): GuardVerdict {
  if (!config.exec.liveConfirmed) {
    return { ok: false, reason: "LIVE not confirmed — set LIVE_TRADING_CONFIRMED=yes in .env (out-of-band)" };
  }
  if (!keyAvailable()) return { ok: false, reason: "no signing key (neither keychain nor key file)" };
  const h = isHalted();
  if (h.halted) return { ok: false, reason: `HALTED: ${h.reason}` };
  return { ok: true };
}

/** Snapshot for the dashboard / logs. */
export function guardStatus(now = Date.now()): {
  halted: boolean;
  haltReason: string | null;
  spentLast24h: number;
  caps: typeof config.exec.guard;
  liveConfirmed: boolean;
} {
  const h = isHalted();
  return {
    halted: h.halted,
    haltReason: h.reason,
    spentLast24h: spentLast24h(now),
    caps: config.exec.guard,
    liveConfirmed: config.exec.liveConfirmed,
  };
}
