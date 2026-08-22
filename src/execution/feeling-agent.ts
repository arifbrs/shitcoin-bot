import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { ui, logRecord } from "../util/log.js";

/**
 * Feeling Agent — an LLM "vibe" judge (the right-brain the metrics gate lacks).
 * Given a held token's momentum picture, it reasons flexibly about whether the
 * hype is still alive (rame) or dying (sepi), the way a human trader would.
 *
 * Best-effort: short timeout, one retry, returns null on any failure so it never
 * blocks the pipeline. NON-SENSITIVE input only — token symbol + on-chain metrics,
 * never keys or wallet data (the relay is third-party and may log prompts).
 */
export const feelingEnabled = Boolean(config.feeling.url && config.feeling.key);

// ── AGENT HEALTH ──────────────────────────────────────────────────────────────
// The LLM is the primary exit brain. If it dies (API down / timeout / bad JSON / no
// key), positions must NOT be left unmanaged — a mechanical fallback takes over. We
// track liveness here so the trader knows when to hand control to the rule-based net,
// and the dashboard can show a clear ALIVE/DOWN indicator (owner wants to SEE it).
interface FeelingHealth {
  enabled: boolean;
  alive: boolean; // enabled AND not in a failure streak
  lastSuccessAt: number;
  lastFailAt: number;
  consecutiveFailures: number;
  calls: number;
  successes: number;
  lastError?: string;
  model: string;
  windowRate?: number; // success rate over the recent trading-path window (drives `alive`)
  windowN?: number;
  shadowCalls?: number; // research judgments — counted, but never allowed to affect `alive`
  shadowFails?: number;
}
const _health = { lastSuccessAt: 0, lastFailAt: 0, consecutiveFailures: 0, calls: 0, successes: 0, lastError: undefined as string | undefined };
// Rolling window of recent TRADING-path outcomes (true = success). Liveness is judged on the rate
// here, not on a raw consecutive count — see feelingHealth().
const _window: boolean[] = [];
const WINDOW = 12;
let _shadowCalls = 0, _shadowFails = 0; // research calls, tracked separately and NEVER used for liveness
const HEALTH_PATH = join(config.logDir, "agent-health.json");
// Persist to a file so the SEPARATE server process can show a live ALIVE/DOWN indicator.
function persistHealth(): void { try { writeFileSync(HEALTH_PATH, JSON.stringify(feelingHealth())); } catch { /* best-effort */ } }
function note(ok: boolean, shadow: boolean, err?: string): void {
  // SHADOW IS RESEARCH, NOT A TRADING DEPENDENCY. Its failures must not mark the exit brain dead:
  // shadow judges positions the agent is not even allowed to act on, and it multiplies call volume
  // several-fold, so counting its timeouts against liveness made the agent look DOWN purely
  // because we asked it more questions. (Measured: 14 of 21 calls were shadow.)
  if (shadow) {
    _shadowCalls++; if (!ok) _shadowFails++;
    // AUDIT P1-4: this used to return before persisting, so a position stuck pre-derisk (agent
    // only ever runs in shadow for it) never refreshed agent-health.json — the dashboard's
    // ALIVE/DOWN readout could go stale for over an hour even while shadow calls kept happening.
    persistHealth();
    return;
  }
  _health.calls++;
  if (ok) { _health.successes++; _health.consecutiveFailures = 0; _health.lastSuccessAt = Date.now(); }
  else { _health.consecutiveFailures++; _health.lastFailAt = Date.now(); _health.lastError = err; }
  _window.push(ok);
  if (_window.length > WINDOW) _window.shift();
  persistHealth();
}
function recordSuccess(shadow = false): void { note(true, shadow); }
function recordFailure(err: string, shadow = false): void { note(false, shadow, err); }

/**
 * Is the LLM agent currently trustworthy as the exit brain? False → mechanical fallback.
 *
 * A raw "3 consecutive failures" test is the WRONG liveness metric for a flaky relay. This one
 * times out on roughly a third of calls (measured 7/21), and at that rate a 3-in-a-row streak
 * appears somewhere in 21 calls about 51% of the time — so DOWN was being declared by chance,
 * not because the agent was broken, while 67% of calls were answering fine.
 *
 * Liveness is now: usable unless the recent window is genuinely bad, OR the relay is hard-down.
 */
