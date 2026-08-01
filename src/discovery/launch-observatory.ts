import { bondingCurvePricesMulti, lowPriorityRpc, quoteMintIsSol, devTradeHistory } from "../safety/onchain.js";
import { logRecord } from "../util/log.js";
import { config, configHash } from "../config.js";
import { classifyLaunch } from "./setup-filter.js";
import { recordOutcome } from "../memory/actor-memory.js";
import type { Candidate } from "../types.js";

/**
 * COUNTERFACTUAL LAUNCH OBSERVATORY (owner spec #3 — follow ALL launches, not just bought).
 *
 * For every launch we SEE (whether or not we enter), track its EXECUTABLE curve value over time
 * so we can answer objectively: does setup-filtering improve expectancy, or does it just miss
 * fat-tail winners? Records executable buy/sell state at intervals → the counterfactual dataset
 * for the 3 shadow strategies (setup / momentum / blind). Bounded + batched to respect the RPC
 * budget: all tracked curves read in ONE getMultipleAccounts per tick.
 */
interface Watched {
  mint: string; decisionId?: string; sym?: string; bcKey: string; pool?: string; creator?: string;
  isMayhemMode?: boolean; isCashbackCoin?: boolean; quoteMint?: string;
  launchAt: number; setupVerdict?: string; setupConfidence?: number; setupVerdictAtSec?: number; classifying?: boolean;
  entryVSol?: number; entryVTokens?: number; // reserves at first observation ≈ launch state
  firstPricedAtSec?: number;
  peakVSol: number; lastVSol: number; done: boolean; samplesLogged: number;
  timeTo: Record<string, number>; // "+50","+100",... → sec since launch when curve value first hit
  mfePct: number; maePct: number; // max favourable / adverse excursion (curve-value gain%)
  everPriced: boolean; // did we ever get a valid price? (else unpriceable)
  prevVSol?: number; prevSec?: number; // for velocity (net SOL/s inflow) = production momentum signal
}

function observedRegime(w: Pick<Watched, "pool" | "isMayhemMode" | "quoteMint">): string {
  if (w.isMayhemMode) return "PUMP_CURVE_MAYHEM";
  if (!quoteMintIsSol(w.quoteMint)) return "NON_SOL_QUOTE";
  const pool = (w.pool ?? "").toLowerCase();
  if (pool === "pump") return "PUMP_CURVE_V1";
  if (pool) return `POOL_${pool.toUpperCase()}`;
  return "UNKNOWN_REGIME";
}

export class LaunchObservatory {
  private watched = new Map<string, Watched>();
  private timer?: ReturnType<typeof setInterval>;
  private busy?: () => boolean; // "the trading pipeline has a backlog" — pause research work

  /** Let the observatory see the live candidate backlog so research never competes with entries. */
  setBusyProbe(fn: () => boolean): void { this.busy = fn; }

