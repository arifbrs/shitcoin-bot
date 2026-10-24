/**
 * STATE paper 1:1 — satu penulis, tulis atomik, ledger JSONL yang bisa diaudit.
 * Lokasi: logs/rhpaper/ (bisa dioverride RHPAPER_DIR untuk pengujian).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface Position {
  arm: string; token: string; symbol: string; entryTs: number; entryQuoteRef: string; entryUsd: number; entryWethRaw: string; qtyRaw: string;
  peakPct?: number; troughPct?: number; marks?: number; stuckCount?: number; stuck?: boolean; stuckReason?: string;
  tradeId?: string; policyId?: string;
  liquidityUsd?: number | null; // (B3) likuiditas pool saat entry — untuk model fill, bukan keputusan
  liquiditySource?: "dexscreener" | null; // (R8) provenance: dari mana angka likuiditas
  liquidityReason?: string | null; // (R8) alasan bila null (DEXSCREENER_NO_PAIR / fetch gagal)
  liquidityAt?: number | null; // (R8) timestamp snapshot likuiditas
  exitPolicy?: { stopPct: number; takePct: number; tpHoldMin: number };
}
export interface PaperState {
  version: 2; cycles: number; day: string; positions: Position[]; closed: number; pnlUsd: number; stuck: number;
  netWethRaw?: string; updatedAt?: number;
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
  s.updatedAt = Date.now();
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

/** Lock untuk pekerjaan ASYNC: lock ditahan sampai promise selesai (withLock sinkron tidak bisa). */
export async function withLockAsync<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(dir(), { recursive: true });
  const lock = dir() + "/.lock";
  try {
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8").trim());
      if (pid && pid !== process.pid) {
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) throw new Error("lane lain masih hidup (pid " + pid + ")");
      }
    }
    writeFileSync(lock, String(process.pid));
    try { return await fn(); } finally { try { unlinkSync(lock); } catch { /* sudah lepas */ } }
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
