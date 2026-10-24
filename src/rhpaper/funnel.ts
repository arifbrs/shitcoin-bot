/**
 * FUNNEL KANDIDAT→EKSEKUSI (round-8 P2) — `npm run rh:funnel`. OFFLINE, machine-generated.
 * Satu corong dengan hitungan SALING-KONSISTEN dari berkas nyata (cache kandidat + ledger),
 * setiap penolakan punya alasan primer + waktu. Scanner-accept ≠ fill-eligible — terpisah jelas.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { simNetFor } from "./fillmodel.js";
import { ROUND_TRIP_GAS_WEI } from "./engine.js";
import { join } from "node:path";

export interface FunnelCounts {
  opens: number; rejects: number; opensWithLiq: number; opensNoLiq: number;
  entrySimFilled: number; entrySimRejected: number;
  exitSignals: number; exitSimFilled: number; exitSimRejected: number; completed: number;
  invalidCloses: number; validCompletedIds: string[]; rejectReasons: Record<string, number>;
}

/** (FINAL P0-3) inti corong MURNI — bukti ketat, bisa diuji offline:
 *  COMPLETED hanya bila (a) tradeId unik & berpasangan OPEN↔CLOSE tunggal, (b) simFillEntry
 *  .filled===true di baris OPEN, (c) simFillExit.filled===true di baris CLOSE itu sendiri
 *  (BUKAN diwarisi dari state entry), (d) fillModelVersion OPEN & CLOSE ada dan sama.
 *  CLOSE tanpa simFillExit / tradeId ganda / versi beda = invalidCloses, TIDAK dihitung. */
export function countFunnel(rows: Array<Record<string, unknown>>): FunnelCounts {
  const out: FunnelCounts = { opens: 0, rejects: 0, opensWithLiq: 0, opensNoLiq: 0, entrySimFilled: 0,
    entrySimRejected: 0, exitSignals: 0, exitSimFilled: 0, exitSimRejected: 0, completed: 0,
    invalidCloses: 0, validCompletedIds: [], rejectReasons: {} };
  // (FINAL P0-3/P0-4) DUA-PASS: hitung SEMUA duplikat lebih dulu — tradeId dengan OPEN/CLOSE
  // ganda mana pun DITOLAK seluruhnya (bukan hanya kejadian kedua).
  const openAgg = new Map<string, { rows: Array<Record<string, unknown>> }>();
  const closeAgg = new Map<string, { rows: Array<Record<string, unknown>> }>();
  for (const j of rows) {
    const action = String(j.action ?? "");
    const id = String(j.tradeId ?? `${j.ts}:${j.token}`);
    if (action === "OPEN") { out.opens++; const a = openAgg.get(id) ?? { rows: [] }; a.rows.push(j); openAgg.set(id, a); }
    else if (action === "CLOSE") { out.exitSignals++; const a = closeAgg.get(id) ?? { rows: [] }; a.rows.push(j); closeAgg.set(id, a); }
    else if (action === "REJECT") { out.rejects++; const why = String(j.reason ?? "?"); out.rejectReasons[why] = (out.rejectReasons[why] ?? 0) + 1; }
  }
  for (const [id, a] of openAgg) {
    for (const j of a.rows) {
      if (typeof j.liquidityUsd === "number" && j.liquidityUsd > 0) out.opensWithLiq++; else out.opensNoLiq++;
      const s = j.simFillEntry as { filled?: boolean; reason?: string } | undefined;
      if (s?.filled === true) out.entrySimFilled++;
      else if (s) { out.entrySimRejected++; out.rejectReasons[`entry_sim:${s.reason ?? "?"}`] = (out.rejectReasons[`entry_sim:${s.reason ?? "?"}`] ?? 0) + 1; }
    }
  }
  for (const [id, a] of closeAgg) {
    const o = openAgg.get(id);
    const oRow = o?.rows[0];
    const es = oRow?.simFillEntry as { filled?: boolean } | undefined;
    const unique = a.rows.length === 1 && o?.rows.length === 1;
    for (const j of a.rows) {
      const xs = j.simFillExit as { filled?: boolean; reason?: string } | undefined;
      const openVersion = oRow?.fillModelVersion ?? null;
      const versionsMatch = openVersion != null && openVersion === j.fillModelVersion;
      if (es?.filled === true && xs?.filled === true && unique && versionsMatch) {
        out.completed++; out.validCompletedIds.push(id);
      } else if (xs?.filled === false) { out.exitSimRejected++; out.rejectReasons[`exit_sim:${xs.reason ?? "?"}`] = (out.rejectReasons[`exit_sim:${xs.reason ?? "?"}`] ?? 0) + 1; }
      else out.invalidCloses++; // duplikat / tanpa bukti / versi beda — dilaporkan, tidak dihitung
    }
  }
  return out;
}

