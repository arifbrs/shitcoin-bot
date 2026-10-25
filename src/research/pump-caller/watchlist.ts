/**
 * WATCHLIST RISET BERBATAS (sprint §3) — admission kebijakan berkelanjutan (bukan poll-semua):
 * kandidat launch di-admit dengan prioritas (devInitialBuy / MC), kapasitas + TTL dibatasi,
 * penolakan DICATAT dgn alasan (tidak dihapus diam-diam). Persist restart-safe.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WatchEntry { mint: string; symbol?: string; admittedAt: number; source: "pumpportal" | "manual" | "gmgn-trending"; priority: number; lastObservedAt: number | null; bondingCurveKey?: string }
export interface RejectedEntry { mint: string | null; reason: string; ts: number }

export function watchDir(): string { return process.env.PUMP_CALLER_DIR?.trim() || "logs/pump-caller"; }
const wlPath = (): string => join(watchDir(), "watchlist.json");
const rjPath = (): string => join(watchDir(), "watchlist-rejected.jsonl");

/** Policy v1 (dibekukan): kapasitas 40, TTL 2 jam, sampling 1 dari N=3 (operator bisa ubah via env). */
export function policyFromEnv() {
  return {
    capacity: Math.max(1, Number(process.env.PUMP_WATCH_CAPACITY ?? 40)),
    ttlMs: Math.max(60_000, Number(process.env.PUMP_WATCH_TTL_MS ?? 2 * 3_600_000)),
    sampleEvery: Math.max(1, Number(process.env.PUMP_WATCH_SAMPLE ?? 3)),
  };
}

export function loadWatchlist(): WatchEntry[] {
  try {
    if (!existsSync(wlPath())) return [];
    const j = JSON.parse(readFileSync(wlPath(), "utf8")) as { entries?: WatchEntry[] };
    return Array.isArray(j.entries) ? j.entries : [];
  } catch { return []; }
}

export function saveWatchlist(entries: WatchEntry[]): void {
  mkdirSync(watchDir(), { recursive: true });
  const tmp = `${wlPath()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), entries }));
  renameSync(tmp, wlPath());
}

export function logRejected(entry: RejectedEntry): void {
  mkdirSync(watchDir(), { recursive: true });
  writeFileSync(rjPath(), JSON.stringify(entry) + "\n", { flag: "a" });
}

/** Admission murni (teruji): evict kedaluwarsa, kapasitas prioritas, sampling deterministik. */
export function admit(
  current: WatchEntry[], candidate: { mint: string; symbol?: string; source: "pumpportal" | "manual" | "gmgn-trending"; priority: number; bondingCurveKey?: string },
  policy: ReturnType<typeof policyFromEnv>, seq: number, now: number,
): { entries: WatchEntry[]; admitted: boolean; reason: string } {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(candidate.mint)) { logRejected({ mint: candidate.mint, reason: "INVALID_MINT", ts: now }); return { entries: current, admitted: false, reason: "INVALID_MINT" }; }
  if (current.some((e) => e.mint === candidate.mint)) return { entries: current, admitted: false, reason: "ALREADY_WATCHED" };
  if (candidate.source === "pumpportal" && seq % policy.sampleEvery !== 0) {
    logRejected({ mint: candidate.mint, reason: `SAMPLING_1_OF_${policy.sampleEvery}`, ts: now });
    return { entries: current, admitted: false, reason: "SAMPLING" };
  }
  let entries = current.filter((e) => now - e.admittedAt < policy.ttlMs); // evict TTL dulu
  if (entries.length >= policy.capacity) {
    // evict prioritas terendah & terlama-di-list (bukan yang baru masuk)
    let worst = 0;
    for (let i = 1; i < entries.length; i++) {
      const w = entries[i]!, b = entries[worst]!;
      if (w.priority < b.priority || (w.priority === b.priority && w.admittedAt < b.admittedAt)) worst = i;
    }
    if (entries[worst]!.priority >= candidate.priority) {
      logRejected({ mint: candidate.mint, reason: `CAPACITY_FULL (${entries.length}) PRIORITAS LEBIH RENDAH`, ts: now });
      return { entries, admitted: false, reason: "CAPACITY_FULL" };
    }
    entries = entries.filter((_, i) => i !== worst);
  }
  entries.push({ mint: candidate.mint, symbol: candidate.symbol, admittedAt: now, source: candidate.source, priority: candidate.priority, lastObservedAt: null, ...(candidate.bondingCurveKey ? { bondingCurveKey: candidate.bondingCurveKey } : {}) });
  return { entries: [...entries], admitted: true, reason: "OK" };
}
