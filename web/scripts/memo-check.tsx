/**
 * Menguji comparator panelMemo terhadap PUSH SUNGGUHAN yang direkam dari /api/stream.
 *
 * Dua kegagalan yang dicari, dan yang kedua jauh lebih berbahaya:
 *   1. terlalu longgar — panel ikut render padahal slice-nya tidak berubah (sia-sia)
 *   2. TERLALU KETAT — slice berubah tapi sidik jarinya sama, sehingga panel BEKU di layar
 *
 * Fixture /tmp/pushes.json = rekaman push NYATA (bukan karangan). Cara membuatnya (2026-10-09):
 *   login → curl -b <cookie> http://127.0.0.1:4317/api/stream → simpan 3–5 frame `data: {...}`.
 * Kalau berkasnya belum ada, skrip ini BERHENTI dengan instruksi — dulu ia crash ENOENT tanpa
 * penjelasan, sehingga kegagalan harness tampak seperti kegagalan panel.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StatsResponse } from "../src/types/stats";

// FIXTURE BERLAPIS (2026-10-13): /tmp hilang saat reboot → check merah karena berkas sementara.
// Cadangan = REKAMAN NYATA yang ikut di-commit (bukan frame karangan); kalau keduanya tak ada,
// check tetap GAGAL seperti semula (fail-closed dipertahankan sesuai niat desain).
const FIXTURE_PATHS = ["/tmp/pushes.json", fileURLToPath(new URL("./fixtures/pushes.json", import.meta.url))];
const FIXTURE_USED = FIXTURE_PATHS.find((f) => existsSync(f));
if (!FIXTURE_USED) {
  console.error("FIXTURE HILANG: /tmp/pushes.json dan web/scripts/fixtures/pushes.json belum ada.");
  console.error("Rekam dari server yang hidup: login ke dashboard lalu simpan `data: {...}` dari /api/stream.");
  process.exit(1);
}
if (FIXTURE_USED !== "/tmp/pushes.json") console.log(`  CATATAN: memakai rekaman repo ${FIXTURE_USED} (rekaman nyata, ikut di-commit).`);
const pushes: StatsResponse[] = JSON.parse(readFileSync(FIXTURE_USED, "utf8"));

const FP: Record<string, [(d: StatsResponse) => unknown[], (d: StatsResponse) => string]> = {
  TradeJournal: [
    (d) => [d.strategy2Primary?.recentTrades?.length, d.strategy2Primary?.recentTrades?.[0]?.ts,
            d.recentTrades?.length, d.recentTrades?.[0]?.ts,
            d.strategy2Primary?.recentTrades?.filter((t) => t.img).length,
            d.recentTrades?.filter((t) => t.img ?? t.image).length],
    (d) => JSON.stringify([d.strategy2Primary?.recentTrades, d.recentTrades]),
  ],
  ScoutPanel: [
    (d) => [d.strategy2.count, d.strategy2.candidates?.length, d.strategy2.candidates?.[0]?.mint,
            d.strategy2.candidates?.filter((c) => c.img).length],
    (d) => JSON.stringify(d.strategy2.candidates),
  ],
  OpenPositions: [
    (d) => [d.strategy2Primary?.paper.open, d.paper?.openPositions?.length,
            d.strategy2Primary?.paper.openPositions?.map((p) => `${p.mint}:${p.unrealizedPnl}:${p.heldSec}`).join(),
            d.paper?.openPositions?.map((p) => `${p.mint}:${p.unrealizedPnl}:${p.heldSec}`).join()],
    (d) => JSON.stringify([d.strategy2Primary?.paper.openPositions, d.paper?.openPositions]),
  ],
  BandWatch: [
    (d) => {
      const b = d.bandWatch;
      return [b?.entries.length, b?.floorSol, b?.ceilSol, b?.drift, b?.launchMedian, b?.entryMedian,
              b?.entries.map((e) => `${e.sym}:${e.mcSol}`).join()];
    },
    // "Berubah" = yang TERLIHAT berubah. Panel ini kini histogram: umur dan awan launch tidak
    // digambar sama sekali, jadi keduanya dikeluarkan dari pembanding.
    (d) => JSON.stringify({
      f: d.bandWatch?.floorSol, c: d.bandWatch?.ceilSol, dr: d.bandWatch?.drift,
      lm: d.bandWatch?.launchMedian, em: d.bandWatch?.entryMedian,
      e: d.bandWatch?.entries.map((x) => [x.sym, x.mcSol]),
    }),
  ],
  GateFunnel: [
    (d) => [d.strategy2Primary?.totals.gated, d.strategy2Primary?.totals.passed, d.strategy2Primary?.totals.rejected],
    (d) => JSON.stringify(d.strategy2Primary?.totals),
  ],
  SniperRecap: [
    (d) => [d.paper?.opens, d.paper?.closed, d.paper?.balanceSol],
    (d) => JSON.stringify([d.paper?.opens, d.paper?.closed, d.paper?.balanceSol, d.paper?.wins, d.paper?.losses]),
  ],
};

let fail = 0;
console.log(`  ${pushes.length} push sungguhan direkam`);
for (const [name, [fp, deep]] of Object.entries(FP)) {
  let renders = 0, changes = 0, missed = 0, wasted = 0;
  for (let i = 1; i < pushes.length; i++) {
    const a = fp(pushes[i - 1]!), b = fp(pushes[i]!);
    const same = a.length === b.length && a.every((v, k) => v === b[k]);
    const reallySame = deep(pushes[i - 1]!) === deep(pushes[i]!);
    if (!same) renders++;
    if (!reallySame) changes++;
    if (same && !reallySame) missed++;      // BEKU: berubah tapi tidak render
    if (!same && reallySame) wasted++;      // sia-sia
  }
  if (missed) fail++;
  const saved = pushes.length - 1 - renders;
  console.log(`  ${missed ? "✗" : "✓"} ${name.padEnd(15)} render ${renders}/${pushes.length - 1}  (hemat ${saved}, ${(100 * saved / (pushes.length - 1)).toFixed(0)}%)  slice berubah ${changes}  beku ${missed}  sia-sia ${wasted}`);
}
console.log(fail === 0 ? "  LULUS — tidak ada panel yang bisa beku" : `  GAGAL ${fail}`);
process.exit(fail ? 1 : 0);
