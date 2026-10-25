/**
 * GMGN FULL WATCH — pemantauan GMGN berprioritas: satu proses, read-only, zero capital.
 *
 * Owner (2026-10-07): "pantau analisa gmgn lengkap ... biar tau gimana cara profit maksimal".
 * Dua pelajaran LIVE yang membentuk desain ini (jangan diubah tanpa membacanya):
 *  1. Limit GMGN keras & mengeskalasi — 14 call dalam 45 detik memicu RATE_LIMIT_BANNED, dan
 *     teks server sendiri: "repeated requests can extend the ban by 5s up to 5 minutes".
 *     Pace terbukti aman: satu call per ~10 detik, tanpa burst. Karena itu SEMUA call di sini
 *     lewat `pace()` — tidak ada dua call berdekatan, sekalipun job-nya beda prioritas.
 *  2. Data historis cacat dua kali: kandidat terotasi (retensi stream `events` = 7 hari) dan
 *     mark horizon ditulis telat (84% baris 6/24/48h historis sebenarnya satu snapshot).
 *     Karena itu state yang bernilai jangka-panjang (kualitas wallet, dedupe sinyal) disimpan
 *     di state file SENDIRI yang tidak ikut terotasi, dan baris outcome kini membawa ageHours
 *     aktual (lihat strategy2-outcome-tracker.ts).
 *
 * Prioritas per siklus (default tiap 15 menit; tiap prioritas punya jatah call sendiri):
 *   P1 posisi terbuka  → token info (tag wallet: smart/renowned/sniper/bundler/rat) +
 *                        top holder smart_degen (conviction: masih pegang? unrealized pnl?)
 *   P2 kandidat baru   → info + security (top-10 holder rate, LP burn, tax) utk kandidat yang
 *                        belum pernah diperkaya — lane GMGN dulu, lalu dev-holding yang lolos
 *   P3 sinyal          → token_signal type 12 (smart-money buy) & 20 (KOL buy) — feed event
 *   P4 kualitas wallet → feed KOL/smart-money: trade yang menyentuh mint kita + skor wallet
 *                        maker (winrate/realized pnl) — disimpan permanen di state
 *
 * Run: npm run gmgn:full-watch   (wajib: gmgn-proxy jalan. GMGN_FULL_WATCH_ONCE=true = 1 siklus)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import {
  gmgnEnabled, gmgnTokenInfo, gmgnTokenSecurity, gmgnTopHolders, gmgnReadResult,
  gmgnKol, gmgnSmartMoney, gmgnWalletStats, SIGNAL_TYPES, type GmgnActivityRow, type GmgnSignalRow,
} from "./gmgn.js";
import { acquireObservationLock, appendObservation, observeSignal, readObservationJournal, writeObservationHealth,
  type ObservationJournal } from "./gmgn-signal-observations.js";

const SPACING_MS = num(process.env.GMGN_FULL_WATCH_SPACING_MS, 10_000, 10_000);
const CYCLE_MS = num(process.env.GMGN_FULL_WATCH_CYCLE_MS, 15 * 60_000, 60_000);
const POS_MAX = num(process.env.GMGN_FULL_WATCH_POS_MAX, 4, 1);
const CAND_MAX = num(process.env.GMGN_FULL_WATCH_CAND_MAX, 6, 1);
const WALLET_MAX = num(process.env.GMGN_FULL_WATCH_WALLET_MAX, 6, 1);
const ONCE = process.env.GMGN_FULL_WATCH_ONCE === "true";
const CAND_WINDOW_MS = 6 * 3_600_000;
const WALLET_RESCORE_MS = 7 * 24 * 3_600_000;
const STATE_PATH = join(config.logDir, "gmgn-full-watch-state.json");
const SIGNAL_CHAINS = [...new Set((process.env.GMGN_FULL_WATCH_CHAINS ?? "sol,robinhood").split(",").map((c) => c.trim()).filter(Boolean))];
if (!SIGNAL_CHAINS.length || SIGNAL_CHAINS.some((c) => !["sol", "bsc", "robinhood"].includes(c))) throw new Error("GMGN_FULL_WATCH_CHAINS must contain sol, bsc, and/or robinhood");

function num(v: string | undefined, def: number, min: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : def;
}

interface WalletQuality { at: number; tags: string[]; winrate: number | null; realizedProfit: number | null; tokens: number | null; buys: number | null; sells: number | null }
interface State {
  enriched: Record<string, number>; // mint -> ts terakhir diperkaya
  walletQuality: Record<string, WalletQuality>;
  seenSignals: Record<string, number>; // key sinyal -> ts
  updatedAt?: number;
}

function loadState(): State {
  if (existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<State>;
      return { enriched: s.enriched ?? {}, walletQuality: s.walletQuality ?? {}, seenSignals: s.seenSignals ?? {} };
    } catch (e) { throw new Error(`gmgn-full-watch state invalid; preserved, not reset: ${(e as Error).message}`); }
  }
  return { enriched: {}, walletQuality: {}, seenSignals: {} };
}
function saveState(s: State): void {
  // Prune: enriched 48 jam (cukup lama utk "jangan diperkaya dua kali"), seenSignals 24 jam.
  const now = Date.now();
  for (const [k, t] of Object.entries(s.enriched)) if (now - t > 48 * 3_600_000) delete s.enriched[k];
  for (const [k, t] of Object.entries(s.seenSignals)) if (now - t > 24 * 3_600_000) delete s.seenSignals[k];
  const wq = Object.entries(s.walletQuality);
  if (wq.length > 20_000) for (const [k] of wq.sort((a, b) => a[1].at - b[1].at).slice(0, wq.length - 20_000)) delete s.walletQuality[k];
  s.updatedAt = now;
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(s)); renameSync(tmp, STATE_PATH);
}

// ── PACE: satu-satunya gerbang waktu. Tidak ada call GMGN yang boleh melewatinya. ──
let lastCallAt = 0;
let callsThisCycle = 0;
async function pace(): Promise<void> {
  const wait = lastCallAt + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
  callsThisCycle++;
}

/** P1: mint dari posisi terbuka (sniper + paper trader) — sumber paling berharga. */
function openPositionMints(): Array<{ mint: string; sym: string }> {
  const out = new Map<string, string>();
  try {
    const sniper = JSON.parse(readFileSync(join(config.logDir, "positions.json"), "utf8")) as { positions?: Array<{ candidate?: { mint?: string; symbol?: string } }> };
    for (const p of sniper.positions ?? []) if (p.candidate?.mint) out.set(p.candidate.mint, p.candidate.symbol ?? "?");
  } catch { /* belum ada */ }
  try {
    const s2 = JSON.parse(readFileSync(join(config.logDir, "strategy2-paper-state.json"), "utf8")) as { positions?: unknown };
    const ps = s2.positions ?? {};
    const arr = (Array.isArray(ps) ? ps : Object.values(ps as Record<string, unknown>)) as Array<Record<string, unknown>>;
    for (const p of arr) {
      const cand = p?.["candidate"] as Record<string, unknown> | undefined;
      const mint = String(p?.["mint"] ?? cand?.["mint"] ?? "");
      if (mint) out.set(mint, String(p?.["symbol"] ?? cand?.["symbol"] ?? "?"));
    }
  } catch { /* belum ada */ }
  return [...out.entries()].map(([mint, sym]) => ({ mint, sym }));
}

