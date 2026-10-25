/**
 * `npm run pump:collect -- --mint <addr> [--fixture]` — mode MANUAL (tanpa Developer API):
 * admit mint eksplisit ke watchlist lalu jalankan SATU pass observasi (trades+candles+keputusan
 * bayangan+outcome marks). `--fixture` = demo deterministik DILABEL fixture (dikecualikan laporan).
 */
import "dotenv/config";
import { admit, loadWatchlist, saveWatchlist, policyFromEnv } from "./watchlist.js";
import { observePass } from "./observer.js";
import { append } from "./journal.js";
import { FIX_TRADES } from "./fixtures.js";
import { absorptionView } from "./absorption.js";
import { analyze, ANALYST_VERSION } from "./analyst.js";
import { decisionIdFor } from "./journal.js";
import { bondingCurvePda } from "./onchain-tape.js";

async function main(): Promise<void> {
  const mints = process.argv.filter((a, i, arr) => arr[i - 1] === "--mint");
  const fixture = process.argv.includes("--fixture");
  if (fixture) {
    console.log("[pump:collect] MODE FIXTURE - bukan bukti pasar (dikecualikan dari laporan).");
    const now = Date.now();
    const abs = absorptionView(FIX_TRADES);
    const out = analyze({ mint: "FixMint11111111111111111111111111111111111", ts: now, caller: null, absorption: abs, wick: null, early: null, liquidityUsd: null });
    append({ type: "shadow-decision", ts: now, mint: "FixMint11111111111111111111111111111111111", decisionId: decisionIdFor("FixMint11111111111111111111111111111111111", now, ANALYST_VERSION),
      admittedAt: now, decision: out.decision, strategyVersion: out.strategyVersion, marketSource: "fixture", fixture: true,
      socialFields: "UNAVAILABLE", callerIdentityConfidence: null, reasons: out.reasons, contraryEvidence: out.contraryEvidence, missingData: out.missingData,
      paperNotionalUsd: out.paperNotionalUsd, executionCostWarning: out.executionCostWarning, priceAtDecision: null,
      triggerIds: [{ id: "LARGE_BUY_SMALL_SELL_ABSORPTION", fires: abs.netFlowSol > 0 && abs.largeBuys.length > 0, evidence: "fixture" }], entryPolicies: null, skipReason: null });
    console.log(`  fixture -> ${out.decision}`);
    return;
  }
  if (!mints.length) { console.log("pemakaian: npm run pump:collect -- --mint <addr> [--mint <addr2>] | --fixture | kontinu: npm run pump:watch"); process.exitCode = 1; return; }
  const policy = policyFromEnv();
  const now = Date.now();
  let entries = loadWatchlist();
  for (const m of mints) {
    // (S11) kohor discovery TERPISAH: GMGN trending = backfill manual, BUKAN feed launch real-time.
    const res = admit(entries, { mint: m, source: "gmgn-trending", priority: 1_000_000, bondingCurveKey: bondingCurvePda(m) }, policy, 0, now);
    entries = res.entries;
    append({ type: "token-observed", ts: now, mint: m, source: "gmgn-trending", discoveredBy: "gmgn-trending-backfill", detectedAt: now });
    console.log(`  ${m.slice(0, 8)}... ${res.admitted ? "di-admit" : `DITOLAK: ${res.reason}`}`);
  }
  saveWatchlist(entries);
  const s = await observePass();
  console.log(`[pump:collect] pass: mints=${s.mints} candles+${s.newCandles} keputusan=${s.decisions} outcome obs=${s.observed} pend=${s.pending}`);
}
void main().catch((e) => { console.error(`[pump:collect] gagal: ${(e as Error).message}`); process.exitCode = 1; });
