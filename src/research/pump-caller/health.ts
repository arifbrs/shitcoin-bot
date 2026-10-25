/** `npm run pump:health` — kesehatan lane: watchlist, feed lag, jurnal, outcomes, koneksi. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWatchlist, watchDir } from "./watchlist.js";
import { read, reduceOutcomes } from "./journal.js";

const j = read();
const wl = loadWatchlist();
const tokens = j.rows.filter((r) => r.type === "token-observed");
const lags = tokens.map((t) => t.feedLagMs).filter((v): v is number => typeof v === "number");
const marks = [...reduceOutcomes(j.rows).values()];
const stale = wl.filter((e) => e.lastObservedAt == null || Date.now() - Number(e.lastObservedAt) > 10 * 60_000).length;
const lastTradeBatch = j.rows.filter((r) => r.type === "trade-batch").map((r) => Number(r.ts)).sort((a, b) => b - a)[0] ?? null;
const lastCandleSource = j.rows.filter((r) => r.type === "candle-source").map((r) => Number(r.ts)).sort((a, b) => b - a)[0] ?? null;
const firstAdmit = wl.length ? Math.min(...wl.map((e) => e.admittedAt)) : null;
console.log(JSON.stringify({
  watcherUptimeMs: firstAdmit ? Date.now() - firstAdmit : null,
  watchlistSize: wl.length, watchlistFresh: wl.length - stale, watchlistStale: stale,
  tokensObserved: tokens.length,
  feedProcessingLagMedMs: lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null,
  feedLagNote: "lag PEMROSESAN launch (detectedAt->admit); on-chain->feed belum diukur di lane ini",
  sourceFreshness: {
    lastTradeBatchAt: lastTradeBatch, ageMin: lastTradeBatch ? Number(((Date.now() - lastTradeBatch) / 60000).toFixed(1)) : null,
    lastCandleSourceAt: lastCandleSource,
  },
  journalRows: j.rows.length, malformed: j.malformed,
  decisions: j.rows.filter((r) => r.type === "shadow-decision").length,
  outcomes: { OBSERVED: marks.filter((m) => m.status === "OBSERVED").length, PENDING: marks.filter((m) => m.status === "PENDING").length, MISSING_FINAL: marks.filter((m) => m.status === "MISSING_FINAL").length },
  gmgnBacklogNote: "proxy GMGN dibagi dgn lane lain; observer memakai serialisasi + cooldown + cek /health",
  knownWalletsFile: existsSync(join(watchDir(), "known-wallets.json")),
}, null, 1));
void readFileSync;
