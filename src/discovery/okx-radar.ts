import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";
import {
  OKX_WALLET_TYPES, okxEnabled, okxLeaderboardWalletTypeCodes, okxLeaderboardWalletTypeLabel,
  okxSmartMoneyLeaderboard, okxTopTokenPnl, okxWalletOverview, type OkxLeaderboardWallet,
} from "./okx.js";

/**
 * ALPHA RADAR — build a wallet universe from OKX's leaderboard, then keep it as OUR record.
 *
 * The endpoint currently returns up to 50 rows per call. That constraint dictates the design:
 * you cannot ask for "the top 500 wallets", you have to sweep wallet-type and sort/time filters
 * and union the results. The current reduced grid is 36 cells,
 * evenly paced under the endpoint's 5 rps limit. It runs on a timer, never in a decision path.
 *
 * ── WHY THE WALLET FILE IS NOT JUST A CACHE OF OKX'S ANSWER ──────────────────────────────────
 * OKX's leaderboard is survivorship ranking: it lists who is up *now*. A wallet that appears once
 * at the top of a 7-day PnL board and never again is indistinguishable, in that snapshot, from one
 * that is there every week. So every sweep appends to a per-wallet history — `seenCount`,
 * `firstSeen`, `lastSeen`, and the PnL each time — and the thing we act on later is persistence
 * across sweeps, not rank within one. This is the same trap the GMGN smart-money lane fell into:
 * a signal that looks predictive because the sample was selected on the outcome.
 *
 * Nothing here decides a trade. The output is a candidate list for `address-tracker-activity`.
 */

const STORE = join(config.logDir, "okx-radar-wallets.json");

/** REST requires integer codes. These six currently return Solana rows; the complete authoritative
 * ten-code mapping remains exported by okx.ts. Empty types are omitted here to conserve quota.
 */
const WALLET_TYPES: Array<{ code: string; label: string }> = [
  { code: OKX_WALLET_TYPES.kol, label: "kol" },
  { code: OKX_WALLET_TYPES.developer, label: "developer" },
  { code: OKX_WALLET_TYPES.smartMoney, label: "smartMoney" },
  { code: OKX_WALLET_TYPES.newWallet, label: "newWallet" },
  { code: OKX_WALLET_TYPES.sniper, label: "sniper" },
  { code: OKX_WALLET_TYPES.pumpSmartMoney, label: "pumpSmartMoney" },
];
/** 1=PnL 2=WinRate 3=Txs 4=Volume 5=ROI */
const SORTS = ["1", "2", "5"] as const;
/** 1=1D 2=3D 3=7D 4=1M 5=3M */
const TIMEFRAMES = ["3", "4"] as const;

export interface RadarWallet {
  walletAddress: string;
  firstSeen: string;
  lastSeen: string;
  /**
   * How many DISTINCT SWEEPS this wallet has appeared in. This is the persistence signal and the
   * whole reason the store exists.
   *
   * BUG FOUND BY RUNNING IT: the first version incremented this once per filter cell, so a single
   * sweep produced wallets with seenCount up to 12 and `minSeenCount: 2` selected 50 wallets
   * before a second sweep had ever run. That silently converted "survived across time" into
   * "appeared in two filter cells at the same instant" — which is not persistence, it is the
   * survivorship bias this file was written to avoid. Sweeps are now deduplicated by timestamp.
   */
  sweepCount: number;
  /** Total (cell, sweep) hits. Breadth of qualification — NOT persistence. */
  cellHits: number;
  /** Which (walletType, sortBy, timeFrame) cells surfaced it. */
  cells: string[];
  /** ISO timestamp of the last sweep counted, so re-entry within one sweep cannot double-count. */
  lastSweepTs: string;
  /** Authoritative OKX integer codes. */
  walletTypeCodes: string[];
  walletTypes: string[];
  lastRealizedPnlUsd: number | null;
  lastWinRatePercent: number | null;
  lastAvgBuyValueUsd: number | null;
  lastTxs: number | null;
  lastActiveTimestamp: number | null;
  /** Rolling record of realized PnL per sweep — lets us see decay rather than one snapshot. */
  pnlHistory: Array<{ ts: string; realizedPnlUsd: number | null; winRatePercent: number | null }>;
  topTokens: string[];
}

