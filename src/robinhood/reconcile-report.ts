/**
 * LAPORAN REKONSILIASI KANONIK (round-3 A4) — `npm run rh:reconcile`.
 *
 * Satu sumber kebenaran: klaim LEDGER vs BUKTI RANTAI untuk setiap peristiwa posisi live.
 * Aturan label (jangan pernah menaikkan label diam-diam):
 *   VERIFIED  — ada hash tx + receipt sukses di rantai (+ saldo konsisten bila relevan).
 *   INFERRED  — hanya baris ledger (tanpa hash); kebenarannya tidak bisa dicek ulang dari sini.
 *   UNKNOWN   — rantai tidak menjawab / data tidak ada; tidak dianggap benar, tidak dianggap salah.
 * Saldo positif TIDAK membuktikan jual parsial; saldo nol TIDAK membuktikan beli gagal —
 * keduanya hanya temuan saldo, dilaporkan apa adanya.
 */
import "dotenv/config";
import { appendFileSync, writeFileSync } from "node:fs";
import { loadLiveRows, readTokenBalance, reconstructPositions, type LiveRow } from "./live-positions.js";
import { BOT_WALLET_FALLBACK } from "./constants.js";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const BOTW = process.env.BOT_WALLET ?? BOT_WALLET_FALLBACK;

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

interface Transfer { token: string; from: string; to: string; valueRaw: string }
interface Receipt { status: string; block: number; from: string; to: string; gasUsed: string; ts: number | null; transfers: Transfer[] }

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function decodeTransfers(logs: unknown[]): Transfer[] {
  const out: Transfer[] = [];
  for (const l of logs) {
    const row = l as { address?: string; topics?: string[]; data?: string };
    if (row?.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || !row.address) continue;
    const data = String(row.data ?? "0x0").slice(2);
    if (data.length < 64) continue;
    // ERC-20 Transfer(address,address,uint256): from = topic1, to = topic2, value = data
    const pad = (h: string): string => "0x" + h.replace(/^0x/, "").padStart(64, "0");
    const from = "0x" + pad(row.topics[1] ?? "").slice(26);
    const to = "0x" + pad(row.topics[2] ?? "").slice(26);
    out.push({ token: row.address, from, to, valueRaw: BigInt("0x" + data.slice(-64)).toString() });
  }
  return out;
}

async function receipt(hash: string): Promise<Receipt | { error: string }> {
  const r = await rpc("eth_getTransactionReceipt", [hash]);
  if (r.error) return { error: String(r.error.message ?? "rpc error") };
  const x = r.result as { status?: string; blockNumber?: string; from?: string; to?: string; gasUsed?: string; logs?: unknown[] } | null;
  if (!x) return { error: "receipt tidak ditemukan (tx belum ditambang?)" };
  const block = Number(x.blockNumber);
  let ts: number | null = null;
  try { ts = Number(((await rpc("eth_getBlockByNumber", ["0x" + block.toString(16), false])).result as Record<string, unknown>)?.timestamp) * 1000; } catch { /* opsional */ }
  return { status: String(x.status), block, from: String(x.from ?? ""), to: String(x.to ?? ""), gasUsed: String(x.gasUsed ?? "0x0"), ts,
    transfers: decodeTransfers(Array.isArray(x.logs) ? x.logs : []) };
}

interface EventFinding {
  ts: number; day: string; action: string; ok: boolean | null; symbol: string;
  txHash: string | null; chain: Receipt | { error: string } | null;
  claim: string; evidence: "VERIFIED" | "INFERRED" | "UNKNOWN"; note: string;
}

async function findingsFor(token: string, rows: LiveRow[]): Promise<EventFinding[]> {
  const out: EventFinding[] = [];
  for (const r of rows.filter((x) => String(x.raw.token ?? "").toLowerCase() === token)) {
    const hash = typeof r.raw.tx === "string" ? r.raw.tx : typeof r.raw.txHash === "string" ? r.raw.txHash : null;
    const chain = hash ? await receipt(hash) : null;
    let evidence: EventFinding["evidence"] = "INFERRED";
    let note = "baris ledger tanpa hash tx — tidak bisa diverifikasi ulang dari sini";
    if (hash) {
      if ("error" in chain!) { evidence = "UNKNOWN"; note = `receipt gagal dibaca: ${(chain as { error: string }).error}`; }
      else {
        evidence = chain!.status === "0x1" ? "VERIFIED" : "UNKNOWN";
        const transfers = chain!.transfers.filter((t) => t.from.toLowerCase() === BOTW.toLowerCase() || t.to.toLowerCase() === BOTW.toLowerCase());
        const txSummary = transfers.length
          ? transfers.map((t) => `${t.to.toLowerCase() === BOTW.toLowerCase() ? "MASUK" : "KELUAR"} ${t.valueRaw} (${t.token.slice(0, 10)}…) ${t.from.slice(0, 8)}→${t.to.slice(0, 8)}`).join(" | ")
          : "tidak ada transfer ERC-20 ke/dari dompet";
        note = `receipt status ${chain!.status}, blok ${chain!.block}, gasUsed ${chain!.gasUsed} · transfer: ${txSummary}`;
      }
    }
    out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol: String(r.raw.symbol ?? "?"), txHash: hash, chain,
      claim: `${r.action} ok=${r.ok}${r.raw.notionalUsd != null ? ` notional=$${r.raw.notionalUsd}` : ""}${r.raw.amountEth != null ? ` amountEth=${r.raw.amountEth}` : ""}${r.raw.note != null ? ` note="${r.raw.note}"` : ""}`,
      evidence, note });
  }
  return out;
}

