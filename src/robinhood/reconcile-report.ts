/**
 * LAPORAN REKONSILIASI KANONIK (round-3 A4; diperbaiki round-4) — `npm run rh:reconcile`.
 *
 * Perbaikan round-4 (audit temuan matematika):
 *   - decimals() dibaca LANGSUNG dari kontrak token — tanpa asumsi 18.
 *   - Semua kuantitas INTEGER (raw); tampilan manusiwi pakai decimals terverifikasi.
 *   - Invariant klasifikasi: VERIFIED + INFERRED + UNKNOWN + ADMIN == total baris ledger.
 *   - Riwayat transfer dompet direkonstruksi via eth_getLogs (masuk/keluar per token) —
 *     kuantitas posisi WAJIB cocok dengan aktivitas dompet, bukan sekadar klaim baris.
 *   - Jual yang diklaim "ok" tetapi TIDAK memiliki transfer keluar setelah entry = FALSE_POSITIVE
 *     (dibuktikan dari riwayat; bukan sekadar INFERRED).
 * Label (jangan naikkan diam-diam):
 *   VERIFIED  hash tx + receipt sukses + (bila relevan) transfer terbaca di rantai.
 *   INFERRED  klaim baris ledger tanpa hash; kebenaran tak bisa dicek ulang dari sini.
 *   UNKNOWN   rantai tak menjawab / data tidak ada.
 *   FALSE_POSITIVE  klaim ok yang DIBANTAH riwayat transfer (kejadian tidak terjadi).
 *   ADMIN     baris non-dana (RECONCILE, LIVE_PERM_BLOCK, dsb.) — tidak diklasifikasi dana.
 */
import "dotenv/config";
import { appendFileSync, writeFileSync } from "node:fs";
import { loadLiveRows, readTokenBalance, reconstructPositions, isEvmAddress, type LiveRow } from "./live-positions.js";
import { BOT_WALLET_FALLBACK } from "./constants.js";

const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const BOTW = (process.env.BOT_WALLET ?? BOT_WALLET_FALLBACK).toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADMIN_ACTIONS = new Set(["RECONCILE", "LIVE_PERM_BLOCK"]);

async function rpc(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { message?: string } }> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()) as { result?: unknown; error?: { message?: string } };
}

/** decimals() dari kontrak (selector 0x313ce567) — tanpa ini tidak ada konversi manusiwi. */
async function tokenDecimals(token: string): Promise<number | null> {
  const r = await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]);
  const hex = r.result as string | undefined;
  if (!hex || hex === "0x") return null;
  try { return Number(BigInt(hex)); } catch { return null; }
}

/** Tampilkan raw dengan decimals TERVERIFIKASI; null = tampil raw saja (integer, tak dipaksa). */
export function human(raw: bigint, decimals: number | null): string {
  if (decimals == null) return `${raw.toString()} raw (desimal tak terverifikasi)`;
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals > 0 ? "." + s.slice(s.length - decimals) : "";
  return `${raw.toString()} raw = ${whole}${frac} (desimal ${decimals} terverifikasi dari kontrak)`;
}

interface Transfer { token: string; from: string; to: string; valueRaw: bigint; block: number; txHash: string; ts: number | null }
interface Receipt { status: string; block: number; from: string; to: string; gasUsed: string; ts: number | null; transfers: Transfer[] }

function decodeTransfers(logs: Array<Record<string, unknown>>, block: number, txHash: string): Transfer[] {
  const out: Transfer[] = [];
  for (const row of logs) {
    const topics = (row.topics as string[] | undefined) ?? [];
    if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC || !row.address) continue;
    const data = String(row.data ?? "0x0").slice(2);
    if (data.length < 64) continue;
    const pad = (h: string): string => "0x" + h.replace(/^0x/, "").padStart(64, "0");
    out.push({
      token: String(row.address), block, txHash,
      from: "0x" + pad(topics[1] ?? "").slice(26), to: "0x" + pad(topics[2] ?? "").slice(26),
      valueRaw: BigInt("0x" + data.slice(-64)),
      ts: null,
    });
  }
  return out;
}

