/** Dua "tool function" hunter: gmgnApi (GMGN) dan heliusGetTransactions (Solana saja). */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

export interface GmgnToken { raw: Record<string, unknown> }

/** gmgnApi: bungkus gmgn-cli (tanpa API key, kena rate-limit gratis). */
export function gmgnApi(args: string[], timeoutMs = 45_000): Record<string, unknown> | null {
  try {
    const out = execFileSync("npx", ["gmgn-cli", ...args, "--raw"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 20e6 });
    return JSON.parse(out) as Record<string, unknown>;
  } catch { return null; }
}

/** heliusGetTransactions: HANYA Solana (Helius tidak melayani Robinhood Chain). Butuh HELIUS_API_KEY. */
export async function heliusGetTransactions(address: string, limit = 50): Promise<{ ok: boolean; reason?: string; txs?: unknown[] }> {
  const key = envKey("HELIUS_API_KEY");
  if (!key) return { ok: false, reason: "HELIUS_API_KEY belum ada di .env" };
  try {
    const r = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&limit=${limit}`);
    if (!r.ok) return { ok: false, reason: "helius HTTP " + r.status };
    return { ok: true, txs: (await r.json()) as unknown[] };
  } catch (e) { return { ok: false, reason: String((e as Error).message).slice(0, 100) }; }
}

function envKey(name: string): string | null {
  try {
    if (!existsSync(".env")) return null;
    for (const l of readFileSync(".env", "utf8").split("\n")) {
      if (l.trim().startsWith(name + "=")) return l.slice(l.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "") || null;
    }
  } catch { /* tanpa env */ }
  return null;
}
