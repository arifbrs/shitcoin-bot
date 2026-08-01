import { config } from "../config.js";
import { fetchJson, TokenBucket } from "../util/http.js";
import { totalSupplyUi } from "./onchain.js";

/**
 * pump.fun TOP-HOLDERS → the same metrics pump.fun's own app shows (Snipers,
 * Bundlers, Dev holdings, Top-10 holders), computed as % OF TOTAL SUPPLY with the
 * app's exact thresholds. FREE, no-auth: advanced-api-v2.pump.fun/coins/top-holders.
 *
 * Each holder carries pump.fun's flags — isDev / isSniper (bought in the first ~10s)
 * / isBundler (coordinated batch-ape) — plus its token `amount`. Dividing the flagged
 * holdings by the on-chain total supply gives the app's percentages:
 *   snipers%  — supply grabbed by first-10s snipers  (app: >10% = red)
 *   bundlers% — supply held by coordinated bundlers   (app: >10% = red)
 *   dev%      — supply still held by the deployer      (app: >20% = red)
 *   top10%    — combined share of the 10 biggest non-team wallets (app: >20% = red)
 *
 * The endpoint returns a VARIABLE, sometimes tiny holder list for very fresh tokens
 * (1–10), so we also report `sample` (holder count) — callers only HARD-reject when
 * the sample is big enough to trust. Holder COUNT / market cap come from on-chain
 * (the mint address), not this endpoint. Verified live 2026-07-22. Best-effort → null.
 */
const bucket = TokenBucket.perMinute(config.pumpHolders.perMin);
const BASE = "https://advanced-api-v2.pump.fun";

interface RawHolder {
  address?: string;
  amount?: number;
  isDev?: boolean;
  isSniper?: boolean;
  isBundler?: boolean;
  enteredAt?: number | null;
  // The wallet that funded this holder's SOL. It's an OBJECT with a rich label — funderType
  // "Centralized Exchange" (Binance etc.) = organic, NOT a cluster; a private wallet funding
  // many holders = the coordinated rug setup.
  fundingSource?: { funder?: string; funderName?: string; funderType?: string } | null;
}
interface RawResp {
  topHolders?: RawHolder[];
}

export interface RugCluster {
  clusterWallets: number; // # of DISTINCT holders sharing ONE funding source (largest cluster)
  clusterPct: number;     // % of supply that largest shared-funding cluster holds together
  fundingDiversity: number | null; // distinct sources ÷ holders-with-a-source; NULL = no funding data (UNKNOWN, NOT clean)
  devFundedBuyers: number; // holders whose funding source IS the dev wallet (dev-controlled fake demand)
  coordinated: boolean;   // a real coordinated cluster is present (rug-setup signal)
  verdict: "TOXIC" | "CLEAN" | "UNKNOWN"; // owner spec: three states — UNKNOWN must never read as CLEAN
}

export interface PumpHolders {
  sample: number; // holders the API returned (confidence — small = fresh/unreliable)
  sniperPct: number; // % of TOTAL SUPPLY held by first-10s snipers
  bundlerPct: number; // % of TOTAL SUPPLY held by coordinated bundlers
  devPct: number; // % of TOTAL SUPPLY still held by the deployer
  top10Pct: number; // % of TOTAL SUPPLY held by the 10 largest non-team wallets
  cluster: RugCluster; // RUG-CLUSTER detection: "beda wallet, 1 pendana" = coordinated dump setup
  fundingParents: string[]; // distinct PRIVATE funder wallets (funding lineage → actor memory)
}

