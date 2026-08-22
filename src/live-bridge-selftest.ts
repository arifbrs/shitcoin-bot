/**
 * LIVE BRIDGE SELF-TEST — proves the real-money state machine WITHOUT real money and
 * WITHOUT the network. Run: `npm run live-bridge:selftest`.
 *
 * Everything the bridge touches outside itself goes through an injectable `ChainOps`, so
 * this suite can stage the failures you cannot rehearse on mainnet: a buy whose
 * confirmation times out and then lands anyway, a bag that appears after we gave up on it,
 * a sell that keeps failing, a paper position that closes while a real bag is still held.
 *
 * Each check maps to one of the six invariants at the top of execution/live-bridge.ts.
 * The last section is the only one that touches the network (read-only, no key use): it
 * verifies the hand-built ATA derivation against real mainnet accounts, because a wrong
 * derivation would silently skip every rent reclaim.
 */
/**
 * The refusal path cannot be tested in this process: `config.exec.liveConfirmed` is read from
 * the environment once, at import. So the suite re-execs ITSELF with the permission absent and
 * asks that child whether writeControl still refuses. Testing it any other way would mean
 * adding a test-only bypass to the very guard being tested.
 */
const NOPERM_CHILD = process.env.LIVE_BRIDGE_NOPERM_CHILD === "1";

/**
 * ISOLATED STATE DIR. The suite used to stash/restore the RUNNING bot's control.json,
 * guard.json, live-lots.json and live-exec log. Stash-and-restore is not isolation: between the
 * two there is a window in which a live bot reads whatever the test wrote — and control.json is
 * the file that decides whether real money is spent. Now the whole suite runs against a throwaway
 * directory and production is never opened at all.
 */
if (!process.env.LOG_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "live-bridge-selftest-"));
  process.env.LOG_DIR = dir;
}

process.env.EXEC_MODE = "live";
// The child sets "no" rather than DELETING the variable. Deleting looks equivalent and is not:
// dotenv only skips keys already present in process.env, so once the real .env gained
// LIVE_TRADING_CONFIRMED=yes, a deleted key was simply repopulated from the file and the child
// came up PERMITTED. The negative test then silently passed nothing — it went hollow at the
// exact moment the permission became real, which is the only moment it protects anything.
process.env.LIVE_TRADING_CONFIRMED = NOPERM_CHILD ? "no" : "yes";
process.env.LIVE_BUY_SETTLE_MS = "40";     // don't wait 3 minutes to test the timeout path
process.env.LIVE_RECONCILE_MS = "3600000"; // no background timers during the suite
process.env.LIVE_SWEEP_MS = "3600000";
process.env.LIVE_TRADE_SIZE_SOL = "0.02";
process.env.LIVE_MAX_SELL_FAILURES = "3";

