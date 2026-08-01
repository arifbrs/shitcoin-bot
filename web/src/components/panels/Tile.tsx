import type { ReactNode } from "react";

interface Props {
  area: string; // maps to a named grid-area in .dash-grid (index.css)
  label: string;
  right?: ReactNode;
  live?: boolean;
  className?: string;
  children: ReactNode;
}

/** Shared tile chrome — mirrors the old dashboard's `.tile`/`.th` pattern (pulsing dot + uppercase label + right-aligned meta). */
export function Tile({ area, label, right, live = true, className = "", children }: Props) {
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
        {right && <span className="ml-auto font-mono text-[9px] tracking-[0.08em] text-muted-foreground/70">{right}</span>}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