/** P2: kandidat segar (≤6 jam) dari stream events — lane GMGN dulu, lalu dev-holding lolos. */
function recentCandidates(s: State): Array<{ mint: string; sym: string; lane: string; mcUsd: number }> {
  const files = (() => {
    try { return readdirSync(config.logDir).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort().slice(-2); } catch { return []; }
  })();
  const now = Date.now();
  const rows: Array<{ mint: string; sym: string; lane: string; mcUsd: number; rank: number }> = [];
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(config.logDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"strategy2-candidate"')) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const mint = String(r["mint"] ?? "");
      const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
      if (!mint || now - firstSeenAt > CAND_WINDOW_MS || s.enriched[mint]) continue;
      const lane = String(r["source"] ?? "?");
      const gmgnLane = lane === "gmgn-trending" || lane === "gmgn-trenches";
      const devHoldPass = lane === "new-launch-dev-holding" && r["passesDevHoldFloor"] === true;
      if (!gmgnLane && !devHoldPass) continue;
      rows.push({ mint, sym: String(r["sym"] ?? "?"), lane, mcUsd: Number(r["mcUsd"] ?? 0), rank: gmgnLane ? 0 : 1 });
    }
  }
  return rows.sort((a, b) => a.rank - b.rank || b.mcUsd - a.mcUsd).slice(0, CAND_MAX).map(({ mint, sym, lane, mcUsd }) => ({ mint, sym, lane, mcUsd }));
}

