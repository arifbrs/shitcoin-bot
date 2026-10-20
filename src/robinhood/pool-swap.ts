/**
 * POOL-SWAP LANGSUNG (jalur universal) — `npm run rh:pool-swap -- --token <addr> --side buy|sell --amount <n> [--yes]`.
 *
 * Terbukti di rantai 2026-10-18: 1.000 gilet → 0,00000404 WETH (gas $0,0064), lewat kontrak helper
 * sendiri 0xb7c640835f6250e06990cc6d9b14d3ca8554a005. Tidak butuh OKX, tidak butuh router ber-whitelist.
 *
 * PELAJARAN YANG SUDAH TERVERIFIKASI (jangan diubah tanpa bukti baru):
 *  - fee pool V3 dinyatakan dalam seperseratus basis poin → 100 = 0,01% (bukan 1%).
 *  - sqrtPriceLimitX96: zeroForOne=false (harga NAIK) → limit DI ATAS harga; true → DI BAWAH. Salah sisi = "SPL".
 *  - helper menarik token input via transferFrom(owner) → butuh approve token; untuk beli, ETH di-wrap dulu.
 *  - SETIAP langkah disimulasikan (eth_call) sebelum dikirim; gagal = tidak dikirim (gas tidak terbuang).
 */
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.js";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const HELPER = "0x791945d9563f789ab437f77b62a698432ee7b323";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const KEY_PATH = join(config.logDir, "rh-wallet.key");

