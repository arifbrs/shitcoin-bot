import { useEffect, useState } from "react";
import { fetchWallet } from "@/lib/api";
import type { StatsResponse, WalletInfo } from "@/types/stats";

/**
 * LIVE WALLET — what replaces the paper "Dompet" panel once real money is armed.
 *
 * The first live run put a red LIVE badge directly above the paper simulation's $2,432 /
 * +831.5% equity curve, while the real wallet held 0.2486 SOL and had traded four times for
 * -0.0076 SOL. Showing both at once was not a compromise, it was the worst of the two: the eye
 * takes the biggest number on the screen as the answer. When live is armed the paper wallet is
 * archived out of the layout entirely and this takes its place.
 *
 * Every figure here comes from the chain or from the append-only `live-exec` log. Nothing is
 * borrowed from the paper model, not even the sparkline's scale.
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
  const solUsd = data?.combined?.solUsd ?? null;
  const net = s?.netSol ?? 0;
  const trades = s?.trades ?? 0;
  const eq = s?.equitySol ?? [];
  const clip = typeof b?.clipSol === "number" ? b.clipSol : null;
  const cap24 = b?.caps?.maxDailySpendSol ?? 0;
  const budgetLeft = Math.max(0, cap24 - (b?.spentLast24h ?? 0));
  const buysLeft = clip && clip > 0 ? Math.floor(budgetLeft / clip) : 0;

  // Sparkline over cumulative realised SOL. Zero line floats with the data — a flat series must
  // not render as a curve, and an all-negative series must not look like it crosses zero.
  const spark = (() => {
    if (eq.length < 2) return null;
    const lo = Math.min(0, ...eq);
    const hi = Math.max(0, ...eq);
    const span = hi - lo || 1;
    const W = 100, H = 28;
    const pts = eq.map((v, i) => `${(i / (eq.length - 1)) * W},${H - ((v - lo) / span) * H}`).join(" ");
    const zeroY = H - ((0 - lo) / span) * H;
    return { pts, zeroY, W, H };
  })();

  return (
    <div className="flex h-full flex-col justify-between gap-3">
      <div>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[26px] leading-none font-semibold text-foreground">
            {balance == null ? "—" : `${balance.toFixed(4)}◎`}
          </span>
          {balance != null && solUsd != null && (
            <span className="font-mono text-xs text-muted-foreground">${(balance * solUsd).toFixed(2)}</span>
          )}
          <span className={`font-mono text-xs font-semibold ${net >= 0 ? "text-up" : "text-down"}`}>
            {trades > 0 ? `${net >= 0 ? "+" : ""}${net.toFixed(5)}◎` : "belum ada trade"}
          </span>
          {s?.netPct != null && (
            <span className={`font-mono text-[10px] ${net >= 0 ? "text-up" : "text-down"}`}>
              ({s.netPct >= 0 ? "+" : ""}{s.netPct.toFixed(1)}%)
            </span>
          )}
        </div>
        <p className="mt-1 font-mono text-[9px] text-muted-foreground">
          saldo on-chain · P&amp;L direalisasi dari {trades} trade live{trades > 0 ? ` · ${s?.wins}W/${s?.losses}L` : ""}
        </p>
      </div>

      {spark ? (
        <svg viewBox={`0 0 ${spark.W} ${spark.H}`} preserveAspectRatio="none" className="h-16 w-full">
          <line x1="0" y1={spark.zeroY} x2={spark.W} y2={spark.zeroY} stroke="currentColor" strokeWidth="0.3" className="text-border" />
          <polyline
            points={spark.pts}
            fill="none"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            className={net >= 0 ? "stroke-up" : "stroke-down"}
          />
        </svg>
      ) : (
        <p className="py-4 text-center font-mono text-[10px] text-muted-foreground">
          kurva muncul setelah 2 trade live selesai
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px]">
        <div className="flex justify-between text-muted-foreground">
          <span>posisi live</span>
          <span className="text-foreground">{b?.openLots ?? 0} · {(b?.deployedSol ?? 0).toFixed(4)}◎</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>modal keluar</span>
          <span className="text-foreground">{(s?.spentSol ?? 0).toFixed(4)}◎</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>sisa budget 24j</span>
          <span className={buysLeft <= 2 ? "text-gold" : "text-foreground"}>
            {cap24 > 0 ? `${budgetLeft.toFixed(3)}◎` : "—"}
          </span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>beli tersisa</span>
          <span className={buysLeft <= 2 ? "text-gold" : "text-foreground"}>
            {clip != null ? `${buysLeft} × ${clip}◎` : "—"}
          </span>
        </div>
      </div>

      {b?.halted && (
        <p className="rounded-md border border-down/40 bg-down/5 p-2 font-mono text-[10px] text-down">
          ⛔ HALTED — {b.haltReason ?? "kill switch"}. Tidak ada pembelian baru sampai di-resume.
        </p>
      )}
      {!b?.armed && (
        <p className="font-mono text-[9px] text-muted-foreground">
          Tombol sedang tidak di LIVE — tidak ada SOL yang keluar. Angka di atas adalah hasil live yang sudah terjadi.
        </p>
      )}
    </div>
  );
}
