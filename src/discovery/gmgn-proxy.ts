/**
 * GMGN LOCAL RATE-LIMIT PROXY — shared by gmgn.ts clients. Legacy CLI callers elsewhere
 * still bypass it; do not start those concurrently until migrated.
 *
 * Review finding (2026-07-27, verified against gmgn-skills/skills/gmgn-market/SKILL.md): GMGN's
 * real limiter is a leaky bucket at `rate=20, capacity=20`, with per-endpoint WEIGHTS —
 * trending=1, kline=2, trenches=3, signal=3, hot-searches=3, everything else defaults to 1.
 * Before this file existed, FIVE separate OS processes (main bot, strategy2-scout,
 * strategy2-papertrader, gmgn-kol-watch, gmgn-launchpad-observatory) each ran their OWN
 * in-process TokenBucket(5/s) — since Node processes don't share memory, that was five
 * independent 5rps budgets, not one shared 20rps budget: up to 25rps could genuinely leave the
 * machine at once, well over GMGN's real ceiling.
 *
 * This process serializes SDK calls at 10-second spacing with persistent ban cooldown.
 * GMGN_READ_ONLY=true prevents loading signing auth or registering swap/order routes.
 *
 * Run: npm run gmgn:proxy (must be running before any other GMGN-consuming process)
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenApiClient } from "gmgn-cli/dist/client/OpenApiClient.js";
import { GmgnAbandonedError, GmgnCooldownError, GmgnRequestGate, type GmgnGateState } from "./gmgn-request-gate.js";
import "dotenv/config";

// Disable gmgn-cli's built-in "retry once on 429" (verified live 2026-10-07): retrying DURING a
// rate-limit cooldown is exactly what escalates RATE_LIMIT_EXCEEDED into an extended
// RATE_LIMIT_BANNED — GMGN's own error text: "repeated requests can extend the ban by 5s up to
// 5 minutes". The proxy now handles cooldown itself (see cooldownUntil below), so the library
// must stay out of it.
process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS = "0";

const PORT = Number(process.env.GMGN_PROXY_PORT ?? 4319);
const apiKey = process.env.GMGN_API_KEY?.trim();
// .env menyimpan PEM sebagai SATU baris dengan `\n` literal (diverifikasi 2026-10-07: tanpa
// normalisasi ini, crypto melempar "1E08010C:DECODER routines::unsupported" saat memuat key).
// Ganti escape jadi baris baru asli; PEM dengan baris baru asli tidak terpengaruh (no-op).
// Review item (2026-07-27): none of the read-only methods this proxy dispatches need signing
// (all are exist-auth — see OpenApiClient.ts's own auth-mode comment), so the private key is
// intentionally NOT loaded here. If a genuinely signed method is ever added, load it explicitly
// at that point, not implicitly for a proxy whose whole purpose is staying read-only.
//
// 2026-08-24: a signed method WAS added, explicitly, per that instruction — S2_EXEC_ROUTE=gmgn
// (owner asked to try GMGN as an execution route). The private key signs the API REQUEST
// (Ed25519/RSA auth signature per GMGN's own protocol); it is NOT a wallet custody key and
// never leaves this process. The swap itself executes against `from_address` = the bot wallet.
const readOnly = process.env.GMGN_READ_ONLY === "true";
const swapEnabled = !readOnly && process.env.S2_EXEC_ROUTE === "gmgn";
// Portfolio reads (wallet holdings / token balance) are GMGN "critical-auth" routes that need the
// private key too. Owner approved loading it for these READS (2026-10-07) WITHOUT enabling swap:
// GMGN_PORTFOLIO_AUTH=true loads the key, but the swap/order entries stay absent from DISPATCH.
const portfolioAuth = !readOnly && process.env.GMGN_PORTFOLIO_AUTH === "true";
const privateKeyRaw = !readOnly ? process.env.GMGN_PRIVATE_KEY?.trim().replace(/\\n/g, "\n") : undefined;
const privateKeyPem = (swapEnabled || portfolioAuth) && privateKeyRaw ? privateKeyRaw : undefined;
if (swapEnabled) console.warn("[gmgn-proxy] S2_EXEC_ROUTE=gmgn — metode swap/order AKTIF (signed auth dimuat).");
else if (portfolioAuth && privateKeyPem) console.warn("[gmgn-proxy] GMGN_PORTFOLIO_AUTH=true — wallet holdings/token balance AKTIF (signed). Swap/order tetap TERTUTUP.");

if (!apiKey) {
  console.error("[gmgn-proxy] GMGN_API_KEY not set — nothing to proxy. Exiting.");
  process.exit(1);
}

const client = new OpenApiClient({ apiKey, host: "https://openapi.gmgn.ai", privateKeyPem });
const logDir = process.env.LOG_DIR ?? "logs";
const statePath = join(logDir, "gmgn-proxy-state.json");
mkdirSync(logDir, { recursive: true });
let initialState: Partial<GmgnGateState> = {};
if (existsSync(statePath)) {
  // Corrupt pacing state must not silently clear a provider ban.
  const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || ["nextCallAt", "cooldownUntil"].some((k) => {
    const value = (parsed as Record<string, unknown>)[k]; return typeof value !== "number" || !Number.isFinite(value) || value < 0;
  })) throw new Error("GMGN proxy pacing state invalid; preserved, not reset");
  initialState = parsed as GmgnGateState;
}
const gate = new GmgnRequestGate(10_000, initialState, Date.now, undefined, (state) => {
  const tmp = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath);
});

// Method name -> weight (verified: trending=1, kline=2, trenches=3, signal=3, hot-searches=3;
// every other read-only method defaults to 1, matching gmgn-skills' documented weight table —
// only these five were explicitly weighted, everything else the docs list at the default).
const WEIGHTS: Record<string, number> = {
  getTrendingSwaps: 1, getTokenKline: 2, getTrenches: 3, getTokenSignalV2: 3, getHotSearches: 3,
  quoteOrder: 2, swap: 5,
};

// Signing methods are absent when readOnly=true. Other invocations retain the existing opt-in.
const DISPATCH: Record<string, (args: unknown[]) => Promise<unknown>> = {
  getTokenInfo: (a) => client.getTokenInfo(a[0] as string, a[1] as string),
  getTokenSecurity: (a) => client.getTokenSecurity(a[0] as string, a[1] as string),
  getTokenPoolInfo: (a) => client.getTokenPoolInfo(a[0] as string, a[1] as string),
  getTokenTopHolders: (a) => client.getTokenTopHolders(a[0] as string, a[1] as string, a[2] as Record<string, string | number>),
  getTokenTopTraders: (a) => client.getTokenTopTraders(a[0] as string, a[1] as string, a[2] as Record<string, string | number>),
  getTokenKline: (a) => client.getTokenKline(a[0] as string, a[1] as string, a[2] as string, a[3] as number | undefined, a[4] as number | undefined),
  getTrendingSwaps: (a) => client.getTrendingSwaps(a[0] as string, a[1] as string, a[2] as Record<string, string | number | string[]>),
  getTrenches: (a) => client.getTrenches(a[0] as string, a[1] as string[] | undefined, a[2] as string[] | undefined, a[3] as number | undefined, a[4] as Record<string, number | string> | undefined),
  getTokenSignalV2: (a) => client.getTokenSignalV2(a[0] as string, a[1] as Parameters<typeof client.getTokenSignalV2>[1]),
  // EKSEKUSI (signed) — hanya terdaftar saat S2_EXEC_ROUTE=gmgn. Tanpa itu, method ini
  // tidak ada di peta = tidak bisa dicapai siapa pun, apa pun body yang dikirim.
  ...(swapEnabled ? {
    swap: (a: unknown[]) => client.swap(a[0] as Parameters<typeof client.swap>[0]),
    getOrder: (a: unknown[]) => client.queryOrder(a[0] as string, a[1] as string),
  } : {}),
  getHotSearches: (a) => client.getHotSearches(a[0] as Parameters<typeof client.getHotSearches>[0]),
  // Wallet portfolio/quality reads (added 2026-10-07 untuk studi kualitas wallet):
  //  - stats/activity: exist-auth — terverifikasi live, tanpa key.
  //  - holdings/token-balance: "critical-auth" — HANYA terdaftar saat key dimuat (portfolioAuth),
  //    jadi proxy read-only default tidak bisa mencapainya sama sekali.
  getWalletStats: (a) => client.getWalletStats(a[0] as string, a[1] as string[], a[2] as string | undefined),
  getWalletActivity: (a) => client.getWalletActivity(a[0] as string, a[1] as string, a[2] as Record<string, string | number | string[]>),
  ...(privateKeyPem ? {
    getWalletHoldings: (a) => client.getWalletHoldings(a[0] as string, a[1] as string, a[2] as Record<string, string | number>),
    getWalletTokenBalance: (a) => client.getWalletTokenBalance(a[0] as string, a[1] as string, a[2] as string),
  } : {}),
  getKol: (a) => client.getKol(a[0] as string | undefined, a[1] as number | undefined),
  getSmartMoney: (a) => client.getSmartMoney(a[0] as string | undefined, a[1] as number | undefined),
  getCreatedTokens: (a) => client.getCreatedTokens(a[0] as string, a[1] as string, a[2] as Record<string, string | number>),
  quoteOrder: (a) => client.quoteOrder(a[0] as string, a[1] as string, a[2] as string, a[3] as string, a[4] as string, a[5] as number),
};

let served = 0, errors = 0, abandonedSuccess = 0, abandonedError = 0, skippedAbandoned = 0, upstreamWeight = 0;

// Global ban-aware cooldown (added 2026-10-07, live-verified): a 429 from GMGN carries a reset
// time, and EVERY request sent before it extends the ban (RATE_LIMIT_EXCEEDED → RATE_LIMIT_BANNED,
// +5s each, up to 5min). Previously the proxy kept relaying callers straight into that window.
// Now any 429 sets a cooldown; subsequent calls are refused locally until it expires.
// Gate serializes dispatch, persists cooldown, and refuses cooldown calls locally instead of
// parking them until after the caller's 15-second timeout and then spending quota anyway.

// LIMITATION (found live 2026-07-27, follow-up audit): a caller aborting its local fetch to THIS
// proxy does NOT cancel the upstream GMGN request `fn(args)` makes — gmgn-cli's OpenApiClient.
// doFetch() calls plain `fetch(url, {method, headers, body})` with no AbortSignal parameter at
// all, so there is nothing to wire a cancellation into short of forking that library. The
// request keeps running, still spends its already-taken rate-limit tokens, and its result is
// simply thrown away once the caller has given up (writeHead/end below then throw on a destroyed
// socket, which is why `served` alone used to look artificially healthy while callers timed out —
// this now tracks that gap explicitly instead of silently swallowing the write error). Split into
// abandonedSuccess/abandonedError (second review pass): the FIRST cut lumped both under one
// `abandoned` counter, so "upstream completed fine, caller just left" was indistinguishable from
// "upstream itself failed after the caller left" — the two mean very different things for
// diagnosing whether GMGN or the timeout budget is the actual problem.
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ readOnly, swapEnabled, spacingMs: 10_000, ...gate.snapshot(), pending: gate.pending,
      served, errors, abandonedSuccess, abandonedError, skippedAbandoned, upstreamWeight }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/call") { res.writeHead(404); res.end(); return; }
  let body = "";
  let callerGone = false;
  req.on("data", (c) => { body += c; if (body.length > 65_536) req.destroy(); });
  res.on("close", () => { if (!res.writableEnded) callerGone = true; });
  req.on("end", () => {
    void (async () => {
      try {
        const { method, args } = JSON.parse(body) as { method: string; args: unknown[] };
        const fn = Object.hasOwn(DISPATCH, method) ? DISPATCH[method] : undefined;
        if (!fn) { if (!callerGone) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `unknown or non-read-only method: ${method}` })); } return; }
        if (!Array.isArray(args)) { res.writeHead(400); res.end(JSON.stringify({ error: "args must be an array" })); return; }
        if (gate.pending >= 4) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "GMGN proxy queue full; no upstream request sent" })); return; }
        const data = await gate.run(async () => { upstreamWeight += WEIGHTS[method] ?? 1; return fn(args); }, () => callerGone);
        if (callerGone) { abandonedSuccess++; return; } // upstream succeeded, but nobody's listening anymore — don't count as clean-served
        served++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      } catch (e) {
        if (e instanceof GmgnAbandonedError) { skippedAbandoned++; return; }
        if (callerGone) { abandonedError++; return; } // upstream itself failed too, AFTER the caller already left — distinct from abandonedSuccess
        errors++;
        // Forward the REAL error message/status distinctly (review: callers used to see every
        // failure — 429, bad contract, network — collapsed to the same `null`).
        const msg = (e as Error).message ?? String(e);
        const rateLimited = e instanceof GmgnCooldownError || (e as { status?: number }).status === 429 || /HTTP 429|RATE_LIMIT/i.test(msg);
        if (rateLimited) {
          console.warn(`[gmgn-proxy] 429 — upstream blocked until ${new Date(gate.snapshot().cooldownUntil).toISOString()}`);
        }
        res.writeHead(rateLimited ? 429 : 502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg, ...(rateLimited ? { retryAt: gate.snapshot().cooldownUntil } : {}) }));
      }
    })();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gmgn-proxy] listening on 127.0.0.1:${PORT} — one upstream call/10s, serialized, persistent cooldown. readOnly=${readOnly}, swapEnabled=${swapEnabled}.`);
});
setInterval(() => console.log(`[gmgn-proxy] served ${served}, errors ${errors}, abandonedSuccess ${abandonedSuccess}, abandonedError ${abandonedError}, skippedQueued ${skippedAbandoned}, pending ${gate.pending}, cooldownUntil ${gate.snapshot().cooldownUntil}`), 5 * 60_000);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
