/**
 * PROBE ON-CHAIN POOL — RH CHAIN (2026-10-12, celah #1).
 *
 * Tujuan: MEMBUKTIKAN apa yang sebenarnya tersedia di rantai SEBELUM membangun pemantau LP.
 * Alasan disiplin ini: konstanta topik event (Sync/Swap/Burn) itu HAFALAN, dan hafalan di rantai
 * yang mungkin fork = halusinasi. Jadi probe ini tidak mengklasifikasi apa pun — ia hanya bertanya:
 *   1) blok terbaru berapa (eth_blockNumber),
 *   2) apakah pool kita menjawab getReserves() (selector 0x0902f1ac — Uniswap V2, tersedia di
 *      banyak fork) dan berapa cadangannya,
 *   3) topik event APA SAJA yang benar-benar muncul dari pool itu (empiris, tanpa tebakan),
 *   4) apakah RPC (langganan yang sudah ada) mengizinkan panggilan-panggilan ini.
 *
 * Nol impor ke lane hidup; ini CLI terpisah. Aman dijalankan kapan saja.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const RPC = process.env.ROBINHOOD_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
/** URL ditampilkan TERMASKER: hanya skema + host (tanpa kunci/query). */
const RPC_SAFE = ((): string => {
  try { const u = new URL(RPC); return `${u.protocol}//${u.host}`; } catch { return "(URL tak valid)"; }
})();

interface HeldPosition { token: string; symbol: string; pool: string }

function heldPools(): HeldPosition[] {
  try {
    const st = JSON.parse(readFileSync(join(config.logDir, "rh-paper-state.json"), "utf8")) as {
      variants?: Record<string, { positions?: HeldPosition[] }>;
    };
    const seen = new Map<string, HeldPosition>();
    for (const v of Object.values(st.variants ?? {})) {
      for (const p of v.positions ?? []) if (p.pool && !seen.has(p.pool)) seen.set(p.pool, p);
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result;
}

async function main(): Promise<void> {
  if (!RPC) { console.log("probe: ROBINHOOD_RPC_URL default tak ditemukan di config.ts — dilewati"); return; }
  const pools = heldPools();
  console.log(`probe on-chain: ${pools.length} pool dari posisi yang SEDANG dipegang`);
  if (!pools.length) { console.log("  (tak ada posisi terbuka — probe butuh minimal satu pool nyata)"); return; }

  let block: number;
  try {
    block = Number(await rpc("eth_blockNumber", []));
  } catch (e) {
    console.log(`  eth_blockNumber GAGAL: ${(e as Error).message.slice(0, 90)} → RPC menolak; celah #1 belum bisa dipakai apa adanya`);
    return;
  }
  console.log(`  blok terbaru: ${block} (RPC menerima panggilan dasar ✓)`);

  for (const p of pools.slice(0, 3)) {
    console.log(`\n  ── ${p.symbol} pool ${p.pool.slice(0, 12)}…`);
    // 1) getReserves() — Uniswap V2 style
    try {
      const out = (await rpc("eth_call", [{ to: p.pool, data: "0x0902f1ac" }, "latest"])) as string;
      if (typeof out === "string" && out.length >= 2 + 64 * 3) {
        const r0 = BigInt("0x" + out.slice(2, 66));
        const r1 = BigInt("0x" + out.slice(66, 130));
        const ts = Number(BigInt("0x" + out.slice(130, 194)));
        console.log(`     getReserves(): DITERIMA ✓ · reserve0=${r0} · reserve1=${r1} · ts=${new Date(ts * 1000).toISOString().slice(11, 19)}`);
      } else {
        console.log(`     getReserves(): jawaban tak terduga (len ${String(out).length}) — kemungkinan bukan V2 atau tak mendukung`);
      }
    } catch (e) {
      console.log(`     getReserves(): GAGAL — ${(e as Error).message.slice(0, 70)} (pool ini mungkin AMM tipe lain)`);
    }
    // 1b) JALUR V3 (dipakai kalau getReserves revert): slot0() + liquidity() + fee()
    //     Selector ini juga diuji empiris: kalau kontraknya bukan V3, ia akan revert juga — dan itu
    //     jawaban yang sah (berarti AMM-nya tipe lain, dan kita sesuaikan, bukan menebak).
    for (const [nama, sel] of [["slot0()", "0x3850c7bd"], ["liquidity()", "0x1a686502"], ["fee()", "0xddca3f43"]] as Array<[string, string]>) {
      try {
        const out = (await rpc("eth_call", [{ to: p.pool, data: sel }, "latest"])) as string;
        const bytes = typeof out === "string" ? (out.length - 2) / 2 : 0;
        console.log(`     ${nama}: DITERIMA ✓ (${bytes} byte balasan)` + (nama === "liquidity()" ? ` · nilai=${BigInt(out).toString()}` : ""));
      } catch (e) {
        console.log(`     ${nama}: revert/gagal — ${(e as Error).message.slice(0, 50)}`);
      }
    }

    // 2) log AKTUAL dari pool ini — empiris, tanpa klasifikasi
    try {
      const from = "0x" + Math.max(0, block - 300).toString(16);
      const logs = (await rpc("eth_getLogs", [{ address: p.pool, fromBlock: from, toBlock: "latest" }])) as Array<{ topics?: string[]; blockNumber?: string; data?: string }>;
      const topik = new Map<string, number>();
      for (const l of logs) {
        const t0 = l.topics?.[0] ?? "(tanpa topik)";
        topik.set(t0, (topik.get(t0) ?? 0) + 1);
      }
      console.log(`     eth_getLogs (300 blok terakhir): ${logs.length} log · topik unik: ${topik.size}`);
      for (const [t, n] of [...topik.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
        console.log(`        ${t.slice(0, 18)}… ×${n}`);
        const contoh = logs.find((l) => l.topics?.[0] === t);
        if (contoh) {
          const nTopik = contoh.topics?.length ?? 0;
          const nByte = typeof contoh.data === "string" ? (contoh.data.length - 2) / 2 : 0;
          console.log(`           bentuk: ${nTopik} topik + ${nByte} byte data (dibaca apa adanya, bukan dinamai dari hafalan)`);
        }
      }
      if (!logs.length) console.log(`        (kosong — pool sepi 300 blok, atau AMM ini tak memancarkan log)`);
    } catch (e) {
      console.log(`     eth_getLogs: GAGAL — ${(e as Error).message.slice(0, 80)}`);
    }
  }
  console.log("\n  BACA: kalau getReserves ✓ DAN topik muncul, pemantau LP berbasis cadangan (bukan hafalan topik) bisa dibangun di atas RPC yang sudah dibayar. Kalau keduanya gagal, celah #1 butuh jalur lain (WS/subscribe) dan itu harus diuji terpisah.");
}

void main();
