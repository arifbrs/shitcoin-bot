import type { AnalyticsResponse, CohortsResponse, ControlArmRow, ControlState, WalletInfo, WithdrawResult } from "@/types/stats";

/** POST to /api/control — patches paused/execMode/guardHalt/command/strategy2Command/risk. Returns the resulting ControlState. */
export async function postControl(patch: Record<string, unknown>): Promise<ControlState> {
  const res = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`control POST failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchAnalytics(cfg?: string): Promise<AnalyticsResponse> {
  const url = cfg ? `/api/analytics?cfg=${encodeURIComponent(cfg)}` : "/api/analytics";
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`analytics fetch failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchCohorts(): Promise<CohortsResponse> {
  const res = await fetch("/api/cohorts", { cache: "no-store" });
  if (!res.ok) throw new Error(`cohorts fetch failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchControlArm(): Promise<ControlArmRow[]> {
  const res = await fetch("/api/strategy2-control-arm", { cache: "no-store" });
  if (!res.ok) throw new Error(`control-arm fetch failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchWallet(): Promise<WalletInfo> {
  const res = await fetch("/api/wallet", { cache: "no-store" });
  if (!res.ok) throw new Error(`wallet fetch failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Real on-chain SOL transfer — never call this without the caller having already shown an
 * explicit confirmation UI (destination address + amount) and gotten the user to confirm THIS
 * specific transfer. This function itself performs no confirmation; that's a hard UI-layer
 * requirement, not something to shortcut for a smoother flow.
 */
export async function withdrawWallet(destination: string, amount: number | "all"): Promise<WithdrawResult> {
  const res = await fetch("/api/wallet/withdraw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ destination, amount }),
  });
  return res.json();
}

/**
 * Login stays a plain form-encoded POST to the EXISTING /login endpoint (unchanged backend logic
 * — rate limiting, lockout, cookie-session issuance) so the React login page is presentation-only.
 * Returns the raw Response so the caller can check status/redirect handling itself (fetch follows
 * redirects by default, so a successful login's final response.url will be /app).
 */
export async function loginRequest(password: string): Promise<Response> {
  const body = new URLSearchParams({ password });
  return fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, redirect: "follow" });
}
