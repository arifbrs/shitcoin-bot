import { useEffect, useState } from "react";
import { fetchWallet } from "@/lib/api";
import type { StatsResponse, WalletInfo } from "@/types/stats";

/**
 * LIVE WALLET — what replaces the paper "Dompet" panel once real money is armed.
 *
 * The first live run put a red LIVE badge directly above the paper simulation's $2,432 /
 * +831.5% equity curve, while the real wallet held 0.2486 SOL and had traded four times for
 * -0.0076 SOL. Showing both at once was not a compromise, it was the worst of the two: the eye
 * takes the biggest number on the screen as the answer.
 *
 * The chart is deliberately the SAME TAPE as EquityCurve, for the same reasons documented
 * there: bars rather than a curve, because whether a drawdown is a steady bleed or a couple of
 * cliffs is real risk information and interpolation erases it. The first version drew a thin
 * polyline stretched across the tile, which read as a smooth trend from four discrete trades —
 * flattering, and false. One scale serves both directions so a +0.001◎ bar and a -0.001◎ bar
 * are the same height, and the zero line sits where zero actually falls in the range.
 *
 * Every figure comes from the chain or the append-only `live-exec` log. Nothing is borrowed
 * from the paper model, not even the tape's scale.
 */
export function LiveWallet({ data }: { data: StatsResponse | null }) {
  const b = data?.liveBridge;
  const s = b?.summary;
  const [wallet, setWallet] = useState<WalletInfo | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => fetchWallet().then((w) => alive && setWallet(w)).catch(() => {});
    load();
    const t = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const balance = wallet && wallet.mainnet >= 0 ? wallet.mainnet : null;
  const rate = data?.combined?.solUsd ?? null;
  const net = s?.netSol ?? 0;
  const trades = s?.trades ?? 0;
  const spent = s?.spentSol ?? 0;
  const netPct = s?.netPct ?? null;
  const clip = typeof b?.clipSol === "number" ? b.clipSol : null;
  const cap24 = b?.caps?.maxDailySpendSol ?? 0;
  const capDep = b?.caps?.maxDeployedSol ?? 0;
  const deployed = b?.deployedSol ?? 0;
  const budgetLeft = Math.max(0, cap24 - (b?.spentLast24h ?? 0));
  const buysLeft = clip && clip > 0 ? Math.floor(budgetLeft / clip) : 0;

  // ── TAPE (identical geometry to EquityCurve) ────────────────────────────────
  // One bar per settled trade, cumulative realised SOL. Baseline is a true zero here — live
  // P&L starts at nothing — so no first-sample subtraction is needed or wanted.
  const eq = s?.equitySol ?? [];
  const N = Math.min(eq.length, 76);
  const dev = N > 0 ? Array.from({ length: N }, (_, i) => eq[Math.floor((i * eq.length) / N)]!) : [];
  const PLOT_H = 96;
  const TOP = 2;
  const maxUp = Math.max(0, ...dev);
  const maxDown = Math.max(0, ...dev.map((d) => -d));
  const span = maxUp + maxDown;
  const flat = span < 1e-12;
  const zeroY = flat ? TOP + PLOT_H / 2 : TOP + (maxUp / span) * PLOT_H;
  const unit = flat ? 0 : PLOT_H / span;
  const peak = Math.max(maxUp, maxDown) || 1;

  const sol = (v: number, d = 5): string => `${v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)} ◎`;
  const pct = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

  const Row = ({ sym, accent, native, quote, dp, share, wl }: {
    sym: string; accent: string; native: string; quote: string; dp: number | null; share: number; wl: string;
  }) => (
    <div className="flex h-[22px] items-center gap-2">
      <span className="w-8 font-mono text-[9px] tracking-widest" style={{ color: accent }}>{sym}</span>
      <span className="w-[92px] font-mono text-[11.5px] tabular-nums text-foreground">{native}</span>
      <span className="w-[70px] font-mono text-[9.5px] tabular-nums text-muted-foreground/60">{quote}</span>
      <span className={`w-[48px] font-mono text-[10px] tabular-nums ${dp == null ? "text-muted-foreground/60" : dp >= 0 ? "text-up" : "text-down"}`}>
        {dp == null ? "—" : pct(dp)}
      </span>
      <span className="h-[4px] flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full opacity-60" style={{ width: `${Math.min(100, Math.max(0, share)).toFixed(0)}%`, background: accent }} />
      </span>
      <span className="w-[62px] text-right font-mono text-[9px] tabular-nums text-muted-foreground/60">{wl}</span>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end gap-2.5">
        <span className="font-sans text-[26px] leading-none font-semibold tabular-nums">
          {balance == null ? "—" : `${balance.toFixed(4)} ◎`}
        </span>
        {balance != null && rate != null && rate > 0 && (
          <span className="pb-px font-mono text-[13px] tabular-nums text-muted-foreground">${(balance * rate).toFixed(2)}</span>
        )}
        <span className="flex-1" />
        <span className={`pb-0.5 font-mono text-[10px] tabular-nums ${net >= 0 ? "text-up" : "text-down"}`}>
          {trades === 0 ? "belum ada trade" : <>{sol(net)} · {netPct == null ? "—" : pct(netPct)}</>}
        </span>
      </div>

      <p className="mt-0.5 mb-2 font-mono text-[9.5px] tabular-nums text-muted-foreground/60">
        saldo on-chain{rate != null && rate > 0 ? <> · 1 ◎ = ${rate.toFixed(2)}</> : null} · modal keluar {sol(spent, 4)}
        {clip != null && <> · clip {clip} ◎</>}
      </p>

      <Row
        sym="P&L" accent="var(--hud-gold)"
        native={sol(net)}
        quote={rate != null && rate > 0 ? `≈ ${net < 0 ? "−" : ""}$${Math.abs(net * rate).toFixed(2)}` : "—"}
        dp={trades > 0 ? netPct : null}
        share={spent > 0 ? Math.min(100, (Math.abs(net) / spent) * 100) : 0}
        wl={trades > 0 ? `${s?.wins}W/${s?.losses}L` : "0 trade"}
      />
      <Row
        sym="RISK" accent="var(--hud-scout)"
        native={sol(deployed, 4)}
        quote={capDep > 0 ? `cap ${capDep} ◎` : "—"}
        dp={null}
        share={capDep > 0 ? (deployed / capDep) * 100 : 0}
        wl={`${b?.openLots ?? 0} bag`}
      />

      {/* Tape: bars, not a curve — cliff depth and clustering stay visible. */}
      <div className="mt-1.5 min-h-0 flex-1">
        {dev.length > 0 ? (
          <svg width="100%" height="100%" preserveAspectRatio="none" viewBox={`0 0 ${Math.max(N, 1)} 100`}>
            <line x1="0" y1={zeroY.toFixed(2)} x2={Math.max(N, 1)} y2={zeroY} stroke="var(--hud-line)" strokeWidth="0.4" vectorEffect="non-scaling-stroke" />
            {dev.map((d, i) => {
              const h = Math.abs(d) * unit;
              const up = d >= 0;
              return (
                <rect
                  key={i} x={i + 0.12} width={0.76}
                  y={up ? zeroY - h : zeroY} height={Math.max(h, 0.6)}
                  fill={up ? "var(--hud-up)" : "var(--hud-down)"}
                  opacity={0.35 + 0.55 * (Math.abs(d) / peak)}
                />
              );
            })}
          </svg>
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-[10px] text-muted-foreground/60">
            tape muncul setelah trade live pertama selesai
          </div>
        )}
      </div>

      <p className="mt-1 font-mono text-[8.5px] leading-tight text-muted-foreground/50">
        {trades} trade live · satu batang = satu trade, tingginya P&amp;L kumulatif sejak nol · sisa budget 24j{" "}
        {cap24 > 0 ? `${budgetLeft.toFixed(3)} ◎ (${buysLeft} beli)` : "—"}
        {b?.halted ? ` · ⛔ HALTED: ${b.haltReason ?? "kill switch"}` : b?.armed ? "" : " · tombol tidak di LIVE, tidak ada SOL keluar"}
      </p>
    </div>
  );
}
