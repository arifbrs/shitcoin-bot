/** Exact identities and as-of joins. Unknown identities are excluded, never guessed. */
export function gmgnCohortKey(row: Record<string, unknown>): string | null {
  const chain = row.chain ?? "sol"; // Legacy strategy-2 source was explicitly Solana-only.
  const fields = [chain, row.mint, row.source, row.cfg, row.strategy2Epoch ?? row.epoch];
  if (fields.some((v) => typeof v !== "string" || !v || ["unknown", "?"].includes(v))) return null;
  return JSON.stringify(fields);
}

export function gmgnCandidateKey(row: Record<string, unknown>): string | null {
  const cohort = gmgnCohortKey(row), at = row.firstSeenAt;
  if (!cohort || typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  return JSON.stringify([cohort, at]);
}

export function exactCandidateMark(candidate: Record<string, unknown>, outcome: Record<string, unknown>): boolean {
  const key = gmgnCandidateKey(candidate);
  return key != null && key === gmgnCandidateKey(outcome) && typeof outcome.checkedAt === "number" &&
    Number.isFinite(outcome.checkedAt) && outcome.checkedAt >= (candidate.firstSeenAt as number);
}

export function latestAsOf<T extends { at: number }>(history: T[], at: number): T | null {
  let latest: T | null = null;
  for (const row of history) if (Number.isFinite(row.at) && row.at > 0 && row.at <= at && (!latest || row.at > latest.at)) latest = row;
  return latest;
}

export function walletIdentity(chain: string, wallet: string): string { return JSON.stringify([chain, chain === "sol" ? wallet : wallet.toLowerCase()]); }

export function validExactLedger(row: Record<string, unknown>): boolean {
  if (row.pairingVersion !== "gmgn-exact-v2" || !row.mark || typeof row.mark !== "object") return false;
  return exactCandidateMark(row, row.mark as Record<string, unknown>);
}
