import WebSocket from "ws";
import { config } from "../config.js";
import { ui } from "../util/log.js";

/**
 * Live per-token trade stream (PumpPortal `subscribeTokenTrade`, free).
 *
 * The bonding-curve reserve tells us HOW MUCH SOL flowed in; this tells us WHO —
 * how many distinct buyers, buy-vs-sell balance, real-time volume. That's the
 * difference between "50 small buyers = organic crowd" and "1 whale about to
 * dump", which the Feeling Agent needs to read conviction. One shared connection,
 * auto-reconnect + resubscribe; a rolling per-mint window feeds live stats.
 */

interface Trade { at: number; txType: "buy" | "sell"; solAmount: number; trader: string }

export interface TradeStats {
  windowSec: number;
  buys: number;
  sells: number;
  uniqueTraders: number;
  uniqueBuyers: number;
  buyVolSol: number;
  sellVolSol: number;
  netBuyVolSol: number; // buy − sell (accumulation vs distribution)
  buyRatio: number; // buys / (buys+sells), 0..1
  lastTradeSecAgo: number;
  /**
   * WASH-TRADE METRICS. Computed here rather than from the Bitquery tape because Bitquery's
   * free STREAMING quota is exhausted after roughly an hour of continuous use (measured
   * 2026-07-26: a fresh token died the same day), whereas this PumpPortal feed is free,
   * unmetered and already running. It carries `traderPublicKey` and `txType`, which is
   * everything the metric needs.
   *
   * `bothSidesPct` — share of wallets appearing as BOTH buyer and seller in the window. This is
   * the strongest published discriminator: Bitquery's own investigation of five confirmed
   * wash-traded tokens measured 95-98% here, against below 30% for genuine retail flow.
   *
   * Why it matters for us: our gate score is measurably INVERTED (coins it scores 62+ win 18%,
   * coins near the unscored base of 50 win 39%), and the bonuses it pays — holder count, buy
   * ratio, heavy buy counts — are exactly what a wash fleet manufactures. This measures the
   * manufacturing itself. MEASUREMENT ONLY: nothing gates on it until it is regressed against
   * our own realised P&L.
   */
  bothSidesPct: number;
  tradesPerTrader: number;
  avgTradeSol: number;
  washScore: number;
}


/**
 * Wash-trade metrics over a trade window. `bothSides` counts wallets on BOTH sides:
 * buyers + sellers - distinct traders (a wallet in both sets is double-counted in the sum,
 * so the difference is exactly the overlap). The composite is Bitquery's published form —
 * a small average trade and a high overlap both amplify it.
 */
function washMetrics(w: Trade[]): { bothSidesPct: number; tradesPerTrader: number; avgTradeSol: number; washScore: number } {
  const buyers = new Set(w.filter((t) => t.txType === "buy").map((t) => t.trader));
  const sellers = new Set(w.filter((t) => t.txType === "sell").map((t) => t.trader));
  const traders = new Set(w.map((t) => t.trader)).size;
  const bothSides = traders > 0 ? (buyers.size + sellers.size - traders) / traders : 0;
  const tradesPerTrader = traders > 0 ? w.length / traders : 0;
  const avgTradeSol = w.length > 0 ? w.reduce((a, t) => a + t.solAmount, 0) / w.length : 0;
  // The published threshold is <$5 per trade; at ~$200/SOL that is ~0.025 SOL. Kept in SOL so
  // the metric never depends on a USD price we would have to fetch and could get wrong.
  const smallTrade = avgTradeSol < 0.025 ? 1 : 0.4;
  const score = Math.log10(Math.max(tradesPerTrader, 1)) * smallTrade * (bothSides > 0.3 ? bothSides : 0.2);
  return {
    bothSidesPct: Number((bothSides * 100).toFixed(1)),
    tradesPerTrader: Number(tradesPerTrader.toFixed(2)),
    avgTradeSol: Number(avgTradeSol.toFixed(5)),
    washScore: Number(score.toFixed(3)),
  };
}

export const tradeStreamEnabled = Boolean(config.pumpPortalApiKey);

export class TradeStream {
  private ws: WebSocket | null = null;
  private closed = false;
  private watched = new Set<string>();
  private trades = new Map<string, Trade[]>(); // mint -> rolling trade buffer (last 5 min)
  private backoffMs = 1_000;

  constructor() {
    // The trade stream needs a funded PumpPortal API key. Without one, stay fully
    // dormant (no connection) — the agent just reads crowd=null and works as before.
    if (tradeStreamEnabled) this.connect();
  }

  private connect(): void {
    if (this.closed || !config.pumpPortalApiKey) return;
    this.ws = new WebSocket(`${config.pumpPortalWsUrl}?api-key=${config.pumpPortalApiKey}`);
    this.ws.on("open", () => {
      this.backoffMs = 1_000;
      if (this.watched.size) {
        this.ws!.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [...this.watched] }));
        ui.info(`[tradestream] connected — streaming trades for ${this.watched.size} held token(s)`);
      }
    });
    this.ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw.toString()));
    this.ws.on("close", () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    this.ws.on("error", () => this.ws?.close());
  }

  private onMessage(text: string): void {
    let m: { mint?: string; txType?: string; solAmount?: number; traderPublicKey?: string };
    try { m = JSON.parse(text); } catch { return; }
    if (!m.mint || (m.txType !== "buy" && m.txType !== "sell")) return;
    if (!this.watched.has(m.mint)) return;
    const arr = this.trades.get(m.mint) ?? [];
    arr.push({ at: Date.now(), txType: m.txType, solAmount: Number(m.solAmount) || 0, trader: String(m.traderPublicKey ?? "") });
    const cutoff = Date.now() - 300_000; // keep last 5 min
    while (arr.length && arr[0]!.at < cutoff) arr.shift();
    this.trades.set(m.mint, arr);
  }

  watch(mint: string): void {
    if (this.watched.has(mint)) return;
    this.watched.add(mint);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
  }

  unwatch(mint: string): void {
    if (!this.watched.delete(mint)) return;
    this.trades.delete(mint);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
  }

  /** Live crowd stats over the trailing window, or null if no trades seen yet. */
  stats(mint: string, windowMs = 180_000): TradeStats | null {
    const arr = this.trades.get(mint);
    if (!arr || !arr.length) return null;
    const cutoff = Date.now() - windowMs;
    const w = arr.filter((t) => t.at >= cutoff);
    if (!w.length) return null;
    const buys = w.filter((t) => t.txType === "buy");
    const sells = w.filter((t) => t.txType === "sell");
    const buyVol = buys.reduce((a, t) => a + t.solAmount, 0);
    const sellVol = sells.reduce((a, t) => a + t.solAmount, 0);
    return {
      windowSec: Math.round(windowMs / 1000),
      buys: buys.length,
      sells: sells.length,
      uniqueTraders: new Set(w.map((t) => t.trader)).size,
      uniqueBuyers: new Set(buys.map((t) => t.trader)).size,
      buyVolSol: Number(buyVol.toFixed(3)),
      sellVolSol: Number(sellVol.toFixed(3)),
      netBuyVolSol: Number((buyVol - sellVol).toFixed(3)),
      buyRatio: Number((buys.length / w.length).toFixed(2)),
      lastTradeSecAgo: Math.round((Date.now() - w[w.length - 1]!.at) / 1000),
      ...washMetrics(w),
    };
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }
}
