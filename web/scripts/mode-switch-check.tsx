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
import { LiveWallet } from "../src/components/panels/LiveWallet";
import { LiveJournal, LivePositions, LiveRecap } from "../src/components/panels/LiveJournal";
import { LiveExitQuality, LiveExecHealth } from "../src/components/panels/LiveAnalytics";

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

// ── PANEL LIVE: tidak boleh meminjam SATU pun angka paper ────────────────────
// Kejadian nyata 2026-08-22: badge LIVE merah duduk di atas "18.629◎ +831.5%" dan dompet
// $2.432 — semuanya paper — sementara dompet asli 0,2486 SOL. Live kini MENGGANTIKAN panel
// paper, jadi yang harus dijaga: tidak ada angka paper yang bocor ke dalamnya.
console.log("\nPANEL LIVE (menggantikan paper)");
const PAPER_POISON = ["18.629", "831.5", "2432", "16.629", "591", "845"];
const SUM = (over: Any = {}): Any => ({ ...SUM0, recent: [], equitySol: [], buyFailed: 0, sellDeferred: 0, exitReasons: [], ...over });
const withPaper = (lb: Any | undefined): Any => ({
  ...base("live", lb),
  combined: { solUsd: 99.67 },
  paper: { balanceSol: 18.6295, floatSol: 2, opens: 1436, wins: 591, losses: 845, winRate: 0.41 },
  strategy2Primary: { recentTrades: [], paper: { open: 0 } },
});

