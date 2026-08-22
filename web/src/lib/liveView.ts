import type { StatsResponse } from "@/types/stats";

/**
 * LIVE VIEW — one adapter, zero new panels.
 *
 * The first attempt at "show live instead of simulation" built a parallel set of panels:
 * LiveWallet, LiveJournal, LivePositions, LiveExitQuality, LiveExecHealth. That was the wrong
 * shape of solution and it showed — every panel had to be re-designed, re-tested and then
 * re-designed again to look like the one it was replacing, and the dashboard still came out
 * looking assembled from parts.
 *
 * The request was never "build live panels". It was "switch the feed". So this returns the SAME
 * StatsResponse the paper panels already consume, with the paper-sourced fields replaced by
 * their live equivalents. Every panel then renders live data through the exact code path — and
 * therefore the exact appearance — it already had. Nothing to keep in visual sync, because
 * there is only one of everything.
 *
 * Fields that have no live counterpart are emptied rather than passed through, so a paper number
 * can never leak into a live view by omission. `runs` is the clearest case: it counts float
 * auto-refills, and a live wallet has no float and no refills, so the honest answer is "no data"
 * rather than yesterday's simulation.
 */
export function toLiveView(data: StatsResponse): StatsResponse {
  const b = data.liveBridge;
  if (!b?.armed) return data;
  const s = b.summary;

  // Trades, in the shape TradeJournal + ExitQuality already read.
  const trades = (s?.recent ?? []).map((r) => ({
    ts: r.ts,
    symbol: r.symbol || `${r.mint.slice(0, 6)}…`,
    reason: r.reason,
    pnlPct: r.netPct ?? 0,
    pnlSol: r.netSol,
    heldSec: r.heldSec,
    img: r.img ?? null,
  }));

  // Open bags, joined to the paper position that decided each one so the card's rings (time
  // against budget, distance to the trailing stop) stay real. Those rings belong to the model,
  // which is correct — the model is what decides this bag's exit.
  const paperOpen = data.paper?.openPositions ?? [];
  const openPositions = (b.lots ?? []).map((l, i) => {
    const p = paperOpen.find((x) => x.mint === l.mint);
    return {
      ...(p ?? {}),
      mint: l.mint || `${l.symbol}-${i}`,
      symbol: l.symbol ?? p?.symbol ?? l.mint.slice(0, 6),
      img: l.img ?? (p as { img?: string | null } | undefined)?.img ?? null,
      unrealizedPnl: p?.unrealizedPnl ?? 0,
      heldSec: l.heldSec,
      sizeSol: l.spentSol,
    };
  }) as StatsResponse["paper"] extends { openPositions: infer T } ? T : never;

  // Wallet: SOL-denominated, like the sniper leg. The "float" is the balance BEFORE live trading
  // started, derived by backing the realised P&L out of the current balance — so the panel's
  // "vs float" reading means "what live trading did", not "what the wallet happens to hold".
  const balanceSol = b.expectedBalanceSol ?? 0;
  const netSol = s?.netSol ?? 0;
  const floatSol = balanceSol - netSol;
  const rate = data.combined?.solUsd ?? null;
  const usd = (sol: number): number | null => (rate != null && rate > 0 ? sol * rate : null);

  // Equity in BALANCE terms (the panel plots deviation from its first sample), so the live
  // cumulative-P&L series is re-based onto the starting float.
  const equity = (s?.equitySol ?? []).map((cum) => ({ t: "", bal: floatSol + cum }));

  return {
    ...data,
    paper: data.paper
      ? {
          ...data.paper,
          opens: s?.trades ?? 0,
          closed: s?.trades ?? 0,
          open: b.openLots ?? 0,
          wins: s?.wins ?? 0,
          losses: s?.losses ?? 0,
          winRate: s && s.trades > 0 ? s.wins / s.trades : 0,
          floatSol,
          balanceSol,
          realizedSol: netSol,
          tradeSizeSol: b.clipSol ?? data.paper.tradeSizeSol,
          exitReasons: Object.fromEntries((s?.exitReasons ?? []).map((r) => [r.reason, r.n])),
          equity: equity.map((e, i) => ({ t: String(i), bal: e.bal })),
          openPositions,
        }
      : data.paper,
    recentTrades: [],
    combined: data.combined
      ? {
          ...data.combined,
          totalUsd: usd(balanceSol),
          floatUsd: usd(floatSol),
          pnlUsd: usd(netSol),
          pnlPct: floatSol > 0 ? (netSol / floatSol) * 100 : null,
          wins: s?.wins ?? 0,
          losses: s?.losses ?? 0,
          winRate: s && s.trades > 0 ? s.wins / s.trades : 0,
          open: b.openLots ?? 0,
          s1: { balanceUsd: usd(balanceSol), floatUsd: usd(floatSol), balanceSol, floatSol, wins: s?.wins ?? 0, losses: s?.losses ?? 0, open: b.openLots ?? 0 },
          // Strategy 2 does not trade live at all. Zeroing it keeps its row visible as an
          // explicit zero instead of silently carrying a simulation balance into a live wallet.
          s2: { balanceUsd: 0, floatUsd: 0, wins: 0, losses: 0, open: 0 },
          equity,
        }
      : data.combined,
    strategy2Primary: data.strategy2Primary
      ? {
          ...data.strategy2Primary,
          recentTrades: trades as StatsResponse["strategy2Primary"] extends { recentTrades: infer T } ? T : never,
          paper: { ...data.strategy2Primary.paper, open: 0, openPositions: [] },
        }
      : data.strategy2Primary,
    // No float, no refills, therefore no runs. "No data" is the honest reading; passing the
    // paper ledger through would put a simulation history under a live heading.
    runs: undefined as unknown as StatsResponse["runs"],
  };
}
