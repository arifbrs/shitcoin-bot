/**
 * EXECUTION REALISM — charge the simulator what execution actually costs.
 *
 * THE PROBLEM THIS EXISTS FOR (owner, 2026-08-25: "simulasi profit ketika live tidak sesuai").
 * Paper and live disagreed, and not slightly. On the SAME 680 trades, chain-verified:
 *
 *      paper claimed  +3.84%        live delivered  −9.08%
 *
 * The disagreement is not spread evenly, which is what makes a flat haircut the wrong fix.
 * The median gap is +0.8 points — on an ordinary trade the simulator is RIGHT. It is wrong,
 * catastrophically, on the ones it says we won:
 *
 *      paper +0..10%   →  live −2.6%   (a small paper gain does not survive the round trip)
 *      paper +10..100% →  live keeps roughly half
 *      paper >+100%    →  live keeps ONE TENTH   (n=32: +340% claimed, +34% realised)
 *
 * That shape is physical, not statistical. Paper marks an exit at a quoted price; live sells
 * seconds later (measured: p50 3.9s, p90 38.7s) into a book that has already moved, and the
 * harder a token spiked the less of that mark is still there when the sell lands. The bigger
 * the claim, the more of it is imaginary.
 *
 * HOW IT WORKS. `npm run live:truth` rebuilds every live trade from the chain and writes the
 * measured transfer function to logs/live-truth.json. This module reads that file — no constant
 * in this file was chosen by a human, and as more live trades land the calibration sharpens by
 * re-running the tool. If the file is missing the module is INERT: an uncalibrated haircut
 * would be a guess wearing the costume of a measurement, which is the thing being fixed.
 *
 * WHAT IT DOES NOT DO. It never touches an exit DECISION — trailing stops, cuts and holds all
 * still see the raw mark, because changing those would be a strategy edit dressed up as an
 * accounting fix. It applies at the booking layer only, and the raw figure is kept in the
 * record beside the adjusted one so nothing is lost.
 *
 * THE ASSUMPTION, STATED PLAINLY. Live is a SUBSET of paper (only mirrored trades exist on
 * chain), so applying this to unmirrored paper trades assumes the mirrored subset is
 * representative of the rest. It is the same assumption every calibration makes, and it is
 * worth re-checking whenever the entry filter changes.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

interface Band { from: number; to: number; n: number; paperPct: number; realPct: number; ratio: number }
interface Calibration { n: number; paperPct: number; realPct: number; bands: Band[] }

/** A band thinner than this cannot steer real money; fall back rather than pretend. */
const MIN_BAND_N = 15;

let loaded: { cal: Calibration | null; mtimeMs: number } | null = null;

function calibration(): Calibration | null {
  const path = join(config.logDir, "live-truth.json");
  if (!existsSync(path)) return null;
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return null; }
  if (loaded && loaded.mtimeMs === mtimeMs) return loaded.cal;
  let cal: Calibration | null = null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { calibration?: Calibration };
    const c = raw.calibration;
    if (c && Array.isArray(c.bands) && c.bands.length > 0 && c.n > 0) cal = c;
  } catch { cal = null; }
  loaded = { cal, mtimeMs };
  return cal;
}

export interface RealismVerdict {
  /** The percentage to BOOK. Equals `paperPct` when the module is inert. */
  pct: number;
  applied: boolean;
  /** Fraction of the claim that survives — reported for the record, not used to re-derive. */
  ratio: number | null;
  /** Which part of the measured curve answered: "scaled", "interp" or "cap". */
  band: string | null;
  bandN: number | null;
  /** Total live trades behind the calibration — the number that says how much to trust it. */
  calN: number | null;
}

interface Point { p: number; r: number; n: number }

