import { memo } from "react";
import type { ComponentType } from "react";
import type { StatsResponse } from "@/types/stats";

/**
 * Re-render a panel only when the slice it actually reads has changed.
 *
 * Every SSE push replaces the whole `StatsResponse` object, so React re-rendered all ~14 panels
 * ~1.1x per second — measured 118 KB per push before the payload was trimmed, and a full tree
 * render on each one. That work lands on the same main thread the canvas animations draw on,
 * which is the remaining source of the periodic hitch in the pipeline fan.
 *
 * The comparator takes a cheap FINGERPRINT rather than deep-comparing: a handful of counts and
 * last-timestamps per panel. That is deliberately conservative in one direction — a fingerprint
 * can only cause a missed repaint if two genuinely different slices produce identical scalars, so
 * every fingerprint below includes a value that moves whenever the underlying data does (a length,
 * a newest timestamp, or the number itself).
 */
export function panelMemo<P extends { data: StatsResponse }>(
  Component: ComponentType<P>,
  fingerprint: (d: StatsResponse) => unknown[],
): ComponentType<P> {
  const Memoized = memo(Component, (prev, next) => {
    const a = fingerprint(prev.data), b = fingerprint(next.data);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    // Props other than `data` are rare here (Tile passes only `data`), but if a panel ever gains
    // one, fall back to re-rendering rather than silently freezing it.
    for (const k of Object.keys(next) as Array<keyof P>) {
      if (k !== ("data" as keyof P) && prev[k] !== next[k]) return false;
    }
    return true;
  });
  Memoized.displayName = `panelMemo(${Component.displayName ?? Component.name})`;
  return Memoized as unknown as ComponentType<P>;
}
