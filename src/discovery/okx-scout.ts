import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";
import {
  okxMemeTokens, okxMemeTokenAgeMs, okxTokenTradingInfo, okxTokenDeveloperInfo,
  okxTokenBundleInfo, okxEnabled, type OkxMemeToken,
} from "./okx.js";

/**
 * OKX-NATIVE SCOUT — the launchpad scanner built on what OKX is measurably good at.
 *
 * ── WHY THIS EXISTS RATHER THAN A REPLACEMENT SNIPER ──────────────────────────────────────────
 * MEASURED 2026-08-29, both against the live APIs:
 *
 *   detection lag   PumpPortal p50 1.1s / p90 1.6s   (n=2135, vs on-chain blockTime)
 *                   OKX        p50 1.4s / p90 1.8s   (corrected for a +1.0s clock offset)
 *   build latency   PumpPortal p50 314ms
 *                   OKX        p50 135ms, blockhash embedded, 8/8 still valid
 *
 * So OKX is ~0.3s SLOWER to see a launch and ~0.18s FASTER to build the trade. It does not win
 * the race to the block. What it does have, and PumpPortal has none of, is pre-computed actor
 * forensics arriving in the SAME response as the token: dev holdings, bundler share, sniper
 * share, insider share, fresh-wallet share and top-10 concentration. Our own pipeline spends
 * ~23 RPC calls per candidate reconstructing exactly those numbers under a 2.5s deadline, and
 * frequently times out on the newest coins.
 *
 * That is the trade this module is built around: give up ~0.3s of entry latency, get a complete
 * and reliable actor profile for free. Whether that trade is profitable is UNKNOWN, so nothing
 * here trades. It scores, records, and lets fixed-horizon outcomes settle the question.
 */

/** Every number OKX hands us inline, normalised. Null means absent, never 0 — the difference
 *  between "no bundlers" and "we could not tell" is the whole point of collecting this. */
export interface ScoutRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  creator: string | null;
  protocolId: string | null;
  createdAt: number | null;
  ageMsAtScan: number | null;
  bondingPercent: number | null;
  marketCapUsd: number | null;
  volumeUsd1h: number | null;
  txCount1h: number | null;
  buyRatio1h: number | null;
  totalHolders: number | null;
  top10Pct: number | null;
  devPct: number | null;
  bundlerPct: number | null;
  sniperPct: number | null;
  insiderPct: number | null;
  freshWalletPct: number | null;
  phishingPct: number | null;
  hasSocials: boolean;
  dexScreenerPaid: boolean;
  communityTakeover: boolean;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

export function toScoutRow(t: OkxMemeToken, now = Date.now()): ScoutRow {
  const m = t.market ?? {};
  const g = t.tags ?? {};
  const s = t.social ?? {};
  const buys = num(m.buyTxCount1h);
  const txs = num(m.txCount1h);
  return {
    mint: t.tokenAddress,
    symbol: t.symbol ?? null,
    name: t.name ?? null,
    creator: t.creatorAddress ?? null,
    protocolId: t.protocolId ?? null,
    createdAt: num(t.createdTimestamp),
    ageMsAtScan: okxMemeTokenAgeMs(t, now),
    bondingPercent: num(t.bondingPercent),
    marketCapUsd: num(m.marketCapUsd),
    volumeUsd1h: num(m.volumeUsd1h),
    txCount1h: txs,
    buyRatio1h: buys != null && txs != null && txs > 0 ? buys / txs : null,
    totalHolders: num(g.totalHolders),
    top10Pct: num(g.top10HoldingsPercent),
    devPct: num(g.devHoldingsPercent),
    bundlerPct: num(g.bundlersPercent),
    sniperPct: num(g.snipersPercent),
    insiderPct: num(g.insidersPercent),
    freshWalletPct: num(g.freshWalletsPercent),
    phishingPct: num(g.suspectedPhishingWalletPercent),
    hasSocials: Boolean(s.x || s.website || s.telegram),
    dexScreenerPaid: s.dexScreenerPaid === true,
    communityTakeover: s.communityTakeover === true,
  };
}

export interface ScoutVerdict {
  verdict: "CLEAN" | "TOXIC" | "UNKNOWN";
  reasons: string[];
  /** Which fields were actually present. A verdict from 2 of 6 signals is not the same as one
   *  from 6 of 6, and collapsing them is how a gate starts trusting silence. */
  coverage: number;
}

