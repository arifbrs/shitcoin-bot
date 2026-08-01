/** Token-bucket rate limiter + fetch with timeout and 429 backoff. */

export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number, // tokens added per millisecond
  ) {
    this.tokens = capacity;
  }

  static perSecond(rps: number) {
    return new TokenBucket(Math.max(1, rps), rps / 1000);
  }

  static perMinute(rpm: number) {
    return new TokenBucket(Math.max(1, Math.ceil(rpm / 4)), rpm / 60_000);
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await sleep(Math.min(waitMs, 2_000));
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thrown when an endpoint rate-limits us, so callers can fail over instead of waiting. */
export class RateLimited extends Error {
  constructor(
    public readonly host: string,
    /** Provider response text, bounded by fetchJson(). Used only to distinguish quota exhaustion. */
    public readonly detail = "",
  ) {
    super(`rate limited by ${host}`);
  }
}

export interface FetchJsonOptions {
  bucket?: TokenBucket;
  headers?: Record<string, string>;
  body?: unknown; // if set, POST
  timeoutMs?: number;
  retries?: number;
  /** Throw RateLimited immediately on 429 instead of sleeping+retrying the same host. */
  failFastOn429?: boolean;
  /**
   * GHOST-REQUEST FIX (2026-07-28): an EXTERNAL deadline (e.g. the fast gate's ~2.5s wave) that
   * should cancel the underlying in-flight fetch the moment it fires — not just stop the CALLER
   * from waiting on it. Before this, gate.ts's withDeadline() raced this promise against a timer
   * with Promise.race: the loser (usually the RPC/HTTP call itself) kept running in the
   * background for its own full timeoutMs + retries (measured up to ~21s), silently holding one
   * of only 4 concurrent RPC slots the whole time even though the gate had already moved on and
   * made its decision without it. Passing the gate's own deadline signal in here lets a request
   * that's already lost the race actually stop, freeing its slot immediately instead of ~21s late.
   */
  signal?: AbortSignal;
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const { bucket, headers, body, timeoutMs = 10_000, retries = 3, failFastOn429 = false, signal: externalSignal } = opts;
  if (externalSignal?.aborted) throw new DOMException("aborted before first attempt", "AbortError");
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) throw new DOMException("aborted", "AbortError");
    if (bucket) await bucket.take();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onExternalAbort = () => ctrl.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        // A 429 means THIS endpoint is refusing us — waiting on it is the wrong move when a
        // healthy fallback exists. MEASURED: our Helius free-tier credits ran out, so every real
        // method (getAccountInfo/getMultipleAccounts/getTokenSupply/getSignaturesForAddress) came
        // back 429 while only the uncharged getHealth succeeded. The old path slept retry-after
        // (≥1s, doubling) before finally throwing and letting the caller fail over — turning a
        // 322ms backup call into a ~3s one. That single delay is what made batch reads take 3.2s,
        // blinded open positions (priced at 19% of the 4s cadence) and inflated entry latency.
        // Now: surface it immediately so the caller switches endpoints.
        if (failFastOn429) {
          // Preserve a small, bounded copy of the provider's public error body. The endpoint
          // pool needs it to distinguish a short burst throttle from an explicit daily/monthly
          // quota exhaustion; treating both as the same 90-second cooldown repeatedly puts a
          // known-dead endpoint back on the latency-critical entry path.
          const detail = (await res.text().catch(() => "")).slice(0, 500);
          throw new RateLimited(new URL(url).host, detail);
        }
        const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      return (await res.json()) as T;
    } catch (err) {
      // A rate-limit is not a transient error to back off from — the caller wants to switch
      // endpoints NOW. Without this rethrow the throw above would be swallowed here, slept on,
      // and retried against the same refusing host: exactly the stall we are removing.
      if (err instanceof RateLimited) throw err;
      // The EXTERNAL deadline fired (not our own per-attempt timeoutMs) — that is the whole point
      // of this fix: stop here, don't sleep-and-retry a request the caller has already moved on
      // from. Rethrow immediately so the slot this held is freed right away.
      if (externalSignal?.aborted) throw err;
      lastErr = err;
      await sleep(500 * 2 ** attempt);
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
