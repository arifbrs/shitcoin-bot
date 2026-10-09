/**
 * CHART — grafik batang (candlestick ASCII) per koin. Pengambilan data ada di chart-data.ts (dipakai
 * bersama endpoint dashboard `/api/chart`), jadi CLI ini hanya soal argumen + gambar.
 *
 * Sumber yang DIUKUR bisa (2026-10-08):
 *   GeckoTerminal  OHLCV per POOL, tanpa kunci, lintas-chain (minute/hour/day). Limit per-IP ketat.
 *   GMGN kline     cadangan Solana lewat proxy lokal (chain "sol"), kuota ketat.
 *   DexScreener    TIDAK punya data lilin — 13 endpoint resminya berhenti di harga/volume agregat.
 *
 * Run:
 *   npm run chart -- --token <mint> [--chain solana] [--tf 5m] [--bars 60] [--json]
 *   npm run chart -- --chain robinhood --pool <alamatPool> [--tf 15m]
 */
import "dotenv/config";
import { fetchCandles, type Candle } from "./chart-data.js";

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const chain = (flag("--chain") ?? "solana").trim();
const token = flag("--token")?.trim();
const pool = flag("--pool")?.trim();
const tf = (flag("--tf") ?? "5m").trim();
const bars = Math.min(300, Math.max(10, Number(flag("--bars") ?? 60) || 60));
const AS_JSON = argv.includes("--json");

const fmtPrice = (v: number): string => (v >= 1 ? `$${v.toFixed(4)}` : `$${v.toPrecision(4)}`);
const fmtUsd = (v: number): string => `$${Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(0)}`;

/** Grafik batang: badan lilin █ (naik) / ▓ (turun), sumbu bayangan │. */
function render(candles: Candle[], label: string, source: string): void {
  const rows = candles.slice(-bars);
  const min = Math.min(...rows.map((c) => c.l));
  const max = Math.max(...rows.map((c) => c.h));
  const H = 14;
  const grid: string[][] = Array.from({ length: H }, () => []);
  for (const c of rows) {
    const bodyTop = Math.max(c.o, c.c), bodyBot = Math.min(c.o, c.c);
    for (let lev = 0; lev < H; lev++) {
      const top = max - (max - min) * (lev / H);
      const bot = max - (max - min) * ((lev + 1) / H);
      const inWick = c.h >= bot && c.l <= top;
      const inBody = bodyTop >= bot && bodyBot <= top;
      grid[lev]?.push(inBody ? (c.c >= c.o ? "█" : "▓") : inWick ? "│" : " ");
    }
  }
  const first = rows[0], last = rows[rows.length - 1];
  if (!first || !last) return;
  const chg = ((last.c - first.o) / first.o) * 100;
  const vol = rows.reduce((a, c) => a + c.v, 0);
  const span = `${new Date(first.t).toISOString().slice(5, 16).replace("T", " ")} → ${new Date(last.t).toISOString().slice(5, 16).replace("T", " ")}`;
  console.log(`\n  ${label}  ·  ${tf}  ·  ${rows.length} lilin  ·  sumber: ${source}`);
  console.log(`  ${span} UTC  ·  ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%  ·  high ${fmtPrice(max)}  low ${fmtPrice(min)}  ·  vol ${fmtUsd(vol)} (USD, per sumber)\n`);
  for (let lev = 0; lev < H; lev++) {
    const price = max - (max - min) * ((lev + 0.5) / H);
    const axis = lev === 0 || lev === H - 1 || lev === Math.floor(H / 2) ? fmtPrice(price).padStart(12) : " ".repeat(12);
    console.log(`  ${axis} │ ${grid[lev]?.join("") ?? ""}`);
  }
  const vmax = Math.max(...rows.map((c) => c.v), 1);
  const blocks = "▁▂▃▄▅▆▇█";
  console.log(`  ${"volume".padStart(12)} │ ${rows.map((c) => blocks[Math.min(7, Math.floor((c.v / vmax) * 8))]).join("")}`);
  console.log(`  ${"harga terakhir".padStart(12)} │ ${fmtPrice(last.c)}  (O ${fmtPrice(last.o)} H ${fmtPrice(last.h)} L ${fmtPrice(last.l)})`);
}

async function main(): Promise<void> {
  const out = await fetchCandles({ chain, token, pool, tf, bars });
  if (!out.candles.length) {
    console.log(`\n  ${out.error}`);
    console.log(`  (DexScreener tidak punya API lilin; GT = sumber gratis, GMGN kline = cadangan Solana.)`);
    return;
  }
  if (AS_JSON) { console.log(JSON.stringify(out.candles, null, 1)); return; }
  render(out.candles, token ? `${chain}:${token.slice(0, 10)}…` : `${chain}:${(out.pool ?? "").slice(0, 10)}…`, out.source === "gmgn-kline" ? "GMGN kline (cadangan; kuota GMGN terpakai)" : `GeckoTerminal (pool ${(out.pool ?? "").slice(0, 8)}…)`);
  console.log(`\n  CATATAN SUMBER: DexScreener TIDAK punya API lilin (hanya harga/volume agregat) — bar hanya`);
  console.log(`  dari GeckoTerminal (gratis, tanpa kunci, per-POOL, limit per-IP) atau GMGN kline (kuota ketat).`);
}

void main();
