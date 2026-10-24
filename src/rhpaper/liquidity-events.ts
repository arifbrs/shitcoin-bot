/**
 * DETEKSI GERAK LIKUIDITAS ON-CHAIN (FINAL-3b) — `npm run rh:liq-events`. OFFLINE.
 * Dari snapshot append-only (logs/rhpaper/liquidity-snapshots.jsonl): perubahan liquidity()
 * pool V3 antar-snapshot token yang sama = LIQUIDITY_ADD / LIQUIDITY_REMOVE (point-in-time,
 * raw BigInt-string, aman-2^53). Hipotesis terkait: gerak likuiditas MEMPREDIKSI pergerakan
 * berikutnya (H-F) — fitur tersimpan, verdict menunggu data prospektif (jangan ditarik mundur).
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type LiqKind = "ACTIVE_LIQUIDITY_CHANGE" | "LP_ADD_CONFIRMED" | "LP_REMOVE_CONFIRMED";
export interface LiqEvent { ts: number; token: string; symbol: string; kind: LiqKind; deltaRaw: string; fromRaw: string; toRaw: string; poolAddress: string | null }

// Topik event V3 DI-DERIVE dari ABI (bukan konstanta hafalan) — keccak256 dari signature
// kanonik Uniswap V3. Terverifikasi viem: Mint=0x7a53080b… (bukan 0x4c209b5f — itu V2!),
// Burn=0x0c396cd9…. Layout (FINAL P0-2):
//   Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper,
//        uint128 amount, uint256 amount0, uint256 amount1)
//     → topics=[Mint, owner, tickLower, tickUpper]; data=[sender, amount, amount0, amount1]
//     → LIKUIDITAS = kata data INDEKS 1 (bukan 0!). Lintasan aktif = likuiditas in-range.
//   Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper,
//        uint128 amount, uint256 amount0, uint256 amount1)
//     → topics=[Burn, owner, tickLower, tickUpper]; data=[amount, amount0, amount1]
//     → LIKUIDITAS = kata data indeks 0.
import { keccak256, toBytes } from "viem";
export const MINT_TOPIC = keccak256(toBytes("Mint(address,address,int24,int24,uint128,uint256,uint256)"));
export const BURN_TOPIC = keccak256(toBytes("Burn(address,int24,int24,uint128,uint256,uint256)"));

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

export interface DecodedLpEvent {
  kind: "LP_ADD_CONFIRMED" | "LP_REMOVE_CONFIRMED";
  liquidityAmountRaw: string; // uint128 — likuiditas operasi TSU (bukan kata data pertama Mint!)
  poolAddress: string; chainId: number;
  txHash: string; logIndex: number; blockNumber: number; timestampMs: number | null;
  eventKey: string; // `${txHash}:${logIndex}` — kunci idempoten (proses ulang = tetap satu)
  owner: string | null; tickLower: string | null; tickUpper: string | null;
}

/** (FINAL P0-2) Decode event Mint/Burn V3 dari logs — layout BENAR, multi-event per tx,
 *  validasi alamat pool pemancar, kunci idempoten. Bukan lagi pembantu terisolasi:
 *  dipakai pipeline konfirmasi (confirmLpEvents). */
