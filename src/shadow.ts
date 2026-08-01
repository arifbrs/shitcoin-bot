/**
 * RETIRED legacy shadow harness.
 *
 * The former implementation emitted profitability estimates that were not identifiable:
 * - it applied a setup verdict learned seconds later to the first price sample (future leakage);
 * - it dropped launches that survived beyond the sampled path;
 * - it valued graduated positions from depleted bonding-curve reserves instead of an AMM quote;
 * - its sparse samples could not reproduce 45s/120s/time-since-peak exits;
 * - it ignored cross-arm capital and exposure contention.
 *
 * Use `npm run profit:evaluate`. That evaluator accepts only complete interleaved ARM_RESULT rows
 * and refuses until the online, independent-ledger arm runner exists and has valid data.
 */
console.error("REFUSED: legacy shadow profitability estimates are retired.");
console.error("- setup verdict timing caused future-data leakage");
console.error("- sparse paths cannot reproduce the live exit policy");
console.error("- graduation lacks a counterfactual AMM sell quote");
console.error("- surviving launches were conditionally excluded");
console.error("Next: build independent online arm ledgers, then run `npm run profit:evaluate`.");
process.exitCode = 2;