type Store = Record<string, RadarWallet>;

function load(): Store {
  if (!existsSync(STORE)) return {};
  try {
    const store = JSON.parse(readFileSync(STORE, "utf8")) as Store;
    for (const wallet of Object.values(store)) {
      const codes = okxLeaderboardWalletTypeCodes(wallet.cells ?? [], wallet.walletTypeCodes ?? []);
      wallet.walletTypeCodes = codes;
      // Old cells contain a wrong human label but a correct integer in parentheses. Rebuild the
      // labels from those integers so historical persistence survives without stale semantics.
      if (codes.length) wallet.walletTypes = codes.map(okxLeaderboardWalletTypeLabel)
        .filter((v): v is NonNullable<typeof v> => v !== null);
      else wallet.walletTypes ??= [];
    }
    return store;
  }
  catch (e) { ui.warn(`[okx-radar] store unreadable, starting fresh: ${(e as Error).message}`); return {}; }
}

function save(store: Store): void {
  writeFileSync(STORE, JSON.stringify(store, null, 2));
}

const num = (v?: string | null): number | null =>
  v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

function absorb(store: Store, rows: OkxLeaderboardWallet[], cell: string, walletTypeCode: string, walletType: string, now: string): number {
  let fresh = 0;
  for (const row of rows) {
    const addr = row.walletAddress;
    if (!addr) continue;
    const pnl = num(row.realizedPnlUsd);
    const wr = num(row.winRatePercent);
    let w = store[addr];
    if (!w) {
      w = store[addr] = {
        walletAddress: addr, firstSeen: now, lastSeen: now, sweepCount: 0, cellHits: 0,
        cells: [], lastSweepTs: "", walletTypeCodes: [], walletTypes: [],
        lastRealizedPnlUsd: null, lastWinRatePercent: null, lastAvgBuyValueUsd: null, lastTxs: null,
        lastActiveTimestamp: null, pnlHistory: [], topTokens: [],
      };
      fresh++;
    }
    w.lastSeen = now;
    w.cellHits++;
    // `now` is one value for the whole sweep, so this counts each sweep exactly once no matter
    // how many filter cells surfaced the wallet.
    if (w.lastSweepTs !== now) { w.sweepCount++; w.lastSweepTs = now; }
    if (!w.cells.includes(cell)) w.cells.push(cell);
    if (!w.walletTypeCodes.includes(walletTypeCode)) w.walletTypeCodes.push(walletTypeCode);
    if (!w.walletTypes.includes(walletType)) w.walletTypes.push(walletType);
    w.lastRealizedPnlUsd = pnl;
    w.lastWinRatePercent = wr;
    w.lastAvgBuyValueUsd = num(row.avgBuyValueUsd);
    w.lastTxs = num(row.txs);
    w.lastActiveTimestamp = num(row.lastActiveTimestamp);
    // One PnL point per sweep, not per cell — otherwise the history length says more about how
    // many filters matched than about how the wallet performed over time.
    if (w.pnlHistory[w.pnlHistory.length - 1]?.ts !== now) w.pnlHistory.push({ ts: now, realizedPnlUsd: pnl, winRatePercent: wr });
    if (w.pnlHistory.length > 50) w.pnlHistory.splice(0, w.pnlHistory.length - 50);
    for (const t of row.topPnlTokenList ?? []) {
      const { usd } = okxTopTokenPnl(t);
      if (t.tokenContractAddress && usd != null && !w.topTokens.includes(t.tokenContractAddress)) {
        w.topTokens.push(t.tokenContractAddress);
        if (w.topTokens.length > 30) w.topTokens.shift();
      }
    }
  }
  return fresh;
}

