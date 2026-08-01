import { useEffect, useRef } from "react";
import type { StatsResponse } from "@/types/stats";
import { useTweenNumber } from "@/hooks/useTweenNumber";

interface Particle {
  x: number;
  lane: number; // fixed at spawn — vertical seat within the cone (0..1, 0.5 = dead center)
  v: number;
  a: number; // base alpha
  dead: boolean;
  deadAt: number | null;
  j: number; // per-particle jitter offset
  trail: Array<[number, number]>;
}

const GATES = [0.125, 0.375, 0.625, 0.875];
const SPREAD = 0.4;
const N = 280;

/**
 * FAITHFUL port (owner, 2026-07-30 — rejected a prior reimagined scatter version, "pipeline dia
 * mengerucut" = it should taper to a cone) of the OLD dashboard's `pipe` IIFE in
 * public/_archive-pre-react/app.html (lines ~931-963): 280 particles each locked to a `lane` at
 * spawn, whose vertical position is pulled toward center (0.5) more strongly as x→1 via
 * `envY(p) = 0.5 + (lane-0.5)*SPREAD*2*(1-x*0.9) + jitter*(1-x*0.6)` — that shrinking spread is
 * literally what produces the cone/funnel shape. 4 gates (at the same x fractions) kill a
 * particle whose lane exceeds that gate's live `keepTo` ratio, computed from the real
 * scanned/passed/entered counts exactly like the original `.set(scan,pass,enter)`.
 */
