/** Filter & tiering Lowcap Hunter — murni, bisa diuji tanpa jaringan. */
export interface TokenSnap { chain: string; token: string; symbol: string; mcapUsd: number; liquidityUsd: number }
export interface TraderSnap { address: string; roiPct: number; winratePct: number; windowDays: number }

// Jendela 90 hari TIDAK bisa diukur: `portfolio stats --period` hanya 7d/30d (terverifikasi).
// Karena itu aturan memakai 30 hari — angka yang BENAR-BENAR tersedia, bukan diklaim.
export const RULES = { mcapMax: 1_000_000, liqMax: 50_000, roiMinPct: 300, winrateMinPct: 60, windowDays: 30 } as const;

export function passesToken(t: TokenSnap): boolean {
  return t.mcapUsd > 0 && t.mcapUsd < RULES.mcapMax && t.liquidityUsd > 0 && t.liquidityUsd < RULES.liqMax;
}

/** Top trader lolos bila ROI >300% DAN winrate >60% dalam window 30 hari. */
export function passesTrader(tr: TraderSnap): boolean {
  return tr.windowDays >= RULES.windowDays && tr.roiPct > RULES.roiMinPct && tr.winratePct > RULES.winrateMinPct;
}

export interface Scored { token: TokenSnap; traders: TraderSnap[]; smart: TraderSnap[]; score: number; tier: string }

/** Skor = jumlah trader lolos × rata-rata ROI mereka (dibatasi 10 trader teratas). */
export function scoreToken(t: TokenSnap, traders: TraderSnap[]): Scored {
  const smart = traders.filter(passesTrader).sort((a, b) => b.roiPct - a.roiPct).slice(0, 10);
  const score = smart.length === 0 ? 0 : smart.length * (smart.reduce((s, x) => s + x.roiPct, 0) / smart.length);
  return { token: t, traders, smart, score, tier: tierOf(smart.length, score) };
}

/** Tier: S (≥3 trader, skor ≥1500) · A (≥2, ≥800) · B (≥1) · C (token lolos filter, trader belum). */
export function tierOf(smartCount: number, score: number): "S" | "A" | "B" | "C" {
  if (smartCount >= 3 && score >= 1500) return "S";
  if (smartCount >= 2 && score >= 800) return "A";
  if (smartCount >= 1) return "B";
  return "C";
}
