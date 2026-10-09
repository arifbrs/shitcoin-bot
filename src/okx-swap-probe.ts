import { okxCredentialWarnings, okxEnabled } from "./discovery/okx.js";
import { OKX_NATIVE_SOL, okxSwapTx } from "./execution/okx.js";

/**
 * Safe live execution-path probe: asks OKX to build SOL→USDC bytes, validates the serialized
 * transaction and exits. It deliberately imports no wallet key and never signs or broadcasts.
 */
if (!okxEnabled) {
  console.error("OKX disabled. Set OKX_SHADOW_ENABLED=true plus API credentials first.");
  process.exit(1);
}
for (const warning of okxCredentialWarnings()) console.warn(`warning: ${warning}`);

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const wallet = process.env.OKX_PROBE_WALLET?.trim() || "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const amount = process.env.OKX_SWAP_PROBE_LAMPORTS?.trim() || "1000000"; // 0.001 SOL, build only
const built = await okxSwapTx(OKX_NATIVE_SOL, USDC, amount, wallet);
if (!built) {
  console.error("okx-swap-probe: build/validation failed (nothing was signed or sent)");
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  signed: false,
  broadcast: false,
  buildMs: built.buildMs,
  format: built.format,
  bytes: built.bytes.length,
  feePayer: built.feePayer,
  fromAmountRaw: built.quote?.fromTokenAmount ?? null,
  toAmountRaw: built.quote?.toTokenAmount ?? null,
  priceImpactPercent: built.quote?.priceImpactPercent ?? null,
}, null, 2));
