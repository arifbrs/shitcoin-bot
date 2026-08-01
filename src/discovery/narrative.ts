/**
 * NARRATIVE CROWDING — how many coins sharing this one's name-theme launched recently.
 *
 * pump.fun launches arrive in THEMED WAVES: a news story breaks and dozens of devs ship coins on
 * the same idea within hours. Observed here: 580 launches across 196 distinct symbols on a single
 * "Robinhood" theme. Our existing copycat guard only blocks the SAME symbol inside a window, so it
 * sees none of this — 196 different tickers all riding one narrative sail straight through.
 *
 * MEASURED (5,348 observed launches with a terminal outcome), bucketed by how many same-theme
 * launches occurred in the 6h BEFORE each one:
 *     0-2 copycats  →  3.5% ever ran ≥+50%,  3.1% rug
 *     3-9           → 10.4% ran,            12.7% rug
 *     10-29         →  8.9% ran,             7.1% rug
 *     30+           →  4.0% ran,             4.6% rug
 * So it is NOT a first-mover effect — a lonely launch is as dead as a saturated one, and the
 * runner rate peaks at moderate crowding. (An earlier cut of this analysis DID show a clean
 * first-mover edge; that was an artefact of ranking by position in OUR log rather than by real
 * elapsed time, and it disappeared under this definition. Kept as a warning.)
 *
 * This module only MEASURES. Runner rate is not profitability — the 3-9 bucket also carries the
 * highest rug rate — so the crowding figure is recorded on every trade and must be validated
 * against real P&L before it is ever allowed to gate an entry.
 *
 * Cost: pure in-memory string work on data we already receive. No RPC, no network.
 */

/** Words too generic to identify a narrative — they would group unrelated coins together. */
const STOP = new Set([
  "the", "a", "coin", "token", "on", "of", "to", "is", "it", "and", "for", "in", "my", "we", "you",
  "sol", "solana", "pump", "fun", "with", "this", "that", "new", "official",
]);

const WINDOW_MS = 6 * 60 * 60_000;
const MAX_THEMES = 20_000; // bound memory on a 24/7 run

/** token → ascending launch timestamps within the window */
const seen = new Map<string, number[]>();

function themeTokens(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z]{4,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  return [...out];
}

/**
 * Record this launch and return how crowded its theme already was.
 * `crowd` = the busiest single name-token, i.e. how many coins sharing that word launched in the
 * preceding window. Call ONCE per launch, at detection.
 */
export function noteLaunchTheme(name: string | undefined, symbol: string | undefined, at = Date.now()): { crowd: number; theme: string | null } {
  const tokens = themeTokens(`${name ?? ""} ${symbol ?? ""}`);
  let crowd = 0, theme: string | null = null;
  const cutoff = at - WINDOW_MS;
  for (const w of tokens) {
    let hist = seen.get(w);
    if (!hist) { hist = []; seen.set(w, hist); }
    while (hist.length && hist[0]! < cutoff) hist.shift(); // drop anything outside the window
    if (hist.length > crowd) { crowd = hist.length; theme = w; }
    hist.push(at);
  }
  // Bound memory: drop themes whose whole history has aged out.
  if (seen.size > MAX_THEMES) {
    for (const [w, h] of seen) { if (!h.length || h[h.length - 1]! < cutoff) seen.delete(w); if (seen.size <= MAX_THEMES) break; }
  }
  return { crowd, theme };
}

/** Diagnostic: the loudest narratives running right now. */
export function hotThemes(n = 5): Array<{ theme: string; launches: number }> {
  const cutoff = Date.now() - WINDOW_MS;
  return [...seen.entries()]
    .map(([theme, h]) => ({ theme, launches: h.filter((t) => t >= cutoff).length }))
    .filter((x) => x.launches >= 3)
    .sort((a, b) => b.launches - a.launches)
    .slice(0, n);
}
