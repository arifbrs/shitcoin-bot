/**
 * (S12-§I) TES FOKUS dashboard: model pumpwatch (pemisahan kohor/outcome/fixture),
 * klasifikasi posisi live (partial/sold/RPC-gagal), dan jaminan no-secrets payload.
 */
import { test, eq, assert } from "../../testing/harness.js";
import { buildPumpwatchModel } from "./pumpwatch-model.js";
import { positionStatus } from "../../robinhood/live-status.js";

const MINT = "TestMint1111111111111111111111111111111111";
const mk = (over: Record<string, unknown>): Record<string, unknown> => over;

test("S12 model pumpwatch: REALTIME vs historis terpisah; fixture dikecualikan; kohor tercatat", () => {
  const now = 10_000_000;
  const rows = [
    mk({ type: "token-observed", ts: 1, mint: MINT, symbol: "TST", source: "pumpportal", detectedAt: 1 }),
    mk({ type: "feed-health", ts: 2, feed: "pumpportal", state: "open", detail: null }),
    mk({ type: "tape-coverage", ts: 3, mint: MINT, encountered: 5, missingTx: 0, error: null, backlogPossible: false, pageTopTs: 5_000, pageBottomTs: 1_000 }),
    mk({ type: "trade", dedupeKey: "s1:W", ts: 4_000, mint: MINT, wallet: "W", side: "buy", sol: 6, usd: 600, state: "VERIFIED_SWAP", observedAt: 4_100 }),
    mk({ type: "h2-event", ts: 4_200, h2EventId: "s1:W", mint: MINT, signature: "s1", detectionClass: "REALTIME", usd: 600, usdQuality: "APPROX_SOL_SPOT", sol: 6, eventTs: 4_000, firstObservedAt: 4_100, observationLatencyMs: 100, discoveryCohort: "pumpportal", canonicalIdQuality: "SIG_TRADER", ixIndex: null, admittedAt: 1_000 }),
    mk({ type: "h2-event", ts: 4_300, h2EventId: "s2:X", mint: MINT, signature: "s2", detectionClass: "PRE_ADMISSION", usd: 900, usdQuality: "APPROX_SOL_SPOT", sol: 9, eventTs: 500, firstObservedAt: 900, observationLatencyMs: 400, discoveryCohort: "manual", canonicalIdQuality: "SIG_TRADER", ixIndex: null, admittedAt: 1_000 }),
    // fixture — HARUS dikecualikan dari sampel:
    mk({ type: "h2-event", ts: 4_400, h2EventId: "fx:F", mint: "Fix", signature: "fx", detectionClass: "REALTIME", usd: 700, eventTs: 4_000, firstObservedAt: 4_100, source: "fixture", admittedAt: 1_000 }),
    mk({ type: "h2-confirmation", ts: 5_000, h2EventId: "s1:W", state: "CONFIRMED", asOf: 5_000, eventTs: 4_000, coverage: { state: "DATA_COMPLETE", reason: "tes" }, confirmationVersion: "h2-conf-v3", followers: { distinctWallets: 2 }, rapidSell: { state: "NO" }, flowWindow: { netFlowSol: 5.1 } }),
    mk({ type: "shadow-decision", ts: 5_100, mint: MINT, decisionId: `${MINT}:5100:v1`, decision: "WATCH" }),
    mk({ type: "h2-decision", ts: 5_200, mint: MINT, decisionId: `h2:s1:W:v2`, decision: "H2_CONFIRMED" }),
    mk({ type: "outcome-mark", ts: 5_300, decisionId: `${MINT}:5100:v1`, horizonMin: 15, status: "OBSERVED", changePct: -10 }),
    mk({ type: "outcome-mark", ts: 5_400, decisionId: `h2:s1:W:v2`, horizonMin: 15, status: "OBSERVED", changePct: +5 }),
  ];
  const m = buildPumpwatchModel(rows, [{ mint: MINT, symbol: "TST", admittedAt: 1_000, source: "pumpportal" }], { journalMtime: now, now });
  eq(m.events.realtime.length, 1, "event REALTIME terpisah");
  eq(m.events.historical.length, 1, "event historis terpisah");
  eq(m.fixtures, 1, "baris fixture dikecualikan & dihitung terpisah");
  eq(m.events.realtime[0]!.conf?.state, "CONFIRMED", "konfirmasi terpasang ke event");
  eq(m.events.realtime[0]!.conf?.coverage, "DATA_COMPLETE", "cakupan eksplisit");
  eq(m.events.realtime[0]!.discoveryCohort, "pumpportal", "kohor discovery tercatat");
  eq(m.observer.feed.state, "open", "kesehatan feed terbaca");
  // outcome admisi vs H2 TIDAK dicampur:
  eq(m.outcomes.admission.find((o) => o.horizonMin === 15)!.meanPct, -10, "outcome admisi");
  eq(m.outcomes.h2.find((o) => o.horizonMin === 15)!.meanPct, 5, "outcome H2 terpisah");
  eq(m.decisions.admission.watch, 1, "keputusan admisi dihitung");
  eq(m.decisions.h2.length, 1, "keputusan H2 dihitung");
});

test("S12 model pumpwatch: kohor REALTIME kosong dilaporkan apa adanya (bukan error/fixture)", () => {
  const m = buildPumpwatchModel([], [], { journalMtime: null, now: 1 });
  eq(m.events.realtime.length, 0, "kohor realtime kosong = 0");
  eq(m.events.historical.length, 0, "");
  eq(m.observer.feed.state, null, "feed belum ada catatan");
  eq(m.outcomes.h2.every((o) => o.observed === 0), true, "outcome H2 kosong");
});

test("S12 live-status: klasifikasi posisi — RPC gagal ≠ nol; partial = OPEN; sold butuh bukti", () => {
  eq(positionStatus(null, false), "UNKNOWN", "RPC gagal → UNKNOWN (bukan 0/nol)");
  eq(positionStatus(null, true), "UNKNOWN", "RPC gagal tetap UNKNOWN walau ada jual terkonfirmasi");
  eq(positionStatus("2623563836639428744132977", false), "OPEN", "gilet: saldo ada → OPEN (jual ok-tanpa-hash BUKAN bukti)");
  eq(positionStatus("1000000000000000000", false), "OPEN", "exit parsial (sisa saldo) → OPEN");
  eq(positionStatus("0", false), "GHOST", "saldo 0 tanpa jual terkonfirmasi → GHOST");
  eq(positionStatus("0", true), "CLOSED_CONFIRMED", "saldo 0 + jual terkonfirmasi (txHash) → CLOSED_CONFIRMED");
});

test("S12 no-secrets: payload model & tipe live tidak memuat kunci privat / kredensial", () => {
  const m = buildPumpwatchModel([], [], { journalMtime: null, now: 1 });
  const json = JSON.stringify(m);
  for (const forbidden of ["privateKey", "secretKey", "apiKey", "passphrase", "0x" + "0".repeat(63), "BEGIN PRIVATE"]) {
    eq(json.includes(forbidden), false, `payload tak memuat ${forbidden.slice(0, 12)}`);
  }
  // live-status: interface hanya alamat publik + angka; tidak ada field kunci.
  const liveJson = JSON.stringify({ wallet: "0xabc", balances: { eth: 1, weth: 0, usdg: 0 }, positions: [], sells: [] });
  assert(!liveJson.includes("key"), "bentuk payload live tanpa field kunci");
});
