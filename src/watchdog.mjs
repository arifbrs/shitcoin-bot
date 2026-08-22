/**
 * WATCHDOG — kills the sniper when its trading path has deadlocked, so the supervisor can
 * restart it.
 *
 * Written after the bot spent 4 hours silently not trading (2026-08-07, 22:57→03:08). The process
 * was alive, logs were being written, the dashboard was green — but every stage after launch
 * intake had stopped: mint-settle, gate-timing, arm-result-set, no-demand-skip all went to zero
 * while `launch` and `observatory-evict` kept flowing. `logs/rpc-health.json` showed the cause:
 * `inFlight 4/4` with `rps 0`. Every concurrency permit was held by a call that never settled, so
 * `acquireHotSlot()` blocked forever and nothing that needs to read the chain could proceed.
 *
 * DELIBERATELY OUTSIDE the files in `codeFingerprint` — a safety net must never cost a cohort
 * reset, or it will keep getting postponed.
 *
 * Two independent detectors, because the first one only catches this specific deadlock:
 *
 *   1. SATURATED-BUT-IDLE   inFlight >= maxConcurrent AND rps == 0.
 *      These cannot both be true in healthy operation: real saturation always has traffic. This
 *      is the exact signature of the incident.
 *
 *   2. INTAKE WITHOUT OUTPUT  launches keep arriving but no decision has been written for a long
 *      time. Catches stalls anywhere between the WebSocket and the gate, including ones whose
 *      mechanism we have not seen yet.
 *
 * Both require SUSTAINED evidence across consecutive checks — a single sample can catch a normal
 * quiet moment, and killing a healthy bot costs real data.
 */
import { readFileSync, existsSync, appendFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const LOG_DIR = process.env.LOG_DIR ?? "logs";
const CHECK_MS = Number(process.env.WATCHDOG_CHECK_MS ?? 60_000);
const STRIKES_TO_KILL = Number(process.env.WATCHDOG_STRIKES ?? 3);   // consecutive checks
const NO_DECISION_MIN = Number(process.env.WATCHDOG_NO_DECISION_MIN ?? 12);
const HEALTH_STALE_MIN = 10;
const PATTERN = process.env.WATCHDOG_PATTERN ?? "tsx src/index.ts";

const now = () => new Date().toISOString();
function say(line) {
  const msg = `[watchdog] ${now()} ${line}`;
  console.log(msg);
  try { appendFileSync(join(LOG_DIR, "watchdog.out"), msg + "\n"); } catch { /* best effort */ }
}

/** Newest mtime among `prefix*.jsonl` in the log dir, or null when none exist. */
function newestMtime(prefix) {
  try {
    let best = null;
    for (const f of readdirSync(LOG_DIR)) {
      if (!f.startsWith(prefix) || !f.endsWith(".jsonl")) continue;
      try {
        const t = statSync(join(LOG_DIR, f)).mtimeMs;
        if (best == null || t > best) best = t;
      } catch { /* file vanished between readdir and stat */ }
    }
    return best;
  } catch { return null; }
}

/**
 * BLIND POSITION — open, past its exit budget, and never once priced.
 *
 * Measured 2026-08-07: of 347 positions opened that day, exactly ONE was never marked — and that
 * one became immortal. Every exit rule the sniper has is defined against the position's peak, the
 * peak is derived from a price, and a position that has never been priced has no peak. So
 * NO_DEVELOPMENT could not fire at 45s, MAX_HOLD could not fire at 120s, and it simply sat there
 * until closed by hand. `lastPriceUsd` was still `null` after 635 seconds; the next-worst blind
 * window all day was 68 seconds.
 *
 * The fix belongs in trader.ts — but that file is inside `codeFingerprint`, so touching it
 * resets the running cohort. This closes the position through exactly the path a human would use:
 * the same `control.json` command the dashboard's close button writes. No cohort cost, and the
 * trade is booked as MANUAL_CLOSE rather than silently vanishing.
 */
export function findBlindPositions(positionsJson, tickMints, nowMs, minAgeSec = 90) {
  const out = [];
  for (const p of positionsJson?.positions ?? []) {
    const mint = p?.candidate?.mint;
    const openedAt = p?.openedAt;
    if (!mint || !openedAt) continue;
    const ageSec = (nowMs - openedAt) / 1000;
    // Never priced: no mark in the tick stream AND no price stored on the position itself.
    const neverPriced = !tickMints.has(mint) && p.lastPriceUsd == null;
    if (neverPriced && ageSec > minAgeSec) {
      out.push({ mint, sym: p?.candidate?.symbol ?? "?", ageSec: Math.round(ageSec) });
    }
  }
  return out;
}

export function diagnose(health, launchMtime, decisionMtime, nowMs) {
  const reasons = [];
  if (!health) return { reasons, note: "no rpc-health.json yet" };

  const healthAgeMin = health.at ? (nowMs - health.at) / 60_000 : Infinity;
  if (healthAgeMin > HEALTH_STALE_MIN) {
    // The trader writes this file on a timer. If it has stopped, the trader is not merely idle.
    reasons.push(`rpc-health basi ${healthAgeMin.toFixed(0)} menit`);
  }

  const saturated = health.maxConcurrent > 0 && health.inFlight >= health.maxConcurrent;
  if (saturated && (health.rps ?? 0) === 0) {
    reasons.push(`semafor buntu: inFlight ${health.inFlight}/${health.maxConcurrent} dengan rps 0`);
  }

  // Intake without output: launches still landing, decisions long silent.
  if (launchMtime != null && decisionMtime != null) {
    const launchAgeMin = (nowMs - launchMtime) / 60_000;
    const decisionAgeMin = (nowMs - decisionMtime) / 60_000;
    if (launchAgeMin < 3 && decisionAgeMin > NO_DECISION_MIN) {
      reasons.push(`launch masuk tapi tidak ada keputusan ${decisionAgeMin.toFixed(0)} menit`);
    }
  }
  return { reasons };
}

/** Mints that appear anywhere in today's tick stream — cheap tail read, not a full parse. */
function markedMints() {
  const set = new Set();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const raw = readFileSync(join(LOG_DIR, `ticks-${today}.jsonl`), "utf8");
    // Only the tail matters: a position open right now would have been marked recently if at all.
    for (const line of raw.slice(-400_000).split("\n")) {
      const i = line.indexOf('"mint":"');
      if (i >= 0) set.add(line.slice(i + 8, line.indexOf('"', i + 8)));
    }
  } catch { /* no ticks yet today */ }
  return set;
}

