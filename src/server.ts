import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, existsSync, mkdirSync, watch, statSync, openSync, readSync, closeSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { config, configHash } from "./config.js";
import { readControl, writeControl } from "./control.js";
import { summarizeTraces } from "./robinhood/mark-trace.js";
import { botPubkey, balanceSol, withdrawSol } from "./execution/wallet.js";
import { applyExecutionRealism } from "./execution/exec-realism.js";
import { gmgnTokenInfo } from "./discovery/gmgn.js";
import { solPriceUsd } from "./execution/jupiter.js";
import { guardStatus, halt, resume } from "./execution/guardian.js";
import { acknowledgeDeposit, bridgeStatus } from "./execution/live-bridge.js";
import { poolBalanceSol, poolLatestBlockhashFull } from "./execution/rpc.js";
import {
  OKX_ENDPOINTS, okxCredentialWarnings, okxLeaderboardWalletTypeCodes,
  okxLeaderboardWalletTypeLabel, type OkxEndpointSpec,
} from "./discovery/okx.js";
import { verifyStrictLedger } from "./discovery/okx-strict-ledger.js";
import { fetchCandles } from "./chart-data.js";
import { strictPaperReport } from "./okx-strict-paper-report.js";
import { inspectRobinhoodToken, searchRobinhoodTokens } from "./robinhood/intelligence.js";

/**
 * The dashboard (this process) now runs standalone from the sniper (src/index.ts) — the two
 * used to be bundled together by start.ts's watchdog, so "the dashboard is up" and "the sniper
 * is scanning" were always the same fact. They no longer are (e.g. sniper archived/stopped while
 * Strategy 2 research continues). The frontend's "FEED LIVE" pill and pipeline counters were
 * hardcoded to always show live/streaming regardless of the source process's actual state —
 * misleading once the two can diverge. This gives the frontend ground truth to react to instead.
 * Cheap-cached: pgrep is a real subprocess spawn, no need to pay that cost on every poll tick.
 */
let sniperAliveCache: { at: number; alive: boolean } = { at: 0, alive: false };
function sniperAlive(): boolean {
  if (Date.now() - sniperAliveCache.at < 5_000) return sniperAliveCache.alive;
  let alive = false;
  try {
    // Bracket trick (audit re-check, 2026-07-29): pgrep -f matches its own invoking command line
    // too on some systems — "[s]rc/index.ts" as a regex matches a REAL process's literal
    // "src/index.ts", but never matches this shell's own argv (which literally contains the
    // bracketed string, not the unbracketed one). Cheap, standard, applied even though a direct
    // reproduction attempt on this machine's pgrep didn't show the false-positive.
    execSync("pgrep -f '[s]rc/index.ts'", { stdio: ["ignore", "pipe", "ignore"] });
    alive = true;
  } catch {
    alive = false;
  }
  sniperAliveCache = { at: Date.now(), alive };
  return alive;
}

// Same pattern, for Strategy 2's paper trader — now the dashboard's PRIMARY strategy (owner,
// 2026-07-29), so the hero's "FEED LIVE"/"Pipeline · live" badges should track ITS process, not
// the (now archived) sniper's.
let strategy2AliveCache: { at: number; alive: boolean } = { at: 0, alive: false };
function strategy2Alive(): boolean {
  if (Date.now() - strategy2AliveCache.at < 5_000) return strategy2AliveCache.alive;
  // Audit fix (2026-07-29): this only checked the paper trader — the scout (candidate discovery)
  // could die silently while the paper trader kept running on whatever it already had, and the
  // dashboard would still show "FEED LIVE". Both processes have to be up for "live" to be honest.
  let alive = false;
  try {
    execSync("pgrep -f '[s]rc/discovery/strategy2-papertrader.ts'", { stdio: ["ignore", "pipe", "ignore"] });
    execSync("pgrep -f '[s]rc/discovery/strategy2-scout.ts'", { stdio: ["ignore", "pipe", "ignore"] });
    alive = true;
  } catch {
    alive = false;
  }
  strategy2AliveCache = { at: Date.now(), alive };
  return alive;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// React+shadcn rewrite (2026-07-29): the dashboard's 3 pages (landing/login/app) are now built
// by Vite into web/dist/*.html + web/dist/assets/* (hashed filenames), replacing the old
// hand-written public/*.html (archived, not deleted, at public/_archive-pre-react/ for rollback).
const WEB_DIST = join(__dirname, "..", "web", "dist");
const PORT = Number(process.env.DASHBOARD_PORT ?? 4317);
const PASSWORD = process.env.DASHBOARD_PASSWORD?.trim() || "shitcoin";
const COOKIE = "shitcoin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
// Bind to loopback by default. A VPS binding 0.0.0.0 puts this console — which can flatten
// positions and withdraw SOL — on the public internet. Expose it through Cloudflare Tunnel or an
// SSH tunnel instead, which needs no open port. Override deliberately with DASHBOARD_HOST.
const HOST = process.env.DASHBOARD_HOST?.trim() || "127.0.0.1";
const PUBLIC_BIND = HOST !== "127.0.0.1" && HOST !== "localhost";

// Refuse to serve the default password on a public interface. This console can move real money
// (withdraw endpoint) — a guessable password on 0.0.0.0 is not a warning, it is an open door.
if (PUBLIC_BIND && PASSWORD === "shitcoin") {
  console.error("\n  ✗ REFUSING TO START: DASHBOARD_HOST is public but DASHBOARD_PASSWORD is still the default.");
  console.error("    Set a strong DASHBOARD_PASSWORD in .env, or leave DASHBOARD_HOST unset to bind loopback only.\n");
  process.exit(1);
}

// Login throttle. Without it the password is brute-forceable at network speed; sessions live in
// memory, so an attacker only needs to guess once. Per-IP, exponential lockout.
const loginFails = new Map<string, { n: number; until: number }>();
function loginBlocked(ip: string): number {
  const f = loginFails.get(ip);
  if (!f || Date.now() > f.until) return 0;
  return Math.ceil((f.until - Date.now()) / 1000);
}
function noteLoginFail(ip: string): void {
  const f = loginFails.get(ip) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60_000, 2 ** (f.n - 5) * 5_000); // 5s → 15m
  loginFails.set(ip, f);
  if (loginFails.size > 1_000) for (const [k, v] of loginFails) if (Date.now() > v.until) loginFails.delete(k);
}
const clientIp = (req: IncomingMessage): string =>
  // Cloudflare/proxy-aware, falling back to the socket address.
  (req.headers["cf-connecting-ip"] as string) ||
  (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
  req.socket.remoteAddress || "?";

// ── In-memory session store (single-process; dev-grade auth, not a bank) ──────
const sessions = new Map<string, number>(); // token -> expiry epoch ms
function newSession(): string {
  const token = randomBytes(24).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function isAuthed(req: IncomingMessage): boolean {
  const raw = req.headers.cookie ?? "";
  const match = raw.split(";").map((c) => c.trim()).find((c) => c.startsWith(COOKIE + "="));
  if (!match) return false;
  const token = match.slice(COOKIE.length + 1);
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

// ── Log aggregation — INCREMENTAL (reads only what was appended) ─────────────
// The old readStream() re-read and re-parsed EVERY matching file in full on every call, and
// buildStats() calls it six times. With an SSE broadcast fired by fs.watch on any log write,
// that meant re-parsing ~45 MB (decisions 18 MB + events 13 MB + the rest) several times a
// second — the dashboard's real performance problem. Now each line is parsed exactly once:
// per-file byte cursors read only the appended tail, with the trailing partial line carried
// over so a half-written record is never dropped or double-counted.
type Row = Record<string, unknown>;
const cursors = new Map<string, number>(); // absolute path -> bytes already consumed
const partials = new Map<string, string>(); // absolute path -> trailing incomplete line

/** Feed every NEW row appended to `prefix*.jsonl` since the last call into `onRow`. */
function tailStream(prefix: string, onRow: (r: Row) => void): void {
  if (!existsSync(config.logDir)) return;
  const files = readdirSync(config.logDir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort();
  for (const f of files) {
    const p = join(config.logDir, f);
    let size: number;
    try { size = statSync(p).size; } catch { continue; }
    const from = cursors.get(p) ?? 0;
    if (size === from) continue;
    // A file that SHRANK was rotated/truncated (e.g. npm run reset) — restart it from zero.
    const start = size < from ? 0 : from;
    if (size < from) partials.delete(p);
    let chunk: string;
    try {
      const fd = openSync(p, "r");
      try {
        const buf = Buffer.allocUnsafe(size - start);
        readSync(fd, buf, 0, buf.length, start);
        chunk = buf.toString("utf8");
      } finally { closeSync(fd); }
    } catch { continue; }
    cursors.set(p, size);
    const text = (partials.get(p) ?? "") + chunk;
    const lines = text.split("\n");
    partials.set(p, lines.pop() ?? ""); // last element is either "" or an incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onRow(JSON.parse(line) as Row); } catch { /* skip malformed */ }
    }
  }
}

/** Bounded ring of the most recent N rows — for "recent activity" panels. */
class Ring<T> {
  private buf: T[] = [];
  constructor(private readonly max: number) {}
  push(v: T): void { this.buf.push(v); if (this.buf.length > this.max) this.buf.shift(); }
  last(n: number): T[] { return this.buf.slice(-n); }
  all(): T[] { return this.buf; }
}
interface GateCheck { name: string; passed: boolean; hard: boolean; detail: string }
interface Decision { ts: string; candidate: { mint: string; symbol?: string; mode: string; source: string; holders?: number; marketCapUsd?: number; creator?: string }; gate: { verdict: "PASS" | "REJECT"; checks: GateCheck[]; score: number }; action: string }
interface Trade { ts: string; action: "OPEN" | "CLOSE" | "PARTIAL" | "RESET"; mint: string; symbol?: string; mode?: string; reason?: string; pnlPct?: number; grossPnlPct?: number; costPct?: number; pnlSol?: number; tradePnlSol?: number; sizeSol?: number; heldSec?: number; price?: number; devOnlyBuys?: boolean; run?: number; finalSol?: number }
interface RunRec { ts: string; run?: number; reason?: string; trades?: number; wins?: number; losses?: number; startSol?: number; finalSol?: number; pnlSol?: number; minSol?: number }
interface PersistedPos { candidate: { symbol?: string; mode?: string; mint?: string; creator?: string; holders?: number; marketCapUsd?: number; marketCapSol?: number }; entryPriceUsd?: number; lastPriceUsd?: number; lastPnlPct?: number; peakPriceUsd?: number; openedAt?: number; armed?: boolean; graduated?: boolean; partialsTaken?: number; devOnlyBuys?: boolean; devBuyBack?: boolean }

const SERVER_START = Date.now();

// ── INCREMENTAL STORE ────────────────────────────────────────────────────────
// The two huge streams (decisions, events) are folded into counters + bounded rings as their
// lines arrive, so nothing scales with total log size. The small streams are kept in full
// because the equity curve, run partitioning and analytics genuinely need every row — but
// they too are parsed only once each.
type DecisionRow = { ts?: string; candidate?: { mint?: string; symbol?: string; mode?: string; source?: string; holders?: number; marketCapUsd?: number }; gate?: { verdict?: string; checks?: GateCheck[]; score?: number }; action?: string };
const CLOSE_WINDOW_MAX = 400; // payload bound only — the real span is decided by ledger continuity

interface OkxAggregate {
  total: number;
  priced: number;
  wins: number;
  sumPct: number;
  /** Two heaps give an exact streaming median without sorting the entire 7-day log on every
   * dashboard refresh. lower is a max-heap, upper a min-heap. */
  lower: number[];
  upper: number[];
}

function okxHeapPush(heap: number[], value: number, before: (a: number, b: number) => boolean): void {
  heap.push(value);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = Math.floor((i - 1) / 2);
    if (!before(heap[i]!, heap[parent]!)) break;
    [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
    i = parent;
  }
}

function okxHeapPop(heap: number[], before: (a: number, b: number) => boolean): number | null {
  if (heap.length === 0) return null;
  const root = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return root;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const left = i * 2 + 1, right = left + 1;
    let best = i;
    if (left < heap.length && before(heap[left]!, heap[best]!)) best = left;
    if (right < heap.length && before(heap[right]!, heap[best]!)) best = right;
    if (best === i) break;
    [heap[i], heap[best]] = [heap[best]!, heap[i]!];
    i = best;
  }
  return root;
}

const okxMaxBefore = (a: number, b: number): boolean => a > b;
const okxMinBefore = (a: number, b: number): boolean => a < b;
function okxMedianAdd(aggregate: OkxAggregate, value: number): void {
  if (aggregate.lower.length === 0 || value <= aggregate.lower[0]!) okxHeapPush(aggregate.lower, value, okxMaxBefore);
  else okxHeapPush(aggregate.upper, value, okxMinBefore);
  if (aggregate.lower.length > aggregate.upper.length + 1) {
    const moved = okxHeapPop(aggregate.lower, okxMaxBefore);
    if (moved != null) okxHeapPush(aggregate.upper, moved, okxMinBefore);
  } else if (aggregate.upper.length > aggregate.lower.length) {
    const moved = okxHeapPop(aggregate.upper, okxMinBefore);
    if (moved != null) okxHeapPush(aggregate.lower, moved, okxMaxBefore);
  }
}

const STORE = {
  decisions: {
    total: 0, passed: 0, rejected: 0, bought: 0,
    byMode: {} as Record<string, number>,
    rejectionReasons: {} as Record<string, number>,
    setupToxicCodes: {} as Record<string, number>,
    recent: new Ring<DecisionRow>(80),
    lastAt: 0,
    // BAND WATCH — two different market caps, and picking the wrong one draws a false picture.
    //
    // A decision record carries `candidate.marketCapSol`, the curve at DETECTION. The entry band
    // is enforced ~15s later on `curveMcSol`, the curve at EXECUTION, and in that gap a coin
    // routinely doubles: today's entries were detected at a median 33.8 and bought at a median
    // 66.5. Plotting detection MC against the band made it look like the bot was buying 28-45
    // while configured for 55-100 — it was not, 51 of 51 entries landed inside the window.
    //
    // So entries are plotted on the number the gate actually tests, and launches are kept as a
    // separate dim cloud showing where coins are BORN (27.96 for every pump.fun curve, by
    // construction) — the distance between the two is the panel's whole point.
    bandEntries: new Ring<{ ts: string; mint?: string; sym: string; mcSol: number }>(60),
    bandLaunch: new Ring<number>(240),
  },
  events: {
    counts: {} as Record<string, number>, // every event type, counted — LIFETIME, across every log file
    /**
     * Raw launch points for the Hero's live-market visual: {ts, marketCapSol} only.
     *
     * STORE.events is otherwise a pure aggregate (counters, no rows), so there was nowhere to
     * read individual launches from — an earlier attempt iterated STORE.events directly and
     * crashed the dashboard with "STORE.events is not iterable". A small ring filled here, in
     * the same single pass the tail reader already makes, keeps that promise: each line is
     * parsed exactly once and nothing re-reads the 13 MB event log.
     */
    launches: new Ring<{ ts: string; mc: number }>(500),
    skipReasons: {} as Record<string, number>,
    lastLaunchAt: 0,
    exitReasonsAll: {} as Record<string, number>,   // lifetime, to match the lifetime entry count
    opensAll: 0,
    closesAll: 0,
    // Set, not a counter: the scout re-logs a candidate on every poll it is still trending, so a
    // raw count would report how CHATTY a feed is, not how many coins it actually brought in.
    sourceMints: {} as Record<string, Set<string>>,
    // Gate rejections scoped to the CURRENT epoch only (2026-07-31). `counts` above is a
    // lifetime tally across every events-*.jsonl on disk, which is fine for "has this ever
    // happened" but wrong for a funnel: the first version of the admission panel compared 2,227
    // cost rejections logged on 2026-07-29 under an older config against 19 entries taken today,
    // producing a pass rate that described no cohort that ever existed. Every rejection event
    // carries its own strategy2Epoch, so this counts only the ones belonging to the epoch the
    // trader is actually running — the same rule freshCandidates() already applies to candidates.
    gateRejectionsEpoch: {} as Record<string, number>,
    /** Entries ACCEPTED in the current epoch — the numerator that matches gateRejectionsEpoch. */
    opensEpoch: 0,
    execSim: new Ring<Record<string, unknown>>(40),
    vibe: new Ring<Record<string, unknown>>(40),
    devnet: new Ring<Record<string, unknown>>(20),
    momentum: new Ring<Record<string, unknown>>(20),
    lateToxic: new Ring<Record<string, unknown>>(20),
    latency: new Ring<{ preMs?: number; gateMs?: number; openMs?: number; totalMs?: number }>(200),
    execLadder: { theoretical: 0, "tx-built": 0, unavailable: 0, "would-fail": 0, executable: 0 } as Record<string, number>,
    integrity: null as Record<string, unknown> | null, // newest ledger-reconciliation result
    // OKX Web3 dashboard data. These are folded from the local JSONL stream in the SAME pass as
    // the rest of the dashboard, so opening /api/okx/overview never spends OKX API quota.
    okx: {
      signalCount: 0,
      copyCount: 0,
      candidateCount: 0,
      recentSignals: new Ring<Row>(30),
      recentCopies: new Ring<Row>(30),
      recentCandidates: new Ring<Row>(30),
      recentObservations: new Ring<Row>(30),
      recentStudyOutcomes: new Ring<Row>(30),
      observationAgg: {} as Record<string, OkxAggregate>,
      studyAgg: {} as Record<string, OkxAggregate>,
      laneStatus: null as Row | null,
      studyStatus: null as Row | null,
      radarSweep: null as Row | null,
      radarSelection: null as Row | null,
      lastEventAt: null as string | null,
    },
  },
  trades: [] as Row[],
  patterns: [] as Row[],
  postExit: [] as Row[],
  runLedger: [] as Row[],
  // STRATEGY 2 SCOUT — separate process (src/discovery/strategy2-scout.ts), zero capital, zero
  // interaction with the sniper. Keyed by mint so each poll's snapshot REPLACES the previous one
  // for that mint (we want current state per candidate, not 30 duplicate rows piling up forever).
  strategy2: new Map<string, Row>(),
  // Strategy 2 promoted to dashboard primary (owner, 2026-07-29): the paper trader's own
  // open/close events, replayed in arrival order, are the only source for a real equity curve
  // and trade journal — strategy2-paper-state.json only ever holds the CURRENT snapshot.
  /** Closes keyed by mint — last write wins, so the derived views can never double-count. */
  strategy2ClosesByMint: new Map<string, Record<string, unknown>>(),
  // Audit fix (2026-07-29): "pisahkan gmgn-trending dan gmgn-trenches jadi arm berbeda" — per
  // source (entrySource, stamped at entry) running totals, built incrementally as close events
  // arrive rather than re-scanning the trade log per dashboard request. Different sources
  // (mid-cap trending vs trenches vs any future lane) have measurably different outcome
  // characteristics and were previously only distinguishable by manually filtering raw logs.
};

/** Pull in everything appended since the last refresh. Cheap and idempotent. */
function refreshStore(): void {
  const D = STORE.decisions, E = STORE.events;
  tailStream("decisions", (r0) => {
    const r = r0 as DecisionRow;
    D.total++;
    const v = r.gate?.verdict;
    if (v === "PASS") D.passed++; else if (v === "REJECT") D.rejected++;
    D.lastAt = Date.now();
    if (r.action === "PAPER_BUY") D.bought++;
    {
      const c = (r.candidate ?? {}) as { mint?: string; symbol?: string; marketCapSol?: number };
      if (typeof c.marketCapSol === "number" && c.marketCapSol > 0) {
        D.bandLaunch.push(c.marketCapSol);
      }
    }
    const m = r.candidate?.mode; if (m) D.byMode[m] = (D.byMode[m] ?? 0) + 1;
    for (const c of r.gate?.checks ?? []) {
      if (!c.hard || c.passed) continue;
      D.rejectionReasons[c.name] = (D.rejectionReasons[c.name] ?? 0) + 1;
      if (c.name === "setup-toxic") for (const code of String(c.detail ?? "").split(",")) {
        const k = code.trim(); if (k) D.setupToxicCodes[k] = (D.setupToxicCodes[k] ?? 0) + 1;
      }
    }
    D.recent.push(r);
  });
  tailStream("events", (r) => {
    const t = String(r["type"] ?? "?");
    E.counts[t] = (E.counts[t] ?? 0) + 1;

    // OKX product view — local log projection only. Source events are counted once here;
    // observation-open/settlement rows are deliberately NOT counted as another signal.
    const O = E.okx;
    if (t.startsWith("okx-") && typeof r["ts"] === "string") O.lastEventAt = r["ts"] as string;
    const okxData = r["data"] && typeof r["data"] === "object" ? r["data"] as Row : null;
    const okxChannel = String(r["channel"] ?? "");
    const okxSide = String(okxData?.["tradeType"] ?? okxData?.["side"] ?? okxData?.["direction"] ?? "").toLowerCase();
    const isBuy = !okxSide || okxSide.includes("buy") || okxSide === "1";
    if (t === "okx-rest-signal" || (t === "okx-ws-event" && (okxChannel === "dex-market-new-signal-openapi" || okxChannel === "kol_smartmoney-tracker-activity"))) {
      O.signalCount++;
      O.recentSignals.push(r);
    }
    if (t === "okx-rest-copy" || (t === "okx-ws-event" && okxChannel === "address-tracker-activity" && isBuy)) {
      O.copyCount++;
      O.recentCopies.push(r);
    }
    if (t === "okx-candidate") {
      O.candidateCount++;
      O.recentCandidates.push(r);
    }
    if (t === "okx-observation") {
      const kind = String(r["kind"] ?? "signal");
      const horizon = Number(r["horizonSec"]);
      if (Number.isFinite(horizon) && horizon > 0) {
        const key = `${kind}:${horizon}`;
        const a = O.observationAgg[key] ??= { total: 0, priced: 0, wins: 0, sumPct: 0, lower: [], upper: [] };
        a.total++;
        const pct = typeof r["pctChange"] === "number" && Number.isFinite(r["pctChange"]) ? r["pctChange"] as number : null;
        if (pct != null) { a.priced++; a.sumPct += pct; okxMedianAdd(a, pct); if (pct > 0) a.wins++; }
      }
      O.recentObservations.push(r);
    }
    if (t === "okx-outcome") {
      const verdict = String(r["verdict"] ?? "UNKNOWN");
      const horizon = Number(r["horizonSec"]);
      if (Number.isFinite(horizon) && horizon > 0) {
        const key = `${verdict}:${horizon}`;
        const a = O.studyAgg[key] ??= { total: 0, priced: 0, wins: 0, sumPct: 0, lower: [], upper: [] };
        a.total++;
        const pct = typeof r["pctChange"] === "number" && Number.isFinite(r["pctChange"]) ? r["pctChange"] as number : null;
        if (pct != null) { a.priced++; a.sumPct += pct; okxMedianAdd(a, pct); if (pct > 0) a.wins++; }
      }
      O.recentStudyOutcomes.push(r);
    }
    if (t === "okx-lane-status") O.laneStatus = r;
    else if (t === "okx-study-status") O.studyStatus = r;
    else if (t === "okx-radar-sweep") O.radarSweep = r;
    else if (t === "okx-radar-selection") O.radarSelection = r;

    if (t.startsWith("strategy2-") && t.endsWith("-rejected") && r["strategy2Epoch"] === config.strategy2Epoch) {
      E.gateRejectionsEpoch[t] = (E.gateRejectionsEpoch[t] ?? 0) + 1;
    }
    if (t === "strategy2-paper-open" && r["strategy2Epoch"] === config.strategy2Epoch) E.opensEpoch++;
    // PIPELINE PANEL — the funnel's shape needs two things nothing else was counting: why the
    // sniper walked away, and which feed a candidate arrived on. Accumulated here rather than
    // re-scanned per request; the panel repaints ~1.3x/s.
    if (t === "no-demand-skip") {
      const why = String(r["reason"] ?? "?");
      E.skipReasons[why] = (E.skipReasons[why] ?? 0) + 1;
    }
    if (t === "strategy2-candidate" && r["mint"]) {
      const src = String(r["source"] ?? "?");
      (E.sourceMints[src] ??= new Set<string>()).add(String(r["mint"]));
    }
    if (t === "launch") E.lastLaunchAt = Date.now();
    if (t === "launch" && typeof r["marketCapSol"] === "number" && typeof r["ts"] === "string") {
      E.launches.push({ ts: r["ts"] as string, mc: r["marketCapSol"] as number });
    }
    if (t === "exec-sim") {
      E.execSim.push(r);
      const stage = String(r["stage"] ?? (!r["built"] ? "theoretical" : r["needsFunding"] ? "tx-built" : r["wouldLand"] ? "executable" : "would-fail"));
      E.execLadder[stage] = (E.execLadder[stage] ?? 0) + 1;
    } else if (t === "vibe") E.vibe.push(r);
    else if (t === "devnet-exec") E.devnet.push(r);
    else if (t === "momentum-confirm") E.momentum.push(r);
    else if (t === "late-toxic") E.lateToxic.push(r);
    else if (t === "latency-breakdown") E.latency.push(r as { preMs?: number; gateMs?: number; openMs?: number; totalMs?: number });
    else if (t === "data-integrity") E.integrity = r; // keep only the newest audit result
    // Audit fix (2026-07-29, re-audit): the scout CANDIDATE panel is filtered to the CURRENT
    // config.strategy2Epoch on purpose — a stale candidate scored under an old thesis/formula
    // shouldn't linger in a "what's being watched right now" view.
    else if (t === "strategy2-candidate" && r["mint"] && r["strategy2Epoch"] === config.strategy2Epoch) STORE.strategy2.set(String(r["mint"]), r);
    // UI-stuck bug fix (2026-07-29, found live): a CLOSE event carries the epoch the position was
    // OPENED under (pos.openedEpoch), not the live epoch at close time — by design, so the record
    // describes the cohort it actually belongs to. But epochs get bumped every time a Strategy 2
    // parameter or file changes (many times in one day during active work), so any position that
    // stayed open across a bump would close with an OLDER epoch tag than the current live one.
    // The previous "only admit current-epoch rows" filter silently dropped every one of those —
    // confirmed live: wins/losses kept climbing (34/127) while the journal/equity curve stayed
    // frozen on a trade from over an hour earlier, because every closing position had been opened
    // one or more epoch-bumps ago. A CLOSE is a real, immutable historical fact regardless of
    // which epoch tag it carries — the journal/equity curve are a live "what just happened" feed,
    // not a cohort-isolated statistic, so they now admit every close. Cohort isolation for
    // STATISTICAL analysis (e.g. "what's this specific config's win rate") belongs in
    // /api/analytics's own ?cfg= filtering, not in what the live dashboard can even display.
    else if (t === "strategy2-paper-close") {
      // NOT epoch-filtered — deliberately, and this was re-learned the hard way. An epoch filter
      // here was tried before, froze the journal and equity curve for over an hour (positions
      // routinely close under an OLDER epoch tag than the live one, because epochs get bumped
      // whenever a parameter changes), and was removed with that reasoning recorded directly
      // above. It was then reintroduced during this audit without reading that note, which would
      // have reproduced the same freeze.
      //
      // The real defect the audit found was different: the panels disagreed because they used
      // DIFFERENT windows — a lifetime per-source total (-$1,317.90 over 240 trades) sat beside a
      // headline describing the current bankroll (-$215.53), and the equity curve spliced in a
      // manual recapitalisation ($0.70 → $1,000) as if it were a recovery. The fix is one shared
      // RECENT window for every derived view (see CLOSE_WINDOW), not cohort filtering: it never
      // freezes, it never splices a reset, and every number on the panel describes the same span.
      // ONE CLOSE PER POSITION. A position can only be closed once, so a second close row for the
      // same mint in the same epoch is a bookkeeping artifact, not a trade — and it corrupts every
      // aggregate downstream. Found by reconciling the epoch by hand: EMOJI carried two closes
      // (+$8.00 then +$11.72), which is why the epoch showed 12 closes against 11 opens and why
      // `epochStart + Σ pnl` overshot the real equity by exactly $8.01. The duplicate came from a
      // state-save race during downtime-reconciliation testing (since fixed), but the log keeps
      // the row forever, and any future crash mid-write could produce another. The state file is
      // the authority on equity; this keeps the derived views agreeing with it.
      // Keyed by mint, LAST write wins. Dropping the duplicate instead was tried and left $3.71
      // unexplained: EMOJI's two rows were +$8.00 then +$11.72, and it is the SECOND that the
      // state file actually applied, so keeping the first preserved a number the bankroll never
      // saw. Storing by key rather than appending also makes this idempotent by construction —
      // re-reading the same log can no longer double-count anything.
      const closeKey = String(r["mint"] ?? `${r["ts"]}`);
      STORE.strategy2ClosesByMint.set(closeKey, r);
      const ts = typeof r["ts"] === "string" ? Date.parse(r["ts"] as string) : Date.now();
      void ts;
      // Epoch-scoped, like every other Strategy 2 series. Unscoped, this spliced a manual
      // recapitalisation into the middle of the curve: equity fell to $0.70, the float was reset
      // to $1,000, and the chart rendered that as a near-vertical recovery the strategy never
      // earned — with a y-range of 0.70-1045.24 flattening the part that actually matters. A
      // reset is a change of experiment, not a trade, so the curve starts again with it.
    }
  });
  tailStream("paper-trades", (r) => {
    STORE.trades.push(r);
    if (r["action"] === "OPEN" && typeof r["curveMcSol"] === "number") {
      STORE.decisions.bandEntries.push({
        ts: String(r["ts"] ?? ""), mint: r["mint"] as string | undefined,
        sym: String(r["symbol"] ?? "?"), mcSol: r["curveMcSol"] as number,
      });
    }
    // PIPELINE PANEL — exit reasons over the SAME window as its entry count.
    //
    // The panel used to draw `funnel.bought` (2,403 — every PAPER_BUY decision in the whole log
    // history) above an exit row of 290 (the current run only), so the picture said 2,470 went in
    // and 290 came out, with 2,180 unaccounted for. Both halves were individually true and the
    // drawing was still a lie, because they were counted over different spans of time.
    if (r["action"] === "CLOSE") {
      const why = String(r["reason"] ?? "?");
      E.exitReasonsAll[why] = (E.exitReasonsAll[why] ?? 0) + 1;
      E.closesAll++;
    } else if (r["action"] === "OPEN") E.opensAll++;
  });
  tailStream("patterns", (r) => STORE.patterns.push(r));
  tailStream("post-exit", (r) => { if (r["type"] === "summary") STORE.postExit.push(r); }); // samples are noise here
  tailStream("run-ledger", (r) => STORE.runLedger.push(r));
}

/** Live RPC budget written by the trader process (separate process → file handoff). */
function rpcHealth(): Record<string, unknown> | null {
  try {
    const h = JSON.parse(readFileSync(join(config.logDir, "rpc-health.json"), "utf8")) as Record<string, unknown>;
    const at = typeof h.at === "number" ? h.at : 0;
    return { ...h, stale: Date.now() - at > 30_000 }; // trader down / not reporting
  } catch { return null; }
}

interface Strategy2PaperStats {
  startingFloatUsd: number; equityUsd: number; pnlUsd: number; pnlPct: number;
  wins: number; losses: number; winRate: number;
  /**
   * Seconds since the trader last completed a poll, or null if it has never written a heartbeat.
   *
   * Added after a real 20-hour blackout (owner shut the machine down; every process stopped and
   * nothing said so). The dashboard kept rendering the last known equity and open position as if
   * they were current, and the position it showed at +0.1% was in fact drifting unattended to
   * -43%. A stale number that looks live is worse than no number — same failure as the stale
   * market caps and the frozen agent face. This is the ground truth the UI needs to say "these
   * figures are not moving".
   */
  heartbeatAgeSec: number | null;
  openPositions: Array<{ mint: string; sym: string; entryCostUsd: number; unrealizedPct: number; heldHours: number; mcUsd: number; holders: number | null; source: string; peakPct: number; fromPeakPct: number }>;
}

/**
 * Strategy-2 paper trader's live equity (USD, separate process → file handoff, same pattern as
 * rpcHealth above). Owner: "pisahkan tampilan saldo semua biar tau paling profit paling
 * powerfull mana" — this is what lets the dashboard show Sniper (SOL) vs Strategy-2 (USD)
 * side by side instead of only ever showing the sniper's numbers.
 */
function strategy2PaperStats(): Strategy2PaperStats | null {
  try {
    const s = JSON.parse(readFileSync(join(config.logDir, "strategy2-paper-state.json"), "utf8")) as {
      equityUsd: number; wins: number; losses: number;
      positions: Record<string, { sym: string; entryCostUsd: number; entryMcUsd: number; currentMcUsd?: number; peakMcUsd: number; openedAt: number; entryHolders?: number; entrySource?: string }>;
      lastHeartbeatAt?: number;
    };
    const startingFloatUsd = config.strategy2Paper.startingFloatUsd;
    const pnlUsd = s.equityUsd - startingFloatUsd;
    return {
      startingFloatUsd, equityUsd: s.equityUsd, pnlUsd: Number(pnlUsd.toFixed(2)),
      pnlPct: Number(((pnlUsd / startingFloatUsd) * 100).toFixed(2)),
      wins: s.wins, losses: s.losses, winRate: (s.wins + s.losses) ? s.wins / (s.wins + s.losses) : 0,
      heartbeatAgeSec: s.lastHeartbeatAt ? Math.round((Date.now() - s.lastHeartbeatAt) / 1000) : null,
      openPositions: Object.entries(s.positions ?? {}).map(([mint, p]) => ({
        mint, sym: p.sym, entryCostUsd: p.entryCostUsd,
        unrealizedPct: Number(((((p.currentMcUsd ?? p.entryMcUsd) - p.entryMcUsd) / p.entryMcUsd) * 100).toFixed(1)),
        heldHours: Number(((Date.now() - p.openedAt) / 3_600_000).toFixed(1)),
        // FIXED (2026-07-29): these were never plumbed through at all — the dashboard showed
        // "MC —"/"holders —" on every Strategy 2 position even though holders>=50 is a real
        // admission requirement (freshCandidates()) the position already cleared to get bought.
        mcUsd: p.currentMcUsd ?? p.entryMcUsd, holders: p.entryHolders ?? null, // null (not 0) for positions opened before this field existed — "unknown", not "zero holders"
        source: p.entrySource ?? "unknown",
        // High-water mark, in the same unit the trail is measured in. `peakMcUsd` is already
        // tracked by the trader for exactly this rule — it just never left the process.
        peakPct: p.entryMcUsd > 0 ? Number((((p.peakMcUsd || p.entryMcUsd) / p.entryMcUsd - 1) * 100).toFixed(1)) : 0,
        fromPeakPct: (p.peakMcUsd || 0) > 0 ? Number((((p.currentMcUsd ?? p.entryMcUsd) / p.peakMcUsd - 1) * 100).toFixed(1)) : 0,
      })),
    };
  } catch { return null; }
}

/**
 * Strategy 2 promoted to dashboard PRIMARY (owner, 2026-07-29): the hero P&L, equity curve,
 * pipeline funnel, trade journal and open-positions panels used to read exclusively from the
 * sniper's `paper`/`funnel`/`totals`/`recentTrades`. This builds the same shapes from Strategy 2's
 * own data (USD, not SOL) so the frontend can point its hero bindings here instead — the sniper's
 * own analytics (buildStats/buildAnalytics) are untouched, just no longer the default view.
 */
function buildStrategy2Primary() {
  const s2 = strategy2PaperStats();
  if (!s2) return null;
  // ONE shared span for every derived view — the equity curve, the journal, the exit-quality
  // tally and the per-source table — chosen by a rule that VERIFIES ITSELF rather than by a
  // guessed length.
  //
  // A closed trade must satisfy `equityAfter[i] === equityAfter[i-1] + pnl[i]`. A manual
  // recapitalisation breaks that invariant, and so does any duplicated or missing row. So this
  // walks BACKWARDS from the newest close for as long as the ledger reconciles, and stops at the
  // first break. What survives is the longest continuous, self-consistent run of trading ending
  // at the present bankroll.
  //
  // A fixed window was tried first and was wrong twice: 120 closes reached back past the
  // $0.70 → $1,000 reset, so the curve again drew a vertical "recovery" the strategy never earned
  // and the per-source total (-$847.85) disagreed with the curve by $1,069 — almost exactly the
  // reset. Any constant is a guess about how far back the last reset was; this is not.
  const allCloses = [...STORE.strategy2ClosesByMint.values()]
    .sort((a, b) => String(a["ts"] ?? "").localeCompare(String(b["ts"] ?? "")));
  const num = (r: Record<string, unknown> | undefined, k: string): number | null =>
    typeof r?.[k] === "number" ? (r[k] as number) : null;
  let startIdx = allCloses.length ? allCloses.length - 1 : 0;
  for (let i = allCloses.length - 1; i > 0; i--) {
    const after = num(allCloses[i], "equityUsdAfter");
    const prevAfter = num(allCloses[i - 1], "equityUsdAfter");
    const pnl = num(allCloses[i], "pnlUsd");
    if (after == null || prevAfter == null || pnl == null) break;
    if (Math.abs(prevAfter + pnl - after) > 0.01) break; // ledger break — reset, gap, or duplicate
    startIdx = i - 1;
  }
  const closes = allCloses.slice(startIdx, startIdx + CLOSE_WINDOW_MAX);
  const equityPtsTs = closes
    .map((c) => ({ t: String(c["ts"] ?? ""), bal: c["equityUsdAfter"] }))
    .filter((x): x is { t: string; bal: number } => typeof x.bal === "number");
  const equityPts = equityPtsTs.map((x) => x.bal);
  // Baseline = the bankroll BEFORE the first close in the window (that close's own P&L backed
  // out), so the curve opens where the shown trading actually started rather than at a configured
  // float the account may not have held for days.
  const firstPnl = typeof closes[0]?.["pnlUsd"] === "number" ? (closes[0]!["pnlUsd"] as number) : 0;
  const equityBase = equityPts.length ? equityPts[0]! - firstPnl : s2.startingFloatUsd;
  const equity = [{ bal: equityBase }, ...equityPts.map((bal) => ({ bal }))];
  // Timestamped copy so the combined (S1+S2) curve can merge the two legs on time.
  const equityTs = [{ t: equityPtsTs[0]?.t ?? "", bal: equityBase }, ...equityPtsTs];
  const recentTrades = closes.slice(-30).reverse().map((t) => ({
    ts: t["ts"], symbol: t["sym"] ?? "?", reason: t["reason"], img: artFor(t["mint"] as string | undefined),
    pnlPct: t["pnlPct"] ?? 0, pnlUsd: t["pnlUsd"] ?? 0, heldHours: t["heldHours"],
  }));
  const seenMints = STORE.strategy2.size; // distinct candidates tracked this epoch (per-mint latest snapshot)
  const closed = s2.wins + s2.losses;
  const opened = closed + s2.openPositions.length;
  // ADMISSION FUNNEL — real numbers (2026-07-31). This block used to report
  // `rejected: 0, passRate: 1` as literals, so the dashboard asserted a 100% pass rate no matter
  // what the trader actually did. On the day this was fixed the same log held 745 bundle
  // rejections, 13 ATH rejections and 5 dead-token rejections — none of which reached the UI at
  // all. That gap is why the panel could look "empty" and unexplained while the backend was
  // busily and correctly rejecting hundreds of candidates: there was no way to see the difference
  // between "nothing is being found" and "everything found is being filtered".
  //
  // Counted from the trader's own rejection events, so the funnel can never drift from the code
  // that makes the decisions — each gate logs its own event and this reads those counts.
  const gateRejections = {
    deadToken: STORE.events.gateRejectionsEpoch["strategy2-dead-token-rejected"] ?? 0,
    staleMc: STORE.events.gateRejectionsEpoch["strategy2-stale-mc-rejected"] ?? 0,
    unroutable: STORE.events.gateRejectionsEpoch["strategy2-unroutable-rejected"] ?? 0,
    bundle: STORE.events.gateRejectionsEpoch["strategy2-bundle-rejected"] ?? 0,
    ath: STORE.events.gateRejectionsEpoch["strategy2-ath-rejected"] ?? 0,
    cost: STORE.events.gateRejectionsEpoch["strategy2-cost-rejected"] ?? 0,
  };
  const rejectedTotal = Object.values(gateRejections).reduce((a, b) => a + b, 0);
  // `opened` counts positions actually taken this epoch; every rejection above is a candidate that
  // reached the admission gate and was turned away. Their sum is what was genuinely evaluated —
  // which is a much smaller and more honest number than "every mint the scout ever logged".
  // Both sides of this ratio must describe the SAME epoch. `opened` above is derived from the
  // paper state file, which deliberately survives epoch changes (open positions are not closed
  // just because the admission rules changed) — pairing it with epoch-scoped rejections produced
  // a 95% pass rate on an epoch that had taken a single entry. The accepted count therefore comes
  // from epoch-tagged open events, exactly like the rejections it is compared against.
  const acceptedEpoch = STORE.events.opensEpoch;
  const evaluated = acceptedEpoch + rejectedTotal;
  return {
    totals: {
      gated: evaluated, passed: acceptedEpoch, rejected: rejectedTotal,
      passRate: evaluated ? acceptedEpoch / evaluated : 0,
    },
    gateRejections,
    seenMints, // distinct candidates the scout surfaced — deliberately separate from `gated`
    // Every stage here must describe the SAME epoch, or the funnel reports an impossibility.
    // Found on screen: ENTERED (30) exceeded SCANNED (26), because `bought` was still taking the
    // lifetime position count from the paper state file — which deliberately survives epoch
    // changes — while the stages beside it had already been scoped to the current epoch. A funnel
    // whose output is larger than its input is worse than no funnel: it silently discredits every
    // other number on the panel.
    funnel: { passed: evaluated, bought: acceptedEpoch },
    paper: {
      opens: opened, closed, open: s2.openPositions.length,
      wins: s2.wins, losses: s2.losses, winRate: s2.winRate,
      heartbeatAgeSec: s2.heartbeatAgeSec, // ground truth for "is this panel showing live numbers"
      floatSol: s2.startingFloatUsd, balanceSol: s2.equityUsd, // field names kept for frontend reuse; values are USD here
      equity,
      // entryPrice/lastPrice are synthetic (1 and 1+pct/100) purely so the frontend's generic
      // "recompute % from price delta" sparkline math (shared with the sniper's positions) works
      // unchanged — the real, authoritative number is unrealizedPct itself, computed above from
      // real MC marks.
      openPositions: s2.openPositions.map((p) => ({
        mint: p.mint, symbol: p.sym, img: artFor(p.mint), unrealizedPnl: p.unrealizedPct, heldSec: Math.round(p.heldHours * 3_600),
        entryCostUsd: p.entryCostUsd,   // S2 sizes by % of equity, so USD is its native stake unit
        ...exitProximity({ peakPct: p.peakPct, fromPeakPct: p.fromPeakPct, engine: "S2" }),
        entryPrice: 1, lastPrice: 1 + p.unrealizedPct / 100,
        noManualClose: true, // Strategy 2 has no /api/control close path — never show a button that silently no-ops
        marketCap: p.mcUsd, holders: p.holders, // FIXED (2026-07-29): posCard() reads these directly, were never passed through
      })),
    },
    recentTrades,
    equityTs, // internal: timestamped equity for the combined-wallet curve
    // Audit fix (2026-07-29): per-source breakdown — "pisahkan gmgn-trending dan gmgn-trenches
    // jadi arm berbeda" (and any future source) instead of blending outcomes from thesis-distinct
    // lanes into one win rate. Sorted by n so the panel reads highest-sample-first.
    // UI-clarity fix (2026-07-29, found live): this used to be built ONLY from CLOSED trades, so
    // a source with several OPEN positions but zero closes yet (e.g. gmgn-trending: 8 open, 0
    // closed in a fresh epoch) simply didn't appear — reading as "this source is missing/broken"
    // rather than "no results yet." openN merges in a live count from currently-open positions so
    // every source with ANY activity (open or closed) shows up.
    bySource: (() => {
      // Built from the SAME window as the equity curve and journal. It used to accumulate for the
      // life of the process, which is how a -$1,317.90 lifetime total came to sit beside a
      // -$215.53 headline on one screen, describing the same strategy.
      const bySrc = new Map<string, { n: number; wins: number; pnlUsd: number; openN: number }>();
      for (const c of closes) {
        const source = String(c["entrySource"] ?? "unknown");
        const pnl = typeof c["pnlUsd"] === "number" ? (c["pnlUsd"] as number) : 0;
        const b = bySrc.get(source) ?? { n: 0, wins: 0, pnlUsd: 0, openN: 0 };
        b.n++; if (pnl >= 0) b.wins++; b.pnlUsd += pnl;
        bySrc.set(source, b);
      }
      for (const p of s2.openPositions) {
        const b = bySrc.get(p.source) ?? { n: 0, wins: 0, pnlUsd: 0, openN: 0 };
        b.openN++;
        bySrc.set(p.source, b);
      }
      return [...bySrc.entries()]
        .map(([source, b]) => ({ source, n: b.n, wins: b.wins, winRate: b.n ? b.wins / b.n : 0, pnlUsd: Number(b.pnlUsd.toFixed(2)), openN: b.openN }))
        .sort((a, b) => (b.n + b.openN) - (a.n + a.openN));
    })(),
  };
}

// ── Live market feed (REAL pump.fun data): newest launches + biggest by market cap ──
// Refreshed on a background timer so /api/stats stays synchronous & fast. These numbers
// are exactly what pump.fun serves (no modelling) — a live view of the actual market.
type Coin = { symbol: string; mint: string; mcUsd: number | null; ageMin: number | null; replies: number; img: string | null };
let marketCache: { new: Coin[]; top: Coin[]; at: number } = { new: [], top: [], at: 0 };

// ── COIN ART CACHE ──────────────────────────────────────────────────────────
// Owner, 2026-08-05: "semua koin yang tampil itu menggunakan icon ya!" — but only the market feed
// ever carried `image_uri`. Open positions, scout candidates and the trade journal all identify
// coins by symbol alone, and a symbol is not an identity here: "BABY", "Memes" and "DUMB" recur
// constantly across unrelated mints.
//
// Two sources, cheapest first:
//   1. the market poll we ALREADY make — free, no extra request, covers whatever is trending
//   2. a per-mint lookup for what that misses, at most one request per mint, ever
//
// Bounded on purpose. Misses are remembered as misses (`null`) so a coin whose art genuinely 404s
// is not re-fetched forever, and the whole map is trimmed rather than allowed to grow with every
// mint the bot has ever seen.
const ART_MAX = 800;
const artCache = new Map<string, string | null>();
const artInFlight = new Set<string>();

function rememberArt(mint: string | undefined, img: string | undefined | null): void {
  if (!mint || !img) return;
  if (!artCache.has(mint)) artCache.set(mint, img);
}

const fetchJson = async (url: string, headers: Record<string, string> = {}, ms = 9000): Promise<unknown> => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: ctl.signal });
    return res.ok ? await res.json() : null;
  } finally { clearTimeout(timer); }
};
const pumpArt = async (mint: string): Promise<string | null> =>
  ((await fetchJson(`https://frontend-api-v3.pump.fun/coins/${mint}`)) as { image_uri?: string } | null)?.image_uri ?? null;
