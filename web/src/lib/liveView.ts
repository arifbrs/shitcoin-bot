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
    pnlPct: r.netPct ?? null,
    pnlSol: r.netSol,
    heldSec: r.heldSec,
    img: r.img ?? null,
    // Tag explicitly. These rows sit in the Strategy-2 slot only because that is the array the
    // journal and Exit Quality already read — labelling them "S2" would name the wrong engine
    // AND hide that this is real money.
    tag: "LIVE" as const,
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
      // No paper twin → no honest mark for a REAL bag. `null` renders an em-dash on the card;
      // coercing to 0 stamped "+0.0%" onto bags nobody could price — a fabricated fact about
      // money at risk, exactly what this adapter exists to prevent.
      unrealizedPnl: p?.unrealizedPnl ?? null,
      heldSec: l.heldSec,
      sizeSol: l.spentSol,
    };
  }) as StatsResponse["paper"] extends { openPositions: infer T } ? T : never;

  // Wallet: SOL-denominated, like the sniper leg. The "float" is the balance BEFORE live trading
  // started, derived by backing the realised P&L out of the current balance — so the panel's
  // "vs float" reading means "what live trading did", not "what the wallet happens to hold".
  //
  // `walletSol` is read on-chain by the web server. It must NOT fall back to
  // `expectedBalanceSol`: that is the bridge's post-transaction snapshot, and the bridge only
  // transacts in the TRADER process, so in the web server it is null forever. Treating it as
  // the balance rendered $0.00 / 0.0000 SOL against a wallet holding 0.22, and dragged float
  // and every percentage down with it.
  //
  // Unknown stays UNKNOWN. Returning the untouched paper data would be worse (a simulation
  // balance under a live heading) — but coercing to ZERO is just as false: on 2026-08-24 a
  // transient RPC failure rendered the funded wallet as "$0.00" with an all-red tape. The
  // balance-derived fields carry null and the wallet panel draws its explicit
  // "saldo tidak terbaca" state until a read succeeds.
  const known = typeof b.walletSol === "number" && b.walletSol >= 0;
  const balanceSol = known ? (b.walletSol as number) : null;
  const netSol = s?.netSol ?? 0;
  const floatSol = known ? (balanceSol as number) - netSol : null;
  const rate = data.combined?.solUsd ?? null;
  const usd = (sol: number | null): number | null => (sol != null && known && rate != null && rate > 0 ? sol * rate : null);

  // Equity in BALANCE terms (the panel plots deviation from its first sample), so the live
  // cumulative-P&L series is re-based onto the starting float. Without a known balance there
  // is no base — an empty series is the honest tape.
  const equity = known && s?.equitySol ? s.equitySol.map((cum) => ({ t: "", bal: (floatSol as number) + cum })) : [];

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
          pnlPct: known && floatSol != null && floatSol > 0 ? (netSol / floatSol) * 100 : null,
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
