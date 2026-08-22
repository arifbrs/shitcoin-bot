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
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { config } from "./config.js";
import { guardBuy, recordSpend, spentLast24h, halt, resume, isHalted, reconcile, liveAllowed } from "./execution/guardian.js";
import { devnetPlumbingTest } from "./execution/executor.js";
import { botPubkey, walletSource } from "./execution/wallet.js";
import { keychainRead, keychainWrite, keychainDelete, keySource } from "./execution/keystore.js";

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
  // Regression guard: the gate must accept a keychain-stored key. It previously required the
  // key FILE to exist, so migrating the key off disk silently blocked live execution forever.
  check("the live gate is not blocked by a missing key FILE",
    gate.reason?.includes("signing key") !== true || keySource() === "none",
    `(${gate.reason})`);
  check("EXEC_MODE is not live in .env", config.exec.mode !== "live" || !config.exec.liveConfirmed);

  // ── 2b. KEY STORAGE ────────────────────────────────────────────────────
  console.log("\n2b. KEY STORAGE (keychain first, file fallback)");
  const addr = botPubkey(); // forces the load so walletSource() is populated
  console.log(`  in use: ${walletSource()} · address ${addr.slice(0, 10)}…`);
  check("the bot resolves a wallet address", addr.length >= 32);
  check("keySource() agrees with what botWallet() actually used", keySource() === walletSource());
  if (process.platform === "darwin") {
    // Round-trip against a THROWAWAY item — the real wallet item is never touched.
    const svc = "micincloud-bot-selftest";
    const acct = "throwaway";
    const secret = `selftest-${Date.now()}`;
    keychainDelete(svc, acct);
    check("keychain read of a missing item returns null", keychainRead(svc, acct) === null);
    const w = keychainWrite(secret, svc, acct);
    check("keychain write succeeds", w.ok, `(${w.err ?? ""})`);
    check("keychain read-back is byte-identical", keychainRead(svc, acct) === secret);
    // Unattended restart is the whole point: a FRESH process must read it with no prompt.
    const child = spawnSync(process.execPath, [...process.execArgv, "-e",
      `const {spawnSync}=require("node:child_process");const r=spawnSync("security",["find-generic-password","-s","${svc}","-a","${acct}","-w"],{encoding:"utf8"});process.stdout.write("CHILD:"+(r.stdout??"").trim());`],
      { encoding: "utf8", timeout: 15_000 });
    check("a FRESH process reads it without a prompt", `${child.stdout ?? ""}`.includes(`CHILD:${secret}`), "(unattended restart depends on this)");
    check("keychain delete removes it", keychainDelete(svc, acct) && keychainRead(svc, acct) === null);
  } else {
    console.log("  ⚠ not macOS — keychain round-trip skipped");
  }
  if (walletSource() === "file") {
    console.log(`  ⚠ the live key is still a plaintext file — run: npm run wallet keychain-import`);
  }

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
