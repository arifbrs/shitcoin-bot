/**
 * bloXroute pump.fun swap RECORDER — passive measurement only.
 *
 * WHY THIS EXISTS
 * Our own price path is sampled by a 4-second polling tick (papertrader.ts `fastTimer`).
 * Measured across 109 armed TRAIL_LOCK exits, the price moves a median of 17.2% in ONE tick
 * step, and the trail fires at the first observation past its band (median 0 ticks of lag).
 * So the exit is not late — the observation is coarse. A 6% trail band cannot be honoured when
 * the next look happens after the price has already gapped 17%.
 *
 * bloXroute's `GetPumpFunSwapsStream` pushes `virtualSolReserves`/`virtualTokenReserves` on
 * EVERY bonding-curve swap. Verified live 2026-08-02: a frame carrying vSol = 30.000000 SOL
 * yields MC 27.96, which is exactly the pump.fun launch constant this project already measured
 * independently — so the feed shares our curve basis and needs only a lamport rescale, not a
 * new price model.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not touch any trading decision. Removing the sampling floor might improve exits, or
 * might make them worse by tripping the trail on single-swap noise and killing runners — that
 * is UNMEASURED, and every exit tuning tested so far has been worth +0.10 to +0.44 %/trade
 * against a measurement precision of ±0.31, i.e. nothing. Record first, decide later.
 *
 * WHY IT IS A SEPARATE FILE AND A SEPARATE PROCESS
 * `codeFingerprint()` in config.ts hashes an EXPLICIT list of 15 strategy files (no globbing).
 * This file is not on that list and is imported by nothing, so running it cannot move the
 * sniper's `cfg` hash or split the live cohort. It writes only to its own log stream.
 *
 * FREE-TIER CONSTRAINT (measured, not read from docs — the docs are wrong here)
 * The docs say a stream subscription costs 100 credits against an Introductory budget of 60,
 * which would make it impossible. In practice one subscription works and holds indefinitely
 * (verified: 58 messages over an unbroken 5-minute run). A SECOND concurrent subscription is
 * refused with "account is rate limited". So: exactly one subscription at a time, held long,
 * re-subscribed rarely. Each re-subscribe is a credit event, hence REFRESH_MS is minutes.
 */
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

const WS_URL = process.env.BLOXROUTE_WS_URL?.trim() || "wss://ny.solana.dex.blxrbdn.com/ws";
const AUTH = process.env.BLOXROUTE_AUTH_HEADER?.trim();
const LOG_DIR = process.env.LOG_DIR?.trim() || "logs";

/** How often the watched-token set is refreshed. Each refresh costs one subscription. */
const REFRESH_MS = Number(process.env.BX_REFRESH_MS ?? 5 * 60_000);
/** How far back to pull launches for the watch list. Our holds are ~46s median, entries ~9s. */
const LAUNCH_WINDOW_MS = Number(process.env.BX_LAUNCH_WINDOW_MS ?? 7 * 60_000);
/** Verified working at 80 tokens (543 swaps in 50s). Kept below that; credits scale with count. */
const MAX_TOKENS = Number(process.env.BX_MAX_TOKENS ?? 80);
/** Backoff after a refused subscription — the credit window is 60s. */
const RATE_LIMIT_BACKOFF_MS = 75_000;

