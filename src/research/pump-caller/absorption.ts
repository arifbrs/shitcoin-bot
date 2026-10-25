/**
 * LARGE-BUY / SMALL-SELL ABSORPTION — murni. Tape ter-timestamp → metrik absorpsi.
 * Ambang USD ($500/$1000, small-sell $5–100) = PARAMETER RISET (bukan ambang profitable);
 * normalisasi likuiditas (share ≥2% likuiditas) dihitung terpisah dari ambang absolut.
 * Ini adalah aliran AMM, bukan order-book — "absorption" berarti arus jual kecil terserap
 * pembeli besar, bukan menyerapnya terhadap bid.
 */
import type { TradeEvent, AbsorptionParams, AbsorptionView, Candle } from "./types.js";
import { DEFAULT_ABSORPTION } from "./types.js";

export function absorptionView(trades: TradeEvent[], params: AbsorptionParams = DEFAULT_ABSORPTION, liquidityUsd: number | null = null, candles1sAfterLargeBuy?: Candle[]): AbsorptionView {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const usdOf = (t: TradeEvent): number | null => (t.usd != null ? t.usd : null);
  const isLarge = (t: TradeEvent): boolean => {
    if (t.side !== "buy") return false;
    const u = usdOf(t);
    if (u != null && params.largeBuyUsd.some((th) => u >= th)) return true;
    if (u != null && liquidityUsd != null && u >= liquidityUsd * params.largeByLiquidityShare) return true;
    return false;
  };
  const largeBuys = sorted.filter(isLarge).map((t) => ({ usd: usdOf(t), sol: t.sol, ts: t.ts, wallet: t.wallet }));
  const smallSells = sorted.filter((t) => t.side === "sell" && t.usd != null && t.usd >= params.smallSellUsdMin && t.usd <= params.smallSellUsdMax);
  const buys = sorted.filter((t) => t.side === "buy");
  const sells = sorted.filter((t) => t.side === "sell");
  const totalBuySol = sum(buys.map((t) => t.sol));
  const totalSellSol = sum(sells.map((t) => t.sol));
  const buyerCounts = new Map<string, number>();
  for (const b of buys) if (b.wallet) buyerCounts.set(b.wallet, (buyerCounts.get(b.wallet) ?? 0) + 1);
  const uniqueBuyers = buyerCounts.size;
  const repeatBuyers = [...buyerCounts.values()].filter((n) => n > 1).length;
  const sellerWallets = new Set(sells.map((t) => t.wallet).filter(Boolean) as string[]);
  const buyerWallets = new Set(buys.map((t) => t.wallet).filter(Boolean) as string[]);
  const traders = new Set([...buyerWallets, ...sellerWallets]);
  const bothSides = traders.size > 0 ? (buyerWallets.size + sellerWallets.size - traders.size) / traders.size : 0;
  // Seller besar keluar: wallet yang pernah large-buy lalu jual > 50% nilai belinya.
  const largeSellerExits = largeBuys.filter((lb) => {
    const walletSells = sells.filter((s) => s.wallet === lb.wallet);
    return sum(walletSells.map((s) => s.usd ?? 0)) > (lb.usd ?? 0) * 0.5;
  }).length;
  // Respons harga pasca large-buy (candle 1s sesudahnya) bila disediakan.
  let priceResponse: AbsorptionView["priceResponseAfterLargeBuy"] = null;
  if (candles1sAfterLargeBuy && candles1sAfterLargeBuy.length >= 2 && largeBuys.length) {
    const lb = largeBuys[0]!;
    const after = candles1sAfterLargeBuy.filter((c) => c.ts >= lb.ts).slice(0, 4);
    if (after.length >= 2) {
      const first = after[0]!, last = after[after.length - 1]!;
      priceResponse = { candleWindow: "≥2×1s pasca large-buy", movePct: ((last.close - first.open) / first.open) * 100 };
    }
  }
  // Pembeli independen menyusul? (≥2 pembeli beda wallet dalam 30 dtk pasca large-buy pertama)
  let followersFollow: boolean | null = null;
  if (largeBuys.length) {
    const lb0 = largeBuys[0]!;
    const followers = buys.filter((b) => b.ts > lb0.ts && b.ts <= lb0.ts + 30_000 && b.wallet && b.wallet !== lb0.wallet);
    followersFollow = new Set(followers.map((f) => f.wallet)).size >= 2;
  }
  // Pembeli awal cepat jual? (large-buy pertama diikuti jual ≥70% nilai oleh wallet yang sama <60 dtk)
  let initialBuyerRapidSold: boolean | null = null;
  if (largeBuys.length) {
    const lb0 = largeBuys[0]!;
    const rapid = sells.filter((s) => s.wallet === lb0.wallet && s.ts > lb0.ts && s.ts <= lb0.ts + 60_000);
    initialBuyerRapidSold = sum(rapid.map((s) => s.usd ?? 0)) >= (lb0.usd ?? 0) * 0.7;
  }
  return {
    largeBuys, smallSells: smallSells.length, smallSellUsdTotal: sum(smallSells.map((s) => s.usd ?? 0)),
    totalBuySol: Number(totalBuySol.toFixed(4)), totalSellSol: Number(totalSellSol.toFixed(4)), netFlowSol: Number((totalBuySol - totalSellSol).toFixed(4)),
    uniqueBuyers, repeatBuyers, largeSellerExits,
    washSuspicion: { bothSidesPct: Number((bothSides * 100).toFixed(1)), note: "pembeli=penjual overlap tinggi = indikasi wash (AMM flow, bukan bukti)" },
    priceResponseAfterLargeBuy: priceResponse, followersFollow, initialBuyerRapidSold,
  };
}

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
