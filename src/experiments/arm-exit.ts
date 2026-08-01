import { config } from "../config.js";
import {
  clampedScaleSellQty,
  counterfactualPostBuyReserves,
  curveEntryFill,
  curveExitProceedsSol,
  curveSellSolGross,
  gasPerSideSol,
  replayObservedCurveDelta,
  syntheticAmmExitProceedsSol,
} from "../execution/curve-math.js";
import { INTERLEAVED_ARM_SPEC } from "./arm-spec.js";

export interface ArmEntryMark {
  atMs: number;
  pool: "pump";
  vSol: number;
  vTokens: number;
  realSol: number;
}

export interface ArmMarketMark {
  atMs: number;
  complete: boolean;
  quoteSource: "bonding-curve" | "jupiter-amm";
  vSol: number;
  vTokens: number;
  realSol: number;
  /** True only when vSol/vTokens reconstruct a Jupiter NET quote; venue fees are embedded. */
  syntheticNetReserves?: boolean;
}

export interface ArmPartialLeg {
  tier: number;
  costBasisSol: number;
  proceedsSol: number;
  tokenQtySold: number;
  remainingQty: number;
}

export interface ArmTerminalExit {
  status: "executable";
  reason: "LIQUIDITY_GONE" | "CATASTROPHIC" | "DYNAMIC_TRAIL" | "FIXED_HORIZON";
  atMs: number;
  quoteSource: "bonding-curve" | "jupiter-amm";
  regimeId: "PUMP_CURVE_V1" | "GRADUATED_AMM";
  finalProceedsSol: number;
  totalProceedsSol: number;
  netExecutablePnlSol: number;
}

export interface ArmMissingExit {
  status: "missing-quote";
  reason: string;
  atMs: number;
}

export interface ArmExitTransition {
  partials: ArmPartialLeg[];
  terminal?: ArmTerminalExit | ArmMissingExit;
}

export interface ArmExitState {
  version: 1;
  entry: ArmEntryMark;
  stakeSol: number;
  originalQty: number;
  remainingQty: number;
  remainingCostSol: number;
  bankedProceedsSol: number;
  nextTier: number;
  peakExecProceedsSol: number | null;
  terminal: boolean;
  cfVSol: number;
  cfVTokens: number;
  cfRealSol: number;
  lastObservedVSol: number;
  lastObservedRealSol: number;
}

function dynamicTrailPct(peakGainPct: number): number | null {
  let trail: number | null = null;
  for (const tier of INTERLEAVED_ARM_SPEC.commonExit.dynamicTrail) {
    if (peakGainPct >= tier.gainPct) trail = tier.trailPct;
  }
  return trail;
}

/**
 * Pure exit simulator shared by every arm. It consumes the same market marks and uses the same
 * curve math as PaperTrader; admission policy is the only intended difference between arms.
 */
export class ArmExitSimulation {
  readonly originalQty: number;
  private remainingQty: number;
  private remainingCostSol: number;
  private bankedProceedsSol = 0;
  private nextTier = 0;
  private peakExecProceedsSol: number | null = null;
  private terminal = false;
  // Counterfactual state includes OUR hypothetical buy. Raw mainnet marks do not.
  private cfVSol: number;
  private cfVTokens: number;
  private cfRealSol: number;
  private lastObservedVSol: number;
  private lastObservedRealSol: number;

  constructor(
    readonly entry: ArmEntryMark,
    readonly stakeSol: number = INTERLEAVED_ARM_SPEC.stakeSol,
  ) {
    const fill = curveEntryFill(entry.vSol, entry.vTokens, stakeSol, entry.pool);
    this.originalQty = fill.tokenQty;
    if (!(this.originalQty > 0)) throw new Error("entry mark cannot produce executable token quantity");
    this.remainingQty = this.originalQty;
    this.remainingCostSol = stakeSol;
    const postBuy = counterfactualPostBuyReserves(entry, fill);
    this.cfVSol = postBuy.vSol;
    this.cfVTokens = postBuy.vTokens;
    this.cfRealSol = postBuy.realSol;
    this.lastObservedVSol = entry.vSol;
    this.lastObservedRealSol = entry.realSol;
    this.peakExecProceedsSol = this.proceedsAt({
      ...entry,
      complete: false,
      quoteSource: "bonding-curve",
      vSol: this.cfVSol,
      vTokens: this.cfVTokens,
      realSol: this.cfRealSol,
    }, this.remainingQty);
  }

