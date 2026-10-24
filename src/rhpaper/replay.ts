/**
 * REPLAY TRADE SIM — REKONSTRUKSI PER VERSI MODEL (FINAL §3). OFFLINE.
 * Setiap CLOSE direkonstruksi SESUAI fillModelVersion yang tersimpan:
 *   v1 → jalur dua-potongan: simulatedExitWeth(exitQuote) = exitOut×(1−l)² (komposit v1, beku).
 *   v2 → jalur re-quote: quotePnl(entryWethRaw, exitSimFill.fillOutRaw) — exitSimFill adalah
 *        bukti eksekusi sim keluar yang dire-quote atas kuantitas sim entry (bukan komposit).
 *   quote-only (tanpa fillModelVersion) → net quote tersimpan, dihitung terpisah.
 *   invalid (sim setengah jalan / versi campur) → tidak dihitung metriknya.
 * Ketidakcocokan rekonstruksi vs nilai tersimpan → exit 1 (gerbang integritas gagal).
 * Output machine-readable terpisah per versi: logs/rh-replay-<tanggal>.json.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotePnl } from "./engine.js";
import { simulatedExitWeth } from "./fillmodel.js";

export interface ReplayRecord {
  tradeId: string; arm: string; symbol: string; token: string;
  fillModelVersion: string; bucket: "v1" | "v2" | "quote-only" | "invalid";
  openedAt: unknown; closedAt: unknown; why: string;
  entryWethRaw: string; exitQuoteWethRaw: string;
  replayNetWethRaw: string; replayNetPct: number;
  storedNetWethRaw: string | null; storedNetPct: number | null;
  consistent: boolean;
}

export function replay(dir = "logs/rhpaper", now = Date.now()): { ok: boolean; byVersion: Record<string, number>; mismatches: number; records: ReplayRecord[] } {
  const opens = new Map<string, Record<string, unknown>>();
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.includes('"action":"OPEN"')) continue;
    try { const j = JSON.parse(line) as Record<string, unknown>; if (j.tradeId) opens.set(String(j.tradeId), j); } catch { /* rusak */ }
  }
  const records: ReplayRecord[] = [];
  let mismatches = 0;
  for (const f of files) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.includes('"action":"CLOSE"')) continue;
    let c: Record<string, unknown>;
    try { c = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const o = opens.get(String(c.tradeId ?? ""));
    const entry = String(c.entryWethRaw ?? ""), exitQuote = String(c.exitWethRaw ?? "");
    if (!/^\d+$/.test(entry) || !/^\d+$/.test(exitQuote)) continue;
    const version = typeof c.fillModelVersion === "string" ? c.fillModelVersion : null;
    const xs = c.simFillExit as { filled?: boolean; fillOutRaw?: string; version?: string } | undefined;
    const es = o?.simFillEntry as { filled?: boolean; fillOutRaw?: string; version?: string } | undefined;
    let bucket: ReplayRecord["bucket"], replayNetWethRaw: string, replayNetPct: number;
    if (version === "rhpaper-fillmodel-v2" && es?.filled === true && xs?.filled === true && xs.fillOutRaw != null) {
      // v2: exitSimFill.fillOutRaw = bukti eksekusi sim keluar (re-quote kuantitas sim ×(1−l)).
      const r = quotePnl(entry, xs.fillOutRaw);
      bucket = "v2"; replayNetWethRaw = r.netWethRaw; replayNetPct = r.netPct;
    } else if (version === "rhpaper-fillmodel-v1" && es?.filled === true && xs?.filled === true) {
      // v1: komposit dua-potongan atas quote keluar penuh (dibekukan; jangan diubah).
      const r = quotePnl(entry, simulatedExitWeth(exitQuote).toString());
      bucket = "v1"; replayNetWethRaw = r.netWethRaw; replayNetPct = r.netPct;
    } else if (version == null) {
      const r = quotePnl(entry, exitQuote);
      bucket = "quote-only"; replayNetWethRaw = r.netWethRaw; replayNetPct = r.netPct;
    } else {
      bucket = "invalid"; replayNetWethRaw = "0"; replayNetPct = 0; // sim setengah jalan / versi campur
    }
    // Konsistensi = NILAI LEDGER harus terekonstrusi persis dari bukti mentahnya:
    // netWethRaw (bila tersimpan) === quotePnl(entry, exitQuote); netPct (bila ada) ≈ sama
    // (toleransi 1e-4 untuk baris presisi-4-desimal lama). Net SIM per versi dilaporkan
    // terpisah — v1/v2 tidak punya kembaran tersimpan, jadi tidak dibandingkan dengannya.
    const storedRaw = typeof c.netWethRaw === "string" && /^-?\d+$/.test(c.netWethRaw) ? c.netWethRaw : null;
    const storedPct = Number.isFinite(Number(c.netPct)) ? Number(c.netPct) : null;
    // (FINAL §3) Basis ditentukan oleh DATA, bukan string versi: baris yang MENYIMPAN netWethRaw
    // = basis net (gas dipotong — termasuk baris transisi tanpa measurementVersion); baris yang
    // hanya menyimpan netPct = basis gross v0 (netPct == grossPct di baris itu, terverifikasi).
    const quoteReplay = quotePnl(entry, exitQuote);
    const expectedPct = storedRaw != null
      ? quoteReplay.netPct
      : (Number(BigInt(exitQuote) - BigInt(entry)) / Number(entry)) * 100;
    let consistent = true;
    if (storedRaw != null && storedRaw !== quoteReplay.netWethRaw) consistent = false;
    // Toleransi 1,5e-4: baris v3 lama disimpan dengan formula 4-desimal (kuantum 1e-4, truncation
    // toward-zero utk negatif) + noise float — kesalahan riil ≥ 1 bp tetap tertangkap.
    if (storedPct != null && Math.abs(storedPct - expectedPct) > 1.5e-4) consistent = false;
    if (!consistent) mismatches++;
    records.push({ tradeId: String(c.tradeId ?? ""), arm: String(c.arm ?? "?"), symbol: String(c.symbol ?? "?"), token: String(c.token ?? "?"),
      fillModelVersion: version ?? "(none)", bucket, openedAt: o?.ts ?? null, closedAt: c.ts ?? null, why: String(c.why ?? "?"),
      entryWethRaw: entry, exitQuoteWethRaw: exitQuote, replayNetWethRaw, replayNetPct,
      storedNetWethRaw: storedRaw, storedNetPct: Number.isFinite(Number(c.netPct)) ? Number(c.netPct) : null, consistent });
  }
  const byVersion: Record<string, number> = {};
  for (const r of records) byVersion[`${r.bucket}:${r.fillModelVersion}`] = (byVersion[`${r.bucket}:${r.fillModelVersion}`] ?? 0) + 1;
  return { ok: mismatches === 0, byVersion, mismatches, records };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = replay();
  console.log(JSON.stringify({ ok: r.ok, byVersion: r.byVersion, mismatches: r.mismatches }, null, 1));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-replay-${day}.json`), JSON.stringify(r, null, 2));
  if (!r.ok) process.exitCode = 1;
}
