/**
 * DETEKSI GERAK LIKUIDITAS ON-CHAIN (FINAL-3b) — `npm run rh:liq-events`. OFFLINE.
 * Dari snapshot append-only (logs/rhpaper/liquidity-snapshots.jsonl): perubahan liquidity()
 * pool V3 antar-snapshot token yang sama = LIQUIDITY_ADD / LIQUIDITY_REMOVE (point-in-time,
 * raw BigInt-string, aman-2^53). Hipotesis terkait: gerak likuiditas MEMPREDIKSI pergerakan
 * berikutnya (H-F) — fitur tersimpan, verdict menunggu data prospektif (jangan ditarik mundur).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LiqEvent { ts: number; token: string; symbol: string; kind: "LIQUIDITY_ADD" | "LIQUIDITY_REMOVE"; deltaRaw: string; fromRaw: string; toRaw: string; poolAddress: string | null }

/** Murni: delta antar dua snapshot token (raw, relatif — threshold proporsional). */
export function classifyDelta(prevRaw: string, nextRaw: string): { kind: "LIQUIDITY_ADD" | "LIQUIDITY_REMOVE" | null; deltaRaw: string } {
  const a = BigInt(prevRaw), b = BigInt(nextRaw);
  const delta = b - a;
  if (a === 0n) return { kind: null, deltaRaw: delta.toString() }; // dari nol = pool baru, bukan "add" ke pool hidup
  const ratio = Number(delta * 10000n / (a < 0n ? -a : a)) / 10000; // proporsional, aman
  if (ratio >= 0.1) return { kind: "LIQUIDITY_ADD", deltaRaw: delta.toString() };
  if (ratio <= -0.1) return { kind: "LIQUIDITY_REMOVE", deltaRaw: delta.toString() };
  return { kind: null, deltaRaw: delta.toString() };
}

export function liquidityEvents(file = "logs/rhpaper/liquidity-snapshots.jsonl"): { events: LiqEvent[]; snapshots: number; tokens: number } {
  const events: LiqEvent[] = [];
  if (!existsSync(file)) return { events, snapshots: 0, tokens: 0 };
  const last = new Map<string, { raw: string; ts: number; symbol: string; pool: string | null }>();
  let snapshots = 0;
  const tokens = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: { ts?: number; rows?: Array<{ token?: string; symbol?: string; poolLiquidityRaw?: string | null; poolAddress?: string | null }> };
    try { row = JSON.parse(line) as typeof row; } catch { continue; }
    if (!row.rows || typeof row.ts !== "number") continue;
    snapshots++;
    for (const r of row.rows) {
      if (!r.token || typeof r.poolLiquidityRaw !== "string") continue;
      tokens.add(r.token);
      const prev = last.get(r.token);
      if (prev && prev.raw !== r.poolLiquidityRaw) {
        const { kind, deltaRaw } = classifyDelta(prev.raw, r.poolLiquidityRaw);
        if (kind) events.push({ ts: row.ts, token: r.token, symbol: r.symbol ?? "?", kind, deltaRaw, fromRaw: prev.raw, toRaw: r.poolLiquidityRaw, poolAddress: r.poolAddress ?? prev.pool });
      }
      last.set(r.token, { raw: r.poolLiquidityRaw, ts: row.ts, symbol: r.symbol ?? "?", pool: r.poolAddress ?? null });
    }
  }
  return { events: events.sort((a, b) => a.ts - b.ts), snapshots, tokens: tokens.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = liquidityEvents();
  const day = new Date().toISOString().slice(0, 10);
  console.log(`snapshot=${r.snapshots} token=${r.tokens} event=${r.events.length}`);
  for (const e of r.events.slice(-20)) console.log(`${new Date(e.ts).toISOString()} ${e.kind} ${e.symbol} Δ=${e.deltaRaw} raw (pool ${e.poolAddress?.slice(0, 10) ?? "?"}…)`);
  writeFileSync(join("logs", `rh-liq-events-${day}.json`), JSON.stringify(r, null, 2));
}
