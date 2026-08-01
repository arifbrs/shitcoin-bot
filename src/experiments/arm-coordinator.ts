import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeHash, config, configHash } from "../config.js";
import {
  bondingCurvePriceSol,
  bondingCurvePricesMulti,
  type CurveState,
} from "../safety/onchain.js";
import { simulateBuyMainnet } from "../execution/executor.js";
import { assessBuySimulation } from "../execution/semantics.js";
import { logRecord, ui } from "../util/log.js";
import type { Candidate, GateResult } from "../types.js";
import { ArmExitSimulation, type ArmEntryMark, type ArmExitState, type ArmMarketMark } from "./arm-exit.js";
import { planArmAdmissions, type ArmIntent } from "./arm-admission.js";
import { VirtualArmLedger, type ArmLedgerState } from "./arm-ledger.js";
import { INTERLEAVED_ARM_SPEC, INTERLEAVED_ARM_SPEC_HASH } from "./arm-spec.js";
import type { ArmResult, ArmResultSet } from "../analysis/profit-contract.js";

const STATE_PATH = join(config.logDir, "arm-coordinator-state.json");
const POLL_MS = 10_000;
const ENTRY_ATTEMPT_MS = 2_000;
const ENTRY_TIMEOUT_MS = 120_000;
const MISSING_MARK_TIMEOUT_MS = 150_000;
const CURVE_PARSER_VERSION = "v4-quote-layout-2026-07-26";

type ArmTerminal = { kind: "executable"; reason: string; atMs: number; regimeId: string; quoteSource: "bonding-curve" | "jupiter-amm"; pnlSol: number }
  | { kind: "missing-quote"; reason: string; atMs: number; regimeId: string; quoteSource: "none" | "jupiter-amm" };
type ArmStatus = {
  armId: "A" | "B" | "C";
  policyId: string;
  status: "pending" | "active" | "capacity-skip" | "policy-skip" | "missing-quote" | "executable";
  reason?: string;
  reservationId?: string;
  simState?: ArmExitState;
  terminal?: ArmTerminal;
};
interface Session {
  decisionId: string;
  implementationHash: string;
  cfg: string;
  mint: string;
  symbol?: string;
  creator?: string;
  launchAt: number;
  detectedAt: number;
  decisionAt: number;
  curveKey: string;
  pool?: string;
  isMayhemMode?: boolean;
  quoteMint?: string;
  clusterIds: string[];
  setup: ReturnType<typeof planArmAdmissions>["setup"];
  intents: ArmIntent[];
  status: "pending-entry" | "active" | "complete";
  entry?: ArmEntryMark;
  regimeId?: string;
  quoteSource?: "bonding-curve" | "jupiter-amm" | "none";
  lastMarkAt?: number;
  armStatuses: ArmStatus[];
}
interface PersistedState {
  version: 1;
  ledgerStates: Record<string, ArmLedgerState>;
  sessions: Session[];
}

const ledgerCfg = (armId: "A" | "B" | "C", policyId: string) => ({
  armId,
  policyId,
  startingSol: INTERLEAVED_ARM_SPEC.startingSol,
  maxPositions: INTERLEAVED_ARM_SPEC.maxPositions,
  maxPerCluster: INTERLEAVED_ARM_SPEC.maxPerCluster,
});

function regimeForCandidate(c: Candidate): string {
  if (c.isMayhemMode) return "PUMP_CURVE_MAYHEM";
  if (c.quoteMint && c.quoteMint !== "SOL" && c.quoteMint !== "So11111111111111111111111111111111111111112") return "NON_SOL_QUOTE";
  return "PUMP_CURVE_V1";
}

