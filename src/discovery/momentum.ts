import { config } from "../config.js";
import { liveRisk } from "../control.js";
import { bondingCurvePriceSol, bondingCurvePricesMulti } from "../safety/onchain.js";
import { pumpTradeStats } from "../safety/pump-trades.js";
import { ui, logRecord } from "../util/log.js";
import type { Candidate } from "../types.js";

/**
 * MOMENTUM WATCHLIST — the diegodiaz-style confirmation entry, curve-based.
 *
 * Instead of blind-sniping every launch at ~8s (which bought dead tokens and bled
 * fees), a new token is WATCHED: we poll its bonding-curve reserve over time and
 * only hand it off for entry once buying is CONFIRMED and ACCELERATING. On the
 * pump.fun curve, vSol only rises on net buys, so:
 *   grownPct = how much real SOL has bought in since we started watching
 *   accel    = recent buy-rate ÷ earlier buy-rate (is momentum building or stalling?)
 *
 * Checkpoints: drop zombies fast (no growth by zombieMs), confirm only after
 * confirmMs with real growth + acceleration, give up at timeoutMs. Free — no trade
 * stream, no JWT; uses the same curve read we already do.
 */

interface Sample { t: number; vSol: number }
interface Watched {
  candidate: Candidate;
  addedAt: number;
  bcKey: string;
  firstVSol: number;
  samples: Sample[];
}

export interface MomentumStats {
  grownPct: number;
  accel: number;
  velSol: number; // ABSOLUTE recent buy velocity (net SOL/s flowing into the curve NOW) — robust primary signal
  ageSec: number;
  vSol: number;
}

