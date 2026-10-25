/**
 * (S12) PUMPWATCH VIEW MODEL — reduksi jurnal pump-caller → payload dashboard, MURNI.
 *
 * Dibangun dari baris jurnal yang SUDAH ada (token-observed / feed-health / tape-coverage /
 * trade / h2-event / h2-confirmation / h2-decision / shadow-decision / outcome-mark) +
 * watchlist.json. Tidak ada IO di sini — server meng-cache hasil (incremental via mtime,
 * lihat server.ts) dan memanggil ulang reduktor hanya saat file berubah.
 *
 * Pemisahan jujur (sprint §B/H):
 *  - event REALTIME vs PRE_ADMISSION/BACKFILL terpisah; hanya REALTIME yang prospektif;
 *  - window konfirmasi DATA_COMPLETE vs tidak terpisah; tanpa bukti cakupan = bukan definitif;
 *  - keputusan ADMISI (shadow-decision) vs keputusan PER-EVENT H2 (h2-decision) TIDAK dicampur;
 *  - fixture / baris pra-registrasi dikeluarkan dari sampel riset (dihitung terpisah).
 */
export interface PumpwatchEvent {
  h2EventId: string; mint: string; symbol: string | null; signature: string;
  detectionClass: "PRE_ADMISSION" | "BACKFILL" | "REALTIME";
  usd: number; usdQuality: string; sol: number;
  eventTs: number; firstObservedAt: number; observationLatencyMs: number | null;
  discoveryCohort: string | null; canonicalIdQuality: string; ixIndex: number | null;
  conf: { state: string; coverage: string | null; version: string | null; followers: number | null; rapidSell: string | null; netFlowSol: number | null; reason: string | null } | null;
  actionable: boolean; // REALTIME + konfirmasi definitif (konfirmasi/penolakan berbasis bukti)
}

export interface PumpwatchToken {
  mint: string; symbol: string | null; admittedAt: number; source: string;
  ageMin: number; lastObservedAt: number | null;
  tradeCount: number; distinctTraders: number; buySol: number; sellSol: number;
  largeBuys: number; smallSells: number; lastTradeTs: number | null;
  lastCandleTs: number | null; backlogPossible: boolean | null; coverageError: boolean;
}

export interface PumpwatchOutcome { horizonMin: number; observed: number; pending: number; missing: number; meanPct: number | null }

export interface PumpwatchModel {
  generatedAt: number;
  observer: {
    journalRows: number; journalMtime: number | null; staleSec: number | null;
    feed: { state: string | null; detail: string | null; ts: number | null };
    lastPassTs: number | null; lastTradeTs: number | null; lastCandleTs: number | null;
    backlogPasses: number; openGaps: number; coveragePasses: number;
    sourceLatencyMs: number | null; // feedLagMs token terakhir (pumpportal) — null bila tak ada
    detectionLatencyMs: number | null; // h2-event REALTIME terakhir (firstObserved−eventTs)
  };
  tokens: PumpwatchToken[];
  events: { realtime: PumpwatchEvent[]; historical: PumpwatchEvent[] };
  decisions: {
    admission: { total: number; skip: number; watch: number; paperEntry: number };
    h2: Array<{ decisionId: string; mint: string; decision: string; ts: number; priceAtDecision: number | null; usd: number | null; latencyMs: number | null }>;
  };
  outcomes: { admission: PumpwatchOutcome[]; h2: PumpwatchOutcome[] };
  paper: {
    counterfactual: Array<{ policy: string; n: number; meanNetPct: number | null }>;
    actionable: Array<{ policy: string; n: number; meanNetPct: number | null }>;
    note: string;
  };
  fixtures: number; // baris berlabel fixture — dikecualikan, dihitung terpisah
}

const asNum = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const asStr = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);

