/**
 * STATISTIK KOHORT PAPER RH (FINAL — BLOCKER 1) — `npm run rh:cohort-stats`. OFFLINE.
 *
 * SATU OTORITAS: net-sim setiap trade dihitung oleh `simNetFor()` (fillmodel) — modul ini
 * TIDAK lagi memanggil simulatedExitWeth atau menghitung overlay sendiri untuk baris ber-model.
 * Pilahan saling-lepas (wajib berjumlah total): quote-only · v1 · v2-defective (BEKU — dikecualikan
 * dari validasi profitabilitas strategi, hasil historis dipertahankan) · v3.
 * Populasi trade = tradeId UNIK yang lulus VALIDATOR YANG SAMA dengan funnel (countFunnel —
 * pasangan unik, simFillEntry+simFillExit terisi, versi cocok). v0 (gross, tanpa gas) dinormalisasi
 * terpisah dan DILABEL HIPOTETIS — tidak pernah mencampur basis ke kohor net.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countFunnel } from "./funnel.js";
import { simNetFor, latencyOverlayPct, DEFAULT_ASSUMPTIONS, quoteNet } from "./fillmodel.js";
import { gasPctForNotional } from "./breakeven.js";

const GAS_WEI_PER_ROUND_TRIP = 11_400_000_000_000n; // paritas dgn engine.ROUND_TRIP_GAS_WEI (dites)
const OVERLAY_PP = latencyOverlayPct(); // eksak (1-(1-lat)^2)*100 — dipakai HANYA utk normalisasi v0

interface CloseRow {
  arm: string; tradeId: string; netPct: number; netWethRaw: bigint; cohortStatus: string; why: string; ts: number;
  fillModelVersion: string | null; token: string; entryWethRaw: string | null; exitWethRaw: string | null;
  entrySimFillOutRaw: string | null; exitSimFillOutRaw: string | null; version: string;
  peakPct: number | null; troughPct: number | null;
}

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

/**
 * (FINAL §2 MDD) Maximum drawdown dari kurva ekuitas bermodal-awal EKSPLISIT atas PnL TERMODEL
 * (bukan netWethRaw ledger-quote), urut waktu. Versi lama mulai ekuitas dari 0 → saat SEMUA
 * trade rugi, puncak tetap 0 → MDD salah 0%. Modal awal = Σ entryWethRaw trade di kohor itu
 * (modal terpasang jendela ini); MDD dipakai per-bucket sama dgn expectancy/PF (tak campur basis).
 */
