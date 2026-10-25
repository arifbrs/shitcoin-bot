/**
 * STYLE REPORT — menyimpulkan aturan exit owner dari keputusan yang benar-benar diambil.
 *
 * Sampai sekarang satu-satunya kebijakan exit yang pernah terekam adalah kebijakan otomatis.
 * Tombol "tutup posisi" di kartu membuka jalur kedua: apa yang ditutup manusia, kapan, dan pada
 * mark berapa. Laporan ini membacanya.
 *
 * SATU PERINGATAN YANG MENENTUKAN CARA MEMBACANYA. Owner MEMILIH posisi mana yang ditutup, jadi
 * membandingkan EV manual lawan otomatis membandingkan dua populasi yang dipilih berbeda, bukan
 * dua kebijakan. Kalau owner cenderung menutup yang sedang hijau, manual akan menang di layar
 * tanpa membuktikan apa pun. Karena itu bagian EV di bawah ditandai TERKONFOUND dan tidak boleh
 * dipakai sebagai klaim performa.
 *
 * Yang BUKAN terkonfound adalah PROFIL keputusannya: pada P&L berapa, setelah berapa lama, dan
 * seberapa jauh dari puncak owner biasanya menekan tombol. Itu sebuah aturan, dan sebuah aturan
 * bisa diuji terhadap SEMUA posisi — termasuk yang tidak pernah ditutup manual. Itulah jalan
 * dari "gaya" menjadi kebijakan yang terukur, dan itu langkah berikutnya, bukan laporan ini.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

interface Close {
  action?: string; reason?: string; pnlPct?: number; rawPnlPct?: number; heldSec?: number;
  peakPct?: number; entrySizeSol?: number; symbol?: string; ts?: string; execRealismApplied?: boolean;
}

const rows: Close[] = [];
for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("paper-trades-") && x.endsWith(".jsonl")).sort()) {
  const p = join(config.logDir, f);
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as Close;
      if (r.action === "CLOSE" && (r.execRealismApplied === true) === config.risk.execRealism) rows.push(r);
    } catch { /* baris terakhir terpotong itu normal */ }
  }
}

const manual = rows.filter((r) => r.reason === "MANUAL_CLOSE");
const auto = rows.filter((r) => r.reason !== "MANUAL_CLOSE" && r.reason !== "MANUAL_FLATTEN");

const q = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s[Math.floor(p * (s.length - 1))] as number) : NaN;
};
const num = (a: Close[], k: keyof Close): number[] =>
  a.map((r) => r[k]).filter((x): x is number => typeof x === "number");

/** Seberapa jauh di bawah puncaknya sendiri posisi itu ditutup. 0 = tepat di puncak. */
const offPeak = (a: Close[]): number[] =>
  a.filter((r) => typeof r.peakPct === "number" && typeof r.rawPnlPct === "number" && (r.peakPct as number) > 0)
    .map((r) => (r.peakPct as number) - (r.rawPnlPct as number));

console.log("═══════ PROFIL KEPUTUSAN TUTUP ═══════\n");
if (!manual.length) {
  console.log("Belum ada MANUAL_CLOSE.");
  console.log("Tombol \"tutup posisi\" ada di tiap kartu posisi terbuka (dua ketuk).");
  console.log("Tutup beberapa posisi seperti biasanya Anda menilai, lalu jalankan ini lagi.");
} else {
  const line = (label: string, a: Close[]): void => {
    const pnl = num(a, "rawPnlPct"), held = num(a, "heldSec"), peak = num(a, "peakPct"), off = offPeak(a);
    console.log(`${label}  (n=${a.length})`);
    console.log(`  mark saat ditutup   p25 ${q(pnl, .25).toFixed(1)}%   med ${q(pnl, .5).toFixed(1)}%   p75 ${q(pnl, .75).toFixed(1)}%`);
    console.log(`  ditahan             med ${q(held, .5).toFixed(0)}s   p90 ${q(held, .9).toFixed(0)}s`);
    console.log(`  puncak yang dicapai med ${q(peak, .5).toFixed(1)}%`);
    if (off.length) console.log(`  jarak dari puncak   med ${q(off, .5).toFixed(1)} poin di bawahnya`);
  };
  line("MANUAL (keputusan Anda)", manual);
  console.log("");
  line("OTOMATIS (aturan bot)", auto);

  const ev = (a: Close[]): number => {
    const w = a.reduce((s, r) => s + (r.entrySizeSol ?? 0), 0);
    return w > 0 ? a.reduce((s, r) => s + (r.pnlPct ?? 0) * (r.entrySizeSol ?? 0), 0) / w : 0;
  };
  console.log(`\n── EV (TERKONFOUND — jangan dibaca sebagai klaim performa) ──`);
  console.log(`  manual   ${(ev(manual) >= 0 ? "+" : "") + ev(manual).toFixed(2)}%   otomatis ${(ev(auto) >= 0 ? "+" : "") + ev(auto).toFixed(2)}%`);
  console.log(`  Anda memilih mana yang ditutup, jadi ini membandingkan dua populasi yang dipilih`);
  console.log(`  berbeda, bukan dua kebijakan. Yang bisa dipakai adalah PROFIL di atas.`);

  if (manual.length >= 20) {
    const pnl = num(manual, "rawPnlPct"), held = num(manual, "heldSec"), off = offPeak(manual);
    console.log(`\n── ATURAN YANG TERBACA DARI KEPUTUSAN ANDA ──`);
    console.log(`  "tutup saat mark ≈ +${q(pnl, .5).toFixed(0)}%, biasanya dalam ${q(held, .5).toFixed(0)} detik,`);
    console.log(`   dan tidak menunggu lebih dari ~${off.length ? q(off, .75).toFixed(0) : "?"} poin turun dari puncak"`);
    console.log(`  Aturan itu bisa diuji terhadap SEMUA posisi, termasuk yang tak pernah Anda tutup.`);
    console.log(`  Itu langkah berikutnya — dan satu-satunya yang bisa membuktikan gaya ini menang.`);
  } else {
    console.log(`\n(butuh ≥20 MANUAL_CLOSE sebelum profilnya cukup stabil untuk dijadikan aturan — sekarang ${manual.length})`);
  }
}
