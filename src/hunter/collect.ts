/**
 * KOLEKTOR Lowcap Hunter — mengisi logs/hunter/in-<tanggal>.json dari GMGN.
 * Perintah terverifikasi: `market trending` · `token info` · `token traders`.
 * Tidak mengarang Field: nama field divergen dicocokkan dengan beberapa kandidat, dan
 * bentuk mentah respons pertama dicatat ke logs/hunter/raw-sample.json agar bisa diverifikasi.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { gmgnApi } from "./tools.js";

const chain = process.argv[2] ?? "robinhood";
const limit = Number(process.argv[3] ?? 20);

type Row = { chain: string; token: string; symbol: string; mcapUsd: number; liquidityUsd: number; traders: Array<{ address: string; roiPct: number; winratePct: number; windowDays: number }> };

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pick = (o: Record<string, unknown>, keys: string[]): unknown => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

function tokenList(res: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!res) return [];
  const d = (res.data ?? res) as unknown;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  const o = d as Record<string, unknown>;
  for (const k of ["rank", "tokens", "list", "items", "rows"]) if (Array.isArray(o[k])) return o[k] as Array<Record<string, unknown>>;
  return [];
}

const trend = gmgnApi(["market", "trending", "--chain", chain, "--limit", String(limit)]);
mkdirSync("logs/hunter", { recursive: true });
writeFileSync("logs/hunter/raw-sample.json", JSON.stringify({ trending: trend }, null, 2).slice(0, 20000));

const list = tokenList(trend).slice(0, limit);
console.log(`  [kolektor] ${chain}: trending mengembalikan ${list.length} token`);

const out: Row[] = [];
for (const t of list) {
  const addr = String(pick(t, ["address", "token_address", "tokenAddress", "contract"]) ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) continue;
  const info = gmgnApi(["token", "info", "--chain", chain, "--address", addr]) ?? {};
  const inf = ((info.data ?? info) as Record<string, unknown>) ?? {};
  const tradersRes = gmgnApi(["token", "traders", "--chain", chain, "--address", addr]);
  const traderRows = tokenList(tradersRes);
  const traders = traderRows.map((x) => ({
    address: String(pick(x, ["address", "wallet", "maker", "trader"]) ?? ""),
    roiPct: num(pick(x, ["roi", "roi_pct", "roiPercent", "profit_pct", "realized_profit_pct"])),
    winratePct: num(pick(x, ["winrate", "win_rate", "winrate_pct", "win_rate_pct"])) * (num(pick(x, ["winrate", "win_rate"])) <= 1 ? 100 : 1),
    windowDays: num(pick(x, ["window_days", "period_days", "days"])) || 90,
  })).filter((x) => x.address);
  const row: Row = {
    chain, token: addr,
    symbol: String(pick(t, ["symbol", "token_symbol"]) ?? pick(inf, ["symbol", "token_symbol"]) ?? "?"),
    mcapUsd: num(pick(inf, ["market_cap", "mcap", "marketCap", "fdv"])),
    liquidityUsd: num(pick(inf, ["liquidity", "liquidity_usd", "pool_liquidity"])),
    traders,
  };
  out.push(row);
  console.log("  · " + row.symbol.padEnd(10) + " mcap " + row.mcapUsd.toFixed(0) + " liq " + row.liquidityUsd.toFixed(0) + " trader " + traders.length);
}
const date = new Date().toISOString().slice(0, 10);
writeFileSync(`logs/hunter/in-${date}.json`, JSON.stringify(out, null, 2));
console.log(`  [kolektor] ditulis logs/hunter/in-${date}.json (${out.length} token) — jalankan: npx tsx src/hunter/run.ts`);