export function maxDrawdownWei(trades: Array<{ ts: number; netWei: bigint }>, startCapitalWei: bigint): number {
  let peak = startCapitalWei, equity = startCapitalWei, mdd = 0;
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    equity += t.netWei;
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
  let openRows = 0, rejectRows = 0, stuckRows = 0, malformed = 0, capitalUsd = 0, acceptedSimEntries = 0;
  const rawRows: Array<Record<string, unknown>> = [];
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { rawRows.push(JSON.parse(line) as Record<string, unknown>); } catch { malformed++; continue; }
    }
  }
  // (BLOCKER-1) Pre-pass: pasangkan OPEN dulu (simFillEntry ada di baris OPEN / state posisi).
  const openById = new Map<string, Record<string, unknown>>();
  for (const j of rawRows) if (String(j.action ?? "") === "OPEN" && j.tradeId) openById.set(String(j.tradeId), j);
  for (const j of rawRows) {
    {
      const action = String(j.action ?? "");
      if (action === "OPEN") {
        openRows++; capitalUsd += Number(j.usd ?? 0) || 0;
        // (FINAL §1) ENTRI SIM DITERIMA = model fill entry LOLOS (bukan sekadar baris OPEN).
        const es = j.simFillEntry as { filled?: boolean } | undefined;
        if (es?.filled === true) acceptedSimEntries++;
        continue;
      }
      if (action === "REJECT") { rejectRows++; continue; }
      if (action === "STUCK") { stuckRows++; continue; }
      if (action !== "CLOSE") continue;
      const netRaw = typeof j.netWethRaw === "string" && /^-?\d+$/.test(j.netWethRaw) ? BigInt(j.netWethRaw) : 0n;
      closes.push({
        arm: String(j.arm ?? "?"), tradeId: String(j.tradeId ?? `${j.ts}:${j.token}`),
        netPct: Number(j.netPct ?? NaN), netWethRaw: netRaw,
        cohortStatus: String(j.cohortStatus ?? "?"), why: String(j.why ?? "?"), ts: Number(j.ts ?? 0),
        fillModelVersion: typeof j.fillModelVersion === "string" ? j.fillModelVersion : null,
        token: String(j.token ?? "?"),
        entryWethRaw: typeof j.entryWethRaw === "string" && /^\d+$/.test(j.entryWethRaw) ? j.entryWethRaw : null,
        exitWethRaw: typeof j.exitWethRaw === "string" && /^\d+$/.test(j.exitWethRaw) ? j.exitWethRaw : null,
        entrySimFillOutRaw: (() => {
          const sClose = j.simFillEntry as { fillOutRaw?: string } | undefined;
          if (typeof sClose?.fillOutRaw === "string" && /^\d+$/.test(sClose.fillOutRaw)) return sClose.fillOutRaw;
          const o = openById.get(String(j.tradeId ?? ""));
          const sOpen = o?.simFillEntry as { fillOutRaw?: string } | undefined;
          return typeof sOpen?.fillOutRaw === "string" && /^\d+$/.test(sOpen.fillOutRaw) ? sOpen.fillOutRaw : null;
        })(),
        exitSimFillOutRaw: (() => { const s = j.simFillExit as { fillOutRaw?: string } | undefined; return typeof s?.fillOutRaw === "string" && /^\d+$/.test(s.fillOutRaw) ? s.fillOutRaw : null; })(),
        version: typeof j.measurementVersion === "string" ? j.measurementVersion : "pre-units(v0, netPct=gross)",
        peakPct: Number.isFinite(Number(j.peakPct)) ? Number(j.peakPct) : null,
        troughPct: Number.isFinite(Number(j.troughPct)) ? Number(j.troughPct) : null,
      });
    }
  }

  // VALIDATOR SAMA DGN FUNNEL: hanya tradeId di validCompletedIds yang masuk metrik trade.
  const fc = countFunnel(rawRows);
  const validIds = new Set(fc.validCompletedIds);
  // BUCKET per baris via simNetFor (otoritas tunggal). v2-defective = DIPISAH, bukan dihitung ulang.
  // (openById dipasangkan di pre-pass atas — dipakai pairing entry-sim di parse CLOSE.)
  const bucketOf = (c: CloseRow): "quote-only" | "v1" | "v2-defective" | "v3" | "invalid" =>
    simNetFor({ version: c.fillModelVersion, entryWethRaw: c.entryWethRaw ?? "0", exitQuoteWethRaw: c.exitWethRaw ?? "0",
      entrySimFillOutRaw: c.entrySimFillOutRaw, exitSimFillOutRaw: c.exitSimFillOutRaw }).bucket;

  const lines: string[] = ["═══ KOHORT PAPER RH — rekonsiliasi penuh (FINAL, otoritas simNetFor) ═══", "",
    `baris: ${files.length} ledger · CLOSE=${closes.length} · OPEN=${openRows} · REJECT=${rejectRows} · STUCK=${stuckRows} · rusak=${malformed}`,
    `kapital terpakai (Σ entryUsd, semua arm/kohort): $${capitalUsd.toFixed(2)}`,
    `total biaya gas termodel: ${closes.length} putaran × 11,4e12 wei = ${BigInt(closes.length) * GAS_WEI_PER_ROUND_TRIP} wei (ABSOLUT wei; 1,14% hanya @0,001 ETH)`, ""];

  // PILAHAN saling-lepas per bucket simNetFor + v0, dengan valid-funnel sebagai gerbang metrik trade.
  // Penghitung eksplisit (noUncheckedIndexedAccess: akses Record menambah undefined).
  let bkQuoteOnly = 0, bkV1 = 0, bkV2Defective = 0, bkV3 = 0, bkInvalid = 0;
  for (const c of closes) {
    const b = bucketOf(c);
    if (b === "quote-only") bkQuoteOnly++; else if (b === "v1") bkV1++; else if (b === "v2-defective") bkV2Defective++; else if (b === "v3") bkV3++; else bkInvalid++;
  }
  const buckets = { "quote-only": bkQuoteOnly, v1: bkV1, "v2-defective": bkV2Defective, v3: bkV3, invalid: bkInvalid };
  const breakdownSum = buckets["quote-only"] + buckets.v1 + buckets["v2-defective"] + buckets.v3 + buckets.invalid;
  const breakdownOk = breakdownSum === closes.length;
  lines.push(`PILAHAN simNetFor (saling-lepas, wajib = total): quote-only=${buckets["quote-only"]} · v1=${buckets.v1} · v2-defective=${buckets["v2-defective"]} (BEKU — dikecualikan dari validasi profitabilitas) · v3=${buckets.v3} · invalid=${buckets.invalid} · jumlah=${breakdownSum} vs CLOSE=${closes.length} → ${breakdownOk ? "COCOK ✓" : "TIDAK COCOK ✗"}`,
    `trade lulus VALIDATOR FUNNEL (unik + bukti sim penuh): ${validIds.size} (dari ${fc.completed} completed countFunnel — validator sama)`, "");

  const json: Record<string, unknown> = {
    calcVersion: "cohort-stats-final (simNetFor otoritas tunggal; validator funnel sama; v2-defective dikecualikan)",
    dataset: { ledgerFiles: files, generatedAt: new Date(now).toISOString() },
    costAssumptions: { gasWeiPerRoundTrip: GAS_WEI_PER_ROUND_TRIP.toString(), gasBasis: "wei ABSOLUT (1,14% hanya @0,001 ETH)",
      latencyOverlayPct: OVERLAY_PP, latencySource: "fillmodel ASUMSI (belum terkalibrasi fill nyata) — dipakai HANYA utk normalisasi v0",
      quoteFees: "terkandung dalam quote OKX" },
    accountingBreakdown: { quoteOnly: buckets["quote-only"], v1: buckets.v1, v2Defective: buckets["v2-defective"], v3: buckets.v3, invalid: buckets.invalid, sum: breakdownSum, matchesCloseTotal: breakdownOk },
    funnelValidTrades: validIds.size, generatedAt: now, closeRows: closes.length, openRows, acceptedSimEntries, rejectRows, stuckRows, malformed, capitalUsd, groups: [] as unknown[] };

  // METRIK per arm × measurementVersion × cohortStatus × bucket — hanya trade funnel-valid.
  for (const arm of [...new Set(closes.map((c) => c.arm))].sort()) {
    for (const version of [...new Set(closes.map((c) => c.version))].sort()) {
      for (const cohort of ["PROSPECTIVE", "LEGACY_CARRYOVER"] as const) {
        for (const bucket of ["quote-only", "v1", "v2-defective", "v3"] as const) {
          const rows = closes.filter((c) => c.arm === arm && c.version === version && c.cohortStatus === cohort
            && bucketOf(c) === bucket && validIds.has(c.tradeId) && Number.isFinite(c.netPct));
          if (!rows.length) continue;
          // Net per trade: simNetFor utk baris ber-model; v0 dinormalisasi (gross−gas−overlay, HIPOTETIS).
          // (FINAL §2 MDD) PnL per trade dibawa BERSAMA ts-nya → kurva ekuitas termodel, modal awal eksplisit.
          const sim = rows.map((r) => {
            if (bucket !== "quote-only") {
              const s = simNetFor({ version: r.fillModelVersion, entryWethRaw: r.entryWethRaw ?? "0", exitQuoteWethRaw: r.exitWethRaw ?? "0",
                entrySimFillOutRaw: r.entrySimFillOutRaw, exitSimFillOutRaw: r.exitSimFillOutRaw });
              return { net: s.netPct, netWethRaw: BigInt(s.netWethRaw), ts: r.ts };
            }
            const gasPct = r.entryWethRaw != null ? gasPctForNotional(GAS_WEI_PER_ROUND_TRIP, BigInt(r.entryWethRaw)) : gasPctForNotional(GAS_WEI_PER_ROUND_TRIP, 1_000_000_000_000_000n);
            return { net: r.netPct - gasPct - OVERLAY_PP, netWethRaw: BigInt(Math.round((r.netPct - gasPct - OVERLAY_PP) / 100 * Number(r.entryWethRaw || "1"))), ts: r.ts, normalized: true } as { net: number; netWethRaw: bigint; ts: number; normalized?: boolean };
          });
          const wins = sim.filter((x) => x.net > 0), losses = sim.filter((x) => x.net < 0);
          const sumWin = wins.reduce((a, b) => a + b.net, 0), sumLoss = Math.abs(losses.reduce((a, b) => a + b.net, 0));
          const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);
          const expectancy = sim.length ? sim.reduce((a, b) => a + b.net, 0) / sim.length : 0;
          const be = sumWin > 0 && losses.length ? (sumLoss / losses.length) / ((sumLoss / losses.length) + (sumWin / wins.length)) : 1;
          const ci = bootstrapCi(sim.map((x) => x.net));
          const netWethSum = sim.reduce((acc, x) => acc + x.netWethRaw, 0n);
          // (FINAL §2 MDD) modal awal = Σ entryWethRaw trade kohor ini (modal terpasang jendela);
          // kurva ekuitas dari PnL TERMODEL urut-waktu — bukan netWethRaw ledger-quote, bukan mulai-0.
          const startCapitalWei = rows.reduce((acc, r) => acc + BigInt(r.entryWethRaw ?? "0"), 0n);
          const mddPct = maxDrawdownWei(sim.map((x) => ({ ts: x.ts, netWei: x.netWethRaw })), startCapitalWei);
          const label = bucket === "quote-only" ? "quote-only (net gas tersimpan)" : `sim ${bucket}`;
          const block = {
            arm, version, cohort, bucket, closeRows: rows.length, uniqueTrades: new Set(rows.map((r) => r.tradeId)).size,
            netWethRawSum: netWethSum.toString(),
            winRate: sim.length ? Number((wins.length / sim.length * 100).toFixed(2)) : null,
            avgWinner: wins.length ? Number((sumWin / wins.length).toFixed(4)) : null,
            avgLoser: losses.length ? Number((sumLoss / losses.length).toFixed(4)) : null,
            profitFactor: Number.isFinite(pf) ? Number(pf.toFixed(4)) : (sumWin > 0 ? "inf" : 0),
            expectancyPct: Number(expectancy.toFixed(4)), expectancyCi95: [Number(ci.lo.toFixed(3)), Number(ci.hi.toFixed(3))],
            breakEvenOfRealized: sim.length ? Number((be * 100).toFixed(2)) : null,
            maxDrawdownPct: mddPct, capitalBaseWei: startCapitalWei.toString(),
            exits: rows.reduce<Record<string, number>>((acc, r) => { acc[r.why] = (acc[r.why] ?? 0) + 1; return acc; }, {}),
            excludedFromProfitability: bucket === "v2-defective",
          };
          lines.push(`arm ${arm} · ${version} · ${cohort} · ${label}: n=${rows.length} · trade UNIK=${block.uniqueTrades}`,
            `  net Σ=${netWethSum.toString()} wei · winrate=${block.winRate ?? "—"}% · rata menang=${block.avgWinner ?? "—"}% · rata rugi=${block.avgLoser ?? "—"}% · PF=${block.profitFactor} · expectancy=${block.expectancyPct}% CI95=${JSON.stringify(block.expectancyCi95)}`,
            `  break-even realisasi=${block.breakEvenOfRealized ?? "—"}% · MDD=${block.maxDrawdownPct}%${block.excludedFromProfitability ? " · [v2-DEFECTIVE: dikecualikan dari validasi profitabilitas, historis dipertahankan]" : ""}`,
            `  exits: ${JSON.stringify(block.exits)}`);
          (json.groups as unknown[]).push(block);
        }
      }
    }
  }
  lines.push("", "BATAS JUJUR: expectancy/PF di atas adalah DISTRIBUSI EXIT atas kandidat quota-arm —",
    "bukan bukti edge; CI lebar (n kecil). v2-defective TIDAK ikut validasi profitabilitas.",
    "Rumus BE teoretis (breakeven.ts): v3 net-basis → BE=(SL+d)/(TP+SL), d=overlay latensi.");
  const summary = `closes=${closes.length} valid=${validIds.size} buckets=${JSON.stringify(buckets)}`;
  return { lines, json, summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = cohortStats();
  console.log(r.lines.join("\n"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-cohort-stats-${day}.md`), r.lines.join("\n") + "\n");
  writeFileSync(join("logs", `rh-cohort-stats-${day}.json`), JSON.stringify(r.json, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
