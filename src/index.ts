import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, configHash } from "./config.js";
import { rpcStats, rpcEndpointHealth, waitForMintVisible } from "./safety/onchain.js";
import { listenNewTokens } from "./discovery/pumpportal.js";
import { MomentumWatch } from "./discovery/momentum.js";
import { BitqueryStream } from "./discovery/bitquery.js";
import { LaunchObservatory } from "./discovery/launch-observatory.js";
import { runGate, runSetupGate, markBadDeployer, shouldBlacklist } from "./gate.js";
import { PaperTrader } from "./papertrader.js";
import type { OpenResult } from "./papertrader.js";
import { readControl } from "./control.js";
import { flushActorMemory } from "./memory/actor-memory.js";
import { notify, notifySync, notifyEnabled } from "./util/notify.js";
import { noteLaunchTheme, hotThemes } from "./discovery/narrative.js";
import { logRecord, ui } from "./util/log.js";
import { mintId } from "./util/ids.js";
import type { Candidate, Decision } from "./types.js";
import { ArmCoordinator } from "./experiments/arm-coordinator.js";

const trader = new PaperTrader();
// Separate virtual-capital experiment. It never changes PaperTrader admission/exit and never
// signs or sends a transaction; it only consumes the same decision-time candidate/gate snapshot.
const armCoordinator = new ArmCoordinator();
let processed = 0;
let passed = 0;
let launchFiltered = 0; // dropped at the create event by the launch-MC floor (never cost an RPC)
let lastLaunchAt = Date.now(); // watchdog: when the launch feed last delivered anything

/**
 * Fast-follow (snipe) settle delay before gating. Lower = more aggressive /
 * earlier / smaller MC, but thinner safety data + more insider-dump risk.
 * Configurable via SNIPE_SETTLE_MS (default 8s). Minimum ~2s so the mint
 * account exists on-chain for the gate to read.
 */
const FAST_FOLLOW_SETTLE_MS = Math.max(800, Number(process.env.SNIPE_SETTLE_MS ?? 1_500));
/** Ceiling for the adaptive settle — past this we proceed anyway and let the buy sim decide. */
const FAST_FOLLOW_MAX_SETTLE_MS = Math.max(FAST_FOLLOW_SETTLE_MS, Number(process.env.SNIPE_MAX_SETTLE_MS ?? 8_000)); // snipe: minimal settle so the curve account exists, then enter — NO momentum wait (owner #3: entry <5s)

