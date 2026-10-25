import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

mkdirSync(config.logDir, { recursive: true });

const day = () => new Date().toISOString().slice(0, 10);

/**
 * LOG RETENTION — required for 24/7. Measured: ~44 MB of JSONL per day (decisions 18 MB, events
 * 13 MB, path 12 MB), and nothing ever deleted it. That is ~1.3 GB/month, ~16 GB/year: on a small
 * VPS the disk fills and the bot dies from an unrelated-looking write error.
 *
 * Daily files are dated, so retention is just "drop files older than N days". Trade records
 * (paper-trades) are the analysis substrate and are kept far longer than the high-volume
 * diagnostic streams, which are only useful while recent.
 */
const RETAIN_DAYS: Record<string, number> = {
  "paper-trades": 90, "run-ledger": 90, "patterns": 90, // the P&L / analysis record — keep
  "decisions": 7, "events": 7, "path": 3, "post-exit": 14, "arm-results": 90, // high-volume diagnostics — recent only
  // Robinhood Chain lane (ditambah 2026-10-07): trade paper = catatan P&L (keep), rh-events =
  // observasi/telemetri volume tinggi (cukup 14 hari; ledger durabel dipegang rh:review).
  "rh-paper": 90, "rh-events": 14,
  // Per-tick position marks: one line per open position every 5s. Dense but short-lived — it
  // exists to answer "what was this worth at T seconds?", which needs days, not months.
  "ticks": 3,
};
function pruneOldLogs(): void {
  const now = Date.now();
  let files: string[];
  try { files = readdirSync(config.logDir); } catch { return; }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const stream = Object.keys(RETAIN_DAYS).find((k) => f.startsWith(k));
    if (!stream) continue;
    const p = join(config.logDir, f);
    try {
      if (now - statSync(p).mtimeMs > RETAIN_DAYS[stream]! * 24 * 60 * 60_000) unlinkSync(p);
    } catch { /* best-effort */ }
  }
}
pruneOldLogs();
setInterval(pruneOldLogs, 6 * 60 * 60_000).unref(); // every 6h; unref so it never holds the process open

/** Append a structured record to logs/<stream>-YYYY-MM-DD.jsonl. The JSONL files are the single
 *  source of truth for all analysis (shadow, calibration, dashboard). */
/** Count of numeric fields rejected as invalid, surfaced by the integrity check. */
export const logIntegrity = { badFields: 0, lastBad: null as string | null };

/**
 * Reject NaN / Infinity BEFORE they reach the log. A single NaN silently poisons every
 * aggregate computed downstream (a mean becomes NaN, a sum becomes NaN) and is invisible in
 * JSON — `NaN` is not valid JSON, so JSON.stringify writes it as `null` and the corruption
 * looks like ordinary missing data. Here it is turned into an explicit null AND counted, so a
 * broken number is a reported defect instead of a quiet hole in the dataset.
 */
function sanitize(obj: unknown, path = ""): unknown {
  if (typeof obj === "number") {
    if (Number.isFinite(obj)) return obj;
    logIntegrity.badFields++; logIntegrity.lastBad = `${path}=${String(obj)}`;
    return null;
  }
  if (Array.isArray(obj)) return obj.map((v, i) => sanitize(v, `${path}[${i}]`));
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = sanitize(v, path ? `${path}.${k}` : k);
    return out;
  }
  return obj;
}

export function logRecord(stream: "decisions" | "paper-trades" | "events" | "run-ledger" | "post-exit" | "patterns" | "path" | "ticks" | "arm-results" | "live-exec" | "rh-paper" | "rh-events", record: unknown): void {
  const rec = sanitize({ ts: new Date().toISOString(), ...(record as object) });
  appendFileSync(join(config.logDir, `${stream}-${day()}.jsonl`), JSON.stringify(rec) + "\n");
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export const ui = {
  info: (msg: string) => console.log(`${C.dim}${msg}${C.reset}`),
  event: (msg: string) => console.log(`${C.cyan}${msg}${C.reset}`),
  pass: (msg: string) => console.log(`${C.green}${msg}${C.reset}`),
  reject: (msg: string) => console.log(`${C.red}${msg}${C.reset}`),
  warn: (msg: string) => console.log(`${C.yellow}${msg}${C.reset}`),
};
