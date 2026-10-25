/**
 * EXEC REALISM SELF-TEST.
 *
 * The property that matters is not "the haircut is applied" — it is that the simulator can no
 * longer print a headline number the chain would refuse to pay. Everything below is a way of
 * asking that question, including the two ways this could go wrong in the other direction:
 * a calibration that does not exist must leave the books ALONE, and losses must be corrected
 * in whatever direction the measurement points, not only the flattering one.
 */
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "realism-"));
process.env.LOG_DIR = dir;
process.env.EXEC_REALISM = "true";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

/** The shape measured on 2026-08-25 from 680 chain-verified trades. */
const REAL_CALIBRATION = {
  n: 680, paperPct: 3.84, realPct: -9.08,
  bands: [
    { from: -Infinity, to: 0, n: 495, paperPct: -27.07, realPct: -19.18, ratio: 0.7086 },
    { from: 0, to: 10, n: 67, paperPct: 4.31, realPct: -2.60, ratio: -0.6032 },
    { from: 10, to: 25, n: 35, paperPct: 17.34, realPct: 8.41, ratio: 0.4850 },
    { from: 25, to: 50, n: 32, paperPct: 35.91, realPct: 22.12, ratio: 0.6160 },
    { from: 50, to: 100, n: 19, paperPct: 80.03, realPct: 52.49, ratio: 0.6559 },
    { from: 100, to: Infinity, n: 32, paperPct: 340.44, realPct: 33.99, ratio: 0.0998 },
  ],
};

function writeCal(cal: unknown | null): void {
  const p = join(dir, "live-truth.json");
  if (cal == null) { if (existsSync(p)) rmSync(p); return; }
  // JSON has no Infinity. The tool writes null for it, so the loader must survive that too —
  // testing against a hand-made object that never round-tripped through JSON would prove nothing.
  writeFileSync(p, JSON.stringify({ generatedAt: new Date().toISOString(), calibration: cal, trades: [] }));
}

