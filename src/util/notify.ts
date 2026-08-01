import { config } from "../config.js";
import { logRecord, ui } from "./log.js";

/**
 * OPERATIONAL ALERTS (Telegram) — the missing piece for unattended 24/7.
 *
 * Everything else in this codebase reports into logs or the dashboard, both of which require you
 * to be LOOKING. For a bot that runs while you sleep the failure that matters is the one nobody
 * sees: the process died, the feed stalled, or the ledger stopped reconciling. This pushes those
 * few events out to you.
 *
 * Deliberately NARROW: operational health only, never per-trade noise. A channel that pings on
 * every trade gets muted within a day, and then it is worth nothing when something real breaks.
 *
 * Free and keyless beyond a bot token: create a bot with @BotFather, send it one message, read
 * your chat id from https://api.telegram.org/bot<TOKEN>/getUpdates. Unset = silently disabled.
 */
const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT = process.env.TELEGRAM_CHAT_ID?.trim();
export const notifyEnabled = Boolean(TOKEN && CHAT);

// De-dupe: a flapping condition must not turn into a message flood.
const lastSent = new Map<string, number>();
const MIN_REPEAT_MS = 15 * 60_000;

export type AlertKind = "startup" | "shutdown" | "crash" | "watchdog" | "integrity" | "halt";

/** Fire-and-forget operational alert. Never throws, never blocks trading. */
export function notify(kind: AlertKind, message: string, force = false): void {
  logRecord("events", { type: "alert", kind, message });
  if (!notifyEnabled) return;
  const now = Date.now();
  if (!force && now - (lastSent.get(kind) ?? 0) < MIN_REPEAT_MS) return;
  lastSent.set(kind, now);
  const icon = { startup: "🟢", shutdown: "⚪️", crash: "🔴", watchdog: "🟠", integrity: "🟡", halt: "⛔️" }[kind];
  const text = `${icon} *${kind.toUpperCase()}*\n${message}\n\n\`cfg ${config.strategyVersion}\``;
  void fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "Markdown", disable_notification: kind === "startup" }),
  }).catch((e) => ui.warn(`[notify] telegram failed: ${(e as Error).message}`));
}

/**
 * Synchronous best-effort alert for the exit path. `notify()` is fire-and-forget, so on
 * process.exit() the request is killed before it leaves — this awaits it briefly instead, which
 * is the difference between being told the bot crashed and finding out hours later.
 */
export async function notifySync(kind: AlertKind, message: string): Promise<void> {
  logRecord("events", { type: "alert", kind, message });
  if (!notifyEnabled) return;
  const icon = { startup: "🟢", shutdown: "⚪️", crash: "🔴", watchdog: "🟠", integrity: "🟡", halt: "⛔️" }[kind];
  try {
    await Promise.race([
      fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text: `${icon} *${kind.toUpperCase()}*\n${message}`, parse_mode: "Markdown" }),
      }),
      new Promise((r) => setTimeout(r, 3_000)), // never delay shutdown by more than this
    ]);
  } catch { /* best-effort */ }
}
