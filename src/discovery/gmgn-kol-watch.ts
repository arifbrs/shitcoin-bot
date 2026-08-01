/**
 * KOL / SMART-MONEY WATCH — read-only, standalone, zero capital.
 *
 * Polls GMGN's live KOL and Smart-Money trade feeds and cross-references them against mints we
 * actually care about: currently-open sniper positions (logs/positions.json) and the latest
 * Strategy-2 candidates (today's events log). Logs a match when a tracked/tagged wallet just
 * bought or sold a mint we're watching — this is OBSERVATION only: no position is opened,
 * closed, or resized because of it. Its own process, own timer, shares no state with
 * PaperTrader/the sniper (same isolation as strategy2-scout.ts).
 *
 * ALSO checks smart-money HOLDER CONVICTION (are they still in profit, still holding) for
 * currently-OPEN sniper positions specifically — not the full candidate set, which can run to
 * ~100+ mints and would burn the shared GMGN budget for a signal that matters most on capital
 * actually at risk (per GMGN's own workflow-risk-warning.md: "smart money exodus = conviction
 * leaving"). This is the flow reason it lives here rather than as a new standalone process: this
 * file already knows which mints are open positions, so extending it avoids a second lookup path.
 *
 * Run: npm run gmgn:kol-watch
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { gmgnEnabled, gmgnKol, gmgnSmartMoney, gmgnTopHolders, type GmgnActivityRow } from "./gmgn.js";

const POLL_MS = 3 * 60_000; // KOL/SM feeds are per-trade event streams, not per-token stats — 3min is plenty without hammering the shared GMGN budget

function openPositionMints(): Map<string, string> {
  const mints = new Map<string, string>(); // mint -> symbol
  try {
    const st = JSON.parse(readFileSync(join(config.logDir, "positions.json"), "utf8")) as { positions?: Array<{ candidate?: { mint?: string; symbol?: string } }> };
    for (const p of st.positions ?? []) if (p.candidate?.mint) mints.set(p.candidate.mint, p.candidate.symbol ?? "?");
  } catch { /* no positions file yet */ }
  return mints;
}

function watchedMints(): Set<string> {
  const mints = new Set<string>(openPositionMints().keys());
  try {
    const files = readdirSync(config.logDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort().slice(-1); // today's file only — candidates age out fast
    for (const f of files) {
      for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { type?: string; mint?: string; firstSeenAt?: number };
          if (r.type === "strategy2-candidate" && r.mint && r.firstSeenAt && Date.now() - r.firstSeenAt < 6 * 3_600_000) mints.add(r.mint);
        } catch { /* skip malformed line */ }
      }
    }
  } catch { /* no events log yet */ }
  return mints;
}

/** Are smart-money holders of an OPEN position collectively still in profit, still holding? */
async function checkHolderConviction(mint: string, symbol: string): Promise<void> {
  const holders = await gmgnTopHolders("sol", mint, "smart_degen", "profit", 20);
  if (!holders || !holders.length) return;
  const stillHolding = holders.filter((h) => (h.amount_percentage ?? 0) > 0);
  const exited = holders.length - stillHolding.length;
  const withUnrealized = stillHolding.filter((h) => h.unrealized_pnl != null);
  const avgUnrealizedPnl = withUnrealized.length
    ? withUnrealized.reduce((s, h) => s + (h.unrealized_pnl ?? 0), 0) / withUnrealized.length
    : null;
  logRecord("events", {
    type: "gmgn-holder-conviction", mint, symbol,
    smartDegenSampled: holders.length, stillHolding: stillHolding.length, exited,
    avgUnrealizedPnl: avgUnrealizedPnl != null ? Number(avgUnrealizedPnl.toFixed(3)) : null,
    strategy2Epoch: config.strategy2Epoch, cfg: configHash,
  });
}

function logMatches(rows: GmgnActivityRow[], label: "kol" | "smartmoney", tracked: Set<string>): number {
  let n = 0;
  for (const r of rows) {
    if (!tracked.has(r.base_address)) continue;
    n++;
    logRecord("events", {
      type: "gmgn-tracked-trade", watchType: label, mint: r.base_address, symbol: r.base_token?.symbol ?? null,
      side: r.side, maker: r.maker, amountUsd: r.amount_usd ?? null, priceUsd: r.price_usd ?? null,
      twitterUsername: r.maker_info?.twitter_username || null, twitterName: r.maker_info?.twitter_name || null,
      tags: r.maker_info?.tags ?? null, txHash: r.transaction_hash, tradeAt: r.timestamp ? r.timestamp * 1000 : null,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
  }
  return n;
}

async function poll(): Promise<void> {
  if (!gmgnEnabled) { ui.warn("[gmgn-kol-watch] GMGN_API_KEY not set — cannot poll"); return; }
  const tracked = watchedMints();
  if (!tracked.size) { ui.info("[gmgn-kol-watch] nothing to watch yet (no open positions, no recent strategy2 candidates)"); return; }
  const [kol, sm] = await Promise.all([gmgnKol("sol", 50), gmgnSmartMoney("sol", 50)]);
  const kolMatches = kol ? logMatches(kol, "kol", tracked) : 0;
  const smMatches = sm ? logMatches(sm, "smartmoney", tracked) : 0;
  ui.info(`[gmgn-kol-watch] watching ${tracked.size} mints — ${kol?.length ?? 0} kol trades (${kolMatches} matched), ${sm?.length ?? 0} smart-money trades (${smMatches} matched)`);

  // HOLDER CONVICTION — open positions only (bounded, unlike the full candidate set above).
  const openMints = openPositionMints();
  for (const [mint, symbol] of openMints) {
    await checkHolderConviction(mint, symbol);
  }
  if (openMints.size) ui.info(`[gmgn-kol-watch] holder-conviction checked for ${openMints.size} open position(s)`);
}

function main(): void {
  console.log(`[gmgn-kol-watch] polling every ${POLL_MS / 60_000}min. Read-only, zero capital, log-only — never opens/closes a position.`);
  void poll();
  const timer = setInterval(() => void poll(), POLL_MS);
  const shutdown = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