/** Best-effort; null on failure or if the mint isn't indexed yet. */
export async function pumpTopHolders(mint: string, supplyHint?: number, signal?: AbortSignal): Promise<PumpHolders | null> {
  try {
    const resp = await fetchJson<RawResp>(`${BASE}/coins/top-holders/${mint}`, {
      bucket,
      timeoutMs: 4_000,
      retries: 1,
      signal,
    });
    const h = resp?.topHolders ?? [];
    if (h.length === 0) return null;
    const supply = supplyHint && supplyHint > 0 ? supplyHint : await totalSupplyUi(mint).catch(() => 0);
    if (!supply || supply <= 0) return null; // without supply we can't do %-of-supply honestly
    const sumPct = (f: (x: RawHolder) => boolean): number =>
      (h.filter(f).reduce((s, x) => s + (x.amount ?? 0), 0) / supply) * 100;
    const nonTeam = h.filter((x) => !x.isDev).map((x) => x.amount ?? 0).sort((a, b) => b - a);
    const top10Pct = (nonTeam.slice(0, 10).reduce((s, a) => s + a, 0) / supply) * 100;
    // distinct PRIVATE (non-CEX) funder wallets = the funding lineage for actor memory
    const fundingParents = [...new Set(h.map((x) => {
      const f = x.fundingSource; if (!f?.funder) return null;
      if ((f.funderType ?? "").toLowerCase().includes("exchange")) return null; return f.funder;
    }).filter((x): x is string => !!x))];
    return {
      sample: h.length,
      sniperPct: sumPct((x) => !!x.isSniper),
      bundlerPct: sumPct((x) => !!x.isBundler),
      devPct: sumPct((x) => !!x.isDev),
      top10Pct,
      cluster: rugCluster(h, supply),
      fundingParents,
    };
  } catch {
    return null;
  }
}

/**
 * RUG-CLUSTER detection (owner's idea: spot the coordinated setup BEFORE the dev rugs).
 * Groups holders by fundingSource — the wallet that sent them their SOL. When many
 * "different" holders were all funded by ONE wallet, that's a single entity wearing many
 * masks (bundler/dev-controlled fake demand), the classic organized-rug pattern the
 * SolRugDetector research describes. Also flags when the DEV wallet is directly funding
 * the early buyers (manufactured demand). Best-effort: fundingSource is null for very
 * fresh coins the indexer hasn't traced yet → returns an all-clear (not a false positive).
 */
function rugCluster(h: RawHolder[], supply: number): RugCluster {
  const dev = h.find((x) => x.isDev)?.address ?? null;
  // Only PRIVATE-wallet funders count for clustering. A Centralized Exchange (Binance,
  // Coinbase…) funding many holders is ORGANIC — different real people withdrawing from the
  // same CEX, NOT one entity. Excluding CEX is what keeps this from false-positiving.
  const funderOf = (x: RawHolder): string | null => {
    const f = x.fundingSource;
    if (!f?.funder) return null;
    if ((f.funderType ?? "").toLowerCase().includes("exchange")) return null; // CEX = organic
    return f.funder;
  };
  const clustered = h.filter((x) => funderOf(x));
  // group the private-funded holders by their funder wallet
  const byFunder = new Map<string, { wallets: number; amount: number }>();
  for (const x of clustered) {
    const src = funderOf(x)!;
    const g = byFunder.get(src) ?? { wallets: 0, amount: 0 };
    g.wallets += 1; g.amount += x.amount ?? 0;
    byFunder.set(src, g);
  }
  let clusterWallets = 0, clusterAmount = 0;
  for (const g of byFunder.values()) if (g.wallets > clusterWallets) { clusterWallets = g.wallets; clusterAmount = g.amount; }
  const clusterPct = (clusterAmount / supply) * 100;
  const devFundedBuyers = dev ? clustered.filter((x) => funderOf(x) === dev).length : 0;
  const coordinated = (clusterWallets >= 3 && clusterPct >= 8) || devFundedBuyers >= 2;
  // CRITICAL (owner-flagged bug): if NO holder had a readable private funding source, we have
  // NO DATA — that is UNKNOWN, NOT clean. The old code returned diversity=1 (looks independent).
  // Three states: TOXIC (coordinated setup) / CLEAN (real independent funding seen) / UNKNOWN.
  const hadFundingData = clustered.length > 0;
  const fundingDiversity = hadFundingData ? Number((byFunder.size / clustered.length).toFixed(2)) : null;
  const verdict: "TOXIC" | "CLEAN" | "UNKNOWN" = coordinated ? "TOXIC" : hadFundingData ? "CLEAN" : "UNKNOWN";
  return { clusterWallets, clusterPct: Number(clusterPct.toFixed(1)), fundingDiversity, devFundedBuyers, coordinated, verdict };
}
