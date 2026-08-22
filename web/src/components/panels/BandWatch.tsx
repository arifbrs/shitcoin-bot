import { useEffect, useRef } from "react";
import { panelMemo } from "@/lib/panelMemo";
import type { StatsResponse } from "@/types/stats";

/** Remote coin art, cached so a redraw never re-requests it. */
const artCache = new Map<string, HTMLImageElement>();
function art(url: string): HTMLImageElement {
  let im = artCache.get(url);
  if (!im) { im = new Image(); im.src = url; artCache.set(url, im); }
  return im;
}

/**
 * BAND WATCH — where inside the entry window the bot is actually buying.
 *
 * The first version was a 24-row list of dots on identical rails, and it was hard to read for a
 * measurable reason rather than a stylistic one: essentially every entry sits between 56 and 66◎,
 * so all 24 dots piled into the left third of every rail while two-thirds stayed empty. A list
 * also cannot answer the question the panel exists for — not "which coins", but "WHERE in the
 * window do entries cluster" — and on this data the answer is striking: they hug the floor.
 *
 * So: a horizontal histogram across the window, one bin per slice of the band, with the coin
 * NAMES drawn inside their own bar (owner's call — the count alone was too anonymous).
 *
 * Names are never truncated mid-word. Symbol is the only identity a coin has here, and "PEPE"
 * recurs across unrelated mints all day, so a clipped "PEP…" would read as the same coin as a
 * different "PEPE". Whatever fits goes in; the rest becomes "+n", and a bar too narrow for even
 * one name puts its names outside rather than forcing them in.
 */
