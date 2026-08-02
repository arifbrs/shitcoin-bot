import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { config } from "../config.js";
import { fetchJson, sleep, TokenBucket, RateLimited } from "../util/http.js";
import { ui } from "../util/log.js";
import type { GateCheck } from "../types.js";

/** Pump uses Pubkey::default() in the account for SOL curves; v2 instructions pass WSOL. */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export function quoteMintIsSol(mint: string | null | undefined): boolean {
  return !mint
    || mint === "SOL"
    || mint === "11111111111111111111111111111111"
    || mint === WRAPPED_SOL_MINT;
}

// ── RPC BUDGET: PRIORITY LANES + ACCOUNTING ──────────────────────────────────
// ROOT CAUSE of the 490s detect→entry latency (measured, not guessed): the free Helius
// tier gives ~8 req/s and EVERYTHING shared one bucket — the counterfactual observatory's
// classifyLaunch (~6 RPC each, 1/s) plus per-position dev polling consumed the whole budget
// before a single candidate could be gated, so candidates queued for minutes.
//
// Fix: two lanes. TRADING calls (gate, entry, position ticks) use the full bucket and are
// never blocked by research. RESEARCH calls (observatory counterfactual classification,
// backfill enrichment) run in a small reserved slice AND yield whenever trading work is
// in flight — so research consumes only genuinely idle capacity.
const rpcBucket = TokenBucket.perSecond(config.limits.rpcMaxRps);
const researchBucket = TokenBucket.perSecond(Math.max(0.5, config.limits.rpcMaxRps * config.limits.researchRpcFrac));
const priorityCtx = new AsyncLocalStorage<{ low: true }>();

/** Run `fn` with every RPC inside it marked RESEARCH (yields to trading, own small budget). */
export function lowPriorityRpc<T>(fn: () => Promise<T>): Promise<T> {
  return priorityCtx.run({ low: true }, fn);
}

let hotInFlight = 0; // trading-critical RPC currently awaiting a response
const stats = { hot: 0, research: 0, skipped: 0, errors: 0, rateLimited: 0, byMethod: new Map<string, number>(), errorsByMethod: new Map<string, number>() };
const recent: number[] = []; // timestamps of the last calls → rolling req/s
const recentLatencies: number[] = []; // ms, last N successful calls → p50/p95 (audit P1-6)
const LATENCY_WINDOW = 200;
function noteCall(method: string, low: boolean): void {
  low ? stats.research++ : stats.hot++;
  stats.byMethod.set(method, (stats.byMethod.get(method) ?? 0) + 1);
  const now = Date.now();
  recent.push(now);
  while (recent.length && now - recent[0]! > 10_000) recent.shift();
}
function noteLatency(ms: number): void {
  recentLatencies.push(ms);
  if (recentLatencies.length > LATENCY_WINDOW) recentLatencies.shift();
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}
/**
 * AUDIT P1-6: a concurrency gate SEPARATE from the token bucket. The bucket caps the average
 * rate but its burst allowance equals its capacity — after any idle gap that many requests can
 * fire in the same instant. This blocks a new HOT request from starting once `rpcMaxConcurrent`
 * are already in flight, regardless of how many tokens are banked, so a burst of candidates
 * can't all leave in the same millisecond even though each individually has budget to spend.
 */
async function acquireHotSlot(): Promise<void> {
  while (hotInFlight >= config.limits.rpcMaxConcurrent) await sleep(15);
  hotInFlight++;
}
/** Live RPC health — the number that explains entry latency. Written to logs/rpc-health.json. */
export function rpcStats(): { rps: number; capacity: number; utilPct: number; hot: number; research: number; skipped: number; errors: number; rateLimited: number; inFlight: number; maxConcurrent: number; curveRejected: number; curveRejectReason: string | null; topMethods: Array<{ method: string; n: number }>; topErrorMethods: Array<{ method: string; n: number }>; latencyP50Ms: number; latencyP95Ms: number } {
  const now = Date.now();
  while (recent.length && now - recent[0]! > 10_000) recent.shift();
  const rps = recent.length / 10;
  const sortedLatencies = [...recentLatencies].sort((a, b) => a - b);
  return {
    rps: Number(rps.toFixed(2)), capacity: config.limits.rpcMaxRps,
    utilPct: Math.round((rps / config.limits.rpcMaxRps) * 100),
    hot: stats.hot, research: stats.research, skipped: stats.skipped, errors: stats.errors, rateLimited: stats.rateLimited,
    inFlight: hotInFlight, maxConcurrent: config.limits.rpcMaxConcurrent,
    curveRejected: curveParse.rejected, curveRejectReason: curveParse.lastReason,
    topMethods: [...stats.byMethod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([method, n]) => ({ method, n })),
    topErrorMethods: [...stats.errorsByMethod.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([method, n]) => ({ method, n })),
    latencyP50Ms: Math.round(percentile(sortedLatencies, 0.5)), latencyP95Ms: Math.round(percentile(sortedLatencies, 0.95)),
  };
}

class ResearchYield extends Error { constructor() { super("research RPC yielded to trading"); } }
/** True when a research call was dropped because trading needed the budget (not an error). */
export const isResearchYield = (e: unknown): boolean => e instanceof ResearchYield;

let rpcId = 0;
/**
 * `params` is `unknown`, not `unknown[]`, on purpose. JSON-RPC permits either an array or an
 * object, and Helius's DAS methods (getTokenAccounts, getAsset, …) REQUIRE an object — verified
 * live: sending `[{mint, limit}]` returns `invalid type: map, expected a string`, while sending
 * the bare object succeeds. Widening the type keeps every existing array caller valid.
 */
/**
 * Params may be a FUNCTION of the endpoint URL, because providers disagree on the shape of the
 * same method. Measured 2026-08-02 on `getTokenAccounts` (the holder gate's primary source):
 *   Helius    accepts `mint`,        rejects `mintAddress` ("unknown field")
 *   QuickNode accepts `mintAddress`, rejects `mint`
 * There is no single body that both accept, and the pool retries the SAME params on the next
 * endpoint — so a fixed shape means one provider always fails, takes an undeserved strike, and
 * eventually gets benched, silently destroying the redundancy it was added for.
 */
type ParamsFor = unknown | ((url: string) => unknown);
const resolveParams = (p: ParamsFor, url: string): unknown => (typeof p === "function" ? (p as (u: string) => unknown)(url) : p);

/**
 * A CLIENT error — malformed params, a bad pubkey, a field this provider does not know. The
 * endpoint is behaving correctly by rejecting it; the request is what is wrong.
 *
 * This distinction was missing and it cost twice. The catch-all `else if (++ep.fails >= 3)`
 * branch below treated these exactly like a 5xx or a timeout, so (a) a healthy endpoint
 * collected strikes and was eventually benched for OUR bug, and (b) every such call was retried
 * across the whole pool even though a rejected pubkey is rejected identically everywhere —
 * burning the entry path's RPC budget to re-learn the same answer.
 *
 * Observed live 2026-08-02: sending Helius's `mint` spelling to QuickNode benched BOTH healthy
 * endpoints for 15s. Solana RPC has no distinct error class for this, so match on the wording
 * the providers actually return.
 */
