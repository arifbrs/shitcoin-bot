import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import type { StatsResponse } from "@/types/stats";

export function EquityCurve({ data }: { data: StatsResponse }) {
  // ONE wallet, same as the Hero. This panel used to draw Strategy 2 alone, so it showed $781.16
  // beside a headline of $892.48 — two balances on one screen again, which is precisely what
  // combining the wallet was supposed to end.
  const c = data.combined;
  const s2 = data.strategy2Primary;
  const paper = s2?.paper;
  if (!paper) return <p className="font-mono text-xs text-muted-foreground">Strategy 2 belum jalan.</p>;

  const points = (c?.equity ?? []).map((e, i) => ({ i, bal: e.bal }));
  const floatUsd = c?.floatUsd ?? 0;
  const balUsd = c?.totalUsd ?? 0;
  const min = Math.min(...points.map((p) => p.bal), floatUsd);
  const max = Math.max(...points.map((p) => p.bal), floatUsd);
  const neg = balUsd < floatUsd;
  const color = neg ? "var(--hud-down)" : "var(--hud-up)";
  const delta = balUsd - floatUsd;

  const bySource = s2?.bySource ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-baseline justify-between">
        <span className="font-sans text-xl font-semibold text-foreground">${balUsd.toFixed(2)}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {min.toFixed(2)}–{max.toFixed(2)}
        </span>
      </div>
      <p className={`mb-1 font-mono text-[10px] ${neg ? "text-down" : "text-up"}`}>
        {delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(2)} vs ${floatUsd.toFixed(2)}
      </p>

      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis domain={[min, max]} hide />
            <Area type="monotone" dataKey="bal" stroke={color} strokeWidth={1.5} fill="url(#equityFill)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {bySource.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {bySource.map((b) => {
            const up = b.pnlUsd >= 0;
            return (
              <span key={b.source} className="rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-muted-foreground">
                {b.source}{" "}
                {b.n > 0 ? (
                  <>
                    <b className={up ? "text-up" : "text-down"}>{up ? "+" : ""}${b.pnlUsd.toFixed(2)}</b> · {Math.round(b.winRate * 100)}% ({b.n})
                  </>
                ) : (
                  <span className="text-muted-foreground/60">no closes yet</span>
                )}
                {b.openN > 0 && <span className="text-muted-foreground/60"> · {b.openN} open</span>}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
