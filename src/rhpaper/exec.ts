/**
 * EXEC — SATU-SATUNYA JALAN EKSEKUSI (paper 1:1 dengan live). 2026-10-21.
 *
 * Prinsip (dari plan yang disetujui):
 *  - Harga fill = harga QUOTE rute (bukan harga pool/mark).
 *  - Quote gagal → TIDAK BOLEH entry. Simulasi `eth_call` gagal → TIDAK dikirim.
 *  - Biaya = terukur: fee pool 0,01% (fee()=100) + gas nyata + slippage dari quote.
 *  - Paper dan live memanggil modul ini; bedanya hanya apakah tx dikirim.
 *
 * Catatan: jeda 1,2s antar panggilan OKX (rate limit); tidak ada panggilan beruntun.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export const CHAIN = 4663;
export const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
export const OKX_APPROVE = "0x42170295f1173c9e5874ea9d00c6d137e1a4f53d";
export const POOL_FEE_PCT = 0.0001; // 100 = 0,01% (terukur dari fee() pool)

export interface QuoteRef { ts: number; route: string; amountIn: string; amountOut: string; impactPct: number; slippagePct: number }
export interface QuoteResult { ok: boolean; reason?: string; quote?: QuoteRef; tx?: { to: string; data: string; value: string } }

let lastCall = 0;
export async function throttle(ms = 2000): Promise<void> {
  const wait = lastCall + ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

export function envOf(): Record<string, string> {
  return Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")];
  }));
}

/** Slippage dari dampak harga quote + margin 1%, dijepit 1%..10% (batas empiris: 2% gagal, 10% berhasil). */
export function slippageFor(impactPct: number): number {
  if (!Number.isFinite(impactPct)) return 5;
  return Math.min(10, Math.max(1, impactPct + 1));
}

export async function okxGet(path: string, env = envOf()): Promise<Record<string, unknown>> {
  await throttle();
  const ts = new Date().toISOString();
  const sign = createHmac("sha256", env.OKX_SECRET_KEY ?? "").update(ts + "GET" + path).digest("base64");
  const headers: Record<string, string> = {
    "OK-ACCESS-KEY": env.OKX_API_KEY ?? "", "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": env.OKX_API_PASSPHRASE ?? "", "content-type": "application/json",
  };
  if (env.OKX_PROJECT_ID) headers["OK-ACCESS-PROJECT"] = env.OKX_PROJECT_ID;
  const res = await fetch("https://web3.okx.com" + path, { headers });
  const txt = await res.text();
  try { return JSON.parse(txt) as Record<string, unknown>; } catch { return { code: "?", msg: txt.slice(0, 120) }; }
}

export async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

export async function decimalsOf(token: string): Promise<number> {
  try {
    const r = await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
    const v = r.result as string | undefined;
    if (v && v !== "0x") return Number(BigInt(v));
  } catch { /* fallback */ }
  return 18;
}

