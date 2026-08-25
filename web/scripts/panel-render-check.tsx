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
process.exit(bad ? 1 : 0);
