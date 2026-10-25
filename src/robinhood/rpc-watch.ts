/**
 * ALARM RPC MATI — ROBINHOOD CHAIN (2026-10-13) — `npm run rh:rpc-watch`.
 *
 * Alasan: 2026-10-13 RPC RH pernah mati karena pemblokiran DNS ISP (pulih dengan WARP). Tanpa alarm,
 * kondisi itu hanya terlihat bila ada yang membuka dashboard. Ini pengawas berdiri sendiri:
 * ping berkala → setelah N gagal beruntun, kirim notifikasi (tools/notify.mjs; diam bila tanpa token).
 * Tidak menyentuh lane, tidak mengubah gate, tidak menandatangani apa pun.
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "../config.js";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const LIMIT = Number(process.env.RH_RPC_WATCH_FAILS ?? 3);
const INTERVAL_MS = Number(process.env.RH_RPC_WATCH_MS ?? 60_000);

async function ping(): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { result?: string; error?: unknown };
    const ms = Date.now() - t0;
    if (j.result === "0x1237") return { ok: true, ms, detail: `chainId ${j.result}` };
    return { ok: false, ms, detail: `jawaban tak terduga: ${JSON.stringify(j).slice(0, 80)}` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: String((e as Error).message).slice(0, 90) };
  }
}

function notify(text: string): void {
  try {
    execFileSync("node", ["tools/notify.mjs", text], { encoding: "utf8", timeout: 20_000 });
  } catch { /* notifier diam bila tanpa token — itu perilaku benar */ }
}

async function main(): Promise<void> {
  console.log(`  rh:rpc-watch → ping ${RPC} tiap ${INTERVAL_MS / 1000}s · alarm setelah ${LIMIT} gagal beruntun`);
  let fails = 0;
  let alerted = false;
  for (;;) {
    const r = await ping();
    if (r.ok) {
      if (fails > 0) console.log(`  ${new Date().toISOString()} pulih · ${r.detail} · ${r.ms}ms`);
      fails = 0;
      alerted = false;
    } else {
      fails += 1;
      console.log(`  ${new Date().toISOString()} GAGAL ${fails}/${LIMIT} · ${r.detail}`);
      if (fails >= LIMIT && !alerted) {
        alerted = true;
        notify(`ALARM: RPC Robinhood tidak menjawab ${fails}x berturut (${r.detail}). Cek WARP/DNS, lalu lane on-chain bisa buta.`);
      }
    }
    await sleep(INTERVAL_MS);
  }
}

void main();
