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

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const LIQ_MIN = BigInt(process.env.RH_POOL_LIQ_MIN ?? "1000000000000000000"); // ambang likuiditas pool (bawaan 1e18)

/** Makna BARU (2026-10-18): "bisa dieksekusi live" = punya pool WETH yang berlikuiditas,
 *  karena jalur eksekusi kita sekarang pool langsung (helper 0xb7c64083…), bukan OKX.
 *  Sumber pool: GMGN biggest_pool_address (bukan tebakan) → token0/token1/fee/liquidity dibaca di rantai. */
const rpc = async (method: string, params: unknown[]): Promise<string> => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(String(j.error.message).slice(0, 60));
  return j.result ?? "0x";
};
const call = async (to: string, data: string): Promise<string> => rpc("eth_call", [{ to, data }, "latest"]);
async function hasLiquidWethPool(token: string): Promise<{ ok: boolean; why: string }> {
  let pool = "";
  try {
    const { execFileSync } = await import("node:child_process");
    const info = JSON.parse(execFileSync("npx", ["gmgn-cli", "token", "info", "--chain", "robinhood", "--address", token, "--raw"], { encoding: "utf8", timeout: 60_000, maxBuffer: 2e7 }) as string) as { biggest_pool_address?: string };
    pool = String(info.biggest_pool_address ?? "");
  } catch { return { ok: false, why: "info token gagal" }; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(pool)) return { ok: false, why: "pool tak ada" };
  try {
    const t0 = ("0x" + (await call(pool, "0x0dfe1681")).slice(-40)).toLowerCase();
    const t1 = ("0x" + (await call(pool, "0xd21220a7")).slice(-40)).toLowerCase();
    if (t0 !== WETH && t1 !== WETH) return { ok: false, why: "pool bukan pasangan WETH" };
    const liq = BigInt(await call(pool, "0x1a686502"));
    if (liq < LIQ_MIN) return { ok: false, why: "likuiditas " + liq.toString().slice(0, 10) + "… < ambang" };
    return { ok: true, why: "pool WETH likuid " + liq.toString().slice(0, 10) + "…" };
  } catch { return { ok: false, why: "baca pool gagal" }; }
}

async function main(): Promise<void> {
  const arm = process.argv[2] ?? "v42-liq25-50";
  const files = readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-3);
  const toks = new Map<string, string>();
  for (const f of files) for (const l of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!l.includes('"' + arm + '"') || !l.includes("RH_OPEN")) continue;
    try { const j = JSON.parse(l) as { token?: string; symbol?: string }; if (j.token) toks.set(j.token.toLowerCase(), j.symbol ?? j.token); } catch { /* lewati baris rusak */ }
  }
  const routable: Array<{ token: string; symbol: string; why?: string }> = [];
  const unroutable: Array<{ token: string; symbol: string; why?: string }> = [];
  for (const [token, symbol] of toks) { const r = await hasLiquidWethPool(token); (r.ok ? routable : unroutable).push({ token, symbol, why: r.why } as { token: string; symbol: string; why?: string }); }
  const out = { ts: Date.now(), arm, checked: toks.size, routable, unroutable };
  writeFileSync(join(config.logDir, "rh-routable.json"), JSON.stringify(out, null, 1));
  console.log("  arm " + arm + " · token diperiksa " + toks.size + " → ROUTABLE " + routable.length + " (" + routable.slice(0, 6).map((r) => r.symbol).join(", ") + ")");
  console.log("  tanpa pool WETH likuid: " + unroutable.length + " → " + unroutable.slice(0, 4).map((r) => r.symbol + " (" + (r as { why?: string }).why + ")").join(" · "));
  console.log("  cache ditulis: " + join(config.logDir, "rh-routable.json") + " (dipakai gate lane, tanpa panggilan jaringan di lane)");
}

void main();
