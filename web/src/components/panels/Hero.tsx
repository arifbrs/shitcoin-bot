import type { StatsResponse } from "@/types/stats";
import { HeroWave } from "./HeroWave";

/**
 * Layout fixed (owner found live, 2026-07-29): this used to vertically-center a fixed-size
 * number block inside `h-full`, which looked fine on a modest window but left a huge dead void
 * above/below the text on a wide/tall monitor where the tile itself grows much taller than the
 * text ever does. Pinned to the TOP now (matches the old dashboard's own `.hTop{top:14px}`
 * layout) with a responsive clamp() font size, so the number scales up to actually use the space
 * on a big tile instead of just floating small in the middle of it.
 */
export function Hero({ data }: { data: StatsResponse }) {
  // ONE bankroll. This used to read Strategy 2 alone while the journal beside it listed both
  // strategies, so Strategy 1's wins scrolled past a headline that could never move.
  const c = data.combined;
  const p = data.strategy2Primary?.paper;
  if (!c || c.totalUsd == null || c.floatUsd == null) {
    // No live SOL rate → the SOL leg has no honest USD value. Say that instead of showing a
    // total that quietly omits half the money.
    return <p className="font-mono text-xs text-muted-foreground">Menunggu kurs SOL/USD…</p>;
  }

  const pnl = c.pnlUsd ?? 0;
  const pnlPct = c.pnlPct ?? 0;
  const neg = pnl < 0;
  const wr = c.wins + c.losses ? Math.round((c.wins / (c.wins + c.losses)) * 100) : 0;
  const s1Pnl = c.s1.balanceUsd != null && c.s1.floatUsd != null ? c.s1.balanceUsd - c.s1.floatUsd : null;
  const s2Pnl = c.s2.balanceUsd - c.s2.floatUsd;
  void p;

  return (
    <div className="relative h-full overflow-hidden">
      <HeroWave pnlPct={pnlPct} confirmed={data.momentum.confirmed} scan={data.scan} />
      {/* Scrim. The text always sat ABOVE the canvas (z-10), so this was never a stacking bug —
          it was contrast: dim muted-foreground rows over a dense field of bright dots are simply
          unreadable, which is what the breakdown line (S1/S2/SOL) had become. Fading the tile
          colour down over the top two-thirds restores legibility where the numbers are and leaves
          the wave fully visible below them, where it is decoration rather than a background. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[68%] bg-gradient-to-b from-card via-card/85 to-transparent" />
      <div className="relative z-10">
        <p
          className={`font-sans font-semibold tracking-tight ${neg ? "text-down" : "text-up"}`}
          style={{ fontSize: "clamp(2.25rem, 5.5cqw, 4.5rem)" }}
        >
          ${c.totalUsd.toFixed(2)}
        </p>
        <div className="mt-2 flex items-center gap-3 font-mono text-[clamp(10px,1cqw,13px)]">
          <span className={neg ? "text-down" : "text-up"}>
            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-muted-foreground">WIN {wr}%</span>
          <span className="text-muted-foreground/40">·</span>
          <span className="text-muted-foreground">{c.wins}W/{c.losses}L</span>
        </div>
        {/* Strategy is a property of the trades, not of a separate wallet — so the split lives
            here as a breakdown of one balance rather than as two competing headline numbers. */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[clamp(9px,0.85cqw,11px)]">
          <span className="text-scout">
            S1 sniper ${c.s1.balanceUsd?.toFixed(2) ?? "—"}
            {s1Pnl != null && <span className={s1Pnl < 0 ? " text-down" : " text-up"}> {s1Pnl >= 0 ? "+" : ""}{s1Pnl.toFixed(2)}</span>}
            <span className="text-muted-foreground/60"> · {c.s1.wins}W/{c.s1.losses}L</span>
          </span>
          <span className="text-gold">
            S2 scout ${c.s2.balanceUsd.toFixed(2)}
            <span className={s2Pnl < 0 ? " text-down" : " text-up"}> {s2Pnl >= 0 ? "+" : ""}{s2Pnl.toFixed(2)}</span>
            <span className="text-muted-foreground/60"> · {c.s2.wins}W/{c.s2.losses}L</span>
          </span>
          <span className="text-muted-foreground/50">
            {c.s1.balanceSol.toFixed(3)} SOL @ ${c.solUsd?.toFixed(2) ?? "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
