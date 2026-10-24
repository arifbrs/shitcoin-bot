/**
 * AUDIT LEDGER (round-6 P2) — `npm run rh:ledger-audit`. OFFLINE.
 * Invariant per baris CLOSE: nilai yang DISIMPAN harus bisa dihitung ulang dari bukti mentah
 * di baris yang sama —
 *   1. netPct  = quotePnl(entryWethRaw, exitWethRaw).netPct   (gas sekali, rumus engine)
 *   2. netWethRaw = entry − exit − GAS (BigInt)
 *   3. simFillExit.fillOutRaw = applyLatencySlippage(exitWethRaw)  (baris overlay fillmodel-v1)
 * Ketidakcocokan dihitung & dilaporkan per jenis; exit non-zero bila ada — laporan yang tidak
 * bisa direkonsiliasi tidak boleh dikutip.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { quotePnl, ROUND_TRIP_GAS_WEI } from "./engine.js";
import { applyLatencySlippage, latencyOverlayPct, DEFAULT_ASSUMPTIONS } from "./fillmodel.js";

export function ledgerAudit(dir = "logs/rhpaper"): { lines: string[]; mismatches: number; checked: number } {
  let checked = 0, badNet = 0, badWei = 0, badFillOut = 0, skipped = 0;
  const lines: string[] = ["═══ AUDIT LEDGER — rekomputasi per VERSI akuntansi (round-6 P2, revisi round-6) ═══", "",
    `overlay latensi tunggal: ${latencyOverlayPct(DEFAULT_ASSUMPTIONS).toFixed(4)} pp (dari fillmodel-v1; didefinisikan SEKALI)`,
    "DUA BASIS TERVERIFIKASI (jangan dicampur):",
    "  v3 (rhpaper-units-arm-v3, sejak 2026-10-24): netPct = gross − gas(11,4e12 wei) via quotePnl bigint.",
    "  v0 (measurementVersion tidak ada, ≤2026-10-23): netPct == grossPct PERSIS — gas TIDAK pernah",
    "     dipotong (bukti: netPct−grossPct=0 pada sampel). Kesimpulan round-5 'threshold sudah memuat",
    "     gas' hanya sah untuk v3; untuk baris v0 threshold adalah GROSS → BE v0 = (SL+d+gas)/(TP+SL)."];
  const files = readdirSync(dir).filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const samples: string[] = [];
  const byVersion: Record<string, { n: number; bad: number }> = {};
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.includes('"action":"CLOSE"')) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const entry = j.entryWethRaw as string | undefined, exit = j.exitWethRaw as string | undefined;
      if (typeof entry !== "string" || !/^\d+$/.test(entry) || typeof exit !== "string" || !/^\d+$/.test(exit)) { skipped++; continue; }
      checked++;
      const version = typeof j.measurementVersion === "string" ? j.measurementVersion : "pre-units(v0)";
      const stats = byVersion[version] ?? (byVersion[version] = { n: 0, bad: 0 });
      stats.n++;
      const entryB = BigInt(entry), exitB = BigInt(exit);
      const grossFloat = Number(exitB - entryB) / Number(entryB) * 100;
      // Basis v0: netPct == gross (float, tanpa gas). Basis v3: quotePnl (gas bigint, presisi 4 des).
      const expectNet = version === "rhpaper-units-arm-v3" ? quotePnl(entry, exit).netPct : grossFloat;
      const storedNet = Number(j.netPct);
      // (FINAL A1) toleransi 1e-4: baris lama disimpan dengan presisi 4 desimal (formula lama);
      // rekomputasi kini 10 desimal — selisih ≤ 5e-5 wajar, kesalahan riil ≥ 1 bp tetap tertangkap.
      if (!Number.isFinite(storedNet) || Math.abs(storedNet - expectNet) > 1e-4) {
        stats.bad++; badNet++;
        if (samples.length < 5) samples.push(`netPct tersimpan ${storedNet} ≠ rekomputasi-${version} ${expectNet.toFixed(6)} (${String(j.arm)}/${String(j.symbol)} ${f})`);
      }
      if (version === "rhpaper-units-arm-v3") {
        const storedWei = typeof j.netWethRaw === "string" && /^-?\d+$/.test(j.netWethRaw) ? BigInt(j.netWethRaw) : null;
        const expectWei = BigInt(quotePnl(entry, exit).netWethRaw);
        if (storedWei != null && storedWei !== expectWei) {
          stats.bad++; badWei++;
          if (samples.length < 5) samples.push(`netWethRaw tersimpan ${storedWei} ≠ rekomputasi ${expectWei} (${String(j.symbol)} ${f})`);
        }
        const s = j.simFillExit as { filled?: boolean; fillOutRaw?: string; version?: string } | undefined;
        if (s?.filled === true) { // baris yang modelnya MENOLAK tidak punya fillOutRaw — sesuai desain
          // (FINAL §1) versi-sadar: v2 = DEFECT (double-count, dibekukan) → fillOutRaw-nya TIDAK
          // divalidasi dgn formula v1/v3 (memang beda); v3 = re-quote kuantitas sim ×(1−l) —
          // exitWethRaw pada baris v3 ADALAH re-quote utk kuantitas sim, jadi formula berlaku.
          const isV2 = s.version === "rhpaper-fillmodel-v2";
          const expect = applyLatencySlippage(exit, DEFAULT_ASSUMPTIONS.latencySlippagePct);
          if (!isV2 && s.fillOutRaw !== expect) {
            stats.bad++; badFillOut++;
            if (samples.length < 5) samples.push(`simFillExit.fillOutRaw ${s.fillOutRaw} ≠ model ${expect} (${String(j.symbol)} ${f})`);
          }
        }
      }
    }
  }
  lines.push(`CLOSE diperiksa: ${checked} (lewati ${skipped} tanpa raw lengkap)`);
  for (const [v, s] of Object.entries(byVersion)) lines.push(`  ${v}: n=${s.n} tak-cocok=${s.bad}`);
  lines.push(`total tak-cocok: netPct=${badNet} · netWethRaw=${badWei} · fillOutRaw=${badFillOut}`,
    ...samples.map((s) => `  contoh: ${s}`),
    badNet + badWei + badFillOut === 0 ? "INVARIANT: SEMUA baris terekonsiliasi dengan basis versinya masing-masing ✓" : "INVARIANT GAGAL — baris yang tidak cocok tidak boleh ikut metrik ✓✗");
  return { lines, mismatches: badNet + badWei + badFillOut, checked };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = ledgerAudit();
  console.log(r.lines.join("\n"));
  const day = new Date().toISOString().slice(0, 10);
  writeFileSync(join("logs", `rh-ledger-audit-${day}.md`), r.lines.join("\n") + "\n");
  if (r.mismatches > 0) process.exitCode = 1;
}