export function PipelineFunnel({ data }: { data: StatsResponse }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keepToRef = useRef<[number, number, number, number]>([1, 1, 0.05, 0.01]);

  // Three stages that genuinely narrow, all scoped to the current epoch:
  //   SCANNED  every candidate the scout surfaced
  //   PASSED   those that actually reached the admission gate
  //   ENTERED  those the gate accepted
  // Previously SCANNED and PASSED were both the post-filter count (identical, so the first leg of
  // the funnel looked flat) while ENTERED came from a lifetime counter — which is how ENTERED
  // ended up LARGER than SCANNED on screen.
  const gated = data.strategy2Primary?.seenMints ?? data.totals.gated;
  const passed = data.strategy2Primary?.funnel.passed ?? data.funnel.passed;
  const bought = data.strategy2Primary?.funnel.bought ?? data.funnel.bought;

  const scanned = useTweenNumber(gated);
  const passedT = useTweenNumber(passed);
  const entered = useTweenNumber(bought);

  // Same math as the original `.set(scan,pass,enter)` — recomputed every render, read by the RAF
  // loop via a ref so the simulation itself never restarts (gated/bought change on ~every SSE tick).
  const s = Math.max(1, gated);
  keepToRef.current = [1, Math.max(0.06, Math.min(1, (passed * 4) / s)), Math.max(0.02, passed / s), Math.max(0.006, bought / s)];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = window.devicePixelRatio || 1;

    let W = 0, H = 0;
    function rs() {
      const r = canvas!.parentElement!.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * DPR)), h = Math.max(1, Math.round(r.height * DPR));
      if (w !== W || h !== H) { W = canvas!.width = w; H = canvas!.height = h; }
    }
    rs();
    window.addEventListener("resize", rs);

    function spawn(p: Particle, rand: boolean) {
      p.x = rand ? Math.random() : -0.02;
      p.lane = Math.random();
      p.v = 0.0022 + Math.random() * 0.0018;
      p.a = 0.32 + Math.random() * 0.6;
      p.dead = false;
      p.deadAt = null;
      p.j = (Math.random() - 0.5) * 0.05;
    }
    const P: Particle[] = [];
    for (let i = 0; i < N; i++) {
      const p: Particle = { x: 0, lane: 0, v: 0, a: 0, dead: false, deadAt: null, j: 0, trail: [] };
      spawn(p, true);
      P.push(p);
    }
    const envY = (p: Particle) => 0.5 + (p.lane - 0.5) * SPREAD * 2 * (1 - p.x * 0.9) + p.j * (1 - p.x * 0.6);

    let raf: number;
    function draw() {
      rs();
      ctx!.clearRect(0, 0, W, H);
      const keepTo = keepToRef.current;
      for (const p of P) {
        const prev = p.x;
        p.x += p.v;
        for (let g = 0; g < GATES.length; g++) {
          if (prev < GATES[g]! && p.x >= GATES[g]! && p.lane > keepTo[g]!) { p.dead = true; p.deadAt = p.x; }
        }
        const near = 1 - Math.min(1, Math.abs(p.lane - 0.5) * 2);
        const py = envY(p) * H, px = p.x * W;
        let alpha = p.a * (0.16 + near * 0.6);
        if (p.dead) alpha *= Math.max(0, 1 - (p.x - p.deadAt!) * 7);
        if (p.x > 0.9) alpha *= Math.max(0, (1 - p.x) / 0.1);
        p.trail.unshift([px, py]);
        if (p.trail.length > 3) p.trail.pop();
        if (alpha > 0.02) {
          const rC = (120 + near * 55) | 0, gC = (165 + near * 80) | 0, bC = (100 + near * 40) | 0;
          for (let ti = p.trail.length - 1; ti >= 0; ti--) {
            const tp = p.trail[ti]!, ta = alpha * (1 - ti * 0.32);
            ctx!.fillStyle = `rgba(${rC},${gC},${bC},${ta})`;
            const s2 = (near > 0.7 ? 1.7 : 1.05) * DPR;
            ctx!.beginPath(); ctx!.arc(tp[0], tp[1], s2, 0, 7); ctx!.fill();
          }
        }
        if (p.x >= 1 || (p.dead && p.x - p.deadAt! > 0.16)) { spawn(p, false); p.trail.length = 0; }
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    if (reduce) draw();

    return () => { window.removeEventListener("resize", rs); cancelAnimationFrame(raf); };
  }, []);

  const shadowNum = { textShadow: "0 0 10px #06070a, 0 0 6px #06070a" };
  const shadowLbl = { textShadow: "0 0 8px #06070a" };
  const node = (color: string, glow: string) => ({ background: color, boxShadow: `0 0 0 3px ${glow}, 0 0 8px ${glow}` });

  return (
    <div className="relative h-full">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {/* Ported 1:1 from the old .pipeflow (position:absolute; top:50%; translateY(-50%)) — the
          stat labels OVERLAY the vertical center of the particle canvas, they don't sit below it. */}
      <div className="absolute inset-x-3.5 top-1/2 z-10 flex -translate-y-1/2 justify-between font-mono text-[9px]">
        <div className="flex flex-1 flex-col items-center gap-[5px]">
          <p className="text-[15px] font-medium leading-none text-foreground" style={shadowNum}>{scanned}</p>
          <p className="tracking-[0.14em] text-muted-foreground uppercase" style={shadowLbl}>Scanned</p>
          <span className="mt-px h-[7px] w-[7px] rounded-full" style={node("#c8d2dc", "rgba(200,210,220,.14)")} />
        </div>
        <div className="flex flex-1 flex-col items-center gap-[5px]">
          <p className="text-[15px] font-medium leading-none text-up" style={shadowNum}>{passedT}</p>
          <p className="tracking-[0.14em] text-muted-foreground uppercase" style={shadowLbl}>Passed</p>
          <span className="mt-px h-[7px] w-[7px] rounded-full" style={node("#78f08c", "rgba(120,240,140,.16)")} />
        </div>
        <div className="flex flex-1 flex-col items-center gap-[5px]">
          <p className="text-[15px] font-medium leading-none text-gold" style={shadowNum}>{entered}</p>
          <p className="tracking-[0.14em] text-muted-foreground uppercase" style={shadowLbl}>Entered</p>
          <span className="mt-px h-[7px] w-[7px] rounded-full" style={node("#e8c56a", "rgba(232,197,106,.16)")} />
        </div>
      </div>
    </div>
  );
}
