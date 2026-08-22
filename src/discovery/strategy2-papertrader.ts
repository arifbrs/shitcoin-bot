/**
 * STRATEGY-2 PAPER TRADER — actually simulates buy/hold/sell on scout candidates.
 *
 * Owner's explicit requirement: "perhitungan value harga harus akurat fee juga jangan asumsi"
 * (price value must be accurate, fee too — don't assume). Entry and exit value therefore come
 * from GMGN's REAL routed swap quote (order quote — exist-auth, no private key, never signs or
 * submits anything), which bakes in the platform fee + the pool's own swap fee + real price
 * impact for the exact size traded. Verified live 2026-07-27: a 1-SOL quote into CATE showed an
 * explicit 0.01 SOL GMGN platform fee + 0.0183 SOL Meteora pool fee, $76.38 in vs $76.12 out —
 * none of that is assumed or modeled here, it is read directly off the quote response.
 *
 * Between entry and exit, tracking the PEAK (for the trailing stop) uses Solana Tracker's free
 * mcUsd read — cheap enough to poll often; only the ACTUAL open/close moment pays for a real
 * quote. Exit is a trailing stop from peak, with a max-hold safety net (owner's choice: use
 * both together, not one or the other).
 *
 * Its own process, own log stream, own simulated USD float. Zero interaction with the Solana
 * sniper's SOL ledger or PaperTrader. Read-only against the chain: gmgnQuote never signs or
 * submits — no real order is ever placed.
 *
 * Run: npm run strategy2:paper
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { gmgnEnabled, gmgnQuote, gmgnTopHolders, gmgnTokenInfo, type GmgnTokenInfo } from "./gmgn.js";
import { solPriceUsd } from "../execution/jupiter.js";
import { tokenMarketSnapshot, type TokenMarketSnapshot } from "./token-market.js";
import { raptorPrice } from "./raptor.js";
import { stTokenSnapshot, solanaTrackerEnabled, stCredits, type StSnapshot } from "./solanatracker.js";
import { readControl } from "../control.js";
import { judgeVibe, feelingEnabled } from "../execution/feeling-agent.js";
import { classifyMcMark, MC_ANOMALY_RATIO } from "./mc-anomaly.js";

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const STATE_PATH = join(config.logDir, "strategy2-paper-state.json");

interface OpenPosition {
  mint: string; sym: string; entryTokensRaw: string; entryCostUsd: number;
  entryMcUsd: number; peakMcUsd: number; currentMcUsd: number; openedAt: number;
  // Owner (2026-07-29): "catat sedetail apapun biar analisanya akurat" — the FULL admission
  // snapshot (everything freshCandidates() knew about this candidate at selection time), frozen
  // at entry so both wins AND losses carry the complete entry context into their close record,
  // not just the P&L number. Without this, a later "why did this lose" or "what do winners have
  // in common" question can't be answered from the trade log alone.
  entryHolders: number; entryLiqUsd: number; entrySource: string;
  entryChange1h: number | null; entryChange24h: number | null;
  entrySmartDegenCount: number | null; entryRenownedCount: number | null;
  // Apakah permintaan Jupiter 5m TERBACA saat masuk. Tanpa ini, kandidat yang diterima
  // karena datanya hilang tidak bisa dibedakan dari yang permintaannya terbukti kuat.
  entryDemandKnown: boolean;
  entryRugRatio: number | null; entryIsWashTrading: boolean | null;
  // Review fix (2026-07-27, follow-up audit): the epoch/cfg active WHEN THIS POSITION WAS
  // OPENED — a position can stay open across a later epoch/cfg change, and the close/outcome
  // record must describe the cohort it actually belongs to, not whatever config happens to be
  // live at close time. Carried on the position itself rather than re-derived at close.
  openedEpoch: string; openedCfg: string;
  // P0 fix (2026-07-28): MC ANOMALY GUARD state — a suspicious single-poll jump/crash (ratio vs
  // last trusted currentMcUsd beyond MC_ANOMALY_RATIO) is held here awaiting confirmation on the
  // NEXT poll rather than trusted immediately. See poll()'s doc comment for the full mechanism.
  pendingMcUsd?: number; pendingMcAt?: number;
  /** Set only when the position lived through a trader blackout — see reconcileDowntime(). */
  downtimeSec?: number;
  lastMarkSource?: TokenMarketSnapshot["source"] | "raptor";
  // Raptor mark inputs (2026-07-31). Both are STATIC per mint, captured once at entry from the
  // live GMGN snapshot, so pricing off raw AMM reserves costs exactly one raptor call per mark
  // with no supporting lookups. Optional because positions opened before this existed won't have
  // them — those simply fall back to the old tokenMarketSnapshot path.
  decimals?: number; supply?: number;
  // Owner found live (2026-07-29): RobinHub/PIPEDOG both hit MC ~$0 (fully dead, zero liquidity)
  // and sat "open" for 3+ hours, 264 retries, because GMGN can never quote a sell into a pool
  // with nothing left in it — the exit condition kept firing correctly, closePosition() just
  // kept bouncing off "no route". Counts consecutive failed sell-quote attempts so closePosition
  // can eventually force a write-off instead of retrying forever (see SELL_QUOTE_FAIL_LIMIT).
  sellQuoteFailCount?: number;
  /**
   * Set the instant closePosition() commits to closing, cleared only if it bails out early.
   *
   * closePosition() is async and awaits a sell quote (and a SOL price) BEFORE it deletes the
   * position from state, so two overlapping polls could both pass their exit checks and both
   * write a close for the same mint — P&L counted twice. Measured live: LUNACAT closed twice
   * (−$6.05 then −$50.60) and EMOJI twice (+$8.00 then +$11.72). The sniper's own close() has
   * had an identity-based idempotent guard for this exact reason; Strategy 2 never got one.
   * DOES get written to disk (saveState serialises the whole State), so loadState() clears it
   * on every start — a restart has no in-flight close by definition, and a stale claim would
   * make the position permanently uncloseable.
   */
  closing?: boolean;
  // Basis-mismatch fix (2026-07-29, external audit + live confirmation): TRAIL_STOP is driven by
  // peakMcUsd (Solana Tracker/DexScreener), but the REALIZED close value always comes from a
  // separate, real GMGN sell quote — confirmed live that these can wildly disagree (Cybercat:
  // DexScreener reported marketCap:0.03, a genuinely dead/stale POOL per its own API response —
  // 0 volume in every window — while GMGN's routing found a live pool and quoted a real +16.14%
  // exit). The MC-anomaly guard doesn't catch this because a source that's SYSTEMATICALLY stuck
  // on a wrong number (not just noisy once) "confirms" its own bad reading on the next poll.
  // peakRealizedValueUsd tracks the high-water mark in REAL, quote-verified dollar terms — updated
  // every time closePosition() gets an actual quote back, whether or not that close is committed.
  // TRAIL_STOP is only allowed to fire if the REAL number also shows the drawdown; MAX_HOLD and
  // MANUAL_FLATTEN are wall-clock/operator-forced and bypass this check entirely (see closePosition).
  peakRealizedValueUsd?: number;
  // SCALE-OUT state (owner, 2026-07-30 — see config.ts's scaleOutTiers comment for why). Absent
  // on positions opened before this field existed, which fall back to selling their FULL
  // original entryTokensRaw at close and never scale out — no retroactive behavior change for
  // whatever happens to already be open the moment this deploys... EXCEPT this ships alongside a
  // restart, so already-open positions DO start participating going forward (remainingTokensRaw
  // defaults to entryTokensRaw the first time they're touched, same as a freshly-opened one).
  remainingTokensRaw?: string; // tokens still held; shrinks as scaleOutTiers execute
  scaleOutTiersDone?: number[]; // indices into config.strategy2Paper.scaleOutTiers already executed
  realizedScaleOutUsd?: number; // cumulative $ already realized via scale-outs (excluded from the eventual final-close pnlUsd, which only covers what's left)
  lastVibeAt?: number; // last time judgeS2Vibe() actually called the LLM for this position — throttles call volume
}
interface State {
  equityUsd: number; wins: number; losses: number; positions: Record<string, OpenPosition>; everSeen: string[];
  strategy2LastCommandId?: number; // audit fix (2026-07-29): highest emergency-flatten command id seen
  strategy2FlattenPending?: boolean; // true from when a flatten command lands until every position is actually gone
  /**
   * Wall-clock heartbeat, written every poll. Exists so a RESTART can tell how long the trader
   * was actually absent — see reconcileDowntime().
   */
  lastHeartbeatAt?: number;
}

/**
 * DOWNTIME RECONCILIATION (owner, 2026-07-31, after a real 20-hour blackout).
 *
 * The owner shut the machine down expecting the bot to close its positions first. It does not:
 * the SIGTERM handler only clears timers, so open positions stay in the state file and are
 * resurrected on the next start carrying a `currentMcUsd` from before the gap. STABLE came back
 * after 20.2 hours, the first fresh mark showed the real price, and the trailing stop fired at
 * -43.17% — a number that describes an unattended position, not a strategy decision. The 8% trail
 * would have exited many hours earlier had anything been watching.
 *
 * Closing positions on SIGTERM is the WRONG fix and was rejected: routine restarts are frequent
 * (roughly ten deploys in one session), so it would force-close healthy positions constantly and
 * destroy far more measurement value than it protects — and it cannot help anyway when the
 * machine loses power or sleeps, because no handler runs at all.
 *
 * So the gap is detected on the way back UP, which works regardless of how the process died.
 * A position that lived through a real blackout is closed immediately at a genuine quote and
 * tagged DOWNTIME_GAP, because the strategy never had the chance to manage it — continuing to
 * hold it would be just as much of a non-decision as the gap itself. The P&L is still booked
 * honestly (the money really did move), but the row is filterable so it never pollutes a cohort's
 * win rate.
 *
 * The threshold is well above the poll interval so ordinary deploy restarts pass through
 * untouched — only an absence long enough to genuinely miss exits counts.
 */
const DOWNTIME_THRESHOLD_MS = 5 * 60_000;
async function reconcileDowntime(s: State): Promise<void> {
  const last = s.lastHeartbeatAt;
  if (!last) return; // first run with this field — nothing to compare against
  const gapMs = Date.now() - last;
  if (gapMs < DOWNTIME_THRESHOLD_MS) return;
  const stranded = Object.values(s.positions);
  logRecord("events", {
    type: "strategy2-downtime-detected", gapSec: Math.round(gapMs / 1000),
    strandedPositions: stranded.length, lastHeartbeatAt: last,
    strategy2Epoch: config.strategy2Epoch, cfg: configHash,
  });
  if (!stranded.length) {
    ui.warn(`[strategy2-paper] trader was down for ${(gapMs / 60_000).toFixed(1)}min — no positions were open, nothing to reconcile`);
    return;
  }
  ui.reject(`[strategy2-paper] trader was down for ${(gapMs / 60_000).toFixed(1)}min with ${stranded.length} position(s) open — closing them as DOWNTIME_GAP; their P&L is real but is NOT a strategy outcome`);
  for (const pos of stranded) {
    pos.downtimeSec = Math.round(gapMs / 1000);
    await closePosition(s, pos, "DOWNTIME_GAP");
  }
}

