/**
 * KOLEKTOR Lowcap Hunter — mengisi logs/hunter/in-<tanggal>.json dari GMGN.
 * Perintah terverifikasi: `market trending` · `token info` · `token traders`.
 * Tidak mengarang Field: nama field divergen dicocokkan dengan beberapa kandidat, dan
 * bentuk mentah respons pertama dicatat ke logs/hunter/raw-sample.json agar bisa diverifikasi.
 */
import { mkdirSync, readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { gmgnApi } from "./tools.js";
import { hunterToken, hunterTrader } from "./data.js";
import { normalizedAddress } from "../discovery/gmgn-signal-observations.js";

const chain = process.argv[2] ?? "robinhood";
// TERVERIFIKASI dari `portfolio stats --help`: --period hanya 7d / 30d. Jendela 90 hari TIDAK tersedia,
// jadi tidak diklaim: windowDays=30 dan aturan 90 hari otomatis tidak lolos (jujur, bukan diasumsikan).
const STATS_PERIOD = "30d";
const STATS_WINDOW_DAYS = 30;
const limit = Number(process.argv[3] ?? 20);

type Row = { chain: string; token: string; symbol: string; mcapUsd: number; liquidityUsd: number; traders: Array<{ address: string; roiPct: number; winratePct: number; windowDays: number }>; observedAt?: number; source?: string };

const pick = (o: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

function tokenList(res: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!res) return [];
  const d = (res.data ?? res) as unknown;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  const o = d as Record<string, unknown>;
  for (const k of ["rank", "tokens", "list", "items", "rows"]) if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
  return [];
}

async function main(): Promise<void> {
if (!["sol", "bsc", "base", "eth", "robinhood"].includes(chain) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid chain/limit");
// Keep low-cap filtering local/verified; CLI-only option translation is not guessed here.
const trend = await gmgnApi("getTrendingSwaps", [chain, "5m", { limit: Math.max(limit, 20), max_marketcap: 1_000_000, max_liquidity: 50_000,
  ...(chain === "sol" ? {} : { filters: ["not_honeypot"] }) }]);
mkdirSync("logs/hunter", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`logs/hunter/raw-${chain}-${stamp}.json`, JSON.stringify({ chain, observedAt: Date.now(), trending: trend }, null, 2));

const list = tokenList(trend).slice(0, limit);
console.log(`  [kolektor] ${chain}: trending mengembalikan ${list.length} token`);

const out: Row[] = [];
const unavailable: Array<Record<string, unknown>> = [];
for (const t of list) {
  const addr = String(pick(t, ["address", "token_address", "tokenAddress", "contract"]) ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) continue;
  const info = await gmgnApi("getTokenInfo", [chain, addr]);
  const inf = ((info.data ?? info) as Record<string, unknown>) ?? {};
  const token = hunterToken(chain, normalizedAddress(chain, addr), String(t.symbol ?? inf.symbol ?? "?"), inf);
  if (!token) { unavailable.push({ token: addr, reason: "PRICE_CIRCULATING_SUPPLY_OR_LIQUIDITY_UNAVAILABLE" }); continue; }
  if (token.mcapUsd >= 1_000_000 || token.liquidityUsd >= 50_000) continue;
  const tradersRes = await gmgnApi("getTokenTopTraders", [chain, addr, { order_by: "profit", direction: "desc", limit: 20 }]);
  const traderRows = tokenList(tradersRes);
  // ROI & winrate TIDAK ada di `token traders` — diambil dari `portfolio stats` per wallet (terverifikasi):
  //   roiPct = realized_profit_pnl × 100 · winratePct = pnl_stat.winrate × 100
  // Ambil 3 trader teratas (list sudah urut --order-by profit) agar tidak kena 429.
  const traders: Row["traders"] = [];
  for (const x of traderRows.slice(0, 3)) {
    const wa = String(pick(x, ["address", "wallet", "maker", "trader"]) ?? "");
    if (!wa) continue;
    const st = await gmgnApi("getWalletStats", [chain, [wa], STATS_PERIOD]);
    const stData = ((st?.data ?? st) as Record<string, unknown>) ?? {};
    const trader = hunterTrader(wa, stData, STATS_WINDOW_DAYS);
    if (trader) traders.push(trader); else unavailable.push({ token: addr, wallet: wa, reason: "ROI_OR_WINRATE_UNAVAILABLE" });
  }
  const row: Row = {
    ...token, traders, observedAt: Date.now(), source: "gmgn-proxy-read-only",
  };
  out.push(row);
  console.log("  · " + row.symbol.padEnd(10) + " mcap " + row.mcapUsd.toFixed(0) + " liq " + row.liquidityUsd.toFixed(0) + " trader " + traders.length);
}
const date = new Date().toISOString().slice(0, 10);
const path = `logs/hunter/in-${date}.json`;
const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Row[] : [];
if (!Array.isArray(previous)) throw new Error("hunter input invalid; preserved, not overwritten");
const merged = [...previous.filter((r) => r.chain !== chain || !out.some((x) => normalizedAddress(chain, x.token) === normalizedAddress(chain, r.token))), ...out];
if (existsSync(path)) writeFileSync(`logs/hunter/in-before-${chain}-${stamp}.json`, JSON.stringify(previous, null, 2));
const tmp = `${path}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(merged, null, 2)); renameSync(tmp, path);
writeFileSync(`logs/hunter/coverage-${chain}-${stamp}.json`, JSON.stringify({ chain, observedAt: Date.now(), received: list.length, valid: out.length, unavailable }, null, 2));
console.log(`  [kolektor] ditulis logs/hunter/in-${date}.json (${out.length} token) — jalankan: npx tsx src/hunter/run.ts`);
}

void main().catch((e) => { console.error(`[hunter] unavailable; existing input preserved: ${(e as Error).message}`); process.exitCode = 1; });
