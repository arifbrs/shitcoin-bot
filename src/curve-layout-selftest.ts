import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { parseBondingCurveAccount, quoteMintIsSol, WRAPPED_SOL_MINT } from "./safety/onchain.js";

const discriminator = createHash("sha256").update("account:BondingCurve").digest().subarray(0, 8);

function fixture(bytes: number, opts: { mayhem?: boolean; cashback?: boolean; quote?: Buffer } = {}): string {
  const buf = Buffer.alloc(bytes);
  discriminator.copy(buf, 0);
  buf.writeBigUInt64LE(1_073_000_000_000_000n, 8); // 1.073B UI tokens
  buf.writeBigUInt64LE(30_000_000_000n, 16);       // 30 quote units at 9 decimals
  buf.writeBigUInt64LE(793_100_000_000_000n, 24);
  buf.writeBigUInt64LE(1_000_000_000n, 32);
  buf.writeBigUInt64LE(1_000_000_000_000_000n, 40);
  buf.writeUInt8(0, 48);
  if (bytes >= 115) {
    buf.writeUInt8(opts.mayhem ? 1 : 0, 81);
    buf.writeUInt8(opts.cashback ? 1 : 0, 82);
    opts.quote?.copy(buf, 83);
  }
  return buf.toString("base64");
}

const legacy = parseBondingCurveAccount(fixture(49));
assert(legacy);
assert.equal(legacy.quoteIsSol, true);
assert.equal(legacy.quoteMint, null);
assert.equal(legacy.layoutBytes, 49);

const standard = parseBondingCurveAccount(fixture(115));
assert(standard);
assert.equal(standard.quoteIsSol, true);
assert.equal(standard.isMayhemMode, false);
assert.equal(standard.isCashbackCoin, false);

const mayhem = parseBondingCurveAccount(fixture(151, { mayhem: true, cashback: true }));
assert(mayhem);
assert.equal(mayhem.isMayhemMode, true);
assert.equal(mayhem.isCashbackCoin, true);
assert.equal(mayhem.layoutBytes, 151);

const quoteBytes = Buffer.alloc(32, 7);
const nonSol = parseBondingCurveAccount(fixture(115, { quote: quoteBytes }));
assert(nonSol);
assert.equal(nonSol.quoteIsSol, false);
assert.equal(nonSol.quoteMint, bs58.encode(quoteBytes));
assert.equal(nonSol.priceSol > 0, true); // numeric ratio is readable, but its unit is NOT SOL
assert.equal(quoteMintIsSol(WRAPPED_SOL_MINT), true);
assert.equal(quoteMintIsSol(nonSol.quoteMint), false);

const bad = Buffer.from(fixture(115), "base64");
bad[0] = bad[0]! ^ 0xff;
assert.equal(parseBondingCurveAccount(bad.toString("base64")), null);

console.log("curve-layout-selftest: 18/18 passed");
