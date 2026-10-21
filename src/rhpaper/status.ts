/** Status paper 1:1 untuk dashboard — dibaca dari engine (bukan dari angka yang dikarang). */
import { existsSync, readFileSync } from "node:fs";
import { ledgerPath, loadState } from "./state.js";
import { loadCandidates } from "./scanner.js";
import { quoteSell } from "./exec.js";

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
    // PnL REALTIME = harga jual dari QUOTE (bisa dieksekusi), bukan harga mark.
    positions: await Promise.all((s.positions ?? []).map(async (p) => {
      const entryWeth = Number(p.entryWethRaw) / 1e18;
      let markWeth: number | null = null;
      let pnlPct: number | null = null;
      try {
        const q = await quoteSell(p.token, p.qtyRaw, process.env.BOT_WALLET || "0x629Ec42444A43A0E02A572587E3A49904542F4E8");
        if (q.ok && q.quote) {
          markWeth = Number(q.quote.amountOut) / 1e18;
          if (entryWeth > 0) pnlPct = ((markWeth - entryWeth) / entryWeth) * 100;
        }
      } catch { /* tanpa quote = tanpa angka */ }
      return {
        arm: p.arm ?? "?", symbol: p.symbol, token: p.token,
        ageMin: Math.round((Date.now() - p.entryTs) / 60000),
        entryWeth, markWeth, pnlPct,
        stuck: Boolean(p.stuck), stuckReason: p.stuckReason ?? null,
      };
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