const dexArt = async (mint: string): Promise<string | null> => {
  const j = (await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)) as
    { pairs?: Array<{ info?: { imageUrl?: string } }> } | null;
  return j?.pairs?.find((p) => p.info?.imageUrl)?.info?.imageUrl ?? null;
};
// Credit-metered, so it is rate-capped independently of the cache: a burst of new candidates must
// never be able to drain a month of quota for decoration.
let trackerArtBudget = 40, trackerArtWindow = Date.now();
const trackerArt = async (mint: string): Promise<string | null> => {
  if (Date.now() - trackerArtWindow > 3_600_000) { trackerArtBudget = 40; trackerArtWindow = Date.now(); }
  const key = (process.env.SOLTRACKER_API_KEYS ?? process.env.SOLTRACKER_API_KEY ?? "").split(/[\n,]/)[0]?.trim();
  if (!key || trackerArtBudget <= 0) return null;
  trackerArtBudget--;
  const j = (await fetchJson(`https://data.solanatracker.io/tokens/${mint}`, { "x-api-key": key })) as
    { token?: { image?: string } } | null;
  return j?.token?.image ?? null;
};


/**
 * EXIT-PROXIMITY FIELDS for an open position — what the card needs to answer "what will close
 * this, and how much room is left".
 *
 * Neither engine ever sent these. The card could show a running P&L and nothing else, while the
 * two rules that actually end 60% of positions (the trailing stop and the no-development timer)
 * were invisible until they fired.
 *
 * S1's trail is a LADDER, not a constant: the wider the peak, the more giveback is allowed
 * (+15% peak → 6% trail … +300% → 45%). Hardcoding one number in the UI would draw a stop that
 * does not exist, so the applicable rung is resolved here, against the same config the exit
 * logic reads.
 */
function exitProximity(opts: { peakPct: number; fromPeakPct: number; engine: "S1" | "S2" }): {
  peakPct: number; fromPeakPct: number; trailPct: number; budgetSec: number; budgetLabel: string;
} {
  const { peakPct, fromPeakPct, engine } = opts;
  if (engine === "S2") {
    return {
      peakPct, fromPeakPct,
      trailPct: config.strategy2Paper.trailStopPct,
      budgetSec: Math.round(config.strategy2Paper.maxHoldHours * 3600),
      budgetLabel: "batas tahan",
    };
  }
  const ladder = config.risk.dynamicTrail;
  let trailPct: number = ladder[0]?.trail ?? 6;
  for (const rung of ladder) if (peakPct >= rung.gain) trailPct = rung.trail;
  // Below the no-development peak floor the position is on the SHORT clock, not the max-hold one.
  const nd = config.risk.noDevelopment;
  const undeveloped = nd.enabled && peakPct < nd.minPeakPct;
  return {
    peakPct, fromPeakPct, trailPct,
    budgetSec: Math.round((undeveloped ? nd.afterMs : config.risk.maxHoldMsFastFollow) / 1000),
    budgetLabel: undeveloped ? "belum berkembang" : "batas tahan",
  };
}

/** Cached art for a mint, kicking off a background lookup the first time we miss. */
/**
 * Wallet balance cache. Polled rather than read per request: /api/stats is built every few
 * seconds and a chain read on that path would spend the RPC budget the trader needs. `null`
 * means UNKNOWN and must stay null all the way to the UI — never coerced to zero.
 */
let cachedBlockhash: { blockhash: string; lastValidBlockHeight: number; at: number } | null = null;
let cachedWalletSol: number | null = null;
// Failure-streak visibility: the $0.00 incident (2026-08-24) was a balance read failing for
// minutes with ZERO trace in this process's log. After 3 consecutive misses, say so once —
// silence means "healthy", never "we stopped looking".
let walletReadMissStreak = 0;
const noteWalletRead = (v: number | null): void => {
  if (v != null) {
    if (walletReadMissStreak >= 3) console.warn(`[wallet] bacaan saldo pulih setelah ${walletReadMissStreak} gagal beruntun — saldo ${v.toFixed(4)} SOL`);
    walletReadMissStreak = 0;
    cachedWalletSol = v;
  } else {
    walletReadMissStreak++;
    if (walletReadMissStreak === 3) console.warn("[wallet] 3× bacaan saldo gagal beruntun di semua endpoint — panel dompet akan menampilkan 'tidak terbaca', bukan nol");
  }
};
// POOL, NOT RAW (2026-08-24): this poll used to hit `config.rpcUrl` directly — endpoint #0,
// forever, bypassing rotation. That is the exact anti-pattern safety/onchain.ts documents:
// one throttled key eats every read while four siblings sit idle, and the dashboard's own
// polling then competes with the trader for the same key OUTSIDE the pool's rate limiter.
// The pool's token bucket + rotation is the shared quota treaty; join it.
setInterval(() => {
  void poolBalanceSol(botPubkey()).then(noteWalletRead).catch(() => noteWalletRead(null));
}, 20_000);
void poolBalanceSol(botPubkey()).then(noteWalletRead).catch(() => noteWalletRead(null));