import { existsSync, rmSync, readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

/** A scriptable stand-in for mainnet. Balances, fills and failures are all dictated here. */
class FakeChain {
  sol = 1.0;
  tokens = new Map<string, number>();
  buyResult: { ok: boolean; timedOut?: boolean; err?: string | null } = { ok: true };
  sellResult: { ok: boolean; timedOut?: boolean; err?: string | null } = { ok: true };
  /**
   * Did the sell actually LAND on chain? Separate from `sellResult` on purpose: the case that
   * matters most is a sell reported as timed out that nevertheless emptied the bag. Leaving
   * these two coupled is how a harness quietly stops testing the thing it was written for.
   * null = follow sellResult.ok.
   */
  sellLands: boolean | null = null;
  /** Set true to simulate a gate that refuses exits — production must NEVER do this. */
  exitBlocked = false;
  /** Tokens credited on a buy. 0 = the fill never arrives (or not yet). */
  fillTokens = 1_000_000;
  solPerFullSell = 0.019;
  calls: string[] = [];
  balanceReadable = true;
  tokenReadable = true;
  ataRent = 0.00203928;

  ops() {
    return {
      balanceSol: async () => (this.balanceReadable ? this.sol : null),
      tokenBalance: async (mint: string) => (this.tokenReadable ? (this.tokens.get(mint) ?? 0) : null),
      buy: async (mint: string, sizeSol: number) => {
        this.calls.push(`buy:${mint}:${sizeSol}`);
        if (this.buyResult.ok || this.buyResult.timedOut) {
          if (this.fillTokens > 0) {
            this.tokens.set(mint, (this.tokens.get(mint) ?? 0) + this.fillTokens);
            this.sol -= sizeSol;
          }
        }
        return { ...this.buyResult, signature: "sigbuy" };
      },
      sell: async (mint: string, amount: number | string) => {
        // MODEL THE REAL GATE. The fake used to sell unconditionally, so "a HALT does not
        // strand the bag" passed here while production did the exact opposite: liveSell went
        // through liveAllowed(), which includes the kill switch, so a halt blocked every exit.
        // A fake that is more permissive than production turns its test into a decoration.
        if (this.exitBlocked) return { ok: false, err: "live blocked: HALTED" };
        this.calls.push(`sell:${mint}:${amount}`);
        if (this.sellLands ?? this.sellResult.ok) {
          const have = this.tokens.get(mint) ?? 0;
          const qty = amount === "100%" ? have : Math.min(have, Number(amount));
          this.tokens.set(mint, have - qty);
          this.sol += this.solPerFullSell * (have > 0 ? qty / have || 0 : 0);
        }
        return { ...this.sellResult, signature: "sigsell" };
      },
      closeAta: async (mint: string) => {
        this.calls.push(`ata:${mint}`);
        this.sol += this.ataRent;
        return this.ataRent;
      },
      now: () => Date.now(),
      sleep: async () => {},
    };
  }
}

/** The child half: no permission in the environment — does the server-side guard hold? */
async function noPermissionChild(): Promise<void> {
  const { config } = await import("./config.js");
  const control = await import("./control.js");
  const B = await import("./execution/live-bridge.js");
  const got = control.writeControl({ execMode: "live" }).execMode;
  const ok = config.exec.liveConfirmed === false && got !== "live" && B.bridgePermitted() === false && B.bridgeArmed() === false;
  console.log(`NOPERM_RESULT ${ok ? "OK" : "FAIL"} liveConfirmed=${config.exec.liveConfirmed} execMode=${got} permitted=${B.bridgePermitted()} armed=${B.bridgeArmed()}`);
  process.exit(0);
}

async function main(): Promise<void> {
  const { config } = await import("./config.js");
  const B = await import("./execution/live-bridge.js");
  const { resume, isHalted } = await import("./execution/guardian.js");
  const control = await import("./control.js");

  // Everything below writes into the throwaway LOG_DIR set at the top of this file, so there
  // is nothing to stash and nothing to put back.
  const restore = () => {
    try { rmSync(config.logDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  console.log("═══════ LIVE BRIDGE SELF-TEST (fake chain, no real money) ═══════\n");

  const fresh = (): FakeChain => {
    const c = new FakeChain();
    B.__resetForTest();
    B.__setChainForTest(c.ops());
    B.__setPermittedForTest(true);
    B.__setArmedForTest(true);
    B.__setPaperProbeForTest(() => true);
    resume();
    return c;
  };

  // ── 0. THE TWO LOCKS ──────────────────────────────────────────────────────
  console.log("0. PERMISSION (.env) vs ACTIVATION (the button)");
  B.__resetForTest();
  B.__setPermittedForTest(null); // fall back to the real config
  B.__setArmedForTest(null);
  check("permission comes from .env alone", B.bridgePermitted() === config.exec.liveConfirmed);
  check("armed requires permission AND the console switch",
    B.bridgeArmed() === (config.exec.liveConfirmed && control.readControl().execMode === "live"));

  // NOT PERMITTED = completely inert. This is the state a browser can never leave.
  B.__setPermittedForTest(false);
  B.__setArmedForTest(true); // even with the button "on"
  const c0 = new FakeChain();
  B.__setChainForTest(c0.ops());
  B.bridgeOpen({ tradeId: "t0", mint: "M0", sizeSol: 0.05 });
  B.bridgeClose("t0", "M0", "TEST");
  B.bridgeSellFraction("t0", "M0", 0.5, "TEST");
  await B.__drainForTest();
  check("NOT PERMITTED: the button alone does nothing at all",
    B.__lotsForTest().size === 0 && c0.calls.length === 0);

  // Server-side gate, POSITIVE direction: with permission, the switch takes.
  const before = control.readControl().execMode;
  check("writeControl accepts 'live' WITH the .env permission",
    control.writeControl({ execMode: "live" }).execMode === "live");
  control.writeControl({ execMode: before });

  // Server-side gate, NEGATIVE direction — the one that actually protects the money. Run in a
  // child with the permission stripped from the environment (see the note at the top).
  // process.execArgv carries tsx's own --require/--import loader flags; without them the
  // child would be plain node and could not run a .ts file at all.
  const child = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!], {
    env: { ...process.env, LIVE_BRIDGE_NOPERM_CHILD: "1", LIVE_TRADING_CONFIRMED: "no" },
    encoding: "utf8",
  });
  const out = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const line = out.split("\n").find((l) => l.startsWith("NOPERM_RESULT")) ?? "(no result)";
  check("WITHOUT the .env permission the button is refused server-side", line.includes("NOPERM_RESULT OK"), `(${line.trim()})`);

  // PERMITTED but DISARMED = no new buys, but exits still work. The asymmetry is the point:
  // flipping the button back to PAPER must never strand a real bag.
  const c0b = new FakeChain();
  B.__resetForTest();
  B.__setChainForTest(c0b.ops());
  B.__setPermittedForTest(true);
  B.__setArmedForTest(true);
  B.__setPaperProbeForTest(() => true);
  B.bridgeOpen({ tradeId: "t0b", mint: "M0B", sizeSol: 0.05 });
  await B.__drainForTest();
  B.__setArmedForTest(false); // owner presses PAPER while a real bag is held
  B.bridgeOpen({ tradeId: "t0c", mint: "M0C", sizeSol: 0.05 });
  await B.__drainForTest();
  check("DISARMED: no new buys", !c0b.calls.some((x) => x.startsWith("buy:M0C")));
  B.bridgeClose("t0b", "M0B", "DISARM_EXIT");
  await B.__drainForTest();
  check("DISARMED: the exit on an existing bag STILL runs",
    c0b.calls.includes("sell:M0B:100%") && (c0b.tokens.get("M0B") ?? 0) === 0);

  // ── 1. SIZE CLAMP ─────────────────────────────────────────────────────────
  console.log("\n1. SIZE (real money never inherits the paper stake)");
  const g = config.exec.guard;
  // These two describe the FIXED-CLIP rule, which is only the rule when compounding is off.
  // Asserting them unconditionally made the suite fail on a correctly-compounding config —
  // the same trap as the live-gate check that assumed live could never be permitted.
  if (!config.exec.live.compound) {
    check("live size is min(live.sizeSol, per-trade cap, paper size)",
      B.__liveSizeForTest(0.05) === Math.min(Math.max(config.exec.live.sizeSol, config.exec.live.minSol), g.maxPerTradeSol, 0.05));
  } else {
    check("compound on: size tracks the wallet, not the fixed clip",
      B.__liveSizeForTest(999, 1.0) !== config.exec.live.sizeSol || config.exec.live.sizeSol === (1.0 * config.exec.live.riskPct) / 100);
  }
  check("a smaller paper stake wins", B.__liveSizeForTest(0.001) === Math.min(0.001, config.exec.live.minSol) || B.__liveSizeForTest(0.001) === 0.001);
  check("never exceeds the per-trade cap", B.__liveSizeForTest(999) <= g.maxPerTradeSol);
  // COMPOUNDING sizes off the REAL wallet snapshot, never the paper float.
  {
    const L = config.exec.live;
    const pctOf = (bal: number) => Math.min(Math.max((bal * L.riskPct) / 100, L.minSol), g.maxPerTradeSol, 999);
    if (L.compound) {
      check("compound: grows with the wallet", B.__liveSizeForTest(999, 1.0) === pctOf(1.0));
      check("compound: SHRINKS with the wallet too", B.__liveSizeForTest(999, 0.1) === pctOf(0.1));
      check("compound: never below the floor", B.__liveSizeForTest(999, 0.0001) >= L.minSol);
    } else {
      check("compound OFF: size is the fixed clip", B.__liveSizeForTest(999, 1.0) === Math.min(Math.max(L.sizeSol, L.minSol), g.maxPerTradeSol));
    }
    // The rule that protects the wallet on a bad read: an UNKNOWN balance must never size UP.
    check("unknown balance falls back to the fixed clip, never guesses upward",
      B.__liveSizeForTest(999, null) <= Math.max(L.sizeSol, L.minSol));
    check("still capped by the paper stake it mirrors", B.__liveSizeForTest(0.002, 10) <= 0.002 || B.__liveSizeForTest(0.002, 10) === L.minSol);
  }

  // ── 2. HAPPY PATH ─────────────────────────────────────────────────────────
  console.log("\n2. HAPPY PATH (open → scale-out → close → rent reclaim)");
  let c = fresh();
  B.bridgeOpen({ tradeId: "t1", mint: "M1", symbol: "AAA", sizeSol: 0.05 });
  await B.__drainForTest();
  let lot = B.__lotsForTest().get("t1")!;
  check("lot opens with the REAL observed token quantity", lot?.state === "open" && lot.tokensBought === 1_000_000);
  check("spend is MEASURED from the balance delta, not assumed",
    Math.abs(lot.spentSol - config.exec.live.sizeSol) < 1e-9, `(got ${lot?.spentSol})`);
  check("exposure counts the open lot", Math.abs(B.deployedLiveSol() - lot.spentSol) < 1e-9);

  B.bridgeSellFraction("t1", "M1", 0.25, "SCALE_OUT_T0");
  await B.__drainForTest();
  check("partial sells a fraction of the ORIGINAL quantity", c.calls.includes("sell:M1:250000"));
  check("lot stays open after a partial", B.__lotsForTest().get("t1")!.state === "open");

  B.bridgeClose("t1", "M1", "TRAIL");
  await B.__drainForTest();
  lot = B.__lotsForTest().get("t1")!;
  check("full exit uses PumpPortal '100%' (no dust left by rounding)", c.calls.includes("sell:M1:100%"));
  check("settles only once the chain reports an empty bag", lot.state === "closed" && (c.tokens.get("M1") ?? 0) === 0);
  check("ATA rent is reclaimed on settle", lot.rentReclaimedSol > 0 && lot.ataClosed === true);
  check("closed lot leaves exposure", B.deployedLiveSol() === 0);

  // ── 3. INVARIANT 1 — real balance is truth ────────────────────────────────
  console.log("\n3. INVARIANT 1 — the chain decides how much we can sell");
  c = fresh();
  B.bridgeOpen({ tradeId: "t2", mint: "M2", sizeSol: 0.05 });
  await B.__drainForTest();
  c.tokens.set("M2", 400_000); // reality: most of the bag is gone (an external transfer/burn)
  B.bridgeSellFraction("t2", "M2", 0.9, "SCALE_OUT");
  await B.__drainForTest();
  check("a partial is clamped to the REAL balance, never the model's",
    c.calls.includes("sell:M2:400000"), `(calls ${c.calls.join(",")})`);

  c = fresh();
  B.bridgeOpen({ tradeId: "t3", mint: "M3", sizeSol: 0.05 });
  await B.__drainForTest();
  c.tokenReadable = false;
  B.bridgeClose("t3", "M3", "STOP");
  await B.__drainForTest();
  check("FAIL-CLOSED: unreadable token balance never sells blind",
    !c.calls.some((x) => x.startsWith("sell:M3")) && B.__lotsForTest().get("t3")!.state === "stuck");
  check("  → and the bag is NOT forgotten", B.__lotsForTest().has("t3"));

  // ── 4. INVARIANT 2 — a timeout is not a failure ───────────────────────────
  console.log("\n4. INVARIANT 2 — a confirmation timeout is never 'no position'");
  c = fresh();
  c.buyResult = { ok: false, timedOut: true, err: "confirmation timeout" };
  B.bridgeOpen({ tradeId: "t4", mint: "M4", sizeSol: 0.05 });
  await B.__drainForTest();
  lot = B.__lotsForTest().get("t4")!;
  check("a timed-out buy that DID land is adopted as a real position",
    lot.state === "open" && lot.tokensBought === 1_000_000 && lot.buyTimedOut === true);

  c = fresh();
  c.buyResult = { ok: false, timedOut: true, err: "confirmation timeout" };
  c.fillTokens = 0; // nothing arrives inside the window
  B.bridgeOpen({ tradeId: "t5", mint: "M5", sizeSol: 0.05 });
  await B.__drainForTest();
  check("a timed-out buy with no fill is kept as UNRESOLVED, not deleted",
    B.__lotsForTest().get("t5")!.state === "stuck");
  // ...and now the tx lands, minutes later, exactly as mainnet does under congestion.
  c.tokens.set("M5", 900_000);
  await B.__sweepForTest();
  await B.__drainForTest();
  lot = B.__lotsForTest().get("t5")!;
  check("INVARIANT 3: the sweeper finds the late fill and adopts it",
    lot.tokensBought === 900_000, `(state ${lot.state}, tokens ${lot.tokensBought})`);

  // ── 5. INVARIANT 4 — orphan sweep ─────────────────────────────────────────
  console.log("\n5. INVARIANT 4 — a bag whose paper position is gone gets liquidated");
  c = fresh();
  B.bridgeOpen({ tradeId: "t6", mint: "M6", sizeSol: 0.05 });
  await B.__drainForTest();
  B.__setPaperProbeForTest(() => false); // the brain closed this trade; the bag is still ours
  await B.__sweepForTest();
  await B.__drainForTest();
  check("orphaned bag is sold in full", c.calls.includes("sell:M6:100%"));
  check("  → and settles to closed", B.__lotsForTest().get("t6")!.state === "closed");

  // ── 6. INVARIANT 5 — per-mint ordering ────────────────────────────────────
  console.log("\n6. INVARIANT 5 — a sell can never overtake its own buy");
  c = fresh();
  B.bridgeOpen({ tradeId: "t7", mint: "M7", sizeSol: 0.05 });
  B.bridgeClose("t7", "M7", "IMMEDIATE"); // fired in the same tick as the open
  await B.__drainForTest();
  const iBuy = c.calls.findIndex((x) => x.startsWith("buy:M7"));
  const iSell = c.calls.findIndex((x) => x.startsWith("sell:M7"));
  check("buy is executed before the sell", iBuy >= 0 && iSell > iBuy, `(${c.calls.join(" → ")})`);
  check("the immediate exit still settles", B.__lotsForTest().get("t7")!.state === "closed");

  // ── 7. STUCK BAG → KILL SWITCH ────────────────────────────────────────────
  console.log("\n7. AN UNSELLABLE BAG TRIPS THE KILL SWITCH");
  c = fresh();
  B.bridgeOpen({ tradeId: "t8", mint: "M8", sizeSol: 0.05 });
  await B.__drainForTest();
  c.sellResult = { ok: false, err: "route failed" };
  for (let i = 0; i < config.exec.live.maxSellFailures; i++) {
    B.bridgeClose("t8", "M8", "STOP");
    await B.__drainForTest();
  }
  check(`HALT after ${config.exec.live.maxSellFailures} failed exits`, isHalted().halted === true,
    `(failures ${B.__lotsForTest().get("t8")!.sellFailures})`);
  check("the stuck lot is retained for retry", B.__lotsForTest().get("t8")!.state === "stuck");
  // A HALT must stop BUYING, never stop us from getting out.
  c.sellResult = { ok: true };
  await B.__sweepForTest();
  await B.__drainForTest();
  check("a HALT does not strand the bag — the exit still runs",
    B.__lotsForTest().get("t8")!.state === "closed" && (c.tokens.get("M8") ?? 0) === 0);
  // And prove it against the real module, not just the fake: the exit gate must ignore the halt.
  {
    const { liveAllowed, liveExitAllowed, halt: h, resume: rs } = await import("./execution/guardian.js");
    h("selftest: exit gate");
    check("HALT blocks BUYING (liveAllowed)", !liveAllowed().ok);
    check("HALT does NOT block SELLING (liveExitAllowed)", liveExitAllowed().ok,
      `(${liveExitAllowed().reason ?? ""}) — a halt must never trap a real bag`);
    rs();
  }
  resume();

  // ── 8. INVARIANT 6 — unexplained movement ─────────────────────────────────
  console.log("\n8. INVARIANT 6 — unexplained balance movement HALTS");
  c = fresh();
  B.bridgeOpen({ tradeId: "t9", mint: "M9", sizeSol: 0.05 });
  await B.__drainForTest();
  await B.__reconcileForTest();
  check("a quiet wallet does not trip anything", isHalted().halted === false);
  c.sol -= g.reconcileToleranceSol + 0.01; // someone else moved our money
  await B.__reconcileForTest();
  check("drift beyond tolerance trips the kill switch", isHalted().halted === true);
  resume();
  c = fresh();
  B.bridgeOpen({ tradeId: "t10", mint: "MA", sizeSol: 0.05 });
  await B.__drainForTest();
  c.balanceReadable = false;
  await B.__reconcileForTest();
  check("a transient RPC failure is NOT treated as theft", isHalted().halted === false);

  // ── 9. IDEMPOTENCE ────────────────────────────────────────────────────────
  console.log("\n9. IDEMPOTENCE (overlapping ticks must not double-spend)");
  c = fresh();
  B.bridgeOpen({ tradeId: "t11", mint: "MB", sizeSol: 0.05 });
  B.bridgeOpen({ tradeId: "t11", mint: "MB", sizeSol: 0.05 });
  B.bridgeOpen({ tradeId: "t11", mint: "MB", sizeSol: 0.05 });
  await B.__drainForTest();
  check("the same tradeId buys exactly once",
    c.calls.filter((x) => x.startsWith("buy:MB")).length === 1, `(${c.calls.filter((x) => x.startsWith("buy:MB")).length})`);
  B.bridgeClose("t11", "MB", "X");
  await B.__drainForTest();
  const sellsBefore = c.calls.filter((x) => x.startsWith("sell:MB")).length;
  B.bridgeClose("t11", "MB", "X");
  await B.__drainForTest();
  check("a closed lot cannot be sold again",
    c.calls.filter((x) => x.startsWith("sell:MB")).length === sellsBefore);

  // ── 10. ATA DERIVATION (read-only mainnet, no key use) ────────────────────
  console.log("\n10. ATA DERIVATION vs real mainnet accounts (rent reclaim depends on it)");
  B.__setChainForTest(null);
  B.__setArmedForTest(null);
  B.__setPermittedForTest(null);
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    // BONK, not USDC: `getTokenLargestAccounts` on a mint with millions of holders is
    // rejected outright ("too many accounts requested") by every endpoint in our pool.
    const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    let matched = 0;
    let checked = 0;
    for (const url of config.rpcEndpoints.slice(0, 5)) {
      try {
        const conn = new Connection(url, "confirmed");
        const largest = await conn.getTokenLargestAccounts(new PublicKey(MINT));
        for (const a of largest.value.slice(0, 10)) {
          const info = await conn.getParsedAccountInfo(a.address);
          const owner = (info.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner;
          if (!owner) continue;
          checked++;
          if (B.__ataForTest(owner, MINT) === a.address.toBase58()) matched++;
        }
        if (checked > 0) break;
      } catch { /* free tiers rate-limit and refuse; try the next endpoint */ }
    }
    // Not every large holder uses an ATA (program vaults are PDAs), so this is a
    // "reproduces real ATAs" check, not an "all of them" check.
    if (checked === 0) console.log("  ⚠ no endpoint answered — derivation unverified this run");
    else check(`derivation reproduces real mainnet ATAs (${matched}/${checked} largest BONK accounts)`, matched >= Math.ceil(checked * 0.5));
  } catch (e) {
    console.log(`  ⚠ mainnet read failed (${(e as Error).message}) — derivation unverified this run`);
  }

  // ── 11. CONCURRENCY: two exits racing on one mint ─────────────────────────
  console.log("\n11. DUA EXIT BALAPAN DI MINT YANG SAMA");
  c = fresh();
  // A sell that takes a while — the window in which a second exit could double-fire.
  const slow = c.ops();
  const baseSell = slow.sell;
  let sellsInFlight = 0;
  let maxConcurrentSells = 0;
  B.__setChainForTest({
    ...slow,
    sell: async (mint: string, amount: number | string) => {
      sellsInFlight++;
      maxConcurrentSells = Math.max(maxConcurrentSells, sellsInFlight);
      await new Promise((r) => setTimeout(r, 30));
      try { return await baseSell(mint, amount); } finally { sellsInFlight--; }
    },
  });
  B.bridgeOpen({ tradeId: "t12", mint: "MC", sizeSol: 0.05 });
  await B.__drainForTest();
  // EARLY_CUT and the trail can both decide to exit on the same tick.
  B.bridgeClose("t12", "MC", "EARLY_CUT");
  B.bridgeClose("t12", "MC", "TRAIL");
  B.bridgeSellFraction("t12", "MC", 0.5, "SCALE_OUT");
  await B.__drainForTest();
  check("never two sells in flight at once", maxConcurrentSells === 1, `(peak ${maxConcurrentSells})`);
  check("the bag is sold exactly once", c.calls.filter((x) => x.startsWith("sell:MC")).length === 1,
    `(${c.calls.filter((x) => x.startsWith("sell:MC")).length} sells)`);
  check("settles closed with an empty bag", B.__lotsForTest().get("t12")!.state === "closed" && (c.tokens.get("MC") ?? 0) === 0);

  // ── 12. A SELL WHOSE CONFIRMATION TIMES OUT BUT LANDS ─────────────────────
  console.log("\n12. SELL TIMEOUT YANG TERNYATA MENDARAT");
  c = fresh();
  B.bridgeOpen({ tradeId: "t13", mint: "MD", sizeSol: 0.05 });
  await B.__drainForTest();
  c.sellResult = { ok: false, timedOut: true, err: "confirmation timeout" };
  c.sellLands = true; // reported as a timeout, but the tx landed
  B.bridgeClose("t13", "MD", "STOP");
  await B.__drainForTest();
  check("a timed-out sell that emptied the bag settles as closed",
    B.__lotsForTest().get("t13")!.state === "closed", `(state ${B.__lotsForTest().get("t13")!.state})`);
  check("  → and is NOT counted as a failure", B.__lotsForTest().get("t13")!.sellFailures === 0);

  // The mirror image: timed out AND did not land. The bag is still ours, so the lot must stay
  // open for retry — the one outcome that must never be mistaken for a completed exit.
  c = fresh();
  B.bridgeOpen({ tradeId: "t14", mint: "ME", sizeSol: 0.05 });
  await B.__drainForTest();
  c.sellResult = { ok: false, timedOut: true, err: "confirmation timeout" };
  c.sellLands = false;
  B.bridgeClose("t14", "ME", "STOP");
  await B.__drainForTest();
  check("a timed-out sell that did NOT land keeps the lot alive",
    B.__lotsForTest().get("t14")!.state !== "closed" && (c.tokens.get("ME") ?? 0) > 0,
    `(state ${B.__lotsForTest().get("t14")!.state})`);
  c.sellResult = { ok: true };
  c.sellLands = null;
  await B.__sweepForTest();
  await B.__drainForTest();
  check("  → and the sweeper finishes the exit", B.__lotsForTest().get("t14")!.state === "closed");

  // ── 13. RPC POOL (real network, read-only) ────────────────────────────────
  console.log("\n13. RPC — jalur uang harus lewat pool, bukan satu endpoint");
  B.__setChainForTest(null);
  // Static guard: the raw-Connection bug fixed here has already recurred twice in this repo
  // (safety/metadata.ts, then executor.ts's simulateBuyMainnet). Assert it cannot come back.
  const execDir = join(new URL("./execution/", import.meta.url).pathname);
  const offenders = readdirSync(execDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => {
      const src = readFileSync(join(execDir, f), "utf8");
      // rpc.ts names the anti-pattern in prose; only real code counts.
      return src.split("\n").some((l) => l.includes("new Connection(config.rpcUrl") && !l.trimStart().startsWith("*"));
    });
  check("no module in execution/ builds its own mainnet Connection", offenders.length === 0, `(${offenders.join(", ")})`);

  try {
    const { poolBalanceSol } = await import("./execution/rpc.js");
    const { botPubkey } = await import("./execution/wallet.js");
    const bal = await poolBalanceSol(botPubkey());
    // With several free-tier keys answering 429 at any given moment, a successful read here IS
    // the failover demonstration — a single pinned endpoint would return null.
    check("pooled balance read succeeds across the live pool", typeof bal === "number" && bal >= 0, `(got ${bal})`);
  } catch (e) {
    console.log(`  ⚠ pooled balance read unavailable (${(e as Error).message.slice(0, 50)})`);
  }

  // ── 14. PUMPPORTAL REFUSES TO BUILD (real endpoint, nothing sent) ─────────
  console.log("\n14. PUMPPORTAL MENOLAK BUILD");
  try {
    const { buildBuyTx, buildSellTx } = await import("./execution/executor.js");
    const { botPubkey } = await import("./execution/wallet.js");
    // A mint that cannot possibly have a route. buildBuyTx BUILDS ONLY — it never signs and
    // never sends, so this costs nothing and risks nothing even though it hits the real API.
    const dead = "1nva1idM1nt1111111111111111111111111111111";
    const b = await buildBuyTx(botPubkey(), dead, 0.001);
    check("a build refusal returns null, not a throw", b === null, `(got ${b === null ? "null" : `${(b as Uint8Array).length} bytes`})`);
    const sv = await buildSellTx(botPubkey(), dead, 1);
    check("the same holds for a sell build", sv === null);
    const { liveBuy } = await import("./execution/executor.js");
    // End-to-end: with the build refused there is nothing to sign, so liveBuy must report a
    // clean failure — no signature, no timeout, nothing to reconcile.
    const r = await liveBuy(dead, 0.001, 0);
    check("liveBuy on an unbuildable mint fails CLEANLY (no sig, no timeout)",
      r.ok === false && !r.signature && !r.timedOut, `(${JSON.stringify(r)})`);
  } catch (e) {
    console.log(`  ⚠ PumpPortal unreachable (${(e as Error).message.slice(0, 50)}) — build-refusal path unverified this run`);
  }

  restore();
  console.log(`\n═══════ RESULT: ${pass} passed, ${fail} failed ═══════`);
  process.exit(fail === 0 ? 0 : 1);
}

void (NOPERM_CHILD ? noPermissionChild() : main());
