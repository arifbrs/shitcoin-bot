import { test, eq, approx } from "../testing/harness.js";
import { isAcceptable, behaviorFromDexRow } from "./scanner.js";

const A = "0x6ebc9cebcd7dc3cacb34c65f279461eb6a35a96f";

test("scanner: tolak token yang menumpang nama aset mapan", () => {
  eq(isAcceptable("ETH", A), false, "ETH ditolak");
  eq(isAcceptable("weth", A), false, "weth ditolak");
  eq(isAcceptable("USDG", A), false, "USDG ditolak");
});

test("scanner: terima simbol wajar dengan alamat valid", () => {
  eq(isAcceptable("Kimchi", A), true, "Kimchi diterima");
  eq(isAcceptable("X", A), false, "simbol 1 huruf ditolak");
  eq(isAcceptable("OK", "bukan-alamat"), false, "alamat salah ditolak");
});

test("FINAL-3: fitur perilaku dari baris pair — imbalance, intensitas, momentum, umur (point-in-time)", () => {
  const row = { chainId: "robinhood", baseToken: { address: "0xabc" }, liquidity: { usd: 50000 },
    txns: { h1: { buys: 30, sells: 10 } }, priceChange: { h1: 4.2 }, pairCreatedAt: Date.now() - 2 * 86_400_000 };
  const b = behaviorFromDexRow(row);
  approx(b.imbalanceH1!, 0.75, 1e-12, "imbalance = 30/(30+10)");
  eq(b.txnsH1, 40, "intensitas");
  eq(b.priceChangeH1, 4.2, "momentum");
  approx(b.pairAgeDays!, 2, 0.01, "umur pair");
  const none = behaviorFromDexRow(null);
  eq(none.imbalanceH1, null, "tanpa baris = null (fail-closed)");
  const zeros = behaviorFromDexRow({ txns: { h1: { buys: 0, sells: 0 } } });
  eq(zeros.imbalanceH1, null, "0/0 = null, bukan NaN");
});