const CLIENT_ERROR = /invalid pubkey|invalid param|unknown field|validation error|invalid type|expected one of|missing field|could not parse|invalid request/i;
function isClientError(err: unknown): boolean {
  return CLIENT_ERROR.test((err as Error)?.message ?? "");
}

async function rpcVia<T>(url: string, method: string, params: ParamsFor, low: boolean, signal?: AbortSignal): Promise<T> {
  const res = await fetchJson<{ result?: T; error?: { message: string } }>(url, {
    bucket: low ? researchBucket : rpcBucket,
    body: { jsonrpc: "2.0", id: ++rpcId, method, params: resolveParams(params, url) },
    retries: 1,
    failFastOn429: true, // a rate-limited endpoint should hand off, not stall
    signal,
  });
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result as T;
}

/**
 * ENDPOINT POOL HEALTH. One entry per URL in `config.rpcEndpoints`, priority = array order.
 *
 * An endpoint that rate-limits us is benched for `rpcCooldownMs` rather than retried, because
 * a spent free tier answers 429 instantly and forever — retrying it just burns wall-clock on
 * every single call. Benching is NOT a ban: the endpoint returns automatically when the
 * cooldown expires, which is what makes a burst-throttle (recovers in seconds) and an
 * exhausted monthly quota (recovers next cycle) both self-healing without human action.
 */
interface EndpointHealth {
  url: string;
  host: string;
  benchedUntil: number;
  maxBatch: number;   // provider's getMultipleAccounts cap — measured, not assumed
  fails: number;      // consecutive non-429 failures
  strikes: number;    // CONSECUTIVE 429s — drives the escalating bench, reset by any success
  rateLimits: number; // lifetime 429s
  calls: number;      // lifetime successful calls
  benchReason: "rate-limit" | "daily-quota" | "unreachable" | "failing" | null;
}

/**
 * How long to bench an endpoint after `strikes` consecutive 429s: 90s, 3m, 6m, 12m … capped
 * at 30m. This is what makes strict-priority key rotation actually cheap.
 *
 * A flat cooldown cannot tell two very different things apart. A BURST throttle recovers in
 * seconds, so it must come back fast — and it does, because one success resets `strikes` to 0.
 * An EXHAUSTED MONTHLY QUOTA answers 429 for days; with a flat 90s bench, the top-priority key
 * un-benches and eats a 429 on the entry path every 90 seconds, forever. Escalating means a
 * genuinely spent key backs off to once every 30 minutes on its own, while still returning
 * automatically when the quota resets. No human action, no restart, no stale config.
 */
function benchMs(strikes: number): number {
  return Math.min(config.rpcCooldownMs * 2 ** Math.max(0, strikes - 1), 30 * 60_000);
}

/**
 * An explicit provider quota error is not an ordinary burst throttle. Live validation on
 * 2026-07-28 also proved the provider's "daily request limit" message can recover within minutes,
 * so assuming a UTC-day reset would unnecessarily discard a healthy endpoint for hours. Probe
 * again every five minutes. This is deliberately NOT strike-escalated: many concurrent callers
 * can observe the same provider response before the shared endpoint state is benched, and that
 * concurrency must not turn one quota event into a false 30-minute exclusion. Exported only so
 * this measured distinction has a deterministic fixture test.
 */
export function rateLimitBenchPolicy(
  detail: string,
  strikes: number,
  now = Date.now(),
): { ms: number; reason: "rate-limit" | "daily-quota" } {
  const quota = /\b(daily|monthly)\b.{0,80}\b(limit|quota|request|credit)|\b(limit|quota|credit).{0,80}\b(daily|monthly)\b/i.test(detail);
  if (!quota) return { ms: benchMs(strikes), reason: "rate-limit" };
  void now; // deterministic API for tests/callers; quota policy is duration-based, not wall-clock.
  return { ms: 5 * 60_000, reason: "daily-quota" };
}

const endpoints: EndpointHealth[] = config.rpcEndpoints.map((url) => {
  const host = (() => { try { return new URL(url).host; } catch { return url.slice(0, 40); } })();
  const key = Object.keys(config.rpcBatchLimits).find((k) => k !== "default" && host.includes(k));
  return {
    url,
    host,
    maxBatch: key ? config.rpcBatchLimits[key]! : config.rpcBatchLimits.default!,
    benchedUntil: 0,
    fails: 0,
    strikes: 0,
    rateLimits: 0,
    calls: 0,
    benchReason: null,
  };
});

/** Largest batch any LIVE endpoint will accept right now — what a bulk read may chunk at. */
export function maxLiveBatch(): number {
  const now = Date.now();
  const live = endpoints.filter((e) => e.benchedUntil <= now);
  return Math.max(1, ...(live.length ? live : endpoints).map((e) => e.maxBatch));
}

/**
 * Is this a connection-level failure (host doesn't resolve / refuses / drops)?
 * Node's fetch reports these as a TypeError whose `cause.code` carries the real reason, so
 * the code is checked first and the message only as a fallback for wrapped errors.
 */
const UNREACHABLE = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED"]);
function isUnreachable(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code && UNREACHABLE.has(code)) return true;
  const msg = (err as Error)?.message ?? "";
  return [...UNREACHABLE].some((c) => msg.includes(c));
}

/** Health snapshot for the dashboard — never leaks the URL (it contains the API key). */
export function rpcEndpointHealth(): Array<{ host: string; live: boolean; benchedForSec: number; calls: number; rateLimits: number; fails: number; strikes: number; benchReason: EndpointHealth["benchReason"] }> {
  const now = Date.now();
  return endpoints.map((e) => ({
    host: e.host,
    live: e.benchedUntil <= now,
    benchedForSec: e.benchedUntil > now ? Math.round((e.benchedUntil - now) / 1000) : 0,
    calls: e.calls,
    rateLimits: e.rateLimits,
    fails: e.fails,
    strikes: e.strikes, // consecutive 429s — a key sitting at 4+ is spent, not merely throttled
    benchReason: e.benchReason,
  }));
}

/**
 * Rotating failover across the whole pool. Walks endpoints in priority order, skipping any
 * that are benched, and returns the first success.
 *
 * If EVERY endpoint is benched we do not give up — we use the one whose cooldown expires
 * soonest. A hard blackout would silently stop the bot reading curves at all, which is worse
 * than one more 429: blind positions are how we got a -96% hold before.
 */
/**
 * Public escape hatch onto the SAME pooled/rotating/rate-limited transport as every other
 * function in this file, for callers that need a JSON-RPC method we have not built a bespoke
 * wrapper for (e.g. `simulateTransaction`). Prefer a dedicated wrapper (`getAccountInfoBase64`,
 * `bondingCurvePriceSol`, ...) when one already exists; use this rather than constructing a raw
 * `@solana/web3.js` `Connection`, which bypasses the pool entirely — see `getAccountInfoBase64`'s
 * doc comment for the measured cost of that (a 429 storm against a single benched endpoint,
 * invisible to `rpc-health.json`). Found a second instance of the same bug 2026-07-26:
 * `execution/executor.ts`'s `simulateBuyMainnet`, called after every paper OPEN, had its own
 * `new Connection(config.rpcUrl).simulateTransaction(...)`.
 */
