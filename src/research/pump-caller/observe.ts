/** `npm run pump:observe` — satu pass outcome-mark (PENDING->OBSERVED/MISSING_FINAL, retry berbatas). */
import { observePass } from "./observer.js";
void observePass().then((s) => console.log(`[pump:observe] mints=${s.mints} keputusan=${s.decisions} outcome: obs=${s.observed} pend=${s.pending} miss=${s.missingFinal}`))
  .catch((e) => { console.error(`[pump:observe] gagal: ${(e as Error).message}`); process.exitCode = 1; });