async function swapPath(from: string, to: string, amountRaw: string, maker: string): Promise<Record<string, unknown>> {
  const env = envOf();
  const q = await okxGet(`/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${from}&toTokenAddress=${to}&amount=${amountRaw}&swapMode=exactIn`, env);
  if (q.code !== "0") return { ok: false, reason: "quote: " + String(q.msg ?? q.code) };
  const d = ((q.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
  const impact = Number(d.priceImpactPercentage ?? NaN);
  if (Number(d.toTokenAmount ?? 0) <= 0) return { ok: false, reason: "quote: keluaran 0" };
  if (Number.isFinite(impact) && impact >= 5) return { ok: false, reason: "quote: dampak " + impact.toFixed(2) + "% ≥ 5%" };
  const slip = slippageFor(impact);
  const s = await okxGet(`/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&fromTokenAddress=${from}&toTokenAddress=${to}&amount=${amountRaw}&swapMode=exactIn&slippagePercent=${slip}&userWalletAddress=${maker}`, env);
  if (s.code !== "0") return { ok: false, reason: "swap: " + String(s.msg ?? s.code) };
  const sd = ((s.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
  const tx = (sd.tx ?? {}) as Record<string, unknown>;
  if (!tx.to || !tx.data) return { ok: false, reason: "swap: data tx tidak lengkap" };
  return { ok: true, quote: { ts: Date.now(), route: "okx", amountIn: amountRaw, amountOut: String(d.toTokenAmount), impactPct: impact, slippagePct: slip } as QuoteRef, tx: { to: String(tx.to), data: String(tx.data), value: String(tx.value ?? "0") } };
}

/** Quote+swap untuk BELI (WETH → token) memakai `usd` sebagai nilai tukar WETH. */
export async function quoteBuy(token: string, wethAmountRaw: string, maker: string): Promise<QuoteResult> {
  return (await swapPath(WETH, token, wethAmountRaw, maker)) as unknown as QuoteResult;
}

/** Quote+swap untuk JUAL (token → WETH). */
export async function quoteSell(token: string, tokenAmountRaw: string, maker: string): Promise<QuoteResult> {
  return (await swapPath(token, WETH, tokenAmountRaw, maker)) as unknown as QuoteResult;
}

/** Simulasi wajib sebelum kirim. */
export async function simulate(tx: { to: string; data: string; value: string }, from: string): Promise<{ ok: boolean; reason?: string }> {
  const r = await rpc("eth_call", [{ from, to: tx.to, value: "0x" + BigInt(tx.value || "0").toString(16), data: tx.data, gas: "0xb71b0" }, "latest"]);
  return r.error ? { ok: false, reason: String(r.error.message ?? "revert").slice(0, 100) } : { ok: true };
}

export async function signer() {
  const { privateKeyToAccount } = await import("viem/accounts");
  const k = readFileSync("logs/rh-wallet.key", "utf8").trim().replace(/^0x/, "");
  return privateKeyToAccount(("0x" + k) as `0x${string}`);
}

export async function allowanceOf(token: string, owner: string): Promise<bigint> {
  const data = "0xdd62ed3e" + owner.slice(2).toLowerCase().padStart(64, "0") + OKX_APPROVE.slice(2).toLowerCase().padStart(64, "0");
  const r = await rpc("eth_call", [{ to: token, data }, "latest"]);
  return BigInt((r.result as string) ?? "0x0");
}

export async function send(tx: { to: string; data: string; value: string }): Promise<{ ok: boolean; hash?: string; reason?: string }> {
  const { createWalletClient, createPublicClient, http } = await import("viem");
  const acct = await signer();
  const wallet = createWalletClient({ account: acct, transport: http(RPC) });
  try {
    const w = wallet as unknown as { sendTransaction: (a: Record<string, unknown>) => Promise<string> };
    const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || "0"), account: acct, chain: null });
    const pub = createPublicClient({ transport: http(RPC) });
    const rc = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    return { ok: rc.status === "success", hash };
  } catch (e) { return { ok: false, reason: String((e as Error).message).slice(0, 120) }; }
}

export async function ensureApprove(token: string, owner: string): Promise<{ ok: boolean; hash?: string; reason?: string }> {
  if ((await allowanceOf(token, owner)) >= 2n ** 200n) return { ok: true };
  return send({ to: token, data: "0x095ea7b3" + OKX_APPROVE.slice(2).toLowerCase().padStart(64, "0") + "f".repeat(64), value: "0" });
}

export async function fillBuy(token: string, wethRaw: string, maker: string): Promise<{ ok: boolean; hash?: string; reason?: string; quote?: QuoteRef }> {
  const q = await quoteBuy(token, wethRaw, maker);
  if (!q.ok) return { ok: false, reason: q.reason };
  const sim = await simulate(q.tx!, maker);
  if (!sim.ok) return { ok: false, reason: "simulasi: " + (sim.reason ?? "revert") };
  return { ...(await send(q.tx!)), quote: q.quote };
}

export async function fillSell(token: string, qtyRaw: string, maker: string): Promise<{ ok: boolean; hash?: string; reason?: string; quote?: QuoteRef }> {
  const ap = await ensureApprove(token, maker);
  if (!ap.ok) return { ok: false, reason: "approve: " + (ap.reason ?? "gagal") };
  const q = await quoteSell(token, qtyRaw, maker);
  if (!q.ok) return { ok: false, reason: q.reason };
  const sim = await simulate(q.tx!, maker);
  if (!sim.ok) return { ok: false, reason: "simulasi: " + (sim.reason ?? "revert") };
  return { ...(await send(q.tx!)), quote: q.quote };
}
