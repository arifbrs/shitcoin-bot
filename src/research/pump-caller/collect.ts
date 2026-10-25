/**
 * COLLECTOR LANE PUMP-CALLER — `npm run pump:collect [-- --mint <addr> ...]`.
 * Zero-capital, read-only. Alur per mint:
 *   token-observed → tape trades (swap-api) → candle 1s/1m → caller (Developer API bila ada
 *   kunci; TANPA kunci caller = missing-data eksplisit) → absorption + wick + latensi →
 *   keputusan bayangan analis → jurnal. Tidak ada eksekusi/penandatanganan.
 * Tanpa PUMPFUN_API_KEY: home-feed/callout/user-* = BLOCKED_EXTERNAL (dilaporkan, bukan dikarang);
 * mint harus diberikan eksplisit (watchlist operator) — deteksi otomatis butuh feed.
 */
import "dotenv/config";
import { pumpfunApi, swapApiTrades, swapApiCandles } from "./pumpfun-api.js";
import { absorptionView } from "./absorption.js";
import { wickContext } from "./wicks.js";
import { latencyView } from "./early-detection.js";
import { analyze } from "./analyst.js";
import { append, decisionIdFor } from "./journal.js";
import { FIX_TRADES } from "./fixtures.js";

async function main(): Promise<void> {
  const mints = process.argv.filter((a, i, arr) => arr[i - 1] === "--mint");
  const fixture = process.argv.includes("--fixture");
  const solUsd = await solUsdOf();
  if (!mints.length && !fixture) {
    const feed = await pumpfunApi.homeFeedNew();
    if (feed.ok) {
      console.log(`[pump:collect] home-feed OK — ${feed.data.length} item (mode otomatis)`);
      for (const item of feed.data.slice(0, 10)) if (item.mint) await processMint(item.mint, solUsd);
      return;
    }
    console.log(`[pump:collect] home-feed TIDAK TERSEDIA (${feed.reason}) — berikan mint: npm run pump:collect -- --mint <addr> [--fixture utk uji offline]`);
    process.exitCode = 1;
    return;
  }
  if (fixture) { console.log("[pump:collect] MODE FIXTURE — keputusan dari data deterministik; BUKAN bukti pasar."); await processMint("FixMint11111111111111111111111111111111111", solUsd, true); return; }
  for (const m of mints) await processMint(m, solUsd);
}

async function processMint(mint: string, solUsd: number | null, fixture = false): Promise<void> {
  const now = Date.now();
  append({ type: "token-observed", ts: now, mint, source: fixture ? "fixture" : "manual" });
  const trades = fixture ? FIX_TRADES : await swapApiTrades(mint, solUsd);
  if (!trades) { console.log(`  ${mint.slice(0, 8)}… tape trades TIDAK TERSEDIA (best-effort → jurnal tanpa tape)`); }
  else {
    append({ type: "trade-batch", ts: now, mint, count: trades.length, from: trades[0]?.ts, to: trades[trades.length - 1]?.ts, source: fixture ? "fixture" : "swap-api" });
    for (const t of trades) append({ type: "trade", ...t, source: fixture ? "fixture" : "swap-api" });
  }
  const candles1s = fixture ? [] : (await swapApiCandles(mint, "1s", 30)) ?? [];
  const candles1m = fixture ? [] : (await swapApiCandles(mint, "1m", 20)) ?? [];
  if (candles1s.length) append({ type: "candle-snapshot", ts: now, mint, interval: "1s", fromTs: candles1s[0]!.ts, count: candles1s.length });
  if (candles1m.length) append({ type: "candle-snapshot", ts: now, mint, interval: "1m", fromTs: candles1m[0]!.ts, count: candles1m.length });
  // Caller: hanya bila Developer API tersedia (BLOCKED_EXTERNAL tanpa kunci).
  let caller: Parameters<typeof analyze>[0]["caller"] = null;
  if (pumpfunApi.hasKey()) {
    const pos = await pumpfunApi.mintPositions(mint);
    if (pos.ok) {
      for (const p of pos.data.slice(0, 5)) append({ type: "caller-position", ts: now, mint, callerId: p.userId, providerPosition: p, source: "pumpfun-developer-api" });
      const first = pos.data[0];
      if (first) caller = { callerId: first.userId, mint, state: (first.tokenAmount ?? 0) > 0 ? "HOLDING" : "EXITED", observedBuysSol: 0, observedSellsSol: 0, observedTokenBalance: first.tokenAmount ?? null, lastEventTs: null, eventCount: pos.data.length, realizedPnlEstimateSol: first.realizedPnl ?? null, unrealizedPnlEstimateSol: first.unrealizedPnl ?? null, evidence: "provider-position", note: "posisi provider (bukan rekonstruksi wallet)" };
    } else console.log(`  caller: ${pos.reason}`);
  }
  const abs = trades ? absorptionView(trades, undefined, null, candles1s) : null;
  const lastCandle = candles1s.length ? candles1s[candles1s.length - 1]! : candles1m.length ? candles1m[candles1m.length - 1]! : null;
  const prevLow = candles1s.length > 1 ? candles1s[candles1s.length - 2]!.low : undefined;
  const wick = lastCandle ? wickContext(lastCandle, prevLow) : null;
  const out = analyze({ mint, ts: now, caller, absorption: abs, wick, early: null, liquidityUsd: null });
  const decisionId = decisionIdFor(mint, out.decidedAt, out.strategyVersion);
  append({ type: "shadow-decision", ts: now, mint, decisionId, decision: out.decision, strategyVersion: out.strategyVersion, reasons: out.reasons, contraryEvidence: out.contraryEvidence, missingData: out.missingData, paperNotionalUsd: out.paperNotionalUsd, executionCostWarning: out.executionCostWarning, priceAtDecision: lastCandle?.close ?? null });
  console.log(`  ${mint.slice(0, 8)}… → ${out.decision}${out.paperNotionalUsd ? ` ($${out.paperNotionalUsd})` : ""} · alasan: ${out.reasons.join("; ") || "—"} · data-hilang: ${out.missingData.join("; ") || "—"}`);
  if (!fixture) console.log(`    latensi: BLOCKED tanpa Developer API (caller timeline tak teramati); tape/candle bebas-kunci OK`);
  void latencyView; // dipakai saat timeline caller tersedia
}

async function solUsdOf(): Promise<number | null> {
  try {
    const r = await fetch("https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5_000) });
    const j = (await r.json()) as Record<string, { usdPrice?: number }>;
    const first = Object.values(j)[0];
    return first?.usdPrice ?? null;
  } catch { return null; }
}

void main().catch((e) => { console.error(`[pump:collect] gagal: ${(e as Error).message}`); process.exitCode = 1; });
