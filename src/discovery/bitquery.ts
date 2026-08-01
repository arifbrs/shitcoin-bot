import WebSocket from "ws";
import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";
import type { Candidate } from "../types.js";

/**
 * BITQUERY MULTI-LAUNCHPAD STREAM — one realtime WebSocket (graphql-transport-ws) that
 * carries REAL DEX trades across ALL Solana launchpads at once (pump.fun, Meteora DBC =
 * Believe/Bonkfun, and more). Because it's real trades, this single stream does BOTH:
 *   • detection      — a mint appears the moment it starts trading, any launchpad
 *   • momentum       — buy-pressure / unique buyers / net-SOL / acceleration, venue-agnostic
 *
 * A mint is CONFIRMED (→ candidate → gate → entry) only once its live tape proves a real,
 * accelerating, buy-dominant crowd — the same anti-blind-snipe idea as the pump.fun
 * checkpoint, but unified across launchpads and with NO per-launchpad curve reads.
 */

interface Tracked {
  launchpad: string;
  symbol?: string;
  firstSeen: number;
  buyers: Set<string>;
  /**
   * WASH-TRADE TAPE. The stream already carries BOTH leg addresses and per-trade USD, and we
   * were keeping only the buyers — throwing away the other half of every trade.
   *
   * `sellers` closes that gap and makes the strongest published wash discriminator computable
   * for free: the share of wallets that appear on BOTH sides of the tape,
   *   overlap = (buyers + sellers - distinct traders) / distinct traders
   * Bitquery's own 12h investigation across 5 confirmed wash-traded tokens measured 95-98%
   * overlap on wash tokens versus below 30% for genuine retail flow.
   *
   * This matters here specifically: our gate score is measurably INVERTED (coins it likes win
   * 18%, coins it barely scores win 39%), and the bonuses it pays out — holder count, buy
   * ratio, heavy buys — are exactly what a wash fleet manufactures. This measures the
   * manufacturing directly. Recorded only for now; it gates nothing until it is validated
   * against our own P&L.
   */
  sellers: Set<string>;
  buys: number;
  sells: number;
  buyVolUsd: number;
  sellVolUsd: number;
  times: number[]; // trade timestamps (for acceleration)
  lastPriceSol?: number;
  lastPriceUsd?: number;
  confirmed: boolean;
}

const SUB = `subscription {
  Solana {
    DEXTrades(where: {Trade: {Dex: {ProtocolName: {in: ${JSON.stringify(config.bitquery.launchpads)}}}}, Transaction: {Result: {Success: true}}}) {
      Trade {
        Dex { ProtocolName }
        Buy  { Amount AmountInUSD Price PriceInUSD Account { Address } Currency { Symbol MintAddress } }
        Sell { Amount AmountInUSD Price PriceInUSD Account { Address } Currency { Symbol MintAddress } }
      }
    }
  }
}`;

export class BitqueryStream {
  private ws?: WebSocket;
  private tracked = new Map<string, Tracked>();
  private pruneTimer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastMsgAt = Date.now();
  private stopped = false;
  private quotaHit = false;
  private tokenIdx = 0; // index into config.bitquery.tokens — advances only on a quota refusal
  private backoffMs = 1_000;

  constructor(private readonly onConfirmed: (c: Candidate) => void) {}

  start(): void {
    // Gate on the POOL, not on BITQUERY_TOKEN — the pool is what connect() actually reads, and
    // a config with only BITQUERY_TOKENS set would otherwise never start.
    if (!config.bitquery.enabled || !config.bitquery.tokens.length) return;
    this.connect();
    this.pruneTimer = setInterval(() => this.prune(), 60_000);
    // Staleness watchdog: force-reconnect if the trade stream goes silent (half-open
    // socket that never fires 'close'). Bitquery streams DEX trades constantly.
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      if (Date.now() - this.lastMsgAt > 45_000) {
        ui.warn(`[bitquery] no trades for ${Math.round((Date.now() - this.lastMsgAt) / 1000)}s — stale, reconnecting`);
        this.lastMsgAt = Date.now();
        try { this.ws?.terminate(); } catch { /* ignore */ }
      }
    }, 15_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  size(): number {
    return this.tracked.size;
  }

