import { config } from "./config.js";
import { ui, logRecord } from "./util/log.js";
import { okxCredentialWarnings, okxEnabled } from "./discovery/okx.js";
import { okxScoutScan, scoutVerdict, okxScoutSeenCount } from "./discovery/okx-scout.js";
import { registerBatch, settleDue, openCount, outcomeHorizons, initOutcomeStore, flushOutcomeStore } from "./discovery/okx-outcome.js";

/**
 * OKX SCOUT STUDY — the experiment that decides whether any of this is worth trading.
 *
 *   npm run okx:study     run it
 *   npm run okx:report    read what it found so far
 *
 * It scans OKX trenches, scores every token on the actor profile OKX ships inline, and prices
 * BOTH the accepted and the rejected at fixed horizons. It never buys. The only question it
 * exists to answer is whether the verdict separates outcomes at all — and if it does not, that
 * is the most valuable thing it can tell us, because it costs nothing to learn here and costs
 * real money to learn in production.
 *
 * SEPARATE PROCESS, no shared state with the trader. It can crash or be region-blocked without
 * touching anything else.
 */

const SCAN_MS = Math.max(300, Number(process.env.OKX_SCAN_MS ?? 600));
const SETTLE_MS = Math.max(2_000, Number(process.env.OKX_SETTLE_MS ?? 5_000));
const STATUS_MS = 60_000;

let scanned = 0, registered = 0, settled = 0;
const verdicts = { CLEAN: 0, TOXIC: 0, UNKNOWN: 0 };

async function scanOnce(): Promise<void> {
  const rows = await okxScoutScan("NEW");
  if (rows.length === 0) return;
  scanned += rows.length;
  const scored = rows.map((row) => {
    const verdict = scoutVerdict(row);
    verdicts[verdict.verdict]++;
    return { row, verdict };
  });
  registered += await registerBatch(scored);
}

async function main(): Promise<void> {
  for (const w of okxCredentialWarnings()) ui.warn(`[okx-study] ${w}`);
  if (!okxEnabled) {
    ui.warn("[okx-study] OKX disabled — set OKX_SHADOW_ENABLED=true and the credentials in .env");
    process.exit(1);
  }
  initOutcomeStore();
  ui.pass(`[okx-study] scanning every ${SCAN_MS}ms, settling every ${SETTLE_MS}ms, horizons ${outcomeHorizons().join("/")}s`);

  const scanTimer = setInterval(() => { void scanOnce().catch((e) => ui.warn(`[okx-study] scan: ${(e as Error).message}`)); }, SCAN_MS);
  const settleTimer = setInterval(() => {
    void settleDue().then(({ settled: s }) => { settled += s; }).catch((e) => ui.warn(`[okx-study] settle: ${(e as Error).message}`));
  }, SETTLE_MS);
  const statusTimer = setInterval(() => {
    const line = { type: "okx-study-status", scanned, registered, settled, open: openCount(), seen: okxScoutSeenCount(), ...verdicts, cfg: config.strategyVersion };
    logRecord("events", line);
    ui.info?.(`[okx-study] scanned=${scanned} registered=${registered} settled=${settled} open=${openCount()} | CLEAN ${verdicts.CLEAN} TOXIC ${verdicts.TOXIC} UNKNOWN ${verdicts.UNKNOWN}`);
  }, STATUS_MS);

  const stop = () => {
    clearInterval(scanTimer); clearInterval(settleTimer); clearInterval(statusTimer);
    // Persist before exiting: a 45-minute horizon lost to a Ctrl-C is 45 minutes of sample gone.
    flushOutcomeStore();
    ui.pass(`[okx-study] stopped — ${openCount()} observations preserved for the next run`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