function skipResult(
  s: Session,
  a: ArmStatus,
  regimeId = s.regimeId ?? regimeForCandidate({} as Candidate),
  quoteSource: "none" | "bonding-curve" | "jupiter-amm" = s.quoteSource ?? "none",
): ArmResult {
  const action = a.status === "capacity-skip" ? "CAPACITY_SKIP" : "POLICY_SKIP";
  return {
    recordType: "ARM_RESULT", source: "interleaved-paper", counterfactualComplete: true,
    measurementEpoch: INTERLEAVED_ARM_SPEC.measurementEpoch, armSetId: INTERLEAVED_ARM_SPEC.armSetId,
    armSpecHash: INTERLEAVED_ARM_SPEC_HASH, implementationHash: s.implementationHash,
    decisionId: s.decisionId, mint: s.mint, creator: s.creator, launchAt: s.launchAt,
    entryAt: s.entry?.atMs, entryLatencyMs: s.entry ? s.entry.atMs - s.detectedAt : undefined,
    entryVSol: s.entry?.vSol, entryVTokens: s.entry?.vTokens, entryRealSol: s.entry?.realSol,
    armId: a.armId, policyId: a.policyId, exitPolicyId: INTERLEAVED_ARM_SPEC.exitPolicyId,
    executionPolicyId: INTERLEAVED_ARM_SPEC.executionPolicyId, parserVersion: CURVE_PARSER_VERSION,
    horizonSec: INTERLEAVED_ARM_SPEC.horizonSec, regimeId, quoteSource, action,
    execStage: "not-entered", skipReason: a.reason ?? "unspecified", netExecutablePnlSol: 0,
  };
}

function missingResult(s: Session, a: ArmStatus, terminal: Extract<ArmTerminal, { kind: "missing-quote" }>): ArmResult {
  return {
    recordType: "ARM_RESULT", source: "interleaved-paper", counterfactualComplete: true,
    measurementEpoch: INTERLEAVED_ARM_SPEC.measurementEpoch, armSetId: INTERLEAVED_ARM_SPEC.armSetId,
    armSpecHash: INTERLEAVED_ARM_SPEC_HASH, implementationHash: s.implementationHash,
    decisionId: s.decisionId, mint: s.mint, creator: s.creator, launchAt: s.launchAt,
    entryAt: s.entry?.atMs, entryLatencyMs: s.entry ? s.entry.atMs - s.detectedAt : undefined,
    entryVSol: s.entry?.vSol, entryVTokens: s.entry?.vTokens, entryRealSol: s.entry?.realSol,
    armId: a.armId, policyId: a.policyId, exitPolicyId: INTERLEAVED_ARM_SPEC.exitPolicyId,
    executionPolicyId: INTERLEAVED_ARM_SPEC.executionPolicyId, parserVersion: CURVE_PARSER_VERSION,
    horizonSec: INTERLEAVED_ARM_SPEC.horizonSec, regimeId: terminal.regimeId, quoteSource: terminal.quoteSource,
    action: "ENTER", execStage: "missing-quote", missingReason: terminal.reason, netExecutablePnlSol: null,
  };
}

function executableResult(s: Session, a: ArmStatus, terminal: Extract<ArmTerminal, { kind: "executable" }>): ArmResult {
  return {
    recordType: "ARM_RESULT", source: "interleaved-paper", counterfactualComplete: true,
    measurementEpoch: INTERLEAVED_ARM_SPEC.measurementEpoch, armSetId: INTERLEAVED_ARM_SPEC.armSetId,
    armSpecHash: INTERLEAVED_ARM_SPEC_HASH, implementationHash: s.implementationHash,
    decisionId: s.decisionId, mint: s.mint, creator: s.creator, launchAt: s.launchAt,
    entryAt: s.entry?.atMs, entryLatencyMs: s.entry ? s.entry.atMs - s.detectedAt : undefined,
    entryVSol: s.entry?.vSol, entryVTokens: s.entry?.vTokens, entryRealSol: s.entry?.realSol,
    armId: a.armId, policyId: a.policyId, exitPolicyId: INTERLEAVED_ARM_SPEC.exitPolicyId,
    executionPolicyId: INTERLEAVED_ARM_SPEC.executionPolicyId, parserVersion: CURVE_PARSER_VERSION,
    horizonSec: INTERLEAVED_ARM_SPEC.horizonSec, regimeId: terminal.regimeId, quoteSource: terminal.quoteSource,
    action: "ENTER", execStage: "executable", exitAt: terminal.atMs, exitReason: terminal.reason, netExecutablePnlSol: terminal.pnlSol,
  };
}