  /** Venue-agnostic live tape stats for a mint (for the agent / enrichment). */
  stats(mint: string): { buyers: number; buys: number; sells: number; buyPressurePct: number; netBuyVolUsd: number;
                         bothSidesPct: number | null; tradesPerTrader: number | null; avgTradeUsd: number | null; washScore: number | null } | null {
    const t = this.tracked.get(mint);
    if (!t) return null;
    const total = t.buys + t.sells;

    // ── WASH METRICS (measurement only — nothing gates on these yet) ──
    // distinct traders via inclusion-exclusion is not available (a wallet can be in both sets),
    // so take the true union; `buyers + sellers - union` is then exactly the both-sides count.
    const union = new Set<string>(t.buyers); for (const s of t.sellers) union.add(s);
    const traders = union.size;
    const bothSides = traders > 0 ? (t.buyers.size + t.sellers.size - traders) / traders : null;
    const tradesPerTrader = traders > 0 ? total / traders : null;
    const avgTradeUsd = total > 0 ? (t.buyVolUsd + t.sellVolUsd) / total : null;
    // Published composite (Bitquery wash investigation). Higher = more wash-like. Their measured
    // reference points: confirmed wash tokens sat at 95-98% both-sides, genuine retail below 30%.
    const washScore = (bothSides !== null && tradesPerTrader !== null && avgTradeUsd !== null)
      ? Math.log10(Math.max(tradesPerTrader, 1)) * (avgTradeUsd < 5 ? 1 : 0.4) * (bothSides > 0.3 ? bothSides : 0.2)
      : null;

    return {
      buyers: t.buyers.size,
      buys: t.buys,
      sells: t.sells,
      buyPressurePct: total > 0 ? (t.buys / total) * 100 : 0,
      netBuyVolUsd: t.buyVolUsd - t.sellVolUsd,
      bothSidesPct: bothSides === null ? null : Number((bothSides * 100).toFixed(1)),
      tradesPerTrader: tradesPerTrader === null ? null : Number(tradesPerTrader.toFixed(2)),
      avgTradeUsd: avgTradeUsd === null ? null : Number(avgTradeUsd.toFixed(4)),
      washScore: washScore === null ? null : Number(washScore.toFixed(3)),
    };
  }

