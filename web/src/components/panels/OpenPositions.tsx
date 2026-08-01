import type { OpenPosition, StatsResponse } from "@/types/stats";
import { PositionCard } from "./PositionCard";

/**
 * Merges BOTH strategies' open positions (owner, 2026-07-30 — same request/reasoning as
 * TradeJournal's merge: tag each card S1/S2 instead of a shared scanner/gate, since the two
 * strategies already track positions independently and just need to be shown together).
 * Sniper positions (SniperOpenPosition) have mostly-optional fields — normalized here with safe
 * fallbacks rather than widening OpenPosition's own (Strategy 2-authoritative) required fields.
 */
export function OpenPositions({ data }: { data: StatsResponse }) {
  const s2 = (data.strategy2Primary?.paper.openPositions ?? []).map((p) => ({ pos: p, tag: "S2" as const }));
  const s1 = (data.paper?.openPositions ?? []).map((p, i) => ({
    pos: {
      mint: p.mint ?? `${p.symbol}-${i}`, symbol: p.symbol, unrealizedPnl: p.unrealizedPnl ?? 0, heldSec: p.heldSec ?? 0,
      entryPrice: p.entryPrice ?? 1, lastPrice: p.lastPrice ?? 1, noManualClose: true as const,
          // NOT `?? 0`. Strategy 1 does not report market cap or holder count for an open
          // position, and defaulting them to zero rendered "MC $0 · 0 holders" on screen — a
          // fabricated fact where the honest answer is "not tracked". PositionCard already draws
          // an em-dash for null, so absence stays visible as absence.
          marketCap: p.marketCap ?? null, holders: p.holders ?? null,
    } satisfies OpenPosition,
    tag: "S1" as const,
  }));
  const positions = [...s1, ...s2];

  if (!positions.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-[11px] text-muted-foreground">no open positions — waiting for confirmed demand</p>
      </div>
    );
  }

  return (
    <div className="grid h-full auto-rows-min grid-cols-2 gap-2 overflow-y-auto pr-1 lg:grid-cols-3 xl:grid-cols-4">
      {positions.map(({ pos, tag }) => (
        <PositionCard key={pos.mint} position={pos} tag={tag} />
      ))}
    </div>
  );
}