/**
 * Hard rejects only, and every threshold is provisional.
 *
 * These are NOT tuned — they are starting points taken from actor concentrations this project has
 * already measured to precede collapses. The scout logs the full row alongside the verdict, so the
 * thresholds can be re-fitted from outcomes later instead of being defended now. Deliberately
 * missing: any score. This project has already measured its own composite score to be INVERTED
 * (higher score, worse outcome), so a fresh one would be inventing the same mistake again.
 */
export function scoutVerdict(r: ScoutRow): ScoutVerdict {
  const reasons: string[] = [];
  const present = [r.devPct, r.bundlerPct, r.sniperPct, r.insiderPct, r.top10Pct, r.totalHolders]
    .filter((v) => v != null).length;
  const coverage = present / 6;

  if (r.phishingPct != null && r.phishingPct > 0) reasons.push(`phishing-wallets ${r.phishingPct}%`);
  if (r.devPct != null && r.devPct > 15) reasons.push(`dev-holds ${r.devPct}%`);
  if (r.bundlerPct != null && r.bundlerPct > 30) reasons.push(`bundlers ${r.bundlerPct}%`);
  if (r.sniperPct != null && r.sniperPct > 40) reasons.push(`snipers ${r.sniperPct}%`);
  if (r.insiderPct != null && r.insiderPct > 25) reasons.push(`insiders ${r.insiderPct}%`);
  if (r.top10Pct != null && r.top10Pct > 60) reasons.push(`top10 ${r.top10Pct}%`);

  if (reasons.length > 0) return { verdict: "TOXIC", reasons, coverage };
  // Fail CLOSED on thin data. A token OKX knows nothing about is not a clean token.
  if (coverage < 0.5) return { verdict: "UNKNOWN", reasons: ["insufficient actor data"], coverage };
  return { verdict: "CLEAN", reasons: [], coverage };
}

const seen = new Map<string, number>();
const MAX_SEEN = 5_000;

/** One scan pass. Returns only rows not seen before, so callers measure first-sighting age. */
export async function okxScoutScan(stage: "NEW" | "MIGRATING" | "MIGRATED" = "NEW"): Promise<ScoutRow[]> {
  if (!okxEnabled) return [];
  const rows = await okxMemeTokens(stage);
  if (!rows) return [];
  const now = Date.now();
  const fresh: ScoutRow[] = [];
  for (const t of rows) {
    if (!t.tokenAddress || seen.has(t.tokenAddress)) continue;
    seen.set(t.tokenAddress, now);
    fresh.push(toScoutRow(t, now));
  }
  if (seen.size > MAX_SEEN) {
    for (const [k] of [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, seen.size - MAX_SEEN)) seen.delete(k);
  }
  return fresh;
}

/** Second-pass enrichment — only for rows worth the extra calls. Two endpoints, ~270ms total. */
export async function okxScoutEnrich(mint: string): Promise<Record<string, unknown> | null> {
  const [dev, bundle, market] = await Promise.all([
    okxTokenDeveloperInfo(mint),
    okxTokenBundleInfo(mint),
    okxTokenTradingInfo([mint]),
  ]);
  if (!dev && !bundle && !market) return null;
  return {
    devTotalTokens: dev?.devLaunchedInfo?.totalToken ?? null,
    devRugCount: dev?.devLaunchedInfo?.rugPullCount ?? null,
    devMigratedCount: dev?.devLaunchedInfo?.migratedCount ?? null,
    devGoldenGems: dev?.devLaunchedInfo?.goldenGemCount ?? null,
    devFundingAddress: dev?.devHoldingInfo?.fundingAddress ?? null,
    totalBundlers: bundle?.totalBundlers ?? null,
    bundlerAthPercent: bundle?.bundlerAthPercent ?? null,
    priceUsd: market?.[0]?.price ?? null,
    liquidityUsd: market?.[0]?.liquidity ?? null,
  };
}

export function logScoutRow(r: ScoutRow, v: ScoutVerdict, enrich?: Record<string, unknown> | null): void {
  logRecord("events", {
    type: "okx-scout", source: "okx-trenches", acted: false,
    ...r, verdict: v.verdict, reasons: v.reasons, coverage: Number(v.coverage.toFixed(2)),
    ...(enrich ?? {}), cfg: config.strategyVersion,
  });
}

export function okxScoutSeenCount(): number { return seen.size; }
