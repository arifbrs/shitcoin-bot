/**
 * Stable, collision-resistant ids for observation identity (decisionId, and anything else that
 * needs one). Time (base36) + a per-process monotonic sequence + a short random suffix: unique
 * within a process via the sequence, and unique across processes/restarts via time+random — no
 * database or shared counter file needed.
 *
 * Mirrors the format `PaperTrader` already uses inline for `tradeId`; kept as a separate,
 * importable function (rather than refactoring that inline call site) so it is independently
 * testable without pulling in the trader — and so `src/index.ts`, which runs `main()` at import
 * time, is never imported by a test.
 */
let seq = 0;

export function mintId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
