import WebSocket from "ws";
import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";

/**
 * OKX OnchainOS DEX WebSocket client — wss://wsdex.okx.com/ws/v6/dex
 *
 * WHY THIS EXISTS AND THE REST ADAPTER IS NOT ENOUGH. The REST lane is bucketed at OKX_MAX_RPS
 * (default 1/s) and the entry gate's whole budget is ~2.5s, so REST can never sit in the hot
 * path — that constraint was the reason the earlier OKX plan concluded "radar only, post-entry".
 * That conclusion was drawn without knowing these streams exist. A subscription costs nothing per
 * event once connected, which puts two things back on the table that REST could not carry:
 *
 *   dex-market-memepump-new-token-openapi  → a launch feed that can be BENCHMARKED head-to-head
 *                                            against PumpPortal on detection lag.
 *   address-tracker-activity               → up to 200 wallets, the correct substrate for shadow
 *                                            copy trading. Polling 200 wallets over a 1 rps REST
 *                                            bucket would be a 200-second loop; as a stream it is
 *                                            push.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not feed the entry path, and it does not buy. Every
 * event is timestamped with `receivedAt` and written to the log. The reason is the lesson already
 * paid for with the GMGN smart-money lane: that signal looked predictive until it turned out most
 * of its buys landed AFTER our own entry — the causality ran backwards. A tracked-wallet feed has
 * exactly the same failure mode, so the ONLY number that can settle it is the gap between when the
 * wallet's transaction hit the chain and when WE learned of it. That gap is recorded on every
 * event as `detectLagMs`; without it, any copy backtest is measuring its own hindsight.
 */

const WS_URL = config.okx.wsUrl;
const apiKey = process.env.OKX_API_KEY?.trim() ?? "";
const secretKey = process.env.OKX_SECRET_KEY?.trim() ?? "";
const passphrase = process.env.OKX_API_PASSPHRASE?.trim() ?? "";

/** The nine documented channels. `pattern` says what the subscribe arg must carry. */
export const OKX_WS_CHANNELS = {
  "kol_smartmoney-tracker-activity":         { group: "signal",   pattern: "global",    desc: "smart money + KOL trade feed" },
  "address-tracker-activity":                { group: "signal",   pattern: "wallets",   desc: "activity for up to 200 tracked wallets" },
  "dex-market-new-signal-openapi":           { group: "signal",   pattern: "chain",     desc: "aggregated buy-signal alerts" },
  "dex-market-memepump-new-token-openapi":   { group: "trenches", pattern: "chain",     desc: "new meme-token launches" },
  "dex-market-memepump-update-metrics-openapi": { group: "trenches", pattern: "chain",  desc: "bonding-curve / metric updates" },
  price:                                     { group: "market",   pattern: "tokenPair", desc: "token price ticks" },
  "price-info":                              { group: "token",    pattern: "tokenPair", desc: "detailed price info" },
  trades:                                    { group: "token",    pattern: "tokenPair", desc: "per-token trade stream" },
  "dex-token-candle1m":                      { group: "market",   pattern: "tokenPair", desc: "1m candles (candle{period} family)" },
} as const;

export type OkxWsChannel = keyof typeof OKX_WS_CHANNELS;

export interface OkxWsEvent {
  channel: string;
  /** When THIS process saw it. The only clock we control, and the one copy analysis must use. */
  receivedAt: number;
  /** Event time as reported by OKX, when present. */
  sourceTs: number | null;
  /** receivedAt - sourceTs. Null when OKX sends no timestamp. See the header note on causality. */
  detectLagMs: number | null;
  data: Record<string, unknown>;
}

type Handler = (event: OkxWsEvent) => void;

