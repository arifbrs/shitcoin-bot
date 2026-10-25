/** `npm run pump:observe` — isi outcome marks idempoten dari candle 1m. */
import { observe } from "./runner.js";
void observe().catch((e) => { console.error(`[pump:observe] gagal: ${(e as Error).message}`); process.exitCode = 1; });
