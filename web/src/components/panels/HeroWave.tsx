import { useEffect, useRef } from "react";

interface Blip { sym: string; pass: boolean; gx: number; gy: number; age: number }

/**
 * FAITHFUL port (owner, 2026-07-30 — a prior "reimagined" version was rejected as looking
 * "basic/childish", nothing like the real one) of the OLD dashboard's `#terrain` canvas from
 * public/_archive-pre-react/app.html (lines ~718-771): a 130×78 grid of value-noise terrain
 * height, ray-projected with a fake isometric perspective (far rows dim/small = depth, near rows
 * bright/large), rendered as a DOT FIELD (never a filled wave shape) — same noise/projection/
 * dot-rendering math, translated 1:1 into a React canvas ref + effect instead of re-derived from
 * scratch. `energy`/`amp` targets react to pnlPct/momentum exactly as the old version's amp/en did.
 */
export function HeroWave({ pnlPct, confirmed, scan }: { pnlPct: number; confirmed: number; scan: Array<{ s: string; p: boolean }> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const targetsRef = useRef({ ampT: 1.4, enT: 0.6 });
  // Exact original formula (app.html line 1077): ampT reacts to confirmed-momentum volume + pnl%,
  // enT reacts to confirmed mod 12 (a cheap pseudo-variety wobble, not meant to mean anything on its own).
  targetsRef.current = { ampT: 0.8 + Math.min(1.1, confirmed / 40) + Math.max(0, pnlPct / 60), enT: 0.4 + Math.min(0.9, (confirmed % 12) / 12) };

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = window.devicePixelRatio || 1;

    let W = 0, H = 0, amp = 1.4, en = 0.6;
    function rs() {
      const r = cv!.parentElement!.getBoundingClientRect();
      W = cv!.width = Math.max(1, r.width * DPR);
      H = cv!.height = Math.max(1, r.height * DPR);
    }
    rs();
    window.addEventListener("resize", rs);

    function hash(x: number, y: number) {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    }
    function noise(x: number, y: number) {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    const COLS = 130, ROWS = 78;
    const blips: Blip[] = [];
    let spawnAcc = 0, spawnEvery = 850, rnd = 1;
    const seenScan = new Set<string>();
    const scanQueue: Array<{ s: string; p: boolean }> = [];

    function th(gx: number, gy: number, t: number) {
      const cx = gx - COLS / 2, cy = gy - ROWS / 2;
      const r = Math.sqrt(cx * cx + cy * cy) / (COLS * 0.5);
      const ridge = Math.exp(-r * r * 2.1);
      let n = 0, f = 1, a2 = 1;
      for (let o = 0; o < 4; o++) { n += noise(gx * 0.07 * f + t * 0.15, gy * 0.07 * f - t * 0.05) * a2; f *= 2; a2 *= 0.5; }
      n /= 1.87;
      return (ridge * 1.6 + n * 0.7 * (0.4 + ridge)) * amp;
    }
    function proj(gx: number, gy: number, h: number): [number, number] {
      const ox = W * 0.5, oy = H * 0.62, sx = (W / COLS) * 1.32, sy = H * 0.022;
      return [ox + (gx - COLS / 2) * sx + (gy - ROWS / 2) * sx * 0.16, oy + (gy - ROWS / 2) * sy - h * (H * 0.13)];
    }

    let t0 = 0, last = performance.now(), raf: number;
    function frame(now: number) {
      const dt = Math.min(50, now - last);
      last = now;
      const { ampT, enT } = targetsRef.current;
      t0 += dt * 0.001 * (0.35 + en * 0.9);
      amp += (ampT - amp) * 0.03;
      en += (enT - en) * 0.03;
      ctx!.clearRect(0, 0, W, H);

      for (let gy = 0; gy < ROWS; gy++) {
        for (let gx = 0; gx < COLS; gx++) {
          const h = th(gx, gy, t0);
          const P = proj(gx, gy, h);
          if (P[1] < -16 || P[1] > H + 16) continue;
          const depth = gy / ROWS;
          const persp = 0.18 + depth * 0.82;
          let br = Math.min(1, 0.1 + h * 0.6) * persp;
          if (depth < 0.14) br *= depth / 0.14;
          if (br < 0.05) continue;
          const g = Math.floor(br * 230), peak = Math.max(0, h - 0.78);
          ctx!.fillStyle = `rgba(${g},${Math.min(255, g + ((peak * 80) | 0))},${Math.min(255, g + 12 + ((peak * 46) | 0))},${0.26 + br * 0.6})`;
          const s = (h > 0.95 ? 2.2 : 1) * DPR * (0.55 + depth * 0.75);
          ctx!.fillRect(P[0], P[1], s, s);
        }
      }

      spawnAcc += dt;
      if (spawnAcc >= spawnEvery) {
        spawnAcc = 0;
        const R = () => ((rnd = (rnd * 48271) % 2147483647) / 2147483647);
        spawnEvery = 650 + R() * 700;
        for (const it of scanRef.current) {
          const key = it.s + "|" + it.p;
          if (it.s && it.s !== "?" && !seenScan.has(key)) { seenScan.add(key); scanQueue.push(it); }
        }
        if (seenScan.size > 400) seenScan.clear();
        if (scanQueue.length > 60) scanQueue.splice(0, scanQueue.length - 60);
        let item = scanQueue.shift();
        if (!item && scanRef.current.length) item = scanRef.current[Math.floor(R() * scanRef.current.length)];
        if (item) {
          blips.push({ sym: item.s, pass: item.p, gx: COLS * 0.24 + R() * (COLS * 0.52), gy: ROWS * 0.5 + R() * (ROWS * 0.3), age: 0 });
          if (blips.length > 12) blips.shift();
        }
      }

      ctx!.font = `${10 * DPR}px ui-monospace, Menlo, monospace`;
      ctx!.textAlign = "center";
      for (let i = blips.length - 1; i >= 0; i--) {
        const b = blips[i]!;
        b.age += dt;
        const life = 2800;
        if (b.age > life) { blips.splice(i, 1); continue; }
        const k = b.age / life, a = Math.min(1, k * 6) * Math.max(0, 1 - (k - 0.25) / 0.75);
        if (a <= 0) continue;
        const h = th(b.gx, b.gy, t0), P = proj(b.gx, b.gy, h);
        const tw = ctx!.measureText(b.sym).width, half = tw / 2 + 10 * DPR;
        const tx = Math.max(half, Math.min(W - half, P[0])), ty = P[1] - 9 * DPR;
        const dotC = b.pass ? "75,208,127" : "150,175,235";
        ctx!.shadowColor = `rgba(${dotC},${a})`;
        ctx!.shadowBlur = 7 * DPR;
        ctx!.fillStyle = `rgba(${dotC},${a})`;
        ctx!.beginPath(); ctx!.arc(P[0], P[1], 2.3 * DPR, 0, 7); ctx!.fill();
        ctx!.shadowBlur = 0;
        ctx!.fillStyle = `rgba(8,10,14,${a * 0.62})`;
        ctx!.beginPath();
        ctx!.roundRect(tx - tw / 2 - 6 * DPR, ty - 11 * DPR, tw + 12 * DPR, 15 * DPR, 4 * DPR);
        ctx!.fill();
        ctx!.fillStyle = (b.pass ? "rgba(130,244,182," : "rgba(224,230,238,") + a + ")";
        ctx!.fillText(b.sym, tx, ty);
      }
      ctx!.textAlign = "start";
      if (!reduce) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    if (reduce) frame(performance.now());

    return () => { window.removeEventListener("resize", rs); cancelAnimationFrame(raf); };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />;
}