async function handleCandidate(c: Candidate): Promise<void> {
  processed++;
  // LATENCY INSTRUMENTATION (owner: measure where detect→open goes, don't guess): preMs = time from
  // detect until a worker STARTS gating (= settle + queue wait); gateMs = gate; openMs = open work.
  const _tStart = Date.now();
  const _preMs = c.detectedAt ? _tStart - c.detectedAt : 0;
  // SETUP-SNIPER: fast deadline-bounded gate (parallel enrichment). Legacy full gate only for
  // the momentum shadow. The setup classifier in open() makes the TOXIC/CLEAN/UNKNOWN call.
  const gate = c.mode === "fast-follow" && config.entryMode === "setup"
    ? await runSetupGate(c)
    : await runGate(c);
  const _gateMs = Date.now() - _tStart;
  // GATE TIMING FOR EVERY CANDIDATE (2026-07-31), not just the ones that open. `latency-breakdown`
  // below only fires on a successful PAPER_BUY — 24 rows in the project's entire history — which
  // is far too sparse to tell whether a latency change worked. Gate time is measured on every
  // candidate anyway, so logging it here turns "wait days for enough entries" into "read the
  // distribution in minutes". This is the metric that matters: measured against 378 live
  // launches, entering 60s late instead of at launch cuts the odds of a +43% move from 16.1% to
  // 2.8%, and a single over-long gate blocks one of only `maxConcurrentGate` workers.
  logRecord("events", { type: "gate-timing", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol,
    mode: c.mode, preMs: _preMs, gateMs: _gateMs, verdict: gate.verdict, cfg: configHash });
  const label = `${c.symbol ?? "?"} (${c.mint.slice(0, 8)}…) [${c.mode}]`;
  try { armCoordinator.observe(c, gate); } catch (err) {
    ui.warn(`[arms] admission planning failed for ${c.mint}: ${(err as Error).message}`);
    logRecord("events", { type: "arm-admission-error", decisionId: c.decisionId ?? null, mint: c.mint, error: (err as Error).message, cfg: configHash });
  }

  const reasons = gate.checks.map((k) => `${k.passed ? "✓" : "✗"} ${k.name}: ${k.detail}`);
  let action: Decision["action"] = "SKIP";
  let openResult: OpenResult | undefined;

  if (gate.verdict === "REJECT") {
    const failed = gate.checks.filter((k) => k.hard && !k.passed).map((k) => k.name);
    ui.reject(`REJECT ${label} — ${failed.join(", ")}`);
    // Only ban the creator on evidence about the CREATOR — not on this coin's price or on thin
    // first-seconds holder data. The old rule banned on everything except two RPC-error names.
    if (shouldBlacklist(failed)) markBadDeployer(c.creator);
  } else {
    passed++;
    ui.pass(`PASS   ${label} — score ${gate.score}`);
    for (const r of reasons) ui.info(`         ${r}`);
    // SETUP-SNIPER: the entry decision is the SETUP classifier (in open()), NOT the legacy
    // demand/momentum score. So in setup mode we SKIP the score≥min gate (audit fix: the runtime
    // was hybrid — setup then legacy score). Momentum mode still uses the score gate.
    const setupMode = c.mode === "fast-follow" && config.entryMode === "setup";
    if (readControl().paused) {
      ui.warn(`         scanner PAUSED (from console) — not opening position`);
    } else if (!setupMode && gate.score < config.risk.minScoreToOpen) {
      ui.warn(`         score ${gate.score} < ${config.risk.minScoreToOpen} min — passed gate but too weak to buy`);
    } else if (trader.canOpen()) {
      const _tOpen = Date.now();
      openResult = await trader.open(c, gate.score);
      if (openResult.opened) {
        action = "PAPER_BUY";
        logRecord("events", { type: "latency-breakdown", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol,
          preMs: _preMs, gateMs: _gateMs, openMs: Date.now() - _tOpen, totalMs: c.detectedAt ? Date.now() - c.detectedAt : undefined, cfg: configHash });
      } else reasons.push(`open:${openResult.code}${openResult.detail ? `:${openResult.detail}` : ""}`);
    } else {
      ui.warn(`         insufficient free capital — waiting for a position to close`);
    }
  }

  const decision: Decision = { candidate: c, gate, action, reasons, openResult, at: Date.now() };
  logRecord("decisions", { ...decision, decisionId: c.decisionId ?? null, measurementEpoch: config.measurementEpoch, cfg: configHash } as Decision); // config hash so decisions isolate per experiment (#5)
}