  onMark(mark: ArmMarketMark): ArmExitTransition {
    if (this.terminal) throw new Error("arm exit simulation is already terminal");
    if (mark.atMs < this.entry.atMs) throw new Error("market mark predates entry");
    const partials: ArmPartialLeg[] = [];
    const ageSec = (mark.atMs - this.entry.atMs) / 1_000;

    if (mark.quoteSource === "bonding-curve" && !mark.complete && mark.vSol < 2) {
      return { partials, terminal: this.close(mark, "LIQUIDITY_GONE", 0) };
    }

    const effectiveMark = mark.quoteSource === "bonding-curve" && !mark.complete
      ? this.advanceCounterfactualCurve(mark)
      : mark;
    let execProceeds = this.proceedsAt(effectiveMark, this.remainingQty);
    const execPnlPct = this.remainingCostSol > 0
      ? ((execProceeds - this.remainingCostSol) / this.remainingCostSol) * 100
      : 0;
    if (execPnlPct <= INTERLEAVED_ARM_SPEC.commonExit.catastrophicStopPct) {
      return { partials, terminal: this.close(effectiveMark, "CATASTROPHIC", execProceeds) };
    }

    if (this.peakExecProceedsSol == null || execProceeds > this.peakExecProceedsSol) {
      this.peakExecProceedsSol = execProceeds;
    }
    const peakGainBeforePartials = this.remainingCostSol > 0
      ? ((this.peakExecProceedsSol - this.remainingCostSol) / this.remainingCostSol) * 100
      : 0;

    // Same-tick tiers walk the local reserves sequentially. The next external mark starts from
    // the observed market again because paper trades do not mutate mainnet.
    let walkVSol = effectiveMark.vSol;
    let walkVTokens = effectiveMark.vTokens;
    let walkRealSol = effectiveMark.realSol;
    while (this.nextTier < INTERLEAVED_ARM_SPEC.commonExit.tiers.length) {
      const tier = INTERLEAVED_ARM_SPEC.commonExit.tiers[this.nextTier]!;
      if (execPnlPct < tier.gainPct) break;
      const qty = clampedScaleSellQty(
        this.originalQty,
        this.remainingQty,
        tier.sellFrac,
        INTERLEAVED_ARM_SPEC.commonExit.minRunnerFrac,
      );
      if (!(qty > 0)) break;
      const proceeds = effectiveMark.syntheticNetReserves
        ? syntheticAmmExitProceedsSol(walkVSol, walkVTokens, qty, walkRealSol)
        : curveExitProceedsSol(walkVSol, walkVTokens, qty, this.entry.pool, effectiveMark.complete, walkRealSol);
      const gross = curveSellSolGross(walkVSol, walkVTokens, qty);
      walkVSol = Math.max(0, walkVSol - gross);
      walkVTokens += qty;
      walkRealSol = Math.max(0, walkRealSol - gross);
      const costBasis = this.remainingCostSol * (qty / this.remainingQty);
      this.remainingQty -= qty;
      this.remainingCostSol -= costBasis;
      this.bankedProceedsSol += proceeds;
      partials.push({
        tier: this.nextTier,
        costBasisSol: costBasis,
        proceedsSol: proceeds,
        tokenQtySold: qty,
        remainingQty: this.remainingQty,
      });
      this.nextTier++;
    }

    if (partials.length) {
      if (effectiveMark.quoteSource === "bonding-curve" && !effectiveMark.complete) {
        this.cfVSol = walkVSol;
        this.cfVTokens = walkVTokens;
        this.cfRealSol = walkRealSol;
      }
      // A partial creates a smaller fresh runner. Seed its HWM from the walked same-tick state and
      // never let the pre-partial peak immediately stop the residual on that same mark.
      execProceeds = effectiveMark.syntheticNetReserves
        ? syntheticAmmExitProceedsSol(walkVSol, walkVTokens, this.remainingQty, walkRealSol)
        : curveExitProceedsSol(walkVSol, walkVTokens, this.remainingQty, this.entry.pool, effectiveMark.complete, walkRealSol);
      this.peakExecProceedsSol = execProceeds;
    } else {
      const peak = this.peakExecProceedsSol ?? execProceeds;
      const peakGainPct = this.remainingCostSol > 0 ? ((peak - this.remainingCostSol) / this.remainingCostSol) * 100 : 0;
      const drawdownPct = peak > 0 ? ((execProceeds - peak) / peak) * 100 : 0;
      const trail = dynamicTrailPct(peakGainPct);
      if (trail != null && drawdownPct <= -trail) {
        return { partials, terminal: this.close(effectiveMark, "DYNAMIC_TRAIL", execProceeds) };
      }
    }

    if (ageSec >= INTERLEAVED_ARM_SPEC.horizonSec) {
      const finalProceeds = partials.length
        ? (effectiveMark.syntheticNetReserves
          ? syntheticAmmExitProceedsSol(walkVSol, walkVTokens, this.remainingQty, walkRealSol)
          : curveExitProceedsSol(walkVSol, walkVTokens, this.remainingQty, this.entry.pool, effectiveMark.complete, walkRealSol))
        : execProceeds;
      return { partials, terminal: this.close(effectiveMark, "FIXED_HORIZON", finalProceeds) };
    }
    void peakGainBeforePartials; // retained as an explicit pre-partial state invariant
    return { partials };
  }

  finishMissing(atMs: number, reason: string): ArmMissingExit {
    if (this.terminal) throw new Error("arm exit simulation is already terminal");
    this.terminal = true;
    return { status: "missing-quote", reason, atMs };
  }

