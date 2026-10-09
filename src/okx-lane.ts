import { config } from "./config.js";
import { ui, logRecord } from "./util/log.js";
import {
  okxCredentialWarnings, okxEnabled, okxLatestSignals, okxWalletTransactions,
  type OkxSignal, type OkxWalletDexTransaction,
} from "./discovery/okx.js";
import { OkxWsClient, OKX_WS_CHANNELS, type OkxWsEvent } from "./discovery/okx-ws.js";
import { attachOkxObservatory, observe, okxObservatoryOpenCount } from "./discovery/okx-observatory.js";
import { okxRadarSweep, okxRadarSelect } from "./discovery/okx-radar.js";
import { enqueueOkxCandidate, flushOkxCandidates, okxCandidateCount } from "./discovery/okx-candidates.js";

/**
 * OKX LANE — a standalone process. It never touches the trading bot.
 *
 *   npm run okx:lane            → run it
 *   npm run okx:radar           → one leaderboard sweep, then exit
 *
 * SEPARATE PROCESS ON PURPOSE. The fast-follow lane's entry budget is ~2.5s of gate and its
 * measured p90 detect→entry is already 14.7s; nothing here may compete for that process's event
 * loop, its RPC pool, or its failure modes. This lane can crash, hang on a stalled socket, or be
 * region-blocked, and the trader will not notice.
 *
 * WHAT IT PRODUCES: evidence, not trades. Three streams in logs/events-*.jsonl —
 *   okx-ws-event            every stream event with its detection lag
 *   okx-observation(-*)     fixed-horizon outcomes for signals and tracked-wallet buys
 *   okx-radar-sweep/-wallet the wallet universe and its persistence across sweeps
 *
 * The bar this lane has to clear before anything it says is allowed near an entry decision is the
 * one the GMGN smart-money lane failed: positive expectancy measured from OUR detection time, at
 * horizons fixed in advance, over a sample large enough to survive the tail.
 */

const RADAR_INTERVAL_MS = Math.max(600_000, Number(process.env.OKX_RADAR_INTERVAL_MS ?? 3_600_000));
const STATUS_INTERVAL_MS = 60_000;

const sourceMs = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

/** Insertion-ordered bounded dedupe. `true` means the key had not been seen. */
function remember(seen: Set<string>, key: string, max = 20_000): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  while (seen.size > max) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest == null) break;
    seen.delete(oldest);
  }
  return true;
}

const signalKey = (s: OkxSignal): string => [
  s.cursor ?? "", s.timestamp ?? "", s.token?.tokenAddress ?? "", s.walletType ?? "",
  s.triggerWalletAddress ?? "", s.amountUsd ?? "",
].join(":");

const copyKey = (wallet: string, t: OkxWalletDexTransaction): string => [
  wallet, t.type, t.time ?? "", t.tokenContractAddress, t.amount ?? "", t.valueUsd ?? "",
].join(":");