/** Indeks CLOSE per tradeId (untuk bukti per-trade, validator sama dgn countFunnel). */
function closeAggForEvidence(rows: Array<Record<string, unknown>>): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const j of rows) if (String(j.action ?? "") === "CLOSE" && j.tradeId && !m.has(String(j.tradeId))) m.set(String(j.tradeId), j);
  return m;
}

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

  // STRATEGY_ELIGIBLE → OPEN / REJECT / CLOSE: dikumpulkan lalu dihitung oleh countFunnel()
  // (FINAL P0-3: fungsi murni, bukti ketat — TIDAK ADA jalur "bukti exit dari state entry").
  const rawRows: Array<Record<string, unknown>> = [];
  const files = readdirLedgers(dir);
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rawRows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* rusak dihitung terpisah */ }
    }
  }
  const fc = countFunnel(rawRows);
  const opens = fc.opens, rejects = fc.rejects, opensWithLiq = fc.opensWithLiq, opensNoLiq = fc.opensNoLiq;
  const entrySimFilled = fc.entrySimFilled, entrySimRejected = fc.entrySimRejected;
  const exitSignals = fc.exitSignals, exitSimFilled = fc.exitSimFilled, exitSimRejected = fc.exitSimRejected, completed = fc.completed;
  const rejectReasons = fc.rejectReasons;
  stages.push({ stage: "STRATEGY_ELIGIBLE (OPEN attempt)", count: opens, note: `REJECT=${rejects} (alasan: ${JSON.stringify(rejectReasons)})` },
    { stage: "LIQUIDITY_VERIFIED at entry (posisi)", count: opensWithLiq, note: `tanpa likuiditas (cache pra-R8)=${opensNoLiq}` },
    { stage: "ENTRY_SIM_FILLED", count: entrySimFilled, note: `ditolak model=${entrySimRejected}` },
    { stage: "EXIT_SIGNAL (CLOSE)", count: exitSignals },
    { stage: "EXIT_SIM_FILLED", count: exitSimFilled, note: `tak-bisa-keluar (model)=${exitSimRejected}` },
    { stage: "COMPLETED_SIM_TRADE", count: completed, note: `bukti ketat: OPEN↔CLOSE unik + simFillEntry.filled + simFillExit.filled + versi cocok; ditolak: ${fc.invalidCloses} baris CLOSE tidak-lengkap/ganda` });

  // (FINAL C) invarian konsistensi internal — funnel tidak boleh lolos dengan hitungan bocor.
  if (opens !== opensWithLiq + opensNoLiq) throw new Error(`funnel: OPEN ${opens} ≠ liq ${opensWithLiq} + no-liq ${opensNoLiq}`);
  if (entrySimFilled + entrySimRejected > opens) throw new Error("funnel: sim-entry melebihi OPEN");
  const rate = (n: number, d: number): number | null => (d > 0 ? Number((100 * n / d).toFixed(2)) : null);
  // (FINAL-2) BUKTI PER-TRADE: setiap COMPLETED_SIM_TRADE direkonstruksi dari snapshot aslinya.
  const completedTrades: Array<Record<string, unknown>> = [];
  const openRowById = new Map<string, Record<string, unknown>>();
  for (const j of rawRows) if (String(j.action ?? "") === "OPEN" && j.tradeId) openRowById.set(String(j.tradeId), j);
  // (P0-4) bukti per-trade memakai VALIDATOR YANG SAMA dengan hitungan ringkasan:
  const validIds = new Set(fc.validCompletedIds);
  for (const id of fc.validCompletedIds) {
    {
      const j = closeAggForEvidence(rawRows).get(id)!;
      const o = openRowById.get(id);
      const es = o?.simFillEntry as { filled?: boolean } | undefined;
      const xs = j.simFillExit as { filled?: boolean } | undefined;
      completedTrades.push({
        tradeId: id, arm: j.arm, symbol: j.symbol, token: j.token,
        openedAt: o?.ts, closedAt: j.ts, heldWhy: j.why,
        liquidityUsd: o?.liquidityUsd ?? null, liquiditySource: o?.liquiditySource ?? null,
        entryWethRaw: j.entryWethRaw, exitQuoteWethRaw: j.exitWethRaw,
        entrySimFill: o?.simFillEntry, exitSimFill: xs,
        netPctQuote: j.netPct,
        // (FINAL §2) OTORITAS TUNGGAL: net sim dari simNetFor (versi-sadar), bukan hitung sendiri.
        netPctSim: (() => { const o = openRowById.get(id); const es2 = o?.simFillEntry as { fillOutRaw?: string } | undefined; const xs2 = j.simFillExit as { fillOutRaw?: string } | undefined;
          if (typeof j.entryWethRaw !== "string" || typeof j.exitWethRaw !== "string") return null;
          return simNetFor({ version: j.fillModelVersion as string | null, entryWethRaw: j.entryWethRaw, exitQuoteWethRaw: j.exitWethRaw,
            entrySimFillOutRaw: es2?.fillOutRaw ?? null, exitSimFillOutRaw: xs2?.fillOutRaw ?? null }).netPct; })(),
        gasWeiPerRoundTrip: ROUND_TRIP_GAS_WEI.toString(), fillModelVersion: j.fillModelVersion ?? null,
      });
    }
  }
  return { generatedAt: new Date(now).toISOString(), calcVersion: "rh-funnel-p03", invalidCloses: fc.invalidCloses, completedTrades,
    stages, conversion: { dataValidPct: rate(dataValid, discovered), liquidityVerifiedPct: rate(liquidityVerified, dataValid),
      entrySimFilledPct: rate(entrySimFilled, opens), completedPct: rate(completed, opens) },
    distinctTokensDiscovered: uniqueTokens.size };
}

function readdirLedgers(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(); } catch { return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = funnel();
  console.log(JSON.stringify(r, null, 2));
  writeFileSync(join("logs", "rh-funnel-latest.json"), JSON.stringify(r, null, 2));
}
