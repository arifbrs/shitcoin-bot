/**
 * REKONSILIASI POSISI LIVE (2026-10-24) — tanggapan audit independen P0/P1/P2.
 *
 * Masalah yang diluruskan (semua bukti di PLAN_PROGRESS.md 2026-10-24):
 *  1. Jalur jual live membaca balanceOf dengan PEMILIK = kontrak token (bug `7a14c75`) →
 *     qty selalu 0 → jual otomatis mustahil. Kini calldata dibangun oleh fungsi murni
 *     `balanceOfCalldata(owner)` yang diuji: pemiliknya dompet, bukan kontrak.
 *  2. `rh:live` crash ENOENT saat `logs/rh-paper-state.json` (paper lama) sudah diarsipkan →
 *     kini `loadLegacyHeldTokens()` fail-open ke himpunan kosong.
 *  3. Bridge hanya membaca ledger live HARI INI → posisi yang dibuka semalam hilang paginya.
 *     Kini `loadLiveRows()` membaca SEMUA `rh-live-*.jsonl` dan `reconstructPositions()`
 *     membangun ulang posisi lintas-hari dari bukti (bukan dari ingatan proses).
 *
 * Semua fungsi murni menerima RPC/berkas lewat parameter agar tiap cabang bisa diuji offline.
 * Prinsip bukti proyek ini tetap: status tx ≠ fill; fill = saldo TERVERIFIKASI berubah.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type RpcCall = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { message?: string } }>;

export const BALANCEOF_SELECTOR = "0x70a08231";

export const isEvmAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Calldata `balanceOf(address)` — argumen pemilik adalah DOMPET BOT. Versi lama (sebelum
 * 2026-10-24) menyisipkan alamat kontrak token di posisi pemilik; tes regresi membandingkan
 * keduanya supaya kesalahan itu tidak bisa kembali tanpa tes merah.
 */
export function balanceOfCalldata(owner: string): string {
  if (!isEvmAddress(owner)) throw new Error(`balanceOfCalldata: pemilik bukan alamat EVM 20-byte: ${String(owner).slice(0, 50)}`);
  // ABI: argumen address = 32 byte → wajib pad kiri 24 nol (bentuk yang sudah terbukti di rantai).
  return BALANCEOF_SELECTOR + owner.toLowerCase().slice(2).padStart(64, "0");
}

export type BalanceResult = { ok: true; raw: bigint } | { ok: false; reason: string };

/** Baca saldo token milik `owner`. Gagal RPC ≠ saldo nol — keduanya dibedakan eksplisit. */
export async function readTokenBalance(rpc: RpcCall, token: string, owner: string): Promise<BalanceResult> {
  if (!isEvmAddress(token)) return { ok: false, reason: "alamat token tidak valid" };
  try {
    const r = await rpc("eth_call", [{ to: token, data: balanceOfCalldata(owner) }, "latest"]);
    if (r.error) return { ok: false, reason: "rpc: " + String(r.error.message ?? "revert").slice(0, 120) };
    const hex = r.result;
    if (typeof hex !== "string" || !/^0x[0-9a-f]*$/.test(hex)) return { ok: false, reason: "rpc: bentuk hasil tidak dikenal" };
    return { ok: true, raw: BigInt(hex) };
  } catch (e) {
    return { ok: false, reason: "rpc: " + String((e as Error).message).slice(0, 120) };
  }
}

/**
 * Himpunan token yang dipegang paper LAMA (pra engine 1:1, `rh-paper-state.json`).
 * Berkas hilang/rusak = himpunan kosong — JANGAN crash (regresi ENOENT 2026-10-24),
 * dan JANGAN menganggap posisi lama hilang hanya karena berkas tidak ada: bridge tetap
 * menemukan posisi dari ledger live, state ini hanya pelengkap aturan yatim.
 */