/**
 * Wait until a mint account is actually VISIBLE to our RPC, then return immediately.
 *
 * Replaces a blind fixed sleep, and the bug it fixes was hiding behind a misleading error.
 * Buy simulations were failing with `{"InstructionError":[2,"IncorrectProgramId"]}` — 872 times
 * today alone, and 2,703 the day before — which reads like a wrong program address. It is not.
 * The failing instruction is the associated-token-account creation: it calls `GetAccountDataSize`
 * on the mint, and when the mint account does not exist yet, the token program reports
 * `IncorrectProgramId` rather than "missing account". Verified directly: a mint that failed this
 * way was absent from `getAccountInfo` at simulation time and present minutes later, owned by
 * Token-2022 exactly as expected.
 *
 * It is a RACE, and the project caused it by getting faster. The error count was zero through
 * 2026-07-28 and appeared only as detect→entry latency collapsed: the bot now reaches the buy
 * simulation ~5s after seeing the create broadcast, sometimes 2.2s, which can be ahead of the
 * mint's propagation to our endpoint.
 *
 * A longer fixed delay is the wrong fix. Measured against 378 live launches, entering 60s late
 * instead of at launch cuts the odds of a +43% move from 16.1% to 2.8%, so blanket patience costs
 * exactly the edge the latency work bought. Polling for real visibility is adaptive in both
 * directions: when the chain is quick this returns sooner than the old 1.5s sleep, and it only
 * waits longer when waiting is genuinely necessary.
 *
 * EXISTENCE IS NOT ENOUGH (tightened 2026-07-31, same day). The first version only checked that
 * `getAccountInfo` returned non-null, and `IncorrectProgramId` kept happening afterwards — 12
 * more times — on mints that were present and Token-2022-owned by the time they were inspected.
 * The gap is the initialization window: `SystemProgram.createAccount` allocates the account
 * FIRST, so for a moment it exists while still owned by the System program, and only the
 * subsequent `InitializeMint2` hands it to a token program. A bare existence check passes during
 * that window, and the ATA instruction still fails, because `GetAccountDataSize` rejects a mint
 * the invoked token program does not own. So this waits for the account to be owned by an actual
 * token program, which is the condition the transaction really depends on.
 *
 * Fails OPEN on a timeout — the caller proceeds and the buy simulation stays the real arbiter.
 * This is a scheduling aid, not a safety gate, and it must never become a new reason to skip.
 */
const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token (classic)
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
]);
export async function waitForMintVisible(mint: string, maxWaitMs = 8_000, pollMs = 250): Promise<{ visible: boolean; waitedMs: number }> {
  const started = Date.now();
  // Cheap syntactic guard — a malformed mint can never become visible, so don't burn the budget.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return { visible: false, waitedMs: 0 };
  for (;;) {
    try {
      const res = await pooledRpc<{ value: { owner?: string } | null }>("getAccountInfo", [mint, { encoding: "base64", commitment: "processed" }]);
      const owner = res?.value?.owner;
      if (owner && TOKEN_PROGRAMS.has(owner)) return { visible: true, waitedMs: Date.now() - started };
    } catch { /* transport hiccup — keep waiting until the cap, then fail open */ }
    if (Date.now() - started >= maxWaitMs) return { visible: false, waitedMs: Date.now() - started };
    await sleep(pollMs);
  }
}

export async function pooledRpc<T>(method: string, params: ParamsFor, signal?: AbortSignal): Promise<T> {
  return rpc<T>(method, params, 0, signal);
}

async function rpc<T>(method: string, params: ParamsFor, needBatch = 0, signal?: AbortSignal): Promise<T> {
  const low = priorityCtx.getStore()?.low === true;
  if (low) {
    // Yield the budget to the trading path: if any gate/entry/tick RPC is in flight, this
    // research call is dropped rather than queued behind it. Research is never allowed to
    // push a live entry back in the queue — that is exactly what caused the 490s latency.
    if (hotInFlight > 0) { stats.skipped++; throw new ResearchYield(); }
  } else {
    await acquireHotSlot(); // audit P1-6: concurrency gate, separate from the token bucket's rate cap
  }
  noteCall(method, low);
  try {
    const now = Date.now();
    // Endpoints that cannot take this batch size are not "unhealthy" — they are simply the
    // wrong tool for THIS call. Filtering here (rather than letting them error) is what keeps
    // a 5-account provider from taking an undeserved strike on a 100-account read.
    const capable = endpoints.filter((e) => e.maxBatch >= needBatch);
    let pool = capable.filter((e) => e.benchedUntil <= now);
    if (!pool.length) {
      const from = capable.length ? capable : endpoints;
      pool = [from.reduce((a, b) => (a.benchedUntil <= b.benchedUntil ? a : b))];
    }
    let lastErr: unknown;
    for (const ep of pool) {
      // GHOST-REQUEST FIX (2026-07-28): an external deadline (the fast gate's ~2.5s wave) firing
      // between endpoint attempts must stop the whole pool loop here, not just the current fetch
      // — otherwise a call that's already lost the race just moves on to try the NEXT endpoint,
      // extending exactly the "held slot past the deadline" problem this signal exists to prevent.
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const callStart = Date.now();
      try {
        const out = await rpcVia<T>(ep.url, method, params, low, signal);
        ep.calls++;
        ep.fails = 0;
        ep.strikes = 0; // it answered — whatever throttled it has cleared, so start over at 90s
        ep.benchReason = null;
        // BUG FIX (2026-07-28): a success only ever reset fails/strikes/benchReason, never
        // benchedUntil itself — an endpoint reached via the "least-benched fallback" (pool empty,
        // picks the endpoint with the soonest-expiring bench) could answer successfully for
        // thousands of calls while its OLD, longer benchedUntil timestamp (set by an earlier,
        // heavier penalty) stayed in the future. Health reporting (`live: benchedUntil <= now`)
        // then showed it permanently dead despite it actively serving traffic. A real success
        // must clear the bench outright, not just the counters that led to it.
        ep.benchedUntil = 0;
        noteLatency(Date.now() - callStart);
        return out;
      } catch (err) {
        stats.errorsByMethod.set(method, (stats.errorsByMethod.get(method) ?? 0) + 1);
        lastErr = err;
        if (err instanceof ResearchYield) throw err; // budget yield, not an endpoint fault
        if (isClientError(err)) throw err; // our request is malformed — no strike, and no point asking anyone else
        if (err instanceof RateLimited) {
          stats.rateLimited++;
          ep.rateLimits++;
          const policy = rateLimitBenchPolicy(err.detail, ++ep.strikes);
          const ms = policy.ms;
          ep.benchedUntil = Date.now() + ms;
          ep.benchReason = policy.reason;
          if (endpoints.length > 1) {
            const label = policy.reason === "daily-quota" ? "daily quota exhausted" : `rate-limited (strike ${ep.strikes})`;
            ui.warn(`[rpc] ${ep.host} ${label} — benched ${Math.round(ms / 1000)}s, rotating`);
          }
        } else if (isUnreachable(err)) {
          // DNS/TCP-level failure: the host does not resolve or refuses connections. That is
          // DEFINITIVE, not ambiguous, so bench on the FIRST occurrence. Waiting for 3 strikes
          // cost ~1.5s on every call in the meantime (measured) — unacceptable on the entry path.
          ep.benchedUntil = Date.now() + Math.min(config.rpcCooldownMs, 15_000);
          ep.fails = 0;
          ep.benchReason = "unreachable";
          if (endpoints.length > 1) ui.warn(`[rpc] ${ep.host} unreachable — benched 15s, rotating`);
        } else if (++ep.fails >= 3) {
          // Ambiguous failures (5xx, timeouts, a single bad response) — these are usually
          // transient, and benching a healthy endpoint costs us its speed, so require repeats.
          ep.benchedUntil = Date.now() + Math.min(config.rpcCooldownMs, 15_000);
          ep.fails = 0;
          ep.benchReason = "failing";
          if (endpoints.length > 1) ui.warn(`[rpc] ${ep.host} failing — benched 15s, rotating`);
        }
      }
    }
    throw lastErr ?? new Error(`${method}: no RPC endpoint available`);
  } catch (err) {
    if (!(err instanceof ResearchYield)) stats.errors++;
    throw err;
  } finally {
    if (!low) hotInFlight--;
  }
}