export function feelingHealth(): FeelingHealth {
  const recentOk = _window.filter(Boolean).length;
  const windowRate = _window.length ? recentOk / _window.length : 1;
  const hardDown = _health.consecutiveFailures >= config.risk.agentFallback.hardDownFailures;
  const degraded = _window.length >= WINDOW && windowRate < config.risk.agentFallback.minSuccessRate;
  const alive = feelingEnabled && !hardDown && !degraded;
  return { enabled: feelingEnabled, alive, ..._health, model: config.feeling.model,
    windowRate: Number(windowRate.toFixed(2)), windowN: _window.length, shadowCalls: _shadowCalls, shadowFails: _shadowFails };
}

export interface Vibe {
  vibe: "alive" | "dying" | "dead" | "abstain"; // ABSTAIN (owner spec): on-chain data often incomplete — forcing alive/dead makes false certainty
  confidence: number; // 0-100 (self-reported; calibrated later against outcomes)
  reason: string;
  evidence?: string[]; // codes: BUYERS_EXPANDING, DEV_NOT_SELLING, VOLUME_DRYING, … (auditable)
  missingCritical?: string[]; // critical data the agent lacked (drives abstain)
  /** Set when the model's own prose contradicted the numbers it was given — see checkNumericFidelity. */
  numericMismatch?: { claimedPct: number; actualPct: number };
}

/**
 * Does the model's prose agree with the numbers we handed it?
 *
 * Caught live (owner spotted it on the dashboard, 2026-07-31): for position STABLE we sent
 * `priceFromEntryPct: 0.1` and the model replied "Harga naik 10%" — a 100x misread, while the
 * position card correctly showed +0.1%. It is not a data bug; six minutes earlier the same model
 * answered "Harga naik 0.1% dari entry" from the same input. The model simply does not reliably
 * read the number it is given.
 *
 * That matters beyond cosmetics. `agentCanExit` is on, so a `dead` verdict at >=70% confidence
 * CLOSES a real position. A model that demonstrably was not reading the inputs must not be
 * allowed to act on them — so a verdict that contradicts its own input is downgraded to
 * `abstain`, which every caller already treats as non-actionable. The original text is preserved
 * so the dashboard still shows what the agent said, flagged rather than silently trusted.
 *
 * Tolerances are deliberately loose to avoid punishing rounding: a claim only counts as a
 * contradiction when it is at least 5 percentage points away AND more than 3x off in relative
 * terms. "0.1% vs 0.2%" passes; "10% vs 0.1%" does not.
 */
function checkNumericFidelity(reason: string, actualPct: number): { claimedPct: number; actualPct: number } | null {
  // Percentages the model states about the move, e.g. "naik 10%", "-24.5%", "turun 3 %".
  const claims = [...reason.matchAll(/(-?\d+(?:[.,]\d+)?)\s*%/g)]
    .map((m) => Number(m[1]!.replace(",", ".")))
    .filter((n) => Number.isFinite(n));
  for (const claimed of claims) {
    const absDiff = Math.abs(claimed - actualPct);
    if (absDiff < 5) continue; // within rounding tolerance — not a contradiction
    const denom = Math.max(Math.abs(actualPct), 0.05);
    if (Math.abs(claimed) / denom > 3) return { claimedPct: claimed, actualPct };
  }
  return null;
}

