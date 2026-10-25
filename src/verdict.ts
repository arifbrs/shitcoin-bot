/**
 * VONIS — apakah strategi ini layak diteruskan, dinilai terhadap aturan yang didaftarkan
 * SEBELUM jawabannya diketahui.
 *
 * Ada karena tanpa tenggat, proyek seperti ini tidak pernah gagal — ia hanya terus berjalan.
 * Setiap pengukuran sejauh ini mengarah ke satu tempat: EV live nyata −9,08% pada 680 trade
 * terverifikasi chain, kedua arm A/B negatif, dan lever ekor-exit terbukti TIDAK memakan uang
 * (selisih +0,29 pts ±6,45, n=211 lawan 469) sehingga memperbaikinya tidak akan mengembalikan
 * apa pun. Alat tidak menciptakan edge; alat hanya berhenti menyembunyikan ketiadaannya.
 *
 * Aturannya dikunci di sini supaya tidak bisa dilonggarkan setelah melihat hasilnya.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export const VERDICT_SPEC = Object.freeze({
  /** A/B tuntas ~2026-08-30 (HI 3,4 trade/jam), plus tiga hari. */
  deadline: "2026-09-02T11:03:00.000Z",
  /**
   * Sebuah konfigurasi disebut TERBUKTI POSITIF hanya jika ketiganya benar. Ambang n dipasang
   * tinggi dengan sengaja: pita yang digantikan A/B ini butuh 3.710 trade untuk terpisah dari
   * nol, jadi apa pun di bawah dua ratus bukan bukti, itu cuaca.
   */
  minN: 200,
  requirePositiveEv: true,
  requireCiExcludesZero: true,
} as const);

export interface Slice { label: string; n: number; ev: number; ci: number; sol: number; exploratory: boolean }

/**
 * SATU aturan, dipakai untuk semua irisan.
 *
 * `exploratory` tidak mengubah aritmetika — ia mengubah apa yang boleh disimpulkan darinya.
 * Menguji belasan sebab-keluar lalu menyorot yang menang adalah cara termurah menemukan pola
 * yang tidak ada. Hanya A/B yang didaftarkan sebelum datanya lahir; sisanya penunjuk arah.
 */
export function proven(s: Slice): boolean {
  if (s.n < VERDICT_SPEC.minN) return false;
  if (VERDICT_SPEC.requirePositiveEv && s.ev <= 0) return false;
  if (VERDICT_SPEC.requireCiExcludesZero && s.ev - s.ci <= 0) return false;
  return true;
}

export function verdictOf(slices: Slice[], now: Date): "GO" | "STOP" | "BELUM" {
  // Hanya irisan terdaftar yang boleh menyatakan GO. Sebuah pemenang eksploratif adalah
  // hipotesis untuk diuji berikutnya, bukan izin meneruskan.
  if (slices.some((s) => !s.exploratory && proven(s))) return "GO";
  return now.toISOString() >= VERDICT_SPEC.deadline ? "STOP" : "BELUM";
}

interface Close { action?: string; mcArm?: string | null; reason?: string; pnlPct?: number; entrySizeSol?: number; execRealismApplied?: boolean }

function closes(): Close[] {
  const out: Close[] = [];
  for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("paper-trades-") && x.endsWith(".jsonl")).sort()) {
    const p = join(config.logDir, f);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as Close;
        // Hanya rezim pembukuan yang berlaku — menggabungkannya dengan yang lama menghasilkan
        // besaran yang bukan apa-apa.
        if (r.action === "CLOSE" && (r.execRealismApplied === true) === config.risk.execRealism) out.push(r);
      } catch { /* baris terakhir terpotong itu normal pada file hidup */ }
    }
  }
  return out;
}

function slice(label: string, rows: Close[], exploratory: boolean): Slice {
  const u = rows.filter((r) => typeof r.pnlPct === "number" && (r.entrySizeSol ?? 0) > 0);
  const w = u.reduce((a, r) => a + (r.entrySizeSol as number), 0);
  if (!u.length || w <= 0) return { label, n: 0, ev: 0, ci: 0, sol: 0, exploratory };
  const ev = u.reduce((a, r) => a + (r.pnlPct as number) * (r.entrySizeSol as number), 0) / w;
  const sd = Math.sqrt(u.reduce((a, r) => a + Math.pow((r.pnlPct as number) - ev, 2), 0) / u.length);
  return {
    label, n: u.length, ev, ci: 1.96 * sd / Math.sqrt(u.length),
    sol: u.reduce((a, r) => a + (r.entrySizeSol as number) * ((r.pnlPct as number) / 100), 0),
    exploratory,
  };
}

function main(): void {
  const all = closes();
  const slices: Slice[] = [
    slice("SEMUA (rezim berlaku)", all, false),
    slice("arm LO (lantai 46)", all.filter((r) => r.mcArm === "LO"), false),
    slice("arm HI (lantai 55)", all.filter((r) => r.mcArm === "HI"), false),
  ];
  const reasons = [...new Set(all.map((r) => r.reason ?? "?"))];
  for (const k of reasons) slices.push(slice(`  ${k}`, all.filter((r) => r.reason === k), true));

  const now = new Date();
  const v = verdictOf(slices, now);
  const left = (new Date(VERDICT_SPEC.deadline).getTime() - now.getTime()) / 86_400_000;

  console.log("═══════ VONIS ═══════");
  console.log(`aturan dikunci: n ≥ ${VERDICT_SPEC.minN}, EV > 0, selang 95% tidak melewati nol`);
  console.log(`tenggat: ${VERDICT_SPEC.deadline.slice(0, 16)}Z  (${left > 0 ? `${left.toFixed(1)} hari lagi` : "TERLAMPAUI"})\n`);
  console.log("irisan                        n         EV          net SOL   status");
  for (const s of slices.sort((a, b) => Number(a.exploratory) - Number(b.exploratory) || b.n - a.n)) {
    if (!s.n) continue;
    const st = proven(s) ? "TERBUKTI +" : s.n < VERDICT_SPEC.minN ? "n kurang" : "tidak terbukti";
    console.log(
      `${s.label.padEnd(28)} ${String(s.n).padStart(5)}  ${((s.ev >= 0 ? "+" : "") + s.ev.toFixed(2) + "%").padStart(8)} ±${s.ci.toFixed(2)}  ` +
      `${((s.sol >= 0 ? "+" : "") + s.sol.toFixed(3)).padStart(8)}   ${st}${s.exploratory ? " (eksploratif)" : ""}`,
    );
  }
  console.log(`\nVONIS: ${v}`);
  console.log(v === "GO" ? "→ ada konfigurasi terdaftar yang terbukti positif. Lanjutkan."
    : v === "STOP" ? "→ tenggat lewat, tidak ada yang terbukti positif. Hentikan strategi ini."
    : "→ belum ada yang terbukti dan tenggat belum lewat. Jangan putuskan apa pun hari ini.");
  console.log("\nirisan eksploratif tidak pernah bisa menyatakan GO: menguji belasan sebab-keluar");
  console.log("lalu menyorot yang menang adalah cara termurah menemukan pola yang tidak ada.");
}

if (process.argv[1] && process.argv[1].includes("verdict")) main();