/** Reduksi murni — input: baris jurnal (urut waktu) + isi watchlist + timestamps. */
export function buildPumpwatchModel(
  rows: Array<Record<string, unknown>>,
  watchlist: Array<{ mint: string; symbol?: string; admittedAt: number; source: string; lastObservedAt?: number | null }>,
  fileMeta: { journalMtime: number | null; now: number },
): PumpwatchModel {
  const live = rows.filter((r) => r.source !== "fixture" && r.fixture !== true);
  const fixtures = rows.length - live.length;
  const symbols = new Map<string, string>();
  for (const r of live) if (r.type === "token-observed" && asStr(r.symbol)) symbols.set(String(r.mint), String(r.symbol));
  for (const w of watchlist) if (w.symbol && !symbols.has(w.mint)) symbols.set(w.mint, w.symbol);

  // ── Observer health ──
  const feedRows = live.filter((r) => r.type === "feed-health");
  const lastFeed = feedRows[feedRows.length - 1] ?? null;
  const cov = live.filter((r) => r.type === "tape-coverage");
  const tradeRows = live.filter((r) => r.type === "trade");
  const tradeBatches = live.filter((r) => r.type === "trade-batch");
  const h2Events = live.filter((r) => r.type === "h2-event");
  const realtimeEv = h2Events.filter((r) => r.detectionClass === "REALTIME");
  const feedLags = live.filter((r) => r.type === "token-observed" && r.source === "pumpportal" && typeof r.feedLagMs === "number").map((r) => Number(r.feedLagMs));
  const detLat = realtimeEv.filter((r) => typeof r.observationLatencyMs === "number").map((r) => Number(r.observationLatencyMs));
  const observer: PumpwatchModel["observer"] = {
    journalRows: rows.length,
    journalMtime: fileMeta.journalMtime,
    staleSec: fileMeta.journalMtime != null ? Math.max(0, Math.floor((fileMeta.now - fileMeta.journalMtime) / 1000)) : null,
    feed: { state: lastFeed ? String(lastFeed.state) : null, detail: asStr(lastFeed?.detail), ts: lastFeed ? asNum(lastFeed.ts) : null },
    lastPassTs: tradeBatches.length ? asNum(tradeBatches[tradeBatches.length - 1]!.ts) : null,
    lastTradeTs: tradeRows.length ? asNum(tradeRows[tradeRows.length - 1]!.ts) : null,
    lastCandleTs: null, // diisi dari candle-source / tape-coverage terbaru di bawah
    backlogPasses: cov.filter((r) => r.backlogPossible === true).length,
    openGaps: cov.filter((r) => r.backlogPossible === true && !((r.drain as { closed?: boolean })?.closed === true)).length,
    coveragePasses: cov.length,
    sourceLatencyMs: feedLags.length ? feedLags[feedLags.length - 1]! : null,
    detectionLatencyMs: detLat.length ? detLat[detLat.length - 1]! : null,
  };
  const candleRows = live.filter((r) => r.type === "candle-source" || r.type === "candle-snapshot");
  if (candleRows.length) observer.lastCandleTs = asNum(candleRows[candleRows.length - 1]!.ts);

  // ── Token monitoring (trade VERIFIED trader-side saja; pool-side tak dihitung riset) ──
  const seenDedupe = new Map<string, Record<string, unknown>>();
  for (const r of tradeRows) {
    if (r.state !== "VERIFIED_SWAP" || r.poolSide === true) continue;
    const k = String(r.dedupeKey);
    if (!seenDedupe.has(k)) seenDedupe.set(k, r); // baris pertama (observedAt awal)
  }
  const LARGE_USD = 500, SS_MIN = 5, SS_MAX = 100; // ambang beku (tampilan, bukan evaluasi baru)
  const tokAgg = new Map<string, PumpwatchToken>();
  for (const w of watchlist) {
    tokAgg.set(w.mint, { mint: w.mint, symbol: symbols.get(w.mint) ?? null, admittedAt: w.admittedAt, source: w.source,
      ageMin: Number(((fileMeta.now - w.admittedAt) / 60_000).toFixed(1)), lastObservedAt: w.lastObservedAt ?? null,
      tradeCount: 0, distinctTraders: 0, buySol: 0, sellSol: 0, largeBuys: 0, smallSells: 0, lastTradeTs: null, lastCandleTs: null, backlogPossible: null, coverageError: false });
  }
  const tradersPerMint = new Map<string, Set<string>>();
  for (const r of seenDedupe.values()) {
    const mint = String(r.mint);
    let t = tokAgg.get(mint);
    if (!t) { t = { mint, symbol: symbols.get(mint) ?? null, admittedAt: 0, source: "watchlist-lama", ageMin: 0, lastObservedAt: null, tradeCount: 0, distinctTraders: 0, buySol: 0, sellSol: 0, largeBuys: 0, smallSells: 0, lastTradeTs: null, lastCandleTs: null, backlogPossible: null, coverageError: false }; tokAgg.set(mint, t); }
    const usd = typeof r.usd === "number" ? r.usd : null;
    t.tradeCount++;
    if (r.wallet) { const s = tradersPerMint.get(mint) ?? new Set<string>(); s.add(String(r.wallet)); tradersPerMint.set(mint, s); }
    if (r.side === "buy") { t.buySol += asNum(r.sol); if (usd != null && usd >= LARGE_USD) t.largeBuys++; }
    else { t.sellSol += asNum(r.sol); if (usd != null && usd >= SS_MIN && usd <= SS_MAX) t.smallSells++; }
    t.lastTradeTs = Math.max(t.lastTradeTs ?? 0, asNum(r.ts));
  }
  for (const [mint, t] of tokAgg) t.distinctTraders = tradersPerMint.get(mint)?.size ?? 0;
  for (const c of cov) {
    const t = tokAgg.get(String(c.mint));
    if (!t) continue;
    t.backlogPossible = c.backlogPossible === true || t.backlogPossible === true;
    if (c.error != null) t.coverageError = true;
  }
  const tokens = [...tokAgg.values()].filter((t) => t.tradeCount > 0 || t.admittedAt > 0).sort((a, b) => b.lastTradeTs ?? 0 - (a.lastTradeTs ?? 0));

  // ── H2 events + konfirmasi terakhir per event ──
  const lastConf = new Map<string, Record<string, unknown>>();
  for (const r of live) if (r.type === "h2-confirmation") lastConf.set(String(r.h2EventId), r);
  const mkEvent = (r: Record<string, unknown>): PumpwatchEvent => {
    const c = lastConf.get(String(r.h2EventId)) ?? null;
    return {
      h2EventId: String(r.h2EventId), mint: String(r.mint), symbol: symbols.get(String(r.mint)) ?? null, signature: String(r.signature ?? ""),
      detectionClass: (r.detectionClass as PumpwatchEvent["detectionClass"]) ?? "BACKFILL",
      usd: asNum(r.usd), usdQuality: String(r.usdQuality ?? "?"), sol: asNum(r.sol),
      eventTs: asNum(r.eventTs ?? r.ts), firstObservedAt: asNum(r.firstObservedAt), observationLatencyMs: typeof r.observationLatencyMs === "number" ? Number(r.observationLatencyMs) : null,
      discoveryCohort: asStr(r.discoveryCohort), canonicalIdQuality: String(r.canonicalIdQuality ?? "?"), ixIndex: typeof r.ixIndex === "number" ? Number(r.ixIndex) : null,
      conf: c ? { state: String(c.state), coverage: asStr((c.coverage as { state?: string })?.state) ?? null, version: asStr(c.confirmationVersion), followers: typeof (c.followers as { distinctWallets?: number })?.distinctWallets === "number" ? Number((c.followers as { distinctWallets?: number }).distinctWallets) : null, rapidSell: asStr((c.rapidSell as { state?: string })?.state), netFlowSol: typeof (c.flowWindow as { netFlowSol?: number })?.netFlowSol === "number" ? Number((c.flowWindow as { netFlowSol?: number }).netFlowSol) : null, reason: asStr(c.reason) } : null,
      actionable: r.detectionClass === "REALTIME" && (c?.state === "CONFIRMED" || c?.state === "REJECTED"),
    };
  };
  const events = {
    realtime: realtimeEv.map(mkEvent).sort((a, b) => b.eventTs - a.eventTs),
    historical: h2Events.filter((r) => r.detectionClass !== "REALTIME").map(mkEvent).sort((a, b) => b.eventTs - a.eventTs),
  };

  // ── Keputusan ──
  const admDec = live.filter((r) => r.type === "shadow-decision");
  const h2Dec = live.filter((r) => r.type === "h2-decision");
  const decisions: PumpwatchModel["decisions"] = {
    admission: { total: admDec.length, skip: admDec.filter((r) => r.decision === "SKIP").length, watch: admDec.filter((r) => r.decision === "WATCH").length, paperEntry: admDec.filter((r) => r.decision === "PAPER_ENTRY").length },
    h2: h2Dec.map((r) => ({ decisionId: String(r.decisionId), mint: String(r.mint), decision: String(r.decision), ts: asNum(r.ts), priceAtDecision: typeof r.priceAtDecision === "number" ? Number(r.priceAtDecision) : null, usd: typeof r.usd === "number" ? Number(r.usd) : null, latencyMs: typeof r.observationLatencyMs === "number" ? Number(r.observationLatencyMs) : null })),
  };

  // ── Outcomes (reduceOutcomes terminal-only; pemisahan admission vs h2 via prefix decisionId) ──
  const states = new Map<string, { status: string; changePct: number | null }>();
  for (const r of live) {
    if (r.type !== "outcome-mark") continue;
    const key = `outcome:${String(r.decisionId)}:${String(r.horizonMin)}`;
    const status = String(r.status);
    const cur = states.get(key);
    if (cur && (cur.status === "OBSERVED" || cur.status === "MISSING_FINAL")) continue;
    states.set(key, { status, changePct: typeof r.changePct === "number" ? Number(r.changePct) : null });
  }
  const outcomeRows = (isH2: boolean): PumpwatchOutcome[] => {
    const horizons = [1, 5, 15, 60, 360, 1440, 2880];
    return horizons.map((h) => {
      const vals: number[] = []; let pending = 0, missing = 0;
      for (const [key, st] of states) {
        const m = /^outcome:(.*):(\d+)$/.exec(key);
        if (!m || Number(m[2]) !== h) continue;
        const idH2 = m[1]!.startsWith("h2:");
        if (idH2 !== isH2) continue;
        if (st.status === "OBSERVED" && st.changePct != null) vals.push(st.changePct);
        else if (st.status === "PENDING") pending++;
        else missing++;
      }
      return { horizonMin: h, observed: vals.length, pending, missing, meanPct: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : null };
    });
  };

  // ── Paper per-event (dari entryPoliciesFrom{Event,Decision} — kedua kelompok terpisah) ──
  const POL = ["IMMEDIATE_OBSERVED_ENTRY", "CONFIRM_AFTER_4X_1S_CANDLES", "CONFIRM_AFTER_4X_1M_CANDLES", "PULLBACK_WITH_BUYER_RECOVERY"];
  const paperGroup = (field: "entryPoliciesFromEvent" | "entryPoliciesFromDecision"): Array<{ policy: string; n: number; meanNetPct: number | null }> =>
    POL.map((pol) => {
      const nets: number[] = [];
      for (const d of h2Dec) {
        const eps = d[field] as Record<string, { availability?: string; evaluation?: { triggered?: boolean } }> | undefined;
        const pe = eps?.[pol];
        if (!pe || pe.availability !== "OK" || pe.evaluation?.triggered !== true) continue;
        // net dihitung server di report; utk tampilan ambil dari baris paper-h2 bila ada
        const pr = live.find((r) => r.type === "h2-paper" && r.decisionId === String(d.decisionId) && r.policy === pol && r.group === (field === "entryPoliciesFromEvent" ? "counterfactual" : "actionable") && typeof r.netPct === "number");
        if (pr) nets.push(Number(pr.netPct));
      }
      return { policy: pol, n: nets.length, meanNetPct: nets.length ? Number((nets.reduce((a, b) => a + b, 0) / nets.length).toFixed(2)) : null };
    });
  const paper: PumpwatchModel["paper"] = {
    counterfactual: paperGroup("entryPoliciesFromEvent"),
    actionable: paperGroup("entryPoliciesFromDecision"),
    note: "counterfactual = HIPOTETIS dari eventTs (bukan actionable); actionable = hanya setelah keputusan konfirmasi; entry pra-keputusan tak pernah dihitung",
  };

  return { generatedAt: fileMeta.now, observer, tokens: tokens.slice(0, 40), events, decisions, outcomes: { admission: outcomeRows(false), h2: outcomeRows(true) }, paper, fixtures };
}