export interface VibeInput {
  symbol: string;
  mode: string;
  heldSec: number;
  // — momentum (harga) —
  priceFromEntryPct: number; // % gerak harga sejak entry
  peakGainPct: number; // puncak tertinggi dari entry
  drawdownFromPeakPct: number; // seberapa jauh turun dari puncak
  // — volume / pembelian (sinyal "rame" yang paling hidup) —
  // Optional (2026-07-30): Strategy 2 doesn't track live buy-flow per position the way the
  // sniper's candidate stream does — undefined here means "not tracked for this caller", and
  // must be read as DATA TAK TERSEDIA (see prompt rule 2 below), never fabricated as 0/absent-buying.
  buyingGrowthPct?: number; // pertumbuhan cadangan kurva sejak entry = SOL beli baru masuk
  secsSinceLastBuyingHigh?: number; // detik sejak pembelian baru terakhir (0 = lagi rame)
  // — market —
  marketCapUsd?: number; // estimasi marketcap live
  // — CHART mentah (deret candle; BACA sendiri bentuknya, jangan andalkan label) —
  chart?: {
    interval: string; // timeframe, mis "1m"
    closes: number[]; // close terakhir, di-index first=100 (bentuk, bebas ukuran token)
    vols: number[]; // volume SOL per candle (urutan sama: lama → baru)
    changePct: number; // gerak harga sepanjang jendela candle
  } | null;
  // — komunitas / kualitas —
  holdersAtEntry?: number;
  organicScore?: number; // 0-100: aktivitas organik vs wash/fake
  // — metrik holder ala app pump.fun (BUKAN garis mati; baca kontekstual vs tape/crowd) —
  whale?: {
    sniperPct: number; // % supply dipegang sniper 10 detik pertama
    bundlerPct: number; // % supply dipegang bundler (batch terkoordinasi)
    devPct: number; // % supply masih dipegang dev
    top10Pct: number; // % supply dipegang 10 wallet terbesar
  } | null;
  // — CROWD live (siapa yang beli, dari stream trade) —
  crowd?: {
    uniqueBuyers: number; // pembeli unik dalam window (banyak = crowd organik)
    buys: number;
    sells: number;
    buyRatio: number; // 0..1, porsi beli vs total
    netBuyVolSol: number; // beli − jual (akumulasi vs distribusi)
    lastTradeSecAgo: number;
  } | null;
  // — dev —
  devBehavior: string; // "only-buys" | "buy-back" | "quiet" | "dumped" | "unknown"
  // — rug-cluster: coordinated funding of "different" wallets = organized-rug setup —
  rugCluster?: { clusterWallets: number; clusterPct: number; devFundedBuyers: number; coordinated: boolean } | null;
  // NOTE: `entrySignature` / `winnerProfile` used to live here. They were removed as target
  // leakage (built from confirmStats captured at T+45-180s — the future relative to entry) and
  // must NOT be reintroduced without a leakage-free source.
}

/** `shadow` = research judgment the agent may not act on; its failures never affect liveness. */
// RELAY CIRCUIT BREAKER (audit 2026-07-31). Measured over the day: 743 failed llm-calls against
// 213 successes, the failures arriving in one unbroken run of timeouts once the relay went down.
// Each failure costs a full `config.feeling.timeoutMs` (40s) of a held slot before it gives up,
// so a sustained outage is not free — it is a steady drip of stalled calls for a signal that is
// observational only and never blocks a mechanical exit. This does not attempt to FIX the relay
// (it is a third-party outage, not a bug on our side); it just stops asking every time once the
// answer has been "timeout" many times in a row, and lets a single probe through after the
// cooldown so recovery is detected on its own without a restart.
const RELAY_BREAKER = { consecutiveFails: 0, openUntil: 0 };
const RELAY_TRIP_AFTER = 8;
const RELAY_COOLDOWN_MS = 5 * 60_000;

export function relayBreakerOpen(): boolean { return Date.now() < RELAY_BREAKER.openUntil; }

/**
 * CONCURRENCY GATE — the actual cause of the agent's 82% failure rate, measured rather than
 * guessed (owner, 2026-07-31).
 *
 * The symptom looked like a dead relay: 669 timeouts against 146 successes in one day, with a
 * median latency of 40,002ms — i.e. the median call did not merely run late, it hit the 40s
 * timeout wall exactly. The natural readings were "the relay is down" or "the prompt is too big",
 * and both were wrong. Probing the relay directly:
 *
 *     1 call alone      →  7.2s   finish=stop, content returned
 *     5 calls at once   → 11.2s, 14.3s, 18.2s, 20.7s, 29.1s
 *
 * Latency scales with in-flight requests, so this relay is effectively serial. The bot judges
 * every open position on the same tick, so a handful of positions is enough to push the tail past
 * 40s — and every one of those doomed calls still occupied a 40-second slot before giving up.
 *
 * So calls are limited to a small number in flight. Crucially the excess is DROPPED, not queued:
 * a vibe read is observational (it never blocks a mechanical exit) and a stale opinion about a
 * position is worth less than nothing, so waiting behind a queue would trade a fast honest null
 * for a slow irrelevant answer. Callers already handle null.
 */
