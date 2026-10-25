/**
 * GATE "PUNYA POOL WETH LIKUID" (kohort routabilitas) — 2026-10-19.
 *
 * Fakta terukur: dari 60 sinyal v42, hanya 5 (8,3%) punya pool WETH berlikuiditas. Gate ini menahan
 * sinyal yang TIDAK bisa dieksekusi jalur live kita (pool langsung via helper 0xb7c64083…).
 *
 * Sumber: cache logs/rh-routable.json yang ditulis `npm run rh:routable` (jeda 1,2s, tanpa panggilan
 * jaringan di lane). Fail-closed: cache kosong/tak terbaca → TOLAK (lebih baik kehilangan sinyal
 * daripada mengklaim bisa eksekusi padahal tidak).
 */
import { existsSync, readFileSync } from "node:fs";

export interface RoutableCache {
  ts?: number;
  arm?: string;
  checked?: number;
  routable?: Array<{ token: string; symbol?: string }>;
}

export function loadCache(path: string): RoutableCache {
  if (!existsSync(path)) return {};
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as RoutableCache;
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** Apakah token ada di daftar pool-WETH-likuid? Fail-closed bila cache kosong. */
export function livePoolOk(token: string, cache: RoutableCache): boolean {
  const list = cache.routable;
  if (!Array.isArray(list) || !list.length) return false;
  const t = String(token).toLowerCase();
  return list.some((r) => String(r?.token ?? "").toLowerCase() === t);
}

/** Usia cache dalam menit (null bila tak diketahui) — cache tua = sinyal mungkin sudah tak berlaku. */
export function cacheAgeMin(cache: RoutableCache, nowMs = Date.now()): number | null {
  return typeof cache.ts === "number" ? (nowMs - cache.ts) / 60_000 : null;
}