interface Counts { positions: number; candidates: number; signals: number; watchedTrades: number; walletsScored: number; walletAttempts: number }

async function jobPosition(mint: string, sym: string): Promise<void> {
  await pace();
  const info = await gmgnTokenInfo("sol", mint);
  await pace();
  const holders = await gmgnTopHolders("sol", mint, "smart_degen", "profit", 20);
  const tags = info?.wallet_tags_stat;
  const held = (holders ?? []).filter((h) => (h.amount_percentage ?? 0) > 0);
  const withPnl = held.filter((h) => h.unrealized_pnl != null);
  logRecord("events", {
    type: "gmgn-full-position", chain: "sol", mint, sym,
    infoAvailable: info != null, holdersAvailable: holders != null,
    holderCount: info?.holder_count ?? null, athPrice: info?.ath_price ?? null, price: info?.price?.price ?? null,
    smartWallets: tags?.smart_wallets ?? null, renownedWallets: tags?.renowned_wallets ?? null,
    sniperWallets: tags?.sniper_wallets ?? null, bundlerWallets: tags?.bundler_wallets ?? null, ratWallets: tags?.rat_trader_wallets ?? null,
    devCreatorStatus: info?.dev?.creator_token_status ?? null, devOpenCount: info?.dev?.creator_open_count ?? null,
    smartDegenSampled: holders?.length ?? 0, stillHolding: held.length, exited: (holders?.length ?? 0) - held.length,
    avgUnrealizedPnl: withPnl.length ? Number((withPnl.reduce((a, h) => a + (h.unrealized_pnl ?? 0), 0) / withPnl.length).toFixed(3)) : null,
    strategy2Epoch: config.strategy2Epoch, cfg: configHash,
  });
}

async function jobCandidate(c: { mint: string; sym: string; lane: string; mcUsd: number }): Promise<boolean> {
  await pace();
  const info = await gmgnTokenInfo("sol", c.mint);
  await pace();
  const sec = await gmgnTokenSecurity("sol", c.mint);
  const tags = info?.wallet_tags_stat;
  logRecord("events", {
    type: "gmgn-full-candidate", chain: "sol", mint: c.mint, sym: c.sym, lane: c.lane, entryMcUsd: c.mcUsd,
    infoAvailable: info != null, securityAvailable: sec != null,
    holderCount: info?.holder_count ?? null,
    top10HolderRate: sec?.top_10_holder_rate ?? null, burnStatus: sec?.burn_status ?? null,
    isHoneypot: sec?.is_honeypot ?? null, buyTax: sec?.buy_tax ?? null, sellTax: sec?.sell_tax ?? null,
    smartWallets: tags?.smart_wallets ?? null, renownedWallets: tags?.renowned_wallets ?? null,
    sniperWallets: tags?.sniper_wallets ?? null, bundlerWallets: tags?.bundler_wallets ?? null,
    topBundlerPct: info?.stat?.top_bundler_trader_percentage ?? null, topRatPct: info?.stat?.top_rat_trader_percentage ?? null,
    strategy2Epoch: config.strategy2Epoch, cfg: configHash,
  });
  return info != null && sec != null;
}

function watchedMints(candidates: Array<{ mint: string }>, journal: ObservationJournal): Set<string> {
  const set = new Set<string>();
  for (const p of openPositionMints()) set.add(p.mint);
  for (const c of candidates) set.add(c.mint);
  // Signals are measurement subjects, not trader candidates. No Solana scout is needed.
  for (const s of journal.signals) if (s.chain === "sol" && Date.now() - s.observedAt <= CAND_WINDOW_MS) set.add(s.mint);
  return set;
}

