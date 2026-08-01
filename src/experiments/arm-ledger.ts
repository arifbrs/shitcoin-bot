/**
 * Independent virtual capital/exposure ledger for one interleaved paper arm.
 *
 * Each arm gets its own instance. Market observations may be shared, but free cash, pending
 * reservations, position slots and actor-cluster exposure never are.
 */
export interface ArmLedgerConfig {
  armId: string;
  policyId: string;
  startingSol: number;
  maxPositions: number;
  maxPerCluster: number;
}

export interface ArmAdmission {
  decisionId: string;
  mint: string;
  stakeSol: number;
  clusterIds?: string[];
}

export type AdmissionFailure =
  | "DUPLICATE_DECISION"
  | "MINT_ALREADY_OPEN"
  | "POSITION_CAP"
  | "CLUSTER_CAP"
  | "INSUFFICIENT_CAPITAL";

export type AdmissionResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: AdmissionFailure };

interface Reservation extends ArmAdmission {
  reservationId: string;
  clusterIds: string[];
}

interface ArmPosition extends ArmAdmission {
  clusterIds: string[];
  remainingCostLamports: number;
}

export interface ArmLedgerSnapshot {
  armId: string;
  policyId: string;
  startingSol: number;
  freeSol: number;
  pendingSol: number;
  availableSol: number;
  deployedCostSol: number;
  realizedPnlSol: number;
  quarantinedSol: number;
  openPositions: number;
  pendingReservations: number;
}

export interface ArmLedgerState {
  version: 1;
  cfg: ArmLedgerConfig;
  freeLamports: number;
  pendingLamports: number;
  realizedPnlLamports: number;
  quarantinedLamports: number;
  seenDecisions: string[];
  reservations: Reservation[];
  positions: ArmPosition[];
}