/** One full sweep of the current filter space: 6 productive wallet types × 3 sorts × 2 frames. */
export async function okxRadarSweep(): Promise<{ cells: number; rows: number; wallets: number; fresh: number }> {
  if (!okxEnabled) { ui.warn("[okx-radar] OKX disabled — sweep skipped"); return { cells: 0, rows: 0, wallets: 0, fresh: 0 }; }
  const store = load();
  const now = new Date().toISOString();
  let cells = 0, rows = 0, fresh = 0;

  for (const { code, label } of WALLET_TYPES) {
    for (const sortBy of SORTS) {
      for (const timeFrame of TIMEFRAMES) {
        const cell = `${label}(${code})/${sortBy}/${timeFrame}`;
        const page = await okxSmartMoneyLeaderboard({ walletType: code, sortBy, timeFrame });
        cells++;
        // Array.isArray, not a truthiness+length check: OKX can answer an error with a non-null
        // object whose .length is undefined, which passes `!page || page.length === 0`.
        if (!Array.isArray(page) || page.length === 0) continue;
        rows += page.length;
        fresh += absorb(store, page, cell, code, label, now);
      }
    }
  }

  save(store);
  const summary = { cells, rows, wallets: Object.keys(store).length, fresh };
  logRecord("events", { type: "okx-radar-sweep", ...summary });
  ui.pass(`[okx-radar] sweep: ${cells} cells, ${rows} rows → ${summary.wallets} wallets (+${fresh} new)`);
  return summary;
}

export interface RadarSelection {
  /** Minimum DISTINCT sweeps. 2 means "still there an hour later", which needs 2 sweeps to pass. */
  minSweepCount: number;
  minWinRate: number | null;
  maxAvgBuyUsd: number | null;
  activeWithinHours: number | null;
  excludeTypes: string[];
  limit: number;
}

/** A dangerous secondary label is still dangerous. `kol+developer` must not become eligible
 * merely because KOL itself is trusted; that loophole selected dust-spamming dev wallets. */
export function okxRadarHasExcludedType(walletTypes: readonly string[], excludeTypes: readonly string[]): boolean {
  const excluded = new Set(excludeTypes);
  return walletTypes.some((type) => excluded.has(type));
}

/**
 * Pick wallets to actually track.
 *
 * `excludeTypes` defaults to identities whose edge is structurally unavailable to a follower.
 * Mixed-label wallets remain eligible when they also qualify as KOL/Smart Money/Pump Smart Money.
 */
export function okxRadarSelect(opts: Partial<RadarSelection> = {}): RadarWallet[] {
  const o: RadarSelection = {
    minSweepCount: 2, minWinRate: 50, maxAvgBuyUsd: null, activeWithinHours: 48,
    excludeTypes: ["developer", "newWallet", "insider", "sniper", "suspectedPhishing", "bundledTrader"], limit: 200, ...opts,
  };
  const store = load();
  const cutoff = o.activeWithinHours == null ? null : Date.now() - o.activeWithinHours * 3_600_000;
  return Object.values(store)
    .filter((w) => w.sweepCount >= o.minSweepCount)
    .filter((w) => o.minWinRate == null || (w.lastWinRatePercent ?? 0) >= o.minWinRate)
    .filter((w) => o.maxAvgBuyUsd == null || (w.lastAvgBuyValueUsd ?? 0) <= o.maxAvgBuyUsd)
    .filter((w) => cutoff == null || (w.lastActiveTimestamp ?? 0) >= cutoff)
    .filter((w) => !okxRadarHasExcludedType(w.walletTypes, o.excludeTypes))
    // Rank by persistence first, breadth second, PnL last. A wallet present in six sweeps at $10k
    // beats one seen once at $200k — the second is a lottery ticket we are reading after the draw.
    .sort((a, b) => (b.sweepCount - a.sweepCount) || (b.cellHits - a.cellHits) || ((b.lastRealizedPnlUsd ?? 0) - (a.lastRealizedPnlUsd ?? 0)))
    .slice(0, o.limit);
}

/** Enrich a shortlist with OKX's own wallet-level PnL view. One call per wallet at ~1 rps. */
export async function okxRadarEnrich(wallets: string[]): Promise<number> {
  let ok = 0;
  for (const w of wallets) {
    const overview = await okxWalletOverview(w);
    if (!overview) continue;
    ok++;
    logRecord("events", { type: "okx-radar-wallet", walletAddress: w, ...overview });
  }
  return ok;
}

export function okxRadarStorePath(): string { return STORE; }
