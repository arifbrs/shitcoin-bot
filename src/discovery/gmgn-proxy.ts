/**
 * GMGN LOCAL RATE-LIMIT PROXY — the ONLY process that talks to GMGN's OpenAPI directly.
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
 * This process holds the ONE real OpenApiClient + the ONE real weighted rate limiter. Every
 * other process now calls THIS over local HTTP instead of GMGN directly — gmgn.ts's wrappers
 * were rewritten to do exactly that. Read-only by construction: only the methods gmgn.ts
 * actually wraps are dispatched; swap/order/cooking are not reachable through this proxy.
 *
 * Run: npm run gmgn:proxy (must be running before any other GMGN-consuming process)
 */
import { createServer } from "node:http";
import { OpenApiClient } from "gmgn-cli/dist/client/OpenApiClient.js";
import { TokenBucket } from "../util/http.js";
import "dotenv/config";

const PORT = Number(process.env.GMGN_PROXY_PORT ?? 4319);
const apiKey = process.env.GMGN_API_KEY?.trim();
const privateKeyRaw = process.env.GMGN_PRIVATE_KEY?.trim();
// Review item (2026-07-27): none of the read-only methods this proxy dispatches need signing
// (all are exist-auth — see OpenApiClient.ts's own auth-mode comment), so the private key is
// intentionally NOT loaded here. If a genuinely signed method is ever added, load it explicitly
// at that point, not implicitly for a proxy whose whole purpose is staying read-only.
//
// 2026-08-24: a signed method WAS added, explicitly, per that instruction — S2_EXEC_ROUTE=gmgn
// (owner asked to try GMGN as an execution route). The private key signs the API REQUEST
// (Ed25519/RSA auth signature per GMGN's own protocol); it is NOT a wallet custody key and
// never leaves this process. The swap itself executes against `from_address` = the bot wallet.
const swapEnabled = process.env.S2_EXEC_ROUTE === "gmgn";
const privateKeyPem = swapEnabled && privateKeyRaw ? privateKeyRaw : undefined;
if (swapEnabled) console.warn("[gmgn-proxy] S2_EXEC_ROUTE=gmgn — metode swap/order AKTIF (signed auth dimuat).");

if (!apiKey) {
  console.error("[gmgn-proxy] GMGN_API_KEY not set — nothing to proxy. Exiting.");
  process.exit(1);
}

const client = new OpenApiClient({ apiKey, host: "https://openapi.gmgn.ai", privateKeyPem });
const bucket = TokenBucket.perSecond(20); // rate=20, capacity=20 — GMGN's REAL documented limit, verified 2026-07-27

// Method name -> weight (verified: trending=1, kline=2, trenches=3, signal=3, hot-searches=3;
// every other read-only method defaults to 1, matching gmgn-skills' documented weight table —
// only these five were explicitly weighted, everything else the docs list at the default).
const WEIGHTS: Record<string, number> = {
  getTrendingSwaps: 1, getTokenKline: 2, getTrenches: 3, getTokenSignalV2: 3, getHotSearches: 3,
};

// Only read-only methods are dispatchable — swap/multiSwap/order/cooking are simply absent from
// this map, so no request body can reach them no matter what a caller sends.
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
  getKol: (a) => client.getKol(a[0] as string | undefined, a[1] as number | undefined),
  getSmartMoney: (a) => client.getSmartMoney(a[0] as string | undefined, a[1] as number | undefined),
  getCreatedTokens: (a) => client.getCreatedTokens(a[0] as string, a[1] as string, a[2] as Record<string, string | number>),
  quoteOrder: (a) => client.quoteOrder(a[0] as string, a[1] as string, a[2] as string, a[3] as string, a[4] as string, a[5] as number),
};

let served = 0, errors = 0, abandonedSuccess = 0, abandonedError = 0;

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
  if (req.method !== "POST" || req.url !== "/call") { res.writeHead(404); res.end(); return; }
  let body = "";
  let callerGone = false;
  req.on("data", (c) => { body += c; });
  res.on("close", () => { if (!res.writableEnded) callerGone = true; });
  req.on("end", () => {
    void (async () => {
      try {
        const { method, args } = JSON.parse(body) as { method: string; args: unknown[] };
        const fn = DISPATCH[method];
        if (!fn) { if (!callerGone) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `unknown or non-read-only method: ${method}` })); } return; }
        const weight = WEIGHTS[method] ?? 1;
        for (let i = 0; i < weight; i++) await bucket.take();
        const data = await fn(args ?? []);
        if (callerGone) { abandonedSuccess++; return; } // upstream succeeded, but nobody's listening anymore — don't count as clean-served
        served++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      } catch (e) {
        if (callerGone) { abandonedError++; return; } // upstream itself failed too, AFTER the caller already left — distinct from abandonedSuccess
        errors++;
        // Forward the REAL error message/status distinctly (review: callers used to see every
        // failure — 429, bad contract, network — collapsed to the same `null`).
        const msg = (e as Error).message ?? String(e);
        const status = /HTTP 429|RATE_LIMIT/i.test(msg) ? 429 : 502;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    })();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[gmgn-proxy] listening on 127.0.0.1:${PORT} — rate=20/cap=20 (real GMGN limit), shared across every GMGN-consuming process.`);
});
setInterval(() => console.log(`[gmgn-proxy] served ${served}, errors ${errors}, abandonedSuccess ${abandonedSuccess} (caller gave up, upstream still succeeded), abandonedError ${abandonedError} (caller gave up, upstream then failed too)`), 5 * 60_000);

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
