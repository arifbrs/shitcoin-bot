/**
 * LIVE TRUTH — recompute every live trade from the chain, not from our own bookkeeping.
 *
 * WHY (audit, 2026-08-25). Three days of live trading were booked with two different, and both
 * wrong, definitions of "what this cost":
 *
 *   · until 2026-08-24T19:45 — a wallet-balance bracket taken around the swap. The `after` read
 *     sits outside the exec lock, so any other transaction landing in the gap was attributed to
 *     this trade. 100% of buys differed from their own order size; one 0.01 SOL buy booked
 *     0.0368, and a quarter booked LESS than they spent.
 *   · after it — the order size itself, while the sell leg kept its balance delta (which
 *     includes the ATA rent coming back). Every trade was flattered by about 0.0023 SOL, or
 *     20.6% of a 0.01 SOL clip. That is what turned a real −15.65% into a printed +1.71%.
 *
 * Neither is fixable in place, because the past records do not contain the missing number. But
 * the chain still does: a transaction's own pre/post balances are its effect and nothing
 * else's. This walks every signature we ever sent and rebuilds the ledger from them.
 *
 * The result is the ONLY dataset entitled to be compared against the paper simulator, which is
 * what `calibrateExecution()` at the bottom does — the simulator's optimism is measured, not
 * assumed, and the number it produces is the one `EXEC_REALISM_*` charges back in paper.
 *
 * Read-only. It sends nothing, signs nothing, and touches no position.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { poolTxWalletDelta } from "./execution/rpc.js";
import { botPubkey } from "./execution/wallet.js";

interface ExecRow {
  ts: string; type: string; tradeId?: string; mint?: string; symbol?: string | null;
  sig?: string; spentSol?: number; solReceived?: number | null; reason?: string;
  liveSizeSol?: number; tokens?: number; full?: boolean; netSol?: number; netPct?: number | null;
  heldSec?: number;
}

interface PaperClose {
  tradeId: string; reason: string; netExecutablePnlPct?: number; netExecutablePnlSol?: number;
  sizeSol?: number; heldSec?: number; peakPct?: number; cfg?: string;
}

interface TradeTruth {
  tradeId: string; mint: string; symbol: string | null; openedAt: string;
  reason: string;
  bookedSpent: number; bookedProceeds: number; bookedNet: number;
  realSpent: number | null; realProceeds: number | null; realNet: number | null;
  realNetPct: number | null;
  buySigs: number; sellSigs: number; unreadable: number;
  paperReason: string | null; paperNetPct: number | null; gapPts: number | null;
}

const CACHE = join(config.logDir, "live-truth-cache.json");

function loadCache(): Map<string, number | null> {
  try { return new Map(Object.entries(JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, number | null>)); }
  catch { return new Map(); }
}
function saveCache(m: Map<string, number | null>): void {
  writeFileSync(CACHE, JSON.stringify(Object.fromEntries(m)));
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* a torn last line is normal on a live file */ }
  }
  return out;
}

function filesMatching(prefix: string): string[] {
  return readdirSync(config.logDir).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl")).sort()
    .map((f) => join(config.logDir, f));
}

