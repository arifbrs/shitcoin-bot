/**
 * Merender PositionCard pada kasus nyata dan kasus tepi, lalu memeriksa hal yang tidak boleh
 * terjadi: cincin penuh saat datanya tidak ada, glow merah pada posisi untung, dan angka NaN.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PositionCard } from "../src/components/panels/PositionCard";
import type { OpenPosition } from "../src/types/stats";

const base: OpenPosition = {
  mint: "x", symbol: "TEST", unrealizedPnl: 0, heldSec: 10,
  peakPct: 0, fromPeakPct: 0, trailPct: 6, budgetSec: 45, budgetLabel: "belum berkembang",
  sizeSol: 0.15, marketCap: 42_000, holders: 14,
} as OpenPosition;

const cases: Array<[string, OpenPosition]> = [
  ["rugi, jauh dari trail", { ...base, unrealizedPnl: -12, fromPeakPct: -2 }],
  ["rugi, HAMPIR trail", { ...base, unrealizedPnl: -31, fromPeakPct: -5.6 }],
  ["UNTUNG, hampir trail", { ...base, unrealizedPnl: 34, peakPct: 41, fromPeakPct: -5.4, trailPct: 6 }],
  ["waktu hampir habis", { ...base, unrealizedPnl: -3, heldSec: 41 }],
  ["tanpa field proximity", { mint: "x", symbol: "OLD", unrealizedPnl: 5, heldSec: 9 } as OpenPosition],
  ["puncak besar, trail lebar", { ...base, unrealizedPnl: 210, peakPct: 320, fromPeakPct: -26, trailPct: 45, budgetSec: 120, budgetLabel: "batas tahan" }],
];

// ── LEBAR: kartu harus selamat di kolom tersempit yang mungkin, bukan cuma di lebar preview.
// Versi pertama kartu ini dinilai pada 392px lalu dirender di sel grid 190px, dan persentasenya
// menembus badge di sebelahnya. Angka di bawah meniru aturan tata letaknya.
const W_MONO = 0.6;   // advance mono
const widthFits = (w: number, pos: OpenPosition): string[] => {
  const wide = w >= 300;
  const pad = 24, gap = 12;
  const ring = wide ? 62 : 52;
  const pctTxt = `${(pos.unrealizedPnl ?? 0) >= 0 ? "+" : "−"}${Math.abs(pos.unrealizedPnl ?? 0).toFixed(1)}%`;
  const rightW = Math.max(
    pctTxt.length * (wide ? 22 : 17) * W_MONO,
    pos.sizeSol != null ? 10 * 9.5 * W_MONO : 0,
    18 * 8.5 * W_MONO,
  );
  const middle = w - pad - ring - gap * 2 - rightW;
  const problems: string[] = [];
  if (middle < 46) problems.push(`kolom tengah tersisa ${middle.toFixed(0)}px`);
  if (rightW + ring + pad + gap * 2 > w) problems.push("angka besar menembus tepi");
  return problems;
};

let fail = 0;
for (const [name, pos] of cases) {
  const html = renderToStaticMarkup(<PositionCard position={pos} tag="S1" />);
  const bad: string[] = [];
  if (/NaN|undefined|Infinity/.test(html)) bad.push("ada NaN/undefined");
  const dashes = [...html.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)].map((m) => +m[1] / +m[2]);
  const noProx = pos.trailPct == null;
  if (noProx && dashes.some((d) => d > 0.01)) bad.push("cincin terisi padahal field proximity tidak ada");
  const up = (pos.unrealizedPnl ?? 0) >= 0;
  const glowUp = html.includes("--hud-up");
  const glowDown = html.includes("--hud-down");
  if (up && glowDown) bad.push("posisi UNTUNG diberi glow merah");
  if (!up && glowUp) bad.push("posisi RUGI diberi glow hijau");
  const hot = html.includes("tinggal");
  for (const w of [272, 300, 392, 520]) bad.push(...widthFits(w, pos).map((m) => `${w}px: ${m}`));
  if (bad.length) fail++;
  console.log(`  ${bad.length ? "✗" : "✓"} ${name.padEnd(24)} cincin ${dashes.map((d) => (100 * d).toFixed(0) + "%").join("/")}  ${hot ? "peringatan" : "tenang"}  ${bad.join(" | ")}`);
}
// kasus terburuk: angka terpanjang yang mungkin muncul
const huge = { ...base, unrealizedPnl: -1234.5, sizeSol: 0.15 } as OpenPosition;
const worst = [272, 300].flatMap((w) => widthFits(w, huge).map((m) => `${w}px: ${m}`));
console.log(`  ${worst.length ? "✗" : "✓"} ${"−1234.5% (terburuk)".padEnd(24)} ${worst.join(" | ")}`);
if (worst.length) fail++;
console.log(fail === 0 ? "  LULUS" : `  GAGAL ${fail}`);
process.exit(fail ? 1 : 0);
