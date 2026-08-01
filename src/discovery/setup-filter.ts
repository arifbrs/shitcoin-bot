import type { Candidate, GateCheck } from "../types.js";
import { config } from "../config.js";
import { assessActors } from "../memory/actor-memory.js";
import { pumpTopHolders } from "../safety/pump-holders.js";
import { authorityChecks, totalSupplyUi, creatorFunders, quoteMintIsSol } from "../safety/onchain.js";

/**
 * DETERMINISTIC SETUP CLASSIFIER (owner spec — the SetupRiskModel, NO LLM).
 *
 * Given the launch data available at entry time, classify the SETUP as TOXIC / CLEAN /
 * UNKNOWN in milliseconds. This — not momentum, not an LLM — is the entry decision:
 *   TOXIC   → hard skip
 *   UNKNOWN → data missing (NOT clean) — allow only if config permits sniping the unknown
 *   CLEAN   → real evidence the setup is safe → snipe
 *
 * Signals treated per the owner's table:
 *   hard-skip: dangerous authority / can't-sim-sell, serial-rugger dev or funding lineage,
 *              dev funds several early buyers, same-slot bundle + large holdings, extreme
 *              supply concentration (valid sample).
 *   soft plus: socials/website. NO socials ≠ skip. CEX funding = UNKNOWN not organic.
 *   NOT a gate: accel / velocity / buy-pressure (those are telemetry/exit only).
 */
export interface SetupVerdict {
  verdict: "TOXIC" | "CLEAN" | "UNKNOWN";
  confidence: number; // 0..1
  evidence: string[]; // codes explaining the verdict
  missing: string[]; // critical data we did NOT have (drives UNKNOWN)
}

/** Pure normalization shared by counterfactual tests; empty means no proven hard failure. */
export function hardAuthorityEvidence(checks: GateCheck[] | null): string[] {
  if (!checks) return [];
  return checks
    .filter((check) => check.hard && !check.passed)
    .map((check) => `AUTHORITY_${check.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`);
}