function loadState(): State {
  if (existsSync(STATE_PATH)) {
    try {
      const loaded = JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
      // Clear any in-flight close claim. `closing` guards against two concurrent callers WITHIN
      // one process; it means nothing across a restart, and saveState() serialises the whole
      // State object, so it does get written to disk. Killing the process while a close was
      // awaiting its sell quote would otherwise reload the position with the claim still set —
      // and closePosition() would then return immediately, forever. A position that can never
      // close is strictly worse than the duplicate close the flag exists to prevent.
      for (const pos of Object.values(loaded.positions ?? {})) pos.closing = false;
      return loaded;
    } catch (e) {
      // Audit fix (2026-07-29): this used to silently fall through to a fresh $1,000 state on
      // ANY parse failure — a corrupt file (e.g. a crash mid-write) would quietly wipe every
      // open position and the real equity number with zero trace. Now the corrupt file is
      // preserved for inspection (never overwritten) and the loss is LOUD, not silent — a
      // startup log line an operator will actually see, not a diff nobody notices.
      const corruptPath = `${STATE_PATH}.corrupt-${Date.now()}`;
      try { writeFileSync(corruptPath, readFileSync(STATE_PATH)); } catch { /* best-effort preservation */ }
      ui.reject(`[strategy2-paper] STATE FILE CORRUPT (${(e as Error).message}) — preserved as ${corruptPath}, starting fresh at $${config.strategy2Paper.startingFloatUsd}. This is NOT a normal restart.`);
    }
  }
  return { equityUsd: config.strategy2Paper.startingFloatUsd, wins: 0, losses: 0, positions: {}, everSeen: [] };
}
function saveState(s: State): void {
  // Audit fix (2026-07-29): write-then-rename instead of writing STATE_PATH directly. A crash
  // (or the process being killed) mid-writeFileSync used to leave a truncated/invalid JSON file
  // that loadState() would then treat as corrupt on the NEXT start. rename() on the same
  // filesystem is atomic on POSIX — readers only ever see the old complete file or the new
  // complete file, never a half-written one.
  const tmpPath = `${STATE_PATH}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(s));
    renameSync(tmpPath, STATE_PATH);
  } catch { /* best-effort */ }
}

interface CandidateRow {
  mint: string; sym: string; mcUsd: number; liqUsd: number; holders: number; at: number;
  rugRatio: number | null; isWashTrading: boolean | null; change1h: number | null; change24h: number | null;
  smartDegenCount: number | null; renownedCount: number | null; source: string; strategy2Epoch: string;
  // Audit fix (2026-07-29): "entry confirmation berbasis demand" — real recent buy/sell flow
  // from Jupiter's 5m stats, logged by the scout alongside every candidate. Used by
  // demandConfirmed() below as a genuine admission gate, not just a logged/informational field.
  netBuyers5m: number | null; buyVolume5m: number | null; sellVolume5m: number | null;
}

/**
 * Review fix (2026-07-27): this used to take whatever candidate was SEEN EARLIEST, filtering
 * only `rugged === true`. No ranking by momentum, smart money, holder density, liquidity, or
 * an upper MC sanity bound — which is how a paper position got opened on a ~$1.67 BILLION
 * market cap token (PUMP, the actual pump.fun ecosystem token showing up in trending — a
 * mature asset, not a memecoin momentum play by any reading of the owner's thesis). This now
 * actually implements "mover, holder banyak, lolos trenches": hard-filters obviously bad/out-
 * of-thesis rows first, then ranks the survivors by a composite score, so the candidates
 * actually OPENED reflect the stated thesis instead of arrival order.
 */
function freshCandidates(everSeen: Set<string>): CandidateRow[] {
  // Review fix (2026-07-27, follow-up audit): freshness previously meant ONLY "not in everSeen" —
  // a candidate first spotted at the start of the day was still eligible after a process restart
  // hours later, even though "mover"/momentum by definition describes a moment, not a standing
  // fact. Scout re-logs a candidate every poll it's still trending, so this bounds how OLD the
  // first sighting is allowed to be, not how often it's been seen. Moved to the TOP of the
  // function (2026-07-29) so filesNeeded below can reference it — was declared after its first
  // use here, a genuine TDZ bug caught before it ever ran.
  const MAX_CANDIDATE_AGE_MS = 6 * 3_600_000; // 6h — matches the scout/outcome-tracker's own shortest horizon
  // Fix (2026-07-29, audit): this used to read ONLY the single most-recent daily log file — a
  // genuinely fresh candidate seen at 23:58 would be invisible the moment the file rolled over
  // to a new day at 00:00, even though it's well within MAX_CANDIDATE_AGE_MS (6h). Read enough
  // files to always cover the full freshness window regardless of where "now" falls relative to
  // the daily rollover — 2 files is always enough for a 6h window (worst case: window spans
  // exactly midnight).
  const filesNeeded = Math.max(2, Math.ceil(MAX_CANDIDATE_AGE_MS / 86_400_000) + 1);
  const files = readdirSync(config.logDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort().slice(-filesNeeded);
  const seen = new Map<string, CandidateRow>();
  for (const f of files) {
    for (const line of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as {
          type?: string; mint?: string; sym?: string; mcUsd?: number; liqUsd?: number; holders?: number;
          firstSeenAt?: number; rugged?: boolean | null; rugRatio?: number | null; isWashTrading?: boolean | null;
          change1h?: number | null; change24h?: number | null; smartDegenCount?: number | null; renownedCount?: number | null;
          source?: string; strategy2Epoch?: string;
          jupNetBuyers5m?: number | null; jupBuyVolume5m?: number | null; jupSellVolume5m?: number | null;
        };
        if (
          r.type !== "strategy2-candidate" ||
          !r.mint ||
          everSeen.has(r.mint) ||
          r.rugged === true ||
          r.strategy2Epoch !== config.strategy2Epoch ||
          // Audit fix (2026-07-29): the new-launch/dev-holding lane is documented as
          // observation-only (strategy2-scout.ts), but nothing here actually enforced that — if
          // a new-launch row ever happened to clear the mid-cap MC/liquidity/holder band too, it
          // could get bought under the wrong thesis. Empirically this hadn't happened yet
          // (checked live: 0 of 3,877 new-launch rows in one day cleared the mid-cap band), but
          // the code shouldn't rely on the two MC ranges never overlapping by chance.
          r.source === "new-launch-dev-holding"
        ) continue;
        const key = r.mint;
        const existing = seen.get(key);
        const at = r.firstSeenAt ?? Date.now();
        if (!existing || at < existing.at) {
          seen.set(key, {
            mint: r.mint, sym: r.sym ?? "?", mcUsd: r.mcUsd ?? 0, liqUsd: r.liqUsd ?? 0, holders: r.holders ?? 0, at,
            rugRatio: r.rugRatio ?? null, isWashTrading: r.isWashTrading ?? null,
            change1h: r.change1h ?? null, change24h: r.change24h ?? null,
            smartDegenCount: r.smartDegenCount ?? null, renownedCount: r.renownedCount ?? null,
            source: r.source ?? "unknown", strategy2Epoch: r.strategy2Epoch,
            netBuyers5m: r.jupNetBuyers5m ?? null, buyVolume5m: r.jupBuyVolume5m ?? null, sellVolume5m: r.jupSellVolume5m ?? null,
          });
        }
      } catch { /* skip malformed line */ }
    }
  }

  const MIN_LIQ_USD = 20_000; // below this, our own quote's price impact would be unreliable/huge
  const MIN_HOLDERS = 50; // matches the scout's own "holder banyak" floor

  // Audit fix (2026-07-29): "entry confirmation berbasis demand" — everything else in this filter
  // is a STATIC attribute of the token (holders, liquidity, rug ratio); none of it proves anyone
  // is actually buying RIGHT NOW. netBuyers5m/buyVolume5m/sellVolume5m come from Jupiter's live 5m
  // trade window (see strategy2-scout.ts's devSignal call). Missing data fails CLOSED (rejected,
  // not silently admitted) — "we can't confirm demand" is treated the same as "no demand", same
  // posture as every other unknown-vs-bad distinction in this project. Config-gated (not a
  // hardcoded law) because Jupiter 5m-stats coverage for this token class hasn't been measured
  // yet at scale — if it turns out to reject nearly everything, that's itself a measurement,
  // not just a bug, and the flag makes it a one-line toggle rather than a code change.
  /**
   * DIUKUR 2026-08-11, menjawab pertanyaan yang ditinggalkan komentar di atas.
   *
   * Cakupan Jupiter 5m untuk kelas token ini ternyata hanya 30%. Dari 239 kandidat yang lolos
   * semua gerbang statis dalam 2 hari, 168 (70%) gugur karena DATANYA HILANG dan hanya 28 karena
   * permintaannya benar-benar lemah. Gagal-tertutup jadi memotong tujuh dari sepuluh kandidat
   * atas dasar ketiadaan data, bukan atas dasar bukti — dan menahan S2 di ~5 trade/hari, terlalu
   * sedikit untuk pernah menyimpulkan apa pun (59 trade seumur hidup).
   *
   * Sekarang "buruk" dan "tidak diketahui" dipisahkan, persis seperti yang kita lakukan di
   * tempat lain (drained vs readFail pada harga, misalnya):
   *   - data ADA dan permintaan lemah  → TOLAK (bukti negatif, tetap dihormati)
   *   - data HILANG                    → terima, TAPI ditandai
   *
   * Penandanya wajib: tanpa `entryDemandKnown` di catatan penutupan, kedua populasi menyatu dan
   * kelonggaran ini tidak akan pernah bisa dinilai. Dengan penanda, "apakah yang tak terkonfirmasi
   * berkinerja lebih buruk?" terjawab sendiri dari data.
   */
  const demandKnown = (c: CandidateRow): boolean =>
    c.netBuyers5m != null && c.buyVolume5m != null && c.sellVolume5m != null;
  const demandConfirmed = (c: CandidateRow): boolean => {
    if (!config.strategy2Paper.requireDemandConfirmation) return true;
    if (!demandKnown(c)) return config.strategy2Paper.admitUnknownDemand;
    return c.netBuyers5m! > 0 && c.buyVolume5m! > c.sellVolume5m!;
  };

  const candidates = [...seen.values()].filter((c) =>
    // The configured $400K ceiling used to be labelled "soft" and never read anywhere, while
    // this paper trader silently used a separate local $50M ceiling. That made Strategy 2's
    // declared identity false. The configured bound is now the one authoritative admission rule.
    c.mcUsd >= config.strategy2Scout.minMcUsd && c.mcUsd <= config.strategy2Scout.maxMcUsd &&
    c.liqUsd >= MIN_LIQ_USD &&
    c.holders >= MIN_HOLDERS &&
    (c.rugRatio == null || c.rugRatio <= 0.3) && // GMGN's own documented danger threshold
    c.isWashTrading !== true &&
    Date.now() - c.at <= MAX_CANDIDATE_AGE_MS &&
    demandConfirmed(c),
  );

  // Composite score v2 (2026-07-29, data-driven flip — owner agreed after real outcome data):
  // v1 weighted smart-money/KOL presence and holder count POSITIVELY, on the hypothesis that more
  // "smart" wallets already in + more holders = safer/more likely to run. 125 real closes showed
  // the opposite: WINS averaged FEWER smart-money wallets (6.6 vs 25.9 for losses), FEWER
  // renowned/KOL wallets (1.9 vs 8.0), and FEWER holders (1,122 vs 2,344) at entry. Same inversion
  // pattern already documented for the sniper's own rawScore — heavy "smart money" presence more
  // often means "already discovered / already peaked" than "about to run." This flips the sign on
  // all three inverted signals to prefer LESS crowding, still just a hypothesis to MEASURE (v2),
  // not a proven edge — v1's cohort is preserved (tagged by epoch/cfg) for comparison. Momentum
  // (change1h/24h) is left unchanged: only ~24 of 127 real closes had a usable value, too sparse
  // to draw a directional conclusion from yet either way.
  const score = (c: CandidateRow): number =>
    -(c.smartDegenCount ?? 0) * 1 +
    -(c.renownedCount ?? 0) * 3 +
    Math.max(c.change1h ?? 0, c.change24h ?? 0, 0) * 0.5 +
    -Math.log10(Math.max(c.holders, 1)) * 5;

  return candidates.sort((a, b) => score(b) - score(a));
}

/**
 * BUNDLE-CLUSTER GATE (owner, 2026-07-30) — Strategy 2 had zero defense against coordinated/
 * "cooked" launches: a dev funds N "different" wallets that all buy in the same instant to fake
 * organic holder count/demand. Ported from a real finding, not a guess: checked GMGN's own
 * top-holders data (already-proxied `gmgnTopHolders`, no extra RPC budget spent) for the 5 real
 * rugs from 2026-07-30 (中本聪×2, RIKA, CATJAK, carp — all had entryLiqUsd $42k-$184k and 900-2000
 * holders, i.e. looked completely clean by every existing gate) plus the 2 positions open at the
 * time (GOAP, BUILDER). Tried several signals (top10Pct concentration, dev/creator wallet %) —
 * both were noisy/contradictory across the sample (BUILDER, presumed healthier, actually had
 * HIGHER dev-wallet% than some of the rugs). The one signal that cleanly separated all 5
 * confirmed rugs (100% positive) from BUILDER (negative) was simpler: whether 2+ of the top 10
 * holders share the EXACT SAME `start_holding_at` second — i.e. bought in the same instant,
 * which is essentially impossible for genuinely independent buyers and is the direct on-chain
 * fingerprint of a bundled/same-transaction buy. GOAP (open, unconfirmed) also flagged positive —
 * treated as a real elevated-risk signal, not a contradiction, since it just hadn't rugged yet in
 * its short holding time. n=7 is still a small sample; keep validating as more trades close.
 */
async function detectBundleCluster(mint: string): Promise<{ coordinated: boolean; clusterWallets: number; clusterPct: number }> {
  const holders = await gmgnTopHolders("sol", mint, undefined, "amount_percentage", 10);
  if (!holders || holders.length < 2) return { coordinated: false, clusterWallets: 0, clusterPct: 0 };
  const byTs = new Map<number, { pct: number; count: number }>();
  for (const h of holders) {
    const ts = h.start_holding_at as number | undefined;
    if (ts == null) continue;
    const pct = h.amount_percentage ?? 0;
    const entry = byTs.get(ts) ?? { pct: 0, count: 0 };
    entry.pct += pct; entry.count += 1;
    byTs.set(ts, entry);
  }
  let best = { pct: 0, count: 0 };
  for (const entry of byTs.values()) if (entry.count >= 2 && entry.count > best.count) best = entry;
  // Threshold is configurable and was raised 2→3 after the admission funnel exposed a 95%
  // rejection rate — see config.strategy2Paper.bundleMinCluster for the measured distribution.
  return { coordinated: best.count >= config.strategy2Paper.bundleMinCluster, clusterWallets: best.count, clusterPct: best.pct };
}

// ATH-PROXIMITY GATE (owner, 2026-07-30; CORRECTED 2026-07-31) — "is this pump already about to
// end". The thesis is unchanged: buying AT a token's all-time high has no room to run and a lot
// of room to fall, versus one that has already pulled back and shown it can absorb selling.
//
// The FIRST implementation was broken and its "validation" was meaningless. It read
// `dev.ath_token_info.ath_mc`, believing that to be this token's ATH market cap. It is not —
// `dev` describes the CREATOR, so that field is the creator's own best-ever *other* token
// (verified live: for mint Hzeue…DZbLn / "John" it points at JF4J6bz…XNrF / "DOG"). Every ratio
// the gate computed was this-token-MC ÷ some-unrelated-token-ATH-MC, which is why it fired only
// 10 times in a day against the bundle gate's 741. The apparent agreement with the bro/JMKE
// losses was coincidence, not evidence.
//
// The correct field is the top-level `ath_price`, denominated the same as `price.price`, so the
// ratio is computed price-vs-price. That also makes it independent of supply/MC bookkeeping,
// which this file already knows is the least trustworthy number GMGN returns (see the MC-anomaly
// guard). Treated as an UNVALIDATED hypothesis again from here — the earlier n=9 "confirmation"
// is withdrawn, and the rejections logged from now on carry `athSource:"ath_price"` so this
// cohort can be measured honestly rather than assumed to work.
const MAX_ATH_PROXIMITY_RATIO = 0.85; // reject if entry price is within 15% of the token's all-time high
function athProximity(info: GmgnTokenInfo | null, livePrice: number): { tooCloseToAth: boolean; athPrice: number | null; ratio: number | null } {
  const athPrice = Number(info?.ath_price);
  if (!isFinite(athPrice) || athPrice <= 0) return { tooCloseToAth: false, athPrice: null, ratio: null }; // unknown ATH — don't block on missing data
  const ratio = livePrice / athPrice;
  return { tooCloseToAth: ratio >= MAX_ATH_PROXIMITY_RATIO, athPrice, ratio };
}

/**
 * LIVE TOKEN SNAPSHOT (owner audit, 2026-07-31) — the fix for the single most damaging bug found
 * in this audit. `freshCandidates()` deliberately keeps the EARLIEST sighting of a mint (so that
 * "age" measures first-discovery, which is correct), but every downstream admission check then
 * read that same row's `mcUsd`/`liqUsd`/`holders` — numbers that could be up to
 * MAX_CANDIDATE_AGE_MS (6h) stale. Measured live on the five candidates the trader was looping
 * on at the time:
 *
 *     sym    liqUsd in candidate row     liquidity live     swaps_1h live
 *     John          $48,305                  $0.13               0
 *     Ashty        $148,271                  $0.49               0
 *     bro          $119,845                  $0.57               0
 *     STUCK         $41,468                  $0.12               0
 *
 * All four were already dead. Two consequences, both observed: (1) `entryMcUsd` was set from the
 * stale row, so the first live mark looked like an instant collapse and tripped the trailing stop
 * — five of eighteen closes died in under 65 seconds (pSOQ at 7s, -5.03%), which is an artifact
 * of the baseline, not a market move; (2) GMGN has no route for a dead token, so `gmgnQuote`
 * returned null, which was classified "retry", so the same corpses were re-quoted every 30s
 * forever — 1,053 failed quote calls burning the shared 20rps GMGN budget.
 *
 * So this runs FIRST, before the quote: one getTokenInfo call (the same one the ATH gate needs,
 * now shared instead of duplicated, so this costs nothing net) establishes whether the token is
 * still alive and what its price actually is RIGHT NOW. Dead tokens are blacklisted rather than
 * retried, and everything downstream uses the live numbers.
 *
 * Fails CLOSED on missing data, matching this file's existing posture everywhere else: if GMGN
 * won't tell us the price or the liquidity, we do not fall back to the stale row.
 */
const MIN_LIVE_LIQ_USD = 20_000; // same floor freshCandidates uses — but measured live, not from a 6h-old row
interface LiveSnapshot { info: GmgnTokenInfo; priceUsd: number; liqUsd: number; mcUsd: number; swaps1h: number; holders: number | null; decimals: number; supply: number }
async function liveSnapshot(mint: string): Promise<LiveSnapshot | null> {
  const info = await gmgnTokenInfo("sol", mint);
  if (!info) return null;
  const priceUsd = Number(info.price?.price);
  const liqUsd = Number(info.liquidity);
  // circulating_supply is the honest basis for MC; total_supply is the documented fallback when
  // GMGN omits it. GMGN returns no `market_cap` field on this endpoint at all (verified live),
  // which is why this is derived rather than read.
  const supply = Number(info.circulating_supply ?? info.total_supply);
  if (!isFinite(priceUsd) || priceUsd <= 0) return null;
  if (!isFinite(liqUsd) || liqUsd < 0) return null;
  if (!isFinite(supply) || supply <= 0) return null;
  const decimals = Number(info.decimals);
  if (!isFinite(decimals) || decimals < 0) return null;
  return {
    info, priceUsd, liqUsd, mcUsd: priceUsd * supply, decimals, supply,
    swaps1h: Number(info.price?.swaps_1h ?? 0),
    holders: typeof info.holder_count === "number" ? info.holder_count : null,
  };
}

/**
 * Returns whether the position actually opened. Review fix (2026-07-27): the caller used to
 * mark a candidate `everSeen` BEFORE knowing this succeeded — a single transient failure
 * (timeout, rate limit, no route yet) permanently blacklisted an otherwise-good candidate.
 * Now the caller only commits `everSeen` when this returns true.
 */
// Result type (owner, 2026-07-30) — found live: bundle/ATH rejections are STRUCTURAL (the
// same-second buy cluster or ATH-proximity ratio for a given snapshot isn't going to change
// moment-to-moment), but the original "never blacklist a rejection, only a success" rule (see
// comment above this function) meant they got retried EVERY poll forever — measured 68 retries
// of the same 2 candidates (YETI, PIPECATE) in 16 minutes, spending GMGN quote/holder-check
// budget on already-known-bad candidates instead of evaluating genuinely new ones. Transient
// failures (no quote yet, bad SOL price, cost ceiling — all of which can plausibly change next
// poll) keep the original retry behavior; "opened" and "blacklist" both commit to everSeen.
type OpenResult = "opened" | "retry" | "blacklist";
async function openPosition(s: State, c: CandidateRow, exposureCapUsd: number): Promise<OpenResult> {
  // Floored at minPositionUsd (owner, 2026-07-30) — see config.ts's comment on minPositionUsd
  // for the measured GMGN data behind this: below ~$1000 equity, riskPerTradePct alone produces
  // a position small enough that GMGN's own ~$0.63 fixed route overhead exceeds the entry-cost
  // ceiling on its own, rejecting every candidate regardless of quality.
  const sizeUsd = Math.max(s.equityUsd * (config.strategy2Paper.riskPerTradePct / 100), config.strategy2Paper.minPositionUsd);
  // LIVENESS GATE — runs before anything expensive. See liveSnapshot's comment for the measured
  // data behind this; in short, the candidate row's mcUsd/liqUsd can be 6h stale and was routinely
  // describing tokens that are already dead.
  const live = await liveSnapshot(c.mint);
  if (!live) {
    ui.warn(`[strategy2-paper] no live GMGN snapshot for ${c.sym} — skipping entry rather than trusting the ${Math.round((Date.now() - c.at) / 60_000)}min-old candidate row`);
    return "retry"; // a failed getTokenInfo really can be transient
  }
  const staleAgeMin = Math.round((Date.now() - c.at) / 60_000);
  if (live.liqUsd < MIN_LIVE_LIQ_USD || live.swaps1h === 0) {
    logRecord("events", {
      type: "strategy2-dead-token-rejected", mint: c.mint, sym: c.sym,
      liveLiqUsd: Number(live.liqUsd.toFixed(2)), candidateLiqUsd: c.liqUsd,
      liveMcUsd: Math.round(live.mcUsd), candidateMcUsd: Math.round(c.mcUsd),
      liveHolders: live.holders, candidateHolders: c.holders,
      swaps1h: live.swaps1h, candidateAgeMin: staleAgeMin,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.warn(`[strategy2-paper] ${c.sym} rejected — dead on live data: liquidity $${live.liqUsd.toFixed(2)} (candidate row said $${Math.round(c.liqUsd).toLocaleString()}, ${staleAgeMin}min ago), ${live.swaps1h} swaps in the last hour`);
    return "blacklist"; // a token that has already died does not come back next poll
  }
  // The MC band was checked in freshCandidates() against the STALE row. Re-check it against the
  // live number — a token that has since fallen out of the band is no longer the thing that was
  // selected, and admitting it would silently widen Strategy 2's declared identity.
  if (live.mcUsd < config.strategy2Scout.minMcUsd || live.mcUsd > config.strategy2Scout.maxMcUsd) {
    logRecord("events", {
      type: "strategy2-stale-mc-rejected", mint: c.mint, sym: c.sym,
      liveMcUsd: Math.round(live.mcUsd), candidateMcUsd: Math.round(c.mcUsd),
      bandMinUsd: config.strategy2Scout.minMcUsd, bandMaxUsd: config.strategy2Scout.maxMcUsd,
      candidateAgeMin: staleAgeMin, strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.warn(`[strategy2-paper] ${c.sym} rejected — live MC $${Math.round(live.mcUsd).toLocaleString()} is outside the $${config.strategy2Scout.minMcUsd.toLocaleString()}-$${config.strategy2Scout.maxMcUsd.toLocaleString()} band (candidate row said $${Math.round(c.mcUsd).toLocaleString()}, ${staleAgeMin}min ago)`);
    return "blacklist"; // it left the band; re-quoting it every 30s is exactly the waste this audit found
  }
  const solPrice = await solPriceUsd();
  if (!solPrice) { ui.warn("[strategy2-paper] no SOL price — skipping entry this cycle"); return "retry"; }
  const sizeLamports = Math.round((sizeUsd / solPrice) * 1e9);
  const q = await gmgnQuote("sol", config.strategy2Paper.quoteFromAddress, WRAPPED_SOL_MINT, c.mint, String(sizeLamports), 10);
  if (!q || !q.tx?.amount_in_usd) {
    // Audit 2026-07-31: this used to be an unconditional "retry", which is how 1,053 failed
    // quotes accumulated against a handful of dead mints. It still retries — a route genuinely
    // can appear a moment later — but only for a token the liveness gate above just confirmed is
    // alive and inside the band. If a token is alive, liquid and STILL unroutable, that is a
    // property of the token, not a blip, so it gets blacklisted after this one look.
    logRecord("events", {
      type: "strategy2-unroutable-rejected", mint: c.mint, sym: c.sym,
      liveLiqUsd: Number(live.liqUsd.toFixed(2)), liveMcUsd: Math.round(live.mcUsd), swaps1h: live.swaps1h,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.warn(`[strategy2-paper] ${c.sym} has live liquidity $${Math.round(live.liqUsd).toLocaleString()} but GMGN can't route a buy — skipping permanently, not a transient miss`);
    return "blacklist";
  }
  // Audit fix (2026-07-29, tightened after external re-audit): amount_in_usd/output_amount were
  // checked for finiteness but not positivity — a negative (still finite) quote number would
  // have sailed through and produced a nonsensical negative-cost "position". Both must be finite
  // AND > 0 now. Fail closed (skip the entry) rather than open on garbage data.
  const amountInUsd = Number(q.tx.amount_in_usd);
  const outputAmount = Number(q.output_amount);
  if (!isFinite(amountInUsd) || amountInUsd <= 0 || !q.output_amount || !isFinite(outputAmount) || outputAmount <= 0) {
    ui.warn(`[strategy2-paper] GMGN quote for ${c.sym} has non-finite/non-positive amount_in_usd or output_amount — skipping entry rather than risk a corrupt position`);
    return "retry";
  }
  // sol_cost is a REAL cost NOT reflected in amount_in_usd at all (verified live: sol_cost >
  // nominal input by ~0.007 SOL on a 0.1 SOL quote) — added here as extra entry cost rather
  // than silently ignored. Conservative: if sol_cost ever reads BELOW the nominal input for
  // some route, treat the shortfall as zero rather than crediting a cost as income.
  // Re-audit fix (2026-07-29): a non-finite sol_cost used to silently fall back to "zero extra
  // cost" — an assumption, which is exactly what this project's own "jangan asumsi" discipline
  // (see closePosition's solPriceUsd handling below) says not to do. Now it defers the entry
  // instead, same posture as every other "can't get a real number" case in this file.
  const rawSolCost = Number(q.tx.sol_cost);
  if (!isFinite(rawSolCost)) { ui.warn(`[strategy2-paper] GMGN quote for ${c.sym} has non-finite sol_cost — skipping entry rather than assume $0 extra cost`); return "retry"; }
  const solCostLamports = rawSolCost;
  const extraCostLamports = Math.max(0, solCostLamports - sizeLamports);
  const extraCostUsd = (extraCostLamports / 1e9) * solPrice;
  const entryCostUsd = amountInUsd + extraCostUsd;
  // Audit fix (2026-07-29): "cost-aware admission" — measured off the REAL quote, not a guess.
  // A route this costly one-way already implies the round trip (this + a comparable exit cost)
  // eats a meaningful chunk of the position before the token even has to move against us.
  const entryFrictionPct = (extraCostUsd / entryCostUsd) * 100;
  if (entryFrictionPct > config.strategy2Paper.maxEntryFrictionPct) {
    logRecord("events", {
      type: "strategy2-cost-rejected", mint: c.mint, sym: c.sym,
      entryFrictionPct: Number(entryFrictionPct.toFixed(2)), maxAllowedPct: config.strategy2Paper.maxEntryFrictionPct,
      entryCostUsd: Number(entryCostUsd.toFixed(2)), extraCostUsd: Number(extraCostUsd.toFixed(4)),
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.warn(`[strategy2-paper] ${c.sym} rejected on cost — entry friction ${entryFrictionPct.toFixed(2)}% exceeds ${config.strategy2Paper.maxEntryFrictionPct}% ceiling`);
    return "retry"; // friction moves a little with network/priority-fee conditions — worth another look next poll, unlike bundle/ATH below
  }
  // Audit fix (2026-07-29, re-audit): the exposure cap was checked BEFORE this entry using the
  // OLD openCostUsd total, then this position's real (post-quote) cost got added on top — an
  // entry starting at 98% of cap could still push total exposure to 103%+. Now the REAL cost (not
  // an estimate) is checked against the cap right before committing, so the invariant "open cost
  // never exceeds cap" actually holds — at the price of one "wasted" GMGN quote call when it's
  // over, which is cheap compared to a broken invariant.
  const currentOpenCostUsd = Object.values(s.positions).reduce((sum, p) => sum + p.entryCostUsd, 0);
  if (currentOpenCostUsd + entryCostUsd > exposureCapUsd) {
    ui.warn(`[strategy2-paper] ${c.sym} would push exposure to $${(currentOpenCostUsd + entryCostUsd).toFixed(2)} (cap $${exposureCapUsd.toFixed(2)}) — skipping this entry`);
    return "retry"; // exposure frees up as other positions close — worth another look next poll
  }
  // Solana Tracker enrichment — ONE call, only for a candidate that has already cleared every
  // cheap gate, so the metered budget is spent on genuine entry candidates and nothing else.
  // Recorded onto the open event below for later correlation against outcome; it does NOT gate.
  // See solanatracker.ts for why gating on this data would be premature (the documented bundler
  // signal failed to separate winners from rugs on the six real closes it was checked against).
  // Never allowed to block an entry: a null here means "no extra context", not "reject".
  const st: StSnapshot | null = solanaTrackerEnabled()
    ? await stTokenSnapshot(c.mint).catch(() => null)
    : null;

  // Bundle-cluster gate — last (most expensive) check, run only on a candidate that already
  // cleared everything else, same reasoning as the cost-friction check above.
  const bundle = await detectBundleCluster(c.mint);
  if (bundle.coordinated) {
    logRecord("events", {
      type: "strategy2-bundle-rejected", mint: c.mint, sym: c.sym,
      clusterWallets: bundle.clusterWallets, clusterPct: Number((bundle.clusterPct * 100).toFixed(2)),
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.warn(`[strategy2-paper] ${c.sym} rejected — ${bundle.clusterWallets} top holders bought in the exact same second (${(bundle.clusterPct * 100).toFixed(1)}% combined supply), looks bundled/coordinated`);
    return "blacklist"; // structural — the same-second buy cluster isn't going to un-happen on the next poll
  }
  if (bundle.clusterWallets >= 2) {
    // BELOW the rejection threshold but not clean either. Logged rather than acted on, so the
    // cohort that used to be blocked at clusterWallets=2 can be scored against real outcomes —
    // if these turn out to lose systematically, the threshold goes back down with evidence.
    logRecord("events", {
      type: "strategy2-bundle-observed", mint: c.mint, sym: c.sym,
      clusterWallets: bundle.clusterWallets, clusterPct: Number((bundle.clusterPct * 100).toFixed(2)),
      thresholdWas: config.strategy2Paper.bundleMinCluster,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
  }
  // ATH-proximity gate — price-vs-price off the live snapshot's own getTokenInfo (no second
  // call). See athProximity's comment for why the previous MC-vs-MC version was reading an
  // unrelated token's ATH.
  const ath = athProximity(live.info, live.priceUsd);
  if (ath.tooCloseToAth) {
    logRecord("events", {
      type: "strategy2-ath-rejected", mint: c.mint, sym: c.sym, athSource: "ath_price",
      entryPriceUsd: live.priceUsd, athPriceUsd: ath.athPrice, entryMcUsd: Math.round(live.mcUsd),
      ratio: Number((ath.ratio! * 100).toFixed(1)),
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.warn(`[strategy2-paper] ${c.sym} rejected — trading at ${(ath.ratio! * 100).toFixed(0)}% of its all-time-high price, too close to the top`);
    return "blacklist"; // structural — a token doesn't un-hit its all-time-high a poll later
  }
  s.positions[c.mint] = {
    // LIVE numbers, not the candidate row's (audit 2026-07-31): anchoring entryMcUsd to a stale
    // row is what made the first live mark look like an instant collapse and tripped the trailing
    // stop within seconds. entryHolders/entryLiqUsd likewise prefer the live reading and only
    // fall back to the row when GMGN omitted the field entirely.
    mint: c.mint, sym: c.sym, entryTokensRaw: q.output_amount, entryCostUsd, entryMcUsd: live.mcUsd,
    peakMcUsd: live.mcUsd, currentMcUsd: live.mcUsd, openedAt: Date.now(), entryHolders: live.holders ?? c.holders,
    entryLiqUsd: live.liqUsd, entrySource: c.source, entryChange1h: c.change1h, entryChange24h: c.change24h,
    entrySmartDegenCount: c.smartDegenCount, entryRenownedCount: c.renownedCount,
    entryDemandKnown: c.netBuyers5m != null && c.buyVolume5m != null && c.sellVolume5m != null,
    entryRugRatio: c.rugRatio, entryIsWashTrading: c.isWashTrading,
    openedEpoch: config.strategy2Epoch, openedCfg: configHash,
    decimals: live.decimals, supply: live.supply,
    peakRealizedValueUsd: entryCostUsd, // real high-water mark starts at cost; only ever revised by an actual quote
    remainingTokensRaw: q.output_amount, scaleOutTiersDone: [], realizedScaleOutUsd: 0,
  };
  logRecord("events", {
    type: "strategy2-paper-open", mint: c.mint, sym: c.sym, entryCostUsd: Number(entryCostUsd.toFixed(2)),
    entryTokensRaw: q.output_amount, entryMcUsd: live.mcUsd, gmgnExchange: q.tx.exchange ?? null,
    amountInUsd: Number(q.tx.amount_in_usd), extraCostUsd: Number(extraCostUsd.toFixed(4)), solCostLamports,
    platformFeeLamports: q.tx?.quote?.platformFee ?? null, priceImpactPct: q.tx?.quote?.priceImpactPct ?? null,
    equityUsdBefore: Number(s.equityUsd.toFixed(2)), strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    // Owner (2026-07-29): full admission snapshot, so a later "what did winners look like at
    // entry" analysis has real signal fields to correlate against outcome, not just P&L.
    entryHolders: live.holders ?? c.holders, entryLiqUsd: live.liqUsd, entrySource: c.source,
    entryChange1h: c.change1h, entryChange24h: c.change24h,
    entrySmartDegenCount: c.smartDegenCount, entryRenownedCount: c.renownedCount,
    entryDemandKnown: c.netBuyers5m != null && c.buyVolume5m != null && c.sellVolume5m != null,
    entryRugRatio: c.rugRatio, entryIsWashTrading: c.isWashTrading,
    // Kept alongside the live figures (audit 2026-07-31) so the size of the staleness problem
    // stays measurable in the log rather than being silently corrected away.
    candidateMcUsd: Math.round(c.mcUsd), candidateLiqUsd: Math.round(c.liqUsd),
    candidateHolders: c.holders, candidateAgeMin: staleAgeMin, athRatioPct: ath.ratio == null ? null : Number((ath.ratio * 100).toFixed(1)),
    // Solana Tracker risk block (2026-07-31) — observational for now. Logged so a later "what did
    // rugs actually look like at entry" question can be answered from real paired data instead of
    // a hunch. stPriceDeltaPct is the live disagreement between the two independent sources at
    // this exact moment; a large value means one of them is stale and the entry is less trustworthy.
    stRugged: st?.rugged ?? null, stRiskScore: st?.riskScore ?? null, stTop10Pct: st?.top10Pct ?? null,
    stSniperCount: st?.sniperCount ?? null, stSniperPct: st?.sniperPct ?? null,
    stInsiderCount: st?.insiderCount ?? null, stInsiderPct: st?.insiderPct ?? null,
    stBundlerCount: st?.bundlerCount ?? null, stBundlerPct: st?.bundlerPct ?? null,
    stDangerFlags: st?.dangerFlags ?? null, stLpBurn: st?.lpBurn ?? null,
    stFreezeAuthority: st?.freezeAuthority ?? null, stMintAuthority: st?.mintAuthority ?? null,
    stBuys: st?.buys ?? null, stSells: st?.sells ?? null,
    stChange5mPct: st?.change5mPct ?? null, stChange1hPct: st?.change1hPct ?? null,
    stMcUsd: st ? Math.round(st.mcUsd) : null, stLiqUsd: st ? Math.round(st.liqUsd) : null,
    stPriceDeltaPct: st ? Number(((st.priceUsd / live.priceUsd - 1) * 100).toFixed(2)) : null,
  });
  ui.pass(`[strategy2-paper] OPEN ${c.sym} — $${entryCostUsd.toFixed(2)} in (real quote + $${extraCostUsd.toFixed(3)} extra cost, ${q.tx.exchange}), live MC $${Math.round(live.mcUsd).toLocaleString()} (candidate row said $${Math.round(c.mcUsd).toLocaleString()}, ${staleAgeMin}min ago)`);
  return "opened";
}

// After this many consecutive failed sell-quote attempts, stop retrying and force a write-off
// instead — a token that's genuinely dead (no liquidity left in any pool) will NEVER get a real
// GMGN route no matter how many more times we ask, so "retry forever" just means "never realize
// the loss." At the poll cadence this runs (currently 30s), 10 misses is ~5 minutes of real
// retrying first — long enough that a merely-temporarily-illiquid token gets a fair shot.
const SELL_QUOTE_FAIL_LIMIT = 10;

// RATCHET TRAILING STOP (owner, 2026-07-30): a flat trailStopPct gives back the SAME percentage
// of the move regardless of how far a position has already run — 8% off a peak that's up 250%
// from entry surrenders far more real profit than the same 8% off a peak that's only up 20%.
// With a ~21% historical win rate (34W/129L per logs/strategy2-paper-state.json at the time this
// was added), the rare big runners are what the whole strategy's P&L depends on, so once a
// position is up this much from entry (peak vs entry, same MC basis checkExitAndUpdate already
// tracks) the trail tightens instead of staying at the same width used for a typical/modest move.
// Below the first tier, behavior is UNCHANGED from before this fix (still the configured 8%).
//
// EARLY-WINDOW TIGHTENING (owner, 2026-07-30) — a second, real trade ("bro") showed the exact
// same failure the "鲣鸟" fix above (config.ts's pollMs comment) already documented once:
// entryMcUsd === peakMcUsd (price never ticked UP even once before crashing), -73.46% by the
// time TRAIL_STOP fired, confirmed real by both the MC source AND a real GMGN quote (not a false
// reading — see closePosition's basis-mismatch guard, which this same tightened value also
// feeds). A position that hasn't shown ANY gain yet is in its highest-risk window — protect it
// with a much tighter stop for the first EARLY_WINDOW_SEC, before any real peak has formed to
// ratchet off of. Once either real time passes or real gain appears, this reverts to the normal
// tiers above — this is strictly ADDITIONAL caution on the way DOWN, never removes upside.
const EARLY_WINDOW_SEC = 300; // 5 minutes
const EARLY_TRAIL_STOP_PCT = 4;
function effectiveTrailStopPct(entryMcUsd: number, peakMcUsd: number, heldSec: number): number {
  const gainFromEntryPct = entryMcUsd > 0 ? ((peakMcUsd - entryMcUsd) / entryMcUsd) * 100 : 0;
  if (gainFromEntryPct >= 150) return 4;
  if (gainFromEntryPct >= 50) return 6;
  if (heldSec < EARLY_WINDOW_SEC) return EARLY_TRAIL_STOP_PCT;
  return config.strategy2Paper.trailStopPct;
}

async function closePosition(s: State, pos: OpenPosition, reason: string): Promise<void> {
  // IDEMPOTENT GUARD — set synchronously, before the first await, so a second concurrent caller
  // for the same mint bails out here instead of writing a duplicate close. Identity check as
  // well as presence: a stale `pos` whose mint was re-opened as a different position must not
  // close the new one. Mirrors the sniper's close() guard (trader.ts).
  if (pos.closing) return;
  if (s.positions[pos.mint] !== pos) return;
  pos.closing = true;
  try {
    await closePositionInner(s, pos, reason);
  } finally {
    // Release the claim if the position is STILL open — i.e. this call deferred (no sell quote,
    // no SOL price, false trigger) or threw. Only a completed close removes it from state, and
    // there is nothing left to release in that case.
    //
    // Structural on purpose: a flag that has to be hand-cleared on every early return is one
    // forgotten `return` away from stranding a position permanently — unable to EVER close,
    // which is strictly worse than the duplicate close this guard exists to prevent. Neither
    // await below can currently throw (callProxy catches everything; solPriceForMark has
    // .catch on both legs), so this is insurance against future edits, not a live bug.
    if (s.positions[pos.mint] === pos) pos.closing = false;
  }
}

async function closePositionInner(s: State, pos: OpenPosition, reason: string): Promise<void> {

  // Sell whatever's actually still held — scale-outs (if any executed) already reduced this
  // below entryTokensRaw; positions predating that field fall back to selling the full original.
  const q = await gmgnQuote("sol", config.strategy2Paper.quoteFromAddress, pos.mint, WRAPPED_SOL_MINT, pos.remainingTokensRaw ?? pos.entryTokensRaw, 10);
  // Audit fix (2026-07-29): a non-finite amount_out_usd (malformed quote) is treated the same as
  // "no quote at all" — same retry/eventual-forced-write-off path — instead of flowing through
  // to become a NaN exitValueUsd/pnlUsd below.
  if (!q || !q.tx?.amount_out_usd || !isFinite(Number(q.tx.amount_out_usd))) {
    pos.sellQuoteFailCount = (pos.sellQuoteFailCount ?? 0) + 1;
    if (pos.sellQuoteFailCount < SELL_QUOTE_FAIL_LIMIT) {
      ui.warn(`[strategy2-paper] no GMGN sell quote for ${pos.sym} — retrying next cycle (${pos.sellQuoteFailCount}/${SELL_QUOTE_FAIL_LIMIT})`);
      return;
    }
    // Owner found live (2026-07-29): RobinHub/PIPEDOG both crashed to MC ~$0 and sat "open" for
    // 3+ hours, 264 retries, never realized as a loss — GMGN can't route a sell into a pool with
    // nothing left in it, full stop. Force the write-off using the MC ratio as the best honest
    // estimate of what a sale WOULD have realized (naturally ≈$0 for a truly dead pool, but not
    // hardcoded to zero — if MC is merely down 80% rather than annihilated, this doesn't pretend
    // it's a 100% loss). Tagged distinctly so this is never confused with a real GMGN-priced exit.
    ui.reject(`[strategy2-paper] FORCED WRITE-OFF ${pos.sym} (${reason}) — ${SELL_QUOTE_FAIL_LIMIT} consecutive sell-quote failures, MC $${pos.currentMcUsd.toFixed(2)} vs entry $${Math.round(pos.entryMcUsd).toLocaleString()} — no liquidity to realistically exit into`);
    const impliedExitValueUsd = pos.entryMcUsd > 0 ? pos.entryCostUsd * (pos.currentMcUsd / pos.entryMcUsd) : 0;
    const pnlUsd = impliedExitValueUsd - pos.entryCostUsd;
    s.equityUsd += pnlUsd;
    s.losses++; // a forced write-off is never counted as a win, regardless of the (near-zero) implied value
    delete s.positions[pos.mint];
    logRecord("events", {
      type: "strategy2-paper-close", mint: pos.mint, sym: pos.sym, reason: `${reason}_NO_LIQUIDITY_FORCED`, forced: true, downtimeSec: pos.downtimeSec ?? null,
      entryCostUsd: Number(pos.entryCostUsd.toFixed(2)), exitValueUsd: Number(impliedExitValueUsd.toFixed(4)),
      pnlUsd: Number(pnlUsd.toFixed(2)), pnlPct: Number(((pnlUsd / pos.entryCostUsd) * 100).toFixed(2)),
      realizedScaleOutUsd: Number((pos.realizedScaleOutUsd ?? 0).toFixed(2)),
      entryMcUsd: pos.entryMcUsd, peakMcUsd: pos.peakMcUsd, exitMcUsd: pos.currentMcUsd,
      heldHours: Number(((Date.now() - pos.openedAt) / 3_600_000).toFixed(1)),
      sellQuoteFailCount: pos.sellQuoteFailCount, equityUsdAfter: Number(s.equityUsd.toFixed(2)),
      wins: s.wins, losses: s.losses, strategy2Epoch: pos.openedEpoch ?? config.strategy2Epoch, cfg: pos.openedCfg ?? configHash,
      entryHolders: pos.entryHolders ?? null, entryLiqUsd: pos.entryLiqUsd ?? null, entrySource: pos.entrySource ?? null,
      entryChange1h: pos.entryChange1h ?? null, entryChange24h: pos.entryChange24h ?? null,
      entrySmartDegenCount: pos.entrySmartDegenCount ?? null, entryRenownedCount: pos.entryRenownedCount ?? null,
      entryDemandKnown: pos.entryDemandKnown ?? null,
      entryRugRatio: pos.entryRugRatio ?? null, entryIsWashTrading: pos.entryIsWashTrading ?? null,
    });
    return;
  }
  // Same sol_cost treatment as entry, but SUBTRACTED here — a real cost taken out of proceeds.
  // Review fix (2026-07-27, follow-up audit): this used to fall back to $0 extra cost and still
  // FINALIZE the close when solPriceUsd() failed — silently dropping a real, nonzero SOL cost and
  // inflating the logged PnL, directly against the owner's "akurat fee juga jangan asumsi" spec.
  // Now it defers the close (same posture as the entry side, which already skips rather than
  // assumes) — a position sits one extra poll cycle rather than closing on a fabricated number.
  // Uses the resilient SOL price, not the raw Jupiter quote (2026-07-31). Deferring rather than
  // assuming is still right, but measured directly, `solPriceUsd()` returns null on roughly two
  // of three cold calls under Jupiter throttling — so the refusal was firing on a transient
  // outage, not on genuinely missing data. Caught during the downtime-reconciliation test: two
  // stranded positions were correctly selected for a DOWNTIME_GAP close and then BOTH deferred
  // for want of a SOL price, leaving them open exactly when the point was to settle them.
  // solPriceForMark() falls back to GMGN's SOL price (already verified against Jupiter) and
  // caches for a minute, so a real "we cannot price SOL at all" still defers, while a Jupiter
  // hiccup no longer blocks an exit.
  const solPrice = await solPriceForMark();
  if (!solPrice) {
    ui.warn(`[strategy2-paper] no SOL price from any source — deferring close for ${pos.sym} (${reason}) rather than assume $0 extra cost`);
    return;
  }
  // Audit fix (2026-07-29): `?? 0` only guards null/undefined — a malformed non-numeric sol_cost
  // would still produce NaN here (poisoning extraCostUsd/exitValueUsd/pnlUsd). isFinite catches
  // that case too, falling back to the conservative $0-extra-cost assumption.
  const rawExitSolCost = Number(q.tx.sol_cost);
  const solCostLamports = isFinite(rawExitSolCost) ? rawExitSolCost : 0;
  const extraCostUsd = (solCostLamports / 1e9) * solPrice;
  const exitValueUsd = Number(q.tx.amount_out_usd) - extraCostUsd;
  const pnlUsd = exitValueUsd - pos.entryCostUsd;

  // Basis-mismatch guard (2026-07-29, external audit + live confirmation): TRAIL_STOP is DECIDED
  // using peakMcUsd (Solana Tracker/DexScreener), but exitValueUsd here is always a REAL, routed
  // GMGN quote — confirmed live these can wildly disagree when DexScreener is stuck reporting a
  // stale/dead POOL (marketCap:0.03, 0 volume in every window, per DexScreener's own API) while
  // GMGN's routing finds a different, live, real pool. peakRealizedValueUsd tracks the true
  // high-water mark using ONLY real quote-derived numbers, so this check compares apples to
  // apples — MC-derived peak/drawdown never enters this decision. Only gates TRAIL_STOP (the one
  // reason whose entire premise is "the price fell — is that actually true?"); MAX_HOLD and
  // MANUAL_FLATTEN are wall-clock/operator-forced and must always execute regardless of price.
  const priorPeakRealized = pos.peakRealizedValueUsd ?? pos.entryCostUsd;
  const newPeakRealized = Math.max(priorPeakRealized, exitValueUsd);
  if (reason === "TRAIL_STOP") {
    const realDrawdownPct = ((exitValueUsd - newPeakRealized) / newPeakRealized) * 100;
    // Same ratcheted threshold checkExitAndUpdate used to trigger this close in the first place —
    // must match, or a big runner could trigger TRAIL_STOP at its tightened 4%/6% but then get
    // waved through here against the flat 8%, defeating the ratchet entirely.
    const trailStopPct = effectiveTrailStopPct(pos.entryMcUsd, pos.peakMcUsd, (Date.now() - pos.openedAt) / 1000);
    if (realDrawdownPct > -trailStopPct) {
      pos.peakRealizedValueUsd = newPeakRealized;
      // Resync the MC-based tracking too, using the REAL quote as ground truth, so the next poll
      // isn't still comparing against whatever garbage value poisoned peakMcUsd/currentMcUsd.
      const impliedMc = pos.entryCostUsd > 0 ? pos.entryMcUsd * (exitValueUsd / pos.entryCostUsd) : pos.entryMcUsd;
      pos.currentMcUsd = impliedMc;
      if (impliedMc > pos.peakMcUsd) pos.peakMcUsd = impliedMc;
      logRecord("events", {
        type: "strategy2-trailstop-false-trigger", mint: pos.mint, sym: pos.sym,
        markMcUsd: pos.currentMcUsd, markPeakMcUsd: pos.peakMcUsd, realExitValueUsd: Number(exitValueUsd.toFixed(2)),
        realPeakValueUsd: Number(newPeakRealized.toFixed(2)), realDrawdownPct: Number(realDrawdownPct.toFixed(1)),
        strategy2Epoch: pos.openedEpoch ?? config.strategy2Epoch, cfg: pos.openedCfg ?? configHash,
      });
      ui.warn(`[strategy2-paper] ${pos.sym} TRAIL_STOP false trigger — MC source says down beyond ${trailStopPct}% but real GMGN quote shows only ${realDrawdownPct.toFixed(1)}% from real peak — NOT closing`);
      return;
    }
  }
  pos.peakRealizedValueUsd = newPeakRealized;

  // Log-accuracy fix (owner, 2026-07-30 — "kode ini harus akurat bukan asumsi asal code"): this
  // used to log the raw `pos.currentMcUsd`, which is whatever the LAST MC poll set it to — on a
  // basis-mismatch close (MC source reads a crashed/dead pool while GMGN's real quote finds a
  // still-live one, see the false-trigger guard above) that could be $0 on a trade that actually
  // closed at a real, large PROFIT (verified live: Fauci closed +164.82% with exitMcUsd logged as
  // 0). Derive the logged exit MC from the REAL exitValueUsd instead, so a genuine rug (exitValueUsd
  // ≈ 0) still logs ≈ 0, but a real quote finding real value logs a real implied MC, not a stale
  // anomalous reading. Never reaches the dashboard (buildStrategy2Primary only forwards pnlPct/
  // pnlUsd/reason/heldHours) — this only affects the raw events-*.jsonl log used for later analysis.
  const impliedExitMcUsd = pos.entryCostUsd > 0 ? pos.entryMcUsd * (exitValueUsd / pos.entryCostUsd) : pos.currentMcUsd;

  s.equityUsd += pnlUsd;
  if (pnlUsd >= 0) s.wins++; else s.losses++;
  delete s.positions[pos.mint];
  logRecord("events", {
    type: "strategy2-paper-close", mint: pos.mint, sym: pos.sym, reason, downtimeSec: pos.downtimeSec ?? null,
    entryCostUsd: Number(pos.entryCostUsd.toFixed(2)), exitValueUsd: Number(exitValueUsd.toFixed(2)),
    amountOutUsd: Number(q.tx.amount_out_usd), extraCostUsd: Number(extraCostUsd.toFixed(4)), solCostLamports,
    pnlUsd: Number(pnlUsd.toFixed(2)), pnlPct: Number(((pnlUsd / pos.entryCostUsd) * 100).toFixed(2)),
    // realizedScaleOutUsd (0 if no tier ever fired) — this close's own pnlUsd only covers the
    // portion still held; add the two together for the trade's TOTAL P&L across its whole life.
    realizedScaleOutUsd: Number((pos.realizedScaleOutUsd ?? 0).toFixed(2)),
    entryMcUsd: pos.entryMcUsd, peakMcUsd: pos.peakMcUsd, exitMcUsd: impliedExitMcUsd,
    heldHours: Number(((Date.now() - pos.openedAt) / 3_600_000).toFixed(1)),
    gmgnExchange: q.tx.exchange ?? null, equityUsdAfter: Number(s.equityUsd.toFixed(2)),
    // Fallback to the live config only for positions opened before this field existed (legacy
    // state on disk) — never for positions opened after this fix, which always carry their own.
    wins: s.wins, losses: s.losses, strategy2Epoch: pos.openedEpoch ?? config.strategy2Epoch, cfg: pos.openedCfg ?? configHash,
    // Owner (2026-07-29): echo the entry snapshot onto the CLOSE record too, so "why did this
    // win/lose" never requires joining against the (much larger, rotated) open-event log.
    // `?? null` covers positions opened before this fix, whose on-disk state predates these fields.
    entryHolders: pos.entryHolders ?? null, entryLiqUsd: pos.entryLiqUsd ?? null, entrySource: pos.entrySource ?? null,
    entryChange1h: pos.entryChange1h ?? null, entryChange24h: pos.entryChange24h ?? null,
    entrySmartDegenCount: pos.entrySmartDegenCount ?? null, entryRenownedCount: pos.entryRenownedCount ?? null,
    entryDemandKnown: pos.entryDemandKnown ?? null,
    entryRugRatio: pos.entryRugRatio ?? null, entryIsWashTrading: pos.entryIsWashTrading ?? null,
  });
  const line = `[strategy2-paper] CLOSE ${pos.sym} (${reason}) = ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} | ${s.wins}W/${s.losses}L, equity $${s.equityUsd.toFixed(2)}`;
  pnlUsd >= 0 ? ui.pass(line) : ui.reject(line);
}

// SCALE-OUT (owner, 2026-07-30) — see config.ts's scaleOutTiers comment for the real trade
// (Kimi K3) that motivated this. Realizes a FIXED fraction of the ORIGINAL position size, in
// real quote-verified USD, the moment gain-from-entry crosses each configured threshold —
// independent of whatever the trailing stop is doing, and executed BEFORE this poll's
// trail/max-hold check so a position that just crossed a tier locks in the slice before any
// exit-close logic runs on the same tick.
async function attemptScaleOuts(s: State, pos: OpenPosition, mc: number): Promise<void> {
  const gainFromEntryPct = pos.entryMcUsd > 0 ? ((mc - pos.entryMcUsd) / pos.entryMcUsd) * 100 : 0;
  const done = pos.scaleOutTiersDone ?? [];
  const tiers = config.strategy2Paper.scaleOutTiers;
  for (let i = 0; i < tiers.length; i++) {
    if (done.includes(i)) continue;
    if (gainFromEntryPct < tiers[i]!.gainFromEntryPct) continue; // not reached yet — tiers are checked in order, no need to look further ahead
    const remainingRaw = BigInt(pos.remainingTokensRaw ?? pos.entryTokensRaw);
    if (remainingRaw <= 0n) { pos.scaleOutTiersDone = [...(pos.scaleOutTiersDone ?? done), i]; continue; }
    // Fraction of the ORIGINAL size, not of whatever remains — two tiers hit in the same poll
    // (a token that gapped past both thresholds between polls) each take their own bite of the
    // original, capped at whatever's actually still held so this can never oversell.
    const wantRaw = (BigInt(pos.entryTokensRaw) * BigInt(Math.round(tiers[i]!.sellFractionOfOriginal * 10_000))) / 10_000n;
    const sellRaw = wantRaw > remainingRaw ? remainingRaw : wantRaw;
    if (sellRaw <= 0n) { pos.scaleOutTiersDone = [...(pos.scaleOutTiersDone ?? done), i]; continue; }

    const q = await gmgnQuote("sol", config.strategy2Paper.quoteFromAddress, pos.mint, WRAPPED_SOL_MINT, sellRaw.toString(), 10);
    if (!q || !q.tx?.amount_out_usd || !isFinite(Number(q.tx.amount_out_usd))) {
      ui.warn(`[strategy2-paper] ${pos.sym} scale-out tier ${i} reached (+${gainFromEntryPct.toFixed(0)}%) but no GMGN sell quote — retrying next poll`);
      continue; // do NOT mark done — retry next poll rather than silently skip this tier forever
    }
    const solPrice = await solPriceUsd();
    if (!solPrice) continue; // same posture as everywhere else here — defer rather than assume $0 extra cost
    const rawSolCost = Number(q.tx.sol_cost);
    const extraCostUsd = (isFinite(rawSolCost) ? rawSolCost : 0) / 1e9 * solPrice;
    const proceedsUsd = Number(q.tx.amount_out_usd) - extraCostUsd;
    // Cost basis sold = per-token cost × tokens sold. Per-token cost is exactly
    // pos.entryCostUsd / remainingRaw at ANY point, including after earlier tiers already
    // shrank both — each tier removes the same proportion from entryCostUsd as it does from the
    // token count, so the ratio never drifts from the position's true original per-token cost.
    // No separate "original per-token cost" field needed; this is exact, not an approximation.
    const perTokenCostUsd = remainingRaw > 0n ? pos.entryCostUsd / Number(remainingRaw) : 0;
    const costBasisSoldUsd = perTokenCostUsd * Number(sellRaw);
    const partialPnlUsd = proceedsUsd - costBasisSoldUsd;

    s.equityUsd += partialPnlUsd;
    pos.remainingTokensRaw = (remainingRaw - sellRaw).toString();
    pos.entryCostUsd -= costBasisSoldUsd; // shrink the remaining cost basis so later tiers/final close see the correct remainder
    pos.realizedScaleOutUsd = (pos.realizedScaleOutUsd ?? 0) + partialPnlUsd;
    pos.scaleOutTiersDone = [...(pos.scaleOutTiersDone ?? done), i];

    logRecord("events", {
      type: "strategy2-scaleout", mint: pos.mint, sym: pos.sym, tier: i,
      gainFromEntryPct: Number(gainFromEntryPct.toFixed(1)), sellFractionOfOriginal: tiers[i]!.sellFractionOfOriginal,
      sellTokensRaw: sellRaw.toString(), proceedsUsd: Number(proceedsUsd.toFixed(2)),
      costBasisSoldUsd: Number(costBasisSoldUsd.toFixed(2)), partialPnlUsd: Number(partialPnlUsd.toFixed(2)),
      remainingTokensRaw: pos.remainingTokensRaw, remainingCostBasisUsd: Number(pos.entryCostUsd.toFixed(2)),
      equityUsdAfter: Number(s.equityUsd.toFixed(2)),
      strategy2Epoch: pos.openedEpoch ?? config.strategy2Epoch, cfg: pos.openedCfg ?? configHash,
    });
    const line = `[strategy2-paper] SCALE-OUT ${pos.sym} tier ${i} (+${gainFromEntryPct.toFixed(0)}% from entry) — sold ${(tiers[i]!.sellFractionOfOriginal * 100).toFixed(0)}% of original, realized ${partialPnlUsd >= 0 ? "+" : ""}$${partialPnlUsd.toFixed(2)}`;
    partialPnlUsd >= 0 ? ui.pass(line) : ui.reject(line);
  }
}

// FEELING AGENT for Strategy 2 (owner, 2026-07-30) — see config.ts's agentEnabled comment for
// why this exists now. Logs a `type: "vibe"` event in the SAME shape src/trader.ts (the
// sniper) already uses, so server.ts's existing merge (E.vibe.all(), and the `beats` feed that
// powers the dashboard's Feeling Agent bubble) picks these up with ZERO server.ts changes — that
// merge was already source-agnostic, it just never had a second source calling it before.
async function judgeS2Vibe(s: State, pos: OpenPosition, mc: number): Promise<void> {
  if (!config.strategy2Paper.agentEnabled || !feelingEnabled) return;
  const heldSec = Math.round((Date.now() - pos.openedAt) / 1000);
  if (heldSec < config.strategy2Paper.agentMinHoldSecToJudge) return;
  if (pos.lastVibeAt && Date.now() - pos.lastVibeAt < config.strategy2Paper.agentJudgeCooldownMs) return;
  pos.lastVibeAt = Date.now();

  const gainFromEntryPct = pos.entryMcUsd > 0 ? ((mc - pos.entryMcUsd) / pos.entryMcUsd) * 100 : 0;
  const peakGainPct = pos.entryMcUsd > 0 ? ((pos.peakMcUsd - pos.entryMcUsd) / pos.entryMcUsd) * 100 : 0;
  const drawdownFromPeakPct = pos.peakMcUsd > 0 ? ((mc - pos.peakMcUsd) / pos.peakMcUsd) * 100 : 0;
  const v = await judgeVibe({
    symbol: pos.sym, mode: "strategy2-scout", heldSec,
    priceFromEntryPct: Number(gainFromEntryPct.toFixed(1)), peakGainPct: Number(peakGainPct.toFixed(1)), drawdownFromPeakPct: Number(drawdownFromPeakPct.toFixed(1)),
    // buyingGrowthPct/secsSinceLastBuyingHigh omitted — Strategy 2 doesn't track live buy-flow per
    // position (only a one-time snapshot at entry), and the prompt now handles their absence as
    // "data not available", never as "no buying happening" (see feeling-agent.ts rule 2).
    marketCapUsd: mc, chart: null, holdersAtEntry: pos.entryHolders ?? undefined,
    organicScore: undefined, whale: null, crowd: null, devBehavior: "unknown", rugCluster: null,
  }, false); // shadow=false: this IS allowed to act (agentCanExit below), not just observed
  if (!v) return;

  logRecord("events", {
    type: "vibe", mint: pos.mint, symbol: pos.sym, vibe: v.vibe, confidence: v.confidence,
    reason: v.reason, evidence: v.evidence ?? null, missingCritical: v.missingCritical ?? null,
    execPnlPct: Number(gainFromEntryPct.toFixed(1)), peakGainPct: Number(peakGainPct.toFixed(1)), heldSec,
    shadow: false, mode: "strategy2", strategy2Epoch: pos.openedEpoch ?? config.strategy2Epoch, cfg: pos.openedCfg ?? configHash,
  });
  ui.info(`[strategy2-paper] ${pos.sym} agent verdict: ${v.vibe} (${v.confidence}%) — ${v.reason}`);

  if (config.strategy2Paper.agentCanExit && v.vibe === "dead" && v.confidence >= config.strategy2Paper.agentMinConfidenceToExit) {
    ui.warn(`[strategy2-paper] ${pos.sym} AGENT_DEAD — ${v.confidence}% confidence dead verdict: ${v.reason}`);
    await closePosition(s, pos, "AGENT_DEAD");
  }
}

// MC ANOMALY GUARD (P0 fix, 2026-07-28): position HOOD's peakMcUsd went from a $2.5M entry to
// "$23.87B" on a single bad Solana Tracker read, and since peaks are a high-water mark that never
// comes back down, that corrupted number stood forever, permanently poisoning its trailing-stop
// math. Owner's explicit spec: do NOT use a naive ">Nx = reject" hard rule — real memecoins DO
// spike hundreds of times over legitimately. Instead, an extreme single-poll jump/crash is HELD
// for confirmation on the very next poll: if a follow-up read lands in the same neighborhood, the
// move was real and gets trusted; if it doesn't, the first read was bad data and gets discarded.
// The ratio itself is only a "needs scrutiny" trigger, never a final verdict.

async function checkExitAndUpdate(s: State, pos: OpenPosition, mc: number): Promise<void> {
  pos.currentMcUsd = mc;
  if (mc > pos.peakMcUsd) pos.peakMcUsd = mc;
  // Scale-out BEFORE the trail/max-hold check below, so a position that just crossed a tier
  // this same tick locks in that slice before any full-close logic runs against it.
  await attemptScaleOuts(s, pos, mc);
  if (!s.positions[pos.mint]) return; // scale-out itself never fully closes a position, but be defensive
  const heldSec = (Date.now() - pos.openedAt) / 1000;
  const trailStopPct = effectiveTrailStopPct(pos.entryMcUsd, pos.peakMcUsd, heldSec);
  const drawdownFromPeakPct = ((mc - pos.peakMcUsd) / pos.peakMcUsd) * 100;
  const heldHours = heldSec / 3600;
  if (drawdownFromPeakPct <= -trailStopPct) {
    await closePosition(s, pos, "TRAIL_STOP");
  } else if (heldHours >= config.strategy2Paper.maxHoldHours) {
    await closePosition(s, pos, "MAX_HOLD");
  }
  // Mechanical exits above take priority within this tick — only judge vibe (and possibly act on
  // it) if the position is still open after them.
  if (s.positions[pos.mint]) await judgeS2Vibe(s, pos, mc);
}

/**
 * Bounded-concurrency map: with maxConcurrentPositions now UNCAPPED (owner, 2026-07-29), a fully
 * sequential per-position check (the old behaviour) could take longer than the poll interval
 * itself once enough positions are open — e.g. 34 positions × up to 8s each = potentially minutes,
 * which is worse than the "realtime" the owner is asking for and defeats a short pollMs entirely.
 * Runs up to `limit` checks in flight at once instead of one-by-one.
 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function poll(): Promise<void> {
  if (!gmgnEnabled) { ui.warn("[strategy2-paper] GMGN_API_KEY not set — cannot poll"); return; }
  const s = loadState();
  s.lastHeartbeatAt = Date.now(); // written every poll so a restart can measure how long we were gone

  // 0) Emergency flatten (audit fix, 2026-07-29) — Strategy 2 previously had NO operator
  // override at all: positions are noManualClose and the sniper's own /api/control command
  // channel never reaches this process. Own namespace/id sequence so this never collides with
  // the sniper's flatten/close/reset-run commands sharing the same control.json file.
  // `strategy2FlattenPending` (not a one-shot attempt) keeps retrying on every poll until every
  // position is ACTUALLY gone — a single failed GMGN quote must not silently abandon an
  // emergency stop; positions that can't get a real quote still resolve via the existing
  // no-liquidity forced-write-off path in closePosition() after enough failed attempts.
  const ctl = readControl();
  const cmd = ctl.strategy2Command;
  if (cmd && cmd.id > (s.strategy2LastCommandId ?? 0)) {
    s.strategy2LastCommandId = cmd.id;
    if (cmd.action === "flatten") s.strategy2FlattenPending = true;
  }
  if (s.strategy2FlattenPending) {
    const toFlatten = Object.values(s.positions);
    if (toFlatten.length === 0) {
      s.strategy2FlattenPending = false;
      ui.pass("[strategy2-paper] MANUAL FLATTEN complete — no positions remain");
    } else {
      ui.reject(`[strategy2-paper] MANUAL FLATTEN in progress — closing ${toFlatten.length} open position(s)`);
      await mapLimit(toFlatten, 12, (pos) => closePosition(s, pos, "MANUAL_FLATTEN"));
    }
  }

  // 1) Mark-to-market + exit check for every open position — up to 12 in flight at once (owner,
  // 2026-07-29: "harus realtime, gak bisa nunggu"). Each position's own state mutations only
  // touch that position's object; shared counters (wins/losses/equityUsd) are only ever written
  // inside a single synchronous statement in closePosition(), so concurrent execution across
  // positions can't interleave mid-update — JS never yields the event loop mid-statement.
  const pollSolUsd = await solPriceForMark();
  await mapLimit(Object.values(s.positions), 12, async (pos) => {
    const mark = await markPosition(pos, pollSolUsd);
    const mc = mark?.mcUsd ?? null;
    if (mc == null) {
      logRecord("events", {
        type: "strategy2-mark-unavailable", mint: pos.mint, sym: pos.sym,
        checkedAt: Date.now(),
        strategy2Epoch: pos.openedEpoch, cfg: pos.openedCfg,
      });
      // Audit fix (2026-07-29): this used to just `return` here, meaning MAX_HOLD could never
      // fire for a position whose mark happened to be unavailable (Solana Tracker 403/429 AND
      // DexScreener both failing) — confirmed happening 94 times in one day live. The mark stays
      // unknown (never fabricated — trailing-stop/peak math is correctly skipped below), but the
      // hard timeout is a WALL-CLOCK fact independent of price, so it still has to fire. The real
      // GMGN sell-quote closePosition() needs doesn't depend on Solana Tracker/DexScreener at all.
      const heldHours = (Date.now() - pos.openedAt) / 3_600_000;
      if (heldHours >= config.strategy2Paper.maxHoldHours) {
        ui.warn(`[strategy2-paper] ${pos.sym} MAX_HOLD reached while mark unavailable — attempting close anyway (last known MC $${pos.currentMcUsd.toFixed(2)})`);
        await closePosition(s, pos, "MAX_HOLD");
      }
      return; // transient read failure — never fabricate a price
    }
    if (pos.lastMarkSource !== mark!.source) {
      logRecord("events", {
        type: "strategy2-mark-source", mint: pos.mint, sym: pos.sym,
        source: mark!.source, previousSource: pos.lastMarkSource ?? null,
        checkedAt: Date.now(),
        strategy2Epoch: pos.openedEpoch, cfg: pos.openedCfg,
      });
      pos.lastMarkSource = mark!.source;
    }

    // Verdict comes from the pure classifier in ./mc-anomaly.ts (unit-tested there — see
    // `npm run mc-anomaly:selftest`, which pins the real HOOD case $2.5M → $23.87B → $2.6M).
    // This block only does the I/O: logging, UI, and writing the result back to the position.
    const verdict = classifyMcMark(pos.currentMcUsd, pos.pendingMcUsd, mc);
    for (const st of verdict.stages) {
      logRecord("events", {
        type: "strategy2-mc-anomaly", stage: st.stage,
        mint: pos.mint, sym: pos.sym, oldValue: pos.currentMcUsd,
        pendingValue: st.pendingValue, rawValue: mc,
        ratio: st.ratio != null ? Number(st.ratio.toFixed(2)) : undefined,
        source: mark!.source, checkedAt: Date.now(), strategy2Epoch: pos.openedEpoch, cfg: pos.openedCfg,
      });
      const usd = (v: number): string => `$${Math.round(v).toLocaleString()}`;
      if (st.stage === "confirmed") ui.pass(`[strategy2-paper] MC-ANOMALY ${pos.sym} CONFIRMED — sustained at ~${usd(mc)}, now trusted`);
      else if (st.stage === "rejected") ui.warn(`[strategy2-paper] MC-ANOMALY ${pos.sym} REJECTED — pending ${usd(st.pendingValue ?? 0)} not corroborated by ${usd(mc)}, discarding bad mark`);
      else ui.warn(`[strategy2-paper] MC-ANOMALY ${pos.sym} FLAGGED — ${usd(pos.currentMcUsd)} → ${usd(mc)} (${(st.ratio ?? 0).toFixed(1)}x), holding for confirmation next poll`);
    }
    pos.pendingMcUsd = verdict.pending;
    pos.pendingMcAt = verdict.action === "hold" ? Date.now() : undefined;
    if (verdict.action === "hold") return; // do NOT update currentMcUsd/peakMcUsd or check exits

    await checkExitAndUpdate(s, pos, mc);
  });

  // 2) New entries, up to the concurrency cap, from candidates never seen before.
  // Skipped entirely while a flatten is in progress (audit fix, 2026-07-29) — opening new
  // positions during an emergency stop would defeat the point of the emergency stop.
  const everSeen = new Set(s.everSeen);
  const openCount = Object.keys(s.positions).length;
  if (!s.strategy2FlattenPending && openCount < config.strategy2Paper.maxConcurrentPositions) {
    // Exposure cap — total OPEN COST (not position count) is bounded to maxExposurePct of
    // current equity. The REAL enforcement (against the actual post-quote entryCostUsd) lives
    // inside openPosition() now (re-audit fix, 2026-07-29 — this outer check alone could overshoot
    // the cap by one position's worth, since it only compared the cap against cost BEFORE the new
    // position's real size was known). This outer check stays as a cheap fast-path so the loop
    // stops issuing pointless GMGN quote calls once obviously already at/over cap.
    const exposureCapUsd = s.equityUsd * (config.strategy2Paper.maxExposurePct / 100);
    const fresh = freshCandidates(everSeen).slice(0, config.strategy2Paper.maxConcurrentPositions - openCount);
    for (const c of fresh) {
      const openCostUsd = Object.values(s.positions).reduce((sum, p) => sum + p.entryCostUsd, 0);
      if (openCostUsd >= exposureCapUsd) {
        ui.warn(`[strategy2-paper] exposure cap reached ($${openCostUsd.toFixed(2)} of $${exposureCapUsd.toFixed(2)} allowed) — skipping remaining candidates this cycle`);
        break;
      }
      const result = await openPosition(s, c, exposureCapUsd);
      // "opened" and "blacklist" both commit to the dedupe (blacklist = structural rejection,
      // won't change next poll — see OpenResult's comment); "retry" leaves it out so a genuinely
      // transient failure (no quote yet, exposure temporarily full) gets another look.
      if (result === "opened" || result === "blacklist") everSeen.add(c.mint);
    }
  }
  s.everSeen = [...everSeen].slice(-5_000); // bounded — this is a dedupe memory, not an audit log

  saveState(s);
  ui.info(`[strategy2-paper] ${s.wins}W/${s.losses}L, equity $${s.equityUsd.toFixed(2)}, ${Object.keys(s.positions).length} open`);
}

// Overlap guard (owner, 2026-07-29): positions are uncapped now and pollMs is much shorter, so a
// slow cycle (many positions, a degraded upstream API) could still be running when the NEXT
// tick fires. Two concurrent poll() calls would both loadState()/saveState() the same file —
// last write wins, silently dropping whatever the other one did. Skip a tick rather than race.
// Shared by BOTH poll() and fastTrailStopCheck() below (2026-07-30) — same state file, same hazard.
let pollRunning = false;
async function pollGuarded(): Promise<void> {
  if (pollRunning) { ui.warn("[strategy2-paper] previous poll still running — skipping this tick rather than overlap"); return; }
  pollRunning = true;
  try { await poll(); } finally { pollRunning = false; }
}

// FAST TRAIL-STOP CHECK, ALL OPEN POSITIONS (owner, 2026-07-30) — see effectiveTrailStopPct's
// EARLY_WINDOW comment for the trade ("bro", -73.46%) that motivated the first version of this.
// ORIGINALLY scoped to positions under EARLY_WINDOW_SEC only ("only fresh positions are
// high-risk") — widened after a second real trade (CORGI: peaked +55% from entry, ratchet tier
// should have exited ~6% off that peak, actually exited -61% off it) closed at heldHours=0.1
// (~6 minutes), just OUTSIDE that 5-minute window, so it never got the fast check at all and sat
// on the 30s cycle instead. The "only fresh positions need this" framing was wrong — ANY
// position can crash faster than 30s can catch, whenever it happens in its life, not just in the
// first few minutes. Removed the age filter entirely: every open position now gets this check.
// Still safe to run this often: mark-to-market is Jupiter/DexScreener (not GMGN, no extra
// rate-limit pressure), and the only GMGN cost — the real quote closePosition() needs — is paid
// once either way, just triggered sooner instead of MORE OFTEN. New entries, scale-out, and
// vibe-judge stay on the slower pollMs cycle (config.ts's own pollMs history note still applies
// to THOSE: "30s is the practical floor... GMGN quotes cost real budget per call").
/**
 * Mark one open position, preferring raptor (raw AMM reserves) over the aggregator chain.
 *
 * Why raptor goes first (2026-07-31): both Solana Tracker Data API keys are spent, so the old
 * primary answers 403/429 on essentially every call, and the chain behind it — Jupiter, then
 * DexScreener — is what produced the junk $0.03 marks that kept tripping the MC-anomaly guard.
 * Raptor answers 200 for the same key, does not throttle, and priced 14 of 14 real tokens within
 * 1.7% of GMGN (see raptor.ts for the full calibration).
 *
 * It needs an anchor to tell the two pool reserves apart, and the position supplies one for free:
 * the last trusted MC divided by supply is the last trusted PRICE. That also means the anchor is
 * never a foreign number — it is this position's own history.
 *
 * Falls back to the old path whenever raptor can't answer or the position predates the stored
 * decimals/supply, so this is strictly additive: a position can always still be marked.
 */
/**
 * SOL price for marking, with a fallback that matters more than it looks.
 *
 * `solPriceUsd()` prices a real 1 SOL → USDC Jupiter quote and caches ~60s, which is the right
 * definition — but measured directly, 2 of 3 cold calls returned null under Jupiter throttling.
 * Every null would silently drop raptor out of the mark path (it needs a SOL price to convert
 * reserves to USD) and hand the mark back to the aggregator chain this change exists to get off.
 * GMGN already returns a SOL price on an endpoint this process calls constantly, so it costs
 * nothing to use it as a second opinion. Cached locally so a burst of position marks in one tick
 * shares a single lookup.
 */
let solMarkCache = { price: 0, at: 0 };
async function solPriceForMark(): Promise<number | null> {
  if (Date.now() - solMarkCache.at < 60_000 && solMarkCache.price > 0) return solMarkCache.price;
  const jup = await solPriceUsd().catch(() => null);
  if (jup && jup > 0) { solMarkCache = { price: jup, at: Date.now() }; return jup; }
  const info = await gmgnTokenInfo("sol", WRAPPED_SOL_MINT).catch(() => null);
  const gm = Number(info?.price?.price);
  if (isFinite(gm) && gm > 0) { solMarkCache = { price: gm, at: Date.now() }; return gm; }
  return solMarkCache.price > 0 ? solMarkCache.price : null;
}

async function markPosition(pos: OpenPosition, solUsd: number | null): Promise<{ mcUsd: number | null; source: OpenPosition["lastMarkSource"] } | null> {
  if (solUsd && solUsd > 0 && pos.decimals != null && pos.supply != null && pos.supply > 0 && pos.currentMcUsd > 0) {
    const anchorPriceUsd = pos.currentMcUsd / pos.supply;
    const m = await raptorPrice(pos.mint, pos.decimals, solUsd, anchorPriceUsd).catch(() => null);
    if (m) return { mcUsd: m.priceUsd * pos.supply, source: "raptor" };
  }
  const mark = await tokenMarketSnapshot(pos.mint);
  return mark ? { mcUsd: mark.mcUsd, source: mark.source } : null;
}

const FAST_CHECK_MS = 8_000;
async function fastTrailStopCheck(): Promise<void> {
  if (pollRunning) return; // don't race the main poll's own loadState/saveState
  pollRunning = true;
  try {
    const s = loadState();
    // Anomaly-pending positions are INCLUDED (fix 2026-07-31, traced from the Fraggle trade).
    // This used to filter them out — `p.pendingMcUsd == null` — to avoid duplicating the slow
    // poll's confirm/reject state machine. The intent was right, the consequence was not: the
    // pending flag is about not COMMITTING a suspicious number to state, but filtering here also
    // switched off the exit path, which is the one thing that must never stop running.
    //
    // It mattered because pending is not a rare state. The primary mark source (Solana Tracker)
    // is answering 403/429 on effectively every call now that both free-tier keys are spent, so
    // marks come from the fallbacks, and the DexScreener fallback keeps returning a junk $0.03
    // market cap. Every time it does, the guard flags the position and the fast check went blind
    // until the next 30s poll happened to resolve it.
    //
    // Fraggle, measured: entry MC $233,588 → peak $284,711 (+21.9%) at 18:53:23, junk 0.03 mark
    // at 18:54:56 flags it, next real mark $192,688 at 18:55:23 — a TWO MINUTE hole with no
    // trail-stop evaluation at all, during which it fell 32% from peak. The 4% early-window stop
    // should have exited near $273,322 (about +17%); it exited at -18.82% instead.
    //
    // A pending position is still evaluated here, but read-only: the fresh mark is used to decide
    // whether the stop is breached and is NOT written back to currentMcUsd/peakMcUsd, so the slow
    // poll's state machine keeps sole ownership of what counts as trusted. Sanity is still
    // enforced the same way for both cases — a mark that disagrees with the last TRUSTED value by
    // more than MC_ANOMALY_RATIO is ignored, which is exactly what makes the junk 0.03 harmless
    // here rather than a false exit trigger.
    const open = Object.values(s.positions);
    if (!open.length) return;
    const fastSolUsd = await solPriceForMark();
    await mapLimit(open, 12, async (pos) => {
      const mark = await markPosition(pos, fastSolUsd);
      const mc = mark?.mcUsd;
      if (mc == null) return; // transient read failure — never fabricate a price
      const ratio = pos.currentMcUsd > 0 ? mc / pos.currentMcUsd : 1;
      if (ratio > MC_ANOMALY_RATIO || ratio < 1 / MC_ANOMALY_RATIO) return; // let the slow poll's anomaly guard own suspicious jumps, don't duplicate that state machine here
      const anomalyPending = pos.pendingMcUsd != null;
      // Peak is a high-water mark, so it can only ever rise; taking it from a mark that already
      // passed the sanity check above is safe even while a confirmation is pending, and refusing
      // to would let a real new high go unrecorded and loosen the stop.
      const peak = Math.max(pos.peakMcUsd, mc);
      if (!anomalyPending) { pos.currentMcUsd = mc; pos.peakMcUsd = peak; }
      const heldSec = (Date.now() - pos.openedAt) / 1000;
      const trailStopPct = effectiveTrailStopPct(pos.entryMcUsd, peak, heldSec);
      const drawdownFromPeakPct = ((mc - peak) / peak) * 100;
      if (drawdownFromPeakPct <= -trailStopPct) {
        if (anomalyPending) {
          // Worth its own row: this is an exit the old code would have missed entirely.
          logRecord("events", {
            type: "strategy2-fast-exit-while-pending", mint: pos.mint, sym: pos.sym,
            markMcUsd: Math.round(mc), peakMcUsd: Math.round(peak), pendingMcUsd: pos.pendingMcUsd,
            drawdownFromPeakPct: Number(drawdownFromPeakPct.toFixed(2)), trailStopPct,
            heldSec: Math.round(heldSec), strategy2Epoch: config.strategy2Epoch, cfg: configHash,
          });
        }
        await closePosition(s, pos, "TRAIL_STOP");
      }
    });
    saveState(s);
  } finally {
    pollRunning = false;
  }
}

function main(): void {
  if (!config.strategy2Paper.enabled) { console.log("[strategy2-paper] disabled (STRATEGY2_PAPER=false)"); return; }
  // Runs once, before any poll, so a blackout is settled before new marks can make a stranded
  // position look like a normal trade going wrong.
  //
  // It takes `pollRunning` for the whole reconciliation. The first version did not, and the bug
  // it caused is worth recording: the close was correctly computed and logged (DOWNTIME_GAP,
  // gapSec=72003) but then VANISHED — the poll interval started immediately alongside it, loaded
  // the pre-close state, and saved that back over the reconciled one. The event log said the
  // position was closed while the state file still held it open. `pollRunning` is the same guard
  // poll() and fastTrailStopCheck() already share for exactly this reason.
  //
  // Failure must never stop the trader from starting — a missed reconciliation is a measurement
  // problem, an unstarted trader is worse — but the flag has to be released either way.
  pollRunning = true;
  void (async () => {
    try {
      const s = loadState();
      await reconcileDowntime(s);
      s.lastHeartbeatAt = Date.now();
      saveState(s);
    } catch (e) {
      ui.warn(`[strategy2-paper] downtime reconciliation failed (continuing): ${(e as Error).message}`);
    } finally {
      pollRunning = false;
    }
  })();
  // Report the metered budget at startup and hourly. The free plan is small and its exhaustion is
  // invisible from the outside — it just turns into 403s that look like missing data, which is
  // exactly how the previous two keys went unnoticed for weeks.
  if (solanaTrackerEnabled()) {
    const report = () => void stCredits().then((c) => {
      if (c == null) ui.warn("[strategy2-paper] Solana Tracker credits unreadable");
      else if (c <= 0) ui.reject(`[strategy2-paper] Solana Tracker credits EXHAUSTED (${c}) — entry enrichment is off until the key resets`);
      else if (c < 250) ui.warn(`[strategy2-paper] Solana Tracker credits low: ${c}`);
      else ui.info(`[strategy2-paper] Solana Tracker credits: ${c}`);
    });
    report();
    setInterval(report, 3_600_000).unref();
  }
  console.log(`[strategy2-paper] trailing stop ${config.strategy2Paper.trailStopPct}% (${EARLY_TRAIL_STOP_PCT}% for the first ${EARLY_WINDOW_SEC / 60}min), max hold ${config.strategy2Paper.maxHoldHours}h, full poll every ${config.strategy2Paper.pollMs / 60_000}min + fast trail-stop check (ALL open positions) every ${FAST_CHECK_MS / 1000}s (up to 12 positions checked concurrently). Real GMGN quotes for entry/exit value — read-only, never signs or submits.`);
  void pollGuarded();
  const timer = setInterval(() => void pollGuarded(), config.strategy2Paper.pollMs);
  const fastTimer = setInterval(() => void fastTrailStopCheck(), FAST_CHECK_MS);
  const shutdown = () => { clearInterval(timer); clearInterval(fastTimer); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
