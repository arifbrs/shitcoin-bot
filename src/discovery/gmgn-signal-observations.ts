/** Prospective price observations only. This journal is never a trader candidate stream. */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GmgnSignalRow, GmgnTokenInfo } from "./gmgn.js";

export const OBSERVATION_VERSION = "gmgn-prospective-v1";
export const HORIZONS_MINUTES = [15, 60, 360, 1440] as const;
export type PriceSource = "dexscreener-fixed-pair" | "gmgn-token-info";
export interface SignalPolicy {
  id: string; source: PriceSource; horizonsMinutes: number[]; entryMaxDelayMs: number; horizonMaxDelayMs: number;
}
export interface SignalObservation {
  type: "gmgn-signal-observation"; version: typeof OBSERVATION_VERSION; signalId: string;
  upstreamId: string | null; identityQuality: "upstream-id" | "trigger-tuple" | "ambiguous";
  chain: string; mint: string; signalType: number; sym: string;
  observedAt: number; requestStartedAt: number; triggerAt: number | null; triggerAtRaw: number | null;
  observationDelayMs: number | null; signalTimes: number | null; qualityFlags: string[];
  policy: SignalPolicy; rawSignal: GmgnSignalRow;
}
export interface PriceSnapshot {
  source: PriceSource; chain: string; mint: string; pairAddress: string | null;
  fetchedAt: number; sourceTimestamp: null; priceUsd: number | null; mcUsd: number | null;
  liquidityUsd: number | null; error: string | null;
}
export interface SignalMark {
  type: "gmgn-signal-mark"; version: typeof OBSERVATION_VERSION; markId: string; signalId: string;
  chain: string; mint: string; policyId: string; horizonMinutes: number;
  targetAt: number; checkedAt: number; actualAgeMinutes: number; latenessMs: number;
  status: "OBSERVED" | "MISSING"; reason: string | null; snapshot: PriceSnapshot | null;
  entryCheckedAt: number | null; returnSpanMinutes: number | null; priceChangePct: number | null;
  executionState: "PRICE_MARK_ONLY_NOT_EXECUTED";
}
export interface ObservationJournal { signals: SignalObservation[]; marks: SignalMark[]; malformed: number; duplicates: number }
export interface MarkTarget { signal: SignalObservation; markId: string; horizonMinutes: number; targetAt: number; expiresAt: number }

export function observationDir(): string {
  return process.env.GMGN_OBSERVATION_DIR?.trim() || join(process.env.LOG_DIR?.trim() || new URL("../../logs/", import.meta.url).pathname, "gmgn-observations");
}
export function journalPath(root = observationDir()): string { return join(root, "journal.jsonl"); }

export function signalPolicy(chain: string): SignalPolicy {
  const body = { version: OBSERVATION_VERSION, source: chain === "robinhood" ? "gmgn-token-info" as const : "dexscreener-fixed-pair" as const,
    horizonsMinutes: [...HORIZONS_MINUTES], entryMaxDelayMs: 300_000, horizonMaxDelayMs: 300_000 };
  return { ...body, id: hash(JSON.stringify(body)) };
}

export function observeSignal(chain: string, row: GmgnSignalRow, observedAt: number, requestStartedAt: number): SignalObservation | null {
  if (!row || typeof row.token_address !== "string" || !row.token_address || !Number.isInteger(row.signal_type) || !Number.isFinite(observedAt) || observedAt <= 0) return null;
  const mint = normalizedAddress(chain, row.token_address);
  const upstreamId = typeof row.id === "string" && row.id.trim() ? row.id : null;
  const triggerAtRaw = finite(row.trigger_at);
  // GMGN's documented unit is Unix seconds; never guess milliseconds for malformed timestamps.
  const triggerAt = triggerAtRaw != null && triggerAtRaw > 0 && triggerAtRaw < 100_000_000_000 ? triggerAtRaw * 1000 : null;
  const signalTimes = finite(row.signal_times);
  const identityQuality = upstreamId ? "upstream-id" : triggerAt ? "trigger-tuple" : "ambiguous";
  const qualityFlags: string[] = [];
  if (identityQuality === "ambiguous") qualityFlags.push("SIGNAL_IDENTITY_UNAVAILABLE");
  if (triggerAt == null) qualityFlags.push("TRIGGER_TIME_UNAVAILABLE");
  if (triggerAt != null && triggerAt > observedAt) qualityFlags.push("FUTURE_TRIGGER");
  // A provider ID that updates its trigger must not collapse successive events. Aggregate
  // signal_times may change on other signal types, so it is metadata, NOT an event identity.
  const signalId = hash(JSON.stringify([OBSERVATION_VERSION, chain, mint, row.signal_type, upstreamId, triggerAtRaw,
    identityQuality === "ambiguous" ? observedAt : null]));
  return { type: "gmgn-signal-observation", version: OBSERVATION_VERSION, signalId, upstreamId, identityQuality,
    chain, mint, signalType: row.signal_type, sym: typeof row.data?.symbol === "string" ? row.data.symbol : "?", observedAt, requestStartedAt,
    triggerAt, triggerAtRaw, observationDelayMs: triggerAt == null ? null : observedAt - triggerAt,
    signalTimes, qualityFlags, policy: signalPolicy(chain), rawSignal: row };
}