export function classifySetup(c: Candidate): SetupVerdict {
  const ev: string[] = [];
  const missing: string[] = [];
  const toxic: string[] = [];

  // ── HARD-SKIP (TOXIC) conditions ──
  // Mayhem mints additional supply for an autonomous agent. Pump's own documentation warns that
  // net agent selling can exhaust curve liquidity so holders cannot sell. Until a separate fill
  // model is validated, this is an unsupported execution regime, not a predictive quality label.
  if (c.isMayhemMode === true) toxic.push("UNSUPPORTED_MAYHEM_MODE");
  // Explicit non-default quote mints use quote units, not lamports/SOL. Until that venue has
  // its own decimals, fill and fee model, entering it would corrupt both the bankroll and P&L.
  if (!quoteMintIsSol(c.quoteMint)) toxic.push("UNSUPPORTED_NON_SOL_QUOTE");
  // Can't simulate a sell / honeypot proven → toxic (set elsewhere as execStage would-fail).
  if (c.honeypot === true) toxic.push("HONEYPOT_NO_SELL");

  // Rug-cluster from holders: coordinated funding = manufactured demand.
  const rc = c.rugCluster;
  if (rc?.verdict === "TOXIC") toxic.push(rc.devFundedBuyers >= config.pumpHolders.hardDevFundedBuyers ? "DEV_FUNDED_BUYERS" : "FUNDING_CLUSTER");
  // Same-slot BUNDLE at launch is toxic only after buyer-wallet verification. The cheap hot-path
  // probe counts transactions, not distinct buyers; treating that proxy as actor proof rejected
  // ordinary launch crowds and was empirically worse than blind entry.
  if (
    c.launchBundle?.verifiedBuys === true
    && c.launchBundle.sameSlotMax >= config.setupFilter.sameSlotBundleMax
  ) toxic.push("SAME_SLOT_BUNDLE");
  // Extreme supply concentration WITH a trustworthy sample.
  if ((c.whaleDevPct ?? 0) > config.pumpHolders.hardDevPct && (c.holdersSample ?? 0) >= config.pumpHolders.minSample) toxic.push("EXTREME_DEV_SUPPLY");
  if ((c.whaleBundlerPct ?? 0) > config.setupFilter.hardBundlerPct && (c.holdersSample ?? 0) >= config.pumpHolders.minSample) toxic.push("EXTREME_BUNDLE");

  // Actor/funding lineage risk (serial rugger, shared funder history).
  const actorRisk = assessActors(c.creator, c.creatorFunders); // creator lineage, NOT early-buyer funders
  if (actorRisk.riskProbability >= config.actorMemory.toxicRiskProb && actorRisk.confidence >= config.actorMemory.toxicConfidence) {
    toxic.push("ACTOR_RISK"); ev.push(...actorRisk.evidence);
  } else if (actorRisk.evidence.length) {
    ev.push(...actorRisk.evidence.map((e) => e + "_LOWCONF")); // suspicious but not confident enough to kill
  }

  if (toxic.length) return { verdict: "TOXIC", confidence: Math.max(0.6, actorRisk.confidence), evidence: [...new Set([...toxic, ...ev])], missing };

  // ── evidence gathering for CLEAN vs UNKNOWN ──
  // Funding data present & independent = real evidence of a clean setup.
  if (rc?.verdict === "CLEAN") ev.push("FUNDING_INDEPENDENT");
  else if (rc?.verdict === "UNKNOWN" || rc == null) missing.push("FUNDING_DATA");
  // Authorities verified? (timed-out = UNKNOWN, never clean — audit fix)
  if (c.authorityUnknown) missing.push("AUTHORITY_UNVERIFIED");
  // Holder sample trustworthy?
  if ((c.holdersSample ?? 0) >= config.pumpHolders.minSample) ev.push("HOLDERS_SAMPLED"); else missing.push("HOLDER_SAMPLE");
  // Socials = SOFT PLUS only (no socials is NOT a skip).
  if (c.hasSocials) ev.push("HAS_SOCIALS");
  // Actor seen before and clean = plus.
  if (actorRisk.sampleSize > 0 && actorRisk.riskProbability < 0.3) ev.push("ACTOR_KNOWN_CLEAN");

  // CLEAN needs real positive evidence (funding independent OR trusted holder sample with no red flags).
  const authorityVerified = !missing.includes("AUTHORITY_UNVERIFIED");
  const clean = authorityVerified
    && (ev.includes("FUNDING_INDEPENDENT") || (ev.includes("HOLDERS_SAMPLED") && missing.length === 0));
  if (clean) return { verdict: "CLEAN", confidence: 0.6 + (ev.includes("FUNDING_INDEPENDENT") ? 0.2 : 0), evidence: [...new Set(ev)], missing };
  return { verdict: "UNKNOWN", confidence: 0.3, evidence: [...new Set(ev)], missing };
}

/**
 * COUNTERFACTUAL CLASSIFY (owner spec — classify EVERY observed launch, not just entered).
 * Runs a bounded, deadline-limited enrichment (holders/authorities/creator-funders) on a mint,
 * then classifies. Used by the LaunchObservatory to stamp a setup verdict on ALL observed
 * launches so the shadow comparison is a real counterfactual, not setup≈blind. Rate-limited by
 * the observatory (few per tick) + the per-API TokenBuckets, so it respects the RPC budget.
 */
export async function classifyLaunch(
  mint: string,
  creator?: string,
  pool?: string,
  isMayhemMode?: boolean,
  quoteMint?: string,
): Promise<SetupVerdict> {
  const c: Candidate = { source: "pumpportal", mode: "fast-follow", mint, creator, pool, isMayhemMode, quoteMint, detectedAt: Date.now() };
  const race = <T>(p: Promise<T>, ms = 3000): Promise<T | null> => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  const supply = await race(totalSupplyUi(mint));
  const [auth, wh, cf] = await Promise.all([
    race(authorityChecks(mint)),
    supply ? race(pumpTopHolders(mint, supply)) : Promise.resolve(null),
    creator ? race(creatorFunders(creator)) : Promise.resolve(null),
  ]);
  if (!auth) c.authorityUnknown = true;
  else {
    const failed = hardAuthorityEvidence(auth);
    if (failed.length) {
      return {
        verdict: "TOXIC",
        confidence: 1,
        evidence: failed,
        missing: [],
      };
    }
  }
  if (wh) { c.whaleSniperPct = wh.sniperPct; c.whaleBundlerPct = wh.bundlerPct; c.whaleDevPct = wh.devPct; c.rugCluster = wh.cluster; c.holdersSample = wh.sample; }
  if (cf) c.creatorFunders = cf;
  return classifySetup(c);
}