/** Resolve signatures against the chain, cached, with bounded concurrency. */
async function resolveAll(sigs: string[], cache: Map<string, number | null>): Promise<void> {
  const wallet = botPubkey();
  const todo = sigs.filter((s) => !cache.has(s));
  if (!todo.length) return;
  console.log(`  ${todo.length} signature belum pernah dibaca (dari total ${sigs.length}) — menanyakan chain...`);
  const CONCURRENCY = 6;
  let done = 0, i = 0;
  const worker = async (): Promise<void> => {
    while (i < todo.length) {
      const sig = todo[i++];
      if (!sig) return;
      cache.set(sig, await poolTxWalletDelta(sig, wallet));
      if (++done % 100 === 0) { console.log(`  ${done}/${todo.length}`); saveCache(cache); }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveCache(cache);
}

function pct(n: number | null): string {
  return n == null ? "  n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

async function main(): Promise<void> {
  console.log("═══════ LIVE TRUTH — pembukuan dihitung ulang dari chain ═══════\n");

  const exec = filesMatching("live-exec-").flatMap((f) => readJsonl<ExecRow>(f));
  const paper = new Map<string, PaperClose>();
  for (const r of filesMatching("paper-trades-").flatMap((f) => readJsonl<PaperClose & { action?: string }>(f))) {
    if (r.action === "CLOSE" && r.tradeId) paper.set(r.tradeId, r);
  }
  console.log(`sumber: ${exec.length} baris live-exec, ${paper.size} penutupan paper\n`);

  // Group every signature by trade.
  const trades = new Map<string, { buys: ExecRow[]; sells: ExecRow[]; settle: ExecRow | null }>();
  const at = (id: string) => {
    let t = trades.get(id);
    if (!t) { t = { buys: [], sells: [], settle: null }; trades.set(id, t); }
    return t;
  };
  for (const r of exec) {
    if (!r.tradeId) continue;
    if (r.type === "buy") at(r.tradeId).buys.push(r);
    else if (r.type === "sell") at(r.tradeId).sells.push(r);
    else if (r.type === "settled") at(r.tradeId).settle = r; // last one wins: it is cumulative
  }
  const filled = [...trades.entries()].filter(([, t]) => t.buys.length > 0);

  const cache = loadCache();
  const sigs = filled.flatMap(([, t]) => [...t.buys, ...t.sells].map((r) => r.sig).filter((s): s is string => !!s));
  await resolveAll(sigs, cache);

  const rows: TradeTruth[] = [];
  for (const [tradeId, t] of filled) {
    const b0 = t.buys[0];
    if (!b0) continue;
    let realSpent = 0, realProceeds = 0, unreadable = 0;
    for (const r of t.buys) {
      const d = r.sig ? cache.get(r.sig) : null;
      if (d == null) unreadable++; else realSpent += Math.abs(d);
    }
    for (const r of t.sells) {
      const d = r.sig ? cache.get(r.sig) : null;
      if (d == null) unreadable++; else realProceeds += d;
    }
    const readable = unreadable === 0 && realSpent > 0;
    const bookedSpent = t.buys.reduce((a, r) => a + (r.spentSol ?? 0), 0);
    const bookedProceeds = t.sells.reduce((a, r) => a + (r.solReceived ?? 0), 0);
    const p = paper.get(tradeId) ?? null;
    const realNet = readable ? realProceeds - realSpent : null;
    const realNetPct = realNet != null ? (realNet / realSpent) * 100 : null;
    rows.push({
      tradeId, mint: b0.mint ?? "", symbol: b0.symbol ?? null, openedAt: b0.ts,
      reason: t.settle?.reason ?? "UNSETTLED",
      bookedSpent, bookedProceeds, bookedNet: bookedProceeds - bookedSpent,
      realSpent: readable ? realSpent : null, realProceeds: readable ? realProceeds : null,
      realNet, realNetPct,
      buySigs: t.buys.length, sellSigs: t.sells.length, unreadable,
      paperReason: p?.reason ?? null,
      paperNetPct: p?.netExecutablePnlPct ?? null,
      gapPts: realNetPct != null && p?.netExecutablePnlPct != null ? realNetPct - p.netExecutablePnlPct : null,
    });
  }

  const good = rows.filter((r) => r.realNet != null);
  const bs = good.reduce((a, r) => a + r.bookedSpent, 0);
  const bp = good.reduce((a, r) => a + r.bookedProceeds, 0);
  const rs = good.reduce((a, r) => a + (r.realSpent ?? 0), 0);
  const rp = good.reduce((a, r) => a + (r.realProceeds ?? 0), 0);

  console.log(`\n=== ${good.length} trade terbaca penuh dari chain (${rows.length - good.length} tidak lengkap) ===`);
  console.log("                 dibukukan        NYATA (chain)");
  console.log(`belanja          ${bs.toFixed(4)} SOL       ${rs.toFixed(4)} SOL`);
  console.log(`hasil jual       ${bp.toFixed(4)} SOL       ${rp.toFixed(4)} SOL`);
  console.log(`net              ${(bp - bs).toFixed(4)} SOL      ${(rp - rs).toFixed(4)} SOL`);
  console.log(`EV per trade     ${pct((bp / bs - 1) * 100)}          ${pct((rp / rs - 1) * 100)}`);
  console.log(`\nselisih pembukuan: ${((bp - bs) - (rp - rs)).toFixed(4)} SOL — inilah untung yang tidak pernah ada.`);

  console.log("\n=== PER SEBAB KELUAR (paper) — klaim simulasi vs hasil nyata ===");
  const cal = calibrateExecution(good);
  console.log("sebab                n     paper      NYATA      selisih");
  for (const c of cal.perReason) {
    console.log(
      `${c.reason.padEnd(20)} ${String(c.n).padStart(4)}  ${pct(c.paperPct).padStart(9)}  ${pct(c.realPct).padStart(9)}  ${(c.gapPts >= 0 ? "+" : "") + c.gapPts.toFixed(1)} pts`,
    );
  }
  console.log(`\nSELURUH POPULASI     ${String(cal.n).padStart(4)}  ${pct(cal.paperPct).padStart(9)}  ${pct(cal.realPct).padStart(9)}  ${(cal.gapPts >= 0 ? "+" : "") + cal.gapPts.toFixed(1)} pts`);
  console.log(`median selisih: ${cal.medianGapPts.toFixed(1)} pts   (median ≈ 0 + rata-rata negatif = kerugiannya ada di EKOR, bukan di trade biasa)`);

  console.log("\n=== TABEL KALIBRASI — berapa persen klaim paper yang benar-benar cair ===");
  console.log("klaim paper          n     paper      NYATA    cair");
  for (const b of cal.bands) {
    const label = `${b.from === -Infinity ? "rugi" : b.from + "%"}..${b.to === Infinity ? "∞" : b.to + "%"}`;
    console.log(`${label.padEnd(20)} ${String(b.n).padStart(4)}  ${pct(b.paperPct).padStart(9)}  ${pct(b.realPct).padStart(9)}  ${(b.ratio * 100).toFixed(0).padStart(4)}%`);
  }

  const out = join(config.logDir, "live-truth.json");
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), calibration: cal, trades: rows }, null, 2));
  console.log(`\nditulis: ${out}`);
  console.log("angka kalibrasi di atas adalah yang dipakai EXEC_REALISM di paper — bukan tebakan.");
}