function panelCase(name: string, node: React.ReactElement, want: { mustShow?: string[]; allowEmpty?: boolean }) {
  try {
    const html = renderToStaticMarkup(node);
    const leaked = PAPER_POISON.filter((n) => html.includes(n));
    const nan = /NaN|undefined|Infinity/.test(html);
    const missing = (want.mustShow ?? []).filter((t) => !html.includes(t));
    const empty = html.length === 0;
    const ok = leaked.length === 0 && !nan && missing.length === 0 && (want.allowEmpty || !empty);
    if (!ok) bad++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${name.padEnd(40)} ${html.length}b` +
        `${leaked.length ? ` *** ANGKA PAPER BOCOR: ${leaked.join(",")} ***` : ""}` +
        `${nan ? " *** NaN/undefined ***" : ""}` +
        `${missing.length ? ` *** tidak menampilkan: ${missing.join(",")} ***` : ""}` +
        `${empty && !want.allowEmpty ? " *** kosong ***" : ""}`,
    );
  } catch (e) { bad++; console.log(`  ✗ ${name.padEnd(40)} GAGAL: ${(e as Error).message.slice(0, 60)}`); }
}

const REAL = SUM({
  trades: 4, wins: 1, losses: 3, spentSol: 0.047994, proceedsSol: 0.040359,
  netSol: -0.007636, netPct: -15.91,
  equitySol: [-0.003277, -0.005734, -0.0086, -0.007636],
  recent: [{ ts: "2026-08-22T05:03:28Z", tradeId: "t1", mint: "AbcdEf1234", symbol: "HODL", reason: "EARLY_CUT", spentSol: 0.01157, proceedsSol: 0.012534, netSol: 0.000964, netPct: 8.33, heldSec: 13 }],
});

panelCase("dompet live · nol trade", <LiveWallet data={withPaper({ ...ARMED, summary: SUM() }) as never} />, { mustShow: ["belum ada trade", "tape muncul setelah"] });
// Gaya grafik harus SAMA dengan panel simulasi: batang (<rect>), bukan garis (<polyline>).
// Versi pertama menggambar polyline tipis melar — dari empat trade diskrit ia terbaca sebagai
// tren mulus, yang menyanjung dan bohong.
panelCase("dompet live · tape BATANG bukan garis", <LiveWallet data={withPaper({ ...ARMED, summary: REAL }) as never} />, { mustShow: ["<rect", "<line"] });
{
  const html = renderToStaticMarkup(<LiveWallet data={withPaper({ ...ARMED, summary: REAL }) as never} />);
  const bars = (html.match(/<rect/g) ?? []).length;
  const ok = !html.includes("<polyline") && bars === REAL.equitySol.length;
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${"satu batang per trade, nol polyline".padEnd(40)} ${bars} batang / ${REAL.equitySol.length} trade${html.includes("<polyline") ? " *** MASIH POLYLINE ***" : ""}`);
}
// Minus tipografis (−, U+2212) sama seperti panel simulasi — bukan hyphen ASCII.
panelCase("dompet live · ada hasil nyata", <LiveWallet data={withPaper({ ...ARMED, summary: REAL }) as never} />, { mustShow: ["0.00764", "15.9%", "\u2212"] });
panelCase("dompet live · payload separuh", <LiveWallet data={{ liveBridge: { permitted: true, armed: true, openLots: 0, deployedSol: 0 } } as never} />, {});
panelCase("journal live · kosong", <LiveJournal data={withPaper({ ...ARMED, summary: SUM() }) as never} />, { mustShow: ["belum ada trade live"] });
panelCase("journal live · ada baris", <LiveJournal data={withPaper({ ...ARMED, summary: REAL }) as never} />, { mustShow: ["HODL", "EARLY_CUT", "+0.00096"] });
// Kosong harus MENJELASKAN, bukan satu kalimat di tengah tile besar.
panelCase("posisi live · kosong menjelaskan", <LivePositions data={withPaper({ ...ARMED, summary: REAL, openLots: 0, lots: [] }) as never} />, { mustShow: ["menunggu entry", "clip berikutnya", "10-60 detik"] });
const LOTS = [
  { tradeId: "L1", mint: "AbcdEf1234", symbol: "HODL", state: "open", spentSol: 0.0118, tokens: 1e5, openedAt: Date.now() - 12000, heldSec: 12, sells: 0, proceedsSol: 0, sellFailures: 0, lastErr: null, img: null },
  { tradeId: "L2", mint: "Zz99", symbol: "imback", state: "stuck", spentSol: 0.0123, tokens: 25649, openedAt: Date.now() - 3600000, heldSec: 3600, sells: 3, proceedsSol: 0.0368, sellFailures: 22, lastErr: "0x1775", img: null },
];
panelCase("posisi live · ada bag", <LivePositions data={withPaper({ ...ARMED, summary: REAL, openLots: 2, deployedSol: 0.02, lots: LOTS }) as never} />, { mustShow: ["HODL", "0.0118"] });
// Bag yang bermasalah HARUS terlihat di dashboard, bukan hanya di log.
panelCase("posisi live · bag tersangkut menonjol", <LivePositions data={withPaper({ ...ARMED, summary: REAL, openLots: 2, lots: LOTS }) as never} />, { mustShow: ["GAGAL JUAL 22x", "imback"] });
// Ikon koin: ada gambar → <img>; tidak ada → tetap ada kotak huruf, baris tidak boleh menciut.
{
  const withImg = REAL.recent.map((r: Any) => ({ ...r, img: "https://example.invalid/a.png" }));
  const a = renderToStaticMarkup(<LiveJournal data={withPaper({ ...ARMED, summary: { ...REAL, recent: withImg } }) as never} />);
  const bHtml = renderToStaticMarkup(<LiveJournal data={withPaper({ ...ARMED, summary: REAL }) as never} />);
  const ok = a.includes("<img") && !bHtml.includes("<img") && bHtml.includes("rounded-[5px]");
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${"ikon koin: gambar / fallback huruf".padEnd(40)} img=${a.includes("<img")} fallback=${bHtml.includes("rounded-[5px]")}`);
}
panelCase("recap live · nol trade", <LiveRecap data={withPaper({ ...ARMED, summary: SUM() }) as never} />, { mustShow: ["belum ada trade live"] });
panelCase("recap live · ada hasil", <LiveRecap data={withPaper({ ...ARMED, summary: REAL }) as never} />, { mustShow: ["-0.00764", "1W/3L"] });
const REASONS = [
  { reason: "EARLY_CUT", n: 5, netSol: -0.00711 },
  { reason: "MAX_HOLD", n: 4, netSol: 0.005689 },
  { reason: "ORPHAN_SWEEP", n: 2, netSol: -0.006579 },
];
panelCase("exit quality live · kosong", <LiveExitQuality data={withPaper({ ...ARMED, summary: SUM() }) as never} />, { mustShow: ["Belum ada exit live"] });
panelCase("exit quality live · per aturan", <LiveExitQuality data={withPaper({ ...ARMED, summary: SUM({ exitReasons: REASONS }) }) as never} />, { mustShow: ["EARLY_CUT", "ORPHAN_SWEEP", "0.00658"] });
panelCase("kesehatan eksekusi · nol trade", <LiveExecHealth data={withPaper({ ...ARMED, summary: SUM() }) as never} />, { mustShow: ["0/0"] });
panelCase("kesehatan eksekusi · ada masalah", <LiveExecHealth data={withPaper({ ...ARMED, summary: SUM({ trades: 12, wins: 3, losses: 9, spentSol: 0.1456, proceedsSol: 0.1323, netSol: -0.013352, buyFailed: 3, sellDeferred: 3, neverFilled: 0, exitReasons: REASONS }) }) as never} />, { mustShow: ["3/12", "orphan sweep", "buy ditolak"] });
panelCase("kesehatan eksekusi · summary hilang", <LiveExecHealth data={{ liveBridge: { permitted: true, armed: true } } as never} />, {});
panelCase("recap live · HALTED terlihat", <LiveRecap data={withPaper({ ...ARMED, summary: REAL, halted: true, haltReason: "stuck bag" }) as never} />, { mustShow: ["HALTED", "stuck bag"] });

console.log(`\n${bad === 0 ? "✓ semua benar" : `✗ ${bad} kasus salah`}`);
process.exit(bad === 0 ? 0 : 1);
