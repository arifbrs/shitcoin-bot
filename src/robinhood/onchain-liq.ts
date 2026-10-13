/**
 * PEMANTAU LIKUIDITAS ON-CHAIN — RH CHAIN (celah #1, langkah 1.3, 2026-10-12).
 *
 * Dasar yang TERUKUR (probe 0528c32, blok 86.941.185): pool RH adalah Uniswap-V3-style —
 * `getReserves()` revert, tetapi `liquidity()` (0x1a686502), `slot0()` (0x3850c7bd), dan `fee()`
 * (0xddca3f43) semua menjawab; log pool berbentuk 3 topik + 160 byte (struktur Swap V3).
 *
 * Yang dibaca dari rantai, dan kenapa itu penting:
 *  • `liquidity()`  → LP ditarik terlihat PER BLOK (bukan disimpulkan dari selisih mark).
 *  • `slot0()`      → sqrtPriceX96: HARGA ON-CHAIN, independen dari mark GT/Dex. Kalau mark basi,
 *                     rantai tetap tahu harganya — inilah penutup "keluar buta" (`mark_basi`).
 *
 * ATURANNYA DIPISAH MURNI supaya bisa diuji tanpa jaringan. Yang menembak RPC hanya readPool().
 */

export interface OnchainBaseline {
  /** Likuiditas saat pertama terlihat (string agar aman disimpan di JSON). */
  liq: string;
  /** sqrtPriceX96 saat pertama terlihat (string, alasan sama). */
  sqrtPriceX96: string;
  at: number;
}

export interface OnchainSnapshot {
  pool: string;
  liq: bigint;
  sqrtPriceX96: bigint;
  block: number;
  at: number;
}

/** Berapa fraksi likuiditas yang HILANG (0,35 = tinggal 65%). Positif = turun. */
export function liquidityDropPct(before: bigint, after: bigint): number {
  if (before <= 0n) return 0;
  const drop = Number(before - after) / Number(before);
  return Number.isFinite(drop) ? drop : 0;
}

/** Rasio harga on-chain dari dua sqrtPriceX96 — memakai RASIO supaya urutan token & desimal tak perlu ditebak. */
export function priceRatio(sqrtBefore: bigint, sqrtAfter: bigint): number {
  if (sqrtBefore <= 0n) return 1;
  const r = Number(sqrtAfter) / Number(sqrtBefore);
  return Number.isFinite(r) ? r * r : 1;
}

/**
 * Haruskah keluar karena rantai? Dua sebab, keduanya dari angka:
 *  1) likuiditas hilang ≥ dropPct  → LP ditarik (penyebab kerugian terbesar kita),
 *  2) harga on-chain jatuh ≥ dropPct terhadap acuan → konfirmasi independen, bukan mark.
 * Sengaja memakai `≥` (bukan >) supaya ambang tepat juga menyala, dan mengembalikan ALASANNYA.
 */
export function onchainExitReason(
  snap: OnchainSnapshot,
  base: OnchainBaseline,
  dropPct: number,
): "onchain_lp_pull" | "onchain_price_drop" | null {
  const drop = liquidityDropPct(BigInt(base.liq), snap.liq);
  if (drop >= dropPct) return "onchain_lp_pull";
  const pr = priceRatio(BigInt(base.sqrtPriceX96), snap.sqrtPriceX96);
  if (1 - pr >= dropPct) return "onchain_price_drop";
  return null;
}

export type OnchainRead =
  | { ok: true; snap: OnchainSnapshot }
  | { ok: false; reason: string };

/**
 * Baca likuiditas + harga dari rantai. Kegagalan DIKEMBALIKAN SEBAGAI ALASAN, bukan null senyap:
 * kelas bug yang baru saja terjadi — jalur ini gagal berjam-jam tanpa satu pun jejak di log, sehingga
 * "0 keluar on-chain" tampak seperti "tidak ada peluang" padahal bisa berarti "tidak pernah membaca".
 */
export async function readPool(
  rpcUrl: string,
  pool: string,
  blockHint: number | null,
): Promise<OnchainRead> {
  const call = async (data: string): Promise<{ hex: string } | { err: string }> => {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: pool, data }, "latest"] }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { err: `HTTP ${res.status}` };
      const j = (await res.json()) as { result?: string; error?: { message?: string } };
      if (j.error) return { err: String(j.error.message ?? "rpc error").slice(0, 90) };
      if (typeof j.result !== "string" || j.result.length < 66) return { err: `balasan tak terduga (${typeof j.result}, len ${String(j.result).length})` };
      return { hex: j.result };
    } catch (e) {
      return { err: `fetch: ${String((e as Error).message ?? e).slice(0, 70)}` };
    }
  };
  const liqRes = await call("0x1a686502");
  if ("err" in liqRes) return { ok: false, reason: `liquidity(): ${liqRes.err}` };
  const slotRes = await call("0x3850c7bd");
  if ("err" in slotRes) return { ok: false, reason: `slot0(): ${slotRes.err}` };
  try {
    return {
      ok: true,
      snap: {
        pool,
        liq: BigInt(liqRes.hex),
        sqrtPriceX96: BigInt("0x" + slotRes.hex.slice(2, 66)),
        block: blockHint ?? 0,
        at: Date.now(),
      },
    };
  } catch (e) {
    return { ok: false, reason: `parse: ${String((e as Error).message ?? e).slice(0, 60)}` };
  }
}