export function loadLegacyHeldTokens(logDir: string, strategy: string): Set<string> {
  try {
    const stj = JSON.parse(readFileSync(join(logDir, "rh-paper-state.json"), "utf8")) as { variants?: Record<string, { positions?: Array<{ token?: string }> }> };
    return new Set((stj.variants?.[strategy]?.positions ?? []).map((x) => String(x.token ?? "").toLowerCase()).filter(isEvmAddress));
  } catch {
    return new Set();
  }
}

/** Satu baris ledger live yang sudah dinormalisasi. `ok === null` = aksi tanpa kolom ok. */
export interface LiveRow { ts: number; day: string; file: string; action: string; ok: boolean | null; raw: Record<string, unknown> }

export function liveLedgerFiles(logDir: string): string[] {
  try {
    return readdirSync(logDir).filter((f) => /^rh-live-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
}

/** SEMUA hari, urut waktu. Baris rusak dihitung, tidak membungkam yang lain. */
export function loadLiveRows(logDir: string): { rows: LiveRow[]; malformed: number } {
  const rows: LiveRow[] = [];
  let malformed = 0;
  for (const f of liveLedgerFiles(logDir)) {
    let text = "";
    try { text = readFileSync(join(logDir, f), "utf8"); } catch { malformed++; continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const ts = Number(raw.ts);
        rows.push({ ts: Number.isFinite(ts) && ts > 0 ? ts : 0, day: f.replace(/^rh-live-|\.jsonl$/g, ""), file: f,
          action: String(raw.action ?? "?"), ok: typeof raw.ok === "boolean" ? raw.ok : null, raw });
      } catch { malformed++; }
    }
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, malformed };
}

export interface LivePosition {
  positionId: string; // deterministik dari bukti entry (lihat positionIdFor) — selamat lintas-restart
  token: string; symbol: string; strategy: string;
  entryTs: number; entryDay: string;
  amountOutRaw: string | null; notionalUsd: number | null; txHash: string | null;
  evidence: "LIVE_FILL" | "LIVE_BUY_LEGACY"; // LIVE_FILL = saldo terverifikasi; LIVE_BUY_LEGACY = status tx saja
  soldAt: number | null; sellTxHash: string | null;
}

/** ID posisi deterministik dari bukti entry — rekonstruksi berikutnya menghasilkan ID yang sama. */
export function positionIdFor(token: string, txHash: string | null, entryTs: number, amountOutRaw: string | null): string {
  return createHash("sha256").update(JSON.stringify([token.toLowerCase(), txHash, entryTs, amountOutRaw])).digest("hex").slice(0, 16);
}

/**
 * Bangun ulang posisi dari seluruh baris ledger. Buy ok pertama membuka posisi; buy ok lagi
 * untuk token yang masih terbuka TIDAK mengganti entry (dedupe, bukan rata-rata harga);
 * sell ok menutup. Buy ok setelah tutup = epoch baru.
 */
export function reconstructPositions(rows: LiveRow[]): Map<string, LivePosition> {
  const out = new Map<string, LivePosition>();
  for (const r of rows) {
    const token = String(r.raw.token ?? "").toLowerCase();
    if (!isEvmAddress(token)) continue;
    const sym = String(r.raw.symbol ?? "?");
    const strategy = String(r.raw.strategy ?? "?");
    if ((r.action === "LIVE_FILL" || r.action === "LIVE_BUY") && r.ok === true) {
      const prev = out.get(token);
      if (prev && !prev.soldAt) continue;
      const txHash = typeof r.raw.txHash === "string" && r.raw.txHash ? r.raw.txHash : null;
      const amountOutRaw = typeof r.raw.amountOutRaw === "string" && /^\d+$/.test(r.raw.amountOutRaw) ? r.raw.amountOutRaw : null;
      const notional = Number(r.raw.notionalUsd);
      out.set(token, {
        positionId: positionIdFor(token, txHash, r.ts, amountOutRaw), token, symbol: sym, strategy,
        entryTs: r.ts, entryDay: r.day, amountOutRaw,
        notionalUsd: Number.isFinite(notional) && notional > 0 ? notional : null,
        txHash, evidence: r.action === "LIVE_FILL" ? "LIVE_FILL" : "LIVE_BUY_LEGACY", soldAt: null, sellTxHash: null,
      });
    } else if (r.action === "LIVE_SELL" && r.ok === true) {
      const prev = out.get(token);
      if (prev && !prev.soldAt) {
        prev.soldAt = r.ts;
        if (typeof r.raw.txHash === "string" && r.raw.txHash) prev.sellTxHash = r.raw.txHash;
      }
    }
  }
  return out;
}

export type PositionStatus = "OPEN" | "CLOSED_CONFIRMED" | "GHOST" | "UNKNOWN";

export interface ReconciledPosition extends LivePosition { status: PositionStatus; balanceRaw: bigint | null; note: string | null }

/**
 * Cocokkan posisi ledger dengan saldo dompet:
 *  OPEN             saldo > 0 — posisi nyata, boleh dikelola.
 *  CLOSED_CONFIRMED jual sukses tercatat DAN saldo 0 — loop tertutup rapi.
 *  GHOST            catatan beli ok tetapi saldo 0 tanpa jual sukses (kasus HOOT/gilet) —
 *                   DILAPORKAN, tidak pernah dijual (tidak ada yang bisa dijual).
 *  UNKNOWN          saldo tak terbaca (RPC gagal) — TIDAK dianggap nol, TIDAK dijual.
 * Token ber-saldo di dompet tanpa catatan posisi dilaporkan terpisah (`untracked`) dan
 * tidak pernah dijual otomatis — penjualan hanya untuk posisi yang terlacak buktinya.
 */
export function reconcilePositions(positions: Map<string, LivePosition>, balances: Map<string, BalanceResult>): { reconciled: ReconciledPosition[]; untracked: Array<{ token: string; balanceRaw: bigint }> } {
  const reconciled: ReconciledPosition[] = [];
  for (const p of positions.values()) {
    const b = balances.get(p.token);
    if (!b || !b.ok) {
      reconciled.push({ ...p, status: "UNKNOWN", balanceRaw: null, note: b ? b.reason : "saldo tidak diperiksa" });
      continue;
    }
    if (b.raw === 0n) {
      reconciled.push(p.soldAt
        ? { ...p, status: "CLOSED_CONFIRMED", balanceRaw: 0n, note: null }
        : { ...p, status: "GHOST", balanceRaw: 0n, note: "saldo 0 tanpa catatan jual sukses" });
    } else {
      reconciled.push({ ...p, status: "OPEN", balanceRaw: b.raw, note: null });
    }
  }
  const untracked: Array<{ token: string; balanceRaw: bigint }> = [];
  for (const [token, b] of balances) if (b.ok && b.raw > 0n && !positions.has(token)) untracked.push({ token, balanceRaw: b.raw });
  return { reconciled, untracked };
}

export interface ActionPlan {
  buys: Array<{ token: string; symbol: string }>;
  sells: Array<{ token: string; symbol: string; positionId: string; qtyRaw: string | null; why: string }>;
  reports: Array<{ kind: "GHOST" | "UNKNOWN" | "UNTRACKED"; token: string; note: string }>;
}

export interface PlanInput {
  rows: LiveRow[];
  reconciled: ReconciledPosition[];
  untracked: Array<{ token: string; balanceRaw: bigint }>;
  /** Token yang SAAT INI dipegang paper arm target (state engine 1:1 + fallback paper lama). */
  paperHeldTokens: Set<string>;
  paperOpens: Array<{ token: string; symbol: string }>;
  now: number;
  maxPositionAgeMs: number;
  /**
   * AUDIT 2026-10-24 round-3 (A3): mode EXIT_ONLY adalah ketidaksanggupan STRUKTURAL —
   * fungsi perencana itu sendiri tidak menghasilkan rencana beli, apa pun isi .env, izin,
   * tunai, atau sinyal. Bukan saklar yang bisa dibolongi env; jalur belinya tidak dibangun.
   */
  exitOnly?: boolean;
}

/** Token yang sudah PERNAH dicoba dan harus tidak dicoba ulang (anti-loop 287-blok 2026-10-21). */
export function attemptedTokens(rows: LiveRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const token = String(r.raw.token ?? "").toLowerCase();
    if (!isEvmAddress(token)) continue;
    if (r.action === "UNEXITABLE_BLOCK" || ((r.action === "LIVE_BUY" || r.action === "LIVE_ATTEMPT") && r.ok === false)) out.add(token);
  }
  return out;
}

