import { fillBuy, fillSell } from "../rhpaper/exec.js";
import { isEvmAddress, loadLegacyHeldTokens, loadLiveRows, planActions, readTokenBalance,
  reconstructPositions, reconcilePositions, wethForUsd, positionIdFor, type BalanceResult } from "./live-positions.js";
/**
 * JEMBATAN SINYAL → EKSEKUSI (2b) — `npm run rh:live -- [--strategy v42-liq25-50] [--usd 25] [--yes]`.
 *
 * Prinsip: LANE TIDAK DISENTUH. Sinyalnya dibaca dari engine paper 1:1 (logs/rhpaper) — jadi
 * apa yang live kerjakan adalah persis sinyal yang sudah diukur, bukan logika baru.
 *  - MASUK: posisi engine paper → beli token itu dengan notional $ (default $25) via OKX (jalur quote+build).
 *  - KELUAR: posisi live yang paper tidak lagi pegang (lintas-hari) atau melewati batas umur → jual 100%.
 *  - REKONSILIASI (2026-10-24): posisi dibangun ulang dari SEMUA ledger live lintas-hari +
 *    dicocokkan dengan saldo dompet on-chain (OPEN/GHOST/UNKNOWN/untracked). Status tx ≠ fill;
 *    fill = saldo TERVERIFIKASI berubah. GHOST/UNKNOWN/untracked dilaporkan, tidak pernah dijual.
 *
 *  - PENGAMAN: default DRY-RUN (tanpa --yes tidak ada tanda tangan/broadcast); simulasi pra-kirim;
 *    maksimum posisi live per token = 1 (dedupe lintas-hari); slippage dinamis dari dampak quote;
 *    berhenti bila tunai < notional; gerbang "bisa keluar" sebelum entry.
 *    MODE (A3): default `--mode exit-only` — rencana beli STRUKTURAL tidak dibangun. `--mode full`
 *    + LIVE_TRADING_CONFIRMED=yes di .env keduanya wajib untuk pembelian otomatis (jualan tetap jalan).
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { config } from "../config.js";
import { duplicateSecurityKeys } from "../util/env-audit.js";
import { verifySwapFill } from "./tx-truth.js";

const CHAIN = 4663;
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const KEY_PATH = join(config.logDir, "rh-wallet.key");
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const ENGINE_STATE = "logs/rhpaper/state.json";

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
  const exitsOnly = argv.includes("--exits-only") ; // kompatibilitas lama
  // MODE (A3, audit round-3): default EXIT-ONLY — fail-closed. "full" (boleh beli) harus
  // diminta EKSPLISIT lewat --mode full DAN tetap tunduk gerbang LIVE_TRADING_CONFIRMED.
  // Nilai asing = ditolak (bukan didiamkan menjadi full).
  const modeRaw = arg("mode", "exit-only");
  if (!["exit-only", "full"].includes(modeRaw)) { console.log(`  TOLAK: --mode ${modeRaw} tidak dikenal (exit-only|full).`); return; }
  const mode = modeRaw as "exit-only" | "full";
  const strategy = arg("strategy", "v42-liq25-50");
  const usd = Number(arg("usd", "25"));
  const max = Number(arg("max", "1"));
  const env = envOf();
  const day = new Date().toISOString().slice(0, 10);
  const liveLog = join(config.logDir, "rh-live-" + day + ".jsonl");
  const BOTW = process.env.BOT_WALLET ?? "0x629Ec42444A43A0E02A572587E3A49904542F4E8";

  // ── REKONSILIASI LINTAS-HARI (2026-10-24): posisi dari SEMUA ledger live, bukan hari ini saja ──
  const { rows, malformed } = loadLiveRows(config.logDir);
  if (malformed) console.log(`  [rekonsiliasi] ${malformed} baris ledger rusak DILEWATI dan DIHITUNG (tidak membungkam, tidak menulis ulang).`);
  const positions = reconstructPositions(rows);
  const ethNow = Number(BigInt((await rpc("eth_getBalance", [BOTW, "latest"])).result as string)) / 1e18;
  const wethBal = await readTokenBalance(rpc, WETH, BOTW);
  const wethNow = wethBal.ok ? Number(wethBal.raw) / 1e18 : NaN;
  let usdgNow = 0;
  try {
    const ub = await readTokenBalance(rpc, USDG, BOTW);
    if (ub.ok) usdgNow = Number(ub.raw) / 1e6;
  } catch { usdgNow = 0; }
  let ethUsd = 2361; // fallback (hanya jika quote gagal — dicetak sebagai perkiraan)
  try {
    const qp = await okx(`/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${WETH}&toTokenAddress=${USDG}&amount=1000000000000000000&swapMode=exactIn`, env);
    const dp = ((qp.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
    const out = Number(dp.toTokenAmount ?? 0) / 1e6;
    if (qp.code === "0" && out > 0) ethUsd = out;
  } catch { /* fallback */ }
  const cashUsd = (ethNow + (Number.isFinite(wethNow) ? wethNow : 0)) * ethUsd + usdgNow;

  // Paper engine 1:1 = sumber sinyal (semua arm diikuti; label strategy hanya nama jembatan).
  // Bila state engine tidak ada, paper lama (arsip) jadi fallback aturan yatim.
  const engineState = existsSync(ENGINE_STATE)
    ? (JSON.parse(readFileSync(ENGINE_STATE, "utf8")) as { positions?: Array<{ token?: string; symbol?: string; arm?: string }> })
    : null;
  const paperHeldTokens = engineState
    ? new Set((engineState.positions ?? []).map((p) => String(p.token ?? "").toLowerCase()).filter(isEvmAddress))
    : loadLegacyHeldTokens(config.logDir, strategy);
  const paperOpens = (engineState?.positions ?? [])
    .filter((p) => isEvmAddress(p.token))
    .map((p) => ({ token: String(p.token).toLowerCase(), symbol: String(p.symbol ?? "?") }));

  // Saldo on-chain untuk setiap token yang relevan: posisi terlacak + sinyal paper + token yang pernah muncul.
  const tokensToCheck = new Set<string>([...positions.keys(), ...paperHeldTokens]);
  for (const r of rows) { const t = String(r.raw.token ?? "").toLowerCase(); if (isEvmAddress(t)) tokensToCheck.add(t); }
  const balances = new Map<string, BalanceResult>();
  for (const t of tokensToCheck) balances.set(t, await readTokenBalance(rpc, t, BOTW));
  const { reconciled, untracked } = reconcilePositions(positions, balances);
  const plan = planActions({ rows, reconciled, untracked, paperHeldTokens, paperOpens, now: Date.now(),
    maxPositionAgeMs: Number(process.env.LIVE_MAX_POSITION_HOURS ?? 24) * 3_600_000,
    exitOnly: mode === "exit-only" });

  const statusCount = (s: string): number => reconciled.filter((p) => p.status === s).length;
  console.log("  ══ JEMBATAN SINYAL→EKSEKUSI — arm " + strategy + " · notional $" + usd + (yes ? " · MODE: EKSEKUSI" : " · MODE: DRY-RUN") + " ══");
  console.log("  saldo tunai: " + ethNow.toFixed(6) + " ETH + " + (Number.isFinite(wethNow) ? wethNow.toFixed(6) : "?") + " WETH + " + usdgNow.toFixed(4) + " USDG ≈ $" + cashUsd.toFixed(2) + " (ETH @ $" + ethUsd.toFixed(0) + ")");
  console.log(`  rekonsiliasi (lintas ${new Set(rows.map((r) => r.day)).size} hari ledger, ${rows.length} baris): OPEN ${statusCount("OPEN")} · GHOST ${statusCount("GHOST")} · UNKNOWN ${statusCount("UNKNOWN")} · CLOSED ${statusCount("CLOSED_CONFIRMED")} · untracked ${untracked.length}`);
  for (const rp of plan.reports) console.log(`    (${rp.kind.toLowerCase()}) ${rp.token.slice(0, 12)}… ${rp.note}`);
  if (yes && (reconciled.some((p) => p.status === "OPEN") || untracked.length || malformed)) {
    appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "RECONCILE", strategy,
      open: statusCount("OPEN"), ghost: statusCount("GHOST"), unknown: statusCount("UNKNOWN"),
      closed: statusCount("CLOSED_CONFIRMED"), untracked: untracked.length, malformedRows: malformed, ethUsd }) + "\n");
  }

  // FIX 2026-10-18: pemeriksaan tunai hanya untuk MEMBUKA posisi. Menjual tidak butuh tunai —
  // dan mode exits-only (supervisor) harus tetap bisa keluar walau saldo tunai kecil.
  if (!exitsOnly && cashUsd < usd) { console.log("  TOLAK: tunai (ETH+WETH) < notional $" + usd + " — tidak ada posisi baru dibuka (penjualan tetap jalan)."); }

  // GERBANG IZIN (2026-10-24): pembelian otomatis hanya bila LIVE_TRADING_CONFIRMED=yes di .env —
  // kunci yang sama dengan sisi Solana (control.ts: PERMISSION out-of-band di mesin). Jualan
  // (pengurangan risiko) selalu diizinkan supaya posisi tidak terkunci oleh saklar ini.
  // (A2, round-3) Duplikat kunci keamanan .env = nilai efektif tanpa suara → mode full DITOLAK
  // sampai operator membereskan .env (aturan yang sama dengan control.ts sisi Solana).
  const secDups = duplicateSecurityKeys(readFileSync(".env", "utf8"));
  const liveConfirmed = env.LIVE_TRADING_CONFIRMED === "yes" && secDups.length === 0;
  if (secDups.length) console.log(`  GERBANG KONFIG: kunci .env keamanan terduplikasi (${secDups.join(", ")}) → pembelian otomatis DITOLAK sampai .env beres.`);
  if (mode === "exit-only") console.log("  MODE exit-only: rencana BELI 0 STRUKTURAL (tidak dibangun, apa pun izin/tunai/sinyal) · JUAL " + plan.sells.length + " token");
  if (!exitsOnly && mode === "full" && !liveConfirmed && plan.buys.length) {
    console.log("  GERBANG IZIN: LIVE_TRADING_CONFIRMED!=yes → " + plan.buys.length + " rencana BELI DITAHAN (jualan tetap jalan).");
    appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "LIVE_PERM_BLOCK", strategy, plannedBuys: plan.buys.length, note: "pembelian otomatis butuh LIVE_TRADING_CONFIRMED=yes di .env" }) + "\n");
  }

  // Buys hanya mungkin di mode full: rencananya sendiri kosong di exit-only (struktural), dan
  // loop ini tidak pernah mencapai fillBuy kecuali mode full + izin + tunai cukup.
  const bufs = mode === "full" && !exitsOnly && liveConfirmed && cashUsd >= usd
    ? plan.buys.slice(0, Math.max(max, 25))
    : [];
  if (mode === "full" && !exitsOnly) {
    console.log(`  rencana: BELI ${plan.buys.length} token (dieksekusi maks ${Math.min(max, bufs.length)}) · JUAL ${plan.sells.length} token`);
    for (const r of bufs.slice(0, 5)) console.log("    beli : " + r.symbol.padEnd(12) + " $" + usd + " (" + r.token.slice(0, 12) + "…)");
    for (const r of plan.sells.slice(0, 5)) console.log("    jual : " + r.symbol.padEnd(12) + " 100% (" + r.why + ")");
  }
  if (!bufs.length && !plan.sells.length) { console.log("  tidak ada aksi baru (sinyal hari ini sudah dijalankan atau belum ada)."); return; }
  if (!yes) { console.log("\n  DRY-RUN selesai — tidak ada tanda tangan/broadcast. Jalankan dengan --yes untuk eksekusi."); return; }

  // JUAL dulu (pengurangan risiko tidak menunggu izin apapun)…
  for (const s of plan.sells) {
    const qtyRaw = s.qtyRaw != null ? BigInt(s.qtyRaw) : 0n;
    if (qtyRaw <= 0n) { console.log("    ⚠ jual " + s.symbol + ": qty " + qtyRaw.toString() + " → dilewati (saldo hilang antara rencana dan eksekusi?)"); continue; }
    console.log("    ▶ jual " + s.symbol + " (seluruh posisi " + s.positionId + ") via exec.fillSell …");
    const sr = await fillSell(s.token, qtyRaw.toString(), BOTW);
    const after = await readTokenBalance(rpc, s.token, BOTW);
    // (R5) bukti fill per-tx juga di sisi jual: token masuk ke dompet pada tx ITU harus WETH.
    const sellProof = sr.hash ? await verifySwapFill(rpc, sr.hash, { owner: BOTW, tokenIn: s.token, tokenOut: WETH }) : null;
    const ok = sr.ok && (sellProof?.filled ?? false) && after.ok && after.raw < qtyRaw; // status + per-tx + delta saldo
    appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "LIVE_SELL", strategy, token: s.token, symbol: s.symbol,
      route: "okx", ok, positionId: s.positionId, qtyRaw: qtyRaw.toString(), why: s.why,
      fillProof: sellProof, ...(sr.hash ? { txHash: sr.hash } : {}), ...(sr.reason ? { reason: sr.reason.slice(0, 120) } : {}), ...(after.ok ? { remainingRaw: after.raw.toString() } : {}) }) + "\n");
  }

  // …baru BELI (izin + tunai + gerbang "bisa keluar" + dedupe sudah di plan).
  let executed = 0;
  for (const r of bufs) {
    if (executed >= max) break;
    // GERBANG "BISA KELUAR" (2026-10-19): buktikan sisi JUAL dulu — pelajaran dari gilet, yang bisa
    // dibeli tetapi tidak bisa dijual. Tanpa bukti keluar, entry tidak dijalankan.
    let sellable = false;
    try {
      const q = await okx(`/api/v6/dex/aggregator/quote?chainIndex=${CHAIN}&fromTokenAddress=${r.token}&toTokenAddress=${WETH}&amount=1000000000000000000&swapMode=exactIn`, env);
      const d = ((q.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      const imp = Number(d.priceImpactPercentage ?? NaN);
      sellable = q.code === "0" && Number(d.toTokenAmount ?? 0) > 0 && (!Number.isFinite(imp) || imp < 5);
      // GERBANG DUA-ARAH (2026-10-21): buktikan juga sisi BELI lewat endpoint SWAP yang akan dipakai.
      if (sellable) {
        const sb = await okx(`/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&fromTokenAddress=${WETH}&toTokenAddress=${r.token}&amount=1000000000000000&swapMode=exactIn&slippagePercent=5&userWalletAddress=${BOTW}`, env);
        const sbd = ((sb.data as Array<Record<string, unknown>>) ?? [])[0] ?? {};
        const stx = (sbd.tx ?? {}) as Record<string, unknown>;
        sellable = sb.code === "0" && Boolean(stx.to) && Boolean(stx.data);
      }
    } catch { sellable = false; }
    if (!sellable) {
      console.log("    ⟳ " + r.symbol + ": TIDAK terbukti bisa dijual → entry DIBATALKAN");
      appendFileSync(liveLog, JSON.stringify({ ts: Date.now(), action: "UNEXITABLE_BLOCK", strategy, token: r.token, symbol: r.symbol, note: "quote jual gagal/0 → tidak boleh entry" }) + "\n");
      continue;
    }
    // Nominal dari harga TERUKUR (2026-10-24) — bukan konstanta tebakan. Fallback harga diberi label.
    const wethRaw = wethForUsd(usd, ethUsd);
    console.log("    ▶ beli " + r.symbol + " $" + usd + " (" + (Number(wethRaw) / 1e18).toFixed(6) + " WETH" + (ethUsd === 2361 ? ", HARGA FALLBACK" : "") + ") via exec.fillBuy …");
    const before = await readTokenBalance(rpc, r.token, BOTW);
    const br = await fillBuy(r.token, wethRaw.toString(), BOTW);
    const after = await readTokenBalance(rpc, r.token, BOTW);
    // (R5) BUKTI FILL PER-TX: transfer token pada tx ITU harus menyerahkan tokenOutput ke dompet.
    // Delta saldo saja bisa tertipu aktivitas bersamaan — keduanya wajib.
    const fillProof = br.hash ? await verifySwapFill(rpc, br.hash, { owner: BOTW, tokenIn: WETH, tokenOut: r.token }) : null;
    const filled = br.ok && (fillProof?.filled ?? false) && before.ok && after.ok && after.raw > before.raw;
    const tsRow = Date.now();
    const amountOutRaw = fillProof?.amountOut != null ? fillProof.amountOut.toString() : (br.ok && before.ok && after.ok ? (after.raw - before.raw).toString() : "0");
    // NIAT vs KENYATAAN (2026-10-21): LIVE_ATTEMPT = percobaan, LIVE_FILL = saldo terverifikasi bertambah.
    appendFileSync(liveLog, JSON.stringify({ ts: tsRow, action: filled ? "LIVE_FILL" : "LIVE_ATTEMPT", strategy,
      token: r.token, symbol: r.symbol, notionalUsd: usd, amountInWethRaw: wethRaw.toString(), priceSource: ethUsd === 2361 ? "fallback" : "okx-quote",
      route: "okx", ok: filled, amountOutRaw, positionId: positionIdFor(r.token, br.hash ?? null, tsRow, filled ? amountOutRaw : null),
      fillProof, ...(br.hash ? { txHash: br.hash } : {}), ...(br.reason ? { reason: br.reason.slice(0, 120) } : {}) }) + "\n");
    if (filled) executed++;
  }
}

void main();
