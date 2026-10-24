/**
 * STATISTIK KOHORT PAPER RH (round-4 #8, diperluas round-5 #4) — `npm run rh:cohort-stats`. OFFLINE.
 *
 * Rekonsiliasi penuh atas SEMUA baris ledger logs/rhpaper:
 *   CLOSE dipilah: PROSPECTIVE vs LEGACY_CARRYOVER × quote-only (tanpa fillModelVersion) vs
 *   fillmodel-v1 overlay × arm A/B/C × exit reason. Kursor trade = tradeId UNIK (baris MARK
 *   berulang tidak pernah dihitung dua kali — hitungan trade independen dari hitungan baris).
 * Metrik per arm×kohort: n-trade unik, PnL gross/net (Σ netWethRaw), winrate, rata pemenang/
 * pecundang, profit factor, expectancy, max drawdown (kurva ekuitas dari CLOSE berurutan),
 * total biaya termodel, CI95 bootstrap (seed tetap), pemakaian modal (Σ OPEN entryUsd),
 * laju REJECT/STUCK.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { latencyOverlayPct, DEFAULT_ASSUMPTIONS } from "./fillmodel.js";
import { gasPctForNotional } from "./breakeven.js";
import { quotePnl } from "./engine.js";
const LATENCY_PCT_PER_SIDE = DEFAULT_ASSUMPTIONS.latencySlippagePct; // SATU SUMBER: fillmodel-v1
const OVERLAY_PP = latencyOverlayPct(); // eksak: (1-(1-lat)^2)*100
const GAS_WEI_PER_ROUND_TRIP = 11_400_000_000_000n;

interface CloseRow { arm: string; tradeId: string | null; netPct: number; grossPct: number; netWethRaw: bigint; cohortStatus: string; why: string; ts: number; fillModelVersion: string | null; token: string; peakPct: number | null; troughPct: number | null; entryWethRaw: string | null; fillOutRaw: string | null; version: string; simEntryFilled: boolean | null; simExitFilled: boolean | null }

function bootstrapCi(values: number[], resamples = 2000, seed = 42): { lo: number; hi: number } {
  if (!values.length) return { lo: NaN, hi: NaN };
  let s = seed >>> 0;
  const rnd = (): number => (s = (s * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;
  const means: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let k = 0; k < values.length; k++) sum += values[Math.floor(rnd() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(0.025 * (means.length - 1))]!, hi: means[Math.floor(0.975 * (means.length - 1))]! };
}

function maxDrawdownPct(rows: CloseRow[]): number {
  // Kurva ekuitas dari netWethRaw kumulatif (urut waktu); MDD = penurunan terdalam dari puncak, %.
  let peak = 0n, equity = 0n, mdd = 0;
  for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
    equity += r.netWethRaw;
    if (equity > peak) peak = equity;
    if (peak > 0n) {
      const dd = Number((peak - equity) * 10_000n / peak) / 100;
      if (dd > mdd) mdd = dd;
    }
  }
  return mdd;
}

export function cohortStats(now = Date.now(), dir = "logs/rhpaper"): { lines: string[]; json: Record<string, unknown>; summary: string } {
  const closes: CloseRow[] = [];
  let openRows = 0, rejectRows = 0, stuckRows = 0, malformed = 0, capitalUsd = 0;
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { malformed++; continue; }
      const action = String(j.action ?? "");
      if (action === "OPEN") { openRows++; capitalUsd += Number(j.usd ?? 0) || 0; continue; }
      if (action === "REJECT") { rejectRows++; continue; }
      if (action === "STUCK") { stuckRows++; continue; }
      if (action !== "CLOSE") continue;
      const netRaw = typeof j.netWethRaw === "string" && /^\d+$/.test(j.netWethRaw.replace("-", "")) ? BigInt(j.netWethRaw) : 0n;
      closes.push({ arm: String(j.arm ?? "?"), tradeId: typeof j.tradeId === "string" ? j.tradeId : null,
        netPct: Number(j.netPct ?? NaN), grossPct: Number(j.grossPct ?? NaN), netWethRaw: netRaw,
        cohortStatus: String(j.cohortStatus ?? "?"), why: String(j.why ?? "?"), ts: Number(j.ts ?? 0),
        fillModelVersion: typeof j.fillModelVersion === "string" ? j.fillModelVersion : null,
        token: String(j.token ?? "?"), peakPct: Number.isFinite(Number(j.peakPct)) ? Number(j.peakPct) : null,
        troughPct: Number.isFinite(Number(j.troughPct)) ? Number(j.troughPct) : null,
        entryWethRaw: typeof j.entryWethRaw === "string" && /^\d+$/.test(j.entryWethRaw) ? j.entryWethRaw : null,
        version: typeof j.measurementVersion === "string" ? j.measurementVersion : "pre-units(v0, netPct=gross)",
        simEntryFilled: (() => { const s = j.simFillEntry as { filled?: boolean } | undefined; return s && typeof s.filled === "boolean" ? s.filled : null; })(),
        simExitFilled: (() => { const s = j.simFillExit as { filled?: boolean } | undefined; return s && typeof s.filled === "boolean" ? s.filled : null; })(),
        fillOutRaw: (() => { const s = j.simFillExit as { fillOutRaw?: string } | undefined; return typeof s?.fillOutRaw === "string" && /^\d+$/.test(s.fillOutRaw) ? s.fillOutRaw : null; })() });
    }
  }

  // (R7 P2) PILAHAN SALING-LEPAS: v0 | v3-quote | v3-fillmodel — jumlah HARUS = total CLOSE.
  const v0 = closes.filter((c) => c.version !== "rhpaper-units-arm-v3").length;
  const v3plain = closes.filter((c) => c.version === "rhpaper-units-arm-v3" && c.fillModelVersion == null).length;
  const v3fm = closes.filter((c) => c.version === "rhpaper-units-arm-v3" && c.fillModelVersion != null).length;
  const breakdownSum = v0 + v3plain + v3fm;
  const breakdownOk = breakdownSum === closes.length;

  const lines: string[] = ["═══ KOHORT PAPER RH — rekonsiliasi penuh (round-7) ═══", "",
    `PILAHAN AKUNTANSI (saling-lepas, wajib berjumlah total): v0(gross, tanpa gas)=${v0} · v3-quote-only=${v3plain} · v3-fillmodel-v1=${v3fm} · jumlah=${breakdownSum} vs CLOSE=${closes.length} → ${breakdownOk ? "COCOK ✓" : "TIDAK COCOK ✗"}`,
    `  ${v3fm} baris fillmodel ADA DI DALAM ${v3plain + v3fm} baris v3 (nested, bukan tambahan). Baris v0: PnL asli = gross`,
    `  (basis keputusan engine saat itu); normalisasi biaya = HIPOTETIS, tidak pernah jadi hasil prospektif.`, "",
    `baris: ${files.length} ledger · CLOSE=${closes.length} · OPEN=${openRows} · REJECT=${rejectRows} · STUCK=${stuckRows} · rusak=${malformed}`,
    `kapital terpakai (Σ entryUsd, semua arm/kohort): $${capitalUsd.toFixed(2)}`,
    `total biaya gas termodel: ${closes.length} putaran × 11,4e12 wei = ${BigInt(closes.length) * GAS_WEI_PER_ROUND_TRIP} wei (≈1,14%/putaran pada 0,001 ETH; ABSOLUT wei, bukan persen tetap)`, ""];
  const json: Record<string, unknown> = {
    calcVersion: "cohort-stats-r7 (basis v0/v3 terpisah; overlay latensi eksak dari fillmodel)",
    dataset: { ledgerFiles: files, generatedAt: new Date(now).toISOString() },
    costAssumptions: { gasWeiPerRoundTrip: GAS_WEI_PER_ROUND_TRIP.toString(), gasBasis: "wei ABSOLUT (1,14% hanya @0,001 ETH)",
      latencyOverlayPct: OVERLAY_PP, latencySource: "fillmodel-v1 ASUMSI (belum terkalibrasi fill nyata)",
      quoteFees: "terkandung dalam quote OKX (tidak dihitung terpisah)" },
    accountingBreakdown: { v0GrossBasis: v0, v3QuoteOnly: v3plain, v3FillmodelV1: v3fm, sum: breakdownSum, matchesCloseTotal: breakdownOk },
    generatedAt: now, files: files.length, closeRows: closes.length, openRows, rejectRows, stuckRows, malformed, capitalUsd, arms: [] as unknown[] };

  for (const arm of [...new Set(closes.map((c) => c.arm))].sort()) {
    for (const version of [...new Set(closes.map((c) => c.version))].sort()) {
    for (const cohort of ["PROSPECTIVE", "LEGACY_CARRYOVER"] as const) {
      const all = closes.filter((c) => c.arm === arm && c.cohortStatus === cohort && c.version === version && Number.isFinite(c.netPct));
      if (!all.length) continue;
      for (const overlay of ["quote-only", "fillmodel-v1"] as const) {
        const rows = overlay === "fillmodel-v1" ? all.filter((c) => c.fillModelVersion != null) : all.filter((c) => c.fillModelVersion == null);
        if (!rows.length) continue;
        const uniqueIds = new Set(rows.map((r) => r.tradeId ?? `no-id:${r.ts}:${r.token}`));
        const net = rows.map((r) => r.netPct);
        // (R6 P2) sim per-trade dari SATU sumber: baris overlay → jalur fillOutRaw eksak (model);
        // baris quote-only → overlay pp tunggal dari fillmodel (dilabel analitik, tak pernah digabung).
        // (R7 P3) basis per VERSI — tidak pernah dicampur. ALJABAR latensi (satu mekanisme, dua kaki):
        //  entry fill → token ×(1−l); exit fill atas token itu → WETH ×(1−l); putaran = ×(1−l)²
        //  → overlay putaran eksak = latencyOverlayPct() = 1−(1−l)². fillOutRaw per-kaki adalah
        //  BUKTI tiap kaki, BUKAN dasar PnL putaran (pakai fillOutRaw saja = kurang satu (1−l)).
        //  v3: sim = netPct − overlay (eksak). v0: netPct = GROSS → normalisasi − gas − overlay.
        // (R7 P3) sim trade = entry-fill DAN exit-fill lolos model; sisanya kategori terpisah
        // (simNoEntry = model tak akan membuka; simNoExit = model tak bisa keluar → unrealized,
        // BUKAN rugi sim). Sim net eksak = netPct − overlay((1−l)² komposit) untuk simTrade.
        const simTradeRows = rows.filter((r) => r.simEntryFilled === true && r.simExitFilled === true);
        const simNoEntry = rows.filter((r) => r.simEntryFilled === false).length;
        const simNoExit = rows.filter((r) => r.simExitFilled === false).length;
        const sim = simTradeRows.map((r) => {
          if (version === "rhpaper-units-arm-v3") return r.netPct - OVERLAY_PP;
          const gasPct = r.entryWethRaw != null ? gasPctForNotional(GAS_WEI_PER_ROUND_TRIP, BigInt(r.entryWethRaw)) : gasPctForNotional(GAS_WEI_PER_ROUND_TRIP, 1_000_000_000_000_000n);
          return r.netPct - gasPct - OVERLAY_PP;
        });
        const wins = sim.filter((p) => p > 0), losses = sim.filter((p) => p < 0);
        const sumWin = wins.reduce((a, b) => a + b, 0), sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
        const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);
        const expectancy = sim.length ? sim.reduce((a, b) => a + b, 0) / sim.length : 0;
        const be = sumWin > 0 && losses.length ? (sumLoss / losses.length) / ((sumLoss / losses.length) + (sumWin / wins.length)) : 1;
        const ci = bootstrapCi(sim);
        const netWethSum = rows.reduce((acc, r) => acc + r.netWethRaw, 0n);
        const block = {
          arm, cohort, overlay, closeRows: rows.length, uniqueTrades: uniqueIds.size,
          grossPctSum: Number(rows.reduce((a, r) => a + (Number.isFinite(r.grossPct) ? r.grossPct : 0), 0).toFixed(4)),
          netPctSum: Number(net.reduce((a, b) => a + b, 0).toFixed(4)),
          netWethRawSum: netWethSum.toString(),
          winRateSim: sim.length ? Number((wins.length / sim.length * 100).toFixed(2)) : null,
          simTrades: simTradeRows.length, simNotEntered: simNoEntry, simUnexitable: simNoExit,
          avgWinnerSim: wins.length ? Number((sumWin / wins.length).toFixed(4)) : null,
          avgLoserSim: losses.length ? Number((sumLoss / losses.length).toFixed(4)) : null,
          profitFactorSim: Number.isFinite(pf) ? Number(pf.toFixed(4)) : (sumWin > 0 ? "inf" : 0),
          expectancySimPct: Number(expectancy.toFixed(4)),
          expectancySimCi95: [Number(ci.lo.toFixed(3)), Number(ci.hi.toFixed(3))],
          breakEvenWinRateOfRealizedDist: sim.length ? Number((be * 100).toFixed(2)) : null,
          maxDrawdownPct: maxDrawdownPct(rows),
          exits: rows.reduce<Record<string, number>>((acc, r) => { acc[r.why] = (acc[r.why] ?? 0) + 1; return acc; }, {}),
        };
        lines.push(`arm ${arm} · ${version} · ${cohort} · ${overlay}: baris CLOSE=${rows.length} · trade UNIK=${uniqueIds.size}`,
          `  gross Σ=${block.grossPctSum}% · net Σ=${block.netPctSum}% (${netWethSum.toString()} wei)`,
          `  sim(overlay ${OVERLAY_PP.toFixed(4)} pp): winrate=${block.winRateSim}% · rata menang=${block.avgWinnerSim ?? "—"}% · rata rugi=${block.avgLoserSim ?? "—"}% · PF=${block.profitFactorSim} · expectancy=${block.expectancySimPct}% CI95=${JSON.stringify(block.expectancySimCi95)}`,
          `  break-even dari distribusi realisasi: ${block.breakEvenWinRateOfRealizedDist == null ? "— (0 sim trade layak)" : block.breakEvenWinRateOfRealizedDist + "%"} · MDD=${block.maxDrawdownPct}% · sim tidak-buka/sim tak-bisa-keluar: ${block.simNotEntered ?? 0}/${block.simUnexitable ?? 0}`,
          `  exits: ${JSON.stringify(block.exits)}`);
        (json.arms as unknown[]).push(block);
      }
    }
    }
  }
  lines.push("", "BATAS JUJUR (round-5): 'break-even dari distribusi realisasi' ≠ rumus threshold — keduanya dilaporkan",
    "terpisah dan TIDAK saling menggantikan. Rumus threshold net: BE=(SL+d)/(TP+SL); d=1,0 pp (latensi)",
    "→ A 71,4% · B 50,0% · C 42,9% (teruji analitik di breakeven.test.ts). Dengan n sekecil ini TIDAK ADA",
    "verdict empiris strategi — ENGINE FUNCTIONAL, PROFITABILITY NOT YET VALIDATED tetap berlaku.");
  return { lines, json, summary: `closes=${closes.length} open=${openRows} reject=${rejectRows} arms=${new Set(closes.map((c) => c.arm)).size}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = cohortStats();
  console.log(r.lines.join("\n"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-cohort-stats-${day}.md`), r.lines.join("\n") + "\n");
  writeFileSync(join("logs", `rh-cohort-stats-${day}.json`), JSON.stringify(r.json, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