// FIX 2026-10-18: ABI tanpa `outputs` membuat viem gagal membaca nilai balik (fee NaN, token0 undefined).
const abiOf = (rows: Array<[string, string, string[], string[]]>): unknown[] => rows.map(([n, sm, ins, outs]) => ({ name: n, type: "function", stateMutability: sm, inputs: ins.map((t) => ({ type: t })), outputs: outs.map((t) => ({ type: t })) }));
const ABI = abiOf([
  ["swapExactIn", "nonpayable", ["address", "bool", "uint256", "uint160", "uint256"], ["uint256"]],
  ["approve", "nonpayable", ["address", "uint256"], ["bool"]],
  ["deposit", "payable", [], []],
  ["balanceOf", "view", ["address"], ["uint256"]],
  ["slot0", "view", [], ["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"]],
  ["token0", "view", [], ["address"]],
  ["token1", "view", [], ["address"]],
  ["fee", "view", [], ["uint24"]],
]);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d?: string): string | undefined => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
  const yes = argv.includes("--yes");
  const token = arg("token");
  const side = arg("side", "buy")!;
  const amountAll = argv.includes("--all"); // jual SELURUH saldo token (atau pakai seluruh WETH untuk beli)
  const amountEth = Number(arg("amount", "0.002"));
  if (!token) { console.log("  pakai: --token 0x… --side buy|sell --amount 0.002 [--yes]"); return; }
  if (!amountAll && amountEth <= 0) { console.log("  --amount harus > 0 (atau pakai --all)"); return; }

  const env = Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createWalletClient, createPublicClient, http } = await import("viem");
  const { encodeFunctionData } = await import("viem");
  const bot = privateKeyToAccount(("0x" + readFileSync(KEY_PATH, "utf8").trim().replace(/^0x/, "")) as `0x${string}`);
  const wallet = createWalletClient({ account: bot, transport: http(RPC) });
  const pub = createPublicClient({ transport: http(RPC) });

  // pool: dari GMGN (biggest_pool_address) → baca token0/token1/fee di rantai
  const gmgn = (await import("node:child_process")).execFileSync;
  const info = JSON.parse(gmgn("npx", ["gmgn-cli", "token", "info", "--chain", "robinhood", "--address", token, "--raw"], { encoding: "utf8", timeout: 60_000, maxBuffer: 2e7 }) as string) as { biggest_pool_address?: string };
  const pool = String(info.biggest_pool_address ?? "");
  const read = async (fn: string, args: unknown[] = []): Promise<unknown> => pub.readContract({ address: pool as `0x${string}`, abi: ABI as never, functionName: fn, args } as never);
  const t0 = String(await read("token0")).toLowerCase(), t1 = String(await read("token1")).toLowerCase();
  const fee = Number(await read("fee"));
  const wethIsT0 = t0 === WETH, wethIsT1 = t1 === WETH;
  console.log("  token " + token.slice(0, 12) + "… · pool " + pool.slice(0, 12) + "… · pair WETH? " + (wethIsT0 || wethIsT1 ? "ya" : "TIDAK (dua-hop belum didukung di modul ini)") + " · fee " + fee + " (" + (fee / 10000).toFixed(2) + "%)");
  if (!wethIsT0 && !wethIsT1) { console.log("  TOLAK: pool bukan pasangan WETH — modul ini tidak menebak rute dua-hop."); return; }

  const buy = side === "buy";
  const zeroForOne = buy ? wethIsT0 : wethIsT1; // beli: WETH masuk → token keluar
  const slot0 = (await read("slot0")) as unknown[];
  const sqrtP = BigInt(slot0[0] as bigint);
  // FIX 2026-10-19: Number(sqrtP) kehilangan presisi (sqrtP ~1e33 > 2^53) → limit == harga → swap 0/0.
  // Hitung batas dengan BigInt: -5% untuk zeroForOne=true, +5% untuk false (harus STRICTLY di sisi itu).
  const limit = zeroForOne ? (sqrtP * 95n) / 100n : (sqrtP * 105n) / 100n;
  console.log("  DIAG sqrtP=" + sqrtP.toString() + " · limit=" + limit.toString() + " · limit>sqrtP=" + (limit > sqrtP ? "YA" : "TIDAK"));
  // --all: jual seluruh saldo token; untuk beli, pakai seluruh WETH yang ada.
  const balOf = async (tok: string): Promise<bigint> => BigInt((await pub.readContract({ address: tok as `0x${string}`, abi: ABI as never, functionName: "balanceOf", args: [bot.address] } as never)) as bigint);
  // DIAGNOSTIK 2026-10-19: cetak angka yang benar-benar dipakai (bug: swap nol → amountIn 0).
  const balSrc = side === "buy" ? WETH : token;
  const balRead = await balOf(balSrc);
  const amountIn = amountAll ? balRead : BigInt(Math.round(amountEth * 1e6)) * 10n ** 12n;
  console.log("  DIAG amountAll=" + amountAll + " · balOf(" + (side === "buy" ? "WETH" : "token") + ")=" + balRead.toString() + " · amountIn=" + amountIn.toString());
  const steps: Array<{ name: string; to: string; data: string; value: bigint }> = [];
  const wethNow = BigInt((await pub.readContract({ address: WETH as `0x${string}`, abi: ABI as never, functionName: "balanceOf", args: [bot.address] } as never)) as bigint);
  if (buy) {
    // FIX 2026-10-18: WETH yang sudah ada DIPAKAI dulu (hasil jual sebelumnya) — wrap hanya kekurangannya.
    const shortfall = wethNow >= amountIn ? 0n : amountIn - wethNow;
    if (shortfall > 0n) steps.push({ name: "wrap ETH→WETH (kekurangan)", to: WETH, data: encodeFunctionData({ abi: ABI as never, functionName: "deposit", args: [] } as never), value: shortfall });
    else console.log("  (WETH yang ada cukup: " + (Number(wethNow) / 1e18).toFixed(6) + " — tidak perlu wrap)");
    steps.push({ name: "approve WETH→helper", to: WETH, data: encodeFunctionData({ abi: ABI as never, functionName: "approve", args: [HELPER, amountIn] } as never), value: 0n });
  } else {
    steps.push({ name: "approve token→helper", to: token, data: encodeFunctionData({ abi: ABI as never, functionName: "approve", args: [HELPER, amountIn] } as never), value: 0n });
  }
  steps.push({ name: (buy ? "beli" : "jual") + " via pool", to: HELPER, data: encodeFunctionData({ abi: ABI as never, functionName: "swapExactIn", args: [pool, zeroForOne, amountIn, limit, 0n] } as never), value: 0n });
  for (const s of steps) console.log("  langkah: " + s.name.padEnd(26) + " → " + s.to.slice(0, 10) + "…" + (s.value > 0n ? " · value " + s.value : ""));
  if (!yes) { console.log("\n  PRATINJAU (tanpa --yes): tidak ada tanda tangan/broadcast."); return; }

  for (const s of steps) {
    const pre = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from: bot.address, to: s.to, data: s.data, value: "0x" + s.value.toString(16), gas: "0x7a120" }, "latest"] }) });
    const prej = (await pre.json()) as { error?: { message?: string } };
    if (prej.error) { console.log("  ✗ " + s.name + ": simulasi gagal → berhenti (tidak ada gas terbuang): " + String(prej.error.message).slice(0, 90)); return; }
    const hash = await wallet.sendTransaction({ to: s.to as `0x${string}`, data: s.data as `0x${string}`, value: s.value, gas: 500000n } as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log("    " + (rc.status === "success" ? "✓" : "✗") + " " + s.name + " · " + hash);
    if (rc.status !== "success") return;
  }
  void env;
  console.log("\n  selesai — ukur: npm run rh:fills --silent -- " + bot.address);
}

void main();