interface ParsedMintInfo {
  value: {
    data: {
      parsed: {
        type: string;
        info: {
          mintAuthority: string | null;
          freezeAuthority: string | null;
          supply: string;
          decimals: number;
        };
      };
      program: string; // "spl-token" | "spl-token-2022"
    };
  } | null;
}

interface LargestAccounts {
  value: Array<{ address: string; uiAmount: number | null }>;
}

/**
 * Gate #1: authority checks — the strongest, cheapest signals (CONCEPT.md D4).
 * Mint or freeze authority still held → REJECT.
 */
export async function authorityChecks(mint: string, retryDelayMs = 5_000, signal?: AbortSignal): Promise<GateCheck[]> {
  // "confirmed" commitment + one retry: a mint created seconds ago is often not
  // yet visible at the default "finalized" level — that's propagation lag, not a scam signal.
  // LATENCY FIX: the retry used to sleep a hard-coded 5s — inside a 2.5s gate deadline that
  // sleep could never pay off, it just held an RPC slot and leaked work past the deadline.
  // The fast gate now passes a short delay (see runSetupGate); slow/research callers keep 5s.
  let parsed: NonNullable<ParsedMintInfo["value"]>["data"]["parsed"] | undefined;
  for (let attempt = 0; ; attempt++) {
    const info = await rpc<ParsedMintInfo>("getAccountInfo", [
      mint,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ], 0, signal);
    parsed = info.value?.data?.parsed;
    if (parsed?.type === "mint" || attempt >= 1) break;
    await sleep(retryDelayMs);
  }
  if (!parsed || parsed.type !== "mint") {
    return [{ name: "mint-account", passed: false, hard: true, detail: "mint account not found/parsable yet" }];
  }
  const { mintAuthority, freezeAuthority } = parsed.info;
  return [
    {
      name: "mint-authority-renounced",
      passed: mintAuthority === null,
      hard: true,
      detail: mintAuthority === null ? "renounced" : `HELD by ${mintAuthority}`,
    },
    {
      name: "freeze-authority-renounced",
      passed: freezeAuthority === null,
      hard: true,
      detail: freezeAuthority === null ? "renounced" : `HELD by ${freezeAuthority}`,
    },
  ];
}

/**
 * Gate #2: holder concentration via getTokenLargestAccounts.
 * On brand-new pump.fun tokens the bonding curve itself holds most supply, so
 * we drop the single largest account (assumed curve/pool vault) and measure
 * concentration among the rest. Thin data in the first seconds — that's why
 * fast-follow also relies on gate #1 + small size (CONCEPT.md D4 blind spots).
 */
export async function holderConcentration(mint: string, totalSupplyUi: number | null): Promise<GateCheck[]> {
  const largest = await rpc<LargestAccounts>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
  const amounts = largest.value.map((a) => a.uiAmount ?? 0).filter((a) => a > 0);
  if (amounts.length === 0) {
    return [{ name: "holder-data", passed: false, hard: false, detail: "no holder data yet" }];
  }
  const supply = totalSupplyUi ?? amounts.reduce((s, a) => s + a, 0);
  const sorted = [...amounts].sort((a, b) => b - a);
  const nonCurve = sorted.slice(1); // drop presumed curve/pool vault
  const top10Share = nonCurve.slice(0, 10).reduce((s, a) => s + a, 0) / supply;
  const maxSingle = (nonCurve[0] ?? 0) / supply;
  return [
    {
      name: "top10-concentration",
      passed: top10Share <= config.gate.top10ConcentrationMax,
      hard: true,
      detail: `top-10 (excl. curve) hold ${(top10Share * 100).toFixed(1)}% (max ${config.gate.top10ConcentrationMax * 100}%)`,
    },
    {
      name: "single-holder",
      passed: maxSingle <= config.gate.singleHolderMax,
      hard: true,
      detail: `largest non-curve holder ${(maxSingle * 100).toFixed(1)}% (max ${config.gate.singleHolderMax * 100}%)`,
    },
  ];
}

/**
 * How many REAL people hold this token right now (the demand signal). Counts
 * non-zero token accounts from getTokenLargestAccounts and drops the single
 * largest (the bonding-curve vault). Maxes at ~19 (the RPC returns up to 20) —
 * plenty for a "≥ N buyers" entry gate. Returns null if the read fails.
 *
 * GMGN FALLBACK (audit 2026-07-31) — measured: `getTokenLargestAccounts` was failing
 * 1,217 out of 1,217 calls, a clean 100%. Cause: QuickNode had been benched on
 * `daily-quota`, leaving Helius as the only live endpoint, and Helius's free tier does not
 * serve this method at all. Since the caller correctly fails CLOSED on a null (see
 * papertrader.ts's P0 fix), a 100% read failure meant Strategy 1 was rejecting candidates it
 * could not see rather than candidates it had judged — 143 of 294 skips in one hour.
 *
 * Note the two sources are NOT the same measurement and must never be silently conflated:
 * RPC counts non-zero accounts in the top 20 (so it saturates around 19), while GMGN's
 * `holder_count` is the token's TOTAL holder count (routinely in the hundreds or thousands).
 * That is fine for the only question this feeds — "have real buyers shown up, or is it just
 * the dev" — because GMGN's number is a superset of the RPC one, so a floor test can only
 * become more permissive at the margin, never wrongly strict. It would NOT be valid to reuse
 * this for a concentration/top-holder ratio, which is why `holderConcentration` above keeps
 * its own RPC-only path. `source` is returned so analysis can separate the two cohorts.
 */
// Circuit breaker for the RPC path (audit 2026-07-31). A fallback alone would have fixed the
// SKIPs but not the waste: every one of those 1,217 calls still had to be issued and still had to
// fail before the fallback could run, and each one spent a slot against the pool's rate limit on
// the one endpoint still alive. When a method is unsupported by the current endpoint, that is a
// standing fact for as long as that endpoint is the live one, so after enough consecutive
// failures this stops asking for a while and goes straight to GMGN. Deliberately time-boxed
// rather than permanent: endpoints get unbenched (QuickNode's is a DAILY quota), and the breaker
// must reopen on its own when that happens without needing a restart.
const LARGEST_ACCOUNTS_BREAKER = { consecutiveFails: 0, openUntil: 0 };
const BREAKER_TRIP_AFTER = 10;
const BREAKER_COOLDOWN_MS = 10 * 60_000;

