/**
 * DETEKSI GERAK LIKUIDITAS ON-CHAIN (FINAL-3b) — `npm run rh:liq-events`. OFFLINE.
 * Dari snapshot append-only (logs/rhpaper/liquidity-snapshots.jsonl): perubahan liquidity()
 * pool V3 antar-snapshot token yang sama = LIQUIDITY_ADD / LIQUIDITY_REMOVE (point-in-time,
 * raw BigInt-string, aman-2^53). Hipotesis terkait: gerak likuiditas MEMPREDIKSI pergerakan
 * berikutnya (H-F) — fitur tersimpan, verdict menunggu data prospektif (jangan ditarik mundur).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LiqKind = "ACTIVE_LIQUIDITY_CHANGE" | "LP_ADD_CONFIRMED" | "LP_REMOVE_CONFIRMED";
export interface LiqEvent { ts: number; token: string; symbol: string; kind: LiqKind; deltaRaw: string; fromRaw: string; toRaw: string; poolAddress: string | null }

// Topik event V3 (Uniswap V3 pool — implementasi RH terverifikasi V3-style): Mint/Burn = operasi
// LP SEBENARNYA; perubahan liquidity() tanpa Mint/Burn = lintas-tick (in-range), BUKAN LP op.
export const MINT_TOPIC = "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f";
export const BURN_TOPIC = "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c";

/** Murni: delta antar dua snapshot token (raw, relatif — threshold proporsional).
 *  (FINAL-2B) KLASIFIKASI DIKOREKSI: perubahan liquidity() adalah perubahan likuiditas
 *  AKTIF-in-range (bisa karena lintas-tick), BUKAN bukti deposit/penarikan LP. Label
 *  LP_ADD/LP_REMOVE hanya boleh setelah Mint/Burn pool terdekode (lihat lpKindFromLogs). */
export function classifyDelta(prevRaw: string, nextRaw: string): { kind: LiqKind | null; deltaRaw: string } {
  const a = BigInt(prevRaw), b = BigInt(nextRaw);
  const delta = b - a;
  if (a === 0n) return { kind: null, deltaRaw: delta.toString() }; // dari nol = pool baru, bukan "add" ke pool hidup
  const ratio = Number(delta * 10000n / (a < 0n ? -a : a)) / 10000; // proporsional, aman
  if (Math.abs(ratio) >= 0.1) return { kind: "ACTIVE_LIQUIDITY_CHANGE", deltaRaw: delta.toString() };
  return { kind: null, deltaRaw: delta.toString() };
}

/** Murni: dari logs pool, apakah ada operasi LP sebenarnya? Mengembalikan jenis + bukti. */
export function lpKindFromLogs(logs: Array<{ topics?: string[]; transactionHash?: string; blockNumber?: number; data?: string }>): { kind: "LP_ADD_CONFIRMED" | "LP_REMOVE_CONFIRMED" | null; amountRaw: string; txHash: string | null; blockNumber: number | null } {
  let amount = 0n, kind: "LP_ADD_CONFIRMED" | "LP_REMOVE_CONFIRMED" | null = null, txHash: string | null = null, block: number | null = null;
  for (const l of logs) {
    const t0 = l.topics?.[0]?.toLowerCase();
    if (t0 !== MINT_TOPIC && t0 !== BURN_TOPIC) continue;
    const amountRaw = "0x" + String(l.data ?? "0x0").slice(2).padStart(64, "0").slice(0, 64); // uint128 amount = word pertama data
    const v = BigInt(amountRaw);
    if (v > amount) { amount = v; kind = t0 === MINT_TOPIC ? "LP_ADD_CONFIRMED" : "LP_REMOVE_CONFIRMED"; txHash = l.transactionHash ?? null; block = l.blockNumber ?? null; }
  }
  return { kind, amountRaw: amount.toString(), txHash, blockNumber: block };
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
      } // (FINAL-2B) konfirmasi LP ops (decode Mint/Burn) = fungsi confirmLpEvents di bawah; snapshot delta TIDAK otomatis jadi LP op
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
