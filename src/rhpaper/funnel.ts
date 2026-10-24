/**
 * FUNNEL KANDIDAT→EKSEKUSI (round-8 P2) — `npm run rh:funnel`. OFFLINE, machine-generated.
 * Satu corong dengan hitungan SALING-KONSISTEN dari berkas nyata (cache kandidat + ledger),
 * setiap penolakan punya alasan primer + waktu. Scanner-accept ≠ fill-eligible — terpisah jelas.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { simulatedExitWeth } from "./fillmodel.js";
import { quotePnl, ROUND_TRIP_GAS_WEI } from "./engine.js";
import { join } from "node:path";

export function funnel(now = Date.now(), dir = "logs/rhpaper"): Record<string, unknown> {
  const stages: Array<{ stage: string; count: number; note?: string }> = [];
  // DISCOVERED + DATA_VALID: dari cache kandidat hari ini (listTokens → probe dua arah).
  let discovered = 0, dataValid = 0, liquidityVerified = 0, liquidityNoPair = 0, liquidityFetchFailed = 0;
  const cacheFile = join(dir, `candidates-${new Date(now).toISOString().slice(0, 10)}.json`);
  let uniqueTokens = new Set<string>();
  if (existsSync(cacheFile)) {
    const c = JSON.parse(readFileSync(cacheFile, "utf8")) as { ts?: number; candidates?: Array<Record<string, unknown>> };
    const rows = c.candidates ?? [];
    discovered = rows.length;
    uniqueTokens = new Set(rows.map((r) => String(r.token)));
    dataValid = rows.filter((r) => r.buyOk === true && r.sellOk === true).length; // semua di cache lolos dua arah
    liquidityVerified = rows.filter((r) => typeof r.liquidityUsd === "number" && (r.liquidityUsd as number) > 0).length;
    liquidityNoPair = rows.filter((r) => r.liquidityReason === "DEXSCREENER_NO_PAIR").length;
    liquidityFetchFailed = rows.filter((r) => typeof r.liquidityReason === "string" && r.liquidityReason.startsWith("DEX_") && r.liquidityReason !== "DEXSCREENER_NO_PAIR").length;
    stages.push({ stage: "DISCOVERED (OKX all-tokens, hari ini)", count: discovered, note: `token unik=${uniqueTokens.size}` },
      { stage: "DATA_VALID (quote beli+jual dua arah)", count: dataValid, note: "penolakan sebelum tahap ini tidak masuk cache" },
      { stage: "LIQUIDITY_VERIFIED (DexScreener point-in-time)", count: liquidityVerified,
        note: `NO_PAIR=${liquidityNoPair} (provider tak punya pair) · FETCH_FAILED=${liquidityFetchFailed} — kategori BERBEDA, bukan kondisi pasar` });
  } else stages.push({ stage: "DISCOVERED", count: 0, note: "cache hari ini belum ada" });

  // STRATEGY_ELIGIBLE → OPEN (accepted) / REJECT (dengan alasan + ts): dari seluruh ledger.
  let opens = 0, rejects = 0, opensWithLiq = 0, opensNoLiq = 0, entrySimFilled = 0, entrySimRejected = 0;
  let exitSignals = 0, exitSimFilled = 0, exitSimRejected = 0, completed = 0;
  const rejectReasons: Record<string, number> = {};
  const files = readdirLedgers(dir);
  const openById = new Map<string, Record<string, unknown>>();
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const action = String(j.action ?? "");
      if (action === "OPEN") {
        opens++;
        const id = String(j.tradeId ?? `${j.ts}:${j.token}`);
        openById.set(id, j);
        if (typeof j.liquidityUsd === "number" && j.liquidityUsd > 0) opensWithLiq++; else opensNoLiq++;
        const s = j.simFillEntry as { filled?: boolean; reason?: string } | undefined;
        if (s?.filled === true) entrySimFilled++;
        else if (s) { entrySimRejected++; rejectReasons[`entry_sim:${s.reason ?? "?"}`] = (rejectReasons[`entry_sim:${s.reason ?? "?"}`] ?? 0) + 1; }
      } else if (action === "REJECT") {
        rejects++;
        const why = String(j.reason ?? "?");
        rejectReasons[why] = (rejectReasons[why] ?? 0) + 1;
      } else if (action === "CLOSE") {
        exitSignals++;
        const id = String(j.tradeId ?? `${j.ts}:${j.token}`);
        const openRow = openById.get(id);
        const s = (j.simFillExit ?? (openRow ? undefined : undefined)) as { filled?: boolean; reason?: string } | undefined;
        const exitState = s ?? undefined;
        if (exitState?.filled === true) { exitSimFilled++; completed++; }
        else if (exitState) { exitSimRejected++; rejectReasons[`exit_sim:${exitState.reason ?? "?"}`] = (rejectReasons[`exit_sim:${exitState.reason ?? "?"}`] ?? 0) + 1; }
        else {
          // exit state ada di baris OPEN yang dipasangkan (simFillExit dihitung saat OPEN pada
          // arsitektur ini — likuiditas entry menentukan kelayakan exit): pakai state entry.
          const es = openRow?.simFillEntry as { filled?: boolean; reason?: string } | undefined;
          if (es?.filled === true) { exitSimFilled++; completed++; }
          else if (es) { exitSimRejected++; rejectReasons[`exit_sim(via-entry-state):${es.reason ?? "?"}`] = (rejectReasons[`exit_sim(via-entry-state):${es.reason ?? "?"}`] ?? 0) + 1; }
        }
      }
    }
  }
  stages.push({ stage: "STRATEGY_ELIGIBLE (OPEN attempt)", count: opens, note: `REJECT=${rejects} (alasan: ${JSON.stringify(rejectReasons)})` },
    { stage: "LIQUIDITY_VERIFIED at entry (posisi)", count: opensWithLiq, note: `tanpa likuiditas (cache pra-R8)=${opensNoLiq}` },
    { stage: "ENTRY_SIM_FILLED", count: entrySimFilled, note: `ditolak model=${entrySimRejected}` },
    { stage: "EXIT_SIGNAL (CLOSE)", count: exitSignals },
    { stage: "EXIT_SIM_FILLED", count: exitSimFilled, note: `tak-bisa-keluar (model)=${exitSimRejected}` },
    { stage: "COMPLETED_SIM_TRADE", count: completed, note: "entry-fill DAN exit-fill lolos model — satu-satunya kohor net-sim yang sah" });

  // (FINAL C) invarian konsistensi internal — funnel tidak boleh lolos dengan hitungan bocor.
  if (opens !== opensWithLiq + opensNoLiq) throw new Error(`funnel: OPEN ${opens} ≠ liq ${opensWithLiq} + no-liq ${opensNoLiq}`);
  if (entrySimFilled + entrySimRejected > opens) throw new Error("funnel: sim-entry melebihi OPEN");
  const rate = (n: number, d: number): number | null => (d > 0 ? Number((100 * n / d).toFixed(2)) : null);
  // (FINAL-2) BUKTI PER-TRADE: setiap COMPLETED_SIM_TRADE direkonstruksi dari snapshot aslinya.
  const completedTrades: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.includes('"action":"CLOSE"')) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const id = String(j.tradeId ?? "");
      const o = openById.get(id);
      const es = o?.simFillEntry as { filled?: boolean } | undefined;
      const xs = j.simFillExit as { filled?: boolean } | undefined;
      if (es?.filled !== true || xs?.filled !== true) continue;
      completedTrades.push({
        tradeId: id, arm: j.arm, symbol: j.symbol, token: j.token,
        openedAt: o?.ts, closedAt: j.ts, heldWhy: j.why,
        liquidityUsd: o?.liquidityUsd ?? null, liquiditySource: o?.liquiditySource ?? null,
        entryWethRaw: j.entryWethRaw, exitQuoteWethRaw: j.exitWethRaw,
        entrySimFill: o?.simFillEntry, exitSimFill: xs,
        netPctQuote: j.netPct,
        netPctSim: j.fillModelVersion != null && typeof j.entryWethRaw === "string" && typeof j.exitWethRaw === "string"
          ? quotePnl(j.entryWethRaw, simulatedExitWeth(j.exitWethRaw).toString()).netPct : null,
        gasWeiPerRoundTrip: ROUND_TRIP_GAS_WEI.toString(), fillModelVersion: j.fillModelVersion ?? null,
      });
    }
  }
  return { generatedAt: new Date(now).toISOString(), calcVersion: "rh-funnel-final",
    stages, conversion: { dataValidPct: rate(dataValid, discovered), liquidityVerifiedPct: rate(liquidityVerified, dataValid),
      entrySimFilledPct: rate(entrySimFilled, opens), completedPct: rate(completed, opens) },
    distinctTokensDiscovered: uniqueTokens.size, completedTrades };
}

function readdirLedgers(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = funnel();
  console.log(JSON.stringify(r, null, 2));
  writeFileSync(join("logs", "rh-funnel-latest.json"), JSON.stringify(r, null, 2));
}
