import type { OpenPosition } from "@/types/stats";

function fmtHeld(sec: number): string {
  if (sec < 60) return `${sec}d`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}d`;
  return `${Math.floor(m / 60)}j ${m % 60}m`;
}

/**
 * POSITION CARD — poster form, chosen by the owner from four candidates (2026-08-05).
 *
 * The previous card led with a full-height gain chart and a percentage. That answered "how is it
 * doing" and nothing else — while the two rules that actually end 60% of positions, the trailing
 * stop and the no-development timer, stayed invisible right up until they fired. This card is
 * built around those two instead:
 *
 *   outer ring  time used against the position's own budget (short no-development clock while it
 *               has not developed, max-hold once it has)
 *   inner ring  distance travelled toward the trailing stop — full means sold
 *   footer      appears only when either passes 80%, naming which one and the remaining room
 *
 * GLOW FOLLOWS P&L, not danger (owner's call, and it is the more truthful signal): a position at
 * +30% closing in on its trail is banking a win, not in trouble. A red card there would read as an
 * alarm about a good outcome.
 *
 * Every number is served, never derived here — S1's trail is a LADDER (+15% peak → 6% giveback,
 * +300% → 45%), so a constant in the UI would draw a stop that does not exist.
 */
export function PositionCard({ position, tag }: { position: OpenPosition; tag?: "S1" | "S2" }) {
  const pnl = position.unrealizedPnl ?? 0;
  const up = pnl >= 0;
  const accent = up ? "var(--hud-up)" : "var(--hud-down)";
  const held = position.heldSec ?? 0;

  const peakPct = position.peakPct ?? 0;
  const fromPeakPct = position.fromPeakPct ?? 0;
  const trailPct = position.trailPct ?? 0;
  const budgetSec = position.budgetSec ?? 0;

  // Both rings are "fraction of the way to being closed". Guard the divisors: a position whose
  // engine has not reported a trail or a budget must render an EMPTY ring, never a full one —
  // a full ring means "about to sell" and inventing that from a missing field would be a lie.
  const trailUsed = trailPct > 0 ? Math.min(1, Math.abs(Math.min(0, fromPeakPct)) / trailPct) : 0;
  const timeUsed = budgetSec > 0 ? Math.min(1, held / budgetSec) : 0;
  const hot = Math.max(trailUsed, timeUsed) >= 0.8;

  const trailRoom = Math.max(0, trailPct - Math.abs(Math.min(0, fromPeakPct)));
  const timeRoom = Math.max(0, budgetSec - held);
  const why = trailUsed >= timeUsed
    ? `tinggal ${trailRoom.toFixed(1)}% lagi ke trailing stop`
    : `tinggal ${fmtHeld(timeRoom)} lagi · ${position.budgetLabel ?? "batas"}`;

  const R1 = 27, R2 = 21, C1 = 2 * Math.PI * R1, C2 = 2 * Math.PI * R2;
  const solPnl = position.sizeSol != null ? position.sizeSol * (pnl / 100) : null;
  const usdPnl = position.entryCostUsd != null ? position.entryCostUsd * (pnl / 100) : null;

  const art = position.img ?? position.image ?? null;

  return (
    <div
      className="@container relative overflow-hidden rounded-xl border p-3 transition-colors"
      style={{
        background: "var(--hud-card)",
        borderColor: hot ? `color-mix(in srgb, ${accent} 40%, transparent)` : "var(--hud-line)",
        boxShadow: hot ? `0 0 0 1px color-mix(in srgb, ${accent} 12%, transparent), 0 8px 30px -12px color-mix(in srgb, ${accent} 45%, transparent)` : undefined,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 90% at 15% 20%, color-mix(in srgb, ${accent} ${hot ? 20 : 13}%, transparent), transparent 70%)` }}
      />
      {hot && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div
            className="absolute inset-y-0 w-[42%] animate-[poscard-sweep_2.8s_linear_infinite] motion-reduce:hidden"
            style={{ background: `linear-gradient(90deg, transparent, color-mix(in srgb, ${accent} 10%, transparent), transparent)` }}
          />
        </div>
      )}

      <div className="relative flex items-center gap-3">
        <div className="relative h-[52px] w-[52px] shrink-0 @[300px]:h-[62px] @[300px]:w-[62px]">
          <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full -rotate-90">
            <circle cx="32" cy="32" r={R1} fill="none" stroke="var(--hud-line)" strokeWidth="2.5" />
            <circle cx="32" cy="32" r={R1} fill="none" stroke="var(--hud-gold)" strokeOpacity="0.8" strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${(C1 * timeUsed).toFixed(1)} ${C1.toFixed(1)}`} />
            <circle cx="32" cy="32" r={R2} fill="none" stroke="var(--hud-line)" strokeWidth="2.5" />
            <circle cx="32" cy="32" r={R2} fill="none" stroke={trailUsed > 0.8 ? accent : "var(--hud-acid)"} strokeWidth="2.5" strokeLinecap="round"
              strokeDasharray={`${(C2 * trailUsed).toFixed(1)} ${C2.toFixed(1)}`}
              className={trailUsed > 0.8 ? "animate-pulse motion-reduce:animate-none" : undefined} />
          </svg>
          <div className="absolute inset-[11px] @[300px]:inset-[13px]">
            {art ? (
              <img src={art} alt="" loading="lazy" className="h-[30px] w-[30px] rounded-[9px] object-cover @[300px]:h-9 @[300px]:w-9"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
            ) : (
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-muted font-mono text-[11px] text-muted-foreground @[300px]:h-9 @[300px]:w-9">
                {(position.symbol || "?").slice(0, 1)}
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            {tag && <span className={`rounded px-1 text-[8px] font-semibold ${tag === "S1" ? "bg-scout/15 text-scout" : "bg-gold/15 text-gold"}`}>{tag}</span>}
            <span className="truncate font-mono text-[12px] font-semibold">{position.symbol}</span>
          </div>
          {/* One line, clipped — wrapping badges pushed the card taller than its row and spilled
              "0 holders" onto its own line under the icon. */}
          <div className="mt-1 flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap">
            {peakPct >= 5 ? (
              <span className="shrink-0 rounded bg-acid/10 px-1 py-px font-mono text-[8px] text-acid">puncak +{peakPct.toFixed(0)}%</span>
            ) : (
              <span className="shrink-0 rounded bg-muted px-1 py-px font-mono text-[8px] text-muted-foreground">belum berkembang</span>
            )}
            {position.marketCap != null && (
              <span className="shrink-0 font-mono text-[8.5px] text-muted-foreground/70">
                MC {position.marketCap >= 1e6 ? `$${(position.marketCap / 1e6).toFixed(2)}M` : `$${Math.round(position.marketCap / 1e3)}k`}
              </span>
            )}
            {position.holders != null && <span className="hidden shrink-0 font-mono text-[8.5px] text-muted-foreground/70 @[330px]:inline">{position.holders} holders</span>}
          </div>
        </div>

        {/* shrink-0 + its own min width: the percentage is the one thing that must never be
            compressed into the badges next to it, which is exactly what happened when this card
            was previewed at 392px and then rendered in a 190px grid cell. */}
        <div className="shrink-0 text-right">
          <div className="font-mono text-[17px] font-semibold leading-none tabular-nums @[300px]:text-[22px]" style={{ color: accent }}>
            {up ? "+" : "−"}{Math.abs(pnl).toFixed(1)}%
          </div>
          {solPnl != null && (
            <div className="mt-1 font-mono text-[9.5px] tabular-nums" style={{ color: accent }}>
              {solPnl >= 0 ? "+" : "−"}{Math.abs(solPnl).toFixed(4)}◎
            </div>
          )}
          {solPnl == null && usdPnl != null && (
            <div className="mt-1 font-mono text-[9.5px] tabular-nums" style={{ color: accent }}>
              {usdPnl >= 0 ? "+" : "−"}${Math.abs(usdPnl).toFixed(2)}
            </div>
          )}
          <div className="mt-0.5 font-mono text-[8.5px] tabular-nums text-muted-foreground/60">
            {fmtHeld(held)}{budgetSec > 0 ? ` / ${fmtHeld(budgetSec)}` : ""}
          </div>
        </div>
      </div>

      {hot && (
        <div className="relative mt-2.5 flex items-center gap-1.5 border-t pt-2 font-mono text-[9px]"
             style={{ borderColor: `color-mix(in srgb, ${accent} 16%, transparent)`, color: accent }}>
          <span className="h-[5px] w-[5px] animate-pulse rounded-full motion-reduce:animate-none" style={{ background: accent }} />
          {why}
        </div>
      )}
    </div>
  );
}