  private connect(): void {
    if (this.stopped) return;
    const tok = config.bitquery.tokens[this.tokenIdx];
    if (!tok) return; // pool exhausted — stop() already ran
    const ws = new WebSocket(config.bitquery.endpoint, "graphql-transport-ws", {
      headers: { Authorization: `Bearer ${tok}` },
    });
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "connection_init" })));
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("error", (e) => ui.warn(`[bitquery] ws error: ${(e as Error).message}`));
    ws.on("close", () => {
      if (this.stopped) return;
      ui.warn(`[bitquery] disconnected — reconnecting in ${Math.round(this.backoffMs / 1000)}s`);
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000); // exponential backoff, capped
    });
  }

  private onMessage(txt: string): void {
    this.lastMsgAt = Date.now(); // heartbeat
    let m: { type?: string; payload?: unknown };
    try { m = JSON.parse(txt); } catch { return; }
    if (m.type === "connection_ack") {
      this.backoffMs = 1_000; // healthy connection resets backoff
      this.ws?.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: SUB } }));
      ui.info(`[bitquery] connected — streaming ${config.bitquery.launchpads.join(", ")} (all launchpads)`);
    } else if (m.type === "next") {
      const rows = (m.payload as { data?: { Solana?: { DEXTrades?: unknown[] } } })?.data?.Solana?.DEXTrades ?? [];
      for (const r of rows) this.ingest(r as Record<string, unknown>);
    } else if (m.type === "error") {
      const em = JSON.stringify(m.payload);
      ui.warn(`[bitquery] subscription error: ${em.slice(0, 200)}`);
      // Quota exhausted on THIS token. Reconnecting with the same one never helps — the meter
      // only resets on Bitquery's own cycle — so advance to the next token in the pool and
      // reconnect immediately. Only when every token is spent do we park the stream; pump.fun
      // momentum checkpoint keeps detection alive either way, so parking is degraded, not dead.
      if (/quota|time limit|restricted/i.test(em)) {
        const n = config.bitquery.tokens.length;
        if (this.tokenIdx + 1 < n) {
          this.tokenIdx++;
          ui.warn(`[bitquery] token ${this.tokenIdx} of ${n} exhausted — rotating to the next one`);
          try { this.ws?.close(); } catch { /* the close handler reconnects with the new token */ }
          return;
        }
        this.quotaHit = true;
        ui.warn(`[bitquery] all ${n} token(s) exhausted — parking multi-launchpad stream (pump.fun checkpoint still running)`);
        this.stop();
      }
    }
  }

  /** Fold one DEX trade into the mint's rolling tape and check the confirm gate. */
  private ingest(row: Record<string, unknown>): void {
    const trade = (row as { Trade?: Record<string, unknown> }).Trade;
    if (!trade) return;
    const dex = (trade.Dex as { ProtocolName?: string })?.ProtocolName ?? "?";
    type Side = { Amount?: string; AmountInUSD?: string; Price?: string; PriceInUSD?: string; Account?: { Address?: string }; Currency?: { Symbol?: string; MintAddress?: string } };
    const buy = trade.Buy as Side | undefined;
    const sell = trade.Sell as Side | undefined;
    const SOL = "So11111111111111111111111111111111111111112";
    const NATIVE = "11111111111111111111111111111111";
    const isStable = (m?: string): boolean => !m || m === SOL || m === NATIVE || m === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // WSOL/native/USDC = the quote leg
    // Each DEX trade is a swap with a Buy leg and a Sell leg. The TOKEN is whichever
    // leg isn't the quote (SOL/USDC). If the token is on the Buy leg → a BUY of the
    // token; if on the Sell leg → a SELL. That's how we get real buy-vs-sell pressure.
    let mint: string | undefined, direction: "buy" | "sell", trader: string | undefined, symbol: string | undefined;
    if (!isStable(buy?.Currency?.MintAddress)) {
      mint = buy!.Currency!.MintAddress; direction = "buy"; trader = buy?.Account?.Address; symbol = buy?.Currency?.Symbol;
    } else if (!isStable(sell?.Currency?.MintAddress)) {
      mint = sell!.Currency!.MintAddress; direction = "sell"; trader = sell?.Account?.Address; symbol = sell?.Currency?.Symbol;
    } else {
      return; // both legs are quote currencies — not a token trade
    }
    if (!mint) return;
    const amountUsd = parseFloat((direction === "buy" ? buy?.AmountInUSD : sell?.AmountInUSD) ?? "0") || 0;
    const priceSol = (direction === "buy" ? buy?.Price : sell?.Price) ? parseFloat((direction === "buy" ? buy!.Price : sell!.Price)!) : undefined;
    const priceUsd = (direction === "buy" ? buy?.PriceInUSD : sell?.PriceInUSD) ? parseFloat((direction === "buy" ? buy!.PriceInUSD : sell!.PriceInUSD)!) : undefined;

    const now = Date.now();
    let t = this.tracked.get(mint);
    if (!t) {
      if (this.tracked.size >= config.bitquery.maxTracked) return;
      t = { launchpad: dex, symbol, firstSeen: now, buyers: new Set(), sellers: new Set(), buys: 0, sells: 0, buyVolUsd: 0, sellVolUsd: 0, times: [], confirmed: false };
      this.tracked.set(mint, t);
    }
    if (direction === "buy") { t.buys++; t.buyVolUsd += amountUsd; if (trader) t.buyers.add(trader); }
    else { t.sells++; t.sellVolUsd += amountUsd; if (trader) t.sellers.add(trader); }
    if (priceSol) t.lastPriceSol = priceSol;
    if (priceUsd) t.lastPriceUsd = priceUsd;
    t.times.push(now);
    if (t.times.length > 200) t.times.shift();

    if (!t.confirmed) this.maybeConfirm(mint, t);
  }

  /** Confirm once the live tape proves a real, accelerating, buy-dominant crowd. */
  private maybeConfirm(mint: string, t: Tracked): void {
    const ageMs = Date.now() - t.firstSeen;
    const c = config.bitquery.confirm;
    if (ageMs < c.minAgeMs || ageMs > c.maxAgeMs) return;
    const total = t.buys + t.sells;
    if (total < 6) return;
    const buyPressure = (t.buys / total) * 100;
    const net = t.buyVolUsd - t.sellVolUsd; // net USD flow (buy − sell)
    // Acceleration: trade-rate in the recent half vs the earlier half of the window.
    const s = t.times;
    const mid = Math.floor(s.length / 2);
    const rate = (arr: number[]): number => { if (arr.length < 2) return 0; const span = (arr[arr.length - 1]! - arr[0]!) / 1000; return span > 0 ? arr.length / span : 0; };
    const accel = rate(s.slice(0, mid + 1)) === 0 ? 0 : rate(s.slice(mid)) / rate(s.slice(0, mid + 1));

    if (t.buyers.size >= c.minUniqueBuyers && buyPressure >= c.minBuyPressurePct && accel >= c.minAccel && net >= c.minNetBuyUsd) {
      t.confirmed = true;
      const candidate: Candidate = {
        source: "bitquery",
        mode: "fast-follow",
        mint,
        symbol: t.symbol,
        pool: t.launchpad, // which launchpad it came from
        priceSol: t.lastPriceSol,
        confirmStats: { accel: Number(accel.toFixed(2)), buyPressurePct: Math.round(buyPressure), uniqueBuyers: t.buyers.size, ageSec: Math.round(ageMs / 1000) },
        // Wash metrics AT CONFIRM TIME — stamped so they land in the trade record and can later
        // be regressed against realised P&L. Measurement only; nothing here blocks the candidate.
        washStats: this.stats(mint) ?? undefined,
        detectedAt: Date.now(),
      };
      ui.pass(`[bitquery] CONFIRMED ${t.symbol ?? mint} [${t.launchpad}] — ${t.buyers.size} buyers · buy ${buyPressure.toFixed(0)}% · accel ${accel.toFixed(2)}× · net $${net.toFixed(0)} · ${(ageMs / 1000).toFixed(0)}s`);
      logRecord("events", { type: "bitquery-confirm", mint, symbol: t.symbol, launchpad: t.launchpad, buyers: t.buyers.size, buyPressurePct: Math.round(buyPressure), accel: Number(accel.toFixed(2)), netBuyUsd: Math.round(net), ageSec: Math.round(ageMs / 1000), ...(candidate.washStats ?? {}) });
      this.onConfirmed(candidate);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [mint, t] of this.tracked) if (now - t.firstSeen > config.bitquery.pruneMs) this.tracked.delete(mint);
  }
}
