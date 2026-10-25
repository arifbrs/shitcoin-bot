/**
 * ATURAN BUNUH KOHORT-11 — `npm run rh:retire [--apply]`.
 *
 * Aturan yang disepakati: arm limit dinyatakan GAGAL-SEMENTARA bila n ≥ 20 trade DAN net ≤ −15%.
 * Default hanya MELAPOR; `--apply` menulis daftar pensiun ke logs/rh-retired.json (data arm TIDAK dihapus).
 * Penegakan di lane (melewati arm yang pensiun) adalah langkah terpisah — disebut, bukan diklaim.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const MIN_N = 20;
const MAX_NET_PCT = -15;

function main(): void {
  const apply = process.argv.includes("--apply");
  const j = JSON.parse(readFileSync(join(config.logDir, "rh-paper-state.json"), "utf8")) as { variants?: Record<string, { trades?: number; equityUsd?: number }> };
  const v = j.variants ?? {};
  const limit = Object.entries(v).filter(([k]) => /^v(59|6[0-9]|7[0-4])-limit/.test(k));
  const qualify: Array<{ arm: string; n: number; netPct: number }> = [];
  for (const [k, x] of limit) {
    const n = Number(x.trades ?? 0);
    const netPct = (Number(x.equityUsd ?? 100) - 100);
    if (n >= MIN_N && netPct <= MAX_NET_PCT) qualify.push({ arm: k, n, netPct });
  }
  console.log("  ══ ATURAN BUNUH KOHORT-11 (n ≥ " + MIN_N + " · net ≤ " + MAX_NET_PCT + "%) ══");
  console.log("  arm limit diperiksa: " + limit.length + " · memenuhi syarat pensiun: " + qualify.length);
  for (const q of qualify) console.log("    " + q.arm + " · n=" + q.n + " · net " + q.netPct.toFixed(1) + "%");
  if (!qualify.length) console.log("  → belum ada yang dipensiunkan (syarat n belum/sudah tidak terpenuhi)");
  if (apply && qualify.length) {
    const out = { ts: Date.now(), minN: MIN_N, maxNetPct: MAX_NET_PCT, retired: qualify.map((q) => q.arm) };
    writeFileSync(join(config.logDir, "rh-retired.json"), JSON.stringify(out, null, 1));
    console.log("  daftar pensiun ditulis: logs/rh-retired.json (" + qualify.length + " arm) — data tidak dihapus");
  } else if (qualify.length) {
    console.log("  (mode lapor; tambahkan --apply untuk menulis daftar pensiun)");
  }
}

main();
