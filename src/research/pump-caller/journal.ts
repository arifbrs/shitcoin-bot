/**
 * JURNAL LANE PUMP-CALLER — append-only JSONL + outcome marks idempoten.
 * Semua entri membawa schemaVersion + source + ts; trade/caller event dedupe by dedupeKey;
 * outcome marks idempoten by `decisionId:horizonMin` (restart-safe).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OutcomeMark } from "./types.js";
import { PUMP_CALLER_SCHEMA } from "./types.js";

export function journalDir(): string { return process.env.PUMP_CALLER_DIR?.trim() || "logs/pump-caller"; }
function file(): string { return join(journalDir(), "journal.jsonl"); }

export function append(entry: Record<string, unknown>): void {
  mkdirSync(journalDir(), { recursive: true });
  appendFileSync(file(), JSON.stringify({ schemaVersion: PUMP_CALLER_SCHEMA, ...entry }) + "\n");
}

export interface Journal { rows: Array<Record<string, unknown>>; malformed: number; duplicates: number }

export function read(): Journal {
  const out: Journal = { rows: [], malformed: 0, duplicates: 0 };
  if (!existsSync(file())) return out;
  const seen = new Set<string>();
  for (const line of readFileSync(file(), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const k = dedupeKeyOf(row);
      if (k) { if (seen.has(k)) { out.duplicates++; continue; } seen.add(k); }
      out.rows.push(row);
    } catch { out.malformed++; }
  }
  return out;
}

/** Kunci idempoten: trade/caller event → dedupeKey; outcome → decisionId:horizonMin; keputusan → decisionId. */
export function dedupeKeyOf(row: Record<string, unknown>): string | null {
  if (row.type === "outcome-mark") return `outcome:${row.decisionId}:${row.horizonMin}`;
  if (row.type === "shadow-decision") return `decision:${row.decisionId}`;
  if (row.type === "trade" || row.type === "caller-event") return String(row.dedupeKey);
  if (row.type === "candle-snapshot") return `candles:${row.mint}:${row.interval}:${row.fromTs}:${row.count}`;
  if (row.type === "token-observed") return `token:${row.mint}`;
  return null; // tipe lain boleh berulang (ringkasan dsb.)
}

/** Tulis outcome mark bila belum ada (idempoten); return true bila baru ditulis. */
export function markOutcome(m: OutcomeMark): boolean {
  const j = read();
  const key = `outcome:${m.decisionId}:${m.horizonMin}`;
  const exists = j.rows.some((r) => dedupeKeyOf(r) === key);
  if (exists) return false;
  append({ type: "outcome-mark", ts: m.checkedAt, ...m });
  return true;
}

export function decisionIdFor(mint: string, decidedAt: number, strategyVersion: string): string {
  return `${mint}:${decidedAt}:${strategyVersion}`;
}
