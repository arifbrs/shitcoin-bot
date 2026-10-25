/**
 * `npm run pump:watch` — observer KONTINU bebas-kunci: feed PumpPortal (reuse listenNewTokens)
 * → watchlist berbatas → tick observe (trades+candles persist → keputusan bayangan → outcomes).
 * Tidak ada Developer API di jalur kritis; tidak ada signing; nol modal.
 */
import { startObserver } from "./observer.js";

const stop = startObserver((kind, info) => {
  const ts = new Date().toISOString().slice(11, 19);
  if (kind === "start") console.log(`[pump:watch ${ts}] ${info}`);
  else if (kind === "admit") console.log(`[pump:watch ${ts}] + admit ${info}`);
  else if (kind === "tick") console.log(`[pump:watch ${ts}] tick: ${info}`);
  else console.log(`[pump:watch ${ts}] ${kind}: ${info}`);
});
process.on("SIGINT", () => { console.log("[pump:watch] stop."); stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