function BandWatchInner({ data }: { data: StatsResponse }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dRef = useRef(data);
  dRef.current = data;

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DPR = window.devicePixelRatio || 1;

    let W = 0, H = 0;
    function rs() {
      const r = cv!.parentElement!.getBoundingClientRect();
      W = r.width; H = r.height;
      cv!.width = Math.max(1, W * DPR); cv!.height = Math.max(1, H * DPR);
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    rs();
    window.addEventListener("resize", rs);

    let grow = 0, raf = 0, last = 0;
    function frame(now: number) {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      const b = dRef.current.bandWatch;
      ctx!.clearRect(0, 0, W, H);
      if (!b || b.entries.length === 0) {
        ctx!.font = "11px ui-monospace, Menlo, monospace";
        ctx!.fillStyle = "rgba(124,130,141,.8)";
        ctx!.fillText("belum ada entry di jendela", 8, 24);
        raf = requestAnimationFrame(frame);
        return;
      }
      grow = reduce ? 1 : Math.min(1, grow + dt * 0.9);

      const lo = b.floorSol, hi = b.ceilSol;
      // Bin count follows height so a bar is never thinner than its own type.
      const BINS = Math.max(5, Math.min(12, Math.floor(H / 34)));
      const TOP = 42, BOT = H - 26;
      const bh = (BOT - TOP) / BINS;
      // Left gutter fits the widest range label; right reserve holds the count.
      ctx!.font = "8px ui-monospace, Menlo, monospace";
      const PAD = Math.min(W * 0.24, ctx!.measureText(`${lo.toFixed(0)}–${hi.toFixed(0)}◎`).width + 12);
      const RESERVE = 26;

      const bins: Array<typeof b.entries> = Array.from({ length: BINS }, () => []);
      for (const e of b.entries) {
        const k = Math.min(BINS - 1, Math.max(0, Math.floor(((e.mcSol - lo) / (hi - lo)) * BINS)));
        bins[k]!.push(e);
      }
      const mx = Math.max(1, ...bins.map((x) => x.length));
      const maxBar = W - PAD - RESERVE - 6;

      bins.forEach((rows, i) => {
        const yy = BOT - (i + 1) * bh;
        const w = Math.max(0, Math.min(maxBar, (rows.length / mx) * maxBar * grow));
        ctx!.fillStyle = `rgba(201,240,74,${0.09 + 0.48 * (rows.length / mx)})`;
        ctx!.fillRect(PAD, yy + 2, w, bh - 4);

        ctx!.font = "8px ui-monospace, Menlo, monospace";
        ctx!.fillStyle = "rgba(124,130,141,.85)";
        ctx!.fillText(`${(lo + ((hi - lo) * i) / BINS).toFixed(0)}–${(lo + ((hi - lo) * (i + 1)) / BINS).toFixed(0)}◎`, 4, yy + bh / 2 + 3);
        if (!rows.length) return;

        ctx!.font = "9px ui-monospace, Menlo, monospace";
        ctx!.fillStyle = "rgba(233,235,238,.9)";
        ctx!.fillText(String(rows.length), PAD + w + 5, yy + bh / 2 + 3);

        // ── names inside the bar ──────────────────────────────────────────
        const S = Math.min(bh - 8, 13), GAP = 4, PADX = 6, F = 8.5;
        ctx!.font = `${F}px ui-monospace, Menlo, monospace`;
        const name = (e: { sym: string }) => e.sym.slice(0, 9);
        const chip = (e: { sym: string }) => S + 3 + ctx!.measureText(name(e)).width;
        const budget = w - PADX * 2;
        let used = 0;
        const show: typeof rows = [];
        for (const e of rows) {
          const cw = chip(e) + (show.length ? GAP : 0);
          if (used + cw > budget) break;
          used += cw; show.push(e);
        }
        let extra = rows.length - show.length;
        if (extra > 0) {
          const ew = ctx!.measureText(`+${extra}`).width + GAP;
          while (show.length && used + ew > budget) {
            const e = show.pop()!;
            used -= chip(e) + (show.length ? GAP : 0);
            extra = rows.length - show.length;
          }
        }
        if (show.length === 0) {
          // Too narrow for even one name — put them outside rather than forcing a clip.
          ctx!.fillStyle = "rgba(154,161,173,.8)";
          ctx!.fillText(rows.map((e) => e.sym.slice(0, 8)).join(" ").slice(0, 20), PAD + w + 18, yy + bh / 2 + 3);
          return;
        }
        const extraW = extra > 0 ? ctx!.measureText(`+${extra}`).width + GAP : 0;
        let cx = PAD + PADX + (budget - used - extraW) / 2;
        for (const e of show) {
          const im = e.img ? art(e.img) : null;
          if (im && im.complete && im.naturalWidth > 0) {
            ctx!.save();
            ctx!.beginPath(); ctx!.roundRect(cx, yy + (bh - S) / 2, S, S, S * 0.28); ctx!.clip();
            ctx!.drawImage(im, cx, yy + (bh - S) / 2, S, S);
            ctx!.restore();
          } else {
            ctx!.fillStyle = "rgba(255,255,255,.10)";
            ctx!.beginPath(); ctx!.roundRect(cx, yy + (bh - S) / 2, S, S, 3); ctx!.fill();
          }
          // Drawn twice: a dark pass one pixel lower keeps the label legible over both the
          // brightest and the dimmest bars without needing a box behind it.
          ctx!.fillStyle = "rgba(10,13,18,.9)";
          ctx!.fillText(name(e), cx + S + 3, yy + bh / 2 + 3.5);
          ctx!.fillStyle = "rgba(240,255,200,.96)";
          ctx!.fillText(name(e), cx + S + 3, yy + bh / 2 + 3);
          cx += chip(e) + GAP;
        }
        if (extra > 0) {
          ctx!.fillStyle = "rgba(10,13,18,.8)";
          ctx!.fillText(`+${extra}`, cx, yy + bh / 2 + 3);
        }
      });

      // median line — the single number that says where the bot really buys
      const med = [...b.entries.map((e) => e.mcSol)].sort((x, y) => x - y)[Math.floor(b.entries.length / 2)]!;
      const my = BOT - ((med - lo) / (hi - lo)) * (BOT - TOP);
      ctx!.strokeStyle = "rgba(90,217,208,.75)";
      ctx!.lineWidth = 1.2; ctx!.setLineDash([3, 3]);
      ctx!.beginPath(); ctx!.moveTo(PAD - 5, my); ctx!.lineTo(W - 6, my); ctx!.stroke();
      ctx!.setLineDash([]);
      ctx!.font = "8.5px ui-monospace, Menlo, monospace";
      ctx!.fillStyle = "rgba(90,217,208,.95)";
      ctx!.textAlign = "right";
      ctx!.fillText(`median ${med.toFixed(1)}◎`, W - 6, my - 4);
      ctx!.textAlign = "left";

      ctx!.font = "10px ui-monospace, Menlo, monospace";
      ctx!.fillStyle = "rgba(233,235,238,.95)";
      ctx!.fillText(`${b.entries.length} entry · jendela ${lo}–${hi}◎`, 4, 18);
      ctx!.font = "8px ui-monospace, Menlo, monospace";
      ctx!.fillStyle = "rgba(69,74,85,1)";
      ctx!.fillText(`lahir ${b.launchMedian?.toFixed(0) ?? "—"}◎ → beli ${b.entryMedian?.toFixed(0) ?? "—"}◎`, 4, 30);
      if (b.drift) {
        ctx!.fillStyle = "rgba(232,197,106,.8)";
        ctx!.textAlign = "right";
        ctx!.fillText(`config ${b.cfgFloorSol}–${b.cfgCeilSol}◎ — digambar band yang dibeli trader`, W - 6, 18);
        ctx!.textAlign = "left";
      }
      ctx!.fillStyle = "rgba(69,74,85,1)";
      ctx!.fillText("lantai band di bawah · plafon di atas", 4, H - 8);

      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { window.removeEventListener("resize", rs); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <canvas ref={ref} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

/** Repaints only when this panel's own slice moves — see lib/panelMemo. */
export const BandWatch = panelMemo(BandWatchInner, (d) => {
  const b = d.bandWatch;
  return [
    b?.entries.length, b?.floorSol, b?.ceilSol, b?.drift,
    b?.launchMedian, b?.entryMedian,
    // The histogram is a function of the MC values and the names in them — nothing else. Ages are
    // deliberately absent: this panel no longer displays them, so ticking on them would repaint
    // ~1.1x/s for a picture that cannot change.
    b?.entries.map((e) => `${e.sym}:${e.mcSol}`).join(),
  ];
});
