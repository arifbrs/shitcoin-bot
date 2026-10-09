import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { readControl } from "../control.js";
import { solPriceUsd } from "./jupiter.js";
import {
  gmgnBuyLive, gmgnSellLive, jupiterBuyLive, jupiterSellLive, okxBuyLive, okxSellLive,
} from "./executor.js";
import { tokenBalanceOfOwner } from "../safety/onchain.js";
import { botWallet } from "./wallet.js";
import { withExecLock } from "../util/exec-lock.js";

/**
 * S2 LIVE MIRROR — the "1 inti" leg for Strategy 2 (owner, 2026-08-24).
 *
 * S2's paper brain (scout → papertrader, GMGN-quoted, read-only) picks tokens and sizes. When
 * the console switch is LIVE, this module executes the SAME decisions for real money via
 * the configured Jupiter/OKX/GMGN route — the exact pattern the S1 live-bridge established: one
 * brain, execution follows the mode. Paper bookkeeping is untouched; this keeps its OWN lot
 * ledger (logs/s2-live-lots.json).
 *
 * Deliberate MVP simplifications, stated honestly:
 *   · The mirror sells the bag the CHAIN says it holds at paper-close time — paper scale-outs
 *     are not mirrored tick-for-tick; the final close sweeps 100% of the real bag, so a bag can
 *     never be stranded by paper bookkeeping drift.
 *   · A paper FORCED WRITE-OFF (dead pool) still triggers a real sell attempt — the chain may
 *     disagree with GMGN's "no route", and the only way to know is to try.
 *   · ATA rent is NOT reclaimed yet (S1 does); noted as follow-up, cost ≈0.002◎/lot.
 */

const PATH = join(config.logDir, "s2-live-lots.json");

interface S2Lot {
  tradeKey: string; // mint — S2 holds one position per mint
  mint: string;
  symbol: string | null;
  openedAt: number;
  closedAt?: number;
  requestedUsd: number;
  spentSol?: number;
  tokens?: number;
  decimals?: number;
  proceedsSol?: number;
  rentReclaimedSol?: number;
  state: "opening" | "open" | "closing" | "closed" | "stuck";
  lastErr?: string | null;
  sells: Array<{ at: number; reason: string; tokens: number | "all"; solReceived: number | null; ok: boolean; err: string | null }>;
}

let lots = new Map<string, S2Lot>();
let expectedBalanceSol: number | null = null;
let inFlight = 0;
const queues = new Map<string, Promise<void>>();
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(PATH)) {
      const s = JSON.parse(readFileSync(PATH, "utf8")) as { lots?: S2Lot[]; expectedBalanceSol?: number | null };
      for (const l of s.lots ?? []) lots.set(l.tradeKey, l);
      expectedBalanceSol = typeof s.expectedBalanceSol === "number" ? s.expectedBalanceSol : null;
    }
  } catch { /* first run / unreadable → start cold */ }
}

function save(): void {
  try {
    writeFileSync(PATH, JSON.stringify({ lots: [...lots.values()], expectedBalanceSol }, null, 0));
  } catch (e) {
    ui.warn(`[s2-live] state save failed: ${(e as Error).message}`);
  }
}

function mirrorArmed(): boolean {
  return config.s2LiveEnabled && readControl().execMode === "live";
}

function deployedSol(): number {
  let sum = 0;
  for (const l of lots.values()) if (l.state === "open" || l.state === "opening") sum += l.spentSol ?? 0;
  return sum;
}

function enqueue(key: string, fn: () => Promise<void>): void {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch(() => { /* never surface into the paper loop */ });
  queues.set(key, next);
}

/** Called by strategy2-papertrader the moment a paper entry is BOOKED. */
export function s2MirrorOpen(p: { mint: string; symbol: string | null; sizeUsd: number; decimals?: number }): void {
  if (!mirrorArmed()) return;
  load();
  if (lots.has(p.mint)) return; // one live position per mint, ever
  enqueue(p.mint, () => doOpen(p).catch(() => {}));
}

/** Called when the paper brain closes the position (normal exit OR forced write-off). */
export function s2MirrorClose(mint: string, symbol: string | null, reason: string): void {
  if (!mirrorArmed()) return;
  load();
  enqueue(mint, () => doClose(mint, symbol, reason).catch(() => {}));
}