export function decodeV3PoolEvents(
  logs: Array<{ address?: string; topics?: string[]; data?: string; transactionHash?: string; blockNumber?: number; logIndex?: number }>,
  opts: { poolAddress: string; chainId: number; timestampMs: number | null },
): DecodedLpEvent[] {
  const pool = opts.poolAddress.toLowerCase();
  const out: DecodedLpEvent[] = [];
  for (const l of logs) {
    if (!l.address || l.address.toLowerCase() !== pool) continue; // validasi kontrak pemancar
    const t0 = l.topics?.[0]?.toLowerCase();
    const isMint = t0 === MINT_TOPIC, isBurn = t0 === BURN_TOPIC;
    if (!isMint && !isBurn) continue;
    if (!l.topics || l.topics.length < 4) continue; // indexed owner + tickLower + tickUpper
    const words = String(l.data ?? "0x").slice(2).match(/.{64}/g) ?? [];
    // Mint: data=[sender, amount, amount0, amount1] → likuiditas di indeks 1.
    // Burn: data=[amount, amount0, amount1] → likuiditas di indeks 0.
    const amountIdx = isMint ? 1 : 0;
    if (words.length <= amountIdx) continue; // data tak lengkap — jangan menebak
    const liquidityAmountRaw = BigInt("0x" + words[amountIdx]!).toString();
    const txHash = String(l.transactionHash ?? "");
    const logIndex = Number(l.logIndex ?? -1);
    out.push({
      kind: isMint ? "LP_ADD_CONFIRMED" : "LP_REMOVE_CONFIRMED",
      liquidityAmountRaw, poolAddress: l.address, chainId: opts.chainId,
      txHash, logIndex, blockNumber: Number(l.blockNumber ?? 0), timestampMs: opts.timestampMs,
      eventKey: `${txHash}:${logIndex}`,
      owner: "0x" + (l.topics[1] ?? "").slice(26),
      tickLower: String(BigInt(l.topics[2] ?? "0x0")),
      tickUpper: String(BigInt(l.topics[3] ?? "0x0")),
    });
  }
  return out;
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

// ── KONFIRMASI OPERASIONAL (P0-2) — dari helper terisolasi menjadi bagian pipeline ──
export type RpcCall = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { message?: string } }>;

/** Timestamp → blok (pencarian biner eth_getBlockByNumber) untuk jendela backfill berbatas. */
export async function blockAtTimestamp(rpc: RpcCall, tsMs: number, lo = 1, hi = 200_000_000): Promise<number> {
  let a = lo, b = Math.min(hi, 200_000_000);
  while (a < b) {
    const mid = Math.floor((a + b) / 2);
    const blk = await rpc("eth_getBlockByNumber", ["0x" + mid.toString(16), false]);
    const t = Number(((blk.result as Record<string, unknown>)?.timestamp ?? 0)) * 1000;
    if (t < tsMs) a = mid + 1; else b = mid;
  }
  return a;
}

export interface ConfirmedLpEvent {
  kind: "LP_ADD_CONFIRMED" | "LP_REMOVE_CONFIRMED";
  liquidityAmountRaw: string; poolAddress: string; chainId: number;
  txHash: string; logIndex: number; blockNumber: number; timestampMs: number | null;
  eventKey: string; owner: string | null; tickLower: string | null; tickUpper: string | null;
  observedVia: "pool-log-backfill"; // provenance: cara event ini ditemukan (bukan identitas)
}

/** (FINAL §5) Konfirmasi LP ops dengan PROVENANCE MURNI dari decode — TIDAK menyebar event
 *  snapshot lain ke dalamnya (bug lama: spread event snapshot tak terkait). Identitas lengkap:
 *  txHash, logIndex, blockNumber, pool, chainId, eventKey, owner, ticks, timestamp dari blok.
 *  Jendela blok dibatasi per interval observasi (±1 jam sekitar event snapshot, chunk kecil).
 *  Idempoten: pemanggil memfilter eventKey yang sudah ada di lp-events.jsonl. */