async function jobSignals(s: State, journal: ObservationJournal, chain: string): Promise<{ added: number; received: number; error: string | null; possiblyTruncated: boolean }> {
  await pace();
  const requestStartedAt = Date.now();
  const result = await gmgnReadResult<unknown>("getTokenSignalV2", [chain, [
    { signal_type: [SIGNAL_TYPES.SMART_MONEY_BUY], mc_min: 10_000 }, { signal_type: [SIGNAL_TYPES.KOL_BUY], mc_min: 10_000 },
  ]]);
  const observedAt = Date.now();
  if (!result.ok) return { added: 0, received: 0, error: result.error, possiblyTruncated: false };
  if (!Array.isArray(result.data)) return { added: 0, received: 0, error: "SIGNAL_RESPONSE_SHAPE", possiblyTruncated: false };
  const rows = result.data as GmgnSignalRow[];
  const seen = new Set(journal.signals.map((r) => r.signalId));
  let added = 0;
  for (const r of rows) {
    const observation = observeSignal(chain, r, observedAt, requestStartedAt);
    if (!observation || seen.has(observation.signalId)) continue;
    appendObservation(observation); // Durability BEFORE optional rotating diagnostic logs/state.
    journal.signals.push(observation); seen.add(observation.signalId);
    s.seenSignals[observation.signalId] = observedAt;
    added++;
    logRecord("events", {
      type: "gmgn-signal", chain, mint: observation.mint, signalType: r.signal_type,
      signalId: observation.signalId, upstreamId: observation.upstreamId, policyId: observation.policy.id,
      observedAt, requestStartedAt, triggerAt: observation.triggerAt, triggerAtRaw: observation.triggerAtRaw,
      observationDelayMs: observation.observationDelayMs, signalTimes: observation.signalTimes,
      sym: r.data?.symbol ?? "?", mcUsd: r.market_cap ?? null, triggerMc: r.trigger_mc ?? null, ath: r.ath ?? null,
      holders: r.data?.holder_count ?? null, rugRatio: r.data?.rug_ratio ?? null, launchpad: r.data?.launchpad_platform ?? null,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
  }
  return { added, received: rows.length, error: null, possiblyTruncated: [12, 20].some((t) => rows.filter((r) => r.signal_type === t).length >= 50) };
}

async function jobFeeds(s: State, watched: Set<string>, walletQueue: Array<{ w: string; tags: string[] }>): Promise<number> {
  await pace();
  const kol = await gmgnKol("sol", 50);
  await pace();
  const sm = await gmgnSmartMoney("sol", 50);
  let matched = 0;
  const handle = (rows: GmgnActivityRow[] | null, label: "kol" | "smartmoney"): void => {
    for (const r of rows ?? []) {
      if (r.maker && r.side === "buy") walletQueue.push({ w: r.maker, tags: r.maker_info?.tags ?? [] });
      if (!watched.has(r.base_address)) continue;
      matched++;
      logRecord("events", {
        type: "gmgn-watched-trade", chain: "sol", watchType: label, mint: r.base_address, symbol: r.base_token?.symbol ?? null,
        tradeAt: typeof r.timestamp === "number" ? r.timestamp * 1000 : null,
        side: r.side, maker: r.maker, amountUsd: r.amount_usd ?? null, priceUsd: r.price_usd ?? null,
        twitterUsername: r.maker_info?.twitter_username || null, tags: r.maker_info?.tags ?? null, txHash: r.transaction_hash,
        strategy2Epoch: config.strategy2Epoch, cfg: configHash,
      });
    }
  };
  handle(kol, "kol");
  handle(sm, "smartmoney");
  return matched;
}

async function jobWallets(s: State, queue: Array<{ w: string; tags: string[] }>, counts: Counts): Promise<void> {
  const seen = new Set<string>();
  for (const { w, tags } of queue) {
    if (counts.walletAttempts >= WALLET_MAX) break;
    if (seen.has(w)) continue;
    seen.add(w);
    const prev = s.walletQuality[w];
    if (prev && Date.now() - prev.at < WALLET_RESCORE_MS) continue;
    await pace();
    counts.walletAttempts++;
    const st = await gmgnWalletStats("sol", [w], "7d");
    if (!st) continue;
    const q: WalletQuality = {
      at: Date.now(), tags,
      winrate: typeof st.pnl_stat?.winrate === "number" ? Number(st.pnl_stat.winrate.toFixed(4)) : null,
      realizedProfit: st.realized_profit != null && Number.isFinite(Number(st.realized_profit)) ? Number(Number(st.realized_profit).toFixed(2)) : null,
      tokens: st.pnl_stat?.token_num ?? null, buys: st.buy ?? null, sells: st.sell ?? null,
    };
    s.walletQuality[w] = q;
    counts.walletsScored++;
    logRecord("events", {
      type: "gmgn-wallet-quality", chain: "sol", wallet: w, tags, scoredAt: q.at, period: "7d",
      winrate: q.winrate, realizedProfit: q.realizedProfit, tokens: q.tokens, buys: q.buys, sells: q.sells,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
  }
}

let running = false;
async function cycle(): Promise<void> {
  if (running) { ui.warn("[gmgn-full-watch] siklus sebelumnya belum selesai — lewati tick ini"); return; }
  running = true;
  callsThisCycle = 0;
  const counts: Counts = { positions: 0, candidates: 0, signals: 0, watchedTrades: 0, walletsScored: 0, walletAttempts: 0 };
  const t0 = Date.now();
  try {
    const s = loadState();
    const journal = readObservationJournal();
    const polls: Record<string, unknown> = {};
    // Observe signals first; entry marks are timed from reception, never retroactively from trigger.
    for (const chain of SIGNAL_CHAINS) {
      const poll = await jobSignals(s, journal, chain);
      polls[chain] = poll; counts.signals += poll.added;
    }
    const positions = openPositionMints().slice(0, POS_MAX);
    const candidates = recentCandidates(s);
    const watched = watchedMints(candidates, journal);
    const walletQueue: Array<{ w: string; tags: string[] }> = [];

    for (const p of positions) {
      await jobPosition(p.mint, p.sym);
      counts.positions++;
    }
    for (const c of candidates) {
      const available = await jobCandidate(c);
      if (available) s.enriched[c.mint] = Date.now();
      counts.candidates++;
    }
    counts.watchedTrades = await jobFeeds(s, watched, walletQueue);
    await jobWallets(s, walletQueue, counts);
    saveState(s);
    writeObservationHealth("collector", { status: "RUNNING", cycleMs: CYCLE_MS, signalChains: SIGNAL_CHAINS, polls, ...counts, completedAt: Date.now() });
    logRecord("events", {
      type: "gmgn-full-cycle", calls: callsThisCycle, ms: Date.now() - t0,
      positions: counts.positions, candidates: counts.candidates, signals: counts.signals,
      watchedTrades: counts.watchedTrades, walletsScored: counts.walletsScored, walletAttempts: counts.walletAttempts,
      positionMints: positions.map((p) => p.mint), candidateMints: candidates.map((c) => c.mint), signalChains: SIGNAL_CHAINS, signalPolls: polls,
      strategy2Epoch: config.strategy2Epoch, cfg: configHash,
    });
    ui.info(`[gmgn-full-watch] siklus: ${callsThisCycle} call ${((Date.now() - t0) / 1000).toFixed(0)}s — posisi ${counts.positions}, kandidat ${counts.candidates}, sinyal ${counts.signals}, trade-terpantau ${counts.watchedTrades}, wallet ${counts.walletsScored}`);
  } catch (e) {
    writeObservationHealth("collector", { status: "ERROR", error: (e as Error).message, cycleMs: CYCLE_MS });
    ui.warn(`[gmgn-full-watch] siklus gagal: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  if (!gmgnEnabled) { console.log("[gmgn-full-watch] GMGN_API_KEY tidak ada — keluar."); return; }
  const release = acquireObservationLock("collector");
  process.on("exit", release);
  console.log(`[gmgn-full-watch] pace ${SPACING_MS / 1000}s/call, siklus tiap ${CYCLE_MS / 60_000}min. Batas/siklus: posisi ${POS_MAX}, kandidat ${CAND_MAX}, wallet ${WALLET_MAX}. Read-only, zero capital.`);
  console.log(`[gmgn-full-watch] state: ${STATE_PATH}. Signal chains: ${SIGNAL_CHAINS.join(",")}; durable observations, NOT trader candidates.`);
  await cycle();
  if (ONCE) { release(); return; }
  const timer = setInterval(() => void cycle(), CYCLE_MS);
  const shutdown = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((e) => { console.error(`[gmgn-full-watch] stopped: ${(e as Error).message}`); process.exitCode = 1; });
