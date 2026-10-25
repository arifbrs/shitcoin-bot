import { panelMemo } from "@/lib/panelMemo";
import type { StatsResponse } from "@/types/stats";

/**
 * Compact Strategy 1 (sniper) recap strip — owner, 2026-07-30: reactivated the sniper (dry-run,
 * `npm run demo` under run-sniper-supervised.sh) to run alongside Strategy 2 rather than
 * sequentially, explicitly to stop losing time switching between them one at a time. This is
 * deliberately NOT a rebuild of the old Signals/DNA/Scanner/Risk panels (dropped when Strategy 2
 * became primary) — just enough to see both strategies' headline numbers at a glance in one row.
 */
function SniperRecapInner({ data }: { data: StatsResponse }) {
  const p = data.paper;
  const alive = data.system.sniperAlive;
  // Live view: balance null = on-chain read failed. Show "unreadable" — never $0.00, which
  // told the owner their funded wallet was empty (found live 2026-08-24).
  if (p && p.balanceSol == null) {
    return (
      <div className="flex h-full items-center gap-3 px-1 font-mono text-[10px] text-muted-foreground">
        <span className={`h-[6px] w-[6px] rounded-full ${alive ? "bg-foreground shadow-[0_0_7px_var(--hud-fg)] animate-pulse" : "bg-muted-foreground/40"}`} />
        <span className="tracking-[0.14em] uppercase">{data.liveBridge?.armed ? "LIVE · saldo tidak terbaca" : "Strategy 1 · Sniper"}</span>
        <span>menunggu bacaan on-chain berhasil…</span>
      </div>
    );
  }
  if (!p || p.opens === 0) {
    return (
      <div className="flex h-full items-center gap-3 px-1 font-mono text-[10px] text-muted-foreground">
        <span className={`h-[6px] w-[6px] rounded-full ${alive ? "bg-foreground shadow-[0_0_7px_var(--hud-fg)] animate-pulse" : "bg-muted-foreground/40"}`} />
        <span className="tracking-[0.14em] uppercase">{data.liveBridge?.armed ? "LIVE · uang sungguhan" : "Strategy 1 · Sniper"}</span>
        <span>{alive ? "belum ada trade" : "OFF"}</span>
      </div>
    );
  }
  const bal = p.balanceSol ?? 0;
  const flt = p.floatSol ?? 0;
  const pnl = bal - flt;
  const pnlPct = flt > 0 ? (pnl / flt) * 100 : 0;
  const neg = pnl < 0;

  return (
    <div className="flex h-full items-center gap-x-5 gap-y-1 overflow-x-auto px-1 font-mono text-[10px] whitespace-nowrap">
      <span className="flex items-center gap-2 tracking-[0.14em] text-muted-foreground uppercase">
        <span className={`h-[6px] w-[6px] rounded-full ${alive ? "bg-foreground shadow-[0_0_7px_var(--hud-fg)] animate-pulse" : "bg-muted-foreground/40"}`} />
        {/* The label follows the SOURCE. When armed this strip is fed by lib/liveView, so it
            shows real money — and it previously said "PAPER" over exactly those numbers. */}
        {data.liveBridge?.armed ? "LIVE · uang sungguhan" : "Strategy 1 · Sniper"}
      </span>
      <span className={`font-semibold ${neg ? "text-down" : "text-up"}`}>
        {bal.toFixed(3)}◎
      </span>
      <span className={neg ? "text-down" : "text-up"}>
        {pnl >= 0 ? "+" : ""}{pnl.toFixed(3)}◎ ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)
      </span>
      <span className="text-muted-foreground">WIN {Math.round(p.winRate * 100)}%</span>
      <span className="text-muted-foreground">{p.wins}W/{p.losses}L</span>
      <span className="text-muted-foreground">{p.open} open</span>
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const SniperRecap = panelMemo(SniperRecapInner, (d) => [d.paper?.opens, d.paper?.closed, d.paper?.balanceSol]);
