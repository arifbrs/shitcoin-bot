import type { ReactNode } from "react";

interface Props {
  area: string; // maps to a named grid-area in .dash-grid (index.css)
  label: string;
  right?: ReactNode;
  live?: boolean;
  /**
   * Where this tile's numbers come from, shown as a chip in the header.
   *
   * Only rendered when live is ARMED — with the bot in simulation everything is simulation and
   * a badge on every tile is noise. Armed, the question "is this real money?" must be
   * answerable per panel without reading the numbers, because the panels look identical by
   * design (they are the same components fed a different source).
   *
   * Added after a panel showing live P&L sat under the heading "PAPER · Strategy 1" — a stale
   * label from an earlier iteration, and the exact ambiguity this chip removes.
   */
  source?: "live" | "sim" | "shared";
  className?: string;
  children: ReactNode;
}

/** Shared tile chrome — mirrors the old dashboard's `.tile`/`.th` pattern (pulsing dot + uppercase label + right-aligned meta). */
export function Tile({ area, label, right, live = true, source, className = "", children }: Props) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-xl border border-border bg-card p-3.5 ${className}`}
      // container-type:inline-size (owner found live, 2026-07-29: content looked tiny/adrift in
      // huge empty tiles on a wide monitor) lets children use `cqw` units to scale their own font
      // size relative to THIS tile's actual width, instead of a fixed px size that stays small
      // no matter how big the tile grows on a large screen.
      style={{ gridArea: area, containerType: "inline-size" }}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={`h-[5px] w-[5px] rounded-full ${live ? "bg-foreground shadow-[0_0_7px_var(--hud-fg)] animate-pulse" : "bg-muted-foreground/40"}`}
        />
        <span className="font-mono text-[9px] tracking-[0.16em] text-muted-foreground uppercase">{label}</span>
        {source && (
          <span
            className={`rounded px-1 font-mono text-[8px] font-semibold tracking-[0.1em] ${
              source === "live" ? "bg-down/20 text-down" : "bg-muted text-muted-foreground"
            }`}
            title={source === "live" ? "uang sungguhan" : source === "sim" ? "simulasi" : "dipakai live dan simulasi"}
          >
            {source === "live" ? "LIVE" : source === "sim" ? "SIM" : "BERSAMA"}
          </span>
        )}
        {right && <span className="ml-auto font-mono text-[9px] tracking-[0.08em] text-muted-foreground/70">{right}</span>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
