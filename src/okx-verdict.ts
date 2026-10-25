/**
 * VERDICT ARM OKX (item 6, 2026-10-11) — `npm run okx:verdict`.
 *
 * Sumber: ledger ber-hash-chain `logs/okx-strict-paper-v2.jsonl` (state tidak dipakai — state bisa
 * ditulis ulang, ledger tidak). Arm diambil dari field `variant`; baris LAMA (sebelum 2026-10-11)
 * tidak punya label itu dan dihitung sebagai arm dasar — disebut terbuka, bukan dibuang diam-diam.
 *
 * Statistik dari modul bersama (stats.ts): konsentrasi, bootstrap tak berpasangan, dan perkiraan
 * jumlah trade yang dibutuhkan supaya "belum terbukti" punya angka, bukan kesan.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { concentration, bootstrapDiffCI, mean, sd as sdOf, requiredNPerArm } from "./robinhood/stats.js";

interface Row {
  type?: string;
  variant?: string;
  cohort?: string;
  policyVersion?: number;
  entryCostLamports?: number;
  quotedSolLamports?: string;
  minSolLamports?: string;
  status?: string;
  exitReason?: string;
  pnlPct?: number;
  symbol?: string;
}

const LEDGER = join(config.logDir, "okx-strict-paper-v2.jsonl");
/** Baris laporan disimpan juga sebagai berkas — review harian & kartu dashboard membacanya. */
const OUT_LINES: string[] = [];
const note = (s: string): void => { OUT_LINES.push(s); console.log(s); };

function loadRows(): Row[] {
  let text = "";
  try {
    text = readFileSync(LEDGER, "utf8");
  } catch {
    return [];
  }
  const out: Row[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Row);
    } catch { /* baris rusak */ }
  }
  return out;
}

/** PnL% sebuah penutupan scalp: hasil dibanding biaya masuk. Hanya bila angkanya memang ada. */
function pnlPctOf(r: Row): number | null {
  if (typeof r.pnlPct === "number") return r.pnlPct;
  const quoted = Number(r.quotedSolLamports ?? NaN);
  const cost = Number(r.entryCostLamports ?? NaN);
  if (!Number.isFinite(quoted) || !Number.isFinite(cost) || cost <= 0) return null;
  if (r.status && r.status !== "BUILT" && r.status !== "SENT" && r.status !== "CONFIRMED") return null;
  return ((quoted - cost) / cost) * 100;
}

const rows = loadRows();
note("═══ VERDICT ARM OKX (ledger ber-hash-chain) ═══");
note(`baris ledger: ${rows.length} · berkas: ${LEDGER}`);

if (!rows.length) {
  note("belum ada baris ledger — belum bisa dinilai apa pun.");
  process.exit(0);
}

const byArm = new Map<string, number[]>();
let tanpaLabel = 0;
let tanpaAngka = 0;
for (const r of rows) {
  if (r.type !== "SCALP_EXIT" && r.type !== "POSITION_EXIT") continue;
  const pnl = pnlPctOf(r);
  if (pnl == null) { tanpaAngka++; continue; }
  const arm = r.variant ?? `v${r.policyVersion ?? "?"}-dasar(tanpa label)`;
  if (!r.variant) tanpaLabel++;
  if (!byArm.has(arm)) byArm.set(arm, []);
  byArm.get(arm)!.push(pnl);
}

note(`penutupan terbaca: ${[...byArm.values()].reduce((a, l) => a + l.length, 0)} · tanpa angka PnL: ${tanpaAngka}`);
if (tanpaLabel) note(`catatan: ${tanpaLabel} baris lama tanpa label arm dihitung sebagai arm dasar (jujur, bukan dibuang)`);
note("");

const money = (v: number): string => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}%`;
const arms = [...byArm.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [arm, list] of arms) {
  const conc = concentration(list);
  const need = requiredNPerArm(mean(list), sdOf(list));
  note(`   ${arm.padEnd(28)} n=${String(list.length).padStart(3)} · rata-rata ${money(mean(list)).padStart(8)}/trade · top-1 ${(conc.topSharePct * 100).toFixed(0)}%${conc.topSharePct > 0.5 && conc.netExclTop1 <= 0 ? " · RAPUH (bergantung satu mint)" : ""} · perlu ≈${Number.isFinite(need) ? need : "∞"} trade/arm`);
}

if (arms.length >= 2) {
  const base = arms[0]!;
  note("");
  for (const [arm, list] of arms.slice(1)) {
    const [lo, hi] = bootstrapDiffCI(list, base[1]);
    const selisih = mean(list) - mean(base[1]);
    note(`   ${arm} vs ${base[0]}: selisih ${money(selisih)}/trade · bootstrap 95% ${money(lo)} … ${money(hi)}${lo > 0 ? " → lebih baik konsisten" : hi < 0 ? " → lebih buruk konsisten" : " → masih melewati nol: belum konklusif"}`);
  }
} else {
  note("\n   (baru satu arm punya angka — arm kedua mulai terisi setelah lane berjalan dengan kode baru)");
}

// Simpan laporan untuk pembaca lain (review harian / kartu dashboard).
try {
  writeFileSync(join(config.logDir, `okx-verdict-${new Date().toISOString().slice(0, 10)}.md`), OUT_LINES.join("\n") + "\n");
} catch { /* best-effort */ }
