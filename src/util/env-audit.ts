/**
 * AUDIT KONFIGURASI ENV (round-3 A2) — dotenv memakai NILAI TERAKHIR untuk kunci duplikat.
 * Override senyap pada kunci keamanan = kasus nyata: MAX_DAILY_SPEND_SOL 0.10 (blok atas .env)
 * tertimpa 9999 (blok bawah) sehingga circuit-breaker harian mati tanpa suara.
 * Fungsi murni: bisa diuji tanpa berkas; config.ts dan live-executor memakainya fail-closed.
 */
export const SECURITY_KEYS = [
  "LIVE_TRADING_CONFIRMED", "EXEC_MODE", "S2_LIVE_ENABLED", "OKX_EXECUTION_ENABLED",
  "MAX_PER_TRADE_SOL", "MAX_DEPLOYED_SOL", "MAX_DAILY_SPEND_SOL",
] as const;

/** Semua kunci yang muncul lebih dari sekali (baris aktif, bukan komentar). */
export function duplicateEnvKeys(text: string): string[] {
  const seen = new Map<string, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k!).sort();
}

/** Irisan duplikat dengan kunci keamanan — keberadaannya = arming live DITOLAK (fail-closed). */
export function duplicateSecurityKeys(text: string): string[] {
  const dups = new Set(duplicateEnvKeys(text));
  return SECURITY_KEYS.filter((k) => dups.has(k));
}