// Measured at 1, not 2: even two in flight degraded each other badly (28s and 80s against a 7s
// solo baseline). The relay serves essentially one request at a time, so admitting a second buys
// nothing and makes both slow.
const MAX_INFLIGHT = 1;
let inFlight = 0;
export function relayInFlight(): number { return inFlight; }

export async function judgeVibe(input: VibeInput, shadow = false): Promise<Vibe | null> {
  if (!feelingEnabled) return null;
  if (relayBreakerOpen()) {
    logRecord("events", { type: "llm-call", shadow, skipped: true, errorType: "breaker-open", ok: false, model: config.feeling.model });
    return null;
  }
  if (inFlight >= MAX_INFLIGHT) {
    // Shed rather than queue — see the MAX_INFLIGHT comment. Logged so the shed rate is visible
    // instead of silently looking like "the agent had no opinion".
    logRecord("events", { type: "llm-call", shadow, skipped: true, errorType: "concurrency-shed", inFlight, ok: false, model: config.feeling.model });
    return null;
  }
  inFlight++;
  try {
    return await judgeVibeInner(input, shadow);
  } finally {
    inFlight--;
  }
}

async function judgeVibeInner(input: VibeInput, shadow: boolean): Promise<Vibe | null> {
  const prompt =
    `PERAN kamu = RunnerStateAgent: kamu HANYA menilai apakah RUNNER SISA (setelah partial) masih hidup, buat ` +
    `keputusan HOLD vs EXIT. Kamu TIDAK mengatur catastrophic stop, exposure cap, atau principal recovery — itu ` +
    `mekanis & di luar wewenangmu. Kamu boleh menjawab ABSTAIN kalau data on-chain belum cukup (jangan maksa alive/dead = kepastian palsu).\n` +
    `WAJIB sertakan evidenceCodes (mis BUYERS_EXPANDING, DEV_NOT_SELLING, VOLUME_DRYING, NEAR_PEAK, DEEP_DRAWDOWN) dan missingCritical (data penting yang tidak ada).\n\n`;
  const promptBody =
    `Kamu analis posisi memecoin Solana yang berpengalaman. BACA sinyal LIVE di bawah seperti trader sungguhan, ` +
    `lalu putuskan apakah keyakinan untuk TETAP TAHAN sedang MENGUAT atau MELEMAH. Ini keputusan "wait and see" — jangan kaku, baca keseluruhan cerita.\n\n` +
    `Cara membaca (URUT PRIORITAS — harga di atas segalanya):\n` +
    `1. HARGA sinyal TERKUAT. priceFromEntryPct NAIK dan drawdownFromPeakPct kecil (dekat puncak) = momentum HIDUP → TAHAN. ` +
    `JANGAN PERNAH jual koin yang sedang naik & masih dekat puncak, apa pun sinyal lain. Naik = hidup, titik.\n` +
    `2. buyingGrowthPct naik + secsSinceLastBuyingHigh kecil = pembeli baru masuk → hidup. Kalau KEDUANYA field ini tidak ada (undefined) = DATA TAK TERSEDIA untuk posisi ini, BUKAN sinyal sepi — jangan anggap bearish, cuma andalkan harga (poin 1) + dev (poin 3) saja untuk posisi ini.\n` +
    `3. dev only-buys/buy-back = konviksi hidup. dev "dumped" = PERINGATAN, BUKAN mati otomatis — data kami buktikan dev jual TAPI koin lari +108% (dev jual ≠ rug). Timbang: dev dumped + harga NAIK/crowd masih beli = crowd nyerap, TAHAN; dev dumped + harga AMBRUK/crowd sepi = baru keluar.\n` +
    `4. crowd = null berarti DATA TAK TERSEDIA — BUKAN sinyal jelek. JANGAN anggap bearish, JANGAN sebut "tidak ada trader". Abaikan saja, andalkan harga + buyingGrowth + dev.\n` +
    `5. organicScore rendah SAJA TIDAK cukup untuk menjual koin yang harganya naik. Memecoin baru wajar organic-nya rendah.\n` +
    `6. whale (sniper/bundler/dev/top10 %) = KONTEKS, BUKAN garis mati. Tiap koin beda. sniper/bundler tinggi TAPI harga naik & crowd banyak beli = crowd nyerap, boleh tahan. sniper/bundler tinggi DAN harga loyo/crowd tipis = risiko dump, condong jual. dev% besar + dev mulai jual = bahaya. Timbang lawan tape & harga, jangan reflek jual cuma karena angka.\n` +
    `7. chart = deret candle MENTAH (closes di-index first=100, + volume). BACA bentuknya sendiri seperti trader: higher-lows/konsolidasi sehat = tahan; puncak memudar + volume kering = melemah. JANGAN kaku pada satu candle — lihat keseluruhan pola.\n` +
    // RULE 8 REMOVED (dead instruction). It told the model to compare `entrySignature` against a
    // learned `winnerProfile` — but BOTH fields were stripped from VibeInput when the winner-DNA
    // prior was found to be target leakage (confirmStats is captured at T+45-180s, i.e. the
    // future). The prompt kept instructing the model to reason about data it never receives:
    // ~100 wasted tokens per call and an invitation to hedge or hallucinate around a missing
    // field. Numbering left as-is below so the remaining rules keep their identity in the logs.
    `9. rugCluster = deteksi SETUP RUG TERKOORDINASI. coordinated=true artinya banyak wallet "beda" ternyata didanai 1 sumber sama (clusterWallets dari 1 pendana pegang clusterPct% supply), atau dev langsung mendanai pembeli awal (devFundedBuyers). Ini tanda permintaan PALSU/dikoordinir — RISIKO DUMP TINGGI. Kalau coordinated=true DAN harga mulai loyo/dev gerak = CONDONG KELUAR cepat (jangan tunggu). Kalau coordinated=true TAPI harga masih kuat naik & crowd organik ikut masuk = tetap waspada tapi boleh tahan selagi naik. coordinated=false = funding independen, aman dari sisi ini.\n` +
    `PENTING — JANGAN BUNUH WINNER: memecoin itu asimetris. Data kami membuktikan koin yang kami potong di minus kecil (−2%..−7%) BEBERAPA lalu terbang +300% bahkan +9000%. Rugi kecil yang dibiarkan bisa jadi 10-90×. Maka: minus KECIL + belum ada tanda mati NYATA = TAHAN, beri ruang ke ekor gemuk. Jangan jual cuma karena "sepi sebentar" atau "minus dikit".\n` +
    `MATI (baru boleh jual) HANYA jika sinyal kematian NYATA: chart rusak parah (jatuh dalam dari puncak + volume kering + sepi lama), ATAU dev dumped DAN harga sekarang ikut ambruk/crowd sepi. Dev dumped SENDIRIAN saat harga masih tegak/naik = BUKAN mati → TAHAN. Bukan sekadar minus kecil atau jeda sepi. Kalau ragu → TAHAN.\n\n` +
    `Data posisi:\n${JSON.stringify(input, null, 2)}\n\n` +
    `Jawab HANYA JSON valid tanpa teks lain: {"vibe":"alive"|"dying"|"dead"|"abstain","confidence":0-100,"reason":"<=15 kata","evidence":["CODE",...],"missingCritical":["CODE",...]}`;
  void promptBody;
  const fullPrompt = prompt + promptBody;

  for (let attempt = 0; attempt < 2; attempt++) {
    const startedAt = Date.now();
    // AUDIT P1-4 telemetry — every attempt (success or fail) gets one structured record with
    // latency, HTTP status, finish_reason, and a categorized error type, logged in the `finally`
    // below so a diagnosis never depends on reconstructing it from console warnings after the fact.
    let httpStatus: number | null = null, finishReason: string | null = null, errorType: string | null = null, timedOut = false, logged = false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => { timedOut = true; ctrl.abort(); }, config.feeling.timeoutMs);
      // OpenAI-compatible chat/completions (the format the relay is confirmed to serve
      // for MiniMax-M3: Bearer auth, choices[0].message.content).
      const res = await fetch(`${config.feeling.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.feeling.key!}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          // Walk the chain across attempts: attempt 0 gets the fast model, a retry falls through
          // to the next entry. A model that is retired (HTTP 410) or hanging therefore costs one
          // attempt, not the whole verdict.
          model: config.feeling.modelChain[Math.min(attempt, config.feeling.modelChain.length - 1)]
            ?? config.feeling.model,
          temperature: 0.3,
          max_tokens: config.feeling.maxTokens,
          messages: [{ role: "user", content: fullPrompt }],
          // Best-effort schema hint — this relay is a nonstandard passthrough over several
          // backing models (see maxTokens comment above), so it may just ignore an unsupported
          // field. The regex-based extraction below stays the authoritative parser either way.
          response_format: { type: "json_object" },
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      httpStatus = res.status;
      if (!res.ok) { const e = `HTTP ${res.status}`; errorType = "http-error"; if (attempt === 1) { ui.warn(`[feeling] LLM ${e} ${(await res.text()).slice(0, 120)}`); recordFailure(e, shadow); } continue; }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }> };
      const msg = j.choices?.[0]?.message;
      finishReason = j.choices?.[0]?.finish_reason ?? null;
      // Reasoning models (routed by `auto`) leave `content` null and put the answer — or, if the
      // token budget was tight, only their half-finished thinking — in reasoning_content. Prefer
      // content, then fall back to the reasoning field so a JSON answer there is still recovered.
      const text = msg?.content || msg?.reasoning_content || msg?.reasoning || "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { errorType = "no-json"; if (attempt === 1) { ui.warn(`[feeling] LLM reply had no JSON: ${text.slice(0, 100)}`); recordFailure("no-json", shadow); } continue; }
      const parsed = JSON.parse(m[0]) as Vibe;
      // Validate the vibe is one of the THREE valid verdicts — any other string was
      // silently accepted before, letting a malformed reply drive an exit decision.
      if ((parsed.vibe === "alive" || parsed.vibe === "dying" || parsed.vibe === "dead" || parsed.vibe === "abstain") && typeof parsed.confidence === "number") {
        parsed.confidence = Math.max(0, Math.min(100, parsed.confidence)); // clamp (verify: was unbounded)
        const mismatch = checkNumericFidelity(String(parsed.reason ?? ""), input.priceFromEntryPct);
        if (mismatch) {
          logRecord("events", {
            type: "vibe-numeric-mismatch", symbol: input.symbol, shadow,
            claimedPct: mismatch.claimedPct, actualPct: mismatch.actualPct,
            originalVibe: parsed.vibe, originalConfidence: parsed.confidence,
            reason: parsed.reason, model: config.feeling.model,
          });
          ui.warn(`[feeling] ${input.symbol} verdict ignored — model said ${mismatch.claimedPct}% but the real move is ${mismatch.actualPct}%; downgraded to abstain so it cannot drive an exit`);
          parsed.numericMismatch = mismatch;
          parsed.vibe = "abstain";
          parsed.confidence = 0;
        }
        recordSuccess(shadow);
        RELAY_BREAKER.consecutiveFails = 0; // a real answer means the relay is back
        return parsed;
      }
      errorType = "bad-shape";
      if (attempt === 1) recordFailure("bad-shape", shadow);
    } catch (e) {
      errorType = timedOut ? "timeout" : "network";
      if (attempt === 1 || timedOut) { ui.warn(`[feeling] LLM call failed: ${(e as Error).message}`); recordFailure((e as Error).message, shadow); }
      if (++RELAY_BREAKER.consecutiveFails >= RELAY_TRIP_AFTER && !relayBreakerOpen()) {
        RELAY_BREAKER.openUntil = Date.now() + RELAY_COOLDOWN_MS;
        ui.warn(`[feeling] relay failed ${RELAY_BREAKER.consecutiveFails}x in a row — pausing vibe calls for ${RELAY_COOLDOWN_MS / 60_000}min (observational signal only, exits are unaffected)`);
      }
      // A TIMEOUT is not worth retrying. Measured: a doomed call spent 80s — two full attempts
      // that each ran out the clock — while holding the only in-flight slot the whole time, which
      // is precisely the starvation this gate exists to stop. A timeout means the relay is busy,
      // and asking the busy relay again immediately cannot help. Other error classes (http-error,
      // no-json, bad-shape) come back fast and ARE worth one more try, so they still fall through
      // to the retry below.
      if (timedOut) { logAttempt(); return null; }
    } finally {
      logAttempt();
    }
    function logAttempt(): void {
      if (logged) return;
      logged = true;
      logRecord("events", {
        type: "llm-call", attempt, shadow, latencyMs: Date.now() - startedAt,
        httpStatus, finishReason, errorType, timedOut, model: config.feeling.model,
        ok: errorType === null,
      });
    }
  }
  return null;
}
