/** Read-only prospective marks. No signing, bankroll, candidate admission, or backfilling. */
import "dotenv/config";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { gmgnReadResult, type GmgnTokenInfo } from "./gmgn.js";
import { acquireObservationLock, appendObservation, dexChain, dexPriceSnapshot, dueMarkTargets, gmgnPriceSnapshot,
  makeSignalMark, observationDir, readObservationJournal, writeObservationHealth, type MarkTarget, type PriceSnapshot } from "./gmgn-signal-observations.js";

const POLL_MS = 60_000;
const GMGN_MAX_PER_POLL = 8;
let stopping = false;

async function dexSnapshots(targets: MarkTarget[], entries: Map<string, import("./gmgn-signal-observations.js").SignalMark>): Promise<Map<string, PriceSnapshot>> {
  const result = new Map<string, PriceSnapshot>();
  const chains = [...new Set(targets.map((t) => t.signal.chain))];
  for (const chain of chains) {
    const mints = [...new Set(targets.filter((t) => t.signal.chain === chain).map((t) => t.signal.mint))];
    for (let i = 0; i < mints.length && !stopping; i += 30) {
      const batch = mints.slice(i, i + 30);
      let rows: unknown[] = [], error: string | null = null;
      try {
        const res = await fetch(`https://api.dexscreener.com/tokens/v1/${dexChain(chain)}/${batch.map(encodeURIComponent).join(",")}`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) error = `DEX_HTTP_${res.status}`;
        else { const data: unknown = await res.json(); if (Array.isArray(data)) rows = data; else error = "DEX_RESPONSE_SHAPE"; }
      } catch (e) { error = `DEX_NETWORK_ERROR:${(e as Error).name}`; }
      const fetchedAt = Date.now();
      for (const target of targets.filter((t) => t.signal.chain === chain && batch.includes(t.signal.mint))) {
        const baselinePair = target.horizonMinutes > 0 ? entries.get(target.signal.signalId)?.snapshot?.pairAddress : null;
        const snapshot = dexPriceSnapshot(chain, target.signal.mint, rows, fetchedAt, baselinePair);
        if (error) snapshot.error = error;
        result.set(target.markId, snapshot);
      }
      // Bounded, non-bursting batches; never consume the Solana Tracker/Jupiter budget.
      if (i + 30 < mints.length) await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  return result;
}

async function poll(): Promise<void> {
  const journal = readObservationJournal();
  const targets = dueMarkTargets(journal, Date.now());
  const entries = new Map(journal.marks.filter((m) => m.horizonMinutes === 0).map((m) => [m.signalId, m]));
  let observed = 0, missing = 0;
  const write = (target: MarkTarget, snapshot: PriceSnapshot | null, failure?: string): void => {
    const mark = makeSignalMark(target, snapshot, snapshot?.fetchedAt ?? Date.now(), entries.get(target.signal.signalId), failure);
    appendObservation(mark);
    if (mark.horizonMinutes === 0) entries.set(mark.signalId, mark);
    if (mark.status === "OBSERVED") observed++; else missing++;
  };
  const live: MarkTarget[] = [];
  for (const target of targets) {
    if (Date.now() > target.expiresAt) write(target, null, "WINDOW_MISSED");
    else if (target.signal.identityQuality === "ambiguous" || target.signal.qualityFlags.includes("FUTURE_TRIGGER")) write(target, null, "SIGNAL_IDENTITY_OR_TIME_INVALID");
    else if (target.horizonMinutes > 0 && entries.get(target.signal.signalId)?.status !== "OBSERVED") write(target, null, "ENTRY_UNAVAILABLE");
    else live.push(target);
  }
  const dexTargets = live.filter((t) => t.signal.policy.source === "dexscreener-fixed-pair");
  const snapshots = await dexSnapshots(dexTargets, entries);
  for (const target of dexTargets) {
    if (stopping) break;
    write(target, snapshots.get(target.markId) ?? null, snapshots.has(target.markId) ? undefined : "FETCH_NOT_COMPLETED");
  }
  // Robinhood uses GMGN's own token price. Group same-token targets, and honor shared cooldown.
  const gmgnTargets = live.filter((t) => t.signal.policy.source === "gmgn-token-info");
  const grouped = new Map<string, MarkTarget[]>();
  for (const target of gmgnTargets) {
    const key = `${target.signal.chain}:${target.signal.mint}`;
    grouped.set(key, [...(grouped.get(key) ?? []), target]);
  }
  let calls = 0;
  for (const group of grouped.values()) {
    if (stopping || calls >= GMGN_MAX_PER_POLL) break;
    const first = group[0]!;
    if (Date.now() > first.expiresAt) { for (const t of group) write(t, null, "WINDOW_MISSED"); continue; }
    calls++;
    const result = await gmgnReadResult<GmgnTokenInfo>("getTokenInfo", [first.signal.chain, first.signal.mint]);
    const snapshot = result.ok ? gmgnPriceSnapshot(first.signal.chain, first.signal.mint, result.data, Date.now()) : null;
    for (const target of group) write(target, snapshot, result.ok ? undefined : `GMGN_${result.status ?? "LOCAL"}:${result.error}`);
    if (!result.ok && result.retryAt != null && result.retryAt > Date.now()) break;
  }
  console.log(`[gmgn-outcomes] ${new Date().toISOString()} signals=${journal.signals.length} due=${targets.length} observed=${observed} missing=${missing} deferred=${targets.length - observed - missing} gmgnCalls=${calls}`);
  // A6 (round-3): akuntansi interval hilang yang TAHAN LAMA — satu baris per poll, terbaca kapan
  // pun setelah proses mati (health file hanya snapshot terakhir dan bisa basi tanpa kabar).
  try {
    appendFileSync(join(observationDir(), "tracker-log.jsonl"), JSON.stringify({ ts: Date.now(), pollMs: POLL_MS, signals: journal.signals.length, due: targets.length, observed, missing, deferred: targets.length - observed - missing, gmgnCalls: calls }) + "\n");
  } catch { /* log sekunder tidak boleh menggagalkan poll utama */ }
  writeObservationHealth("tracker", { status: "RUNNING", pollMs: POLL_MS, signals: journal.signals.length, due: targets.length, observed, missing, deferred: targets.length - observed - missing, gmgnCalls: calls });
}

async function main(): Promise<void> {
  const release = acquireObservationLock("tracker");
  const shutdown = () => { stopping = true; };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  console.log(`[gmgn-outcomes] journal=${observationDir()} horizons=15m,1h,6h,24h; tolerance=5m; PRICE MARKS, NOT PROFIT. Read-only.`);
  try {
    do {
      await poll();
      if (process.argv.includes("--once") || stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, POLL_MS);
        function done() { clearTimeout(timer); process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); }
        process.once("SIGINT", done); process.once("SIGTERM", done);
      });
    } while (!stopping);
  } finally { release(); }
}

void main().catch((e) => {
  writeObservationHealth("tracker", { status: "ERROR", error: (e as Error).message });
  console.error(`[gmgn-outcomes] stopped: ${(e as Error).message}`); process.exitCode = 1;
});
