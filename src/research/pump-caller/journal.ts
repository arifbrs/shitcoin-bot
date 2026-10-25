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
  // outcome-mark TIDAK didedupe (event stream); state final = reduceOutcomes(rows).
  return out;
}

/** Kunci idempoten: trade/caller event → dedupeKey; keputusan → decisionId.
 *  outcome-mark TIDAK lagi didedupe di read() — state dihitung lewat reduceOutcomes()
 *  (S8-P1: baris PENDING lama tidak boleh MENUTUPI OBSERVED yang datang belakangan). */
export function dedupeKeyOf(row: Record<string, unknown>): string | null {
  if (row.type === "outcome-mark") return null;
  if (row.type === "shadow-decision" || row.type === "h2-decision") return `decision:${row.decisionId}`;
  if (row.type === "h2-event") return `h2event:${row.h2EventId}`; // (S11) dedupe event lintas pass/restart
  // h2-confirmation TIDAK didedupe (event stream; state terakhir per h2EventId yang menang).
  if (row.type === "trade" || row.type === "caller-event") return String(row.dedupeKey);
  if (row.type === "candle-snapshot") return `candles:${row.mint}:${row.interval}:${row.fromTs}:${row.count}`;
  if (row.type === "token-observed") return `token:${row.mint}`;
  return null; // tipe lain boleh berulang (ringkasan dsb.)
}

export interface OutcomeState { key: string; status: "PENDING" | "OBSERVED" | "MISSING_FINAL"; priceAtTarget: number | null; changePct: number | null; attempts: number; checkedAt: number }

/**
 * (S8-P1) Reduksi event→state append-only untuk outcome-mark:
 *   PENDING → PENDING(attempts++) | OBSERVED | MISSING_FINAL ; OBSERVED/MISSING_FINAL = TERMINAL
 *   (baris setelah terminal untuk kunci sama DIABAIKAN — terminal tak tertimpa diam-diam).
 */
export function reduceOutcomes(rows: Array<Record<string, unknown>>): Map<string, OutcomeState> {
  const map = new Map<string, OutcomeState>();
  for (const r of rows) {
    if (r.type !== "outcome-mark") continue;
    const key = `outcome:${r.decisionId}:${r.horizonMin}`;
    const status = String(r.status) as OutcomeState["status"];
    const cur = map.get(key);
    if (cur && (cur.status === "OBSERVED" || cur.status === "MISSING_FINAL")) continue; // terminal
    if (!cur && status !== "PENDING" && status !== "OBSERVED" && status !== "MISSING_FINAL") continue;
    map.set(key, { key, status, priceAtTarget: r.priceAtTarget != null ? Number(r.priceAtTarget) : null,
      changePct: r.changePct != null ? Number(r.changePct) : null, attempts: Number(r.attempts ?? 0), checkedAt: Number(r.ts ?? 0) });
  }
  return map;
}

/** Tulis mark hanya bila TRANSISI berubah (atau attempts naik saat PENDING) — no-op lain. */
export function markOutcome(m: OutcomeMark & { attempts?: number }): boolean {
  const cur = reduceOutcomes(read().rows).get(`outcome:${m.decisionId}:${m.horizonMin}`);
  if (cur && cur.status !== "PENDING") return false; // terminal (OBSERVED/MISSING_FINAL)
  const nextAttempts = Number(m.attempts ?? ((cur?.attempts ?? 0) + 1));
  if (cur && m.status === "PENDING" && nextAttempts <= cur.attempts) return false;
  append({ type: "outcome-mark", ts: m.checkedAt, ...m, attempts: nextAttempts });
  return true;
}

export function decisionIdFor(mint: string, decidedAt: number, strategyVersion: string): string {
  return `${mint}:${decidedAt}:${strategyVersion}`;
}