/**
 * Rencana aksi murni dari bukti:
 *  BELI  sinyal paper terbuka − posisi OPEN − token yang sudah dicoba gagal. Satu entri per token.
 *  JUAL  posisi OPEN yang paper tidak lagi pegang ATAU melewati batas umur. qty = saldo terbaca;
 *        UNKNOWN tidak pernah dijual; GHOST/untracked hanya laporan.
 */
export function planActions(input: PlanInput): ActionPlan {
  const open = input.reconciled.filter((p) => p.status === "OPEN");
  const openTokens = new Set(open.map((p) => p.token));
  const attempted = attemptedTokens(input.rows);

  // EXIT_ONLY (A3): rencana BELI tidak pernah dibangun — ketidaksanggupan struktural di dalam
  // fungsi perencana itu sendiri, bukan saklar env yang bisa terlewati di jalur eksekusi.
  const buys: ActionPlan["buys"] = [];
  if (!input.exitOnly) {
    const seen = new Set<string>();
    for (const o of input.paperOpens) {
      const token = String(o.token ?? "").toLowerCase();
      if (!isEvmAddress(token) || seen.has(token)) continue;
      seen.add(token);
      if (openTokens.has(token) || attempted.has(token)) continue;
      buys.push({ token, symbol: String(o.symbol ?? "?") });
    }
  }

  const sells: ActionPlan["sells"] = [];
  for (const p of open) {
    const paperStillHolds = input.paperHeldTokens.has(p.token);
    const tua = input.now - p.entryTs > input.maxPositionAgeMs;
    if (paperStillHolds && !tua) continue;
    sells.push({ token: p.token, symbol: p.symbol, positionId: p.positionId,
      qtyRaw: p.balanceRaw != null ? p.balanceRaw.toString() : null,
      why: tua ? "umur > batas" : "yatim (paper tak memegang)" });
  }

  const reports: ActionPlan["reports"] = [];
  for (const p of input.reconciled) {
    if (p.status === "GHOST") reports.push({ kind: "GHOST", token: p.token, note: `${p.symbol}: ${p.note ?? ""} — tidak dijual, tidak dibeli ulang` });
    if (p.status === "UNKNOWN") reports.push({ kind: "UNKNOWN", token: p.token, note: `${p.symbol}: saldo tak terbaca (${p.note ?? "?"}) — tidak dijual, tidak dibeli ulang` });
  }
  for (const u of input.untracked) reports.push({ kind: "UNTRACKED", token: u.token, note: `saldo dompet tanpa catatan posisi (${u.balanceRaw.toString()} raw) — LAPOR saja, tidak pernah dijual otomatis` });

  return { buys, sells, reports };
}

/** Konversi USD → wei WETH dari harga terukur. Gagal harga = tolak (bukan nominal tebakan). */
export function wethForUsd(usd: number, ethUsd: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("wethForUsd: notional tidak valid");
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) throw new Error("wethForUsd: harga ETH tidak terukur — menolak mengarang nominal");
  return BigInt(Math.round((usd / ethUsd) * 1e18));
}
