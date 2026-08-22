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

type Any = Record<string, any>;

const base = (execMode: string, liveBridge: Any | undefined): Any => ({
  control: { execMode, paused: false },
  guardian: { caps: { maxPerTradeSol: 0.05, maxDeployedSol: 0.3, maxDailySpendSol: 0.5, feeReserveSol: 0.01, reconcileToleranceSol: 0.02 } },
  liveBridge,
});

const ARMED = { permitted: true, armed: true, halted: false, haltReason: null, openLots: 2, deployedSol: 0.04, realizedSol: -0.0031, wallet: "ayDYr5jGkV83e5ZN4bPZRWipUgtPzoBs2JZ1kqtkH8w", expectedBalanceSol: 0.2 };
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

console.log(`\n${bad === 0 ? "✓ semua benar" : `✗ ${bad} kasus salah`}`);
process.exit(bad === 0 ? 0 : 1);
