/**
 * PER-ENDPOINT HEALTH PROBE — hits EVERY endpoint in the pool directly, one at a time, and
 * reports what each one actually answers right now.
 *
 * The pool's own rotation hides this: a call that succeeds tells you the pool worked, not which
 * keys are alive. Read-only (`getBalance`), free, and never prints an API key.
 */
import { config } from "./config.js";

function label(url: string): string {
  try {
    const u = new URL(url);
    const key = u.searchParams.get("api-key") ?? u.searchParams.get("apikey");
    const tail = key ? key.slice(-4) : u.pathname.split("/").filter(Boolean).pop()?.slice(-4) ?? "";
    return `${u.hostname}${tail ? `·${tail}` : ""}`;
  } catch { return "?"; }
}

async function probe(url: string): Promise<{ ok: boolean; ms: number; note: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["ayDYr5jGkV83e5ZN4bPZRWipUgtPzoBs2JZ1kqtkH8w"] }),
      signal: AbortSignal.timeout(12_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (res.status === 429) return { ok: false, ms, note: `429 ${/max usage/i.test(text) ? "QUOTA HABIS" : "throttled (burst)"}` };
    if (!res.ok) return { ok: false, ms, note: `HTTP ${res.status}` };
    let j: { result?: { value?: number }; error?: { message?: string } };
    try { j = JSON.parse(text); } catch { return { ok: false, ms, note: "unparseable body" }; }
    if (j.error) return { ok: false, ms, note: (j.error.message ?? "rpc error").slice(0, 40) };
    return { ok: true, ms, note: `${((j.result?.value ?? 0) / 1e9).toFixed(4)} SOL` };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, note: (e as Error).message.slice(0, 40) };
  }
}

async function main(): Promise<void> {
  console.log(`\n  ${config.rpcEndpoints.length} endpoint di pool (urutan = prioritas)\n`);
  let alive = 0;
  for (let i = 0; i < config.rpcEndpoints.length; i++) {
    const url = config.rpcEndpoints[i]!;
    const r = await probe(url);
    if (r.ok) alive++;
    console.log(`  ${String(i + 1).padStart(2)}. ${label(url).padEnd(42)} ${r.ok ? "✓" : "✗"} ${String(r.ms).padStart(5)}ms  ${r.note}`);
  }
  console.log(`\n  HIDUP: ${alive}/${config.rpcEndpoints.length}\n`);
}
void main().then(() => process.exit(0));
