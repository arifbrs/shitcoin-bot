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
import { simNetFor, quoteNet } from "./fillmodel.js";
import { countFunnel } from "./funnel.js";

export interface ReplayRecord {
  tradeId: string; arm: string; symbol: string; token: string;
  fillModelVersion: string; bucket: "v1" | "v2" | "quote-only" | "invalid";
  openedAt: unknown; closedAt: unknown; why: string;
  entryWethRaw: string; exitQuoteWethRaw: string;
  replayNetWethRaw: string; replayNetPct: number;
  storedNetWethRaw: string | null; storedNetPct: number | null;
  consistent: boolean;
}

export function replay(dir = "logs/rhpaper", now = Date.now()): { ok: boolean; byVersion: Record<string, number>; mismatches: number; records: ReplayRecord[]; reconciliation: Record<string, unknown> } {
  const rawRows: Array<Record<string, unknown>> = [];
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rawRows.push(JSON.parse(line) as Record<string, unknown>); } catch { /* rusak */ }
  }
  // (FINAL §2) VALIDATOR YANG SAMA dgn funnel: hanya tradeId di validCompletedIds yang layak.
  const fc = countFunnel(rawRows);
  const validIds = new Set(fc.validCompletedIds);
  const opens = new Map<string, Record<string, unknown>>();
  for (const j of rawRows) if (String(j.action ?? "") === "OPEN" && j.tradeId) opens.set(String(j.tradeId), j);
  const records: ReplayRecord[] = [];
  let mismatches = 0;
  for (const f of files) for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    if (!line.includes('"action":"CLOSE"')) continue;
    let c: Record<string, unknown>;
    try { c = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const o = opens.get(String(c.tradeId ?? ""));
    const isValidCompleted = validIds.has(String(c.tradeId ?? ""));
    const entry = String(c.entryWethRaw ?? ""), exitQuote = String(c.exitWethRaw ?? "");
    if (!/^\d+$/.test(entry) || !/^\d+$/.test(exitQuote)) continue;
    const version = typeof c.fillModelVersion === "string" ? c.fillModelVersion : null;
    const xs = c.simFillExit as { filled?: boolean; fillOutRaw?: string; version?: string } | undefined;
    const es = o?.simFillEntry as { filled?: boolean; fillOutRaw?: string; version?: string } | undefined;
    // (FINAL §2) OTORITAS TUNGGAL: rekonstruksi net sim via simNetFor (versi-sadar).
    const s = simNetFor({ version, entryWethRaw: entry, exitQuoteWethRaw: exitQuote,
      entrySimFillOutRaw: es?.fillOutRaw ?? null, exitSimFillOutRaw: xs?.fillOutRaw ?? null });
    const bucket = s.bucket as unknown as ReplayRecord["bucket"];
    const replayNetWethRaw = s.netWethRaw, replayNetPct = s.netPct;
    // Konsistensi = NILAI LEDGER harus terekonstrusi persis dari bukti mentahnya — via
    // simNetFor bucket quote-only (net gas, satu otoritas): netWethRaw (bila tersimpan) harus
    // cocok; netPct (bila ada) ≈ sama (toleransi 1e-4 utk baris presisi-4-desimal lama).
    const storedRaw = typeof c.netWethRaw === "string" && /^-?\d+$/.test(c.netWethRaw) ? c.netWethRaw : null;
    const storedPct = Number.isFinite(Number(c.netPct)) ? Number(c.netPct) : null;
    // (FINAL §3) Basis ditentukan oleh DATA, bukan string versi: baris yang MENYIMPAN netWethRaw
    // = basis net (gas dipotong — termasuk baris transisi tanpa measurementVersion); baris yang
    // hanya menyimpan netPct = basis gross v0 (netPct == grossPct di baris itu, terverifikasi).
    const expectedPct = storedRaw != null
      ? quoteNet(entry, exitQuote).netPct
      : (Number(BigInt(exitQuote) - BigInt(entry)) / Number(entry)) * 100;
    let consistent = true;
    if (storedRaw != null && storedRaw !== quoteNet(entry, exitQuote).netWethRaw) consistent = false;
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
  const byVersionValid: Record<string, number> = {};
  for (const r of records) if (validIds.has(r.tradeId)) byVersionValid[`${r.bucket}:${r.fillModelVersion}`] = (byVersionValid[`${r.bucket}:${r.fillModelVersion}`] ?? 0) + 1;
  const reconciliation = { funnelCompleted: fc.completed, evidenceCount: fc.validCompletedIds.length,
    replayValidRows: Object.values(byVersionValid).reduce((a, b) => a + b, 0),
    consistent: fc.completed === fc.validCompletedIds.length && fc.validCompletedIds.length === Object.values(byVersionValid).reduce((a, b) => a + b, 0),
    note: "COMPLETED === bukti unik === replay valid; duplikat/invalid dilaporkan terpisah" };
  return { ok: mismatches === 0 && reconciliation.consistent, byVersion, mismatches, records, reconciliation };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = replay();
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-replay-${day}.json`), JSON.stringify(r, null, 2));
  console.log(JSON.stringify({ ok: r.ok, byVersion: r.byVersion, mismatches: r.mismatches, reconciliation: r.reconciliation }, null, 1));
  if (!r.ok) process.exitCode = 1;
}
