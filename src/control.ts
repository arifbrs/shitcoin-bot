import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Shared runtime control state, on disk so the web server (browser-driven) and the
 * scanner/trader (a separate process) coordinate — the web writes it, the bot polls it.
 * This is the remote control: pause, exec mode, one-shot COMMANDS (flatten/close/reset),
 * and LIVE-tunable risk knobs — all without a restart.
 */
export interface RiskOverrides {
  paperTradeSizeSol?: number; // per-trade size
  catastrophicStopPct?: number; // always-on hard floor (negative)
  scaleOutTriggerPct?: number; // de-risk / bank-principal trigger
  minVelSol?: number; // momentum confirm inflow floor
}

/** One-shot command the trader executes on its next tick, then clears. */
export interface ControlCommand {
  id: number; // monotonically increasing so the trader runs each command exactly once
  action: "flatten" | "close" | "reset-run";
  mint?: string; // for "close"
}

export type ExecMode = "dry-run" | "simulate" | "devnet" | "live";

/**
 * THE TWO LOCKS, and which one this file is.
 *
 * Until 2026-08-22 the rule was "live can never be set from the web", full stop. That made
 * the console safe by making it useless for the one switch the owner actually wants. The
 * rule is now split instead, which keeps the property that mattered:
 *
 *   PERMISSION  — LIVE_TRADING_CONFIRMED=yes in .env. Out-of-band, on the machine, and a
 *                 browser can still never set it. Removing the line revokes live instantly:
 *                 readControl() below degrades a persisted "live" back to dry-run.
 *   ACTIVATION  — execMode here, i.e. the button. Only ever meaningful with permission.
 *
 * So a browser alone still cannot start spending real money — it can only activate what the
 * machine's owner has already permitted out-of-band. Turning live OFF needs no permission at
 * all: stopping is always allowed.
 */
export interface ControlState {
  paused: boolean; // scanner keeps discovering but stops opening new positions
  execMode: ExecMode; // "live" requires the out-of-band permission — see above
  command?: ControlCommand | null; // pending one-shot command (cleared after execution)
  lastCommandId?: number; // highest command id the trader has already executed
  risk?: RiskOverrides; // live risk-parameter overrides (merged over config.risk at runtime)
  // Audit found (2026-07-29): Strategy 2 had NO emergency stop at all — `command` above is only
  // ever read by the sniper's own trader.ts, so noManualClose positions genuinely had zero
  // operator override. Separate namespace, same one-shot-by-id pattern, so both bots share this
  // file without stepping on each other's commands.
  strategy2Command?: ControlCommand | null;
  strategy2LastCommandId?: number;
}

const PATH = join(process.env.CONTROL_DIR || config.logDir, "control.json");
const DEFAULT: ControlState = {
  paused: false,
  // EXEC_MODE=live in .env seeds the ACTIVATION too, so a headless box can run live without
  // anyone opening a browser — but still only when the permission is also present.
  execMode: config.exec.mode === "live" && config.exec.liveConfirmed ? "live" : config.exec.mode === "live" ? "dry-run" : config.exec.mode,
  command: null,
  lastCommandId: 0,
  risk: {},
  strategy2Command: null,
  strategy2LastCommandId: 0,
};

mkdirSync(config.logDir, { recursive: true });

/** Is real-money execution PERMITTED on this machine? (.env only — never the browser.) */
export function livePermitted(): boolean {
  return config.exec.liveConfirmed;
}

/**
 * MODE GATE — OWNER RULE (2026-08-24): "kredit mengikuti mode aktif".
 *
 * When the console switch is LIVE, every paper/simulation consumer must go IDLE: no entries,
 * no movement, no credit consumption — live gets every credit. When the owner switches to
 * paper/simulate/devnet, that mode's consumption resumes by itself (this reads control.json
 * fresh on every call, so a mode flip takes effect on the next poll without a restart).
 *
 * `paperIdleByMode` wraps the check with log-once semantics per consumer: entering the idle
 * state announces it ONCE (silence afterwards = still idle, not dead), and leaving it logs the
 * resume. Pass a module-level `state` object per consumer.
 */
export function paperIdleByMode(tag: string, state: { logged?: boolean }): boolean {
  let live = false;
  try { live = readControl().execMode === "live"; } catch { /* unreadable control file = do not idle */ }
  if (live && !state.logged) {
    console.warn(`[${tag}] mode LIVE aktif — paper/simulasi IDLE: tanpa entry, tanpa gerak, tanpa konsumsi kredit. Switch mode untuk melanjutkan.`);
    state.logged = true;
  } else if (!live && state.logged) {
    console.warn(`[${tag}] mode bukan LIVE — paper/simulasi RESUME`);
    state.logged = false;
  }
  return live;
}