export interface ExecBand {
  /** Inclusive lower / exclusive upper bound on the paper claim, in percent. */
  from: number;
  to: number;
  n: number;
  paperPct: number;
  realPct: number;
  /** realPct / paperPct — the fraction of its own claim this band actually delivered. */
  ratio: number;
}

export interface ExecCalibration {
  n: number;
  paperPct: number;
  realPct: number;
  gapPts: number;
  medianGapPts: number;
  perReason: Array<{ reason: string; n: number; paperPct: number; realPct: number; gapPts: number }>;
  bands: ExecBand[];
}

/**
 * BAND EDGES. Chosen before looking at the fit, and kept coarse on purpose: the whole point is
 * to carry the SHAPE of the bias, and the shape turned out to be strongly non-linear — small
 * claimed gains do not survive execution at all, mid-range gains survive about half, and claims
 * above +100% survive barely a tenth. A single average haircut would have hidden all three.
 */
const BAND_EDGES = [-Infinity, 0, 10, 25, 50, 100, Infinity];

/**
 * How much better paper says a trade did than the chain says it did.
 *
 * SOL-weighted on purpose. An unweighted mean over percentages lets one 0.01 SOL lottery ticket
 * outvote a hundred real positions — which is precisely how the simulator came to advertise a
 * "+9.77% average" for a set of trades that lost money in every currency that exists.
 */
export function calibrateExecution(
  rows: Array<{ realSpent: number | null; realProceeds: number | null; realNetPct: number | null; paperNetPct: number | null; paperReason: string | null }>,
): ExecCalibration {
  const usable = rows.filter((r) => r.realNetPct != null && r.paperNetPct != null && r.realSpent);
  const wMean = (sel: (r: typeof usable[number]) => number): number => {
    const w = usable.reduce((a, r) => a + (r.realSpent ?? 0), 0);
    return w > 0 ? usable.reduce((a, r) => a + sel(r) * (r.realSpent ?? 0), 0) / w : 0;
  };
  const paperPct = wMean((r) => r.paperNetPct as number);
  const realPct = wMean((r) => r.realNetPct as number);
  const gaps = usable.map((r) => (r.realNetPct as number) - (r.paperNetPct as number)).sort((a, b) => a - b);
  const byReason = new Map<string, typeof usable>();
  for (const r of usable) {
    const k = r.paperReason ?? "UNKNOWN";
    const arr = byReason.get(k) ?? [];
    arr.push(r);
    byReason.set(k, arr);
  }
  const perReason = [...byReason.entries()]
    .map(([reason, arr]) => {
      const w = arr.reduce((a, r) => a + (r.realSpent ?? 0), 0);
      const pp = w > 0 ? arr.reduce((a, r) => a + (r.paperNetPct as number) * (r.realSpent ?? 0), 0) / w : 0;
      const rr = w > 0 ? arr.reduce((a, r) => a + (r.realNetPct as number) * (r.realSpent ?? 0), 0) / w : 0;
      return { reason, n: arr.length, paperPct: pp, realPct: rr, gapPts: rr - pp };
    })
    .sort((a, b) => b.n - a.n);
  const bands: ExecBand[] = [];
  for (let i = 0; i + 1 < BAND_EDGES.length; i++) {
    const from = BAND_EDGES[i] as number, to = BAND_EDGES[i + 1] as number;
    const arr = usable.filter((r) => (r.paperNetPct as number) >= from && (r.paperNetPct as number) < to);
    if (!arr.length) continue;
    const w = arr.reduce((a, r) => a + (r.realSpent ?? 0), 0);
    const pp = w > 0 ? arr.reduce((a, r) => a + (r.paperNetPct as number) * (r.realSpent ?? 0), 0) / w : 0;
    const rr = w > 0 ? arr.reduce((a, r) => a + (r.realNetPct as number) * (r.realSpent ?? 0), 0) / w : 0;
    // A band whose own claim rounds to nothing has no ratio to speak of — say so rather than
    // dividing by it and calling the result a calibration.
    bands.push({ from, to, n: arr.length, paperPct: pp, realPct: rr, ratio: Math.abs(pp) < 0.5 ? 1 : rr / pp });
  }
  return {
    n: usable.length, paperPct, realPct, gapPts: realPct - paperPct,
    medianGapPts: gaps.length ? (gaps[Math.floor(gaps.length / 2)] as number) : 0,
    perReason, bands,
  };
}

if (process.argv[1] && process.argv[1].includes("live-truth")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
