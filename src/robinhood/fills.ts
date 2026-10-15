/**
 * UKUR FILL NYATA — ROBINHOOD CHAIN (2026-10-13) — `npm run rh:fills [alamat] [jendelaBlok]`.
 *
 * Tujuan: mengukur transaksi NYATA (bukan model) dari rantai: token masuk vs token keluar per-tx,
 * blok, dan harga efektif (WETH keluar / token masuk). Tidak menebak decimal: 18 dipakai hanya untuk
 * token yang memang sudah terverifikasi (WETH, XZON); selain itu angka mentah ditampilkan apa adanya.
 * Read-only, tidak menyentuh lane, tidak menandatangani apa pun.
 */
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const KNOWN: Record<string, { sym: string; dec: number }> = {
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { sym: "WETH", dec: 18 },
  "0xe01d7eb1aceae4047ea70be02fc01c4f3fbd48e2": { sym: "XZON", dec: 18 },
};
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message?.slice(0, 90)}`);
  return j.result;
}
const fmt = (raw: bigint, addr: string): string => {
  const k = KNOWN[addr.toLowerCase()];
  return k ? `${(Number(raw) / 10 ** k.dec).toFixed(6)} ${k.sym}` : `${raw.toString()} (mentah, decimal belum diverifikasi) ${addr.slice(0, 10)}…`;
};

async function main(): Promise<void> {
  const addr = (process.argv[2] ?? "0x4b2600ce0Ab31D16E54FA493e7FFFc94bCdBDeC2").toLowerCase();
  const window = Number(process.argv[3] ?? 5000);
  const latest = Number(BigInt((await rpc("eth_blockNumber", [])) as string));
  const from = "0x" + Math.max(0, latest - window).toString(16);
  const pad = "0x000000000000000000000000" + addr.slice(2);
  const out = (await rpc("eth_getLogs", [{ fromBlock: from, toBlock: "latest", topics: [TRANSFER, pad] }])) as Array<{ address: string; data: string; transactionHash: string; blockNumber: string }>;
  const inn = (await rpc("eth_getLogs", [{ fromBlock: from, toBlock: "latest", topics: [TRANSFER, null, pad] }])) as Array<{ address: string; data: string; transactionHash: string; blockNumber: string }>;
  console.log(`══ FILL NYATA ${addr} · blok ${latest} (jendela ${window}) ══`);
  if (!out.length && !inn.length) {
    console.log("  belum ada transfer token sama sekali di jendela ini (artinya: belum ada swap, bukan 'gagal ukur')");
    return;
  }
  const byTx = new Map<string, { block: number; in: string[]; out: string[] }>();
  for (const l of inn) { const k = l.transactionHash; const e = byTx.get(k) ?? { block: parseInt(l.blockNumber, 16), in: [], out: [] }; e.in.push(`${fmt(BigInt(l.data), l.address)}`); byTx.set(k, e); }
  for (const l of out) { const k = l.transactionHash; const e = byTx.get(k) ?? { block: parseInt(l.blockNumber, 16), in: [], out: [] }; e.out.push(`${fmt(BigInt(l.data), l.address)}`); byTx.set(k, e); }
  for (const [tx, e] of [...byTx.entries()].sort((a, b) => a[1].block - b[1].block)) {
    console.log(`  blok ${e.block} · ${tx.slice(0, 18)}…`);
    console.log(`     keluar: ${e.out.join(" | ") || "-"}`);
    console.log(`     masuk : ${e.in.join(" | ") || "-"}`);
    const wethOut = out.find((l) => l.transactionHash === tx && l.address.toLowerCase() === WETH);
    const tokIn = inn.find((l) => l.transactionHash === tx && l.address.toLowerCase() !== WETH);
    if (wethOut && tokIn) {
      const w = Number(BigInt(wethOut.data)) / 1e18;
      const t = KNOWN[tokIn.address.toLowerCase()] ? Number(BigInt(tokIn.data)) / 1e18 : null;
      if (t && t > 0) console.log(`     harga efektif: ${(w / t).toFixed(8)} WETH per token (dibayar ${w.toFixed(6)} WETH untuk ${t.toFixed(6)} token)`);
    }
  }
}

void main();
