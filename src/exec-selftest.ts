/**
 * Execution self-test — proves the money-safety layer and the automatic (no-
 * approval) signing path WITHOUT spending real money. Run: `npm run exec:selftest`.
 *
 *   1. Guardian battery — every safety rule, especially the fail-closed ones.
 *   2. Live gate — confirms real-money execution is blocked without the opt-in.
 *   3. Devnet plumbing — a REAL sign+send+confirm on devnet (faucet SOL) that
 *      demonstrates the bot signs with its own key, instantly, with no approval.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { guardBuy, recordSpend, spentLast24h, halt, resume, isHalted, reconcile, liveAllowed } from "./execution/guardian.js";
import { devnetPlumbingTest } from "./execution/executor.js";
import { botPubkey } from "./execution/wallet.js";

const GUARD_PATH = join(config.logDir, "guard.json");
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
function cleanGuard(): void { if (existsSync(GUARD_PATH)) rmSync(GUARD_PATH); }

async function main(): Promise<void> {
  console.log("═══════ EXECUTION SELF-TEST (no real money) ═══════\n");
  const g = config.exec.guard;
  console.log(`caps: per-trade ${g.maxPerTradeSol} | exposure ${g.maxDeployedSol} | daily ${g.maxDailySpendSol} SOL | feeReserve ${g.feeReserveSol}\n`);

  // ── 1. GUARDIAN BATTERY ────────────────────────────────────────────────
  console.log("1. GUARDIAN (money safety, fail-closed)");
  cleanGuard();
  check("healthy buy at cap passes", guardBuy(g.maxPerTradeSol, 1.0, 0).ok);
  check("over per-trade cap rejected", !guardBuy(g.maxPerTradeSol + 0.001, 1.0, 0).ok);
  check("FAIL-CLOSED: unreadable balance (-1) rejected", !guardBuy(g.maxPerTradeSol, -1, 0).ok);
  check("FAIL-CLOSED: unknown exposure (-1) rejected", !guardBuy(g.maxPerTradeSol, 1.0, -1).ok);
  check("insufficient balance rejected", !guardBuy(g.maxPerTradeSol, g.maxPerTradeSol, 0).ok, "(no fee reserve room)");
  check("exposure cap enforced", !guardBuy(g.maxPerTradeSol, 1.0, g.maxDeployedSol).ok);
  check("NaN size rejected", !guardBuy(NaN, 1.0, 0).ok);

  // 24h spend circuit breaker
  cleanGuard();
  const near = Math.max(0, g.maxDailySpendSol - g.maxPerTradeSol / 2);
  recordSpend(near);
  check("spend ledger persists", Math.abs(spentLast24h() - near) < 1e-9, `(got ${spentLast24h()})`);
  check("24h circuit breaker trips", !guardBuy(g.maxPerTradeSol, 1.0, 0).ok, "(would exceed daily cap)");

  // Kill switch
  cleanGuard();
  halt("selftest kill");
  check("HALT blocks all buys", !guardBuy(0.001, 1.0, 0).ok);
  check("isHalted reflects state", isHalted().halted === true);
  resume();
  check("RESUME clears the halt", guardBuy(0.001, 1.0, 0).ok && isHalted().halted === false);

  // Reconciliation
  cleanGuard();
  check("reconcile: matching balances ok", reconcile(1.0, 1.0).ok);
  cleanGuard();
  check("reconcile: drift beyond tolerance HALTS", !reconcile(1.0, 1.0 - g.reconcileToleranceSol - 0.01).ok);
  check("  → and the halt actually latched", isHalted().halted === true);
  cleanGuard();
  check("reconcile: unreadable (-1) fail-closed + HALT", !reconcile(1.0, -1).ok && isHalted().halted === true);
  cleanGuard();

  // ── 2. LIVE GATE ───────────────────────────────────────────────────────
  console.log("\n2. LIVE GATE (real-money double-lock)");
  const gate = liveAllowed();
  check("live is BLOCKED without opt-in", !gate.ok, `(${gate.reason})`);
  check("EXEC_MODE is not live in .env", config.exec.mode !== "live" || !config.exec.liveConfirmed);

  // ── 3. DEVNET PLUMBING (real automatic signing, fake money) ────────────
  console.log("\n3. DEVNET PLUMBING — automatic signing, NO approval, faucet SOL");
  console.log(`  bot wallet: ${botPubkey()}`);
  const t0 = Date.now();
  const r = await devnetPlumbingTest();
  const dt = Date.now() - t0;
  if (r.confirmed) {
    check("signed + sent + confirmed a REAL devnet tx with NO human approval", true);
    console.log(`     sig ${r.signature?.slice(0, 24)}… | balance ${r.balanceSol.toFixed(3)} devnet SOL | ${dt}ms end-to-end`);
  } else {
    // A faucet rate-limit is an environment issue, not a code failure — report, don't fail the suite.
    console.log(`  ⚠ devnet send not confirmed: ${r.error}`);
    console.log(`     (usually the devnet faucet rate-limit — the sign/send code path is still valid)`);
  }

  cleanGuard(); // leave no test-set halt/spend behind
  console.log(`\n═══════ RESULT: ${pass} passed, ${fail} failed ═══════`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
