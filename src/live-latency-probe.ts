/**
 * LIVE LATENCY PROBE — measures the one leg that cannot be measured any other way:
 * send → confirmed, on mainnet, at the priority fee we would actually pay.
 *
 * WHY IT SPENDS ANYTHING AT ALL. Everything up to the send is already measurable for free and
 * is already logged (`latency-breakdown` in index.ts, `gate-timing` on every candidate). The
 * send→confirm leg is not: devnet has no comparable fee market or congestion, and simulation
 * never enters the queue. The number decides whether the strategy is viable, because EARLY_CUT
 * — the only exit lever that has ever measured positive — lives inside a FIVE SECOND window.
 * If a confirmation takes eight seconds, that edge is gone before we can act on it.
 *
 * WHY IT IS SAFE. The transaction is a SELF-TRANSFER OF ZERO LAMPORTS. The destination is this
 * wallet's own address, hardcoded, not a parameter. There is no route by which SOL leaves the
 * wallet — the only cost is the network fee, which is bounded, measured, and printed before
 * anything is sent. This is deliberately NOT gated behind LIVE_TRADING_CONFIRMED: requiring the
 * trading permission in order to take a measurement would mean opening the money lock to find
 * out whether opening the money lock is a good idea.
 *
 * Usage:
 *   npm run latency:probe                    → dry, shows the cost, sends nothing
 *   npm run latency:probe -- --confirm       → sends (default 10 samples)
 *   npm run latency:probe -- --confirm --samples 20
 */
import { ComputeBudgetProgram, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { config } from "./config.js";
import { botWallet, botPubkey, walletSource } from "./execution/wallet.js";
import { poolBalanceSol, poolLatestBlockhash, poolSendRawTransaction, poolSignatureStatus } from "./execution/rpc.js";
import { buildBuyTx } from "./execution/executor.js";
import { logRecord } from "./util/log.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const CONFIRM = args.includes("--confirm");
const SAMPLES = Math.max(1, Math.min(50, Number(args[args.indexOf("--samples") + 1]) || 10));

// Match the real trade's priority fee so the measurement reflects the queue we would actually
// join. config.exec.priorityFeeSol is a SOL total; convert it to a per-CU price.
const CU_LIMIT = 200_000;
const PRIORITY_LAMPORTS = Math.round(config.exec.priorityFeeSol * LAMPORTS_PER_SOL);
const MICRO_LAMPORTS_PER_CU = Math.round((PRIORITY_LAMPORTS * 1e6) / CU_LIMIT);
const BASE_FEE_LAMPORTS = 5_000;
const PER_SAMPLE_SOL = (PRIORITY_LAMPORTS + BASE_FEE_LAMPORTS) / LAMPORTS_PER_SOL;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

/** Newest mint we have actually traded — a real, live-ish target for the build-latency leg. */
function recentMint(): string | null {
  try {
    const files = readdirSync(config.logDir).filter((f) => f.startsWith("paper-trades") && f.endsWith(".jsonl")).sort();
    for (const f of files.reverse()) {
      const lines = readFileSync(join(config.logDir, f), "utf8").trim().split("\n").reverse();
      for (const l of lines) {
        try {
          const o = JSON.parse(l) as { action?: string; mint?: string };
          if (o.action === "OPEN" && o.mint) return o.mint;
        } catch { /* skip */ }
      }
    }
  } catch { /* none */ }
  return null;
}

/** PumpPortal build time. Free: builds only, never signs, never sends. */
async function measureBuild(): Promise<void> {
  const mint = recentMint();
  if (!mint) { console.log("  (no recent mint in the logs — build leg skipped)"); return; }
  const ms: number[] = [];
  let nulls = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const b = await buildBuyTx(botPubkey(), mint, 0.01);
    ms.push(Date.now() - t0);
    if (!b) nulls++;
    await sleep(300);
  }
  const s = [...ms].sort((a, b) => a - b);
  console.log(`  PumpPortal build : p50 ${pct(s, 50)}ms · max ${s.at(-1)}ms · ${nulls}/5 refused (dead mint is fine)`);
}

