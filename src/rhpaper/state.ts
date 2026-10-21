/**
 * STATE paper 1:1 — satu penulis, tulis atomik, ledger JSONL yang bisa diaudit.
 * Lokasi: logs/rhpaper/ (bisa dioverride RHPAPER_DIR untuk pengujian).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface Position {
  token: string; symbol: string; entryTs: number; entryQuoteRef: string; entryUsd: number; qtyRaw: string;
  peakPnlPct?: number; stuck?: boolean; stuckReason?: string;
}
export interface PaperState {
  version: 2; cycles: number; day: string; positions: Position[]; closed: number; pnlUsd: number; stuck: number;
}

export function dir(): string { return process.env.RHPAPER_DIR || "logs/rhpaper"; }
export function statePath(): string { return dir() + "/state.json"; }
export function ledgerPath(date = new Date().toISOString().slice(0, 10)): string { return dir() + "/ledger-" + date + ".jsonl"; }

export function emptyState(): PaperState { return { version: 2, cycles: 0, day: new Date().toISOString().slice(0, 10), positions: [], closed: 0, pnlUsd: 0, stuck: 0 }; }

export function loadState(): PaperState {
  try {
    if (!existsSync(statePath())) return emptyState();
    const j = JSON.parse(readFileSync(statePath(), "utf8")) as PaperState;
    if (j.version !== 2) return emptyState();
    return j;
  } catch { return emptyState(); }
}

/** Tulis atomik: tmp → rename (tidak pernah meninggalkan state setengah jadi). */
export function saveState(s: PaperState): void {
  mkdirSync(dir(), { recursive: true });
  const tmp = statePath() + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, statePath());
}

export function appendLedger(entry: Record<string, unknown>): void {
  mkdirSync(dir(), { recursive: true });
  appendFileSync(ledgerPath(), JSON.stringify(entry) + "\n");
}

/** Lock satu-penulis: PID + takeover bila proses lama mati. */
export function withLock<T>(fn: () => T): T {
  mkdirSync(dir(), { recursive: true });
  const lock = dir() + "/.lock";
  try {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (pid && pid !== process.pid) {
        try { process.kill(pid, 0); throw new Error("lane lain masih hidup (pid " + pid + ")"); } catch (e) {
          if (String((e as Error).message).includes("masih hidup")) throw e;
        }
      }
    }
    writeFileSync(lock, String(process.pid));
    try { return fn(); } finally { try { unlinkSync(lock); } catch { /* sudah lepas */ } }
  } catch (e) { throw e; }
}

/** Audit: baris ledger wajib punya quoteRef; tanpa itu = FAIL (tidak boleh ada laba tanpa bukti). */
export function auditLedger(lines: string[]): { ok: boolean; bad: number } {
  let bad = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      const j = JSON.parse(l) as Record<string, unknown>;
      if ((j.action === "OPEN" || j.action === "CLOSE") && !j.quoteRef) bad++;
    } catch { bad++; }
  }
  return { ok: bad === 0, bad };
}
