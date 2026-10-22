/**
 * KOLEKTOR Lowcap Hunter — mengisi logs/hunter/in-<tanggal>.json dari GMGN.
 * Perintah terverifikasi: `market trending` · `token info` · `token traders`.
 * Tidak mengarang Field: nama field divergen dicocokkan dengan beberapa kandidat, dan
 * bentuk mentah respons pertama dicatat ke logs/hunter/raw-sample.json agar bisa diverifikasi.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gmgnApi } from "./tools.js";

const chain = process.argv[2] ?? "robinhood";
// TERVERIFIKASI dari `portfolio stats --help`: --period hanya 7d / 30d. Jendela 90 hari TIDAK tersedia,
// jadi tidak diklaim: windowDays=30 dan aturan 90 hari otomatis tidak lolos (jujur, bukan diasumsikan).
const STATS_PERIOD = "30d";
const STATS_WINDOW_DAYS = 30;
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

// Filter di sisi server (opsi terverifikasi): mcap <1jt · likuiditas <50rb · bukan honeypot.
const trend = gmgnApi([
  "market", "trending", "--chain", chain, "--interval", "5m", "--limit", String(Math.max(limit, 20)),
  "--max-marketcap", "1000000", "--max-liquidity", "50000",
  ...(chain === "sol" ? [] : ["--filter", "not_honeypot"]),
]);
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
  // PACING: gmgn-cli membalas 429 RATE_LIMIT_EXCEEDED bila dipanggil beruntun (ban bisa memanjang).
  execFileSync("sleep", ["2"]);
  const tradersRes = gmgnApi(["token", "traders", "--chain", chain, "--address", addr, "--order-by", "profit", "--limit", "20"]);
  const traderRows = tokenList(tradersRes);
  // ROI & winrate TIDAK ada di `token traders` — diambil dari `portfolio stats` per wallet (terverifikasi):
  //   roiPct = realized_profit_pnl × 100 · winratePct = pnl_stat.winrate × 100
  // Ambil 3 trader teratas (list sudah urut --order-by profit) agar tidak kena 429.
  const traders: Row["traders"] = [];
  for (const x of traderRows.slice(0, 3)) {
    const wa = String(pick(x, ["address", "wallet", "maker", "trader"]) ?? "");
    if (!wa) continue;
    execFileSync("sleep", ["2"]);
    const st = gmgnApi(["portfolio", "stats", "--chain", chain, "--wallet", wa, "--period", STATS_PERIOD]);
    const stData = ((st?.data ?? st) as Record<string, unknown>) ?? {};
    const pnlStat = (stData.pnl_stat ?? {}) as Record<string, unknown>;
    traders.push({
      address: wa,
      roiPct: num(pick(stData, ["realized_profit_pnl"])) * 100,
      winratePct: num(pick(pnlStat, ["winrate"])) * 100,
      windowDays: STATS_WINDOW_DAYS, // 30 hari = maksimum yang benar-benar tersedia
    });
  }
  const row: Row = {
    chain, token: addr,
    symbol: String(pick(t, ["symbol", "token_symbol"]) ?? pick(inf, ["symbol", "token_symbol"]) ?? "?"),
    // TERVERIFIKASI dari respons nyata: token info TIDAK punya field market cap.
    // mcap = price.price × circulating_supply (contoh: 0,00028493 × 1e9 ≈ $284.929).
    mcapUsd: num((inf.price as Record<string, unknown> | undefined)?.price) * num(pick(inf, ["circulating_supply", "total_supply"])),
    liquidityUsd: num(pick(inf, ["liquidity", "liquidity_usd", "pool_liquidity"])),
    traders,
  };
  out.push(row);
  console.log("  · " + row.symbol.padEnd(10) + " mcap " + row.mcapUsd.toFixed(0) + " liq " + row.liquidityUsd.toFixed(0) + " trader " + traders.length);
}
const date = new Date().toISOString().slice(0, 10);
writeFileSync(`logs/hunter/in-${date}.json`, JSON.stringify(out, null, 2));
console.log(`  [kolektor] ditulis logs/hunter/in-${date}.json (${out.length} token) — jalankan: npx tsx src/hunter/run.ts`);
