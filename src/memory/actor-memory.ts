import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * ACTOR / CLUSTER MEMORY (owner spec #1 — the highest-value memory for ENTRY).
 *
 * Persistent, PROBABILISTIC reputation for the people behind a launch — creators and the
 * wallets that FUND them (funding lineage, not just the exact creator wallet, because
 * ruggers rotate creator wallets but keep the same funding parent). One bad launch does NOT
 * mean a permanent blacklist: we store {riskProbability, confidence, sampleSize, evidence,
 * lastSeenAt} and let it decay/update. A brand-new wallet funded by a known-bad actor is
 * still recognised via the funder link.
 *
 * Written to logs/actor-memory.json (single JSON, small). Updated on every trade outcome.
 */
export interface ActorRecord {
  id: string; // creator or funder wallet
  kind: "creator" | "funder";
  launches: number; // how many launches attributed to this actor
  rugs: number; // launches that rugged / went unsellable
  abandons: number; // launches the dev walked away from (no dev activity, faded)
  sellableWins: number; // launches that were a real sellable win for us
  devSellSecs: number[]; // samples of seconds-to-dev-sell (for a REAL median, capped length)
  medianDevSellSec: number | null; // TRUE median of devSellSecs (was a biased running avg — bug)
  metaCounts: Record<string, number>; // metadataHash → times seen (reuse = SAME meta ≥2×, was inverted)
  fundedActors: string[]; // creators this funder has funded (lineage)
  fundedBy: string[]; // funders of this creator (1-2 hop lineage up)
  reusedMeta: string[]; // metadata/domain/twitter hashes seen reused across launches
  lastSeenAt: number;
  sampleSize: number;
}

export interface ActorRisk {
  riskProbability: number; // 0..1 estimated P(this launch is toxic) from the actor lineage
  confidence: number; // 0..1 — how much to trust it (grows with sampleSize)
  sampleSize: number;
  evidence: string[]; // codes: SERIAL_RUGGER, SHARED_FUNDER, REUSED_META, DEV_FAST_SELLER, …
  lastSeenAt: number | null;
}

const PATH = join(config.logDir, "actor-memory.json");
mkdirSync(config.logDir, { recursive: true });

export type ActorStore = Record<string, ActorRecord>;
type Store = ActorStore;
function load(): Store {
  if (!existsSync(PATH)) return {};
  try { return JSON.parse(readFileSync(PATH, "utf8")) as Store; } catch { return {}; }
}
// One in-process authoritative store. Reloading disk on every outcome loses updates whenever
// several outcomes arrive inside the delayed-save window: each mutation starts from the same stale
// file and the last pending snapshot wins. All reads and writes below share this object instead.
const store: Store = load();
/**
 * PRUNE + THROTTLED SAVE — the two things this file needed to survive 24/7.
 *
 * Growth: an entry is created for EVERY creator seen, including the launches we only observe
 * and never enter (~2k/day), and nothing was ever removed. Measured after ~1 day: 1,523 entries
 * / 546 KB. Left alone that is a ~180 MB file after a year.
 *
 * Write amplification: save() was called synchronously on every outcome — every close AND every
 * observed launch — so the WHOLE file was re-serialised thousands of times a day, and each write
 * blocks the event loop for longer as it grows. On a 4s trading tick that is real latency.
 *
 * Fix: drop records whose reputation has decayed to irrelevance (confidence uses a 14-day
 * half-life, so a record untouched for ~4 half-lives contributes essentially nothing), and
 * coalesce writes into one flush per interval. Nothing is lost that the scoring could still use.
 */
const MAX_AGE_MS = config.actorMemory.halfLifeDays * 4 * 24 * 60 * 60_000; // ~4 half-lives
const SAVE_INTERVAL_MS = 15_000;
let pendingStore: Store | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function prune(s: Store): Store {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, r] of Object.entries(s)) {
    // Keep anything still recent, and never drop an actor with real evidence against them.
    if ((r.lastSeenAt ?? 0) < cutoff && (r.rugs ?? 0) === 0) delete s[id];
  }
  return s;
}

function flush(): void {
  saveTimer = null;
  const s = pendingStore; pendingStore = null;
  if (!s) return;
  try { writeFileSync(PATH, JSON.stringify(prune(s))); } catch { /* best-effort */ }
}

function save(s: Store): void {
  pendingStore = s; // newest state wins; the interval decides when it hits disk
  if (!saveTimer) saveTimer = setTimeout(flush, SAVE_INTERVAL_MS);
}

/** Force any pending actor-memory write to disk (called on shutdown so nothing is lost). */
export function flushActorMemory(): void { if (saveTimer) { clearTimeout(saveTimer); } flush(); }