/**
 * Helius DAS `getTokenAccounts` — the real fix for the 100% `getTokenLargestAccounts` failure.
 *
 * Found by reading Helius's docs properly (owner, 2026-07-31: "doc itu lengkap, bukan hanya
 * introduction") rather than treating Helius as a plain JSON-RPC endpoint. The method that was
 * failing is simply not served by Helius's free tier; this one is, and it answers a strictly
 * better question — actual on-chain token accounts for the mint, with balances, instead of a
 * capped top-20 list.
 *
 * Deliberately asks for a SMALL page. The response is paginated (`limit` + `cursor`) and `total`
 * is the page size, not the token's true holder count, so counting every holder would mean
 * walking every page — expensive, and pointless for the only question this feeds: "have real
 * buyers shown up, or is this just the dev". A page comfortably larger than the threshold answers
 * that exactly, and anything beyond it is reported as "at least this many".
 */
const HOLDER_PAGE = 60;
interface DasTokenAccounts { token_accounts?: Array<{ amount?: number; owner?: string }> }

export async function holderCountWithSource(mint: string): Promise<{ count: number | null; source: "rpc" | "das" | "gmgn" | null }> {
  try {
    // Per-provider shape — see the ParamsFor note on rpcVia. Keyed on the host so a new endpoint
    // defaults to the Helius spelling (the DAS spec Metaplex published); only QuickNode's variant
    // is special-cased, because that is the one measured to differ.
    const das = await rpc<DasTokenAccounts>("getTokenAccounts", (url: string) =>
      url.includes("quiknode.pro")
        ? { mintAddress: mint, limit: HOLDER_PAGE, options: { showZeroBalance: false } }
        : { mint, limit: HOLDER_PAGE, options: { showZeroBalance: false } });
    const accounts = das?.token_accounts;
    if (Array.isArray(accounts)) {
      // Distinct OWNERS, not accounts — one wallet can hold several token accounts for a mint,
      // and counting those separately would inflate "how many people hold this".
      const owners = new Set(accounts.filter((a) => (a.amount ?? 0) > 0).map((a) => a.owner ?? ""));
      owners.delete("");
      // Same convention as the old top-20 path: drop the largest holder as the curve/pool vault.
      return { count: Math.max(0, owners.size - 1), source: "das" };
    }
  } catch { /* fall through to the legacy path below */ }

  if (Date.now() < LARGEST_ACCOUNTS_BREAKER.openUntil) return holderCountViaGmgn(mint);
  try {
    const largest = await rpc<LargestAccounts>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    LARGEST_ACCOUNTS_BREAKER.consecutiveFails = 0;
    const nonZero = largest.value.map((a) => a.uiAmount ?? 0).filter((a) => a > 0);
    if (nonZero.length === 0) return { count: 0, source: "rpc" };
    return { count: Math.max(0, nonZero.length - 1), source: "rpc" }; // drop the curve/pool vault → real buyers
  } catch {
    if (++LARGEST_ACCOUNTS_BREAKER.consecutiveFails >= BREAKER_TRIP_AFTER && Date.now() >= LARGEST_ACCOUNTS_BREAKER.openUntil) {
      LARGEST_ACCOUNTS_BREAKER.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
      ui.warn(`[onchain] getTokenLargestAccounts failed ${LARGEST_ACCOUNTS_BREAKER.consecutiveFails}x in a row — no live endpoint serves it, falling back to GMGN holder_count for ${BREAKER_COOLDOWN_MS / 60_000}min`);
    }
    return holderCountViaGmgn(mint);
  }
}

async function holderCountViaGmgn(mint: string): Promise<{ count: number | null; source: "rpc" | "das" | "gmgn" | null }> {
  {
    // Lazy import so this module keeps no static dependency on the discovery layer.
    try {
      const { gmgnEnabled, gmgnTokenInfo } = await import("../discovery/gmgn.js");
      if (!gmgnEnabled) return { count: null, source: null };
      const info = await gmgnTokenInfo("sol", mint);
      const n = info?.holder_count;
      if (typeof n === "number" && isFinite(n) && n >= 0) return { count: n, source: "gmgn" };
    } catch { /* fallback itself failed — fall through to the honest null below */ }
    return { count: null, source: null };
  }
}

/** Back-compat shape for callers that only need the number. */
export async function holderCount(mint: string): Promise<number | null> {
  return (await holderCountWithSource(mint)).count;
}

/**
 * Generic pooled single-account read, decoded to a Buffer. Any module reading ONE on-chain
 * account (a bonding curve has its own batched/parsed path — use `bondingCurvePricesMulti`
 * instead) should call this rather than constructing its own `@solana/web3.js` `Connection`.
 *
 * A raw `new Connection(config.rpcUrl)` bypasses the pool entirely: no rotation, no escalating
 * backoff, no rate limiting, and it keeps hammering whichever single endpoint `config.rpcUrl`
 * happens to be even after the pool has already benched it for 429s. MEASURED 2026-07-26:
 * `safety/metadata.ts`'s own `new Connection` produced ~28 raw "Server responded with 429"
 * retries against QuickNode in the first 25s of a fresh run — invisible to `rpc-health.json` —
 * while the pool itself was correctly failing over to other endpoints for every other call.
 */
export async function getAccountInfoBase64(pubkey: string, commitment: "confirmed" | "processed" = "confirmed", signal?: AbortSignal): Promise<Buffer | null> {
  const res = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [pubkey, { encoding: "base64", commitment }], 0, signal);
  const b64 = res.value?.data?.[0];
  return b64 ? Buffer.from(b64, "base64") : null;
}

export async function totalSupplyUi(mint: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await rpc<{ value: { uiAmount: number | null } }>("getTokenSupply", [mint, { commitment: "confirmed" }], 0, signal);
    return res.value.uiAmount;
  } catch {
    return null;
  }
}

interface OwnerAccounts {
  value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }>;
}

/**
 * How much of `mint` the `owner` wallet currently holds (UI amount, summed
 * across its token accounts). Used to track the DEV/creator wallet over time:
 * a rising balance = buy-back (commitment); a falling one = dumping.
 * Returns null on RPC error so callers can skip rather than misread.
 */
