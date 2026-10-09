/**
 * STRATEGY-2 OUTCOME TRACKER — read-only, standalone, zero capital.
 *
 * The scout (strategy2-scout.ts) only logs an ENTRY snapshot (MC/holders/momentum at the
 * moment a mint is first seen). That snapshot alone can never answer "did this candidate do
 * well" — without a later re-check it's just a watchlist, not evidence. This process closes
 * that loop: for every distinct mint the scout has ever logged, once it has aged past a fixed
 * horizon (default 6h/24h/48h) since its FIRST sighting, re-fetch the same Solana Tracker
 * single-token endpoint and log the delta (MC change %, holder change, rugged/risk now).
 *
 * Runs as its OWN process on its OWN timer, reads existing log files only (never touches
 * PaperTrader/the sniper), and writes a new "strategy2-outcome" record type. No position is
 * ever opened — this is measurement only.
 *
 * Run: npm run strategy2:outcome
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { logRecord, ui } from "../util/log.js";
import { tokenMarketSnapshot } from "./token-market.js";

interface CandidateSnapshot {
  mint: string; sym: string; firstSeenAt: number; source: string; cfg?: string | null; epoch?: string | null;
  entryMcUsd: number; entryHolders: number;
}

function readEventRows(): Record<string, unknown>[] {
  let files: string[];
  try { files = readdirSync(config.logDir); } catch { return []; }
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    if (!f.startsWith("events-") || !f.endsWith(".jsonl")) continue;
    let text: string;
    try { text = readFileSync(join(config.logDir, f), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
  }
  return out;
}

/**
 * Earliest-sighting snapshot per (mint, source, cfg, epoch) — KEYED BY SOURCE (review fix,
 * 2026-07-27): the whole point of running Solana Tracker / gmgn-trending / gmgn-trenches
 * concurrently was to later compare which source's candidates actually did better. Keying by
 * mint ALONE collapsed every source's observation of the same mint into one, discarding `source`
 * entirely — 17 of 281 mints seen by more than one source silently lost that distinction, and 34
 * outcome rows already written have no `source`/`cfg` to attribute them by.
 *
 * SECOND review fix (2026-07-27, follow-up audit): keying by mint|source alone still wasn't
 * enough — the `strategy2Epoch`/`cfg` tags added to the LOGGED output were cosmetic only; this
 * dedup key (and `alreadyChecked` below) still collapsed across epochs. If tuning ever produces a
 * new `strategy2Epoch`/`cfg` and the SAME mint+source reappears, the old snapshot/outcome rows
 * would silently attribute to it. `cfg`+`epoch` are now part of the snapshot's own identity, read
 * from the record that produced it (NOT the live `config.strategy2Epoch` at outcome-check time —
 * a position can outlive an epoch change, so the tag must travel with the record it describes).
 */
function earliestCandidates(rows: Record<string, unknown>[]): Map<string, CandidateSnapshot> {
  const byKey = new Map<string, CandidateSnapshot>();
  for (const r of rows) {
    if (r["type"] !== "strategy2-candidate") continue;
    const mint = String(r["mint"] ?? "");
    if (!mint) continue;
    const source = String(r["source"] ?? "unknown");
    const cfg = (r["cfg"] as string) ?? "unknown";
    const epoch = (r["strategy2Epoch"] as string) ?? "unknown";
    const key = `${mint}|${source}|${cfg}|${epoch}`;
    const firstSeenAt = Number(r["firstSeenAt"] ?? 0);
    const existing = byKey.get(key);
    if (!existing || firstSeenAt < existing.firstSeenAt) {
      byKey.set(key, {
        mint, sym: String(r["sym"] ?? "?"), firstSeenAt, source, cfg: (r["cfg"] as string) ?? null,
        epoch: (r["strategy2Epoch"] as string) ?? null,
        entryMcUsd: Number(r["mcUsd"] ?? 0), entryHolders: Number(r["holders"] ?? 0),
      });
    }
  }
  return byKey;
}