export function readObservationJournal(root = observationDir(), strict = true): ObservationJournal {
  const out: ObservationJournal = { signals: [], marks: [], malformed: 0, duplicates: 0 };
  const file = journalPath(root);
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    // An incomplete tail cannot safely be appended to. Preserve it and fail closed for writers.
    if (i === lines.length - 1 && !text.endsWith("\n")) { out.malformed++; continue; }
    try {
      const row = JSON.parse(line) as SignalObservation | SignalMark;
      if (row.version !== OBSERVATION_VERSION || !row.signalId || !row.chain || !row.mint) throw new Error("invalid observation identity");
      const id = row.type === "gmgn-signal-observation" ? `signal:${row.signalId}` : row.type === "gmgn-signal-mark" ? `mark:${row.markId}` : "";
      if (!id || (row.type === "gmgn-signal-observation" && (!row.policy?.id || !Array.isArray(row.policy.horizonsMinutes))) ||
        (row.type === "gmgn-signal-mark" && !["OBSERVED", "MISSING"].includes(row.status))) throw new Error("invalid observation record");
      if (seen.has(id)) { out.duplicates++; continue; }
      seen.add(id);
      if (row.type === "gmgn-signal-observation") out.signals.push(row); else out.marks.push(row);
    } catch { out.malformed++; }
  }
  if (strict && (out.malformed || out.duplicates)) throw new Error(`GMGN observation journal invalid: ${out.malformed} malformed, ${out.duplicates} duplicate; preserved, not reset`);
  return out;
}

export function appendObservation(row: SignalObservation | SignalMark, root = observationDir()): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(journalPath(root), JSON.stringify(row) + "\n");
}

export function writeObservationHealth(role: "collector" | "tracker", data: Record<string, unknown>, root = observationDir()): void {
  mkdirSync(root, { recursive: true });
  const path = join(root, `${role}-health.json`), tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...data, pid: process.pid, updatedAt: Date.now() }));
  renameSync(tmp, path);
}

/** One collector and one tracker. Atomic creation; a live/unknown lock is never overwritten. */
export function acquireObservationLock(role: "collector" | "tracker", root = observationDir()): () => void {
  mkdirSync(root, { recursive: true });
  const file = join(root, `${role}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => { if (existsSync(file) && readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt) throw error;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${role} lock has unknown owner: ${file}`);
      try { process.kill(pid, 0); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(file); continue; }
        throw e;
      }
      throw new Error(`GMGN ${role} already running (pid ${pid})`);
    }
  }
  throw new Error(`cannot acquire ${role} lock`);
}

export function dueMarkTargets(journal: ObservationJournal, now: number): MarkTarget[] {
  const done = new Set(journal.marks.map((m) => m.markId));
  return journal.signals.flatMap((signal) => [0, ...signal.policy.horizonsMinutes].map((horizonMinutes) => {
    const markId = `${signal.signalId}:${signal.policy.id}:${horizonMinutes}`;
    const targetAt = signal.observedAt + horizonMinutes * 60_000;
    return { signal, markId, horizonMinutes, targetAt,
      expiresAt: targetAt + (horizonMinutes === 0 ? signal.policy.entryMaxDelayMs : signal.policy.horizonMaxDelayMs) };
  }).filter((t) => now >= t.targetAt && !done.has(t.markId))).sort((a, b) => a.expiresAt - b.expiresAt || a.markId.localeCompare(b.markId));
}

