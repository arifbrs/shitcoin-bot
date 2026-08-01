import WebSocket from "ws";
import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";
import type { Candidate } from "../types.js";

export interface NewTokenEvent {
  mint?: string;
  baseMint?: string;
  base_mint?: string;
  name?: string;
  symbol?: string;
  traderPublicKey?: string; // creator wallet on create events
  pool?: string; // "pump" | "bonk" | ...
  txType?: string; // "create"
  bondingCurveKey?: string;
  vSolInBondingCurve?: number;
  vTokensInBondingCurve?: number;
  marketCapSol?: number;
  uri?: string;
  solAmount?: number; // SOL the creator spent on their own buy inside the create tx
  is_mayhem_mode?: boolean;
  is_cashback_coin?: boolean;
  quote_mint?: string;
  quoteMint?: string;
  signature?: string;
}

export type NormalizedLaunch =
  | { ok: true; candidate: Candidate }
  | { ok: false; reason: "MISSING_BASE_MINT" | "MISSING_CREATE_METADATA" | "QUOTE_MINT_AS_BASE" };

const KNOWN_QUOTE_ASSETS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "So11111111111111111111111111111111111111112",   // wrapped SOL instruction account
]);

/**
 * PumpPortal's legacy feed has emitted create-v2 rows with USDC in `mint` while the unique
 * bonding-curve account belongs to an omitted base token. Treating those rows as USDC launches
 * collapses many real launches into one mint and corrupts every counterfactual join. Prefer an
 * explicit base-mint field when present; otherwise fail closed on a known quote asset.
 */
export function normalizeNewTokenEvent(msg: NewTokenEvent, detectedAt = Date.now()): NormalizedLaunch {
  const mint = msg.base_mint ?? msg.baseMint ?? msg.mint;
  if (!mint) return { ok: false, reason: "MISSING_BASE_MINT" };
  // A genuine Pump CreateEvent always carries name/symbol/URI. PumpPortal has mislabeled
  // collect_creator_fee_v2 transactions as txType=create while fabricating launch reserves;
  // those rows omit all three metadata fields. Reject the transaction class, not just USDC.
  if (!msg.name || !msg.symbol || !msg.uri) return { ok: false, reason: "MISSING_CREATE_METADATA" };
  if (KNOWN_QUOTE_ASSETS.has(mint)) return { ok: false, reason: "QUOTE_MINT_AS_BASE" };
  const vSol = msg.vSolInBondingCurve;
  const vTok = msg.vTokensInBondingCurve;
  return {
    ok: true,
    candidate: {
      source: "pumpportal",
      mode: "fast-follow",
      mint,
      name: msg.name,
      symbol: msg.symbol,
      creator: msg.traderPublicKey,
      pool: msg.pool ?? "pump",
      isMayhemMode: msg.is_mayhem_mode === true,
      isCashbackCoin: msg.is_cashback_coin === true,
      quoteMint: msg.quote_mint ?? msg.quoteMint,
      priceSol: vSol && vTok ? vSol / vTok : undefined,
      bondingCurveKey: msg.bondingCurveKey,
      bcVSol: vSol,
      marketCapSol: msg.marketCapSol,
      devInitialBuySol: msg.solAmount,
      metadataUri: msg.uri,
      detectedAt,
    },
  };
}

/**
 * Free, keyless real-time launch feed (RESEARCH.md §1).
 * Reconnects with backoff; PumpPortal allows one connection — do not open more.
 */
export function listenNewTokens(onCandidate: (c: Candidate) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoffMs = 1_000;
  let lastMsgAt = Date.now();
  // Staleness watchdog: a WS can go SILENT (stop delivering messages) WITHOUT firing
  // 'close'/'error' — a half-open socket. PumpPortal streams launches every few seconds,
  // so if we've heard nothing for STALE_MS the connection is dead → force a reconnect.
  // This is the fix for the feed silently dying and needing a manual restart.
  const STALE_MS = 45_000;
  const watchdog = setInterval(() => {
    if (closed) return;
    if (Date.now() - lastMsgAt > STALE_MS) {
      ui.warn(`[pumpportal] no messages for ${Math.round((Date.now() - lastMsgAt) / 1000)}s — connection stale, reconnecting`);
      lastMsgAt = Date.now(); // avoid rapid repeat
      try { ws?.terminate(); } catch { /* ignore */ } // terminate() fires 'close' → reconnect
    }
  }, 15_000);

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(config.pumpPortalWsUrl);

    ws.on("open", () => {
      backoffMs = 1_000;
      lastMsgAt = Date.now();
      ui.info("[pumpportal] connected — subscribing to new-token events");
      ws!.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      lastMsgAt = Date.now(); // heartbeat — any message keeps the connection "alive"
      let msg: NewTokenEvent;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if ((!msg.mint && !msg.baseMint && !msg.base_mint) || (msg.txType && msg.txType !== "create")) return;
      logRecord("events", { type: "launch", ...msg });
      const normalized = normalizeNewTokenEvent(msg);
      if (!normalized.ok) {
        logRecord("events", {
          type: "launch-schema-reject",
          reason: normalized.reason,
          rawMint: msg.mint ?? null,
          baseMint: msg.base_mint ?? msg.baseMint ?? null,
          quoteMint: msg.quote_mint ?? msg.quoteMint ?? null,
          bondingCurveKey: msg.bondingCurveKey ?? null,
          signature: msg.signature ?? null,
        });
        return;
      }
      onCandidate(normalized.candidate);
    });

    ws.on("close", () => {
      if (closed) return;
      ui.warn(`[pumpportal] disconnected — reconnecting in ${backoffMs / 1000}s`);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    });

    ws.on("error", (err: Error) => {
      ui.warn(`[pumpportal] error: ${err.message}`);
      ws?.close();
    });
  };

  connect();
  return () => {
    closed = true;
    clearInterval(watchdog);
    ws?.close();
  };
}
