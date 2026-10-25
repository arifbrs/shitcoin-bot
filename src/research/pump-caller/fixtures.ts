/** FIXTURES deterministik — bentuk respons terdokumentasi; utk tes offline. BUKAN bukti pasar. */
import type { HomeFeedItem, Callout, UserPosition, UserTrade, MintPosition, TradeEvent, Candle } from "./types.js";

export const FIX_HOME_FEED: HomeFeedItem[] = [
  { coin: "FIXCOIN1", mint: "FixMint11111111111111111111111111111111111", name: "Fixture One", symbol: "FX1", usdMarketCap: 42_000, createdBy: "caller-alpha", createdAt: 1_790_000_000_000 },
  { coin: "FIXCOIN2", mint: "FixMint22222222222222222222222222222222222", name: "Fixture Two", symbol: "FX2", usdMarketCap: 9_500, createdBy: "caller-beta", createdAt: 1_790_003_600_000 },
];

export const FIX_CALLOUTS: Callout[] = [
  { calloutId: "co-1", coin: "FIXCOIN1", userId: "caller-alpha", username: "alpha", text: "fixture callout", timestamp: 1_790_000_120_000 },
];

export const FIX_USER_POSITIONS: UserPosition[] = [
  { userId: "caller-alpha", mint: "FixMint11111111111111111111111111111111111", tokenAmount: 12_000_000, usdPosition: 310, solPosition: 0.13, realizedPnl: 42, unrealizedPnl: -55, avgCostSolPerToken: 0.00000004 },
];

export const FIX_USER_TRADES: UserTrade[] = [
  { id: "t-1", userId: "caller-alpha", mint: "FixMint11111111111111111111111111111111111", side: "buy", solAmount: 0.5, tokenAmount: 12_500_000, timestamp: 1_790_000_060_000, signature: "FixSig1111111111111111111111111111111111111111111111111111111111" },
  { id: "t-2", userId: "caller-alpha", mint: "FixMint11111111111111111111111111111111111", side: "sell", solAmount: 0.2, tokenAmount: 500_000, timestamp: 1_790_000_600_000, signature: "FixSig2222222222222222222222222222222222222222222222222222222222" },
];

export const FIX_MINT_POSITIONS: MintPosition[] = [
  { mint: "FixMint11111111111111111111111111111111111", userId: "caller-alpha", tokenAmount: 12_000_000, usdPosition: 310, realizedPnl: 42, unrealizedPnl: -55 },
];

export const FIX_TRADES: TradeEvent[] = [
  { dedupeKey: "w1:1000:buy:3", mint: "FixMint11111111111111111111111111111111111", wallet: "w1", side: "buy", sol: 3, usd: 600, ts: 1_790_000_000_000 + 1_000 },
  { dedupeKey: "w2:2000:sell:0.02", mint: "FixMint11111111111111111111111111111111111", wallet: "w2", side: "sell", sol: 0.02, usd: 4, ts: 1_790_000_000_000 + 2_000 },
  { dedupeKey: "w2:3000:sell:0.05", mint: "FixMint11111111111111111111111111111111111", wallet: "w2", side: "sell", sol: 0.05, usd: 10, ts: 1_790_000_000_000 + 3_000 },
  { dedupeKey: "w3:4000:buy:5", mint: "FixMint11111111111111111111111111111111111", wallet: "w3", side: "buy", sol: 5, usd: 1000, ts: 1_790_000_000_000 + 4_000 },
  { dedupeKey: "w4:5000:buy:0.5", mint: "FixMint11111111111111111111111111111111111", wallet: "w4", side: "buy", sol: 0.5, usd: 100, ts: 1_790_000_000_000 + 5_000 },
  { dedupeKey: "w4:9000:sell:0.5", mint: "FixMint11111111111111111111111111111111111", wallet: "w4", side: "sell", sol: 0.5, usd: 105, ts: 1_790_000_000_000 + 9_000 },
];

const T0 = 1_790_000_000_000;
export const FIX_CANDLES_1S: Candle[] = Array.from({ length: 12 }, (_, i) => {
  const base = 0.0000040 + (i >= 4 ? 0.0000006 : 0); // lompatan setelah large-buy di candle-4
  const wig = i % 3 === 0 ? 0.0000002 : 0.0000001;
  return { ts: T0 + i * 1_000, open: base, high: base + wig, low: base - wig * 0.5, close: base + (i >= 4 ? wig * 0.6 : 0), volumeSol: i === 4 ? 5 : 0.3 };
});
export const FIX_CANDLES_1M: Candle[] = Array.from({ length: 6 }, (_, i) => ({ ts: T0 + i * 60_000, open: 0.0000040, high: 0.0000048, low: 0.0000039, close: 0.0000044 + i * 0.00000005, volumeSol: 2 + i }));
