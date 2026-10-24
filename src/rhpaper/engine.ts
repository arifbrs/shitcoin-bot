/**
 * Quote-only paper engine: never simulates, signs, or sends. STUCK means no available quote,
 * not a proven total loss. Historical gas is an assumption, not measured execution cost.
 */
import { quoteBuy, quoteSell, ethUsdOf } from "./exec.js";
import { simulateFill, FILL_MODEL_VERSION, rationalPct } from "./fillmodel.js";
export { rationalPct }; // re-export: otoritas tunggal (tes lama mengimpor dari sini)
import { createHash, randomUUID } from "node:crypto";
import { cacheStale, liquiditySnapshot, loadCandidates, scanCandidates } from "./scanner.js";
import { appendLedger, loadState, saveState, withLockAsync, type Position } from "./state.js";

export interface Cfg { maker: string; usd: number; maxPositions: number; stopPct: number; tpHoldMin: number; takePct: number; arm?: string; wethRaw?: string }

// Historical gas assumption, NOT a measured fee for each OKX transaction. Keep units exact.
export const ROUND_TRIP_GAS_WEI = 11_400_000_000_000n;

export function quotePnl(entryRaw: string, exitRaw: string, gasWei = ROUND_TRIP_GAS_WEI): { grossPct: number; netPct: number; netWethRaw: string } {
  const entry = BigInt(entryRaw), exit = BigInt(exitRaw);
  if (entry <= 0n || exit < 0n || gasWei < 0n) throw new Error("invalid quote amounts");
  const gross = exit - entry, net = gross - gasWei;
  // (FINAL-2 REVISI) PRESISI AMAN-2^53: 2^53−1 wei ≈ 0,009007199 ETH — posisi ≥0,009 ETH SUDAH
  // melewatinya, jadi Number(BigInt) langsung BUKAN otoritas yang sah untuk akuntansi.
  // Metode: rasional eksak via BigInt — I = |delta|×10^25 / entry merepresentasikan pp×10^23
  // (25 digit di bawah koma), lalu string → Number() membulatkan KE TERDEKAT double secara
  // deterministik. Tidak ada konversi Number(BigInt) yang kehilangan digit signifikan.
  const pct = (delta: bigint): number => rationalPct(delta, entry); // dari fillmodel (satu definisi)
  return { grossPct: pct(gross), netPct: pct(net), netWethRaw: net.toString() };
}

type CycleIO = Pick<typeof import("./exec.js"), "quoteBuy" | "quoteSell"> &
  Pick<typeof import("./scanner.js"), "cacheStale" | "loadCandidates" | "scanCandidates"> & {
  ethUsd?: () => Promise<number | null>; // (R8 P6) dapat disuntik untuk fixture deterministik offline
  liquiditySnapshot?: (tokens: string[]) => Promise<Map<string, { liquidityUsd: number | null; at: number }>>; // (P0-4) injeksi fixture
};
const cycleIO: CycleIO = { quoteBuy, quoteSell, cacheStale, loadCandidates, scanCandidates, ethUsd: ethUsdOf, liquiditySnapshot };

export function shouldExit(pnlPct: number, ageMin: number, cfg: Pick<Cfg, "stopPct" | "tpHoldMin" | "takePct">): string | null {
  if (pnlPct <= -Math.abs(cfg.stopPct)) return "stop";
  if (pnlPct >= Math.abs(cfg.takePct)) return "take";
  if (ageMin >= cfg.tpHoldMin) return "waktu";
  return null;
}