async function doOpen(p: { mint: string; symbol: string | null; sizeUsd: number; decimals?: number }): Promise<void> {
  load();
  if (lots.has(p.mint)) return;
  const sol = await solPriceUsd();
  if (!sol || sol <= 0) { ui.warn(`[s2-live] ${p.symbol ?? p.mint} open skipped — no SOL price`); return; }
  // Cap to the S2 per-trade limit; the paper size is a brain detail, the guardian caps are law.
  const sizeSol = Math.min(p.sizeUsd / sol, config.s2MaxPerTradeSol);
  if (sizeSol < 0.001) return; // dust guard — below fee noise
  const lot: S2Lot = { tradeKey: p.mint, mint: p.mint, symbol: p.symbol, openedAt: Date.now(), requestedUsd: p.sizeUsd, state: "opening", sells: [] };
  lots.set(p.mint, lot);
  save();
  inFlight++;
  try {
    const route = config.s2ExecRoute;
    const caps = { maxPerTradeSol: config.s2MaxPerTradeSol, maxDeployedSol: config.s2MaxDeployedSol };
    const r = await withExecLock(() => {
      if (route === "gmgn") return gmgnBuyLive(p.mint, sizeSol, deployedSol(), caps);
      if (route === "okx") return okxBuyLive(p.mint, sizeSol, deployedSol(), caps);
      return jupiterBuyLive(p.mint, sizeSol, deployedSol(), caps);
    });
    // SPEND EKSAK: input tx diketahui pasti (sizeSol) — delta saldo lintas-strategi tidak
    // dipakai lagi (lihat exec-lock: COTUS "+2709%" fantasi).
    lot.spentSol = r.ok ? sizeSol : (lot.spentSol ?? 0);
    if (r.ok) {
      // GMGN route reports the REAL received amount in its order report — prefer it; Jupiter
      // has no report, so the chain balance stays the source of truth there.
      const reported = route === "gmgn" ? r.tokensOut : undefined;
      const tokens = reported ?? (await tokenBalanceOfOwner(botWallet().publicKey.toBase58(), p.mint));
      lot.tokens = tokens ?? 0;
      lot.decimals = p.decimals ?? 6;
      lot.state = lot.tokens > 0 ? "open" : "stuck";
      lot.lastErr = lot.tokens > 0 ? null : "confirmed but no tokens observed";
    } else {
      lot.state = r.timedOut ? "stuck" : "closed";
      lot.lastErr = r.err ?? null;
    }
    save();
    logRecord("live-exec", {
      type: "s2-buy", strategyTag: "S2", route, tradeKey: p.mint, mint: p.mint, symbol: p.symbol,
      requestedUsd: p.sizeUsd, spentSol: Number((lot.spentSol ?? 0).toFixed(6)), tokens: lot.tokens ?? 0,
      sig: r.signature, timedOut: r.timedOut === true, err: r.err ?? null, confirmVia: r.confirmVia ?? null,
      confirmMs: r.confirmMs ?? null, buildMs: r.buildMs ?? null, txFormat: r.txFormat ?? null,
    });
    ui[r.ok ? "pass" : "reject"](`[s2-live] BUY ${p.symbol ?? p.mint} ${sizeSol.toFixed(4)} SOL → ${lot.tokens ?? 0} tok ${r.ok ? "" : `— ${r.err}`}`);
  } finally {
    inFlight--;
  }
}

async function doClose(mint: string, symbol: string | null, reason: string): Promise<void> {
  load();
  const lot = lots.get(mint);
  const owner = botWallet().publicKey.toBase58();
  const bag = await tokenBalanceOfOwner(owner, mint);
  if (!lot) {
    // No mirror lot (opened while disarmed?) — but a bag exists and live is armed: sell it anyway.
    if (mirrorArmed() && bag != null && bag > 0) await sellBag(mint, symbol, bag, reason, null);
    return;
  }
  if (lot.state === "closed") return;
  if (bag == null) { lot.lastErr = "bag unreadable — refusing to sell blind"; lot.state = "stuck"; save(); return; }
  if (bag <= 0) {
    lot.state = "closed"; lot.closedAt = Date.now(); save();
    logRecord("live-exec", { type: "s2-settled", strategyTag: "S2", tradeKey: mint, mint, symbol, reason: `${reason}_EMPTY`, netSol: Number(((lot.proceedsSol ?? 0) - (lot.spentSol ?? 0)).toFixed(6)) });
    return;
  }
  await sellBag(mint, symbol, bag, reason, lot);
}

