import { config } from "./config.js";
import { logRecord, ui } from "./log.js";
import { decide, type BarState } from "./strategy.js";
import type { Candle } from "./feed.js";

interface OpenPosition {
  entryPrice: number;
  entryAtr: number;
  stopPrice: number;
  sizeUsd: number;
  sizeEth: number;
  openedAtMs: number;
  openIndex: number;
}

/**
 * ETH paper trader — same accounting discipline as the Solana project's papertrader.ts:
 * every close is logged with full context, wins/losses/PnL are tracked explicitly, and the
 * (unverified) Robinhood fee assumption is applied so its impact is visible, not hidden.
 */
export class EthPaperTrader {
  private equityUsd = config.risk.startingFloatUsd;
  private position: OpenPosition | null = null;
  private wins = 0;
  private losses = 0;
  private realizedPnlUsd = 0;

  summary(): string {
    const pct = ((this.equityUsd - config.risk.startingFloatUsd) / config.risk.startingFloatUsd) * 100;
    return `${this.wins}W/${this.losses}L, equity $${this.equityUsd.toFixed(2)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%), ${this.position ? "in position" : "flat"}`;
  }

  hasPosition(): boolean { return this.position !== null; }

  /** Process ONE closed bar. `states` is the full history so far (index `i` = current bar). */
  processBar(states: BarState[], i: number, candle: Candle): void {
    const now = states[i]!;
    const prev = states[i - 1];

    // Stop-loss check FIRST, against this bar's LOW (a long position can be stopped out
    // intra-bar even if the close looks fine) — checked every bar regardless of the EMA signal.
    if (this.position && candle.low <= this.position.stopPrice) {
      this.close(this.position.stopPrice, now, "ATR_STOP");
      return;
    }

    const action = decide(prev, now, this.hasPosition());
    if (action === "enter-long" && !this.position) {
      this.open(now);
    } else if (action === "exit-long" && this.position) {
      this.close(now.close, now, "TREND_REVERSAL");
    }
  }

  private open(now: BarState): void {
    const stopDistance = now.atr * config.strategy.atrStopMult;
    const stopPrice = now.close - stopDistance;
    // Position sizing: risk a fixed % of CURRENT equity, sized so a stop-out loses exactly
    // that % (before fees) — the same "risk per trade, not fixed notional" model as the Solana
    // sniper's exposure math.
    const riskUsd = this.equityUsd * (config.risk.riskPerTradePct / 100);
    const sizeEth = riskUsd / stopDistance;
    const sizeUsd = sizeEth * now.close;
    this.position = { entryPrice: now.close, entryAtr: now.atr, stopPrice, sizeUsd, sizeEth, openedAtMs: Date.now(), openIndex: now.i };
    logRecord("trades", {
      action: "OPEN", entryPrice: now.close, stopPrice: Number(stopPrice.toFixed(2)),
      atr: Number(now.atr.toFixed(2)), sizeUsd: Number(sizeUsd.toFixed(2)), sizeEth: Number(sizeEth.toFixed(6)),
      equityUsd: Number(this.equityUsd.toFixed(2)), symbol: config.feed.symbol,
    });
    ui.pass(`[paper] OPEN long @ $${now.close.toFixed(2)} — stop $${stopPrice.toFixed(2)} (ATR $${now.atr.toFixed(2)}), size $${sizeUsd.toFixed(2)}`);
  }

  private close(exitPrice: number, now: BarState, reason: string): void {
    if (!this.position) return;
    const pos = this.position;
    const grossPnlUsd = (exitPrice - pos.entryPrice) * pos.sizeEth;
    // UNVERIFIED FEE MODEL — see config.ts. Applied so its effect on the bottom line is
    // visible and comparable, not hidden; must be replaced with Robinhood's real fee schedule
    // before any conclusion from this is trusted.
    const feeUsd = pos.sizeUsd * (config.risk.unverifiedRoundTripFeePct / 100);
    const netPnlUsd = grossPnlUsd - feeUsd;
    this.equityUsd += netPnlUsd;
    this.realizedPnlUsd += netPnlUsd;
    if (netPnlUsd >= 0) this.wins++; else this.losses++;
    const heldBars = now.i - pos.openIndex;
    logRecord("trades", {
      action: "CLOSE", reason, entryPrice: pos.entryPrice, exitPrice: Number(exitPrice.toFixed(2)),
      grossPnlUsd: Number(grossPnlUsd.toFixed(2)), feeUsd: Number(feeUsd.toFixed(2)), netPnlUsd: Number(netPnlUsd.toFixed(2)),
      pnlPct: Number(((netPnlUsd / pos.sizeUsd) * 100).toFixed(2)), heldBars, equityUsd: Number(this.equityUsd.toFixed(2)),
      wins: this.wins, losses: this.losses, symbol: config.feed.symbol,
    });
    const line = `[paper] CLOSE ${reason} @ $${exitPrice.toFixed(2)} = ${netPnlUsd >= 0 ? "+" : ""}$${netPnlUsd.toFixed(2)} | ${this.wins}W/${this.losses}L, equity $${this.equityUsd.toFixed(2)}`;
    netPnlUsd >= 0 ? ui.pass(line) : ui.reject(line);
    this.position = null;
  }
}
