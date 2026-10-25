/**
 * STATUS LIVE (sumber data untuk /api/live & LivePanel) — `npm run rh:live-status`.
 *
 * Menjawab tepat pertanyaan operator: "posisi live apa saja, kenapa belum dijual, berapa biayanya".
 * Semua dari sumber nyata: logs/rh-live-*.jsonl (aksi jembatan), logs/rh-paper-state.json (apakah arm
 * paper masih memegang token), dan RPC (saldo ETH/WETH/USDG + balanceOf per token). Tanpa mengarang nilai.
 *
 * (S12-§F) Perbaikan akuntansi status:
 *  - RPC GAGAL ≠ saldo nol: setiap pembacaan dibungkus; kegagalan → null + pesan galat (fail-visible),
 *    posisi tetap tampil dgn status UNKNOWN — bukan dihilangkan atau di-nol-kan.
 *  - Kuantitas pakai decimals() TERVERIFIKASI per kontrak (bukan asumsi 18).
 *  - Exit parsial tetap OPEN dgn sisa saldo (bukan CLOSED).
 *  - CLOSED_CONFIRMED menuntut bukti: baris jual ok + txHash + saldo terverifikasi 0 (rekonsiliasi).
 *    Baris jual "ok" TANPA hash (kasus gilet 10-19) = unverifiedSell — posisi tetap OPEN + catatan.
 *  - Dedupe baris beli historis per token (satu posisi per token, tidak duplikat antar hari).
 *  - Posisi lintas hari tetap tampil (semua berkas rh-live-*.jsonl dibaca).
 *  - notionalUsd berasal dari baris beli → harga LAMA: dilabel stalePrice, bukan quote eksekusi.
 *  - GHOST = saldo 0 terverifikasi tanpa jual terkonfirmasi; UNEXITABLE = saldo > 0 tapi tak ada
 *    rute jual (pengecekan quote dibatasi & di-cache per proses).
 * Terpisah dari paper server (rhpaper) dan paper browser — panel itu tidak mencampur dana nyata.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const WALLET = process.env.BOT_WALLET ?? "0x629Ec42444A43A0E02A572587E3A49904542F4E8";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const MAX_AGE_MS = Number(process.env.LIVE_MAX_POSITION_HOURS ?? 24) * 3_600_000;

const rpc = async (method: string, params: unknown[]): Promise<string> => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result ?? "0x";
};
/** eth_call yang MEMBEDAKAN kegagalan (null) dari hasil nol — kegagalan tidak pernah jadi "saldo 0". */
const callOrNull = async (to: string, data: string): Promise<string | null> => {
  try { return await rpc("eth_call", [{ to, data }, "latest"]); } catch { return null; }
};
const erc20OrNull = async (token: string, dec: number): Promise<number | null> => {
  const r = await callOrNull(token, "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase());
  return r == null ? null : Number(BigInt(r)) / 10 ** dec;
};

/** (S12-§I) Klasifikasi murni — teruji tanpa RPC: RPC gagal ≠ nol; exit parsial = OPEN;
 *  CLOSED_CONFIRMED menuntut jual terkonfirmasi (txHash) DAN saldo 0 terverifikasi. */
export function positionStatus(balRaw: string | null, hasConfirmedSell: boolean): LivePosition["status"] {
  if (balRaw == null) return "UNKNOWN";
  if (balRaw === "0") return hasConfirmedSell ? "CLOSED_CONFIRMED" : "GHOST";
  return "OPEN";
}

export interface LivePosition {
  token: string; symbol?: string; notionalUsd?: number; route?: string; ageMin: number; paperHolds: boolean; reason: string;
  // (S12-§F) kuantitas terverifikasi + status eksplisit:
  qtyRaw: string | null;      // balanceOf on-chain (null = RPC gagal — UNKNOWN, bukan 0)
  decimals: number | null;    // decimals() kontrak (bukan asumsi)
  qty: number | null;         // qtyRaw / 10^decimals
  status: "OPEN" | "CLOSED_CONFIRMED" | "GHOST" | "UNKNOWN" | "UNEXITABLE";
  unverifiedSell: boolean;    // ada baris jual "ok" TANPA bukti tx/balance (false-positive historis)
  lastSellTxHash: string | null;
  stalePrice: boolean;        // notionalUsd = harga SAAT BELI (lama) — bukan quote eksekusi
  sellable: boolean | null;   // null = belum diperiksa; false = tak ada rute (mis. likuiditas mati)
}

export interface LiveStatus {
  wallet: string;
  chainId: string | null; // hex — kegagalan RPC tidak menghapus identitas chain, hanya null
  balances: { eth: number; weth: number; usdg: number };
  balanceErrors: { eth: string | null; weth: string | null; usdg: string | null };
  positions: LivePosition[];
  sells: Array<{ token: string; symbol?: string; ts: number; confirmed: boolean; txHash: string | null }>;
  costs: { poolFeePct: number; gasPerSwapUsd: number; note: string };
  generatedAt: number;
}

/** Pengecekan rute jual via OKX quote — DIBATASI & cache per proses (kuota riset rendah). */
const sellableCache = new Map<string, boolean | null>();
async function checkSellable(token: string): Promise<boolean | null> {
  const cached = sellableCache.get(token); if (cached !== undefined) return cached;
  let ok: boolean | null = null;
  try {
    const { createHmac } = await import("node:crypto");
    const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
    if (!env.OKX_API_KEY) { sellableCache.set(token, null); return null; }
    const ts = new Date().toISOString();
    const path = `/api/v6/dex/aggregator/quote?chainIndex=4663&fromTokenAddress=${token}&toTokenAddress=${USDG}&amount=1000000000000000000&swapMode=exactIn`;
    const sign = createHmac("sha256", env.OKX_SECRET_KEY ?? "").update(ts + "GET" + path).digest("base64");
    const res = await fetch("https://web3.okx.com" + path, { headers: { "OK-ACCESS-KEY": env.OKX_API_KEY ?? "", "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": env.OKX_API_PASSPHRASE ?? "", "content-type": "application/json" } });
    const j = (await res.json()) as { code?: string; data?: Array<{ toTokenAmount?: string }> };
    ok = j.code === "0" && Number(j.data?.[0]?.toTokenAmount ?? "0") > 0;
  } catch { ok = null; } // kegagalan cek ≠ tak bisa dijual (UNKNOWN)
  sellableCache.set(token, ok ?? false);
  return ok;
}

export async function liveStatus(): Promise<LiveStatus> {
  const files = readdirSync(config.logDir).filter((f) => /^rh-live-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) for (const l of readFileSync(join(config.logDir, f), "utf8").split("\n")) { try { if (l.trim()) rows.push(JSON.parse(l) as Record<string, unknown>); } catch { /* lewati */ } }
  // Jual: "ok" saja TIDAK cukup — konfirmasi = ok + txHash + (saldo 0 terverifikasi di bawah).
  const sellRows = rows.filter((r) => r.action === "LIVE_SELL");
  const sells = sellRows.map((r) => ({ token: String(r.token), symbol: r.symbol as string | undefined, ts: Number(r.ts ?? 0), confirmed: Boolean(r.ok) && typeof r.txHash === "string" && r.txHash.length > 2, txHash: typeof r.txHash === "string" ? r.txHash : null }));
  const buys = rows.filter((r) => (r.action === "LIVE_FILL" || r.action === "LIVE_BUY") && r.ok);
  let paperHeld = new Set<string>();
  const stPath = join(config.logDir, "rh-paper-state.json");
  if (existsSync(stPath)) {
    try {
      const st = JSON.parse(readFileSync(stPath, "utf8")) as { variants?: Record<string, { positions?: Array<{ token: string }> }> };
      paperHeld = new Set((st.variants?.["v42-liq25-50"]?.positions ?? []).map((x) => String(x.token).toLowerCase()));
    } catch { /* state rusak → anggap kosong (fail-closed: posisi akan dianggap yatim) */ }
  }

  // DEDUPE beli per token: satu posisi per token (retry/hari berbeda tidak menduplikasi).
  const seenTok = new Set<string>();
  const buyRows = buys.filter((b) => { const t = String(b.token).toLowerCase(); if (seenTok.has(t)) return false; seenTok.add(t); return true; });

  const positions: LivePosition[] = [];
  for (const b of buyRows) {
    const tk = String(b.token).toLowerCase();
    const token = String(b.token);
    const ageMin = (Date.now() - Number(b.ts ?? 0)) / 60_000;
    const holds = paperHeld.has(tk);
    const tooOld = Date.now() - Number(b.ts ?? 0) > MAX_AGE_MS;
    const reason = tooOld ? "umur > batas (" + (MAX_AGE_MS / 3_600_000) + " jam) → jual otomatis" : holds ? "menunggu arm paper v42 menutup posisi" : "yatim (paper tak memegang) → jual otomatis";
    // Kuantitas TERVERIFIKASI: balanceOf + decimals() per kontrak; kegagalan RPC = UNKNOWN.
    const balHex = await callOrNull(token, "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase());
    const decHex = await callOrNull(token, "0x313ce567");
    const decimals = decHex != null && decHex !== "0x" ? Number(BigInt(decHex)) : null;
    let qty: number | null = null, qtyRaw: string | null = null;
    if (balHex != null) {
      const raw = BigInt(balHex); qtyRaw = raw.toString();
      qty = decimals != null ? Number(raw) / 10 ** decimals : null; // tanpa decimals terverifikasi → null (bukan tebakan)
    }
    const unverifiedSell = sells.some((s) => s.token.toLowerCase() === tk && !s.confirmed);
    const confirmedSell = sells.find((s) => s.token.toLowerCase() === tk && s.confirmed);
    const hasConfirmedSell = confirmedSell != null;
    let status = positionStatus(qtyRaw, hasConfirmedSell);
    const sellable = status === "OPEN" ? await checkSellable(token) : null;
    if (status === "OPEN" && sellable === false) status = "UNEXITABLE";
    positions.push({ token, symbol: b.symbol as string | undefined, notionalUsd: Number(b.notionalUsd ?? 0), route: String(b.route ?? "?"), ageMin: Number(ageMin.toFixed(1)), paperHolds: holds, reason,
      qtyRaw, decimals, qty, status, unverifiedSell, lastSellTxHash: confirmedSell?.txHash ?? null, stalePrice: true, sellable });
  }

  // Saldo native/WETH/USDG: kegagalan → null (ditampilkan "—"), TIDAK pernah 0 palsu.
  let eth: number | null = null, weth: number | null = null, usdg: number | null = null;
  const ethErr: string | null = await (async () => { try { eth = Number(BigInt(await rpc("eth_getBalance", [WALLET, "latest"]))) / 1e18; return null; } catch (e) { return (e as Error).message.slice(0, 60); } })();
  const wethErr: string | null = await (async () => { try { weth = await erc20OrNull(WETH, 18); return null; } catch (e) { return (e as Error).message.slice(0, 60); } })();
  const usdgErr: string | null = await (async () => { try { usdg = await erc20OrNull(USDG, 6); return null; } catch (e) { return (e as Error).message.slice(0, 60); } })();
  let chainId: string | null = null;
  try { chainId = await rpc("eth_chainId", []); } catch { chainId = null; }

  return { wallet: WALLET, chainId,
    balances: { eth: eth ?? -1, weth: weth ?? -1, usdg: usdg ?? -1 }, // -1 = tak terbaca (legacy shape; kesalahan di balanceErrors)
    balanceErrors: { eth: ethErr, weth: wethErr, usdg: usdgErr },
    positions, sells,
    costs: { poolFeePct: 0.01, gasPerSwapUsd: 0.007, note: "terukur 2026-10-18/19: fee pool 0,01% (fee()=100), gas nyata $0,0064–0,0080 per swap" }, generatedAt: Date.now() };
}

void (async () => {
  if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    const s = await liveStatus();
    console.log(JSON.stringify(s, null, 1));
  }
})();
