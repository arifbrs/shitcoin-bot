/**
 * Menguji comparator panelMemo terhadap PUSH SUNGGUHAN yang direkam dari /api/stream.
 *
 * Dua kegagalan yang dicari, dan yang kedua jauh lebih berbahaya:
 *   1. terlalu longgar — panel ikut render padahal slice-nya tidak berubah (sia-sia)
 *   2. TERLALU KETAT — slice berubah tapi sidik jarinya sama, sehingga panel BEKU di layar
 */
import { readFileSync } from "node:fs";
import type { StatsResponse } from "../src/types/stats";

const pushes: StatsResponse[] = JSON.parse(readFileSync("/tmp/pushes.json", "utf8"));

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