async function main(): Promise<void> {
  const warnings = okxCredentialWarnings();
  for (const w of warnings) ui.warn(`[okx-lane] ${w}`);
  if (!okxEnabled) {
    ui.warn("[okx-lane] OKX REST is disabled — set OKX_SHADOW_ENABLED=true and the three credentials in .env");
    ui.warn("[okx-lane] run `npm run okx:probe` first: it reports which endpoints actually answer before anything is built on them");
    process.exit(1);
  }

  ui.pass(`[okx-lane] starting — REST ${config.okx.baseUrl} @ ${config.okx.maxRps} rps ceiling, WS ${config.okx.wsEnabled ? config.okx.wsUrl : "disabled"}`);

  // ── radar: build the wallet universe, then feed it to the tracker ──
  let tracked: string[] = config.okx.trackedWallets;
  let client: OkxWsClient | null = null;
  const sweep = async (): Promise<void> => {
    try {
      await okxRadarSweep();
      const picked = okxRadarSelect({ limit: 200 }).map((w) => w.walletAddress);
      if (picked.length === 0) {
        // Expected on the first sweep: persistence needs two. Say so, rather than letting an
        // empty tracker list look like a failure.
        ui.warn("[okx-lane] no wallets selected yet — persistence needs at least 2 sweeps");
      }
      if (picked.length > 0) {
        // Explicit owner follows are pinned; radar discoveries fill the remaining slots instead
        // of replacing the manual list on every sweep.
        tracked = [...new Set([...config.okx.trackedWallets, ...picked])].slice(0, 200);
        if (client && (config.okx.copyShadow || config.okx.wsChannels.includes("address-tracker-activity"))) {
          client.replaceWallets(tracked);
        }
        logRecord("events", {
          type: "okx-radar-selection", radarCount: picked.length,
          manualCount: config.okx.trackedWallets.length, trackedCount: tracked.length, sample: tracked.slice(0, 5),
        });
        ui.pass(`[okx-lane] tracking ${tracked.length} wallets (${config.okx.trackedWallets.length} manual + radar)`);
      }
    } catch (e) {
      ui.warn(`[okx-lane] radar sweep failed: ${(e as Error).message}`);
    }
  };
  await sweep();
  // Referenced on purpose: the old `.unref()` made REST-only mode exit immediately after the
  // first sweep, even though the console said it would keep running.
  const radarTimer = setInterval(() => void sweep(), RADAR_INTERVAL_MS);

  // ── REST fallback: signal feed + shadow copy polling when WS is unavailable ──
  const seenSignals = new Set<string>();
  const seenCopies = new Set<string>();
  const primedCopyWallets = new Set<string>();
  const lastCopyPoll = new Map<string, number>();
  let signalsPrimed = false;
  let signalBusy = false;
  let copyBusy = false;
  let restSignalEvents = 0;
  let restCopyEvents = 0;
  let signalTimer: NodeJS.Timeout | null = null;
  let copyTimer: NodeJS.Timeout | null = null;

  const pollSignals = async (): Promise<void> => {
    if (signalBusy) return;
    signalBusy = true;
    try {
      const rows = await okxLatestSignals({ limit: "100" });
      if (!rows) return;
      if (!signalsPrimed) {
        for (const row of rows) remember(seenSignals, signalKey(row));
        signalsPrimed = true;
        logRecord("events", { type: "okx-rest-signal-seed", rows: rows.length });
        return;
      }
      for (const row of [...rows].reverse()) {
        if (!remember(seenSignals, signalKey(row))) continue;
        const receivedAt = Date.now();
        const sourceTs = sourceMs(row.timestamp);
        const event: OkxWsEvent = {
          channel: "dex-market-new-signal-openapi-rest",
          receivedAt,
          sourceTs,
          detectLagMs: sourceTs == null ? null : receivedAt - sourceTs,
          data: {
            ...row,
            tokenAddress: row.token?.tokenAddress,
            symbol: row.token?.symbol,
          },
        };
        restSignalEvents++;
        logRecord("events", { type: "okx-rest-signal", detectLagMs: event.detectLagMs, data: event.data });
        enqueueOkxCandidate("signal", event);
        observe("signal", event);
      }
    } catch (e) {
      ui.warn(`[okx-lane] REST signal poll failed: ${(e as Error).message}`);
    } finally {
      signalBusy = false;
    }
  };

  const pollCopies = async (): Promise<void> => {
    if (copyBusy || !config.okx.copyShadow) return;
    copyBusy = true;
    try {
      const wallets = [...new Set(tracked)].slice(0, config.okx.restCopyMaxWallets);
      for (const wallet of wallets) {
        const end = Date.now();
        const begin = Math.max(0, (lastCopyPoll.get(wallet) ?? (end - 5 * 60_000)) - 5_000);
        const page = await okxWalletTransactions(wallet, {
          begin: String(begin), end: String(end), type: "1", limit: "100",
        });
        if (!page) continue; // do not advance the window after an unreadable page
        lastCopyPoll.set(wallet, end);
        const rows = Array.isArray(page.transactionList) ? [...page.transactionList].reverse() : [];
        if (!primedCopyWallets.has(wallet)) {
          for (const row of rows) remember(seenCopies, copyKey(wallet, row), 50_000);
          primedCopyWallets.add(wallet);
          continue;
        }
        for (const row of rows) {
          if (row.type !== "1" || !row.tokenContractAddress || !remember(seenCopies, copyKey(wallet, row), 50_000)) continue;
          const receivedAt = Date.now();
          const ts = sourceMs(row.time);
          const event: OkxWsEvent = {
            channel: "address-tracker-activity-rest",
            receivedAt,
            sourceTs: ts,
            detectLagMs: ts == null ? null : receivedAt - ts,
            data: {
              ...row,
              walletAddress: wallet,
              amountUsd: row.valueUsd,
              symbol: row.tokenSymbol,
            },
          };
          restCopyEvents++;
          logRecord("events", { type: "okx-rest-copy", detectLagMs: event.detectLagMs, data: event.data });
          enqueueOkxCandidate("copy", event);
          observe("copy", event);
        }
      }
    } catch (e) {
      ui.warn(`[okx-lane] REST copy poll failed: ${(e as Error).message}`);
    } finally {
      copyBusy = false;
    }
  };

  const startRestFallback = (reason: string): void => {
    if (config.okx.restSignalEnabled && !signalTimer) {
      ui.warn(`[okx-lane] REST signal fallback active (${reason}) — poll ${config.okx.restSignalPollMs}ms`);
      void pollSignals();
      signalTimer = setInterval(() => void pollSignals(), config.okx.restSignalPollMs);
    }
    if (config.okx.copyShadow && !copyTimer) {
      ui.warn(`[okx-lane] REST copy fallback active (${reason}) — ${config.okx.restCopyMaxWallets} wallets max / ${config.okx.restCopyPollMs}ms`);
      void pollCopies();
      copyTimer = setInterval(() => void pollCopies(), config.okx.restCopyPollMs);
    }
  };

  // ── streams ──
  if (!config.okx.wsEnabled) {
    ui.warn("[okx-lane] OKX_WS_ENABLED != true — running REST-only");
    startRestFallback("WebSocket disabled");
  } else {
    client = new OkxWsClient("okx-lane");
    let wallets = false;
    for (const ch of config.okx.wsChannels) {
      const spec = (OKX_WS_CHANNELS as Record<string, { pattern: string }>)[ch];
      if (!spec) { ui.warn(`[okx-lane] unknown channel "${ch}"`); continue; }
      if (spec.pattern === "chain") client.subscribe(ch, { chainIndex: "501" });
      else if (spec.pattern === "global") client.subscribe(ch, {});
      else if (spec.pattern === "wallets") { client.subscribeWallets(tracked); wallets = true; }
      else ui.warn(`[okx-lane] "${ch}" needs a token pair — not subscribed here`);
    }
    if (config.okx.copyShadow && !wallets && tracked.length > 0) {
      // Copy shadow was asked for but the channel was not listed — subscribe it rather than
      // running a copy study with no copy events, which would silently produce an empty verdict.
      client.subscribeWallets(tracked);
      ui.warn(`[okx-lane] OKX_COPY_SHADOW=true — auto-subscribed address-tracker-activity for ${tracked.length} wallets`);
    }

    client.onEvent((e) => {
      logRecord("events", { type: "okx-ws-event", channel: e.channel, detectLagMs: e.detectLagMs, sourceTs: e.sourceTs, data: e.data });
      if (e.channel === "dex-market-new-signal-openapi" || e.channel === "kol_smartmoney-tracker-activity") {
        enqueueOkxCandidate("signal", e);
      } else if (e.channel === "address-tracker-activity") {
        const side = String(e.data.tradeType ?? e.data.side ?? e.data.direction ?? "").toLowerCase();
        if (!side || side.includes("buy") || side === "1") enqueueOkxCandidate("copy", e);
      }
    });
    attachOkxObservatory(client);
    client.onUnavailable((reason) => startRestFallback(reason));
    client.connect();
  }

  const statusTimer = setInterval(() => {
    const channelCounts = client ? Object.fromEntries(client.counts) : {};
    const counts = client ? [...client.counts.entries()].map(([c, n]) => `${c}=${n}`).join(" ") : "";
    logRecord("events", {
      type: "okx-lane-status", openObservations: okxObservatoryOpenCount(), trackedWallets: tracked.length,
      channelCounts, restSignalEvents, restCopyEvents, candidates: okxCandidateCount(),
    });
    ui.info?.(`[okx-lane] obs=${okxObservatoryOpenCount()} candidates=${okxCandidateCount()} tracked=${tracked.length} restSignal=${restSignalEvents} restCopy=${restCopyEvents} ${counts}`);
  }, STATUS_INTERVAL_MS);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(radarTimer);
    clearInterval(statusTimer);
    if (signalTimer) clearInterval(signalTimer);
    if (copyTimer) clearInterval(copyTimer);
    client?.close();
    flushOkxCandidates();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
