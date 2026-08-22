/**
 * MODE SWITCH RENDER CHECK — executes the exec-mode control for real and asserts the LIVE
 * button is locked whenever the .env permission is absent.
 *
 * Type-checking cannot catch this: `permitted` is a plain boolean, and every wrong rendering
 * of it still compiles. What matters is that the button an owner can click is DISABLED when
 * real money is not permitted, including on an older server payload that has no `liveBridge`
 * field at all — where "undefined" must read as locked, not as unlocked.
 *
 * Renders ModeSwitch directly, NOT through ControlDialog: the dialog is a Radix portal and
 * renders to ZERO bytes of static markup, so a check pointed at it passes while asserting
 * nothing at all. That is exactly how this check first "passed".
 *
 * Usage:  npm run mode:check   (no fixture needed — the payloads are built here)
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModeSwitch } from "../src/components/panels/ModeSwitch";
import { toLiveView } from "../src/lib/liveView";
import { SniperRecap } from "../src/components/panels/SniperRecap";
import { EquityCurve } from "../src/components/panels/EquityCurve";
import { TradeJournal } from "../src/components/panels/TradeJournal";
import { OpenPositions } from "../src/components/panels/OpenPositions";
import { ExitQuality } from "../src/components/panels/ExitQuality";
import { RunLedger } from "../src/components/panels/RunLedger";

type Any = Record<string, any>;

const base = (execMode: string, liveBridge: Any | undefined): Any => ({
  control: { execMode, paused: false },
  guardian: { caps: { maxPerTradeSol: 0.05, maxDeployedSol: 0.3, maxDailySpendSol: 0.5, feeReserveSol: 0.01, reconcileToleranceSol: 0.02 } },
  liveBridge,
});

const CAPS = { maxPerTradeSol: 0.02, maxDeployedSol: 0.05, maxDailySpendSol: 0.1, feeReserveSol: 0.01, reconcileToleranceSol: 0.02 };
const SUM0 = { trades: 0, wins: 0, losses: 0, spentSol: 0, proceedsSol: 0, netSol: 0, netPct: null, neverFilled: 0 };
const ARMED = { permitted: true, armed: true, halted: false, haltReason: null, openLots: 2, deployedSol: 0.04, realizedSol: -0.0031, wallet: "ayDYr5jGkV83e5ZN4bPZRWipUgtPzoBs2JZ1kqtkH8w", expectedBalanceSol: 0.2, spentLast24h: 0.02, caps: CAPS, clipSol: 0.01, summary: SUM0 };
const PERMITTED = { ...ARMED, armed: false, openLots: 0, deployedSol: 0, realizedSol: 0 };
const LOCKED = { ...PERMITTED, permitted: false, wallet: "" };

/** Does the rendered LIVE button carry `disabled`? Located by its own lock marker. */
function liveButtonDisabled(html: string): boolean {
  const i = html.indexOf("LIVE 🔒");
  if (i < 0) return false; // no lock marker rendered → not locked
  const open = html.lastIndexOf("<button", i);
  return open >= 0 && html.slice(open, i).includes("disabled");
}

const cases: Array<[string, Any, { liveLocked: boolean; expectHint: boolean }]> = [
  ["tanpa izin .env", base("dry-run", LOCKED), { liveLocked: true, expectHint: true }],
  ["payload lama (tanpa liveBridge)", base("dry-run", undefined), { liveLocked: true, expectHint: true }],
  ["izin ada, masih PAPER", base("dry-run", PERMITTED), { liveLocked: false, expectHint: false }],
  ["izin ada, mode SIMULASI", base("simulate", PERMITTED), { liveLocked: false, expectHint: false }],
  ["izin ada, LIVE aktif", base("live", ARMED), { liveLocked: false, expectHint: false }],
  ["data null", null as unknown as Any, { liveLocked: true, expectHint: true }],
];

let bad = 0;
console.log("MODE SWITCH RENDER CHECK\n");
for (const [label, data, want] of cases) {
  try {
    const html = renderToStaticMarkup(<ModeSwitch data={data as never} />);
    const locked = liveButtonDisabled(html);
    const hint = html.includes("LIVE_TRADING_CONFIRMED=yes");
    const nan = /NaN|undefined|Infinity/.test(html);
    const okLock = locked === want.liveLocked;
    const okHint = hint === want.expectHint;
    const ok = okLock && okHint && !nan;
    if (!ok) bad++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${label.padEnd(32)} live=${locked ? "TERKUNCI" : "bisa diklik"}` +
        `${okLock ? "" : ` *** harusnya ${want.liveLocked ? "TERKUNCI" : "bisa diklik"} ***`}` +
        `${okHint ? "" : " *** petunjuk .env salah ***"}${nan ? " *** NaN/undefined bocor ***" : ""}`,
    );
  } catch (e) {
    bad++;
    console.log(`  ✗ ${label.padEnd(32)} GAGAL RENDER: ${(e as Error).message.slice(0, 70)}`);
  }
}

// The one that would actually cost money: a locked switch must never also claim to be armed.
try {
  const html = renderToStaticMarkup(<ModeSwitch data={base("dry-run", LOCKED) as never} />);
  const ok = !html.includes("ARMED");
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} tanpa izin, kata "ARMED" tidak pernah muncul`);
} catch { bad++; }

