/**
 * MC-BAND A/B REPORT — read the experiment, decide nothing on its behalf.
 *
 * Reports each arm's execution-corrected EV, SOL-weighted, with a 95% interval, and says
 * plainly whether the pre-registered stopping rule has been reached. It refuses to declare a
 * winner before that, because the band this experiment exists to question took 3,710 trades to
 * separate from zero — a couple of hundred will not settle anything, and a report that names a
 * winner early is how a coin flip becomes a strategy.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { MC_BAND_AB_SPEC } from "./experiments/mc-band-ab.js";

interface Close {
  action?: string; mcArm?: "LO" | "HI" | null; curveMcSol?: number;
  pnlPct?: number; rawPnlPct?: number; entrySizeSol?: number; execStage?: string;
  mcFloor?: number | null; mcCeiling?: number | null;
  ts?: string; reason?: string; execRealismApplied?: boolean;
}

function closes(): Close[] {
  const out: Close[] = [];
  for (const f of readdirSync(config.logDir).filter((x) => x.startsWith("paper-trades-") && x.endsWith(".jsonl")).sort()) {
    const p = join(config.logDir, f);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as Close;
        if (r.action === "CLOSE" && (r.mcArm === "LO" || r.mcArm === "HI")) out.push(r);
      } catch { /* torn last line on a live file is normal */ }
    }
  }
  return out;
}

function stat(rows: Close[]): { n: number; ev: number; ci: number; sol: number; stake: number; win: number } {
  const usable = rows.filter((r) => typeof r.pnlPct === "number" && typeof r.entrySizeSol === "number" && (r.entrySizeSol ?? 0) > 0);
  const stake = usable.reduce((a, r) => a + (r.entrySizeSol as number), 0);
  if (!usable.length || stake <= 0) return { n: 0, ev: 0, ci: 0, sol: 0, stake: 0, win: 0 };
  const ev = usable.reduce((a, r) => a + (r.pnlPct as number) * (r.entrySizeSol as number), 0) / stake;
  const sd = Math.sqrt(usable.reduce((a, r) => a + Math.pow((r.pnlPct as number) - ev, 2), 0) / usable.length);
  return {
    n: usable.length, ev, ci: 1.96 * sd / Math.sqrt(usable.length),
    sol: usable.reduce((a, r) => a + (r.entrySizeSol as number) * ((r.pnlPct as number) / 100), 0),
    stake, win: usable.filter((r) => (r.pnlPct as number) > 0).length / usable.length * 100,
  };
}

function line(label: string, s: ReturnType<typeof stat>): void {
  if (!s.n) { console.log(`${label.padEnd(22)} belum ada data`); return; }
  console.log(
    `${label.padEnd(22)} ${String(s.n).padStart(5)}  ${((s.ev >= 0 ? "+" : "") + s.ev.toFixed(2) + "%").padStart(9)} ±${s.ci.toFixed(2)}` +
    `   ${((s.sol >= 0 ? "+" : "") + s.sol.toFixed(4)).padStart(9)} ◎   ${s.win.toFixed(0)}% menang`,
  );
}

const rows = closes();
const lo = rows.filter((r) => r.mcArm === "LO");
const hi = rows.filter((r) => r.mcArm === "HI");
const sLo = stat(lo), sHi = stat(hi);
/**
 * Bands come from the DATA, not from this reader's environment.
 *
 * The floors live in the supervisor's exported env, so anyone running this from a plain shell
 * gets config defaults instead — which silently mislabels every row (the first run of this tool
 * printed "HI = lantai 30 · plafon 45" against a live experiment at 55/74). Same lesson the cfg
 * hash taught: read what actually happened, never re-derive it where you happen to be standing.
 */
const floorOf = (rs: Close[]): number | null => {
  const v = rs.map((r) => r.mcFloor).filter((x): x is number => typeof x === "number");
  return v.length ? v[v.length - 1] as number : null;
};
const loFloor = floorOf(lo) ?? config.gate.entryMcAb.loFloorSol;
const prodFloor = floorOf(hi) ?? config.gate.entryMcBandSol.floor;
const ceiling = lo.concat(hi).map((r) => r.mcCeiling).filter((x): x is number => typeof x === "number").pop()
  ?? config.gate.entryMcBandSol.ceiling;
const slice = stat(lo.filter((r) => typeof r.curveMcSol === "number" && (r.curveMcSol as number) < prodFloor));

console.log("═══════ A/B LANTAI ENTRY-MC ═══════");
console.log(`spec ${MC_BAND_AB_SPEC.experimentId}, beku sejak ${MC_BAND_AB_SPEC.frozenAt}`);
console.log(`LO = lantai ${loFloor} · HI = lantai ${prodFloor} · plafon ${ceiling} (sama)`);
console.log(rows.length ? "(pita dibaca dari catatan, bukan dari env shell ini)\n" : "(belum ada baris ber-arm; pita di atas dari config lokal)\n");
console.log("arm                        n         EV        net SOL      angka menang");
line("LO (lantai rendah)", sLo);
line("HI (kontrol)", sHi);
console.log("");
line(`  └ irisan ${loFloor}–${prodFloor - 1}`, slice);

const need = MC_BAND_AB_SPEC.minTradesPerArm;
const ready = sLo.n >= need && sHi.n >= need;
console.log(`\naturan berhenti: ${need} trade/arm (LO ${sLo.n}, HI ${sHi.n}) atau ${MC_BAND_AB_SPEC.maxDays} hari`);
if (!ready) {
  console.log("BELUM CUKUP — jangan putuskan apa pun dari angka di atas.");
  console.log("Selang yang melewati nol berarti 'tidak terukur', bukan 'nol'.");
} else {
  const diff = sLo.ev - sHi.ev;
  const ci = Math.sqrt(sLo.ci * sLo.ci + sHi.ci * sHi.ci);
  console.log(`\nselisih LO − HI: ${(diff >= 0 ? "+" : "") + diff.toFixed(2)} pts ±${ci.toFixed(2)}`);
  console.log(Math.abs(diff) > ci
    ? `→ TERPISAH DARI NOL: ${diff > 0 ? "lantai rendah lebih baik" : "lantai rendah lebih buruk"}.`
    : "→ TIDAK terpisah dari nol: lantai bukan lever yang menentukan. Pertahankan kontrol.");
}
