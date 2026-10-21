/**
 * ENGINE paper 1:1 — aturan exit WAJIB punya quote jual. Gagal → STUCK (rugi nyata, tidak disembunyikan).
 * Harga fill = harga quote (exec.ts), biaya = fee pool 0,01% + gas nyata (dihitung saat laporan).
 */
import { quoteBuy, quoteSell } from "./exec.js";
import { loadCandidates, scanCandidates } from "./scanner.js";
import { appendLedger, emptyState, loadState, saveState, withLock, type Position } from "./state.js";

export interface Cfg { maker: string; usd: number; maxPositions: number; stopPct: number; tpHoldMin: number; takePct: number }

export function shouldExit(pnlPct: number, ageMin: number, cfg: Pick<Cfg, "stopPct" | "tpHoldMin" | "takePct">): string | null {
  if (pnlPct <= -Math.abs(cfg.stopPct)) return "stop";
  if (pnlPct >= Math.abs(cfg.takePct)) return "take";
  if (ageMin >= cfg.tpHoldMin) return "waktu";
  return null;
}

export async function cycle(cfg: Cfg): Promise<{ opened: number; closed: number; stuck: number; errors: string[] }> {
  const errors: string[] = [];
  return withLock(() => {
    // catatan: isi fungsi ini async → dibungkus promise agar lock tetap dilepas setelah selesai
    return (async () => {
      const s = loadState();
      s.cycles++;
      const today = new Date().toISOString().slice(0, 10);
      if (s.day !== today) { s.day = today; }
      let opened = 0, closed = 0, stuck = 0;

      // 1) EXIT — hanya boleh bila quote jual ada
      for (const p of s.positions) {
        if (p.stuck) continue;
        const sell = await quoteSell(p.token, p.qtyRaw, cfg.maker);
        if (!sell.ok) {
          p.stuck = true; p.stuckReason = sell.reason ?? "quote jual gagal";
          s.stuck++; stuck++;
          appendLedger({ ts: Date.now(), action: "STUCK", token: p.token, symbol: p.symbol, reason: p.stuckReason });
          continue;
        }
        const outWeth = Number(sell.quote!.amountOut) / 1e18;
        const entryWeth = p.entryUsd / 2361; // nilai WETH saat entry (dicatat di entryQuoteRef)
        const pnlPct = entryWeth > 0 ? ((outWeth - entryWeth) / entryWeth) * 100 : 0;
        const why = shouldExit(pnlPct, (Date.now() - p.entryTs) / 60000, cfg);
        if (why) {
          const pnlUsd = (outWeth - entryWeth) * 2361;
          s.positions = s.positions.filter((x) => x !== p);
          s.closed++; s.pnlUsd += pnlUsd; closed++;
          appendLedger({ ts: Date.now(), action: "CLOSE", token: p.token, symbol: p.symbol, why, pnlPct, pnlUsd, quoteRef: JSON.stringify(sell.quote) });
        }
      }

      // 2) ENTRY — hanya kandidat dua-arah, dan hanya bila quote beli ada
      if (s.positions.length < cfg.maxPositions) {
        let cands = loadCandidates();
        if (cands.length === 0) cands = await scanCandidates(cfg.maker, Math.max(1, cfg.maxPositions));
        for (const c of cands) {
          if (s.positions.length >= cfg.maxPositions) break;
          if (s.positions.some((p) => p.token === c.token)) continue;
          const usdRaw = String(BigInt(Math.floor((cfg.usd / 2361) * 1e18)));
          const buy = await quoteBuy(c.token, usdRaw, cfg.maker);
          if (!buy.ok) { errors.push(c.symbol + ": " + (buy.reason ?? "quote beli gagal")); continue; }
          const pos: Position = { token: c.token, symbol: c.symbol, entryTs: Date.now(), entryQuoteRef: JSON.stringify(buy.quote), entryUsd: cfg.usd, qtyRaw: buy.quote!.amountOut };
          s.positions.push(pos); opened++;
          appendLedger({ ts: Date.now(), action: "OPEN", token: c.token, symbol: c.symbol, usd: cfg.usd, qtyRaw: pos.qtyRaw, quoteRef: pos.entryQuoteRef });
        }
      }
      saveState(s);
      return { opened, closed, stuck, errors };
    })().finally(() => { /* lock dilepas oleh withLock */ }) as unknown as { opened: number; closed: number; stuck: number; errors: string[] };
  });
}
