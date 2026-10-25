/** (S12) Bentuk payload /api/pumpwatch — reduksi jurnal pump-caller di server. */
export interface PumpwatchEvent {
  h2EventId: string; mint: string; symbol: string | null; signature: string;
  detectionClass: "PRE_ADMISSION" | "BACKFILL" | "REALTIME";
  usd: number; usdQuality: string; sol: number;
  eventTs: number; firstObservedAt: number; observationLatencyMs: number | null;
  discoveryCohort: string | null; canonicalIdQuality: string; ixIndex: number | null;
  conf: { state: string; coverage: string | null; version: string | null; followers: number | null; rapidSell: string | null; netFlowSol: number | null; reason: string | null } | null;
  actionable: boolean;
}
export interface PumpwatchToken {
  mint: string; symbol: string | null; admittedAt: number; source: string;
  ageMin: number; lastObservedAt: number | null;
  tradeCount: number; distinctTraders: number; buySol: number; sellSol: number;
  largeBuys: number; smallSells: number; lastTradeTs: number | null;
  lastCandleTs: number | null; backlogPossible: boolean | null; coverageError: boolean;
}
export interface PumpwatchOutcome { horizonMin: number; observed: number; pending: number; missing: number; meanPct: number | null }
export interface PumpwatchModel {
  generatedAt: number;
  observer: {
    journalRows: number; journalMtime: number | null; staleSec: number | null;
    feed: { state: string | null; detail: string | null; ts: number | null };
    lastPassTs: number | null; lastTradeTs: number | null; lastCandleTs: number | null;
    backlogPasses: number; openGaps: number; coveragePasses: number;
    sourceLatencyMs: number | null; detectionLatencyMs: number | null;
  };
  tokens: PumpwatchToken[];
  events: { realtime: PumpwatchEvent[]; historical: PumpwatchEvent[] };
  decisions: {
    admission: { total: number; skip: number; watch: number; paperEntry: number };
    h2: Array<{ decisionId: string; mint: string; decision: string; ts: number; priceAtDecision: number | null; usd: number | null; latencyMs: number | null }>;
  };
  outcomes: { admission: PumpwatchOutcome[]; h2: PumpwatchOutcome[] };
  paper: {
    counterfactual: Array<{ policy: string; n: number; meanNetPct: number | null }>;
    actionable: Array<{ policy: string; n: number; meanNetPct: number | null }>;
    note: string;
  };
  fixtures: number;
}