  start(): void {
    if (!config.observatory.enabled) return;
    this.timer = setInterval(() => void this.tick(), config.observatory.sampleMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }
  size(): number { return this.watched.size; }

  /**
   * AUDIT P1-5: at 200 slots × up to 3600s each, sustained throughput tops out around ~200
   * launches/hour — far under the actual launch rate, so the map sat permanently full and every
   * arrival past that point was dropped outright (measured: 52-93% of launches on busy days).
   * Growing `maxWatch` doesn't fix a rate mismatch, it just moves the ceiling. Instead: when full,
   * evict the WEAKEST currently-watched entry (oldest + flattest, i.e. already priced and
   * essentially motionless for a while, or one that never even got priced despite a fair grace
   * period) rather than refuse every newcomer — a slot occupied by a token that has shown nothing
   * for minutes is lower research value than an unobserved brand-new launch. If nothing is safely
   * evictable (everything watched is either too young to judge or genuinely still moving), fall
   * back to the original drop — never evict a token that might still turn out to matter.
   */
  private static readonly MIN_AGE_FOR_EVICTION_SEC = 120; // give every entry a fair look first
  private static readonly FLAT_MFE_PCT = 5; // "hasn't moved" bar — well under real momentum

  private findEvictionCandidate(now: number): [string, Watched] | null {
    let best: [string, Watched] | null = null;
    let bestScore = -Infinity;
    for (const [mint, w] of this.watched) {
      if (w.done) continue;
      const ageSec = (now - w.launchAt) / 1000;
      if (ageSec < LaunchObservatory.MIN_AGE_FOR_EVICTION_SEC) continue; // too young to judge
      const neverPriced = !w.everPriced;
      const flat = w.everPriced && w.mfePct < LaunchObservatory.FLAT_MFE_PCT;
      if (!neverPriced && !flat) continue; // showing real movement — not evictable
      // Prefer evicting the OLDEST flat/unpriced entry (had the longest fair look and still
      // nothing) — score = age, unpriced entries score a small bonus (even less useful than
      // "flat but at least real").
      const score = ageSec + (neverPriced ? 300 : 0);
      if (score > bestScore) { bestScore = score; best = [mint, w]; }
    }
    return best;
  }

  /** Register a launch to follow (called for EVERY fast-follow candidate, entered or not). */
  observe(c: Candidate, setupVerdict?: string): void {
    if (!config.observatory.enabled || c.mode !== "fast-follow" || !c.bondingCurveKey) return;
    if (this.watched.has(c.mint)) return;
    if (this.watched.size >= config.observatory.maxWatch) {
      const now = Date.now();
      const victim = this.findEvictionCandidate(now);
      if (victim) {
        const [victimMint, w] = victim;
        const ageSec = Math.round((now - w.launchAt) / 1000);
        logRecord("events", { type: "observatory-evict", decisionId: c.decisionId ?? null, mint: c.mint,
          evictedMint: victimMint, evictedSym: w.sym, evictedAgeSec: ageSec, evictedMfePct: Number(w.mfePct.toFixed(1)),
          evictedNeverPriced: !w.everPriced, maxWatch: config.observatory.maxWatch, cfg: configHash });
        this.finish(victimMint, w, ageSec, false, "evicted-early");
      } else {
        logRecord("events", {
          type: "observatory-capacity-drop",
          decisionId: c.decisionId ?? null,
          mint: c.mint,
          maxWatch: config.observatory.maxWatch,
          cfg: configHash,
        });
        return;
      }
    }
    const launchAt = c.detectedAt || Date.now();
    this.watched.set(c.mint, {
      mint: c.mint,
      decisionId: c.decisionId,
      sym: c.symbol,
      bcKey: c.bondingCurveKey,
      pool: c.pool,
      creator: c.creator,
      isMayhemMode: c.isMayhemMode,
      isCashbackCoin: c.isCashbackCoin,
      quoteMint: c.quoteMint,
      launchAt,
      setupVerdict,
      setupVerdictAtSec: setupVerdict ? Math.max(0, Math.round((Date.now() - launchAt) / 1000)) : undefined,
      peakVSol: 0,
      lastVSol: 0,
      done: false,
      samplesLogged: 0,
      timeTo: {},
      mfePct: 0,
      maePct: 0,
      everPriced: false,
    });
  }

  /** Stamp the SETUP verdict once the classifier has run (fixes shadow: setupVerdict was always
   *  undefined because observe() runs before classification). Makes setup ≠ blind. */
  setVerdict(mint: string, verdict: string, confidence?: number): void {
    const w = this.watched.get(mint);
    if (!w || w.setupVerdict) return; // first decision-time verdict is immutable
    w.setupVerdict = verdict;
    w.setupVerdictAtSec = Math.max(0, Math.round((Date.now() - w.launchAt) / 1000));
    if (confidence != null) w.setupConfidence = confidence;
  }

  private async tick(): Promise<void> {
    if (this.watched.size === 0) return;
    const now = Date.now();
    const keys = [...this.watched.values()].filter((w) => !w.done).map((w) => w.bcKey);
    const batch = keys.length ? await bondingCurvePricesMulti(keys) : new Map();
    for (const [mint, w] of [...this.watched]) {
      const ageSec = Math.round((now - w.launchAt) / 1000);
      const bc = batch.get(w.bcKey);
      if (!bc) {
        if (ageSec >= config.observatory.maxAgeSec) this.finish(mint, w, ageSec);
        continue;
      }
      w.isMayhemMode = w.isMayhemMode === true || bc.isMayhemMode;
      w.isCashbackCoin = w.isCashbackCoin === true || bc.isCashbackCoin;
      if (bc.quoteMint) w.quoteMint = bc.quoteMint;
      if (bc.isMayhemMode || !bc.quoteIsSol) {
        this.finish(mint, w, ageSec, false, "unsupported-regime");
        continue;
      }
      if (w.entryVSol == null) {
        w.entryVSol = bc.vSol;
        w.entryVTokens = bc.vTokens;
        w.firstPricedAtSec = ageSec;
      }
      w.lastVSol = bc.vSol; if (bc.vSol > w.peakVSol) w.peakVSol = bc.vSol;
      if (bc.vSol > 0 && bc.vTokens > 0) w.everPriced = true;
      // executable value proxy = curve-value gain vs launch state (marginal — cheap, comparable)
      const gainPct = w.entryVSol && w.entryVSol > 0 ? ((bc.vSol - w.entryVSol) / w.entryVSol) * 100 : 0;
      if (gainPct > w.mfePct) w.mfePct = gainPct; // max favourable excursion
      if (gainPct < w.maePct) w.maePct = gainPct; // max adverse excursion
      for (const thr of [50, 100, 250, 500, 800]) { const k = "+" + thr; if (!(k in w.timeTo) && gainPct >= thr) w.timeTo[k] = ageSec; }
      // sample at coarse cadence to keep log volume sane
      const horizonMark = ageSec >= config.observatory.maxAgeSec;
      if ((w.samplesLogged < config.observatory.maxSamplesPerLaunch && this.dueSample(ageSec)) || horizonMark) {
        w.samplesLogged++;
        // velocity = net SOL/s inflow since the previous sample (the PRODUCTION momentum signal,
        // not a raw gainPct proxy) — so the shadow momentum arm uses the real predicate.
        const velSol = (w.prevVSol != null && w.prevSec != null && ageSec > w.prevSec) ? (bc.vSol - w.prevVSol) / (ageSec - w.prevSec) : 0;
        w.prevVSol = bc.vSol; w.prevSec = ageSec;
        logRecord("path", {
          obs: true,
          decisionId: w.decisionId ?? null,
          measurementEpoch: config.measurementEpoch,
          regimeId: observedRegime(w),
          isMayhemMode: w.isMayhemMode ?? false,
          mint,
          sym: w.sym,
          sec: ageSec,
          vSol: Number(bc.vSol.toFixed(4)),
          vTokens: Number(bc.vTokens.toFixed(2)),
          realSol: Number(bc.realSol.toFixed(4)),
          gainPct: Number(gainPct.toFixed(1)),
          velSol: Number(velSol.toFixed(4)),
          complete: bc.complete,
          fixedHorizon: horizonMark,
          firstPricedAtSec: w.firstPricedAtSec,
          setupVerdict: w.setupVerdict,
          setupVerdictAtSec: w.setupVerdictAtSec,
          cfg: configHash,
        });
      }
      if (bc.complete || bc.vSol < 2) this.finish(mint, w, ageSec, bc.complete); // graduated or drained → done
      else if (horizonMark) this.finish(mint, w, ageSec);
    }
    // COUNTERFACTUAL CLASSIFY (owner spec): classify launches WE DIDN'T ENTER too, so the shadow
    // is a real setup-vs-blind comparison. Rate-limited: up to maxClassifyPerTick per tick, only
    // launches past a min age (survived the first seconds) that lack a verdict. Respects RPC via
    // the per-API buckets in the enrichment functions.
    // RPC PRIORITY (latency fix): this is RESEARCH, not trading. It runs inside lowPriorityRpc
    // so every RPC it makes is drawn from the small research slice and is DROPPED outright
    // whenever a live gate/entry/tick RPC is in flight. Previously it ran at 3 classifications
    // per 3s tick × ~6 RPC each ≈ 6 req/s against an 8 req/s budget — it was starving the very
    // entries it was meant to be a counterfactual for. It also backs off when the candidate
    // queue is deep, so a launch burst always gets the full budget.
    if (config.observatory.classifyAll && !this.busy?.()) {
      let done = 0;
      for (const [mint, w] of this.watched) {
        if (done >= config.observatory.maxClassifyPerTick) break;
        if (w.setupVerdict || w.classifying || w.done) continue;
        const age = Math.round((now - w.launchAt) / 1000);
        if (age < config.observatory.minClassifyAgeSec) continue;
        w.classifying = true; done++;
        void lowPriorityRpc(() => classifyLaunch(mint, w.creator, w.pool, w.isMayhemMode, w.quoteMint))
          .then((v) => {
            if (!w.setupVerdict) {
              w.setupVerdict = v.verdict;
              w.setupConfidence = v.confidence;
              w.setupVerdictAtSec = Math.max(0, Math.round((Date.now() - w.launchAt) / 1000));
            }
            w.classifying = false;
          })
          .catch(() => { w.classifying = false; }); // includes ResearchYield — retried on a later tick
      }
    }
  }
  private dueSample(ageSec: number): boolean {
    // dense early (1,3,5,10,30s), then sparse (1,5,15,30,60m)
    const marks = [1, 3, 5, 10, 30, 60, 300, 900, 1800, 3600];
    return marks.some((m) => Math.abs(ageSec - m) <= 2);
  }
  private finish(mint: string, w: Watched, ageSec: number, complete = false, forcedOutcome?: string): void {
    if (!w.done) {
      w.done = true;
      const peakGain = w.entryVSol && w.entryVSol > 0 ? ((w.peakVSol - w.entryVSol) / w.entryVSol) * 100 : 0;
      // EXPLICIT terminal outcome (audit: include unpriceable/rapid-rug, don't drop):
      //   unpriceable — never got a valid price (couldn't trade at all)
      //   rapid-rug   — drained within a short window
      //   drained     — liquidity gone later
      //   graduated   — migrated to AMM
      //   faded       — reached horizon still on the curve, no big move
      const drained = w.lastVSol < 2;
      const outcome = forcedOutcome ?? (!w.everPriced ? "unpriceable"
        : complete ? "graduated"
        : drained && ageSec <= config.observatory.rapidRugSec ? "rapid-rug"
        : drained ? "drained"
        : "faded");
      logRecord("path", { obs: true, summary: true, decisionId: w.decisionId ?? null, measurementEpoch: config.measurementEpoch,
        regimeId: observedRegime(w), isMayhemMode: w.isMayhemMode ?? false,
        isCashbackCoin: w.isCashbackCoin ?? false, quoteMint: w.quoteMint ?? null,
        mint, sym: w.sym, setupVerdict: w.setupVerdict, setupConfidence: w.setupConfidence, setupVerdictAtSec: w.setupVerdictAtSec,
        firstPricedAtSec: w.firstPricedAtSec, fixedHorizonSec: config.observatory.maxAgeSec,
        launchAgeSec: ageSec, peakGainPct: Number(peakGain.toFixed(1)), mfePct: Number(w.mfePct.toFixed(1)), maePct: Number(w.maePct.toFixed(1)),
        timeToTargets: w.timeTo, outcome, cfg: configHash });
      // ACTOR MEMORY from ALL launches (owner spec — was only from BOUGHT tokens). Every observed
      // launch's terminal outcome teaches the creator's reputation, so we learn a rugger from the
      // launches we CORRECTLY skipped too. observedOnly=true so it isn't counted as our trade.
      if (w.creator && outcome !== "unsupported-regime") recordOutcome({ creator: w.creator, funders: undefined, metaHash: undefined,
        rugged: outcome === "drained" || outcome === "rapid-rug", abandoned: outcome === "faded" || outcome === "unpriceable",
        sellableWin: outcome === "graduated" || peakGain >= 100, devSellSec: null, at: Date.now(), observedOnly: true });
      // ── SWING-THESIS SIGNAL SNAPSHOT (owner: "cari mc besar-menengah, holder banyak, dev-buy
      // tanpa jual — apakah ini beneran memprediksi hasil?"). Fired ONCE per graduation, at the
      // moment of graduation — this is the "signal AT entry-like time" half of the question. The
      // "outcome N hours later" half is answered later by re-checking these same mints via
      // pump.fun's free swap-api (works post-graduation too — verified 2026-07-26, program
      // "pump_amm" trades hours after migration). Fire-and-forget: never blocks the observatory
      // tick, never touches any trading decision, and a failure here is swallowed, not thrown.
      if (outcome === "graduated") void this.recordGraduationSignal(mint, w, peakGain);
    }
    this.watched.delete(mint);
  }

  private async recordGraduationSignal(mint: string, w: Watched, peakGainPct: number): Promise<void> {
    try {
      const host = config.solTracker.host;
      let holders: number | null = null, riskScore: number | null = null, rugged: boolean | null = null;
      if (host) {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8_000);
          const res = await fetch(`${host}/tokens/${mint}`, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
          if (res.ok) {
            const j = (await res.json()) as { holders?: number; risk?: { score?: number; rugged?: boolean } };
            holders = typeof j.holders === "number" ? j.holders : null;
            riskScore = j.risk?.score ?? null;
            rugged = j.risk?.rugged ?? null;
          }
        } catch { /* Data API best-effort — never block the signal record on it */ }
      }
      // Dev/creator behaviour, our own free RPC — research priority so it never competes with
      // a live gate/entry/tick call for pool budget (same pattern as classifyLaunch above).
      const dev = w.creator ? await lowPriorityRpc(() => devTradeHistory(w.creator!, mint, config.dev.historyLimit)).catch(() => null) : null;
      logRecord("events", {
        type: "graduation-signal",
        measurementEpoch: config.measurementEpoch,
        mint, sym: w.sym, creator: w.creator ?? null,
        peakGainPct: Number(peakGainPct.toFixed(1)),
        entryVSol: w.entryVSol ?? null, peakVSol: w.peakVSol,
        holders, riskScore, rugged,
        devBuys: dev?.buys ?? null, devSells: dev?.sells ?? null, devOnlyBuys: dev?.onlyBuys ?? null,
        at: Date.now(), cfg: configHash,
      });
    } catch { /* measurement-only — a failure here must never surface as a trading fault */ }
  }
}
