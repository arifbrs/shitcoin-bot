import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import type { OkxWsEvent } from "./okx-ws.js";

/**
 * Persistent OKX pre-execution candidate ledger.
 *
 * This module deliberately stops one boundary before execution. A signal or tracked-wallet buy
 * can become WATCH or REJECT, but never "approved", never an order, and never a transaction. The
 * point is to make radar → signal/copy → measured candidate a complete, auditable workflow while
 * the signal source is still earning evidence. Connecting this ledger to a signer would require a
 * separate policy and explicit owner opt-in; there is no hidden callback here that can do it.
 */

const STORE_PATH = join(config.logDir, "okx-candidates.json");
const STORE_VERSION = 1 as const;

export interface OkxCandidatePolicy {
  maxLagMs: number;
  minAmountUsd: number;
}

export interface OkxCandidate {
  candidateId: string;
  kind: "signal" | "copy";
  status: "WATCH" | "REJECT";
  executionState: "BLOCKED";
  channel: string;
  mint: string;
  symbol: string | null;
  wallet: string | null;
  walletType: string | null;
  detectedAt: number;
  sourceTs: number | null;
  detectLagMs: number | null;
  amountUsd: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  reasons: string[];
}

interface CandidateStore {
  version: typeof STORE_VERSION;
  updatedAt: string;
  candidates: OkxCandidate[];
}

const numberOrNull = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const stringOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (obj[key] != null) return obj[key];
  return undefined;
}

function candidateId(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/** Pure normaliser used by both the live lane and offline regression tests. */
export function buildOkxCandidate(
  kind: OkxCandidate["kind"],
  event: OkxWsEvent,
  policy: OkxCandidatePolicy = {
    maxLagMs: config.okx.candidateMaxLagMs,
    minAmountUsd: config.okx.candidateMinAmountUsd,
  },
): OkxCandidate | null {
  const data = event.data;
  const token = data["token"] && typeof data["token"] === "object" ? data["token"] as Record<string, unknown> : {};
  const mint = stringOrNull(pick(data, ["tokenAddress", "tokenContractAddress", "mint"]) ?? pick(token, ["tokenAddress", "tokenContractAddress"]));
  if (!mint) return null;

  const symbol = stringOrNull(pick(data, ["symbol", "tokenSymbol"]) ?? pick(token, ["symbol"]));
  const wallet = stringOrNull(pick(data, ["walletAddress", "triggerWalletAddress", "trader", "userAddress"]));
  const walletType = stringOrNull(pick(data, ["walletType", "tag"]));
  const amountUsd = numberOrNull(pick(data, ["amountUsd", "valueUsd", "quoteAmountUsd", "volumeUsd"]));
  const marketCapUsd = numberOrNull(pick(data, ["marketCapUsd", "marketCap"]) ?? pick(token, ["marketCapUsd"]));
  const holders = numberOrNull(pick(data, ["holders"]) ?? pick(token, ["holders"]));
  const lag = event.detectLagMs == null ? null : Math.max(0, event.detectLagMs);
  const reasons: string[] = [];
  if (lag != null && lag > policy.maxLagMs) reasons.push(`STALE_LAG>${policy.maxLagMs}ms`);
  if (amountUsd != null && amountUsd < policy.minAmountUsd) reasons.push(`AMOUNT_USD<${policy.minAmountUsd}`);
  if (kind === "copy" && !wallet) reasons.push("COPY_WALLET_MISSING");

  return {
    candidateId: candidateId([
      kind, event.channel, mint, wallet, event.sourceTs ?? event.receivedAt,
      amountUsd, pick(data, ["amount", "price", "cursor"]),
    ]),
    kind,
    status: reasons.length === 0 ? "WATCH" : "REJECT",
    executionState: "BLOCKED",
    channel: event.channel,
    mint,
    symbol,
    wallet,
    walletType,
    detectedAt: event.receivedAt,
    sourceTs: event.sourceTs,
    detectLagMs: lag,
    amountUsd,
    marketCapUsd,
    holders,
    reasons,
  };
}

let storeBroken = false;
let records = new Map<string, OkxCandidate>();
let flushTimer: NodeJS.Timeout | null = null;

function loadStore(): void {
  if (!existsSync(STORE_PATH)) return;
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<CandidateStore>;
    if (parsed.version !== STORE_VERSION || !Array.isArray(parsed.candidates)) throw new Error("unsupported store shape");
    records = new Map(parsed.candidates.filter((row) => typeof row?.candidateId === "string").map((row) => [row.candidateId, row]));
  } catch (cause) {
    // Fail closed and preserve the unreadable file. Starting "fresh" would overwrite evidence
    // and erase the dedupe keys that prevent a restart from replaying old candidates.
    storeBroken = true;
    ui.warn(`[okx-candidates] ledger unreadable — writes disabled: ${(cause as Error).message}`);
  }
}
loadStore();

function persist(): void {
  if (storeBroken) return;
  const max = config.okx.candidateMaxRecords;
  const candidates = [...records.values()].sort((a, b) => a.detectedAt - b.detectedAt).slice(-max);
  records = new Map(candidates.map((row) => [row.candidateId, row]));
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, updatedAt: new Date().toISOString(), candidates } satisfies CandidateStore, null, 2));
    renameSync(tmp, STORE_PATH);
  } catch (cause) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    ui.warn(`[okx-candidates] ledger write failed: ${(cause as Error).message}`);
  }
}

function schedulePersist(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; persist(); }, 250);
  flushTimer.unref?.();
}

/** Insert once across reconnects/restarts. Returns null for disabled, invalid, or duplicate rows. */
export function enqueueOkxCandidate(kind: OkxCandidate["kind"], event: OkxWsEvent): OkxCandidate | null {
  if (!config.okx.candidateQueueEnabled || storeBroken) return null;
  const candidate = buildOkxCandidate(kind, event);
  if (!candidate || records.has(candidate.candidateId)) return null;
  records.set(candidate.candidateId, candidate);
  schedulePersist();
  logRecord("events", { type: "okx-candidate", ...candidate });
  return candidate;
}

/** Flush before a clean lane shutdown so the last 250ms debounce window is not lost. */
export function flushOkxCandidates(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  persist();
}

export function okxCandidateCount(): number { return records.size; }
export function okxCandidateLedgerPath(): string { return STORE_PATH; }
