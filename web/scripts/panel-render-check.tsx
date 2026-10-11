/**
 * PANEL RENDER CHECK — renders a panel to static HTML with the LIVE /api/stats payload and a few
 * null-shaped variants, then fails on any NaN/undefined/Infinity that reached the markup.
 *
 * Exists because "npm run build" passing and the route returning HTTP 200 both proved nothing:
 * a panel shipped this way still came out blank (a TypeError killed the script) and before that
 * came out as a file download (wrong content-type). Type-checking cannot catch either. This
 * executes the component for real.
 *
 * Usage:  curl -b cookie localhost:4317/api/stats > /tmp/st.json && npm run panel:check
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { EquityCurve } from "../src/components/panels/EquityCurve";
import { Hero } from "../src/components/panels/Hero";
import { LaneDex } from "../src/components/panels/LaneDex";
import { LaneOkxPaper } from "../src/components/panels/LaneOkxPaper";
import { ChartBars } from "../src/components/panels/CoinChart";
import { QualityCard } from "../src/components/panels/QualityCard";
import type { ChartCandleView } from "../src/types/stats";

const data = JSON.parse(readFileSync("/tmp/st.json", "utf8"));
const cases: Array<[string, any]> = [
  ["data asli", data],
  ["solUsd null", { ...data, combined: { ...data.combined, solUsd: null } }],
  ["equity kosong", { ...data, combined: { ...data.combined, equity: [] } }],
  ["s1 balanceUsd null", { ...data, combined: { ...data.combined, s1: { ...data.combined.s1, balanceUsd: null } } }],
  // Kasus pita: garis nol harus bergeser, bukan terpaku di tengah.
  ["pita semua turun", { ...data, combined: { ...data.combined, equity: [100, 96, 92, 88, 84, 80].map((b) => ({ bal: b })) } }],
  ["pita semua naik", { ...data, combined: { ...data.combined, equity: [100, 104, 108, 112, 116].map((b) => ({ bal: b })) } }],
  ["pita datar", { ...data, combined: { ...data.combined, equity: [100, 100, 100, 100].map((b) => ({ bal: b })) } }],
  ["pita 1 titik", { ...data, combined: { ...data.combined, equity: [{ bal: 100 }] } }],
  // REGRESI 2026-08-24: saldo live tak terbaca dulu dirender "$0.00" + pita merah semua —
  // memalsukan fakta bahwa dompet berisi 0.2751◎. Sekarang harus "tidak terbaca", tanpa $0.00.
  ["live saldo null", {
    ...data,
    liveBridge: { ...(data.liveBridge ?? {}), armed: true, walletSol: null },
    combined: { ...(data.combined ?? {}), s1: { ...(data.combined?.s1 ?? {}), balanceSol: null, floatSol: null, balanceUsd: null, floatUsd: null }, totalUsd: null, floatUsd: null, pnlUsd: null, equity: [] },
    paper: { ...(data.paper ?? {}), balanceSol: null, floatSol: null },
  }],
];
let bad = 0;
// Hero: tidak boleh ada satu pun tanda mata uang — Dompet yang memegang uang.
for (const [label, d] of [["hero data asli", data], ["hero tanpa launchField", { ...data, launchField: [] }], ["hero tanpa scan", { ...data, scan: [] }]] as Array<[string, any]>) {
  try {
    const html = renderToStaticMarkup(<Hero data={d} />);
    // Aturannya BUKAN "tidak boleh ada tanda dolar" — MC koin memang diminta tampil.
    // Yang dilarang adalah uang DOMPET: saldo gabungan dan P&L, yang sudah dipegang panel Dompet.
    const c = (d as any).combined ?? {};
    const forbidden = [c.totalUsd, c.pnlUsd, c.floatUsd, c.s1?.balanceUsd, c.s2?.balanceUsd]
      .filter((v: unknown): v is number => typeof v === "number")
      .map((v: number) => Math.abs(v).toFixed(2));
    const money = forbidden.some((f: string) => html.includes(f));
    const nan = /NaN|undefined|Infinity/.test(html);
    console.log(`  ${label.padEnd(20)} ${String(html.length).padStart(5)} byte · ${money ? "*** ADA UANG DOMPET ***" : "tanpa uang dompet"} · ${nan ? "*** RUSAK ***" : "bersih"}`);
    if (money || nan) bad++;
  } catch (e) { console.log(`  ${label.padEnd(20)} *** GAGAL: ${(e as Error).message.slice(0,60)}`); bad++; }
}
for (const [label, d] of cases) {
  try {
    const html = renderToStaticMarkup(<EquityCurve data={d} />);
    const nan = /NaN|undefined|Infinity|\$null/.test(html);
    if (label === "live saldo null") {
      const ok = html.includes("tidak terbaca") && !html.includes("$0.00");
      console.log(`  ${label.padEnd(20)} ${ok ? "✓ state tidak-terbaca, tanpa $0.00" : "*** MASIH $0.00 / tanpa pesan ***"}`);
      if (!ok) bad++;
      continue;
    }
    const rects = (html.match(/<rect/g) || []).length;
    const zero = html.match(/<line[^>]*y1="([\d.]+)"/)?.[1] ?? "-";
    // batang tertinggi & terendah, untuk membuktikan tinggi penuh terpakai
    const ys = [...html.matchAll(/<rect[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/g)].map((m) => [parseFloat(m[1]!), parseFloat(m[2]!)] as const);
    const top = ys.length ? Math.min(...ys.map(([y]) => y)).toFixed(1) : "-";
    const bot = ys.length ? Math.max(...ys.map(([y, h]) => y + h)).toFixed(1) : "-";
    console.log(`  ${label.padEnd(20)} ${String(rects).padStart(3)} batang · nol@${String(zero).padStart(5)} · terpakai ${String(top).padStart(5)}..${String(bot).padStart(5)} · ${nan ? "*** NILAI RUSAK ***" : "bersih"}`);
    if (nan) bad++;
  } catch (e) {
    console.log(`  ${label.padEnd(20)} *** GAGAL RENDER: ${(e as Error).message.slice(0, 60)}`);
    bad++;
  }
}
// LANE BARU (2026-10-08): DexScreener + OKX strict-paper. Kasus yang benar-benar bisa terjadi —
// state belum ada, WS belum melapor, ledger rusak, promosi dengan likuiditas tipis — harus
// dirender sebagai pernyataan yang jujur, bukan angka palsu.
const nowIso = new Date().toISOString();
const laneCases: Array<[string, string, any]> = [
  ["dex", "dex data asli", data.laneDex],
  ["dex", "dex state kosong", {
    updatedAt: nowIso, watchlistTotal: 0, seenTotal: 0, cycles24h: 0, lastCycle: null,
    ws: null, wsReconnects: 0, discovered: {}, metas: [], promotions: [], movers: [], quotaCost: 0,
  }],
  ["dex", "dex liq tipis", {
    updatedAt: nowIso, watchlistTotal: 2, seenTotal: 3, cycles24h: 1,
    lastCycle: { ts: nowIso, calls: 20, ms: 2100, watch: 2 },
    ws: { ts: nowIso, alive: 6, streams: "profiles=3msg/270row" }, wsReconnects: 1, discovered: { profiles: 3 },
    metas: [{ slug: "dog", tokens: 73, vol: 93_000_000 }],
    promotions: [{ chain: "solana", token: "Token111", amountUsd: 500, symbol: "TIPIS", liqUsd: 2_000, vol24: 5_000, chg24: -97 }],
    movers: [{ symbol: "TIPIS", chain: "solana", chg24: 8900, liqUsd: 0, vol24: 1_000 }],
    quotaCost: 0,
  }],
  ["okx", "okx data asli", data.laneOkxPaper],
  ["okx", "okx state kosong", {
    updatedAt: null, open: [], closedTotal: 0, pending: 0, scoutCache: 0, budget: null,
    primed: { scanner: false, ranking: false, signal: false, trackers: 0 },
    activity24h: {}, rejectReasons: [], recentCloses: [],
    ledger: { ok: true, records: 0, lastSeq: 0, error: null }, quotaCost: 0,
  }],
  ["okx", "okx ledger rusak", {
    ...(data.laneOkxPaper ?? {}),
    open: [], recentCloses: [], rejectReasons: [],
    ledger: { ok: false, records: 0, lastSeq: 0, error: "hash-chain break at line 7" },
  }],
];
for (const [which, label, d] of laneCases) {
  try {
    const html = which === "dex" ? renderToStaticMarkup(<LaneDex data={d} />) : renderToStaticMarkup(<LaneOkxPaper data={d} />);
    const nan = /NaN|undefined|Infinity/.test(html);
    const structureOk = which === "dex"
      ? html.includes("Promosi berbayar")
      : label === "okx ledger rusak" ? html.includes("RUSAK") : html.includes("ledger");
    console.log(`  ${label.padEnd(20)} ${String(html.length).padStart(5)} byte · ${structureOk ? "struktur ok" : "*** STRUKTUR HILANG ***"} · ${nan ? "*** NILAI RUSAK ***" : "bersih"}`);
    if (nan || !structureOk) bad++;
  } catch (e) {
    console.log(`  ${label.padEnd(20)} *** GAGAL RENDER: ${(e as Error).message.slice(0, 60)}`);
    bad++;
  }
}
// GRAFIK per koin (2026-10-08): kasus yang benar-benar bisa terjadi — harga datar (span 0), volume
// nol, dan lilin cuma satu — tidak boleh menghasilkan NaN di gambar.
const candleCase = (n: number, flat: boolean, zeroVol: boolean) => Array.from({ length: n }, (_, i) => ({
  t: 1_700_000_000_000 + i * 300_000, o: flat ? 1 : 1 + i * 0.01, h: flat ? 1 : 1.02 + i * 0.01,
  l: flat ? 1 : 0.99 + i * 0.01, c: flat ? 1 : 1.01 + i * 0.01, v: zeroVol ? 0 : 1000 + i,
}));
for (const [label, candles] of [
  ["chart 60 lilin", candleCase(60, false, false)],
  ["chart harga datar", candleCase(30, true, false)],
  ["chart volume nol", candleCase(30, false, true)],
  ["chart 1 lilin", candleCase(1, false, false)],
] as Array<[string, ChartCandleView[]]>) {
  try {
    const html = renderToStaticMarkup(<ChartBars candles={candles} />);
    const nan = /NaN|undefined|Infinity/.test(html);
    const bars = (html.match(/<rect/g) || []).length;
    console.log(`  ${label.padEnd(20)} ${String(bars).padStart(3)} batang · ${nan ? "*** NILAI RUSAK ***" : "bersih"}`);
    if (nan) bad++;
  } catch (e) {
    console.log(`  ${label.padEnd(20)} *** GAGAL RENDER: ${(e as Error).message.slice(0, 60)}`);
    bad++;
  }
}
// KARTU KUALITAS (2026-10-11): harus selamat pada data kosong, data hilang, dan angka rusak —
// kartu status yang menampilkan angka salah lebih buruk daripada kartu yang jujur kosong.
for (const [label, q] of [
  ["kualitas data asli", data.quality],
  ["kualitas belum ada", undefined],
  ["kualitas kosong", { day: data.quality?.day ?? "—", traceRows: 0, retention: [] }],
  ["kualitas angka rusak", { day: "x", traceRows: NaN, retention: [{ reason: "take_profit", n: NaN, p50: NaN, p10: Infinity, vanished: 1 }] }],
] as Array<[string, any]>) {
  try {
    const html = renderToStaticMarkup(<QualityCard data={q} />);
    const nan = /NaN|undefined|Infinity/.test(html);
    console.log(`  ${label.padEnd(20)} ${nan ? "*** NILAI RUSAK ***" : "bersih"}`);
    if (nan) bad++;
  } catch (e) {
    console.log(`  ${label.padEnd(20)} *** GAGAL RENDER: ${(e as Error).message.slice(0, 60)}`);
    bad++;
  }
}
process.exit(bad ? 1 : 0);
