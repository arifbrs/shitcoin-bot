import {
  okxCall, okxCredentialWarnings, okxEnabled, type OkxCallResult, type OkxEndpointId,
  type OkxSwapData,
} from "./discovery/okx.js";
import { OKX_NATIVE_SOL } from "./execution/okx.js";

/**
 * Targeted, non-mutating probe for transaction-toolbox endpoints excluded from the broad sweep.
 * It builds and simulates unsigned data, and reads fake/public order identifiers. It never calls
 * create-order, cancel-order, cancel-signdata, broadcast-transaction, or local wallet signing.
 */
if (!okxEnabled) {
  console.error("OKX disabled. Set OKX_SHADOW_ENABLED=true plus API credentials first.");
  process.exit(1);
}
for (const warning of okxCredentialWarnings()) console.warn(`warning: ${warning}`);

const SOLANA = "501";
const ETHEREUM = "1";
const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_ETH = "0xA0b86991c6218b36c1d19d4a2e9eb0cE3606eB48";
const EVM_ADDRESS = "0x0000000000000000000000000000000000000001";
const ZERO_HASH = `0x${"0".repeat(64)}`;
const wallet = process.env.OKX_PROBE_WALLET?.trim() || "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

const results: Array<{ id: OkxEndpointId; result: OkxCallResult<unknown> }> = [];
const call = async (id: OkxEndpointId, query: Record<string, string | number | boolean | undefined> = {}, body?: unknown) => {
  const result = await okxCall<unknown>(id, query, body);
  results.push({ id, result });
  return result;
};

await call("dex.approve", { chainIndex: ETHEREUM, tokenContractAddress: USDC_ETH, approveAmount: "1000" });
await call("dex.history", { chainIndex: ETHEREUM, txHash: ZERO_HASH });
await call("intent.auctionInfo", { auctionId: "1" });
await call("intent.orderList", { userWalletAddress: EVM_ADDRESS, limit: 1 });
await call("post.txByHash", { chainIndex: ETHEREUM, txHash: ZERO_HASH });
await call("post.txByAddress", { chains: ETHEREUM, address: EVM_ADDRESS, limit: 1 });
await call("pre.checkApprovals", {}, {
  address: EVM_ADDRESS,
  chainIndex: ETHEREUM,
  tokens: [{ tokenContractAddress: USDC_ETH }],
});
await call("pre.nonce", { address: EVM_ADDRESS, chainIndex: ETHEREUM });
await call("post.orders", { address: EVM_ADDRESS, chainIndex: ETHEREUM, limit: 1 });

const swapQuery = {
  chainIndex: SOLANA,
  amount: "1000000",
  fromTokenAddress: OKX_NATIVE_SOL,
  toTokenAddress: USDC_SOL,
  userWalletAddress: wallet,
  swapMode: "exactIn",
  slippagePercent: "3",
};
const swap = await okxCall<OkxSwapData[]>("dex.swap", swapQuery);
results.push({ id: "dex.swap", result: swap as OkxCallResult<unknown> });
const tx = swap.data?.[0]?.tx;

await call("dex.swapInstruction", swapQuery);
await call("pre.gasLimit", {}, {
  chainIndex: SOLANA,
  fromAddress: wallet,
  toAddress: tx?.to ?? "",
  txAmount: tx?.value ?? "0",
  extJson: { inputData: tx?.data ?? "" },
});
await call("pre.simulate", {}, {
  chainIndex: SOLANA,
  fromAddress: wallet,
  toAddress: tx?.to ?? "",
  txAmount: tx?.value ?? "0",
  extJson: { inputData: tx?.data ?? "" },
  includeDebug: false,
});

const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
console.log("\n" + pad("ENDPOINT", 25) + pad("RESULT", 9) + "DETAIL");
console.log("-".repeat(80));
for (const { id, result } of results) {
  console.log(pad(id, 25) + pad(result.ok ? "OK" : "FAIL", 9) + (result.ok
    ? `${result.elapsedMs}ms`
    : `HTTP ${result.httpStatus ?? "-"} code ${result.code ?? "-"} ${result.msg ?? ""}`));
}
const passed = results.filter((r) => r.result.ok).length;
console.log("-".repeat(80));
console.log(`${passed}/${results.length} safe toolbox endpoints answered; signed=false, broadcast=false`);
console.log("Skipped by design: intent.createOrder, intent.cancelSignData, intent.cancelOrder, intent.orderStatus (needs a real UID), dex.broadcast.");
process.exit(passed === results.length ? 0 : 1);