const cleanClusters = (ids: string[] | undefined): string[] =>
  [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
const LAMPORTS_PER_SOL = 1_000_000_000;
const toLamports = (sol: number): number => Math.round(sol * LAMPORTS_PER_SOL);
const toSol = (lamports: number): number => lamports / LAMPORTS_PER_SOL;

export class VirtualArmLedger {
  private readonly reservations = new Map<string, Reservation>();
  private readonly positions = new Map<string, ArmPosition>();
  private readonly seenDecisions = new Set<string>();
  private freeLamports: number;
  private pendingLamports = 0;
  private realizedPnlLamports = 0;
  private quarantinedLamports = 0;

  constructor(readonly cfg: ArmLedgerConfig) {
    if (!(cfg.startingSol > 0)) throw new Error("startingSol must be positive");
    if (!(cfg.maxPositions > 0)) throw new Error("maxPositions must be positive");
    if (!(cfg.maxPerCluster > 0)) throw new Error("maxPerCluster must be positive");
    this.freeLamports = toLamports(cfg.startingSol);
  }

  admit(input: ArmAdmission): AdmissionResult {
    if (this.seenDecisions.has(input.decisionId)) {
      return { ok: false, reason: "DUPLICATE_DECISION" };
    }
    // One decision is final even when it skips for capital/exposure; a later retry would use future
    // bankroll state and turn an interleaved launch comparison into asynchronous selection.
    this.seenDecisions.add(input.decisionId);
    if ([...this.positions.values(), ...this.reservations.values()].some((p) => p.mint === input.mint)) {
      return { ok: false, reason: "MINT_ALREADY_OPEN" };
    }
    if (this.positions.size + this.reservations.size >= this.cfg.maxPositions) {
      return { ok: false, reason: "POSITION_CAP" };
    }
    const clusterIds = cleanClusters(input.clusterIds);
    if (clusterIds.some((id) => this.clusterExposure(id) >= this.cfg.maxPerCluster)) {
      return { ok: false, reason: "CLUSTER_CAP" };
    }
    const stakeLamports = toLamports(input.stakeSol);
    if (!(stakeLamports > 0) || this.freeLamports - this.pendingLamports < stakeLamports) {
      return { ok: false, reason: "INSUFFICIENT_CAPITAL" };
    }
    const reservationId = `${this.cfg.armId}:${input.decisionId}`;
    this.reservations.set(reservationId, { ...input, clusterIds, reservationId });
    this.pendingLamports += stakeLamports;
    return { ok: true, reservationId };
  }

  commit(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`unknown reservation ${reservationId}`);
    this.reservations.delete(reservationId);
    const stakeLamports = toLamports(reservation.stakeSol);
    this.pendingLamports -= stakeLamports;
    this.freeLamports -= stakeLamports;
    this.positions.set(reservation.decisionId, {
      decisionId: reservation.decisionId,
      mint: reservation.mint,
      stakeSol: reservation.stakeSol,
      clusterIds: reservation.clusterIds,
      remainingCostLamports: stakeLamports,
    });
  }

  cancel(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return; // idempotent cancellation
    this.reservations.delete(reservationId);
    this.pendingLamports -= toLamports(reservation.stakeSol);
  }

  /**
   * Realize one partial leg immediately. This is essential for an honest capital comparison:
   * principal returned by Arm B must become available to Arm B only, while its unsold runner
   * continues occupying one slot and its remaining cost basis stays deployed.
   */
  partial(decisionId: string, costBasisSol: number, proceedsSol: number): void {
    const position = this.positions.get(decisionId);
    if (!position) throw new Error(`unknown open decision ${decisionId}`);
    const costLamports = toLamports(costBasisSol);
    const proceedsLamports = toLamports(proceedsSol);
    if (!(costLamports > 0) || costLamports > position.remainingCostLamports) {
      throw new Error("invalid partial cost basis");
    }
    if (!(Number.isFinite(proceedsSol) && proceedsSol >= 0)) throw new Error("invalid partial proceeds");
    position.remainingCostLamports -= costLamports;
    this.freeLamports += proceedsLamports;
    this.realizedPnlLamports += proceedsLamports - costLamports;
  }

  close(decisionId: string, proceedsSol: number): void {
    const position = this.positions.get(decisionId);
    if (!position) throw new Error(`unknown open decision ${decisionId}`);
    if (!(Number.isFinite(proceedsSol) && proceedsSol >= 0)) throw new Error("invalid proceeds");
    this.positions.delete(decisionId);
    const proceedsLamports = toLamports(proceedsSol);
    this.freeLamports += proceedsLamports;
    this.realizedPnlLamports += proceedsLamports - position.remainingCostLamports;
  }

  /**
   * Terminal measurement failure: remove the slot but DO NOT turn unknown value into a zero-loss
   * or zero-proceeds observation. Remaining cost stays unavailable to future admissions and is
   * reported separately until an external reconciliation resolves it.
   */
  quarantine(decisionId: string): void {
    const position = this.positions.get(decisionId);
    if (!position) throw new Error(`unknown open decision ${decisionId}`);
    this.positions.delete(decisionId);
    this.quarantinedLamports += position.remainingCostLamports;
  }

  snapshot(): ArmLedgerSnapshot {
    const deployedLamports = [...this.positions.values()]
      .reduce((sum, position) => sum + position.remainingCostLamports, 0);
    return {
      armId: this.cfg.armId,
      policyId: this.cfg.policyId,
      startingSol: this.cfg.startingSol,
      freeSol: toSol(this.freeLamports),
      pendingSol: toSol(this.pendingLamports),
      availableSol: toSol(this.freeLamports - this.pendingLamports),
      deployedCostSol: toSol(deployedLamports),
      realizedPnlSol: toSol(this.realizedPnlLamports),
      quarantinedSol: toSol(this.quarantinedLamports),
      openPositions: this.positions.size,
      pendingReservations: this.reservations.size,
    };
  }

  /** Deterministic persistent state; integer lamports make restart replay byte-stable. */
  toState(): ArmLedgerState {
    const byDecision = <T extends { decisionId: string }>(a: T, b: T) =>
      a.decisionId.localeCompare(b.decisionId);
    return {
      version: 1,
      cfg: { ...this.cfg },
      freeLamports: this.freeLamports,
      pendingLamports: this.pendingLamports,
      realizedPnlLamports: this.realizedPnlLamports,
      quarantinedLamports: this.quarantinedLamports,
      seenDecisions: [...this.seenDecisions].sort(),
      reservations: [...this.reservations.values()].map((x) => ({ ...x, clusterIds: [...x.clusterIds] })).sort(byDecision),
      positions: [...this.positions.values()].map((x) => ({ ...x, clusterIds: [...x.clusterIds] })).sort(byDecision),
    };
  }

  static fromState(cfg: ArmLedgerConfig, state: ArmLedgerState): VirtualArmLedger {
    if (state.version !== 1) throw new Error("unsupported arm ledger state version");
    if (JSON.stringify(state.cfg) !== JSON.stringify(cfg)) throw new Error("arm ledger config mismatch");
    const ledger = new VirtualArmLedger(cfg);
    const integers = [
      state.freeLamports,
      state.pendingLamports,
      state.realizedPnlLamports,
      state.quarantinedLamports,
    ];
    if (!integers.every(Number.isSafeInteger)) throw new Error("arm ledger contains non-integer lamports");
    if (state.freeLamports < 0 || state.pendingLamports < 0 || state.quarantinedLamports < 0) {
      throw new Error("arm ledger contains negative capital");
    }
    ledger.freeLamports = state.freeLamports;
    ledger.pendingLamports = state.pendingLamports;
    ledger.realizedPnlLamports = state.realizedPnlLamports;
    ledger.quarantinedLamports = state.quarantinedLamports;
    for (const decisionId of state.seenDecisions) ledger.seenDecisions.add(decisionId);
    for (const reservation of state.reservations) {
      ledger.reservations.set(reservation.reservationId, {
        ...reservation,
        clusterIds: cleanClusters(reservation.clusterIds),
      });
    }
    for (const position of state.positions) {
      if (!Number.isSafeInteger(position.remainingCostLamports) || position.remainingCostLamports < 0) {
        throw new Error("arm position contains invalid cost basis");
      }
      ledger.positions.set(position.decisionId, {
        ...position,
        clusterIds: cleanClusters(position.clusterIds),
      });
    }
    const expectedPending = [...ledger.reservations.values()]
      .reduce((sum, reservation) => sum + toLamports(reservation.stakeSol), 0);
    if (expectedPending !== ledger.pendingLamports) throw new Error("arm ledger pending capital mismatch");
    return ledger;
  }

  private clusterExposure(clusterId: string): number {
    let count = 0;
    for (const position of this.positions.values()) if (position.clusterIds.includes(clusterId)) count++;
    for (const reservation of this.reservations.values()) if (reservation.clusterIds.includes(clusterId)) count++;
    return count;
  }
}