export async function tokenBalanceOfOwner(owner: string, mint: string): Promise<number | null> {
  try {
    const res = await rpc<OwnerAccounts>("getTokenAccountsByOwner", [
      owner,
      { mint },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    return res.value.reduce((sum, a) => sum + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  } catch {
    return null;
  }
}

/**
 * Live price of a pump.fun bonding-curve token, read straight from its bonding
 * curve account (SOL per token), plus whether it has graduated (`complete`).
 * Layout verified against PumpPortal event data: u64 virtualTokenReserves @8,
 * u64 virtualSolReserves @16, bool complete @48. Lets fast-follow tokens be
 * priced the instant they launch, before DexScreener indexes them.
 */
export interface CurveState {
  priceSol: number;   // marginal price = vSol/vTokens
  complete: boolean;  // bonding curve finished → migrated to AMM
  vSol: number;       // VIRTUAL sol reserve (the x*y=k pricing input — what the program uses)
  vTokens: number;    // VIRTUAL token reserve (pricing input)
  realSol: number;    // REAL sol actually deposited — the SOL a sell can truly draw from
  realTokens: number; // REAL tokens still in the curve
  gradPct: number;    // 0..100 progress to graduation (realSol / ~85 SOL cap)
  /**
   * Pump's current account calls these quote reserves, not necessarily SOL reserves.
   * `priceSol` remains for compatibility but is SOL-denominated ONLY when quoteIsSol=true.
   */
  quoteMint: string | null;
  quoteIsSol: boolean;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
  layoutBytes: number;
}

/**
 * Read the pump.fun bonding-curve account. Layout (Anchor): [8 discriminator]
 * virtualTokenReserves u64@8, virtualSolReserves u64@16, realTokenReserves u64@24,
 * realSolReserves u64@32, tokenTotalSupply u64@40, complete bool@48. Pricing uses the
 * VIRTUAL reserves (that IS the program's constant-product); the REAL reserves tell us
 * how much SOL genuinely backs a payout and how close the curve is to graduating.
 */
/** Parse a raw bonding-curve account buffer into a CurveState (shared by single + batch reads). */
// ── ANCHOR DISCRIMINATOR (pump.fun is an Anchor program) ──
// Every Anchor account begins with 8 bytes = sha256("account:<StructName>")[0..8]. We were reading
// reserves from hard-coded offsets WITHOUT ever checking we had the right kind of account, so a
// wrong pubkey, a program upgrade, or an unrelated account would be parsed as reserves and produce
// a confident, completely fabricated price — which then drives entry MC, exit proceeds and P&L.
// VERIFIED against a live curve: computed 17b7f83760d8ac60 matches the real account byte-for-byte.
const BONDING_CURVE_DISCRIMINATOR = createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);

/** Counter surfaced in rpcStats so rejected/odd curve accounts are visible, not silent. */
export const curveParse = { rejected: 0, lastReason: null as string | null };

export function parseBondingCurveAccount(data: string | undefined): CurveState | null {
  if (!data) return null;
  const buf = Buffer.from(data, "base64");
  if (buf.length < 49) return null;
  // 1) It must actually BE a BondingCurve account.
  if (!buf.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) {
    curveParse.rejected++; curveParse.lastReason = "bad-discriminator";
    return null;
  }
  const vTokenReserves = buf.readBigUInt64LE(8);
  const vSolReserves = buf.readBigUInt64LE(16);
  const realTokenReserves = buf.length >= 32 ? buf.readBigUInt64LE(24) : 0n;
  const realSolReserves = buf.length >= 40 ? buf.readBigUInt64LE(32) : 0n;
  const complete = buf.readUInt8(48) === 1;
  const vSol = Number(vSolReserves) / 1e9;
  const vTokens = Number(vTokenReserves) / 1e6;
  const realSol = Number(realSolReserves) / 1e9;
  const realTokens = Number(realTokenReserves) / 1e6;
  // Current Pump BondingCurve layout (IDL order, offsets include the 8-byte discriminator):
  // creator@49..81, is_mayhem_mode@81, is_cashback_coin@82, quote_mint@83..115.
  // Pubkey::default() (32 zero bytes) denotes the legacy SOL quote. A layout shorter than 115
  // bytes predates non-SOL quotes and is therefore also SOL-denominated. Extra trailing bytes
  // in 151-byte accounts do not move these prefix fields.
  const hasQuoteLayout = buf.length >= 115;
  const quoteBytes = hasQuoteLayout ? buf.subarray(83, 115) : null;
  const quoteIsDefault = quoteBytes ? quoteBytes.every((byte) => byte === 0) : true;
  const quoteMint = quoteBytes && !quoteIsDefault ? bs58.encode(quoteBytes) : null;
  const quoteIsSol = !hasQuoteLayout || quoteMintIsSol(quoteMint);
  const isMayhemMode = hasQuoteLayout && buf.readUInt8(81) === 1;
  const isCashbackCoin = hasQuoteLayout && buf.readUInt8(82) === 1;
  const regime = {
    quoteMint,
    quoteIsSol,
    isMayhemMode,
    isCashbackCoin,
    layoutBytes: buf.length,
  };
  // pump.fun graduates near ~85 real SOL raised (~$69k MC). This is an ASSUMPTION, not a read
  // value — the curve account does not carry its own graduation threshold.
  //
  // Bitquery's docs give a token-based formula instead: 100 - ((realTokens - 206.9M) / 793.1M).
  // TESTED against 57 live curves 2026-07-26 and REJECTED: 19 of them (33%) carry realTokenReserves
  // outside the standard 0.7931 x totalSupply ratio — one had 1,328M reserves against a stated
  // 1,000M supply — and the token formula returns NEGATIVE progress there. Those are the same
  // custom-initial-reserve curves found in the MC investigation. The SOL-based form degrades
  // gracefully on them; the token-based one breaks. Adopting the "official" formula would have
  // been a regression.
  //
  // NOTE: gradPct currently has ZERO consumers outside this function — nothing reads it for any
  // decision. Do not invest in refining it until something actually depends on it.
  const GRAD_SOL_CAP = 85;
  const gradPct = Math.min(100, (realSol / GRAD_SOL_CAP) * 100);
  // 2) GRADUATED CURVES MUST PASS THROUGH UNTOUCHED — checked BEFORE any plausibility bound.
  // On migration pump.fun zeroes the curve reserves, so a graduated account reads vSol 0 /
  // vTokens 0 and any market-cap derived from it is 0/0 = NaN. An earlier version of this guard
  // applied the MC bound first and therefore rejected EVERY graduated curve (verified live on 8
  // real ones: ANSEM, Fartcoin, Pnut, jellyjelly … all complete=true, all rejected). That would
  // have silently killed graduation handling entirely — the caller never sees `complete`, so the
  // position looks unreadable instead of migrated. Graduated state is valid data; the AMM path
  // (Jupiter quote) prices it, not this function.
  if (complete) return { priceSol: 0, complete, vSol, vTokens, realSol, realTokens, gradPct, ...regime };
  if (vTokenReserves === 0n) return { priceSol: 0, complete, vSol, vTokens: 0, realSol, realTokens, gradPct, ...regime };
  // 3) STRUCTURAL BOUNDS ONLY. This used to also reject any market cap below 20 SOL, on the
  // theory that a pump.fun curve always launches at vSol 30 / vTokens 1.073e9 = 27.96 SOL and
  // can only rise, so anything lower had to be a shifted layout. INVESTIGATED 2026-07-26 and
  // that theory was wrong. Sampling 134 live curves found TWO account sizes — 115B and 151B —
  // both owned by the real pump.fun program (6EF8rre…), both with `tokenTotalSupply` landing
  // at offset 40 exactly as expected, i.e. our offsets were never misaligned. The 151B accounts
  // are simply a newer account version (+36 bytes) and are entirely normal: median MC 28.05,
  // 16% of them sit inside our 30-45 entry band — a HIGHER share than the 115B ones.
  //
  // The genuinely sub-20 curves are a real minority (12% of 151B) launched with custom low
  // initial reserves. Rejecting them was a BUSINESS rule wearing a parser's clothes: the gate's
  // entry band already refuses anything under 30 SOL, so the bound blocked no trade we would
  // ever take — it only blinded the observatory dataset to a slice of the market, which biases
  // the counterfactual/shadow analysis that is supposed to tell us whether our filter has edge.
  //
  // So: reject only what cannot be priced at all. Let the gate decide what is worth buying.
  const mcSol = (vSol / vTokens) * 1_000_000_000;
  if (!(vSol > 0 && vTokens > 0) || !isFinite(mcSol) || mcSol <= 0 || mcSol > 1_000_000) {
    curveParse.rejected++; curveParse.lastReason = `unpriceable-mc:${mcSol.toFixed(4)}`;
    return null;
  }
  return { priceSol: vSol / vTokens, complete, vSol, vTokens, realSol, realTokens, gradPct, ...regime };
}

export async function bondingCurvePriceSol(bondingCurveKey: string): Promise<CurveState | null> {
  try {
    const res = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
      bondingCurveKey,
      { encoding: "base64", commitment: "processed" },
    ]);
    return parseBondingCurveAccount(res.value?.data?.[0]);
  } catch {
    return null;
  }
}

