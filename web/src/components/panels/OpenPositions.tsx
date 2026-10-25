import { panelMemo } from "@/lib/panelMemo";
import type { OpenPosition, StatsResponse } from "@/types/stats";
import { PositionCard } from "./PositionCard";

/**
 * Merges BOTH strategies' open positions (owner, 2026-07-30 — same request/reasoning as
 * TradeJournal's merge: tag each card S1/S2 instead of a shared scanner/gate, since the two
 * strategies already track positions independently and just need to be shown together).
 * Sniper positions (SniperOpenPosition) have mostly-optional fields — normalized here with safe
 * fallbacks rather than widening OpenPosition's own (Strategy 2-authoritative) required fields.
 */
function OpenPositionsInner({ data }: { data: StatsResponse }) {
  const s2 = (data.strategy2Primary?.paper.openPositions ?? []).map((p) => ({ pos: p, tag: "S2" as const }));
  // When live is ARMED, `paper.openPositions` IS the bridge's real bags (lib/liveView maps them
  // in). They must wear the LIVE badge — red, "real SOL at risk" — not S1's purple scout tag,
  // which names a simulation engine for money that is actually on-chain.
  const s1Tag = data.liveBridge?.armed ? ("LIVE" as const) : ("S1" as const);
  const s1 = (data.paper?.openPositions ?? []).map((p, i) => ({
    pos: {
      // SPREAD FIRST. This used to name every field it forwarded, so when the server started
      // sending exit-proximity data (peakPct/fromPeakPct/trailPct/budgetSec) and the coin art,
      // Strategy 1 silently lost all of it — the card then read peakPct as 0 and stamped
      // "belum berkembang" onto a position sitting at +127.5%, which is not a cosmetic bug but a
      // false statement about the position. Explicit keys below still win where normalization is
      // genuinely needed.
      ...p,
      mint: p.mint ?? `${p.symbol}-${i}`, symbol: p.symbol, unrealizedPnl: p.unrealizedPnl ?? null, heldSec: p.heldSec ?? 0,
      entryPrice: p.entryPrice ?? 1, lastPrice: p.lastPrice ?? 1, noManualClose: true as const,
          // NOT `?? 0`. Strategy 1 does not report market cap or holder count for an open
          // position, and defaulting them to zero rendered "MC $0 · 0 holders" on screen — a
          // fabricated fact where the honest answer is "not tracked". PositionCard already draws
          // an em-dash for null, so absence stays visible as absence.
          marketCap: p.marketCap ?? null, holders: p.holders ?? null,
    } satisfies OpenPosition,
    tag: s1Tag,
  }));
  const positions = [...s1, ...s2];

  if (!positions.length) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="font-mono text-[11px] text-muted-foreground">
          {data.liveBridge?.armed
            ? "tidak ada bag live — menunggu kandidat lolos gate"
            : "tidak ada posisi terbuka — menunggu permintaan terkonfirmasi"}
        </p>
      </div>
    );
  }

  return (
    // auto-fill with a FLOOR, not a fixed column count. At `grid-cols-4` on a 12-column tile each
    // card got ~190px — the poster layout was designed and previewed at 392px, so the percentage
    // ran straight through the badges. A minimum column width means the card is never rendered
    // narrower than it can survive; the column count follows from the tile instead of being
    // asserted against it.
    <div className="grid h-full auto-rows-min gap-2 overflow-y-auto pr-1"
         style={{ gridTemplateColumns: "repeat(auto-fill, minmax(272px, 1fr))" }}>
      {positions.map(({ pos, tag }) => (
        <PositionCard key={pos.mint} position={pos} tag={tag} />
      ))}
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const OpenPositions = panelMemo(OpenPositionsInner, (d) => [d.strategy2Primary?.paper.open, d.paper?.openPositions?.length, d.strategy2Primary?.paper.openPositions?.map((p) => `${p.mint}:${p.unrealizedPnl}:${p.heldSec}`).join(), d.paper?.openPositions?.map((p) => `${p.mint}:${p.unrealizedPnl}:${p.heldSec}`).join()]);