/**
 * The measured transfer function, as points rather than a lookup.
 *
 * Two corrections are baked in here, and both came from this module's own self-test failing:
 *
 *   · MONOTONE. Raw, the top band delivers LESS than the one below it (+340% claimed returns
 *     +34%, while +80% claimed returns +52%). That is a true fact about 32 trades and a
 *     terrible transfer function: it would book a bigger claim as a smaller number and scramble
 *     every cohort comparison. A running maximum keeps the curve non-decreasing, which turns
 *     the top band into what it really is — a CEILING. We have never realised more than about
 *     +52% on average, so nothing gets booked above it.
 *   · BOUNDS ARE NOT USED. `from`/`to` are Infinity in memory and `null` after a JSON round
 *     trip, and comparing a number against `null` silently succeeds as a comparison against 0.
 *     That bug booked a −40% trade as +94%. Interpolating between measured centroids needs no
 *     bounds at all, so the trap is gone rather than guarded.
 */
function curve(cal: Calibration): Point[] {
  const pts = cal.bands
    .filter((b) => b.n >= MIN_BAND_N && Number.isFinite(b.paperPct) && Number.isFinite(b.realPct))
    .map((b) => ({ p: b.paperPct, r: b.realPct, n: b.n }))
    .sort((a, b) => a.p - b.p);
  let best = -Infinity;
  for (const q of pts) { best = Math.max(best, q.r); q.r = best; }
  return pts;
}

/**
 * Translate a paper P&L percentage into the percentage live would have delivered.
 *
 * Losses are adjusted too, and upward: chain-verified, live LOSES LESS than paper models on a
 * losing trade (−19.2% against a claimed −27.1%). Applying the measurement in only the
 * flattering direction would be picking the number that suits the story, which is the original
 * sin here.
 */
export function applyExecutionRealism(paperPct: number): RealismVerdict {
  const inert: RealismVerdict = { pct: paperPct, applied: false, ratio: null, band: null, bandN: null, calN: null };
  if (!config.risk.execRealism) return inert;
  if (!Number.isFinite(paperPct)) return inert;
  const cal = calibration();
  if (!cal) return inert;
  const pts = curve(cal);
  if (!pts.length) return inert;

  // Never extrapolate across zero. With no measured GAIN we have nothing to say about a gain,
  // and saying it anyway is how a calibration starts inventing. Same for the loss side.
  const first = pts[0] as Point, last = pts[pts.length - 1] as Point;
  if (paperPct > 0 && !pts.some((q) => q.p > 0)) return inert;
  if (paperPct < 0 && !pts.some((q) => q.p < 0)) return inert;

  let out: number, band: string, bandN: number;
  if (paperPct <= first.p) {
    // Below everything measured: scale proportionally off the nearest evidence. A deeper loss
    // than we have ever measured is still a deeper loss — the shape does not flip.
    const ratio = Math.abs(first.p) > 0.5 ? first.r / first.p : 1;
    out = paperPct * ratio; band = "scaled"; bandN = first.n;
  } else if (paperPct >= last.p) {
    out = last.r; band = "cap"; bandN = last.n;                 // the ceiling, see curve()
  } else {
    let i = 0;
    while (i + 1 < pts.length && (pts[i + 1] as Point).p <= paperPct) i++;
    const a = pts[i] as Point, b = pts[i + 1] as Point;
    const t = b.p === a.p ? 0 : (paperPct - a.p) / (b.p - a.p);
    out = a.r + t * (b.r - a.r); band = "interp"; bandN = Math.min(a.n, b.n);
  }

  const pct = Math.max(-100, out);
  return {
    pct,
    applied: true,
    ratio: Math.abs(paperPct) > 1e-9 ? Number((pct / paperPct).toFixed(4)) : null,
    band, bandN, calN: cal.n,
  };
}

/** One line for startup, so an adjusted ledger can never be mistaken for a raw one. */
export function realismBanner(): string | null {
  if (!config.risk.execRealism) return null;
  const cal = calibration();
  if (!cal) return "[realism] EXEC_REALISM aktif tapi BELUM terkalibrasi — jalankan `npm run live:truth` (sementara ini pembukuan mentah)";
  return `[realism] pembukuan paper dikoreksi ke eksekusi NYATA — kalibrasi dari ${cal.n} trade live terverifikasi chain (paper ${cal.paperPct.toFixed(2)}% → nyata ${cal.realPct.toFixed(2)}%)`;
}

/** Test seam: forget the cached file so a test can swap calibrations. */
export function __resetRealismCache(): void { loaded = null; }