/**
 * Online paper-only coordinator for the pre-registered A/B/C entry experiment.
 *
 * It never calls a signing or send path. Main PaperTrader actions remain separate; this class
 * owns virtual ledgers and a shared curve mark for all arms. Graduation is deliberately recorded
 * as missing until the counterfactual AMM migration is proven, so it cannot manufacture a
 * profitable result from a quote that omitted the hypothetical curve buy.
 */
export class ArmCoordinator {
  private ledgers: Record<"A" | "B" | "C", VirtualArmLedger>;
  private sessions = new Map<string, Session>();
  private readonly loggedDecisionIds = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private entryTimer?: ReturnType<typeof setInterval>;
  private readonly entryQueue: string[] = [];
  private readonly entryQueued = new Set<string>();
  private entryRunning = false;
  private running = false;

  constructor() {
    this.ledgers = {
      A: new VirtualArmLedger(ledgerCfg("A", INTERLEAVED_ARM_SPEC.arms[0]!.policyId)),
      B: new VirtualArmLedger(ledgerCfg("B", INTERLEAVED_ARM_SPEC.arms[1]!.policyId)),
      C: new VirtualArmLedger(ledgerCfg("C", INTERLEAVED_ARM_SPEC.arms[2]!.policyId)),
    };
    this.hydrateLoggedDecisionIds();
    this.load();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    for (const session of this.sessions.values()) {
      if (session.status === "pending-entry") this.enqueueEntry(session);
    }
    this.entryTimer = setInterval(() => void this.drainEntryQueue(), ENTRY_ATTEMPT_MS);
    void this.drainEntryQueue();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.entryTimer) clearInterval(this.entryTimer);
    this.timer = undefined;
    this.entryTimer = undefined;
    this.save();
  }

  /** Fire-and-forget from the gate path; it never blocks or changes the main paper action. */
  observe(c: Candidate, gate: GateResult): void {
    if (!c.decisionId || this.sessions.has(c.decisionId)) return;
    const plan = planArmAdmissions(c, gate);
    const session: Session = {
      decisionId: c.decisionId, implementationHash: codeHash, cfg: configHash,
      mint: c.mint, symbol: c.symbol, creator: c.creator,
      launchAt: c.detectedAt, detectedAt: c.detectedAt, decisionAt: Date.now(), curveKey: c.bondingCurveKey ?? "",
      pool: c.pool, isMayhemMode: c.isMayhemMode, quoteMint: c.quoteMint,
      clusterIds: [c.creator, ...(c.creatorFunders ?? [])].filter(Boolean) as string[],
      setup: plan.setup, intents: plan.intents, status: "pending-entry",
      regimeId: regimeForCandidate(c), quoteSource: "none",
      armStatuses: plan.intents.map((intent) => ({
        armId: intent.armId, policyId: intent.policyId,
        status: intent.action === "POLICY_SKIP" ? "policy-skip" : "pending",
        reason: intent.action === "POLICY_SKIP" ? intent.reason : undefined,
      })),
    };
    this.sessions.set(c.decisionId, session);
    this.save();
    // QUEUE-CAPACITY FIX (2026-07-28): the worker is deliberately bounded to one curve-read +
    // simulation attempt per ENTRY_ATTEMPT_MS (avoids an RPC storm) — measured max throughput
    // ~30/min against an actual incoming rate of ~24-30 decisions/min plus retries, which pushed
    // P50 queue age past ENTRY_TIMEOUT_MS and manufactured hundreds of ENTRY_QUOTE_TIMEOUT
    // results that measure coordinator congestion, not strategy performance. Owner's explicit
    // call: do NOT raise ENTRY_ATTEMPT_MS (RPC-storm risk); reduce demand via deterministic
    // admission sampling instead (see arm-admission.ts). A session whose plan already resolved
    // every arm to POLICY_SKIP (common execution skip, admission sampling, toxic setup) can never
    // produce a pending verdict from prepareEntry() either — resolving it here, before it ever
    // occupies a queue slot, is what actually gives sampling its capacity benefit (without this,
    // a 67%-sampled-out candidate would still cost one wasted worker turn just to discover it has
    // nothing pending, per the very check prepareEntry() already does first).
    if (!session.armStatuses.some((a) => a.status === "pending")) {
      session.status = "complete";
      this.finalize(session);
      return;
    }
    this.enqueueEntry(session);
  }

  private enqueueEntry(s: Session): void {
    if (s.status !== "pending-entry" || this.entryQueued.has(s.decisionId)) return;
    this.entryQueued.add(s.decisionId);
    this.entryQueue.push(s.decisionId);
  }

  /**
   * Entry validation needs a hot RPC verdict—using the research lane was measured starving
   * forever whenever the scanner stayed busy. A single round-robin worker bounds this to at
   * most one curve+simulation attempt per two seconds, so it can progress without an RPC storm.
   */
  private async drainEntryQueue(): Promise<void> {
    if (this.entryRunning) return;
    const decisionId = this.entryQueue.shift();
    if (!decisionId) return;
    this.entryQueued.delete(decisionId);
    const s = this.sessions.get(decisionId);
    if (!s || s.status !== "pending-entry") return;
    this.entryRunning = true;
    try {
      // WATCHDOG (2026-07-28): found live — a hung network call inside prepareEntry() (the
      // concrete cause was buildTradeTx's missing fetch timeout, now fixed) left entryRunning
      // stuck at true forever, since nothing ever reached this try's finally. A single-worker
      // queue with no ceiling on one turn means one hang permanently deadlocks EVERY session,
      // old and new. This can't truly cancel a hung call without an AbortSignal threaded all the
      // way through (same limitation as gmgn-proxy.ts's documented one) — but it does guarantee
      // entryRunning resets and the worker keeps moving even if some future call hangs without
      // its own timeout. 15s ceiling: generous over the ~10s bound each individual RPC/HTTP leg
      // inside prepareEntry now carries, tight enough that one stuck candidate costs at most a
      // handful of missed worker turns, not the whole queue.
      await Promise.race([
        this.prepareEntry(s),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("prepareEntry watchdog timeout")), 15_000)),
      ]);
    } catch {
      // Watchdog fired or prepareEntry itself threw unexpectedly — either way, let the normal
      // ENTRY_TIMEOUT_MS check (inside prepareEntry, re-run on the next turn) decide this
      // session's fate rather than silently dropping it.
    } finally {
      this.entryRunning = false;
      if (s.status === "pending-entry") this.enqueueEntry(s);
    }
  }

  private async prepareEntry(s: Session): Promise<void> {
    if (s.status !== "pending-entry") return;
    if (!s.armStatuses.some((a) => a.status === "pending")) {
      s.status = "complete";
      this.finalize(s);
      return;
    }
    if (!s.curveKey) {
      this.markPendingMissing(s, "MISSING_BONDING_CURVE", s.regimeId ?? "PUMP_CURVE_V1", "none");
      return;
    }
    if (Date.now() - s.decisionAt > ENTRY_TIMEOUT_MS) {
      this.markPendingMissing(s, "ENTRY_QUOTE_TIMEOUT", "PUMP_CURVE_V1", "none");
      return;
    }
    try {
      const curve = await bondingCurvePriceSol(s.curveKey);
      if (!curve) throw new Error("entry-curve-unavailable");
      if (curve.complete) {
        this.markPendingMissing(s, "GRADUATION_CONTINUITY_UNPROVEN", "GRADUATED_AMM", "none");
        return;
      }
      if (curve.isMayhemMode || !curve.quoteIsSol) {
        this.markPendingPolicySkip(
          s,
          curve.isMayhemMode ? "PUMP_CURVE_MAYHEM" : "NON_SOL_QUOTE",
          curve.isMayhemMode ? "PUMP_CURVE_MAYHEM" : "NON_SOL_QUOTE",
          "none",
        );
        return;
      }
      // One shared transaction simulation is a material execution predicate. It is read-only and
      // all arms receive the same result; no arm can selectively benefit from a later retry.
      const sim = await simulateBuyMainnet(s.mint, INTERLEAVED_ARM_SPEC.stakeSol, s.pool ?? "pump");
      const assessed = assessBuySimulation(sim);
      if (!assessed.entryExecutable) {
        const reason = sim.needsFunding
          ? "BUY_SIM_NEEDS_FUNDING"
          : `BUY_SIM_${assessed.stage.toUpperCase()}:${sim.err ?? "unknown"}`;
        if (assessed.retryable && Date.now() - s.decisionAt <= ENTRY_TIMEOUT_MS) {
          // Measured PumpPortal indexing race: a fresh Pump mint can return IncorrectProgramId,
          // then simulate successfully later. Keep every arm pending and take a new shared curve
          // snapshot only once execution is actually possible; the recorded entry latency makes
          // that wait visible instead of pretending the original decision was executable.
          return;
        } else if (assessed.stage === "would-fail") {
          this.markPendingPolicySkip(s, reason, "PUMP_CURVE_V1", "none");
        } else {
          this.markPendingMissing(s, reason, "PUMP_CURVE_V1", "none");
        }
        return;
      }
      const entry: ArmEntryMark = {
        atMs: Date.now(), pool: "pump", vSol: curve.vSol, vTokens: curve.vTokens, realSol: curve.realSol,
      };
      s.entry = entry; s.status = "active"; s.regimeId = "PUMP_CURVE_V1"; s.quoteSource = "bonding-curve";
      for (const a of s.armStatuses) {
        if (a.status !== "pending") continue;
        const ledger = this.ledgers[a.armId];
        const admitted = ledger.admit({ decisionId: s.decisionId, mint: s.mint, stakeSol: INTERLEAVED_ARM_SPEC.stakeSol, clusterIds: s.clusterIds });
        if (!admitted.ok) {
          a.status = "capacity-skip"; a.reason = admitted.reason;
          continue;
        }
        ledger.commit(admitted.reservationId);
        a.status = "active"; a.reservationId = admitted.reservationId;
        a.simState = new ArmExitSimulation(entry).toState();
      }
      logRecord("events", {
        type: "arm-admission", decisionId: s.decisionId, mint: s.mint, symbol: s.symbol ?? null,
        intents: s.intents, setup: s.setup, simStage: assessed.stage, simErr: sim.err,
        entrySnapshot: { atMs: entry.atMs, vSol: entry.vSol, vTokens: entry.vTokens, realSol: entry.realSol },
        omittedMainPredicates: ["main-capital", "copycat", "holder-demand", "reentry", "main-stale-budget"],
        armStatuses: s.armStatuses.map((a) => ({ armId: a.armId, status: a.status, reason: a.reason ?? null })),
        measurementEpoch: INTERLEAVED_ARM_SPEC.measurementEpoch, armSpecHash: INTERLEAVED_ARM_SPEC_HASH,
        implementationHash: s.implementationHash, cfg: s.cfg,
      });
      if (!s.armStatuses.some((a) => a.status === "active")) {
        s.status = "complete";
        this.finalize(s);
      }
      this.save();
    } catch (e) {
      // Research yield/temporary RPC failure is not an executable zero. Retry while the entry
      // snapshot is still fresh; after that, close the decision as missing for every arm.
      if (Date.now() - s.decisionAt <= ENTRY_TIMEOUT_MS) {
        return;
      } else {
        this.markPendingMissing(s, "ENTRY_QUOTE_TIMEOUT", "PUMP_CURVE_V1", "none");
      }
    }
  }

  private markPendingMissing(s: Session, reason: string, regimeId: string, quoteSource: "none" | "jupiter-amm"): void {
    s.regimeId = regimeId; s.quoteSource = quoteSource; s.status = "complete";
    for (const a of s.armStatuses) if (a.status === "pending") {
      a.status = "missing-quote"; a.terminal = { kind: "missing-quote", reason, atMs: Date.now(), regimeId, quoteSource };
    }
    this.finalize(s);
  }

  private markPendingPolicySkip(s: Session, reason: string, regimeId: string, quoteSource: "none"): void {
    s.regimeId = regimeId; s.quoteSource = quoteSource; s.status = "complete";
    for (const a of s.armStatuses) if (a.status === "pending") { a.status = "policy-skip"; a.reason = reason; }
    this.finalize(s);
  }

  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const active = [...this.sessions.values()].filter((s) => s.status === "active" && s.armStatuses.some((a) => a.status === "active"));
      if (!active.length) return;
      const byKey = new Map(active.map((s) => [s.curveKey, s]));
      // One batch every 10s is bounded position monitoring, not best-effort research. The low
      // lane was measured starving during normal scanner traffic, then falsely quarantining all
      // active arms after MARK_UNAVAILABLE_TIMEOUT despite healthy RPC endpoints.
      const marks = await bondingCurvePricesMulti([...byKey.keys()]).catch(() => new Map<string, CurveState>());
      const now = Date.now();
      for (const s of active) {
        const curve = marks.get(s.curveKey);
        if (!curve) {
          if (now - (s.lastMarkAt ?? s.entry?.atMs ?? s.detectedAt) > MISSING_MARK_TIMEOUT_MS) {
            for (const a of s.armStatuses) if (a.status === "active") {
              this.ledgers[a.armId].quarantine(s.decisionId);
              a.status = "missing-quote";
              a.terminal = { kind: "missing-quote", reason: "MARK_UNAVAILABLE_TIMEOUT", atMs: now, regimeId: "PUMP_CURVE_V1", quoteSource: "none" };
            }
            s.status = "complete"; s.regimeId = "PUMP_CURVE_V1"; s.quoteSource = "none"; this.finalize(s);
          }
          continue;
        }
        s.lastMarkAt = now;
        if (curve.complete) {
          for (const a of s.armStatuses) if (a.status === "active") {
            this.ledgers[a.armId].quarantine(s.decisionId);
            a.status = "missing-quote";
            a.terminal = { kind: "missing-quote", reason: "GRADUATION_CONTINUITY_UNPROVEN", atMs: now, regimeId: "GRADUATED_AMM", quoteSource: "jupiter-amm" };
          }
          s.status = "complete"; s.regimeId = "GRADUATED_AMM"; s.quoteSource = "jupiter-amm"; this.finalize(s); continue;
        }
        const mark: ArmMarketMark = {
          atMs: now, complete: false, quoteSource: "bonding-curve",
          vSol: curve.vSol, vTokens: curve.vTokens, realSol: curve.realSol,
        };
        for (const a of s.armStatuses) {
          if (a.status !== "active" || !a.simState) continue;
          const sim = ArmExitSimulation.fromState(a.simState);
          const transition = sim.onMark(mark);
          a.simState = sim.toState();
          for (const partial of transition.partials) this.ledgers[a.armId].partial(s.decisionId, partial.costBasisSol, partial.proceedsSol);
          if (transition.terminal?.status === "executable") {
            const terminal = transition.terminal;
            this.ledgers[a.armId].close(s.decisionId, terminal.totalProceedsSol);
            a.status = "executable";
            a.terminal = { kind: "executable", reason: terminal.reason, atMs: terminal.atMs, regimeId: terminal.regimeId, quoteSource: terminal.quoteSource, pnlSol: terminal.netExecutablePnlSol };
          }
        }
        if (!s.armStatuses.some((a) => a.status === "active")) { s.status = "complete"; this.finalize(s); }
      }
      this.save();
    } finally {
      this.running = false;
    }
  }

  private finalize(s: Session): void {
    if (s.status !== "complete") return;
    if (s.armStatuses.some((a) => a.status === "pending" || a.status === "active")) return;
    // Append-only idempotency: this set is rebuilt from durable result files on every restart.
    // If a process died after append but before saving state, replay reaches here and removes the
    // stale session without writing a duplicate ARM_RESULT_SET.
    if (this.loggedDecisionIds.has(s.decisionId)) {
      this.sessions.delete(s.decisionId);
      this.save();
      return;
    }
    const regimeId = s.regimeId ?? "PUMP_CURVE_V1";
    const quoteSource = s.quoteSource ?? "none";
    const results: ArmResult[] = s.armStatuses.map((a) => {
      if (a.status === "executable" && a.terminal?.kind === "executable") return executableResult(s, a, a.terminal);
      if (a.status === "missing-quote" && a.terminal?.kind === "missing-quote") return missingResult(s, a, a.terminal);
      return skipResult(s, a, regimeId, quoteSource);
    });
    const set: ArmResultSet = { recordType: "ARM_RESULT_SET", armSetId: INTERLEAVED_ARM_SPEC.armSetId, decisionId: s.decisionId, results };
    logRecord("arm-results", set);
    this.loggedDecisionIds.add(s.decisionId);
    logRecord("events", {
      type: "arm-result-set", decisionId: s.decisionId, mint: s.mint, symbol: s.symbol ?? null,
      regimeId, quoteSource, results: results.map((r) => ({ armId: r.armId, action: r.action, execStage: r.execStage, pnl: r.netExecutablePnlSol })),
      measurementEpoch: INTERLEAVED_ARM_SPEC.measurementEpoch, armSpecHash: INTERLEAVED_ARM_SPEC_HASH,
      implementationHash: s.implementationHash, cfg: s.cfg,
    });
    this.sessions.delete(s.decisionId);
    this.save();
  }

  private save(): void {
    try {
      const state: PersistedState = {
        version: 1,
        ledgerStates: Object.fromEntries(Object.entries(this.ledgers).map(([id, ledger]) => [id, ledger.toState()])),
        sessions: [...this.sessions.values()],
      };
      writeFileSync(STATE_PATH, JSON.stringify(state));
    } catch { /* best-effort; append-only ARM_RESULT remains authoritative */ }
  }

  private load(): void {
    if (!existsSync(STATE_PATH)) return;
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as PersistedState;
      if (state.version !== 1) return;
      for (const id of ["A", "B", "C"] as const) {
        const persisted = state.ledgerStates?.[id];
        if (persisted) {
          const cfg = ledgerCfg(id, INTERLEAVED_ARM_SPEC.arms.find((a) => a.armId === id)!.policyId);
          this.ledgers[id] = VirtualArmLedger.fromState(cfg, persisted);
        }
      }
      for (const session of state.sessions ?? []) {
        if (!session.decisionId || this.sessions.has(session.decisionId) || this.loggedDecisionIds.has(session.decisionId)) continue;
        session.decisionAt ??= Date.now(); // legacy in-flight state from the pre-timeout-field build
        session.implementationHash ??= "unknown";
        session.cfg ??= "unknown";
        this.sessions.set(session.decisionId, session);
      }
    } catch (e) {
      ui.warn(`[arms] state load skipped: ${(e as Error).message}`);
    }
  }

  private hydrateLoggedDecisionIds(): void {
    try {
      for (const file of readdirSync(config.logDir).filter((f) => f.startsWith("arm-results-") && f.endsWith(".jsonl"))) {
        for (const line of readFileSync(join(config.logDir, file), "utf8").split("\n")) {
          if (!line.includes('"ARM_RESULT_SET"')) continue;
          try {
            const row = JSON.parse(line) as { recordType?: string; decisionId?: string };
            if (row.recordType === "ARM_RESULT_SET" && row.decisionId) this.loggedDecisionIds.add(row.decisionId);
          } catch { /* malformed rows remain visible to the evaluator; never invent identity */ }
        }
      }
    } catch { /* first run has no arm-results files */ }
  }
}