export function readControl(): ControlState {
  if (!existsSync(PATH)) return { ...DEFAULT };
  try {
    const s = JSON.parse(readFileSync(PATH, "utf8")) as Partial<ControlState>;
    // A persisted "live" survives only as long as the .env permission does. Delete the line
    // and the very next read is dry-run — no restart, no cleanup, no stale armed state.
    const execMode: ExecMode =
      s.execMode === "simulate" || s.execMode === "devnet" ? s.execMode
      : s.execMode === "live" && livePermitted() ? "live"
      : "dry-run";
    return {
      paused: Boolean(s.paused),
      execMode,
      command: s.command ?? null,
      lastCommandId: Number(s.lastCommandId ?? 0),
      risk: s.risk && typeof s.risk === "object" ? s.risk : {},
      strategy2Command: s.strategy2Command ?? null,
      strategy2LastCommandId: Number(s.strategy2LastCommandId ?? 0),
    };
  } catch {
    // AUDIT 2026-10-24 (temuan F2): dulu fail-open ke DEFAULT (paused=false, mode dari env) —
    // file kontrol yang rusak bisa diam-diam UN-PAUSE dan menghidupkan ulang live. Kini fail-closed
    // seperti guardian.json: state rusak = JEDA + dry-run sampai operator menulis ulang state
    // (menulis ulang selalu aman; menghentikan tidak butuh izin).
    return { paused: true, execMode: "dry-run", command: null, lastCommandId: 0, risk: {},
      strategy2Command: null, strategy2LastCommandId: 0 };
  }
}

export function writeControl(next: Partial<ControlState>): ControlState {
  const cur = readControl();
  const merged: ControlState = { ...cur, ...next, risk: { ...cur.risk, ...(next.risk ?? {}) } };
  // Hard guard, server-side: activation without permission is refused here, not in the UI.
  // The browser is not trusted to enforce this — it only renders what it is told.
  // (A2, round-3) FAIL-CLOSED TAMBAHAN: selama kunci keamanan .env terduplikasi (nilai efektif
  // = nilai TERAKHIR dotenv, tanpa suara), arming live DITOLAK apa pun izinnya — operator
  // membereskan .env dulu (hapus duplikat), lalu arming kembali normal.
  if (merged.execMode === "live" && !livePermitted()) merged.execMode = "dry-run";
  if (merged.execMode === "live" && config.securityDupKeys.length > 0) {
    console.warn(`[control] ARMING LIVE DITOLAK: kunci .env keamanan terduplikasi (${config.securityDupKeys.join(", ")}) — nilai efektif = nilai TERAKHIR dotenv. Bereskan duplikat, lalu arm ulang.`);
    merged.execMode = "dry-run";
  }
  // AUDIT TRAIL for the one field that decides whether real money moves.
  //
  // Live re-armed once without anyone clicking, and there was no way to answer "who did that?" —
  // control.json holds only the current value, so the transition left no trace anywhere. Six
  // minutes later the bot bought a real position. Every mode change now records which process
  // made it, so the question is answerable the first time it is asked instead of reconstructed
  // from file mtimes.
  if (merged.execMode !== cur.execMode) {
    try {
      appendFileSync(
        join(config.logDir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`),
        JSON.stringify({
          ts: new Date().toISOString(), type: "exec-mode-change",
          from: cur.execMode, to: merged.execMode,
          pid: process.pid, script: process.argv[1]?.split("/").slice(-2).join("/") ?? null,
        }) + "\n",
      );
    } catch { /* never let logging block a mode change, least of all a disarm */ }
  }
  // AUDIT 2026-10-24 (temuan F2/F3): tulis ATOMIK (tmp→rename) — tulis setengah jadi tidak lagi
  // mungkin terbaca sebagai state rusak. (RACE lintas-proses penulis masih ada; mitigasinya di
  // catat sebagai keterbatasan, bukan dianggap selesai.)
  const tmp = `${PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2));
  renameSync(tmp, PATH);
  return merged;
}

/**
 * LIVE-effective risk value: a control override if set (and sane), else the config default.
 * Lets the console tune size/stop/scale-out/velocity without a restart — clamped so a
 * fat-finger in the browser can't set an absurd value.
 */
export function liveRisk<K extends keyof RiskOverrides>(key: K, fallback: number, clamp?: [number, number]): number {
  const ov = readControl().risk?.[key];
  if (typeof ov !== "number" || !isFinite(ov)) return fallback;
  if (clamp) return Math.max(clamp[0], Math.min(clamp[1], ov));
  return ov;
}