async function main(): Promise<void> {
  console.log("═══════ EXEC REALISM SELF-TEST ═══════\n");
  const R = await import("./execution/exec-realism.js");

  console.log("1. TANPA KALIBRASI = TIDAK BOLEH MENGARANG");
  writeCal(null);
  R.__resetRealismCache();
  {
    const v = R.applyExecutionRealism(80);
    check("tanpa file kalibrasi → pembukuan TIDAK disentuh", v.applied === false && v.pct === 80);
    check("  → dan banner mengaku belum terkalibrasi", (R.realismBanner() ?? "").includes("BELUM terkalibrasi"));
  }

  console.log("\n2. BENTUK YANG TERUKUR HARUS TERBAWA");
  writeCal(REAL_CALIBRATION);
  R.__resetRealismCache();
  {
    const small = R.applyExecutionRealism(5);
    check("klaim kecil (+5%) jadi RUGI — persis yang chain bilang", small.applied && small.pct < 0,
      `dapat ${small.pct.toFixed(2)}%`);

    const mid = R.applyExecutionRealism(40);
    check("klaim menengah (+40%) cair sebagian", mid.pct > 0 && mid.pct < 40, `dapat ${mid.pct.toFixed(2)}%`);

    const moon = R.applyExecutionRealism(400);
    check("klaim >100% cair SANGAT sedikit (n=32)", moon.pct < 60, `dapat ${moon.pct.toFixed(2)}%`);
    check("  → dan tetap positif, bukan dihapus", moon.pct > 0);

    // Yang paling penting: urutan tidak boleh terbalik. Koreksi yang membuat trade buruk
    // terlihat lebih baik dari trade bagus akan merusak setiap perbandingan cohort.
    check("monoton: klaim lebih besar tidak pernah membukukan lebih kecil (dalam satu pita)",
      R.applyExecutionRealism(30).pct < R.applyExecutionRealism(45).pct);
  }

  console.log("\n3. RUGI JUGA DIKOREKSI — KE ARAH YANG DITUNJUK DATA");
  {
    const loss = R.applyExecutionRealism(-40);
    check("live rugi LEBIH SEDIKIT dari model (terukur −19,2% vs klaim −27,1%)",
      loss.pct > -40 && loss.pct < 0, `dapat ${loss.pct.toFixed(2)}%`);
    check("  → koreksi tidak pernah menembus −100%", R.applyExecutionRealism(-100).pct >= -100);
  }

  console.log("\n4. PITA TIPIS TIDAK BOLEH MENYETIR UANG");
  {
    const thin = {
      n: 250, paperPct: 10, realPct: 2,
      bands: [
        { from: -Infinity, to: 0, n: 190, paperPct: -20, realPct: -15, ratio: 0.75 },
        { from: 10, to: 50, n: 58, paperPct: 30, realPct: 12, ratio: 0.4 },
        { from: 100, to: Infinity, n: 2, paperPct: 500, realPct: 495, ratio: 0.99 }, // n=2: kebetulan
      ],
    };
    writeCal(thin); R.__resetRealismCache();
    const v = R.applyExecutionRealism(500);
    check("pita n=2 tidak dipakai — klaim dibatasi bukti yang tebal", v.band === "cap" && v.pct === 12,
      `band=${v.band} pct=${v.pct}`);
    check("  → keberuntungan 2 trade tidak mengangkat plafon", v.pct < 495);
  }

  console.log("\n5. TANPA BUKTI ARAH ITU, JANGAN MENGARANG");
  {
    const lossOnly = {
      n: 190, paperPct: -20, realPct: -15,
      bands: [{ from: -Infinity, to: 0, n: 190, paperPct: -20, realPct: -15, ratio: 0.75 }],
    };
    writeCal(lossOnly); R.__resetRealismCache();
    check("hanya ada bukti RUGI → klaim untung dibiarkan mentah",
      R.applyExecutionRealism(300).applied === false);
    check("  → tapi rugi tetap dikoreksi", R.applyExecutionRealism(-40).applied === true);
  }

  console.log("\n6. KALIBRASI BARU LANGSUNG TERPAKAI (file berubah = angka berubah)");
  {
    writeCal(REAL_CALIBRATION); R.__resetRealismCache();
    const before = R.applyExecutionRealism(40).pct;
    const harsher = { ...REAL_CALIBRATION, bands: REAL_CALIBRATION.bands.map((b) => ({ ...b, realPct: b.realPct / 2 })) };
    await new Promise((r) => setTimeout(r, 5)); // mtime harus bergerak agar cache batal
    writeCal(harsher);
    const after = R.applyExecutionRealism(40).pct;
    check("re-kalibrasi terbaca tanpa restart", after < before,
      `sebelum=${before.toFixed(2)} sesudah=${after.toFixed(2)}`);
  }

  console.log("\n7. SAKLAR MATI = MENTAH");
  {
    // Harus proses BARU: config dibaca sekali saat modul dimuat, jadi mengubah env di sini
    // tidak membuktikan apa pun (versi pertama tes ini salah karena itu).
    writeCal(REAL_CALIBRATION);
    const child = spawnSync(process.execPath, ["-e", `
      process.env.LOG_DIR = ${JSON.stringify(dir)};
      process.env.EXEC_REALISM = "false";
      import("${pathToFileURL(join(process.cwd(), "src/execution/exec-realism.ts")).href}")
        .then((m) => { const v = m.applyExecutionRealism(80); console.log(JSON.stringify(v)); })
        .catch((e) => { console.error(e); process.exit(1); });
    `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--import tsx" } });
    let v: { applied?: boolean; pct?: number } = {};
    try { v = JSON.parse((child.stdout ?? "").trim().split("\n").pop() ?? "{}"); } catch { /* reported below */ }
    check("EXEC_REALISM=false → angka mentah kembali", v.applied === false && v.pct === 80,
      `stdout=${(child.stdout ?? "").trim()} stderr=${(child.stderr ?? "").trim().slice(0, 200)}`);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n═══════ RESULT: ${pass} passed, ${fail} failed ═══════`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