/**
 * BATCH read many bonding-curve accounts in ONE getMultipleAccounts RPC (#9). Cuts the
 * per-position serial reads that grow effective tick-age with position count.
 *
 * Chunked at `config.rpcMaxBatch`, NOT at the 100 the Solana spec allows: providers cap this
 * far lower on free tiers (QuickNode's discover plan: 5). Over-sending does not degrade
 * gracefully — the whole batch errors, so every position in that chunk goes unpriced and the
 * endpoint takes a strike it did not deserve.
 *
 * Returns a map key→CurveState (missing/failed keys are absent).
 */
export async function bondingCurvePricesMulti(keys: string[]): Promise<Map<string, CurveState>> {
  const out = new Map<string, CurveState>();
  const uniq = [...new Set(keys.filter(Boolean))];
  // Chunk at what the pool can actually serve RIGHT NOW, not a fixed number. A handful of open
  // positions stays under QuickNode's 5 and keeps its 34ms; a large watchlist sweep chunks at
  // 100 and is routed to a provider that takes it whole, instead of becoming 20 calls.
  const B = Math.max(1, Math.min(maxLiveBatch(), uniq.length));
  for (let i = 0; i < uniq.length; i += B) {
    const chunk = uniq.slice(i, i + B);
    try {
      const res = await rpc<{ value: Array<{ data: [string, string] } | null> }>("getMultipleAccounts", [
        chunk,
        { encoding: "base64", commitment: "processed" },
      ], chunk.length);
      const arr = res.value ?? [];
      for (let j = 0; j < chunk.length; j++) {
        const cs = parseBondingCurveAccount(arr[j]?.data?.[0]);
        if (cs) out.set(chunk[j]!, cs);
      }
    } catch { /* chunk failed → those keys just fall back to per-position reads */ }
  }
  return out;
}

interface SignatureInfo { signature: string }
interface TxMeta {
  meta: {
    preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount: number | null } }>;
    postTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount?: { uiAmount: number | null } }>;
  } | null;
}

export interface DevHistory { buys: number; sells: number; onlyBuys: boolean }

/**
 * Classify the creator's recent transaction history for `mint` into buys vs
 * sells, by diffing the creator's token balance across each transaction.
 * "onlyBuys" (sells === 0, buys ≥ 1) = the dev has only ever accumulated —
 * the strongest conviction signal ("dev yakin market cap naik").
 *
 * Best-effort and bounded (scans the last `limit` signatures); returns null on
 * failure so callers can skip rather than misread. Used at position entry only,
 * not per gate — it costs one getSignatures + up to `limit` getTransaction calls.
 */
/**
 * LAUNCH BUNDLE DETECTION from the INITIAL-BUY TRANSACTIONS (owner spec — not the holder
 * indexer, which lags). Reads the mint's EARLIEST signatures and clusters by SLOT: many buys
 * in the same slot = a coordinated bundle at launch (one entity, many wallets, same block).
 * Bounded (limit sigs) + best-effort so it can run under the entry deadline. Returns the max
 * same-slot buy count and the share of early txs that were bundled.
 */
/**
 * CHEAP bundle probe for the HOT path — ONE getSignaturesForAddress, no getTransaction.
 * The full detectLaunchBundle costs up to 1 signature page + 14 parallel getTransaction
 * (~15 RPC per candidate) and was the single biggest consumer of the entry budget. The
 * signature list already carries `slot`, so the same-slot clustering that drives the
 * SAME_SLOT_BUNDLE toxic verdict can be computed from it directly for 1 RPC.
 *
 * The difference vs the full version is that this counts TRANSACTIONS per slot, not
 * DISTINCT BUYER WALLETS — so it over-counts (one wallet buying twice in a slot looks
 * like two). It is therefore a CONSERVATIVE screen (`verifiedBuys:false`): good enough
 * to veto at entry, and the verified version still runs in the background after open()
 * so the trade record keeps the accurate figure.
 */
export async function launchBundleProbe(mint: string, limit = 40, signal?: AbortSignal): Promise<{ sameSlotMax: number; bundledShare: number; earlyTxs: number; verifiedBuys: boolean } | null> {
  try {
    const page = await rpc<Array<{ signature: string; slot?: number }>>("getSignaturesForAddress", [mint, { limit }], 0, signal);
    if (!page?.length) return null;
    // Newest-first; on a fresh coin (< `limit` lifetime txs) the tail IS the launch window.
    const early = page.slice(-14);
    const slotCount = new Map<number, number>();
    for (const s of early) if (typeof s.slot === "number") slotCount.set(s.slot, (slotCount.get(s.slot) ?? 0) + 1);
    let sameSlotMax = 0, bundled = 0;
    for (const n of slotCount.values()) { if (n > sameSlotMax) sameSlotMax = n; if (n >= 2) bundled += n; }
    return { sameSlotMax, bundledShare: Number((bundled / early.length).toFixed(2)), earlyTxs: early.length, verifiedBuys: false };
  } catch { return null; }
}

