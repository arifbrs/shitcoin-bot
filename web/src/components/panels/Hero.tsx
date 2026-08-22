import type { StatsResponse } from "@/types/stats";
import { HeroWave } from "./HeroWave";

/**
 * HERO — the terrain, with live coins surfacing over it.
 *
 * Money was removed on purpose: the wallet tile beside this one already carried the total, the
 * S1/S2 split, the SOL rate and the W/L, so repeating them here made the largest panel on screen
 * the least informative. Worse, the label said "TOTAL P&L" while the big number was the BALANCE,
 * painted red whenever P&L was negative — a positive $894.78 rendered as if it were a loss.
 *
 * The five-stat row that used to sit along the bottom is gone from the canvas: it needed a scrim
 * to stay readable, and that scrim ate the lower third of the terrain — of the one panel whose
 * entire job is to BE the terrain. The same numbers now live in the tile header (see heroMeta),
 * where they cost no artwork at all.
 *
 * The terrain itself is kept exactly as it was (owner's call — a reimagined version was rejected
 * before). What is new is that something real now rides ON the terrain: the wave's own blips grew
 * into cards carrying the coin's pump.fun art and market cap. They were briefly a fixed card in
 * the corner instead, which the owner rejected — floating beside the terrain rather than landing
 * on it made the terrain look like a backdrop for a widget, when the whole point is that the
 * coins ARE the terrain. No wallet figures here; the wallet tile owns those.
 */
/** Header meta for the hero tile — the counts that used to be painted over the terrain. */
export function heroMeta(data: StatsResponse): string {
  const field = data.launchField ?? [];
  const spanSec = field.length ? Math.max(...field.map((p) => p.a)) : 0;
  const perMin = spanSec > 0 ? field.length / (spanSec / 60) : 0;
  const inBand = field.filter((p) => p.mc >= 55 && p.mc <= 100).length;
  return `${field.length} peluncuran · ${perMin.toFixed(0)}/mnt · ${inBand} lahir di band`;
}

export function Hero({ data }: { data: StatsResponse }) {
  const coins = (data.market?.new ?? []).concat(data.market?.top ?? []);
  return (
    <div className="relative h-full overflow-hidden">
      <HeroWave pnlPct={data.combined?.pnlPct ?? 0} confirmed={data.momentum.confirmed} scan={data.scan ?? []} coins={coins} />
    </div>
  );
}
