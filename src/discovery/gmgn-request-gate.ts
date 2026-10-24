/** One upstream request at a time, including across cooldown wake-ups. No retries. */
export interface GmgnGateState { nextCallAt: number; cooldownUntil: number }

export class GmgnCooldownError extends Error {
  constructor(public readonly retryAt: number) {
    super(`GMGN cooldown until ${new Date(retryAt).toISOString()}; no upstream request sent`);
  }
}

export class GmgnAbandonedError extends Error {}

export function gmgnRetryAt(error: unknown, now: number): number | null {
  const e = error as { status?: number; apiError?: string; resetAtUnix?: number; message?: string } | null;
  const message = e?.message ?? String(error);
  if (e?.status !== 429 && !/HTTP 429|RATE_LIMIT/i.test(message)) return null;
  const reset = Number(e?.resetAtUnix);
  const remaining = Number(/~(\d+)s remaining/.exec(message)?.[1]);
  // A ban with no reliable reset must not fall back to a short 30-second retry.
  const fallback = /BANNED|RATE_LIMIT_BLOCKED/i.test(`${e?.apiError ?? ""} ${message}`) ? 300 : 30;
  const until = Number.isFinite(reset) && reset > 0 ? reset * 1000
    : now + (Number.isFinite(remaining) ? remaining : fallback) * 1000;
  return Math.max(now, until) + 5_000;
}

export class GmgnRequestGate {
  private tail: Promise<void> = Promise.resolve();
  private state: GmgnGateState;
  pending = 0;

  constructor(
    private readonly spacingMs = 10_000,
    initial: Partial<GmgnGateState> = {},
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly persist: (state: GmgnGateState) => void = () => {},
  ) {
    this.state = {
      nextCallAt: validTime(initial.nextCallAt),
      cooldownUntil: validTime(initial.cooldownUntil),
    };
  }

  snapshot(): GmgnGateState { return { ...this.state }; }

  async run<T>(fn: () => Promise<T>, abandoned: () => boolean = () => false): Promise<T> {
    if (this.state.cooldownUntil > this.now()) throw new GmgnCooldownError(this.state.cooldownUntil);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    this.pending++;
    await previous;
    try {
      this.check(abandoned);
      const wait = this.state.nextCallAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.check(abandoned);
      this.state.nextCallAt = this.now() + this.spacingMs;
      this.persist(this.snapshot());
      try {
        return await fn();
      } catch (error) {
        // This must happen even if the local caller disconnected while upstream was running.
        const retryAt = gmgnRetryAt(error, this.now());
        if (retryAt != null) {
          this.state.cooldownUntil = Math.max(this.state.cooldownUntil, retryAt);
          this.persist(this.snapshot());
        }
        throw error;
      }
    } finally {
      this.pending--;
      release();
    }
  }

  private check(abandoned: () => boolean): void {
    if (abandoned()) throw new GmgnAbandonedError("caller disconnected before dispatch; no upstream request sent");
    if (this.state.cooldownUntil > this.now()) throw new GmgnCooldownError(this.state.cooldownUntil);
  }
}

function validTime(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
