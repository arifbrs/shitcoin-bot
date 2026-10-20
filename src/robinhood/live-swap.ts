/**
 * JALUR EKSEKUSI LIVE — OKX DEX (chain Robinhood) — `npm run rh:live-swap -- …`.
 *
 * Gratis (tanpa paket), self-custody: tanda tangan sendiri memakai logs/rh-wallet.key (0600).
 * Lane tidak pernah membaca kunci ini; proses ini terpisah, hanya atas perintah operator.
 *
 * PELAJARAN 2026-10-16 (dari dua percobaan nyata, total kerugian $0,0079 = gas saja):
 *  - mengirim ETH NATIVE ditolak adaptor OKX → "adaptor call failed" (tereproduksi di simulasi).
 *  - karena itu alur yang benar: WRAP (ETH→WETH) → APPROVE (WETH → approve address OKX) → SWAP (input WETH).
 *  - SETIAP langkah disimulasikan dulu (eth_call); kalau revert, langkah itu TIDAK dikirim → gas tidak terbuang.
 *
 * Pengaman: tanpa --yes hanya pratinjau; slippage ≤ 5%; tolak bila data tx tak lengkap.
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.js";

const CHAIN = 4663;
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const KEY_PATH = join(config.logDir, "rh-wallet.key");
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const DEX_APPROVE = "0x42170295f1173c9e5874ea9d00c6d137e1a4f53d";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

const envOf = (): Record<string, string> => Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));

async function okxGet(path: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const ts = new Date().toISOString();
  const sign = createHmac("sha256", env.OKX_SECRET_KEY ?? "").update(ts + "GET" + path).digest("base64");
  const headers: Record<string, string> = { "OK-ACCESS-KEY": env.OKX_API_KEY ?? "", "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": env.OKX_API_PASSPHRASE ?? "", "content-type": "application/json" };
  if (env.OKX_PROJECT_ID) headers["OK-ACCESS-PROJECT"] = env.OKX_PROJECT_ID;
  const res = await fetch("https://web3.okx.com" + path, { headers });
  const txt = await res.text();
  try { return JSON.parse(txt) as Record<string, unknown>; } catch { return { code: "?", msg: txt.slice(0, 120) }; }
}

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string): string | undefined => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
  const yes = argv.includes("--yes");
  const wrap = argv.includes("--wrap");
  const toSym = arg("to", "USDG")!;
  const amount = arg("amount", "0.002")!;
  const amountRaw = BigInt(Math.round(Number(amount) * 1e6)) * 1_000_000_000_000n; // ETH 18 desimal
  let slipPct = 5;
  const env = envOf();
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createWalletClient, createPublicClient, http } = await import("viem");
  const bot = privateKeyToAccount(("0x" + readFileSync(KEY_PATH, "utf8").trim().replace(/^0x/, "")) as `0x${string}`);
  const wallet = createWalletClient({ account: bot, transport: http(RPC) });
  const pub = createPublicClient({ transport: http(RPC) }) as unknown as { waitForTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<{ status: string }> };

  const tokens = (await okxGet(`/api/v6/dex/aggregator/all-tokens?chainIndex=${CHAIN}`, env)).data as Array<Record<string, unknown>>;
  const toTok = tokens.find((t) => String(t.tokenSymbol).toUpperCase() === toSym.toUpperCase());
  if (!toTok) { console.log("  token " + toSym + " tidak ada di daftar OKX"); return; }
  const toAddr = String(toTok.tokenContractAddress);

  console.log("  ══ jalur: ETH → wrap → " + (wrap ? "approve → " : "") + "swap → " + toSym + " ══");
  console.log("  wallet : " + bot.address + " · Robinhood (" + CHAIN + ") · jumlah " + amount + " ETH");

  const pad = (v: bigint): string => v.toString(16).padStart(64, "0");
  const steps: Array<{ name: string; to: string; data: string; value: bigint }> = [];
  if (wrap) {
    steps.push({ name: "wrap (ETH→WETH)", to: WETH, data: "0xd0e30db0", value: amountRaw });
    steps.push({ name: "approve WETH → OKX", to: WETH, data: "0x095ea7b3" + pad(BigInt(DEX_APPROVE)) + pad(amountRaw), value: 0n });
  }
  const fromTok = wrap ? WETH : NATIVE;
  // SLIPPAGE DINAMIS (2026-10-19): dari priceImpact quote + margin, clamp 1%..10%.
  {
    const qd = await okxGet(`/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${fromTok}&toTokenAddress=${toAddr}&amount=${amountRaw}&swapMode=exactIn`, env);
    if (qd.code === "0") {
      const d0 = ((qd.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      const imp = Number(d0.priceImpactPercentage ?? NaN);
      if (Number.isFinite(imp)) slipPct = Math.min(10, Math.max(1, imp + 1));
    }
  }
  const sw = await okxGet(`/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&fromTokenAddress=${fromTok}&toTokenAddress=${toAddr}&amount=${amountRaw}&swapMode=exactIn&slippagePercent=${slipPct}&userWalletAddress=${bot.address}`, env);
  if (sw.code !== "0") { console.log("  swap API: ✗ code=" + sw.code + " " + String(sw.msg).slice(0, 100)); return; }
  const sd = (sw.data as Array<Record<string, unknown>>)[0] ?? {};
  const tx = (sd.tx ?? {}) as Record<string, unknown>;
  if (!tx.to || !tx.data) { console.log("  TOLAK: data tx tak lengkap"); return; }
  steps.push({ name: "swap → " + toSym, to: String(tx.to), data: String(tx.data), value: BigInt(String(tx.value ?? "0")) });

  for (const s of steps) console.log("  langkah: " + s.name.padEnd(24) + " to=" + s.to.slice(0, 10) + "… · value=" + s.value);
  if (!yes) { console.log("\n  PRATINJAU saja (tanpa --yes). Tambahkan --yes untuk menjalankan."); return; }

  for (const s of steps) {
    const gas = 400000n;
    const pre = await rpc("eth_call", [{ from: bot.address, to: s.to, value: "0x" + s.value.toString(16), data: s.data, gas: "0x" + gas.toString(16) }, "latest"]);
    if (pre.error) { console.log("  ✗ " + s.name + ": simulasi GAGAL → berhenti, tidak ada gas terbuang: " + String(pre.error.message).slice(0, 100)); return; }
    console.log("  ▶ " + s.name + " … simulasi lolos");
    const hash = await wallet.sendTransaction({ to: s.to as `0x${string}`, data: s.data as `0x${string}`, value: s.value, gas } as never);
    console.log("    terkirim: " + hash);
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log("    status: " + (rc.status === "success" ? "SUKSES ✓" : "GAGAL ✗"));
    if (rc.status !== "success") { console.log("  berhenti di langkah ini."); return; }
  }
  console.log("\n  selesai. Ukur: npm run rh:fills --silent -- " + bot.address);
}

void main();
