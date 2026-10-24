/** Dua "tool function" hunter: gmgnApi (GMGN) dan heliusGetTransactions (Solana saja). */
import { readFileSync, existsSync } from "node:fs";
import { gmgnReadResult } from "../discovery/gmgn.js";

export interface GmgnToken { raw: Record<string, unknown> }

/** Shared local proxy only: never spawn a CLI with its own limiter or signed capabilities. */
export async function gmgnApi(method: string, args: unknown[]): Promise<Record<string, unknown>> {
  const result = await gmgnReadResult<Record<string, unknown>>(method, args);
  if (!result.ok) throw new Error(`GMGN ${method} unavailable: ${result.error}`);
  return result.data;
}

/** heliusGetTransactions: HANYA Solana (Helius tidak melayani Robinhood Chain). Butuh HELIUS_API_KEY. */
let heliusIdx = 0;

export async function heliusGetTransactions(address: string, limit = 50): Promise<{ ok: boolean; reason?: string; txs?: unknown[] }> {
  // Satu nilai HELIUS_API_KEY boleh berisi BEBERAPA kunci dipisah koma → dipakai bergiliran (rotasi).
  const raw = envKey("HELIUS_API_KEY");
  const keys = (raw ?? "").split(",").map((k) => k.trim()).filter((k) => k.length > 15);
  if (keys.length === 0) return { ok: false, reason: "HELIUS_API_KEY belum ada di .env" };
  let lastReason = "tidak dicoba";
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(heliusIdx + i) % keys.length];
    try {
      const r = await fetch(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${key}&limit=${limit}`);
      if (r.ok) { heliusIdx = (heliusIdx + i + 1) % keys.length; return { ok: true, txs: (await r.json()) as unknown[] }; }
      lastReason = "helius HTTP " + r.status;
      if (r.status !== 401 && r.status !== 429) break;
    } catch (e) { lastReason = String((e as Error).message).slice(0, 100); }
  }
  return { ok: false, reason: lastReason };
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
