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

const LATENCY_PCT_PER_SIDE = 0.5; // fillmodel-v1 (diekspos ulang agar laporan mandiri)
const GAS_WEI_PER_ROUND_TRIP = 11_400_000_000_000n;

interface CloseRow { arm: string; tradeId: string | null; netPct: number; grossPct: number; netWethRaw: bigint; cohortStatus: string; why: string; ts: number; fillModelVersion: string | null; token: string; peakPct: number | null; troughPct: number | null }

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
        troughPct: Number.isFinite(Number(j.troughPct)) ? Number(j.troughPct) : null });
    }
  }

  const lines: string[] = ["═══ KOHORT PAPER RH — rekonsiliasi penuh (round-5) ═══", "",
    `baris: ${files.length} ledger · CLOSE=${closes.length} · OPEN=${openRows} · REJECT=${rejectRows} · STUCK=${stuckRows} · rusak=${malformed}`,
    `kapital terpakai (Σ entryUsd, semua arm/kohort): $${capitalUsd.toFixed(2)}`,
    `total biaya gas termodel: ${closes.length} putaran × 11,4e12 wei = ${BigInt(closes.length) * GAS_WEI_PER_ROUND_TRIP} wei (≈1,14%/putaran pada 0,001 ETH; ABSOLUT wei, bukan persen tetap)`, ""];
  const json: Record<string, unknown> = { generatedAt: now, files: files.length, closeRows: closes.length, openRows, rejectRows, stuckRows, malformed, capitalUsd, arms: [] as unknown[] };

  for (const arm of [...new Set(closes.map((c) => c.arm))].sort()) {
    for (const cohort of ["PROSPECTIVE", "LEGACY_CARRYOVER"] as const) {
      const all = closes.filter((c) => c.arm === arm && c.cohortStatus === cohort && Number.isFinite(c.netPct));
      if (!all.length) continue;
      for (const overlay of ["quote-only", "fillmodel-v1"] as const) {
        const rows = overlay === "fillmodel-v1" ? all.filter((c) => c.fillModelVersion != null) : all.filter((c) => c.fillModelVersion == null);
        if (!rows.length) continue;
        const uniqueIds = new Set(rows.map((r) => r.tradeId ?? `no-id:${r.ts}:${r.token}`));
        const net = rows.map((r) => r.netPct);
        const sim = net.map((p) => p - 2 * LATENCY_PCT_PER_SIDE);
        const wins = sim.filter((p) => p > 0), losses = sim.filter((p) => p < 0);
        const sumWin = wins.reduce((a, b) => a + b, 0), sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
        const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);
        const expectancy = sim.reduce((a, b) => a + b, 0) / sim.length;
        const be = sumWin > 0 && losses.length ? (sumLoss / losses.length) / ((sumLoss / losses.length) + (sumWin / wins.length)) : 1;
        const ci = bootstrapCi(sim);
        const netWethSum = rows.reduce((acc, r) => acc + r.netWethRaw, 0n);
        const block = {
          arm, cohort, overlay, closeRows: rows.length, uniqueTrades: uniqueIds.size,
          grossPctSum: Number(rows.reduce((a, r) => a + (Number.isFinite(r.grossPct) ? r.grossPct : 0), 0).toFixed(4)),
          netPctSum: Number(net.reduce((a, b) => a + b, 0).toFixed(4)),
          netWethRawSum: netWethSum.toString(),
          winRateSim: Number((wins.length / sim.length * 100).toFixed(2)),
          avgWinnerSim: wins.length ? Number((sumWin / wins.length).toFixed(4)) : null,
          avgLoserSim: losses.length ? Number((sumLoss / losses.length).toFixed(4)) : null,
          profitFactorSim: Number.isFinite(pf) ? Number(pf.toFixed(4)) : (sumWin > 0 ? "inf" : 0),
          expectancySimPct: Number(expectancy.toFixed(4)),
          expectancySimCi95: [Number(ci.lo.toFixed(3)), Number(ci.hi.toFixed(3))],
          breakEvenWinRateOfRealizedDist: Number((be * 100).toFixed(2)),
          maxDrawdownPct: maxDrawdownPct(rows),
          exits: rows.reduce<Record<string, number>>((acc, r) => { acc[r.why] = (acc[r.why] ?? 0) + 1; return acc; }, {}),
        };
        lines.push(`arm ${arm} · ${cohort} · ${overlay}: baris CLOSE=${rows.length} · trade UNIK=${uniqueIds.size}`,
          `  gross Σ=${block.grossPctSum}% · net Σ=${block.netPctSum}% (${netWethSum.toString()} wei)`,
          `  sim(overlay latensi 1,0 pp): winrate=${block.winRateSim}% · rata menang=${block.avgWinnerSim ?? "—"}% · rata rugi=${block.avgLoserSim ?? "—"}% · PF=${block.profitFactorSim} · expectancy=${block.expectancySimPct}% CI95=${JSON.stringify(block.expectancySimCi95)}`,
          `  break-even winrate dari DISTRIBUSI REALISASI (bukan rumus threshold): ${block.breakEvenWinRateOfRealizedDist}% · MDD=${block.maxDrawdownPct}%`,
          `  exits: ${JSON.stringify(block.exits)}`);
        (json.arms as unknown[]).push(block);
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