export async function confirmLpEvents(rpc: RpcCall, snapshotEvents: LiqEvent[], opts: { chainId: number; latest: number; maxChunk?: number }): Promise<ConfirmedLpEvent[]> {
  const out: ConfirmedLpEvent[] = [];
  const byPool = new Map<string, LiqEvent[]>();
  for (const e of snapshotEvents) if (e.poolAddress) byPool.set(e.poolAddress, [...(byPool.get(e.poolAddress) ?? []), e]);
  const maxChunk = opts.maxChunk ?? 5_000;
  for (const [pool, evs] of byPool) {
    const windows: Array<{ lo: number; hi: number }> = [];
    for (const e of evs) {
      const lo = Math.max(1, await blockAtTimestamp(rpc, e.ts - 3_600_000));
      const hi = Math.min(opts.latest, await blockAtTimestamp(rpc, e.ts + 3_600_000));
      windows.push({ lo, hi });
    }
    const merged: Array<{ lo: number; hi: number }> = [];
    for (const w of windows.sort((a, b) => a.lo - b.lo)) {
      const last = merged[merged.length - 1];
      if (last && w.lo <= last.hi) last.hi = Math.max(last.hi, w.hi); else merged.push({ ...w });
    }
    for (const w of merged) {
      for (let lo = w.lo; lo <= w.hi; lo += maxChunk) {
        const hi = Math.min(lo + maxChunk - 1, w.hi);
        const r = await rpc("eth_getLogs", [{ address: pool, fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16), topics: [[MINT_TOPIC, BURN_TOPIC]] }]);
        if (r.error) continue; // provider menolak rentang: event tetap ACTIVE_LIQUIDITY_CHANGE, tanpa fallback
        const logs = (r.result as Array<Record<string, unknown>>) ?? [];
        for (const decoded of decodeV3PoolEvents(logs as never, { poolAddress: pool, chainId: opts.chainId, timestampMs: null })) {
          let ts: number | null = null;
          try { ts = Number(((await rpc("eth_getBlockByNumber", ["0x" + decoded.blockNumber.toString(16), false])).result as Record<string, unknown>)?.timestamp ?? 0) * 1000 || null; } catch { ts = null; }
          out.push({ kind: decoded.kind, liquidityAmountRaw: decoded.liquidityAmountRaw, poolAddress: decoded.poolAddress,
            chainId: decoded.chainId, txHash: decoded.txHash, logIndex: decoded.logIndex, blockNumber: decoded.blockNumber,
            timestampMs: ts, eventKey: decoded.eventKey, owner: decoded.owner, tickLower: decoded.tickLower,
            tickUpper: decoded.tickUpper, observedVia: "pool-log-backfill" });
        }
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = liquidityEvents();
  const day = new Date().toISOString().slice(0, 10);
  console.log(`snapshot=${r.snapshots} token=${r.tokens} event=${r.events.length} (ACTIVE_LIQUIDITY_CHANGE — bukan otomatis LP op)`);
  for (const e of r.events.slice(-20)) console.log(`${new Date(e.ts).toISOString()} ${e.kind} ${e.symbol} Δ=${e.deltaRaw} raw (pool ${e.poolAddress?.slice(0, 10) ?? "?"}…)`);
  writeFileSync(join("logs", `rh-liq-events-${day}.json`), JSON.stringify(r, null, 2));
  // --confirm: naikkan ke LP_ADD/REMOVE_CONFIRMED bila decode Mint/Burn pool menemukan operasi.
  if (process.argv.includes("--confirm")) {
    void (async () => {
      const rpc: import("./liquidity-events.js").RpcCall = async (m, p) => (await fetch(process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json() as never;
      const latestBlk = await rpc("eth_blockNumber", []);
      const confirmed = await confirmLpEvents(rpc, r.events, { chainId: 4663, latest: Number((latestBlk.result as string) ?? "0x0"), maxChunk: 5_000 });
      // IDEMPOTEN: kunci = eventKey (txHash:logIndex) — proses ulang/restart tidak menduplikasi.
      const store = "logs/rhpaper/lp-events.jsonl";
      const known = new Set<string>();
      if (existsSync(store)) for (const line of readFileSync(store, "utf8").split("\n")) { try { known.add((JSON.parse(line) as { eventKey?: string }).eventKey ?? ""); } catch { /* rusak */ } }
      let fresh = 0;
      for (const e of confirmed) {
        if (known.has(e.eventKey)) continue;
        known.add(e.eventKey);
        appendLpEvent(e); fresh++;
      }
      console.log(`[liq-events] --confirm: ${confirmed.length} LP ops terdekode, ${fresh} baru (idempoten eventKey) → ${store}`);
    })();
  }
}
function appendLpEvent(e: ConfirmedLpEvent): void {
  mkdirSync("logs/rhpaper", { recursive: true });
  appendFileSync("logs/rhpaper/lp-events.jsonl", JSON.stringify(e) + "\n");
}