const day = (): string => new Date().toISOString().slice(0, 10);
const write = (rec: unknown): void => {
  appendFileSync(join(LOG_DIR, `bx-swaps-${day()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), ...(rec as object) }) + "\n");
};
const log = (msg: string): void => console.log(`[bx-swaps] ${msg}`);

/**
 * Recent launches from the bot's OWN event log — no extra API call, and it guarantees the
 * watch list is exactly the universe the sniper is choosing from.
 */
function recentLaunchMints(): string[] {
  const cutoff = Date.now() - LAUNCH_WINDOW_MS;
  const out: string[] = [];
  try {
    // Two files so the list survives the UTC midnight rollover mid-window.
    const files = readdirSync(LOG_DIR).filter((f) => f.startsWith("events-") && f.endsWith(".jsonl")).sort().slice(-2);
    for (const f of files) {
      for (const line of readFileSync(join(LOG_DIR, f), "utf8").split("\n")) {
        if (!line.includes('"launch"')) continue; // cheap prefilter before the JSON parse
        try {
          const r = JSON.parse(line) as { type?: string; mint?: string; ts?: string };
          if (r.type !== "launch" || !r.mint || !r.ts) continue;
          if (Date.parse(r.ts) >= cutoff) out.push(r.mint);
        } catch { /* skip malformed line */ }
      }
    }
  } catch (err) {
    log(`could not read launches: ${(err as Error).message}`);
  }
  return [...new Set(out)].slice(-MAX_TOKENS);
}

interface SwapFrame {
  slot?: number; txnHash?: string; mintAddress?: string; solAmount?: string | number;
  tokenAmount?: string | number; isBuy?: boolean; virtualSolReserves?: string | number;
  virtualTokenReserves?: string | number; creator?: string; timestamp?: string;
}

let ws: WebSocket | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let swaps = 0, subs = 0, refusals = 0, frames = 0;

function connectAndSubscribe(): void {
  const tokens = recentLaunchMints();
  if (!tokens.length) { log("no recent launches yet — retrying in 60s"); refreshTimer = setTimeout(connectAndSubscribe, 60_000); return; }

  try { ws?.close(); } catch { /* already gone */ }
  ws = new WebSocket(WS_URL, { headers: { Authorization: AUTH! } });
  const sock = ws;

  sock.on("open", () => {
    sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscribe", params: ["GetPumpFunSwapsStream", { tokens }] }));
  });

  sock.on("message", (raw: Buffer) => {
    frames++;
    let o: { error?: { message?: string; data?: string }; result?: unknown; params?: { result?: SwapFrame } };
    try { o = JSON.parse(raw.toString()); } catch { return; }

    if (o.error) {
      const detail = o.error.data || o.error.message || "unknown";
      const limited = /rate limit/i.test(detail);
      if (limited) refusals++;
      log(`subscribe refused: ${detail}${limited ? ` — backing off ${RATE_LIMIT_BACKOFF_MS / 1000}s` : ""}`);
      write({ type: "bx-subscribe-refused", detail, tokens: tokens.length });
      try { sock.close(); } catch { /* ignore */ }
      refreshTimer = setTimeout(connectAndSubscribe, limited ? RATE_LIMIT_BACKOFF_MS : 30_000);
      return;
    }

    if (typeof o.result === "string") {
      subs++;
      log(`subscribed to ${tokens.length} tokens (subscription #${subs}, ${swaps} swaps so far)`);
      write({ type: "bx-subscribed", tokens: tokens.length, subscriptionCount: subs });
      return;
    }

    const r = o.params?.result;
    if (!r?.mintAddress) return;

    // Rescale to the units this project already uses everywhere else. vSol arrives in lamports
    // and vTokens in raw base units (6 decimals for pump.fun), so mcSol matches papertrader's
    // `entryMcSol = (vSol / vTokens) * 1e9` — verified against the 27.96 launch constant.
    const vSolLamports = Number(r.virtualSolReserves ?? 0);
    const vTokensRaw = Number(r.virtualTokenReserves ?? 0);
    const vSol = vSolLamports / 1e9;
    const vTokens = vTokensRaw / 1e6;
    const mcSol = vTokens > 0 ? (vSol / vTokens) * 1e9 : null;

    swaps++;
    write({
      type: "bx-swap",
      mint: r.mintAddress, slot: r.slot ?? null, txnHash: r.txnHash ?? null,
      isBuy: r.isBuy ?? null,
      solAmount: Number(r.solAmount ?? 0) / 1e9,
      // Both the raw feed values and our derived ones, so a later audit can re-derive rather
      // than trust this conversion — the same discipline the trade log already follows.
      vSolLamports, vTokensRaw,
      vSol: Number(vSol.toFixed(9)),
      mcSol: mcSol == null ? null : Number(mcSol.toFixed(4)),
      creator: r.creator ?? null,
      feedTimestamp: r.timestamp ?? null,
    });
  });

  sock.on("close", (code: number) => {
    if (sock !== ws) return; // superseded by a refresh
    log(`socket closed (${code}) — reconnecting in 10s`);
    refreshTimer = setTimeout(connectAndSubscribe, 10_000);
  });
  sock.on("error", (e: Error) => log(`socket error: ${e.message}`));
}

function main(): void {
  if (!AUTH) {
    console.error("[bx-swaps] BLOXROUTE_AUTH_HEADER is not set — refusing to start.");
    process.exit(1);
  }
  log(`starting — ws=${WS_URL} refresh=${REFRESH_MS / 1000}s window=${LAUNCH_WINDOW_MS / 1000}s maxTokens=${MAX_TOKENS}`);
  connectAndSubscribe();

  // Periodic refresh so the watch list follows the launch feed. Deliberately NOT event-driven
  // on each new launch: every re-subscribe is a credit event and a second concurrent one is
  // refused outright, so churning the subscription would leave us recording nothing at all.
  setInterval(() => {
    if (refreshTimer) clearTimeout(refreshTimer);
    connectAndSubscribe();
  }, REFRESH_MS);

  setInterval(() => log(`alive — ${frames} frames, ${swaps} swaps, ${subs} subscriptions, ${refusals} refusals`), 60_000);
}

main();
