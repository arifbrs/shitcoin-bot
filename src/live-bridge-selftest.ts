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
  /**
   * REAL COSTS, off by default so the existing cases keep their round numbers.
   *
   * Turn on for the accounting cases: a buy then costs order size + gas + ATA rent, and a full
   * sell returns proceeds − gas + that rent. Those are the mainnet-measured shapes, and the
   * whole 2026-08-25 audit finding was that the bridge booked the ORDER SIZE instead — a fake
   * with no fees is a fake that can never notice.
   */
  chargeFees = false;
  gasPerTx = 0.000055;
  /** Real SOL each signature moved, exactly as this fake applied it to `sol`. */
  txDeltas = new Map<string, number>();
  /** null = the chain will not tell us (dropped tx / every endpoint down). */
  txDeltaReadable = true;
  /** Mints whose ATA still exists — rent can be reclaimed once, by whoever gets there first. */
  ataOpen = new Set<string>();
  private sigN = 0;

  ops() {
    return {
      balanceSol: async () => (this.balanceReadable ? this.sol : null),
      tokenBalance: async (mint: string) => (this.tokenReadable ? (this.tokens.get(mint) ?? 0) : null),
      buy: async (mint: string, sizeSol: number) => {
        this.calls.push(`buy:${mint}:${sizeSol}`);
        const solBefore = this.sol; // production liveBuy returns its pre-buy balance read
        const sig = `sigbuy${++this.sigN}`;
        if (this.buyResult.ok || this.buyResult.timedOut) {
          if (this.fillTokens > 0) {
            this.tokens.set(mint, (this.tokens.get(mint) ?? 0) + this.fillTokens);
            const cost = sizeSol + (this.chargeFees ? this.gasPerTx + this.ataRent : 0);
            if (this.chargeFees) this.ataOpen.add(mint);
            this.sol -= cost;
            this.txDeltas.set(sig, -cost);
          }
        }
        return { ...this.buyResult, signature: sig, balanceBefore: solBefore };
      },
      sell: async (mint: string, amount: number | string) => {
        // MODEL THE REAL GATE. The fake used to sell unconditionally, so "a HALT does not
        // strand the bag" passed here while production did the exact opposite: liveSell went
        // through liveAllowed(), which includes the kill switch, so a halt blocked every exit.
        // A fake that is more permissive than production turns its test into a decoration.
        if (this.exitBlocked) return { ok: false, err: "live blocked: HALTED" };
        this.calls.push(`sell:${mint}:${amount}`);
        const sig = `sigsell${++this.sigN}`;
        if (this.sellLands ?? this.sellResult.ok) {
          const have = this.tokens.get(mint) ?? 0;
          const qty = amount === "100%" ? have : Math.min(have, Number(amount));
          this.tokens.set(mint, have - qty);
          const emptied = have - qty <= 0;
          // The sell route closes the ATA when it sweeps the bag — which is why the rent comes
          // back inside the proceeds, and why booking the buy at order size double-counted it.
          const sweptRent = this.chargeFees && emptied && this.ataOpen.delete(mint) ? this.ataRent : 0;
          const got = this.solPerFullSell * (have > 0 ? qty / have || 0 : 0)
            - (this.chargeFees ? this.gasPerTx : 0)
            + sweptRent;
          this.sol += got;
          this.txDeltas.set(sig, got);
        }
        return { ...this.sellResult, signature: sig };
      },
      closeAta: async (mint: string) => {
        this.calls.push(`ata:${mint}`);
        // With fees modelled, the sell route already swept the rent — closing again finds
        // nothing, which is exactly what mainnet reports (0 token accounts, 0 ata-closed).
        if (this.chargeFees && !this.ataOpen.delete(mint)) return 0;
        this.sol += this.ataRent;
        return this.ataRent;
      },
      txWalletDelta: async (sig: string) => {
        this.calls.push(`txdelta:${sig}`);
        if (!this.txDeltaReadable) return null;
        return this.txDeltas.has(sig) ? (this.txDeltas.get(sig) as number) : null;
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

  // ── 2b. THE REAL FILL REPLACES THE MODEL ──────────────────────────────────
  console.log("\n2b. FILL NYATA MENGGANTIKAN MODEL (tidak ada lagi 'paper' saat live)");
  c = fresh();
  {
    const fills: Array<{ tradeId: string; spentSol: number; tokens: number }> = [];
    B.__setFillHookForTest((f) => fills.push(f));
    c.fillTokens = 987_654; // chain memberi jumlah yang BERBEDA dari model
    B.bridgeOpen({ tradeId: "tf1", mint: "MF", symbol: "FILL", sizeSol: 0.05 });
    await B.__drainForTest();
    check("fill nyata dilaporkan ke mesin strategi", fills.length === 1, `(${fills.length})`);
    check("  jumlah token = yang benar-benar diterima", fills[0]?.tokens === 987_654, `(${fills[0]?.tokens})`);
    check("  modal = selisih saldo terukur, bukan clip yang diminta",
      Math.abs((fills[0]?.spentSol ?? 0) - config.exec.live.sizeSol) < 1e-9, `(${fills[0]?.spentSol})`);
    // Buy yang GAGAL tidak boleh melaporkan fill apa pun — mengadopsi nol akan menghancurkan posisi.
    fills.length = 0;
    c.buyResult = { ok: false, err: "no route" };
    B.bridgeOpen({ tradeId: "tf2", mint: "MG", sizeSol: 0.05 });
    await B.__drainForTest();
    check("buy gagal TIDAK melaporkan fill", fills.length === 0);
    // Begitu juga buy yang timeout tanpa token.
    c.buyResult = { ok: false, timedOut: true }; c.fillTokens = 0;
    B.bridgeOpen({ tradeId: "tf3", mint: "MH", sizeSol: 0.05 });
    await B.__drainForTest();
    check("buy tanpa token TIDAK melaporkan fill", fills.length === 0);
    B.__setFillHookForTest(() => {});
  }

  // ── 2c. STATUS HARUS TERBACA DARI PROSES LAIN ─────────────────────────────
  // Dashboard adalah proses TERPISAH yang tidak pernah memanggil bridgeStart(), jadi peta lot
  // di memorinya kosong selamanya. Status yang membaca memori melaporkan 0 bag permanen —
  // trade muncul di jurnal (baca log dari disk) tanpa pernah terlihat sebagai posisi, dan bag
  // tersangkut tidak akan terlihat sama sekali.
  console.log("\n2c. STATUS DIBACA DARI DISK, BUKAN MEMORI PROSES");
  c = fresh();
  B.bridgeOpen({ tradeId: "td1", mint: "MD1", symbol: "DISK", sizeSol: 0.05 });
  await B.__drainForTest();
  {
    const onDisk = JSON.parse(readFileSync(join(config.logDir, "live-lots.json"), "utf8")) as { lots: Array<{ state: string }> };
    check("lot tertulis ke disk", onDisk.lots.some((l) => l.state !== "closed"));
    // Tiru proses lain: kosongkan memori, status harus TETAP melihat bag itu.
    B.__resetForTest();
    const st = B.bridgeStatus();
    check("status tetap melihat bag walau memori kosong", st.openLots === 1 && st.lots.length === 1,
      `(openLots ${st.openLots}, lots ${st.lots.length})`);
    check("  dan SOL berisiko ikut terbaca", st.deployedSol > 0, `(${st.deployedSol})`);
    check("  simbolnya ikut, jadi panel bisa menamainya", st.lots[0]?.symbol === "DISK");
  }

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

  // ── 2x. DEPOSIT ACKNOWLEDGE ──────────────────────────────────────────────
  // Setoran owner = pergerakan saldo yang sah, tapi reconcile-or-HALT tidak bisa membedakannya
  // dari pembobolan. Skenario nyata 2026-08-23: snapshot 0.0147, on-chain 0.4516 → HALT; resume
  // TANPA acknowledge langsung ter-halt ulang di tick berikutnya (snapshot masih angka lama).
  console.log("\n2x. ACKNOWLEDGE DEPOSIT (setoran sah vs pembobolan)");
  {
    const c = fresh();
    B.__setBalanceForTest(0.0147);          // snapshot lama (pra-setoran)
    c.sol = 0.4516;                          // setoran masuk on-chain
    await B.__reconcileForTest();
    check("setoran tanpa ack → HALT fail-closed", isHalted().halted === true,
      `(${isHalted().reason ?? "tidak halt"})`);
    check("alasannya drift saldo", /unexplained balance move/.test(isHalted().reason ?? ""));
    const ack = await (B as unknown as { acknowledgeDeposit(): Promise<{ ok: boolean; sol: number | null }> }).acknowledgeDeposit();
    check("ack membaca saldo on-chain yang baru",
      ack.ok === true && Math.abs((ack.sol ?? 0) - 0.4516) < 1e-9, `(${JSON.stringify(ack)})`);
    resume(); // pasangan wajibnya — ack hanya memperbarui snapshot, resume mengangkat halt
    await B.__reconcileForTest();
    check("reconcile setelah ack+resume TIDAK halt ulang", isHalted().halted === false,
      `(${isHalted().reason ?? ""})`);
    // Dan jalur gagal: chain tak terbaca → ack menolak, tidak mengklaim apa pun.
    c.balanceReadable = false;
    const bad = await (B as unknown as { acknowledgeDeposit(): Promise<{ ok: boolean; sol: number | null }> }).acknowledgeDeposit();
    check("chain tak terbaca → ack MENOLAK (fail-closed)", bad.ok === false && bad.sol === null);
  }

  // ── 2w. DOMPET KERING — 177 penolakan identik tidak boleh terulang ────────
  {
    console.log("\n2w. DOMPET KERING (beli berhenti, keluar tidak)");
    const c = fresh();
    c.buyResult = { ok: false, err: "guard: insufficient balance: need 0.0200, have 0.0190" };
    for (let i = 0; i < 4; i++) {
      B.bridgeOpen({ tradeId: `dry${i}`, mint: `MDRY${i}`, sizeSol: 0.01 });
      await B.__drainForTest();
    }
    check("beberapa penolakan awal belum mengunci (bisa transien)", B.__dryWalletForTest() === null);
    B.bridgeOpen({ tradeId: "dry4", mint: "MDRY4", sizeSol: 0.01 });
    await B.__drainForTest();
    const latched = B.__dryWalletForTest();
    check("setelah beruntun → MENGUNCI dan menyebut angkanya", latched?.needSol === 0.02);

    // Terkunci = berhenti bertanya. Inilah yang gagal di produksi.
    const before = c.calls.filter((x) => x.startsWith("buy:")).length;
    for (let i = 5; i < 15; i++) {
      B.bridgeOpen({ tradeId: `dry${i}`, mint: `MDRY${i}`, sizeSol: 0.01 });
      await B.__drainForTest();
    }
    const after = c.calls.filter((x) => x.startsWith("buy:")).length;
    check("  → 10 sinyal berikutnya TIDAK menembak chain lagi", after === before, `${after - before} percobaan lolos`);

    // Tapi bag yang sudah ada harus tetap bisa keluar — asimetri yang tidak boleh dikorbankan.
    c.buyResult = { ok: true };
    B.__resetForTest();
    const c2 = fresh();
    c2.buyResult = { ok: true };
    B.bridgeOpen({ tradeId: "held", mint: "MHELD", sizeSol: 0.01 });
    await B.__drainForTest();
    c2.buyResult = { ok: false, err: "guard: insufficient balance: need 0.0200, have 0.0010" };
    for (let i = 0; i < 6; i++) {
      B.bridgeOpen({ tradeId: `d2${i}`, mint: `MD2${i}`, sizeSol: 0.01 });
      await B.__drainForTest();
    }
    check("dompet kering → tetap MENGUNCI", B.__dryWalletForTest() !== null);
    B.bridgeClose("held", "MHELD", "STOP");
    await B.__drainForTest();
    check("  → tapi bag yang dipegang TETAP bisa dijual", (c2.tokens.get("MHELD") ?? 0) === 0);
    check("  → dan lot-nya tertutup bersih", B.__lotsForTest().get("held")?.state === "closed");
  }

  // ── 2y. AKUNTANSI: UANG YANG DIBUKUKAN HARUS UANG YANG BERGERAK ──────────
  // Ini gerbang yang absen selama tiga hari perdagangan live. Bug-nya bukan crash: ledger
  // membukukan UKURAN ORDER (0.01◎) sebagai biaya beli, sementara sisi jual memakai delta
  // saldo yang sudah termasuk rent ATA balik. Asimetri itu menaikkan tiap trade ≈0.0023◎ —
  // 20,6% dari notional — dan mengubah −15,65% nyata menjadi +1,71% di layar.
  {
    console.log("\n2y. AKUNTANSI — buku harus sama dengan chain");
    const c = fresh();
    c.chargeFees = true;              // gas + rent ATA, bentuk mainnet yang terukur
    c.fillTokens = 1_000_000;
    c.solPerFullSell = 0.0098;        // jual sedikit di bawah modal
    const size = 0.01;
    const solBefore = c.sol;

    B.bridgeOpen({ tradeId: "acc1", mint: "MACC", sizeSol: size });
    await B.__drainForTest();
    const lot = B.__lotsForTest().get("acc1");

    const expectedSpend = size + c.gasPerTx + c.ataRent;
    check("beli dibukukan sebesar DEBIT NYATA, bukan ukuran order",
      !!lot && Math.abs((lot.spentSol ?? 0) - expectedSpend) < 1e-9,
      `spent=${lot?.spentSol} seharusnya=${expectedSpend}`);
    check("  → dan ukuran order saja akan MELEBIH-LEBIHKAN hasil",
      expectedSpend > size);
    check("  → ditandai terukur, bukan taksiran", lot?.spentMeasured === true);

    B.bridgeClose("acc1", "MACC", "EARLY_CUT");
    await B.__drainForTest();

    // Kebenaran tunggal: yang hilang dari dompet harus sama dengan yang dicatat ledger.
    const walletMoved = c.sol - solBefore;
    const settled = B.__lotsForTest().get("acc1");
    const booked = (settled?.proceedsSol ?? 0) + (settled?.rentReclaimedSol ?? 0) - (settled?.spentSol ?? 0);
    check("net ledger == pergerakan dompet NYATA (≤1 lamport)",
      Math.abs(booked - walletMoved) < 1e-9,
      `ledger=${booked.toFixed(9)} dompet=${walletMoved.toFixed(9)}`);
    check("  → dan angkanya rugi, bukan untung palsu", booked < 0);
  }

  // Chain bisa saja tidak mau menjawab. Angka taksiran boleh dipakai, tapi TIDAK BOLEH
  // menyamar sebagai hasil pengukuran — itu justru cara bug ini bersembunyi selama ini.
  {
    const c = fresh();
    c.chargeFees = true;
    c.txDeltaReadable = false;
    B.bridgeOpen({ tradeId: "acc2", mint: "MACC2", sizeSol: 0.01 });
    await B.__drainForTest();
    const lot = B.__lotsForTest().get("acc2");
    check("tx tak terbaca → tetap membukukan sesuatu (tidak menggantung)", (lot?.spentSol ?? 0) > 0);
    check("  → tapi JUJUR menandai dirinya taksiran", lot?.spentMeasured === false);
  }

  // ── 2z. RIWAYAT SALDO — jangkar rekonsiliasi tingkat dompet ──────────────
  {
    console.log("\n2z. RIWAYAT SALDO (audit dompet)");
    const c = fresh();
    c.chargeFees = true;
    B.bridgeOpen({ tradeId: "bal1", mint: "MBAL", sizeSol: 0.01 });
    await B.__drainForTest();
    B.bridgeClose("bal1", "MBAL", "STOP");
    await B.__drainForTest();
    const lines = readFileSync(join(config.logDir, `live-exec-${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; reason?: string; sol?: number });
    const bals = lines.filter((l) => l.type === "balance");
    check("tiap pergerakan uang meninggalkan titik saldo", bals.length >= 2,
      `hanya ${bals.length} titik`);
    check("  → dengan alasan yang bisa dibaca", bals.some((b) => b.reason === "buy") && bals.some((b) => b.reason === "sell"));
    const last = bals[bals.length - 1];
    check("  → dan saldo terakhir == saldo chain", Math.abs((last?.sol ?? -1) - c.sol) < 1e-9);
  }

  restore();
  console.log(`\n═══════ RESULT: ${pass} passed, ${fail} failed ═══════`);
  process.exit(fail === 0 ? 0 : 1);
}

void (NOPERM_CHILD ? noPermissionChild() : main());
