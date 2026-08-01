import WebSocket from "ws";
import { config } from "../config.js";
import { ui } from "../util/log.js";

/** Derive the RPC's WebSocket URL from the HTTP(S) endpoint. */
function wsUrl(): string {
  return config.rpcUrl.replace(/^http/i, "ws");
}

/**
 * Real-time dev-wallet watcher. Subscribes (Solana `logsSubscribe` with a
 * `mentions` filter) to each watched creator wallet over the RPC WebSocket, so
 * the moment a dev transacts we get a sub-second push — no 20s poll delay.
 * One shared connection, auto-reconnect + resubscribe. The paper trader still
 * keeps a slow poll as a backstop in case a push is ever missed.
 */
export class DevWatcher {
  private ws: WebSocket | null = null;
  private closed = false;
  private nextId = 1;
  private pending = new Map<number, string>(); // rpc request id -> creator (awaiting sub id)
  private subToCreator = new Map<number, string>(); // subscription id -> creator
  private creatorToSub = new Map<string, number>();
  private watched = new Set<string>(); // desired watches (for resubscribe on reconnect)
  private backoffMs = 1_000;

  constructor(private readonly onActivity: (creator: string) => void) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    this.ws = new WebSocket(wsUrl());
    this.ws.on("open", () => {
      this.backoffMs = 1_000;
      this.subToCreator.clear();
      this.creatorToSub.clear();
      this.pending.clear();
      for (const c of this.watched) this.sendSubscribe(c);
      if (this.watched.size) ui.info(`[devwatch] connected — watching ${this.watched.size} dev wallet(s) in real time`);
    });
    this.ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw.toString()));
    this.ws.on("close", () => {
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
    this.ws.on("error", () => this.ws?.close());
  }

  private sendSubscribe(creator: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const id = this.nextId++;
    this.pending.set(id, creator);
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "logsSubscribe",
        params: [{ mentions: [creator] }, { commitment: "processed" }],
      }),
    );
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; method?: string; params?: { subscription?: number } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const creator = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (typeof msg.result === "number") {
        this.subToCreator.set(msg.result, creator);
        this.creatorToSub.set(creator, msg.result);
      }
      return;
    }
    if (msg.method === "logsNotification") {
      const sub = msg.params?.subscription;
      const creator = sub !== undefined ? this.subToCreator.get(sub) : undefined;
      if (creator) this.onActivity(creator); // dev just transacted — re-check now
    }
  }

  watch(creator: string): void {
    if (this.watched.has(creator)) return;
    this.watched.add(creator);
    this.sendSubscribe(creator);
  }

  unwatch(creator: string): void {
    if (!this.watched.delete(creator)) return;
    const sub = this.creatorToSub.get(creator);
    if (sub !== undefined) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "logsUnsubscribe", params: [sub] }));
      }
      this.subToCreator.delete(sub);
      this.creatorToSub.delete(creator);
    }
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }
}
