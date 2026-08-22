/**
 * Merekonstruksi harga fill NYATA tiap kejadian KOL dari transaksinya sendiri.
 *
 * kol-copy mencatat tokenDelta tapi bukan harga, jadi imbal hasil round-trip tidak bisa dihitung.
 * Perubahan saldo SOL wallet di transaksi yang sama memberi sisi SOL-nya; dibagi tokenDelta =
 * harga yang BENAR-BENAR mereka dapat, termasuk slippage dan fee. Itu lebih jujur daripada
 * menandai dengan MC pasar, yang mengabaikan dampak harga pembelian mereka sendiri.
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const env = Object.fromEntries(readFileSync(".env","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>[l.slice(0,l.indexOf("=")).trim(), l.slice(l.indexOf("=")+1).trim()]));
const url = (env.RPC_URLS||"").split(",").map(s=>s.trim()).find(u=>u.includes("helius"));
const rows = [];
for (const f of readdirSync("logs").filter(f=>f.startsWith("kol-copy-")&&f.endsWith(".jsonl")))
  for (const l of readFileSync(join("logs",f),"utf8").split("\n")) { if(!l) continue; try{rows.push(JSON.parse(l));}catch{} }
const done = new Set();
try { for (const l of readFileSync("logs/kol-price.jsonl","utf8").split("\n")) { if(!l) continue; done.add(JSON.parse(l).sig); } } catch {}
const todo = rows.filter(r => r.sig && !done.has(r.sig));
console.log(`  ${rows.length} kejadian · ${todo.length} perlu harga`);
let ok=0, fail=0;
for (const r of todo) {
  try {
    const res = await fetch(url, { method:"POST", headers:{"content-type":"application/json"},
      body: JSON.stringify({jsonrpc:"2.0",id:1,method:"getTransaction",
        params:[r.sig,{maxSupportedTransactionVersion:0,encoding:"jsonParsed"}]}) });
    const tx = (await res.json())?.result;
    if (!tx) { fail++; continue; }
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const i = keys.findIndex(k => (typeof k === "string" ? k : k.pubkey) === r.wallet);
    if (i < 0) { fail++; continue; }
    const pre = tx.meta?.preBalances?.[i], post = tx.meta?.postBalances?.[i];
    if (pre == null || post == null) { fail++; continue; }
    const solDelta = (post - pre) / 1e9;             // negatif saat beli, positif saat jual
    const qty = Math.abs(r.tokenDelta ?? 0);
    if (!qty) { fail++; continue; }
    appendFileSync("logs/kol-price.jsonl", JSON.stringify({
      sig:r.sig, wallet:r.wallet, mint:r.mint, side:r.side, blockTime:tx.blockTime,
      solDelta:Number(solDelta.toFixed(6)), qty, priceSol: Math.abs(solDelta)/qty })+"\n");
    ok++;
  } catch { fail++; }
  await new Promise(s=>setTimeout(s, 350));
}
console.log(`  selesai: ${ok} berhasil · ${fail} gagal`);