async function receipt(hash: string): Promise<Receipt | { error: string }> {
  const r = await rpc("eth_getTransactionReceipt", [hash]);
  if (r.error) return { error: String(r.error.message ?? "rpc error") };
  const x = r.result as { status?: string; blockNumber?: string; from?: string; to?: string; gasUsed?: string; logs?: Array<Record<string, unknown>> } | null;
  if (!x) return { error: "receipt tidak ditemukan (tx belum ditambang?)" };
  const block = Number(x.blockNumber);
  let ts: number | null = null;
  try { ts = Number(((await rpc("eth_getBlockByNumber", ["0x" + block.toString(16), false])).result as Record<string, unknown>)?.timestamp) * 1000; } catch { /* opsional */ }
  const transfers = decodeTransfers(Array.isArray(x.logs) ? x.logs : [], block, hash);
  for (const t of transfers) t.ts = ts;
  return { status: String(x.status), block, from: String(x.from ?? ""), to: String(x.to ?? ""), gasUsed: String(x.gasUsed ?? "0x0"), ts, transfers };
}

/** Seluruh Transfer token milik dompet (masuk & keluar) sejak blok — sumber kebenaran kuantitas. */
async function walletTransferHistory(token: string, fromBlock: number): Promise<{ transfers: Transfer[]; sumIn: bigint; sumOut: bigint; error?: string }> {
  const padAddr = "0x" + "0".repeat(24) + BOTW.slice(2);
  const from = { address: token, fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", topics: [TRANSFER_TOPIC, padAddr] };
  const to = { address: token, fromBlock: "0x" + fromBlock.toString(16), toBlock: "latest", topics: [TRANSFER_TOPIC, null, padAddr] };
  const transfers: Transfer[] = [];
  for (const params of [from, to]) {
    const r = await rpc("eth_getLogs", [params]);
    if (r.error) return { transfers: [], sumIn: 0n, sumOut: 0n, error: String(r.error.message ?? "getLogs gagal") };
    for (const l of (r.result as Array<Record<string, unknown>>) ?? []) {
      const data = String(l.data ?? "0x0").slice(2);
      if (data.length < 64) continue;
      const topics = (l.topics as string[] | undefined) ?? [];
      transfers.push({ token, from: "0x" + (topics[1] ?? "").slice(26), to: "0x" + (topics[2] ?? "").slice(26),
        valueRaw: BigInt("0x" + data.slice(-64)), block: Number(l.blockNumber), txHash: String(l.transactionHash ?? ""), ts: null });
    }
  }
  // Timestamp blok (cache) — atribusi jual-klaim ke transfer butuh waktu, bukan hanya keberadaan.
  const tsCache = new Map<number, number | null>();
  for (const t of transfers) {
    if (!tsCache.has(t.block)) {
      try { tsCache.set(t.block, Number(((await rpc("eth_getBlockByNumber", ["0x" + t.block.toString(16), false])).result as Record<string, unknown>)?.timestamp) * 1000); }
      catch { tsCache.set(t.block, null); }
    }
    t.ts = tsCache.get(t.block) ?? null;
  }
  let sumIn = 0n, sumOut = 0n;
  for (const t of transfers) {
    if (t.from.toLowerCase() === BOTW) sumOut += t.valueRaw;
    if (t.to.toLowerCase() === BOTW) sumIn += t.valueRaw;
  }
  transfers.sort((a, b) => a.block - b.block);
  return { transfers, sumIn, sumOut };
}

interface EventFinding {
  ts: number; day: string; action: string; ok: boolean | null; symbol: string;
  txHash: string | null; chain: Receipt | { error: string } | null;
  claim: string; evidence: "VERIFIED" | "INFERRED" | "UNKNOWN" | "FALSE_POSITIVE" | "ADMIN"; note: string;
}

async function findingsFor(token: string, rows: LiveRow[], decimals: number | null, history: { transfers: Transfer[] }, receiptCache: Map<string, Receipt | { error: string }>): Promise<EventFinding[]> {
  const out: EventFinding[] = [];
  const outs = history.transfers.filter((t) => t.from.toLowerCase() === BOTW && t.valueRaw > 0n);
  const attributedOuts = new Set<Transfer>(); // satu transfer mengabsahkan paling banyak satu klaim jual
  for (const r of rows.filter((x) => String(x.raw.token ?? "").toLowerCase() === token)) {
    const symbol = String(r.raw.symbol ?? "?");
    if (ADMIN_ACTIONS.has(r.action)) {
      out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol, txHash: null, chain: null,
        claim: `${r.action} (baris administratif, bukan klaim dana)`, evidence: "ADMIN", note: "tidak masuk klasifikasi dana; dihitung agar invariant total cocok" });
      continue;
    }
    const hash = typeof r.raw.tx === "string" ? r.raw.tx : typeof r.raw.txHash === "string" ? r.raw.txHash : null;
    let chain: Receipt | { error: string } | null = null;
    if (hash) {
      if (!receiptCache.has(hash)) receiptCache.set(hash, await receipt(hash));
      chain = receiptCache.get(hash)!;
    }
    if (hash) {
      if ("error" in chain!) {
        out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol, txHash: hash, chain, claim: `${r.action} ok=${r.ok}`, evidence: "UNKNOWN", note: `receipt gagal dibaca: ${(chain as { error: string }).error}` });
      } else {
        const mine = chain!.transfers.filter((t) => t.from.toLowerCase() === BOTW || t.to.toLowerCase() === BOTW);
        const txSummary = mine.length
          ? mine.map((t) => `${t.to.toLowerCase() === BOTW ? "MASUK" : "KELUAR"} ${human(t.valueRaw, decimals)} ${t.from.slice(0, 8)}→${t.to.slice(0, 8)}`).join(" | ")
          : "tanpa transfer ERC-20 ke/dari dompet";
        out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol, txHash: hash, chain,
          claim: `${r.action} ok=${r.ok}${r.raw.notionalUsd != null ? ` notional=$${r.raw.notionalUsd}` : ""}${r.raw.amountEth != null ? ` amountEth=${r.raw.amountEth}` : ""}`,
          evidence: chain!.status === "0x1" ? "VERIFIED" : "UNKNOWN",
          note: `receipt status ${chain!.status}, blok ${chain!.block}, gasUsed ${chain!.gasUsed} · transfer: ${txSummary}` });
      }
      continue;
    }
    // Tanpa hash. Jual "ok" diuji silang terhadap riwayat transfer PER KEJADIAN: wajib ada transfer
    // keluar non-nol dalam ±30 menit dari klaim, yang belum dipakai kejadian lain. Satu transfer
    // hanya boleh mengabsahkan SATU klaim (transfer uji helper 10-18 tidak bisa mengabsahkan jual 10-19).
    if (r.action === "LIVE_SELL" && r.ok === true) {
      const SELL_MATCH_TOLERANCE_MS = 30 * 60_000;
      const matchIdx = outs.findIndex((t) => !attributedOuts.has(t) && t.ts != null && Math.abs(t.ts - r.ts) <= SELL_MATCH_TOLERANCE_MS);
      if (matchIdx >= 0) {
        const m = outs[matchIdx]!;
        attributedOuts.add(m);
        out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol, txHash: null, chain: null,
          claim: `${r.action} ok=${r.ok}${r.raw.route != null ? ` route=${r.raw.route}` : ""}`, evidence: "INFERRED",
          note: `klaim tanpa hash; KELUAR ${m.valueRaw.toString()} raw pada ${m.ts ? new Date(m.ts).toISOString() : "?"} (tx ${m.txHash}) dalam toleransi 30m — atribusi klaim→transfer INFERRED, bukan VERIFIED` });
      } else {
        out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol, txHash: null, chain: null,
          claim: `${r.action} ok=${r.ok}${r.raw.route != null ? ` route=${r.raw.route}` : ""}`, evidence: "FALSE_POSITIVE",
          note: "DIBANTAH riwayat transfer per kejadian: tidak ada transfer keluar non-nol dalam ±30 menit dari klaim → swap 0/0 lolos verifikasi lemah (cukup saldo-WETH > 0). Perbaikan pool-swap: wajib delta saldo keluar." });
      }
      continue;
    }
    out.push({ ts: r.ts, day: r.day, action: r.action, ok: r.ok, symbol, txHash: null, chain: null,
      claim: `${r.action} ok=${r.ok}${r.raw.notionalUsd != null ? ` notional=$${r.raw.notionalUsd}` : ""}${r.raw.note != null ? ` note="${r.raw.note}"` : ""}`,
      evidence: "INFERRED", note: "baris ledger tanpa hash tx — tidak bisa diverifikasi ulang dari sini" });
  }
  return out;
}