export async function detectLaunchBundle(mint: string, pages = 3): Promise<{ sameSlotMax: number; bundledShare: number; earlyTxs: number; verifiedBuys: boolean } | null> {
  try {
    // getSignaturesForAddress is NEWEST-first (audit fix: old code sliced the tail of ONE page,
    // which is NOT the earliest lifetime txs). Paginate with `before` to reach the OLDEST page,
    // which holds the launch-time txs. Bounded to `pages`×1000 to stay under the deadline.
    let before: string | undefined; let last: Array<{ signature: string; slot?: number }> = [];
    for (let p = 0; p < pages; p++) {
      const params: [string, Record<string, unknown>] = [mint, { limit: 1000, ...(before ? { before } : {}) }];
      const page = await rpc<Array<{ signature: string; slot?: number }>>("getSignaturesForAddress", params);
      if (!page?.length) break;
      last = page; before = page[page.length - 1]?.signature;
      if (page.length < 1000) break; // reached the earliest page
    }
    if (!last.length) return null;
    const early = last.slice(-14); // the earliest ~14 txs (launch window) — bounded for the parallel fetch

    // VERIFIED BUNDLE (audit fix): a real bundle is many DISTINCT wallets BUYING in the SAME slot
    // (a Jito bundle), NOT just N txs in a slot. For each early tx we fetch the parsed tx and find
    // the BUYER = the owner whose token balance for THIS mint increased. We then count DISTINCT
    // buyer wallets per slot. Fetched in PARALLEL (bounded) so wall-time ≈ one getTransaction and
    // this still fits the gate deadline. If a tx can't be parsed it's skipped (not counted).
    const buys = await Promise.all(early.map(async (s) => {
      const tx = await rpc<TxMeta>("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]).catch(() => null);
      const meta = tx?.meta; if (!meta) return null;
      // largest positive token-balance delta for THIS mint = the buyer wallet
      const deltas = new Map<string, number>();
      for (const b of meta.postTokenBalances ?? []) if (b.mint === mint && b.owner) deltas.set(b.owner, (b.uiTokenAmount?.uiAmount ?? 0));
      for (const b of meta.preTokenBalances ?? []) if (b.mint === mint && b.owner) deltas.set(b.owner, (deltas.get(b.owner) ?? 0) - (b.uiTokenAmount?.uiAmount ?? 0));
      let buyer: string | null = null, best = 1e-6;
      for (const [owner, d] of deltas) if (d > best) { best = d; buyer = owner; }
      return buyer && typeof s.slot === "number" ? { slot: s.slot, buyer } : null;
    }));

    const verified = buys.filter((b): b is { slot: number; buyer: string } => b != null);
    if (!verified.length) {
      // couldn't verify any buy (parse failures) → fall back to the slot-count PROXY, flagged.
      const slotCount = new Map<number, number>();
      for (const s of early) if (typeof s.slot === "number") slotCount.set(s.slot, (slotCount.get(s.slot) ?? 0) + 1);
      let sameSlotMax = 0, bundled = 0;
      for (const n of slotCount.values()) { if (n > sameSlotMax) sameSlotMax = n; if (n >= 2) bundled += n; }
      return { sameSlotMax, bundledShare: Number((bundled / early.length).toFixed(2)), earlyTxs: early.length, verifiedBuys: false };
    }
    // distinct BUYER wallets per slot (dedupe a wallet buying twice in one slot)
    const slotBuyers = new Map<number, Set<string>>();
    for (const v of verified) { let set = slotBuyers.get(v.slot); if (!set) { set = new Set(); slotBuyers.set(v.slot, set); } set.add(v.buyer); }
    let sameSlotMax = 0, bundled = 0;
    for (const set of slotBuyers.values()) { if (set.size > sameSlotMax) sameSlotMax = set.size; if (set.size >= 2) bundled += set.size; }
    return { sameSlotMax, bundledShare: Number((bundled / verified.length).toFixed(2)), earlyTxs: verified.length, verifiedBuys: true };
  } catch { return null; }
}

/**
 * CREATOR FUNDING LINEAGE (owner/audit fix): who funded the CREATOR wallet's SOL — the correct
 * lineage for actor memory (ruggers rotate creator wallets but keep the same funding parent).
 * This is DISTINCT from early-buyer funders (which the rug-cluster uses). We read the creator's
 * OLDEST signatures and find the source(s) of the earliest incoming SOL transfer. Best-effort,
 * bounded; returns [] on failure (UNKNOWN lineage — honest, never a WRONG attribution).
 */
// A creator's funding lineage is IMMUTABLE history — it can be cached for the process
// lifetime. Ruggers relaunch from the same wallet repeatedly, so this turns a recurring
// 4-RPC read (1 getSignatures + 3 getTransaction) into a map lookup on every repeat.
const funderCache = new Map<string, string[]>();
export function cachedCreatorFunders(creator: string | undefined): string[] | undefined {
  return creator ? funderCache.get(creator) : undefined;
}

export async function creatorFunders(creator: string, limit = 20): Promise<string[]> {
  const hit = funderCache.get(creator);
  if (hit) return hit;
  try {
    // getSignaturesForAddress is newest-first; take the OLDEST in this window (a fresh rugger
    // wallet has few txs, so the oldest here ≈ the funding tx).
    const sigs = await rpc<SignatureInfo[]>("getSignaturesForAddress", [creator, { limit }]);
    if (!sigs?.length) return [];
    const oldest = sigs.slice(-3); // earliest few — the funding is among the first txs
    const funders = new Set<string>();
    for (const s of oldest) {
      const tx = await rpc<{ meta?: { preBalances?: number[]; postBalances?: number[] } | null; transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }> } } }>(
        "getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]
      ).catch(() => null);
      const keys = tx?.transaction?.message?.accountKeys ?? [];
      const pre = tx?.meta?.preBalances ?? [], post = tx?.meta?.postBalances ?? [];
      // find the account whose SOL DECREASED the most (the funder) when the creator's INCREASED
      let creatorIdx = -1, funderIdx = -1, maxDrop = 0;
      keys.forEach((k, i) => { const addr = typeof k === "string" ? k : k.pubkey; if (addr === creator) creatorIdx = i; });
      if (creatorIdx < 0 || (post[creatorIdx] ?? 0) <= (pre[creatorIdx] ?? 0)) continue; // creator didn't receive here
      keys.forEach((k, i) => { const drop = (pre[i] ?? 0) - (post[i] ?? 0); if (drop > maxDrop && i !== creatorIdx) { maxDrop = drop; funderIdx = i; } });
      if (funderIdx >= 0) { const k = keys[funderIdx]; const addr = typeof k === "string" ? k : k?.pubkey; if (addr) funders.add(addr); }
    }
    const out = [...funders];
    if (out.length) funderCache.set(creator, out); // only cache a real answer, never an empty/failed read
    if (funderCache.size > 5_000) funderCache.delete(funderCache.keys().next().value as string); // bound memory
    return out;
  } catch { return []; }
}

export async function devTradeHistory(creator: string, mint: string, limit: number): Promise<DevHistory | null> {
  try {
    const sigs = await rpc<SignatureInfo[]>("getSignaturesForAddress", [creator, { limit }]);
    let buys = 0;
    let sells = 0;
    const EPS = 1e-6;
    for (const s of sigs) {
      const tx = await rpc<TxMeta>("getTransaction", [
        s.signature,
        { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" },
      ]).catch(() => null);
      const meta = tx?.meta;
      if (!meta) continue;
      const pre = meta.preTokenBalances?.find((b) => b.owner === creator && b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
      const post = meta.postTokenBalances?.find((b) => b.owner === creator && b.mint === mint)?.uiTokenAmount?.uiAmount ?? 0;
      const delta = post - pre;
      if (delta > EPS) buys++;
      else if (delta < -EPS) sells++;
    }
    return { buys, sells, onlyBuys: sells === 0 && buys >= 1 };
  } catch {
    return null;
  }
}