/** OKX WS login signs `timestamp + 'GET' + '/users/self/verify'` — same HMAC/base64 as REST. */
function loginArgs(): Array<Record<string, string>> {
  const timestamp = String(Date.now() / 1000);
  const sign = createHmac("sha256", secretKey).update(`${timestamp}GET/users/self/verify`).digest("base64");
  return [{ apiKey, passphrase, timestamp, sign }];
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

export class OkxWsClient {
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectAt: NodeJS.Timeout | null = null;
  private attempts = 0;
  private loggedIn = false;
  private closed = false;
  /** Count of 60029s. Reaching the subscription count means this key has no stream access at all. */
  whitelistRejections = 0;
  private readonly handlers = new Set<Handler>();
  private readonly unavailableHandlers = new Set<(reason: string) => void>();
  private unavailableEmitted = false;
  private readonly subs: Array<Record<string, string>> = [];
  /** Counts per channel, so a stream that connects but never delivers is visible rather than
   *  looking identical to a stream that was never subscribed. */
  readonly counts = new Map<string, number>();

  constructor(private readonly label = "okx-ws") {}

  onEvent(fn: Handler): void { this.handlers.add(fn); }
  onUnavailable(fn: (reason: string) => void): void { this.unavailableHandlers.add(fn); }

  private emitUnavailable(reason: string): void {
    if (this.unavailableEmitted) return;
    this.unavailableEmitted = true;
    for (const fn of this.unavailableHandlers) {
      try { fn(reason); } catch { /* a fallback hook cannot break the socket */ }
    }
  }

  /** Queue a subscription. Safe before connect: args are replayed after every (re)login. */
  subscribe(channel: OkxWsChannel | string, args: Record<string, string> = {}): void {
    this.subs.push({ channel, ...args });
    if (this.loggedIn) this.send({ op: "subscribe", args: [{ channel, ...args }] });
  }

  subscribeMemepumpLaunches(chainIndex = "501"): void { this.subscribe("dex-market-memepump-new-token-openapi", { chainIndex }); }
  subscribeSignals(chainIndex = "501"): void { this.subscribe("dex-market-new-signal-openapi", { chainIndex }); }
  subscribeSmartMoney(): void { this.subscribe("kol_smartmoney-tracker-activity", {}); }
  /** OKX caps this at 200 addresses; the slice mirrors config.okx.trackedWallets. */
  subscribeWallets(wallets: string[]): void {
    this.replaceWallets(wallets);
  }

  /** Replace, rather than append, the address-tracker subscription after each radar sweep. */
  replaceWallets(wallets: string[]): void {
    const list = wallets.filter(Boolean).slice(0, 200);
    const previous = this.subs.filter((s) => s.channel === "address-tracker-activity");
    if (this.loggedIn) for (const arg of previous) this.send({ op: "unsubscribe", args: [arg] });
    for (let i = this.subs.length - 1; i >= 0; i--) {
      if (this.subs[i]?.channel === "address-tracker-activity") this.subs.splice(i, 1);
    }
    if (list.length === 0) return;
    const next = { channel: "address-tracker-activity", walletAddresses: list.join(",") };
    this.subs.push(next);
    if (this.loggedIn) this.send({ op: "subscribe", args: [next] });
  }

  connect(): void {
    if (this.closed) return;
    if (!config.okx.wsEnabled) { ui.warn(`[${this.label}] disabled (OKX_WS_ENABLED != true)`); return; }
    if (!apiKey || !secretKey || !passphrase) { ui.warn(`[${this.label}] missing credentials — not connecting`); return; }

    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    this.loggedIn = false;

    ws.on("open", () => {
      this.attempts = 0;
      this.whitelistRejections = 0;
      this.send({ op: "login", args: loginArgs() });
      // OKX expects a literal "ping" string every 25s and answers "pong". A JSON frame here is
      // NOT a heartbeat and the server will drop the socket ~30s later without saying why.
      this.heartbeat = setInterval(() => { try { ws.send("ping"); } catch { /* closing */ } }, 25_000);
    });

    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text === "pong") return;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(text) as Record<string, unknown>; } catch { return; }

      if (msg.event === "login") {
        const ok = String(msg.code ?? "0") === "0";
        this.loggedIn = ok;
        if (!ok) {
          ui.warn(`[${this.label}] login rejected: code ${msg.code} ${msg.msg ?? ""}`);
          this.emitUnavailable(`login rejected: ${msg.code ?? "unknown"}`);
          this.close();
          return;
        }
        ui.pass(`[${this.label}] connected + authenticated`);
        for (const arg of this.subs) this.send({ op: "subscribe", args: [arg] });
        return;
      }
      if (msg.event === "subscribe") { ui.info?.(`[${this.label}] subscribed ${JSON.stringify(msg.arg)}`); return; }
      if (msg.event === "error") {
        // 60029 = "Only users who are in the whitelist are allowed to subscribe to this channel."
        // MEASURED 2026-08-29: ALL NINE documented channels return this on a standard OnchainOS
        // key — including price and trades, not just the premium tracker feeds. This is an
        // account entitlement, not a bug and not a transient: retrying cannot fix it, and a
        // reconnect loop would just hide it behind an endlessly "connected" socket. So it is
        // counted, reported once with what to do about it, and the socket is left idle.
        if (String(msg.code) === "60029") {
          this.whitelistRejections++;
          if (this.whitelistRejections === 1) {
            ui.warn(`[${this.label}] channel rejected: NOT WHITELISTED (60029). OKX gates every DEX WS channel behind an account whitelist — request access via the OKX developer portal. Streams are unavailable until then; REST still works.`);
          }
          if (this.whitelistRejections >= this.subs.length && this.subs.length > 0) {
            ui.warn(`[${this.label}] all ${this.subs.length} subscriptions rejected — closing, nothing to listen for`);
            this.emitUnavailable("all subscriptions rejected: not whitelisted (60029)");
            this.close();
          }
          return;
        }
        ui.warn(`[${this.label}] error: code ${msg.code} ${msg.msg ?? ""}`);
        return;
      }

      const arg = (msg.arg ?? {}) as Record<string, unknown>;
      const channel = String(arg.channel ?? "unknown");
      const rows = Array.isArray(msg.data) ? (msg.data as Array<Record<string, unknown>>) : [];
      const receivedAt = Date.now();
      for (const row of rows) {
        const sourceTs = firstNumber(row, ["ts", "timestamp", "time", "blockTime", "tradeTime"]);
        // OKX mixes seconds and milliseconds across channels; anything below 1e12 is seconds.
        const sourceMs = sourceTs == null ? null : sourceTs < 1e12 ? sourceTs * 1000 : sourceTs;
        const event: OkxWsEvent = {
          channel,
          receivedAt,
          sourceTs: sourceMs,
          detectLagMs: sourceMs == null ? null : receivedAt - sourceMs,
          data: row,
        };
        this.counts.set(channel, (this.counts.get(channel) ?? 0) + 1);
        for (const h of this.handlers) {
          try { h(event); } catch (e) { ui.warn(`[${this.label}] handler threw: ${(e as Error).message}`); }
        }
      }
    });

    ws.on("close", () => { this.teardown(); this.scheduleReconnect(); });
    ws.on("error", (e) => { ui.warn(`[${this.label}] socket error: ${(e as Error).message}`); });
  }

  private send(payload: unknown): void {
    try { this.ws?.send(JSON.stringify(payload)); } catch { /* socket closing */ }
  }

  private teardown(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.loggedIn = false;
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempts++, 5));
    ui.warn(`[${this.label}] disconnected — reconnect in ${Math.round(delay / 1000)}s`);
    this.reconnectAt = setTimeout(() => this.connect(), delay);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectAt) clearTimeout(this.reconnectAt);
    const ws = this.ws;
    this.teardown();
    try { ws?.close(); } catch { /* already gone */ }
  }
}

