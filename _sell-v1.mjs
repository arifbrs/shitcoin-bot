import { readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi } from "viem";
const RPC="https://rpc.mainnet.chain.robinhood.com";
const HELPER_V1="0xb7c640835f6250e06990cc6d9b14d3ca8554a005";
const POOL="0xcc1a638e7714ecc2e8e477c1a6259d2ed37bddc4";
const GILET="0x7d96ddcf176de54e4b279c78fb9459e758b8ae7d", WETH="0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const { privateKeyToAccount }=await import("viem/accounts");
const { createWalletClient, createPublicClient, http }=await import("viem");
const bot=privateKeyToAccount(("0x"+readFileSync("logs/rh-wallet.key","utf8").trim().replace(/^0x/,"")));
const wallet=createWalletClient({account:bot,transport:http(RPC)}), pub=createPublicClient({transport:http(RPC)});
const erc=parseAbi(["function balanceOf(address) view returns (uint256)","function approve(address,uint256) returns (bool)"]);
const bal=await pub.readContract({address:GILET,abi:erc,functionName:"balanceOf",args:[bot.address]});
console.log("  gilet: "+(Number(bal)/1e18).toFixed(6));
if(bal===0n){console.log("  kosong");process.exit(0)}
// 1) approve ke helper v1 (yang dulu terbukti bekerja)
const ap=encodeFunctionData({abi:erc,functionName:"approve",args:[HELPER_V1,bal]});
const h1=await wallet.sendTransaction({to:GILET,data:ap,gas:120000n}); const r1=await pub.waitForTransactionReceipt({hash:h1});
console.log("  approve → helper v1: "+(r1.status==="success"?"✓":"✗")+" "+String(h1).slice(0,18)+"…");
// 2) TRICK v1: amount = komplemen-dua (uint256 besar → dibaca int256 negatif = exact input)
const amountTwos=(1n<<256n)-bal;
const ABI_V1=[{name:"swapExactIn",type:"function",stateMutability:"nonpayable",inputs:[{name:"pool",type:"address"},{name:"zeroForOne",type:"bool"},{name:"amountIn",type:"uint256"},{name:"sqrtPriceLimitX96",type:"uint160"},{name:"minOut",type:"uint256"}],outputs:[{type:"uint256"}]}];
const s0=await pub.readContract({address:POOL,abi:parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]),functionName:"slot0"});
const sqrtP=BigInt(s0[0]); const limit=(sqrtP*105n)/100n;
const data=encodeFunctionData({abi:ABI_V1,functionName:"swapExactIn",args:[POOL,false,amountTwos,limit,0n]});
console.log("  panggil helper v1: amount="+amountTwos.toString().slice(0,12)+"… (komplemen-dua) · limit>sqrtP="+(limit>sqrtP));
const pre=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{from:bot.address,to:HELPER_V1,data,gas:"0x9c400"},"latest"]})});
const pj=await pre.json();
if(pj.error){console.log("  ✗ simulasi gagal: "+String(pj.error.message).slice(0,90));process.exit(0)}
const h2=await wallet.sendTransaction({to:HELPER_V1,data,gas:600000n}); const r2=await pub.waitForTransactionReceipt({hash:h2});
console.log("  swap: "+(r2.status==="success"?"✓":"✗")+" "+String(h2).slice(0,18)+"…");
const g2=await pub.readContract({address:GILET,abi:erc,functionName:"balanceOf",args:[bot.address]});
const w2=await pub.readContract({address:WETH,abi:erc,functionName:"balanceOf",args:[bot.address]});
console.log("  SALDO → gilet "+(Number(g2)/1e18).toFixed(6)+" · WETH "+(Number(w2)/1e18).toFixed(8));
console.log("  "+(g2<bal/2n?"GILET TERJUAL ✓":"masih utuh"));