async function main(): Promise<void> {
  console.log("\n═══════ LIVE LATENCY PROBE ═══════\n");
  console.log(`  wallet      ${botPubkey()}  (key from ${walletSource()})`);
  const startBal = await poolBalanceSol(botPubkey());
  console.log(`  balance     ${startBal == null ? "?" : startBal.toFixed(5)} SOL`);
  console.log(`  priority    ${config.exec.priorityFeeSol} SOL (${MICRO_LAMPORTS_PER_CU} µlamports/CU over ${CU_LIMIT} CU)`);
  console.log(`  cost        ~${PER_SAMPLE_SOL.toFixed(6)} SOL/sample × ${SAMPLES} = ~${(PER_SAMPLE_SOL * SAMPLES).toFixed(5)} SOL`);
  console.log(`  transfer    ZERO lamports, destination = this wallet itself (no SOL can leave)\n`);

  console.log("── FREE LEGS (nothing sent) ──");
  await measureBuild();

  if (!CONFIRM) {
    console.log(`\n  Dry run. Nothing was sent. To measure send→confirm for real:`);
    console.log(`    npm run latency:probe -- --confirm --samples ${SAMPLES}\n`);
    return;
  }
  if (startBal != null && startBal < PER_SAMPLE_SOL * SAMPLES + 0.005) {
    console.log(`\n  ✗ balance too low for ${SAMPLES} samples. Aborting.\n`);
    process.exit(1);
  }

  console.log(`\n── SEND → CONFIRM (${SAMPLES} real mainnet transactions) ──`);
  const kp = botWallet();
  const self = new PublicKey(botPubkey());
  const sendMs: number[] = [];
  const confirmMs: number[] = [];
  const totalMs: number[] = [];
  let failed = 0;

  for (let i = 0; i < SAMPLES; i++) {
    const blockhash = await poolLatestBlockhash();
    if (!blockhash) { failed++; console.log(`  ${i + 1}. blockhash unavailable`); continue; }
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }))
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_LAMPORTS_PER_CU }))
      .add(SystemProgram.transfer({ fromPubkey: self, toPubkey: self, lamports: 0 }));
    tx.feePayer = self;
    tx.recentBlockhash = blockhash;
    tx.sign(kp);

    const t0 = Date.now();
    let sig: string;
    try {
      sig = await poolSendRawTransaction(tx.serialize());
    } catch (e) {
      failed++;
      console.log(`  ${i + 1}. send failed: ${(e as Error).message.slice(0, 60)}`);
      continue;
    }
    const tSent = Date.now();
    let confirmedAt: number | null = null;
    const deadline = tSent + 60_000;
    while (Date.now() < deadline) {
      const st = await poolSignatureStatus(sig).catch(() => null);
      if (st?.err) break;
      if (st?.confirmed) { confirmedAt = Date.now(); break; }
      await sleep(200); // tight poll: we are measuring, not being polite
    }
    if (confirmedAt == null) {
      failed++;
      console.log(`  ${i + 1}. not confirmed within 60s (sig ${sig.slice(0, 12)}…)`);
      continue;
    }
    const send = tSent - t0;
    const conf = confirmedAt - tSent;
    sendMs.push(send);
    confirmMs.push(conf);
    totalMs.push(confirmedAt - t0);
    console.log(`  ${String(i + 1).padStart(2)}. send ${String(send).padStart(4)}ms · confirm ${String(conf).padStart(5)}ms · total ${String(confirmedAt - t0).padStart(5)}ms`);
    await sleep(500);
  }

  const endBal = await poolBalanceSol(botPubkey());
  const spent = startBal != null && endBal != null ? startBal - endBal : null;
  const sS = [...sendMs].sort((a, b) => a - b);
  const cS = [...confirmMs].sort((a, b) => a - b);
  const tS = [...totalMs].sort((a, b) => a - b);

  console.log(`\n── RESULT (n=${totalMs.length}, ${failed} failed) ──`);
  if (totalMs.length > 0) {
    console.log(`  RPC accept    p50 ${pct(sS, 50)}ms · p90 ${pct(sS, 90)}ms · max ${sS.at(-1)}ms`);
    console.log(`  confirmation  p50 ${pct(cS, 50)}ms · p90 ${pct(cS, 90)}ms · max ${cS.at(-1)}ms`);
    console.log(`  send→confirm  p50 ${pct(tS, 50)}ms · p90 ${pct(tS, 90)}ms · max ${tS.at(-1)}ms`);
    // ── INTERPRETATION ──────────────────────────────────────────────────────────────
    // Two different things live in these numbers and must not be blended:
    //   · CONFIRMATION is Solana's own latency. We cannot change it.
    //   · RPC ACCEPT spikes are OUR pool rotating off exhausted free-tier keys. That is a
    //     purchasable fix, and if it dominates the tail then the tail is not a Solana problem.
    const sendP50 = pct(sS, 50), sendP90 = pct(sS, 90);
    const confP50 = pct(cS, 50), confP90 = pct(cS, 90);
    const rotationShare = sendP90 > 0 ? sendP90 / (sendP90 + confP90) : 0;
    console.log(`\n  Where the tail comes from: at p90, ${Math.round(rotationShare * 100)}% is our own RPC accept`);
    console.log(`  (p50 ${sendP50}ms → p90 ${sendP90}ms) and the rest is Solana confirming (p50 ${confP50}ms → p90 ${confP90}ms).`);
    if (sendP90 > 3 * sendP50 && sendP90 > 500) {
      console.log(`  → The accept spikes are endpoint ROTATION off spent free-tier keys, not the network.`);
      console.log(`    More/better RPC capacity removes most of this tail without touching strategy.`);
    }

    // EARLY_CUT: one leg, not two. The paper model decides at <=5s; the live exit lands one
    // build+send+confirm AFTER that decision. The entry lag is a separate cost, already paid
    // before the window starts.
    const cut = config.risk.earlyCut?.withinMs ?? 5_000;
    const legP50 = pct(tS, 50), legP90 = pct(tS, 90);
    console.log(`\n  EARLY_CUT window ${cut}ms. The rule is validated on ticks, so what matters is how`);
    console.log(`  late the live exit lands AFTER the model decides — one leg, not a round trip:`);
    console.log(`    exit lag  p50 ~${((legP50) / 1000).toFixed(1)}s · p90 ~${((legP90) / 1000).toFixed(1)}s   (+ PumpPortal build, ~0.3s)`);
    const slipP90 = (legP90 / cut) * 100;
    console.log(`  At p90 that is ${slipP90.toFixed(0)}% of the whole window spent in flight.`);
    console.log(`\n  ⚠ FLOOR, NOT ESTIMATE. This measured a zero-lamport self-transfer: 3 instructions,`);
    console.log(`    no ATA creation, no curve account contention, and no snipers outbidding us on`);
    console.log(`    priority fee for the same block. A real pump.fun buy is heavier and competes.`);
    console.log(`    Treat every number above as the best case.`);
  }
  console.log(`  fee spent     ${spent == null ? "?" : spent.toFixed(6)} SOL total`);
  logRecord("live-exec", {
    type: "latency-probe", samples: totalMs.length, failed,
    sendP50: pct(sS, 50), sendP90: pct(sS, 90),
    confirmP50: pct(cS, 50), confirmP90: pct(cS, 90),
    totalP50: pct(tS, 50), totalP90: pct(tS, 90), totalMax: tS.at(-1) ?? null,
    feeSpentSol: spent, priorityFeeSol: config.exec.priorityFeeSol,
  });
  console.log("");
}

void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