async function sellBag(mint: string, symbol: string | null, bag: number, reason: string, lot: S2Lot | null): Promise<void> {
  inFlight++;
  try {
    const decimals = lot?.decimals ?? 6;
    // LOCK: sama seperti buy — delta proceeds tidak boleh disela tx strategi lain.
    const route = config.s2ExecRoute;
    const r = await withExecLock(() => {
      if (route === "gmgn") return gmgnSellLive(mint, bag, decimals);
      if (route === "okx") return okxSellLive(mint, bag, decimals);
      return jupiterSellLive(mint, bag);
    });
    const reportedSol = (r as { solOut?: number }).solOut;
    const { poolBalanceSol } = await import("./rpc.js");
    const after = await poolBalanceSol(botWallet().publicKey.toBase58());
    const got = reportedSol ?? (after != null && expectedBalanceSol != null ? Math.max(0, after - expectedBalanceSol) : null);
    if (after != null) { expectedBalanceSol = after; }
    const rec = { at: Date.now(), reason, tokens: "all" as const, solReceived: got, ok: r.ok, err: r.err ?? null };
    if (lot) { lot.sells.push(rec); lot.state = r.ok ? "closed" : "stuck"; if (r.ok) { lot.closedAt = Date.now(); } lot.lastErr = r.err ?? null; }
    save();
    logRecord("live-exec", {
      type: r.ok ? "s2-sell" : "s2-sell-failed", strategyTag: "S2", route, tradeKey: mint, mint, symbol, reason,
      tokens: bag, solReceived: got, sig: r.signature, timedOut: r.timedOut === true, err: r.err ?? null,
      confirmVia: r.confirmVia ?? null, confirmMs: r.confirmMs ?? null,
      buildMs: r.buildMs ?? null, txFormat: r.txFormat ?? null,
    });
    ui[r.ok ? "pass" : "reject"](`[s2-live] SELL ${symbol ?? mint} ALL ${reason} → ${got != null ? `${got.toFixed(6)} SOL` : "?"}`);
    if (lot && r.ok && got != null) {
      lot.proceedsSol = (lot.proceedsSol ?? 0) + got;
      lot.state = "closed"; lot.closedAt = Date.now();
      save();
      const net = (lot.proceedsSol ?? 0) + (lot.rentReclaimedSol ?? 0) - (lot.spentSol ?? 0);
      logRecord("live-exec", {
        type: "s2-settled", strategyTag: "S2", tradeKey: mint, mint, symbol, reason,
        spentSol: Number((lot.spentSol ?? 0).toFixed(6)), proceedsSol: Number((lot.proceedsSol ?? 0).toFixed(6)),
        netSol: Number(net.toFixed(6)), heldSec: Math.round((Date.now() - lot.openedAt) / 1000),
      });
    }
  } finally {
    inFlight--;
  }
}

/** Emergency flatten for the S2 mirror (console command path). Best-effort per bag. */
export async function s2MirrorFlatten(): Promise<number> {
  load();
  let n = 0;
  for (const l of [...lots.values()]) {
    if (l.state === "closed") continue;
    const bag = await tokenBalanceOfOwner(botWallet().publicKey.toBase58(), l.mint);
    if (bag != null && bag > 0) { await sellBag(l.mint, l.symbol, bag, "MANUAL_FLATTEN", l); n++; }
  }
  return n;
}

export function s2MirrorSummary(): { open: number; deployedSol: number; lots: number } {
  load();
  return { open: [...lots.values()].filter((l) => l.state !== "closed").length, deployedSol: deployedSol(), lots: lots.size };
}

export const __s2ResetForTest = (): void => { lots = new Map(); expectedBalanceSol = null; loaded = true; };
