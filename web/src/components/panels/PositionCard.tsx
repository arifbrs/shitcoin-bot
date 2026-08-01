import { useEffect, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import type { OpenPosition } from "@/types/stats";

function fmtHeld(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtMc(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
}

/**
 * Redesigned position card (owner, 2026-07-29: the old one — a DOM track bar plus a 1px
 * hand-drawn canvas sparkline — was called out as ugly and asked to be genuinely improved, not
 * just ported). This version leads with a full-height gradient area chart of the position's own
 * gain-history, real typographic hierarchy (symbol prominent, stats demoted to a quiet footer
 * row), and a single glanceable pct badge instead of a badge row for sniper-only flags that don't
 * apply to Strategy 2 positions at all (no rug-cluster/dev-buyback/graduated/armed concepts here).
 *
 * History model UNCHANGED from the old dashboard on purpose (same data behavior, just presented
 * better): accumulated client-side in this component's own state, growing for as long as this
 * card instance stays mounted (i.e. since the browser tab opened) — the server only ever sends a
 * current snapshot, not a stored history, same limitation as before.
 */
export function PositionCard({ position, tag }: { position: OpenPosition; tag?: "S1" | "S2" }) {
  const [history, setHistory] = useState<number[]>([]);
  const lastPct = useRef<number | null>(null);
  const pnl = position.unrealizedPnl ?? 0;

  useEffect(() => {
    if (lastPct.current === pnl) return;
    lastPct.current = pnl;
    setHistory((prev) => {
      const next = [...prev, pnl];
      return next.length > 120 ? next.slice(next.length - 120) : next;
    });
  }, [pnl]);

  const up = pnl >= 0;
  const color = up ? "var(--hud-up)" : "var(--hud-down)";
  const chartData = (history.length ? history : [pnl, pnl]).map((v, i) => ({ i, v }));
  const min = Math.min(0, ...chartData.map((d) => d.v));
  const max = Math.max(0, ...chartData.map((d) => d.v));

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-secondary/40">
      <div className="flex items-center justify-between px-3 pt-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {tag && (
            <span className={`rounded px-1 text-[8px] font-semibold ${tag === "S1" ? "bg-scout/15 text-scout" : "bg-gold/15 text-gold"}`}>{tag}</span>
          )}
          <span className="truncate font-mono text-[11px] font-semibold text-foreground">{position.symbol}</span>
        </div>
        <span className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold ${up ? "text-up bg-up/10" : "text-down bg-down/10"}`}>
          {up ? "▲" : "▼"} {Math.abs(pnl).toFixed(1)}%
        </span>
      </div>

      <div className="h-16 px-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 2, bottom: 0, left: 2 }}>
            <defs>
              <linearGradient id={`pos-fill-${position.mint}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis domain={[min, max]} hide />
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} fill={`url(#pos-fill-${position.mint})`} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-3 py-2 font-mono text-[9px] text-muted-foreground">
        <span>held {fmtHeld(position.heldSec ?? 0)}</span>
        <span>MC {position.marketCap != null ? fmtMc(position.marketCap) : "—"}</span>
        <span>{position.holders != null ? `${position.holders} holders` : "holders —"}</span>
      </div>
    </div>
  );
}