export class MomentumWatch {
  private watched = new Map<string, Watched>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(private readonly onConfirmed: (c: Candidate, m: MomentumStats) => void) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), config.checkpoint.pollMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  size(): number {
    return this.watched.size;
  }

  /** Put a fresh fast-follow launch on the watchlist (curve-based momentum). */
  add(c: Candidate): void {
    if (c.mode !== "fast-follow" || !c.bondingCurveKey) return; // curve momentum = fast-follow only
    if (this.watched.has(c.mint)) return;
    if (this.watched.size >= config.checkpoint.maxWatch) return; // cap RPC load
    this.watched.set(c.mint, { candidate: c, addedAt: Date.now(), bcKey: c.bondingCurveKey, firstVSol: c.bcVSol ?? 30, samples: [] });
  }

  private stats(w: Watched, vSolNow: number): MomentumStats {
    const s = w.samples;
    const base = s[0]?.vSol ?? w.firstVSol;
    const grownPct = base > 0 ? ((vSolNow - base) / base) * 100 : 0;
    // Acceleration: growth RATE in the recent half vs the earlier half of samples.
    const rate = (arr: Sample[]): number => {
      if (arr.length < 2) return 0;
      const dt = (arr[arr.length - 1]!.t - arr[0]!.t) / 1000;
      return dt > 0 ? (arr[arr.length - 1]!.vSol - arr[0]!.vSol) / dt : 0;
    };
    const mid = Math.floor(s.length / 2);
    const earlyRate = rate(s.slice(0, mid + 1));
    const recentRate = rate(s.slice(mid));
    // ACCELERATION — recent buy-rate vs earlier. A near-zero earlyRate divisor used to
    // manufacture absurd ratios (DRILLPIG showed accel 46.78× purely because earlyRate was
    // ~0, then it dumped −32%). Guard it: require a MEANINGFUL absolute recent velocity
    // (real SOL/s flowing in) before trusting a ratio, and CAP the ratio so one slow early
    // sample can't fake a rocket. Below the velocity floor, accel is "steady" (1), not huge.
    const MIN_RECENT_VEL = 0.002; // SOL/s of net buying — below this, the ratio is noise
    let accel: number;
    if (recentRate < MIN_RECENT_VEL) accel = recentRate > 0 ? 1 : 0; // too little real flow to call it accelerating
    else if (earlyRate > MIN_RECENT_VEL) accel = Math.min(8, recentRate / earlyRate); // real ratio, capped at 8×
    else accel = 2; // genuine acceleration from a quiet start (real velocity now, was slow) — modest, not 46×
    // ABSOLUTE velocity = the actual net SOL/s flowing in over the recent window. This is the
    // PRIMARY momentum signal now (audit #5): unlike the ratio it can't be faked by a tiny
    // divisor, and it directly measures "real money entering right now". recentRate already
    // computes exactly this from the last-half of samples.
    const velSol = Math.max(0, recentRate);
    return { grownPct, accel, velSol, ageSec: (Date.now() - w.addedAt) / 1000, vSol: vSolNow };
  }

  private async tick(): Promise<void> {
    if (this.polling) return; // don't overlap slow ticks
    this.polling = true;
    try {
      const now = Date.now();
      // BATCH-read ALL watched curves in ONE getMultipleAccounts RPC — lets us watch MANY
      // more coins and poll FAST without blowing the RPC limit (memecoins move fast; a slow
      // sequential poll missed them). Falls back to a single read if a key isn't in the batch.
      const keys = [...this.watched.values()].map((w) => w.bcKey);
      const batch = keys.length > 1 ? await bondingCurvePricesMulti(keys) : new Map();
      for (const [mint, w] of [...this.watched]) {
        const ageMs = now - w.addedAt;
        if (ageMs > config.checkpoint.timeoutMs) { this.drop(mint, w, "timeout"); continue; }
        const bc = batch.get(w.bcKey) ?? await bondingCurvePriceSol(w.bcKey);
        if (!bc) continue; // transient read fail — try next tick
        if (bc.complete) { this.drop(mint, w, "graduated"); continue; }
        w.samples.push({ t: now, vSol: bc.vSol });
        if (w.samples.length > 30) w.samples.shift();

        const grownPct = w.firstVSol > 0 ? ((bc.vSol - w.firstVSol) / w.firstVSol) * 100 : 0;
        // Zombie: past the deadline and STILL essentially flat = dead-on-arrival.
        // Note the low bar (zombieGrowthPct) — a slow-burner that's grown a little gets
        // to keep proving itself toward the full confirm bar (minGrowthPct) instead of
        // being killed at 60s for not already being +20%.
        if (ageMs > config.checkpoint.zombieMs && grownPct < config.checkpoint.zombieGrowthPct) {
          this.drop(mint, w, "zombie"); continue;
        }
        // Confirm: enough age + samples, real curve growth AND still accelerating.
        // Then a SECOND gate on the REAL trade tape (free swap-api): buy-pressure and
        // a genuine crowd of distinct buyers — this is the diegodiaz checkpoint proper,
        // not just a curve proxy. A pump with one wallet churning fails here.
        if (ageMs > config.checkpoint.confirmMs && w.samples.length >= 3) {
          const m = this.stats(w, bc.vSol);
          // PRIMARY = absolute inflow velocity (real SOL/s in NOW) + real growth; accel is a
          // secondary shape check. A coin that grew earlier but has NO current inflow (velSol
          // below the floor) is a stalled pump, not live momentum → don't confirm.
          if (m.grownPct >= config.checkpoint.minGrowthPct && m.velSol >= liveRisk("minVelSol", config.checkpoint.minVelSol, [0, 1]) && m.accel >= config.checkpoint.minAccel) {
            const tr = await pumpTradeStats(mint);
            // Thin-buyer leak fix: previously a null tape (swap-api not indexed yet) meant
            // an AUTOMATIC pass — so extreme-growth pumps by a handful of wallets (ALLEARS
            // +155% / 6 buyers) slipped through on curve growth alone. Now:
            //   • EXTREME growth (≥ extremeGrowthPct) REQUIRES a verified healthy tape —
            //     no tape or a thin/one-sided/net-negative tape → reject (that's the manip pattern).
            //   • Otherwise the tape must pass buy-pressure + unique-buyers, OR be genuinely
            //     unavailable (fail-open only for normal growth, where the curve is enough).
            const extreme = m.grownPct >= config.pumpTrades.extremeGrowthPct;
            const tapeHealthy = !!tr
              && tr.buyPressurePct >= config.pumpTrades.minBuyPressurePct
              && tr.uniqueBuyers >= config.pumpTrades.minUniqueBuyers
              && tr.netBuyVolSol > 0; // real net money in, not churn
            const buyOk = extreme ? tapeHealthy : (!tr || tapeHealthy);
            if (!buyOk) {
              // thin/one-sided/net-negative demand (or unverifiable extreme pump) — don't buy.
              logRecord("events", { type: "momentum-weak-tape", mint, symbol: w.candidate.symbol, grownPct: Number(m.grownPct.toFixed(0)), buyPressurePct: tr ? Math.round(tr.buyPressurePct) : null, uniqueBuyers: tr?.uniqueBuyers ?? null, netBuyVolSol: tr ? Number(tr.netBuyVolSol.toFixed(2)) : null, extreme });
            } else {
              this.watched.delete(mint);
              w.candidate.bcVSol = bc.vSol; // hand off with the FRESH reserve
              w.candidate.confirmStats = { grownPct: Number(m.grownPct.toFixed(1)), accel: Number(m.accel.toFixed(2)), velSol: Number(m.velSol.toFixed(4)), ageSec: Math.round(m.ageSec), buyPressurePct: tr ? Math.round(tr.buyPressurePct) : undefined, uniqueBuyers: tr?.uniqueBuyers, netBuyVolSol: tr ? Number(tr.netBuyVolSol.toFixed(2)) : undefined };
              // Wash-trade metrics from the SAME tape read — no extra call. Stamped pre-entry so
              // they land in the trade record and can later be regressed against realised P&L.
              if (tr) w.candidate.washStats = { bothSidesPct: tr.bothSidesPct, tradesPerTrader: tr.tradesPerTrader, avgTradeSol: tr.avgTradeSol, washScore: tr.washScore };
              const tape = tr ? ` · buy ${tr.buyPressurePct.toFixed(0)}% · ${tr.uniqueBuyers} buyers · net ${tr.netBuyVolSol.toFixed(2)}◎` : " · tape n/a";
              // "→ gate+entry" was a LIE. Since the sniper-paradigm change in index.ts the
              // MomentumWatch callback only writes a `momentum-telemetry` record — it does not
              // enqueue, gate, or open anything. The console said otherwise on every line, which
              // is how a whole evening was spent believing this predicate drove our entries.
              ui.pass(`[momentum] CONFIRMED ${w.candidate.symbol ?? mint} — grown +${m.grownPct.toFixed(0)}% · vel ${m.velSol.toFixed(3)}◎/s · accel ${m.accel.toFixed(2)}×${tape} · ${m.ageSec.toFixed(0)}s → TELEMETRY ONLY (no entry)`);
              logRecord("events", { type: "momentum-confirm", mint, symbol: w.candidate.symbol, grownPct: Number(m.grownPct.toFixed(1)), accel: Number(m.accel.toFixed(2)), velSol: Number(m.velSol.toFixed(4)), ageSec: Math.round(m.ageSec), buyPressurePct: tr ? Math.round(tr.buyPressurePct) : undefined, uniqueBuyers: tr?.uniqueBuyers, netBuyVolSol: tr ? Number(tr.netBuyVolSol.toFixed(2)) : undefined, bothSidesPct: tr?.bothSidesPct, tradesPerTrader: tr?.tradesPerTrader, washScore: tr?.washScore });
              this.onConfirmed(w.candidate, m);
            }
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private drop(mint: string, w: Watched, reason: string): void {
    this.watched.delete(mint);
    logRecord("events", { type: "momentum-drop", mint, symbol: w.candidate.symbol, reason });
  }
}