function ensure(s: Store, id: string, kind: "creator" | "funder"): ActorRecord {
  const r = (s[id] ??= { id, kind, launches: 0, rugs: 0, abandons: 0, sellableWins: 0, devSellSecs: [], medianDevSellSec: null, metaCounts: {}, fundedActors: [], fundedBy: [], reusedMeta: [], lastSeenAt: 0, sampleSize: 0 });
  if (!Array.isArray(r.devSellSecs)) r.devSellSecs = []; // migrate
  if (!r.metaCounts) r.metaCounts = {};
  return r;
}

export interface ActorOutcome {
  creator?: string | null; funders?: string[]; metaHash?: string | null;
  rugged: boolean; abandoned: boolean; sellableWin: boolean; devSellSec?: number | null; at: number;
  observedOnly?: boolean; // true = learned from an observed (not traded) launch — still teaches reputation
}

/** Pure accumulator used by production and concurrency fixtures. It never reads or writes disk. */
export function applyOutcome(s: ActorStore, o: ActorOutcome): void {
  const touch = (id: string, kind: "creator" | "funder") => {
    const r = ensure(s, id, kind);
    r.launches++; r.sampleSize++; r.lastSeenAt = o.at;
    if (o.rugged) r.rugs++; if (o.abandoned) r.abandons++; if (o.sellableWin) r.sellableWins++;
    if (o.metaHash) r.metaCounts[o.metaHash] = (r.metaCounts[o.metaHash] ?? 0) + 1; // count occurrences of EACH meta
    if (o.devSellSec != null) {
      r.devSellSecs.push(o.devSellSec);
      if (r.devSellSecs.length > 25) r.devSellSecs.shift(); // cap
      const sorted = [...r.devSellSecs].sort((a, b) => a - b);
      r.medianDevSellSec = sorted[Math.floor(sorted.length / 2)] ?? null; // TRUE median
    }
  };
  if (o.creator) touch(o.creator, "creator");
  for (const f of o.funders ?? []) {
    touch(f, "funder");
    const r = ensure(s, f, "funder");
    if (o.creator && !r.fundedActors.includes(o.creator)) r.fundedActors.push(o.creator);
    const cr = o.creator ? ensure(s, o.creator, "creator") : null;
    if (cr && !cr.fundedBy.includes(f)) cr.fundedBy.push(f);
  }
}

/** Record a launch's outcome against its creator + funder lineage (call at CLOSE). */
export function recordOutcome(o: ActorOutcome): void {
  applyOutcome(store, o);
  const s = store;
  save(s);
}

/** Assess a launch's actor lineage risk BEFORE entry (creator + its funders 1-2 hops). */
export function assessActors(creator?: string | null, funders?: string[]): ActorRisk {
  const s = store;
  const evidence: string[] = [];
  let worstRug = 0, totalSample = 0, lastSeen: number | null = null;
  const consider = (id?: string | null) => {
    if (!id || !s[id]) return;
    const r = s[id]!;
    totalSample += r.sampleSize; lastSeen = Math.max(lastSeen ?? 0, r.lastSeenAt);
    const rugRate = r.launches > 0 ? (r.rugs + r.abandons) / r.launches : 0;
    if (r.launches >= config.actorMemory.serialLaunchMin && rugRate >= config.actorMemory.serialRugRate) evidence.push(r.kind === "funder" ? "SHARED_FUNDER_RUGGER" : "SERIAL_RUGGER");
    if (r.medianDevSellSec != null && r.medianDevSellSec < config.actorMemory.fastDevSellSec) evidence.push("DEV_FAST_SELLER");
    // REUSED_META = the SAME metadata seen ≥2× (a rug template reused), NOT two different metas.
    if (Object.values(r.metaCounts ?? {}).some((n) => n >= 2)) evidence.push("REUSED_META");
    worstRug = Math.max(worstRug, rugRate);
  };
  consider(creator);
  for (const f of funders ?? []) {
    consider(f);
    // 1-hop: other creators this funder funded — if they rugged, this launch inherits suspicion
    const fr = f ? s[f] : undefined;
    for (const c2 of fr?.fundedActors ?? []) if (c2 !== creator) consider(c2);
  }
  // DECAY (audit fix: memory had none): an actor not seen for a long time is less certain —
  // scale confidence down by recency so stale reputation doesn't hard-gate forever.
  const ageDays = lastSeen ? (Date.now() - lastSeen) / 86_400_000 : 0;
  const recency = Math.exp(-ageDays / config.actorMemory.halfLifeDays);
  const confidence = Math.min(1, totalSample / config.actorMemory.confidentSample) * recency;
  const riskProbability = Math.min(1, worstRug + (evidence.length ? 0.15 : 0));
  return { riskProbability: Number(riskProbability.toFixed(2)), confidence: Number(confidence.toFixed(2)), sampleSize: totalSample, evidence: [...new Set(evidence)], lastSeenAt: lastSeen };
}

/** How many CURRENTLY-open positions share this actor lineage (for the exposure cap). */
export function actorKnown(id?: string | null): boolean { if (!id) return false; return Boolean(store[id]); }
