/** `npm run pump:health` — kesehatan lane: watchlist, feed lag, jurnal, outcomes, koneksi. */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadWatchlist, watchDir } from "./watchlist.js";
import { read } from "./journal.js";

const j = read();
const wl = loadWatchlist();
const tokens = j.rows.filter((r) => r.type === "token-observed");
const lags = tokens.map((t) => t.feedLagMs).filter((v): v is number => typeof v === "number");
const marks = j.rows.filter((r) => r.type === "outcome-mark");
const stale = wl.filter((e) => e.lastObservedAt == null || Date.now() - Number(e.lastObservedAt) > 10 * 60_000).length;
console.log(JSON.stringify({
  watchlistSize: wl.length, watchlistStale: stale,
  tokensObserved: tokens.length, feedLagMedMs: lags.length ? [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)] : null,
  journalRows: j.rows.length, malformed: j.malformed,
  decisions: j.rows.filter((r) => r.type === "shadow-decision").length,
  outcomes: { OBSERVED: marks.filter((m) => m.status === "OBSERVED").length, PENDING: marks.filter((m) => m.status === "PENDING").length, MISSING_FINAL: marks.filter((m) => m.status === "MISSING_FINAL").length },
  knownWalletsFile: existsSync(join(watchDir(), "known-wallets.json")),
}, null, 1));
void readFileSync;
