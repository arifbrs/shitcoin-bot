/** Status paper 1:1 untuk dashboard — dibaca dari engine (bukan dari angka yang dikarang). */
import { existsSync, readFileSync } from "node:fs";
import { ledgerPath, loadState } from "./state.js";
import { loadCandidates } from "./scanner.js";

export async function paperStatus(): Promise<Record<string, unknown>> {
  const s = loadState();
  let closes: Array<Record<string, unknown>> = [];
  try {
    const f = ledgerPath();
    if (existsSync(f)) {
      closes = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => x !== null && x.action === "CLOSE");
    }
  } catch { /* tanpa ledger */ }
  return {
    engine: "rhpaper-1to1",
    version: s.version,
    cycles: s.cycles,
    candidates: loadCandidates().length,
    positions: (s.positions ?? []).map((p) => ({
      symbol: p.symbol, token: p.token,
      ageMin: Math.round((Date.now() - p.entryTs) / 60000),
      entryWeth: Number(p.entryWethRaw) / 1e18,
      stuck: Boolean(p.stuck), stuckReason: p.stuckReason ?? null,
    })),
    byArm: (() => {
      const m: Record<string, { open: number; closed: number; stuck: number }> = {};
      for (const p of s.positions ?? []) { const a = p.arm ?? "?"; (m[a] ??= { open: 0, closed: 0, stuck: 0 }).open++; if (p.stuck) m[a].stuck++; }
      for (const c of closes) { const a = String((c as Record<string, unknown>).arm ?? "?"); (m[a] ??= { open: 0, closed: 0, stuck: 0 }).closed++; }
      return m;
    })(),
    closed: s.closed,
    stuck: s.stuck,
    closes: closes.slice(-10),
    rule: "fill = harga quote · exit wajib quote jual · gagal → STUCK",
    updatedAt: new Date().toISOString(),
  };
}