function main(): void {
  console.log(`Shitcoin dry-run MVP — mode: ${config.mode} | DRY_RUN=${config.dryRun} (no wallet, no transactions)`);
  if (config.usingPublicRpc) {
    ui.warn("No HELIUS_API_KEY/RPC_URL set — using public mainnet RPC (heavily rate-limited). Register a free Helius key per RESEARCH.md §7.");
  }
  if (!config.rugcheckApiKey) {
    ui.warn("No RUGCHECK_API_KEY set — RugCheck enrichment limited to ~10 req/min unauthenticated.");
  }

  const stops: Array<() => void> = [];
  const queue: Candidate[] = [];
  let activeWorkers = 0;

  // BOUNDED-CONCURRENCY drain (owner #3: entry <5s). Launches burst; a fully-serial drain made
  // candidate #5 wait for #1-4's whole gate+open. The gate/open are I/O-bound (RPC awaits), so we
  // run up to maxConcurrentGate candidates through gate+entry at once. Each worker pulls the next
  // queued candidate until the queue drains, then retires. Bounded so we never blow the RPC budget.
  const worker = async () => {
    activeWorkers++;
    try {
      while (queue.length) {
        const c = queue.shift()!;
        try { await handleCandidate(c); }
        catch (err) { ui.warn(`pipeline error for ${c.mint}: ${(err as Error).message}`); }
      }
    } finally { activeWorkers--; }
  };
  const drain = () => {
    // spin up workers until we hit the concurrency cap or run out of queued work. Each spawned
    // worker synchronously shifts one item before its first await, so the queue drains as we loop
    // → we never spawn more workers than there is work, and never exceed the cap.
    while (activeWorkers < config.exec.maxConcurrentGate && queue.length > 0) void worker();
  };

  // SNIPER PARADIGM (owner spec): a launch is NOT watched for momentum then bought later
  // (that's futures/indicator thinking + structurally overpays on the bonding curve). Momentum
  // is NO LONGER an entry gate — it's telemetry. The momentum watch still runs (for post-hoc
  // data / the shadow comparison) but its "confirm" callback ONLY logs; it does NOT enter.
  const momentum = new MomentumWatch((c, m) => {
    logRecord("events", { type: "momentum-telemetry", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol, grownPct: m.grownPct, accel: m.accel, velSol: m.velSol, ageSec: m.ageSec });
  });
  // Bitquery multi-launchpad stream still routes confirmed tape straight to gate+entry.
  // FIRST ACCEPTANCE for the bitquery lane — same rule as `enqueue()` above: mint decisionId
  // before this candidate touches the queue or the gate. This lane bypasses the observatory and
  // the launch-MC floor (existing behaviour, unchanged here) but still needs its own identity.
  const bitquery = new BitqueryStream((c) => { c.decisionId ??= mintId("d"); queue.push(c); void drain(); });
  // COUNTERFACTUAL observatory: follows EVERY launch (entered or not) for the shadow dataset.
  const observatory = new LaunchObservatory();

  const enqueue = (c: Candidate) => {
    // FIRST ACCEPTANCE — mint decisionId here, before the launch-MC floor, the queue, or the
    // gate see this candidate. Every function below holds this SAME object reference, so one
    // assignment here is what carries the id through the observatory, the gate, open(), the
    // Position, and every log record for the rest of this candidate's life.
    c.decisionId ??= mintId("d");
    lastLaunchAt = Date.now(); // watchdog heartbeat — proof the launch feed is genuinely alive
    ui.event(`candidate: ${c.symbol ?? c.mint.slice(0, 8)} via ${c.source} (${c.mode})`);
    observatory.observe(c); // track ALL launches for the counterfactual dataset (BEFORE any filter)
    // Narrative crowding — measured for EVERY launch (including ones we skip), so the baseline is
    // not conditioned on our own filters. Pure in-memory; no RPC.
    const th = noteLaunchTheme(c.name, c.symbol);
    c.themeCrowd = th.crowd; c.themeWord = th.theme ?? undefined;

    // ── LAUNCH-TIME MC FLOOR — the cheapest filter we have ──
    // Runs on the create event itself: no RPC, no queue slot, no settle wait. Launch MC above
    // the 27.96 base is purely the dev's own buy, so this rejects creators who put in nothing.
    // It also protects throughput: every launch dropped here is RPC budget handed to a better
    // candidate, which is the same resource that caused the entry backlog.
    const floor = config.gate.launchMcFloorSol;
    // FAIL CLOSED on a missing MC. `marketCapSol != null && ... < floor` let a null through the
    // filter entirely — the same fail-open shape as the holder-gate P0 (papertrader.ts), on the
    // gate that guards the measured poison zone (at/below the 27.96 launch base: 0 wins in 48
    // trades). Measured 0 nulls in 22,743 decisions, so this is latent today, not active — but
    // an unpriced launch is exactly the case we cannot verify and must not buy.
    if (floor > 0 && c.marketCapSol == null) {
      launchFiltered++;
      logRecord("events", { type: "launch-mc-skip", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol,
        marketCapSol: null, devInitialBuySol: c.devInitialBuySol ?? null, floor, reason: "mc-unavailable", cfg: configHash });
      return;
    }
    if (floor > 0 && c.marketCapSol != null && c.marketCapSol < floor) {
      launchFiltered++;
      logRecord("events", { type: "launch-mc-skip", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol,
        marketCapSol: Number(c.marketCapSol.toFixed(2)), devInitialBuySol: c.devInitialBuySol ?? null, floor, cfg: configHash });
      return;
    }

    if (c.mode === "fast-follow" && config.entryMode === "momentum" && config.checkpoint.enabled) {
      momentum.add(c); // legacy path (only if explicitly configured — for the shadow test)
      return;
    }
    // ── BUNDLE PREFETCH: TRIED AND REVERTED (kept as a warning) ──
    // `bundleSlotMax` cross-validates as our BEST entry signal, but the probe needs 3.3-4.2s while
    // the gate waits 2.5s, so it was present on 0% of OPEN records. Starting it here at detection
    // did lift coverage 0% → 33% — and blew entry latency from 3.1s to 11.8s. The breakdown showed
    // the cost was NOT in the gate (pre 1.5s / gate 2.5s unchanged) but in open(), which jumped
    // 0.8s → 7.8s: one extra hot-lane RPC per launch starves the entry reads on a free 8 req/s
    // tier. Late entry is worse than a missing signal, so this stays reverted.
    // To actually get this signal at entry we need a paid/low-latency RPC — not a code change.

    // SETUP-SNIPER (default): go STRAIGHT to the gate+entry after a minimal settle so the
    // curve account exists. The gate is the SETUP filter (structural safety + rug-cluster +
    // dev lineage). Entry is early — no waiting for price to move. Also keep a telemetry watch.
    if (c.mode === "fast-follow" && config.checkpoint.enabled) momentum.add(c); // telemetry only
    const enqueueNow = () => {
      queue.push(c);
      if (queue.length > 200) queue.splice(0, queue.length - 200); // bounded backlog: drop oldest
      void drain();
    };
    if (c.mode !== "fast-follow") { enqueueNow(); return; }
    // ADAPTIVE SETTLE (2026-07-31) — wait for the mint to actually EXIST, not for a fixed clock.
    // The old blind `FAST_FOLLOW_SETTLE_MS` sleep was racing chain propagation: 872 buy
    // simulations today failed with a misleading `IncorrectProgramId`, which really means the ATA
    // instruction asked a token program about a mint account that was not visible yet (verified —
    // the same mints resolve fine minutes later). See waitForMintVisible for the full diagnosis.
    // This returns as soon as the account appears, so it is usually FASTER than the old 1.5s
    // sleep and only slower when waiting is genuinely required.
    void waitForMintVisible(c.mint, FAST_FOLLOW_MAX_SETTLE_MS).then(({ visible, waitedMs }) => {
      logRecord("events", { type: "mint-settle", decisionId: c.decisionId ?? null, mint: c.mint, symbol: c.symbol,
        visible, waitedMs, capMs: FAST_FOLLOW_MAX_SETTLE_MS, cfg: configHash });
      enqueueNow(); // fail OPEN — the buy simulation stays the real arbiter, this only schedules
    });
  };

  stops.push(listenNewTokens(enqueue)); // fast-follow bonding-curve launches (the only lane)
  armCoordinator.start();
  stops.push(() => armCoordinator.stop());
  trader.start();
  if (config.checkpoint.enabled) { momentum.start(); ui.info(`[momentum] checkpoint entry ON — watching curves, buy only on confirmed accelerating momentum`); }
  if (config.bitquery.enabled) { bitquery.start(); ui.info(`[bitquery] multi-launchpad stream ON — ${config.bitquery.launchpads.join(", ")}`); }
  trader.setSetupVerdictHook((mint, verdict, confidence) => observatory.setVerdict(mint, verdict, confidence)); // stamp verdict+confidence when classifier runs
  // Research pauses whenever live candidates are backed up — entries always win the RPC budget.
  observatory.setBusyProbe(() => queue.length > 0 || activeWorkers > 0);
  observatory.start(); if (config.observatory.enabled) ui.info(`[observatory] following ALL launches for the counterfactual/shadow dataset`);
  stops.push(() => observatory.stop());
  notify("startup", `Bot online — mode ${config.mode}, size ${config.risk.paperTradeSizeSol}◎, settle ${FAST_FOLLOW_SETTLE_MS}ms`);
  if (!notifyEnabled) ui.info("[notify] Telegram alerts OFF — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for unattended 24/7");

  // ── WATCHDOG: catch the SILENT failure mode ──
  // The dangerous 24/7 failure is not a crash (a supervisor restarts that) — it is the bot staying
  // "up" while its data feed is dead: a WebSocket that was half-closed by a NAT/proxy still looks
  // open, so pumpportal stops delivering launches and the bot sits there scanning nothing, forever,
  // with no error in the log. pump.fun produces launches continuously, so a long gap can only mean
  // the feed is broken. Exit non-zero and let the supervisor restart with a fresh socket — that is
  // strictly better than a process that is alive but blind.
  const stallMs = Number(process.env.WATCHDOG_STALL_MS ?? 5 * 60_000);
  const watchdog = setInterval(() => {
    const quietMs = Date.now() - lastLaunchAt;
    if (quietMs < stallMs) return;
    ui.warn(`[watchdog] no launch for ${Math.round(quietMs / 1000)}s (limit ${stallMs / 1000}s) — feed is dead, restarting`);
    logRecord("events", { type: "watchdog-restart", quietMs, stallMs, cfg: configHash });
    try { trader.stop(); flushActorMemory(); } catch { /* persist what we can */ }
    void notifySync("watchdog", `Launch feed silent for ${Math.round(quietMs / 1000)}s — restarting.\nOpen positions were persisted.`)
      .finally(() => process.exit(1)); // non-zero → supervisor restarts us
  }, 30_000);
  stops.push(() => clearInterval(watchdog));

  // RPC HEALTH → logs/rpc-health.json. The trader and the web server are SEPARATE processes
  // (they share state through files, not memory), so the dashboard reads the budget picture
  // from here. This is the number that explains entry latency — it must be visible, not guessed.
  const healthTimer = setInterval(() => {
    const s = rpcStats();
    try {
      writeFileSync(join(config.logDir, "rpc-health.json"), JSON.stringify({
        ...s, queueDepth: queue.length, activeWorkers,
        // Per-endpoint health for the rotating failover. Hosts only — the URLs carry API keys
        // and this file is read by the web process. Makes "which key is live, which is spent"
        // an observable fact instead of something we infer from a latency spike.
        endpoints: rpcEndpointHealth(),
        hotThemes: hotThemes(5), // loudest narratives right now — surfaced so it is observable
        at: Date.now(),
      }));
    } catch { /* best-effort */ }
    if (s.utilPct >= 95) ui.warn(`[rpc] saturated — ${s.rps}/${s.capacity} req/s, ${queue.length} candidates queued (entries will lag)`);
  }, 5_000);
  stops.push(() => clearInterval(healthTimer));

  setInterval(() => {
    const s = rpcStats();
    ui.info(`— status: ${launchFiltered} launch-MC skipped, ${processed} gated, ${passed} passed, ${momentum.size()} watching | rpc ${s.rps}/${s.capacity}/s (${s.utilPct}%), queue ${queue.length} | paper: ${trader.summary()}`);
  }, 60_000);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return; // a second signal must not re-enter and double-close positions
    shuttingDown = true;
    ui.info("shutting down…");
    stops.forEach((s) => s());
    momentum.stop();
    bitquery.stop();
    trader.stop();          // persists open positions
    flushActorMemory();     // actor-memory writes are throttled — force the pending one out
    ui.info(`final: ${processed} gated, ${passed} passed | paper: ${trader.summary()}`);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── 24/7 SURVIVABILITY ──
  // Without these, one unhandled rejection from any best-effort fetch takes the whole bot down
  // and (under a process supervisor) triggers a restart loop that looks like "the bot is buggy".
  // A single failed enrichment call must never end the process; it is logged and trading goes on.
  process.on("unhandledRejection", (reason) => {
    ui.warn(`[fatal-guard] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
    logRecord("events", { type: "unhandled-rejection", reason: reason instanceof Error ? reason.message : String(reason), cfg: configHash });
  });
  process.on("uncaughtException", (err) => {
    // An uncaught exception CAN leave state inconsistent, so unlike a rejection we do not pretend
    // it is fine: record it, persist positions, and exit non-zero so the supervisor restarts clean.
    ui.warn(`[fatal-guard] uncaught exception: ${err.message}`);
    logRecord("events", { type: "uncaught-exception", message: err.message, stack: err.stack?.slice(0, 500), cfg: configHash });
    try { trader.stop(); flushActorMemory(); } catch { /* nothing more we can do */ }
    void notifySync("crash", `Uncaught exception — restarting.\n\`${err.message.slice(0, 200)}\``)
      .finally(() => process.exit(1));
  });
}

main();
