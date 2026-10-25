import { useEffect, useRef } from "react";
import type { LaunchPoint } from "@/types/stats";

/**
 * MARKET RADAR — the live pump.fun launch stream, with our entry band drawn as a ring.
 *
 * Replaces the old terrain canvas, whose two data inputs were both dead: `amp` read
 * `min(1.1, confirmed/40)` against a counter sitting at 1347 (saturated since it passed 44) plus
 * `max(0, pnlPct/60)` which is always 0 while P&L is negative — so it had been pinned at exactly
 * 1.9 for a very long time. The "energy" term was `(confirmed % 12)/12`, and the original comment
 * conceded it was "not meant to mean anything on its own".
 *
 * Every mark here is a real launch: angle = how long ago, radius = the curve market cap it was
 * born at. The shape carries the fact the whole strategy rests on — pump.fun's virtual reserves
 * are identical for every token at creation, so ~all coins appear on the same inner circle at
 * 27.96 ◎, and anything further out is the creator's own buy inside the create transaction.
 * The highlighted annulus is the 55–100 ◎ entry band, which makes "how rare is our setup"
 * something you see rather than read.
 *
 * No money figures: the wallet panel owns those, and duplicating them here is what made the old
 * hero redundant with the tile beside it.
 */
export function HeroRadar({ field, sweepSec = 8 }: { field: LaunchPoint[]; sweepSec?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef(field);
  dataRef.current = field;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = window.devicePixelRatio || 1;
    let W = 0, H = 0, raf = 0;

    const fit = (): void => {
      const r = cv.parentElement!.getBoundingClientRect();
      W = r.width; H = r.height;
      cv.width = Math.max(1, W * DPR); cv.height = Math.max(1, H * DPR);
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (cv.parentElement) ro.observe(cv.parentElement);

    // Log radius: 27.96 (every launch) sits near the centre, 400 ◎ at the rim.
    const LO = Math.log(27), HI = Math.log(430);
    const rad = (mc: number, R: number): number => ((Math.log(Math.max(mc, 27)) - LO) / (HI - LO)) * R;
    const BAND: [number, number] = [55, 100];

    const t0 = performance.now();
    const draw = (now: number): void => {
      const pts = dataRef.current;
      const maxAge = Math.max(60, ...pts.map((p) => p.a));
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 26;
      const sweep = ((now - t0) / (sweepSec * 1000)) % 1 * Math.PI * 2 - Math.PI / 2;

      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(26,29,36,1)"; ctx.lineWidth = 1;
      for (const k of [0.34, 0.67, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, Math.PI * 2); ctx.stroke(); }

      // Entry band as an annulus.
      const r1 = rad(BAND[0], R), r2 = rad(BAND[1], R);
      ctx.fillStyle = "rgba(232,197,106,.07)";
      ctx.beginPath(); ctx.arc(cx, cy, r2, 0, Math.PI * 2); ctx.arc(cx, cy, r1, 0, Math.PI * 2, true); ctx.fill();
      ctx.strokeStyle = "rgba(232,197,106,.28)"; ctx.setLineDash([3, 3]);
      for (const rr of [r1, r2]) { ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke(); }
      ctx.setLineDash([]);

      for (const p of pts) {
        const ang = (1 - p.a / maxAge) * Math.PI * 2 - Math.PI / 2;
        const rr = rad(p.mc, R);
        let d = sweep - ang; while (d < 0) d += Math.PI * 2; while (d > Math.PI * 2) d -= Math.PI * 2;
        const lit = Math.max(0, 1 - d / (Math.PI * 1.4)); // re-lit as the sweep passes
        const band = p.mc >= BAND[0] && p.mc <= BAND[1];
        const big = p.mc > 120;
        ctx.globalAlpha = (band ? 0.34 : 0.10) + lit * (band ? 0.62 : 0.42);
        ctx.fillStyle = band ? "#e8c56a" : big ? "#c9f04a" : "#7f8a96";
        ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, band ? 3 : 1.3, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;

      const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R);
      g.addColorStop(0, "rgba(201,240,74,0)"); g.addColorStop(1, "rgba(201,240,74,.5)");
      ctx.strokeStyle = g; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R); ctx.stroke();

      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [sweepSec]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}
