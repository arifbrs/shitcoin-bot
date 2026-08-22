import { useEffect, useRef } from "react";
import type { MarketCoin } from "@/types/stats";

interface Blip { sym: string; pass: boolean; gx: number; gy: number; age: number; img?: string; mc?: number }

/** Logos are remote pump.fun URLs; cache the Image objects so a blip never re-requests art. */
const artCache = new Map<string, HTMLImageElement>();
function art(url: string): HTMLImageElement {
  let im = artCache.get(url);
  if (!im) { im = new Image(); im.src = url; artCache.set(url, im); }
  return im;
}
const short = (v: number): string =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}k` : `$${Math.round(v)}`;

/**
 * FAITHFUL port (owner, 2026-07-30 — a prior "reimagined" version was rejected as looking
 * "basic/childish", nothing like the real one) of the OLD dashboard's `#terrain` canvas from
 * public/_archive-pre-react/app.html (lines ~718-771): a 130×78 grid of value-noise terrain
 * height, ray-projected with a fake isometric perspective (far rows dim/small = depth, near rows
 * bright/large), rendered as a DOT FIELD (never a filled wave shape) — same noise/projection/
 * dot-rendering math, translated 1:1 into a React canvas ref + effect instead of re-derived from
 * scratch. `energy`/`amp` targets react to pnlPct/momentum exactly as the old version's amp/en did.
 */
export function HeroWave({ pnlPct, confirmed, scan, coins = [] }: {
  pnlPct: number; confirmed: number; scan: Array<{ s: string; p: boolean }>; coins?: MarketCoin[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const coinsRef = useRef(coins);
  coinsRef.current = coins;
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
    let spawnAcc = 0, spawnEvery = 850, rnd = 1, coinTurn = false;
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
        // Alternate the two real feeds so the terrain shows both what the bot is judging (scan)
        // and what the market is minting (coins, the only source that carries art + market cap).
        const pool = coinsRef.current;
        coinTurn = !coinTurn;
        let spawned: Blip | undefined;
        const at = { gx: COLS * 0.24 + R() * (COLS * 0.52), gy: ROWS * 0.5 + R() * (ROWS * 0.3), age: 0 };
        if (coinTurn && pool.length) {
          const c = pool[Math.floor(R() * pool.length)]!;
          if (c.img) art(c.img);   // start the fetch a beat before it is drawn
          spawned = { sym: c.symbol || "?", pass: false, ...at, img: c.img ?? undefined, mc: c.mcUsd ?? undefined };
        } else {
          let item = scanQueue.shift();
          if (!item && scanRef.current.length) item = scanRef.current[Math.floor(R() * scanRef.current.length)];
          if (item) spawned = { sym: item.s, pass: item.p, ...at };
        }
        if (spawned) {
          blips.push(spawned);
          if (blips.length > 12) blips.shift();
        }
      }

      ctx!.textAlign = "start";
      for (let i = blips.length - 1; i >= 0; i--) {
        const b = blips[i]!;
        b.age += dt;
        const life = 2800;
        if (b.age > life) { blips.splice(i, 1); continue; }
        const k = b.age / life, a = Math.min(1, k * 6) * Math.max(0, 1 - (k - 0.25) / 0.75);
        if (a <= 0) continue;
        const h = th(b.gx, b.gy, t0), P = proj(b.gx, b.gy, h);

        // CARD LAYOUT — measured first so the pill can be clamped inside the canvas as a whole
        // unit. A logo only counts toward the width once it has actually decoded: reserving the
        // slot before then would leave a permanent gap for coins whose art 404s.
        const im = b.img ? art(b.img) : undefined;
        const ready = !!im && im.complete && im.naturalWidth > 0;
        const PAD = 7 * DPR, GAP = 6 * DPR, LOGO = 16 * DPR, CARD_H = 24 * DPR;
        ctx!.font = `${10.5 * DPR}px ui-monospace, Menlo, monospace`;
        const symW = ctx!.measureText(b.sym).width;
        const mcTxt = b.mc != null ? short(b.mc) : "";
        ctx!.font = `${10.5 * DPR}px ui-monospace, Menlo, monospace`;
        const mcW = mcTxt ? ctx!.measureText(mcTxt).width + GAP : 0;
        const cardW = PAD * 2 + (ready ? LOGO + GAP : 0) + symW + mcW;

        const cx0 = Math.max(4 * DPR, Math.min(W - cardW - 4 * DPR, P[0] - cardW / 2));
        const cy0 = Math.max(4 * DPR, P[1] - CARD_H - 10 * DPR);

        // the point on the terrain the card belongs to
        const dotC = b.pass ? "75,208,127" : "150,175,235";
        ctx!.shadowColor = `rgba(${dotC},${a})`;
        ctx!.shadowBlur = 7 * DPR;
        ctx!.fillStyle = `rgba(${dotC},${a})`;
        ctx!.beginPath(); ctx!.arc(P[0], P[1], 2.3 * DPR, 0, 7); ctx!.fill();
        ctx!.shadowBlur = 0;

        // pill
        ctx!.fillStyle = `rgba(9,11,16,${a * 0.86})`;
        ctx!.strokeStyle = `rgba(255,255,255,${a * 0.10})`;
        ctx!.lineWidth = 1 * DPR;
        ctx!.beginPath(); ctx!.roundRect(cx0, cy0, cardW, CARD_H, 8 * DPR); ctx!.fill(); ctx!.stroke();

        let x = cx0 + PAD;
        ctx!.globalAlpha = a;
        if (ready) {
          ctx!.save();
          ctx!.beginPath(); ctx!.roundRect(x, cy0 + (CARD_H - LOGO) / 2, LOGO, LOGO, 4 * DPR); ctx!.clip();
          ctx!.drawImage(im!, x, cy0 + (CARD_H - LOGO) / 2, LOGO, LOGO);
          ctx!.restore();
          x += LOGO + GAP;
        }
        ctx!.globalAlpha = 1;
        ctx!.textBaseline = "middle";
        ctx!.fillStyle = (b.pass ? "rgba(130,244,182," : "rgba(226,231,238,") + a + ")";
        ctx!.fillText(b.sym, x, cy0 + CARD_H / 2);
        if (mcTxt) {
          ctx!.fillStyle = `rgba(201,240,74,${a})`;
          ctx!.fillText(mcTxt, x + symW + GAP, cy0 + CARD_H / 2);
        }
        ctx!.textBaseline = "alphabetic";
      }
      ctx!.textAlign = "start";
      if (!reduce) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    if (reduce) frame(performance.now());

    return () => { window.removeEventListener("resize", rs); cancelAnimationFrame(raf); };
  }, []);

  // VIGNETTE lewat mask CSS, bukan gambar tambahan di kanvas. Alternatifnya menimpa gradien
  // radial tiap frame dengan `destination-out`, yang berarti satu operasi seukuran layar penuh
  // 60x per detik pada panel yang sudah menggambar 10.140 titik per frame. Mask adalah properti
  // compositor: dihitung sekali, gratis saat animasi berjalan, dan tidak menyentuh loop gambar
  // sama sekali.
  //
  // Bentuknya elips yang sedikit turun (pusat 52%) mengikuti proyeksi isometrik terrain — pusat
  // massa titik memang ada di bawah tengah, jadi vignette yang terpusat sempurna akan memudarkan
  // baris depan yang justru paling terang. `-webkit-` disertakan: Safari masih memerlukannya.
  const fade = "radial-gradient(118% 96% at 50% 52%, #000 42%, rgba(0,0,0,0.55) 74%, transparent 100%)";
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ maskImage: fade, WebkitMaskImage: fade }}
    />
  );
}
