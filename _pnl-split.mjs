import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
const env = Object.fromEntries(readFileSync(".env","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,"")]}));
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const get = async (path) => { const ts=new Date().toISOString(); const sign=createHmac("sha256",env.OKX_SECRET_KEY).update(ts+"GET"+path).digest("base64"); const h={"OK-ACCESS-KEY":env.OKX_API_KEY,"OK-ACCESS-SIGN":sign,"OK-ACCESS-TIMESTAMP":ts,"OK-ACCESS-PASSPHRASE":env.OKX_API_PASSPHRASE,"OK-ACCESS-PROJECT":env.OKX_PROJECT_ID,"content-type":"application/json"}; const r=await fetch("https://web3.okx.com"+path,{headers:h}); return JSON.parse(await r.text()); };
const files = readdirSync("logs").filter(f=>/^rh-paper-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-1);
const closes = [];
for (const f of files) for (const l of readFileSync("logs/"+f,"utf8").split("\n")) {
  if (!l.includes("v42-liq25-50")) continue;
  if (!l.includes("RH_CLOSE")) continue;
  try { const j=JSON.parse(l); if (j.token) closes.push({ token:String(j.token).toLowerCase(), sym:j.symbol, pnl:Number(j.pnlUsd ?? j.pnl ?? 0) }); } catch {}
}
const total = closes.reduce((a,c)=>a+c.pnl,0);
console.log("  penutupan v42 hari ini: "+closes.length+" · total PnL paper: "+total.toFixed(2));
const pass=[], fail=[];
for (const c of closes) {
  const q = await get(`/api/v6/dex/aggregator/quote?chainIndex=4663&fromTokenAddress=${c.token}&toTokenAddress=${WETH}&amount=1000000000000000000&swapMode=exactIn`);
  (q.code==="0" && Number(q.data?.[0]?.toTokenAmount ?? 0)>0 ? pass : fail).push(c);
  await new Promise(r=>setTimeout(r,700));
}
const sum=a=>a.reduce((x,c)=>x+c.pnl,0);
console.log("  BISA dijual (lolos gerbang): "+pass.length+" trade · PnL "+sum(pass).toFixed(2));
console.log("  TIDAK bisa dijual        : "+fail.length+" trade · PnL "+sum(fail).toFixed(2));
console.log("  → porsi laba paper yang bisa direalisasikan live: "+(total!==0?(sum(pass)/total*100).toFixed(0):"?")+"%");