export async function reconcileNow(now = Date.now()): Promise<{ markdown: string; json: string; summary: string }> {
  const { rows, malformed } = loadLiveRows("logs");
  const positions = reconstructPositions(rows);
  const tokens = [...new Set([...positions.keys(), ...rows.map((r) => String(r.raw.token ?? "").toLowerCase()).filter((t) => /^0x[0-9a-f]{40}$/.test(t))])];

  const lines: string[] = [`# REKONSILIASI POSISI LIVE — ${new Date(now).toISOString()}`, "",
    `Ledger: ${rows.length} baris (${malformed} rusak dilewati) · dompet: ${BOTW}`, "",
    "Aturan: VERIFIED = hash tx + receipt rantai. INFERRED = baris ledger saja. UNKNOWN = rantai tak menjawab.",
    "Saldo ≠ bukti jual parsial/beli gagal; saldo adalah temuan tersendiri.", ""];

  const json: Array<Record<string, unknown>> = [];
  const tally = { VERIFIED: 0, INFERRED: 0, UNKNOWN: 0 };

  for (const token of tokens) {
    const bal = await readTokenBalance(rpc, token, BOTW);
    const balText = bal.ok ? `${bal.raw.toString()} raw (${(Number(bal.raw) / 1e18).toFixed(6)} bila 18 desimal)` : `TIDAK TERBACA (${bal.reason})`;
    const events = await findingsFor(token, rows);
    for (const e of events) tally[e.evidence]++;
    const pos = positions.get(token);
    const posText = pos ? `posisi rekonstruksi: evidence=${pos.evidence}, entry=${new Date(pos.entryTs).toISOString()}, soldAt=${pos.soldAt ? new Date(pos.soldAt).toISOString() : "null"}` : "tidak tercatat sebagai posisi (hanya kejadian lewat)";
    lines.push(`## ${String(events[0]?.symbol ?? token)} · ${token}`, "", `- Saldo dompet kini: ${balText}`, `- ${posText}`, "");
    for (const e of events) {
      lines.push(`- [${e.evidence}] ${e.day} ${e.action} ok=${e.ok} — ${e.claim}`, `  - ${e.note}${e.txHash ? ` · tx ${e.txHash}` : ""}`);
    }
    lines.push("");
    json.push({ token, symbol: events[0]?.symbol ?? null, balanceRaw: bal.ok ? bal.raw.toString() : null, balanceError: bal.ok ? null : bal.reason, events });
  }

  const summary = `peristiwa: VERIFIED=${tally.VERIFIED} · INFERRED=${tally.INFERRED} · UNKNOWN=${tally.UNKNOWN} (posisi terlacak: ${positions.size})`;
  lines.push(`═══ RINGKASAN ═══`, `- ${summary}`, "",
    "Keterbukaan: jual 10-19 (gilet, route manual-pool) dan beli HOOT 10-20 tidak meninggalkan hash di log mana pun;",
    "keduanya INFERRED. Saldo gilet >0 setelah 'jual ok' = konflik ledger-vs-rantai yang sedang berjalan (posisi tetap OPEN).");

  const day = new Date(now).toISOString().slice(0, 10);
  writeFileSync(`logs/rh-reconciliation-${day}.md`, lines.join("\n"));
  writeFileSync(`logs/rh-reconciliation-${day}.json`, JSON.stringify({ generatedAt: now, wallet: BOTW, malformedRows: malformed, tally, tokens: json }, null, 2));
  appendFileSync("logs/rh-reconciliation-history.jsonl", JSON.stringify({ ts: now, ...tally, positions: positions.size, malformed }) + "\n");
  return { markdown: lines.join("\n"), json: "", summary };
}

// Jalankan langsung: npx tsx src/robinhood/reconcile-report.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  void reconcileNow().then((r) => { console.log(r.markdown); console.log(`\n[rh:reconcile] ${r.summary}`); });
}