function closeViaControl(mint, sym, ageSec) {
  const p = join(LOG_DIR, "control.json");
  let state = {};
  try { state = JSON.parse(readFileSync(p, "utf8")); } catch { /* first write */ }
  // Timestamped id so the trader runs it exactly once — same contract the dashboard uses.
  state.command = { id: Date.now(), action: "close", mint };
  try {
    writeFileSync(p, JSON.stringify(state, null, 2));
    say(`MENUTUP posisi buta ${sym} (${mint.slice(0, 8)}…) — terbuka ${ageSec}s tanpa satu pun harga`);
  } catch (e) {
    say(`gagal menulis control.json: ${e.message}`);
  }
}

let strikes = 0;
const blindSeen = new Map();   // mint -> strikes, so one slow tick cannot trigger a close
function tick() {
  let health = null;
  try { health = JSON.parse(readFileSync(join(LOG_DIR, "rpc-health.json"), "utf8")); } catch { /* not up yet */ }
  const nowMs = Date.now();
  const { reasons } = diagnose(health, newestMtime("events-"), newestMtime("decisions-"), nowMs);

  // Blind positions are handled separately from the stall strikes: this is not "the bot is
  // wedged", it is "one position is stuck", and the remedy is a close, not a restart.
  try {
    const pos = JSON.parse(readFileSync(join(LOG_DIR, "positions.json"), "utf8"));
    const blind = findBlindPositions(pos, markedMints(), nowMs);
    const live = new Set(blind.map((b) => b.mint));
    for (const m of [...blindSeen.keys()]) if (!live.has(m)) blindSeen.delete(m);
    for (const b of blind) {
      const n = (blindSeen.get(b.mint) ?? 0) + 1;
      blindSeen.set(b.mint, n);
      say(`posisi buta ${b.sym} ${b.ageSec}s tanpa harga — strike ${n}/2`);
      if (n >= 2) { closeViaControl(b.mint, b.sym, b.ageSec); blindSeen.delete(b.mint); }
    }
  } catch { /* positions.json absent or mid-write */ }

  if (reasons.length === 0) {
    if (strikes > 0) say(`pulih setelah ${strikes} strike`);
    strikes = 0;
    return;
  }
  strikes++;
  say(`strike ${strikes}/${STRIKES_TO_KILL} — ${reasons.join(" · ")}`);
  if (strikes < STRIKES_TO_KILL) return;

  say(`MEMBUNUH sniper (${PATTERN}) — supervisor akan menghidupkan ulang`);
  try {
    execSync(`pkill -f ${JSON.stringify(PATTERN)}`);
    say("sinyal terkirim");
  } catch {
    say("pkill tidak menemukan proses — mungkin sudah mati");
  }
  strikes = 0;   // give the restart a full window before judging it again
}

// Importing this file must not start the loop — the selftest imports `diagnose` directly.
if (process.env.WATCHDOG_RUN === "1") {
  if (!existsSync(LOG_DIR)) { say(`log dir ${LOG_DIR} tidak ada — berhenti`); process.exit(1); }
  say(`mulai · cek tiap ${CHECK_MS / 1000}s · bunuh setelah ${STRIKES_TO_KILL} strike berturut-turut`);
  tick();
  setInterval(tick, CHECK_MS);
}
