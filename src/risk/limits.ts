/**
 * PENJAGA RISIKO (item 7, 2026-10-11) — gerbang P3 yang bisa dipasang SEBELUM uang nyata ada.
 *
 * Rencana proyek (PROFITABILITY_TODO P3) mensyaratkan: kill switch, batas rugi harian, batas
 * modal total — dan itu belum ada sama sekali. Fungsi di sini murni (tanpa I/O kecuali cek berkas
 * kill switch) supaya bisa diuji dan dipakai lane mana pun.
 */

import { existsSync } from "node:fs";

export interface RiskLimits {
  /** Berapa kerugian harian (USD) yang menghentikan entry baru. 0 = mati. */
  maxDailyLossUsd: number;
  /** Batas total notional terbuka (USD) lintas varian. 0 = mati. */
  maxTotalNotionalUsd: number;
  /** Batas jumlah posisi terbuka. 0 = mati. */
  maxOpenPositions: number;
  /** Berkas penanda: bila ada, SEMUA entry baru diblokir (kill switch manual). */
  killFile: string;
}

export interface EntryCheck {
  allowed: boolean;
  reason?: string;
}

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export function loadLimits(env: NodeJS.ProcessEnv = process.env, killFileDefault = "logs/KILL"): RiskLimits {
  return {
    maxDailyLossUsd: num(env.RISK_MAX_DAILY_LOSS_USD, 0),
    maxTotalNotionalUsd: num(env.RISK_MAX_TOTAL_NOTIONAL_USD, 0),
    maxOpenPositions: Math.floor(num(env.RISK_MAX_OPEN_POSITIONS, 0)),
    killFile: env.RISK_KILL_FILE?.trim() || killFileDefault,
  };
}

/** Kill switch manual: cukup buat berkasnya (mis. `touch logs/KILL`) untuk menghentikan entry baru. */
export function killSwitchActive(path: string): boolean {
  return existsSync(path);
}

/**
 * Boleh membuka posisi baru? Batas 0 berarti "tidak dibatasi" — supaya penjaga ini bisa dipasang
 * di lingkungan paper tanpa mengubah perilaku sampai angkanya diisi.
 */
export function checkEntryAllowed(
  input: { notionalUsd: number; openNotionalUsd: number; openPositions: number; dayPnlUsd: number },
  limits: RiskLimits,
): EntryCheck {
  if (killSwitchActive(limits.killFile)) return { allowed: false, reason: `kill switch aktif (${limits.killFile} ada)` };
  if (limits.maxDailyLossUsd > 0 && input.dayPnlUsd <= -limits.maxDailyLossUsd) {
    return { allowed: false, reason: `batas rugi harian terlampaui (${input.dayPnlUsd.toFixed(2)} ≤ −${limits.maxDailyLossUsd})` };
  }
  if (limits.maxOpenPositions > 0 && input.openPositions >= limits.maxOpenPositions) {
    return { allowed: false, reason: `batas posisi terbuka (${input.openPositions}/${limits.maxOpenPositions})` };
  }
  if (limits.maxTotalNotionalUsd > 0 && input.openNotionalUsd + input.notionalUsd > limits.maxTotalNotionalUsd) {
    return { allowed: false, reason: `batas modal total ($${(input.openNotionalUsd + input.notionalUsd).toFixed(2)} > $${limits.maxTotalNotionalUsd})` };
  }
  return { allowed: true };
}
