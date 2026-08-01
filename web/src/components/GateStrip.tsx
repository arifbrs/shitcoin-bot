import { useEffect, useRef, useState } from "react";

/**
 * The landing page's signature element — a live-feeling ambient strip embodying the product's
 * actual mechanic: a firehose of freshly-launched tokens drifts left→right, each one resolved as
 * PASS (green, glows and holds) or REJECT (red X, dissolves) right at a labeled "GATE" line.
 * Purely illustrative — no real trading data (this renders pre-auth, on the public landing page)
 * — deliberately built from the product's OWN vocabulary (gate/pass/reject) rather than a stock
 * hero animation, since a visitor here has never seen the real dashboard yet.
 */
const SAMPLE_SYMBOLS = [
  "WOJAK", "PEPE2", "MOGGED", "RIZZ", "BONK9", "GIGA", "COPE", "SIGMA", "FROG7",
  "BASED", "DEGEN", "MOON3", "APEX", "SEND", "FOMO", "LFG", "NGMI", "WAGMI",
] as const;

interface Pill {
  id: number;
  symbol: string;
  laneY: number; // percent
  durationS: number;
  delayS: number;
  outcome: "pass" | "reject";
}

function makePill(id: number): Pill {
  return {
    id,
    symbol: SAMPLE_SYMBOLS[Math.floor(Math.random() * SAMPLE_SYMBOLS.length)]!,
    laneY: 8 + Math.random() * 84,
    durationS: 5.5 + Math.random() * 3.5,
    delayS: Math.random() * 4,
    // Real measured pass-rate territory (this project's own gate typically rejects the large
    // majority of candidates) — reused here as flavor, not presented as a live statistic.
    outcome: Math.random() < 0.22 ? "pass" : "reject",
  };
}

export function GateStrip() {
  const [pills, setPills] = useState<Pill[]>(() => Array.from({ length: 14 }, (_, i) => makePill(i)));
  const nextId = useRef(14);

  useEffect(() => {
    const t = setInterval(() => {
      setPills((prev) => {
        const id = nextId.current++;
        const next = [...prev, makePill(id)];
        return next.length > 20 ? next.slice(next.length - 20) : next;
      });
    }, 900);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative h-40 w-full overflow-hidden rounded-xl border border-border bg-card/60">
      {/* GATE line, ~62% across — pills resolve pass/reject as they cross it. Label sits INSIDE
          the container's own bounds (not above it) — a `-top-5` version got silently clipped by
          this container's own `overflow-hidden`, found via a live screenshot during QA. */}
      <div className="absolute inset-y-0 left-[62%] w-px bg-foreground/25">
        <span className="absolute top-1.5 left-1/2 -translate-x-1/2 bg-card px-1 text-[9px] tracking-[0.25em] text-muted-foreground">
          GATE
        </span>
      </div>
      <div className="pointer-events-none absolute inset-0">
        {pills.map((p) => (
          <span
            key={p.id}
            className="gate-pill absolute font-mono text-[10px] tracking-wider"
            style={
              {
                top: `${p.laneY}%`,
                "--duration": `${p.durationS}s`,
                "--delay": `${p.delayS}s`,
              } as React.CSSProperties
            }
            data-outcome={p.outcome}
          >
            {p.symbol}
          </span>
        ))}
      </div>
      {/* Fade masks at both edges so pills materialize/vanish softly, not clipped mid-motion */}
      <div className="absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-card to-transparent" />
      <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-card to-transparent" />
    </div>
  );
}
