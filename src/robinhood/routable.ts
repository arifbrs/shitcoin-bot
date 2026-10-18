/**
 * PENCACAH ROUTABILITAS (kohort routabilitas — potong (a)) — `npm run rh:routable [arm]`.
 *
 * Mengukur: dari sinyal arm tertentu di ledger paper, token mana yang BISA dieksekusi jalur live
 * (OKX bisa merutekan) dan mana yang tidak. Hasilnya dicache ke logs/rh-routable.json supaya
 * gate di lane bisa memakainya TANPA panggilan jaringan (lane tetap cepat & tidak kena rate limit).
 *
 * Read-only, tanpa uang, tidak menyentuh lane.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.js";

const CHAIN = 4663;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const envOf = (): Record<string, string> => Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
async function quoteRoutable(addr: string, env: Record<string, string>): Promise<boolean> {
  const path = `/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${WETH}&toTokenAddress=${addr}&amount=10000000000000000&swapMode=exactIn`;
  const ts = new Date().toISOString();
  const sign = createHmac("sha256", env.OKX_SECRET_KEY ?? "").update(ts + "GET" + path).digest("base64");
  const h: Record<string, string> = { "OK-ACCESS-KEY": env.OKX_API_KEY ?? "", "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": env.OKX_API_PASSPHRASE ?? "", "content-type": "application/json" };
  if (env.OKX_PROJECT_ID) h["OK-ACCESS-PROJECT"] = env.OKX_PROJECT_ID;
  const r = await fetch("https://web3.okx.com" + path, { headers: h });
  const t = await r.text();
  try { return (JSON.parse(t) as { code?: string }).code === "0"; } catch { return false; }
}

async function main(): Promise<void> {
  const arm = process.argv[2] ?? "v42-liq25-50";
  const env = envOf();
  const files = readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-3);
  const toks = new Map<string, string>();
  for (const f of files) for (const l of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!l.includes('"' + arm + '"') || !l.includes("RH_OPEN")) continue;
    try { const j = JSON.parse(l) as { token?: string; symbol?: string }; if (j.token) toks.set(j.token.toLowerCase(), j.symbol ?? j.token); } catch { /* lewati baris rusak */ }
  }
  const routable: Array<{ token: string; symbol: string }> = [];
  const unroutable: Array<{ token: string; symbol: string }> = [];
  for (const [token, symbol] of toks) (await quoteRoutable(token, env) ? routable : unroutable).push({ token, symbol });
  const out = { ts: Date.now(), arm, checked: toks.size, routable, unroutable };
  writeFileSync(join(config.logDir, "rh-routable.json"), JSON.stringify(out, null, 1));
  console.log("  arm " + arm + " · token diperiksa " + toks.size + " → ROUTABLE " + routable.length + " (" + routable.slice(0, 6).map((r) => r.symbol).join(", ") + ")");
  console.log("  tidak routable: " + unroutable.length + " → " + unroutable.slice(0, 5).map((r) => r.symbol).join(", ") + " …");
  console.log("  cache ditulis: " + join(config.logDir, "rh-routable.json") + " (dipakai gate lane, tanpa panggilan jaringan di lane)");
}

void main();