/** Set of "mint|source|cfg|epoch|horizonHours" tuples already checked, so a re-run never double-fetches. */
function alreadyChecked(rows: Record<string, unknown>[]): Set<string> {
  const done = new Set<string>();
  for (const r of rows) {
    if (r["type"] !== "strategy2-outcome") continue;
    done.add(`${r["mint"]}|${r["source"] ?? "unknown"}|${r["cfg"] ?? "unknown"}|${r["strategy2Epoch"] ?? "unknown"}|${r["horizonHours"]}`);
  }
  return done;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function poll(): Promise<void> {
  const host = config.solTracker.host;
  if (!host) { ui.warn("[strategy2-outcome] SOLTRACKER_HOST not set — cannot poll"); return; }
  const rows = readEventRows();
  const candidates = earliestCandidates(rows);
  const done = alreadyChecked(rows);
  const now = Date.now();

  let due: { snap: CandidateSnapshot; horizonHours: number }[] = [];
  for (const snap of candidates.values()) {
    const ageHours = (now - snap.firstSeenAt) / 3_600_000;
    for (const h of config.strategy2Outcome.horizonsHours) {
      if (ageHours >= h && !done.has(`${snap.mint}|${snap.source}|${snap.cfg ?? "unknown"}|${snap.epoch ?? "unknown"}|${h}`)) due.push({ snap, horizonHours: h });
    }
  }

  if (!due.length) { ui.info(`[strategy2-outcome] no horizons due yet (${candidates.size} mints tracked)`); return; }

  let checked = 0;
  for (const { snap, horizonHours } of due) {
    const cur = await tokenMarketSnapshot(snap.mint);
    if (cur) {
      const mcChangePct = cur.mcUsd != null && snap.entryMcUsd > 0
        ? Number((((cur.mcUsd - snap.entryMcUsd) / snap.entryMcUsd) * 100).toFixed(1))
        : null;
      logRecord("events", {
        type: "strategy2-outcome",
        // Audit fix (2026-07-29): this was hardcoded regardless of `source` — every new-launch/
        // dev-hold candidate's outcome row was mislabeled as the mid-cap thesis even though
        // `source` (below) correctly said otherwise. Derive it instead of hardcoding.
        strategyTag: snap.source === "new-launch-dev-holding" ? "strategy2-new-launch-dev-hold-v1" : "strategy2-mid-cap-scout-v1",
        // Tag with the snapshot's OWN cfg/epoch (from when the candidate was first seen), not the
        // live config at check time — a candidate can outlive an epoch/cfg change (review fix).
        // Follow-up audit fix: a snapshot with no recorded epoch (legacy row) is dedupe-keyed as
        // "unknown" above — the written value must say the same "unknown" rather than silently
        // falling back to whatever epoch happens to be live right now, which would misattribute it.
        mint: snap.mint, sym: snap.sym, source: snap.source, cfg: snap.cfg ?? null, strategy2Epoch: snap.epoch ?? "unknown", horizonHours,
        firstSeenAt: snap.firstSeenAt, checkedAt: now,
        // Umur mark yang SEBENARNYA (review 2026-10-07): horizonHours hanya label nominal. Kalau
        // proses sempat berhenti, satu snapshot ditulis untuk beberapa horizon sekaligus (84%
        // baris historis 6/24/48h begini) — kolom ini membuat "mark tepat waktu" bisa
        // diverifikasi dari data, bukan diasumsikan.
        ageHours: Number(((now - snap.firstSeenAt) / 3_600_000).toFixed(2)),
        entryMcUsd: snap.entryMcUsd, entryHolders: snap.entryHolders,
        currentMcUsd: cur.mcUsd, currentHolders: cur.holders,
        mcChangePct, riskScoreNow: cur.riskScore, ruggedNow: cur.rugged,
        marketDataSource: cur.source, solTrackerStatus: cur.primaryStatus,
      });
      checked++;
    }
    await sleep(400); // be gentle with the shared, finite Solana Tracker budget
  }
  ui.info(`[strategy2-outcome] checked ${checked}/${due.length} due horizons (${candidates.size} mints tracked total)`);
}

function main(): void {
  if (!config.strategy2Outcome.enabled) { console.log("[strategy2-outcome] disabled (STRATEGY2_OUTCOME=false)"); return; }
  console.log(`[strategy2-outcome] tracking horizons [${config.strategy2Outcome.horizonsHours.join(",")}]h, checking every ${config.strategy2Outcome.pollMs / 60_000}min. Read-only, zero capital.`);
  void poll();
  const timer = setInterval(() => void poll(), config.strategy2Outcome.pollMs);
  const shutdown = () => { clearInterval(timer); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
