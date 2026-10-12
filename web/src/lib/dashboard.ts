import type { RobinhoodVariantView, StatsResponse } from "@/types/stats";

export const dashboardLanes = [
  { id: "robinhood", name: "Robinhood", mark: "RH", description: "Forward test strategi · Ethereum L2", mode: "Paper" },
  { id: "gmgn", name: "GMGN", mark: "GM", description: "Sinyal smart money & kualitas wallet", mode: "Observasi" },
  { id: "dex", name: "DexScreener", mark: "DX", description: "Pergerakan pasar & watchlist token", mode: "Observasi" },
  { id: "okxPaper", name: "OKX", mark: "OK", description: "Simulasi eksekusi & integritas ledger", mode: "Strict paper" },
] as const;

export type DashboardSection = "overview" | typeof dashboardLanes[number]["id"] | "solana";

export function snapshotAge(receivedAt: number | null, now: number): number | null {
  return receivedAt === null ? null : Math.max(0, Math.floor((now - receivedAt) / 1000));
}

export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "Belum tersedia";
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} dtk lalu`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt lalu`;
  return `${Math.floor(seconds / 3600)} jam lalu`;
}

export function laneState(health: NonNullable<StatsResponse["laneHealth"]>[string] | undefined, elapsed: number | null, connected: boolean) {
  const age = health?.ageSec == null ? null : health.ageSec + (elapsed ?? 0);
  if (!connected) return { label: "Belum terverifikasi", tone: "unknown", age };
  if (!health || age === null) return { label: "Belum ada data", tone: "unknown", age };
  return health.fresh
    ? { label: "Aktif", tone: "active", age }
    : { label: "Tidak aktif", tone: "idle", age };
}

export function filterVariants(variants: RobinhoodVariantView[], query: string, onlyOpen: boolean) {
  const search = query.trim().toLowerCase();
  return variants.filter((variant) =>
    (!onlyOpen || variant.openPositions > 0) &&
    [variant.id, variant.cohort ?? "", ...variant.positions.map((position) => position.symbol)]
      .some((value) => value.toLowerCase().includes(search)));
}