  snapshot(): {
    remainingQty: number;
    remainingCostSol: number;
    bankedProceedsSol: number;
    nextTier: number;
    terminal: boolean;
  } {
    return {
      remainingQty: this.remainingQty,
      remainingCostSol: this.remainingCostSol,
      bankedProceedsSol: this.bankedProceedsSol,
      nextTier: this.nextTier,
      terminal: this.terminal,
    };
  }

  toState(): ArmExitState {
    return {
      version: 1,
      entry: { ...this.entry },
      stakeSol: this.stakeSol,
      originalQty: this.originalQty,
      remainingQty: this.remainingQty,
      remainingCostSol: this.remainingCostSol,
      bankedProceedsSol: this.bankedProceedsSol,
      nextTier: this.nextTier,
      peakExecProceedsSol: this.peakExecProceedsSol,
      terminal: this.terminal,
      cfVSol: this.cfVSol,
      cfVTokens: this.cfVTokens,
      cfRealSol: this.cfRealSol,
      lastObservedVSol: this.lastObservedVSol,
      lastObservedRealSol: this.lastObservedRealSol,
    };
  }

  static fromState(state: ArmExitState): ArmExitSimulation {
    if (state.version !== 1) throw new Error("unsupported arm exit state version");
    const sim = new ArmExitSimulation(state.entry, state.stakeSol);
    if (Math.abs(sim.originalQty - state.originalQty) > Math.max(1e-9, sim.originalQty * 1e-12)) {
      throw new Error("arm exit entry fill changed under persisted state");
    }
    const finite = [
      state.remainingQty,
      state.remainingCostSol,
      state.bankedProceedsSol,
      state.cfVSol,
      state.cfVTokens,
      state.cfRealSol,
      state.lastObservedVSol,
      state.lastObservedRealSol,
    ];
    if (!finite.every(Number.isFinite) || finite.some((n) => n < 0)) {
      throw new Error("arm exit state contains invalid numeric values");
    }
    if (
      !Number.isInteger(state.nextTier)
      || state.nextTier < 0
      || state.nextTier > INTERLEAVED_ARM_SPEC.commonExit.tiers.length
    ) throw new Error("arm exit state contains invalid tier");
    sim.remainingQty = state.remainingQty;
    sim.remainingCostSol = state.remainingCostSol;
    sim.bankedProceedsSol = state.bankedProceedsSol;
    sim.nextTier = state.nextTier;
    sim.peakExecProceedsSol = state.peakExecProceedsSol;
    sim.terminal = state.terminal;
    sim.cfVSol = state.cfVSol;
    sim.cfVTokens = state.cfVTokens;
    sim.cfRealSol = state.cfRealSol;
    sim.lastObservedVSol = state.lastObservedVSol;
    sim.lastObservedRealSol = state.lastObservedRealSol;
    return sim;
  }

  private proceedsAt(mark: ArmMarketMark, qty: number): number {
    return mark.syntheticNetReserves
      ? syntheticAmmExitProceedsSol(mark.vSol, mark.vTokens, qty, mark.realSol)
      : curveExitProceedsSol(mark.vSol, mark.vTokens, qty, this.entry.pool, mark.complete, mark.realSol);
  }

  /**
   * Replay the external net reserve deltas onto the curve state that already contains our paper
   * buy/partials. This preserves x*y=k and stops raw mainnet `realSol=0` from deleting the SOL
   * that our counterfactual entry itself contributed.
   */
  private advanceCounterfactualCurve(mark: ArmMarketMark): ArmMarketMark {
    const replayed = replayObservedCurveDelta(
      { vSol: this.cfVSol, vTokens: this.cfVTokens, realSol: this.cfRealSol },
      { vSol: this.lastObservedVSol, realSol: this.lastObservedRealSol },
      mark,
    );
    this.cfVSol = replayed.vSol;
    this.cfVTokens = replayed.vTokens;
    this.cfRealSol = replayed.realSol;
    this.lastObservedVSol = mark.vSol;
    this.lastObservedRealSol = mark.realSol;
    return {
      ...mark,
      vSol: this.cfVSol,
      vTokens: this.cfVTokens,
      realSol: this.cfRealSol,
    };
  }

  private close(
    mark: ArmMarketMark,
    reason: ArmTerminalExit["reason"],
    remainingProceedsSol: number,
  ): ArmTerminalExit {
    this.terminal = true;
    // Final sale leaves a zero token balance; reclaim ATA rent exactly as PaperTrader does.
    const ataReclaim = config.risk.ataReclaim
      ? Math.max(0, config.risk.ataRentSol - gasPerSideSol())
      : 0;
    const finalProceedsSol = Math.max(0, remainingProceedsSol) + ataReclaim;
    const totalProceedsSol = this.bankedProceedsSol + finalProceedsSol;
    return {
      status: "executable",
      reason,
      atMs: mark.atMs,
      quoteSource: mark.quoteSource,
      regimeId: mark.complete ? "GRADUATED_AMM" : "PUMP_CURVE_V1",
      finalProceedsSol,
      totalProceedsSol,
      netExecutablePnlSol: totalProceedsSol - this.stakeSol,
    };
  }
}