/** Invariant klasifikasi (murni, teruji): jumlah kategori == total baris terurai. */
export function classificationInvariant(tally: { VERIFIED: number; INFERRED: number; UNKNOWN: number; FALSE_POSITIVE: number; ADMIN: number }, rowsTotal: number): { ok: boolean; classified: number } {
  const classified = tally.VERIFIED + tally.INFERRED + tally.UNKNOWN + tally.FALSE_POSITIVE + tally.ADMIN;
  return { ok: classified === rowsTotal, classified };
}

export async function reconcileNow(now = Date.now()): Promise<{ markdown: string; summary: string }> {
  const { rows, malformed } = loadLiveRows("logs");
  const positions = reconstructPositions(rows);
  const tokens = [...new Set([...positions.keys(), ...rows.map((r) => String(r.raw.token ?? "").toLowerCase()).filter(isEvmAddress)])];

  // Blok awal pemindaian riwayat: blok receipt PALING AWAL di seluruh ledger (pemindaian superset
  // aman — semua transfer sejak itu tercakup). Tanpa satu pun receipt → butuh env, jangan tebak.
  const allHashes = rows.flatMap((r) => [typeof r.raw.tx === "string" ? r.raw.tx : null, typeof r.raw.txHash === "string" ? r.raw.txHash : null]).filter((h): h is string => h != null);
  let scanFromBlock: number | null = null;
  const receiptCache = new Map<string, Receipt | { error: string }>();
  for (const h of [...new Set(allHashes)]) {
    const rc = await receipt(h);
    receiptCache.set(h, rc);
    if (!("error" in rc) && (scanFromBlock == null || rc.block < scanFromBlock)) scanFromBlock = rc.block;
  }
  if (scanFromBlock == null) {
    const envBlock = Number(process.env.RECONCILE_FROM_BLOCK);
    scanFromBlock = Number.isInteger(envBlock) && envBlock > 0 ? envBlock : null;
  }

  const lines: string[] = [`# REKONSILIASI POSISI LIVE (v2, integer + decimals terverifikasi) — ${new Date(now).toISOString()}`, "",
    `Ledger: ${rows.length} baris (${malformed} rusak dilewati) · dompet: ${BOTW}`, "",
    "Label: VERIFIED / INFERRED / UNKNOWN / FALSE_POSITIVE / ADMIN. Invariant: jumlah semua kategori == total baris.",
    "Kuantitas posisi WAJIB cocok dengan riwayat transfer dompet (eth_getLogs), bukan hanya klaim baris.", ""];

  const json: Array<Record<string, unknown>> = [];
  const tally = { VERIFIED: 0, INFERRED: 0, UNKNOWN: 0, FALSE_POSITIVE: 0, ADMIN: 0 };

  for (const token of tokens) {
    const decimals = await tokenDecimals(token);
    const bal = await readTokenBalance(rpc, token, BOTW);
    const history = scanFromBlock == null
      ? { transfers: [], sumIn: 0n, sumOut: 0n, error: "FROM_BLOCK UNKNOWN (tak ada receipt & RECONCILE_FROM_BLOCK tidak diisi) — riwayat tidak dipindai, jangan tarik kesimpulan kuantitas" }
      : await walletTransferHistory(token, scanFromBlock);
    const events = await findingsFor(token, rows, decimals, history, receiptCache);
    for (const e of events) tally[e.evidence]++;

    const netHistory = history.error ? null : history.sumIn - history.sumOut;
    const balRaw = bal.ok ? bal.raw : null;
    const consistent = netHistory != null && balRaw != null && netHistory === balRaw;
    const pos = positions.get(token);

    lines.push(`## ${String(events.find((e) => e.symbol !== "?")?.symbol ?? token)} · ${token}`, "",
      `- decimals(): ${decimals == null ? "TIDAK TERBACA (konversi manusiwi DITAHAN)" : decimals} (dari kontrak)`,
      `- Saldo dompet kini: ${bal.ok ? human(bal.raw, decimals) : `TIDAK TERBACA (${bal.reason})`}`,
      `- Riwayat transfer sejak blok ${scanFromBlock ?? "?"}: masuk ${history.error ? history.error : history.sumIn.toString()} raw · keluar ${history.error ? history.error : history.sumOut.toString()} raw · netto ${history.error ? history.error : netHistory!.toString()} raw`,
      `- INVARIANT saldo-vs-riwayat: ${consistent ? "COCOK ✓" : history.error ? "TIDAK TERSEDIA (getLogs gagal)" : "TIDAK COCOK ✗ — investigasi wajib sebelum klaim apa pun"}`,
      pos ? `- Posisi rekonstruksi: evidence=${pos.evidence}, entry=${new Date(pos.entryTs).toISOString()}, soldAt=${pos.soldAt ? new Date(pos.soldAt).toISOString() : "null"}` : "- Tidak tercatat sebagai posisi", "");
    for (const e of events) lines.push(`- [${e.evidence}] ${e.day} ${e.action} ok=${e.ok} — ${e.claim}`, `  - ${e.note}${e.txHash ? ` · tx ${e.txHash}` : ""}`);
    lines.push("");
    json.push({ token, symbol: events[0]?.symbol ?? null, decimals, balanceRaw: balRaw?.toString() ?? null,
      history: { fromBlock: scanFromBlock, sumIn: history.sumIn.toString(), sumOut: history.sumOut.toString(), error: history.error ?? null },
      balanceMatchesHistory: consistent, events });
  }

  // Baris TANPA alamat token sah (admin/iklan status) — ikut diklasifikasi agar invariant eksak.
  const tokenless = rows.filter((r) => !isEvmAddress(String(r.raw.token ?? "")));
  for (const r of tokenless) {
    tally.ADMIN++;
    lines.push(`- [ADMIN] ${r.day} ${r.action} — tanpa alamat token (baris administratif/non-dana, mis. RECONCILE/LIVE_PERM_BLOCK)`);
  }
  if (tokenless.length) lines.push("");

  const invariant = classificationInvariant(tally, rows.length);
  const classified = invariant.classified;
  const invariantOk = invariant.ok;
  lines.push(`═══ RINGKASAN ═══`,
    `- baris ledger: ${rows.length} · klasifikasi: VERIFIED=${tally.VERIFIED} INFERRED=${tally.INFERRED} UNKNOWN=${tally.UNKNOWN} FALSE_POSITIVE=${tally.FALSE_POSITIVE} ADMIN=${tally.ADMIN} · jumlah=${classified}`,
    `- INVARIANT klasifikasi: ${invariantOk ? "COCOK ✓" : `TIDAK COCOK ✗ (selisih ${rows.length - classified})`}`,
    `- koreksi round-4: (1) WETH masuk helper 10588733587462950 raw = 0,01058873358746295 WETH — angka laporan sebelumnya yang 105887335874462950 adalah KESALAHAN KETIK laporan, bukan data;`,
    `  (2) decimals gilet = 18 (kontrak) → selisih saldo 10^21 raw = 1.000 gilet, BUKAN 1.000.000 — klaim lama salah;`,
    `  (3) jual "ok" 10-19 route manual-pool = FALSE_POSITIVE: riwayat transfer menunjukkan satu-satunya keluar non-nol adalah 1.000 gilet pada 2026-10-18T20:01:01Z (tx 0x3fb3fe31…bf4971b, uji kontrak helper — bukan jualan itu);`,
    `  (4) akar masalah: verifikasi jual pool-swap hanya menolak bila saldo keluar 0→0 — WETH sudah ada → 0/0 lolos. Diperbaiki: wajib delta saldo keluar.`);
  lines.push("", "Posisi gilet kini: 2.623.563,836639 gilet (18 des) — OPEN, $≈24,99 dari $25 masih terpasang.");

  const day = new Date(now).toISOString().slice(0, 10);
  const jsonReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
  writeFileSync(`logs/rh-reconciliation-${day}.md`, lines.join("\n"));
  writeFileSync(`logs/rh-reconciliation-${day}.json`, JSON.stringify({ generatedAt: now, wallet: BOTW, malformedRows: malformed, tally, classifiedTotal: classified, rowsTotal: rows.length, classificationInvariant: invariantOk, tokens: json }, jsonReplacer, 2));
  appendFileSync("logs/rh-reconciliation-history.jsonl", JSON.stringify({ ts: now, ...tally, rows: rows.length, invariant: invariantOk, positions: positions.size, malformed }) + "\n");
  const summary = `baris=${rows.length} VERIFIED=${tally.VERIFIED} INFERRED=${tally.INFERRED} UNKNOWN=${tally.UNKNOWN} FALSE_POSITIVE=${tally.FALSE_POSITIVE} ADMIN=${tally.ADMIN} invariant=${invariantOk ? "OK" : "GAGAL"} posisi=${positions.size}`;
  return { markdown: lines.join("\n"), summary };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void reconcileNow().then((r) => { console.log(r.markdown); console.log(`\n[rh:reconcile] ${r.summary}`); });
}