export async function cycle(cfg: Cfg, io: CycleIO = cycleIO): Promise<{ opened: number; closed: number; stuck: number; errors: string[] }> {
  const armName = cfg.arm ?? "A";
  const exitPolicy = { stopPct: cfg.stopPct, takePct: cfg.takePct, tpHoldMin: cfg.tpHoldMin };
  const policyId = createHash("sha256").update(JSON.stringify({ version: "rhpaper-units-arm-v3", arm: armName, ...exitPolicy })).digest("hex").slice(0, 16);
  const errors: string[] = [];
  return withLockAsync(async () => {
    {
      const s = loadState();
      s.cycles++;
      const today = new Date().toISOString().slice(0, 10);
      if (s.day !== today) { s.day = today; }
      let opened = 0, closed = 0, stuck = 0;

      // 1) EXIT — hanya boleh bila quote jual ada
      const exitLiquidity = await (io.liquiditySnapshot ?? liquiditySnapshot)(s.positions.map((p) => p.token)); // (P0-4) likuiditas exit-time, satu batch
      for (const p of s.positions) {
        // Each supervisor invocation owns only its arm. Frozen positions retain their entry policy.
        if (p.arm !== armName) continue;
        // (FINAL-P0-2) exit QUOTE untuk kuantitas sim entry yang sesungguhnya (re-quote nyata,
        // bukan penskalaan proporsional) — hanya bila bukti sim entry tersimpan & versinya cocok.
        const entrySimUsablePre = p.simFillEntry?.filled === true && p.simFillEntry?.fillOutRaw != null && p.simFillEntry?.version === FILL_MODEL_VERSION;
        const sell = await io.quoteSell(p.token, entrySimUsablePre ? p.simFillEntry!.fillOutRaw! : p.qtyRaw, cfg.maker);
        if (!sell.ok || !sell.quote) {
          // GALAT SEMENTARA (429/timeout/rate/chainIndex) ≠ tidak ada pembeli. Jangan cap STUCK permanen.
          const reason = sell.reason ?? "quote jual gagal";
          const transient = /too many|rate|timeout|fetch failed|chainIndex|502|503|504|econn/i.test(reason);
          p.stuckCount = (p.stuckCount ?? 0) + 1;
          if (transient && p.stuckCount < 6) {
            appendLedger({ ts: Date.now(), action: "RETRY", arm: p.arm, token: p.token, symbol: p.symbol, reason, attempt: p.stuckCount });
            continue;
          }
          if (!p.stuck) { s.stuck++; stuck++; }
          p.stuck = true; p.stuckReason = reason;
          appendLedger({ ts: Date.now(), action: "STUCK", arm: p.arm, token: p.token, symbol: p.symbol, reason, attempt: p.stuckCount });
          continue;
        }
        if (p.stuck) { p.stuck = false; p.stuckReason = undefined; p.stuckCount = 0; s.stuck = Math.max(0, s.stuck - 1); appendLedger({ ts: Date.now(), action: "UNSTUCK", arm: p.arm, token: p.token, symbol: p.symbol }); }
        p.stuckCount = 0;
        // PnL dihitung DALAM WETH (masuk vs keluar) — tidak ada harga tebakan.
        const pnl = quotePnl(p.entryWethRaw, sell.quote!.amountOut);
        const pnlPct = pnl.grossPct;
        // JURNAL: satu baris MARK per siklus → bisa menghitung drawdown, peak, dan lintasan tiap trade.
        p.peakPct = Math.max(p.peakPct ?? pnlPct, pnlPct);
        p.troughPct = Math.min(p.troughPct ?? pnlPct, pnlPct);
        p.marks = (p.marks ?? 0) + 1;
        appendLedger({ ts: Date.now(), action: "MARK", arm: p.arm, token: p.token, symbol: p.symbol, tradeId: p.tradeId ?? null, policyId: p.policyId ?? "legacy-unfrozen",
          decisionQtySource: entrySimUsablePre ? "sim-entry" : "quote-only", decisionQtyRaw: entrySimUsablePre ? p.simFillEntry!.fillOutRaw! : p.qtyRaw,
          outWethRaw: sell.quote.amountOut, pnlPct, netPct: pnl.netPct, impactPct: sell.quote.impactPct, quoteRef: JSON.stringify(sell.quote), executionState: "QUOTE_ONLY_NOT_SIMULATED" });
        const why = shouldExit(pnl.netPct, (Date.now() - p.entryTs) / 60000, p.exitPolicy ?? exitPolicy);
        if (why) {
          // Deduct historical gas assumption in WEI; do not call this actual executed P&L.
          const netPct = pnl.netPct;
          s.positions = s.positions.filter((x) => x !== p);
          s.closed++; closed++;
          s.netWethRaw = (BigInt(s.netWethRaw ?? "0") + BigInt(pnl.netWethRaw)).toString();
          // (B3) simFillExit: model fill TERPISAH untuk akuntansi simulasi — tidak mengubah keputusan
          // keluar di atas, tidak pernah digabung ke PnL nyata/quote.
          // (FINAL-P0-1) EXIT fail-closed: tanpa sim entry tersimpan (hilang/versi beda/entri gagal
          // model) → sim exit DITOLAK dengan alasan spesifik; TIDAK pernah memakai qty quote penuh.
          const simEntry = p.simFillEntry;
          const exitLiq = exitLiquidity.get(p.token) ?? null;
          const entrySimUsable = simEntry?.filled === true && simEntry?.fillOutRaw != null && simEntry?.version === FILL_MODEL_VERSION;
          const simFillExit = !entrySimUsable
            ? { filled: false as const, reason: simEntry == null ? "ENTRY_SIM_MISSING" : simEntry.filled === false ? `ENTRY_SIM_REJECTED:${simEntry.reason ?? "?"}` : "ENTRY_SIM_VERSION_MISMATCH", version: FILL_MODEL_VERSION }
            : simulateFill({ quoteAmountIn: p.qtyRaw, quoteAmountOut: sell.quote!.amountOut, impactPct: sell.quote!.impactPct,
            liquidityUsd: exitLiq?.liquidityUsd ?? null, sizeWethRaw: p.entryWethRaw, ethUsd: await (io.ethUsd ?? ethUsdOf)(),
            quoteAgeMs: Date.now() - (sell.quote!.ts ?? Date.now()) }); // (FINAL §1) quote SUDAH utk kuantitas sim (re-quote nyata) — tanpa penskalaan kedua
          appendLedger({
            ts: Date.now(), action: "CLOSE", arm: p.arm, token: p.token, symbol: p.symbol, why,
            decisionQtySource: entrySimUsablePre ? "sim-entry" : "quote-only", decisionQtyRaw: entrySimUsablePre ? p.simFillEntry!.fillOutRaw! : p.qtyRaw,
            tradeId: p.tradeId ?? null, policyId: p.policyId ?? "legacy-unfrozen", measurementVersion: "rhpaper-units-arm-v3",
            cohortStatus: p.tradeId && p.policyId && p.exitPolicy ? "PROSPECTIVE" : "LEGACY_CARRYOVER",
            heldMin: Math.round((Date.now() - p.entryTs) / 60000),
            entryWethRaw: p.entryWethRaw, exitWethRaw: String(sell.quote!.amountOut),
            grossPct: pnlPct, netPct, netWethRaw: pnl.netWethRaw, gasWeth: Number(ROUND_TRIP_GAS_WEI) / 1e18,
            gasWei: ROUND_TRIP_GAS_WEI.toString(), gasSource: "historical-assumption", executionState: "QUOTE_ONLY_NOT_SIMULATED",
            exitLiquidityUsd: exitLiq?.liquidityUsd ?? null, exitLiquidityAt: exitLiq?.at ?? null,
            simFillExit, fillModelVersion: FILL_MODEL_VERSION,
            peakPct: p.peakPct ?? pnlPct, troughPct: p.troughPct ?? pnlPct, marks: p.marks ?? 0,
            entryImpactPct: (() => { try { return (JSON.parse(p.entryQuoteRef) as { impactPct?: number }).impactPct ?? null; } catch { return null; } })(),
            exitImpactPct: sell.quote!.impactPct, exitSlippagePct: sell.quote!.slippagePct,
            quoteRef: JSON.stringify(sell.quote),
          });
        }
      }

      // 2) ENTRY — hanya kandidat dua-arah, dan hanya bila quote beli ada
      const armOpen = s.positions.filter((p) => p.arm === armName).length;
      if (armOpen < cfg.maxPositions) {
        let cands = io.loadCandidates();
        if (cands.length === 0 || io.cacheStale(30)) cands = await io.scanCandidates(cfg.maker, Math.max(40, cfg.maxPositions));
        for (const c of cands) {
          if (s.positions.filter((p) => p.arm === armName).length >= cfg.maxPositions) break;
          if (s.positions.some((p) => p.token === c.token && p.arm === armName)) continue;
          // Notional dalam WETH (bukan USD) → tidak butuh harga ETH untuk membuka posisi.
          const wethRaw = cfg.wethRaw ?? "1000000000000000";
          const buy = await io.quoteBuy(c.token, wethRaw, cfg.maker);
          if (!buy.ok || !buy.quote) {
            // (B5) REJECT rows: kandidat LAYAK yang ditolak tercatat — dasar nol-pilih saat evaluasi.
            appendLedger({ ts: Date.now(), action: "REJECT", arm: armName, token: c.token, symbol: c.symbol, reason: buy.reason ?? "quote beli gagal" });
            errors.push(c.symbol + ": " + (buy.reason ?? "quote beli gagal")); continue;
          }
          // The reverse proof must cover the actual full buy size, not one arbitrary token.
          const reverse = await io.quoteSell(c.token, buy.quote!.amountOut, cfg.maker);
          if (!reverse.ok || !reverse.quote) {
            appendLedger({ ts: Date.now(), action: "REJECT", arm: armName, token: c.token, symbol: c.symbol, reason: "reverse quote unavailable at full size" });
            errors.push(c.symbol + ": reverse quote unavailable at full size"); continue;
          }
          const floor = quotePnl(buy.quote!.amountIn, reverse.quote.amountOut);
          if (floor.netPct <= -Math.abs(cfg.stopPct)) {
            appendLedger({ ts: Date.now(), action: "REJECT", arm: armName, token: c.token, symbol: c.symbol, reason: "round trip already beyond stop", roundTripFloorPct: floor.netPct });
            errors.push(c.symbol + ": round trip already beyond stop"); continue;
          }
          // (FINAL-P0-1) sim entry dihitung SEBELUM pos dibuat dan DISIMPAN di posisi (crash-safe:
          // ikut saveState/loadState) — exit nanti membaca kuantitas sim yang nyata, bukan tebakan.
          const simFillEntry = simulateFill({ quoteAmountIn: buy.quote!.amountIn, quoteAmountOut: buy.quote!.amountOut, impactPct: buy.quote!.impactPct,
            liquidityUsd: c.liquidityUsd ?? null, sizeWethRaw: buy.quote!.amountIn, ethUsd: await (io.ethUsd ?? ethUsdOf)() });
          const pos: Position = { arm: armName, token: c.token, symbol: c.symbol, entryTs: Date.now(), entryQuoteRef: JSON.stringify(buy.quote), entryUsd: cfg.usd, entryWethRaw: buy.quote!.amountIn, qtyRaw: buy.quote!.amountOut, tradeId: randomUUID(), policyId, exitPolicy, liquidityUsd: c.liquidityUsd ?? null, liquiditySource: c.liquiditySource ?? null, liquidityReason: c.liquidityReason ?? null, liquidityAt: c.liquidityAt ?? null,
          imbalanceH1: c.imbalanceH1 ?? null, txnsH1: c.txnsH1 ?? null, priceChangeH1: c.priceChangeH1 ?? null, pairAgeDays: c.pairAgeDays ?? null,
          simFillEntry: simFillEntry.filled
            ? { filled: true, fillOutRaw: simFillEntry.fillOutRaw, version: FILL_MODEL_VERSION }
            : { filled: false, reason: simFillEntry.reason, version: FILL_MODEL_VERSION } };
          s.positions.push(pos); opened++;
          // (B3) simFillEntry: model fill untuk akuntansi simulasi — tidak mengubah keputusan buka.
          appendLedger({ ts: Date.now(), action: "OPEN", arm: pos.arm, token: c.token, symbol: c.symbol, tradeId: pos.tradeId, policyId, exitPolicy, measurementVersion: "rhpaper-units-arm-v3", executionState: "QUOTE_ONLY_NOT_SIMULATED", roundTripFloorPct: floor.netPct, reverseQuoteRef: JSON.stringify(reverse.quote), decimals: c.decimals, usd: cfg.usd, entryWethRaw: pos.entryWethRaw, qtyRaw: pos.qtyRaw, entryImpactPct: buy.quote!.impactPct, entrySlippagePct: buy.quote!.slippagePct, quoteRef: pos.entryQuoteRef,
            liquidityUsd: c.liquidityUsd ?? null, liquidityReason: c.liquidityReason ?? null, liquidityAt: c.liquidityAt ?? null,
            imbalanceH1: c.imbalanceH1 ?? null, txnsH1: c.txnsH1 ?? null, priceChangeH1: c.priceChangeH1 ?? null, pairAgeDays: c.pairAgeDays ?? null, simFillEntry, fillModelVersion: FILL_MODEL_VERSION });
        }
      }
      saveState(s);
      return { opened, closed, stuck, errors };
    }
  });
}
