import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

mkdirSync(config.logDir, { recursive: true });

function day(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Append-only JSONL log — same durable, never-mutated pattern as the Solana project's logs. */
export function logRecord(stream: "trades" | "candles" | "events", record: unknown): void {
  try {
    const rec = { ts: new Date().toISOString(), ...(record as Record<string, unknown>) };
    appendFileSync(join(config.logDir, `${stream}-${day()}.jsonl`), JSON.stringify(rec) + "\n");
  } catch { /* best-effort */ }
}

export const ui = {
  info: (msg: string) => console.log(`\x1b[2m${msg}\x1b[0m`),
  pass: (msg: string) => console.log(`\x1b[32m${msg}\x1b[0m`),
  reject: (msg: string) => console.log(`\x1b[31m${msg}\x1b[0m`),
  warn: (msg: string) => console.warn(`\x1b[33m${msg}\x1b[0m`),
};
