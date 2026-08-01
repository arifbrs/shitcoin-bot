/**
 * MULTI-LAUNCHPAD OBSERVATORY — read-only, standalone, zero capital.
 *
 * Owner's ask: "pantau launchpad Solana lain di luar pump.fun semuanya, karna kalau sniper gagal
 * kita bisa hapus dan pakai strategi satunya" (watch every other Solana launchpad too, so if the
 * pump.fun sniper doesn't work out, there's already comparison data to switch to). The sniper
 * only ever sees pump.fun (via pumpportal's WS feed). GMGN's `market trenches` indexes new
 * launches across MANY more Solana launchpads (letsbonk, bags, believe, boop, moonshot_app,
 * ray_launchpad, meteora_virtual_curve, and others) uniformly — this watches ALL of them at
 * once, tags every observation with its actual `launchpad_platform`, and re-checks each one's
 * value at fixed horizons so platforms are directly comparable later, exactly like the
 * Strategy-2 scout/outcome-tracker pair already does for a single population.
 *
 * NOT filtered by risk/quality — logs everything trenches reports (new_creation), same
 * unbiased "follow ALL launches" posture as launch-observatory.ts. No position is ever opened;
 * this is measurement only, and it shares no state with PaperTrader/the sniper/Strategy 2.
 *
 * Run: npm run gmgn:launchpads
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { gmgnEnabled, gmgnTrenches, gmgnTokenSignal } from "./gmgn.js";
import { tokenMarketSnapshot } from "./token-market.js";

// Confirmed live 2026-07-27: the API rejects 14/15/16 ("not supported") — the real valid set
// isn't a clean 1-21 range. Meaning of any signal_type is UNKNOWN (undocumented anywhere in
// gmgn-skills) — logged uninterpreted so it can be correlated against outcomes later, never
// filtered/acted on by number until that correlation actually says something.
const VALID_SIGNAL_TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 18, 19, 20, 21];

const STATE_PATH = join(config.logDir, "gmgn-launchpad-state.json");
const OBSERVE_POLL_MS = 2 * 60_000; // new_creation moves fast; still bounded by the shared 5rps GMGN budget
const SIGNAL_POLL_MS = 5 * 60_000; // separate cadence — a distinct endpoint, own share of the same GMGN budget
const OUTCOME_POLL_MS = 30 * 60_000; // matches strategy2-outcome-tracker's cadence
const HORIZONS_HOURS = [6, 24, 48];

interface Observed {
  mint: string; sym: string; launchpad: string; creator: string | null;
  firstSeenAt: number; entryMcUsd: number; entryHolders: number;
  checkedHorizons: number[];
  // Review fix (2026-07-27, follow-up audit): the epoch/cfg active WHEN THIS TOKEN WAS FIRST
  // OBSERVED. Outcome checks (6h/24h/48h later) used to tag records with whatever config is LIVE
  // at check time — a token can outlive an epoch/cfg change while still being tracked, which
  // would misattribute its outcome to a cohort it was never actually part of.
  observedEpoch: string; observedCfg: string;
}
interface State { observed: Record<string, Observed> }

function loadState(): State {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State; } catch { /* fresh */ }
  }
  return { observed: {} };
}
function saveState(s: State): void {
  try { writeFileSync(STATE_PATH, JSON.stringify(s)); } catch { /* best-effort */ }
}

