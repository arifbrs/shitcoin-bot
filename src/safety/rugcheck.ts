import { config } from "../config.js";
import { fetchJson, TokenBucket } from "../util/http.js";
import type { GateCheck } from "../types.js";

const bucket = TokenBucket.perMinute(config.limits.rugcheckPerMin);

interface RugcheckReport {
  score?: number;
  score_normalised?: number;
  risks?: Array<{ name: string; level?: string; description?: string }>;
  rugged?: boolean;
  totalHolders?: number;
  creator?: string;
  creatorAddress?: string;
  graphInsidersDetected?: number; // RugCheck's own bundled-insider detection
  insiderNetworks?: unknown[];
  creatorTokens?: unknown[]; // other tokens this dev has launched (serial-deployer signal)
}

export interface RugcheckResult {
  checks: GateCheck[];
  holders?: number; // community-size signal, fed into momentum scoring
  creator?: string; // dev wallet, for buy-back / dump tracking
}

/**
 * Gate #3: RugCheck enrichment — best-effort, NEVER blocks the pipeline
 * (CONCEPT.md D4). Uses the full /report (the /summary variant omits holders +
 * creator). Surfaces holder count + dev wallet, and adds RugCheck's own
 * insider-network detection as a soft signal. Auth via the `?key=` query param
 * (raises the free limit from ~10 to ~60/min); short timeout; non-blocking.
 */
export async function rugcheckEnrichment(mint: string, signal?: AbortSignal): Promise<RugcheckResult> {
  try {
    const keyQuery = config.rugcheckApiKey ? `?key=${config.rugcheckApiKey}` : "";
    const report = await fetchJson<RugcheckReport>(
      `${config.rugcheckBaseUrl}/tokens/${mint}/report${keyQuery}`,
      { bucket, timeoutMs: 4_000, retries: 1, signal },
    );
    const dangers = (report.risks ?? []).filter((r) => r.level === "danger");
    const insiders = (report.graphInsidersDetected ?? 0) > 0 || (report.insiderNetworks?.length ?? 0) > 0;
    const serialDeployer = (report.creatorTokens?.length ?? 0) > 10;
    const checks: GateCheck[] = [
      {
        name: "rugcheck-rugged-flag",
        passed: report.rugged !== true,
        hard: true,
        detail: report.rugged ? "RugCheck marks token as RUGGED" : "not flagged as rugged",
      },
      {
        name: "rugcheck-danger-risks",
        passed: dangers.length === 0,
        hard: false,
        detail: dangers.length ? dangers.map((d) => d.name).join(", ") : "no danger-level risks",
      },
      {
        name: "rugcheck-insider-network",
        passed: !insiders,
        hard: false,
        detail: insiders ? `insider/bundle network detected (${report.graphInsidersDetected ?? 0})` : "no insider network flagged",
      },
      {
        name: "rugcheck-serial-deployer",
        passed: !serialDeployer,
        hard: false,
        detail: serialDeployer ? `dev has launched ${report.creatorTokens?.length} tokens` : "not a heavy serial deployer",
      },
    ];
    // RugCheck normalised score: LOWER = safer (verified: USDC=1, BONK=7, risky≈70+).
    // Score it meaningfully instead of always-pass, so risky tokens are penalised.
    const norm = report.score_normalised;
    if (typeof norm === "number") {
      const safe = norm <= 20;
      checks.push({ name: "rugcheck-score", passed: safe, hard: false, detail: `risk ${norm}/100 (${safe ? "low" : "elevated"}, lower=safer)` });
    } else if (typeof report.score === "number") {
      checks.push({ name: "rugcheck-score", passed: true, hard: false, detail: `score ${report.score}` });
    }
    return { checks, holders: report.totalHolders, creator: report.creator ?? report.creatorAddress };
  } catch (err) {
    return {
      checks: [
        {
          name: "rugcheck-unavailable",
          passed: true, // non-blocking by design
          hard: false,
          detail: `enrichment skipped: ${(err as Error).message}`,
        },
      ],
    };
  }
}
