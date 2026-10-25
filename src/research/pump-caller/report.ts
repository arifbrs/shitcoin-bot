/**
 * LAPORAN RISET PUMP-CALLER (sprint §10-12) — `npm run pump:report`.
 * FIXTURE DIKECUALIKAN dari seluruh sampel riset (dihitung terpisah + dilabel).
 * Trigger dari field terstruktur triggerIds (bukan teks bebas). Paper per policy
 * (no-look-ahead; net setelah biaya model; $3/$5) + cakupan/latensi/missing.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { read, reduceOutcomes } from "./journal.js";
import { watchDir } from "./watchlist.js";
import { OUTCOME_HORIZONS_MIN, type EntryPolicy, type PolicyEvaluation } from "./types.js";
import { paperForPolicy } from "./results.js";
import { loadCandles } from "./observer.js";
import { PUMP_PAPER_COST_V1 } from "./analyst.js";

const CANDLE_1M_MS = 60_000;

export function report(now = Date.now()): void {
  const j = read();
  const all = j.rows;
  const fixtures = all.filter((r) => r.source === "fixture" || r.fixture === true);
  const live = all.filter((r) => r.source !== "fixture" && r.fixture !== true);
  const decisions = live.filter((r) => r.type === "shadow-decision");
  // (S9-P0) laporan memakai STATE tereduksi (reduceOutcomes) - bukan baris event mentah.
  const marks = [...reduceOutcomes(live).values()].map((s) => ({ horizonMin: Number(s.key.split(":")[2]), status: s.status, changePct: s.changePct }));
  const tokens = live.filter((r) => r.type === "token-observed");
  const feedLags = tokens.map((t) => t.feedLagMs).filter((v): v is number => typeof v === "number" && v >= 0);

  const lines: string[] = ["=== LAPORAN RISET PUMP-CALLER - observasi nyata (fixture dikecualikan) ===", "",
    `jurnal live: ${live.length} baris - fixture: ${fixtures.length} baris (DIKECUALIKAN dari sampel) - rusak=${j.malformed} duplikat-dilewati=${j.duplicates}`,
    `token live teramati: ${tokens.length} - latensi feed: med=${med(feedLags) != null ? (med(feedLags)! / 1000).toFixed(1) + "s" : "?"} max=${feedLags.length ? (Math.max(...feedLags) / 1000).toFixed(1) + "s" : "?"}`,
    `keputusan bayangan live: ${decisions.length} (${JSON.stringify(tally(decisions, "decision"))}) - sosial: UNAVAILABLE (Developer API invitation-restricted; caller identity hanya KNOWN_WALLET_PROXY bila file operator ada)`];

  lines.push("", "-- Outcome harga (close candle SELESAI; PENDING->OBSERVED/MISSING_FINAL) --");
  for (const h of OUTCOME_HORIZONS_MIN) {
    const m = marks.filter((x) => Number(x.horizonMin) === h);
    const obs = m.filter((x) => x.status === "OBSERVED") as Array<{ changePct?: number }>;
    const pend = m.filter((x) => x.status === "PENDING").length;
    const fin = m.filter((x) => x.status === "MISSING_FINAL").length;
    if (!m.length) { lines.push(`  ${h}m: -`); continue; }
    const vals = obs.map((o) => Number(o.changePct)).filter(Number.isFinite);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    lines.push(`  ${h}m: OBS=${obs.length} PENDING=${pend} MISS_FINAL=${fin}${mean != null ? ` - mean=${mean.toFixed(2)}% (bruto harga)` : ""}`);
  }

  lines.push("", `-- Paper per policy (entry = close candle SELESAI pasca-trigger; biaya model ${PUMP_PAPER_COST_V1.roundTripOverheadPct}pp putaran; $3/$5) --`);
  const POLICIES: EntryPolicy[] = ["IMMEDIATE_OBSERVED_ENTRY", "CONFIRM_AFTER_4X_1S_CANDLES", "CONFIRM_AFTER_4X_1M_CANDLES", "PULLBACK_WITH_BUYER_RECOVERY"];
  for (const pol of POLICIES) {
    let n = 0; const nets: number[] = []; let skipped = 0; let mfeSum = 0, maeSum = 0, mfeN = 0;
    for (const d of decisions) {
      const eps = d.entryPolicies as Record<string, Record<EntryPolicy, PolicyEvaluation>> | undefined;
      for (const storeKey of ["1s", "1m"] as const) {
        const ev = eps?.[storeKey]?.[pol];
        if (!ev) continue;
        const store = loadCandles(String(d.mint));
        const intervalMs = storeKey === "1s" ? 1_000 : CANDLE_1M_MS;
        const pr = paperForPolicy({ decisionTs: Number(d.ts), priceAtDecision: Number(d.priceAtDecision ?? 0) }, ev, 15, store[storeKey], intervalMs, now);
        if (pr.triggered && pr.netPct != null) { n++; nets.push(pr.netPct); if (pr.mfePct != null) { mfeSum += pr.mfePct; mfeN++; } if (pr.maePct != null) maeSum += pr.maePct; }
        else skipped++;
      }
    }
    const mean = nets.length ? nets.reduce((a, b) => a + b, 0) / nets.length : null;
    lines.push(`  ${pol}: selesai=${n} terlewat/belum-matang=${skipped}${mean != null ? ` - net mean=${mean.toFixed(2)}% (horizon 15m)` : ""}${mfeN ? ` - MFE~${(mfeSum / mfeN).toFixed(1)}% MAE~${(maeSum / mfeN).toFixed(1)}%` : ""}`);
  }

  lines.push("", "-- Hipotesis (trigger TERSTRUKTUR dari keputusan; H1 BLOCKED_DATA tanpa caller terverifikasi) --");
  const trigCount = new Map<string, { fires: number; total: number }>();
  for (const d of decisions) {
    for (const t of (d.triggerIds as Array<{ id: string; fires: boolean }> | undefined) ?? []) {
      const e = trigCount.get(t.id) ?? { fires: 0, total: 0 };
      e.total++; if (t.fires) e.fires++;
      trigCount.set(t.id, e);
    }
  }
  for (const [id, c] of trigCount) lines.push(`  ${id}: fires ${c.fires}/${c.total}`);
  if (!trigCount.size) lines.push("  (belum ada keputusan live dengan trigger terstruktur)");

  // ── (S11) H2 EVENT-DRIVEN: event per large-buy, konfirmasi ber-window, keputusan per-event ──
  const h2Events = live.filter((r) => r.type === "h2-event");
  const h2Confs = new Map<string, Record<string, unknown>>();
  for (const r of live) if (r.type === "h2-confirmation") h2Confs.set(String(r.h2EventId), r);
  const h2Decisions = live.filter((r) => r.type === "h2-decision");
  if (h2Events.length || h2Decisions.length) {
    lines.push("", "-- H2 EVENT-DRIVEN (registrasi h2-event-v2; ambang beku $500/$1000 & $5–$100 tak diubah) --");
    const byCls: Record<string, number> = {};
    for (const e of h2Events) byCls[String(e.detectionClass)] = (byCls[String(e.detectionClass)] ?? 0) + 1;
    const byCohort: Record<string, number> = {};
    for (const e of h2Events) byCohort[String(e.discoveryCohort ?? "?")] = (byCohort[String(e.discoveryCohort ?? "?")] ?? 0) + 1;
    const lat = h2Events.map((e) => Number(e.observationLatencyMs)).filter((v) => Number.isFinite(v));
    const usdQ: Record<string, number> = {};
    for (const e of h2Events) usdQ[String(e.usdQuality)] = (usdQ[String(e.usdQuality)] ?? 0) + 1;
    const confStates: Record<string, number> = {};
    for (const c of h2Confs.values()) confStates[String(c.state)] = (confStates[String(c.state)] ?? 0) + 1;
    const confRows = live.filter((r) => r.type === "h2-confirmation");
    const dataIncomplete = confRows.filter((r) => r.dataComplete === false && r.flowWindow && (r.flowWindow as { complete?: boolean }).complete === true).length;
    const versions = new Set(confRows.map((r) => String(r.confirmationVersion ?? "h2-conf-v1")));
    lines.push(`event unik: ${h2Events.length} (klasifikasi ${JSON.stringify(byCls)}) - kohor discovery ${JSON.stringify(byCohort)}`,
      `konfirmasi (state terakhir): ${JSON.stringify(confStates)} - window-lewat-tapi-tanpa-data: ${dataIncomplete} - versi konfirmasi: ${[...versions].join(",")} - keputusan prospektif: ${h2Decisions.length} (hanya REALTIME)`,
      `latensi observasi: med=${lat.length ? (med(lat)! / 1000).toFixed(1) + "s" : "?"} max=${lat.length ? (Math.max(...lat) / 1000).toFixed(1) + "s" : "?"} (window registrasi v2 = 90s)`,
      `kualitas USD event: ${JSON.stringify(usdQ)} - kanonik ixIndex ${h2Events.filter((e) => e.canonicalIdQuality === "SIG_IX_TRADER").length}/${h2Events.length}`);
    // (S11.1) DUA kelompok paper — dilaporkan TERPISAH, tidak pernah dicampur:
    //   counterfactual = policy diukur dari eventTs (hipotetis awal; BUKAN actionable)
    //   actionable     = policy dari entryPoliciesFromDecision (setelah keputusan konfirmasi);
    //                    guard tambahan: entryTs < decisionTs tidak pernah dihitung actionable.
    const paperGroup = (label: string, field: "entryPoliciesFromEvent" | "entryPoliciesFromDecision", actionable: boolean): void => {
      const stats = new Map<EntryPolicy, { n: number; nets: number[]; guard: number }>();
      for (const d of h2Decisions) {
        const eps = d[field] as Record<string, { evaluation: PolicyEvaluation; interval: string; availability: string }> | undefined;
        if (!eps) continue;
        const store = loadCandles(String(d.mint));
        for (const pol of POLICIES) {
          const pe = eps[pol];
          if (!pe || pe.availability !== "OK") continue;
          const intervalMs = pe.interval === "1s" ? 1_000 : CANDLE_1M_MS;
          const pr = paperForPolicy({ decisionTs: Number(d.ts), priceAtDecision: Number(d.priceAtDecision ?? 0) }, pe.evaluation, 15, store[pe.interval as "1s" | "1m"], intervalMs, now);
          const st = stats.get(pol) ?? { n: 0, nets: [], guard: 0 };
          if (pr.triggered && pr.netPct != null) {
            if (actionable && pr.entryTs != null && pr.entryTs < Number(d.ts)) st.guard++; // tak mungkin: guard defensif
            else { st.n++; st.nets.push(pr.netPct); }
          }
          stats.set(pol, st);
        }
      }
      lines.push(`  ${label}:`);
      for (const [pol, st] of stats) {
        const mean = st.nets.length ? st.nets.reduce((a, b) => a + b, 0) / st.nets.length : null;
        lines.push(`    ${pol}: selesai=${st.n}${st.guard ? ` guard-kerja=${st.guard}` : ""}${mean != null ? ` net mean=${mean.toFixed(2)}% (horizon 15m, biaya model)` : ""}`);
      }
      if (!stats.size) lines.push(`    (belum ada policy OK utk dievaluasi)`);
    };
    paperGroup("paper COUNTERFACTUAL (diukur dari eventTs — HIPOTETIS, bukan actionable)", "entryPoliciesFromEvent", false);
    paperGroup("paper ACTIONABLE (entry hanya SETELAH keputusan konfirmasi)", "entryPoliciesFromDecision", true);
  }

  // (S11-P1) Kesehatan feed + celah sampling tape (kuota RPC dilaporkan, bukan disembunyikan)
  const feedRows = live.filter((r) => r.type === "feed-health");
  const lastFeed = feedRows[feedRows.length - 1];
  const cov = live.filter((r) => r.type === "tape-coverage");
  const missTx = cov.reduce((s2, r) => s2 + Number(r.missingTx ?? 0), 0);
  const covErr = cov.filter((r) => r.error != null).length;
  const backlog = cov.filter((r) => r.backlogPossible === true).length;
  lines.push("", "-- Kesehatan feed & celah sampling --",
    `pumpportal feed terakhir: ${lastFeed ? `${lastFeed.state} @${new Date(Number(lastFeed.ts)).toISOString().slice(11, 19)}${lastFeed.detail ? ` (${lastFeed.detail})` : ""}` : "tidak ada catatan"} - kohor discovery: pumpportal(real-time launch) ${live.filter((r) => r.type === "token-observed" && r.source === "pumpportal").length} vs gmgn-trending(backfill) ${live.filter((r) => r.type === "token-observed" && (r.source === "gmgn-trending" || r.source === "manual")).length} - KOHOR TERPISAH, tidak dicampur`,
    `celah tape on-chain: tx missing=${missTx} dari ${cov.length} pass; pass dgn error RPC=${covErr}; pass dgn BACKLOG MUNGKIN (encountered≥limit)=${backlog} - cakupan per-pass terbatas limit ${cov[0]?.limit ?? 12} sig; missing=0 BUKAN bukti cakupan penuh${backlog ? " - ada pass yang mungkin meninggalkan sig tak terambil" : ""}`);

  lines.push("", "-- Kualitas data --",
    `trades ditolak (timestamp invalid): ${live.filter((r) => r.type === "trade-rejected").length}`,
    `batch USD UNAVAILABLE (tanpa SOL/USD): ${live.filter((r) => r.type === "trade-batch" && r.usdQuality === "UNAVAILABLE_SOLUSD").length}`,
    `kandidat ditolak watchlist: ${rejectedCount()} (watchlist-rejected.jsonl)`,
    `biaya: model v1 = fee ${PUMP_PAPER_COST_V1.takerFeePct}% + slip ${PUMP_PAPER_COST_V1.slippagePct}% per sisi - PARAMETER RISET, belum terkalibrasi`);
  lines.push("", "SOSIAL: callout/follower/identitas caller Pump.fun = UNAVAILABLE (adapter Developer API dorman,",
    "BUKAN di jalur kritis). KNOWN_WALLET hanya bila known-wallets.json operator diisi.");
  console.log(lines.join("\n"));
  writeFileSync(join("logs", `pump-caller-report-${new Date(now).toISOString().slice(0, 10)}.md`), lines.join("\n") + "\n");
}

function med(a: number[]): number | null { return a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : null; }
function tally(rows: Array<Record<string, unknown>>, k: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of rows) c[String(r[k])] = (c[String(r[k])] ?? 0) + 1;
  return c;
}
function rejectedCount(): number {
  const f = join(watchDir(), "watchlist-rejected.jsonl");
  if (!existsSync(f)) return 0;
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length;
}

report();