function artFor(mint: string | undefined): string | null {
  if (!mint) return null;
  const hit = artCache.get(mint);
  if (hit !== undefined) return hit;
  if (artCache.size > ART_MAX) {
    // oldest-first trim: Map preserves insertion order, so this drops the least recently ADDED
    for (const k of [...artCache.keys()].slice(0, Math.floor(ART_MAX / 4))) artCache.delete(k);
  }
  if (!artInFlight.has(mint) && !artQueue.includes(mint)) {
    artQueue.push(mint);
    void drainArtQueue();
  }
  return null;   // this render gets the fallback glyph; a later one gets the art
}

/**
 * Resolve queued mints a few at a time.
 *
 * Firing one fetch per cache miss looked fine until the panels that needed art all rendered at
 * once: 30 scout candidates + 14 journal rows = 44 simultaneous lookups, which saturated the
 * connection pool and every one of them hit its own AbortError at the 6s timeout — so the caller
 * saw zero icons and the queue refilled on the next render, forever. Three at a time with a
 * longer deadline resolves the same 44 mints in a few seconds and never stampedes.
 */
const ART_CONCURRENCY = 3;
const artQueue: string[] = [];
let artWorkers = 0;
async function drainArtQueue(): Promise<void> {
  if (artWorkers >= ART_CONCURRENCY) return;
  artWorkers++;
  try {
    for (;;) {
      const mint = artQueue.shift();
      if (!mint) return;
      if (artCache.has(mint) || artInFlight.has(mint)) continue;
      artInFlight.add(mint);
      await (async () => {
      try {
        // THREE SOURCES, cheapest and most-likely-first. Measured on real mints from this bot's
        // own panels: pump.fun answers for its own launches (S1's whole universe, and 10 of 30
        // scout candidates), but the scout also tracks coins that never touched pump.fun at all —
        // for those it 404s, and DexScreener covers whatever has a live pair. Solana Tracker
        // covers the rest but SPENDS CREDITS (3,098 left across the rotating keys), so it is the
        // last resort and only for mints the free sources genuinely could not answer.
        const img =
          (await pumpArt(mint)) ??
          (await dexArt(mint)) ??
          (await trackerArt(mint));
        artCache.set(mint, img);   // null = all three looked and there is none
      } catch {
        // A failed lookup is NOT cached as a miss: the next render tries again, otherwise one
        // network blip permanently blanks a coin's icon for the life of the process.
        //
        // This catch is also load-bearing for stability, which is how it was found: an earlier
        // edit left `try { … } finally { … }` with no catch at all, so an aborted fetch became an
        // unhandled rejection inside a `void`-ed async IIFE — which Node 20 turns into a process
        // exit by default. Icon decoration must never be able to take the dashboard down.
      } finally {
        artInFlight.delete(mint);
      }
      })();
    }
  } finally {
    artWorkers--;
  }
}
async function fetchCoins(sort: string): Promise<Coin[]> {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins?offset=0&limit=24&sort=${sort}&order=DESC&includeNsfw=false`, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{ symbol?: string; mint?: string; usd_market_cap?: number; created_timestamp?: number; reply_count?: number; image_uri?: string }>;
    const now = Date.now();
    return (Array.isArray(arr) ? arr : []).map((c) => ({
      symbol: c.symbol ?? "?", mint: c.mint ?? "",
      // null, never 0: `?? 0` printed a confident "MC $0" for a field the feed simply omitted,
      // which reads as "worthless coin" rather than "not reported". Same defect class as the
      // fabricated holder counts fixed earlier — the UI renders null as "—".
      mcUsd: typeof c.usd_market_cap === "number" && isFinite(c.usd_market_cap) ? Math.round(c.usd_market_cap) : null,
      // pump.fun ships the token art on this very response; the old mapping simply dropped it,
      // so the dashboard had no logos despite them being one field away. https only — an ipfs://
      // or data: URI would not render in an <img> without extra plumbing.
      img: typeof c.image_uri === "string" && c.image_uri.startsWith("https://") ? c.image_uri : null,
      ageMin: c.created_timestamp ? Math.round((now - c.created_timestamp) / 60000) : null, replies: c.reply_count ?? 0,
    })).filter((c) => c.mint);
  } catch { return []; }
}
async function refreshMarket(): Promise<void> {
  const [fresh, top] = await Promise.all([fetchCoins("created_timestamp"), fetchCoins("market_cap")]);
  for (const c of [...fresh, ...top]) rememberArt(c.mint, c.img);
  if (fresh.length || top.length) marketCache = { new: fresh, top, at: Date.now() };
}
void refreshMarket();
// TIGHTENED 20s→5s→1s (owner, 2026-07-29). This is purely the dashboard's own "Live Market"
// display widget for human viewing — NOT the sniper's detection path (pumpportal.ts subscribes
// to pump.fun over a WebSocket, real push events, never polled at all). Honest risk at 1s
// sustained 24/7 against a free unauthenticated endpoint: pump.fun could eventually soft-block
// or Cloudflare-challenge this IP, unlike a browser tab that polls only while open. fetchCoins()
// already fails silently and keeps the last good cache rather than crash if that happens — watch
// for a market feed that stops updating as the tell, and dial back if seen.
setInterval(() => void refreshMarket(), 1_000);

// Live SOL price, refreshed in the background. The dashboard used to multiply the paper
// balance by a HARD-CODED 78.19 to show USD — wrong by however far SOL has moved since that
// number was typed. Same class of bug as the hard-coded 2.00 SOL float in the P&L line.
let solUsd: number | null = null;
async function refreshSolPrice(): Promise<void> {
  // Never overwrite a good rate with nothing. `solPriceUsd()` RETURNS null under Jupiter
  // throttling rather than throwing, so the old `solUsd = await solPriceUsd()` wiped the last
  // known price on every hiccup — and with the wallet now denominated in USD, a null rate blanks
  // the headline balance, the equity curve and the combined P&L all at once. Measured earlier the
  // same day: 2 of 3 cold calls to that helper returned null. GMGN publishes a SOL price on an
  // endpoint this process already talks to, so it stands in when Jupiter is unavailable, and a
  // stale-but-real rate is kept if both fail.
  try {
    const jup = await solPriceUsd();
    if (jup && jup > 0) { solUsd = jup; return; }
  } catch { /* fall through */ }
  try {
    const info = await gmgnTokenInfo("sol", "So11111111111111111111111111111111111111112");
    const gm = Number(info?.price?.price);
    if (isFinite(gm) && gm > 0) solUsd = gm;
  } catch { /* keep last */ }
}
void refreshSolPrice();
setInterval(() => void refreshSolPrice(), 60_000);

// Solscan network status (free /chaininfo). Cached; best-effort.
let chainCache: { blockHeight?: number; epoch?: number; at: number } = { at: 0 };
async function solscanChainInfo() {
  if (!config.solscanApiKey) return null;
  if (Date.now() - chainCache.at < 30_000 && chainCache.blockHeight) return chainCache;
  try {
    const res = await fetch(config.solscanChainInfoUrl, { headers: { token: config.solscanApiKey } });
    const j = (await res.json()) as { data?: { blockHeight?: number; currentEpoch?: number } };
    chainCache = { blockHeight: j.data?.blockHeight, epoch: j.data?.currentEpoch, at: Date.now() };
    return chainCache;
  } catch {
    return chainCache.blockHeight ? chainCache : null;
  }
}

/**
 * "No-trade/control arm" comparison (audit fix, 2026-07-29): strategy2-outcome-tracker.ts already
 * re-checks EVERY scouted candidate at fixed horizons (6h/24h/48h) — bought or not, since it never
 * filters on purchase status. That means the exact comparison the audit asked for ("bandingkan
 * current filter... dan tidak entry pada kandidat yang sama serta window yang sama") already
 * exists in the raw logs; it just wasn't ever computed and shown anywhere. This joins the two
 * event streams (strategy2-outcome × strategy2-paper-open, on mint+source+cfg+epoch) live from
 * disk rather than maintaining yet another incremental store — this endpoint is called rarely
 * (a diagnostics view, not the hot dashboard poll), so a full read is the simpler, honest choice.
 */
function buildStrategy2ControlArm() {
  const boughtMints = new Set<string>();
  const bySourceOutcome = new Map<string, { boughtMcChangePcts: number[]; skippedMcChangePcts: number[] }>();
  try {
    const files = readdirSync(config.logDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort();
    // Pass 1: which mints did we actually buy (any horizon, any time — a mint bought today should
    // never be miscounted as "skipped" just because the open event lives in an earlier file).
    for (const f of files) {
      for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { type?: string; mint?: string };
          if (r.type === "strategy2-paper-open" && r.mint) boughtMints.add(r.mint);
        } catch { /* skip malformed line */ }
      }
    }
    // Pass 2: bucket every outcome row's mcChangePct by source and by bought/skipped.
    for (const f of files) {
      for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { type?: string; mint?: string; source?: string; mcChangePct?: number; horizonHours?: number };
          if (r.type !== "strategy2-outcome" || r.horizonHours !== 6 || typeof r.mcChangePct !== "number") continue;
          const src = r.source ?? "unknown";
          const bucket = bySourceOutcome.get(src) ?? { boughtMcChangePcts: [], skippedMcChangePcts: [] };
          (r.mint && boughtMints.has(r.mint) ? bucket.boughtMcChangePcts : bucket.skippedMcChangePcts).push(r.mcChangePct);
          bySourceOutcome.set(src, bucket);
        } catch { /* skip malformed line */ }
      }
    }
  } catch { /* best-effort */ }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return [...bySourceOutcome.entries()].map(([source, b]) => ({
    source,
    boughtN: b.boughtMcChangePcts.length, boughtAvgMcChangePct6h: avg(b.boughtMcChangePcts),
    skippedN: b.skippedMcChangePcts.length, skippedAvgMcChangePct6h: avg(b.skippedMcChangePcts),
    note: "6h horizon only; mcChangePct is the RAW market-cap delta the outcome tracker measured, not a realized trade P&L",
  }));
}

/**
 * The config hash the TRADER is actually running, read from the newest CLOSE record.
 *
 * Not `configHash` — that is THIS process's own hash, and the dashboard is a separate process
 * with its own env. The 25s NO_DEV cohort test sets `NO_DEV_MS` only in the sniper's supervisor,
 * so the two diverged (`1qa0i0o` here vs `t5cofy` there). Anything that filters or labels
 * trading data by `configHash` therefore describes the dashboard, not the bot — which silently
 * hid the newest run from the run-ledger and mislabelled the "current" cohort row.
 *
 * Falls back to `configHash` only when there are no tagged trades at all.
 */
function liveTradingCfg(): string {
  const rows = STORE.trades as unknown as Array<{ action?: string; cfg?: unknown; ts?: unknown }>;
  let cfg = configHash;
  let newestTs = "";
  for (const r of rows) {
    if (r.action !== "CLOSE" || typeof r.cfg !== "string") continue;
    const ts = String(r.ts ?? "");
    if (ts > newestTs) { newestTs = ts; cfg = r.cfg; }
  }
  return cfg;
}

/** DEEP ANALYTICS from the complete CLOSE records — data-backed answers, never modelled. */
function buildAnalytics(cfgFilter?: string) {
  type C = Record<string, number | string | boolean | null>;
  refreshStore();
  const cfg = cfgFilter ?? configHash;
  const all = (STORE.trades as unknown as C[]).filter((r) => r.action === "CLOSE" && (r.cfg === cfg || cfgFilter === "all"));
  const num = (r: C, k: string): number | null => (typeof r[k] === "number" ? (r[k] as number) : null);
  const n = all.length;
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

  const peaks = all.map((r) => num(r, "peakPct") ?? 0);
  const nets = all.map((r) => num(r, "tradePnlSol") ?? num(r, "pnlSol") ?? 0);
  // Capture is only meaningful against a peak worth capturing. Historical rows were written
  // with any peak > 0 as the denominator, so a +0.0001% peak yields a value in the millions —
  // guard here too so old data can never poison the mean.
  const caps = all.filter((r) => (num(r, "peakPct") ?? 0) >= 5)
    .map((r) => num(r, "capturePct")).filter((x): x is number => x != null && isFinite(x) && Math.abs(x) <= 500);

  // outcome distribution by PEAK reached
  const dist = { rug: 0, flat_0_20: 0, small_20_100: 0, big_100_500: 0, moon_500plus: 0 };
  all.forEach((r) => { const p = num(r, "peakPct") ?? 0;
    if (p < 0) dist.rug++; else if (p < 20) dist.flat_0_20++; else if (p < 100) dist.small_20_100++; else if (p < 500) dist.big_100_500++; else dist.moon_500plus++; });

  // capture rate — how much of the peak we actually banked (the profit lever)
  const capture = { n: caps.length, meanPct: Number(mean(caps).toFixed(1)), medianPct: Number(med(caps).toFixed(1)) };

  // fat-tail contribution — do the winners pay for the losers? (real SOL, no model)
  const winners = all.filter((r) => (num(r, "tradePnlSol") ?? 0) > 0);
  const losers = all.filter((r) => (num(r, "tradePnlSol") ?? 0) <= 0);
  const fatTail = {
    totalPnlSol: Number(sum(nets).toFixed(4)),
    winners: winners.length, winnerPnlSol: Number(sum(winners.map((r) => num(r, "tradePnlSol") ?? 0)).toFixed(4)),
    losers: losers.length, loserPnlSol: Number(sum(losers.map((r) => num(r, "tradePnlSol") ?? 0)).toFixed(4)),
    avgLoserPct: Number(mean(losers.map((r) => num(r, "pnlPct") ?? 0)).toFixed(1)),
    biggestWinSol: winners.length ? Number(Math.max(...winners.map((r) => num(r, "tradePnlSol") ?? 0)).toFixed(4)) : 0,
  };

  // SIGNAL → OUTCOME correlation: for each entry signal, mean peak of trades that HAD it vs not
  const signalEdge = (key: string, threshold: number, label: string) => {
    const withSig = all.filter((r) => (num(r, key) ?? -1) >= threshold);
    const without = all.filter((r) => { const v = num(r, key); return v != null && v < threshold; });
    return { label, n: withSig.length, avgPeakWith: Number(mean(withSig.map((r) => num(r, "peakPct") ?? 0)).toFixed(0)), avgPeakWithout: Number(mean(without.map((r) => num(r, "peakPct") ?? 0)).toFixed(0)) };
  };
  const signals = [
    signalEdge("buyers", 30, "buyers≥30"),
    signalEdge("buyPressurePct", 70, "buyPressure≥70%"),
    signalEdge("velSol", 0.05, "velSol≥0.05"),
    signalEdge("accel", 3, "accel≥3×"),
    signalEdge("rawScore", 90, "rawScore≥90"),
  ];
  // rug-cluster outcome: did flagged coins do worse?
  const coord = all.filter((r) => r.coordinated === true);
  const clean = all.filter((r) => r.coordinated === false);
  const rugClusterEdge = { flagged: coord.length, flaggedAvgPnlPct: Number(mean(coord.map((r) => num(r, "pnlPct") ?? 0)).toFixed(1)),
    clean: clean.length, cleanAvgPnlPct: Number(mean(clean.map((r) => num(r, "pnlPct") ?? 0)).toFixed(1)) };

  // scale-out effectiveness
  const scaled = all.filter((r) => r.deRisked === true);
  const scaleOut = { fired: scaled.length, avgTradePnlSol: scaled.length ? Number(mean(scaled.map((r) => num(r, "tradePnlSol") ?? 0)).toFixed(4)) : 0 };

  // ── TIME-TO-ATH benchmark (owner's idea: when do coins peak → hold vs take-profit timing) ──
  // For coins that actually ran (peak≥40%), WHEN did the ATH happen? The distribution of
  // peakAtSec is the data-backed benchmark: hold through the typical climb window, take
  // profit / tighten around the median peak minute, treat the fade as over after it.
  const ran = all.filter((r) => (num(r, "peakPct") ?? 0) >= 40 && (num(r, "peakAtSec") ?? 0) > 0);
  const athSecs = ran.map((r) => num(r, "peakAtSec") ?? 0);
  // bucket by minute band
  const band = { m0_2: 0, m2_5: 0, m5_15: 0, m15_30: 0, m30plus: 0 };
  athSecs.forEach((s) => { if (s < 120) band.m0_2++; else if (s < 300) band.m2_5++; else if (s < 900) band.m5_15++; else if (s < 1800) band.m15_30++; else band.m30plus++; });
  // does time-to-peak differ for BIG winners vs small? (do moons take longer to peak?)
  const bigRan = ran.filter((r) => (num(r, "peakPct") ?? 0) >= 200);
  const timeToAth = {
    n: ran.length,
    medianMin: Number((med(athSecs) / 60).toFixed(1)),
    avgMin: Number((mean(athSecs) / 60).toFixed(1)),
    bandByMinute: band,
    bigWinnerMedianMin: bigRan.length ? Number((med(bigRan.map((r) => num(r, "peakAtSec") ?? 0)) / 60).toFixed(1)) : null, // do +200% runners peak later?
    note: "hold through the climb; the median peak minute is the take-profit / tighten window",
  };

  // ── ENTRY-MC vs OUTCOME (the band-tuning table) ──
  // A pump.fun curve launches at ~27.96 SOL, so the bands are cut around that constant: at or
  // below it nobody has bought yet. Reported as SOL per trade, which is the only figure that
  // compares bands with different trade counts fairly.
  const mcRows = all.filter((r) => num(r, "curveMcSol") != null);
  const mcBands = [
    { label: "≤28.1 (bare launch)", lo: 0, hi: 28.1 },
    { label: "28.1–30", lo: 28.1, hi: 30 },
    { label: "30–36", lo: 30, hi: 36 },
    { label: "36–45", lo: 36, hi: 45 },
    { label: "45–60", lo: 45, hi: 60 },
    { label: "> 60", lo: 60, hi: Infinity },
  ].map((b) => {
    const rows = mcRows.filter((r) => { const v = num(r, "curveMcSol")!; return v >= b.lo && v < b.hi; });
    const sol = sum(rows.map((r) => num(r, "tradePnlSol") ?? 0));
    return {
      label: b.label, n: rows.length,
      deadPct: rows.length ? Math.round((rows.filter((r) => (num(r, "pnlPct") ?? 0) < -60).length / rows.length) * 100) : 0,
      winPct: rows.length ? Math.round((rows.filter((r) => (num(r, "tradePnlSol") ?? 0) > 0).length / rows.length) * 100) : 0,
      sol: Number(sol.toFixed(4)),
      solPerTrade: rows.length ? Number((sol / rows.length).toFixed(5)) : 0,
      inBand: b.lo >= config.gate.entryMcBandSol.floor && b.hi <= config.gate.entryMcBandSol.ceiling,
    };
  });
  const mcBand = { coverage: mcRows.length, of: n, floor: config.gate.entryMcBandSol.floor, ceiling: config.gate.entryMcBandSol.ceiling, bands: mcBands };

  // ── EXIT LEDGER: which mechanism produced (or destroyed) the SOL ──
  // Exit-reason COUNTS alone hide the story; the same reason can be both the most frequent and
  // the most expensive. This attributes real SOL to each exit path.
  const byReason = new Map<string, { n: number; sol: number; pnl: number[]; held: number[] }>();
  for (const r of all) {
    const k = String(r.reason ?? "?");
    const e = byReason.get(k) ?? { n: 0, sol: 0, pnl: [], held: [] };
    e.n++; e.sol += num(r, "tradePnlSol") ?? 0; e.pnl.push(num(r, "pnlPct") ?? 0); e.held.push(num(r, "heldSec") ?? 0);
    byReason.set(k, e);
  }
  const exitLedger = [...byReason.entries()].map(([reason, e]) => ({
    reason, n: e.n, sol: Number(e.sol.toFixed(4)),
    avgPnlPct: Number(mean(e.pnl).toFixed(1)), medianHoldMin: Number((med(e.held) / 60).toFixed(1)),
  })).sort((a, b) => a.sol - b.sol);

  return {
    cfg, version: config.strategyVersion, trades: n,
    outcomeDistribution: dist,
    mcBand, exitLedger,
    captureRate: capture, // THE profit lever — % of peak we bank
    fatTail, // do winners pay for losers (real SOL)
    signalEdge: signals, // which entry signals predict higher peaks
    rugClusterEdge, // do rug-cluster flags predict worse outcomes
    scaleOut,
    timeToAth, // WHEN coins peak (owner's minute-to-ATH benchmark for hold vs take-profit)
    note: n < 20 ? "sample small — treat as indicative until more trades" : "sufficient sample",
  };
}

/**
 * COHORT COMPARISON — every sniper config that has ever traded, side by side.
 *
 * `cfg` is a hash of the material config + code fingerprint, so it changes on any real
 * parameter edit and each setting's trades self-isolate. This groups CLOSE records by that
 * hash so a tuning change can be judged against the setting it replaced instead of against
 * a memory of it.
 *
 * The honest caveat, kept in the payload so it reaches the screen and not just this comment:
 * cohorts are sequential, not randomised. Market conditions move between them, so a
 * difference here is evidence, not proof — and with a few hundred trades per cohort, the
 * noise on EV/trade is worth several points on its own.
 */
function buildCohorts() {
  refreshStore();
  type C = Record<string, number | string | boolean | null>;
  const all = (STORE.trades as unknown as C[]).filter((r) => r.action === "CLOSE" && typeof r.cfg === "string");
  const byCfg = new Map<string, C[]>();
  for (const r of all) {
    const k = String(r.cfg);
    const list = byCfg.get(k) ?? [];
    list.push(r);
    byCfg.set(k, list);
  }
  const num = (r: C, k: string): number | null => (typeof r[k] === "number" ? (r[k] as number) : null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const med = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

  const liveCfg = liveTradingCfg();

  const cohorts = [...byCfg.entries()].map(([cfg, rows]) => {
    const pnls = rows.map((r) => num(r, "pnlPct") ?? 0);
    const sols = rows.map((r) => num(r, "tradePnlSol") ?? 0);
    const held = rows.map((r) => num(r, "heldSec") ?? 0);
    const wins = rows.filter((r) => (num(r, "tradePnlSol") ?? 0) > 0);
    const ts = rows.map((r) => String(r.ts ?? "")).filter(Boolean).sort();
    // exit-reason split, so a change aimed at ONE exit path can be checked on that path
    const reasons: Record<string, { n: number; avgPnlPct: number }> = {};
    const byReason = new Map<string, number[]>();
    for (const r of rows) {
      const k = String(r.reason ?? "?");
      byReason.set(k, [...(byReason.get(k) ?? []), num(r, "pnlPct") ?? 0]);
    }
    for (const [k, v] of byReason) reasons[k] = { n: v.length, avgPnlPct: Number(mean(v).toFixed(1)) };
    return {
      cfg,
      current: cfg === liveCfg,
      trades: rows.length,
      evPct: Number(mean(pnls).toFixed(2)),      // the headline: expected % per trade (PAPER)
      totalSol: Number(sols.reduce((s, x) => s + x, 0).toFixed(4)),
      winPct: rows.length ? Math.round((wins.length / rows.length) * 100) : 0,
      // -25%, not the -60% used elsewhere: measured over 780 sniper closes, NOTHING lands below
      // -40% (the exit rules cut long before that), so a -60% "dead" bar reads 0% for every
      // cohort and discriminates nothing. -25% catches the worst 21% — the bleed tail this
      // NO_DEVELOPMENT tuning is actually aimed at.
      bleedPct: rows.length ? Math.round((rows.filter((r) => (num(r, "pnlPct") ?? 0) < -25).length / rows.length) * 100) : 0,
      medianHoldSec: Math.round(med(held)),
      avgPeakPct: Number(mean(rows.map((r) => num(r, "peakPct") ?? 0)).toFixed(0)),
      firstTs: ts[0] ?? null,
      lastTs: ts[ts.length - 1] ?? null,
      reasons,
    };
  }).sort((a, b) => String(b.lastTs ?? "").localeCompare(String(a.lastTs ?? "")));

  // Paper EV minus what a real fill would additionally pay.
  //
  // The overhead is a FIXED number of SOL, so as a percentage it depends entirely on the position
  // size — and that size differs per cohort (0.05 before 2026-08-02, 0.15 after). Reading it from
  // this process's own `config.risk.paperTradeSizeSol` was wrong for the same reason `configHash`
  // was wrong twice before: the dashboard is a separate process and its env is not the trader's.
  // It reported every cohort at 0.05 while the live one was trading 0.15, overstating the newest
  // cohort's overhead by 3×. Take the size from each cohort's OWN trade records instead.
  const tipSol0 = Number(process.env.VALIDATOR_TIP_SOL ?? 0.001);
  const prioSol0 = Number(process.env.LIVE_PRIORITY_FEE_SOL ?? 0.000001);
  const perTrip = 2 * (tipSol0 + prioSol0);
  for (const c of cohorts) {
    const sizes = (byCfg.get(c.cfg) ?? [])
      .map((r) => num(r, "entrySizeSol") ?? num(r, "sizeSol"))
      .filter((v): v is number => v != null && v > 0);
    const size = sizes.length ? med(sizes) : config.risk.paperTradeSizeSol;
    const oh = size > 0 ? (perTrip / size) * 100 : 0;
    const x = c as unknown as { evLivePct: number; sizeSol: number; overheadPct: number };
    x.sizeSol = Number(size.toFixed(4));
    x.overheadPct = Number(oh.toFixed(2));
    x.evLivePct = Number((c.evPct - oh).toFixed(2));
  }

  // The two newest cohorts with a usable sample — the pair a tuning change is actually judged on.
  const usable = cohorts.filter((c) => c.trades >= 20);
  const [now, prev] = usable;
  const delta = now && prev
    ? {
        cfgNew: now.cfg, cfgOld: prev.cfg,
        evPctDelta: Number((now.evPct - prev.evPct).toFixed(2)),
        winPctDelta: now.winPct - prev.winPct,
        bleedPctDelta: now.bleedPct - prev.bleedPct,
        medianHoldSecDelta: now.medianHoldSec - prev.medianHoldSec,
        verdict:
          Math.min(now.trades, prev.trades) < 100
            ? "sampel belum cukup — tunggu ~100 trade di cohort baru sebelum menyimpulkan"
            : now.evPct > prev.evPct
              ? "cohort baru lebih baik"
              : "cohort baru lebih buruk",
      }
    : null;

  // LIVE-ADJUSTED EV. Paper P&L deliberately excludes the validator/Jito tip and the priority
  // fee — folding them into `pnlPct` would re-base 1,365 historical trades and make the running
  // cohort incomparable with the baseline it is measured against. So the overhead is applied
  // HERE, on top, where it can be read beside the paper figure instead of replacing it.
  //
  // It is not a rounding detail: at the 0.03 SOL size this bot traded until 2026-08-02 the tip
  // alone was 6.67% round trip, larger than every other modelled cost combined, and it turned
  // the best cohort (3orcmx, +5.28% on paper) into −1.39% live. Position size was raised to
  // 0.15 SOL precisely because fixed costs scale inversely with it.
  const tipSol = Number(process.env.VALIDATOR_TIP_SOL ?? 0.001);
  const prioSol = Number(process.env.LIVE_PRIORITY_FEE_SOL ?? 0.000001); // measured market rate, not the config's stale 0.00005
  const liveRow = cohorts.find((c) => c.current) as unknown as { sizeSol?: number } | undefined;
  const sizeSol = liveRow?.sizeSol ?? config.risk.paperTradeSizeSol;
  const liveOverheadPct = sizeSol > 0 ? Number(((2 * (tipSol + prioSol) / sizeSol) * 100).toFixed(2)) : 0;

  return {
    activeCfg: liveCfg, // from the newest CLOSE, not this process's configHash — see note above
    liveOverhead: {
      tipSol, prioSol, sizeSol, pct: liveOverheadPct,
      note: "Tip + priority fee per round trip, as % of position. NOT subtracted from evPct — evLivePct is.",
    },
    cohorts,
    delta,
    caveat:
      "Cohort berurutan, bukan acak — kondisi pasar ikut berubah di antaranya, jadi selisih di sini adalah bukti, bukan kepastian. Dengan beberapa ratus trade per cohort, derau EV/trade sendiri sudah beberapa poin.",
  };
}

function buildStats() {
  refreshStore();
  const D = STORE.decisions, E = STORE.events;
  const allTrades = STORE.trades as unknown as Trade[];
  // Auto-reset trials: the balance/tally shown is the CURRENT run only — everything
  // after the last RESET marker. Prior runs live in the run-ledger below.
  let lastReset = -1;
  for (let i = 0; i < allTrades.length; i++) if (allTrades[i]!.action === "RESET") lastReset = i;
  let trades = lastReset >= 0 ? allTrades.slice(lastReset + 1) : allTrades;
  /**
   * ── SATU REZIM AKUNTANSI SAJA ─────────────────────────────────────────────
   *
   * Sejak 2026-08-25T10:01Z P&L paper dibukukan pada laju yang benar-benar cair (lihat
   * execution/exec-realism.ts). Baris sebelum itu dibukukan dengan cara lama. Menjumlahkan
   * keduanya menghasilkan angka yang bukan apa-apa: saat audit ini ditulis ada 211 baris
   * terkoreksi lawan 4.958 baris lama, jadi "cum P&L" di halaman utama praktis adalah angka
   * lama dengan sedikit angka baru menempel.
   *
   * Yang memisahkan BUKAN cfg. Hash cfg berubah pada tiap suntingan kode — hari ini lima kali —
   * dan memfilter dengannya akan mereset kurva ekuitas karena hal-hal yang tidak ada
   * hubungannya dengan uang. Yang memisahkan adalah rezim pembukuannya sendiri, dan itu
   * tertulis di tiap baris.
   *
   * Baris lama tidak dibuang; ia dilaporkan terpisah di `legacy` supaya tetap bisa dilihat
   * dan tidak pernah ikut terjumlah.
   */
  const inRegime = (t: { execRealismApplied?: boolean }): boolean =>
    (t.execRealismApplied === true) === config.risk.execRealism;
  const legacyTrades = trades.filter((t) => !inRegime(t as { execRealismApplied?: boolean }));
  const legacyCloses = legacyTrades.filter((t) => t.action === "CLOSE");
  const legacyRealizedSol = legacyCloses
    .filter((t) => (t as { execStage?: string }).execStage === "executable" || t.reason === "MANUAL_CLOSE" || t.reason === "MANUAL_FLATTEN")
    .reduce((s, t) => s + (t.pnlSol ?? (t.sizeSol ?? config.risk.paperTradeSizeSol) * ((t.pnlPct ?? 0) / 100)), 0);
  trades = trades.filter((t) => inRegime(t as { execRealismApplied?: boolean }));


  // Post-exit learning: after each close we keep sampling the token's price. The
  // summaries tell us how often our exits were PREMATURE (it ran after we sold) and
  // how much upside we left — the data to tune hold time.
  const postExitRecs = STORE.postExit as Array<{ type?: string; symbol?: string; exitReason?: string; exitPnlPct?: number; heldSec?: number; maxRiseAfterExitPct?: number; peakAtSec?: number; verdict?: string }>;
  const premature = postExitRecs.filter((r) => r.verdict === "premature");
  const postExit = {
    tracked: postExitRecs.length,
    premature: premature.length,
    prematurePct: postExitRecs.length ? Math.round((premature.length / postExitRecs.length) * 100) : 0,
    avgMissedUpsidePct: premature.length ? Math.round(premature.reduce((s, r) => s + (r.maxRiseAfterExitPct ?? 0), 0) / premature.length) : 0,
    worst: postExitRecs.slice().sort((a, b) => (b.maxRiseAfterExitPct ?? 0) - (a.maxRiseAfterExitPct ?? 0)).slice(0, 5).map((r) => ({ symbol: r.symbol ?? "?", exitReason: r.exitReason, exitPnlPct: r.exitPnlPct, maxRiseAfterExitPct: r.maxRiseAfterExitPct, peakAtSec: r.peakAtSec })),
  };
  // PATTERN MEMORY — learn the entry signature of winners vs losers. For each outcome
  // bucket (moon ≥500% peak, bigWin ≥100%, dud <20%) average the entry conditions, so
  // "what does a runner look like at entry" becomes a concrete, data-backed profile.
  // REBUILT on fields that actually EXIST. The previous profile averaged `buyers`,
  // `buyPressurePct`, `accel`, `organic` and `confirmAgeSec` — every one of which has **0%
  // coverage** in the patterns log. They came from `confirmStats`, which was deliberately removed
  // as target leakage (captured at T+45-180s, i.e. the future relative to entry). So the whole
  // winner-DNA panel had been rendering "—" permanently while looking like a live readout.
  // These fields are from the FROZEN entry snapshot, so the profile stays leakage-free:
  //   setupVerdict 89% · holders 97% · mcUsd 73% · execStage 89% · decisionLatencyMs 89%
  //   sniperPct/bundlerPct/devPct 22% (sparse, shown but not to be over-read)
  type Pat = { peakPct?: number; holders?: number; mcUsd?: number; sniperPct?: number; bundlerPct?: number;
    devPct?: number; decisionLatencyMs?: number; setupVerdict?: string; execStage?: string; launchpad?: string };
  const pats = STORE.patterns as unknown as Pat[];
  const avg = (rows: Pat[], k: keyof Pat): number | null => { const v = rows.map((r) => r[k]).filter((x): x is number => typeof x === "number"); return v.length ? Number((v.reduce((s, n) => s + n, 0) / v.length).toFixed(1)) : null; };
  const share = (rows: Pat[], k: keyof Pat, val: string): number | null =>
    rows.length ? Math.round((rows.filter((r) => r[k] === val).length / rows.length) * 100) : null;
  const profile = (rows: Pat[]) => ({
    n: rows.length,
    holders: avg(rows, "holders"), mcUsd: avg(rows, "mcUsd"),
    sniperPct: avg(rows, "sniperPct"), bundlerPct: avg(rows, "bundlerPct"), devPct: avg(rows, "devPct"),
    entryLatencySec: (() => { const v = avg(rows, "decisionLatencyMs"); return v == null ? null : Number((v / 1000).toFixed(1)); })(),
    cleanSetupPct: share(rows, "setupVerdict", "CLEAN"),   // how often the classifier called it CLEAN
    executablePct: share(rows, "execStage", "executable"), // how often the fill was proven executable
  });
  const patterns = {
    total: pats.length,
    winnerDNA: profile(pats.filter((p) => (p.peakPct ?? 0) >= 100)), // ≥+100% peak from entry
    moonDNA: profile(pats.filter((p) => (p.peakPct ?? 0) >= 500)),   // ≥+500% (the fat tail)
    loserDNA: profile(pats.filter((p) => (p.peakPct ?? 0) < 20)),    // never really moved
    topMoons: pats.filter((p) => (p.peakPct ?? 0) >= 300).sort((a, b) => (b.peakPct ?? 0) - (a.peakPct ?? 0)).slice(0, 6)
      .map((p) => ({ peakPct: p.peakPct, holders: p.holders, mcUsd: p.mcUsd, setupVerdict: p.setupVerdict, launchpad: p.launchpad })),
  };

  // Run ledger — every completed 1-SOL trial (does the fat tail ever pay?).
  // ISOLATE to the CURRENT config hash (#5): runs from an older strategy/fee config must NOT
  // pool into this experiment's CI/expectancy. Records before hashing are treated as legacy.
  // AUDIT P0-3 quarantine list — see logs/quarantine.json for why each run is flagged.
  let quarantine: { runs: Array<{ run: number; reason: string }> } = { runs: [] };
  try { quarantine = JSON.parse(readFileSync(join(config.logDir, "quarantine.json"), "utf8")); } catch { /* no quarantine file yet */ }

  const allRunRecs = STORE.runLedger as unknown as Array<RunRec & { cfg?: string }>;
  // Filter by the TRADER's cfg, not the dashboard's — see liveTradingCfg(). With `configHash`
  // here, the moment the sniper's config diverged from the dashboard's (the 25s cohort test)
  // every NEW run vanished from this ledger while old ones stayed, which is exactly backwards.
  const traderCfg = liveTradingCfg();
  const cfgFilteredRunRecs = allRunRecs.filter((r) => r.cfg === traderCfg || (r.cfg == null && allRunRecs.every((x) => x.cfg == null)));
  // AUDIT P0-3: runs whose run-ledger SUMMARY row was computed before the executable/hypothetical
  // split existed (audit P0-2) and overlapped a known execution-simulation regression. Raw per-trade
  // logs are untouched — only these pre-fix SUMMARY rows are excluded from the tuning-facing CI.
  const quarantinedRuns = new Set<number>(quarantine.runs.map((q) => q.run));
  const runRecs = cfgFilteredRunRecs.filter((r) => r.run == null || !quarantinedRuns.has(r.run));
  const runPnls = runRecs.map((r) => r.pnlSol ?? 0);
  // ── CLEAN-EXPERIMENT STATS (#6) — is the edge REAL or noise? ──────────────────
  // A single run means nothing (one lucky winner flatters everything). Across N runs we
  // bootstrap a 90% confidence interval on the mean per-run P&L: resample the runs with
  // replacement B times, take each resample's mean, and read the 5th/95th percentiles.
  // If the CI straddles 0, we do NOT have a proven edge yet — the honest verdict.
  const avgOf = (a: number[]): number => (a.length ? a.reduce((s, n) => s + n, 0) / a.length : 0);
  function bootstrapCI(xs: number[], B = 2000): { lo: number; hi: number; mean: number } | null {
    if (xs.length < 3) return null; // too few runs to say anything
    let seed = 987654321; // deterministic (no Math.random) so the dashboard is stable within a snapshot
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const means: number[] = [];
    for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rnd() * xs.length)] ?? 0; means.push(s / xs.length); }
    means.sort((a, b) => a - b);
    return { lo: means[Math.floor(B * 0.05)] ?? 0, hi: means[Math.floor(B * 0.95)] ?? 0, mean: avgOf(xs) };
  }
  const ci = bootstrapCI(runPnls);
  const runs = {
    completed: runRecs.length,
    current: runRecs.length + 1,
    profitable: runRecs.filter((r) => (r.pnlSol ?? 0) > 0).length,
    avgFinalSol: runRecs.length ? runRecs.reduce((s, r) => s + (r.finalSol ?? 0), 0) / runRecs.length : null,
    bestSol: runRecs.length ? Math.max(...runRecs.map((r) => r.finalSol ?? 0)) : null,
    worstSol: runRecs.length ? Math.min(...runRecs.map((r) => r.finalSol ?? 0)) : null,
    avgMinSol: runRecs.length ? runRecs.reduce((s, r) => s + (r.minSol ?? 0), 0) / runRecs.length : null, // deepest drawdown avg → live-float need
    // Clean-experiment verdict: mean per-run P&L with a 90% bootstrap CI. edge:
    //   "proven-positive" (CI wholly >0), "proven-negative" (<0), or "inconclusive" (straddles 0).
    avgRunPnl: runRecs.length ? Number(avgOf(runPnls).toFixed(4)) : null,
    ci: ci ? { lo: Number(ci.lo.toFixed(4)), hi: Number(ci.hi.toFixed(4)) } : null,
    edge: ci ? (ci.lo > 0 ? "proven-positive" : ci.hi < 0 ? "proven-negative" : "inconclusive") : "need-more-runs",
    strategyVersion: config.strategyVersion, cfg: traderCfg, // frozen strategy tag + the TRADER's config hash
    // ALL runs, deliberately NOT cfg-filtered — every counter above is, and must stay, scoped to
    // one config so the CI/edge verdict compares like with like. But this list answers a different
    // question: "the balance jumped back up — was that profit or a reset?". autoReset refills the
    // float every ~300 trades, and with cfg filtering the list showed only runs from the current
    // config, so three losing runs vanished the moment the config changed and the refill read as a
    // gain. History must survive a config change; the verdict must not pool across one.
    // `sameCfg` marks which rows the verdict above actually used. Quarantined runs stay VISIBLE
    // here, flagged, rather than silently disappearing.
    recent: allRunRecs.slice(-10).reverse().map((r) => ({
      run: r.run, trades: r.trades, finalSol: r.finalSol, pnlSol: r.pnlSol, minSol: r.minSol, reason: r.reason,
      cfg: r.cfg ?? null,
      sameCfg: r.cfg == null ? null : r.cfg === traderCfg,
      measurementInvalid: r.run != null && quarantinedRuns.has(r.run) ? true : undefined,
    })),
    // Lifetime totals across EVERY run and config — the honest "how are we doing overall" number,
    // which no other field on this payload reports (all of them reset with the float or the cfg).
    lifetime: {
      runs: allRunRecs.length,
      profitable: allRunRecs.filter((r) => (r.pnlSol ?? 0) > 0).length,
      pnlSol: Number(allRunRecs.reduce((s, r) => s + (r.pnlSol ?? 0), 0).toFixed(4)),
      trades: allRunRecs.reduce((s, r) => s + (r.trades ?? 0), 0),
    },
  };
  // Counters are maintained incrementally as lines arrive (see refreshStore) — nothing here
  // scans the 18 MB decisions log any more.
  const rejectionReasons = D.rejectionReasons;
  const byMode: Record<string, number> = { "fast-follow": 0, ...D.byMode };
  const closes = trades.filter((t) => t.action === "CLOSE"); // ALL closes — hypothetical, includes would-fail
  const opens = trades.filter((t) => t.action === "OPEN");
  // AUDIT P0-2 + manual-override (2026-07-27): a "would-fail" buy is proven (by mainnet
  // simulation) to never actually land — no SOL would have moved on real chain — UNLESS a human
  // deliberately closed the position anyway (MANUAL_CLOSE/MANUAL_FLATTEN), which is real
  // regardless of what the entry simulation predicted. Every dashboard number that reads as
  // P&L, win/loss, or a tuning signal below is computed from `execCloses`/`execPartials` (this
  // qualification) only. The unfiltered `closes` above still feeds `paperHypothetical`.
  /**
   * ── "EXECUTABLE ONLY" BUTUH BUKTI, DAN BUKTINYA BISA TIDAK PERNAH DIKUMPULKAN ──
   *
   * Angka utama sengaja hanya menghitung trade yang simulasi mainnet buktikan BENAR-BENAR
   * mendarat (audit P0-2): buy would-fail tidak pernah mempertaruhkan SOL. Aturan itu benar
   * selama `execStage` memang terisi.
   *
   * Ia tidak terisi di sini. Cap `executable` ditulis oleh simulasi buy yang hanya berjalan
   * sinkron ketika execMode "simulate" DAN skipWouldFail menyala; pada execMode "dry-run"
   * keduanya tidak, jadi setiap baris ditutup dengan execStage "pending". Terukur saat ini:
   * 214 CLOSE rezim berlaku, SEMUANYA pending, sementara 3.710 baris "executable" seluruhnya
   * milik rezim pembukuan lama.
   *
   * Akibatnya panel utama menghitung NOL trade sejak mode berpindah -- angka yang terpampang
   * seluruhnya sejarah, dan tampak hidup. Itu persis mode kegagalan yang sedang diaudit.
   *
   * Menyaring habis data karena buktinya tidak pernah dikumpulkan bukan kehati-hatian, itu
   * kebutaan. Jadi: pakai kualifikasi selama ADA buktinya; kalau tidak ada sama sekali, hitung
   * semuanya dan katakan begitu, dengan lantang, di payload -- supaya layar bisa menjelaskan
   * dirinya sendiri alih-alih menampilkan nol yang misterius.
   */
  const execEvidence = closes.some((t) => {
    const st = (t as { execStage?: string }).execStage;
    return st === "executable" || st === "would-fail";
  });
  const execStageUnresolved = !execEvidence && closes.length > 0;

  const qualifyingTradeIds = new Set(
    closes
      .filter((t) => (t as { execStage?: string }).execStage === "executable" || t.reason === "MANUAL_CLOSE" || t.reason === "MANUAL_FLATTEN")
      .map((t) => (t as { tradeId?: string }).tradeId)
      .filter((id): id is string => Boolean(id)),
  );
  const execCloses = execStageUnresolved
    ? closes // buktinya tidak pernah dikumpulkan — lihat catatan di atas
    : closes.filter((t) => (t as { execStage?: string }).execStage === "executable" || t.reason === "MANUAL_CLOSE" || t.reason === "MANUAL_FLATTEN");
  // #8 entry-latency telemetry: how long from detect → entry (honest about "momentum
  // follower, not opening sniper"). Also per-mode P&L split (owner wants clean per-mode data).
  const lat = opens.map((t) => (t as { decisionLatencyMs?: number }).decisionLatencyMs).filter((x): x is number => typeof x === "number");
  const entryLatency = lat.length
    ? { n: lat.length, medianSec: Math.round((lat.slice().sort((a, b) => a - b)[Math.floor(lat.length / 2)] ?? 0) / 1000), avgSec: Math.round(lat.reduce((s, n) => s + n, 0) / lat.length / 1000) }
    : null;
  const byModePnl: Record<string, { closed: number; pnlSol: number; wins: number }> = {};
  for (const t of execCloses) {
    const m = (t as { mode?: string }).mode ?? "?";
    const b = (byModePnl[m] ??= { closed: 0, pnlSol: 0, wins: 0 });
    b.closed++; b.pnlSol += (t as { tradePnlSol?: number; pnlSol?: number }).tradePnlSol ?? t.pnlSol ?? 0;
    if (((t as { tradePnlSol?: number; pnlSol?: number }).tradePnlSol ?? t.pnlSol ?? 0) >= 0) b.wins++;
  }
  const exitReasons: Record<string, number> = {};
  for (const t of execCloses) exitReasons[t.reason ?? "?"] = (exitReasons[t.reason ?? "?"] ?? 0) + 1;

  // Authoritative ledger = positions.json (written by the paper trader). Falls
  // back to deriving from the log if the state file is absent.
  type OpenPos = { symbol: string; mode?: string; entryPrice?: number; lastPrice?: number; unrealizedPnl?: number; peak?: number; heldSec?: number; armed?: boolean; devOnlyBuys?: boolean; devBuyBack?: boolean; hasCreator?: boolean; holders?: number; marketCap?: number; marketCapSol?: number };
  const nowMs = Date.now();

  // Cumulative stats come ONLY from the append-only paper-trades log — the
  // durable source of truth that survives every restart. positions.json is
  // just the transient snapshot of currently-open positions.
  const wins = execCloses.filter((t) => (t.pnlPct ?? 0) >= 0).length;
  const ledgerClosed = execCloses.length;
  // SUM of per-trade percentages. This is NOT a portfolio return — 18 trades at −21% sum to
  // −390%, which reads as losing 3.9× the account. It is only meaningful divided by the trade
  // count (that IS expectancy). Exposed under an explicit name so it can never be read as a return.
  const sumOfTradePcts = execCloses.reduce((s, t) => s + (t.pnlPct ?? 0), 0);

  // AUDIT P0-2 — the hypothetical (unfiltered) counterparts, for comparison only. Never used
  // below to drive `paper`, tuning, or the dashboard's primary numbers.
  const hypWins = closes.filter((t) => (t.pnlPct ?? 0) >= 0).length;
  const hypLedgerClosed = closes.length;
  const hypSumOfTradePcts = closes.reduce((s, t) => s + (t.pnlPct ?? 0), 0);

  let openPositions: OpenPos[] = [];
  const statePath = join(config.logDir, "positions.json");
  if (existsSync(statePath)) {
    try {
      const st = JSON.parse(readFileSync(statePath, "utf8")) as { positions: PersistedPos[] };
      openPositions = (st.positions ?? []).map((p) => ({
        symbol: p.candidate?.symbol ?? "?", mode: p.candidate?.mode, mint: p.candidate?.mint,
        // The sniper's own candidate record sometimes carries art; when it does not, the shared
        // cache resolves it once per mint. Never a placeholder image — a wrong logo on a position
        // is worse than none, and the card falls back to the symbol's first letter.
        image: (p.candidate as { image?: string })?.image ?? artFor(p.candidate?.mint) ?? undefined,
        img: (p.candidate as { image?: string })?.image ?? artFor(p.candidate?.mint),
        entryPrice: p.entryPriceUsd, lastPrice: p.lastPriceUsd, unrealizedPnl: p.lastPnlPct, peak: p.peakPriceUsd,
        // MARK vs YANG AKAN DIBAYAR. `unrealizedPnl` adalah mark paper apa adanya — dan mark
        // paper pada token yang sedang bergerak justru yang terbukti tidak bisa dieksekusi:
        // klaim 50-100% cair ~66%, klaim di atas 100% cair ~10%. Kartu bertuliskan +120% BUKAN
        // +120% yang akan diterima. Koreksinya sengaja tidak menyentuh keputusan exit (itu
        // suntingan strategi, bukan tampilan), jadi angka ini murni untuk dibaca manusia.
        unrealizedPnlAdj: typeof p.lastPnlPct === "number"
          ? Number(applyExecutionRealism(p.lastPnlPct).pct.toFixed(1)) : undefined,
        heldSec: p.openedAt ? Math.round((nowMs - p.openedAt) / 1000) : undefined, armed: p.armed,
        sizeSol: config.risk.paperTradeSizeSol,
        ...exitProximity({
          peakPct: (p.entryPriceUsd ?? 0) > 0 ? Number((((p.peakPriceUsd || p.entryPriceUsd!) / p.entryPriceUsd!) * 100 - 100).toFixed(1)) : 0,
          fromPeakPct: (p.peakPriceUsd ?? 0) > 0 ? Number((((p.lastPriceUsd ?? p.entryPriceUsd!) / p.peakPriceUsd!) * 100 - 100).toFixed(1)) : 0,
          engine: "S1",
        }),
        graduated: p.graduated,
        // Report the REAL tier progress. `partialsTaken` is a frozen legacy field (always 0);
        // `scaleTier` is the index of the highest ladder tier actually sold, so +1 is the count.
        partialsTaken: ((p as { scaleTier?: number }).scaleTier ?? -1) + 1,
        devOnlyBuys: p.devOnlyBuys, devBuyBack: p.devBuyBack, hasCreator: Boolean(p.candidate?.creator),
        holders: p.candidate?.holders, marketCap: p.candidate?.marketCapUsd, marketCapSol: p.candidate?.marketCapSol,
        deRisked: (p as { deRisked?: boolean }).deRisked, // scale-out done → house money
        coordinated: (p.candidate as { rugCluster?: { coordinated?: boolean } })?.rugCluster?.coordinated, // rug-cluster flag
        rawScore: (p.candidate as { rawScore?: number })?.rawScore, // uncapped gate score
        velSol: (p.candidate as { confirmStats?: { velSol?: number } })?.confirmStats?.velSol, // entry inflow velocity
      }));
    } catch { /* transient file — ignore if unreadable */ }
  }

  // Concrete SOL accounting (per-trade size × pct), plus the configured float.
  const tradeSizeSol = config.risk.paperTradeSizeSol;
  const floatSol = config.risk.startingFloatSol;
  const partials = trades.filter((t) => t.action === "PARTIAL"); // ALL partials — hypothetical
  // PARTIAL records always carry reason:"SCALE_OUT_LADDER" (never "MANUAL_CLOSE" — the manual
  // decision only happens at the final close), so a partial's own execStage isn't the deciding
  // factor once its position later gets manually closed. Join by tradeId against the CLOSE-level
  // qualification computed above instead of checking the partial's own execStage in isolation.
  const execPartials = partials.filter((t) => {
    const id = (t as { tradeId?: string }).tradeId;
    if (execStageUnresolved) return true; // sama alasannya dengan execCloses di atas
    return id ? qualifyingTradeIds.has(id) : (t as { execStage?: string }).execStage === "executable";
  });
  // Realized SOL = remaining-leg SOL from every close + every banked partial-TP. EXECUTABLE ONLY
  // (audit P0-2) — a would-fail buy never actually put SOL at risk on real chain.
  const realizedSol =
    execCloses.reduce((s, t) => s + (t.pnlSol ?? (t.sizeSol ?? tradeSizeSol) * ((t.pnlPct ?? 0) / 100)), 0) +
    execPartials.reduce((s, t) => s + (t.pnlSol ?? 0), 0);
  const hypRealizedSol =
    closes.reduce((s, t) => s + (t.pnlSol ?? (t.sizeSol ?? tradeSizeSol) * ((t.pnlPct ?? 0) / 100)), 0) +
    partials.reduce((s, t) => s + (t.pnlSol ?? 0), 0);

  // Equity curve: running SOL balance after each realized event, chronologically. EXECUTABLE ONLY.
  const equityEvents = [...execCloses, ...execPartials].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  let running = floatSol;
  const equity: Array<{ t: string; bal: number }> = [{ t: "", bal: floatSol }];
  for (const e of equityEvents) {
    running += e.pnlSol ?? (e.sizeSol ?? tradeSizeSol) * ((e.pnlPct ?? 0) / 100);
    equity.push({ t: e.ts, bal: Number(running.toFixed(4)) });
  }
  const balanceSol = floatSol + realizedSol; // current paper equity
  const compounding = config.risk.compound;

  // P&L statistics (from closed trades, net of cost) — EXECUTABLE ONLY (audit P0-2).
  const winPnls = execCloses.filter((t) => (t.pnlPct ?? 0) >= 0).map((t) => t.pnlPct ?? 0);
  const lossPnls = execCloses.filter((t) => (t.pnlPct ?? 0) < 0).map((t) => t.pnlPct ?? 0);
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const pnlStats = {
    avgWin: mean(winPnls), avgLoss: mean(lossPnls),
    best: execCloses.length ? Math.max(...execCloses.map((t) => t.pnlPct ?? 0)) : 0,
    worst: execCloses.length ? Math.min(...execCloses.map((t) => t.pnlPct ?? 0)) : 0,
    expectancy: ledgerClosed ? sumOfTradePcts / ledgerClosed : 0, // avg % per trade — the valid reading
  };

  // Gate funnel + dev-signal summary
  const funnel = { gated: D.total, passed: D.passed, bought: D.bought };
  const devSummary = {
    onlyBuys: openPositions.filter((p) => p.devOnlyBuys).length,
    buyBack: openPositions.filter((p) => p.devBuyBack && !p.devOnlyBuys).length,
    watched: openPositions.filter((p) => p.hasCreator && !p.devOnlyBuys && !p.devBuyBack).length,
    unknown: openPositions.filter((p) => !p.hasCreator).length,
    dumpEvents: E.counts["dev-dump"] ?? 0,
    buybackEvents: E.counts["dev-buyback"] ?? 0,
    onlyBuysEvents: E.counts["dev-only-buys"] ?? 0,
  };

  // Execution-simulation summary (only populated in simulate mode): how many
  // real pump.fun buy txs were built and whether they'd LAND on mainnet.
  const execEvents = E.execSim.all() as Array<{ symbol?: string; stage?: string; built?: boolean; wouldLand?: boolean; err?: string; needsFunding?: boolean; ts?: string }>;
  const stageOf = (e: { stage?: string; built?: boolean; wouldLand?: boolean; needsFunding?: boolean }): string =>
    e.stage ?? (!e.built ? "theoretical" : e.needsFunding ? "tx-built" : e.wouldLand ? "executable" : "would-fail");
  const execLadder = E.execLadder; // #2 EXECUTABLE LADDER — counted incrementally, never pooled with theoretical
  const execSim = {
    total: E.counts["exec-sim"] ?? 0,
    ladder: execLadder, // theoretical → tx-built(unfunded) → would-fail → executable
    executable: execLadder.executable, // proven would-land on mainnet sim (the real subset)
    needsFunding: execLadder["tx-built"], // built but wallet unfunded → fund ~0.05 SOL to validate
    wouldFail: execLadder["would-fail"], // simulated but reverts (honeypot/bad)
    // funded = the RECENT sims actually ran (not stuck on needs-funding). Uses the last 8
    // events so old pre-funding tx-built records don't keep the flag false forever.
    funded: execEvents.slice(-8).some((e) => { const s = stageOf(e); return s === "executable" || s === "would-fail"; })
      && !execEvents.slice(-8).every((e) => stageOf(e) === "tx-built"),
    recent: execEvents.slice(-15).reverse().map((e) => ({ ts: e.ts, symbol: e.symbol ?? "?", status: stageOf(e), err: e.err })),
  };

  // Feeling Agent (LLM vibe judge) live summary — powers the "flow with an agent"
  // panel. Non-sensitive: symbol + verdict only.
  const vibeEvents = E.vibe.all() as Array<{ symbol?: string; vibe?: string; confidence?: number; reason?: string; ts?: string }>;
  const vibeCount = (v: string) => vibeEvents.filter((e) => e.vibe === v).length; // over the recent window
  const lastVibe = vibeEvents[vibeEvents.length - 1];
  // Live agent HEALTH (#5) — written by the bot process to logs/agent-health.json.
  // down=true → the mechanical fallback net is driving exits (dashboard shows a DOWN badge).
  let health: { enabled?: boolean; alive?: boolean; lastSuccessAt?: number; consecutiveFailures?: number; lastError?: string } = {};
  try { health = JSON.parse(readFileSync(join(config.logDir, "agent-health.json"), "utf8")); } catch { /* no health file yet */ }
  const feeling = {
    enabled: Boolean(config.feeling.url && config.feeling.key),
    model: config.feeling.model,
    calls: E.counts["vibe"] ?? 0,
    alive: vibeCount("alive"),
    dying: vibeCount("dying"),
    dead: vibeCount("dead"),
    exits: (exitReasons["FEELING"] ?? 0),
    // agent liveness (distinct from the "alive/dying/dead" VIBE verdicts above)
    health: {
      // trustworthy until proven otherwise: no health file yet (agent not called) → assume up if enabled
      up: health.alive ?? Boolean(config.feeling.url && config.feeling.key),
      enabled: health.enabled ?? Boolean(config.feeling.url && config.feeling.key),
      // FALL BACK TO THE VERDICT ITSELF. `agent-health.json` is written by the BOT process, and
      // when the relay is failing it never records a success — so `lastSuccessAt` sits at 0, which
      // `?? null` then passes through as "no age known" and the dashboard renders a green LIVE
      // badge over a verdict that is hours old. Measured 2026-08-04: last real verdict 12.3 hours
      // earlier, badge still LIVE. The newest `vibe` event IS a success, by definition — it only
      // exists because a call returned — so it is the more trustworthy clock of the two.
      lastSuccessAt: (health.lastSuccessAt || 0) > 0
        ? health.lastSuccessAt!
        : (lastVibe?.ts ? Date.parse(String(lastVibe.ts)) || null : null),
      consecutiveFailures: health.consecutiveFailures ?? 0,
      lastError: health.lastError ?? null,
      fallbackExits: (exitReasons["FALLBACK_STOP"] ?? 0) + (exitReasons["FALLBACK_DEVDUMP"] ?? 0),
    },
    last: lastVibe ? { symbol: lastVibe.symbol ?? "?", vibe: lastVibe.vibe, confidence: lastVibe.confidence, reason: lastVibe.reason, ts: lastVibe.ts } : null,
    recent: vibeEvents.slice(-8).reverse().map((e) => ({ symbol: e.symbol ?? "?", vibe: e.vibe, confidence: e.confidence, reason: e.reason, ts: e.ts })),
  };
  // ── AGENT DECISION FEED ─────────────────────────────────────────────────────
  // The companion face used to react ONLY to LLM verdicts. Those are rare by design (the agent
  // is limited to de-risked runners — 1.5% of trades) and were failing outright until the token
  // budget was fixed, so the face sat frozen at its default and never spoke. But the bot IS
  // deciding constantly — mechanically. Those decisions are the real "expression", so the feed
  // merges LLM verdicts with mechanical actions and the server publishes a ready-made
  // mood + one-line utterance. The UI stays dumb: it just renders what it is handed.
  type Beat = { ts: string; mood: "alive" | "dying" | "dead"; say: string; kind: string; symbol: string };
  const MOOD: Record<string, "alive" | "dying" | "dead"> = {
    DEV_DUMP: "dead", CATASTROPHIC: "dead", LIQUIDITY_GONE: "dead", SETUP_TOXIC_LATE: "dead", FALLBACK_DEVDUMP: "dead",
    NO_DEVELOPMENT: "dying", FALLBACK_STOP: "dying", STALE: "dying", MAX_HOLD: "dying",
    RUN_RESET: "dying", MANUAL_FLATTEN: "dying", MANUAL_CLOSE: "dying",
    TRAIL_LOCK: "alive", GRADUATED: "alive",
  };
  const pctTxt = (v: unknown): string => (typeof v === "number" ? `${v >= 0 ? "+" : ""}${Math.round(v)}%` : "");
  const phraseFor = (reason: string, sym: string, pnl: unknown): string => {
    switch (reason) {
      case "DEV_DUMP": return `${sym}: dev dump — kabur sekarang`;
      case "CATASTROPHIC": return `${sym}: ${pctTxt(pnl)} — stop darurat`;
      case "LIQUIDITY_GONE": return `${sym}: likuiditas habis, rug`;
      case "SETUP_TOXIC_LATE": return `${sym}: setup toxic, batal`;
      case "NO_DEVELOPMENT": return `${sym}: 90 detik tak bergerak, lepas`;
      case "FALLBACK_STOP": return `${sym}: ${pctTxt(pnl)} — jaring mekanis`;
      case "STALE": return `${sym}: tak bisa dibaca, tutup`;
      case "MAX_HOLD": return `${sym}: kelamaan, lepas`;
      case "TRAIL_LOCK": return `${sym}: kunci profit ${pctTxt(pnl)}`;
      case "GRADUATED": return `${sym}: graduated ${pctTxt(pnl)}`;
      case "MANUAL_FLATTEN": case "MANUAL_CLOSE": return `${sym}: ditutup dari konsol`;
      default: return `${sym}: ${reason.toLowerCase().replace(/_/g, " ")} ${pctTxt(pnl)}`.trim();
    }
  };
  const beats: Beat[] = [];
  for (const t of trades.slice(-40)) {
    const rec = t as unknown as Record<string, unknown>;
    const sym = String(rec.symbol ?? "?");
    const ts = String(rec.ts ?? "");
    if (rec.action === "CLOSE") {
      const reason = String(rec.reason ?? "?");
      beats.push({ ts, mood: MOOD[reason] ?? "dying", say: phraseFor(reason, sym, rec.pnlPct), kind: reason, symbol: sym });
    } else if (rec.action === "PARTIAL") {
      beats.push({ ts, mood: "alive", say: `${sym}: ambil partial di ${pctTxt(rec.atGainPct)}`, kind: "SCALE_OUT", symbol: sym });
    } else if (rec.action === "OPEN") {
      const mc = typeof rec.curveMcSol === "number" ? ` @ ${(rec.curveMcSol as number).toFixed(0)}◎` : "";
      beats.push({ ts, mood: "alive", say: `${sym}: masuk${mc}`, kind: "OPEN", symbol: sym });
    }
  }
  for (const v of vibeEvents) { // LLM verdicts still speak, in their own voice
    const vibe = String(v.vibe ?? "alive");
    beats.push({ ts: String(v.ts ?? ""), mood: vibe === "dead" || vibe === "dying" ? (vibe as "dead" | "dying") : "alive",
      say: `${v.symbol ?? "?"}: ${v.reason ?? vibe}`, kind: "LLM", symbol: String(v.symbol ?? "?") });
  }
  beats.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const agent = { last: beats[beats.length - 1] ?? null, recent: beats.slice(-10).reverse() };

  // ── AGENT SCORECARD — is the LLM actually any good, measured the only valid way ──
  // The agent has NO memory: every judgeVibe() call is stateless, so it cannot learn from its own
  // mistakes. The only way it improves is if WE measure it and change the prompt or its mandate.
  //
  // The obvious measurement is a trap. Comparing "P&L when the agent said dead" to "P&L at close"
  // scores it as almost always wrong — because a confident bearish call CLOSES the position, so no
  // time remains for the price to move and the delta is ~0 by construction. (Measured that way the
  // agent looked 3.7% accurate on `dead`, which is an artefact, not a result.)
  //
  // The valid counterfactual is the post-exit tracker: after ANY exit we keep sampling the token
  // for 45 minutes. If it ran hard after we sold, the exit was premature — whoever made it. That
  // scores agent exits against mechanical exits on identical terms.
  const medOf = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
  const postByMint = new Map<string, number>();
  for (const p of STORE.postExit as Array<Record<string, unknown>>) {
    const m = p.mint as string | undefined, rise = p.maxRiseAfterExitPct;
    if (m && typeof rise === "number") postByMint.set(m, rise);
  }
  const prematureBy = new Map<string, number[]>();
  for (const t of trades) {
    const r = t as unknown as Record<string, unknown>;
    if (r.action !== "CLOSE") continue;
    const rise = postByMint.get(r.mint as string);
    if (rise == null) continue;
    const k = String(r.reason ?? "?");
    (prematureBy.get(k) ?? prematureBy.set(k, []).get(k)!).push(rise);
  }
  const exitQuality = [...prematureBy.entries()]
    .filter(([, v]) => v.length >= 3)
    .map(([reason, v]) => ({
      reason, n: v.length,
      medianRiseAfterPct: Number(medOf(v).toFixed(1)),
      ranHardPct: Math.round((v.filter((x) => x >= 50).length / v.length) * 100), // ≥+50% after we sold
    }))
    .sort((a, b) => b.ranHardPct - a.ranHardPct);
  const agentVerdicts = E.vibe.all() as Array<Record<string, unknown>>;
  const agentScorecard = {
    decisions: E.counts["vibe"] ?? 0,
    stateless: true, // judgeVibe carries no history — it CANNOT self-improve; only the prompt/mandate can
    verdictMix: agentVerdicts.reduce<Record<string, number>>((a, v) => { const k = String(v.vibe ?? "?"); a[k] = (a[k] ?? 0) + 1; return a; }, {}),
    shadowOnly: agentVerdicts.filter((v) => v.shadow === true).length, // judged but not allowed to act
    // Compare agent exits to mechanical ones on the SAME premature-exit metric.
    exitQuality,
    note: "ranHardPct = share of exits where the coin still rose ≥50% afterwards. Lower is better. Compare FEELING (agent) against the mechanical rows.",
  };

  // Exit-guard breakdown: which mechanism closed each trade (the HOLD→EXIT flow).
  const partialCount = trades.filter((t) => (t as { action?: string }).action === "PARTIAL").length;
  const flow = {
    held: openPositions.length,
    partials: partialCount,
    guards: [
      { key: "GRADUATED", label: "Graduated", n: exitReasons["GRADUATED"] ?? 0, kind: "profit" },
      { key: "TRAIL_LOCK", label: "Trailing lock", n: exitReasons["TRAIL_LOCK"] ?? 0, kind: "profit" }, // trader writes TRAIL_LOCK (was mislabeled TRAILING_STOP → always 0)
      { key: "SCALE_OUT", label: "Scale-out (banked principal)", n: partialCount, kind: "profit" }, // de-risk partials
      { key: "FEELING", label: "Feeling Agent", n: exitReasons["FEELING"] ?? 0, kind: "agent" },
      { key: "NO_DEVELOPMENT", label: "No development (90s)", n: exitReasons["NO_DEVELOPMENT"] ?? 0, kind: "guard" }, // capital-stuck cut
      { key: "FALLBACK_STOP", label: "Fallback Stop (agent down)", n: exitReasons["FALLBACK_STOP"] ?? 0, kind: "guard" },
      { key: "CATASTROPHIC", label: "Catastrophic guard", n: exitReasons["CATASTROPHIC"] ?? 0, kind: "guard" }, // always-on hard floor
      // Dev-dump is now a MECHANICAL fast escape off the WebSocket push (no LLM in the path), so
      // the legacy FALLBACK_DEVDUMP rows from the old agent-gated behaviour fold in here.
      { key: "DEV_DUMP", label: "Dev dump (fast escape)", n: (exitReasons["DEV_DUMP"] ?? 0) + (exitReasons["FALLBACK_DEVDUMP"] ?? 0), kind: "guard" },
      { key: "SETUP_TOXIC_LATE", label: "Setup toxic (post-entry)", n: exitReasons["SETUP_TOXIC_LATE"] ?? 0, kind: "guard" },
      { key: "LIQUIDITY_GONE", label: "Rug / Drained", n: exitReasons["LIQUIDITY_GONE"] ?? 0, kind: "guard" },
      { key: "STALE", label: "Stale (no price)", n: exitReasons["STALE"] ?? 0, kind: "guard" },
      { key: "MAX_HOLD", label: "Max Hold", n: exitReasons["MAX_HOLD"] ?? 0, kind: "metric" },
    ],
  };

  // Devnet execution mirror — proves the real sign→send→confirm pipeline is live.
  const devExec = E.devnet.all() as Array<{ kind?: string; symbol?: string; ok?: boolean; sig?: string; ms?: number; signMs?: number; needsFunding?: boolean; err?: string; ts?: string }>;
  const devConfirmed = devExec.filter((e) => e.ok);
  const execLive = {
    venue: "devnet" as const,
    fired: devExec.length,
    confirmed: devConfirmed.length,
    failed: devExec.filter((e) => !e.ok && !e.needsFunding).length,
    needsFunding: devExec.filter((e) => e.needsFunding).length,
    avgSignMs: devConfirmed.length ? Math.round(devConfirmed.reduce((a, e) => a + (e.signMs ?? 0), 0) / devConfirmed.length) : null,
    avgMs: devConfirmed.length ? Math.round(devConfirmed.reduce((a, e) => a + (e.ms ?? 0), 0) / devConfirmed.length) : null,
    lastSig: devConfirmed.length ? devConfirmed[devConfirmed.length - 1]!.sig : null,
    recent: devExec.slice(-8).reverse().map((e) => ({ ts: e.ts, kind: e.kind, symbol: e.symbol ?? "?", ok: Boolean(e.ok), needsFunding: Boolean(e.needsFunding), ms: e.ms, sig: e.sig, err: e.err })),
  };

  // Momentum-checkpoint funnel: how many launches were watched, dropped as dead,
  // or CONFIRMED (real accelerating buying) before entry — the anti-blind-snipe.
  const momentum = {
    confirmed: E.counts["momentum-confirm"] ?? 0,
    telemetry: E.counts["momentum-telemetry"] ?? 0, // setup mode: momentum observes, never enters
    dropped: E.counts["momentum-drop"] ?? 0,
    recent: (E.momentum.last(6) as Array<{ symbol?: string; grownPct?: number; accel?: number; ageSec?: number; ts?: string; buyPressurePct?: number; uniqueBuyers?: number; netBuyVolSol?: number }>).reverse().map((e) => ({ symbol: e.symbol ?? "?", grownPct: e.grownPct, accel: e.accel, ageSec: e.ageSec, ts: e.ts, buyPressurePct: e.buyPressurePct, uniqueBuyers: e.uniqueBuyers, netBuyVolSol: e.netBuyVolSol })),
  };

  // ── ENTRY LATENCY BREAKDOWN — where detect→entry actually goes ──
  // preMs = settle + time queued waiting for a worker (the RPC-saturation symptom),
  // gateMs = the gate itself, openMs = entry work. Reported over a recent window so the
  // effect of the RPC-priority fix is visible immediately instead of averaged into history.
  const latRows = E.latency.all();
  const pick = (k: "preMs" | "gateMs" | "openMs" | "totalMs", rows: typeof latRows): number | null => {
    const v = rows.map((r) => r[k]).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    return v.length ? Math.round((v[Math.floor(v.length / 2)] ?? 0) / 100) / 10 : null; // median, seconds 1dp
  };
  const last20 = latRows.slice(-20);
  const latencyBreakdown = latRows.length ? {
    n: latRows.length,
    allTime: { pre: pick("preMs", latRows), gate: pick("gateMs", latRows), open: pick("openMs", latRows), total: pick("totalMs", latRows) },
    recent: { n: last20.length, pre: pick("preMs", last20), gate: pick("gateMs", last20), open: pick("openMs", last20), total: pick("totalMs", last20) },
  } : null;

  const control = readControl();
  return {
    now: new Date().toISOString(),
    mode: config.mode,
    usingPublicRpc: config.usingPublicRpc,
    control, // { paused, execMode } — driven from the console
    /**
     * ONE BANKROLL, in USD (owner, 2026-08-01: "saldo itu satu, sol usdnya berapa convertnya,
     * jadi bisa baca, gunakan 1 dompet, pisahkan datanya koin ini pakai scout apa sniper").
     *
     * The two strategies were being reported as two separate accounts in two different
     * currencies — Strategy 1 in SOL, Strategy 2 in USD — with the headline showing only one of
     * them while the trade journal listed both. Wins scrolled past while the displayed balance
     * never moved, which reads as a dead dashboard. It was not dead: it was answering a different
     * question than the one being asked.
     *
     * Money is combined here at the live SOL price; STRATEGY stays a property of each trade, not
     * of a separate wallet. `solUsd` is echoed so the UI can show the rate it converted at rather
     * than implying a precision the conversion does not have.
     */
    combined: (() => {
      const rate = solUsd;
      const s2p = strategy2PaperStats();
      const s2Full = buildStrategy2Primary();
      const s1Bal = balanceSol, s1Float = floatSol;
      const s2Bal = s2p?.equityUsd ?? 0, s2Float = s2p?.startingFloatUsd ?? 0;
      const s1Wins = wins, s1Losses = ledgerClosed - wins, s1Open = openPositions.length;
      const s2Wins = s2p?.wins ?? 0, s2Losses = s2p?.losses ?? 0, s2Open = s2p?.openPositions.length ?? 0;
      // Without a live rate the SOL leg cannot be honestly valued — report null rather than
      // silently pricing it at zero or at a stale constant.
      if (rate == null || !(rate > 0)) {
        return { solUsd: null, totalUsd: null, floatUsd: null, pnlUsd: null, pnlPct: null,
          wins: 0, losses: 0, winRate: 0, open: 0,
          s1: { balanceUsd: null, floatUsd: null, balanceSol: s1Bal, floatSol: s1Float, wins: s1Wins, losses: s1Losses, open: s1Open },
          s2: { balanceUsd: s2Bal, floatUsd: s2Float, wins: s2Wins, losses: s2Losses, open: s2Open },
          equity: [] as Array<{ bal: number }> };
      }
      const s1Usd = s1Bal * rate, s1FloatUsd = s1Float * rate;
      /**
       * COMBINED equity curve — the two legs merged on wall-clock time.
       *
       * Without this the headline said one thing and the chart beside it said another: the Hero
       * showed the combined $892.48 while the equity panel still drew Strategy 2's $781.16, so
       * two balances sat side by side again — the exact problem combining the wallet was meant to
       * end.
       *
       * Both series are step functions (a balance holds until the next close), so the merge walks
       * every timestamp from either leg and carries the last known value of the other forward.
       * NOTE the honest limitation: the SOL leg is valued at the CURRENT rate across its whole
       * history, not the rate at each moment — the per-close SOL/USD price was never recorded.
       * For a paper bankroll that is a small distortion, but it is a real one, so it is stated
       * rather than hidden.
       */
      const s1Curve = (equity as Array<{ t?: string; bal: number }>).filter((e) => typeof e.bal === "number");
      const s2Curve = (s2Full?.equityTs ?? []) as Array<{ t: string; bal: number }>;
      const stamps = [...new Set([...s1Curve.map((e) => e.t ?? ""), ...s2Curve.map((e) => e.t)])]
        .filter(Boolean).sort();
      let i1 = 0, i2 = 0;
      let last1 = s1Curve[0]?.bal ?? s1Float;
      let last2 = s2Curve[0]?.bal ?? s2Float;
      const combinedEquity: Array<{ bal: number }> = [];
      for (const t of stamps) {
        while (i1 < s1Curve.length && (s1Curve[i1]!.t ?? "") <= t) { last1 = s1Curve[i1]!.bal; i1++; }
        while (i2 < s2Curve.length && s2Curve[i2]!.t <= t) { last2 = s2Curve[i2]!.bal; i2++; }
        combinedEquity.push({ bal: Number((last1 * rate + last2).toFixed(2)) });
      }
      const totalUsd = s1Usd + s2Bal, floatUsd = s1FloatUsd + s2Float;
      const allWins = s1Wins + s2Wins;
      const allLosses = s1Losses + s2Losses;
      return {
        solUsd: Number(rate.toFixed(2)),
        totalUsd: Number(totalUsd.toFixed(2)), floatUsd: Number(floatUsd.toFixed(2)),
        pnlUsd: Number((totalUsd - floatUsd).toFixed(2)),
        pnlPct: floatUsd > 0 ? Number(((totalUsd - floatUsd) / floatUsd * 100).toFixed(2)) : null,
        wins: allWins, losses: allLosses, winRate: allWins + allLosses ? allWins / (allWins + allLosses) : 0,
        open: s1Open + s2Open,
        s1: { balanceUsd: Number(s1Usd.toFixed(2)), floatUsd: Number(s1FloatUsd.toFixed(2)), balanceSol: s1Bal, floatSol: s1Float, wins: s1Wins, losses: s1Losses, open: s1Open },
        s2: { balanceUsd: Number(s2Bal.toFixed(2)), floatUsd: Number(s2Float.toFixed(2)), wins: s2Wins, losses: s2Losses, open: s2Open },
        equity: combinedEquity.length ? combinedEquity : [{ bal: Number((s1Usd + s2Bal).toFixed(2)) }],
      };
    })(),
    system: {
      dryRun: control.execMode === "dry-run",
      rpcTier: config.usingPublicRpc ? "Public RPC (throttled)" : "Helius + FluxRPC backup",
      rugcheckKey: Boolean(config.rugcheckApiKey),
      jupiterKey: Boolean(config.jupiterApiKey),
      snipeMaxMcSol: config.gate.snipeMaxEntryMcSol,
      solscanBlockHeight: chainCache.blockHeight, // Solscan /chaininfo (network status)
      solscanEpoch: chainCache.epoch,
      solUsd, // live SOL/USD so the UI never hard-codes a stale price
      uptimeSec: Math.round((nowMs - SERVER_START) / 1000),
      sniperAlive: sniperAlive(), // ground truth: is src/index.ts actually running right now?
      strategy2Alive: strategy2Alive(), // ground truth for the now-primary strategy's own feed/pipeline badges
    },
    totals: {
      gated: D.total, passed: D.passed, rejected: D.rejected,
      passRate: D.total ? D.passed / D.total : 0,
      launches: E.counts["launch"] ?? 0,
      takeovers: E.counts["community-takeover"] ?? 0,
    },
    // ── DIAGNOSTICS the dashboard was blind to ──
    rpc: rpcHealth(), // live RPC budget from the trader process — the number that explains latency
    strategy2Paper: strategy2PaperStats(), // Strategy-2's own USD equity — separate from the sniper's SOL ledger, for direct comparison
    /**
     * DIKIRIM HANYA KALAU S2 BENAR-BENAR HIDUP (2026-08-18).
     *
     * Frontend memakai `isS2 = !!data.strategy2Primary` untuk memutuskan strategi mana yang jadi
     * utama — pilihan yang benar SELAMA S2 berjalan. Tapi S2 dimatikan permanen hari ini (EV
     * -6,2% konsisten, float kertas $1000 -> $520), dan objek ini tetap dikirim, sehingga SELURUH
     * halaman melaporkan status S2 yang sudah mati: badge ARCHIVED, banner TRADER BERHENTI, dan
     * angka utama membeku — padahal sniper sehat penuh dan terus berdagang.
     *
     * Alarm palsu yang menetap melatih orang mengabaikan peringatan, jadi ia lebih berbahaya
     * daripada tidak ada peringatan sama sekali. Dengan dihilangkan saat S2 mati, frontend
     * otomatis jatuh kembali ke sniper sebagai strategi utama — TopBar, StaleBanner, dan hero
     * ikut benar tanpa perubahan di sana. Begitu S2 dihidupkan lagi, objeknya kembali sendiri.
     */
    strategy2Primary: strategy2Alive() ? buildStrategy2Primary() : undefined,
    // LANE ROBINHOOD (2026-10-07): ikut di payload SSE supaya panel update PUSH setiap state
    // ditulis (mark 30 detik) — bukan polling. Cache internal 4 detik; murah (state kecil +
    // log harian + 2 file laporan). GMGN TIDAK ikut di sini karena sumbernya file events besar.
    laneRobinhood: buildRobinhoodPaper(),
    // KESEHATAN LANE (2026-10-09): sebelumnya kartu status di dashboard HARDCODE "AKTIF" — kalau
    // lane mati, kartunya tetap hijau (dashboad bisa berbohong). Ini dihitung dari mtime berkas
    // state yang ditulis tiap siklus: murah (statSync), tanpa membaca isi, tanpa kuota API.
    laneHealth: buildLaneHealth(),
    // LANE BARU (2026-10-08): DexScreener (13 endpoint + 6 stream WS realtime) dan OKX strict-paper
    // (uang kertas + verifikasi hash-chain ledger). Keduanya ikut payload SSE supaya panel ikut push
    // saat state ditulis; cache internal masing-masing 4 detik (ledger 60 detik).
    laneDex: buildDexOverview(),
    laneOkxPaper: buildOkxPaper(),
    latencyBreakdown, // where detect→entry time actually goes
    setupToxicCodes: D.setupToxicCodes, // which toxic verdict is doing the filtering
    // Launches dropped at the create event by the launch-MC floor — they never reached the
    // decisions log, so they are invisible in the funnel unless counted here.
    launchMcSkip: { n: E.counts["launch-mc-skip"] ?? 0, floor: config.gate.launchMcFloorSol },
    // TRADING-PATH STALL — the failure the dashboard could not see.
    //
    // On 2026-08-07 the bot spent 4 hours not trading while every liveness signal stayed green:
    // the process was up, logs were being written, the heartbeat was fresh. What had actually
    // happened was that every stage AFTER launch intake stopped — the RPC concurrency semaphore
    // deadlocked at inFlight 4/4 with rps 0 — so `launch` events kept flowing while no decision
    // was ever made. Uptime and heartbeat are the wrong questions; the right one is whether
    // intake is still producing output.
    stall: (() => {
      const lastLaunch = E.lastLaunchAt ?? 0;
      const lastDecision = STORE.decisions.lastAt ?? 0;
      const now = Date.now();
      const launchAgeSec = lastLaunch ? Math.round((now - lastLaunch) / 1000) : null;
      const decisionAgeSec = lastDecision ? Math.round((now - lastDecision) / 1000) : null;
      const h = rpcHealth() as { inFlight?: number; maxConcurrent?: number; rps?: number } | null;
      const deadlocked = !!h && (h.maxConcurrent ?? 0) > 0 && (h.inFlight ?? 0) >= (h.maxConcurrent ?? 0) && (h.rps ?? 0) === 0;
      // Only meaningful while launches ARE arriving: a quiet market is not a stall.
      const intakeLive = launchAgeSec != null && launchAgeSec < 180;
      const starved = intakeLive && decisionAgeSec != null && decisionAgeSec > 600;
      return {
        launchAgeSec, decisionAgeSec, deadlocked, starved,
        stalled: deadlocked || starved,
      };
    })(),
    pipeline: {
      // The sniper's own launch stream is counted from `launch` events; each scout feed reports
      // its unique-mint tally. A feed that has gone silent stays in the list at 0 — it is dropped
      // from the DRAWING only if we choose to, never from the data.
      sources: [
        { n: "pumpportal", d: "WebSocket launch", v: E.counts["launch"] ?? 0, eng: "S1" },
        ...["new-launch-dev-holding", "gmgn-trending", "solana-tracker-trending"].map((k) => ({
          n: k === "new-launch-dev-holding" ? "new-launch dev-holding" : k.replace("-trending", ""),
          d: "polling",
          v: E.sourceMints[k]?.size ?? 0,
          eng: "S2",
        })),
      ],
      skip: { "MC di luar band": E.counts["launch-mc-skip"] ?? 0, ...E.skipReasons },
      // Lifetime on BOTH sides, so the funnel reconciles: every position counted at the gate is a
      // position whose exit is counted on the way out.
      exits: E.exitReasonsAll,
      gated: funnel.gated,
      bought: E.opensAll,
      openNow: E.opensAll - E.closesAll,
      passedS2: 0,
    },
    bandWatch: (() => {
      const cfgBand = config.gate.entryMcBandSol;
      // Five purchases is enough to place a window whose edges are hard limits; below that the
      // The window is read from what the bot ACTUALLY BOUGHT, never from this process's own env:
      // ENTRY_MC_FLOOR_SOL/CEIL are exported inside run-sniper-supervised.sh, so only the trader
      // sees them and the dashboard would otherwise draw its defaults (30-45) over a trader
      // running 55-100. What the trader bought cannot drift from what the trader bought.
      const entries = D.bandEntries.all();
      const mcs = entries.map((e) => e.mcSol);
      const observed = mcs.length >= 5;
      const floor = observed ? Math.floor(Math.min(...mcs)) : cfgBand.floor;
      const ceil = observed ? Math.ceil(Math.max(...mcs)) : cfgBand.ceiling;
      const launches = D.bandLaunch.all();
      return {
        floorSol: floor, ceilSol: ceil,
        source: observed ? "teramati" : "config",
        cfgFloorSol: cfgBand.floor, cfgCeilSol: cfgBand.ceiling,
        drift: observed && (floor < cfgBand.floor - 1 || ceil > cfgBand.ceiling + 1),
        launchMcSol: 27.96,   // every pump.fun curve is born here, by construction
        // Where coins are BORN vs where the bot BUYS. Median of each is the headline: today 33.8
        // at detection against 66.5 at execution, i.e. the band is reached by growth, not by
        // picking coins that launched high.
        launchMedian: launches.length ? [...launches].sort((a, b) => a - b)[Math.floor(launches.length / 2)] : null,
        entryMedian: mcs.length ? [...mcs].sort((a, b) => a - b)[Math.floor(mcs.length / 2)] : null,
        launches: launches.slice(-240),
        entries: entries.slice(-24).reverse().map((e) => ({
          ...e, img: artFor(e.mint),
          ageSec: e.ts ? Math.max(0, Math.round((Date.now() - Date.parse(e.ts)) / 1000)) : null,
        })),
      };
    })(),
    lateToxic: { n: E.counts["late-toxic"] ?? 0, recent: E.lateToxic.last(8).reverse() }, // post-entry vetoes
    tickSlow: E.counts["tick-slow"] ?? 0, // ticks that overran their interval (stale position marks)
    // DATA INTEGRITY — null while healthy (the trader only writes a record when something is
    // wrong), so `null` here means "every audit so far reconciled".
    dataIntegrity: E.integrity,
    // ── STRATEGY 2 SCOUT — a SEPARATE, read-only process (strategy2-scout.ts). No capital, no
    // buy/sell, no interaction with the sniper below. Kept as its own top-level field, never
    // merged into `paper`/`totals`/anything sniper-shaped, so the dashboard can never blur the
    // two into looking like one strategy.
    strategy2: {
      mode: "SCOUT — read-only, zero capital, not trading",
      // FIXED (2026-07-29): this used to show every logged candidate from ALL sources unfiltered
      // — including the new-launch/dev-holding lane (a completely different, tiny-MC thesis) and
      // raw GMGN rows with no upper MC bound (the scout's own poll() deliberately logs broadly,
      // "no upper bound enforced"), so the panel rendered billion-dollar established tokens next
      // to $100K memecoins under one "mid-cap mover" label. This panel is specifically the
      // mid-cap-mover thesis (the one Strategy 2 actually PAPER-BUYS from) — bound it to the same
      // MC band + source set admission uses, so what's shown matches what's actually tradeable.
      count: STORE.strategy2.size,
      candidates: [...STORE.strategy2.values()]
        .filter((c) => {
          const src = String(c["source"] ?? "");
          const mc = Number(c["mcUsd"] ?? 0);
          return src !== "new-launch-dev-holding" && mc >= config.strategy2Scout.minMcUsd && mc <= config.strategy2Scout.maxMcUsd;
        })
        .sort((a, b) => (Number(b["change24h"] ?? -Infinity)) - (Number(a["change24h"] ?? -Infinity)))
        .slice(0, 30)
        // PROJECTED, not spread. The raw candidate row carries 40 fields (1,053 bytes each) and
        // the scout panel renders six of them — at 30 rows that is 31 KB of every 118 KB push,
        // re-parsed and re-rendered ~1.1x per second for data nothing reads.
        .map((c) => ({
          mint: c["mint"], sym: c["sym"], mcUsd: c["mcUsd"], holders: c["holders"],
          change24h: c["change24h"], twitterUrl: c["twitterUrl"],
          img: artFor(c["mint"] as string | undefined),
        })),
      // New-launch/dev-holding lane's own candidates — SEPARATE thesis, kept apart from the panel
      // above on purpose (see comment). Observation-only; not shown in a dedicated UI panel yet.
      // SUMMARY ONLY. This lane is observation-for-later with no UI consumer anywhere in web/src,
      // and it was shipping 30 full candidate rows (19.6 KB) on every push. The rows are still
      // written to the logs, which is where the analysis for this thesis actually happens.
      newLaunchDevHold: (() => {
        const rows = [...STORE.strategy2.values()].filter((c) => String(c["source"] ?? "") === "new-launch-dev-holding");
        const dev = rows.map((c) => Number(c["jupDevBalancePct"] ?? NaN)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
        return { n: rows.length, devPctMedian: dev.length ? dev[Math.floor(dev.length / 2)] : null };
      })(),
    },
    risk: { // the live exit envelope, so the UI never has to hardcode it
      catastrophicStopPct: config.risk.catastrophicStopPct,
      noDevelopment: config.risk.noDevelopment,
      dynamicTrail: config.risk.dynamicTrail,
      scaleOutTiers: config.risk.scaleOut.tiers,
      entryMcBandSol: config.gate.entryMcBandSol,
      // What the SNIPER is actually entering at, measured from its own recent OPENs — the field
      // above is this process's config, and the two diverge whenever a cohort test sets the band
      // in the sniper's supervisor only (55–100 today vs the dashboard's default 30–45). Showing
      // just the config made Diagnostics state the wrong band with total confidence.
      entryMcObserved: (() => {
        // Scoped to the LIVE cfg: the last 200 opens otherwise straddle a cohort change and
        // report a band spanning both settings (min 30 from the old one, max 98.8 from the new),
        // which describes neither.
        const live = liveTradingCfg();
        const opens = (STORE.trades as unknown as Array<{ action?: string; curveMcSol?: unknown; cfg?: unknown }>)
          .filter((r) => r.action === "OPEN" && typeof r.curveMcSol === "number" && r.cfg === live)
          .slice(-200)
          .map((r) => r.curveMcSol as number);
        if (!opens.length) return null;
        const s = [...opens].sort((a, b) => a - b);
        return { n: s.length, min: Number(s[0]!.toFixed(1)), median: Number(s[Math.floor(s.length / 2)]!.toFixed(1)), max: Number(s[s.length - 1]!.toFixed(1)) };
      })(),
    },
    byMode, rejectionReasons, funnel, devSummary, pnlStats, execSim, feeling, flow,
    agent, // merged decision feed (mechanical + LLM) → drives the companion mood & speech
    agentScorecard, // is the LLM actually good? measured via the post-exit counterfactual
    runs, // auto-reset trial ledger: completed runs, profit distribution, drawdown
    momentum, // momentum-checkpoint funnel (confirmed / zombie / timeout)
    market: { new: marketCache.new, top: marketCache.top, ageMs: marketCache.at ? Date.now() - marketCache.at : null }, // REAL pump.fun live market
    patterns, // pattern memory: entry-condition profile of winners vs losers (learned edge)
    entryLatency, // #8 detect→entry latency (honest: momentum-follower ~2-3min, not opening sniper)
    byModePnl, // per-mode P&L split — clean per-mode validation
    postExit, // post-exit learning: how often exits were premature + missed upside
    // Recently SCANNED coins (for the live scanner viz — names blip in/out as they pass).
    // FIXED (2026-07-29): this only ever read D.recent (the sniper's own decisions log), which
    // will never grow again — the "live scan" wave looked alive but had zero real coin names to
    // show. Owner's point stands: pump.fun itself churns new/mover coins every few seconds, and
    // this dashboard already polls that live feed (refreshMarket(), every 20s) independently of
    // the sniper — it just wasn't wired into the scan visual. Now combines fresh market data with
    // whatever Strategy 2 is actually tracking, `p:true` marking the ones that cleared Strategy
    // 2's own admission bar (mid-cap mover OR new-launch/dev-hold), so the wave shows real,
    // currently-churning market names again instead of nothing.
    // LAUNCH FIELD — the last few hundred pump.fun launches as {secondsAgo, marketCapSol},
    // for the Hero's live-market visual. Deliberately tiny: two numbers per launch, no symbols,
    // because the panel plots them as points and never labels them individually.
    //
    // The shape is the point. Nearly every coin is born at 27.96 ◎ (the pump.fun curve constant —
    // virtual reserves are identical for every token at creation), so the floor draws itself and
    // anything above it is the creator's own buy inside the create tx.
    launchField: (() => {
      const now = Date.now();
      const out: Array<{ a: number; mc: number }> = [];
      for (const r of E.launches.all()) {
        const a = (now - Date.parse(r.ts)) / 1000;
        if (!isFinite(a) || a < 0 || a > 1800) continue; // 30 minutes of history
        out.push({ a: Math.round(a), mc: Number(r.mc.toFixed(1)) });
      }
      return out;
    })(),
    scan: (() => {
      // FROZEN-FEED FIX (2026-08-03). This built `[...candidates, ...market].slice(0, 48)`, and
      // STORE.strategy2 holds ~17k candidates in insertion order — so slice(0,48) returned the
      // 48 OLDEST ever seen and never changed. Measured: identical symbols, identical order, for
      // 64s straight; the market names (the only genuinely rotating source) never got a slot at
      // all, and every entry carried p:true so the pass/reject colour contrast never appeared.
      //
      // Now: newest candidates first, and market names get a guaranteed share so the visual keeps
      // moving even when the scout is quiet.
      const s2Mints = new Set(STORE.strategy2.keys());
      const MARKET_SLOTS = 20;
      const fromMarket = [...marketCache.new, ...marketCache.top]
        .map((c) => ({ s: c.symbol || "?", p: s2Mints.has(c.mint) }))
        .slice(0, MARKET_SLOTS);
      const fromCandidates = [...STORE.strategy2.values()]
        .slice(-(48 - fromMarket.length))          // newest, not oldest
        .reverse()
        .map((c) => ({ s: String(c["sym"] ?? "?"), p: true }));
      return [...fromCandidates, ...fromMarket].slice(0, 48);
    })(),
    guardian: guardStatus(), // money-safety caps, 24h spend, halt state (live-phase readout)
    // Live bridge readout. `armed: false` — the normal state — means every real-money path
    // is inert and the numbers below are structurally zero, not merely quiet.
    //
    // Coin art is attached HERE rather than inside the bridge: `artFor` is a server-side cache
    // with its own fetch queue, and the bridge must stay a pure reader of the append-only log
    // (it runs inside the trader process too, where no art cache exists).
    liveBridge: (() => {
      const b = bridgeStatus();
      void cachedWalletSol; // (declared below; read inside the object literal)
      return {
        ...b,
        // REAL balance, read on-chain by THIS process.
        //
        // `expectedBalanceSol` is the bridge's post-transaction snapshot, and the bridge only
        // transacts inside the TRADER process — in the web server it is null forever. Publishing
        // it as the wallet balance made the live panel read $0.00 / 0.0000 SOL against a wallet
        // holding 0.22, and every derived figure (float, %) followed it into nonsense.
        walletSol: cachedWalletSol,
        summary: { ...b.summary, recent: b.summary.recent.map((r) => ({ ...r, img: artFor(r.mint) })) },
        lots: b.lots.map((l) => ({ ...l, img: artFor(l.mint) })),
      };
    })(),
    execLive, // devnet execution mirror (real sign→send→confirm, worthless SOL)
    paper: {
      // EXECUTABLE ONLY (audit P0-2) — every number here reflects trades proven, by mainnet
      // simulation, to actually have landed. would-fail buys never really spent SOL.
      opens: opens.length, closed: ledgerClosed, open: openPositions.length,
      wins, losses: ledgerClosed - wins, winRate: ledgerClosed ? wins / ledgerClosed : 0,
      sumOfTradePcts, // NOT a return — see note above; use realizedSol / floatSol for that
      returnPctOfFloat: floatSol > 0 ? Number(((realizedSol / floatSol) * 100).toFixed(2)) : 0,
      exitReasons,
      tradeSizeSol, floatSol, realizedSol, balanceSol, compounding, // concrete SOL accounting
      // The S1 equity series (330 points, 16 KB) had NO reader: the wallet panel plots
      // `combined.equity`, which is built separately and already includes this engine. Kept as a
      // last-point summary so the field still answers "where did S1 end up" without shipping the
      // whole curve on every push.
      equityLast: equity.length ? equity[equity.length - 1] : null,
      equityPoints: equity.length,
      openPositions,
      /**
       * Baris dari rezim pembukuan LAIN — tidak ikut dijumlah di angka mana pun di atas.
       * Dilaporkan supaya "kenapa cum P&L-ku mengecil?" punya jawaban di layar, bukan hanya
       * di commit log.
       */
      /**
       * true = kualifikasi "executable only" TIDAK bisa diterapkan karena simulasi buy tidak
       * pernah berjalan pada mode ini, jadi angka di atas memuat SEMUA trade rezim berlaku.
       * Bukan klaim yang lebih lemah — klaim yang berbeda, dan layar harus mengatakannya.
       */
      execStageUnresolved,
      legacy: {
        corrected: config.risk.execRealism,
        closed: legacyCloses.length,
        realizedSol: Number(legacyRealizedSol.toFixed(4)),
      },
    },
    // AUDIT P0-2 — "what if every simulated buy had actually landed on-chain, would-fail
    // included". Comparison/research data ONLY. Never use this for tuning or as a performance
    // claim — see `paper` above for the number that reflects real executability.
    paperHypothetical: {
      closed: hypLedgerClosed, wins: hypWins, losses: hypLedgerClosed - hypWins,
      winRate: hypLedgerClosed ? hypWins / hypLedgerClosed : 0,
      sumOfTradePcts: hypSumOfTradePcts, realizedSol: hypRealizedSol,
      wouldFailClosed: hypLedgerClosed - ledgerClosed, // count excluded from `paper` above
    },
    recentDecisions: D.recent.last(50).reverse().map((d) => ({
      ts: d.ts, symbol: d.candidate?.symbol ?? "?", mint: d.candidate?.mint ?? "", mode: d.candidate?.mode ?? "",
      source: d.candidate?.source ?? "", verdict: d.gate?.verdict, score: d.gate?.score ?? 0, action: d.action,
      holders: d.candidate?.holders, marketCap: d.candidate?.marketCapUsd,
      failed: (d.gate?.checks ?? []).filter((c) => c.hard && !c.passed).map((c) => c.name),
    })),
    // EXECUTABLE ONLY — a would-fail "loss" in the journal would show a trade that never
    // actually happened on real chain (audit P0-2).
    recentTrades: execCloses.slice(-30).reverse().map((t) => ({
      ts: t.ts, symbol: t.symbol ?? "?", reason: t.reason, pnlPct: t.pnlPct ?? 0,
      image: (t as { image?: string }).image,
      img: (t as { image?: string }).image ?? artFor(t.mint),
      grossPnlPct: t.grossPnlPct, costPct: t.costPct,
      pnlSol: t.tradePnlSol ?? t.pnlSol ?? (t.sizeSol ?? tradeSizeSol) * ((t.pnlPct ?? 0) / 100),
      heldSec: t.heldSec ?? 0, devOnlyBuys: t.devOnlyBuys,
    })),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
/** Serves a built Vite page (web/dist/{name}.html) — replaces the old serveFile()/PUBLIC pages. */
function serveWebPage(res: ServerResponse, name: string, status = 200): void {
  const p = join(WEB_DIST, name);
  if (!existsSync(p)) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end(`dashboard not built — run \`npm run build\` in web/ (missing ${p})`);
    return;
  }
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(p));
}
const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon",
};
/**
 * Serves a static file under web/dist. `immutableCache` should be true ONLY for content-hashed
 * files (Vite's `assets/*` — filename changes whenever content does, so caching forever is safe);
 * plain copied-through files at dist root (favicon.svg, etc, same name every build) must NOT be
 * cached that aggressively or a stale favicon could stick around for a year.
 */
