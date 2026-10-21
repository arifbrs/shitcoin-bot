import { fillBuy, fillSell } from "../rhpaper/exec.js";
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
  const exitsOnly = argv.includes("--exits-only"); // mode supervisor: HANYA keluar, tidak membuka posisi baru
  const strategy = arg("strategy", "v42-liq25-50");
  const usd = Number(arg("usd", "25"));
  const max = Number(arg("max", "1"));
  const env = envOf();
  const day = new Date().toISOString().slice(0, 10);
  const liveLog = join(config.logDir, "rh-live-" + day + ".jsonl");
  const live = existsSync(liveLog) ? readFileSync(liveLog, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }) : [];
  const held = live.filter((r) => (r.action === "LIVE_FILL" || r.action === "LIVE_BUY") && r.ok);
  const BOTW = process.env.BOT_WALLET ?? "0x629Ec42444A43A0E02A572587E3A49904542F4E8";
  const ethNow = Number(BigInt((await rpc("eth_getBalance", [BOTW, "latest"])).result as string)) / 1e18;
  // FIX 2026-10-18: hasil penjualan berbentuk WETH — jadi tunai = ETH + WETH (bukan ETH saja).
  const wethRaw = (await rpc("eth_call", [{ to: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", data: "0x70a08231000000000000000000000000" + BOTW.slice(2) }, "latest"])).result as string;
  const wethNow = Number(BigInt(wethRaw ?? "0x0")) / 1e18;
  // TUNAI DALAM USD (2026-10-19): ETH+WETH dikonversi dengan harga dari quote OKX (gratis) + USDG (stable).
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  let usdgNow = 0;
  try {
    const ur = (await rpc("eth_call", [{ to: USDG, data: "0x70a08231000000000000000000000000" + BOTW.slice(2).toLowerCase() }, "latest"])).result as string;
    usdgNow = Number(BigInt(ur ?? "0x0")) / 1e6;
  } catch { usdgNow = 0; }
  let ethUsd = 2361; // fallback (hanya jika quote gagal — dicetak sebagai perkiraan)
  try {
    const qp = await okx(`/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${WETH}&toTokenAddress=${USDG}&amount=1000000000000000000&swapMode=exactIn`, env);
    const dp = ((qp.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    const out = Number(dp.toTokenAmount ?? 0) / 1e6;
    if (qp.code === "0" && out > 0) ethUsd = out;
  } catch { /* fallback */ }
  const cashUsd = (ethNow + wethNow) * ethUsd + usdgNow;
  const cashNow = cashUsd / ethUsd; // setara ETH (untuk kompatibilitas)

  console.log("  ══ JEMBATAN SINYAL→EKSEKUSI — arm " + strategy + " · notional $" + usd + (yes ? " · MODE: EKSEKUSI" : " · MODE: DRY-RUN") + " ══");
  console.log("  saldo tunai: " + ethNow.toFixed(6) + " ETH + " + wethNow.toFixed(6) + " WETH + " + usdgNow.toFixed(4) + " USDG ≈ $" + cashUsd.toFixed(2) + " (ETH @ $" + ethUsd.toFixed(0) + ")");
  // FIX 2026-10-18: pemeriksaan tunai hanya untuk MEMBUKA posisi. Menjual tidak butuh tunai —
  // dan mode exits-only (supervisor) harus tetap bisa keluar walau saldo tunai kecil.
  if (!exitsOnly && cashUsd < usd) { console.log("  TOLAK: tunai (ETH+WETH) < notional $" + usd + " — tidak ada posisi baru dibuka (penjualan tetap jalan)."); }

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
  // FIX 2026-10-21: token yang DIBLOKIR gerbang atau GAGAL dibeli juga dianggap "sudah dicoba" —
  // sebelumnya diulang tiap siklus (287 blokir/hari, loop berputar di token yang sama, tak pernah maju).
  for (const r of live) {
    const a = String(r.action);
    if (a === "UNEXITABLE_BLOCK" || (a === "LIVE_BUY" && !r.ok)) doneBuys.add(String(r.token).toLowerCase());
  }
  const doneSells = new Set(live.filter((r) => r.action === "LIVE_SELL").map((r) => String(r.token).toLowerCase()));
  const soldOk = new Set(live.filter((r) => r.action === "LIVE_SELL" && r.ok).map((r) => String(r.token).toLowerCase()));
  // FIX 2026-10-19: "posisi terbuka" = posisi yang TOKENNYA BENAR-BENAR ADA di wallet.
  // Bug nyata: HOOT tercatat LIVE_BUY tetapi saldonya 0 (swap 0/0 di pool kosong) → posisi hantu
  // memblokir semua entry berikutnya lewat aturan satu-posisi.
  let openLive = 0;
  for (const r of held) {
    const tk = String(r.token).toLowerCase();
    if (soldOk.has(tk)) continue;
    try {
      const b = (await rpc("eth_call", [{ to: r.token as string, data: "0x70a08231000000000000000000000000" + BOTW.slice(2).toLowerCase() }, "latest"])).result as string;
      if (BigInt(b ?? "0x0") > 0n) openLive++;
    } catch { /* gagal baca → anggap tidak terbuka (fail-open untuk entry, tapi gerbang+cash tetap menjaga) */ }
  }
  let todoBuy = opens.filter((r) => !doneBuys.has(String(r.token).toLowerCase()));
  if (openLive >= 1) { console.log("  ATURAN SATU-POSISI: ada " + openLive + " posisi live terbuka → tidak buka posisi baru dulu."); todoBuy = []; }
  todoBuy = todoBuy.slice(0, Math.max(max, 25)); // PINDAI jendela luas; eksekusi tetap dibatasi max
  const liveTokens = new Set(held.map((r) => String(r.token).toLowerCase()));
  const todoSell0 = closes.filter((r) => liveTokens.has(String(r.token).toLowerCase()) && !doneSells.has(String(r.token).toLowerCase()));
  // (a) ATURAN YATIM + BATAS 24 JAM (2026-10-19): jual bila (i) arm paper tak lagi memegang token ini
  // padahal kita memegangnya, atau (ii) posisi live sudah lebih tua dari batas — supaya tidak ada posisi
  // yang menggantung tanpa pemicu (kasus nyata: gilet — pembelian live terjadi setelah sinyal papernya lewat).
  const stj = JSON.parse(readFileSync(join(config.logDir, "rh-paper-state.json"), "utf8")) as { variants?: Record<string, { positions?: Array<{ token: string }> }> };
  const heldPaper = new Set((stj.variants?.[strategy]?.positions ?? []).map((x) => String(x.token).toLowerCase()));
  const MAX_AGE_MS = Number(process.env.LIVE_MAX_POSITION_HOURS ?? 24) * 3_600_000;
  const buys = live.filter((r) => (r.action === "LIVE_FILL" || r.action === "LIVE_BUY") && r.ok);
  const yatim: Array<Record<string, unknown>> = [];
  for (const b of buys) {
    const tk = String(b.token).toLowerCase();
    if (doneSells.has(tk)) continue;
    const tua = Date.now() - Number(b.ts ?? 0) > MAX_AGE_MS;
    if (!heldPaper.has(tk) || tua) yatim.push({ token: b.token, symbol: b.symbol, why: tua ? "umur > batas" : "yatim (paper tak memegang)" });
  }
  const todoSell = todoSell0.slice();
  for (const y of yatim) {
    if (!todoSell.some((x) => String(x.token).toLowerCase() === String(y.token).toLowerCase())) { todoSell.push(y); console.log("    (yatim) " + String(y.symbol ?? y.token) + " — " + String(y.why)); }
  }

  if (!exitsOnly) console.log("  rencana: BELI " + todoBuy.length + " token · JUAL " + todoSell.length + " token");
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
  // JALUR: pool-swap (helper sendiri) — dipanggil lewat CLI yang sudah tervalidasi, bukan disalin.
  // Alasan: CLI itu sudah punya wrap→approve→swapExactIn + simulasi pra-kirim di tiap langkah.
  const { execFileSync } = await import("node:child_process");
  const runSwap = (side: "buy" | "sell", token: string, amount: number): boolean => {
    const amountArg = side === "sell" ? ["--all"] : ["--amount", String(amount)];
    try {
      const out = execFileSync("npx", side === "buy"
        ? ["tsx", "src/robinhood/live-swap.ts", "--from", "ETH", "--to", token, "--amount", String(amount), "--yes"]
        : ["tsx", "src/robinhood/live-swap.ts", "--from", token, "--to", "ETH", "--amount", String(amount), "--yes"], { encoding: "utf8", timeout: 300_000, maxBuffer: 2e7 });
      return out.includes("selesai");
    } catch (e) {
      console.log("    ✗ " + side + " gagal: " + String((e as Error).message).slice(0, 90));
      return false;
    }
  };
  let executed = 0;
  const cukupTunai = cashUsd >= usd;
  if (exitsOnly) { console.log("  MODE exits-only: rencana BELI 0 (semua pembukaan dilewati) · JUAL " + todoSell.length + " token"); }
  if (!cukupTunai) console.log("  (tunai kurang: hanya jalur KELUAR yang dijalankan)") ;
  for (const r of (exitsOnly || !cukupTunai ? [] : todoBuy)) {
    if (executed >= max) break;
    const token = String(r.token);
    // GERBANG "BISA KELUAR" (2026-10-19): buktikan sisi JUAL dulu — pelajaran dari gilet, yang bisa
    // dibeli tetapi tidak bisa dijual (OKX: "input value too low"; router: "Invalid token"; pool: swap 0/0).
    // Tanpa bukti keluar, entry tidak dijalankan (log rh-unexitable-block) agar posisi tidak terkunci.
    let sellable = false;
    try {
      const q = await okx(`/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${token}&toTokenAddress=${WETH}&amount=1000000000000000000&swapMode=exactIn`, env);
      const d = ((q.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      const imp = Number(d.priceImpactPercentage ?? NaN);
      // GERBANG DIPERKETAT (2026-10-19): nilai jual > 0 DAN dampak harga wajar (<5%).
      sellable = q.code === "0" && Number(d.toTokenAmount ?? 0) > 0 && (!Number.isFinite(imp) || imp < 5);
      // GERBANG DUA-ARAH (2026-10-21): buktikan juga sisi BELI lewat endpoint SWAP yang akan dipakai.
      // Bukti: Kimchi lolos quote JUAL tetapi swap BELI ditolak "Insufficient liquidity" → harus disaring di sini.
      if (sellable) {
        const sb = await okx(`/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&fromTokenAddress=${WETH}&toTokenAddress=${token}&amount=1000000000000000&swapMode=exactIn&slippagePercent=5&userWalletAddress=${BOTW}`, env);
        const sbd = ((sb.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
        const stx = (sbd.tx ?? {}) as Record<string, unknown>;
        sellable = sb.code === "0" && Boolean(stx.to) && Boolean(stx.data);
      }
    } catch { sellable = false; }
    if (!sellable) {
      console.log("    ⟳ " + String(r.symbol ?? token) + ": TIDAK terbukti bisa dijual → entry DIBATALKAN");
      appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "UNEXITABLE_BLOCK", strategy, token, symbol: r.symbol, note: "quote jual gagal/0 → tidak boleh entry" }) + "\n");
      continue;
    }
    console.log("    ▶ beli " + String(r.symbol ?? token) + " $" + usd + " via pool-swap …");
    // SKEMA BARU (2026-10-21): pisahkan NIAT vs KENYATAAN.
    //  LIVE_ATTEMPT = percobaan (gagal/sukses) — TIDAK pernah dihitung posisi.
    //  LIVE_FILL    = hanya bila saldo token TERVERIFIKASI bertambah (transaksi nyata).
    const rawBal = async (tok: string): Promise<bigint> => {
      try {
        const r = (await rpc("eth_call", [{ to: tok, data: "0x70a08231000000000000000000000000" + BOTW.slice(2).toLowerCase() }, "latest"])).result as string;
        return BigInt(r ?? "0x0");
      } catch { return 0n; }
    };
    const before = await rawBal(token);
    const okRun = (await fillBuy(token, "1000000000000000", BOTW)).ok;
    const after = await rawBal(token);
    const filled = okRun && after > before;
    appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: filled ? "LIVE_FILL" : "LIVE_ATTEMPT", strategy, token, symbol: r.symbol, notionalUsd: usd, route: "okx", ok: filled, amountOutRaw: (after - before).toString() }) + "\n");
    if (filled) executed++;
  }
  for (const r of todoSell) {
    const token = String(r.token);
    const held = live.find((x) => (x.action === "LIVE_FILL" || x.action === "LIVE_BUY") && x.ok && String(x.token).toLowerCase() === token.toLowerCase());
    const amount = Number(held?.notionalUsd ?? usd) / 2361; // jual seluruh posisi (nilai ETH saat beli)
    console.log("    ▶ jual " + String(r.symbol ?? token) + " (seluruh posisi) via pool-swap …");
    // JUAL via OKX: baca saldo token mentah → kirim sebagai jumlah (18 desimal) ke live-swap.
    let jualAmt = 0;
    try {
      const hex = "0x70a08231000000000000000000000000" + token.slice(2).toLowerCase();
      const rb = (await rpc("eth_call", [{ to: token, data: hex }, "latest"])).result as string;
      jualAmt = Number(BigInt(rb ?? "0x0")) / 1e18;
    } catch { jualAmt = 0; }
    const ok = jualAmt > 0 ? runSwap("sell", token, jualAmt) : false;
    appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "LIVE_SELL", strategy, token, symbol: r.symbol, route: "pool-swap", ok }) + "\n");
  }
}

void main();
