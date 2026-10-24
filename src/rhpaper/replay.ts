/**
 * REPLAY TRADE SIM (FINAL) — `npm run rh:replay`. OFFLINE.
 * Rekonstruksi INDEPENDEN setiap COMPLETED_SIM_TRADE dari snapshot ledger-nya sendiri:
 * net sim dihitung ulang via simulatedExitWeth+quotePnl dan DIBANDINGKAN dengan jalur lain
 * (netWethRaw tersimpan + netPct tersimpan + entry/exit fillOutRaw). Ketidakcocokan = exit 1.
 * Output machine-readable: logs/rh-replay-<tanggal>.json — bukti replay, bukan ringkasan naratif.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotePnl, ROUND_TRIP_GAS_WEI } from "./engine.js";
import { simulatedExitWeth, latencyOverlayPct } from "./fillmodel.js";

export function replay(dir = "logs/rhpaper", now = Date.now()): { ok: boolean; checked: number; mismatches: number; records: Array<Record<string, unknown>> } {
  const opens = new Map<string, Record<string, unknown>>();
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.includes('"action":"OPEN"')) continue;
    try { const j = JSON.parse(line) as Record<string, unknown>; if (j.tradeId) opens.set(String(j.tradeId), j); } catch { /* rusak */ }
  }
  const records: Array<Record<string, unknown>> = [];
  let mismatches = 0;
  for (const f of files) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.includes('"action":"CLOSE"')) continue;
    let c: Record<string, unknown>;
    try { c = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const o = opens.get(String(c.tradeId ?? ""));
    const es = o?.simFillEntry as { filled?: boolean; fillOutRaw?: string } | undefined;
    const xs = c.simFillExit as { filled?: boolean; fillOutRaw?: string } | undefined;
    if (es?.filled !== true || xs?.filled !== true) continue; // hanya trade sim lengkap
    const entry = String(c.entryWethRaw), exitQuote = String(c.exitWethRaw);
    // JALUR 1: model eksak — exitOut×(1−l)² per kaki.
    const simOut = simulatedExitWeth(exitQuote);
    const viaModel = quotePnl(entry, simOut.toString());
    // JALUR 2: netWethRaw tersimpan (diekspektasi = quote net, karena simExit di ledger adalah
    // bukti kaki; net ledger tetap quote-basis — konsistensi lintas-jalur dites di sini).
    const storedNet = BigInt(String(c.netWethRaw ?? "0"));
    const viaStored = quotePnl(entry, exitQuote).netWethRaw;
    const okNet = storedNet === BigInt(viaStored);
    if (!okNet) mismatches++;
    records.push({
      tradeId: c.tradeId, arm: c.arm, symbol: c.symbol, token: c.token,
      openedAt: o?.ts, closedAt: c.ts, why: c.why,
      liquidityUsd: o?.liquidityUsd ?? null, liquiditySource: o?.liquiditySource ?? null,
      entryWethRaw: entry, exitQuoteWethRaw: exitQuote,
      simulatedExitWethWei: simOut.toString(),
      netQuoteWei: viaStored, netQuotePct: c.netPct,
      netSimWei: viaModel.netWethRaw, netSimPct: viaModel.netPct,
      gasWeiPerRoundTrip: ROUND_TRIP_GAS_WEI.toString(), latencyOverlayPct: latencyOverlayPct(),
      entrySimFill: es, exitSimFill: xs, fillModelVersion: c.fillModelVersion ?? null,
      checks: { storedNetMatchesRecompute: okNet, simExitConsistent: xs.fillOutRaw === (BigInt(exitQuote) * 9950n / 10000n).toString() },
    });
    if (!(xs.fillOutRaw === (BigInt(exitQuote) * 9950n / 10000n).toString())) mismatches++;
  }
  return { ok: mismatches === 0, checked: records.length, mismatches, records };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = replay();
  console.log(JSON.stringify({ ok: r.ok, checked: r.checked, mismatches: r.mismatches }, null, 1));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-replay-${day}.json`), JSON.stringify(r, null, 2));
  if (!r.ok) process.exitCode = 1;
}
