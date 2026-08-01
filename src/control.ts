import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

export interface ControlState {
  paused: boolean; // scanner keeps discovering but stops opening new positions
  execMode: "dry-run" | "simulate" | "devnet"; // "live" can never be set from the web
  command?: ControlCommand | null; // pending one-shot command (cleared after execution)
  lastCommandId?: number; // highest command id the trader has already executed
  risk?: RiskOverrides; // live risk-parameter overrides (merged over config.risk at runtime)
  // Audit found (2026-07-29): Strategy 2 had NO emergency stop at all — `command` above is only
  // ever read by the sniper's own papertrader.ts, so noManualClose positions genuinely had zero
  // operator override. Separate namespace, same one-shot-by-id pattern, so both bots share this
  // file without stepping on each other's commands.
  strategy2Command?: ControlCommand | null;
  strategy2LastCommandId?: number;
}

const PATH = join(config.logDir, "control.json");
const DEFAULT: ControlState = {
  paused: false,
  execMode: config.exec.mode === "live" ? "dry-run" : config.exec.mode,
  command: null,
  lastCommandId: 0,
  risk: {},
  strategy2Command: null,
  strategy2LastCommandId: 0,
};

mkdirSync(config.logDir, { recursive: true });

export function readControl(): ControlState {
  if (!existsSync(PATH)) return { ...DEFAULT };
  try {
    const s = JSON.parse(readFileSync(PATH, "utf8")) as Partial<ControlState>;
    const execMode = s.execMode === "simulate" || s.execMode === "devnet" ? s.execMode : "dry-run";
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
    return { ...DEFAULT };
  }
}

export function writeControl(next: Partial<ControlState>): ControlState {
  const cur = readControl();
  const merged: ControlState = { ...cur, ...next, risk: { ...cur.risk, ...(next.risk ?? {}) } };
  // Hard guard: the web can never flip the bot into live money.
  if ((merged.execMode as string) === "live") merged.execMode = "dry-run";
  writeFileSync(PATH, JSON.stringify(merged, null, 2));
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
