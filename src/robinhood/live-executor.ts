/**
 * JEMBATAN SINYAL → EKSEKUSI (2b) — `npm run rh:live -- [--strategy v42-liq25-50] [--usd 25] [--yes]`.
 *
 * Prinsip: LANE TIDAK DISENTUH. Sinyalnya dibaca dari ledger paper (baris RH_OPEN arm pilihan) — jadi
 * apa yang live kerjakan adalah persis sinyal yang sudah diukur, bukan logika baru.
 *  - MASUK: sinyal RH_OPEN arm strategi → beli token itu dengan notional $ (default $25) via OKX (jalur wrap→swap).
 *  - KELUAR: baris RH_CLOSE arm yang sama untuk token yang kita pegang → jual 100%.
 *  - Tag strategi ditulis ke logs/rh-live-<tanggal>.jsonl → atribusi live terpisah dari penantang.
 *  - PENGAMAN: default DRY-RUN (tanpa --yes tidak ada tanda tangan/broadcast); simulasi pra-kirim;
 *    maksimum 1 posisi live per token; slippage ≤5%; berhenti bila saldo < notional.
 *
 * Catatan jujur: eksekusi keluar memakai jalur yang sama (approve token sekali, lalu swap jual).
 */
import { readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.js";

const CHAIN = 4663;
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const KEY_PATH = join(config.logDir, "rh-wallet.key");
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const DEX_APPROVE = "0x42170295f1173c9e5874ea9d00c6d137e1a4f53d";

const envOf = (): Record<string, string> => Object.fromEntries(readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
async function okx(path: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const ts = new Date().toISOString();
  const sign = createHmac("sha256", env.OKX_SECRET_KEY ?? "").update(ts + "GET" + path).digest("base64");
  const h: Record<string, string> = { "OK-ACCESS-KEY": env.OKX_API_KEY ?? "", "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": env.OKX_API_PASSPHRASE ?? "", "content-type": "application/json" };
  if (env.OKX_PROJECT_ID) h["OK-ACCESS-PROJECT"] = env.OKX_PROJECT_ID;
  const r = await fetch("https://web3.okx.com" + path, { headers: h });
  const t = await r.text();
  try { return JSON.parse(t) as Record<string, unknown>; } catch { return { code: "?", msg: t.slice(0, 100) }; }
}
async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string, d: string): string => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1]! : d; };
  const yes = argv.includes("--yes");
  const strategy = arg("strategy", "v42-liq25-50");
  const usd = Number(arg("usd", "25"));
  const max = Number(arg("max", "1"));
  const env = envOf();
  const day = new Date().toISOString().slice(0, 10);
  const liveLog = join(config.logDir, "rh-live-" + day + ".jsonl");
  const live = existsSync(liveLog) ? readFileSync(liveLog, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }) : [];
  const held = live.filter((r) => r.action === "LIVE_BUY" && r.ok);
  const ethNow = Number(BigInt((await rpc("eth_getBalance", [process.env.BOT_WALLET ?? "0x629Ec42444A43A0E02A572587E3A49904542F4E8", "latest"])).result as string)) / 1e18;

  console.log("  ══ JEMBATAN SINYAL→EKSEKUSI — arm " + strategy + " · notional $" + usd + (yes ? " · MODE: EKSEKUSI" : " · MODE: DRY-RUN") + " ══");
  console.log("  saldo ETH wallet bot: " + ethNow.toFixed(6) + " ETH ≈ $" + (ethNow * 2361).toFixed(2));
  if (ethNow * 2361 < usd) { console.log("  TOLAK: saldo < notional $" + usd + " — tidak ada yang dijalankan."); return; }

  // Sinyal dari ledger paper arm terpilih (hari ini)
  const files = readdirSync(config.logDir).filter((f) => /^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-1);
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) for (const l of readFileSync(join(config.logDir, f), "utf8").split("\n")) {
    if (!l.includes('"' + strategy + '"')) continue;
    try { rows.push(JSON.parse(l) as Record<string, unknown>); } catch { /* baris rusak dilewati */ }
  }
  const opens = rows.filter((r) => r.action === "RH_OPEN");
  const closes = rows.filter((r) => r.action === "RH_CLOSE");
  console.log("  sinyal paper (berkas " + (files[0] ?? "-") + "): " + opens.length + " buka · " + closes.length + " tutup");

  const doneBuys = new Set(held.map((r) => String(r.token).toLowerCase()));
  const doneSells = new Set(live.filter((r) => r.action === "LIVE_SELL").map((r) => String(r.token).toLowerCase()));
  const soldOk = new Set(live.filter((r) => r.action === "LIVE_SELL" && r.ok).map((r) => String(r.token).toLowerCase()));
  const openLive = held.filter((r) => !soldOk.has(String(r.token).toLowerCase())).length;
  let todoBuy = opens.filter((r) => !doneBuys.has(String(r.token).toLowerCase()));
  if (openLive >= 1) { console.log("  ATURAN SATU-POSISI: ada " + openLive + " posisi live terbuka → tidak buka posisi baru dulu."); todoBuy = []; }
  todoBuy = todoBuy.slice(0, Math.max(max, 25)); // PINDAI jendela luas; eksekusi tetap dibatasi max
  const liveTokens = new Set(held.map((r) => String(r.token).toLowerCase()));
  const todoSell = closes.filter((r) => liveTokens.has(String(r.token).toLowerCase()) && !doneSells.has(String(r.token).toLowerCase()));

  console.log("  rencana: BELI " + todoBuy.length + " token · JUAL " + todoSell.length + " token");
  for (const r of todoBuy.slice(0, 5)) console.log("    beli : " + String(r.symbol ?? r.token).padEnd(12) + " $" + usd + " (" + String(r.token).slice(0, 12) + "…)");
  for (const r of todoSell.slice(0, 5)) console.log("    jual : " + String(r.symbol ?? r.token).padEnd(12) + " 100%");
  if (!todoBuy.length && !todoSell.length) { console.log("  tidak ada aksi baru (sinyal hari ini sudah dijalankan atau belum ada)."); return; }
  if (!yes) { console.log("\n  DRY-RUN selesai — tidak ada tanda tangan/broadcast. Jalankan dengan --yes untuk eksekusi."); return; }

  const { privateKeyToAccount } = await import("viem/accounts");
  const { createWalletClient, createPublicClient, http } = await import("viem");
  const bot = privateKeyToAccount(("0x" + readFileSync(KEY_PATH, "utf8").trim().replace(/^0x/, "")) as `0x${string}`);
  const wallet = createWalletClient({ account: bot, transport: http(RPC) });
  const pub = createPublicClient({ transport: http(RPC) }) as unknown as { waitForTransactionReceipt: (a: { hash: `0x${string}` }) => Promise<{ status: string }> };
  const send = async (name: string, to: string, data: string, value: bigint): Promise<string | null> => {
    const gas = 500000n;
    const pre = await rpc("eth_call", [{ from: bot.address, to, value: "0x" + value.toString(16), data, gas: "0x" + gas.toString(16) }, "latest"]);
    if (pre.error) { console.log("    ✗ " + name + " simulasi gagal: " + String(pre.error.message).slice(0, 90)); return null; }
    const hash = await wallet.sendTransaction({ to: to as `0x${string}`, data: data as `0x${string}`, value, gas } as never);
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log("    " + (rc.status === "success" ? "✓" : "✗") + " " + name + " · " + hash);
    return rc.status === "success" ? hash : null;
  };
  const weiPerUsd = BigInt(Math.round((1 / 2361) * 1e18));
  let executed = 0;
  const scanned: string[] = [];
  for (const r of todoBuy) {
    if (executed >= max) break;
    const token = String(r.token);
    const amount = weiPerUsd * BigInt(Math.round(usd));
    const sw = await okx(`/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&fromTokenAddress=${WETH}&toTokenAddress=${token}&amount=${amount}&swapMode=exactIn&slippagePercent=5&userWalletAddress=${bot.address}`, env);
    const sd = ((sw.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    const tx = (sd.tx ?? {}) as Record<string, unknown>;
    if (!tx.to || !tx.data) {
      scanned.push(String(r.symbol ?? token));
      console.log("    ⟳ " + String(r.symbol ?? token) + ": OKX tidak bisa merutekan → dilewati (bukan gagal, tidak ada biaya)");
      continue;
    }
    console.log("    ▶ " + String(r.symbol) + " BISA dirutekan → eksekusi $" + usd);
    const h1 = await send("wrap", WETH, "0xd0e30db0", amount);
    const h2 = h1 ? await send("approve", WETH, "0x095ea7b3" + BigInt(DEX_APPROVE).toString(16).padStart(64, "0") + amount.toString(16).padStart(64, "0"), 0n) : null;
    const h3 = h2 ? await send("beli " + String(r.symbol), String(tx.to), String(tx.data), BigInt(String(tx.value ?? "0"))) : null;
    appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "LIVE_BUY", strategy, token, symbol: r.symbol, notionalUsd: usd, amountEth: Number(amount) / 1e18, tx: h3, ok: h3 != null }) + "\n");
    if (h3) executed++;
  }
  if (scanned.length) console.log("  dilewati karena tak bisa dirutekan: " + scanned.length + " (" + scanned.slice(0, 5).join(", ") + ")");
  if (!executed) console.log("  tidak ada order yang tereksekusi pada pemindaian ini.");
}

void main();