function serveWebAsset(res: ServerResponse, relPath: string, immutableCache: boolean): void {
  const p = join(WEB_DIST, relPath);
  // Prevent path traversal — relPath comes straight from the URL.
  if (!p.startsWith(WEB_DIST) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  const ext = relPath.slice(relPath.lastIndexOf("."));
  const contentType = ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": contentType, "cache-control": immutableCache ? "max-age=31536000, immutable" : "no-cache" });
  res.end(readFileSync(p));
}
function redirect(res: ServerResponse, location: string, cookie?: string): void {
  const headers: Record<string, string> = { location };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(302, headers);
  res.end();
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e4) req.destroy(); });
    req.on("end", () => resolve(data));
  });
}

// ── OKX Web3 product projection ──────────────────────────────────────────────
// Everything below reads configuration, process state, the radar cache, and rows already on
// disk. It MUST stay network-free: the browser refreshes this view, and a dashboard repaint is
// never a valid reason to consume provider quota or slow the signal lane.

const okxNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

// ── LANE VIEWS (dashboard multi-lane, 2026-10-07) ────────────────────────────
// Reader state LOKAL saja (quotaCost = 0) dengan cache pendek: dashboard boleh poll sesukanya
// tanpa membaca ulang berkas events harian yang besar setiap request.
const laneCache = new Map<string, { at: number; data: unknown }>();
/** Cache chart manual (klik koin) + single-flight: dua klik cepat = satu panggilan GT. */
const chartCache = new Map<string, { at: number; data: unknown }>();
const chartInflight = new Map<string, Promise<unknown>>();
let chartLastFetchAt = 0;
function cachedLane(key: string, ttlMs: number, build: () => unknown): unknown {
  const hit = laneCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const data = build();
  laneCache.set(key, { at: Date.now(), data });
  return data;
}
function readJsonSafe<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}
function recentRowFiles(prefix: string, days: number): string[] {
  try {
    const cut = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return readdirSync(config.logDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl") && f.slice(prefix.length, prefix.length + 10) >= cut)
      .sort().map((f) => join(config.logDir, f));
  } catch { return []; }
}
function latestMd(prefix: string, maxChars = 9_000): { file: string; text: string } | null {
  try {
    const files = readdirSync(config.logDir).filter((f) => f.startsWith(prefix) && f.endsWith(".md")).sort();
    const f = files[files.length - 1];
    if (!f) return null;
    const text = readFileSync(join(config.logDir, f), "utf8");
    return { file: f, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… (dipotong)` : text };
  } catch { return null; }
}

/**
 * Kesehatan lane dari mtime berkas state — bukan dari niat. Ambang per lane mengikuti irama
 * siklusnya (dengan kelonggaran ~3×): RH paper menulis tiap tick mark (10s), Dex tiap siklus (5m),
 * OKX paper tiap putaran toplist (detik), GMGN watch tiap 15m.
 */
function buildLaneHealth(): Record<string, { ageSec: number | null; fresh: boolean }> {
  const probe = (file: string, freshWithinSec: number): { ageSec: number | null; fresh: boolean } => {
    try {
      const st = statSync(join(config.logDir, file));
      const ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
      return { ageSec, fresh: ageSec <= freshWithinSec };
    } catch { return { ageSec: null, fresh: false }; }
  };
  const today = new Date().toISOString().slice(0, 10);
  return {
    // RH diperiksa dari STATE (ditulis tiap tick mark 10 detik), BUKAN berkas harian: berkas harian
    // hanya bertambah saat ada trade, jadi 30 menit tanpa trade = "DIAM" palsu (alarm palsu yang
    // menetap melatih orang mengabaikan peringatan — prinsip yang sama dengan alarm S2 dulu).
    robinhood: probe("rh-paper-state.json", 5 * 60),
    gmgn: probe("gmgn-full-watch-state.json", 45 * 60),
    dex: probe("dex-full-state.json", 15 * 60),
    okxPaper: probe("okx-strict-paper-v2-state.json", 5 * 60),
  };
}

/** Lane DexScreener (2026-10-08): 13 endpoint REST (siklus 5 menit) + 6 stream WS realtime. */
function buildDexOverview(): Record<string, unknown> {
  return cachedLane("dex", 4_000, () => {
    const now = Date.now();
    const state = readJsonSafe<{
      seen?: Record<string, { at: number; kind: string; amt?: number }>;
      watch?: Record<string, { at: number; chain: string; symbol: string; liqUsd: number | null; vol24: number | null; chg24: number | null; mcUsd: number | null }>;
    }>(join(config.logDir, "dex-full-state.json"));
    const watch = Object.entries(state?.watch ?? {});
    // Pergerakan terbesar dulu — beserta likuiditasnya, supaya "naik 900% tapi liq $0k" terbaca
    // sebagai jebakan di layar, bukan sebagai peluang.
    const movers = watch
      .filter(([, w]) => w.chg24 != null)
      .sort((a, b) => Math.abs(b[1].chg24 ?? 0) - Math.abs(a[1].chg24 ?? 0))
      .slice(0, 8)
      .map(([key, w]) => ({ symbol: w.symbol, chain: w.chain, token: key.split("|")[1] ?? "", chg24: w.chg24, liqUsd: w.liqUsd, vol24: w.vol24 }));
    // Promosi berbayar: entri "boost-amt|<chain>|<token>" menyimpan total belanja terakhir per token.
    const promotions = Object.entries(state?.seen ?? {})
      .filter(([k, v]) => k.startsWith("boost-amt|") && (v.amt ?? 0) > 0)
      .map(([k, v]) => {
        const parts = k.split("|");
        const chain = parts[1] ?? "?";
        const token = parts[2] ?? "";
        const w = state?.watch?.[`${chain}|${token}`];
        return { chain, token, amountUsd: v.amt ?? 0, symbol: w?.symbol ?? null, liqUsd: w?.liqUsd ?? null, vol24: w?.vol24 ?? null, chg24: w?.chg24 ?? null };
      })
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .slice(0, 10);
    const discovered: Record<string, number> = {};
    let cycles24h = 0, ws: Record<string, unknown> | null = null, wsReconnects = 0;
    let lastCycle: Record<string, unknown> | null = null;
    let metas: Array<{ slug: string; tokens: number; vol: number }> = [];
    for (const f of recentRowFiles("events-", 2)) {
      let text: string;
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        if (!line.includes('"dex-')) continue;
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          const ts = Date.parse(String(r["ts"] ?? ""));
          if (!Number.isFinite(ts) || now - ts > 86_400_000) continue;
          const type = String(r["type"]);
          const short = type.replace("dex-", "");
          discovered[short] = (discovered[short] ?? 0) + 1;
          if (type === "dex-cycle") { cycles24h++; lastCycle = { ts: r["ts"], calls: r["calls"], ms: r["ms"], watch: r["watch"] }; }
          if (type === "dex-ws-status") ws = { ts: r["ts"], alive: r["alive"], streams: r["streams"] };
          if (type === "dex-ws-reconnect") wsReconnects++;
          if (type === "dex-metas" && Array.isArray(r["top"])) metas = (r["top"] as Array<{ slug: string; tokens: number; vol: number }>).slice(0, 5);
        } catch { /* baris rusak — abaikan */ }
      }
    }
    return {
      updatedAt: new Date().toISOString(),
      watchlistTotal: watch.length, seenTotal: Object.keys(state?.seen ?? {}).length,
      cycles24h, lastCycle, ws, wsReconnects, discovered, metas, promotions, movers, quotaCost: 0,
    };
  }) as Record<string, unknown>;
}

/**
 * Lane OKX strict-paper (2026-10-08): uang kertas — prosesnya tidak mengimpor signer/broadcast.
 * Termasuk VERIFIKASI hash-chain ledger (dihitung ulang dari berkas, cache 60 detik): angka paper
 * yang ledger-nya rusak ditandai di layar, bukan dipercaya diam-diam.
 */
function buildOkxPaper(): Record<string, unknown> {
  const lane = cachedLane("okx-paper", 4_000, () => {
    const state = readJsonSafe<{
      updatedAt?: string;
      positions?: Record<string, {
        status?: string; policyVersion?: number; symbol?: string | null; mint?: string; source?: string;
        detectedAt?: number; walletType?: string | null;
        adaptive?: { exit?: { pnlPct?: number; triggerReason?: string } | null } | null;
      }>;
      budget?: { premiumUsed?: number; basicUsed?: number; premiumPaused?: boolean; basicPaused?: boolean };
      primed?: { scanner?: boolean; ranking?: boolean; signal?: boolean; trackers?: string[] };
      pendingCandidates?: Record<string, { symbol?: string | null; mint?: string }>;
      scoutCache?: Record<string, unknown>;
    }>(join(config.logDir, "okx-strict-paper-v2-state.json"));
    const positions = Object.entries(state?.positions ?? {}).map(([id, p]) => ({ id, ...p }));
    const open = positions.filter((p) => p.status === "OPEN");
    const closed = positions.filter((p) => p.status === "CLOSED");
    const kinds: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    const closes: Array<Record<string, unknown>> = [];
    try {
      const tail = readFileSync(join(config.logDir, "okx-strict-paper-v2.jsonl"), "utf8").slice(-400_000).split("\n");
      for (const line of tail) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          const ts = Date.parse(String(r["ts"] ?? ""));
          if (!Number.isFinite(ts) || Date.now() - ts > 86_400_000) continue;
          const type = String(r["type"]);
          kinds[type] = (kinds[type] ?? 0) + 1;
          if (type === "CANDIDATE_TERMINAL") {
            const raw = r["reasons"] ?? r["reason"];
            const list = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
            for (const one of list) if (one) reasons[String(one).trim()] = (reasons[String(one).trim()] ?? 0) + 1;
          }
          if (type === "POSITION_CLOSED" && closes.length < 8) {
            const pnlLamports = Number(r["pnlLamports"] ?? 0);
            closes.push({
              ts: r["ts"], symbol: r["symbol"] ?? r["mint"] ?? "?",
              pnlSol: Number((pnlLamports / 1e9).toFixed(6)),
              trigger: (r["adaptive"] as { exit?: { triggerReason?: string } } | undefined)?.exit?.triggerReason ?? r["reason"] ?? null,
            });
          }
        } catch { /* baris rusak — abaikan */ }
      }
    } catch { /* ledger belum ada */ }
    return {
      updatedAt: state?.updatedAt ?? null,
      open: open.map((p) => ({ id: p.id, symbol: p.symbol ?? p.mint ?? "?", source: p.source ?? "?", detectedAt: p.detectedAt ?? null, policyVersion: p.policyVersion ?? null })),
      closedTotal: closed.length,
      pending: Object.keys(state?.pendingCandidates ?? {}).length,
      scoutCache: Object.keys(state?.scoutCache ?? {}).length,
      budget: state?.budget ?? null,
      primed: { scanner: state?.primed?.scanner ?? false, ranking: state?.primed?.ranking ?? false, signal: state?.primed?.signal ?? false, trackers: state?.primed?.trackers?.length ?? 0 },
      activity24h: kinds, rejectReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 6), recentCloses: closes.reverse(),
      quotaCost: 0,
    };
  }) as Record<string, unknown>;
  const ledger = cachedLane("okx-paper-ledger", 60_000, () => {
    const v = verifyStrictLedger(join(config.logDir, "okx-strict-paper-v2.jsonl"));
    return { ok: v.ok, records: v.records.length, lastSeq: v.records.at(-1)?.seq ?? 0, error: v.error };
  });
  return { ...lane, ledger };
}

/** Lane Robinhood: state 10 varian + trade terakhir + laporan backtest/review terakhir. */
function buildRobinhoodPaper(): Record<string, unknown> {
  return cachedLane("rh-paper", 4_000, () => {
    const startEnv = Number(process.env.RH_START_EQUITY_USD);
    const startEquity = Number.isFinite(startEnv) && startEnv > 0 ? startEnv : 100;
    const state = readJsonSafe<{
      startedAt?: number; cycles?: number;
      variants?: Record<string, {
        equityUsd?: number; trades?: number; wins?: number; losses?: number; maxDdPct?: number;
        bankruptAt?: number; life?: number; lifeHistory?: Array<{ endEquityUsd: number }>;
        cohort?: string;
        positions?: Array<{ symbol?: string; lastPrice?: number; lastMarkAt?: number; notionalUsd?: number }>;
      }>;
    }>(join(config.logDir, "rh-paper-state.json"));
    const now = Date.now();
    const laneDays = state?.startedAt ? (now - state.startedAt) / 86_400_000 : 0;
    const variants = Object.entries(state?.variants ?? {}).map(([id, v]) => {
      const positions = (v.positions ?? []).map((p) => ({
        symbol: p.symbol ?? "?", lastPrice: p.lastPrice ?? 0,
        markAgeSec: p.lastMarkAt ? Math.round((now - p.lastMarkAt) / 1000) : null,
        notionalUsd: typeof p.notionalUsd === "number" ? p.notionalUsd : 0,
      }));
      // EXPOSURE TERBUKA (2026-10-07 malam): batas 50% berlaku PER-ENTRY, bukan agregat — v10
      // terbukti bisa menyentuh equity NEGATIF (-$1.61, dd 101.6%) dan v01 pernah $175 exposure di
      // atas $69.73 equity. Angka ini ditampilkan supaya risikonya terbaca, bukan tersembunyi.
      const exposureUsd = positions.reduce((a, p) => a + p.notionalUsd, 0);
      const trades = v.trades ?? 0;
      const equityUsd = v.equityUsd ?? startEquity;
      // Status berlapis: BANKRUT (equity < $4 atau sedang menunggu restart life baru) > SIAP > jalan.
      // Tanpa ini, varian yang modalnya habis tampil seolah masih berdagang.
      const status = v.bankruptAt != null || equityUsd < 4 ? "bankrut" : laneDays >= 7 && trades >= 10 ? "siap direview" : "jalan";
      // LIFE-2: P&L per-life (equity−100) + kumulatif (semua life yang sudah selesai + life berjalan).
      const historyPnl = (v.lifeHistory ?? []).reduce((a, l) => a + (l.endEquityUsd - startEquity), 0);
      return {
        id, equityUsd: Number(equityUsd.toFixed(2)), pnlUsd: Number((equityUsd - startEquity).toFixed(2)),
        cohort: v.cohort ?? null,
        life: v.life ?? 1, cumulativePnlUsd: Number((historyPnl + equityUsd - startEquity).toFixed(2)),
        bankrupt: v.bankruptAt != null,
        trades, wins: v.wins ?? 0, losses: v.losses ?? 0,
        winRate: trades ? Number((((v.wins ?? 0) / trades) * 100).toFixed(1)) : null,
        maxDdPct: Number((v.maxDdPct ?? 0).toFixed(2)), openPositions: positions.length, positions,
        exposureUsd: Number(exposureUsd.toFixed(2)),
        status,
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const rows: Array<Record<string, unknown>> = [];
    for (const f of recentRowFiles("rh-paper-", 2)) {
      try {
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.includes('"RH_')) continue;
          try { rows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* baris rusak */ }
        }
      } catch { /* skip */ }
    }
    const recent = rows.slice(-30).reverse().map((r) => ({
      action: String(r["action"] ?? "?"), variant: String(r["variant"] ?? "?"), symbol: String(r["symbol"] ?? "?"),
      pnlUsd: typeof r["pnlUsd"] === "number" ? r["pnlUsd"] : null,
      pnlPct: typeof r["pnlPct"] === "number" ? r["pnlPct"] : null,
      reason: typeof r["reason"] === "string" ? r["reason"] : null,
      ts: String(r["ts"] ?? ""),
      entryPriceUsd: typeof r["entryPriceUsd"] === "number" ? r["entryPriceUsd"] : null,
      exitPriceUsd: typeof r["exitPriceUsd"] === "number" ? r["exitPriceUsd"] : null,
    }));
    const backtest = latestMd("rh-backtest-");
    const review = latestMd("robinhood-review-");
    return {
      updatedAt: new Date().toISOString(), startEquityUsd: startEquity,
      laneDays: Number(laneDays.toFixed(2)), cycles: state?.cycles ?? 0,
      openTotal: variants.reduce((a, v) => a + v.openPositions, 0), variants, recent,
      backtestMd: backtest?.text ?? null, backtestFile: backtest?.file ?? null,
      reviewMd: review?.text ?? null, reviewFile: review?.file ?? null,
    };
  }) as Record<string, unknown>;
}

/** Lane GMGN: sinyal 24 jam, kualitas wallet (state permanen), trade terpantau, laporan harian. */
function buildGmgnOverview(): Record<string, unknown> {
  return cachedLane("gmgn", 60_000, () => {
    const now = Date.now();
    const dayMs = 86_400_000;
    const signals: Array<Record<string, unknown>> = [];
    const watched: Array<Record<string, unknown>> = [];
    let lastCycle: Record<string, unknown> | null = null;
    for (const f of recentRowFiles("events-", 2)) {
      try {
        for (const line of readFileSync(f, "utf8").split("\n")) {
          if (!line.includes('"gmgn-')) continue;
          try {
            const r = JSON.parse(line) as Record<string, unknown>;
            const t = String(r["type"] ?? "");
            if (t === "gmgn-signal") signals.push(r);
            else if (t === "gmgn-watched-trade") watched.push(r);
            else if (t === "gmgn-full-cycle") lastCycle = r;
          } catch { /* baris rusak */ }
        }
      } catch { /* skip */ }
    }
    const tsOf = (r: Record<string, unknown>): number => Date.parse(String(r["ts"] ?? "")) || 0;
    const sig24 = signals.filter((r) => now - tsOf(r) <= dayMs);
    const byType = new Map<number, Array<Record<string, unknown>>>();
    for (const s of sig24) {
      const t = Number(s["signalType"] ?? 0);
      const a = byType.get(t);
      if (a) a.push(s); else byType.set(t, [s]);
    }
    const signals24h = [...byType.entries()].map(([signalType, rows]) => ({
      signalType, count: rows.length,
      sample: rows.slice(-4).map((r) => ({ sym: String(r["sym"] ?? "?"), mcUsd: typeof r["mcUsd"] === "number" ? r["mcUsd"] : null, ts: String(r["ts"] ?? "") })),
    })).sort((a, b) => b.count - a.count);
    const state = readJsonSafe<{ walletQuality?: Record<string, { at?: number; tags?: string[]; winrate?: number | null; realizedProfit?: number | null; tokens?: number | null }> }>(join(config.logDir, "gmgn-full-watch-state.json"));
    const wallets = Object.entries(state?.walletQuality ?? {}).map(([wallet, q]) => ({
      wallet, tags: q.tags ?? [], winrate: q.winrate ?? null, realizedProfit: q.realizedProfit ?? null, tokens: q.tokens ?? null, at: q.at ?? 0,
    })).sort((a, b) => (b.winrate ?? -1) - (a.winrate ?? -1)).slice(0, 20);
    const report = latestMd("gmgn-report-", 12_000);
    return {
      updatedAt: new Date().toISOString(),
      signals24h,
      recentSignals: sig24.slice(-12).reverse().map((r) => ({
        sym: String(r["sym"] ?? "?"), signalType: Number(r["signalType"] ?? 0),
        mcUsd: typeof r["mcUsd"] === "number" ? r["mcUsd"] : null,
        triggerMc: typeof r["triggerMc"] === "number" ? r["triggerMc"] : null,
        ath: typeof r["ath"] === "number" ? r["ath"] : null,
        holders: typeof r["holders"] === "number" ? r["holders"] : null,
        rugRatio: typeof r["rugRatio"] === "number" ? r["rugRatio"] : null,
        ts: String(r["ts"] ?? ""),
      })),
      wallets, walletsScored: Object.keys(state?.walletQuality ?? {}).length,
      watchedTrades24h: watched.filter((r) => now - tsOf(r) <= dayMs).length,
      watchedRecent: watched.slice(-8).reverse().map((r) => ({
        symbol: String(r["symbol"] ?? "?"), side: String(r["side"] ?? "?"), maker: String(r["maker"] ?? ""),
        amountUsd: typeof r["amountUsd"] === "number" ? r["amountUsd"] : null,
        watchType: String(r["watchType"] ?? "?"), ts: String(r["ts"] ?? ""),
      })),
      lastCycle: lastCycle ? {
        ts: String(lastCycle["ts"] ?? ""), calls: Number(lastCycle["calls"] ?? 0), ms: Number(lastCycle["ms"] ?? 0),
        positions: Number(lastCycle["positions"] ?? 0), candidates: Number(lastCycle["candidates"] ?? 0),
        signals: Number(lastCycle["signals"] ?? 0), walletsScored: Number(lastCycle["walletsScored"] ?? 0),
      } : null,
      reportMd: report?.text ?? null, reportFile: report?.file ?? null,
    };
  }) as Record<string, unknown>;
}

function buildOkxStatus(): Record<string, unknown> {
  const entries = Object.entries(OKX_ENDPOINTS) as Array<[string, OkxEndpointSpec]>;
  const counts = Object.fromEntries(["live", "params-unknown", "unavailable", "unprobed"].map(
    (status) => [status, entries.filter(([, spec]) => spec.status === status).length],
  ));
  const control = readControl();
  const guardian = guardStatus();
  const blockers: string[] = [];
  if (!config.okx.enabled) blockers.push("OKX read lane disabled or credentials incomplete");
  if (!config.okx.executionEnabled) blockers.push("OKX_EXECUTION_ENABLED is not true");
  if (config.s2ExecRoute !== "okx") blockers.push(`S2 route is ${config.s2ExecRoute}, not okx`);
  if (!config.s2LiveEnabled) blockers.push("S2 live bridge is disabled");
  if (!config.exec.liveConfirmed) blockers.push("global live permission is not confirmed");
  if (control.execMode !== "live") blockers.push(`console mode is ${control.execMode}, not live`);
  if (control.paused) blockers.push("trading is paused");
  if (guardian.halted) blockers.push(`guardian halted${guardian.haltReason ? `: ${guardian.haltReason}` : ""}`);

  return {
    enabled: config.okx.enabled,
    executionEnabled: config.okx.executionEnabled,
    executionRouteSelected: config.s2ExecRoute === "okx",
    // "Armed" now means every configuration/runtime gate visible to the server is open. The
    // signing key, balance, route, exposure and caps are still re-checked fail-closed per order.
    executionArmed: blockers.length === 0,
    executionBlockers: blockers,
    executionChecksAtOrder: ["signing key", "wallet balance", "route", "per-trade cap", "deployed cap", "24h spend cap"],
    controlMode: control.execMode,
    paused: control.paused,
    guardianHalted: guardian.halted,
    route: config.s2ExecRoute,
    slippagePercent: config.okx.slippagePercent,
    websocketEnabled: config.okx.wsEnabled,
    websocketChannels: config.okx.wsChannels,
    restSignalFallback: config.okx.restSignalEnabled,
    restSignalPollMs: config.okx.restSignalPollMs,
    copyShadow: config.okx.copyShadow,
    candidateQueueEnabled: config.okx.candidateQueueEnabled,
    candidateMaxLagMs: config.okx.candidateMaxLagMs,
    candidateMinAmountUsd: config.okx.candidateMinAmountUsd,
    trackedWallets: config.okx.trackedWallets.length,
    restCopyMaxWallets: config.okx.restCopyMaxWallets,
    endpointTotal: entries.length,
    endpointCounts: counts,
    warnings: okxCredentialWarnings(),
    endpoints: entries.map(([id, spec]) => ({ id, ...spec })),
  };
}

interface OkxRadarFileRow {
  walletAddress?: string;
  firstSeen?: string;
  lastSeen?: string;
  sweepCount?: number;
  cellHits?: number;
  cells?: string[];
  walletTypeCodes?: string[];
  walletTypes?: string[];
  lastRealizedPnlUsd?: number | null;
  lastWinRatePercent?: number | null;
  lastAvgBuyValueUsd?: number | null;
  lastTxs?: number | null;
  lastActiveTimestamp?: number | null;
}

let okxRadarCache: { mtimeMs: number; snapshot: Record<string, unknown> } | null = null;
function okxRadarSnapshot(): Record<string, unknown> {
  const path = join(config.logDir, "okx-radar-wallets.json");
  if (!existsSync(path)) return { available: false, totalWallets: 0, copyableWallets: 0, updatedAt: null, topWallets: [] };
  try {
    const stat = statSync(path);
    if (okxRadarCache?.mtimeMs === stat.mtimeMs) return okxRadarCache.snapshot;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, OkxRadarFileRow>;
    const rows = Object.values(parsed).filter((row) => typeof row.walletAddress === "string" && row.walletAddress.length > 0);
    const activeCutoff = Date.now() - 48 * 3_600_000;
    const excluded = new Set(["developer", "newWallet", "insider", "sniper", "suspectedPhishing", "bundledTrader"]);
    const normalized = rows.map((row) => {
      const walletTypeCodes = okxLeaderboardWalletTypeCodes(row.cells ?? [], row.walletTypeCodes ?? []);
      const walletTypes = walletTypeCodes.length
        ? walletTypeCodes.map(okxLeaderboardWalletTypeLabel).filter((v): v is NonNullable<typeof v> => v !== null)
        : row.walletTypes ?? [];
      return { ...row, walletTypeCodes, walletTypes };
    });
    const copyable = normalized
      .filter((row) => (row.sweepCount ?? 0) >= 2)
      .filter((row) => (row.lastWinRatePercent ?? 0) >= 50)
      .filter((row) => {
        const raw = row.lastActiveTimestamp ?? 0;
        const at = raw > 0 && raw < 1e12 ? raw * 1000 : raw;
        return at >= activeCutoff;
      })
      // Same rule as okxRadarSelect(): exclude a wallet only when ALL its known identities are
      // inherently uncopyable. A smart-money wallet that also appears as "fresh" stays visible.
      .filter((row) => !(row.walletTypes?.length && row.walletTypes.every((type) => excluded.has(type))))
      .sort((a, b) => ((b.sweepCount ?? 0) - (a.sweepCount ?? 0)) || ((b.cellHits ?? 0) - (a.cellHits ?? 0)) || ((b.lastRealizedPnlUsd ?? 0) - (a.lastRealizedPnlUsd ?? 0)));
    const snapshot = {
      available: true,
      totalWallets: rows.length,
      copyableWallets: copyable.length,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      topWallets: copyable.slice(0, 12).map((row) => ({
        walletAddress: row.walletAddress,
        sweepCount: row.sweepCount ?? 0,
        cellHits: row.cellHits ?? 0,
        walletTypes: row.walletTypes ?? [],
        realizedPnlUsd: row.lastRealizedPnlUsd ?? null,
        winRatePercent: row.lastWinRatePercent ?? null,
        avgBuyValueUsd: row.lastAvgBuyValueUsd ?? null,
        txs: row.lastTxs ?? null,
        lastActiveTimestamp: row.lastActiveTimestamp ?? null,
      })),
    };
    okxRadarCache = { mtimeMs: stat.mtimeMs, snapshot };
    return snapshot;
  } catch {
    return { available: false, totalWallets: 0, copyableWallets: 0, updatedAt: null, topWallets: [] };
  }
}

function okxSourceEvent(row: Row): Record<string, unknown> {
  const data = row["type"] === "okx-candidate"
    ? row
    : row["data"] && typeof row["data"] === "object" ? row["data"] as Row : {};
  const token = data["token"] && typeof data["token"] === "object" ? data["token"] as Row : {};
  const mint = String(data["tokenAddress"] ?? data["tokenContractAddress"] ?? data["mint"] ?? token["tokenAddress"] ?? token["tokenContractAddress"] ?? "");
  const symbol = String(data["symbol"] ?? data["tokenSymbol"] ?? token["symbol"] ?? "");
  const wallet = String(data["walletAddress"] ?? data["triggerWalletAddress"] ?? data["trader"] ?? data["userAddress"] ?? "");
  return {
    ts: row["ts"] ?? null,
    channel: row["channel"] ?? (row["type"] === "okx-rest-copy" ? "address-tracker-activity-rest" : "dex-market-new-signal-openapi-rest"),
    mint,
    symbol: symbol || null,
    wallet: wallet || null,
    walletType: data["walletType"] ?? data["tag"] ?? null,
    amountUsd: okxNumber(data["amountUsd"] ?? data["valueUsd"] ?? data["quoteAmountUsd"] ?? data["volumeUsd"]),
    marketCapUsd: okxNumber(data["marketCapUsd"] ?? data["marketCap"] ?? token["marketCapUsd"]),
    holders: okxNumber(data["holders"] ?? token["holders"]),
    detectLagMs: okxNumber(row["detectLagMs"]),
    status: data["status"] ?? null,
    executionState: data["executionState"] ?? null,
    reasons: Array.isArray(data["reasons"]) ? data["reasons"] : [],
  };
}

function okxOutcomeEvent(row: Row): Record<string, unknown> {
  return {
    ts: row["ts"] ?? null,
    kind: row["kind"] ?? null,
    mint: row["mint"] ?? null,
    symbol: row["symbol"] ?? null,
    wallet: row["wallet"] ?? null,
    verdict: row["verdict"] ?? null,
    horizonSec: okxNumber(row["horizonSec"]),
    pctChange: okxNumber(row["pctChange"]),
    status: row["status"] ?? row["verdict"] ?? null,
  };
}

function okxAggregateRows(values: Record<string, OkxAggregate>, labelKey: "kind" | "verdict"): Array<Record<string, unknown>> {
  return Object.entries(values).map(([key, a]) => {
    const split = key.lastIndexOf(":");
    const label = split >= 0 ? key.slice(0, split) : key;
    const horizonSec = split >= 0 ? Number(key.slice(split + 1)) : 0;
    const median = a.lower.length === 0
      ? null
      : a.lower.length === a.upper.length
        ? (a.lower[0]! + a.upper[0]!) / 2
        : a.lower[0]!;
    return {
      [labelKey]: label,
      horizonSec,
      total: a.total,
      priced: a.priced,
      unpriced: a.total - a.priced,
      winRatePercent: a.priced ? Number((a.wins / a.priced * 100).toFixed(1)) : null,
      avgPct: a.priced ? Number((a.sumPct / a.priced).toFixed(2)) : null,
      medianPct: median == null ? null : Number(median.toFixed(2)),
    };
  }).sort((a, b) => Number(a["horizonSec"]) - Number(b["horizonSec"]) || String(a[labelKey]).localeCompare(String(b[labelKey])));
}

let okxProcessesCache = { at: 0, lane: false, study: false, paper: false };
function okxProcesses(): { lane: boolean; study: boolean; paper: boolean } {
  if (Date.now() - okxProcessesCache.at < 5_000) {
    return { lane: okxProcessesCache.lane, study: okxProcessesCache.study, paper: okxProcessesCache.paper };
  }
  const alive = (pattern: string): boolean => {
    try { execSync(`pgrep -f '${pattern}'`, { stdio: ["ignore", "pipe", "ignore"] }); return true; }
    catch { return false; }
  };
  okxProcessesCache = {
    at: Date.now(),
    lane: alive("[s]rc/okx-lane.ts"),
    study: alive("[s]rc/okx-study.ts"),
    paper: alive("[s]rc/okx-strict-paper.ts"),
  };
  return { lane: okxProcessesCache.lane, study: okxProcessesCache.study, paper: okxProcessesCache.paper };
}

let okxStrictPaperCache: { mtimeMs: number; snapshot: Record<string, unknown> } | null = null;
function okxStrictPaperSnapshot(): Record<string, unknown> {
  const path = join(config.logDir, "okx-strict-paper-v2.jsonl");
  if (!existsSync(path)) return { available: false, ledgerIntegrity: "MISSING", error: null, exitSummary: [] };
  try {
    const stat = statSync(path);
    if (okxStrictPaperCache?.mtimeMs === stat.mtimeMs) return okxStrictPaperCache.snapshot;
    const verified = verifyStrictLedger(path);
    const snapshot = verified.ok
      ? { available: true, ledgerIntegrity: "OK", error: null, ...strictPaperReport(verified.records) }
      : { available: true, ledgerIntegrity: "FAILED", error: verified.error, exitSummary: [] };
    okxStrictPaperCache = { mtimeMs: stat.mtimeMs, snapshot };
    return snapshot;
  } catch (error) {
    return { available: true, ledgerIntegrity: "FAILED", error: (error as Error).message, exitSummary: [] };
  }
}

function okxStatusRow(row: Row | null, keys: string[]): Record<string, unknown> | null {
  if (!row) return null;
  return Object.fromEntries(["ts", ...keys].map((key) => [key, row[key] ?? null]));
}

function buildOkxOverview(): Record<string, unknown> {
  refreshStore();
  const O = STORE.events.okx;
  const radar = okxRadarSnapshot();
  const processes = okxProcesses();
  return {
    generatedAt: new Date().toISOString(),
    status: buildOkxStatus(),
    processes,
    radar: {
      ...radar,
      lastSweep: okxStatusRow(O.radarSweep, ["cells", "rows", "wallets", "fresh"]),
      lastSelection: okxStatusRow(O.radarSelection, ["radarCount", "manualCount", "trackedCount"]),
    },
    lane: {
      mode: config.okx.copyShadow ? "shadow-copy" : "signals-only",
      status: okxStatusRow(O.laneStatus, ["openObservations", "trackedWallets", "channelCounts", "restSignalEvents", "restCopyEvents", "candidates"]),
      signals: { total: O.signalCount, recent: O.recentSignals.last(12).reverse().map(okxSourceEvent) },
      copies: { total: O.copyCount, liveExecution: false, recent: O.recentCopies.last(12).reverse().map(okxSourceEvent) },
      candidates: { total: O.candidateCount, liveExecution: false, recent: O.recentCandidates.last(12).reverse().map(okxSourceEvent) },
      outcomes: okxAggregateRows(O.observationAgg, "kind"),
      recentOutcomes: O.recentObservations.last(12).reverse().map(okxOutcomeEvent),
    },
    study: {
      status: okxStatusRow(O.studyStatus, ["scanned", "registered", "settled", "open", "seen", "CLEAN", "TOXIC", "UNKNOWN", "cfg"]),
      outcomes: okxAggregateRows(O.studyAgg, "verdict"),
      recent: O.recentStudyOutcomes.last(12).reverse().map(okxOutcomeEvent),
    },
    paper: okxStrictPaperSnapshot(),
    lastLocalEventAt: O.lastEventAt,
    quotaCost: 0,
  };
}

// ── Router ───────────────────────────────────────────────────────────────────
// Named so BOTH loopback listeners (IPv4 below, IPv6 at the bottom) share one implementation.
const handler = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // Vite's build output for hashed assets (JS/CSS/fonts, content-addressed filenames — safe to
  // cache forever) plus any file it copies through from web/public unhashed (e.g. favicon.svg).
  if (path.startsWith("/assets/")) return serveWebAsset(res, path.slice(1), true);
  if (path === "/favicon.svg") return serveWebAsset(res, "favicon.svg", false);

  // Design preview — static, no live data, auth-gated like /app. Copied through from web/public
  // by Vite. Exists so UI directions can be compared side by side at the real tile size without
  // touching the running dashboard.
  if (path === "/preview" || path === "/preview-equity" || path === "/preview-hero" || path === "/preview-hero2" || path === "/preview-pipeline" || path === "/preview-pipeline2" || path === "/preview-pipeline3" || path === "/preview-agent" || path === "/preview-poscard" || path === "/preview-poscard2" || path === "/preview-band") {
    if (!isAuthed(req)) return redirect(res, "/login");
    if (path === "/preview") return serveWebPage(res, "preview.html");
    if (path === "/preview-hero") return serveWebPage(res, "preview-hero.html");
    if (path === "/preview-hero2") return serveWebPage(res, "preview-hero2.html");
    if (path === "/preview-pipeline") return serveWebPage(res, "preview-pipeline.html");
    if (path === "/preview-pipeline2") return serveWebPage(res, "preview-pipeline2.html");
    if (path === "/preview-pipeline3") return serveWebPage(res, "preview-pipeline3.html");
    if (path === "/preview-agent") return serveWebPage(res, "preview-agent.html");
    if (path === "/preview-poscard") return serveWebPage(res, "preview-poscard.html");
    if (path === "/preview-poscard2") return serveWebPage(res, "preview-poscard2.html");
    if (path === "/preview-band") return serveWebPage(res, "preview-band.html");
    // serveWebPage, not serveWebAsset: the asset map only knows Vite's hashed types (js/css/
    // woff2/svg) and falls back to application/octet-stream, which makes the browser DOWNLOAD
    // the page instead of rendering it. serveWebPage sets text/html and reads from the same dir.
    return serveWebPage(res, "preview-equity.html");
  }

  if (path === "/" ) return serveWebPage(res, "index.html"); // Vite output name mirrors the SOURCE file's own name (web/index.html), not the rollupOptions.input key

  if (path === "/login" && req.method === "GET")
    return isAuthed(req) ? redirect(res, "/app") : serveWebPage(res, "login.html");

  if (path === "/login" && req.method === "POST") {
    const ip = clientIp(req);
    const wait = loginBlocked(ip);
    if (wait > 0) { res.writeHead(429, { "content-type": "text/plain", "retry-after": String(wait) }); res.end(`too many attempts — retry in ${wait}s`); return; }
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (params.get("password") === PASSWORD) {
      loginFails.delete(ip);
      const token = newSession();
      // Secure only behind TLS — setting it unconditionally would break a plain-HTTP SSH tunnel.
      const secure = PUBLIC_BIND || req.headers["x-forwarded-proto"] === "https" ? " Secure;" : "";
      return redirect(res, "/app", `${COOKIE}=${token}; HttpOnly;${secure} SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    }
    noteLoginFail(ip);
    return redirect(res, "/login?e=1");
  }

  if (path === "/logout")
    return redirect(res, "/", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);

  // Alternative dashboard, served alongside the existing one so the two can be compared
  // side by side rather than one replacing the other before it has earned it.
  if (path === "/app")
    return isAuthed(req) ? serveWebPage(res, "app.html") : redirect(res, "/login");

  if (path === "/api/stats") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildStats()));
    return;
  }

  // OKX capability/arming truth. This is intentionally configuration + registry state only: the
  // dashboard must not spend paid API quota every time it polls. `npm run okx:probe` remains the
  // explicit live-health test, while this endpoint makes missing/unprobed/armed states visible.
  if (path === "/api/okx/status") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildOkxStatus()));
    return;
  }

  // Full OKX Web3 product view. Unlike /api/okx/status this includes radar, signal/copy activity
  // and measured outcomes, but it still reads LOCAL state only (quotaCost=0).
  if (path === "/api/okx/overview") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildOkxOverview()));
    return;
  }

  // Separate, read-only EVM intelligence lane. No wallet, signer, or execution path.
  if (path === "/api/robinhood/search" || path === "/api/robinhood/token") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    try {
      const data = path.endsWith("/search")
        ? await searchRobinhoodTokens(url.searchParams.get("q") ?? "")
        : await inspectRobinhoodToken(url.searchParams.get("address") ?? "", Number(url.searchParams.get("whaleUsd") ?? 10_000));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  // Lane views untuk dashboard multi-lane (2026-10-07): state lokal saja, cache pendek.
  if (path === "/api/robinhood/paper" || path === "/api/gmgn/overview" || path === "/api/dex/overview" || path === "/api/okx/paper") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    const lane = path === "/api/robinhood/paper" ? buildRobinhoodPaper()
      : path === "/api/gmgn/overview" ? buildGmgnOverview()
      : path === "/api/dex/overview" ? buildDexOverview()
      : buildOkxPaper();
    res.end(JSON.stringify(lane));
    return;
  }

  // KARTU KUALITAS EKSEKUSI (2026-10-11): data untuk kartu dashboard — retensi harga pasca-keluar
  // (dihitung dari jejak hari ini dengan fungsi yang SAMA dipakai review & realism) plus ringkasan
  // berkas laporan alat (kualitas stop, realisme keluar, arm OKX). Semua dari berkas lokal, nol API.
  if (path === "/api/quality") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildQuality()));
    return;
  }

  /** Ringkasan sebuah berkas laporan (nama, waktu tulis, baris penting) — atau null bila belum ada. */
  function reportDigest(pat: RegExp): { file: string; mtime: string; lines: string[] } | null {
    const files = readdirSync(config.logDir).filter((f) => pat.test(f)).sort();
    const file = files[files.length - 1];
    if (!file) return null;
    try {
      const full = join(config.logDir, file);
      const lines = readFileSync(full, "utf8").split("\n").filter((l) => l.trim()).slice(0, 120);
      return { file, mtime: statSync(full).mtime.toISOString(), lines };
    } catch {
      return null;
    }
  }

  function buildQuality(): unknown {
    const day = new Date().toISOString().slice(0, 10);
    let retention: ReturnType<typeof summarizeTraces> = [];
    let traceRows = 0;
    try {
      const rows = readFileSync(join(config.logDir, `rh-events-${day}.jsonl`), "utf8").split("\n")
        .filter((l) => l.includes("rh-mark-after"))
        .map((l) => { try { return JSON.parse(l) as { reason: string; exitPriceUsd: number; marks: Array<{ p: number | null }> }; } catch { return null; } })
        .filter((r): r is { reason: string; exitPriceUsd: number; marks: Array<{ p: number | null }> } => r != null);
      traceRows = rows.length;
      retention = summarizeTraces(rows);
    } catch { /* belum ada jejak hari ini */ }
    return {
      day,
      traceRows,
      retention,
      stop: reportDigest(/^rh-stop-quality-\d{4}-\d{2}-\d{2}\.md$/),
      realism: reportDigest(/^rh-realism-\d{4}-\d{2}-\d{2}\.md$/),
      okxArms: reportDigest(/^okx-verdict-\d{4}-\d{2}-\d{2}\.md$/),
      note: "retensi rendah pada take_profit = harga tidak bertahan sesudah keluar (untung di atas kertas)",
    };
  }

  // CHART per koin (2026-10-08): permintaan MANUAL dari dashboard (klik koin), bukan polling.
  // Limit GeckoTerminal ketat dan IP ini dipakai bersama lane Robinhood → cache 60 detik per kunci
  // + jarak minimum 3 detik antar-fetch berbeda. Kegagalan dilaporkan apa adanya (429/404/kosong).
  if (path === "/api/chart") {
    if (!isAuthed(req)) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":"unauthorized"}'); return; }
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    const chartChain = (url.searchParams.get("chain") ?? "solana").trim();
    const chartToken = url.searchParams.get("token")?.trim() || undefined;
    const chartPool = url.searchParams.get("pool")?.trim() || undefined;
    const chartTf = (url.searchParams.get("tf") ?? "5m").trim();
    const chartBars = Math.min(300, Math.max(10, Number(url.searchParams.get("bars") ?? 60) || 60));
    if (!chartToken && !chartPool) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"token atau pool wajib diisi"}'); return; }
    const key = `${chartChain}|${chartToken ?? chartPool}|${chartTf}|${chartBars}`;
    const cached = chartCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...(cached.data as object), cached: true }));
      return;
    }
    let pending = chartInflight.get(key);
    if (!pending) {
      const gap = chartLastFetchAt + 3_000 - Date.now();
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      chartLastFetchAt = Date.now();
      pending = fetchCandles({ chain: chartChain, token: chartToken, pool: chartPool, tf: chartTf, bars: chartBars })
        .then((out) => ({ chain: chartChain, token: chartToken ?? null, pool: out.pool, tf: chartTf, bars: chartBars, source: out.source, error: out.error, candles: out.candles }))
        .finally(() => chartInflight.delete(key));
      chartInflight.set(key, pending);
    }
    const data = await pending;
    chartCache.set(key, { at: Date.now(), data });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ...(data as object), cached: false }));
    return;
  }

  // DEEP ANALYTICS — every answer computed from the COMPLETE trade records (owner: "answer
  // with DATA not assumptions"). ?cfg=<hash> to isolate one strategy version (default: current).
  if (path === "/api/analytics") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildAnalytics(url.searchParams.get("cfg") ?? undefined)));
    return;
  }

  // COHORT COMPARISON — every config that has traded, grouped by `cfg` hash, so a tuning
  // change can be judged against the setting it replaced. Diagnostics-only, not hot-polled.
  if (path === "/api/cohorts") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildCohorts()));
    return;
  }

  // "No-trade/control arm" comparison — bought vs skipped candidates, same source, same 6h
  // window (audit fix, 2026-07-29). Diagnostics-only endpoint, not polled by the hot dashboard.
  if (path === "/api/strategy2-control-arm") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(buildStrategy2ControlArm()));
    return;
  }

  // Console remote control: pause/resume the scanner, switch exec mode.
  if (path === "/api/control" && req.method === "POST") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    const body = await readBody(req);
    let next: Record<string, unknown> = {};
    try { next = JSON.parse(body || "{}"); } catch { /* ignore */ }
    const patch: Partial<{ paused: boolean; execMode: "dry-run" | "simulate" | "devnet" | "live"; command: { id: number; action: "flatten" | "close" | "reset-run"; mint?: string }; strategy2Command: { id: number; action: "flatten" }; risk: Record<string, number> }> = {};
    if (typeof next.paused === "boolean") patch.paused = next.paused;
    // "live" is accepted here but writeControl() re-gates it against the .env permission —
    // the browser is never the thing that decides, it only asks.
    if (next.execMode === "dry-run" || next.execMode === "simulate" || next.execMode === "devnet" || next.execMode === "live") patch.execMode = next.execMode;
    // Kill switch: trip/clear the money-guardian from the console (works even in
    // dry-run so it's ready before live). Halting blocks every real spend.
    if (next.guardHalt === true) halt("kill switch (console)");
    if (next.guardHalt === false) resume();
    // DEPOSIT ACKNOWLEDGE: an owner top-up trips reconcile-or-HALT by definition (a balance
    // move the bridge did not make). Acknowledging re-seeds the expected-balance snapshot to
    // the CURRENT on-chain value and then lifts the halt — in that order, so the next
    // reconcile tick cannot immediately re-halt on the same drift. A failed read returns an
    // error WITHOUT resuming: never lift a kill switch on an unknown balance.
    let walletAckResult: { ok: boolean; sol: number | null } | null = null;
    if (next.walletAck === true) {
      walletAckResult = await acknowledgeDeposit();
      if (walletAckResult.ok) resume();
    }
    // One-shot COMMAND (flatten all / close one / reset run) — the trader executes it on
    // its next command-poll. Timestamped id so it runs exactly once.
    if (next.command === "flatten" || next.command === "reset-run" || (next.command === "close" && typeof next.mint === "string")) {
      patch.command = { id: Date.now(), action: next.command as "flatten" | "close" | "reset-run", mint: typeof next.mint === "string" ? next.mint : undefined };
    }
    // Audit fix (2026-07-29): Strategy 2's OWN emergency flatten — separate namespace/id sequence
    // from the sniper's `command` above, polled by strategy2-papertrader.ts itself.
    if (next.strategy2Command === "flatten") {
      patch.strategy2Command = { id: Date.now(), action: "flatten" };
    }
    // LIVE risk-knob tuning (validated + clamped in liveRisk() at read time).
    if (next.risk && typeof next.risk === "object") {
      const r: Record<string, number> = {};
      for (const k of ["paperTradeSizeSol", "catastrophicStopPct", "scaleOutTriggerPct", "minVelSol"]) {
        const v = (next.risk as Record<string, unknown>)[k];
        if (typeof v === "number" && isFinite(v)) r[k] = v;
      }
      if (Object.keys(r).length) patch.risk = r;
    }
    const state = writeControl(patch);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...state, walletAck: walletAckResult ?? undefined }));
    scheduleBroadcast();
    return;
  }

  // Serve the Solana web3.js browser build from local node_modules (no CDN, so
  // it works offline / on a VPS). Used by the Connect-Phantom funding flow.
  if (path === "/vendor/solana-web3.js") {
    const p = join(__dirname, "..", "node_modules", "@solana", "web3.js", "lib", "index.iife.min.js");
    if (!existsSync(p)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "max-age=86400" });
    res.end(readFileSync(p));
    return;
  }

  // Latest mainnet blockhash — lets the browser build a funding tx without
  // exposing our Helius key client-side. Auth-gated. Served through the rotating
  // pool (poolLatestBlockhash) + a 20s cache: a raw Connection here bypassed
  // rotation AND re-fetched an almost-identical blockhash on every browser open.
  if (path === "/api/blockhash") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    try {
      let bh = cachedBlockhash;
      if (!bh || Date.now() - bh.at > 20_000) {
        const fresh = await poolLatestBlockhashFull();
        if (!fresh) throw new Error("no pool endpoint answered getLatestBlockhash");
        bh = { ...fresh, at: Date.now() };
        cachedBlockhash = bh;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, botAddress: botPubkey() }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }

  // Bot wallet status (address + balances) for the Controls view.
  // Mainnet read goes through the ROTATING POOL: this used to be a raw read against
  // config.rpcUrl (endpoint #0, forever) — the exact bypass that made /api/wallet return -1
  // whenever that one key was throttled, even while six siblings sat healthy.
  if (path === "/api/wallet") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    const [mainnet, devnet] = await Promise.all([
      poolBalanceSol(botPubkey()).then((v) => v ?? -1).catch(() => -1),
      balanceSol(config.exec.devnetRpc).catch(() => -1),
    ]);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ address: botPubkey(), mainnet, devnet }));
    return;
  }

  // Withdraw SOL out of the bot wallet (owner doesn't want money sitting idle). Real
  // on-chain transfer — needs the destination + amount. Never touches trading.
  if (path === "/api/wallet/withdraw" && req.method === "POST") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    const body = await readBody(req);
    let b: { destination?: string; amount?: number | "all" } = {};
    try { b = JSON.parse(body || "{}"); } catch { /* ignore */ }
    if (!b.destination || typeof b.destination !== "string" || b.destination.length < 32) {
      res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "valid destination address required" })); return;
    }
    try {
      const r = await withdrawSol(config.rpcUrl, b.destination, b.amount === "all" ? "all" : Number(b.amount));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, signature: r.signature, sentSol: r.sentSol }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
    return;
  }

  // Server-Sent Events: instant push whenever the logs change (real-time, no poll).
  if (path === "/api/stream") {
    if (!isAuthed(req)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(buildStats())}\n\n`); // initial snapshot
    sseClients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000); // keep-alive
    req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  res.writeHead(404); res.end("not found");
};

const server = createServer(handler);

// ── SSE broadcast: watch the log dir, push a fresh snapshot on any change ─────
const sseClients = new Set<ServerResponse>();
mkdirSync(config.logDir, { recursive: true });
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let lastBroadcast = 0;
const MIN_BROADCAST_MS = 700; // floor on push rate — the bot writes logs far faster than a UI can render
function scheduleBroadcast(): void {
  if (broadcastTimer) return;
  // Debounce the burst AND enforce a minimum gap. fs.watch fires on every single log line;
  // without the floor, a launch burst would rebuild and push a full snapshot dozens of times
  // a second for no visible benefit.
  const wait = Math.max(250, MIN_BROADCAST_MS - (Date.now() - lastBroadcast));
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    if (sseClients.size === 0) { refreshStore(); return; } // still consume the tail so cursors stay current
    lastBroadcast = Date.now();
    const data = `data: ${JSON.stringify(buildStats())}\n\n`;
    for (const client of sseClients) client.write(data);
  }, wait);
}
try {
  watch(config.logDir, () => scheduleBroadcast());
} catch { /* fs.watch unavailable — SSE still sends the initial snapshot; clients fall back to poll */ }

// Graceful handling if the port is already taken (e.g. a previous run still
// running) — a clean message instead of an unhandled crash + stack trace.
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n  ✗ Port ${PORT} is already in use — another Shitcoin web server is probably still running.`);
    console.error(`    Fix: stop it, or free the port with:  lsof -ti :${PORT} | xargs kill -9`);
    console.error(`    Or run on a different port:  DASHBOARD_PORT=4318 npm start\n`);
    process.exit(1);
  }
  console.error(`  ✗ web server error: ${err.message}`);
  process.exit(1);
});