/** New launches across EVERY Solana launchpad GMGN indexes — not just Pump.fun. */
async function pollObserve(): Promise<void> {
  if (!gmgnEnabled) return;
  const s = loadState();
  const t = await gmgnTrenches("sol", ["new_creation"], undefined, 80, {});
  if (!t?.new_creation) { ui.warn("[gmgn-launchpads] observe poll: no data"); return; }
  const now = Date.now();
  let added = 0;
  const byPlatform: Record<string, number> = {};
  for (const r of t.new_creation) {
    if (!r.address) continue;
    byPlatform[r.launchpad_platform ?? "?"] = (byPlatform[r.launchpad_platform ?? "?"] ?? 0) + 1;
    if (s.observed[r.address]) continue; // already tracking this one
    s.observed[r.address] = {
      mint: r.address, sym: r.symbol ?? "?", launchpad: r.launchpad_platform ?? "unknown", creator: r.creator ?? null,
      firstSeenAt: now, entryMcUsd: r.market_cap ?? 0, entryHolders: r.holder_count ?? 0, checkedHorizons: [],
      observedEpoch: config.strategy2Epoch, observedCfg: configHash,
    };
    added++;
    logRecord("events", {
      type: "gmgn-launchpad-observed", mint: r.address, sym: r.symbol ?? "?", launchpad: r.launchpad_platform ?? "unknown",
      creator: r.creator ?? null, entryMcUsd: r.market_cap ?? 0, entryHolders: r.holder_count ?? 0,
      rugRatio: r.rug_ratio ?? null, bundlerRate: r.bundler_trader_amount_rate ?? null, sniperCount: r.sniper_count ?? null,
      xFollowers: r.x_user_follower ?? null, tgCallCount: r.tg_call_count ?? null,
      creatorCreatedOpenRatio: r.creator_created_open_ratio ?? null, firstSeenAt: now, strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
  }
  saveState(s);
  ui.info(`[gmgn-launchpads] observe: ${t.new_creation.length} seen (${added} new) — by platform: ${JSON.stringify(byPlatform)}`);
}

/**
 * `market signal` events — fed into the SAME observed-mint state as trenches above, so the
 * existing outcome-tracker (6h/24h/48h re-check) automatically covers signal-sourced mints too,
 * without a second outcome loop. `signalType` is logged raw and uninterpreted (see gmgn.ts's
 * gmgnTokenSignal doc — meaning is not yet known).
 */
async function pollSignal(): Promise<void> {
  if (!gmgnEnabled) return;
  const s = loadState();
  const rows = await gmgnTokenSignal("sol", [{ signal_type: VALID_SIGNAL_TYPES, mc_min: 1_000 }]);
  if (!rows) { ui.warn("[gmgn-launchpads] signal poll: no data"); return; }
  const now = Date.now();
  let added = 0;
  for (const r of rows) {
    if (!r.token_address) continue;
    logRecord("events", {
      type: "gmgn-signal-observed", mint: r.token_address, signalType: r.signal_type,
      sym: r.data?.symbol ?? "?", launchpad: r.data?.launchpad_platform ?? "unknown", creator: r.data?.creator ?? null,
      marketCap: r.market_cap ?? null, triggerMc: r.trigger_mc ?? null, ath: r.ath ?? null,
      holderCount: r.data?.holder_count ?? null, rugRatio: r.data?.rug_ratio ?? null, strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    if (!s.observed[r.token_address]) {
      s.observed[r.token_address] = {
        mint: r.token_address, sym: r.data?.symbol ?? "?", launchpad: r.data?.launchpad_platform ?? "unknown",
        creator: r.data?.creator ?? null, firstSeenAt: now, entryMcUsd: r.market_cap ?? 0,
        entryHolders: r.data?.holder_count ?? 0, checkedHorizons: [],
        observedEpoch: config.strategy2Epoch, observedCfg: configHash,
      };
      added++;
    }
  }
  saveState(s);
  ui.info(`[gmgn-launchpads] signal: ${rows.length} events (${added} new mints added to outcome tracking)`);
}

/** Re-check each observed mint's value at 6h/24h/48h — makes platforms directly comparable. */
async function pollOutcome(): Promise<void> {
  if (!gmgnEnabled) return;
  const s = loadState();
  const now = Date.now();
  let checked = 0;
  const due: Array<{ o: Observed; horizon: number }> = [];
  for (const o of Object.values(s.observed)) {
    const ageHours = (now - o.firstSeenAt) / 3_600_000;
    for (const h of HORIZONS_HOURS) {
      if (ageHours >= h && !o.checkedHorizons.includes(h)) due.push({ o, horizon: h });
    }
  }
  for (const { o, horizon } of due) {
    try {
      const mark = await tokenMarketSnapshot(o.mint);
      if (!mark || mark.mcUsd == null) {
        logRecord("events", {
          type: "gmgn-launchpad-mark-unavailable", mint: o.mint, sym: o.sym, launchpad: o.launchpad,
          horizonHours: horizon, primaryStatus: mark?.primaryStatus ?? "network-error", checkedAt: now,
          strategy2Epoch: o.observedEpoch ?? "unknown", cfg: o.observedCfg ?? "unknown",
        });
        continue;
      }
      const currentMcUsd = mark.mcUsd;
      const currentHolders = mark.holders;
      const mcChangePct = currentMcUsd != null && o.entryMcUsd > 0 ? Number((((currentMcUsd - o.entryMcUsd) / o.entryMcUsd) * 100).toFixed(1)) : null;
      logRecord("events", {
        type: "gmgn-launchpad-outcome", mint: o.mint, sym: o.sym, launchpad: o.launchpad, creator: o.creator,
        horizonHours: horizon, entryMcUsd: o.entryMcUsd, currentMcUsd, entryHolders: o.entryHolders, currentHolders,
        markSource: mark.source, primaryStatus: mark.primaryStatus,
        // Tag with the OBSERVATION-time epoch/cfg (review fix), not the live config at check time.
        // Fallback covers state persisted before this field existed.
        mcChangePct, checkedAt: now, strategy2Epoch: o.observedEpoch ?? "unknown", cfg: o.observedCfg ?? "unknown",
      });
      o.checkedHorizons.push(horizon);
      checked++;
      await new Promise((r) => setTimeout(r, 300)); // gentle on the free Solana Tracker endpoint
    } catch { /* transient — retried automatically once the horizon is still due next poll */ }
  }
  // Drop anything past the last horizon AND already checked at it — its research life is over.
  const maxHorizon = Math.max(...HORIZONS_HOURS);
  for (const [mint, o] of Object.entries(s.observed)) {
    if (o.checkedHorizons.includes(maxHorizon)) delete s.observed[mint];
  }
  saveState(s);
  if (checked) ui.info(`[gmgn-launchpads] outcome: checked ${checked} due horizons (${Object.keys(s.observed).length} still tracked)`);
}

function main(): void {
  console.log(`[gmgn-launchpads] observing ALL Solana launchpads GMGN indexes (not just Pump.fun) every ${OBSERVE_POLL_MS / 60_000}min, signal events every ${SIGNAL_POLL_MS / 60_000}min (meaning unknown, logged raw), outcome re-check at [${HORIZONS_HOURS.join(",")}]h every ${OUTCOME_POLL_MS / 60_000}min. Read-only, zero capital.`);
  void pollObserve();
  void pollSignal();
  void pollOutcome();
  const t1 = setInterval(() => void pollObserve(), OBSERVE_POLL_MS);
  const t2 = setInterval(() => void pollOutcome(), OUTCOME_POLL_MS);
  const t3 = setInterval(() => void pollSignal(), SIGNAL_POLL_MS);
  const shutdown = () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