export function makeSignalMark(target: MarkTarget, snapshot: PriceSnapshot | null, checkedAt: number, entry?: SignalMark, failure?: string): SignalMark {
  const { signal, horizonMinutes, targetAt } = target;
  let reason = failure ?? snapshot?.error ?? null;
  if (checkedAt > target.expiresAt) reason = snapshot ? "LATE_RESPONSE" : "WINDOW_MISSED";
  if (checkedAt < targetAt) reason = "EARLY_MARK";
  if (signal.identityQuality === "ambiguous" || signal.qualityFlags.includes("FUTURE_TRIGGER")) reason = "SIGNAL_IDENTITY_OR_TIME_INVALID";
  if (horizonMinutes > 0 && entry?.status !== "OBSERVED") reason ??= "ENTRY_UNAVAILABLE";
  if (snapshot && (snapshot.source !== signal.policy.source || snapshot.chain !== signal.chain || snapshot.mint !== signal.mint)) reason = "SOURCE_IDENTITY_MISMATCH";
  if (horizonMinutes > 0 && snapshot && entry?.snapshot && snapshot.pairAddress !== entry.snapshot.pairAddress) reason = "PAIR_CHANGED";
  if (positive(snapshot?.priceUsd) == null) reason ??= "PRICE_UNAVAILABLE";
  const status = reason ? "MISSING" : "OBSERVED";
  const entryCheckedAt = horizonMinutes > 0 && entry?.status === "OBSERVED" ? entry.checkedAt : null;
  return { type: "gmgn-signal-mark", version: OBSERVATION_VERSION, markId: target.markId, signalId: signal.signalId,
    chain: signal.chain, mint: signal.mint, policyId: signal.policy.id, horizonMinutes, targetAt, checkedAt,
    actualAgeMinutes: (checkedAt - signal.observedAt) / 60_000, latenessMs: checkedAt - targetAt,
    status, reason, snapshot, entryCheckedAt, returnSpanMinutes: entryCheckedAt == null ? null : (checkedAt - entryCheckedAt) / 60_000,
    priceChangePct: status === "OBSERVED" && horizonMinutes > 0 && positive(entry?.snapshot?.priceUsd) != null
      ? (snapshot!.priceUsd! / entry!.snapshot!.priceUsd! - 1) * 100 : null,
    executionState: "PRICE_MARK_ONLY_NOT_EXECUTED" };
}

export function dexChain(chain: string): string { return ({ sol: "solana", eth: "ethereum" } as Record<string, string>)[chain] ?? chain; }
export function normalizedAddress(chain: string, address: string): string { return chain === "sol" ? address : address.toLowerCase(); }
export function dexPriceSnapshot(chain: string, mint: string, rows: unknown[], fetchedAt: number, pairAddress?: string | null): PriceSnapshot {
  const pairs = rows.filter((r): r is Record<string, unknown> => r != null && typeof r === "object").filter((r) => {
    const base = r.baseToken as { address?: string } | undefined;
    return r.chainId === dexChain(chain) && typeof base?.address === "string" && normalizedAddress(chain, base.address) === mint &&
      typeof r.pairAddress === "string" && (!pairAddress || r.pairAddress === pairAddress);
  }).sort((a, b) => Number(positive((b.liquidity as { usd?: number } | undefined)?.usd) ?? 0) - Number(positive((a.liquidity as { usd?: number } | undefined)?.usd) ?? 0) || String(a.pairAddress).localeCompare(String(b.pairAddress)));
  const p = pairs[0];
  const priceUsd = positive(p?.priceUsd);
  return { source: "dexscreener-fixed-pair", chain, mint, pairAddress: typeof p?.pairAddress === "string" ? p.pairAddress : pairAddress ?? null,
    fetchedAt, sourceTimestamp: null, priceUsd, mcUsd: positive(p?.marketCap), liquidityUsd: positive((p?.liquidity as { usd?: number } | undefined)?.usd),
    error: !p ? pairAddress ? "PAIR_UNAVAILABLE" : "NO_MATCHING_BASE_TOKEN_PAIR" : priceUsd == null ? "PRICE_UNAVAILABLE" : null };
}

export function gmgnPriceSnapshot(chain: string, mint: string, info: GmgnTokenInfo, fetchedAt: number): PriceSnapshot {
  const priceUsd = positive(info.price?.price), supply = positive(info.circulating_supply);
  return { source: "gmgn-token-info", chain, mint, pairAddress: info.biggest_pool_address ?? null,
    fetchedAt, sourceTimestamp: null, priceUsd, mcUsd: priceUsd != null && supply != null ? positive(priceUsd * supply) : null,
    liquidityUsd: positive(info.liquidity), error: priceUsd == null ? "PRICE_UNAVAILABLE" : null };
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function positive(value: unknown): number | null {
  if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null;
}