// Keep the Solscan network-status cache warm (best-effort).
if (config.solscanApiKey) {
  void solscanChainInfo();
  setInterval(() => void solscanChainInfo(), 30_000);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  Shitcoin web → http://${HOST}:${PORT}`);
  console.log(`  bind: ${PUBLIC_BIND ? "PUBLIC (make sure a proxy/tunnel fronts this)" : "loopback only — reach it via Cloudflare Tunnel or `ssh -L`"}`);
  console.log(`  login password: ${process.env.DASHBOARD_PASSWORD ? "(from .env)" : `"shitcoin" (DEFAULT — set DASHBOARD_PASSWORD before exposing)`}`);
  console.log(`  reading logs from ${config.logDir}\n`);
});

/**
 * ALSO listen on IPv6 loopback. `server.listen(PORT, "127.0.0.1")` binds the IPv4 stack ONLY,
 * but macOS resolves `localhost` to `::1` FIRST — so a browser typing http://localhost:4317
 * gets connection-refused and gives up, while curl silently succeeds by falling back to IPv4.
 * The dashboard looked "down" while being perfectly healthy.
 *
 * This is a SECOND loopback listener, not a widening of the bind: ::1 is as private as
 * 127.0.0.1, so the PUBLIC_BIND guard above still means what it says. Skipped when the operator
 * has deliberately bound elsewhere, and failures are ignored — on a host without IPv6 the IPv4
 * listener above is already serving.
 */
if (!PUBLIC_BIND) {
  const v6 = createServer(handler);
  v6.on("error", () => { /* no IPv6 stack, or ::1 already taken — IPv4 still serves */ });
  v6.listen(PORT, "::1", () => console.log(`  also listening on http://[::1]:${PORT} (so "localhost" resolves)\n`));
}
