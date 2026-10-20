import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { encodeFunctionData, parseAbi } from "viem";
const RPC="https://rpc.mainnet.chain.robinhood.com", CHAIN=4663;
const GILET="0x7d96ddcf176de54e4b279c78fb9459e758b8ae7d", WETH="0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const OKX_APPROVE="0x42170295f1173c9e5874ea9d00c6d137e1a4f53d";
const env=Object.fromEntries(readFileSync(".env","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,"")]}));
const { privateKeyToAccount }=await import("viem/accounts");
const { createWalletClient, createPublicClient, http }=await import("viem");
const bot=privateKeyToAccount(("0x"+readFileSync("logs/rh-wallet.key","utf8").trim().replace(/^0x/,"")));
const wallet=createWalletClient({account:bot,transport:http(RPC)}), pub=createPublicClient({transport:http(RPC)});
const bal=await pub.readContract({address:GILET,abi:parseAbi(["function balanceOf(address) view returns (uint256)"]),functionName:"balanceOf",args:[bot.address]});
console.log("  gilet di wallet: "+(Number(bal)/1e18).toFixed(6));
if(bal===0n){console.log("  tidak ada gilet");process.exit(0)}
// 1) APPROVE
const ap=encodeFunctionData({abi:parseAbi(["function approve(address,uint256) returns (bool)"]),functionName:"approve",args:[OKX_APPROVE,bal]});
const pre1=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{from:bot.address,to:GILET,data:ap,gas:"0x2dc6c0"},"latest"]})});
if((await pre1.json()).error){console.log("  ✗ approve simulasi gagal");process.exit(0)}
const h1=await wallet.sendTransaction({to:GILET,data:ap,gas:120000n}); const r1=await pub.waitForTransactionReceipt({hash:h1});
console.log("  approve → OKX: "+(r1.status==="success"?"✓":"✗")+" "+String(h1).slice(0,20)+"…");
if(r1.status!=="success")process.exit(0);
// 2) OKX swap: gilet → WETH
const get=async(path)=>{const ts=new Date().toISOString();const sign=createHmac("sha256",env.OKX_SECRET_KEY).update(ts+"GET"+path).digest("base64");const h={"OK-ACCESS-KEY":env.OKX_API_KEY,"OK-ACCESS-SIGN":sign,"OK-ACCESS-TIMESTAMP":ts,"OK-ACCESS-PASSPHRASE":env.OKX_API_PASSPHRASE,"OK-ACCESS-PROJECT":env.OKX_PROJECT_ID,"content-type":"application/json"};const r=await fetch("https://web3.okx.com"+path,{headers:h});return JSON.parse(await r.text())};
const j=await get(`/api/v6/dex/aggregator/swap?chainIndex=${CHAIN}&fromTokenAddress=${GILET}&toTokenAddress=${WETH}&amount=${bal}&swapMode=exactIn&slippagePercent=5&userWalletAddress=${bot.address}`);
if(j.code!=="0"){console.log("  ✗ OKX swap: code="+j.code+" "+String(j.msg).slice(0,100));process.exit(0)}
const tx=(j.data?.[0]?.tx)??{};
if(!tx.to||!tx.data){console.log("  ✗ OKX tidak mengembalikan tx");process.exit(0)}
console.log("  OKX tx: to="+String(tx.to).slice(0,12)+"… · value="+String(tx.value||"0")+" · gas="+String(tx.gas||"?"));
const pre2=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{from:bot.address,to:tx.to,value:"0x"+BigInt(tx.value||"0").toString(16),data:tx.data,gas:"0xb71b0"},"latest"]})});
const p2=await pre2.json();
if(p2.error){console.log("  ✗ simulasi swap GAGAL → tidak dikirim: "+String(p2.error.message).slice(0,90));process.exit(0)}
const h2=await wallet.sendTransaction({to:tx.to,data:tx.data,value:BigInt(tx.value||"0"),gas:tx.gas?BigInt(tx.gas)*3n/2n:750000n});
const r2=await pub.waitForTransactionReceipt({hash:h2});
console.log("  swap: "+(r2.status==="success"?"✓":"✗")+" "+String(h2).slice(0,20)+"…");
const g2=await pub.readContract({address:GILET,abi:parseAbi(["function balanceOf(address) view returns (uint256)"]),functionName:"balanceOf",args:[bot.address]});
const w2=await pub.readContract({address:WETH,abi:parseAbi(["function balanceOf(address) view returns (uint256)"]),functionName:"balanceOf",args:[bot.address]});
console.log("  SESUDAH → gilet "+(Number(g2)/1e18).toFixed(6)+" · WETH "+(Number(w2)/1e18).toFixed(8));
console.log("  → "+(g2<bal/2n?"GILET TERJUAL ✓ PUTARAN LIVE PERTAMA TUNTAS":"masih ada gilet"));