// ── ADAPTER LIVE lewat KOMPONEN ASLI ─────────────────────────────────────────
// Tidak ada panel khusus live. toLiveView menukar SUMBER-nya, panel yang sama merender.
// Yang dijaga di sini: tidak ada satu pun angka simulasi yang lolos ke tampilan live.
console.log("\nADAPTER LIVE (panel yang sama, sumber berganti)");
const PAPER_POISON = ["18.629", "831.5", "2432", "16.629"];
const SUM = (over: Any = {}): Any => ({ ...SUM0, recent: [], equitySol: [], buyFailed: 0, sellDeferred: 0, exitReasons: [], ...over });
const REAL = SUM({
  trades: 4, wins: 1, losses: 3, spentSol: 0.047994, proceedsSol: 0.040359,
  netSol: -0.007636, netPct: -15.91, equitySol: [-0.003277, -0.005734, -0.0086, -0.007636],
  exitReasons: [{ reason: "EARLY_CUT", n: 3, netSol: -0.0086 }, { reason: "MAX_HOLD", n: 1, netSol: 0.000964 }],
  recent: [{ ts: "2026-08-22T05:03:28Z", tradeId: "t1", mint: "AbcdEf1234", symbol: "HODL", reason: "EARLY_CUT", spentSol: 0.01157, proceedsSol: 0.012534, netSol: 0.000964, netPct: 8.33, heldSec: 13, img: null }],
});
const BASE: Any = {
  control: { execMode: "live", paused: false },
  system: { sniperAlive: true, strategy2Alive: true },
  feeling: { enabled: false },
  guardian: { caps: CAPS },
  combined: { solUsd: 99.67, totalUsd: 2432.66, floatUsd: 1199, pnlUsd: 1233, pnlPct: 102, wins: 591, losses: 845, winRate: 0.41, open: 0,
    s1: { balanceUsd: 1856, floatUsd: 199, balanceSol: 18.6295, floatSol: 2, wins: 591, losses: 845, open: 0 },
    s2: { balanceUsd: 576, floatUsd: 1000, wins: 34, losses: 212, open: 0 }, equity: [{ t: "", bal: 100 }, { t: "", bal: 200 }] },
  paper: { opens: 1436, closed: 1436, open: 0, wins: 591, losses: 845, winRate: 0.41, sumOfTradePcts: 0, returnPctOfFloat: 0,
    exitReasons: {}, tradeSizeSol: 0.05, floatSol: 2, realizedSol: 16.629, balanceSol: 18.6295, compounding: false, equity: [], openPositions: [] },
  recentTrades: [{ ts: "2026-08-22T01:00:00Z", symbol: "PAPERCOIN", reason: "MAX_HOLD", pnlPct: 33.2 }],
  strategy2Primary: { recentTrades: [{ ts: "2026-08-22T01:00:00Z", symbol: "S2COIN", reason: "TRAIL_STOP", pnlPct: -12.1 }], paper: { open: 0, openPositions: [] }, totals: { rejected: 0 } },
  runs: { profitable: 2, completed: 5, recent: [], lifetime: { runs: 5, profitable: 2, pnlSol: -1, trades: 900 } },
  liveBridge: { ...ARMED, summary: REAL, lots: [] },
};

function adapterCase(name: string, node: (d: Any) => React.ReactElement, want: { mustShow?: string[]; mustNotShow?: string[] }) {
  try {
    const v = toLiveView(BASE as never) as Any;
    const html = renderToStaticMarkup(node(v));
    const leaked = [...PAPER_POISON, ...(want.mustNotShow ?? [])].filter((n) => html.includes(n));
    const nan = /NaN|undefined|Infinity/.test(html);
    const missing = (want.mustShow ?? []).filter((t) => !html.includes(t));
    const ok = leaked.length === 0 && !nan && missing.length === 0;
    if (!ok) bad++;
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(40)} ${html.length}b` +
      `${leaked.length ? ` *** SIMULASI BOCOR: ${leaked.join(",")} ***` : ""}` +
      `${nan ? " *** NaN/undefined ***" : ""}${missing.length ? ` *** tak menampilkan: ${missing.join(",")} ***` : ""}`);
  } catch (e) { bad++; console.log(`  ✗ ${name.padEnd(40)} GAGAL: ${(e as Error).message.slice(0, 70)}`); }
}

adapterCase("recap = angka live", (d) => <SniperRecap data={d} />, { mustShow: ["1W/3L"], mustNotShow: ["PAPERCOIN"] });
adapterCase("dompet = saldo + kurva live", (d) => <EquityCurve data={d} />, { mustShow: ["W/3L"] });
adapterCase("journal = trade live saja", (d) => <TradeJournal data={d} />, { mustShow: ["HODL", "EARLY_CUT"], mustNotShow: ["PAPERCOIN", "S2COIN"] });
adapterCase("exit quality = aturan live", (d) => <ExitQuality data={d} />, { mustShow: ["EARLY_CUT"], mustNotShow: ["TRAIL_STOP"] });
adapterCase("posisi = kosong bila tak ada bag", (d) => <OpenPositions data={d} />, { mustShow: ["no open positions"] });
{ // runs tidak berlaku di live — jangan tampilkan riwayat simulasi di bawah judul live
  const v = toLiveView(BASE as never) as Any;
  const html = renderToStaticMarkup(<RunLedger data={v} />);
  const ok = !html.includes("2/5") && html.length > 0;
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${"run ledger tidak memuat riwayat paper".padEnd(40)} ${ok ? "kosong" : "*** riwayat paper bocor ***"}`);
}
{ // disarmed: adapter TIDAK boleh menyentuh apa pun
  const untouched = toLiveView({ ...BASE, liveBridge: { ...ARMED, armed: false, summary: REAL } } as never) as Any;
  const ok = untouched.paper.balanceSol === 18.6295 && untouched.recentTrades.length === 1;
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${"disarmed → data simulasi utuh".padEnd(40)} ${ok ? "utuh" : "*** dimodifikasi ***"}`);
}

console.log(`\n${bad === 0 ? "✓ semua benar" : `✗ ${bad} kasus salah`}`);
process.exit(bad === 0 ? 0 : 1);