/**
 * Default observatory wiring: connect, subscribe whatever OKX_WS_CHANNELS asks for, and write
 * every event to the log with its detection lag. No consumer, by design — the first job is to
 * find out whether these streams are fast and populated enough to be worth consuming at all.
 */
export function startOkxObservatory(): OkxWsClient | null {
  if (!config.okx.wsEnabled) return null;
  const client = new OkxWsClient("okx-ws");

  for (const ch of config.okx.wsChannels) {
    const spec = (OKX_WS_CHANNELS as Record<string, { pattern: string }>)[ch];
    if (!spec) { ui.warn(`[okx-ws] unknown channel "${ch}" — skipped`); continue; }
    if (spec.pattern === "chain") client.subscribe(ch, { chainIndex: "501" });
    else if (spec.pattern === "global") client.subscribe(ch, {});
    else if (spec.pattern === "wallets") client.subscribeWallets(config.okx.trackedWallets);
    else ui.warn(`[okx-ws] channel "${ch}" needs a token pair — subscribe it explicitly`);
  }

  client.onEvent((e) => {
    logRecord("events", {
      type: "okx-ws-event",
      channel: e.channel,
      detectLagMs: e.detectLagMs,
      sourceTs: e.sourceTs,
      data: e.data,
    });
  });

  client.connect();
  return client;
}
