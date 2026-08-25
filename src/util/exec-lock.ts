import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * CROSS-PROCESS EXECUTION LOCK (2026-08-24) — one trade bracket at a time, wallet-wide.
 *
 * Why: S1 (sniper bridge) and S2 (live mirror) both trade from the SAME wallet, in DIFFERENT
 * processes. Both measured spends/proceeds as wallet-balance deltas around their own tx — and
 * the moment their brackets overlapped, each captured the other's SOL movement: COTUS booked
 * spent 0.0004◎ against 0.012◎ proceeds (+2709% phantom), Shitface booked spent 0. A lockfile
 * serializes the brackets across processes, which makes delta accounting safe again.
 *
 * mkdir is atomic on all platforms — first process to create the directory holds the lock.
 * A crashed holder cannot deadlock trading: the lock carries its own timestamp and is stolen
 * after STALE_MS. If the wait budget expires we proceed UNLOCKED with a loud warning — a
 * degraded measurement must never become a stopped trader.
 */
const LOCK_PATH = join(config.logDir, "exec-lock");
const STALE_MS = 60_000;
const WAIT_BUDGET_MS = 45_000;
const POLL_MS = 200;

function tryAcquire(): boolean {
  try {
    mkdirSync(LOCK_PATH);
    writeFileSync(join(LOCK_PATH, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    // Held by someone else — steal it if stale.
    try {
      const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
      if (age > STALE_MS) {
        rmSync(LOCK_PATH, { recursive: true, force: true });
        return tryAcquire();
      }
    } catch { /* vanished between exists and stat — retry on next poll */ }
    return false;
  }
}

export async function withExecLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!tryAcquire()) {
    if (Date.now() > deadline) {
      console.warn("[exec-lock] wait budget habis — lanjut TANPA lock (akuntansi delta bisa tumpang-tindih)");
      return fn();
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    try { rmSync(LOCK_PATH, { recursive: true, force: true }); } catch { /* next holder steals it */ }
  }
}
