import { readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi } from "viem";
const RPC="https://rpc.mainnet.chain.robinhood.com";
const HELPER="0xb7c640835f6250e06990cc6d9b14d3ca8554a005";
const POOL="0xcc1a638e7714ecc2e8e477c1a6259d2ed37bddc4";
const GILET="0x7d96ddcf176de54e4b279c78fb9459e758b8ae7d", WETH="0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const MAX_LIMIT=1461446703485210103287273052203988822378723970341n; // MAX_SQRT_RATIO-1 (batas sah tertinggi)
const { privateKeyToAccount }=await import("viem/accounts");
const { createWalletClient, createPublicClient, http }=await import("viem");
const bot=privateKeyToAccount(("0x"+readFileSync("logs/rh-wallet.key","utf8").trim().replace(/^0x/,"")));
const wallet=createWalletClient({account:bot,transport:http(RPC)}), pub=createPublicClient({transport:http(RPC)});
const erc=parseAbi(["function balanceOf(address) view returns (uint256)","function approve(address,uint256) returns (bool)"]);
const bal=await pub.readContract({address:GILET,abi:erc,functionName:"balanceOf",args:[bot.address]});
// 1) approve TAK TERBATAS (2^256-1) — hilangkan kemungkinan kurangnya allowance
const ap=encodeFunctionData({abi:erc,functionName:"approve",args:[HELPER,(1n<<256n)-1n]});
const h0=await wallet.sendTransaction({to:GILET,data:ap,gas:120000n}); await pub.waitForTransactionReceipt({hash:h0});
console.log("  approve MAX → helper ✓");
// 2) swap dengan limit MAKSIMUM SAH (menjelajah seluruh kurva)
const ABI=[{name:"swapExactIn",type:"function",stateMutability:"nonpayable",inputs:[{name:"pool",type:"address"},{name:"zeroForOne",type:"bool"},{name:"amountIn",type:"uint256"},{name:"sqrtPriceLimitX96",type:"uint160"},{name:"minOut",type:"uint256"}],outputs:[{type:"uint256"}]}];
const amountTwos=(1n<<256n)-bal;
const data=encodeFunctionData({abi:ABI,functionName:"swapExactIn",args:[POOL,false,amountTwos,MAX_LIMIT,0n]});
const pre=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_call",params:[{from:bot.address,to:HELPER,data,gas:"0xb71b0"},"latest"]})});
const pj=await pre.json();
if(pj.error){console.log("  ✗ simulasi gagal: "+String(pj.error.message).slice(0,80)+" · data: "+String(pj.error.data||"").slice(0,40));process.exit(0)}
const h=await wallet.sendTransaction({to:HELPER,data,gas:1200000n}); const rc=await pub.waitForTransactionReceipt({hash:h});
const SW="0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const sw=rc.logs.find(l=>String(l.topics[0]).toLowerCase()===SW);
if(sw){const d=sw.data.slice(2);console.log("  SWAP amount0="+BigInt("0x"+d.slice(0,64))+" · amount1="+BigInt("0x"+d.slice(64,128)));}
const g2=await pub.readContract({address:GILET,abi:erc,functionName:"balanceOf",args:[bot.address]});
const w2=await pub.readContract({address:WETH,abi:erc,functionName:"balanceOf",args:[bot.address]});
console.log("  status "+(rc.status==="success"?"✓":"✗")+" · SALDO → gilet "+(Number(g2)/1e18).toFixed(6)+" · WETH "+(Number(w2)/1e18).toFixed(8));
console.log("  "+(g2<bal/2n?"GILET TERJUAL ✓":"masih utuh"));
