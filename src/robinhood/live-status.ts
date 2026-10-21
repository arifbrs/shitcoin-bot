/**
 * STATUS LIVE (sumber data untuk /api/live & LivePanel) — `npm run rh:live-status`.
 *
 * Menjawab tepat pertanyaan operator: "posisi live apa saja, kenapa belum dijual, berapa biayanya".
 * Semua dari sumber nyata: logs/rh-live-*.jsonl (aksi jembatan), logs/rh-paper-state.json (apakah arm
 * paper masih memegang token), dan RPC (saldo ETH/WETH/USDG). Tanpa mengarang nilai.
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
  const j = (await r.json()) as { result?: string };
  return j.result ?? "0x";
};
// FIX 2026-10-19: decimal PER TOKEN (USDG 6, WETH 18) — sebelumnya semua dibagi 1e18 → USDG tampak 1e-12.
const erc20 = async (token: string, dec: number): Promise<number> => Number(BigInt(await rpc("eth_call", [{ to: token, data: "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase() }, "latest"]))) / 10 ** dec;

export interface LiveStatus {
  wallet: string;
  balances: { eth: number; weth: number; usdg: number };
  positions: Array<{ token: string; symbol?: string; notionalUsd?: number; route?: string; ageMin: number; paperHolds: boolean; reason: string }>;
  sells: Array<{ token: string; symbol?: string; ts: number }>;
  costs: { poolFeePct: number; gasPerSwapUsd: number; note: string };
  generatedAt: number;
}

export async function liveStatus(): Promise<LiveStatus> {
  const files = readdirSync(config.logDir).filter((f) => /^rh-live-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) for (const l of readFileSync(join(config.logDir, f), "utf8").split("\n")) { try { if (l.trim()) rows.push(JSON.parse(l) as Record<string, unknown>); } catch { /* lewati */ } }
  const sells = rows.filter((r) => r.action === "LIVE_SELL" && r.ok).map((r) => ({ token: String(r.token), symbol: r.symbol as string | undefined, ts: Number(r.ts ?? 0) }));
  const sold = new Set(sells.map((s) => s.token.toLowerCase()));
  const buys = rows.filter((r) => r.action === "LIVE_BUY" && r.ok);
  let paperHeld = new Set<string>();
  const stPath = join(config.logDir, "rh-paper-state.json");
  if (existsSync(stPath)) {
    try {
      const st = JSON.parse(readFileSync(stPath, "utf8")) as { variants?: Record<string, { positions?: Array<{ token: string }> }> };
      paperHeld = new Set((st.variants?.["v42-liq25-50"]?.positions ?? []).map((x) => String(x.token).toLowerCase()));
    } catch { /* state rusak → anggap kosong (fail-closed: posisi akan dianggap yatim) */ }
  }
  const positions = buys.filter((b) => !sold.has(String(b.token).toLowerCase())).map((b) => {
    const tk = String(b.token).toLowerCase();
    const ageMin = (Date.now() - Number(b.ts ?? 0)) / 60_000;
    const holds = paperHeld.has(tk);
    const tooOld = Date.now() - Number(b.ts ?? 0) > MAX_AGE_MS;
    const reason = tooOld ? "umur > batas (" + (MAX_AGE_MS / 3_600_000) + " jam) → jual otomatis" : holds ? "menunggu arm paper v42 menutup posisi" : "yatim (paper tak memegang) → jual otomatis";
    return { token: String(b.token), symbol: b.symbol as string | undefined, notionalUsd: Number(b.notionalUsd ?? 0), route: String(b.route ?? "?"), ageMin: Number(ageMin.toFixed(1)), paperHolds: holds, reason };
  });
  const eth = Number(BigInt(await rpc("eth_getBalance", [WALLET, "latest"]))) / 1e18;
  const weth = await erc20(WETH, 18);
  const usdg = await erc20(USDG, 6);
  // FIX 2026-10-21: buang posisi ber-saldo 0 (HANTU) — HOOT tampil 15 jam padahal 0 token.
  // Panel harus menampilkan posisi NYATA saja; token yang tak ada di wallet tidak bisa dijual siapa pun.
  const zeroBal = new Set<string>();
  for (const p of positions) {
    try {
      const r = await rpc("eth_call", [{ to: p.token, data: "0x70a08231000000000000000000000000" + WALLET.slice(2).toLowerCase() }, "latest"]);
      if (BigInt(r ?? "0x0") === 0n) zeroBal.add(p.token.toLowerCase());
    } catch { /* jika tak terbaca, biarkan tampil (fail-visible) */ }
  }
  const positionsLive = positions.filter((p) => !zeroBal.has(p.token.toLowerCase()));
  return { wallet: WALLET, balances: { eth, weth, usdg }, positions: positionsLive, sells, costs: { poolFeePct: 0.01, gasPerSwapUsd: 0.007, note: "terukur 2026-10-18/19: fee pool 0,01% (fee()=100), gas nyata $0,0064–0,0080 per swap" }, generatedAt: Date.now() };
}

void (async () => {
  const s = await liveStatus();
  console.log(JSON.stringify(s, null, 1));
})();
