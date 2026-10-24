/** Fail-closed parsing: missing statistics are unavailable, never profitable/zero-valued data. */
import type { TokenSnap, TraderSnap } from "./filters.js";

export function hunterNumber(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}

export function hunterToken(chain: string, token: string, symbol: string, info: Record<string, unknown>): TokenSnap | null {
  const price = hunterNumber((info.price as { price?: unknown } | undefined)?.price), supply = hunterNumber(info.circulating_supply), liquidity = hunterNumber(info.liquidity);
  if (price == null || price <= 0 || supply == null || supply <= 0 || liquidity == null || liquidity <= 0) return null;
  const mcapUsd = price * supply;
  return Number.isFinite(mcapUsd) ? { chain, token, symbol, mcapUsd, liquidityUsd: liquidity } : null;
}

export function hunterTrader(address: string, info: Record<string, unknown>, windowDays = 30): TraderSnap | null {
  const roi = hunterNumber(info.realized_profit_pnl), winrate = hunterNumber((info.pnl_stat as { winrate?: unknown } | undefined)?.winrate);
  if (!address || roi == null || winrate == null || winrate < 0 || winrate > 1) return null;
  return { address, roiPct: roi * 100, winratePct: winrate * 100, windowDays };
}
